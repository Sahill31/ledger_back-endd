import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { authService } from "../services/auth.service";

const meta = (req: Request) => ({
  userAgent: req.headers["user-agent"],
  ip: req.ip,
});

export const authController = {
  login: asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const { user, tokens } = await authService.login(email, password, meta(req));
    res.json({ success: true, data: { user, ...tokens }, message: "Logged in" });
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body;
    const { user, tokens } = await authService.refresh(refreshToken, meta(req));
    res.json({ success: true, data: { user, ...tokens } });
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    await authService.logout(req.body?.refreshToken);
    res.json({ success: true, data: null, message: "Logged out" });
  }),

  forgotPassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.forgotPassword(req.body.email);
    // Identical response whether or not the account exists.
    res.json({
      success: true,
      data: null,
      message: "If an account exists for that email, a reset link has been sent.",
    });
  }),

  resetPassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.resetPassword(req.body.token, req.body.password);
    res.json({ success: true, data: null, message: "Password updated" });
  }),

  me: asyncHandler(async (req: Request, res: Response) => {
    const user = await authService.getSessionUser(req.user!.id);
    res.json({ success: true, data: user });
  }),
};
