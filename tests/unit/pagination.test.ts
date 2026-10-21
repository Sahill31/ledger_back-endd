import "../helpers/env";
import { describe, expect, it } from "vitest";
import { paginate, paginationSchema, skipTake } from "../../src/utils/pagination";

describe("pagination", () => {
  it("applies defaults, coerces strings, and caps pageSize at 100", () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(paginationSchema.parse({ page: "3", pageSize: "50" })).toEqual({ page: 3, pageSize: 50 });
    expect(() => paginationSchema.parse({ pageSize: "500" })).toThrow();
    expect(() => paginationSchema.parse({ page: "0" })).toThrow();
  });

  it("computes skip/take and totals", () => {
    const p = paginationSchema.parse({ page: "2", pageSize: "10" });
    expect(skipTake(p)).toEqual({ skip: 10, take: 10 });
    const out = paginate([1, 2], 25, p);
    expect(out.pagination).toEqual({ page: 2, pageSize: 10, total: 25, totalPages: 3 });
  });
});
