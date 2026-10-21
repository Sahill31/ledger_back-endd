import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { budgetService } from "../services/budget.service";

/** All handlers here are mounted behind authorizeRole("ADMIN"). */
export const budgetController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const data = await budgetService.list(req.query as never, req.user!);
    res.json({ success: true, data });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await budgetService.getById(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await budgetService.create(req.body, req.user!);
    res.status(201).json({ success: true, data, message: "Budget rule created" });
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await budgetService.update(req.params.id!, req.body, req.user!);
    res.json({ success: true, data });
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await budgetService.remove(req.params.id!, req.user!);
    res.json({ success: true, data: null, message: "Budget rule deleted" });
  }),

  summary: asyncHandler(async (req: Request, res: Response) => {
    const data = await budgetService.summary(req.query as never, req.user!);
    res.json({ success: true, data });
  }),
};
