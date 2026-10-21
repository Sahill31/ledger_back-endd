import { BillStatus, ScheduleStatus } from "@prisma/client";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { logger } from "../config/logger";

/**
 * Deadline sweep — idempotent and safe to run repeatedly.
 *
 *   • Schedules past their submission deadline without a bill → OVERDUE,
 *     plus a one-time overdue notification (dedup key per schedule).
 *   • Schedules due today → DUE_TODAY + one-time reminder.
 *   • Schedules due within 7 days → UPCOMING + one-time reminder.
 *   • Schedules whose bill was submitted/approved externally are reconciled
 *     to SUBMITTED / COMPLETED.
 *
 * Single-instance limitation: the optional in-process timer is fine for a
 * single-node deployment. For multi-instance deployments keep
 * ENABLE_IN_PROCESS_JOBS=false and call POST /api/v1/jobs/overdue-sweep with
 * header `x-job-secret` from an external scheduler.
 */

export interface SweepResult {
  reconciled: number;
  markedUpcoming: number;
  markedDueToday: number;
  markedOverdue: number;
  notificationsCreated: number;
}

function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function runOverdueSweep(now: Date = new Date()): Promise<SweepResult> {
  const today = utcDay(now);
  const dayMs = 86_400_000;

  // ------------------------------------------------------------------
  // 1. Reconcile: schedules that already have an active bill but whose
  //    stored status is stale.
  // ------------------------------------------------------------------
  const withBills = await prisma.billSchedule.findMany({
    where: {
      status: { notIn: [ScheduleStatus.CANCELLED, ScheduleStatus.SUBMITTED, ScheduleStatus.COMPLETED] },
      bills: { some: { status: { not: BillStatus.REJECTED } } },
    },
    include: { bills: { where: { status: { not: BillStatus.REJECTED } }, select: { status: true } } },
  });
  let reconciled = 0;
  for (const s of withBills) {
    const allApproved = s.bills.length > 0 && s.bills.every((b) => b.status === BillStatus.APPROVED);
    const target = allApproved ? ScheduleStatus.COMPLETED : ScheduleStatus.SUBMITTED;
    await prisma.billSchedule.update({ where: { id: s.id }, data: { status: target } });
    reconciled += 1;
  }

  // ------------------------------------------------------------------
  // 2. Open schedules (no active bill) — derive deadline status + notify.
  // ------------------------------------------------------------------
  const open = await prisma.billSchedule.findMany({
    where: {
      status: { in: [ScheduleStatus.SCHEDULED, ScheduleStatus.UPCOMING, ScheduleStatus.DUE_TODAY, ScheduleStatus.OVERDUE] },
      bills: { none: { status: { not: BillStatus.REJECTED } } },
    },
    include: {
      dealership: { select: { name: true } },
      category: { select: { name: true } },
      assignedAccountant: { select: { id: true, fullName: true, isActive: true } },
    },
  });

  const notifications: {
    recipientId: string;
    type: "overdue" | "deadline_approaching" | "missing_bill";
    title: string;
    message: string;
    relatedEntityType: string;
    relatedEntityId: string;
    deduplicationKey: string;
  }[] = [];

  let markedUpcoming = 0, markedDueToday = 0, markedOverdue = 0;

  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  });

  /** Recipients: the assigned accountant if any, else all active accountants on the dealership. */
  async function recipientsFor(s: (typeof open)[number]): Promise<string[]> {
    if (s.assignedAccountantId && s.assignedAccountant?.isActive) {
      return [s.assignedAccountantId];
    }
    const rows = await prisma.dealershipAssignment.findMany({
      where: { dealershipId: s.dealershipId, user: { isActive: true, role: "ACCOUNTANT" } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  for (const s of open) {
    const deadline = utcDay(s.submissionDeadline);
    const label = `${s.dealership.name} / ${s.category.name}`;

    if (deadline < today) {
      if (s.status !== ScheduleStatus.OVERDUE) {
        await prisma.billSchedule.update({ where: { id: s.id }, data: { status: ScheduleStatus.OVERDUE } });
      }
      markedOverdue += 1;
      for (const rid of await recipientsFor(s)) {
        notifications.push({
          recipientId: rid,
          type: "overdue",
          title: "Bill submission overdue",
          message: `The ${label} bill for this period is overdue. Please submit it as soon as possible.`,
          relatedEntityType: "schedule",
          relatedEntityId: s.id,
          deduplicationKey: `schedule:${s.id}:overdue`,
        });
      }
      // Admins get missing-bill alerts for >3 days overdue.
      if (deadline < today - 3 * dayMs) {
        for (const a of admins) {
          notifications.push({
            recipientId: a.id,
            type: "missing_bill",
            title: "Missing bill",
            message: `No bill has been submitted for ${label}; the deadline passed over 3 days ago.`,
            relatedEntityType: "schedule",
            relatedEntityId: s.id,
            deduplicationKey: `schedule:${s.id}:missing`,
          });
        }
      }
    } else if (deadline === today) {
      if (s.status !== ScheduleStatus.DUE_TODAY) {
        await prisma.billSchedule.update({ where: { id: s.id }, data: { status: ScheduleStatus.DUE_TODAY } });
      }
      markedDueToday += 1;
      for (const rid of await recipientsFor(s)) {
        notifications.push({
          recipientId: rid,
          type: "deadline_approaching",
          title: "Bill due today",
          message: `The ${label} bill is due today.`,
          relatedEntityType: "schedule",
          relatedEntityId: s.id,
          deduplicationKey: `schedule:${s.id}:due_today`,
        });
      }
    } else if (deadline <= today + 7 * dayMs) {
      if (s.status !== ScheduleStatus.UPCOMING && s.status !== ScheduleStatus.DUE_TODAY) {
        await prisma.billSchedule.update({ where: { id: s.id }, data: { status: ScheduleStatus.UPCOMING } });
      }
      markedUpcoming += 1;
      for (const rid of await recipientsFor(s)) {
        notifications.push({
          recipientId: rid,
          type: "deadline_approaching",
          title: "Bill deadline approaching",
          message: `The ${label} bill is due on ${s.submissionDeadline.toISOString().slice(0, 10)}.`,
          relatedEntityType: "schedule",
          relatedEntityId: s.id,
          deduplicationKey: `schedule:${s.id}:due_soon`,
        });
      }
    } else if (s.status !== ScheduleStatus.SCHEDULED) {
      await prisma.billSchedule.update({ where: { id: s.id }, data: { status: ScheduleStatus.SCHEDULED } });
    }
  }

  const notifResult = await prisma.notification.createMany({
    data: notifications,
    skipDuplicates: true,
  });

  const result: SweepResult = {
    reconciled,
    markedUpcoming,
    markedDueToday,
    markedOverdue,
    notificationsCreated: notifResult.count,
  };
  logger.info(result, "overdue schedule sweep completed");
  return result;
}

let timer: NodeJS.Timeout | null = null;

/** Start the optional in-process scheduler (single-instance deployments). */
export function startInProcessJobs() {
  if (!env.ENABLE_IN_PROCESS_JOBS || timer) return;
  const intervalMs = env.OVERDUE_SWEEP_INTERVAL_MINUTES * 60 * 1000;
  timer = setInterval(() => {
    runOverdueSweep().catch((err) => logger.error({ err }, "overdue sweep failed"));
  }, intervalMs);
  timer.unref();
  logger.info({ intervalMinutes: env.OVERDUE_SWEEP_INTERVAL_MINUTES }, "in-process overdue sweep started");
  // Also run once shortly after boot.
  setTimeout(() => runOverdueSweep().catch((e) => logger.error({ e }, "boot sweep failed")), 10_000).unref();
}

export function stopInProcessJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}
