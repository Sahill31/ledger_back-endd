import {
  BillStatus,
  Prisma,
  type Bill,
  type BillReviewHistory,
} from "@prisma/client";
import { prisma } from "../config/database";
import { moneyToNumber } from "../utils/money";

type BillWithRefs = Bill & {
  dealership?: { name: string; code: string } | null;
  category?: { name: string } | null;
  submittedBy?: { fullName: string } | null;
};

export type BillStatusDTO =
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "correction_requested";

export function billStatusToDTO(s: BillStatus): BillStatusDTO {
  return s.toLowerCase() as BillStatusDTO;
}

export type BudgetStatusDTO = "within_budget" | "over_budget" | "no_budget";

export interface BillRowDTO {
  id: string;
  billReference: string;
  scheduleId?: string;
  dealershipId: string;
  categoryId: string;
  submittedById: string;
  submittedByName: string;
  amount: number;
  currency: string;
  billDate: string;
  billingPeriod: { month: number; year: number };
  referenceNumber?: string;
  fileName: string;
  fileType: "pdf" | "jpg" | "png";
  fileSizeKb: number;
  status: BillStatusDTO;
  rejectionReason?: string;
  accountantNotes?: string;
  adminNotes?: string;
  resubmissionCount: number;
  submittedAt: string;
  reviewedAt?: string;
  dealershipName: string;
  dealershipCode: string;
  categoryName: string;

  // --- Extraction / consumer identity ---
  consumerNumber?: string;
  meterNumber?: string;
  unitsKwh?: number;
  currentPeriodAmount?: number;
  previousBillAmount?: number;
  previousBillId?: string;
  scanId?: string;
  extractionWarnings?: string[];
  /**
   * Status only — safe for accountants. Budget figures (amount, variance,
   * utilization) are NEVER serialized for non-admin callers.
   */
  budgetStatus?: BudgetStatusDTO;

  /** ADMIN ONLY — populated only when toBillRowDTO(bill, {admin:true}). */
  budgetComparison?: {
    status: BudgetStatusDTO;
    comparisonAmount: number;
    budgetAmount: number | null;
    varianceAmount: number | null;
    utilizationPercentage: number | null;
  };
}

function mimeToFileType(mime: string): "pdf" | "jpg" | "png" {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  return "jpg";
}

/** Response DTO — deliberately excludes documentKey (private storage path). */
export function toBillRowDTO(b: BillWithRefs, opts?: { admin?: boolean }): BillRowDTO {
  const dto: BillRowDTO = {
    id: b.id,
    billReference: b.billReference,
    scheduleId: b.scheduleId ?? undefined,
    dealershipId: b.dealershipId,
    categoryId: b.categoryId,
    submittedById: b.submittedById,
    submittedByName: b.submittedBy?.fullName ?? "Unknown",
    amount: moneyToNumber(b.amount),
    currency: b.currency,
    billDate: b.billingDate.toISOString(),
    billingPeriod: {
      month: b.billingPeriod.getUTCMonth() + 1,
      year: b.billingPeriod.getUTCFullYear(),
    },
    referenceNumber: b.referenceNumber ?? undefined,
    fileName: b.originalDocumentName,
    fileType: mimeToFileType(b.mimeType),
    fileSizeKb: Math.round(b.fileSizeBytes / 1024),
    status: billStatusToDTO(b.status),
    rejectionReason: b.rejectionReason ?? undefined,
    accountantNotes: b.accountantNotes ?? undefined,
    adminNotes: b.adminNotes ?? undefined,
    resubmissionCount: b.resubmissionCount,
    submittedAt: b.submittedAt.toISOString(),
    reviewedAt: b.reviewedAt?.toISOString(),
    dealershipName: b.dealership?.name ?? "Unknown",
    dealershipCode: b.dealership?.code ?? "—",
    categoryName: b.category?.name ?? "Unknown",

    consumerNumber: b.consumerNumber ?? undefined,
    meterNumber: b.meterNumber ?? undefined,
    unitsKwh: b.unitsKwh === null ? undefined : Number(b.unitsKwh),
    currentPeriodAmount:
      b.currentPeriodAmount === null ? undefined : moneyToNumber(b.currentPeriodAmount),
    previousBillAmount:
      b.previousBillAmount === null ? undefined : moneyToNumber(b.previousBillAmount),
    previousBillId: b.previousBillId ?? undefined,
    scanId: b.scanId ?? undefined,
    extractionWarnings: (b.extractionWarnings as string[] | null) ?? undefined,
    budgetStatus: b.budgetStatus
      ? (b.budgetStatus.toLowerCase() as BudgetStatusDTO)
      : undefined,
  };

  if (opts?.admin && b.budgetStatus && b.budgetComparisonAmount !== null) {
    const comparison = new Prisma.Decimal(b.budgetComparisonAmount);
    const budget = b.budgetAmount === null ? null : new Prisma.Decimal(b.budgetAmount);
    dto.budgetComparison = {
      status: dto.budgetStatus!,
      comparisonAmount: moneyToNumber(comparison),
      budgetAmount: budget === null ? null : moneyToNumber(budget),
      varianceAmount:
        budget === null ? null : moneyToNumber(comparison.sub(budget)),
      utilizationPercentage:
        budget === null || budget.isZero()
          ? null
          : Number(comparison.div(budget).mul(100).toDecimalPlaces(1)),
    };
  }
  return dto;
}

export const billInclude = {
  dealership: { select: { name: true, code: true } },
  category: { select: { name: true } },
  submittedBy: { select: { fullName: true } },
} as const;

export const billModel = {
  findById(id: string) {
    return prisma.bill.findUnique({ where: { id }, include: billInclude });
  },
  findByReference(ref: string) {
    return prisma.bill.findUnique({ where: { billReference: ref }, include: billInclude });
  },
  list(args: { where: Prisma.BillWhereInput; skip: number; take: number }) {
    const { where, skip, take } = args;
    return Promise.all([
      prisma.bill.findMany({
        where,
        include: billInclude,
        orderBy: { submittedAt: "desc" },
        skip,
        take,
      }),
      prisma.bill.count({ where }),
    ]);
  },
};

export interface ReviewEventDTO {
  id: string;
  action: string;
  actorId: string;
  actorName: string;
  previousStatus?: string;
  newStatus: string;
  note?: string;
  at: string;
}

export function toReviewEventDTO(
  h: BillReviewHistory & { reviewer: { fullName: string } }
): ReviewEventDTO {
  return {
    id: h.id,
    action: h.decision.toLowerCase(),
    actorId: h.reviewerId,
    actorName: h.reviewer.fullName,
    previousStatus: h.previousStatus?.toLowerCase(),
    newStatus: h.newStatus.toLowerCase(),
    note: h.reason ?? h.notes ?? undefined,
    at: h.createdAt.toISOString(),
  };
}
