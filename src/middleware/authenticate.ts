import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { UserRole } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/database";
import { ApiError } from "../utils/ApiError";

export interface RequestUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  /** Dealership ids this accountant is assigned to. Empty for admins. */
  dealershipIds: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: RequestUser;
    }
  }
}

interface AccessTokenPayload extends jwt.JwtPayload {
  sub: string;
  role: UserRole;
  type: "access";
}

export function signAccessToken(user: { id: string; role: UserRole }): string {
  return jwt.sign({ role: user.role, type: "access" }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
    issuer: "autoledger-api",
    audience: "autoledger-client",
  });
}

/**
 * Verifies the Bearer access token, loads the user, and rejects inactive
 * accounts. Attaches `req.user`.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw ApiError.unauthenticated("Missing or malformed Authorization header");
    }
    const token = header.slice("Bearer ".length).trim();

    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
        issuer: "autoledger-api",
        audience: "autoledger-client",
      }) as AccessTokenPayload;
    } catch {
      throw ApiError.unauthenticated("Invalid or expired access token");
    }
    if (payload.type !== "access" || !payload.sub) {
      throw ApiError.unauthenticated("Invalid access token");
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        assignments: { select: { dealershipId: true } },
      },
    });
    if (!user) throw ApiError.unauthenticated("Account no longer exists");
    if (!user.isActive) {
      throw ApiError.forbidden("This account has been deactivated. Contact your administrator.");
    }

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      dealershipIds: user.assignments.map((a) => a.dealershipId),
    };
    next();
  } catch (err) {
    next(err);
  }
}
