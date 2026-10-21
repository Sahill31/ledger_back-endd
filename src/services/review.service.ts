import { BillStatus, ReviewDecision, ScheduleStatus } from "@prisma/client";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";
import { toBillRowDTO, type BillRowDTO } from "../models/bill.model";
import { reviewHistoryModel } from "../models/reviewHistory.model";
import type { RequestUser } from "../middleware/authenticate";
import { notificationService } from "./notification.service";

/**
 * ADMIN-ONLY review decisions. Every decision appends an immutable
 * BillReviewHistory row inside the same transaction as the bill update.
 */

type Decision = "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "CORRECTION_REQUESTED";

const ALLOWED: Record<BillStatus, Decision[]> = {
  SUBMITTED: ["UNDER_REVIEW", "APPROVED", "REJECTED", "CORRECTION_REQUESTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "CORRECTION_REQUESTED"],
  CORRECTION_REQUESTED: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: ["UNDER_REVIEW"],
};

const NOTIF: Record<Decision, { type: "approved" | "rejected" | "correction_requested" | "system"; title: string }> = {
  APPROVED: { type: "approved", title: "Bill approved" },
  REJECTED: { type: "rejected", title: "Bill rejected" },
  CORRECTION_REQUESTED: { type: "correction_requested", title: "Corrections requested" },
  UNDER_REVIEW: { type: "system", title: "Bill under review" },
};

export const reviewService = {
  async decide(
    billId: string,
    input: { decision: Decision; reason?: string; notes?: string },
    admin: RequestUser
  ): Promise<BillRowDTO> {
    const bill = await prisma.bill.findUnique({ where: { id: billId } });
    if (!bill) throw ApiError.notFound("Bill not found.");

    const allowed = ALLOWED[bill.status];
    if (!allowed.includes(input.decision)) {
      throw ApiError.conflict(
        `Cannot transition a ${bill.status.toLowerCase()} bill to ${input.decision.toLowerCase()}.`
      );
    }
    if ((input.decision === "REJECTED" || input.decision === "CORRECTION_REQUESTED") && !input.reason?.trim()) {
      throw ApiError.unprocessable(
        input.decision === "REJECTED"
          ? "A rejection reason is required."
          : "Correction instructions are required."
      );
    }

    const newStatus = input.decision as BillStatus;

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.bill.update({
        where: { id: billId },
        data: {
          status: newStatus,
          reviewedById: admin.id,
          reviewedAt: new Date(),
          rejectionReason:
            input.decision === "REJECTED" ? input.reason!.trim() : null,
          adminNotes:
            input.decision === "CORRECTION_REQUESTED"
              ? input.reason!.trim()
              : input.notes ?? bill.adminNotes,
        },
        include: {
          dealership: { select: { name: true, code: true } },
          category: { select: { name: true } },
          submittedBy: { select: { fullName: true } },
        },
      });

      await reviewHistoryModel.create(tx, {
        billId,
        reviewerId: admin.id,
        previousStatus: bill.status,
        newStatus,
        decision: input.decision as ReviewDecision,
        reason: input.reason?.trim(),
        notes: input.notes,
      });

      // Reconcile the schedule with the review outcome.
      if (bill.scheduleId) {
        if (input.decision === "APPROVED") {
          await tx.billSchedule.update({
            where: { id: bill.scheduleId },
            data: { status: ScheduleStatus.COMPLETED },
          });
        } else if (input.decision === "REJECTED") {
          // Frees the schedule slot — the partial unique index no longer blocks
          // a fresh submission for this period.
          const today = new Date();
          const s = await tx.billSchedule.findUnique({ where: { id: bill.scheduleId } });
          await tx.billSchedule.update({
            where: { id: bill.scheduleId },
            data: {
              status:
                s && s.submissionDeadline < today ? ScheduleStatus.OVERDUE : ScheduleStatus.SCHEDULED,
            },
          });
        }
      }

      await notificationService.notify(
        [
          {
            recipientId: bill.submittedById,
            type: NOTIF[input.decision].type,
            title: NOTIF[input.decision].title,
            message:
              input.decision === "APPROVED"
                ? `Bill ${bill.billReference} was approved by ${admin.fullName}.`
                : input.decision === "REJECTED"
                  ? `Bill ${bill.billReference} was rejected: ${input.reason!.trim()}`
                  : input.decision === "CORRECTION_REQUESTED"
                    ? `Corrections requested on ${bill.billReference}: ${input.reason!.trim()}`
                    : `Bill ${bill.billReference} is now under review.`,
            relatedEntityType: "bill",
            relatedEntityId: bill.id,
          },
        ],
        tx
      );

      return b;
    });

    return toBillRowDTO(updated);
  },
};
