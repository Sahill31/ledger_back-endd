import { Router } from "express";
import { billController } from "../controllers/bill.controller";
import { reviewController } from "../controllers/review.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";
import { reviewDecisionSchema } from "../schemas/bill.schema";

/**
 * Review endpoints are also reachable under /bills/:id/review +
 * /bills/:id/history (see bill.routes). This router exposes the same
 * handlers under /review for API completeness.
 */
export const reviewRoutes = Router();

reviewRoutes.use(authenticate);

reviewRoutes.post(
  "/bills/:id/decision",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema, body: reviewDecisionSchema }),
  reviewController.decide
);
reviewRoutes.get("/bills/:id/history", validate({ params: idParamSchema }), billController.history);
