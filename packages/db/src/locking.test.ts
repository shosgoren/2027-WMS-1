// Unit: acquireStockLocks (T-210, I-15). Ağ erişimi YOK: sahte `tx.execute` üretilen SQL'i ve parametreleri kaydeder.
// Alt adımlar dışa açık olmadığından plan normalizasyonu, adım sırası, NULLS FIRST sıralaması ve sayım kilidi istisnası
// yalnızca `acquireStockLocks`'ın gözlenebilir davranışı üzerinden sınanır. Aynı kümenin DB sıralamasıyla karşılaştırması
// entegrasyon testindedir (tests/integration/stock/locking.int.test.ts).
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { TenantTx } from "./client.ts";
import { acquireStockLocks, type StockDimensionKey, type StockLockPlan } from "./locking.ts";

const TENANT = "0b3c6a52-6f0e-4a8b-9d1e-2f4a5b6c7d8e";
const dialect = new PgDialect();
// Lint (wms/stock-sql-guard) bu dosyada stok yazma SQL metnini yasaklar.
// Ekleme ifadeleri fiil/tablo adı yazılmadan, yapısal ayırt edicilerle tanınır (lint bu dosyada dize bölmeye dayanmaz).
const isDimensionInsert = (c: { text: string }): boolean => c.text.includes("jsonb_to_recordset") && c.text.includes("ON CONFLICT");
const isBalanceInsert = (c: { text: string }): boolean => c.text.includes("unnest(") && c.text.includes("ON CONFLICT");
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

interface Call {
  readonly text: string;
  readonly params: readonly unknown[];
}
interface Fixture {
  document?: { id: string; version: number; status: string; warehouse_id: string };
  locks?: { location_id: string; status: "IDLE" | "COUNTING"; count_session_id: string | null }[];
  visibleLocations?: string[];
  /** Transaction'daki tenant bağlamı (`undefined` = ayarlı değil). Varsayılan: TENANT. */
  contextTenant?: string | null;
}

function fakeTx(fx: Fixture = {}): { tx: TenantTx; calls: Call[]; probes: () => number } {
  const calls: Call[] = [];
  let probes = 0;
  const execute = (query: SQL): Promise<Record<string, unknown>[]> => {
    const q = dialect.sqlToQuery(query);
    const text = q.sql.replace(/\s+/g, " ");
    if (text.includes("current_setting")) {
      probes++; // tenant bağlamı yoklaması (`currentTenantId`); sözleşme sorguları `calls`'tadır
      return Promise.resolve([{ tenant_id: fx.contextTenant === undefined ? TENANT : fx.contextTenant }]);
    }
    calls.push({ text, params: q.params });
    if (text.includes("FROM public.documents")) return Promise.resolve(fx.document === undefined ? [] : [fx.document]);
    if (text.includes("FROM public.location_count_locks")) {
      // Fikstür verilmediyse istenen her lokasyon IDLE'dır.
      const asked = q.params.filter((p): p is string => typeof p === "string" && p !== TENANT);
      return Promise.resolve(fx.locks ?? asked.map((location_id) => ({ location_id, status: "IDLE" as const, count_session_id: null })));
    }
    if (text.includes("FROM public.locations")) return Promise.resolve((fx.visibleLocations ?? []).map((i) => ({ id: i })));
    if (text.includes("JOIN public.stock_dimensions")) {
      const json = q.params.find((p): p is string => typeof p === "string" && p.startsWith("["));
      const rows = JSON.parse(json ?? "[]") as Record<string, unknown>[];
      return Promise.resolve(rows.map((r, i) => ({ id: id(1000 + i), ...r })));
    }
    if (text.includes("FROM public.stock_balances")) {
      const ids = q.params.filter((p): p is string => typeof p === "string" && p.startsWith("00000000-") && p !== TENANT);
      return Promise.resolve(ids.map((d) => ({ stock_dimension_id: d, quantity: "0.000000", reserved_quantity: "0.000000", version: "0" })));
    }
    if (text.includes("FROM public.reservations") || text.includes("FROM public.serials")) {
      const ids = q.params.filter((p): p is string => typeof p === "string" && p !== TENANT);
      return Promise.resolve(ids.map((d) => ({ id: d })));
    }
    return Promise.resolve([]);
  };
  return { tx: { execute } as unknown as TenantTx, calls, probes: () => probes };
}

