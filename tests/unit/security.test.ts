import "../helpers/env";
import { describe, expect, it } from "vitest";
import { assertFileSignature } from "../../src/services/bill.service";
import { signLocalFileKey, verifyLocalFileSignature } from "../../src/config/storage";

describe("file signature validation", () => {
  it("accepts real PDF/JPEG/PNG magic bytes", () => {
    expect(() => assertFileSignature(Buffer.from("%PDF-1.7 ..."), "application/pdf")).not.toThrow();
    expect(() =>
      assertFileSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg")
    ).not.toThrow();
    expect(() =>
      assertFileSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), "image/png")
    ).not.toThrow();
  });

  it("rejects mismatched content vs declared mime", () => {
    const fake = Buffer.from("MZ fake executable");
    expect(() => assertFileSignature(fake, "application/pdf")).toThrowError(/do not match/);
  });

  it("rejects disallowed mime types", () => {
    expect(() => assertFileSignature(Buffer.from("%PDF-1.4"), "application/exe")).toThrowError(
      /Unsupported file type/
    );
  });
});

describe("local signed file URLs", () => {
  const key = "bills/d1/b1.pdf";

  it("verifies a valid signature", () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const sig = signLocalFileKey(key, exp);
    expect(verifyLocalFileSignature(key, exp, sig)).toBe(true);
  });

  it("rejects tampered signatures and other keys", () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const sig = signLocalFileKey(key, exp);
    expect(verifyLocalFileSignature(key, exp, "deadbeef")).toBe(false);
    expect(verifyLocalFileSignature("bills/d1/OTHER.pdf", exp, sig)).toBe(false);
  });

  it("rejects expired URLs", () => {
    const exp = Math.floor(Date.now() / 1000) - 10;
    const sig = signLocalFileKey(key, exp);
    expect(verifyLocalFileSignature(key, exp, sig)).toBe(false);
  });
});
