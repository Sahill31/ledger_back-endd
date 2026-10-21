import { Router } from "express";
import { categoryController } from "../controllers/category.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";
import {
  createCategorySchema,
  setCategoryStatusSchema,
  updateCategorySchema,
} from "../schemas/category.schema";

export const categoryRoutes = Router();

categoryRoutes.use(authenticate);

categoryRoutes.get("/", categoryController.list);
categoryRoutes.post(
  "/",
  authorizeRole("ADMIN"),
  validate({ body: createCategorySchema }),
  categoryController.create
);
categoryRoutes.patch(
  "/:id",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema, body: updateCategorySchema }),
  categoryController.update
);
categoryRoutes.patch(
  "/:id/status",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema, body: setCategoryStatusSchema }),
  categoryController.setStatus
);
categoryRoutes.delete(
  "/:id",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema }),
  categoryController.remove
);
