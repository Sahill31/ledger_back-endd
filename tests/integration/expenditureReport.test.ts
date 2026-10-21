import { randomUUID } from "crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { auth, makeCategory, makeDealership, makeUser, prisma, resetDb } from "../helpers/db";
import { firstOfMonth } from "../../src/utils/date";
import type { BillStatus } from "@prisma/client";

const app = createApp();
const base = "/api/v1";

async function fixture() {
  const { user: admin, token: adminToken } = await makeUser({ role: "ADMIN" });
  const dealer = await makeDealership();
  const dealer2 = await makeDealership();
  const cat = await makeCategory("Electricity");
  const cat2 = await makeCategory("Water");
  const { user: acct, token: acctToken } = await makeUser({
    role: "ACCOUNTANT",
    dealershipIds: [dealer.id],
  });
  return { admin, adminToken, acct, acctToken, dealer, dealer2, cat, cat2 };
}

async function makeBill(opts: {
  dealershipId: string;
  categoryId: string;
  submittedById: string;
  billingPeriod: Date;
  amount: number;
  currentPeriodAmount?: number | null;
  status?: BillStatus;
  scheduleId?: string;
}) {
  return prisma.bill.create({
    data: {
      billReference: `AL-T-${randomUUID().slice(0, 8)}`,
      dealershipId: opts.dealershipId,
      categoryId: opts.categoryId,
      scheduleId: opts.scheduleId ?? null,
      billingPeriod: opts.billingPeriod,
      billingDate: opts.billingPeriod,
      amount: opts.amount,
      currentPeriodAmount: opts.currentPeriodAmount ?? null,
      documentKey: `bills/${randomUUID()}.pdf`,
      originalDocumentName: "bill.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1024,
      submittedById: opts.submittedById,
      status: opts.status ?? "APPROVED",
    },
  });
}

async function makeBudget(opts: {
  dealershipId: string;
  categoryId: string;
  effectiveMonth: Date;
  monthlyAmount: number;
  createdById: string;
}) {
  return prisma.budgetRule.create({
    data: {
      dealershipId: opts.dealershipId,
      categoryId: opts.categoryId,
      effectiveMonth: opts.effectiveMonth,
      monthlyAmount: opts.monthlyAmount,
      createdById: opts.createdById,
    },
  });
}

const report = (token: string, qs: string) =>
  request(app).get(`${base}/analytics/expenditure-report?${qs}`).set(auth(token));

const PERIOD = { month: 10, year: 2026 };
const periodDate = firstOfMonth(PERIOD.year, PERIOD.month);

