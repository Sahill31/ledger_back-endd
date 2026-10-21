import { z } from "zod";
import { paginationSchema } from "../utils/pagination";

export const idParamSchema = z.object({
  id: z.string().uuid("Invalid id"),
});

export const uuid = z.string().uuid();

export const paginationQuery = paginationSchema;

/** "YYYY-MM-DD" or ISO datetime → Date (UTC-normalized by the DB as DATE). */
export const dateString = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
  .transform((v) => new Date(v));

export const monthYear = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});

/** INR money input — positive, max 2 decimal places, fits NUMERIC(14,2). */
export const moneyAmount = z.coerce
  .number()
  .positive("Amount must be greater than zero")
  .max(999_999_999_999.99)
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(String(v)), "Amount may have at most 2 decimal places");
