import { Router } from "express";
import { dealershipController } from "../controllers/dealership.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";
import {
  createDealershipSchema,
  listDealershipsQuery,
  setDealershipStatusSchema,
  updateDealershipSchema,
} from "../schemas/dealership.schema";

export const dealershipRoutes = Router();

dealershipRoutes.use(authenticate);

dealershipRoutes.get("/", validate({ query: listDealershipsQuery }), dealershipController.list);
dealershipRoutes.get("/:id", validate({ params: idParamSchema }), dealershipController.getById);
dealershipRoutes.get(
  "/:id/accountants",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema }),
  dealershipController.accountants
);

// Admin-only management.
dealershipRoutes.post(
  "/",
  authorizeRole("ADMIN"),
  validate({ body: createDealershipSchema }),
  dealershipController.create
);
dealershipRoutes.patch(
  "/:id",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema, body: updateDealershipSchema }),
  dealershipController.update
);
dealershipRoutes.patch(
  "/:id/status",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema, body: setDealershipStatusSchema }),
  dealershipController.setStatus
);
dealershipRoutes.delete(
  "/:id",
  authorizeRole("ADMIN"),
  validate({ params: idParamSchema }),
  dealershipController.remove
);
