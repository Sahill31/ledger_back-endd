import { Router } from "express";
import { z } from "zod";
import { analyticsController } from "../controllers/analytics.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { validate } from "../middleware/validate";

const yearQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  dealershipId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
});

const monthYearQuery = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  dealershipId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
});

const completionQuery = z.object({
  months: z.coerce.number().int().min(1).max(24).optional(),
  dealershipId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
});

const reportQuery = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  dealershipId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  reviewStatus: z
    .enum(["SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "CORRECTION_REQUESTED"])
    .optional(),
  comparePrevious: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const exportQuery = z.object({
  type: z.enum(["bills", "budgets", "spending"]).default("bills"),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const analyticsRoutes = Router();

/**
 * Accountant dashboard — separate from admin analytics and restricted to
 * the ACCOUNTANT role; contains only the caller's own workflow metrics.
 */
analyticsRoutes.get(
  "/my-dashboard",
  authenticate,
  authorizeRole("ACCOUNTANT"),
  analyticsController.accountantDashboard
);

// Everything below is ADMIN-ONLY — budget-derived data included.
analyticsRoutes.use(authenticate, authorizeRole("ADMIN"));

analyticsRoutes.get("/overview", analyticsController.overview);
analyticsRoutes.get("/monthly-spending", validate({ query: yearQuery }), analyticsController.monthlySpending);
analyticsRoutes.get("/dealership-comparison", validate({ query: monthYearQuery }), analyticsController.dealershipComparison);
analyticsRoutes.get("/category-breakdown", validate({ query: monthYearQuery }), analyticsController.categoryBreakdown);
analyticsRoutes.get("/submission-completion", validate({ query: completionQuery }), analyticsController.submissionCompletion);
analyticsRoutes.get("/budget-vs-actual", validate({ query: monthYearQuery }), analyticsController.budgetVsActual);
analyticsRoutes.get("/expenditure-report", validate({ query: reportQuery }), analyticsController.expenditureReport);
analyticsRoutes.get("/export", validate({ query: exportQuery }), analyticsController.exportCsv);
