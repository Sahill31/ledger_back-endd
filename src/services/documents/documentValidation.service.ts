import { ApiError } from "../../utils/ApiError";

/**
 * Scan-upload validation — the filename and declared MIME are never trusted:
 * the file signature (magic bytes) must match before the buffer is stored or
 * processed.
 */
export const SCAN_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

export function scanDocumentKey(userId: string, scanId: string, extension: string): string {
  return `scans/${userId}/${scanId}.${extension}`;
}

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function extensionFor(mime: string): string {
  const ext = MIME_EXT[mime];
  if (!ext) throw ApiError.badRequest("Unsupported file type. Accepted: PDF, JPG, PNG.");
  return ext;
}

export function assertScanFile(buf: Buffer, mime: string): void {
  if (!SCAN_ALLOWED_MIME.has(mime)) {
    throw ApiError.badRequest("Unsupported file type. Accepted: PDF, JPG, PNG.");
  }
  if (buf.length === 0) throw ApiError.badRequest("The uploaded file is empty.");
  const head = buf.subarray(0, 8);
  const ok =
    (mime === "application/pdf" && head.subarray(0, 4).toString("latin1") === "%PDF") ||
    (mime === "image/jpeg" && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    (mime === "image/png" &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47);
  if (!ok) throw ApiError.badRequest("File contents do not match the declared type.");
}
