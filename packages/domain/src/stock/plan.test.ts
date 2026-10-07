// T-217: işleme planı (saf). Satır sırasından bağımsız, sıralı ve tekrarlı boyutları birleştiren plan; 16 kural 1/3.
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { assertLineRules } from "./rules.ts";
import { buildPostingPlan, dimensionIdentity, fromMicro, toMicro, type PostingLine } from "./plan.ts";

const ITEM = "00000000-0000-4000-8000-0000000000a1";
const L1 = "00000000-0000-4000-8000-0000000000b1";
const L2 = "00000000-0000-4000-8000-0000000000b2";
const L3 = "00000000-0000-4000-8000-0000000000b3";
const S1 = "00000000-0000-4000-8000-0000000000c1";

const line = (no: number, over: Partial<PostingLine> = {}): PostingLine => ({
  lineId: `00000000-0000-4000-8000-00000000d0${no.toString().padStart(2, "0")}`,
  lineNo: no,
  itemId: ITEM,
  quantity: "1",
  conversionFactor: "1",
  baseQuantity: "1",
  sourceLocationId: null,
  targetLocationId: null,
  lotId: null,
  serialId: null,
  sourceStatus: "AVAILABLE",
  targetStatus: "AVAILABLE",
  inventoryOwnerId: null,
  handlingUnitId: null,
  ...over,
});

