import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { addDecimal, assertConversionFactor, assertPositive, assertQuantityScale, compareDecimal, mulDecimal, subDecimal, toBase } from "./quantity.ts";

const detailOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return `${(e as AppError).code}/${(e as AppError).detail ?? ""}`;
  }
  return undefined;
};

describe("decimal aritmetik (yuvarlama yok)", () => {
  it("0.1 + 0.2 tam 0.3 (float hatası yok)", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(subDecimal("0.3", "0.1")).toBe("0.2");
  });
  it("çarpım tam; sondaki sıfırlar kanonikleşir", () => {
    expect(mulDecimal("1.5", "2.0")).toBe("3");
    expect(mulDecimal("0.000001", "0.000001")).toBe("0.000000000001");
    expect(mulDecimal("-2.5", "4")).toBe("-10");
  });
  it("büyük değerler Number hassasiyetini aşar", () => {
    expect(addDecimal("99999999999999999999.999999", "0.000001")).toBe("100000000000000000000");
    expect(mulDecimal("12345678901234", "12345678901234")).toBe("152415787532374345526722756");
  });
  it("karşılaştırma", () => {
    expect(compareDecimal("1.10", "1.1")).toBe(0);
    expect(compareDecimal("-1", "0")).toBe(-1);
    expect(compareDecimal("10", "9.999999")).toBe(1);
  });
});

describe("assertQuantityScale", () => {
  it("ölçeği aşan miktar QUANTITY_SCALE; eşit ya da sıfır sonlu uygun", () => {
    expect(assertQuantityScale("5", 0, "any")).toBe("5");
    expect(assertQuantityScale("5.00", 0, "any")).toBe("5");
    expect(assertQuantityScale("2.125", 3, "any")).toBe("2.125");
    expect(detailOf(() => assertQuantityScale("2.5", 0, "any"))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(detailOf(() => assertQuantityScale("0.0001", 3, "any"))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
  });
  it("biçim hatası ve geçersiz ölçek VALIDATION_FAILED", () => {
    for (const bad of ["", "abc", "1e3", "1,5", " 1", "1.", ".5", "1".repeat(41)]) {
      expect(detailOf(() => assertQuantityScale(bad, 3, "any"))).toBe("VALIDATION_FAILED/");
    }
    expect(detailOf(() => assertQuantityScale("1", 7, "any"))).toBe("VALIDATION_FAILED/");
  });
});

describe("assertConversionFactor", () => {
  it("> 0 ve ≤ 6 ondalık", () => {
    expect(assertConversionFactor("12")).toBe("12");
    expect(assertConversionFactor("0.000001")).toBe("0.000001");
    expect(assertConversionFactor("1.2500000")).toBe("1.25");
  });
  it("sıfır, negatif, 7 ondalık, biçim, 15 tam hane reddi", () => {
    for (const bad of ["0", "0.0", "-1", "0.0000001", "x", "", "123456789012345"]) {
      expect(detailOf(() => assertConversionFactor(bad))).toBe("VALIDATION_FAILED/UNIT_CONVERSION_INVALID");
    }
  });
});

describe("toBase", () => {
  it("koli → adet", () => {
    expect(toBase("3", "12", 0)).toBe("36");
    expect(toBase("0.5", "12", 0)).toBe("6");
  });
  it("sonuç ölçeği aşarsa yuvarlanmaz, reddedilir", () => {
    expect(detailOf(() => toBase("0.5", "5", 0))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(toBase("0.5", "5", 1)).toBe("2.5");
    expect(toBase("1", "0.333333", 6)).toBe("0.333333");
    expect(detailOf(() => toBase("1.5", "0.333333", 6))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
  });
  it("büyük değer: 14 tam hane sınırı; aşım VALIDATION_FAILED (INTERNAL değil)", () => {
    expect(toBase("99999999999999", "1", 0)).toBe("99999999999999");
    expect(detailOf(() => toBase("99999999999999", "2", 0))).toBe("VALIDATION_FAILED/");
    expect(detailOf(() => toBase("99999999999999", "999999.999999", 6))).toBe("VALIDATION_FAILED/");
    expect(toBase("9999999.5", "1000000", 1)).toBe("9999999500000");
  });
});

describe("işaret ve taşma denetimi", () => {
  it("assertPositive: sıfır ve negatif reddi; 14 tam hane sınırı", () => {
    expect(assertPositive("0.5")).toBe("0.5");
    expect(assertPositive("99999999999999.999999")).toBe("99999999999999.999999");
    for (const bad of ["0", "0.000", "-1", "-0.1", "100000000000000", "abc"]) {
      expect(detailOf(() => assertPositive(bad))).toBe("VALIDATION_FAILED/");
    }
  });
  it("assertQuantityScale işaret seçenekleri; negatif varsayılan 'any' ile geçer", () => {
    expect(assertQuantityScale("-2", 0, "any")).toBe("-2");
    expect(detailOf(() => assertQuantityScale("-2", 0, "nonNegative"))).toBe("VALIDATION_FAILED/");
    expect(assertQuantityScale("0", 0, "nonNegative")).toBe("0");
    expect(detailOf(() => assertQuantityScale("0", 0, "positive"))).toBe("VALIDATION_FAILED/");
    expect(detailOf(() => assertQuantityScale("-100000000000000", 0, "any"))).toBe("VALIDATION_FAILED/");
  });
  it("toBase negatif miktarı varsayılan reddeder; allowNegative ile işaret korunur ve ölçek yine denetlenir", () => {
    expect(detailOf(() => toBase("-3", "12", 0))).toBe("VALIDATION_FAILED/");
    expect(toBase("-3", "12", 0, { allowNegative: true })).toBe("-36");
    expect(detailOf(() => toBase("-0.5", "5", 0, { allowNegative: true }))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(toBase("0", "12", 0)).toBe("0");
  });
});
