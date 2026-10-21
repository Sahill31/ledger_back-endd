import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@prisma/client";
import { ApiError } from "../utils/ApiError";

/**
 * Role gate. Exactly two roles exist: ADMIN and ACCOUNTANT.
 * Usage: router.get("/", authenticate, authorizeRole("ADMIN"), handler)
 */
export function authorizeRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthenticated());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
    next();
  };
}

/** Accountant scope check: throws unless the user may access the dealership. */
export function assertDealershipAccess(
  user: { role: UserRole; dealershipIds: string[] },
  dealershipId: string
) {
  if (user.role === "ACCOUNTANT" && !user.dealershipIds.includes(dealershipId)) {
    throw ApiError.forbidden("You are not assigned to this dealership.");
  }
}
