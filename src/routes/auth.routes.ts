import { Router } from "express";
import { authController } from "../controllers/auth.controller";
import { authenticate } from "../middleware/authenticate";
import { authLimiter, passwordResetLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
} from "../schemas/auth.schema";

export const authRoutes = Router();

authRoutes.post("/login", authLimiter, validate({ body: loginSchema }), authController.login);
authRoutes.post("/refresh", authLimiter, validate({ body: refreshSchema }), authController.refresh);
authRoutes.post("/logout", authController.logout);
authRoutes.post(
  "/forgot-password",
  passwordResetLimiter,
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword
);
authRoutes.post(
  "/reset-password",
  passwordResetLimiter,
  validate({ body: resetPasswordSchema }),
  authController.resetPassword
);
authRoutes.get("/me", authenticate, authController.me);
