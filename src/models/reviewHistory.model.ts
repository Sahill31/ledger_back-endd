import type { BillStatus, ReviewDecision } from "@prisma/client";
import { prisma } from "../config/database";

/**
 * Review history is append-only. There is intentionally no update or delete
 * method — audit records are immutable.
 */
export const reviewHistoryModel = {
  listForBill(billId: string) {
    return prisma.billReviewHistory.findMany({
      where: { billId },
      include: { reviewer: { select: { fullName: true } } },
      orderBy: { createdAt: "desc" },
    });
  },
  create(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    data: {
      billId: string;
      reviewerId: string;
      previousStatus: BillStatus | null;
      newStatus: BillStatus;
      decision: ReviewDecision;
      reason?: string;
      notes?: string;
    }
  ) {
    return tx.billReviewHistory.create({ data });
  },
};
