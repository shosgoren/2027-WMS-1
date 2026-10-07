// T-307 saf kurallar: görev üretim sırası, eksik miktar hesabı, birim/koli dönüşümü. DB yok.
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { pickShortfall, planPickTasks, scaledBaseQuantity, type PickSource } from "./picking.ts";

const M = 1_000_000n;
const src = (o: Partial<PickSource> & { lineId: string }): PickSource => ({
  orderId: "o1", orderNumber: "S1", lineNo: 1, itemId: "i1", locationId: "l1", locationCode: "R-01", warehouseId: "w1", quantity: 5n * M, ...o,
});

describe("planPickTasks", () => {
  it("lokasyon kodu, sipariş no, satır no sırasıyla üretir", () => {
    const out = planPickTasks([
      src({ lineId: "a", locationCode: "R-02", locationId: "l2", orderNumber: "S1" }),
      src({ lineId: "b", locationCode: "R-01", orderNumber: "S2" }),
      src({ lineId: "c", locationCode: "R-01", orderNumber: "S1", lineNo: 2 }),
      src({ lineId: "d", locationCode: "R-01", orderNumber: "S1", lineNo: 1 }),
    ]);
    expect(out.map((t) => t.lineId)).toEqual(["d", "c", "b", "a"]);
  });
  it("açık görev miktarı düşülür; artan yoksa görev yok, artan varsa yalnız artan", () => {
    const open = new Map([["a|l1", 5n * M], ["b|l1", 2n * M]]);
    const out = planPickTasks([src({ lineId: "a" }), src({ lineId: "b" })], open);
    expect(out.map((t) => [t.lineId, t.quantity])).toEqual([["b", 3n * M]]);
  });
  it("boş girdi boş çıktı", () => expect(planPickTasks([])).toEqual([]));
});

describe("pickShortfall", () => {
  it("beklenen = min(görev, rezervasyon); eksik = beklenen − bulunan", () => {
    expect(pickShortfall(4n * M, 4n * M, 3n * M)).toEqual({ expected: 4n * M, short: 1n * M });
    expect(pickShortfall(4n * M, 4n * M, 0n)).toEqual({ expected: 4n * M, short: 4n * M });
    expect(pickShortfall(4n * M, 4n * M, 4n * M).short).toBe(0n);
    expect(pickShortfall(6n * M, 2n * M, 2n * M)).toEqual({ expected: 2n * M, short: 0n });
  });
  it("fazla bulunan negatif eksik verir (çağıran reddeder)", () => expect(pickShortfall(4n * M, 4n * M, 5n * M).short).toBe(-1n * M));
});

describe("scaledBaseQuantity", () => {
  it("koli barkodu: adet × okutma başına × katsayı", () => {
    expect(scaledBaseQuantity("2", "1", "12.000000")).toBe(24n * M);
    expect(scaledBaseQuantity("3", "6", "1.000000")).toBe(18n * M);
    expect(scaledBaseQuantity("0", "1", "1")).toBe(0n);
  });
  it("6 ondalıktan fazla girdi reddedilir", () => {
    const e = (() => { try { scaledBaseQuantity("0.0000005", "1", "1"); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(AppError);
  });
  it("tam 6 ondalık kabul", () => expect(scaledBaseQuantity("0.5", "1", "0.5")).toBe(250_000n));
});

// --- T-307 güvenlik: sipariş rezervasyonu taşıma kuralı (reservations.ts:452 reddi YALNIZ toplama yolunda kalktı) ------------------------------
import type { LockedReservation, LockedState, StockDimensionKey } from "@wms/db";
import { dimensionIdentity, toMicro, type LedgerEntry } from "../stock/plan.ts";
import { planReservationEffects } from "../stock/reservations.ts";

describe("planReservationEffects: sipariş rezervasyonu yalnız toplama yolunda taşınır", () => {
  const U = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const key = (loc: number): StockDimensionKey => ({ itemId: U(1), locationId: U(100 + loc), lotId: null, serialId: null, stockStatus: "AVAILABLE", inventoryOwnerId: null, handlingUnitId: null });
  const R01 = key(1);
  const SEVK = key(2);
  const ids = new Map([[dimensionIdentity(R01), U(501)], [dimensionIdentity(SEVK), U(502)]]);
  const lockedOf = (reservations: LockedReservation[]): LockedState => ({ document: undefined, locations: [], dimensions: [], balances: [], reservations, serials: [] });
  const entries = (q: number): LedgerEntry[] => [
    { lineId: U(9), lineNo: 1, key: R01, delta: -toMicro(String(q)), reason: "MOVE" },
    { lineId: U(9), lineNo: 1, key: SEVK, delta: toMicro(String(q)), reason: "MOVE" },
  ];
  const orderRes: LockedReservation = { id: U(10), stockDimensionId: U(501), documentLineId: null, quantity: "4.000000", status: "ACTIVE" };
  const docRes: LockedReservation = { id: U(11), stockDimensionId: U(501), documentLineId: U(700), quantity: "4.000000", status: "ACTIVE" };
  const run = (res: LockedReservation, allow: boolean) =>
    planReservationEffects({
      kind: "STOCK_MOVE", entries: entries(4), locked: lockedOf([res]), dimIdByIdentity: ids,
      moves: [{ lineId: U(9), reservationIds: [res.id], ...(allow ? { allowOrderReservations: true as const } : {}) }],
    });
  const code = (f: () => unknown): string => { try { f(); } catch (e) { return e instanceof AppError ? e.code : "other"; } return "no-throw"; };

  it("genel (bayraksız) yol: sipariş rezervasyonu VALIDATION_FAILED", () => expect(code(() => run(orderRes, false))).toBe("VALIDATION_FAILED"));
  it("toplama yolu (bayraklı): sipariş rezervasyonu hedef boyuta taşınır, reserved kaynak −4 / hedef +4", () => {
    const fx = run(orderRes, true);
    expect(fx.moveOps.map((o) => [o.id, o.take, o.rest, o.sourceDimensionId, o.targetDimensionId])).toEqual([[U(10), toMicro("4"), 0n, U(501), U(502)]]);
    expect(fx.reservedDelta.get(U(501))).toBe(-toMicro("4"));
    expect(fx.reservedDelta.get(U(502))).toBe(toMicro("4"));
  });
  it("belge satırı rezervasyonu: bayrak etkisiz, sonuç aynı (davranış değişmedi)", () => {
    const a = run(docRes, false);
    const b = run(docRes, true);
    expect(b).toEqual(a);
    expect(a.moveOps.map((o) => [o.id, o.take, o.rest])).toEqual([[U(11), toMicro("4"), 0n]]);
  });
});