describe("expenditure report — summary", () => {
  beforeEach(resetDb);

  it("within budget: approved spend below budget", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      effectiveMonth: periodDate,
      monthlyAmount: 10000,
      createdById: f.admin.id,
    });
    await makeBill({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      submittedById: f.acct.id,
      billingPeriod: periodDate,
      amount: 6000,
    });

    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    expect(res.status).toBe(200);
    const s = res.body.data.summary;
    expect(s.status).toBe("within_budget");
    expect(s.budget).toBe(10000);
    expect(s.actualExpenditure).toBe(6000);
    expect(s.remainingBudget).toBe(4000);
    expect(s.exceededAmount).toBeNull();
    expect(s.utilizationPercentage).toBe(60);
  });

  it("actual equal to budget → within budget, zero remaining", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      effectiveMonth: periodDate,
      monthlyAmount: 5000,
      createdById: f.admin.id,
    });
    await makeBill({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      submittedById: f.acct.id,
      billingPeriod: periodDate,
      amount: 5000,
    });

    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    const s = res.body.data.summary;
    expect(s.status).toBe("within_budget");
    expect(s.remainingBudget).toBe(0);
    expect(s.utilizationPercentage).toBe(100);
  });

  it("over budget: exceeded amount, utilization > 100", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      effectiveMonth: periodDate,
      monthlyAmount: 4000,
      createdById: f.admin.id,
    });
    await makeBill({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      submittedById: f.acct.id,
      billingPeriod: periodDate,
      amount: 5000,
    });

    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    const s = res.body.data.summary;
    expect(s.status).toBe("exceeded");
    expect(s.exceededAmount).toBe(1000);
    expect(s.remainingBudget).toBeNull();
    expect(s.utilizationPercentage).toBe(125);
    const pair = res.body.data.comparisons.find(
      (c: { dealershipId: string; categoryId: string }) =>
        c.dealershipId === f.dealer.id && c.categoryId === f.cat.id
    );
    expect(pair.status).toBe("exceeded");
    expect(pair.exceeded).toBe(1000);
  });

  it("no configured budget → no_budget status, spend still reported", async () => {
    const f = await fixture();
    await makeBill({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      submittedById: f.acct.id,
      billingPeriod: periodDate,
      amount: 3000,
    });

    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    const s = res.body.data.summary;
    expect(s.status).toBe("no_budget");
    expect(s.budget).toBeNull();
    expect(s.actualExpenditure).toBe(3000);
    expect(s.utilizationPercentage).toBeNull();
    expect(s.remainingBudget).toBeNull();
    expect(s.exceededAmount).toBeNull();
  });

  it("no approved bills → no_expenditure; pending-only → pending_only", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      effectiveMonth: periodDate,
      monthlyAmount: 8000,
      createdById: f.admin.id,
    });

    let res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    expect(res.body.data.summary.status).toBe("no_expenditure");
    expect(res.body.data.summary.actualExpenditure).toBe(0);

    await makeBill({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      submittedById: f.acct.id,
      billingPeriod: periodDate,
      amount: 2500,
      status: "SUBMITTED",
    });
    res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    const s = res.body.data.summary;
    expect(s.status).toBe("pending_only");
    expect(s.actualExpenditure).toBe(0);
    expect(s.pendingReview.amount).toBe(2500);
    expect(s.pendingReview.count).toBe(1);
  });

  it("rejected bills excluded from expenditure, reported separately", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      effectiveMonth: periodDate,
      monthlyAmount: 10000,
      createdById: f.admin.id,
    });
    await makeBill({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      submittedById: f.acct.id,
      billingPeriod: periodDate,
      amount: 9000,
      status: "REJECTED",
    });

    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    const s = res.body.data.summary;
    expect(s.actualExpenditure).toBe(0);
    expect(s.rejected.amount).toBe(9000);
    expect(s.rejected.count).toBe(1);
    expect(s.status).toBe("no_expenditure");
  });

  it("multiple approved bills aggregate correctly; zero budget handled", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      effectiveMonth: periodDate,
      monthlyAmount: 1000,
      createdById: f.admin.id,
    });
    for (const amount of [100, 200, 300.5]) {
      await makeBill({
        dealershipId: f.dealer.id,
        categoryId: f.cat.id,
        submittedById: f.acct.id,
        billingPeriod: periodDate,
        amount,
      });
    }
    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    const s = res.body.data.summary;
    expect(s.actualExpenditure).toBeCloseTo(600.5);
    expect(s.approvedBillCount).toBe(3);

    // Zero-budget rule → no_budget presentation, no divide-by-zero.
    await prisma.budgetRule.updateMany({ where: {}, data: { monthlyAmount: 0 } });
    const res2 = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    expect(res2.body.data.summary.status).toBe("no_budget");
    expect(res2.body.data.summary.utilizationPercentage).toBeNull();
  });

  it("current-period charge is the expenditure basis, not total payable", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      effectiveMonth: periodDate,
      monthlyAmount: 4000,
      createdById: f.admin.id,
    });
    // Total payable 5000 (incl. arrears), current-period charge 3621.40.
    await makeBill({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      submittedById: f.acct.id,
      billingPeriod: periodDate,
      amount: 5000,
      currentPeriodAmount: 3621.4,
    });

    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    const s = res.body.data.summary;
    expect(s.actualExpenditure).toBeCloseTo(3621.4);
    expect(s.approvedTotalPayable).toBe(5000);
    expect(s.status).toBe("within_budget");
    const row = res.body.data.bills.items[0];
    expect(row.expenditureAmount).toBeCloseTo(3621.4);
    expect(row.totalPayable).toBe(5000);
  });

  it("September bill submitted in October compares against September's budget", async () => {
    const f = await fixture();
    const sept = firstOfMonth(2026, 9);
    await makeBudget({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      effectiveMonth: sept,
      monthlyAmount: 3000,
      createdById: f.admin.id,
    });
    await makeBill({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      submittedById: f.acct.id,
      billingPeriod: sept,
      amount: 3500,
    });

    const res = await report(f.adminToken, "month=9&year=2026");
    expect(res.body.data.summary.status).toBe("exceeded");
    expect(res.body.data.summary.exceededAmount).toBe(500);
  });
});

