import { env } from "../../config/env";
import { logger } from "../../config/logger";

/**
 * OCR provider interface — swap implementations (Tesseract locally today,
 * a cloud vision/document-AI provider later) without touching the scan
 * workflow. Credentials for cloud providers would be configured through
 * environment variables only; no keys ever reach the client.
 */
export interface OcrResult {
  text: string;
  /** Mean word confidence 0..1 when the provider reports it. */
  confidence?: number;
}

export interface OcrProvider {
  readonly name: string;
  extractText(image: Buffer): Promise<OcrResult>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_r, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    ),
  ]);
}

/** Local OCR via tesseract.js — no external credentials required. */
class TesseractOcrProvider implements OcrProvider {
  readonly name = "tesseract";

  async extractText(image: Buffer): Promise<OcrResult> {
    // Lazy import: keeps the worker/wasm out of unit tests and non-OCR paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createWorker } = require("tesseract.js") as typeof import("tesseract.js");
    const worker = await withTimeout(
      createWorker(env.OCR_LANG),
      env.OCR_TIMEOUT_MS,
      "OCR engine startup"
    );
    try {
      const out = await withTimeout(
        worker.recognize(image),
        env.OCR_TIMEOUT_MS,
        "OCR recognition"
      );
      return {
        text: out.data.text ?? "",
        confidence:
          typeof out.data.confidence === "number"
            ? Math.max(0, Math.min(1, out.data.confidence / 100))
            : undefined,
      };
    } finally {
      await worker.terminate().catch(() => undefined);
    }
  }
}

let cached: OcrProvider | null | undefined;

/**
 * Returns the configured OCR provider, or null when OCR is disabled
 * (OCR_PROVIDER=none). Scanned PDFs cannot be rasterized locally — callers
 * surface that as a warning so the accountant can upload a JPG/PNG instead.
 */
export function getOcrProvider(): OcrProvider | null {
  if (cached === undefined) {
    cached = env.OCR_PROVIDER === "tesseract" ? new TesseractOcrProvider() : null;
    if (!cached) logger.info("OCR disabled (OCR_PROVIDER=none)");
  }
  return cached;
}

/** Test hook. */
export function resetOcrProviderCache(): void {
  cached = undefined;
}
