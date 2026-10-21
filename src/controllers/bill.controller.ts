import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { billFieldsSchema, budgetPreviewSchema } from "../schemas/bill.schema";
import { billService } from "../services/bill.service";

/**
 * Multipart contract: field `document` = the file; field `data` = JSON string
 * matching billFieldsSchema. (Multer has already run before validation.)
 */
function parseFields(req: Request) {
  const raw = typeof req.body?.data === "string" ? req.body.data : req.body;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw ApiError.badRequest("`data` must be a JSON string.");
    }
  }
  const r = billFieldsSchema.safeParse(parsed);
  if (!r.success) {
    throw ApiError.validation(
      "Request validation failed",
      r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }
  return r.data;
}

/** Document optional when the request consumes an existing scan. */
function fileOrScan(req: Request, hasScan: boolean) {
  if (req.file) return req.file;
  if (hasScan) return null;
  throw ApiError.badRequest("A bill document file is required (or pass scanId).");
}

function requireFile(req: Request) {
  if (!req.file) throw ApiError.badRequest("A bill document file is required.");
  return req.file;
}

export const billController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const data = await billService.list(req.query as never, req.user!);
    res.json({ success: true, data });
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const data = await billService.getById(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),

  submit: asyncHandler(async (req: Request, res: Response) => {
    const fields = parseFields(req);
    const file = fileOrScan(req, !!fields.scanId);
    const data = await billService.submit(fields, file, req.user!);
    res.status(201).json({ success: true, data, message: "Bill submitted" });
  }),

  previous: asyncHandler(async (req: Request, res: Response) => {
    const data = await billService.previous(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),

  budgetComparison: asyncHandler(async (req: Request, res: Response) => {
    const data = await billService.budgetComparison(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),

  budgetPreview: asyncHandler(async (req: Request, res: Response) => {
    const r = budgetPreviewSchema.safeParse(req.body);
    if (!r.success) {
      throw ApiError.validation(
        "Request validation failed",
        r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
      );
    }
    const data = await billService.budgetPreview(r.data, req.user!);
    res.json({ success: true, data });
  }),

  resubmit: asyncHandler(async (req: Request, res: Response) => {
    const fields = parseFields(req);
    const file = requireFile(req);
    const data = await billService.resubmit(req.params.id!, fields, file, req.user!);
    res.json({ success: true, data, message: "Bill resubmitted" });
  }),

  replaceDocument: asyncHandler(async (req: Request, res: Response) => {
    const file = requireFile(req);
    const data = await billService.replaceDocument(req.params.id!, file, req.user!);
    res.json({ success: true, data, message: "Document replaced" });
  }),

  documentUrl: asyncHandler(async (req: Request, res: Response) => {
    const data = await billService.documentUrl(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),

  history: asyncHandler(async (req: Request, res: Response) => {
    const data = await billService.history(req.params.id!, req.user!);
    res.json({ success: true, data });
  }),
};