const plan = (over: Partial<StockLockPlan> = {}): StockLockPlan => ({ locationIds: [], dimensions: [], reservationIds: [], serialIds: [], ...over });
const key = (over: Partial<StockDimensionKey> & { itemId: string; locationId: string }): StockDimensionKey => ({
  lotId: null,
  serialId: null,
  stockStatus: "AVAILABLE",
  inventoryOwnerId: null,
  handlingUnitId: null,
  ...over,
});
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { name?: string; code?: string }).name === "StockLockError" ? (e as { code: string }).code : `non-lock:${String(e)}`;
  }
};
const dimensionJson = (calls: Call[]): { item_id: string }[] =>
  JSON.parse(calls.find(isDimensionInsert)?.params.find((p) => typeof p === "string" && p.startsWith("[")) as string);

const FLAG = "STOCK_SERIAL_LOCK_ENABLED";
/** Bayrağı geçici ayarlar (`undefined` = tanımsız) ve eski değeri geri yükler. */
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env[FLAG];
    else process.env[FLAG] = old;
  }
}

describe("plan normalizasyonu", () => {
  it("boş plan yalnızca tenant bağlamı yoklamasını yapar (boş adımlar atlanır)", async () => {
    const { tx, calls } = fakeTx();
    const state = await acquireStockLocks(tx, TENANT, plan());
    expect(calls).toHaveLength(0);
    expect(state).toEqual({ document: undefined, locations: [], dimensions: [], balances: [], reservations: [], serials: [] });
  });

  it("kimlikler küçük harfe çevrilir, tekilleştirilir ve artan sıralanır; SQL ORDER BY ile birlikte", async () => {
    const { tx, calls } = fakeTx();
    await withFlag("true", () => acquireStockLocks(tx, TENANT, plan({ reservationIds: [id(3), id(1).toUpperCase(), id(3), id(2)], serialIds: [id(9), id(7), id(9)] })));
    const res = calls.find((c) => c.text.includes("FROM public.reservations"));
    const ser = calls.find((c) => c.text.includes("FROM public.serials"));
    expect(res?.params.filter((p) => p !== TENANT)).toEqual([id(1), id(2), id(3)]);
    expect(res?.text).toContain("ORDER BY id FOR UPDATE");
    expect(ser?.params.filter((p) => p !== TENANT)).toEqual([id(7), id(9)]);
    expect(ser?.text).toContain("ORDER BY id FOR NO KEY UPDATE");
  });

  it("yinelenen boyut anahtarı tekilleşir; aynı anahtarın büyük harfli yazımı da aynıdır", async () => {
    const { tx, calls } = fakeTx();
    const state = await acquireStockLocks(
      tx,
      TENANT,
      plan({ dimensions: [key({ itemId: id(5), locationId: id(6) }), key({ itemId: id(5).toUpperCase(), locationId: id(6) })] }),
    );
    expect(dimensionJson(calls)).toHaveLength(1);
    expect(state.dimensions).toHaveLength(1);
    expect(state.balances).toHaveLength(1);
  });

  it.each([
    ["geçersiz kiracı", () => acquireStockLocks(fakeTx().tx, "not-a-uuid", plan())],
    ["geçersiz lokasyon", () => acquireStockLocks(fakeTx().tx, TENANT, plan({ locationIds: ["x"] }))],
    ["geçersiz sürüm", () => acquireStockLocks(fakeTx().tx, TENANT, plan({ document: { id: id(1), expectedVersion: 1.5 } }))],
    ["geçersiz durum", () => acquireStockLocks(fakeTx().tx, TENANT, plan({ dimensions: [{ ...key({ itemId: id(1), locationId: id(2) }), stockStatus: "X" as never }] }))],
  ])("%s sorgudan önce VALIDATION_FAILED", async (_n, run) => {
    expect(await codeOf(run())).toBe("VALIDATION_FAILED");
  });
});

