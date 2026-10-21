import "../helpers/env";
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { DocumentScanStatus, Prisma } from "@prisma/client";
import { createApp } from "../../src/app";
import {
  auth,
  billPayload,
  makeCategory,
  makeDealership,
  makeUser,
  pdfBuffer,
  prisma,
  resetDb,
} from "../helpers/db";
import { firstOfMonth } from "../../src/utils/date";

const app = createApp();
const base = "/api/v1";

async function fixture() {
  const { user: admin, token: adminToken } = await makeUser({ role: "ADMIN" });
  const dealer = await makeDealership();
  const otherDealer = await makeDealership();
  const cat = await makeCategory("Electricity");
  const { user: acct, token: acctToken } = await makeUser({
    role: "ACCOUNTANT",
    dealershipIds: [dealer.id],
  });
  const { token: otherAcctToken } = await makeUser({
    role: "ACCOUNTANT",
    dealershipIds: [otherDealer.id],
  });
  return { admin, adminToken, acct, acctToken, otherAcctToken, dealer, otherDealer, cat };
}

async function makeScan(opts: {
  uploadedById: string;
  dealershipId?: string;
  categoryId?: string;
  status?: DocumentScanStatus;
  expiresInMs?: number;
  extracted?: object;
}) {
  return prisma.documentScan.create({
    data: {
      uploadedById: opts.uploadedById,
      dealershipId: opts.dealershipId ?? null,
      categoryId: opts.categoryId ?? null,
      documentKey: `scans/${opts.uploadedById}/${randomUUID()}.pdf`,
      originalFileName: "jvvnl-bill.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 2048,
      status: opts.status ?? DocumentScanStatus.EXTRACTED,
      extractionMethod: "pdf_text",
      extractedJson: opts.extracted
        ? (opts.extracted as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      warningsJson: [],
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)),
    },
  });
}

async function submitViaScan(token: string, payload: Record<string, unknown>) {
  return request(app)
    .post(`${base}/bills`)
    .set(auth(token))
    .field("data", JSON.stringify(payload));
}

/** Generates a real digital PDF with a text layer via pdfkit. */
function jvvnlPdfBuffer(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(14).text("JAIPUR VIDYUT VITRAN NIGAM LIMITED");
    doc.fontSize(11).text("JVVNL Electricity Bill");
    [
      "K. No: 123456789012",
      "Consumer Name: TEST MOTORS PVT LTD",
      "Meter No: RJ45210098",
      "Bill No: 8877665544",
      "Bill Month: October 2026",
      "Issue Date: 05/11/2026",
      "Due Date: 20/11/2026",
      "Units Consumed: 750 kWh",
      "Energy Charges: Rs. 6,825.00",
      "Fixed Charges: Rs. 1,875.00",
      "Current Bill Amount: Rs. 8,700.00",
      "Net Amount Payable: Rs. 8,700.00",
    ].forEach((l) => doc.text(l));
    doc.end();
  });
}

