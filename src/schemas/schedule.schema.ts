import { z } from "zod";
import { dateString, paginationQuery, uuid } from "./common.schema";

export const createScheduleSchema = z
  .object({
    dealershipId: uuid,
    categoryId: uuid,
    assignedAccountantId: uuid.optional(),
    billingPeriod: z.object({
      month: z.number().int().min(1).max(12),
      year: z.number().int().min(2000).max(2100),
    }),
    dueDate: dateString,
    submissionDeadline: dateString,
    recurring: z.boolean().default(false),
    instructions: z.string().trim().max(2000).optional(),
  })
  .strict();

export const updateScheduleSchema = z
  .object({
    assignedAccountantId: uuid.nullable().optional(),
    dueDate: dateString.optional(),
    submissionDeadline: dateString.optional(),
    recurring: z.boolean().optional(),
    instructions: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const cancelScheduleSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const listSchedulesQuery = paginationQuery.extend({
  dealershipId: uuid.optional(),
  categoryId: uuid.optional(),
  status: z
    .enum([
      "scheduled",
      "due_soon",
      "due_today",
      "overdue",
      "missing",
      "submitted",
      "completed",
      "cancelled",
    ])
    .optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  search: z.string().trim().max(160).optional(),
  dueWithinDays: z.coerce.number().int().min(0).max(365).optional(),
});
