// T-221: rezervasyon saf kuralları (bölüştürme, kalan hesap, tüketim/taşıma etkisi, süre aşımı bayrağı). 16 §Temel kurallar 2/5/7, Senaryo A adım 5-7.
import { describe, expect, it } from "vitest";
import type { LockedReservation, LockedState, StockDimensionKey } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import {
  allocateAcross,
  dimensionIdentity,
  remainingToReserve,
  reservedExcluding,
  toMicro,
  type LedgerEntry,
} from "./plan.ts";
import { isReservationExpiryEnabled, planReservationEffects } from "./reservations.ts";

const U = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ITEM = U(1);
const key = (loc: number): StockDimensionKey => ({
  itemId: ITEM,
  locationId: U(100 + loc),
  lotId: null,
  serialId: null,
  stockStatus: "AVAILABLE",
  inventoryOwnerId: null,
  handlingUnitId: null,
});
const R01 = key(1);
const SEVK = key(2);
const DIM_R01 = U(501);
const DIM_SEVK = U(502);
const dimIdByIdentity = new Map([
  [dimensionIdentity(R01), DIM_R01],
  [dimensionIdentity(SEVK), DIM_SEVK],
]);
const LINE_A = U(700);
const LINE_B = U(701);
const m = (n: number): bigint => toMicro(String(n));

const res = (id: number, dim: string, line: string, q: number, status = "ACTIVE"): LockedReservation => ({
  id: U(id),
  stockDimensionId: dim,
  documentLineId: line,
  quantity: `${q}.000000`,
  status,
});
const lockedOf = (reservations: LockedReservation[]): LockedState => ({
  document: undefined,
  locations: [],
  dimensions: [],
  balances: [],
  reservations,
  serials: [],
});
const entry = (lineId: string, k: StockDimensionKey, delta: bigint): LedgerEntry => ({ lineId, lineNo: 1, key: k, delta, reason: delta < 0n ? "SHIPMENT" : "MOVE" });
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof AppError ? (e.detail === undefined ? e.code : `${e.code}/${e.detail}`) : "other";
  }
  return "no-throw";
};

describe("allocateAcross (tahsis bölüştürme)", () => {
  const slices = [
    { id: U(3), quantity: m(2) },
    { id: U(2), quantity: m(5) },
    { id: U(4), quantity: m(1) },
  ];
  it("kimliğe göre artan sırayla dağıtır; kalan hesabı doğrudur (girdi sırasından bağımsız)", () => {
    const t = allocateAcross(slices, m(6));
    expect(t.map((x) => [x.id, x.take, x.rest])).toEqual([
      [U(2), m(5), 0n],
      [U(3), m(1), m(1)],
    ]);
    expect(allocateAcross([...slices].reverse(), m(6))).toEqual(t);
  });
  it("tek dilimden kısmi: kalan ACTIVE; toplam yetmezse ya da miktar ≤ 0 ise ret (sessiz kısaltma yok)", () => {
    expect(allocateAcross(slices, m(3)).map((x) => [x.take, x.rest])).toEqual([[m(3), m(2)]]);
    expect(allocateAcross(slices, m(8)).reduce((a, x) => a + x.take, 0n)).toBe(m(8));
    expect(code(() => allocateAcross(slices, m(9)))).toBe("VALIDATION_FAILED");
    expect(code(() => allocateAcross(slices, 0n))).toBe("VALIDATION_FAILED");
  });
});

describe("kalan hesap", () => {
  it("satır üst sınırı: kalan = satır − Σ ACTIVE, negatife inmez", () => {
    expect(remainingToReserve(m(4), m(0))).toBe(m(4));
    expect(remainingToReserve(m(4), m(3))).toBe(m(1));
    expect(remainingToReserve(m(4), m(5))).toBe(0n);
  });
  it("yeterlilik düzeltmesi: kendi rezervasyonu düşülür; reserved'dan büyük kendi pay bütünlük ihlalidir (INTERNAL)", () => {
    expect(reservedExcluding(m(4), m(4))).toBe(0n);
    expect(reservedExcluding(m(7), m(4))).toBe(m(3));
    expect(code(() => reservedExcluding(m(3), m(4)))).toBe("INTERNAL");
    expect(code(() => reservedExcluding(m(3), -1n))).toBe("VALIDATION_FAILED");
  });
});

describe("planReservationEffects: çıkışta tüketim (Senaryo A adım 7)", () => {
  it("satırın kaynak boyutundaki rezervasyonu tüketilir; reserved düşer; kendi pay yeterlilikten düşülür", () => {
    const fx = planReservationEffects({
      kind: "STOCK_OUT",
      entries: [entry(LINE_A, SEVK, -m(4))],
      locked: lockedOf([res(10, DIM_SEVK, LINE_A, 4)]),
      dimIdByIdentity,
    });
    expect(fx.consumeOps.map((o) => [o.id, o.take, o.rest])).toEqual([[U(10), m(4), 0n]]);
    expect(fx.reservedDelta.get(DIM_SEVK)).toBe(-m(4));
    expect(fx.ownReserved.get(dimensionIdentity(SEVK))).toBe(m(4));
  });
  it("kısmi: çıkış rezervasyondan küçükse kalan ACTIVE; başka boyuttaki ve başka satırın rezervasyonuna dokunulmaz", () => {
    const fx = planReservationEffects({
      kind: "STOCK_OUT",
      entries: [entry(LINE_A, SEVK, -m(3))],
      locked: lockedOf([res(10, DIM_SEVK, LINE_A, 4), res(11, DIM_R01, LINE_A, 2), res(12, DIM_SEVK, LINE_B, 5)]),
      dimIdByIdentity,
    });
    expect(fx.consumeOps.map((o) => [o.id, o.take, o.rest])).toEqual([[U(10), m(3), m(1)]]);
    expect(fx.reservedDelta.get(DIM_SEVK)).toBe(-m(3));
    expect(fx.reservedDelta.has(DIM_R01)).toBe(false);
  });
  it("rezervasyonsuz satır etkisizdir; kapalı (CONSUMED/RELEASED) rezervasyon sayılmaz", () => {
    const fx = planReservationEffects({
      kind: "STOCK_OUT",
      entries: [entry(LINE_A, SEVK, -m(3))],
      locked: lockedOf([res(10, DIM_SEVK, LINE_A, 4, "CONSUMED"), res(11, DIM_SEVK, LINE_A, 4, "RELEASED")]),
      dimIdByIdentity,
    });
    expect(fx.consumeOps).toEqual([]);
    expect(fx.ownReserved.size).toBe(0);
  });
});

