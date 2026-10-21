import "../helpers/env";
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { BillStatus, ScheduleStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { createApp } from "../../src/app";
import {
  auth,
  billPayload,
  makeCategory,
  makeDealership,
  makeSchedule,
  makeUser,
  pdfBuffer,
  prisma,
  resetDb,
} from "../helpers/db";
import { firstOfMonth } from "../../src/utils/date";
import { runOverdueSweep } from "../../src/jobs/overdueSchedules.job";

const app = createApp();
const base = "/api/v1";

async function fixture() {
  const { user: admin, token: adminToken } = await makeUser({ role: "ADMIN" });
  const dealer = await makeDealership();
  const cat = await makeCategory("Electricity");
  const { user: acct, token: acctToken } = await makeUser({
    role: "ACCOUNTANT",
    dealershipIds: [dealer.id],
  });
  return { admin, adminToken, acct, acctToken, dealer, cat };
}

async function createBill(
  dealershipId: string,
  categoryId: string,
  submittedById: string,
  amount: string,
  status: BillStatus,
  period: Date
) {
  return prisma.bill.create({
    data: {
      billReference: `AL-T-${Math.random().toString(36).slice(2, 10)}`,
      dealershipId,
      categoryId,
      submittedById,
      billingPeriod: period,
      billingDate: period,
      amount: new Prisma.Decimal(amount),
      documentKey: `bills/${dealershipId}/t.pdf`,
      originalDocumentName: "t.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 100,
      status,
    },
  });
}

describe("analytics + financial aggregation", () => {
  beforeEach(resetDb);

  it("monthly-spending splits approved vs pending with decimal precision", async () => {
    const f = await fixture();
    const oct = firstOfMonth(2026, 10);
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "100.10", "APPROVED", oct);
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "0.20", "APPROVED", oct);
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "50.00", "SUBMITTED", oct);
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "999.99", "REJECTED", oct);

    const res = await request(app)
      .get(`${base}/analytics/monthly-spending?year=2026`)
      .set(auth(f.adminToken));
    expect(res.status).toBe(200);
    const oct_ = res.body.data.find((p: { month: number }) => p.month === 10);
    expect(oct_.approved).toBe(100.3); // 100.10 + 0.20 — Decimal, not float
    expect(oct_.pending).toBe(50);
    expect(oct_.total).toBe(150.3);
    expect(oct_.count).toBe(3); // rejected excluded from count
  });

  it("budget-vs-actual computes utilization, remaining, MoM with Decimal math", async () => {
    const f = await fixture();
    const oct = firstOfMonth(2026, 10);
    const sep = firstOfMonth(2026, 9);
    await prisma.budgetRule.create({
      data: {
        dealershipId: f.dealer.id,
        categoryId: f.cat.id,
        effectiveMonth: oct,
        monthlyAmount: new Prisma.Decimal("200.00"),
        createdById: f.admin.id,
      },
    });
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "150.00", "APPROVED", oct);
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "100.00", "APPROVED", sep);
    // pending bill must NOT count toward actual
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "1000.00", "SUBMITTED", oct);

    const res = await request(app)
      .get(`${base}/analytics/budget-vs-actual?month=10&year=2026`)
      .set(auth(f.adminToken));
    const row = res.body.data[0];
    expect(row.actual).toBe(150);
    expect(row.budget).toBe(200);
    expect(row.remaining).toBe(50);
    expect(row.utilization).toBe(75);
    expect(row.overBudget).toBe(0);
    expect(row.monthOverMonthChange).toBe(50); // 150 vs 100
  });

  it("CSV export returns escaped text/csv", async () => {
    const f = await fixture();
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "42.00", "APPROVED", firstOfMonth(2026, 10));
    const res = await request(app)
      .get(`${base}/analytics/export?type=bills&month=10&year=2026`)
      .set(auth(f.adminToken));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("reference,dealership");
    expect(res.text).toContain("42.00");
  });

  it("accountant dashboard is scoped and contains no budget fields", async () => {
    const f = await fixture();
    const schedule = await makeSchedule({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      createdById: f.admin.id,
      submissionDeadline: new Date(Date.now() - 2 * 864e5), // overdue
    });
    void schedule;
    await createBill(f.dealer.id, f.cat.id, f.acct.id, "10", "APPROVED", firstOfMonth(2026, 10));

    const res = await request(app).get(`${base}/analytics/my-dashboard`).set(auth(f.acctToken));
    expect(res.status).toBe(200);
    expect(res.body.data.overdue).toBe(1);
    expect(res.body.data.approved).toBe(1);
    expect(res.body.data.assignedDealerships).toBe(1);
    expect(JSON.stringify(res.body)).not.toMatch(/budget/i);
  });

  it("admins cannot call the accountant dashboard", async () => {
    const f = await fixture();
    const res = await request(app).get(`${base}/analytics/my-dashboard`).set(auth(f.adminToken));
    expect(res.status).toBe(403);
  });
});

