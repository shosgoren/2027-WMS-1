// Unit: sipariş tahsis önerisi (T-306; A-138; 16 kural 5 ve 9). Saf işlev: tablo testleri.
import { describe, expect, it } from "vitest";
import type { StockDimensionKey } from "@wms/db";
import { isAllocationCandidate, suggestAllocation, type AllocationCandidate } from "./allocation.ts";

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const M = 1_000_000n;
const cand = (code: string, avail: number, over: Partial<Omit<AllocationCandidate, "key">> & { key?: Partial<StockDimensionKey> } = {}): AllocationCandidate => {
  const { key: keyOver, ...rest } = over;
  return {
    key: { itemId: id(1), locationId: id(code.charCodeAt(0) * 10 + code.length), lotId: null, serialId: null, stockStatus: "AVAILABLE", inventoryOwnerId: null, handlingUnitId: null, ...keyOver },
    locationCode: code,
    locationKind: "STORAGE",
    pickBlocked: false,
    counting: false,
    available: BigInt(avail) * M,
    ...rest,
  };
};
const codes = (a: ReturnType<typeof suggestAllocation>): string[] => a.map((x) => `${x.key.locationId}:${x.qty / M}`);

describe("aday süzgeci (kural 5, kural 9)", () => {
  it.each([
    ["KABUL·KAR (QUARANTINE)", cand("A", 5, { key: { stockStatus: "QUARANTINE" } }), false],
    ["DAMAGED", cand("A", 5, { key: { stockStatus: "DAMAGED" } }), false],
    ["BLOCKED", cand("A", 5, { key: { stockStatus: "BLOCKED" } }), false],
    ["RECEIVING lokasyonu", cand("A", 5, { locationKind: "RECEIVING" }), false],
    ["pick_blocked", cand("A", 5, { pickBlocked: true }), false],
    ["sayımdaki lokasyon", cand("A", 5, { counting: true }), false],
    ["kullanılabilir 0", cand("A", 0), false],
    ["kullanılabilir negatif", cand("A", -1), false],
    ["lot'lu (A-306-5)", cand("A", 5, { key: { lotId: id(9) } }), false],
    ["seri'li (A-306-5)", cand("A", 5, { key: { serialId: id(9) } }), false],
    ["STORAGE · AVAILABLE", cand("A", 5), true],
    ["STAGING · AVAILABLE", cand("A", 5, { locationKind: "STAGING" }), true],
  ])("%s", (_n, c, ok) => {
    expect(isAllocationCandidate(c)).toBe(ok);
  });
});

describe("suggestAllocation (A-138)", () => {
  it("tek boyut yetiyorsa tek boyut (16 Senaryo A adım 5: R-01'e 4)", () => {
    const r = cand("R-01", 10);
    expect(suggestAllocation([r], 4n * M)).toEqual([{ key: r.key, qty: 4n * M }]);
  });
  it("yetenler arasında eşitlikte lokasyon kodu artan", () => {
    const b = cand("R-02", 10);
    const a = cand("R-01", 10);
    expect(suggestAllocation([b, a], 4n * M)).toEqual([{ key: a.key, qty: 4n * M }]);
  });
  it("tek boyut yeten varsa daha küçük kodlu ama yetmeyen atlanır (en az sayıda boyut)", () => {
    const small = cand("A-01", 3);
    const big = cand("B-01", 8);
    expect(suggestAllocation([small, big], 5n * M)).toEqual([{ key: big.key, qty: 5n * M }]);
  });
  it("hiçbiri tek başına yetmiyorsa en çok kullanılabilirden, en az sayıda boyutla", () => {
    const a = cand("A-01", 2);
    const b = cand("B-01", 5);
    const c = cand("C-01", 3);
    expect(codes(suggestAllocation([a, b, c], 7n * M))).toEqual([`${b.key.locationId}:5`, `${c.key.locationId}:2`]);
  });
  it("eşit kullanılabilirde lokasyon kodu artan", () => {
    const a = cand("A-01", 3);
    const b = cand("B-01", 3);
    expect(codes(suggestAllocation([b, a], 5n * M))).toEqual([`${a.key.locationId}:3`, `${b.key.locationId}:2`]);
  });
  it("toplam yetmezse bulunan kadar (kısmi; kalan tahsissiz)", () => {
    const a = cand("A-01", 2);
    const b = cand("B-01", 1);
    const out = suggestAllocation([a, b], 10n * M);
    expect(out.reduce((s, x) => s + x.qty, 0n)).toBe(3n * M);
  });
  it("aday yok / ihtiyaç 0 → boş", () => {
    expect(suggestAllocation([], 4n * M)).toEqual([]);
    expect(suggestAllocation([cand("A", 5, { key: { stockStatus: "DAMAGED" } })], 4n * M)).toEqual([]);
    expect(suggestAllocation([cand("A", 5)], 0n)).toEqual([]);
  });
  it("aday olmayan boyut yeterli olsa da seçilmez (pick_blocked: Senaryo D adım 7)", () => {
    const blocked = cand("R-02", 3, { pickBlocked: true });
    expect(suggestAllocation([blocked], 1n * M)).toEqual([]);
  });
  it("girdi dizisini değiştirmez", () => {
    const list = [cand("B", 1), cand("A", 1)];
    const copy = [...list];
    suggestAllocation(list, 2n * M);
    expect(list).toEqual(copy);
  });
});
