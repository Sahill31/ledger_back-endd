import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { checkDatabaseConnection } from "../config/database";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import { runOverdueSweep } from "../jobs/overdueSchedules.job";
import { authRoutes } from "./auth.routes";
import { userRoutes } from "./user.routes";
import { dealershipRoutes } from "./dealership.routes";
import { categoryRoutes } from "./category.routes";
import { budgetRoutes } from "./budget.routes";
import { scheduleRoutes } from "./schedule.routes";
import { billRoutes } from "./bill.routes";
import { reviewRoutes } from "./review.routes";
import { notificationRoutes } from "./notification.routes";
import { analyticsRoutes } from "./analytics.routes";
import { documentRoutes } from "./document.routes";
import { filesRoutes } from "./files.routes";

export const apiRouter = Router();

apiRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const db = await checkDatabaseConnection();
    res.status(db ? 200 : 503).json({
      success: db,
      data: { status: db ? "ok" : "degraded", database: db ? "up" : "down" },
    });
  })
);

/**
 * External-scheduler trigger for the overdue-schedule sweep. Protected by a
 * shared secret header (x-job-secret), not user auth — intended for cron
 * systems (e.g. GitHub Actions, pg_cron+webhook, uptime workers). Constant-time
 * comparison; missing JOB_SECRET disables the endpoint.
 */
apiRouter.post(
  "/jobs/overdue-sweep",
  asyncHandler(async (req, res) => {
    if (!env.JOB_SECRET) throw ApiError.notFound();
    const provided = req.headers["x-job-secret"];
    const a = Buffer.from(String(provided ?? ""));
    const b = Buffer.from(createHash("sha256").update(env.JOB_SECRET).digest());
    const ah = createHash("sha256").update(a).digest();
    if (a.length === 0 || !timingSafeEqual(ah, b)) throw ApiError.forbidden();
    const result = await runOverdueSweep();
    res.json({ success: true, data: result });
  })
);

apiRouter.use("/files", filesRoutes);
apiRouter.use("/auth", authRoutes);
apiRouter.use("/users", userRoutes);
apiRouter.use("/dealerships", dealershipRoutes);
apiRouter.use("/categories", categoryRoutes);
apiRouter.use("/budgets", budgetRoutes);
apiRouter.use("/schedules", scheduleRoutes);
apiRouter.use("/bills", billRoutes);
apiRouter.use("/documents", documentRoutes);
apiRouter.use("/review", reviewRoutes);
apiRouter.use("/notifications", notificationRoutes);
apiRouter.use("/analytics", analyticsRoutes);