describe("document scanning endpoints", () => {
  beforeEach(resetDb);

  it("extracts fields from a digitally generated JVVNL PDF", async () => {
    const f = await fixture();
    const pdf = await jvvnlPdfBuffer();
    const res = await request(app)
      .post(`${base}/documents/scan`)
      .set(auth(f.acctToken))
      .field("dealershipId", f.dealer.id)
      .field("categoryId", f.cat.id)
      .attach("document", pdf, { filename: "jvvnl.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d.status).toBe("extracted");
    expect(d.extractionMethod).toBe("pdf_text");
    expect(d.fields.consumerNumber).toBe("123456789012");
    expect(d.fields.totalAmountPayable).toBe(8700);
    expect(d.fields.dueDate).toBe("2026-11-20");
    expect(d.fields.billingMonth).toBe(10);
    expect(d.fields.unitsKwh).toBe(750);
  });

  it("rejects admins and unauthenticated callers", async () => {
    const f = await fixture();
    const asAdmin = await request(app)
      .post(`${base}/documents/scan`)
      .set(auth(f.adminToken))
      .attach("document", pdfBuffer(), { filename: "b.pdf", contentType: "application/pdf" });
    expect(asAdmin.status).toBe(403);
    const anon = await request(app).post(`${base}/documents/scan`);
    expect(anon.status).toBe(401);
  });

  it("rejects files whose signature does not match the declared type", async () => {
    const f = await fixture();
    const res = await request(app)
      .post(`${base}/documents/scan`)
      .set(auth(f.acctToken))
      .field("dealershipId", f.dealer.id)
      .attach("document", Buffer.from("MZ executable bytes"), {
        filename: "bill.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/contents do not match|Unsupported/i);
  });

  it("marks an unreadable PDF as FAILED with a manual-entry warning", async () => {
    const f = await fixture();
    const res = await request(app)
      .post(`${base}/documents/scan`)
      .set(auth(f.acctToken))
      .attach("document", pdfBuffer(), { filename: "bad.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(["failed", "partial"]).toContain(res.body.data.status);
    expect(res.body.data.warnings.length).toBeGreaterThan(0);
  });

  it("scan results are private to the uploader", async () => {
    const f = await fixture();
    const scan = await makeScan({ uploadedById: f.acct.id });
    const ok = await request(app)
      .get(`${base}/documents/scans/${scan.id}`)
      .set(auth(f.acctToken));
    expect(ok.status).toBe(200);
    const other = await request(app)
      .get(`${base}/documents/scans/${scan.id}`)
      .set(auth(f.otherAcctToken));
    expect(other.status).toBe(403);
    const urlOther = await request(app)
      .get(`${base}/documents/scans/${scan.id}/document-url`)
      .set(auth(f.otherAcctToken));
    expect(urlOther.status).toBe(403);
  });
});

describe("bill submission via scan + budget comparison", () => {
  beforeEach(resetDb);

  async function budgeted(monthlyAmount: number) {
    const f = await fixture();
    await prisma.budgetRule.create({
      data: {
        dealershipId: f.dealer.id,
        categoryId: f.cat.id,
        effectiveMonth: firstOfMonth(2026, 10),
        monthlyAmount,
        createdById: f.admin.id,
      },
    });
    return f;
  }

  it("submits a bill consuming a scan; extraction fills fields; budget = within", async () => {
    const f = await budgeted(5000);
    const scan = await makeScan({
      uploadedById: f.acct.id,
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      extracted: {
        consumerNumber: "K998877665",
        meterNumber: "MTR-77",
        unitsKwh: 400,
        currentAmount: 4000,
        totalAmountPayable: 4200,
        billNumber: "V-123",
      },
    });
    const res = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 4200 }),
      scanId: scan.id,
      // accountant corrects one extracted value
      currentPeriodAmount: 4100,
    });
    expect(res.status).toBe(201);
    const bill = res.body.data;
    expect(bill.consumerNumber).toBe("K998877665");
    expect(bill.meterNumber).toBe("MTR-77");
    expect(bill.unitsKwh).toBe(400);
    expect(bill.currentPeriodAmount).toBe(4100);
    expect(bill.previousBillAmount).toBeUndefined(); // no prior bill, not extracted
    // Accountant sees the status ONLY — never figures.
    expect(bill.budgetStatus).toBe("within_budget");
    expect(JSON.stringify(bill)).not.toMatch(/budgetAmount|variance|utilization/);
  });

  it("budget comparisons are computed server-side (equal/above/none)", async () => {
    const f = await budgeted(1000);
    await prisma.budgetRule.create({
      data: {
        dealershipId: f.dealer.id,
        categoryId: f.cat.id,
        effectiveMonth: firstOfMonth(2026, 11),
        monthlyAmount: 1000,
        createdById: f.admin.id,
      },
    });
    const mk = () =>
      makeScan({ uploadedById: f.acct.id, dealershipId: f.dealer.id, categoryId: f.cat.id });

    const eq = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 1000 }),
      scanId: (await mk()).id,
      consumerNumber: "EQ1",
    });
    expect(eq.status).toBe(201);
    expect(eq.body.data.budgetStatus).toBe("within_budget");

    const over = await makeScan({ uploadedById: f.acct.id });
    const overRes = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 2500 }),
      scanId: over.id,
      consumerNumber: "OV1",
      billingPeriod: { month: 11, year: 2026 },
    });
    expect(overRes.status).toBe(201);
    expect(overRes.body.data.budgetStatus).toBe("over_budget");
  });

  it("no budget configured → NO_BUDGET and figures hidden from accountant", async () => {
    const f = await fixture();
    const scan = await makeScan({ uploadedById: f.acct.id });
    const res = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 700 }),
      scanId: scan.id,
      consumerNumber: "NB1",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.budgetStatus).toBe("no_budget");
    const detail = await request(app)
      .get(`${base}/bills/${res.body.data.id}`)
      .set(auth(f.acctToken));
    expect(JSON.stringify(detail.body.data)).not.toMatch(/budgetAmount|variance|utilization/);
    // admin sees the full comparison object
    const adm = await request(app)
      .get(`${base}/bills/${res.body.data.id}`)
      .set(auth(f.adminToken));
    expect(adm.body.data.budgetComparison).toBeDefined();
    expect(adm.body.data.budgetComparison.status).toBe("no_budget");
    expect(adm.body.data.budgetComparison.budgetAmount).toBeNull();
  });

  it("admin sees figures on the budget-comparison endpoint; accountants get 403", async () => {
    const f = await budgeted(1000);
    const scan = await makeScan({ uploadedById: f.acct.id });
    const res = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 1500 }),
      scanId: scan.id,
      consumerNumber: "AD1",
    });
    const acct = await request(app)
      .get(`${base}/bills/${res.body.data.id}/budget-comparison`)
      .set(auth(f.acctToken));
    expect(acct.status).toBe(403);
    const adm = await request(app)
      .get(`${base}/bills/${res.body.data.id}/budget-comparison`)
      .set(auth(f.adminToken));
    expect(adm.status).toBe(200);
    expect(adm.body.data.budgetAmount).toBe(1000);
    expect(adm.body.data.comparisonAmount).toBe(1500);
    expect(adm.body.data.varianceAmount).toBe(500);
    expect(adm.body.data.utilizationPercentage).toBe(150);
  });

  it("budget lookup is month+dealership-scoped (wrong month → NO_BUDGET)", async () => {
    const f = await budgeted(1000);
    const scan = await makeScan({ uploadedById: f.acct.id });
    const res = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 800 }),
      scanId: scan.id,
      billingPeriod: { month: 9, year: 2026 }, // budget exists for Oct only
    });
    expect(res.status).toBe(201);
    expect(res.body.data.budgetStatus).toBe("no_budget");
  });

  it("matches the previous month's bill via consumer number", async () => {
    const f = await fixture();
    // September bill
    const s1 = await makeScan({ uploadedById: f.acct.id });
    const sep = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 900 }),
      scanId: s1.id,
      consumerNumber: "K555",
      billingPeriod: { month: 9, year: 2026 },
    });
    expect(sep.status).toBe(201);
    // October bill — same consumer
    const s2 = await makeScan({ uploadedById: f.acct.id });
    const oct = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 1200 }),
      scanId: s2.id,
      consumerNumber: "K555",
      billingPeriod: { month: 10, year: 2026 },
    });
    expect(oct.status).toBe(201);
    expect(oct.body.data.previousBillId).toBe(sep.body.data.id);
    expect(oct.body.data.previousBillAmount).toBe(900);

    const prev = await request(app)
      .get(`${base}/bills/${oct.body.data.id}/previous`)
      .set(auth(f.acctToken));
    expect(prev.status).toBe(200);
    expect(prev.body.data.id).toBe(sep.body.data.id);
  });

  it("leaves previousBill null when no earlier bill exists", async () => {
    const f = await fixture();
    const scan = await makeScan({ uploadedById: f.acct.id });
    const res = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id, amount: 500 }),
      scanId: scan.id,
      consumerNumber: "LONELY1",
    });
    expect(res.body.data.previousBillId).toBeUndefined();
    const prev = await request(app)
      .get(`${base}/bills/${res.body.data.id}/previous`)
      .set(auth(f.acctToken));
    expect(prev.body.data).toBeNull();
  });

  it("blocks duplicate submissions for the same consumer + period", async () => {
    const f = await fixture();
    const s1 = await makeScan({ uploadedById: f.acct.id });
    const first = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }),
      scanId: s1.id,
      consumerNumber: "DUP9",
    });
    expect(first.status).toBe(201);
    const s2 = await makeScan({ uploadedById: f.acct.id });
    const second = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }),
      scanId: s2.id,
      consumerNumber: "dup9 ", // normalization should still catch it
    });
    expect(second.status).toBe(409);
  });

  it("a consumed scan cannot be reused; expired scans rejected", async () => {
    const f = await fixture();
    const scan = await makeScan({ uploadedById: f.acct.id });
    const ok = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }),
      scanId: scan.id,
      consumerNumber: "USE1",
    });
    expect(ok.status).toBe(201);
    const reuse = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }),
      scanId: scan.id,
      billingPeriod: { month: 11, year: 2026 },
    });
    expect(reuse.status).toBe(409);

    const stale = await makeScan({ uploadedById: f.acct.id, expiresInMs: -1000 });
    const expired = await submitViaScan(f.acctToken, {
      ...billPayload({ dealershipId: f.dealer.id, categoryId: f.cat.id }),
      scanId: stale.id,
      billingPeriod: { month: 11, year: 2026 },
    });
    expect(expired.status).toBe(422);
  });

  it("budget preview returns status-only for accountants, figures for admins", async () => {
    const f = await budgeted(1000);
    const body = {
      dealershipId: f.dealer.id,
      categoryId: f.cat.id,
      billingPeriod: { month: 10, year: 2026 },
      amount: 2000,
    };
    const acct = await request(app)
      .post(`${base}/bills/budget-preview`)
      .set(auth(f.acctToken))
      .send(body);
    expect(acct.status).toBe(200);
    expect(acct.body.data).toEqual({ status: "over_budget" });
    const adm = await request(app)
      .post(`${base}/bills/budget-preview`)
      .set(auth(f.adminToken))
      .send(body);
    expect(adm.body.data.budgetAmount).toBe(1000);
    expect(adm.body.data.utilizationPercentage).toBe(200);
  });
});
