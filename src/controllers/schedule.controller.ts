import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { scheduleService } from "../services/schedule.service";

export const scheduleController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const data = await scheduleService.list(req.query as never, req.user!);
    res.json({ success: true, data });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await scheduleService.getById(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await scheduleService.create(req.body, req.user!);
    res.status(201).json({ success: true, data, message: "Schedule created" });
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await scheduleService.update(req.params.id!, req.body, req.user!);
    res.json({ success: true, data });
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const data = await scheduleService.cancel(req.params.id!, req.body.reason, req.user!);
    res.json({ success: true, data, message: "Schedule cancelled" });
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await scheduleService.remove(req.params.id!, req.user!);
    res.json({ success: true, data: null, message: "Schedule deleted" });
  }),
};
