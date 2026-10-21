import { logger } from "../../config/logger";

export interface PdfTextResult {
  text: string;
  pageCount: number;
}

/**
 * Extracts the embedded text layer from a PDF using pdf-parse.
 *
 * Lazily imported so tests and non-PDF paths never load the dependency.
 * Scanned (image-only) PDFs yield little or no text — the caller decides
 * whether to escalate to OCR based on env.PDF_MIN_TEXT_CHARS.
 */
export const pdfTextExtractor = {
  async extract(buf: Buffer): Promise<PdfTextResult> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse") as (b: Buffer) => Promise<{
        text: string;
        numpages: number;
      }>;
      const out = await pdfParse(buf);
      return { text: out.text ?? "", pageCount: out.numpages ?? 0 };
    } catch (e) {
      logger.warn({ err: e }, "pdf text extraction failed");
      return { text: "", pageCount: 0 };
    }
  },
};
