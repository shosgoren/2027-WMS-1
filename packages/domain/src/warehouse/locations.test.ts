// T-205 birim testleri: kod normalizasyonu, derinlik, kapsam bayrağı ve dizi değişmezi (DB'siz).
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { MAX_LOCATION_DEPTH, childDepth } from "./locations.ts";
import { isWarehouseScopeEnabled, pgUuidArray } from "./scope.ts";
import { normalizeCode, normalizeName } from "./warehouses.ts";

const fails = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe("VALIDATION_FAILED");
    return e as AppError;
  }
  throw new Error("expected throw");
};

describe("normalizeCode", () => {
  it("trims and upper-cases ASCII only", () => {
    expect(normalizeCode("  a-01 ")).toBe("A-01");
    expect(normalizeCode("raf-b2")).toBe("RAF-B2");
  });
  it("does not apply Turkish i/dotless-i conversion or other locale folding", () => {
    expect(normalizeCode("ırmak")).toBe("ırmak".replace(/[a-z]/g, (c) => c.toUpperCase()));
    expect(normalizeCode("ırmak")).toContain("ı");
    expect(normalizeCode("iz")).toBe("IZ");
    expect(normalizeCode("İz")).toBe("İZ");
    expect(normalizeCode("straße")).toBe("STRAßE");
  });
  it("makes exact-match comparison: dotted/dotless variants stay distinct", () => {
    expect(normalizeCode("ı1")).not.toBe(normalizeCode("i1"));
  });
  it("rejects empty, control characters, non-strings and over-long codes", () => {
    fails(() => normalizeCode("   "));
    fails(() => normalizeCode("A\u0000B"));
    fails(() => normalizeCode("A\nB"));
    fails(() => normalizeCode(null));
    fails(() => normalizeCode("x".repeat(65)));
    expect(normalizeCode("x".repeat(64))).toBe("X".repeat(64));
  });
});

describe("normalizeName", () => {
  it("trims and keeps case", () => {
    expect(normalizeName("  Ana Depo ")).toBe("Ana Depo");
  });
  it("rejects empty and over-long names", () => {
    fails(() => normalizeName(" "));
    fails(() => normalizeName("n".repeat(201)));
  });
});

describe("childDepth", () => {
  it("is parent + 1, root is 0", () => {
    expect(childDepth(null)).toBe(0);
    expect(childDepth(0)).toBe(1);
    expect(childDepth(3)).toBe(4);
  });
  it("rejects beyond the depth guard and invalid parents", () => {
    expect(childDepth(MAX_LOCATION_DEPTH - 1)).toBe(MAX_LOCATION_DEPTH);
    fails(() => childDepth(MAX_LOCATION_DEPTH));
    fails(() => childDepth(-1));
    fails(() => childDepth(1.5));
  });
});

describe("isWarehouseScopeEnabled", () => {
  it("is off by default and for unknown values", () => {
    expect(isWarehouseScopeEnabled({})).toBe(false);
    expect(isWarehouseScopeEnabled({ WAREHOUSE_SCOPE_ENABLED: "" })).toBe(false);
    expect(isWarehouseScopeEnabled({ WAREHOUSE_SCOPE_ENABLED: "yes" })).toBe(false);
    expect(isWarehouseScopeEnabled({ WAREHOUSE_SCOPE_ENABLED: "false" })).toBe(false);
  });
  it("turns on only for true/1", () => {
    expect(isWarehouseScopeEnabled({ WAREHOUSE_SCOPE_ENABLED: "true" })).toBe(true);
    expect(isWarehouseScopeEnabled({ WAREHOUSE_SCOPE_ENABLED: " TRUE " })).toBe(true);
    expect(isWarehouseScopeEnabled({ WAREHOUSE_SCOPE_ENABLED: "1" })).toBe(true);
  });
});

describe("pgUuidArray", () => {
  it("formats valid uuids and rejects anything else (no injection into the literal)", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(pgUuidArray([])).toBe("{}");
    expect(pgUuidArray([a, b])).toBe(`{${a},${b}}`);
    fails(() => pgUuidArray([`${a}","x`]));
  });
});
