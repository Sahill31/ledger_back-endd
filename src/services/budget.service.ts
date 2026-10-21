import { BillStatus, Prisma } from "@prisma/client";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";
import { firstOfMonth } from "../utils/date";
import { toDecimal } from "../utils/money";
import {
  budgetModel,
  toBudgetRowDTO,
  type BudgetRowDTO,
} from "../models/budget.model";
import { paginate, skipTake, type Paginated, type Pagination } from "../utils/pagination";
import type { RequestUser } from "../middleware/authenticate";

/**
 * ADMIN-ONLY service. Every route that reaches this service is guarded by
 * authorizeRole("ADMIN"); no accountant code path may call it.
 *
 * Actual-spending policy: `actual` = sum of APPROVED bills for the
 * dealership+category+period. `pending` = bills awaiting a final decision
 * (SUBMITTED / UNDER_REVIEW / CORRECTION_REQUESTED). REJECTED bills never
 * count toward spend.
 */

interface ListQuery extends Pagination {
  dealershipId?: string;
  categoryId?: string;
  month?: number;
  year?: number;
}

function spendKey(dealershipId: string, categoryId: string, period: Date) {
  return `${dealershipId}:${categoryId}:${period.toISOString().slice(0, 10)}`;
}

/** Aggregate approved + pending spend for a set of months in one GROUP BY. */
async function spendMap(months: Date[]) {
  const rows = await prisma.bill.groupBy({
    by: ["dealershipId", "categoryId", "billingPeriod", "status"],
    where: { billingPeriod: { in: months }, status: { not: BillStatus.REJECTED } },
    _sum: { amount: true },
  });
  const approved = new Map<string, Prisma.Decimal>();
  const pending = new Map<string, Prisma.Decimal>();
  for (const r of rows) {
    const key = spendKey(r.dealershipId, r.categoryId, r.billingPeriod);
    const amount = r._sum.amount ?? new Prisma.Decimal(0);
    const map = r.status === BillStatus.APPROVED ? approved : pending;
    map.set(key, (map.get(key) ?? new Prisma.Decimal(0)).plus(amount));
  }
  return { approved, pending };
}

async function decorate(rows: Awaited<ReturnType<typeof budgetModel.list>>[0]) {
  const months = [...new Set(rows.map((r) => r.effectiveMonth.toISOString()))].map(
    (s) => new Date(s)
  );
  const { approved, pending } = await spendMap(months);
  return rows.map((b) => {
    const key = spendKey(b.dealershipId, b.categoryId, b.effectiveMonth);
    return toBudgetRowDTO(
      b,
      approved.get(key) ?? new Prisma.Decimal(0),
      pending.get(key) ?? new Prisma.Decimal(0)
    );
  });
}

async function assertRefsExist(dealershipId: string, categoryId: string) {
  const [d, c] = await Promise.all([
    prisma.dealership.findUnique({ where: { id: dealershipId } }),
    prisma.billCategory.findUnique({ where: { id: categoryId } }),
  ]);
  if (!d) throw ApiError.unprocessable("Dealership does not exist.");
  if (!c) throw ApiError.unprocessable("Category does not exist.");
}

