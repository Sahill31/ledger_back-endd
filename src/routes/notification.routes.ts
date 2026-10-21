import { Router } from "express";
import { z } from "zod";
import { notificationController } from "../controllers/notification.controller";
import { authenticate } from "../middleware/authenticate";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";
import { paginationQuery } from "../schemas/common.schema";

const listNotificationsQuery = paginationQuery.extend({
  unreadOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

export const notificationRoutes = Router();

// All operations are scoped to the authenticated owner — no cross-user access.
notificationRoutes.use(authenticate);

notificationRoutes.get("/", validate({ query: listNotificationsQuery }), notificationController.list);
notificationRoutes.get("/unread-count", notificationController.unreadCount);
notificationRoutes.patch("/:id/read", validate({ params: idParamSchema }), notificationController.markRead);
notificationRoutes.post("/read-all", notificationController.markAllRead);
