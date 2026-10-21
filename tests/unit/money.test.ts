import "../helpers/env";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { moneyToNumber, momChangePercent, percentUsed, toDecimal } from "../../src/utils/money";

const D = (v: string | number) => new Prisma.Decimal(v);

describe("money utils", () => {
  it("keeps two-decimal precision without float artifacts", () => {
    const a = toDecimal("0.1").plus(toDecimal("0.2"));
    expect(a.toString()).toBe("0.3");
    expect(moneyToNumber(a)).toBe(0.3);
  });

  it("multiplies precisely", () => {
    expect(moneyToNumber(D("12345.67").mul(3))).toBe(37037.01);
  });

  it("computes utilization against a Decimal budget", () => {
    expect(percentUsed(D(25), D(100))).toBe(25);
    expect(percentUsed(D(1), D(3))).toBeCloseTo(33.33, 2);
    expect(percentUsed(D(50), D(0))).toBe(0); // no division by zero
  });

  it("computes month-over-month change and handles missing baselines", () => {
    expect(momChangePercent(D(110), D(100))).toBe(10);
    expect(momChangePercent(D(90), D(100))).toBe(-10);
    expect(momChangePercent(D(50), D(0))).toBeNull();
    expect(momChangePercent(D(50), null)).toBeNull();
  });
});