describe("buildPostingPlan", () => {
  it("STOCK_IN hedefe +, STOCK_OUT kaynaktan -, STOCK_MOVE kaynak - ve hedef + (kural 3: toplam 0)", () => {
    const inn = buildPostingPlan("STOCK_IN", [line(1, { targetLocationId: L1, baseQuantity: "10", quantity: "10" })]);
    expect(inn.entries.map((e) => e.delta)).toEqual([10_000_000n]);
    const out = buildPostingPlan("STOCK_OUT", [line(1, { sourceLocationId: L1 })]);
    expect(out.entries.map((e) => e.delta)).toEqual([-1_000_000n]);
    const mv = buildPostingPlan("STOCK_MOVE", [line(1, { sourceLocationId: L1, targetLocationId: L2, baseQuantity: "4", quantity: "4" })]);
    expect(mv.entries.map((e) => e.delta)).toEqual([-4_000_000n, 4_000_000n]);
    expect([...mv.net.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
    expect(mv.entries.map((e) => e.reason)).toEqual(["MOVE", "MOVE"]);
  });

  it("ters sıralı satırlar aynı sıralı kilit planını verir; tekrarlı boyut birleşir", () => {
    const a = [line(1, { targetLocationId: L3 }), line(2, { targetLocationId: L1 }), line(3, { targetLocationId: L3, baseQuantity: "2", quantity: "2" })];
    const p1 = buildPostingPlan("STOCK_IN", a);
    const p2 = buildPostingPlan("STOCK_IN", [...a].reverse());
    expect(p2.dimensions).toEqual(p1.dimensions);
    expect(p2.locationIds).toEqual(p1.locationIds);
    expect(p1.locationIds).toEqual([L1, L3]);
    expect(p1.dimensions).toHaveLength(2);
    expect(p1.net.get(dimensionIdentity(p1.dimensions[1] as never))).toBe(3_000_000n);
  });

  it("çıkış toplamı boyut başına birleşir; seri kimlikleri planda", () => {
    const p = buildPostingPlan("STOCK_OUT", [line(1, { sourceLocationId: L1 }), line(2, { sourceLocationId: L1, baseQuantity: "3", quantity: "3" })]);
    expect([...p.outTotals.values()]).toEqual([4_000_000n]);
    const s = buildPostingPlan("STOCK_MOVE", [line(1, { sourceLocationId: L1, targetLocationId: L2, serialId: S1 })]);
    expect(s.serialIds).toEqual([S1]);
  });

  it("biçim ihlalleri VALIDATION_FAILED: IN'de kaynak, OUT'ta hedef, MOVE'da eksik uç, boş hareket", () => {
    const bad: [Parameters<typeof buildPostingPlan>[0], PostingLine][] = [
      ["STOCK_IN", line(1, { sourceLocationId: L1, targetLocationId: L2 })],
      ["STOCK_IN", line(1)],
      ["STOCK_OUT", line(1, { sourceLocationId: L1, targetLocationId: L2 })],
      ["STOCK_MOVE", line(1, { sourceLocationId: L1 })],
      ["STOCK_MOVE", line(1, { sourceLocationId: L1, targetLocationId: L1 })],
    ];
    for (const [k, l] of bad) expect(() => buildPostingPlan(k, [l])).toThrow(AppError);
  });

  it("durum değişimi (kaynak ≠ hedef durum) aynı lokasyonda geçerli hareket (T-248: yükleyici hedef durumu doldurur)", () => {
    const p = buildPostingPlan("STOCK_MOVE", [line(1, { sourceLocationId: L1, targetLocationId: L1, sourceStatus: "QUARANTINE", targetStatus: "AVAILABLE" })]);
    expect(p.dimensions.map((d) => d.stockStatus).sort()).toEqual(["AVAILABLE", "QUARANTINE"]);
  });

  it("T-248: kaynak ve hedef boyutlar ayrı anahtarlanır (−kaynak durum, +hedef durum); AVAILABLE→QUARANTINE ve geri izinli", () => {
    for (const [from, to] of [["QUARANTINE", "AVAILABLE"], ["AVAILABLE", "QUARANTINE"]] as const) {
      const p = buildPostingPlan("STOCK_MOVE", [line(1, { sourceLocationId: L1, targetLocationId: L1, sourceStatus: from, targetStatus: to })]);
      expect(p.entries.map((e) => [e.key.stockStatus, e.delta])).toEqual([[from, -1_000_000n], [to, 1_000_000n]]);
    }
  });

  it("T-248 A-248-1: izinli çift dışındaki durum geçişleri VALIDATION_FAILED; IN/OUT'ta kaynak ≠ hedef durum reddedilir", () => {
    const all = ["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"] as const;
    const allowed = new Set(["QUARANTINE>AVAILABLE", "AVAILABLE>QUARANTINE"]);
    for (const a of all) for (const b of all) {
      if (a === b) continue;
      const t = () => buildPostingPlan("STOCK_MOVE", [line(1, { sourceLocationId: L1, targetLocationId: L1, sourceStatus: a, targetStatus: b })]);
      if (allowed.has(`${a}>${b}`)) expect(t).not.toThrow();
      else expect(t).toThrow(AppError);
    }
    expect(() => buildPostingPlan("STOCK_IN", [line(1, { targetLocationId: L1, sourceStatus: "QUARANTINE", targetStatus: "AVAILABLE" })])).toThrow(AppError);
    expect(() => buildPostingPlan("STOCK_OUT", [line(1, { sourceLocationId: L1, sourceStatus: "QUARANTINE", targetStatus: "AVAILABLE" })])).toThrow(AppError);
  });
});

describe("decimal yardımcıları (I-09)", () => {
  it("toMicro/fromMicro gidiş dönüş; geçersiz biçim reddedilir", () => {
    expect(toMicro("12.5")).toBe(12_500_000n);
    expect(fromMicro(-1_500_000n)).toBe("-1.500000");
    expect(fromMicro(toMicro("0.000001"))).toBe("0.000001");
    expect(() => toMicro("1e3")).toThrow(AppError);
    expect(() => toMicro("1.1234567")).toThrow(AppError);
  });
});

describe("assertLineRules — I-09 kesin çarpım (T-290)", () => {
  const items = new Map([[ITEM, { id: ITEM, trackingMode: "NONE" as const, quantityScale: 6 }]]);
  const run = (over: Partial<PostingLine>): string | undefined => {
    try {
      assertLineRules([line(1, { targetLocationId: L1, ...over })], items, new Map());
      return undefined;
    } catch (e) {
      return e instanceof AppError ? `${e.code}${e.detail === undefined ? "" : "/" + String(e.detail)}` : "?";
    }
  };
  it("0.000001 × 0.5 (yuvarlanmış 0.000001) reddedilir; tam çarpım geçer", () => {
    expect(run({ quantity: "0.000001", conversionFactor: "0.5", baseQuantity: "0.000001" })).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(run({ quantity: "0.000001", conversionFactor: "0.5", baseQuantity: "0.000000" })).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(run({ quantity: "0.000002", conversionFactor: "0.5", baseQuantity: "0.000001" })).toBeUndefined();
    expect(run({ quantity: "2", conversionFactor: "12", baseQuantity: "23" })).toBe("VALIDATION_FAILED");
  });
});
