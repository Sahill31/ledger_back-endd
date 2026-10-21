import { Prisma } from "@prisma/client";

const { Decimal } = Prisma;

type DecimalLike = InstanceType<typeof Decimal>;

/**
 * Money is always a Decimal internally. Values are only converted to a JSON
 * number at the DTO boundary — never computed from display strings.
 */
export function toDecimal(v: DecimalLike | number | string): Prisma.Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

/** Serialize a Decimal for API responses (number, 2-dp precision kept). */
export function moneyToNumber(v: DecimalLike | number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return toDecimal(v).toDecimalPlaces(2).toNumber();
}

export function percentUsed(actual: Prisma.Decimal, budget: Prisma.Decimal): number {
  if (budget.lte(0)) return 0;
  return actual.div(budget).mul(100).toDecimalPlaces(2).toNumber();
}

/**
 * Month-over-month change percent. Returns null when the previous month has
 * zero or missing spend rather than fabricating a value.
 */
export function momChangePercent(
  current: Prisma.Decimal,
  previous: Prisma.Decimal | null
): number | null {
  if (previous === null || previous.lte(0)) return null;
  return current.minus(previous).div(previous).mul(100).toDecimalPlaces(2).toNumber();
}
