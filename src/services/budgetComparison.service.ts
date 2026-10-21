import { BudgetComparisonStatus, Prisma } from "@prisma/client";
import { prisma } from "../config/database";

/**
 * Budget comparison engine.
 *
 * BUSINESS RULE (documented, applied everywhere):
 *   The amount compared against the monthly budget is the bill's
 *   CURRENT-PERIOD charge — `currentPeriodAmount` when the bill supplies it
 *   (extracted from the document or corrected by the accountant), otherwise
 *   the total payable `amount`. Prior-period arrears on the document are
 *   never mixed into the comparison.
 *
 * All arithmetic runs on Prisma.Decimal — no JS float math on money.
 */
export interface BudgetComparison {
  status: BudgetComparisonStatus;
  /** The amount actually compared (current-period rule above). */
  comparisonAmount: Prisma.Decimal;
  /** Matched rule id — null when no budget exists. */
  budgetRuleId: string | null;
  /** Snapshot of the matched monthly budget — ADMIN-ONLY data. */
  budgetAmount: Prisma.Decimal | null;
}

export interface ComparisonInput {
  dealershipId: string;
  categoryId: string;
  /** First day of the billing month. */
  billingPeriod: Date;
  /** Total payable on the bill. */
  amount: Prisma.Decimal | number;
  /** Current-period charges excluding arrears, when available. */
  currentPeriodAmount?: Prisma.Decimal | number | null;
}

/** Resolve the comparison amount per the documented business rule. */
export function comparisonAmountFor(input: {
  amount: Prisma.Decimal | number;
  currentPeriodAmount?: Prisma.Decimal | number | null;
}): Prisma.Decimal {
  const cur =
    input.currentPeriodAmount !== null && input.currentPeriodAmount !== undefined
      ? new Prisma.Decimal(input.currentPeriodAmount)
      : null;
  const total = new Prisma.Decimal(input.amount);
  // Sanity: extracted current-period must not exceed total payable.
  if (cur && cur.greaterThan(0) && cur.lessThanOrEqualTo(total)) return cur;
  return total;
}

async function compute(
  input: ComparisonInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<BudgetComparison> {
  const comparisonAmount = comparisonAmountFor(input);
  const rule = await tx.budgetRule.findFirst({
    where: {
      dealershipId: input.dealershipId,
      categoryId: input.categoryId,
      effectiveMonth: input.billingPeriod,
      isActive: true,
    },
  });
  if (!rule) {
    return {
      status: BudgetComparisonStatus.NO_BUDGET,
      comparisonAmount,
      budgetRuleId: null,
      budgetAmount: null,
    };
  }
  return {
    status: comparisonAmount.lessThanOrEqualTo(rule.monthlyAmount)
      ? BudgetComparisonStatus.WITHIN_BUDGET
      : BudgetComparisonStatus.OVER_BUDGET,
    comparisonAmount,
    budgetRuleId: rule.id,
    budgetAmount: rule.monthlyAmount,
  };
}

export const budgetComparisonService = {
  compute,

  /**
   * Admin-facing detail: full figures. Accountant callers must use
   * `toPublicStatus` — the raw amounts are confidential.
   */
  async detail(input: ComparisonInput, tx?: Prisma.TransactionClient) {
    const c = await compute(input, tx);
    return {
      status: c.status,
      comparisonAmount: Number(c.comparisonAmount),
      budgetAmount: c.budgetAmount === null ? null : Number(c.budgetAmount),
      varianceAmount:
        c.budgetAmount === null ? null : Number(c.comparisonAmount.sub(c.budgetAmount)),
      utilizationPercentage:
        c.budgetAmount === null || c.budgetAmount.isZero()
          ? null
          : Number(
              c.comparisonAmount
                .div(c.budgetAmount)
                .mul(100)
                .toDecimalPlaces(1)
            ),
    };
  },

  /** Status-only view — safe to return to accountants. */
  toPublicStatus(c: { status: BudgetComparisonStatus }) {
    return { status: c.status };
  },
};
