import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { userService } from "../services/user.service";

export const userController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.list(req.query as never);
    res.json({ success: true, data });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.getById(req.params.id!);
    res.json({ success: true, data });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.create(req.body, req.user!);
    res.status(201).json({ success: true, data, message: "Account created" });
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.update(req.params.id!, req.body);
    res.json({ success: true, data });
  }),

  setStatus: asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.setStatus(req.params.id!, req.body.isActive, req.user!);
    res.json({ success: true, data });
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await userService.remove(req.params.id!, req.user!);
    res.json({ success: true, data: null, message: "Account deleted" });
  }),

  getAssignments: asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.getAssignments(req.params.id!);
    res.json({ success: true, data: { dealershipIds: data } });
  }),

  setAssignments: asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.setAssignments(req.params.id!, req.body.dealershipIds);
    res.json({ success: true, data, message: "Assignments updated" });
  }),

  updateProfile: asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.update(req.user!.id, req.body);
    res.json({ success: true, data });
  }),
};
