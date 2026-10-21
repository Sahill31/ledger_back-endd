import {
  BillStatus,
  ScheduleStatus,
  type BillSchedule,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../config/database";
import { moneyToNumber } from "../utils/money";

/**
 * Frontend-compatible derived status. The stored enum tracks workflow state;
 * the list DTO derives the task-view status the React app renders.
 */
export type DerivedScheduleStatus =
  | "scheduled"
  | "due_soon"
  | "overdue"
  | "missing"
  | "submitted"
  | "completed"
  | "cancelled";

export function deriveScheduleStatus(
  schedule: BillSchedule,
  hasActiveBill: boolean,
  today: Date
): DerivedScheduleStatus {
  if (schedule.status === ScheduleStatus.CANCELLED) return "cancelled";
  if (schedule.status === ScheduleStatus.COMPLETED) return "completed";
  if (hasActiveBill || schedule.status === ScheduleStatus.SUBMITTED) return "submitted";

  const deadline = schedule.submissionDeadline;
  const dayMs = 24 * 60 * 60 * 1000;
  const deadlineDay = Date.UTC(
    deadline.getUTCFullYear(),
    deadline.getUTCMonth(),
    deadline.getUTCDate()
  );
  const todayDay = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  );
  if (deadlineDay < todayDay - 3 * dayMs) return "missing";
  if (deadlineDay < todayDay) return "overdue";
  if (deadlineDay <= todayDay + 7 * dayMs) return "due_soon";
  return "scheduled";
}

type ScheduleWithRefs = BillSchedule & {
  dealership: { name: string; code: string };
  category: { name: string };
  assignedAccountant?: { id: string; fullName: string } | null;
  bills?: { id: string; status: BillStatus; amount: Prisma.Decimal }[];
};

export interface ScheduledTaskDTO {
  id: string;
  dealershipId: string;
  categoryId: string;
  assignedAccountantId?: string;
  assignedAccountantName?: string;
  billingPeriod: { month: number; year: number };
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  submissionDeadline: string;
  recurring: boolean;
  notes?: string;
  status: DerivedScheduleStatus;
  workflowStatus: ScheduleStatus;
  cancelledReason?: string;
  dealershipName: string;
  dealershipCode: string;
  categoryName: string;
  billId?: string;
  /** Minimal info about the active (non-rejected) bill for this schedule. */
  billStatus?: BillStatus;
  billAmount?: number;
  createdAt: string;
}

export function toScheduledTaskDTO(
  s: ScheduleWithRefs,
  today: Date
): ScheduledTaskDTO {
  const hasActiveBill = (s.bills ?? []).some((b) => b.status !== BillStatus.REJECTED);
  const activeBill = (s.bills ?? []).find((b) => b.status !== BillStatus.REJECTED);
  const periodStart = s.billingPeriod;
  const periodEnd = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 0)
  );
  return {
    id: s.id,
    dealershipId: s.dealershipId,
    categoryId: s.categoryId,
    assignedAccountantId: s.assignedAccountantId ?? undefined,
    assignedAccountantName: s.assignedAccountant?.fullName,
    billingPeriod: {
      month: periodStart.getUTCMonth() + 1,
      year: periodStart.getUTCFullYear(),
    },
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    dueDate: s.dueDate.toISOString(),
    submissionDeadline: s.submissionDeadline.toISOString(),
    recurring: s.recurring,
    notes: s.instructions ?? undefined,
    status: deriveScheduleStatus(s, hasActiveBill, today),
    workflowStatus: s.status,
    cancelledReason: s.cancelledReason ?? undefined,
    dealershipName: s.dealership.name,
    dealershipCode: s.dealership.code,
    categoryName: s.category.name,
    billId: activeBill?.id,
    billStatus: activeBill?.status,
    billAmount: activeBill ? moneyToNumber(activeBill.amount) : undefined,
    createdAt: s.createdAt.toISOString(),
  };
}

export const scheduleInclude = {
  dealership: { select: { name: true, code: true } },
  category: { select: { name: true } },
  assignedAccountant: { select: { id: true, fullName: true } },
  bills: { select: { id: true, status: true, amount: true } },
} as const;

export const scheduleModel = {
  findById(id: string) {
    return prisma.billSchedule.findUnique({ where: { id }, include: scheduleInclude });
  },
  list(args: { where: Prisma.BillScheduleWhereInput; skip: number; take: number }) {
    const { where, skip, take } = args;
    return Promise.all([
      prisma.billSchedule.findMany({
        where,
        include: scheduleInclude,
        orderBy: { submissionDeadline: "asc" },
        skip,
        take,
      }),
      prisma.billSchedule.count({ where }),
    ]);
  },
};
