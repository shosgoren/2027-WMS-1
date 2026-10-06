// T-217: işleme planı (saf). Satır sırasından bağımsız, sıralı ve tekrarlı boyutları birleştiren plan; 16 kural 1/3.
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
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

  it("durum değişimi (kaynak ≠ hedef durum) aynı lokasyonda geçerli hareket (A-217-1: yükleyici henüz doldurmaz)", () => {
    const p = buildPostingPlan("STOCK_MOVE", [line(1, { sourceLocationId: L1, targetLocationId: L1, sourceStatus: "QUARANTINE", targetStatus: "AVAILABLE" })]);
    expect(p.dimensions.map((d) => d.stockStatus).sort()).toEqual(["AVAILABLE", "QUARANTINE"]);
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
