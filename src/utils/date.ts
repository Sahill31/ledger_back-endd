import { endOfMonth, startOfMonth } from "date-fns";

/**
 * Calendar-month helpers. `billingPeriod` / `effectiveMonth` are stored as
 * PostgreSQL DATE values normalized to the first day of the month.
 */

export function firstOfMonth(year: number, month: number): Date {
  // month is 1-12
  return new Date(Date.UTC(year, month - 1, 1));
}

export function normalizeToFirstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function monthPeriodBounds(year: number, month: number) {
  const start = firstOfMonth(year, month);
  return { start, end: endOfMonth(start) };
}

export function parseYearMonth(input: { month: number; year: number }): Date {
  return firstOfMonth(input.year, input.month);
}

export function toBillingPeriod(d: Date): { month: number; year: number } {
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export { startOfMonth, endOfMonth };
