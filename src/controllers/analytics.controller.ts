import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { analyticsService } from "../services/analytics.service";

/**
 * Every handler except `accountantDashboard` is mounted behind
 * authorizeRole("ADMIN"). The accountant dashboard is mounted behind
 * authorizeRole("ACCOUNTANT") and returns only workflow metrics.
 */
export const analyticsController = {
  overview: asyncHandler(async (_req: Request, res: Response) => {
    const data = await analyticsService.overview();
    res.json({ success: true, data });
  }),

  monthlySpending: asyncHandler(async (req: Request, res: Response) => {
    const { year, dealershipId, categoryId } = req.query as never;
    const data = await analyticsService.monthlySpending(year ?? new Date().getUTCFullYear(), {
      dealershipId,
      categoryId,
    });
    res.json({ success: true, data });
  }),

  dealershipComparison: asyncHandler(async (req: Request, res: Response) => {
    const data = await analyticsService.dealershipComparison(req.query as never);
    res.json({ success: true, data });
  }),

  categoryBreakdown: asyncHandler(async (req: Request, res: Response) => {
    const data = await analyticsService.categoryBreakdown(req.query as never);
    res.json({ success: true, data });
  }),

  submissionCompletion: asyncHandler(async (req: Request, res: Response) => {
    const { months, dealershipId, categoryId } = req.query as {
      months?: number;
      dealershipId?: string;
      categoryId?: string;
    };
    const data = await analyticsService.submissionCompletion(months ?? 6, dealershipId, categoryId);
    res.json({ success: true, data });
  }),

  budgetVsActual: asyncHandler(async (req: Request, res: Response) => {
    const now = new Date();
    const { month = now.getUTCMonth() + 1, year = now.getUTCFullYear() } = req.query as never;
    const data = await analyticsService.budgetVsActual(month, year);
    res.json({ success: true, data });
  }),

  expenditureReport: asyncHandler(async (req: Request, res: Response) => {
    const data = await analyticsService.expenditureReport(req.query as never);
    res.json({ success: true, data });
  }),

  exportCsv: asyncHandler(async (req: Request, res: Response) => {
    const { type = "bills", month, year } = req.query as never;
    const csv = await analyticsService.exportCsv(type, { month, year });
    res
      .status(200)
      .setHeader("Content-Type", "text/csv; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="autoledger-${type}.csv"`)
      .send(csv);
  }),

  accountantDashboard: asyncHandler(async (req: Request, res: Response) => {
    const data = await analyticsService.accountantDashboard(req.user!);
    res.json({ success: true, data });
  }),
};