describe("budget confidentiality + rules", () => {
  beforeEach(resetDb);

  it("creates, updates (with history) and rejects duplicate budget rules", async () => {
    const f = await fixture();
    const create = await request(app)
      .post(`${base}/budgets`)
      .set(auth(f.adminToken))
      .send({
        dealershipId: f.dealer.id,
        categoryId: f.cat.id,
        month: 10,
        year: 2026,
        monthlyAmount: 500,
      });
    expect(create.status).toBe(201);

    const dup = await request(app)
      .post(`${base}/budgets`)
      .set(auth(f.adminToken))
      .send({
        dealershipId: f.dealer.id,
        categoryId: f.cat.id,
        month: 10,
        year: 2026,
        monthlyAmount: 600,
      });
    expect(dup.status).toBe(409);

    const upd = await request(app)
      .patch(`${base}/budgets/${create.body.data.id}`)
      .set(auth(f.adminToken))
      .send({ monthlyAmount: 750.5 });
    expect(upd.body.data.amount).toBe(750.5);
    expect(upd.body.data.history).toHaveLength(1);
    expect(upd.body.data.history[0].amount).toBe(750.5);

    // negative amounts blocked
    const neg = await request(app)
      .patch(`${base}/budgets/${create.body.data.id}`)
      .set(auth(f.adminToken))
      .send({ monthlyAmount: -1 });
    expect(neg.status).toBe(400);
  });
});

describe("notifications", () => {
  beforeEach(resetDb);

  it("lists, marks read, and marks all read for the owner", async () => {
    const { user, token } = await makeUser({ role: "ACCOUNTANT" });
    const n1 = await prisma.notification.create({
      data: { recipientId: user.id, type: "system", title: "a", message: "m" },
    });
    await prisma.notification.create({
      data: { recipientId: user.id, type: "system", title: "b", message: "m" },
    });

    let res = await request(app).get(`${base}/notifications/unread-count`).set(auth(token));
    expect(res.body.data.count).toBe(2);

    res = await request(app).patch(`${base}/notifications/${n1.id}/read`).set(auth(token));
    expect(res.status).toBe(200);
    res = await request(app).get(`${base}/notifications/unread-count`).set(auth(token));
    expect(res.body.data.count).toBe(1);

    res = await request(app).post(`${base}/notifications/read-all`).set(auth(token));
    expect(res.status).toBe(200);
    res = await request(app).get(`${base}/notifications/unread-count`).set(auth(token));
    expect(res.body.data.count).toBe(0);
  });
});

describe("overdue schedules job", () => {
  beforeEach(resetDb);

  it("marks overdue schedules, notifies once, and is idempotent", async () => {
    const f = await fixture();
    const pastDeadline = new Date(Date.now() - 2 * 864e5);
    const s = await makeSchedule({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      createdById: f.admin.id,
      assignedAccountantId: f.acct.id,
      submissionDeadline: pastDeadline,
    });

    const r1 = await runOverdueSweep();
    expect(r1.markedOverdue).toBe(1);
    expect(r1.notificationsCreated).toBeGreaterThan(0);

    const updated = await prisma.billSchedule.findUnique({ where: { id: s.id } });
    expect(updated!.status).toBe(ScheduleStatus.OVERDUE);

    const r2 = await runOverdueSweep();
    expect(r2.notificationsCreated).toBe(0); // dedup keys prevent repeats

    const count = await prisma.notification.count({
      where: { deduplicationKey: `schedule:${s.id}:overdue` },
    });
    expect(count).toBe(1);
  });

  it("reconciles schedules when a bill exists", async () => {
    const f = await fixture();
    const s = await makeSchedule({
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      createdById: f.admin.id,
    });
    // simulate a bill submitted directly
    const submit = await request(app)
      .post(`${base}/bills`)
      .set(auth(f.acctToken))
      .field(
        "data",
        JSON.stringify(
          billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, scheduleId: s.id })
        )
      )
      .attach("document", pdfBuffer(), { filename: "b.pdf", contentType: "application/pdf" });
    expect(submit.status).toBe(201);

    // set schedule back to SCHEDULED to simulate drift
    await prisma.billSchedule.update({ where: { id: s.id }, data: { status: "SCHEDULED" } });
    const r = await runOverdueSweep();
    expect(r.reconciled).toBeGreaterThanOrEqual(1);
    const updated = await prisma.billSchedule.findUnique({ where: { id: s.id } });
    expect(updated!.status).toBe(ScheduleStatus.SUBMITTED);
  });

  it("job endpoint requires the shared secret", async () => {
    const unauth = await request(app).post(`${base}/jobs/overdue-sweep`);
    expect(unauth.status).toBe(403);
    const ok = await request(app)
      .post(`${base}/jobs/overdue-sweep`)
      .set("x-job-secret", process.env.JOB_SECRET!);
    expect(ok.status).toBe(200);
  });
});
