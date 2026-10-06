import { describe, expect, it } from "vitest";
import { GS, gtinLookupForms, isValidGtin, parseGs1 } from "./gs1.ts";

const GTIN = "09506000134352"; // GS1 genel şartname örnek GTIN-14 (kontrol hanesi 2)

describe("isValidGtin", () => {
  it("GTIN-8/12/13/14 sabit vektörleri", () => {
    expect(isValidGtin("96385074")).toBe(true); // GTIN-8
    expect(isValidGtin("036000291452")).toBe(true); // GTIN-12
    expect(isValidGtin("4006381333931")).toBe(true); // GTIN-13
    expect(isValidGtin(GTIN)).toBe(true);
  });
  it("bozuk kontrol hanesi, uzunluk ve karakter reddi", () => {
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("09506000134353")).toBe(false);
    expect(isValidGtin("123456789")).toBe(false);
    expect(isValidGtin("400638133393X")).toBe(false);
  });
});

describe("parseGs1", () => {
  it("(01)(17)(10) önekli ve değişken uzunluk lot sonda", () => {
    const r = parseGs1(`]C101${GTIN}1726123110LOT-42`);
    expect(r).toMatchObject({ ok: true, gtin: GTIN, lot: "LOT-42", expiryRaw: "261231", expiryDate: "2026-12-31" });
  });
  it("FNC1 ile değişken uzunluk lot sonra gelen AI'dan ayrılır", () => {
    const r = parseGs1(`01${GTIN}10AB12${GS}2198765${GS}3001500`);
    expect(r).toMatchObject({ ok: true, gtin: GTIN, lot: "AB12", serial: "98765", quantity: "1500" });
  });
  it("]d2 öneki ve (37) adet; baştaki sıfırlar atılır", () => {
    const r = parseGs1(`]d201${GTIN}3700000012`);
    expect(r).toMatchObject({ ok: true, quantity: "12" });
  });
  it("(30) varsa (37)'ye önceliklidir", () => {
    const r = parseGs1(`01${GTIN}3700000005${GS}3006`);
    expect(r).toMatchObject({ ok: true, quantity: "6" });
  });
  it("FNC1'siz değişken AI sonrası AI bu dizgide lota yutulur (ayraç şart)", () => {
    const r = parseGs1(`01${GTIN}10AB1221987`);
    expect(r).toMatchObject({ ok: true, lot: "AB1221987" });
  });
  it("SKT günü 00 → ayın son günü; geçersiz ay/gün reddi", () => {
    expect(parseGs1(`01${GTIN}17240200`)).toMatchObject({ ok: true, expiryDate: "2024-02-29" });
    expect(parseGs1(`01${GTIN}17250200`)).toMatchObject({ ok: true, expiryDate: "2025-02-28" });
    expect(parseGs1(`01${GTIN}17261301`)).toEqual({ ok: false, reason: "INVALID_DATE" });
    expect(parseGs1(`01${GTIN}17250230`)).toEqual({ ok: false, reason: "INVALID_DATE" });
  });
  it("bozuk GTIN kontrol hanesi", () => {
    expect(parseGs1("0109506000134353")).toEqual({ ok: false, reason: "INVALID_GTIN_CHECK_DIGIT" });
  });
  it("tanınmayan AI: yapı korunur, hata değil", () => {
    const r = parseGs1(`01${GTIN}9912345${GS}10LOT1`);
    expect(r).toMatchObject({ ok: true, gtin: GTIN, lot: "LOT1" });
    if (r.ok) expect(r.elements.some((e) => e.kind === "unknown" && e.raw === "9912345")).toBe(true);
  });
  it("sabit uzunluk eksik, aşırı uzun lot, yinelenen AI, geçersiz karakter", () => {
    expect(parseGs1("01095060001343")).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseGs1(`01${GTIN}10${"A".repeat(21)}`)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseGs1(`01${GTIN}10A${GS}10B`)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseGs1(`01${GTIN}10A B`)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseGs1(`01${GTIN}30ABC`)).toEqual({ ok: false, reason: "MALFORMED" });
  });
  it("GS1 olmayan girdiler", () => {
    expect(parseGs1("")).toEqual({ ok: false, reason: "EMPTY" });
    expect(parseGs1("]Q3abc")).toEqual({ ok: false, reason: "NOT_GS1" });
    expect(parseGs1("ABC-123")).toEqual({ ok: false, reason: "NOT_GS1" });
  });
});

describe("gtinLookupForms", () => {
  it("baştaki sıfır dolgusundan kısa biçimler türetir", () => {
    expect(gtinLookupForms("04006381333931")).toEqual(["04006381333931", "4006381333931"]);
    expect(gtinLookupForms("00036000291452")).toEqual(["00036000291452", "0036000291452", "036000291452"]);
    expect(gtinLookupForms(GTIN)).toEqual([GTIN, "9506000134352"]);
    // GTIN-8 biçimi yalnızca sembol tanımlayıcı önekiyle (allowGtin8)
    expect(gtinLookupForms("00000096385074")).toEqual(["00000096385074", "0000096385074", "000096385074"]);
    expect(gtinLookupForms("00000096385074", true)).toEqual(["00000096385074", "0000096385074", "000096385074", "96385074"]);
    expect(gtinLookupForms("19506000134359")).toEqual(["19506000134359"]);
  });
  it("sembol/FNC1 sinyali raporlanır", () => {
    expect(parseGs1(`]C101${GTIN}`)).toMatchObject({ ok: true, symbologyPrefix: true, hasFnc1: false });
    expect(parseGs1(`01${GTIN}10A${GS}21B`)).toMatchObject({ ok: true, symbologyPrefix: false, hasFnc1: true });
    expect(parseGs1(`01${GTIN}`)).toMatchObject({ ok: true, symbologyPrefix: false, hasFnc1: false });
  });
});

describe("parseGs1 sert girdi sınırları", () => {
  it("256 karakteri aşan girdi MALFORMED", () => {
    expect(parseGs1(`01${GTIN}10${"A".repeat(300)}`)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseGs1("1".repeat(257))).toEqual({ ok: false, reason: "MALFORMED" });
  });
  it("kontrol karakteri (GS hariç), boşluk ve Unicode MALFORMED; tanınmayan segmentte de", () => {
    for (const bad of [`01${GTIN}10A\u0000B`, `01${GTIN}10A\tB`, `01${GTIN}10A\nB`, `01${GTIN}10AİB`, `01${GTIN}10A\u00e9`, `01${GTIN}99X\u200bY`, `01${GTIN}\u007f`, ` 01${GTIN}`]) {
      expect(parseGs1(bad)).toEqual({ ok: false, reason: "MALFORMED" });
    }
  });
  it("(30)/(37) sıfır adet INVALID_QUANTITY", () => {
    expect(parseGs1(`01${GTIN}3000000`)).toEqual({ ok: false, reason: "INVALID_QUANTITY" });
    expect(parseGs1(`01${GTIN}3700000000`)).toEqual({ ok: false, reason: "INVALID_QUANTITY" });
    expect(parseGs1(`01${GTIN}3000001`)).toMatchObject({ ok: true, quantity: "1" });
  });
});
