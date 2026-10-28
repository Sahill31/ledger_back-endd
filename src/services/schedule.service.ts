import { BillStatus, Prisma, ScheduleStatus, UserRole } from "@prisma/client";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";
import { firstOfMonth } from "../utils/date";
import {
  scheduleInclude,
  scheduleModel,
  toScheduledTaskDTO,
  type ScheduledTaskDTO,
} from "../models/schedule.model";
import { paginate, skipTake, type Paginated, type Pagination } from "../utils/pagination";
import type { RequestUser } from "../middleware/authenticate";

interface ListQuery extends Pagination {
  dealershipId?: string;
  categoryId?: string;
  status?: string;
  month?: number;
  year?: number;
  search?: string;
  dueWithinDays?: number;
}

/** Status values as exposed by the API (derived + workflow statuses). */
const DERIVED = new Set(["scheduled", "due_soon", "overdue", "missing", "submitted", "completed", "cancelled"]);

async function validateAssignee(assignedAccountantId: string, dealershipId: string) {
  const u = await prisma.user.findUnique({ where: { id: assignedAccountantId } });
  if (!u || u.role !== UserRole.ACCOUNTANT) {
    throw ApiError.unprocessable("Assigned user must be an accountant account.");
  }
  if (!u.isActive) throw ApiError.unprocessable("Assigned accountant is inactive.");
  const assignment = await prisma.dealershipAssignment.findUnique({
    where: {
      userId_dealershipId: { userId: assignedAccountantId, dealershipId },
    },
  });
  if (!assignment) {
    throw ApiError.unprocessable("Assigned accountant is not assigned to this dealership.");
  }
}

/** Where-clause scoping: accountants see schedules for their dealerships only. */
function scopeWhere(q: ListQuery, user: RequestUser): Prisma.BillScheduleWhereInput {
  const where: Prisma.BillScheduleWhereInput = {};
  if (user.role === "ACCOUNTANT") {
    if (q.dealershipId && !user.dealershipIds.includes(q.dealershipId)) {
      // Asking for a dealership outside scope → empty result, not an error.
      where.dealershipId = "__none__";
    } else {
      where.AND = [
        { dealershipId: { in: q.dealershipId ? [q.dealershipId] : user.dealershipIds } },
        { OR: [{ assignedAccountantId: null }, { assignedAccountantId: user.id }] },
      ];
    }
  } else if (q.dealershipId) {
    where.dealershipId = q.dealershipId;
  }

  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.month && q.year) where.billingPeriod = firstOfMonth(q.year, q.month);
  else if (q.year) {
    where.billingPeriod = { gte: firstOfMonth(q.year, 1), lte: firstOfMonth(q.year, 12) };
  }
  if (q.dueWithinDays !== undefined) {
    const limit = new Date();
    limit.setUTCDate(limit.getUTCDate() + q.dueWithinDays);
    where.submissionDeadline = { lte: limit };
  }
  if (q.search) {
    where.AND = [
      ...((where.AND as Prisma.BillScheduleWhereInput[]) ?? []),
      {
        OR: [
          { dealership: { name: { contains: q.search, mode: "insensitive" } } },
          { dealership: { code: { contains: q.search, mode: "insensitive" } } },
          { category: { name: { contains: q.search, mode: "insensitive" } } },
        ],
      },
    ];
  }
  return where;
}

function matchesDerived(dto: ScheduledTaskDTO, status?: string): boolean {
  if (!status || status === "all" || !DERIVED.has(status)) return true;
  return dto.status === status;
}

