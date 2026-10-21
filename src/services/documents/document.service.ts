import { randomUUID } from "node:crypto";
import { DocumentScanStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import { env } from "../../config/env";
import { storage } from "../../config/storage";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/ApiError";
import { assertDealershipAccess } from "../../middleware/authorizeRole";
import type { RequestUser } from "../../middleware/authenticate";
import {
  assertScanFile,
  extensionFor,
  scanDocumentKey,
} from "./documentValidation.service";
import { pdfTextExtractor } from "./pdfTextExtractor.service";
import { getOcrProvider } from "./ocrProvider.service";
import { jvvnlBillExtractor, type ExtractionResult } from "./jvvnlBillExtractor.service";

/**
 * Document scan orchestration.
 *
 * Flow: validate signature → store the file privately → extract text
 * (PDF text layer first, OCR for image uploads) → run the JVVNL field
 * extractor → persist the structured result. Scans belong to the uploading
 * accountant, expire after SCAN_RETENTION_HOURS, and may be consumed by at
 * most one bill submission.
 */

export interface ScanDTO {
  id: string;
  status: "processing" | "extracted" | "partial" | "failed";
  fileName: string;
  fileType: "pdf" | "jpg" | "png";
  fileSizeKb: number;
  extractionMethod: string | null;
  pageCount: number | null;
  dealershipId: string | null;
  categoryId: string | null;
  scheduleId: string | null;
  fields: ExtractionResult["fields"] | null;
  confidence: ExtractionResult["confidence"] | null;
  warnings: string[];
  expiresAt: string;
  createdAt: string;
}

export function toScanDTO(s: {
  id: string;
  status: DocumentScanStatus;
  originalFileName: string;
  mimeType: string;
  fileSizeBytes: number;
  extractionMethod: string | null;
  pageCount: number | null;
  dealershipId: string | null;
  categoryId: string | null;
  scheduleId: string | null;
  extractedJson: Prisma.JsonValue | null;
  confidenceJson: Prisma.JsonValue | null;
  warningsJson: Prisma.JsonValue | null;
  expiresAt: Date;
  createdAt: Date;
}): ScanDTO {
  return {
    id: s.id,
    status: s.status.toLowerCase() as ScanDTO["status"],
    fileName: s.originalFileName,
    fileType:
      s.mimeType === "application/pdf" ? "pdf" : s.mimeType === "image/png" ? "png" : "jpg",
    fileSizeKb: Math.round(s.fileSizeBytes / 1024),
    extractionMethod: s.extractionMethod,
    pageCount: s.pageCount,
    dealershipId: s.dealershipId,
    categoryId: s.categoryId,
    scheduleId: s.scheduleId,
    fields: (s.extractedJson as ExtractionResult["fields"] | null) ?? null,
    confidence: (s.confidenceJson as ExtractionResult["confidence"] | null) ?? null,
    warnings: (s.warningsJson as string[] | null) ?? [],
    expiresAt: s.expiresAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
  };
}

/** Text short enough to mean "image-only PDF" or "OCR produced nothing". */
function unusable(text: string): boolean {
  return text.trim().length < env.PDF_MIN_TEXT_CHARS;
}

export const documentService = {
  /**
   * Upload + scan a bill document. Processing is synchronous — a digital PDF
   * extracts in ms; image OCR typically takes a few seconds (bounded by
   * OCR_TIMEOUT_MS). The scan row is persisted either way so the client can
   * poll/inspect failures without re-uploading blindly.
   */
  async scan(
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    hints: { dealershipId?: string; categoryId?: string; scheduleId?: string },
    user: RequestUser
  ): Promise<ScanDTO> {
    if (user.role !== "ACCOUNTANT") {
      throw ApiError.forbidden("Only accountants may scan bill documents.");
    }
    assertScanFile(file.buffer, file.mimetype);
    if (hints.dealershipId) assertDealershipAccess(user, hints.dealershipId);

    const scanId = randomUUID();
    const key = scanDocumentKey(user.id, scanId, extensionFor(file.mimetype));
    const expiresAt = new Date(Date.now() + env.SCAN_RETENTION_HOURS * 3_600_000);

    const scan = await prisma.documentScan.create({
      data: {
        id: scanId,
        uploadedById: user.id,
        dealershipId: hints.dealershipId ?? null,
        categoryId: hints.categoryId ?? null,
        scheduleId: hints.scheduleId ?? null,
        documentKey: key,
        originalFileName: file.originalname,
        mimeType: file.mimetype,
        fileSizeBytes: file.size,
        status: DocumentScanStatus.PROCESSING,
        expiresAt,
      },
    });
    await storage.upload(key, file.buffer, file.mimetype);

    try {
      return await this.processScan(scan.id, file.buffer, file.mimetype);
    } catch (e) {
      logger.error({ err: e, scanId }, "scan processing crashed");
      const failed = await prisma.documentScan.update({
        where: { id: scanId },
        data: {
          status: DocumentScanStatus.FAILED,
          warningsJson: ["The document could not be processed. Try again or enter the bill manually."],
        },
      });
      return toScanDTO(failed);
    }
  },

  /** Runs the extraction pipeline and persists the result. */
  async processScan(scanId: string, buffer: Buffer, mime: string): Promise<ScanDTO> {
    const warnings: string[] = [];
    let text = "";
    let pageCount: number | null = null;
    let method: string | null = null;

    if (mime === "application/pdf") {
      const pdf = await pdfTextExtractor.extract(buffer);
      pageCount = pdf.pageCount;
      text = pdf.text;
      method = "pdf_text";
      if (unusable(text)) {
        warnings.push(
          "This PDF has no readable text layer (it appears to be a scanned image). " +
            (env.OCR_PROVIDER === "none"
              ? "OCR is disabled on this server — upload a JPG/PNG of the bill is not supported either; enter the bill manually."
              : "Scanned-PDF rasterization is not supported on this server — upload a photo or scanned image (JPG/PNG) of the bill instead.")
        );
        method = "none";
      }
    } else {
      // Image upload → OCR provider.
      const provider = getOcrProvider();
      if (!provider) {
        warnings.push("OCR is disabled on this server — enter the bill manually.");
        method = "none";
      } else {
        try {
          const ocr = await provider.extractText(buffer);
          text = ocr.text;
          method = `${provider.name}_ocr`;
          if (unusable(text)) {
            warnings.push("OCR could not read enough text from this image — try a sharper photo or enter manually.");
          }
          if (ocr.confidence !== undefined && ocr.confidence < 0.5) {
            warnings.push("OCR confidence is low — double-check every extracted value.");
          }
        } catch (e) {
          warnings.push(
            `OCR failed (${e instanceof Error ? e.message : "unknown error"}). Try again or enter the bill manually.`
          );
          method = "none";
        }
      }
    }

    let result: ExtractionResult | null = null;
    if (!unusable(text)) {
      result = jvvnlBillExtractor.extract(text);
      warnings.push(...result.warnings);
    }

    const hasCritical = result
      ? result.fields.totalAmountPayable !== null && result.fields.consumerNumber !== null
      : false;
    const hasAny = result
      ? Object.values(result.fields).some((v) => v !== null)
      : false;
    const status =
      result === null
        ? DocumentScanStatus.FAILED
        : hasCritical
          ? DocumentScanStatus.EXTRACTED
          : hasAny
            ? DocumentScanStatus.PARTIAL
            : DocumentScanStatus.FAILED;

    const scan = await prisma.documentScan.update({
      where: { id: scanId },
      data: {
        status,
        extractionMethod: method,
        extractedJson: result ? (result.fields as unknown as Prisma.JsonObject) : Prisma.JsonNull,
        confidenceJson: result ? (result.confidence as unknown as Prisma.JsonObject) : Prisma.JsonNull,
        warningsJson: warnings,
        pageCount,
        textLength: text.trim().length,
      },
    });
    return toScanDTO(scan);
  },

  /** Owner-only (or admin) access — scans are tied to the uploader. */
  async getScan(id: string, user: RequestUser): Promise<ScanDTO> {
    const scan = await prisma.documentScan.findUnique({ where: { id } });
    if (!scan) throw ApiError.notFound("Scan not found.");
    if (user.role === "ACCOUNTANT" && scan.uploadedById !== user.id) {
      throw ApiError.forbidden("This scan belongs to a different accountant.");
    }
    return toScanDTO(scan);
  },

  async scanDocumentUrl(
    id: string,
    user: RequestUser
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const scan = await prisma.documentScan.findUnique({ where: { id } });
    if (!scan) throw ApiError.notFound("Scan not found.");
    if (user.role === "ACCOUNTANT" && scan.uploadedById !== user.id) {
      throw ApiError.forbidden("This scan belongs to a different accountant.");
    }
    const ttl = 300;
    return { url: await storage.getSignedUrl(scan.documentKey, ttl), expiresInSeconds: ttl };
  },
};
