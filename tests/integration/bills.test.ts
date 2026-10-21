import "../helpers/env";
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { BillStatus, ScheduleStatus } from "@prisma/client";
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

const app = createApp();
const base = "/api/v1";

async function fixture() {
  const { user: admin, token: adminToken } = await makeUser({ role: "ADMIN" });
  const dealer = await makeDealership();
  const otherDealer = await makeDealership();
  const cat = await makeCategory();
  const { user: acct, token: acctToken } = await makeUser({
    role: "ACCOUNTANT",
    dealershipIds: [dealer.id],
  });
  const schedule = await makeSchedule({
    dealershipId: dealer.id,
    categoryId: cat.id,
    createdById: admin.id,
    assignedAccountantId: acct.id,
  });
  return { admin, adminToken, acct, acctToken, dealer, otherDealer, cat, schedule };
}

async function submitBill(
  token: string,
  payload: ReturnType<typeof billPayload>,
  file = pdfBuffer()
) {
  return request(app)
    .post(`${base}/bills`)
    .set(auth(token))
    .field("data", JSON.stringify(payload))
    .attach("document", file, { filename: "bill.pdf", contentType: "application/pdf" });
}

describe("bill submission workflow", () => {
  beforeEach(resetDb);

  it("submits a bill with document, creates audit + admin notification, updates schedule", async () => {
    const f = await fixture();
    const res = await submitBill(
      f.acctToken,
      billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, scheduleId: f.schedule.id, amount: 250.75 })
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("submitted");
    expect(res.body.data.billReference).toMatch(/^AL-\d{4}-\d{6}$/);
    expect(res.body.data.documentKey).toBeUndefined(); // storage key never leaks

    const bill = await prisma.bill.findUnique({ where: { id: res.body.data.id } });
    expect(bill!.amount.toString()).toBe("250.75");
    expect(bill!.documentKey).toContain(`bills/${f.dealer.id}/`);

    const schedule = await prisma.billSchedule.findUnique({ where: { id: f.schedule.id } });
    expect(schedule!.status).toBe(ScheduleStatus.SUBMITTED);

    const history = await prisma.billReviewHistory.findMany({ where: { billId: bill!.id } });
    expect(history).toHaveLength(1);
    expect(history[0]!.decision).toBe("SUBMITTED");

    const notifs = await prisma.notification.findMany({ where: { relatedEntityId: bill!.id } });
    expect(notifs.length).toBeGreaterThan(0);
    expect(notifs[0]!.type).toBe("review_request");
  });

  it("rejects submission for an unassigned dealership", async () => {
    const f = await fixture();
    const res = await submitBill(
      f.acctToken,
      billPayload({ dealershipId: f.otherDealer.id, categoryId: f.cat.id })
    );
    expect(res.status).toBe(403);
  });

  it("rejects mismatched schedule/category and rolls back cleanly", async () => {
    const f = await fixture();
    const otherCat = await makeCategory("Water");
    const res = await submitBill(
      f.acctToken,
      billPayload({ dealershipId: f.dealer.id, categoryId: otherCat.id, scheduleId: f.schedule.id })
    );
    expect(res.status).toBe(422);
    expect(await prisma.bill.count()).toBe(0);
    expect(await prisma.billReviewHistory.count()).toBe(0);
  });

  it("blocks duplicate submission for the same schedule", async () => {
    const f = await fixture();
    const p = billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, scheduleId: f.schedule.id });
    expect((await submitBill(f.acctToken, p)).status).toBe(201);
    const dup = await submitBill(f.acctToken, p);
    expect(dup.status).toBe(409);
  });

  it("blocks duplicate active bill for dealer+category+period without schedule", async () => {
    const f = await fixture();
    const p = billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id });
    expect((await submitBill(f.acctToken, p)).status).toBe(201);
    expect((await submitBill(f.acctToken, p)).status).toBe(409);
  });

  it("rejects files whose bytes don't match the declared type", async () => {
    const f = await fixture();
    const res = await submitBill(
      f.acctToken,
      billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }),
      Buffer.from("MZ not a pdf")
    );
    expect(res.status).toBe(400);
  });

  it("rejects a submission by an admin", async () => {
    const f = await fixture();
    const res = await submitBill(
      f.adminToken,
      billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id })
    );
    expect(res.status).toBe(403);
  });

  it("validates amount and payload fields", async () => {
    const f = await fixture();
    const res = await submitBill(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }),
      amount: -5,
    });
    expect(res.status).toBe(400);
  });

  it("full review cycle: under_review → correction → resubmit → approve", async () => {
    const f = await fixture();
    const sub = await submitBill(
      f.acctToken,
      billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, scheduleId: f.schedule.id })
    );
    const billId = sub.body.data.id;

    // Under review
    let r = await request(app)
      .post(`${base}/bills/${billId}/review`)
      .set(auth(f.adminToken))
      .send({ decision: "UNDER_REVIEW" });
    expect(r.body.data.status).toBe("under_review");

    // Reject requires reason
    r = await request(app)
      .post(`${base}/bills/${billId}/review`)
      .set(auth(f.adminToken))
      .send({ decision: "REJECTED" });
    expect(r.status).toBe(400); // zod requires `reason`

    // Correction requested with instructions
    r = await request(app)
      .post(`${base}/bills/${billId}/review`)
      .set(auth(f.adminToken))
      .send({ decision: "CORRECTION_REQUESTED", reason: "Amount looks wrong" });
    expect(r.body.data.status).toBe("correction_requested");

    // Accountant got a notification
    const notif = await prisma.notification.findFirst({
      where: { recipientId: f.acct.id, type: "correction_requested" },
    });
    expect(notif).toBeTruthy();

    // Resubmit with corrected amount
    const re = await request(app)
      .post(`${base}/bills/${billId}/resubmit`)
      .set(auth(f.acctToken))
      .field(
        "data",
        JSON.stringify(
          billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, scheduleId: f.schedule.id, amount: 300 })
        )
      )
      .attach("document", pdfBuffer(), { filename: "fixed.pdf", contentType: "application/pdf" });
    expect(re.status).toBe(200);
    expect(re.body.data.status).toBe("submitted");
    expect(re.body.data.resubmissionCount).toBe(1);
    expect(re.body.data.amount).toBe(300);

    // Approve
    r = await request(app)
      .post(`${base}/bills/${billId}/review`)
      .set(auth(f.adminToken))
      .send({ decision: "APPROVED" });
    expect(r.body.data.status).toBe("approved");

    const schedule = await prisma.billSchedule.findUnique({ where: { id: f.schedule.id } });
    expect(schedule!.status).toBe(ScheduleStatus.COMPLETED);

    // Audit trail contains every step
    const history = await prisma.billReviewHistory.findMany({
      where: { billId },
      orderBy: { createdAt: "asc" },
    });
    expect(history.map((h) => h.decision)).toEqual([
      "SUBMITTED",
      "UNDER_REVIEW",
      "CORRECTION_REQUESTED",
      "RESUBMITTED",
      "APPROVED",
    ]);
  });

  it("rejects invalid review transitions", async () => {
    const f = await fixture();
    const sub = await submitBill(
      f.acctToken,
      billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id })
    );
    const billId = sub.body.data.id;
    await request(app)
      .post(`${base}/bills/${billId}/review`)
      .set(auth(f.adminToken))
      .send({ decision: "APPROVED" });
    const again = await request(app)
      .post(`${base}/bills/${billId}/review`)
      .set(auth(f.adminToken))
      .send({ decision: "REJECTED", reason: "too late" });
    expect(again.status).toBe(409);
  });

  it("rejected bill frees the schedule slot for a new submission", async () => {
    const f = await fixture();
    const p = billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, scheduleId: f.schedule.id });
    const sub = await submitBill(f.acctToken, p);
    const billId = sub.body.data.id;
    await request(app)
      .post(`${base}/bills/${billId}/review`)
      .set(auth(f.adminToken))
      .send({ decision: "REJECTED", reason: "wrong document" });
    const resub = await request(app)
      .post(`${base}/bills/${billId}/resubmit`)
      .set(auth(f.acctToken))
      .field("data", JSON.stringify(p))
      .attach("document", pdfBuffer(), { filename: "v2.pdf", contentType: "application/pdf" });
    expect(resub.status).toBe(200);
    expect(resub.body.data.status).toBe("submitted");
  });

  it("document-url: owner-scope ok, out-of-scope denied, URL serves file", async () => {
    const f = await fixture();
    const otherAcct = await makeUser({ role: "ACCOUNTANT", dealershipIds: [f.otherDealer.id] });
    const sub = await submitBill(
      f.acctToken,
      billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id })
    );
    const billId = sub.body.data.id;

    const ok = await request(app).get(`${base}/bills/${billId}/document-url`).set(auth(f.acctToken));
    expect(ok.status).toBe(200);
    const url = new URL(ok.body.data.url);
    const fileRes = await request(app).get(url.pathname + url.search);
    expect(fileRes.status).toBe(200);
    expect(fileRes.body.toString()).toContain("%PDF");

    const denied = await request(app)
      .get(`${base}/bills/${billId}/document-url`)
      .set(auth(otherAcct.token));
    expect(denied.status).toBe(403);
  });

  it("accountant list is scoped; admin sees all", async () => {
    const f = await fixture();
    await submitBill(f.acctToken, billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }));

    // another dealership + bill by another accountant
    const other = await makeUser({ role: "ACCOUNTANT", dealershipIds: [f.otherDealer.id] });
    const cat2 = await makeCategory("Internet");
    await submitBill(other.token, billPayload({ dealershipId: f.otherDealer.id, categoryId: cat2.id }));

    const acctList = await request(app).get(`${base}/bills`).set(auth(f.acctToken));
    expect(acctList.body.data.items).toHaveLength(1);
    expect(acctList.body.data.items[0].dealershipId).toBe(f.dealer.id);

    const adminList = await request(app).get(`${base}/bills`).set(auth(f.adminToken));
    expect(adminList.body.data.items).toHaveLength(2);
  });

  it("history endpoint is scoped to dealership access", async () => {
    const f = await fixture();
    const otherAcct = await makeUser({ role: "ACCOUNTANT", dealershipIds: [f.otherDealer.id] });
    const sub = await submitBill(f.acctToken, billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }));
    const res = await request(app)
      .get(`${base}/bills/${sub.body.data.id}/history`)
      .set(auth(otherAcct.token));
    expect(res.status).toBe(403);
    const ok = await request(app)
      .get(`${base}/bills/${sub.body.data.id}/history`)
      .set(auth(f.acctToken));
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].action).toBe("submitted");
  });

  it("review responses never include budget data", async () => {
    const f = await fixture();
    const sub = await submitBill(f.acctToken, billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }));
    const res = await request(app)
      .get(`${base}/bills/${sub.body.data.id}`)
      .set(auth(f.acctToken));
    // budgetStatus (a label only) is allowed; confidential figures are not.
    expect(JSON.stringify(res.body)).not.toMatch(
      /budgetAmount|budgetComparison|variance|utilization|monthlyAmount|budgetRule/i
    );
  });
});

describe("bill expiry/expired statuses", () => {
  beforeEach(resetDb);
  it("keeps REJECTED bills readable for audit", async () => {
    const f = await fixture();
    const sub = await submitBill(f.acctToken, billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }));
    await request(app)
      .post(`${base}/bills/${sub.body.data.id}/review`)
      .set(auth(f.adminToken))
      .send({ decision: "REJECTED", reason: "duplicate invoice" });
    const bill = await prisma.bill.findUnique({ where: { id: sub.body.data.id } });
    expect(bill!.status).toBe(BillStatus.REJECTED);
    expect(bill!.rejectionReason).toBe("duplicate invoice");
  });
});
