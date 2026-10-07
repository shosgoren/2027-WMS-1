// T-224: ters kayıt saf mantığı (kalan hesabı, satır seçimi, ters defter girdileri, bakiye yeterliliği, girdi doğrulaması). Veritabanı yok.
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { dimensionIdentity, toMicro } from "./plan.ts";
import {
  REVERSAL_MAX_LINES,
  assertReversalCovered,
  buildReversalPlan,
  normalizeReversalInput,
  remainingMicro,
  reversalLineQuantity,
  reversalStateAfter,
  selectReversalLines,
  type BalanceSnapshot,
  type SourceLine,
} from "./reversal.ts";

const ITEM = "00000000-0000-4000-8000-0000000000a1";
const L1 = "00000000-0000-4000-8000-0000000000b1";
const L2 = "00000000-0000-4000-8000-0000000000b2";
const DOC = "00000000-0000-4000-8000-0000000000d1";
const lineId = (n: number): string => `00000000-0000-4000-8000-${(0xe00000 + n).toString(16).padStart(12, "0")}`;

const src = (no: number, over: Partial<SourceLine> = {}): SourceLine => ({
  lineId: lineId(no),
  lineNo: no,
  itemId: ITEM,
  unitId: "00000000-0000-4000-8000-0000000000f1",
  quantity: "100",
  conversionFactor: "1",
  baseQuantity: "100",
  reversedQuantity: "0",
  sourceLocationId: null,
  targetLocationId: L1,
  lotId: null,
  serialId: null,
  sourceStatus: "AVAILABLE",
  targetStatus: "AVAILABLE",
  inventoryOwnerId: null,
  handlingUnitId: null,
  ...over,
});
const fail = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
};
const codeOf = (e: AppError): string => (e.detail === undefined ? e.code : `${e.code}/${e.detail}`);

describe("remainingMicro / reversalStateAfter", () => {
  it("kalan = base − reversed; negatife inmez", () => {
    expect(remainingMicro({ baseQuantity: "100", reversedQuantity: "40" })).toBe(60_000_000n);
    expect(remainingMicro({ baseQuantity: "100", reversedQuantity: "100" })).toBe(0n);
    expect(remainingMicro({ baseQuantity: "1", reversedQuantity: "2" })).toBe(0n);
  });
  it("durum: kısmi PARTIAL, tamamı FULL (Senaryo C: 40/100 PARTIAL)", () => {
    expect(reversalStateAfter("100", "0", 40_000_000n)).toEqual({ reversed: 40_000_000n, status: "PARTIAL" });
    expect(reversalStateAfter("100", "40", 60_000_000n)).toEqual({ reversed: 100_000_000n, status: "FULL" });
  });
});

describe("normalizeReversalInput", () => {
  const ok = { documentId: DOC.toUpperCase(), reason: "  yanlış giriş  ", lines: [{ lineId: lineId(2).toUpperCase(), quantity: "1.5" }, { lineId: lineId(1), quantity: "2" }] };
  it("kimlikler küçük harf, satırlar lineId sıralı, gerekçe kırpılır", () => {
    const n = normalizeReversalInput(ok);
    expect(n.documentId).toBe(DOC);
    expect(n.reason).toBe("yanlış giriş");
    expect(Array.isArray(n.lines) ? n.lines.map((l) => l.lineId) : n.lines).toEqual([lineId(1), lineId(2)]);
  });
  it("ALL kabul edilir", () => {
    expect(normalizeReversalInput({ documentId: DOC, reason: "x", lines: "ALL" }).lines).toBe("ALL");
  });
  it("gerekçe zorunlu; boş/kontrol karakterli/501 karakter reddedilir", () => {
    for (const reason of ["", "   ", "a\u0000b", "x".repeat(501)]) {
      expect(codeOf(fail(() => normalizeReversalInput({ documentId: DOC, lines: "ALL", reason })))).toBe("VALIDATION_FAILED");
    }
  });
  it("geçersiz kimlik, miktar (0, negatif, 7 ondalık, boş), boş liste ve tekrarlı satır reddedilir", () => {
    const bad: unknown[] = [
      { ...ok, documentId: "x" },
      { ...ok, lines: [] },
      { ...ok, lines: [{ lineId: "x", quantity: "1" }] },
      { ...ok, lines: [{ lineId: lineId(1), quantity: "0" }] },
      { ...ok, lines: [{ lineId: lineId(1), quantity: "-1" }] },
      { ...ok, lines: [{ lineId: lineId(1), quantity: "1.1234567" }] },
      { ...ok, lines: [{ lineId: lineId(1), quantity: "" }] },
      { ...ok, lines: [{ lineId: lineId(1), quantity: "1" }, { lineId: lineId(1).toUpperCase(), quantity: "2" }] },
      { ...ok, lines: "ALLX" },
    ];
    for (const b of bad) expect(codeOf(fail(() => normalizeReversalInput(b as never)))).toBe("VALIDATION_FAILED");
  });
  it("200 satır üstü TOO_MANY_LINES (A-224-1)", () => {
    const lines = Array.from({ length: REVERSAL_MAX_LINES + 1 }, (_, i) => ({ lineId: lineId(i + 1), quantity: "1" }));
    expect(codeOf(fail(() => normalizeReversalInput({ documentId: DOC, reason: "x", lines })))).toBe("VALIDATION_FAILED/TOO_MANY_LINES");
    expect(normalizeReversalInput({ documentId: DOC, reason: "x", lines: lines.slice(0, REVERSAL_MAX_LINES) }).lines).toHaveLength(REVERSAL_MAX_LINES);
  });
});

