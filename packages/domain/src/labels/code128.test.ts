import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { CODE_B, CODE_C, encodeCode128, LabelCharsetError, START_B, START_C, STOP, symbolWidths, toModuleString } from "./code128.ts";

/** Bağımsız kontrol karakteri hesabı (test içinde, kodlayıcıdan ayrı): (başlangıç + Σ değer·konum) mod 103. */
function checksumOf(valuesWithoutCheck: readonly number[]): number {
  let s = valuesWithoutCheck[0] as number;
  for (let i = 1; i < valuesWithoutCheck.length; i++) s += (valuesWithoutCheck[i] as number) * i;
  return s % 103;
}

describe("Code 128 tablo bütünlüğü", () => {
  it("her sembol 11 modül (bitiş 13), çubuk toplamı çift, desenler benzersiz", () => {
    const seen = new Set<string>();
    for (let v = 0; v <= 106; v++) {
      const w = symbolWidths(v);
      const total = w.reduce((a, b) => a + b, 0);
      expect(total).toBe(v === 106 ? 13 : 11);
      expect(w.length).toBe(v === 106 ? 7 : 6);
      const bars = w.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
      if (v !== 106) expect(bars % 2).toBe(0); // ISO/IEC 15417: çubuk modül toplamı çift (hata yakalama özelliği)
      for (const x of w) expect(x).toBeGreaterThanOrEqual(1);
      for (const x of w) expect(x).toBeLessThanOrEqual(4);
      seen.add(w.join(""));
    }
    expect(seen.size).toBe(107);
  });
  it("bilinen bit desenleri (başlangıç B/C, boşluk, 'A', bitiş)", () => {
    const bits = (v: number): string => toModuleString({ values: [], checksum: 0, modules: 0, widths: symbolWidths(v) });
    expect(bits(START_B)).toBe("11010010000");
    expect(bits(START_C)).toBe("11010011100");
    expect(bits(0)).toBe("11011001100"); // boşluk
    expect(bits(33)).toBe("10100011000"); // 'A' (B kümesi)
    expect(bits(STOP)).toBe("1100011101011");
  });
  it("geçersiz sembol değeri RangeError", () => {
    expect(() => symbolWidths(107)).toThrow(RangeError);
    expect(() => symbolWidths(-1)).toThrow(RangeError);
  });
});

describe("encodeCode128 altın vektörler", () => {
  it("B kümesi: 'PJJ123C' kontrol karakteri (Wikipedia örneği A başlangıçla 54; B başlangıçla 55)", () => {
    const r = encodeCode128("PJJ123C");
    // P=48 J=42 J=42 '1'=17 '2'=18 '3'=19 C=35
    expect(r.values).toEqual([START_B, 48, 42, 42, 17, 18, 19, 35, 55, STOP]);
    expect(r.checksum).toBe(55);
    // Aynı veri A başlangıcıyla (103) bilinen değer 54 olurdu: formül doğrulaması.
    expect(checksumOf([103, 48, 42, 42, 17, 18, 19, 35])).toBe(54);
  });
  it("C kümesi: '1234' → Start C, 12, 34, kontrol 82", () => {
    const r = encodeCode128("1234");
    expect(r.values).toEqual([START_C, 12, 34, 82, STOP]);
  });
  it("tek sayıda rakam: '12345' → Start B '1', Code C, 23, 45", () => {
    const r = encodeCode128("12345");
    expect(r.values.slice(0, 5)).toEqual([START_B, 17, CODE_C, 23, 45]);
    expect(r.checksum).toBe(checksumOf(r.values.slice(0, 5)));
  });
  it("B→C geçişi: 'AB1234' → B,'A','B',Code C,12,34, kontrol 102", () => {
    const r = encodeCode128("AB1234");
    expect(r.values).toEqual([START_B, 33, 34, CODE_C, 12, 34, 102, STOP]);
  });
  it("C→B geçişi ve ortada kısa rakam dizisi B'de kalır", () => {
    const r = encodeCode128("123456AB");
    expect(r.values.slice(0, 7)).toEqual([START_C, 12, 34, 56, CODE_B, 33, 34]);
    const mid = encodeCode128("A12345B"); // ortada 5 rakam < 6: C'ye geçilmez
    expect(mid.values).not.toContain(CODE_C);
    const mid6 = encodeCode128("A123456B"); // ortada 6 rakam: C'ye geçilir
    expect(mid6.values).toContain(CODE_C);
  });
  it("tam 2 rakam C, 3 rakam B + C değil (3 < 4)", () => {
    expect(encodeCode128("12").values[0]).toBe(START_C);
    expect(encodeCode128("123").values).not.toContain(CODE_C);
  });
  it("her çıktı için kontrol karakteri bağımsız hesapla aynı, modül sayısı 11·(n+... )+13", () => {
    for (const t of ["A", " ", "~", "SKU-0001", "0123456789", "8690000000019", "LOC/A-01-02", "a1b2c3d4e5f6g7"]) {
      const r = encodeCode128(t);
      const body = r.values.slice(0, -2);
      expect(r.checksum).toBe(checksumOf(body));
      expect(r.values[r.values.length - 1]).toBe(STOP);
      expect(r.modules).toBe(11 * (r.values.length - 1) + 13);
      expect(toModuleString(r).length).toBe(r.modules);
      expect(toModuleString(r).startsWith("11010")).toBe(true);
      expect(toModuleString(r).endsWith("1100011101011")).toBe(true);
    }
  });
  it("tüm yazdırılabilir ASCII tek tek kodlanır; sembol değeri = kod - 32", () => {
    for (let c = 32; c <= 126; c++) {
      const ch = String.fromCharCode(c);
      expect(encodeCode128(ch).values[1]).toBe(c - 32);
    }
  });
  it("EAN-13 uzunluğunda rakam dizisi: Start C, 6 çift, kontrol, bitiş", () => {
    const r = encodeCode128("123456789012");
    expect(r.values.slice(0, 7)).toEqual([START_C, 12, 34, 56, 78, 90, 12]);
    expect(r.values.length).toBe(9);
  });
});

describe("encodeCode128 reddi", () => {
  it("Türkçe/ASCII dışı ve denetim karakterleri: VALIDATION_FAILED + LABEL_CHARSET", () => {
    for (const t of ["ŞEKER", "çay", "İ", "ğ", "a\u0000b", "tab\t", "x\u007F", "€", "😀", "a\nb"]) {
      let err: unknown;
      try {
        encodeCode128(t);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LabelCharsetError);
      expect(err).toBeInstanceOf(AppError);
      expect((err as LabelCharsetError).code).toBe("VALIDATION_FAILED");
      expect((err as LabelCharsetError).reason).toBe("LABEL_CHARSET");
    }
  });
  it("boş metin VALIDATION_FAILED", () => {
    expect(() => encodeCode128("")).toThrow(AppError);
    expect(() => encodeCode128(5 as never)).toThrow(AppError);
  });
});
