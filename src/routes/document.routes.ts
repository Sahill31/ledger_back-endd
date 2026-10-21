import { Router } from "express";
import multer from "multer";
import { env } from "../config/env";
import { documentController } from "../controllers/document.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { uploadLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024, files: 1 },
});

export const documentRoutes = Router();

documentRoutes.use(authenticate);

documentRoutes.post(
  "/scan",
  authorizeRole("ACCOUNTANT"),
  uploadLimiter,
  upload.single("document"),
  documentController.scan
);
documentRoutes.get(
  "/scans/:id",
  validate({ params: idParamSchema }),
  documentController.getScan
);
documentRoutes.get(
  "/scans/:id/document-url",
  validate({ params: idParamSchema }),
  documentController.scanDocumentUrl
);