describe("expenditure report — filters, aggregation & bills", () => {
  beforeEach(resetDb);

  it("all-dealership aggregation sums budgets and spend (no averaging)", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id, categoryId: f.cat.id, effectiveMonth: periodDate,
      monthlyAmount: 1000, createdById: f.admin.id,
    });
    await makeBudget({
      dealershipId: f.dealer2.id, categoryId: f.cat.id, effectiveMonth: periodDate,
      monthlyAmount: 1000, createdById: f.admin.id,
    });
    // dealer: 600/1000 (60%), dealer2: 1400/1000 (140%)
    await makeBill({ dealershipId: f.dealer.id, categoryId: f.cat.id, submittedById: f.acct.id, billingPeriod: periodDate, amount: 600 });
    await makeBill({ dealershipId: f.dealer2.id, categoryId: f.cat.id, submittedById: f.acct.id, billingPeriod: periodDate, amount: 1400 });

    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    const s = res.body.data.summary;
    expect(s.budget).toBe(2000);
    expect(s.actualExpenditure).toBe(2000);
    expect(s.utilizationPercentage).toBe(100); // not (60+140)/2
    expect(res.body.data.comparisons).toHaveLength(2);

    // Scoped to dealer2 only → exceeded.
    const res2 = await report(
      f.adminToken,
      `month=${PERIOD.month}&year=${PERIOD.year}&dealershipId=${f.dealer2.id}`
    );
    expect(res2.body.data.summary.status).toBe("exceeded");
    expect(res2.body.data.comparisons).toHaveLength(1);
  });

  it("different budgets for different months", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id, categoryId: f.cat.id,
      effectiveMonth: firstOfMonth(2026, 9), monthlyAmount: 2000, createdById: f.admin.id,
    });
    await makeBudget({
      dealershipId: f.dealer.id, categoryId: f.cat.id,
      effectiveMonth: periodDate, monthlyAmount: 9000, createdById: f.admin.id,
    });
    await makeBill({
      dealershipId: f.dealer.id, categoryId: f.cat.id,
      submittedById: f.acct.id, billingPeriod: firstOfMonth(2026, 9), amount: 2500,
    });
    await makeBill({
      dealershipId: f.dealer.id, categoryId: f.cat.id,
      submittedById: f.acct.id, billingPeriod: periodDate, amount: 5000,
    });

    const sep = await report(f.adminToken, "month=9&year=2026");
    expect(sep.body.data.summary.status).toBe("exceeded");
    const oct = await report(f.adminToken, "month=10&year=2026");
    expect(oct.body.data.summary.status).toBe("within_budget");
  });

  it("trend covers the year without inventing budgets; prev-month compare works", async () => {
    const f = await fixture();
    await makeBudget({
      dealershipId: f.dealer.id, categoryId: f.cat.id,
      effectiveMonth: periodDate, monthlyAmount: 8000, createdById: f.admin.id,
    });
    await makeBill({
      dealershipId: f.dealer.id, categoryId: f.cat.id,
      submittedById: f.acct.id, billingPeriod: periodDate, amount: 6000,
    });

    const res = await report(
      f.adminToken,
      `month=${PERIOD.month}&year=${PERIOD.year}&comparePrevious=true`
    );
    const trend = res.body.data.trend;
    expect(trend).toHaveLength(12);
    expect(trend[8].budget).toBeNull(); // September — no budget configured
    expect(trend[9].budget).toBe(8000); // October
    expect(trend[9].actual).toBe(6000);
    expect(res.body.data.previousPeriod.month).toBe(9);
    expect(res.body.data.previousPeriod.status).toBe("no_budget");
  });

  it("reviewStatus filter limits the bill list; pagination works", async () => {
    const f = await fixture();
    await makeBill({ dealershipId: f.dealer.id, categoryId: f.cat.id, submittedById: f.acct.id, billingPeriod: periodDate, amount: 100, status: "APPROVED" });
    await makeBill({ dealershipId: f.dealer.id, categoryId: f.cat.id, submittedById: f.acct.id, billingPeriod: periodDate, amount: 200, status: "SUBMITTED" });
    await makeBill({ dealershipId: f.dealer.id, categoryId: f.cat.id, submittedById: f.acct.id, billingPeriod: periodDate, amount: 300, status: "REJECTED" });

    const res = await report(
      f.adminToken,
      `month=${PERIOD.month}&year=${PERIOD.year}&reviewStatus=REJECTED&pageSize=1`
    );
    expect(res.body.data.bills.total).toBe(1);
    expect(res.body.data.bills.items[0].status).toBe("REJECTED");
    expect(res.body.data.bills.pageSize).toBe(1);
  });

  it("linked monthly task id is returned on the bill row", async () => {
    const f = await fixture();
    const schedule = await prisma.billSchedule.create({
      data: {
        dealershipId: f.dealer.id,
        categoryId: f.cat.id,
        createdById: f.admin.id,
        billingPeriod: periodDate,
        dueDate: new Date(Date.UTC(2026, 9, 20)),
        submissionDeadline: new Date(Date.UTC(2026, 9, 25)),
      },
    });
    await makeBill({
      dealershipId: f.dealer.id, categoryId: f.cat.id, submittedById: f.acct.id,
      billingPeriod: periodDate, amount: 100, scheduleId: schedule.id,
    });
    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    expect(res.body.data.bills.items[0].scheduleId).toBe(schedule.id);
  });
});

describe("expenditure report — authorization & safety", () => {
  beforeEach(resetDb);

  it("accountants get 403 even with valid filters", async () => {
    const f = await fixture();
    const res = await report(f.acctToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    expect(res.status).toBe(403);
  });

  it("unauthenticated requests are rejected", async () => {
    const res = await request(app).get(
      `${base}/analytics/expenditure-report?month=${PERIOD.month}&year=${PERIOD.year}`
    );
    expect(res.status).toBe(401);
  });

  it("invalid month is rejected by validation", async () => {
    const f = await fixture();
    const res = await report(f.adminToken, "month=13&year=2026");
    expect(res.status).toBe(400);
  });

  it("the report never mutates scheduler state", async () => {
    const f = await fixture();
    const before = await prisma.billSchedule.count();
    const res = await report(f.adminToken, `month=${PERIOD.month}&year=${PERIOD.year}`);
    expect(res.status).toBe(200);
    expect(await prisma.billSchedule.count()).toBe(before);
  });
});
