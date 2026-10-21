import { z } from "zod";

export const createCategorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).optional(),
  icon: z.string().trim().max(60).optional(),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(400).nullable().optional(),
    icon: z.string().trim().max(60).optional(),
  })
  .strict();

export const setCategoryStatusSchema = z.object({
  isActive: z.boolean(),
});