describe("selectReversalLines", () => {
  const lines = [src(1), src(2, { reversedQuantity: "30" }), src(3, { reversedQuantity: "100" })];
  const req = (l: { lineId: string; q: string }[]) => normalizeReversalInput({ documentId: DOC, reason: "x", lines: l.map((x) => ({ lineId: x.lineId, quantity: x.q })) }).lines;
  it("ALL: her satırın kalanı, kalanı 0 olan atlanır", () => {
    const s = selectReversalLines(lines, "ALL");
    expect(s.map((x) => [x.line.lineNo, x.micro])).toEqual([[1, 100_000_000n], [2, 70_000_000n]]);
  });
  it("ALL: hiç kalan yoksa EXCEEDS_REMAINING", () => {
    expect(codeOf(fail(() => selectReversalLines([src(1, { reversedQuantity: "100" })], "ALL")))).toBe("REVERSAL_BLOCKED/EXCEEDS_REMAINING");
  });
  it("kalanı aşan miktar EXCEEDS_REMAINING; kalana eşit olan geçer", () => {
    expect(codeOf(fail(() => selectReversalLines(lines, req([{ lineId: lineId(2), q: "70.000001" }]))))).toBe("REVERSAL_BLOCKED/EXCEEDS_REMAINING");
    expect(codeOf(fail(() => selectReversalLines(lines, req([{ lineId: lineId(3), q: "1" }]))))).toBe("REVERSAL_BLOCKED/EXCEEDS_REMAINING");
    expect(selectReversalLines(lines, req([{ lineId: lineId(2), q: "70" }]))[0]?.micro).toBe(70_000_000n);
  });
  it("belgede olmayan satır VALIDATION_FAILED", () => {
    expect(codeOf(fail(() => selectReversalLines(lines, req([{ lineId: lineId(9), q: "1" }]))))).toBe("VALIDATION_FAILED");
  });
});

