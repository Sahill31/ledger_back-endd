import { Prisma, type BudgetRule } from "@prisma/client";
import { prisma } from "../config/database";
import { moneyToNumber, percentUsed } from "../utils/money";

type BudgetWithNames = BudgetRule & {
  dealership?: { name: string } | null;
  category?: { name: string } | null;
  createdBy?: { fullName: string } | null;
  history?: { previousAmount: Prisma.Decimal; newAmount: Prisma.Decimal; createdAt: Date; changedBy: { fullName: string } }[];
};

/**
 * ADMIN-ONLY DTO. Budget data must never be serialized into accountant
 * responses — see assertDealershipAccess + authorizeRole guards.
 */
export interface BudgetRowDTO {
  id: string;
  dealershipId: string;
  categoryId: string;
  month: number;
  year: number;
  amount: number;
  increaseThresholdPercent?: number;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
  dealershipName: string;
  categoryName: string;
  /** Finalized spend = APPROVED bills only (documented actual-spending policy). */
  actual: number;
  /** Pending review spend — SUBMITTED/UNDER_REVIEW/CORRECTION_REQUESTED. */
  pending: number;
  remaining: number;
  utilization: number;
  history: { amount: number; changedAt: string; changedBy: string }[];
}

export function toBudgetRowDTO(
  b: BudgetWithNames,
  actual: Prisma.Decimal,
  pending: Prisma.Decimal
): BudgetRowDTO {
  const budget = b.monthlyAmount;
  const remaining = budget.minus(actual);
  return {
    id: b.id,
    dealershipId: b.dealershipId,
    categoryId: b.categoryId,
    month: b.effectiveMonth.getUTCMonth() + 1,
    year: b.effectiveMonth.getUTCFullYear(),
    amount: moneyToNumber(budget),
    increaseThresholdPercent: b.increaseThresholdPercent
      ? moneyToNumber(b.increaseThresholdPercent)
      : undefined,
    active: b.isActive,
    updatedAt: b.updatedAt.toISOString(),
    updatedBy: b.createdBy?.fullName ?? "",
    dealershipName: b.dealership?.name ?? "Unknown",
    categoryName: b.category?.name ?? "Unknown",
    actual: moneyToNumber(actual),
    pending: moneyToNumber(pending),
    remaining: moneyToNumber(remaining),
    utilization: percentUsed(actual, budget),
    history: (b.history ?? []).map((h) => ({
      amount: moneyToNumber(h.newAmount),
      changedAt: h.createdAt.toISOString(),
      changedBy: h.changedBy.fullName,
    })),
  };
}

export const budgetInclude = {
  dealership: { select: { name: true } },
  category: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  history: {
    orderBy: { createdAt: "desc" as const },
    include: { changedBy: { select: { fullName: true } } },
  },
};

export const budgetModel = {
  findById(id: string) {
    return prisma.budgetRule.findUnique({ where: { id }, include: budgetInclude });
  },
  findRule(dealershipId: string, categoryId: string, effectiveMonth: Date) {
    return prisma.budgetRule.findUnique({
      where: {
        dealershipId_categoryId_effectiveMonth: {
          dealershipId,
          categoryId,
          effectiveMonth,
        },
      },
    });
  },
  list(args: { where: Prisma.BudgetRuleWhereInput; skip: number; take: number }) {
    const { where, skip, take } = args;
    return Promise.all([
      prisma.budgetRule.findMany({
        where,
        include: budgetInclude,
        orderBy: [{ effectiveMonth: "desc" }, { dealership: { name: "asc" } }],
        skip,
        take,
      }),
      prisma.budgetRule.count({ where }),
    ]);
  },
  /**
   * Aggregated spending per dealership+category+period. Runs a single GROUP BY
   * in Postgres — never materializes rows to compute totals.
   */
  async spendByPeriod(months: Date[]) {
    const rows = await prisma.bill.groupBy({
      by: ["dealershipId", "categoryId", "billingPeriod", "status"],
      where: { billingPeriod: { in: months } },
      _sum: { amount: true },
    });
    return rows;
  },
};
