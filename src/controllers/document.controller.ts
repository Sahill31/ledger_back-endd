import type { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { documentService } from "../services/documents/document.service";
import { uuid } from "../schemas/common.schema";

const scanHintsSchema = z
  .object({
    dealershipId: uuid.optional(),
    categoryId: uuid.optional(),
    scheduleId: uuid.optional(),
  })
  .strict();

function parseScanHints(req: Request) {
  // Hints arrive as normal multipart fields.
  const r = scanHintsSchema.safeParse(req.body ?? {});
  if (!r.success) {
    throw ApiError.validation(
      "Request validation failed",
      r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }
  return r.data;
}

export const documentController = {
  /**
   * POST /documents/scan — multipart `document` field; optional hint fields.
   * Processes synchronously and returns the structured extraction.
   */
  scan: asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest("A bill document file is required (field `document`).");
    const hints = parseScanHints(req);
    const data = await documentService.scan(req.file, hints, req.user!);
    res.status(201).json({ success: true, data });
  }),

  getScan: asyncHandler(async (req: Request, res: Response) => {
    const data = await documentService.getScan(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),

  scanDocumentUrl: asyncHandler(async (req: Request, res: Response) => {
    const data = await documentService.scanDocumentUrl(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),
};
