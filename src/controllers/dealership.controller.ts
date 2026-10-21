import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { dealershipService } from "../services/dealership.service";

export const dealershipController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const data = await dealershipService.list(req.query as never, req.user!);
    res.json({ success: true, data });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await dealershipService.getById(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await dealershipService.create(req.body);
    res.status(201).json({ success: true, data, message: "Dealership created" });
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await dealershipService.update(req.params.id!, req.body);
    res.json({ success: true, data });
  }),

  setStatus: asyncHandler(async (req: Request, res: Response) => {
    const data = await dealershipService.setStatus(req.params.id!, req.body.isActive);
    res.json({ success: true, data });
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await dealershipService.remove(req.params.id!);
    res.json({ success: true, data: null, message: "Dealership deleted" });
  }),

  accountants: asyncHandler(async (req: Request, res: Response) => {
    const data = await dealershipService.accountantsFor(req.params.id!);
    res.json({ success: true, data });
  }),
};
