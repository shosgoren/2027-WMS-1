// T-217: işleme kuralları tablosu (saf): yeterlilik, seri, ölçek, 4 takip modu × satır biçimi. Arşiv/depo (A-145): entegrasyon testlerinde.
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { buildPostingPlan, dimensionIdentity, type PostingLine } from "./plan.ts";
import { assertLineRules, assertSerialUnique, assertSufficient, type ItemInfo, type SerialInfo } from "./rules.ts";
import { assertTracking, type TrackingMode } from "./tracking.ts";

const ITEM = "00000000-0000-4000-8000-0000000000a1";
const LOC = "00000000-0000-4000-8000-0000000000b1";
const LOT = "00000000-0000-4000-8000-0000000000f1";
const LOT2 = "00000000-0000-4000-8000-0000000000f2";
const SER = "00000000-0000-4000-8000-0000000000c1";

const base: PostingLine = {
  lineId: "00000000-0000-4000-8000-00000000d001",
  lineNo: 1,
  itemId: ITEM,
  quantity: "1",
  conversionFactor: "1",
  baseQuantity: "1",
  sourceLocationId: null,
  targetLocationId: LOC,
  lotId: null,
  serialId: null,
  sourceStatus: "AVAILABLE",
  targetStatus: "AVAILABLE",
  inventoryOwnerId: null,
  handlingUnitId: null,
};
const item = (mode: TrackingMode, over: Partial<ItemInfo> = {}): ItemInfo => ({ id: ITEM, trackingMode: mode, quantityScale: 0, ...over });
const serials = (lot: string | null = null): Map<string, SerialInfo> => new Map([[SER, { id: SER, itemId: ITEM, lotId: lot }]]);
const code = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.detail === undefined ? e.code : `${e.code}/${e.detail}`;
    throw e;
  }
  return undefined;
};
const run = (mode: TrackingMode, line: Partial<PostingLine>, it_: Partial<ItemInfo> = {}, sl = serials()) =>
  code(() => assertLineRules([{ ...base, ...line }], new Map([[ITEM, item(mode, it_)]]), sl));

describe("takip modu × satır biçimi", () => {
  const table: [TrackingMode, Partial<PostingLine>, string | undefined][] = [
    ["NONE", {}, undefined],
    ["NONE", { lotId: LOT }, "TRACKING_VIOLATION"],
    ["NONE", { serialId: SER }, "TRACKING_VIOLATION"],
    ["LOT", { lotId: LOT }, undefined],
    ["LOT", {}, "TRACKING_VIOLATION"],
    ["LOT", { lotId: LOT, serialId: SER }, "TRACKING_VIOLATION"],
    ["SERIAL", { serialId: SER }, undefined],
    ["SERIAL", {}, "TRACKING_VIOLATION"],
    ["SERIAL", { serialId: SER, lotId: LOT }, "TRACKING_VIOLATION"],
    ["SERIAL", { serialId: SER, quantity: "2", baseQuantity: "2" }, "TRACKING_VIOLATION"],
    ["LOT_AND_SERIAL", { serialId: SER, lotId: LOT }, undefined],
    ["LOT_AND_SERIAL", { serialId: SER }, "TRACKING_VIOLATION"],
    ["LOT_AND_SERIAL", { lotId: LOT }, "TRACKING_VIOLATION"],
  ];
  it.each(table)("%s %j → %s", (mode, line, expected) => {
    const sl = mode === "LOT_AND_SERIAL" ? serials(LOT) : serials(null);
    expect(run(mode, line, {}, sl)).toBe(expected);
  });
  it("LOT_AND_SERIAL: seri başka lota bağlıysa ret", () => {
    expect(run("LOT_AND_SERIAL", { serialId: SER, lotId: LOT }, {}, serials(LOT2))).toBe("TRACKING_VIOLATION");
  });
  it("seri satırı kilitli görüntüde yoksa ret", () => {
    expect(() => assertTracking("SERIAL", { lotId: null, serialId: SER, quantityMicro: 1_000_000n }, undefined)).toThrow(AppError);
  });
});

describe("ölçek, dönüşüm", () => {
  it("miktar ölçeği aşımı QUANTITY_SCALE; ölçek içi geçer", () => {
    expect(run("NONE", { quantity: "1.5", baseQuantity: "1.5" })).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(run("NONE", { quantity: "1.5", baseQuantity: "1.5" }, { quantityScale: 1 })).toBeUndefined();
    expect(run("NONE", { quantity: "0.000001", baseQuantity: "0.000001" }, { quantityScale: 6 })).toBeUndefined();
  });
  it("taban miktar = miktar × katsayı (I-09); uyuşmazlık VALIDATION_FAILED", () => {
    expect(run("NONE", { quantity: "2", conversionFactor: "12", baseQuantity: "24" })).toBeUndefined();
    expect(run("NONE", { quantity: "2", conversionFactor: "12", baseQuantity: "23" })).toBe("VALIDATION_FAILED");
  });
});

describe("yeterlilik (I-05)", () => {
  const out = (q: string) => buildPostingPlan("STOCK_OUT", [{ ...base, sourceLocationId: LOC, targetLocationId: null, quantity: q, baseQuantity: q }]);
  const key = dimensionIdentity(out("1").dimensions[0] as never);
  it("quantity − reserved ≥ çıkış geçer; bir fazlası INSUFFICIENT_STOCK", () => {
    const bal = new Map([[key, { quantity: 10_000_000n, reserved: 4_000_000n }]]);
    expect(code(() => assertSufficient(out("6"), bal))).toBeUndefined();
    expect(code(() => assertSufficient(out("7"), bal))).toBe("INSUFFICIENT_STOCK");
  });
  it("bakiyesi olmayan boyuttan çıkış reddedilir", () => {
    expect(code(() => assertSufficient(out("1"), new Map()))).toBe("INSUFFICIENT_STOCK");
  });
});

describe("seri tekilliği (AC-09)", () => {
  it("hedefte başka boyutta pozitif seri → ret; kaynak sıfırlanıyorsa (taşıma) geçer", () => {
    const existing = new Map([[SER, new Map([["d1", 1_000_000n]])]]);
    expect(code(() => assertSerialUnique(existing, new Map([["d2", 1_000_000n]]), new Map([["d2", SER]])))).toBe("TRACKING_VIOLATION");
    expect(
      code(() => assertSerialUnique(existing, new Map([["d1", -1_000_000n], ["d2", 1_000_000n]]), new Map([["d1", SER], ["d2", SER]]))),
    ).toBeUndefined();
  });
  it("aynı seri belgede iki hedef boyuta girerse ret", () => {
    expect(code(() => assertSerialUnique(new Map(), new Map([["d1", 1_000_000n], ["d2", 1_000_000n]]), new Map([["d1", SER], ["d2", SER]])))).toBe("TRACKING_VIOLATION");
  });
});
