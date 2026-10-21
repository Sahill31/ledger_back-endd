import "../helpers/env";
import { describe, expect, it } from "vitest";
import { jvvnlBillExtractor } from "../../src/services/documents/jvvnlBillExtractor.service";
import { comparisonAmountFor } from "../../src/services/budgetComparison.service";

/** Representative text shape of a JVVNL bill (digital PDF text layer). */
const SAMPLE = `
JAIPUR VIDYUT VITRAN NIGAM LIMITED
JVVNL Electricity Bill
K. No: 123456789012
Consumer Name: SHREE AUTO MOTORS PVT LTD
Address: PLOT 14, RIVER ROAD, JAIPUR 302001
Meter No: RJ45210098
Bill No: 8877665544
Bill Month: September 2026
Issue Date: 05/10/2026
Due Date: 20/10/2026
Previous Reading: 12040 Current Reading: 12790
Units Consumed: 750 kWh
Sanctioned Load: 25 KW
Tariff Category: HT-2
Energy Charges: Rs. 6,825.00
Fixed Charges: Rs. 1,875.00
Fuel Surcharge: Rs. 412.50
Electricity Duty: Rs. 911.25
Current Bill Amount: Rs. 10,023.75
Previous Outstanding: Rs. 2,150.00
Payments Received: Rs. 2,150.00
Net Amount Payable: Rs. 10,023.75
`;

describe("jvvnlBillExtractor", () => {
  it("extracts identification, dates, amounts and consumption", () => {
    const r = jvvnlBillExtractor.extract(SAMPLE);
    const f = r.fields;
    expect(f.utilityProvider).toBe("JVVNL");
    expect(f.documentType).toBe("electricity_bill");
    expect(f.consumerNumber).toBe("123456789012");
    expect(f.billNumber).toBe("8877665544");
    expect(f.consumerName).toContain("SHREE AUTO MOTORS");
    expect(f.meterNumber).toBe("RJ45210098");
    expect(f.issueDate).toBe("2026-10-05");
    expect(f.dueDate).toBe("2026-10-20");
    expect(f.billingMonth).toBe(9);
    expect(f.billingYear).toBe(2026);
    expect(f.previousReading).toBe(12040);
    expect(f.currentReading).toBe(12790);
    expect(f.unitsKwh).toBe(750);
    expect(f.sanctionedLoadKw).toBe(25);
    expect(f.energyCharges).toBe(6825);
    expect(f.fixedCharges).toBe(1875);
    expect(f.surcharges).toBe(412.5);
    expect(f.taxesDuties).toBe(911.25);
    expect(f.currentAmount).toBe(10023.75);
    expect(f.totalAmountPayable).toBe(10023.75);
    expect(f.previousOutstanding).toBe(2150);
    expect(r.confidence.totalAmountPayable).toBeGreaterThan(0.5);
  });

  it("returns nulls + warnings for missing fields — never fabricates", () => {
    const r = jvvnlBillExtractor.extract("JVVNL\nEnergy Charges: Rs. 500.00\n");
    expect(r.fields.consumerNumber).toBeNull();
    expect(r.fields.totalAmountPayable).toBeNull();
    expect(r.fields.dueDate).toBeNull();
    expect(r.warnings.some((w) => /consumer/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /payable|amount/i.test(w))).toBe(true);
  });

  it("flags non-JVVNL providers with a warning", () => {
    const r = jvvnlBillExtractor.extract("BSES Rajdhani Power Ltd\nK No: 12345678\nNet Payable: 100.00");
    expect(r.warnings.some((w) => /not JVVNL/i.test(w))).toBe(true);
  });

  it("warns on inconsistent totals (charges + arrears ≠ payable)", () => {
    const bad = SAMPLE.replace("Net Amount Payable: Rs. 10,023.75", "Net Amount Payable: Rs. 99,999.00");
    const r = jvvnlBillExtractor.extract(bad);
    expect(r.warnings.some((w) => /inconsistent/i.test(w))).toBe(true);
  });
});

/**
 * Real JVVNL BILLPRINT pdf-parse output — the embedded font has a broken cmap,
 * so Devanagari decodes as substitute glyphs (वत[मान = वर्तमान, ǒबल = बिल,
 * èवȥ = स्वी) and the totals row arrives concatenated.
 */
