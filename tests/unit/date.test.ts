import "../helpers/env";
import { describe, expect, it } from "vitest";
import { firstOfMonth, normalizeToFirstOfMonth, toBillingPeriod } from "../../src/utils/date";

describe("date utils", () => {
  it("builds first-of-month UTC dates", () => {
    const d = firstOfMonth(2026, 3);
    expect(d.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("normalizes arbitrary dates to the first of the month", () => {
    expect(normalizeToFirstOfMonth(new Date("2026-10-21T15:30:00Z")).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z"
    );
  });

  it("round-trips billing periods", () => {
    const d = firstOfMonth(2026, 12);
    expect(toBillingPeriod(d)).toEqual({ month: 12, year: 2026 });
  });
});
