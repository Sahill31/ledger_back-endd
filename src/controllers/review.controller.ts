import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { reviewService } from "../services/review.service";

/** Mounted behind authorizeRole("ADMIN") on the decision endpoint. */
export const reviewController = {
  decide: asyncHandler(async (req: Request, res: Response) => {
    const data = await reviewService.decide(req.params.id!, req.body, req.user!);
    res.json({ success: true, data, message: `Bill ${req.body.decision.toLowerCase().replace(/_/g, " ")}` });
  }),
};
