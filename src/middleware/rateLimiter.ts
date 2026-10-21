import rateLimit from "express-rate-limit";

const json = {
  success: false,
  error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
};

/** Sensitive auth endpoints — tight limit. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: json,
});

/** Password reset — extra tight. */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: json,
});

/** Upload endpoints — moderate. */
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: json,
});

/** General API baseline. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: json,
});