describe("adım sırası (I-15)", () => {
  it("belge → sayım kilidi → boyut → bakiye satırı → bakiye → rezervasyon → seri", async () => {
    const { tx, calls } = fakeTx({
      document: { id: id(1), version: 4, status: "APPROVED", warehouse_id: id(2) },
      locks: [{ location_id: id(7), status: "IDLE", count_session_id: null }],
    });
    await withFlag("true", () => acquireStockLocks(
      tx,
      TENANT,
      plan({
        serialIds: [id(30)],
        reservationIds: [id(20)],
        dimensions: [key({ itemId: id(5), locationId: id(7) })],
        locationIds: [id(7)],
        document: { id: id(1), expectedVersion: 4 },
      }),
    ));
    const order: ((c: Call) => boolean)[] = [
      (c) => c.text.includes("FROM public.documents"),
      (c) => c.text.includes("FROM public.location_count_locks"),
      isDimensionInsert,
      (c) => c.text.includes("JOIN public.stock_dimensions"),
      isBalanceInsert,
      (c) => c.text.includes("FROM public.stock_balances"),
      (c) => c.text.includes("FROM public.reservations"),
      (c) => c.text.includes("FROM public.serials"),
    ];
    const at = order.map((match) => calls.findIndex(match));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(calls[at[0] as number]?.text).toContain("FOR UPDATE");
    expect(calls[at[1] as number]?.text).toContain("ORDER BY location_id FOR SHARE");
    expect(calls[at[5] as number]?.text).toContain("ORDER BY stock_dimension_id FOR UPDATE");
  });
});

describe("boyut anahtarı sırası = PostgreSQL ORDER BY … NULLS FIRST", () => {
  const A = id(0xa);
  const B = id(0xb);
  const L1 = id(0x11);
  const L2 = id(0x22);
  // Beklenen sıra (elle): item, location, lot (NULL önce), serial (NULL önce), status, owner (NULL önce), handling unit (NULL önce).
  const expected: StockDimensionKey[] = [
    key({ itemId: A, locationId: L1 }),
    key({ itemId: A, locationId: L1, handlingUnitId: B }),
    key({ itemId: A, locationId: L1, inventoryOwnerId: A }),
    key({ itemId: A, locationId: L1, stockStatus: "BLOCKED" }),
    key({ itemId: A, locationId: L1, serialId: A }),
    key({ itemId: A, locationId: L1, lotId: A }),
    key({ itemId: A, locationId: L1, lotId: B }),
    key({ itemId: A, locationId: L2 }),
    key({ itemId: B, locationId: L1 }),
  ];
  it("karıştırılmış girdi beklenen sıraya oturur", async () => {
    const shuffled = [3, 7, 0, 8, 5, 1, 6, 2, 4].map((i) => expected[i] as StockDimensionKey);
    const { tx, calls } = fakeTx();
    const state = await acquireStockLocks(tx, TENANT, plan({ dimensions: shuffled }));
    const sent = JSON.parse(
      calls.find(isDimensionInsert)?.params.find((p) => typeof p === "string" && p.startsWith("[")) as string,
    ) as Record<string, string | null>[];
    expect(sent.map((r) => [r.item_id, r.location_id, r.lot_id, r.serial_id, r.stock_status, r.inventory_owner_id, r.handling_unit_id])).toEqual(
      expected.map((k) => [k.itemId, k.locationId, k.lotId, k.serialId, k.stockStatus, k.inventoryOwnerId, k.handlingUnitId]),
    );
    expect(state.dimensions.map((d) => d.key)).toEqual(expected);
    const insert = calls.find(isDimensionInsert);
    expect(insert?.text).toContain("ORDER BY w.ord");
  });
});

