import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { addDays, addMinutes } from "date-fns";
import type { User } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { prisma } from "../config/database";
import { signAccessToken, type RequestUser } from "../middleware/authenticate";
import { ApiError } from "../utils/ApiError";
import { toUserDTO, userModel, type UserDTO } from "../models/user.model";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

function refreshExpiry(): Date {
  // Parse "7d"/"30d"/"12h" — only day/hour units supported for refresh TTL.
  const m = /^(\d+)([dh])$/.exec(env.JWT_REFRESH_EXPIRES_IN);
  const n = m ? parseInt(m[1]!, 10) : 7;
  return m?.[2] === "h" ? addMinutes(new Date(), n * 60) : addDays(new Date(), n);
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

async function issueTokens(user: User, meta?: { userAgent?: string; ip?: string }): Promise<AuthTokens> {
  const refreshToken = randomBytes(48).toString("base64url");
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: refreshExpiry(),
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    },
  });
  return {
    accessToken: signAccessToken({ id: user.id, role: user.role }),
    refreshToken,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  };
}

export const authService = {
  async login(
    email: string,
    password: string,
    meta?: { userAgent?: string; ip?: string }
  ): Promise<{ user: UserDTO; tokens: AuthTokens }> {
    const user = await userModel.findByEmail(email);
    // Constant-shape failure — do not reveal which part was wrong.
    if (!user) throw ApiError.unauthenticated("Invalid email or password.");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw ApiError.unauthenticated("Invalid email or password.");
    if (!user.isActive) {
      throw ApiError.forbidden("This account has been deactivated. Contact your administrator.");
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
      include: { assignments: { select: { dealershipId: true } } },
    });
    const tokens = await issueTokens(user, meta);
    return { user: toUserDTO(updated), tokens };
  },

  /** Rotates the refresh token — old token is revoked, new pair issued. */
  async refresh(
    rawRefreshToken: string,
    meta?: { userAgent?: string; ip?: string }
  ): Promise<{ user: UserDTO; tokens: AuthTokens }> {
    const tokenHash = sha256(rawRefreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw ApiError.unauthenticated("Invalid or expired refresh token");
    }
    const user = stored.user;
    if (!user.isActive) {
      throw ApiError.forbidden("This account has been deactivated.");
    }

    const tokens = await prisma.$transaction(async (tx) => {
      const newRefresh = randomBytes(48).toString("base64url");
      const created = await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(newRefresh),
          expiresAt: refreshExpiry(),
          userAgent: meta?.userAgent,
          ip: meta?.ip,
        },
      });
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
      return {
        accessToken: signAccessToken({ id: user.id, role: user.role }),
        refreshToken: newRefresh,
        expiresIn: env.JWT_ACCESS_EXPIRES_IN,
      } satisfies AuthTokens;
    });

    const full = await userModel.findById(user.id);
    return { user: toUserDTO(full!), tokens };
  },

  /** Revokes a refresh token (idempotent). */
  async logout(rawRefreshToken?: string) {
    if (!rawRefreshToken) return;
    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(rawRefreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async getSessionUser(userId: string): Promise<UserDTO> {
    const user = await userModel.findById(userId);
    if (!user || !user.isActive) throw ApiError.unauthenticated();
    return toUserDTO(user);
  },

  /**
   * Issues a one-hour password-reset token. With no email provider configured
   * the reset link is logged at WARN level — wire an SMTP/transactional-mail
   * provider here in production.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await userModel.findByEmail(email);
    // Always succeed — never reveal whether the account exists.
    if (!user || !user.isActive) return;

    const token = randomBytes(32).toString("base64url");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: addMinutes(new Date(), 60),
      },
    });
    const link = `${env.corsOrigins[0] ?? "http://localhost:5173"}/reset-password?token=${token}`;
    logger.warn({ userId: user.id, link }, "password reset link generated (no mail provider configured)");
  },

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = sha256(token);
    const stored = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
      throw ApiError.badRequest("Reset link is invalid or has expired.");
    }
    const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_SALT_ROUNDS);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: stored.userId },
        data: { passwordHash },
      }),
      prisma.passwordResetToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      }),
      // Revoke all sessions after a password change.
      prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  },

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, env.BCRYPT_SALT_ROUNDS);
  },

  /** Exported for tests — stable hashing used for token storage. */
  _sha256: sha256,
  _timingEqual(a: string, b: string) {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  },
};

export function toRequestUser(dto: UserDTO): Omit<RequestUser, "fullName" | "email"> & { role: "ADMIN" | "ACCOUNTANT" } {
  return {
    id: dto.id,
    role: dto.role === "admin" ? "ADMIN" : "ACCOUNTANT",
    dealershipIds: dto.dealershipIds,
  };
}
