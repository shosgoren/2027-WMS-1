// T-308: sevk ve iade saf kuralları (16 Temel kurallar 5/6, Senaryo A adım 7–8, Senaryo D adım 8–9; AC-08 sevk kolu). DB'siz.
import { describe, expect, it } from "vitest";
import type { StockDimensionKey } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { toMicro } from "../stock/plan.ts";
import type { ReservationPlanRow } from "../stock/reservation-reads.ts";
import { parseReturnReason, returnableOf } from "./returns.ts";
import { isShippableReservation, planShipment } from "./shipping.ts";

const U = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ITEM = U(1);
const key = (loc: number, over: Partial<StockDimensionKey> = {}): StockDimensionKey => ({
  itemId: ITEM, locationId: U(100 + loc), lotId: null, serialId: null, stockStatus: "AVAILABLE", inventoryOwnerId: null, handlingUnitId: null, ...over,
});
const row = (id: number, loc: number, q: number, over: Partial<ReservationPlanRow> & { k?: Partial<StockDimensionKey> } = {}): ReservationPlanRow => ({
  id: U(id), status: "ACTIVE", quantity: `${q}.000000`, source: { kind: "ORDER_LINE", lineId: U(900) }, key: key(loc, over.k), warehouseId: U(50), locationKind: "STAGING",
  ...(over.status === undefined ? {} : { status: over.status }),
  ...(over.locationKind === undefined ? {} : { locationKind: over.locationKind }),
});
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof AppError ? (e.detail === undefined ? e.code : `${e.code}/${e.detail}`) : "other";
  }
  return "no-throw";
};
const m = (n: number): bigint => toMicro(String(n));

describe("isShippableReservation (AC-08 sevk kolu)", () => {
  it("yalnız ACTIVE, STAGING, takipsiz AVAILABLE rezervasyon sevke uygundur", () => {
    expect(isShippableReservation(row(1, 1, 4))).toBe(true);
    expect(isShippableReservation(row(1, 1, 4, { locationKind: "STORAGE" }))).toBe(false); // toplanmamış
    expect(isShippableReservation(row(1, 1, 4, { locationKind: "RECEIVING" }))).toBe(false);
    expect(isShippableReservation(row(1, 1, 4, { status: "CONSUMED" }))).toBe(false);
    expect(isShippableReservation(row(1, 1, 4, { k: { stockStatus: "QUARANTINE" } }))).toBe(false);
    expect(isShippableReservation(row(1, 1, 4, { k: { stockStatus: "DAMAGED" } }))).toBe(false);
    expect(isShippableReservation(row(1, 1, 4, { k: { lotId: U(7) } }))).toBe(false);
  });
});

describe("planShipment (kısmi sevk; Senaryo A adım 7, Senaryo D adım 8)", () => {
  it("kısmi sevk: 4 rezerveden 3 → tek parça 3, rezervasyon kimlikleri taşınır", () => {
    const p = planShipment([row(10, 2, 4)], m(3));
    expect(p.map((x) => [x.quantity, x.reservationIds])).toEqual([[m(3), [U(10)]]]);
  });
  it("tam sevk ve rezervasyon toplamı kadar sevk", () => {
    expect(planShipment([row(10, 2, 2), row(11, 2, 3)], m(5)).map((x) => x.quantity)).toEqual([m(5)]);
  });
  it("birden çok STAGING boyutu: miktar boyut kimliği sırasıyla bölünür (A-308-3)", () => {
    const p = planShipment([row(11, 3, 2), row(10, 2, 2)], m(3));
    expect(p.map((x) => [x.key.locationId, x.quantity])).toEqual([[U(102), m(2)], [U(103), m(1)]]);
  });
  it("rezervasyon toplamından fazla ya da uygun rezervasyon yoksa INSUFFICIENT_STOCK (rezervasyonsuz sevk yolu yok)", () => {
    expect(code(() => planShipment([row(10, 2, 4)], m(5)))).toBe("INSUFFICIENT_STOCK");
    expect(code(() => planShipment([], m(1)))).toBe("INSUFFICIENT_STOCK");
    expect(code(() => planShipment([row(10, 2, 4, { locationKind: "STORAGE" })], m(1)))).toBe("INSUFFICIENT_STOCK");
    expect(code(() => planShipment([row(10, 2, 4, { k: { stockStatus: "QUARANTINE" } })], m(1)))).toBe("INSUFFICIENT_STOCK");
  });
  it("miktar ≤ 0 VALIDATION_FAILED", () => {
    expect(code(() => planShipment([row(10, 2, 4)], 0n))).toBe("VALIDATION_FAILED");
  });
});

describe("iade kuralları (A-135, A-308-4)", () => {
  it("iade edilebilir = sevk − önceki iadeler, negatife inmez (Senaryo A: sevk 3, iade 1 → 2 kalır)", () => {
    expect(returnableOf(m(3), 0n)).toBe(m(3));
    expect(returnableOf(m(3), m(1))).toBe(m(2));
    expect(returnableOf(m(3), m(4))).toBe(0n);
  });
  it("neden zorunlu: boş, çok uzun ve kontrol karakterli neden reddedilir; kırpılır", () => {
    expect(parseReturnReason("  hasarlı  ")).toBe("hasarlı");
    expect(code(() => parseReturnReason("   "))).toBe("VALIDATION_FAILED");
    expect(code(() => parseReturnReason("x".repeat(501)))).toBe("VALIDATION_FAILED");
    expect(code(() => parseReturnReason("a\u0000b"))).toBe("VALIDATION_FAILED");
    expect(code(() => parseReturnReason(undefined))).toBe("VALIDATION_FAILED");
  });
});
