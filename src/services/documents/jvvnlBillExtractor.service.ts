/* eslint-disable no-useless-escape -- escaping `-`, `/`, `.` inside these bill-label regexes is intentional for readability. */
/**
 * JVVNL electricity bill field extractor.
 *
 * Parses the raw text of a JVVNL (Jaipur Vidyut Vitran Nigam Ltd.) electricity
 * bill — whether it came from a digital PDF's text layer or OCR — into a typed
 * extraction schema. Every field is nullable: nothing is ever fabricated, and
 * a missing amount is never assumed to be zero.
 *
 * Confidence is reported per field (0..1): strong labeled matches ≈0.9, fuzzy
 * matches ≈0.5, absent fields → 0 + a warning.
 */

export interface ExtractedBillFields {
  // Identification
  utilityProvider: string | null;
  documentType: "electricity_bill" | "unknown" | null;
  consumerNumber: string | null; // K-number / consumer / account number
  billNumber: string | null;     // vendor's bill/reference number
  consumerName: string | null;
  serviceAddress: string | null;
  meterNumber: string | null;

  // Billing period & dates (ISO yyyy-mm-dd)
  billingMonth: number | null;
  billingYear: number | null;
  previousReadingDate: string | null;
  currentReadingDate: string | null;
  issueDate: string | null;
  dueDate: string | null;

  // Amounts (INR, plain numbers)
  previousBillAmount: number | null;      // previous bill's payable amount
  previousOutstanding: number | null;     // arrears/balance carried forward
  paymentsReceived: number | null;
  energyCharges: number | null;
  fixedCharges: number | null;
  surcharges: number | null;              // fuel/FPPAS/DPS-type surcharges
  taxesDuties: number | null;             // electricity duty / tax
  lateFees: number | null;
  currentAmount: number | null;           // current-period charges only
  totalAmountPayable: number | null;      // net payable incl. arrears
  totalOutstanding: number | null;

  // Consumption
  previousReading: number | null;
  currentReading: number | null;
  unitsKwh: number | null;
  sanctionedLoadKw: number | null;
  tariffCategory: string | null;
}

export type ExtractedFieldKey = keyof ExtractedBillFields;

export interface ExtractionResult {
  fields: ExtractedBillFields;
  /** Per-field confidence 0..1 (0 when the field is absent). */
  confidence: Record<ExtractedFieldKey, number>;
  warnings: string[];
}

/**
 * JVVNL BILLPRINT PDFs embed a font with a broken cmap — Devanagari decodes as
 * substitute glyphs ("वत[मान देय रािश" instead of "वर्तमान देय राशि"). The
 * substitution is deterministic, so we de-corrupt the text before matching.
 * Applied only when the marker characters are present — clean text is untouched.
 */
const CORRUPTION_MARKERS = /[ǒǑǔǐȥȣèàƱƭĮĐÈãÜƠÍĤĒĚƮɅÞ×ÉǽÚ]/;