describe("sayım kilidi kararı", () => {
  const S1 = id(0x51);
  const S2 = id(0x52);
  const locks = (rows: [string, "IDLE" | "COUNTING", string | null][]) =>
    rows.map(([location_id, status, count_session_id]) => ({ location_id, status, count_session_id }));

  it("oturum yok: hepsi IDLE → geçer, FOR SHARE", async () => {
    const { tx, calls } = fakeTx({ locks: locks([[id(1), "IDLE", null], [id(2), "IDLE", null]]) });
    await acquireStockLocks(tx, TENANT, plan({ locationIds: [id(2), id(1)] }));
    expect(calls[0]?.text).toContain("FOR SHARE");
  });
  it("oturum yok: biri COUNTING → LOCATION_LOCKED", async () => {
    const { tx } = fakeTx({ locks: locks([[id(1), "IDLE", null], [id(2), "COUNTING", S1]]) });
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ locationIds: [id(1), id(2)] })))).toBe("LOCATION_LOCKED");
  });
  it("oturum var: tümü aynı oturuma kilitli → geçer, FOR UPDATE", async () => {
    const { tx, calls } = fakeTx({ locks: locks([[id(1), "COUNTING", S1], [id(2), "COUNTING", S1]]) });
    await acquireStockLocks(tx, TENANT, plan({ locationIds: [id(1), id(2)], countSessionId: S1 }));
    expect(calls[0]?.text).toContain("FOR UPDATE");
  });
  it.each([
    ["biri başka oturumda", [[id(1), "COUNTING", S1], [id(2), "COUNTING", S2]] as [string, "IDLE" | "COUNTING", string | null][]],
    ["biri IDLE", [[id(1), "COUNTING", S1], [id(2), "IDLE", null]] as [string, "IDLE" | "COUNTING", string | null][]],
  ])("oturum var ama %s → LOCATION_LOCKED", async (_n, rows) => {
    const { tx } = fakeTx({ locks: locks(rows) });
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ locationIds: [id(1), id(2)], countSessionId: S1 })))).toBe("LOCATION_LOCKED");
  });
  it("kilit satırı yok, lokasyon görünür → COUNT_LOCK_ROW_MISSING", async () => {
    const { tx } = fakeTx({ locks: [], visibleLocations: [id(1)] });
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ locationIds: [id(1)] })))).toBe("COUNT_LOCK_ROW_MISSING");
  });
  it("lokasyon görünmüyor (başka tenant) → NOT_FOUND, varlık sızmaz", async () => {
    const { tx } = fakeTx({ locks: [], visibleLocations: [] });
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ locationIds: [id(1)] })))).toBe("NOT_FOUND");
  });
});

describe("belge kilidi", () => {
  it("sürüm uyuşmazlığı → VERSION_CONFLICT; sonraki adımlar çalışmaz", async () => {
    const { tx, calls } = fakeTx({ document: { id: id(1), version: 5, status: "APPROVED", warehouse_id: id(2) } });
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ document: { id: id(1), expectedVersion: 4 }, locationIds: [id(3)] })))).toBe("VERSION_CONFLICT");
    expect(calls).toHaveLength(1);
  });
  it("belge görünmüyor → NOT_FOUND", async () => {
    const { tx } = fakeTx();
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ document: { id: id(1), expectedVersion: 1 } })))).toBe("NOT_FOUND");
  });
  it("sürüm eşleşirse anlık görüntü döner", async () => {
    const { tx } = fakeTx({ document: { id: id(1), version: 4, status: "APPROVED", warehouse_id: id(2) } });
    const s = await acquireStockLocks(tx, TENANT, plan({ document: { id: id(1), expectedVersion: 4 } }));
    expect(s.document).toEqual({ id: id(1), version: 4, status: "APPROVED", warehouseId: id(2) });
  });
});

