import { Router } from "express";
import { scheduleController } from "../controllers/schedule.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";
import {
  cancelScheduleSchema,
  createScheduleSchema,
  listSchedulesQuery,
  updateScheduleSchema,
} from "../schemas/schedule.schema";

export const scheduleRoutes = Router();

scheduleRoutes.use(authenticate);

// Read access: admins see all; accountants see scoped results (service-side).
scheduleRoutes.get("/", validate({ query: listSchedulesQuery }), scheduleController.list);
scheduleRoutes.get("/:id", validate({ params: idParamSchema }), scheduleController.getById);

// Management: admin-only.
scheduleRoutes.post(
  "/",
  authorizeRole("ADMIN"),
  validate({ body: createScheduleSchema }),
  scheduleController.create
);
scheduleRoutes.patch(
  "/:id",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema, body: updateScheduleSchema }),
  scheduleController.update
);
scheduleRoutes.post(
  "/:id/cancel",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema, body: cancelScheduleSchema }),
  scheduleController.cancel
);
scheduleRoutes.delete(
  "/:id",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema }),
  scheduleController.remove
);
