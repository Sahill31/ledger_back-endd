import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { MulterError } from "multer";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { ApiError } from "../utils/ApiError";

/**
 * Centralized error handler. Never leaks SQL text, stack traces, or secrets
 * in production responses.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      res.status(409).json({
        success: false,
        error: { code: "CONFLICT", message: "A record with these values already exists." },
      });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Resource not found" },
      });
      return;
    }
    if (err.code === "P2003") {
      res.status(422).json({
        success: false,
        error: { code: "UNPROCESSABLE", message: "Referenced record does not exist." },
      });
      return;
    }
  }

  if (err instanceof MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Uploaded file exceeds the maximum allowed size."
        : "File upload failed.";
    res.status(400).json({ success: false, error: { code: "BAD_REQUEST", message } });
    return;
  }

  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "Malformed JSON body" },
    });
    return;
  }

  logger.error(
    { err, method: req.method, path: req.path },
    "unhandled request error"
  );
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: env.isProd ? "An unexpected error occurred" : String(err),
    },
  });
}