describe("planReservationEffects: toplama taşıması (Senaryo A adım 6)", () => {
  const moveEntries = (qty: number): LedgerEntry[] => [entry(LINE_B, R01, -m(qty)), entry(LINE_B, SEVK, m(qty))];
  it("rezervasyon malla birlikte hedef boyuta taşınır: kaynak reserved −, hedef +", () => {
    const fx = planReservationEffects({
      kind: "STOCK_MOVE",
      entries: moveEntries(4),
      locked: lockedOf([res(10, DIM_R01, LINE_A, 4)]),
      dimIdByIdentity,
      moves: [{ lineId: LINE_B, reservationIds: [U(10)] }],
    });
    expect(fx.moveOps.map((o) => [o.id, o.take, o.rest, o.sourceDimensionId, o.targetDimensionId])).toEqual([[U(10), m(4), 0n, DIM_R01, DIM_SEVK]]);
    expect(fx.reservedDelta.get(DIM_R01)).toBe(-m(4));
    expect(fx.reservedDelta.get(DIM_SEVK)).toBe(m(4));
    expect(fx.targetDims.map((d) => d.id)).toEqual([DIM_SEVK]);
  });
  it("kısmi toplama: yalnızca satır miktarı kadar taşınır, kalan kaynakta ACTIVE", () => {
    const fx = planReservationEffects({
      kind: "STOCK_MOVE",
      entries: moveEntries(3),
      locked: lockedOf([res(10, DIM_R01, LINE_A, 4)]),
      dimIdByIdentity,
      moves: [{ lineId: LINE_B, reservationIds: [U(10)] }],
    });
    expect(fx.moveOps.map((o) => [o.take, o.rest])).toEqual([[m(3), m(1)]]);
  });
  it("taşıma girdisi olmayan MOVE etkisizdir; STOCK_IN/OUT'ta taşıma girdisi ret", () => {
    expect(planReservationEffects({ kind: "STOCK_MOVE", entries: moveEntries(4), locked: lockedOf([res(10, DIM_R01, LINE_A, 4)]), dimIdByIdentity }).moveOps).toEqual([]);
    const mv = [{ lineId: LINE_A, reservationIds: [U(10)] }];
    expect(code(() => planReservationEffects({ kind: "STOCK_IN", entries: [], locked: lockedOf([]), dimIdByIdentity, moves: mv }))).toBe("VALIDATION_FAILED");
    expect(code(() => planReservationEffects({ kind: "STOCK_OUT", entries: [entry(LINE_A, SEVK, -m(1))], locked: lockedOf([]), dimIdByIdentity, moves: mv }))).toBe("VALIDATION_FAILED");
  });
  it("kaynak boyutta olmayan, kapalı, kilitsiz ya da iki kez verilen rezervasyon ret", () => {
    const base = { kind: "STOCK_MOVE" as const, entries: moveEntries(4), dimIdByIdentity };
    const mv = (ids: string[]) => [{ lineId: LINE_B, reservationIds: ids }];
    expect(code(() => planReservationEffects({ ...base, locked: lockedOf([res(10, DIM_SEVK, LINE_A, 4)]), moves: mv([U(10)]) }))).toBe("VALIDATION_FAILED");
    expect(code(() => planReservationEffects({ ...base, locked: lockedOf([res(10, DIM_R01, LINE_A, 4, "RELEASED")]), moves: mv([U(10)]) }))).toBe("VALIDATION_FAILED");
    expect(code(() => planReservationEffects({ ...base, locked: lockedOf([]), moves: mv([U(10)]) }))).toBe("VALIDATION_FAILED");
    const twoLines = [...moveEntries(2), entry(LINE_A, R01, -m(2)), entry(LINE_A, SEVK, m(2))];
    const dup = [{ lineId: LINE_B, reservationIds: [U(10)] }, { lineId: LINE_A, reservationIds: [U(10)] }];
    expect(code(() => planReservationEffects({ ...base, entries: twoLines, locked: lockedOf([res(10, DIM_R01, LINE_A, 4)]), moves: dup }))).toBe("VALIDATION_FAILED");
  });
});

describe("süre aşımı bayrağı (A-76)", () => {
  it("varsayılan KAPALI; yalnızca true/1 açar", () => {
    expect(isReservationExpiryEnabled({})).toBe(false);
    expect(isReservationExpiryEnabled({ RESERVATION_EXPIRY_ENABLED: "false" })).toBe(false);
    expect(isReservationExpiryEnabled({ RESERVATION_EXPIRY_ENABLED: "yes" })).toBe(false);
    expect(isReservationExpiryEnabled({ RESERVATION_EXPIRY_ENABLED: "TRUE" })).toBe(true);
    expect(isReservationExpiryEnabled({ RESERVATION_EXPIRY_ENABLED: "1" })).toBe(true);
  });
});