const BILLPRINT = `AEN H_III_JAGATAPURA
2114830
उपखÖड कोड:
जयपुर ǒवƭुत ǒवतरण िनगम िलिमटेड
के.नं
  नाम.
  पता
211483020138
ARPIT MANSHANI S/O SHRI RAMESH MAN SHANI B-603 4 TH
FLOOR  SOUTH AND HOMES JAIPUR
B-603 4 TH FLOOR  SOUTH AND HOMES JAIPUR
202606
ǒबल माह :
  उपभोग :
411.0000
  िनयत भुगतान ितिथ :
ǒपछलȥ बकाया रािश (ǽ.)
0.00
वत[मान देय रािश (ǽ.)
िनयत ितिथ तक कुल देय रािश
ǒवलàब भुगतान सरचाज[(ǽ.)
 िनयत ितिथ पƱात देय कुल रािश
3621.403621.0067.913689.00
 सेवा Đमांक
DS
 èवȥ. Įेणȥ
489757
 èवȥ.लोड(Ǒक.वा./हा.पा.)
1000XA
 टैǐरफ कोड
6.00 (KW)
R
 वत[मान पठन ितिथ
1250.00
 अमानत रािश(ǽ)
01-06-2026
 गत पठन ितिथ
650.00
 मȥटर सुर¢ा रािश(ǽ)
01-05-2026
 वत[मान èथाǒपत मȥटर नं
193
 औसत मािसक उपभोग(पू.ǒव.
4884261
 वत[मान पठन
1.00
 गुणांक
8900.0000
 वत[मान पठन
8489.0000
 गत पठन(KWH)
17170843
 खाता संÉया
  ǒबल जारȣ कȥ ितिथ:
  ǒबिलंग ǔèथित :
062626341
04-06-2026
R
1.0000
ǒबल नं:
15-06-2026
Last Bill Amount
2860.45
Last Payment Due Date
14-05-2026
Last Payment
2860.00
Last Payment Date
14-05-2026
ǒĤंट Ǒदनांक -
05-Jun-2026 10:56:11
Account No. : JVVNL1211483020138`;

describe("jvvnlBillExtractor — real BILLPRINT (Hindi layout)", () => {
  const r = jvvnlBillExtractor.extract(BILLPRINT);
  const f = r.fields;

  it("extracts identity fields", () => {
    expect(f.utilityProvider).toBe("JVVNL");
    expect(f.consumerNumber).toBe("211483020138"); // के.नं
    expect(f.billNumber).toBe("062626341");        // बिल नं
    expect(f.consumerName).toContain("ARPIT MANSHANI");
    expect(f.serviceAddress).toContain("B-603");
    expect(f.meterNumber).toBe("4884261");
  });

  it("extracts dates with the real due date — not the last-payment date", () => {
    expect(f.issueDate).toBe("2026-06-04"); // बिल जारी करने की तिथि
    expect(f.dueDate).toBe("2026-06-15");   // नियत भुगतान तिथि
    expect(f.currentReadingDate).toBe("2026-06-01");
    expect(f.previousReadingDate).toBe("2026-05-01");
    expect(f.billingMonth).toBe(6);         // बिल माह 202606
    expect(f.billingYear).toBe(2026);
  });

  it("extracts the four-amount totals row positionally", () => {
    expect(f.currentAmount).toBe(3621.4);       // वर्तमान देय राशि
    expect(f.totalAmountPayable).toBe(3621);    // नियत तिथि तक कुल देय राशि
    expect(f.lateFees).toBe(67.91);             // विलम्ब भुगतान सरचार्ज
    expect(f.previousOutstanding).toBe(0);      // पिछली बकाया राशि
    expect(f.previousBillAmount).toBe(2860.45); // Last Bill Amount
    expect(f.paymentsReceived).toBe(2860);      // Last Payment
  });

  it("extracts consumption without confusing meter no./tariff code", () => {
    expect(f.currentReading).toBe(8900);
    expect(f.previousReading).toBe(8489);
    expect(f.unitsKwh).toBe(411);
    expect(f.sanctionedLoadKw).toBe(6);       // NOT 1000 (tariff code 1000XA)
    expect(f.tariffCategory).toBe("DS");
  });
});

describe("comparisonAmountFor business rule", () => {
  it("uses current-period charges when present and ≤ total", () => {
    expect(comparisonAmountFor({ amount: 12000, currentPeriodAmount: 10000 }).toNumber()).toBe(10000);
  });
  it("falls back to total payable when current period is missing", () => {
    expect(comparisonAmountFor({ amount: 12000 }).toNumber()).toBe(12000);
    expect(comparisonAmountFor({ amount: 12000, currentPeriodAmount: null }).toNumber()).toBe(12000);
  });
  it("rejects a current-period figure larger than the total (bad extraction)", () => {
    expect(comparisonAmountFor({ amount: 9000, currentPeriodAmount: 11000 }).toNumber()).toBe(9000);
  });
});
