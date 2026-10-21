import { z } from "zod";
import { dateString, moneyAmount, paginationQuery, uuid } from "./common.schema";

export const billStatusEnum = z.enum([
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "CORRECTION_REQUESTED",
]);

/**
 * Bill field values — the multipart form carries these alongside the file,
 * or they are sent as JSON for metadata-only submissions.
 */
export const billFieldsSchema = z
  .object({
    scheduleId: uuid.optional(),
    dealershipId: uuid,
    categoryId: uuid,
    billingPeriod: z.object({
      month: z.coerce.number().int().min(1).max(12),
      year: z.coerce.number().int().min(2000).max(2100),
    }),
    billingDate: dateString,
    amount: moneyAmount,
    referenceNumber: z.string().trim().max(120).optional(),
    accountantNotes: z.string().trim().max(2000).optional(),
    // --- Scan-workflow fields (accountant-confirmed after autofill) ---
    /// Consumes a prior POST /documents/scan result; its stored file becomes
    /// the bill's document (no separate upload needed).
    scanId: uuid.optional(),
    /// JVVNL K-number / consumer account — normalized server-side.
    consumerNumber: z.string().trim().min(3).max(40).optional(),
    meterNumber: z.string().trim().max(40).optional(),
    unitsKwh: z.coerce.number().positive().max(100_000_000).optional(),
    /// Current-period charges excluding prior arrears (budget comparison base).
    currentPeriodAmount: moneyAmount.optional(),
    /// Previous bill's payable amount as printed on the document.
    previousBillAmount: moneyAmount.optional(),
  })
  .strict();

/** Budget preview — returns a status only for accountants, figures for admin. */
export const budgetPreviewSchema = z
  .object({
    dealershipId: uuid,
    categoryId: uuid,
    billingPeriod: z.object({
      month: z.coerce.number().int().min(1).max(12),
      year: z.coerce.number().int().min(2000).max(2100),
    }),
    amount: moneyAmount,
    currentPeriodAmount: moneyAmount.optional(),
  })
  .strict();

export const listBillsQuery = paginationQuery.extend({
  dealershipId: uuid.optional(),
  categoryId: uuid.optional(),
  // Accepts both API enum ("APPROVED") and frontend-style ("approved") values.
  status: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toUpperCase() : v),
      billStatusEnum
    )
    .optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  search: z.string().trim().max(160).optional(),
  submittedFrom: dateString.optional(),
  submittedTo: dateString.optional(),
});

export const reviewDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("UNDER_REVIEW"),
    notes: z.string().trim().max(2000).optional(),
  }),
  z.object({
    decision: z.literal("APPROVED"),
    notes: z.string().trim().max(2000).optional(),
  }),
  z.object({
    decision: z.literal("REJECTED"),
    reason: z.string().trim().min(5, "A rejection reason is required").max(1000),
    notes: z.string().trim().max(2000).optional(),
  }),
  z.object({
    decision: z.literal("CORRECTION_REQUESTED"),
    reason: z
      .string()
      .trim()
      .min(5, "Correction instructions are required")
      .max(1000),
    notes: z.string().trim().max(2000).optional(),
  }),
]);