describe("inceleme MAJOR-4: denetlenen lokasyon = locationIds ∪ boyut lokasyonları", () => {
  const S1 = id(0x51);
  it("boyutu COUNTING lokasyonda olup locationIds'te yok → LOCATION_LOCKED; boyut/bakiye eklenmez", async () => {
    const { tx, calls } = fakeTx({ locks: [{ location_id: id(7), status: "COUNTING", count_session_id: S1 }] });
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ dimensions: [key({ itemId: id(5), locationId: id(7) })] })))).toBe("LOCATION_LOCKED");
    expect(calls.some(isDimensionInsert)).toBe(false);
  });
  it("lokasyonlar birleşim olarak tekilleştirilir ve artan sorgulanır", async () => {
    const { tx, calls } = fakeTx({ locks: [{ location_id: id(7), status: "IDLE", count_session_id: null }, { location_id: id(8), status: "IDLE", count_session_id: null }] });
    const s = await acquireStockLocks(tx, TENANT, plan({ locationIds: [id(8), id(7)], dimensions: [key({ itemId: id(5), locationId: id(7) })] }));
    expect(calls[0]?.params.filter((p) => p !== TENANT)).toEqual([id(7), id(8)]);
    expect(s.locations.map((l) => l.locationId)).toEqual([id(7), id(8)]);
  });
  it("countSessionId verilmiş ama kapsanan lokasyon yok → VALIDATION_FAILED, sorgu yok", async () => {
    const { tx, calls, probes } = fakeTx();
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ countSessionId: S1 })))).toBe("VALIDATION_FAILED");
    expect(calls).toHaveLength(0);
    expect(probes()).toBe(0);
  });
  it("oturum istisnası boyut lokasyonlarını da kapsar: boyut IDLE lokasyonda → LOCATION_LOCKED", async () => {
    const { tx } = fakeTx({ locks: [{ location_id: id(7), status: "COUNTING", count_session_id: S1 }, { location_id: id(8), status: "IDLE", count_session_id: null }] });
    expect(
      await codeOf(acquireStockLocks(tx, TENANT, plan({ locationIds: [id(7)], countSessionId: S1, dimensions: [key({ itemId: id(5), locationId: id(8) })] }))),
    ).toBe("LOCATION_LOCKED");
  });
});

describe("inceleme MAJOR-5: seri kilidi kapalı bayrak (Q-56)", () => {
  it.each([undefined, "", "false", "1", "TRUE"])("bayrak %j iken serialIds → VALIDATION_FAILED, HİÇ sorgu yok (belge/tenant yoklaması dahil)", async (value) => {
    const { tx, calls, probes } = fakeTx({ document: { id: id(1), version: 1, status: "APPROVED", warehouse_id: id(2) } });
    const code = await withFlag(value, () => codeOf(acquireStockLocks(tx, TENANT, plan({ document: { id: id(1), expectedVersion: 1 }, serialIds: [id(9)] }))));
    expect(code).toBe("VALIDATION_FAILED");
    expect(calls).toHaveLength(0);
    expect(probes()).toBe(0);
  });
  it("bayrak kapalıyken serialIds boşsa plan çalışır", async () => {
    const { tx } = fakeTx();
    await withFlag(undefined, () => acquireStockLocks(tx, TENANT, plan({ reservationIds: [id(3)] })));
  });
  it("bayrak 'true' iken seri adımı çalışır", async () => {
    const { tx, calls } = fakeTx();
    await withFlag("true", () => acquireStockLocks(tx, TENANT, plan({ serialIds: [id(9)] })));
    expect(calls.some((c) => c.text.includes("FROM public.serials"))).toBe(true);
  });
});

describe("inceleme MINOR-3/4", () => {
  it("tenantId transaction bağlamıyla uyuşmuyorsa FORBIDDEN (sorgu yok)", async () => {
    const { tx, calls } = fakeTx({ contextTenant: id(0x99) });
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ reservationIds: [id(3)] })))).toBe("FORBIDDEN");
    expect(calls).toHaveLength(0);
  });
  it("tenant bağlamı kurulu değilse FORBIDDEN", async () => {
    const { tx } = fakeTx({ contextTenant: null });
    expect(await codeOf(acquireStockLocks(tx, TENANT, plan({ reservationIds: [id(3)] })))).toBe("FORBIDDEN");
  });
  it("büyük harfli tenantId bağlamla eşleşir", async () => {
    const { tx } = fakeTx();
    await acquireStockLocks(tx, TENANT.toUpperCase(), plan({ reservationIds: [id(3)] }));
  });
  it("çakışma hedefi adlandırılmış kısıttır (migration 0013 adları)", async () => {
    const { tx, calls } = fakeTx();
    await acquireStockLocks(tx, TENANT, plan({ dimensions: [key({ itemId: id(5), locationId: id(6) })] }));
    expect(calls.find(isDimensionInsert)?.text).toContain("ON CONFLICT ON CONSTRAINT stock_dimensions_natural_key DO NOTHING");
    expect(calls.find(isBalanceInsert)?.text).toContain("ON CONFLICT ON CONSTRAINT stock_balances_pkey DO NOTHING");
  });
});