const DECORRUPT: [RegExp, string][] = [
  // ǒĤ = प्रि (प्रिंट दिनांक) — must run before the generic rules.
  [/[ǒǑǔǐ]Ĥ/g, "प्रि"],
  // Prefix chars encoding a hoisted ि-matra: ǒबल→बिल, Ǒकराया→किराया, ǔजèमे→जिस्मे
  [/[ǒǑǔǐ]([\u0900-\u097F])/g, "$1ि"],
  // ि-matra emitted BEFORE its consonant instead of after: रािश→राशि,
  // िनयत→नियत, ितिथ→तिथि. ONLY when ि is not already following a consonant —
  // in correct Unicode ि is stored after its consonant, so an unconditioned
  // swap would corrupt clean text (बिल → बलि).
  // eslint-disable-next-line no-misleading-character-class -- \u094D (halant) in the lookbehind is intentional.
  [/(?<![\u0915-\u0939\u094D\u0966-\u096F])ि([\u0900-\u097F])/g, "$1ि"],
  // [ encodes र् belonging BEFORE the preceding consonant: वत[मान→वर्तमान,
  // सरचाज[→सरचार्ज, अÛतग[त→अंतर्गत.
  [/([\u0900-\u097F])\[/g, "र्$1"],
  [/\[/g, "र्"],
  [/ȥ/g, "ी"],  // ी — पछलȥ→पछली, èवȥ→स्वी
  [/ȣ/g, "ी"],  // ी — जारȣ→जारी, सडȣ→सिडी
  [/Ʌ/g, "ें"], // ें — मɅ→में
  [/è/g, "स्"], // स् — èथाǒपत→स्थापित, èवȥ→स्वी
  [/Û/g, "न्"], // न् — अÛतग[त→अंतर्गत
  [/\[/g, "र्"], // र् — वत[मान→वर्तमान, सरचाज[→सरचार्ज
  [/Ʊ/g, "श्च"], // श्च — पƱात→पश्चात
  [/à/g, "म्"],  // म् — ǒवलàब→विलम्ब
  [/Ý/g, "फ्"],  // फ् — Ýयूल→फ्यूल
  [/ƭ/g, "द्य"], // द्य — ǒवƭुत→विद्युत
  [/É/g, "ख्"],  // ख् — संÉया→संख्या
  [/Į/g, "श्र"], // श्र — Įेणȥ→श्रेणी
  [/Đ/g, "क्र"], // क्र — Đमांक→क्रमांक
  [/È/g, "क्ट्"], // क्ट् — कनेÈटेड→कनेक्टेड
  [/ã/g, "ल्"],  // ल् — शुãक→शुल्क, वोãटेज→वोल्टेज
  [/Ü/g, "प्"],  // प् — सÜलाई→सप्लाई
  [/Ơ/g, "क्त"], // क्त — उपभोƠा→उपभोक्ता
  [/Í/g, "च्छ"], // च्छ — ǒवÍछेद→विच्छेद
  [/×/g, "त्स"], // त्स — Ĥो×साहन→प्रोत्साहन
  [/Ĥ/g, "प्र"], // प्र — Ĥित→प्रति, ǒĤंट→प्रिंट
  [/Ē/g, "ग्र"], // ग्र — Ēामȥण→ग्रामीण
  [/Ě/g, "ट्र"], // ट्र — Ěांसफाम[र→ट्रांसफार्मर
  [/Ʈ/g, "द्व"], // द्व — Ʈारा→द्वारा
  [/Þ/g, "ब्"],  // ब् — सǔÞसडȣ→सब्सिडी
  [/ǽ/g, "रु"],  // रु — rupee abbreviation (रु.)
  [/Ú/g, "ृ"],  // ृ — conjunct marker
];

function decorruptDevanagari(text: string): string {
  if (!CORRUPTION_MARKERS.test(text)) return text;
  let out = text;
  // Repeat until stable — one ि-swap can reveal the next ("ितिथ" → "तिथि"
  // needs two passes). Three passes cover any realistic label.
  for (let pass = 0; pass < 3; pass++) {
    let prev = out;
    for (const [re, rep] of DECORRUPT) out = out.replace(re, rep);
    if (out === prev) break;
    prev = out;
  }
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** "1,23,456.78" / "Rs. 1234.50" / "₹1,234" → 123456.78 */
function parseAmount(s: string): number | null {
  const cleaned = s.replace(/(?:rs\.?|inr|₹)/gi, "").replace(/[,\s]/g, "");
  const m = cleaned.match(/-?\d+(?:\.\d{1,2})?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** dd/mm/yyyy, dd-mm-yy, dd-MMM-yyyy, yyyy-mm-dd → ISO date string. */
function parseDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    const [, d, mo, yRaw] = m;
    const y = yRaw!.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return `${y.toString().padStart(4, "0")}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    }
    return null;
  }
  m = t.match(/(\d{1,2})[\s\-./]*([A-Za-z]{3,9})[\s\-./]*(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    if (!mo) return null;
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(mo).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return t.slice(0, 10);
  return null;
}

function firstLine(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m?.[1]?.trim() || null;
}

function labelAmount(re: RegExp, text: string): number | null {
  const raw = firstLine(re, text);
  return raw ? parseAmount(raw) : null;
}

function labelDate(re: RegExp, text: string): string | null {
  const raw = firstLine(re, text);
  return raw ? parseDate(raw) : null;
}

/**
 * The official JVVNL BILLPRINT layout is Hindi-dominant and two-columned —
 * text extraction often puts the label on one line and the value one or more
 * lines later. These helpers allow a small gap between label and value and
 * are therefore used *in addition to* the same-line patterns.
 */

/** First date token within `window` chars after the label match. */
function dateAfter(re: RegExp, text: string, window = 200): string | null {
  const m = text.match(re);
  if (!m || m.index === undefined) return null;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + window);
  const d = tail.match(/\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}-[A-Za-z]{3}-\d{4}/);
  return d ? parseDate(d[0]) : null;
}

/** First standalone number within `window` chars after the label match. */
function numAfter(re: RegExp, text: string, window = 120, minValue = 0): number | null {
  const m = text.match(re);
  if (!m || m.index === undefined) return null;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + window);
  for (const n of tail.matchAll(/[\d][\d,]*(?:\.\d+)?/g)) {
    const v = parseAmount(n[0]);
    if (v !== null && v >= minValue) return v;
  }
  return null;
}

/** First numeric token with at least `minDigits` digits after the label. */
function digitsAfter(re: RegExp, text: string, window = 160, minDigits = 5): string | null {
  const m = text.match(re);
  if (!m || m.index === undefined) return null;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + window);
  for (const n of tail.matchAll(/\d+/g)) {
    if (n[0].length >= minDigits) return n[0];
  }
  return null;
}

/** Value BEFORE its label — BILLPRINT often emits "1234.00  लेबल" order. */
function numBefore(re: RegExp, text: string, decimalsRequired = false): number | null {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const all = [...text.matchAll(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*[\\n\\s]+${re.source}`, flags))];
  if (all.length === 0) return null;
  const pool = decimalsRequired ? all.filter((m) => m[1]!.includes(".")) : all;
  const pick = (pool.length ? pool : all)[pool.length ? pool.length - 1 : all.length - 1];
  return pick ? parseAmount(pick[1]!) : null;
}

/**
 * The JVVNL totals row: the four labels appear together ("वर्तमान देय राशि",
 * "नियत तिथि तक कुल देय राशि", "विलम्ब भुगतान सरचार्ज", "नियत तिथि पश्चात देय
 * कुल राशि") followed by a row of four numbers in the same order.
 */
function parseJvvnlTotalsRow(text: string): {
  currentDue: number | null;
  payableByDueDate: number | null;
  lateSurcharge: number | null;
  payableAfterDueDate: number | null;
} | null {
  const m = text.match(
    /वर्तमान\s*देय\s*राशि[\s\S]{0,300}?नियत\s*तिथि\s*पश्चात\s*देय\s*कुल\s*राशि[\s\S]{0,160}?((?:[\d,]+(?:\.\d+)?\s+){2,}[\d,]+(?:\.\d+)?)/
  );
  let nums: number[] = m
    ? (m[1]!.match(/[\d,]+(?:\.\d+)?/g) ?? []).map(parseAmount).filter((v): v is number => v !== null)
    : [];
  if (nums.length < 3) {
    // BILLPRINT jam: "3621.403621.0067.913689.00" — four decimals concatenated.
    const jam = text.match(
      /वर्तमान\s*देय\s*राशि[\s\S]{0,400}?(\d+\.\d{2})(\d+\.\d{2})(\d+\.\d{2})(\d+\.\d{2})/
    ) ?? text.match(/(?:^|\s)(\d+\.\d{2})(\d+\.\d{2})(\d+\.\d{2})(\d+\.\d{2})(?:\s|$)/m);
    if (jam) {
      nums = jam.slice(1, 5).map((s) => Number(s));
    }
  }
  if (nums.length < 3) return null;
  return {
    currentDue: nums[0] ?? null,
    payableByDueDate: nums[1] ?? null,
    lateSurcharge: nums[2] ?? null,
    payableAfterDueDate: nums[3] ?? null,
  };
}

/** Parses the के.नं / नाम / पता header block of a JVVNL print bill. */
function parseJvvnlHeader(text: string): {
  consumerNumber: string | null;
  consumerName: string | null;
  serviceAddress: string | null;
} {
  const out = { consumerNumber: null as string | null, consumerName: null as string | null, serviceAddress: null as string | null };
  const kMatch = text.match(/के\.?\s*नं[\s\S]{0,220}?(\d{8,15})/);
  if (!kMatch || kMatch.index === undefined) return out;
  out.consumerNumber = kMatch[1]!;
  // Text after the K-number contains "NAME <address>" then a repeated address line.
  const tail = text.slice(kMatch.index + kMatch[0].length, kMatch.index + kMatch[0].length + 400);
  const lines = tail.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 2);
  let nameIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\d+$/.test(line)) continue;
    if (!out.consumerName && /^[A-Za-z]/.test(line)) {
      // Cut at the first flat/house token (e.g. "B-603") that starts the address.
      const cut = line.split(/\s+(?=[A-Z]-\d|\d+\/\d)/);
      out.consumerName = (cut.length > 1 ? cut[0]! : line).trim();
      nameIdx = i;
    }
  }
  // Address: the line(s) after the name — BILLPRINT repeats the full address
  // (e.g. "B-603 4 TH FLOOR SOUTH AND HOMES JAIPUR"); prefer the longest
  // candidate containing a flat/house pattern.
  const addrCand = lines
    .slice(nameIdx + 1)
    .filter((l) => /[A-Za-z]-?\d/.test(l) && l.length > 15 && !/[अ-ह]/.test(l));
  if (addrCand.length > 0) {
    out.serviceAddress = addrCand.sort((a, b) => b.length - a.length)[0]!.slice(0, 160);
  }
  return out;
}

