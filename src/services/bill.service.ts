import { randomUUID } from "node:crypto";
import {
  BillStatus,
  DocumentScanStatus,
  Prisma,
  ReviewDecision,
  ScheduleStatus,
} from "@prisma/client";
import { prisma } from "../config/database";
import { billDocumentKey, storage } from "../config/storage";
import { ApiError } from "../utils/ApiError";
import { firstOfMonth } from "../utils/date";
import { budgetComparisonService } from "./budgetComparison.service";
import type { ExtractedBillFields } from "./documents/jvvnlBillExtractor.service";
import {
  billModel,
  toBillRowDTO,
  toReviewEventDTO,
  type BillRowDTO,
  type ReviewEventDTO,
} from "../models/bill.model";
import { reviewHistoryModel } from "../models/reviewHistory.model";
import { assertDealershipAccess } from "../middleware/authorizeRole";
import type { RequestUser } from "../middleware/authenticate";
import { paginate, skipTake, type Paginated, type Pagination } from "../utils/pagination";
import { notificationService } from "./notification.service";

/**
 * Bill submission & review workflow.
 *
 * Storage cannot join the Postgres transaction: the file is uploaded first,
 * then the DB transaction runs; on failure the uploaded object is deleted so
 * no orphans accumulate.
 */

export const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Magic-byte signature check — never trust the extension alone. */
export function assertFileSignature(buf: Buffer, mime: string): void {
  if (!ALLOWED_MIME.has(mime)) {
    throw ApiError.badRequest("Unsupported file type. Accepted: PDF, JPG, PNG.");
  }
  const head = buf.subarray(0, 8);
  const ok =
    (mime === "application/pdf" && head.subarray(0, 4).toString("latin1") === "%PDF") ||
    (mime === "image/jpeg" && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    (mime === "image/png" &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47);
  if (!ok) throw ApiError.badRequest("File contents do not match the declared type.");
}

export interface BillFieldsInput {
  scheduleId?: string;
  dealershipId: string;
  categoryId: string;
  billingPeriod: { month: number; year: number };
  billingDate: Date;
  amount: number;
  referenceNumber?: string;
  accountantNotes?: string;
  // Scan workflow — accountant-confirmed values override extracted ones.
  scanId?: string;
  consumerNumber?: string;
  meterNumber?: string;
  unitsKwh?: number;
  currentPeriodAmount?: number;
  previousBillAmount?: number;
}

interface ScanRow {
  id: string;
  uploadedById: string;
  status: DocumentScanStatus;
  documentKey: string;
  originalFileName: string;
  mimeType: string;
  fileSizeBytes: number;
  extractedJson: Prisma.JsonValue | null;
  warningsJson: Prisma.JsonValue | null;
  expiresAt: Date;
}

/**
 * Validates a scan for consumption: same uploader, unexpired, finished, and
 * not already consumed by another bill. Accountant-provided fields win over
 * extracted values.
 */
async function loadScanForBill(
  scanId: string | undefined,
  user: RequestUser
): Promise<ScanRow | null> {
  if (!scanId) return null;
  const scan = await prisma.documentScan.findUnique({
    where: { id: scanId },
    include: { bill: { select: { id: true, billReference: true } } },
  });
  if (!scan) throw ApiError.unprocessable("Scan not found — upload the document again.");
  if (scan.uploadedById !== user.id) {
    throw ApiError.forbidden("This scan belongs to a different accountant.");
  }
  if (scan.expiresAt.getTime() < Date.now()) {
    throw ApiError.unprocessable("This scan has expired — scan the document again.");
  }
  if (scan.bill) {
    throw ApiError.conflict(`This scan was already submitted as bill ${scan.bill.billReference}.`);
  }
  if (scan.status === DocumentScanStatus.PROCESSING) {
    throw ApiError.unprocessable("The scan is still processing — wait a moment and retry.");
  }
  return scan;
}

/** Most recent prior-period bill for the same consumer+dealership+category. */
async function findPreviousBill(
  tx: Prisma.TransactionClient,
  input: {
    dealershipId: string;
    categoryId: string;
    consumerNumber?: string | null;
    billingPeriod: Date;
    excludeId?: string;
  }
) {
  if (!input.consumerNumber) return null;
  return tx.bill.findFirst({
    where: {
      dealershipId: input.dealershipId,
      categoryId: input.categoryId,
      consumerNumber: input.consumerNumber,
      billingPeriod: { lt: input.billingPeriod },
      status: { not: BillStatus.REJECTED },
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
    orderBy: { billingPeriod: "desc" },
    select: { id: true, amount: true, billReference: true },
  });
}

/** Normalize consumer identifiers for matching/dedup (K-numbers etc.). */
export function normalizeConsumer(v: string | undefined | null): string | null {
  const t = v?.trim().toUpperCase().replace(/\s+/g, "");
  return t && t.length > 0 ? t : null;
}

async function nextBillReference(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<{ v: bigint }[]>`SELECT nextval('bill_reference_seq') AS v`;
  const seq = Number(rows[0]!.v);
  return `AL-${new Date().getUTCFullYear()}-${String(seq).padStart(6, "0")}`;
}

interface ListQuery extends Pagination {
  dealershipId?: string;
  categoryId?: string;
  status?: BillStatus;
  month?: number;
  year?: number;
  search?: string;
  submittedFrom?: Date;
  submittedTo?: Date;
}

function scopeWhere(q: ListQuery, user: RequestUser): Prisma.BillWhereInput {
  const where: Prisma.BillWhereInput = {};
  if (user.role === "ACCOUNTANT") {
    if (q.dealershipId && !user.dealershipIds.includes(q.dealershipId)) {
      where.dealershipId = "__none__";
    } else {
      where.dealershipId = { in: q.dealershipId ? [q.dealershipId] : user.dealershipIds };
    }
  } else if (q.dealershipId) {
    where.dealershipId = q.dealershipId;
  }
  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.status) where.status = q.status;
  if (q.month && q.year) where.billingPeriod = firstOfMonth(q.year, q.month);
  else if (q.year) {
    where.billingPeriod = { gte: firstOfMonth(q.year, 1), lte: firstOfMonth(q.year, 12) };
  }
  if (q.submittedFrom || q.submittedTo) {
    where.submittedAt = {
      ...(q.submittedFrom ? { gte: q.submittedFrom } : {}),
      ...(q.submittedTo ? { lte: q.submittedTo } : {}),
    };
  }
  if (q.search) {
    where.AND = [
      {
        OR: [
          { billReference: { contains: q.search, mode: "insensitive" } },
          { referenceNumber: { contains: q.search, mode: "insensitive" } },
          { originalDocumentName: { contains: q.search, mode: "insensitive" } },
          { submittedBy: { fullName: { contains: q.search, mode: "insensitive" } } },
          { dealership: { name: { contains: q.search, mode: "insensitive" } } },
          { dealership: { code: { contains: q.search, mode: "insensitive" } } },
          { category: { name: { contains: q.search, mode: "insensitive" } } },
        ],
      },
    ];
  }
  return where;
}

export const billService = {
  async list(q: ListQuery, user: RequestUser): Promise<Paginated<BillRowDTO>> {
    const where = scopeWhere(q, user);
    const admin = user.role === "ADMIN";
    const [rows, total] = await billModel.list({ where, ...skipTake(q) });
    return paginate(rows.map((b) => toBillRowDTO(b, { admin })), total, q);
  },

  async getById(id: string, user: RequestUser): Promise<BillRowDTO> {
    const bill = await billModel.findById(id);
    if (!bill) throw ApiError.notFound("Bill not found.");
    assertDealershipAccess(user, bill.dealershipId);
    return toBillRowDTO(bill, { admin: user.role === "ADMIN" });
  },

  /**
   * Accountant submission. File uploaded to private storage first; the bill +
   * audit entry + schedule update + admin notifications commit in ONE
   * transaction; the object is removed if the transaction fails.
   *
   * When `fields.scanId` is present the document comes from the scan row
   * (no separate upload): the scan must belong to the accountant, be
   * unexpired, and not already consumed. Extracted values fill any fields
   * the accountant left blank; confirmed fields always win.
   */
  async submit(
    fields: BillFieldsInput,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | null,
    user: RequestUser
  ): Promise<BillRowDTO> {
    if (user.role !== "ACCOUNTANT") {
      throw ApiError.forbidden("Only accountants submit bills.");
    }
    assertDealershipAccess(user, fields.dealershipId);

    const billingPeriod = firstOfMonth(fields.billingPeriod.year, fields.billingPeriod.month);
    const consumerNumber = normalizeConsumer(fields.consumerNumber);
    const billId = randomUUID();

    // --- Scan consumption (document already in private storage) ----------
    const scan = await loadScanForBill(fields.scanId, user);
    const extracted = (scan?.extractedJson as ExtractedBillFields | null) ?? null;

    if (!scan && !file) {
      throw ApiError.badRequest("A bill document file is required.");
    }

    let key: string;
    let docName: string;
    let docMime: string;
    let docSize: number;
    let uploadedNewFile = false;
    if (scan) {
      key = scan.documentKey;
      docName = scan.originalFileName;
      docMime = scan.mimeType;
      docSize = scan.fileSizeBytes;
    } else {
      assertFileSignature(file!.buffer, file!.mimetype);
      key = billDocumentKey(fields.dealershipId, billId, MIME_EXT[file!.mimetype]!);
      docName = file!.originalname;
      docMime = file!.mimetype;
      docSize = file!.size;
      await storage.upload(key, file!.buffer, file!.mimetype);
      uploadedNewFile = true;
    }

    try {
      const bill = await prisma.$transaction(async (tx) => {
        // Validate schedule linkage + consistency inside the transaction.
        // Advisory lock serializes concurrent submissions for the same
        // dealership+category+period — prevents race-condition duplicates.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${fields.dealershipId}:${fields.categoryId}:${billingPeriod.toISOString()}`}))`;

        if (fields.scheduleId) {
          const schedule = await tx.billSchedule.findUnique({ where: { id: fields.scheduleId } });
          if (!schedule) throw ApiError.unprocessable("Schedule does not exist.");
          if (schedule.status === ScheduleStatus.CANCELLED) {
            throw ApiError.unprocessable("Cannot submit against a cancelled schedule.");
          }
          if (schedule.dealershipId !== fields.dealershipId || schedule.categoryId !== fields.categoryId) {
            throw ApiError.unprocessable("Bill dealership/category does not match the schedule.");
          }
          const existing = await tx.bill.findFirst({
            where: { scheduleId: fields.scheduleId, status: { not: BillStatus.REJECTED } },
          });
          if (existing) {
            throw ApiError.conflict("A bill has already been submitted for this schedule.");
          }
        } else {
          // Non-scheduled duplicate check. A REJECTED bill does not block a new
          // submission — admin rejection is the explicit exception path.
          const existing = await tx.bill.findFirst({
            where: {
              dealershipId: fields.dealershipId,
              categoryId: fields.categoryId,
              billingPeriod,
              status: { not: BillStatus.REJECTED },
            },
          });
          if (existing) {
            throw ApiError.conflict(
              `Bill ${existing.billReference} already exists for this dealership, category and billing period.`
            );
          }
        }

        // Consumer-identifier duplicate check — a second bill for the same
        // consumer in the same period is almost certainly a rescan/error.
        if (consumerNumber) {
          const dup = await tx.bill.findFirst({
            where: {
              dealershipId: fields.dealershipId,
              consumerNumber,
              billingPeriod,
              status: { not: BillStatus.REJECTED },
            },
            select: { billReference: true },
          });
          if (dup) {
            throw ApiError.conflict(
              `Bill ${dup.billReference} already exists for consumer ${consumerNumber} in this billing period.`
            );
          }
        }

        const [dealership, category] = await Promise.all([
          tx.dealership.findUnique({ where: { id: fields.dealershipId } }),
          tx.billCategory.findUnique({ where: { id: fields.categoryId } }),
        ]);
        if (!dealership || !dealership.isActive) {
          throw ApiError.unprocessable("Dealership does not exist or is inactive.");
        }
        if (!category) throw ApiError.unprocessable("Category does not exist.");

        // Previous-bill matching: same normalized consumer + dealership +
        // category, strictly earlier period, non-rejected. Never matched on
        // consumer name alone.
        const previous = await findPreviousBill(tx, {
          dealershipId: fields.dealershipId,
          categoryId: fields.categoryId,
          consumerNumber,
          billingPeriod,
        });

        // Budget comparison — recomputed authoritatively on the server using
        // currentPeriodAmount when supplied (business rule: prior arrears are
        // excluded from the budget figure).
        const comparison = await budgetComparisonService.compute(
          {
            dealershipId: fields.dealershipId,
            categoryId: fields.categoryId,
            billingPeriod,
            amount: fields.amount,
            currentPeriodAmount: fields.currentPeriodAmount ?? null,
          },
          tx
        );

        const billReference = await nextBillReference(tx);
        const created = await tx.bill.create({
          data: {
            id: billId,
            billReference,
            scheduleId: fields.scheduleId ?? null,
            dealershipId: fields.dealershipId,
            categoryId: fields.categoryId,
            billingPeriod,
            billingDate: fields.billingDate,
            amount: new Prisma.Decimal(fields.amount),
            referenceNumber: fields.referenceNumber ?? extracted?.billNumber ?? undefined,
            documentKey: key,
            originalDocumentName: docName,
            mimeType: docMime,
            fileSizeBytes: docSize,
            submittedById: user.id,
            status: BillStatus.SUBMITTED,
            accountantNotes: fields.accountantNotes,

            consumerNumber: consumerNumber ?? normalizeConsumer(extracted?.consumerNumber),
            meterNumber: fields.meterNumber ?? extracted?.meterNumber ?? null,
            unitsKwh:
              fields.unitsKwh !== undefined
                ? new Prisma.Decimal(fields.unitsKwh)
                : extracted?.unitsKwh != null
                  ? new Prisma.Decimal(extracted.unitsKwh)
                  : null,
            currentPeriodAmount:
              fields.currentPeriodAmount !== undefined
                ? new Prisma.Decimal(fields.currentPeriodAmount)
                : extracted?.currentAmount != null
                  ? new Prisma.Decimal(extracted.currentAmount)
                  : null,
            previousBillAmount:
              fields.previousBillAmount !== undefined
                ? new Prisma.Decimal(fields.previousBillAmount)
                : extracted?.previousBillAmount != null
                  ? new Prisma.Decimal(extracted.previousBillAmount)
                  : (previous?.amount ?? null),
            previousBillId: previous?.id ?? null,
            scanId: scan?.id ?? null,
            extractionWarnings:
              (scan?.warningsJson as string[] | null) ?? undefined,
            budgetStatus: comparison.status,
            budgetComparisonAmount: comparison.comparisonAmount,
            budgetAmount: comparison.budgetAmount,
            budgetRuleId: comparison.budgetRuleId,
          },
          include: {
            dealership: { select: { name: true, code: true } },
            category: { select: { name: true } },
            submittedBy: { select: { fullName: true } },
          },
        });

        await reviewHistoryModel.create(tx, {
          billId: created.id,
          reviewerId: user.id,
          previousStatus: null,
          newStatus: BillStatus.SUBMITTED,
          decision: ReviewDecision.SUBMITTED,
          notes: fields.accountantNotes,
        });

        if (fields.scheduleId) {
          await tx.billSchedule.update({
            where: { id: fields.scheduleId },
            data: { status: ScheduleStatus.SUBMITTED },
          });
        }

        await notificationService.notifyAdmins(
          [
            {
              type: "review_request",
              title: "Bill awaiting review",
              message:
                `${user.fullName} submitted bill ${created.billReference} for ${created.dealership.name} / ${created.category.name}.` +
                (comparison.status === "OVER_BUDGET" ? " ⚠ Over configured budget." : ""),
              relatedEntityType: "bill",
              relatedEntityId: created.id,
            },
          ],
          tx
        );
        return created;
      });
      return toBillRowDTO(bill);
    } catch (e) {
      // Compensate for the untransactionable object-storage write — but only
      // for files WE just uploaded; a consumed scan's object stays put.
      if (uploadedNewFile) await storage.delete(key).catch(() => undefined);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw ApiError.conflict("A bill already exists for this dealership, category and billing period.");
      }
      throw e;
    }
  },

  /**
   * Resubmit a REJECTED or CORRECTION_REQUESTED bill — audited as a new
   * history entry; the old document is replaced and removed from storage.
   */
  async resubmit(
    id: string,
    fields: BillFieldsInput,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    user: RequestUser
  ): Promise<BillRowDTO> {
    if (user.role !== "ACCOUNTANT") {
      throw ApiError.forbidden("Only accountants resubmit bills.");
    }
    const existing = await prisma.bill.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Bill not found.");
    assertDealershipAccess(user, existing.dealershipId);
    if (existing.submittedById !== user.id) {
      throw ApiError.forbidden("Only the original submitter may resubmit this bill.");
    }
    if (existing.status !== BillStatus.REJECTED && existing.status !== BillStatus.CORRECTION_REQUESTED) {
      throw ApiError.unprocessable("Only rejected or correction-requested bills can be resubmitted.");
    }
    if (fields.dealershipId !== existing.dealershipId || fields.categoryId !== existing.categoryId) {
      throw ApiError.unprocessable("Dealership and category cannot change on resubmission.");
    }
    assertFileSignature(file.buffer, file.mimetype);

    const newKey = billDocumentKey(existing.dealershipId, existing.id, MIME_EXT[file.mimetype]!);
    await storage.upload(newKey, file.buffer, file.mimetype);
    const oldKey = existing.documentKey;

    const newPeriod = firstOfMonth(fields.billingPeriod.year, fields.billingPeriod.month);
    const consumerNumber = normalizeConsumer(fields.consumerNumber) ?? existing.consumerNumber;
    const currentPeriodAmount =
      fields.currentPeriodAmount !== undefined
        ? new Prisma.Decimal(fields.currentPeriodAmount)
        : existing.currentPeriodAmount;

    try {
      const bill = await prisma.$transaction(async (tx) => {
        // Re-resolve predecessor + budget when identity fields change.
        const previous = await findPreviousBill(tx, {
          dealershipId: existing.dealershipId,
          categoryId: existing.categoryId,
          consumerNumber,
          billingPeriod: newPeriod,
          excludeId: existing.id,
        });
        const comparison = await budgetComparisonService.compute(
          {
            dealershipId: existing.dealershipId,
            categoryId: existing.categoryId,
            billingPeriod: newPeriod,
            amount: fields.amount,
            currentPeriodAmount,
          },
          tx
        );

        const updated = await tx.bill.update({
          where: { id: existing.id },
          data: {
            amount: new Prisma.Decimal(fields.amount),
            billingDate: fields.billingDate,
            billingPeriod: newPeriod,
            referenceNumber: fields.referenceNumber,
            accountantNotes: fields.accountantNotes,
            consumerNumber,
            meterNumber: fields.meterNumber ?? existing.meterNumber,
            unitsKwh:
              fields.unitsKwh !== undefined
                ? new Prisma.Decimal(fields.unitsKwh)
                : existing.unitsKwh,
            currentPeriodAmount,
            previousBillAmount:
              fields.previousBillAmount !== undefined
                ? new Prisma.Decimal(fields.previousBillAmount)
                : (previous?.amount ?? existing.previousBillAmount),
            previousBillId: previous?.id ?? existing.previousBillId,
            budgetStatus: comparison.status,
            budgetComparisonAmount: comparison.comparisonAmount,
            budgetAmount: comparison.budgetAmount,
            budgetRuleId: comparison.budgetRuleId,
            documentKey: newKey,
            originalDocumentName: file.originalname,
            mimeType: file.mimetype,
            fileSizeBytes: file.size,
            status: BillStatus.SUBMITTED,
            rejectionReason: null,
            resubmissionCount: { increment: 1 },
            submittedAt: new Date(),
          },
          include: {
            dealership: { select: { name: true, code: true } },
            category: { select: { name: true } },
            submittedBy: { select: { fullName: true } },
          },
        });
        await reviewHistoryModel.create(tx, {
          billId: existing.id,
          reviewerId: user.id,
          previousStatus: existing.status,
          newStatus: BillStatus.SUBMITTED,
          decision: ReviewDecision.RESUBMITTED,
          notes: fields.accountantNotes,
        });
        if (existing.scheduleId) {
          await tx.billSchedule.update({
            where: { id: existing.scheduleId },
            data: { status: ScheduleStatus.SUBMITTED },
          });
        }
        await notificationService.notifyAdmins(
          [
            {
              type: "resubmitted",
              title: "Bill resubmitted",
              message: `${user.fullName} resubmitted bill ${existing.billReference}.`,
              relatedEntityType: "bill",
              relatedEntityId: existing.id,
            },
          ],
          tx
        );
        return updated;
      });
      // Old object only removed after successful commit.
      if (oldKey !== newKey) await storage.delete(oldKey).catch(() => undefined);
      return toBillRowDTO(bill);
    } catch (e) {
      await storage.delete(newKey).catch(() => undefined);
      throw e;
    }
  },

  /**
   * Replace the document on an existing submission (e.g. a clearer scan).
   * Allowed while the bill is SUBMITTED/UNDER_REVIEW/CORRECTION_REQUESTED.
   */
  async replaceDocument(
    id: string,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    user: RequestUser
  ): Promise<BillRowDTO> {
    const bill = await prisma.bill.findUnique({ where: { id } });
    if (!bill) throw ApiError.notFound("Bill not found.");
    assertDealershipAccess(user, bill.dealershipId);
    const replaceableStatuses: BillStatus[] = [
      BillStatus.SUBMITTED,
      BillStatus.UNDER_REVIEW,
      BillStatus.CORRECTION_REQUESTED,
    ];
    if (user.role === "ACCOUNTANT" && !replaceableStatuses.includes(bill.status)) {
      throw ApiError.unprocessable("Document can only be replaced while the bill is in review.");
    }
    assertFileSignature(file.buffer, file.mimetype);

    const newKey = billDocumentKey(bill.dealershipId, bill.id, MIME_EXT[file.mimetype]!);
    await storage.upload(newKey, file.buffer, file.mimetype);
    try {
      const updated = await prisma.bill.update({
        where: { id: bill.id },
        data: {
          documentKey: newKey,
          originalDocumentName: file.originalname,
          mimeType: file.mimetype,
          fileSizeBytes: file.size,
        },
        include: {
          dealership: { select: { name: true, code: true } },
          category: { select: { name: true } },
          submittedBy: { select: { fullName: true } },
        },
      });
      if (bill.documentKey !== newKey) await storage.delete(bill.documentKey).catch(() => undefined);
      return toBillRowDTO(updated);
    } catch (e) {
      await storage.delete(newKey).catch(() => undefined);
      throw e;
    }
  },

  /** Short-lived authorized download URL for the private document. */
  async documentUrl(id: string, user: RequestUser): Promise<{ url: string; expiresInSeconds: number }> {
    const bill = await prisma.bill.findUnique({ where: { id } });
    if (!bill) throw ApiError.notFound("Bill not found.");
    assertDealershipAccess(user, bill.dealershipId);
    const ttl = 300;
    const url = await storage.getSignedUrl(bill.documentKey, ttl);
    return { url, expiresInSeconds: ttl };
  },

  /** Review history — admins see all; accountants scoped to their dealerships. */
  async history(id: string, user: RequestUser): Promise<ReviewEventDTO[]> {
    const bill = await prisma.bill.findUnique({ where: { id } });
    if (!bill) throw ApiError.notFound("Bill not found.");
    assertDealershipAccess(user, bill.dealershipId);
    const rows = await reviewHistoryModel.listForBill(id);
    return rows.map(toReviewEventDTO);
  },

  /** The matched previous-period bill (same consumer+dealership+category). */
  async previous(id: string, user: RequestUser): Promise<BillRowDTO | null> {
    const bill = await prisma.bill.findUnique({ where: { id } });
    if (!bill) throw ApiError.notFound("Bill not found.");
    assertDealershipAccess(user, bill.dealershipId);
    if (!bill.previousBillId) return null;
    const prev = await billModel.findById(bill.previousBillId);
    return prev ? toBillRowDTO(prev, { admin: user.role === "ADMIN" }) : null;
  },

  /**
   * Budget preview before submission. Accountants get ONLY the status;
   * admins additionally get the comparison figures.
   */
  async budgetPreview(
    fields: {
      dealershipId: string;
      categoryId: string;
      billingPeriod: { month: number; year: number };
      amount: number;
      currentPeriodAmount?: number;
    },
    user: RequestUser
  ) {
    assertDealershipAccess(user, fields.dealershipId);
    const detail = await budgetComparisonService.detail({
      dealershipId: fields.dealershipId,
      categoryId: fields.categoryId,
      billingPeriod: firstOfMonth(fields.billingPeriod.year, fields.billingPeriod.month),
      amount: fields.amount,
      currentPeriodAmount: fields.currentPeriodAmount ?? null,
    });
    if (user.role !== "ADMIN") {
      return { status: detail.status.toLowerCase() };
    }
    return {
      status: detail.status.toLowerCase(),
      comparisonAmount: detail.comparisonAmount,
      budgetAmount: detail.budgetAmount,
      varianceAmount: detail.varianceAmount,
      utilizationPercentage: detail.utilizationPercentage,
    };
  },

  /** ADMIN-only: the stored comparison snapshot for a submitted bill. */
  async budgetComparison(id: string, user: RequestUser) {
    if (user.role !== "ADMIN") throw ApiError.forbidden("Admin access required.");
    const bill = await prisma.bill.findUnique({ where: { id } });
    if (!bill) throw ApiError.notFound("Bill not found.");
    if (!bill.budgetStatus || bill.budgetComparisonAmount === null) {
      return { status: null, comparisonAmount: null, budgetAmount: null, varianceAmount: null, utilizationPercentage: null };
    }
    const comparison = new Prisma.Decimal(bill.budgetComparisonAmount);
    const budget = bill.budgetAmount === null ? null : new Prisma.Decimal(bill.budgetAmount);
    return {
      status: bill.budgetStatus.toLowerCase(),
      comparisonAmount: Number(comparison),
      budgetAmount: budget === null ? null : Number(budget),
      varianceAmount: budget === null ? null : Number(comparison.sub(budget)),
      utilizationPercentage:
        budget === null || budget.isZero()
          ? null
          : Number(comparison.div(budget).mul(100).toDecimalPlaces(1)),
    };
  },
};
