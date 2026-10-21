import { Router } from "express";
import { env } from "../config/env";
import { storage, verifyLocalFileSignature } from "../config/storage";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";

/**
 * LOCAL-PROVIDER ONLY: serves files behind short-lived HMAC-signed URLs
 * produced by GET /bills/:id/document-url. When STORAGE_PROVIDER=supabase
 * this router is dead code (supabase signed URLs point at Supabase).
 *
 * No Bearer auth here — the HMAC signature IS the authorization, letting the
 * browser open the URL directly. Signatures expire after ~5 minutes.
 */
export const filesRoutes = Router();

filesRoutes.get(
  "/:key",
  asyncHandler(async (req, res) => {
    if (env.STORAGE_PROVIDER !== "local") throw ApiError.notFound();
    // Express already URL-decodes params — the encoded %2F becomes '/'.
    const key = req.params.key!;
    const e = Number(req.query.e);
    const s = String(req.query.s ?? "");
    if (!e || !s || !verifyLocalFileSignature(key, e, s)) {
      throw ApiError.forbidden("Invalid or expired file link");
    }
    if (!storage.readLocal) throw ApiError.notFound();
    const buf = await storage.readLocal(key);
    const mime = key.endsWith(".pdf")
      ? "application/pdf"
      : key.endsWith(".png")
        ? "image/png"
        : "image/jpeg";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buf);
  })
);