export const jvvnlBillExtractor = {
  extract(rawText: string): ExtractionResult {
    const text = decorruptDevanagari(
      rawText
        .replace(/[₹]/g, " Rs. ")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
    );
    const warnings: string[] = [];
    const confidence = {} as Record<ExtractedFieldKey, number>;
    const fields = {} as ExtractedBillFields;

    const set = <K extends ExtractedFieldKey>(
      key: K,
      value: ExtractedBillFields[K],
      conf: number
    ) => {
      fields[key] = value;
      confidence[key] = value === null || value === undefined ? 0 : conf;
    };

    // ---------------- Provider / document type ----------------
    const isJvvnl =
      /JVVNL|Jaipur\s+Vidyut\s+Vitran\s+Nigam|जयपुर\s*विद्युत\s*वितरण\s*निगम|विद्युत\s*उपभोग\s*विपत्र/i.test(text);
    const otherProvider = firstLine(
      /(JdVVNL|AVVNL|TPDDL|BSES|Tata\s*Power|Adani|Torrent|MSEB|MSEDCL|KSEB|TNEB|MPEB|DHBVN|PSPCL|BESCOM|CESC|UPPCL)/i,
      text
    );
    if (isJvvnl) {
      set("utilityProvider", "JVVNL", 0.95);
      set("documentType", "electricity_bill", 0.9);
    } else if (otherProvider) {
      set("utilityProvider", otherProvider.toUpperCase(), 0.6);
      set("documentType", "electricity_bill", 0.6);
      warnings.push(
        `Detected provider "${otherProvider.toUpperCase()}", not JVVNL — review the extracted fields carefully.`
      );
    } else if (/electricity|vidyut|kwh|meter/i.test(text)) {
      set("utilityProvider", null, 0);
      set("documentType", "electricity_bill", 0.5);
      warnings.push("Could not identify the utility provider — verify this is a JVVNL electricity bill.");
    } else {
      set("utilityProvider", null, 0);
      set("documentType", "unknown", 0.2);
      warnings.push("This document does not look like an electricity bill.");
    }

    // ---------------- Identification ----------------
    const header = parseJvvnlHeader(text);
    set(
      "consumerNumber",
      header.consumerNumber ??
        firstLine(
          /(?:K\.?\s*No\.?|Consumer\s*(?:No|Number|A\/C|Account)\.?|Account\s*No\.?|A\/C\s*No\.?)[.:\s\-]*([0-9]{6,15})/i,
          text
        )?.toUpperCase() ?? null,
      0.9
    );
    if (!fields.consumerNumber) {
      warnings.push("Consumer/K-number could not be extracted — enter it manually for previous-bill matching.");
    }

    set(
      "billNumber",
      firstLine(/बिल\s*नं[:：.]?\s*([A-Z0-9]{5,15})/, text) ??
        // BILLPRINT: the number appears a few lines BEFORE "बिल नं:" — take
        // the last long digit-run in the 80 chars preceding the label so the
        // nearby खाता संख्या can't win.
        (() => {
          const m = text.match(/बिल\s*नं[:：]/);
          if (!m || m.index === undefined) return null;
          const runs = [...text.slice(Math.max(0, m.index - 80), m.index).matchAll(/\d{6,15}/g)];
          return runs.length ? runs[runs.length - 1]![0] : null;
        })() ??
        firstLine(/Bill\s*(?:No|Number|Ref(?:erence)?\.?)\.?\s*[.:\-]?\s*([A-Z0-9\-\/]{4,20})/i, text),
      0.85
    );
    set(
      "consumerName",
      header.consumerName ??
        firstLine(/(?:Consumer|Customer)\s*Name\s*[.:\-]?\s*(.{3,80})/i, text) ??
        firstLine(/Name\s*(?:of\s*(?:the\s*)?Consumer)?\s*[.:\-]\s*(.{3,80})/i, text) ??
        firstLine(/नाम\.?\s*[:\-]?\s*(.{3,80})/, text),
      0.75
    );
    set(
      "serviceAddress",
      header.serviceAddress ??
        firstLine(/(?:Service|Site|Consumer|Installation)\s*Address\s*[.:\-]?\s*(.{8,160})/i, text) ??
        firstLine(/Address\s*[.:\-]\s*(.{8,160})/i, text),
      0.6
    );
    set(
      "meterNumber",
      firstLine(/वर्तमान\s*स्थापित\s*मीटर\s*नं[:：.]?\s*([A-Z0-9]{4,20})/, text) ??
        digitsAfter(/वर्तमान\s*स्थापित\s*मीटर\s*नं/, text, 160, 5) ??
        firstLine(/Meter\s*(?:No|Number|#)\.?\s*[.:\-]?\s*([A-Z0-9\-\/]{4,20})/i, text) ??
        firstLine(/मीटर\s*नं[:：.]?\s*([A-Z0-9]{4,20})/, text),
      0.8
    );

    // ---------------- Dates ----------------
    set(
      "issueDate",
      dateAfter(/बिल\s*जारी\s*(?:करने\s*)?(?:की\s*)?तिथि/, text, 80) ??
        labelDate(/(?:Bill|Issue|Generation)\s*Date\s*[.:\-]?\s*(\S+(?:\s+\S+){0,2})/i, text) ??
        dateAfter(/प्रिंट\s*दिनांक/, text, 80),
      0.85
    );
    set(
      "dueDate",
      // Tight window first — on BILLPRINT the due date sits far from its
      // label and a wide window catches reading dates instead.
      dateAfter(/नियत\s*भुगतान\s*तिथि/, text, 80) ??
        // "Last Payment Due Date" is the previous cycle — never the due date.
        labelDate(/(?<!Last\s)(?<!Payment\s)Due\s*Date\s*[.:\-]?\s*(\S+(?:\s+\S+){0,2})/i, text) ??
        labelDate(/Payable\s*(?:up\s*to|by|till)\s*[.:\-]?\s*(\S+(?:\s+\S+){0,2})/i, text),
      0.85
    );
    // Fallback: on JVVNL bills the due date is the earliest date AFTER the
    // issue date (~10 days later; print/reading dates are within ~2 days).
    if (!fields.dueDate && fields.issueDate) {
      const minDue = new Date(new Date(fields.issueDate).getTime() + 5 * 86400000)
        .toISOString()
        .slice(0, 10);
      const allDates = [...text.matchAll(/\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}|\d{1,2}-[A-Za-z]{3}-\d{4}/g)]
        .map((m) => parseDate(m[0]))
        .filter((d): d is string => d !== null && d >= minDue)
        .sort();
      if (allDates.length > 0) {
        set("dueDate", allDates[0]!, 0.5);
        warnings.push("Due date inferred from the document dates — verify it against the bill.");
      }
    }
    set(
      "previousReadingDate",
      dateAfter(/गत\s*पठन\s*तिथि/, text, 200) ??
        labelDate(/Prev(?:ious)?\.?\s*(?:Reading|Rdgs?)\s*Date\s*[.:\-]?\s*(\S+(?:\s+\S+){0,2})/i, text),
      0.7
    );
    set(
      "currentReadingDate",
      dateAfter(/वर्तमान\s*पठन\s*तिथि/, text, 200) ??
        labelDate(/Curr(?:ent)?\.?\s*(?:Reading|Rdgs?)\s*Date\s*[.:\-]?\s*(\S+(?:\s+\S+){0,2})/i, text) ??
        labelDate(/(?:Reading|Rdgs?)\s*Date\s*[.:\-]?\s*(\S+(?:\s+\S+){0,2})/i, text),
      0.7
    );

    // ---------------- Billing month / year ----------------
    const monthWord = firstLine(
      /(?:Bill(?:ing)?\s*Month|Month\s*of\s*Bill|Billing\s*Period)\s*[.:\-]?\s*([A-Za-z]{3,12})/i,
      text
    );
    let bMonth: number | null = monthWord ? MONTHS[monthWord.toLowerCase()] ?? null : null;
    const numericPeriod = text.match(
      /(?:Bill(?:ing)?\s*Month|Billing\s*Period)\s*[.:\-]?\s*(\d{1,2})[\/\-.](\d{4})/i
    );
    let bYear: number | null = null;
    // JVVNL print format: बिल माह as YYYYMM (e.g. 202606 = June 2026) — the
    // value may come before OR after the label depending on extraction order.
    const hindiPeriod =
      text.match(/बिल\s*माह\s*[:\-]?\s*(\d{4})(\d{2})/) ??
      text.match(/(\d{4})(\d{2})\s*\n?\s*बिल\s*माह/);
    if (hindiPeriod && Number(hindiPeriod[2]) >= 1 && Number(hindiPeriod[2]) <= 12) {
      bYear = Number(hindiPeriod[1]);
      bMonth = Number(hindiPeriod[2]);
    } else if (numericPeriod) {
      bMonth = Number(numericPeriod[1]);
      bYear = Number(numericPeriod[2]);
    } else if (bMonth) {
      const yearNear = text.match(/(?:Bill(?:ing)?\s*Month|Billing\s*Period)[^\d\n]{0,40}?((?:19|20)\d{2})/i);
      bYear = yearNear ? Number(yearNear[1]) : null;
    }
    if (!bMonth && fields.issueDate) {
      bMonth = Number(fields.issueDate.slice(5, 7));
      bYear = Number(fields.issueDate.slice(0, 4));
      set("billingMonth", bMonth, 0.6);
      set("billingYear", bYear, 0.6);
    } else {
      set("billingMonth", bMonth, 0.8);
      set("billingYear", bYear, 0.8);
    }

    // ---------------- Amounts ----------------
    // JVVNL totals row — four positional amounts after the grouped labels.
    const totalsRow = parseJvvnlTotalsRow(text);

    set(
      "previousBillAmount",
      numAfter(/Last\s*Bill\s*Amount/i, text, 80) ??
        labelAmount(/Prev(?:ious)?\.?\s*Bill\s*(?:Amount)?\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text),
      0.7
    );
    set(
      "previousOutstanding",
      numAfter(/पिछली\s*बकाया\s*राशि/, text, 100) ??
        numAfter(/पिछले\s*बिल\s*तक\s*बकाया\s*राशि/, text, 120) ??
        labelAmount(/(?:Prev(?:ious)?\.?\s*)?(?:Outstanding|Arrears?|Balance\s*B\/F|Old\s*Balance)\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text),
      0.7
    );
    set(
      "paymentsReceived",
      // "Last Payment <amount>" — the guard requires a digit right after the
      // label so "Last Payment Due Date"/"Last Payment Date" can't match.
      labelAmount(/Last\s*Payment\s*[:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text) ??
        labelAmount(/(?:Payments?|Amount)\s*Received\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text) ??
        labelAmount(/(?:Payments?|Adjustment)\s*(?:Credits?)?\s*[.:\-]?\s*\(?((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)\)?/i, text),
      0.65
    );
    set(
      "energyCharges",
      labelAmount(/(?:Energy|Elec(?:tricity)?)\s*Charges?\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text),
      0.8
    );
    set(
      "fixedCharges",
      labelAmount(/Fixed\s*Charges?\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text),
      0.8
    );
    set(
      "surcharges",
      labelAmount(/(?:Fuel|FPPAS|FPPCA|Power\s*Purchase)\s*(?:Surcharge|Charge|Adjustment)?\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text),
      0.75
    );
    set(
      "taxesDuties",
      labelAmount(/(?:Electricity\s*Duty|Elec\.?\s*Duty|\bE\.?\s*D\.?\b|Tax(?:es)?(?:\s*&\s*Dut(?:y|ies))?|Urban\s*Cess|Water\s*Conservation\s*Cess)\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text),
      0.75
    );
    set(
      "lateFees",
      totalsRow?.lateSurcharge ??
        labelAmount(/(?:Late\s*Payment|DPS|Delayed\s*Payment)\s*(?:Surcharge|Charges?|Fee)?\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text) ??
        numAfter(/विलम्ब\s*भुगतान\s*सरचार्ज/, text, 160),
      0.7
    );
    set(
      "currentAmount",
      totalsRow?.currentDue ??
        labelAmount(/Curr(?:ent)?\.?\s*(?:Bill|Period|Month)\s*(?:Amount|Charges?)\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text) ??
        labelAmount(/(?:Current\s*Consumption\s*Charges?|Net\s*Current\s*Charges?)\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text) ??
        numAfter(/निगम\s*राशि\s*\(क्रम\s*सं[^)]*\)/, text, 200),
      0.8
    );
    set(
      "totalAmountPayable",
      totalsRow?.payableByDueDate ??
        labelAmount(/(?:Net\s*(?:Amount\s*)?Payable|Total\s*(?:Amount\s*)?Payable|Net\s*Payable\s*Amount|Amount\s*Payable|Total\s*Amount\s*Due|Net\s*Bill\s*Amount)\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text) ??
        numAfter(/नियत\s*तिथि\s*तक\s*कुल\s*देय\s*राशि/, text, 160) ??
        numAfter(/कुल\s*देय\s*राशि\s*\(क्रम\s*सं[^)]*\)/, text, 200),
      0.9
    );
    set(
      "totalOutstanding",
      totalsRow?.payableAfterDueDate ??
        labelAmount(/Total\s*Outstanding\s*[.:\-]?\s*((?:Rs\.?|INR|₹)?\s*-?[\d,]+(?:\.\d{1,2})?)/i, text),
      0.7
    );

    // Derive current-period charges from components when not labeled.
    if (fields.currentAmount === null) {
      const parts = [fields.energyCharges, fields.fixedCharges, fields.surcharges, fields.taxesDuties].filter(
        (v): v is number => v !== null
      );
      if (parts.length >= 2) {
        const sum = parts.reduce((a, b) => a + b, 0);
        set("currentAmount", Number(sum.toFixed(2)), 0.5);
        warnings.push("Current-period charges were derived from the charge breakdown — verify the total.");
      }
    }
    if (fields.totalAmountPayable === null) {
      warnings.push("Total payable amount could not be extracted — enter the bill amount manually.");
    }
    if (fields.previousBillAmount === null) {
      warnings.push("Last bill amount could not be extracted — enter it manually if needed.");
    }

    // ---------------- Consumption ----------------
    // In BILLPRINT text the reading VALUES typically precede their labels.
    set(
      "previousReading",
      labelAmount(/([\d]{3,}(?:\.\d+)?)\s*गत\s*पठन\s*\(KWH\)/i, text) ??
        labelAmount(/Prev(?:ious)?\.?\s*(?:Meter\s*)?(?:Reading|Rdgs?)\s*[.:\-]?\s*([\d,\.]+)/i, text) ??
        labelAmount(/गत\s*पठन\s*\(KWH\)\s*[:\-]?\s*([\d,\.]+)/i, text),
      0.75
    );
    set(
      "currentReading",
      // Prefer decimal-formatted readings (JVVNL prints "8900.0000") and take
      // the LAST value-before-label match — earlier "वर्तमान पठन" labels can be
      // preceded by the meter number instead of a reading.
      numBefore(/वर्तमान\s*पठन/i, text, true) ??
        labelAmount(/Curr(?:ent)?\.?\s*(?:Meter\s*)?(?:Reading|Rdgs?)\s*[.:\-]?\s*([\d,\.]+)/i, text) ??
        numBefore(/वर्तमान\s*पठन/i, text) ??
        labelAmount(/वर्तमान\s*पठन\s*\(KWH\)\s*[:\-]?\s*([\d,\.]+)/i, text),
      0.75
    );
    set(
      "unitsKwh",
      labelAmount(/उपभोग\s*[:\-]?\s*([\d,]+(?:\.\d+)?)/i, text) ??
        labelAmount(/(?:Units?\s*Consumed|Consumption|Billed\s*Units?|Total\s*Units?)\s*[.:\-]?\s*([\d,\.]+)\s*(?:kWh|KWH|Units?)?/i, text) ??
        labelAmount(/([\d,\.]+)\s*(?:kWh|KWH)\b/i, text),
      0.8
    );
    if (
      fields.unitsKwh === null &&
      fields.currentReading !== null &&
      fields.previousReading !== null &&
      fields.currentReading >= fields.previousReading
    ) {
      set("unitsKwh", Number((fields.currentReading - fields.previousReading).toFixed(2)), 0.55);
      warnings.push("Units consumed derived from meter readings — verify against the bill.");
    }
    if (fields.unitsKwh === null) {
      warnings.push("Units consumed (kWh) could not be extracted — enter it manually.");
    }
    set(
      "sanctionedLoadKw",
      // Require a KW/कि.वा unit marker — "टैरिफ कोड 1000XA" must not match.
      labelAmount(/स्वी\.?\s*लोड[\s\S]{0,140}?([\d,]+(?:\.\d+)?)\s*\(?(?:KW|KVA|कि\.वा)/i, text) ??
        labelAmount(/(?:Sanctioned|Contract)\s*(?:Load|Demand|Connected\s*Load)\s*[.:\-]?\s*([\d,\.]+)\s*(?:KW|KVA|kW)?/i, text),
      0.75
    );
    set(
      "tariffCategory",
      // BILLPRINT: "DS\nस्वी. श्रेणी" — the value precedes the label.
      firstLine(/\b([A-Z]{1,4})\s*\n\s*स्वी\.?\s*श्रेणी/, text) ??
        firstLine(/स्वी\.?\s*श्रेणी\s*[:\-]?\s*([A-Z][A-Z0-9\/\-]{0,11})/i, text) ??
        firstLine(/टैरिफ\s*कोड\s*[:\-]?\s*([A-Z0-9\-\/]{3,15})/, text) ??
        firstLine(/Tariff\s*(?:Category|Code|Sub\s*Cat(?:egory)?\.?)\s*[.:\-]?\s*([A-Z0-9\-\/ ]{2,30})/i, text) ??
        firstLine(/Category\s*[.:\-]\s*([A-Z]{2,5}(?:\s*\/\s*[A-Z0-9]+)?)/i, text),
      0.65
    );

    // ---------------- Cross-field sanity ----------------
    // payable ≈ current charges + carried arrears. (PaymentsReceived applies
    // against the PREVIOUS bill, so it is deliberately not subtracted here.)
    if (
      fields.totalAmountPayable !== null &&
      fields.currentAmount !== null &&
      fields.previousOutstanding !== null
    ) {
      const expected = fields.currentAmount + fields.previousOutstanding;
      if (Math.abs(expected - fields.totalAmountPayable) > Math.max(5, fields.totalAmountPayable * 0.05)) {
        warnings.push(
          "Extracted amounts look inconsistent (current charges + arrears ≠ total payable). Review each amount carefully."
        );
      }
    }
    if (fields.totalAmountPayable === null && fields.currentAmount !== null) {
      set("totalAmountPayable", fields.currentAmount, 0.5);
      warnings.push("Total payable assumed equal to current charges — confirm no arrears apply.");
    }

    return { fields, confidence, warnings };
  },
};
