import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { notificationService } from "../services/notification.service";

export const notificationController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const data = await notificationService.list(req.user!.id, req.query as never);
    res.json({ success: true, data });
  }),

  unreadCount: asyncHandler(async (req: Request, res: Response) => {
    const count = await notificationService.unreadCount(req.user!.id);
    res.json({ success: true, data: { count } });
  }),

  markRead: asyncHandler(async (req: Request, res: Response) => {
    await notificationService.markRead(req.params.id!, req.user!.id);
    res.json({ success: true, data: null });
  }),

  markAllRead: asyncHandler(async (req: Request, res: Response) => {
    await notificationService.markAllRead(req.user!.id);
    res.json({ success: true, data: null });
  }),
};
