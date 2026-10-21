import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { categoryService } from "../services/category.service";

export const categoryController = {
  list: asyncHandler(async (_req: Request, res: Response) => {
    const data = await categoryService.list();
    res.json({ success: true, data });
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = await categoryService.create(req.body);
    res.status(201).json({ success: true, data, message: "Category created" });
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const data = await categoryService.update(req.params.id!, req.body);
    res.json({ success: true, data });
  }),

  setStatus: asyncHandler(async (req: Request, res: Response) => {
    const data = await categoryService.setStatus(req.params.id!, req.body.isActive);
    res.json({ success: true, data });
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await categoryService.remove(req.params.id!);
    res.json({ success: true, data: null, message: "Category deleted" });
  }),
};