export const scheduleService = {
  async list(q: ListQuery, user: RequestUser): Promise<Paginated<ScheduledTaskDTO>> {
    const where = scopeWhere(q, user);
    // Workflow-status shortcuts: some derived statuses map to stored values.
    if (q.status === "cancelled") where.status = ScheduleStatus.CANCELLED;
    if (q.status === "completed") where.status = ScheduleStatus.COMPLETED;

    const [rows, total] = await scheduleModel.list({ where, ...skipTake(q) });
    const today = new Date();
    let items = rows.map((s) => toScheduledTaskDTO(s, today));
    if (q.status && q.status !== "cancelled" && q.status !== "completed") {
      items = items.filter((i) => matchesDerived(i, q.status));
    }
    return paginate(items, total, q);
  },

  async getById(id: string, user: RequestUser): Promise<ScheduledTaskDTO> {
    const s = await scheduleModel.findById(id);
    if (!s) throw ApiError.notFound("Schedule not found.");
    if (user.role === "ACCOUNTANT") {
      const allowed =
        user.dealershipIds.includes(s.dealershipId) &&
        (!s.assignedAccountantId || s.assignedAccountantId === user.id);
      if (!allowed) throw ApiError.forbidden("You are not assigned to this schedule.");
    }
    return toScheduledTaskDTO(s, new Date());
  },

  async create(
    input: {
      dealershipId: string;
      categoryId: string;
      assignedAccountantId?: string;
      billingPeriod: { month: number; year: number };
      dueDate: Date;
      submissionDeadline: Date;
      recurring: boolean;
      instructions?: string;
    },
    admin: RequestUser
  ): Promise<ScheduledTaskDTO> {
    const [dealership, category] = await Promise.all([
      prisma.dealership.findUnique({ where: { id: input.dealershipId } }),
      prisma.billCategory.findUnique({ where: { id: input.categoryId } }),
    ]);
    if (!dealership || !dealership.isActive) {
      throw ApiError.unprocessable("Dealership does not exist or is inactive.");
    }
    if (!category || !category.isActive) {
      throw ApiError.unprocessable("Category does not exist or is inactive.");
    }
    if (input.assignedAccountantId) {
      await validateAssignee(input.assignedAccountantId, input.dealershipId);
    }
    if (input.submissionDeadline < input.dueDate) {
      // Allowed but unusual — submission deadline normally follows the vendor
      // due date. Kept permissive intentionally.
    }

    try {
      const s = await prisma.billSchedule.create({
        data: {
          dealershipId: input.dealershipId,
          categoryId: input.categoryId,
          assignedAccountantId: input.assignedAccountantId ?? null,
          billingPeriod: firstOfMonth(input.billingPeriod.year, input.billingPeriod.month),
          dueDate: input.dueDate,
          submissionDeadline: input.submissionDeadline,
          recurring: input.recurring,
          instructions: input.instructions,
          status: ScheduleStatus.SCHEDULED,
          createdById: admin.id,
        },
        include: scheduleInclude,
      });
      return toScheduledTaskDTO(s, new Date());
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw ApiError.conflict(
          "An active schedule already exists for this dealership, category and billing period."
        );
      }
      throw e;
    }
  },

  async update(
    id: string,
    patch: {
      assignedAccountantId?: string | null;
      dueDate?: Date;
      submissionDeadline?: Date;
      recurring?: boolean;
      instructions?: string | null;
    },
    _admin: RequestUser
  ): Promise<ScheduledTaskDTO> {
    const s = await prisma.billSchedule.findUnique({ where: { id } });
    if (!s) throw ApiError.notFound("Schedule not found.");
    if (s.status === ScheduleStatus.CANCELLED) {
      throw ApiError.unprocessable("Cancelled schedules cannot be modified.");
    }
    if (patch.assignedAccountantId) {
      await validateAssignee(patch.assignedAccountantId, s.dealershipId);
    }
    const updated = await prisma.billSchedule.update({
      where: { id },
      data: {
        ...(patch.assignedAccountantId !== undefined
          ? { assignedAccountantId: patch.assignedAccountantId }
          : {}),
        ...(patch.dueDate ? { dueDate: patch.dueDate } : {}),
        ...(patch.submissionDeadline ? { submissionDeadline: patch.submissionDeadline } : {}),
        ...(patch.recurring !== undefined ? { recurring: patch.recurring } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      },
      include: scheduleInclude,
    });
    return toScheduledTaskDTO(updated, new Date());
  },

  async cancel(id: string, reason: string, admin: RequestUser): Promise<ScheduledTaskDTO> {
    const s = await prisma.billSchedule.findUnique({ where: { id } });
    if (!s) throw ApiError.notFound("Schedule not found.");
    if (s.status === ScheduleStatus.CANCELLED) {
      throw ApiError.conflict("Schedule is already cancelled.");
    }
    const updated = await prisma.$transaction(async (tx) => {
      // Only a bill still pending review blocks cancellation. Approved or
      // rejected bills are settled — the schedule may be cancelled/closed out.
      const pendingBill = await tx.bill.findFirst({
        where: {
          scheduleId: id,
          status: {
            in: [
              BillStatus.SUBMITTED,
              BillStatus.UNDER_REVIEW,
              BillStatus.CORRECTION_REQUESTED,
            ],
          },
        },
      });
      if (pendingBill) {
        throw ApiError.conflict(
          "A submitted bill is still pending review. Approve or reject the bill first, then cancel the schedule."
        );
      }
      return tx.billSchedule.update({
        where: { id },
        data: {
          status: ScheduleStatus.CANCELLED,
          cancelledReason: reason,
          cancelledAt: new Date(),
        },
        include: scheduleInclude,
      });
    });
    void admin;
    return toScheduledTaskDTO(updated, new Date());
  },

  /**
   * Permanent delete — a schedule may be hard-deleted as long as no bill is
   * still pending review. Approved/rejected bills survive the delete
   * (bills.schedule_id is ON DELETE SET NULL) so financial history is kept;
   * they are simply unlinked from the removed schedule.
   */
  async remove(id: string, _admin: RequestUser): Promise<void> {
    const s = await prisma.billSchedule.findUnique({ where: { id } });
    if (!s) throw ApiError.notFound("Schedule not found.");
    const pendingBills = await prisma.bill.count({
      where: {
        scheduleId: id,
        status: {
          in: [
            BillStatus.SUBMITTED,
            BillStatus.UNDER_REVIEW,
            BillStatus.CORRECTION_REQUESTED,
          ],
        },
      },
    });
    if (pendingBills > 0) {
      throw ApiError.conflict(
        "Cannot permanently delete: a submitted bill is still pending review. Approve or reject the bill first, then delete the schedule."
      );
    }
    await prisma.billSchedule.delete({ where: { id } });
  },
};
