import { Router } from "express";
import { budgetController } from "../controllers/budget.controller";
import { authenticate } from "../middleware/authenticate";
import { authorizeRole } from "../middleware/authorizeRole";
import { validate } from "../middleware/validate";
import { idParamSchema } from "../schemas/common.schema";
import {
  budgetSummaryQuery,
  createBudgetSchema,
  listBudgetsQuery,
  updateBudgetSchema,
} from "../schemas/budget.schema";

/**
 * STRICTLY ADMIN. Accountants must never receive budget records or
 * budget-derived calculations — enforced by authorizeRole("ADMIN") on the
 * entire router (defense in depth beyond route-level checks).
 */
export const budgetRoutes = Router();

budgetRoutes.use(authenticate, authorizeRole("ADMIN"));

budgetRoutes.get("/", validate({ query: listBudgetsQuery }), budgetController.list);
budgetRoutes.get("/summary", validate({ query: budgetSummaryQuery }), budgetController.summary);
budgetRoutes.get("/:id", validate({ params: idParamSchema }), budgetController.getById);
budgetRoutes.post("/", validate({ body: createBudgetSchema }), budgetController.create);
budgetRoutes.patch(
  "/:id",
  validate({ params: idParamSchema, body: updateBudgetSchema }),
  budgetController.update
);
budgetRoutes.delete(
  "/:id",
  validate({ params: idParamSchema }),
  budgetController.remove
);