export const budgetService = {
  async list(q: ListQuery, _admin: RequestUser): Promise<Paginated<BudgetRowDTO>> {
    const where: Prisma.BudgetRuleWhereInput = {
      ...(q.dealershipId ? { dealershipId: q.dealershipId } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.month && q.year
        ? { effectiveMonth: firstOfMonth(q.year, q.month) }
        : q.year
          ? {
              effectiveMonth: {
                gte: firstOfMonth(q.year, 1),
                lte: firstOfMonth(q.year, 12),
              },
            }
          : {}),
    };
    const [rows, total] = await budgetModel.list({ where, ...skipTake(q) });
    return paginate(await decorate(rows), total, q);
  },

  async getById(id: string, _admin: RequestUser): Promise<BudgetRowDTO> {
    const rule = await budgetModel.findById(id);
    if (!rule) throw ApiError.notFound("Budget rule not found.");
    const [dto] = await decorate([rule]);
    return dto!;
  },

  async create(
    input: {
      dealershipId: string;
      categoryId: string;
      month: number;
      year: number;
      monthlyAmount: number;
      increaseThresholdPercent?: number;
    },
    admin: RequestUser
  ): Promise<BudgetRowDTO> {
    await assertRefsExist(input.dealershipId, input.categoryId);
    const effectiveMonth = firstOfMonth(input.year, input.month);
    const existing = await budgetModel.findRule(
      input.dealershipId,
      input.categoryId,
      effectiveMonth
    );
    if (existing) {
      throw ApiError.conflict(
        "A budget rule already exists for this dealership, category and month. Update it instead."
      );
    }
    const rule = await prisma.budgetRule.create({
      data: {
        dealershipId: input.dealershipId,
        categoryId: input.categoryId,
        effectiveMonth,
        monthlyAmount: new Prisma.Decimal(input.monthlyAmount),
        increaseThresholdPercent:
          input.increaseThresholdPercent !== undefined
            ? new Prisma.Decimal(input.increaseThresholdPercent)
            : null,
        createdById: admin.id,
      },
      include: {
        dealership: { select: { name: true } },
        category: { select: { name: true } },
        createdBy: { select: { fullName: true } },
        history: { include: { changedBy: { select: { fullName: true } } } },
      },
    });
    const [dto] = await decorate([rule]);
    return dto!;
  },

  /**
   * Update a rule. Amount changes append an immutable BudgetRuleHistory row
   * inside the same transaction — past reported limits stay auditable.
   */
  async update(
    id: string,
    patch: {
      monthlyAmount?: number;
      increaseThresholdPercent?: number | null;
      isActive?: boolean;
    },
    admin: RequestUser
  ): Promise<BudgetRowDTO> {
    const existing = await prisma.budgetRule.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Budget rule not found.");

    await prisma.$transaction(async (tx) => {
      if (
        patch.monthlyAmount !== undefined &&
        !toDecimal(patch.monthlyAmount).eq(existing.monthlyAmount)
      ) {
        await tx.budgetRuleHistory.create({
          data: {
            budgetRuleId: id,
            previousAmount: existing.monthlyAmount,
            newAmount: new Prisma.Decimal(patch.monthlyAmount),
            changedById: admin.id,
          },
        });
      }
      await tx.budgetRule.update({
        where: { id },
        data: {
          ...(patch.monthlyAmount !== undefined
            ? { monthlyAmount: new Prisma.Decimal(patch.monthlyAmount) }
            : {}),
          ...(patch.increaseThresholdPercent !== undefined
            ? {
                increaseThresholdPercent:
                  patch.increaseThresholdPercent === null
                    ? null
                    : new Prisma.Decimal(patch.increaseThresholdPercent),
              }
            : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        },
      });
    });

    return this.getById(id, admin);
  },

  /** Permanent delete — budget history rows cascade with the rule. */
  async remove(id: string, _admin: RequestUser): Promise<void> {
    const existing = await prisma.budgetRule.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Budget rule not found.");
    await prisma.budgetRule.delete({ where: { id } });
  },

  /** Budget-vs-actual summary for a month — admin only. */
  async summary(q: { month?: number; year?: number }, _admin: RequestUser) {
    const now = new Date();
    const month = q.month ?? now.getUTCMonth() + 1;
    const year = q.year ?? now.getUTCFullYear();
    const effectiveMonth = firstOfMonth(year, month);

    const rules = await prisma.budgetRule.findMany({
      where: { effectiveMonth, isActive: true },
      include: {
        dealership: { select: { name: true } },
        category: { select: { name: true } },
        createdBy: { select: { fullName: true } },
        history: { include: { changedBy: { select: { fullName: true } } } },
      },
    });
    const { approved, pending } = await spendMap([effectiveMonth]);
    const rows = rules.map((b) =>
      toBudgetRowDTO(
        b,
        approved.get(spendKey(b.dealershipId, b.categoryId, b.effectiveMonth)) ??
          new Prisma.Decimal(0),
        pending.get(spendKey(b.dealershipId, b.categoryId, b.effectiveMonth)) ??
          new Prisma.Decimal(0)
      )
    );
    return { month, year, items: rows };
  },
};
