import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { ApiError } from "../utils/ApiError";

interface Schemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

/**
 * Validates request parts with Zod and replaces them with the parsed
 * (coerced/defaulted) values.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        const r = schemas.body.safeParse(req.body);
        if (!r.success) throw ApiError.validation("Request validation failed", formatIssues(r.error.issues));
        req.body = r.data;
      }
      if (schemas.params) {
        const r = schemas.params.safeParse(req.params);
        if (!r.success) throw ApiError.validation("Invalid route parameters", formatIssues(r.error.issues));
        req.params = r.data as typeof req.params;
      }
      if (schemas.query) {
        const r = schemas.query.safeParse(req.query);
        if (!r.success) throw ApiError.validation("Invalid query parameters", formatIssues(r.error.issues));
        req.query = r.data as typeof req.query;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

function formatIssues(issues: { path: (string | number)[]; message: string }[]) {
  return issues.map((i) => ({ field: i.path.join("."), message: i.message }));
}
