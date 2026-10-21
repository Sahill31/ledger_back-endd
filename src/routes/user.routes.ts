import { Router } from "express";
import { userController } from "../controllers/user.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";
import {
  createUserSchema,
  listUsersQuery,
  setAssignmentsSchema,
  setUserStatusSchema,
  updateProfileSchema,
  updateUserSchema,
} from "../schemas/user.schema";

export const userRoutes = Router();

// Self-service profile (any authenticated user; role/status not modifiable).
userRoutes.patch(
  "/me/profile",
  authenticate,
  validate({ body: updateProfileSchema }),
  userController.updateProfile
);

// Everything below is admin-only.
userRoutes.use(authenticate, authorizeRole("ADMIN"));

userRoutes.get("/", validate({ query: listUsersQuery }), userController.list);
userRoutes.post("/", validate({ body: createUserSchema }), userController.create);
userRoutes.get("/:id", validate({ params: idParamSchema }), userController.getById);
userRoutes.patch(
  "/:id",
  validate({ params: idParamSchema, body: updateUserSchema }),
  userController.update
);
userRoutes.patch(
  "/:id/status",
  validate({ params: idParamSchema, body: setUserStatusSchema }),
  userController.setStatus
);
userRoutes.delete(
  "/:id",
  validate({ params: idParamSchema }),
  userController.remove
);
userRoutes.get(
  "/:id/assignments",
  validate({ params: idParamSchema }),
  userController.getAssignments
);
userRoutes.put(
  "/:id/assignments",
  validate({ params: idParamSchema, body: setAssignmentsSchema }),
  userController.setAssignments
);
