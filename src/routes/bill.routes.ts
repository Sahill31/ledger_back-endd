import { Router } from "express";
import multer from "multer";
import { env } from "../config/env";
import { billController } from "../controllers/bill.controller";
import { reviewController } from "../controllers/review.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { uploadLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";
import { listBillsQuery, reviewDecisionSchema } from "../schemas/bill.schema";

/** In-memory multipart handling — buffers are validated then streamed to storage. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024, files: 1 },
});

export const billRoutes = Router();

billRoutes.use(authenticate);

billRoutes.get("/", validate({ query: listBillsQuery }), billController.list);

// Pre-submission budget check — status only for accountants (figures admin-only).
billRoutes.post("/budget-preview", billController.budgetPreview);

billRoutes.get("/:id", validate({ params: idParamSchema }), billController.getById);
billRoutes.get("/:id/history", validate({ params: idParamSchema }), billController.history);
billRoutes.get("/:id/previous", validate({ params: idParamSchema }), billController.previous);
billRoutes.get(
  "/:id/budget-comparison",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema }),
  billController.budgetComparison
);
billRoutes.get("/:id/document-url", validate({ params: idParamSchema }), billController.documentUrl);

// Submission — accountants only (enforced again in the service).
billRoutes.post(
  "/",
  authorizeRole("ACCOUNTANT"),
  uploadLimiter,
  upload.single("document"),
  billController.submit
);
billRoutes.post(
  "/:id/resubmit",
  authorizeRole("ACCOUNTANT"),
  uploadLimiter,
  upload.single("document"),
  validate({ params: idParamSchema }),
  billController.resubmit
);
billRoutes.post(
  "/:id/document",
  uploadLimiter,
  upload.single("document"),
  validate({ params: idParamSchema }),
  billController.replaceDocument
);

// Review decisions — admin-only.
billRoutes.post(
  "/:id/review",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema, body: reviewDecisionSchema }),
  reviewController.decide
);
