import { z } from "zod";
import { monthYear, paginationQuery } from "./common.schema";

const nonNegativeMoney = z.coerce
  .number()
  .min(0, "Monthly amount must be non-negative")
  .max(999_999_999_999.99)
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(String(v)), "Amount may have at most 2 decimal places");

export const createBudgetSchema = monthYear.extend({
  dealershipId: z.string().uuid(),
  categoryId: z.string().uuid(),
  monthlyAmount: nonNegativeMoney,
  increaseThresholdPercent: z.coerce.number().min(0).max(10000).optional(),
});

export const updateBudgetSchema = z
  .object({
    monthlyAmount: nonNegativeMoney.optional(),
    increaseThresholdPercent: z.coerce.number().min(0).max(10000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const listBudgetsQuery = paginationQuery.extend({
  dealershipId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const budgetSummaryQuery = monthYear.partial();
