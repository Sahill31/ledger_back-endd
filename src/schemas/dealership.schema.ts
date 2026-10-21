import { z } from "zod";
import { paginationQuery } from "./common.schema";

export const createDealershipSchema = z.object({
  name: z.string().trim().min(2).max(160),
  code: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(/^[A-Za-z0-9-]+$/, "Code may contain letters, digits and hyphens")
    .transform((v) => v.toUpperCase()),
  address: z.string().trim().min(3).max(300),
  city: z.string().trim().min(2).max(120),
  state: z.string().trim().max(120).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(32).optional(),
  contactEmail: z.string().email().max(255).optional(),
});

export const updateDealershipSchema = createDealershipSchema.partial();

export const setDealershipStatusSchema = z.object({
  isActive: z.boolean(),
});

export const listDealershipsQuery = paginationQuery.extend({
  status: z.enum(["active", "inactive"]).optional(),
  search: z.string().trim().max(120).optional(),
});