describe("buildReversalPlan", () => {
  it("STOCK_IN: hedef boyuttan −; STOCK_OUT: kaynağa +; STOCK_MOVE: kaynağa + ve hedeften −", () => {
    const inn = buildReversalPlan("STOCK_IN", selectReversalLines([src(1)], [{ lineId: lineId(1), quantity: "40", micro: 40_000_000n }]));
    expect(inn.entries.map((e) => e.delta)).toEqual([-40_000_000n]);
    expect(inn.outTotals.get(dimensionIdentity(inn.entries[0]!.key))).toBe(40_000_000n);
    const out = buildReversalPlan("STOCK_OUT", selectReversalLines([src(1, { sourceLocationId: L1, targetLocationId: null })], "ALL"));
    expect(out.entries.map((e) => e.delta)).toEqual([100_000_000n]);
    expect(out.outTotals.size).toBe(0);
    const mv = buildReversalPlan("STOCK_MOVE", selectReversalLines([src(1, { sourceLocationId: L1, targetLocationId: L2 })], "ALL"));
    expect(mv.entries.map((e) => e.delta)).toEqual([100_000_000n, -100_000_000n]);
    expect(mv.entries[0]?.key.locationId).toBe(L1);
    expect(mv.entries[1]?.key.locationId).toBe(L2);
    expect([...mv.net.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });
  it("durum değiştiren taşıma ters çevrilmez: REVERSAL_BLOCKED/STATUS_CHANGE (A-224-3); aynı durumlu taşıma çevrilir", () => {
    const sel = selectReversalLines([src(1, { sourceLocationId: L1, targetLocationId: L1, sourceStatus: "AVAILABLE", targetStatus: "QUARANTINE" })], "ALL");
    expect(codeOf(fail(() => buildReversalPlan("STOCK_MOVE", sel)))).toBe("REVERSAL_BLOCKED/STATUS_CHANGE");
    expect(() => buildReversalPlan("STOCK_MOVE", selectReversalLines([src(1, { sourceLocationId: L1, targetLocationId: L2 })], "ALL"))).not.toThrow();
  });
});

describe("reversalLineQuantity (I-09, A-224-8)", () => {
  const BASE_UNIT = "00000000-0000-4000-8000-0000000000f9";
  const l = (over: Partial<SourceLine>) => src(1, over);
  it("tam satır: asıl miktar, birim ve katsayı aynen", () => {
    expect(reversalLineQuantity(l({ quantity: "4", conversionFactor: "25", baseQuantity: "100" }), 100_000_000n, BASE_UNIT)).toEqual({
      unitId: l({}).unitId, quantity: "4", conversionFactor: "25",
    });
  });
  it("kısmi satır, tam bölünüyorsa asıl birimde (50/25 = 2)", () => {
    expect(reversalLineQuantity(l({ quantity: "4", conversionFactor: "25", baseQuantity: "100" }), 50_000_000n, BASE_UNIT)).toEqual({
      unitId: l({}).unitId, quantity: "2.000000", conversionFactor: "25",
    });
  });
  it("kısmi satır, bölünmüyorsa temel birim ve katsayı 1 (değer uydurulmaz, 0.000001'e zorlanmaz)", () => {
    const r = reversalLineQuantity(l({ quantity: "4", conversionFactor: "25", baseQuantity: "100" }), 7_000_001n, BASE_UNIT);
    expect(r).toEqual({ unitId: BASE_UNIT, quantity: "7.000001", conversionFactor: "1.000000" });
    const tiny = reversalLineQuantity(l({ quantity: "1", conversionFactor: "1000000", baseQuantity: "1000000" }), 1n, BASE_UNIT);
    expect(tiny).toEqual({ unitId: BASE_UNIT, quantity: "0.000001", conversionFactor: "1.000000" });
  });
  it("seçilen her durumda base = round(quantity × katsayı, 6) (özellik)", () => {
    for (const [q, cf, base, take] of [["3", "0.333333", "1", 400_000n], ["7", "1.5", "10.5", 3_500_000n], ["2", "3", "6", 1_000_001n], ["5", "0.1", "0.5", 123_456n]] as const) {
      const r = reversalLineQuantity(l({ quantity: q, conversionFactor: cf, baseQuantity: base }), take, BASE_UNIT);
      const back = (toMicro(r.quantity) * toMicro(r.conversionFactor) + 500_000n) / 1_000_000n;
      expect(back).toBe(take);
    }
  });
});

describe("assertReversalCovered (I-05)", () => {
  const plan = buildReversalPlan("STOCK_IN", selectReversalLines([src(1)], "ALL"));
  const id = dimensionIdentity(plan.entries[0]!.key);
  const bal = (quantity: bigint, reserved = 0n): Map<string, BalanceSnapshot> => new Map([[id, { quantity, reserved }]]);
  it("Senaryo C: kalan 40 < 100 → STOCK_USED", () => {
    expect(codeOf(fail(() => assertReversalCovered(plan, bal(40_000_000n))))).toBe("REVERSAL_BLOCKED/STOCK_USED");
  });
  it("bakiye yeter ama rezerve düşülünce yetmez → STOCK_RESERVED", () => {
    expect(codeOf(fail(() => assertReversalCovered(plan, bal(100_000_000n, 1n))))).toBe("REVERSAL_BLOCKED/STOCK_RESERVED");
  });
  it("tam yeterli bakiye geçer; eksik boyut 0 sayılır", () => {
    expect(() => assertReversalCovered(plan, bal(100_000_000n))).not.toThrow();
    expect(codeOf(fail(() => assertReversalCovered(plan, new Map())))).toBe("REVERSAL_BLOCKED/STOCK_USED");
  });
});
