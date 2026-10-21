import { z } from "zod";
import { paginationQuery } from "./common.schema";

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a digit");

/**
 * Role is accepted ONLY on the admin-provision endpoint. Public registration
 * does not exist — there is no path for a client to self-assign a role.
 */
export const createUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().email().max(255),
  password,
  role: z.enum(["ADMIN", "ACCOUNTANT"]),
  title: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(32).optional(),
  dealershipIds: z.array(z.string().uuid()).max(200).default([]),
});

export const updateUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    email: z.string().email().max(255).optional(),
    title: z.string().trim().max(120).nullable().optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    password: password.optional(),
  })
  // Deliberately NO role/isActive here — privilege and status changes go
  // through dedicated guarded endpoints.
  .strict();

export const setUserStatusSchema = z.object({
  isActive: z.boolean(),
});

export const setAssignmentsSchema = z.object({
  dealershipIds: z.array(z.string().uuid()).max(200),
});

export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    title: z.string().trim().max(120).nullable().optional(),
    phone: z.string().trim().max(32).nullable().optional(),
  })
  .strict();

export const listUsersQuery = paginationQuery.extend({
  role: z.enum(["ADMIN", "ACCOUNTANT"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  search: z.string().trim().max(120).optional(),
});
