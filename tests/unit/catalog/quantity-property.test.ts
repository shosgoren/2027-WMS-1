// T-219 (qa-verifier): decimal dönüşüm özellik testi (I-09). Üreteç test içidir (fast-check yok; T-220'de gelir): sabit tohumlu
// LCG, koşu belirlenimcidir. Oracle üretim koduna BAĞLI DEĞİLDİR: BigInt ile 10^12 ölçekli tamsayı aritmetiği.
import { describe, expect, it } from "vitest";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { addDecimal, toBase } from "../../../packages/domain/src/catalog/quantity.ts";

/** 31-bit doğrusal eşlenik üreteç (LCG); tohumlu, test içi. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}
const SCALE = 12;
const P = 10n ** BigInt(SCALE);

/** Dizgi → 10^12 ölçekli BigInt (en çok 12 ondalık). */
function scaled(s: string): bigint {
  const [i, f = ""] = s.split(".");
  return BigInt((i as string) + f.padEnd(SCALE, "0"));
}
/** Ondalık hane sayısı (sondaki sıfırlar sayılmaz), BigInt ürününden bağımsız hesap. */
function placesOf(units12: bigint): number {
  let n = 0;
  let v = units12;
  while (n < SCALE && v % 10n === 0n) {
    v /= 10n;
    n++;
  }
  return SCALE - n;
}

function genDecimal(r: () => number, intDigits: number, places: number): string {
  const ip = String(Math.floor(r() * 10 ** intDigits));
  if (places === 0) return ip;
  let f = "";
  for (let i = 0; i < places; i++) f += String(Math.floor(r() * 10));
  return `${ip}.${f}`;
}

function outcome(fn: () => string): { ok: true; v: string } | { ok: false; code: string; detail: string | undefined } {
  try {
    return { ok: true, v: fn() };
  } catch (e) {
    if (!(e instanceof AppError)) throw e; // beklenmeyen hata türü (ör. RangeError/TypeError) özelliği kırar
    return { ok: false, code: e.code, detail: e.detail };
  }
}

describe("toBase özellik testi (I-09, float yok)", () => {
  it("rastgele ölçekli girdilerde: sonuç tam çarpımdır, tersine çevrilebilir (r / f == q), ölçek aşımı QUANTITY_SCALE ile reddedilir", () => {
    const r = rng(219);
    let accepted = 0;
    let rejectedScale = 0;
    for (let i = 0; i < 3000; i++) {
      const scale = Math.floor(r() * 7); // 0..6
      const qty = genDecimal(r, 1 + Math.floor(r() * 5), Math.floor(r() * 7));
      const factor = genDecimal(r, 1 + Math.floor(r() * 3), Math.floor(r() * 7));
      const qU = scaled(qty);
      const fU = scaled(factor);
      if (fU === 0n) continue; // katsayı > 0 kuralı ayrı testte
      const exactProduct12x = qU * fU; // 10^24 ölçekli
      const productU = exactProduct12x / P; // 10^12 ölçekli; q ve f en çok 6 hane -> bölme tam
      expect(exactProduct12x % P).toBe(0n);
      const out = outcome(() => toBase(qty, factor, scale));
      if (placesOf(productU) > scale) {
        // Yuvarlama YOK: ölçeği aşan sonuç reddedilir.
        expect(out, `${qty} x ${factor} @${scale}`).toEqual({ ok: false, code: "VALIDATION_FAILED", detail: "QUANTITY_SCALE" });
        rejectedScale++;
        continue;
      }
      expect(out.ok, `${qty} x ${factor} @${scale}`).toBe(true);
      if (!out.ok) continue;
      accepted++;
      const rU = scaled(out.v);
      expect(rU, `${qty} x ${factor}`).toBe(productU); // tam çarpım
      // Tersine çevrilebilirlik: r / f tam bölünür ve q'yu verir.
      expect((rU * P) % fU).toBe(0n);
      expect((rU * P) / fU).toBe(qU);
      // Kanonik biçim: sondaki sıfır ve gereksiz "." yok.
      expect(out.v).not.toMatch(/\.\d*0$/);
      expect(out.v).not.toMatch(/\.$/);
    }
    expect(accepted).toBeGreaterThan(300); // üreteç iki dalı da gerçekten sınıyor
    expect(rejectedScale).toBeGreaterThan(300);
  });

  it("14 tam haneyi aşan sonuç VALIDATION_FAILED (QUANTITY_SCALE değil); negatif miktar varsayılan ret", () => {
    expect(outcome(() => toBase("99999999999999", "2", 0))).toEqual({ ok: false, code: "VALIDATION_FAILED", detail: undefined });
    expect(outcome(() => toBase("99999999999999", "1", 0))).toEqual({ ok: true, v: "99999999999999" });
    expect(outcome(() => toBase("-1", "2", 0))).toEqual({ ok: false, code: "VALIDATION_FAILED", detail: undefined });
    expect(outcome(() => toBase("-1", "2", 0, { allowNegative: true }))).toEqual({ ok: true, v: "-2" });
  });

  it("geçersiz katsayı (0, negatif, 7 ondalık) ve geçersiz biçim reddedilir; ölçek 0..6 dışı reddedilir", () => {
    for (const f of ["0", "0.0", "-1", "1.0000001", "1e3", "", " 1", "1,5"]) {
      expect(outcome(() => toBase("0", f, 6)).ok, `factor ${JSON.stringify(f)}`).toBe(false);
    }
    for (const q of ["1e3", "", "abc", "1.", ".5", "0x10", "NaN", "Infinity"]) {
      expect(outcome(() => toBase(q, "1", 6)).ok, `qty ${JSON.stringify(q)}`).toBe(false);
    }
    for (const s of [-1, 7, 1.5, Number.NaN]) expect(outcome(() => toBase("1", "1", s)).ok, `scale ${s}`).toBe(false);
  });

  it("float hatası yok: 0.1 + 0.2 == 0.3, 0.1 x 3 == 0.3, 0.1 x 0.2 == 0.02; 14+6 haneli değer bire bir korunur", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // JS float'ının hatalı olduğunun kanıtı (testin anlamlılığı)
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(toBase("0.1", "3", 1)).toBe("0.3");
    expect(toBase("0.1", "0.2", 2)).toBe("0.02");
    expect(toBase("1.1", "1.1", 2)).toBe("1.21");
    expect(toBase("99999999999999.999999", "1", 6)).toBe("99999999999999.999999"); // Number ile 2^53'ü aşar
    expect(toBase("0.000001", "1", 6)).toBe("0.000001");
    // Tamsayı toplamı yineleme ile birikse de kayma yok.
    let acc = "0";
    for (let i = 0; i < 1000; i++) acc = addDecimal(acc, "0.1");
    expect(acc).toBe("100");
  });

  it("belge satırına kopyalanan katsayı: aynı (qty, factor) her çağrıda aynı sonucu verir (saf işlev; sonradan değişen kart katsayısı etkilemez)", () => {
    const copied = "12"; // belge satırında saklanan conversion_factor
    const first = toBase("3", copied, 0);
    const cardChangedTo = "24";
    expect(toBase("3", cardChangedTo, 0)).not.toBe(first); // kart katsayısı farklı sonuç verir...
    expect(toBase("3", copied, 0)).toBe(first); // ...ama kopya ile hesap değişmez
    expect(first).toBe("36");
  });
});
