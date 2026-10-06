// acquireStockLocks (T-210, I-15, ADR-017 §1-§5, ADR-018 §7) — GERÇEK rollerle: uygulama tarafı yalnızca DATABASE_URL (wms_app, pooler);
// migration rolü (DATABASE_URL_DIRECT) yalnızca fikstür kurulumu/temizliği ve sayım kilidi durumunu değiştirmek içindir.
// Sentetik veri: rastgele UUID (G-09). AC-27 (T-227) bu kartın kapsamı dışındadır; burada kilit sözleşmesinin DB davranışı doğrulanır.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireStockLocks, createDbClient, withTenant, type StockDimensionKey, type StockLockPlan } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient, type TenantContext } from "../../../packages/db/src/client.ts";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let admin: pg.Client;
let app: DbClient;
let A: TenantWorld;
let B: TenantWorld;
let ctxA: TenantContext;

const empty = (over: Partial<StockLockPlan> = {}): StockLockPlan => ({ locationIds: [], dimensions: [], reservationIds: [], serialIds: [], ...over });
const dim = (itemId: string, locationId: string, over: Partial<StockDimensionKey> = {}): StockDimensionKey => ({
  itemId,
  locationId,
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
    const x = e as { name?: string; code?: string };
    return x.name === "StockLockError" ? x.code : `other:${x.name}:${x.code ?? ""}`;
  }
};
const sqlstateOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    let cur: unknown = e;
    for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      cur = (cur as { cause?: unknown }).cause;
    }
    return `unknown:${String(e)}`;
  }
};
/** Migration rolü + tenant bağlamı (RLS FORCE) ile tek transaction. */
async function adminTx(tenantId: string, work: (q: (s: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<void>): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await work((s, p) => admin.query(s, p));
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: env.databaseUrlDirect });
  admin.on("error", () => undefined);
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrlDirect])}`);
  }
  A = await seedWorld(admin, reg, "T210-A");
  B = await seedWorld(admin, reg, "T210-B");
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  ctxA = createTenantContext(app, A.tenantId);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (admin !== undefined) {
    try {
      await cleanupRegistry(admin, reg);
    } finally {
      await admin.end();
    }
  }
}, 120_000);

const run = <T>(plan: StockLockPlan, after?: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) =>
  withTenant(ctxA, async (tx) => {
    const state = await acquireStockLocks(tx, A.tenantId, plan);
    if (after !== undefined) await after(tx);
    return state;
  });

describe("tam plan: belge, lokasyon, boyut/bakiye, rezervasyon", () => {
  it("mevcut boyut yeniden kullanılır; eksik boyut ve bakiye satırı oluşur; bakiye 0 ile kilitlenir", async () => {
    const existing = dim(A.itemNoneId, A.rootLocationId);
    const fresh = dim(A.itemNoneId, A.childLocationId, { stockStatus: "QUARANTINE" });
    const state = await run(
      empty({
        document: { id: A.documentId, expectedVersion: 1 },
        locationIds: [A.rootLocationId, A.childLocationId],
        dimensions: [fresh, existing],
        reservationIds: [A.reservationId],
      }),
    );
    expect(state.document?.version).toBe(1);
    expect(state.locations.map((l) => l.status)).toEqual(["IDLE", "IDLE"]);
    expect(state.dimensions.find((d) => d.id === A.dimensionId)?.key).toEqual(existing);
    const freshRow = state.dimensions.find((d) => d.id !== A.dimensionId);
    expect(freshRow?.key).toEqual(fresh);
    const bal = state.balances.find((b) => b.stockDimensionId === A.dimensionId);
    expect(bal).toMatchObject({ quantity: "10.000000", reservedQuantity: "4.000000" });
    expect(state.balances.find((b) => b.stockDimensionId === freshRow?.id)).toMatchObject({ quantity: "0.000000", reservedQuantity: "0.000000" });
    expect(state.reservations).toHaveLength(1);
    expect(state.reservations[0]).toMatchObject({ id: A.reservationId, stockDimensionId: A.dimensionId, quantity: "4.000000", status: "ACTIVE" });
    // Aynı plan ikinci kez: idempotent, yeni boyut oluşmaz.
    const again = await run(empty({ dimensions: [existing, fresh] }));
    expect(again.dimensions.map((d) => d.id).sort()).toEqual(state.dimensions.map((d) => d.id).sort());
  });

  // BULGU (T-210, Q-56): 0011 `serials` için wms_app'e yalnızca SELECT + INSERT verir; PostgreSQL her satır kilidi modu
  // (FOR UPDATE/SHARE/KEY SHARE) tabloda UPDATE yetkisi ister. Spec adım 6 (`lockSerials` FOR UPDATE) bu yüzden bugün wms_app ile
  // çalışamaz. Seri adımı KAPALI BAYRAKLIDIR (STOCK_SERIAL_LOCK_ENABLED): bayrak yokken plan sorgudan önce reddedilir; bayrak açıkken
  // işlev KAPALI ÇÖKERDİ (42501). 0015 (T-237, A-122) yalnız kilit için `UPDATE (created_at)` verir ve satır değişmezliğini tetikleyiciyle zorlar → bayrak açıkken kilit alınır.
  const withSerialFlag = async <T,>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const old = process.env.STOCK_SERIAL_LOCK_ENABLED;
    if (value === undefined) delete process.env.STOCK_SERIAL_LOCK_ENABLED;
    else process.env.STOCK_SERIAL_LOCK_ENABLED = value;
    try {
      return await fn();
    } finally {
      if (old === undefined) delete process.env.STOCK_SERIAL_LOCK_ENABLED;
      else process.env.STOCK_SERIAL_LOCK_ENABLED = old;
    }
  };
  it("seri kilidi bayrak KAPALIYKEN reddedilir: VALIDATION_FAILED", async () => {
    expect(await withSerialFlag(undefined, () => codeOf(run(empty({ serialIds: [A.serialId] }))))).toBe("VALIDATION_FAILED");
  });
  it("seri kilidi bayrak AÇIKKEN (0015, Q-56/A-122) wms_app satırı kilitler: state.serials döner, kilit gerçekten tutulur (55P03), satır değişmez", async () => {
    const before = await admin.query("SELECT * FROM public.serials WHERE id = $1", [A.serialId]);
    let concurrent: string | undefined;
    const state = await withSerialFlag("true", () =>
      run(empty({ serialIds: [A.serialId] }), async () => {
        // Kilit işlem boyunca tutulur: ikinci bağlantı NOWAIT ile aynı satırı kilitleyemez.
        concurrent = await admin.query("SELECT 1 FROM public.serials WHERE id = $1 FOR UPDATE NOWAIT", [A.serialId]).then(
          () => "acquired",
          (e: { code?: string }) => e.code,
        );
      }),
    );
    expect(concurrent).toBe("55P03");
    expect(state.serials).toEqual([{ id: A.serialId, itemId: before.rows[0].item_id, serialNo: before.rows[0].serial_no, lotId: before.rows[0].lot_id }]);
    const after = await admin.query("SELECT * FROM public.serials WHERE id = $1", [A.serialId]);
    expect(after.rows).toEqual(before.rows);
  });

  it("tenantId transaction bağlamıyla uyuşmuyorsa FORBIDDEN (başka tenant kimliğiyle çağrı)", async () => {
    expect(await codeOf(withTenant(ctxA, (tx) => acquireStockLocks(tx, B.tenantId, empty({ reservationIds: [A.reservationId] }))))).toBe("FORBIDDEN");
  });
  it("başka tenant'ın kimlikleri görünmez: NOT_FOUND (varlık sızmaz)", async () => {
    expect(await codeOf(run(empty({ locationIds: [B.rootLocationId] })))).toBe("NOT_FOUND");
    expect(await codeOf(run(empty({ document: { id: B.documentId, expectedVersion: 1 } })))).toBe("NOT_FOUND");
    expect(await codeOf(run(empty({ reservationIds: [B.reservationId] })))).toBe("NOT_FOUND");
  });
});

describe("boyut anahtarı sırası = PostgreSQL ORDER BY … NULLS FIRST (uygulama sırası DB sırasıyla aynı)", () => {
  it("NULL içeren anahtar kümesi DB'de sıralanıp uygulama sırasıyla karşılaştırılır", async () => {
    const keys: StockDimensionKey[] = [];
    for (const itemId of [A.itemNoneId]) {
      for (const locationId of [A.rootLocationId, A.childLocationId]) {
        for (const stockStatus of ["BLOCKED", "AVAILABLE", "DAMAGED"] as const) {
          for (const inventoryOwnerId of [null, A.ownerId]) {
            for (const handlingUnitId of [null, A.handlingUnitId]) keys.push(dim(itemId, locationId, { stockStatus, inventoryOwnerId, handlingUnitId }));
          }
        }
      }
    }
    // Lot + seri doluluğu LOT_AND_SERIAL ürününde zorunludur (boyut tetikleyicisi); NULL-lot/seri sırası birim testte tablolanır.
    keys.push(dim(A.itemId, A.rootLocationId, { lotId: A.lotId, serialId: A.serialId }), dim(A.itemId, A.rootLocationId, { lotId: A.lotId, serialId: A.serialId, stockStatus: "QUARANTINE" }));
    const shuffled = [...keys].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? 1 : -1));
    const state = await run(empty({ dimensions: shuffled }));
    expect(state.dimensions).toHaveLength(keys.length);
    const appOrder = state.dimensions.map((d) => d.id);
    const rows = await withTenant(ctxA, (tx) =>
      // Değerler bu testin kendi ürettiği rastgele UUID'lerdir (kullanıcı girdisi yok); string yürütme yalnızca testtedir.
      tx.execute<{ id: string }>(
        `SELECT id FROM public.stock_dimensions
          WHERE tenant_id = '${A.tenantId}'::uuid AND id = ANY(ARRAY[${appOrder.map((i) => `'${i}'::uuid`).join(", ")}])
          ORDER BY item_id, location_id, lot_id NULLS FIRST, serial_id NULLS FIRST, stock_status, inventory_owner_id NULLS FIRST, handling_unit_id NULLS FIRST`,
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(appOrder);
  });
});

describe("eşzamanlı ters sıralı planlar: deadlock yok", () => {
  // Ayırt edici tasarım (inceleme MAJOR-3): belge YOK; her tur TAZE lokasyonda 8 YENİ boyut (henüz var olmayan satırlar: sıralı olmayan
  // ekleme ters kilit sırası = 40P01) + 4 rezervasyon, iki yönde. Planı normalize eden sıralama kaldırılırsa test 40P01 ile kırmızıya döner
  // (mutasyon kanıtı rapordadır). Kontrol testi AYNI satır kümesini elle ters sırayla kilitler ve 40P01 üretir.
  const extraReservations: string[] = [];
  const roundKeys = (locationId: string): StockDimensionKey[] =>
    (["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"] as const).flatMap((stockStatus) =>
      [null, A.ownerId].map((inventoryOwnerId) => dim(A.itemNoneId, locationId, { stockStatus, inventoryOwnerId })),
    );
  const freshLocation = async (): Promise<string> => {
    const locationId = randomUUID();
    await adminTx(A.tenantId, async (q) => {
      await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, NULL, $4, 'T210 tur', 0, 'STORAGE')", [
        A.tenantId,
        locationId,
        A.warehouseId,
        `T210-${locationId.slice(0, 8)}`,
      ]);
    });
    return locationId;
  };
  const hold = (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => tx.execute("SELECT pg_sleep(0.05)");
  let lastLocation = "";

  beforeAll(async () => {
    // Mevcut boyuta 3 ek ACTIVE rezervasyon (rezerve toplamı bakiyede aynı transaction'da güncellenir; mutlak denetim ertelenmiş).
    await adminTx(A.tenantId, async (q) => {
      for (let n = 0; n < 3; n++) {
        const rid = randomUUID();
        extraReservations.push(rid);
        await q("INSERT INTO public.reservations (tenant_id, id, stock_dimension_id, document_line_id, quantity) VALUES ($1, $2, $3, $4, 1)", [
          A.tenantId,
          rid,
          A.dimensionId,
          A.documentLineNoneId,
        ]);
      }
      await q("UPDATE public.stock_balances SET reserved_quantity = reserved_quantity + 3 WHERE tenant_id = $1 AND stock_dimension_id = $2", [A.tenantId, A.dimensionId]);
    });
  }, 60_000);

  it("acquireStockLocks: iki yönde ters sıralı boyut ve rezervasyon planları; belge yok; her tur yeni satırlar; deadlock'suz", async () => {
    const reservations = [A.reservationId, ...extraReservations];
    for (let round = 0; round < 6; round++) {
      lastLocation = await freshLocation();
      const keys = roundKeys(lastLocation);
      const forward = empty({ dimensions: keys, reservationIds: reservations });
      const backward = empty({ dimensions: [...keys].reverse(), reservationIds: [...reservations].reverse() });
      const outcomes = await Promise.all([sqlstateOf(run(forward, hold)), sqlstateOf(run(backward, hold)), sqlstateOf(run(forward, hold)), sqlstateOf(run(backward, hold))]);
      expect(outcomes).toEqual([undefined, undefined, undefined, undefined]);
    }
  }, 120_000);

  it("kontrol: AYNI satır kümesi (son turun 8 bakiyesi) elle ters sırayla kilitlenince 40P01 üretir (eşzamanlılık gerçek)", async () => {
    const seeded = await run(empty({ dimensions: roundKeys(lastLocation) }));
    const ids = seeded.dimensions.map((d) => d.id);
    expect(ids).toHaveLength(8);
    const lockAll = (order: string[]) =>
      withTenant(ctxA, async (tx) => {
        for (const [n, id] of order.entries()) {
          await tx.execute(`SELECT 1 FROM public.stock_balances WHERE tenant_id = '${A.tenantId}'::uuid AND stock_dimension_id = '${id}'::uuid FOR UPDATE`);
          if (n === 0) await tx.execute("SELECT pg_sleep(0.3)");
        }
      });
    const results = await Promise.all([sqlstateOf(lockAll(ids)), sqlstateOf(lockAll([...ids].reverse()))]);
    expect(results.filter((r) => r === "40P01")).toHaveLength(1);
  }, 30_000);
});

describe("sayım kilidi", () => {
  const session = randomUUID();
  const setCounting = (locationId: string, counting: boolean) =>
    adminTx(A.tenantId, async (q) => {
      if (counting) {
        await q(
          "UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE tenant_id = $1 AND location_id = $4",
          [A.tenantId, session, A.ownerMembershipId, locationId],
        );
      } else {
        await q("UPDATE public.location_count_locks SET status = 'IDLE', count_session_id = NULL, locked_at = NULL, locked_by = NULL WHERE tenant_id = $1 AND location_id = $2", [
          A.tenantId,
          locationId,
        ]);
      }
    });

  it("COUNTING lokasyon → LOCATION_LOCKED; oturumlu istisna yalnızca tüm lokasyonlar aynı oturumdaysa", async () => {
    await setCounting(A.childLocationId, true);
    try {
      expect(await codeOf(run(empty({ locationIds: [A.rootLocationId, A.childLocationId] })))).toBe("LOCATION_LOCKED");
      expect(await codeOf(run(empty({ locationIds: [A.childLocationId] })))).toBe("LOCATION_LOCKED");
      // Başka oturum kimliği ve IDLE kardeş lokasyon: istisna yok.
      expect(await codeOf(run(empty({ locationIds: [A.childLocationId], countSessionId: randomUUID() })))).toBe("LOCATION_LOCKED");
      expect(await codeOf(run(empty({ locationIds: [A.rootLocationId, A.childLocationId], countSessionId: session })))).toBe("LOCATION_LOCKED");
      const ok = await run(empty({ locationIds: [A.childLocationId], countSessionId: session }));
      expect(ok.locations).toEqual([{ locationId: A.childLocationId, status: "COUNTING", countSessionId: session }]);
      // Kilit reddi sonraki adımlara geçmez: boyut/bakiye oluşmaz.
      const before = await withTenant(ctxA, (tx) => tx.execute<{ n: string }>(`SELECT count(*)::text AS n FROM public.stock_dimensions WHERE tenant_id = '${A.tenantId}'::uuid`));
      expect(await codeOf(run(empty({ locationIds: [A.childLocationId], dimensions: [dim(A.itemNoneId, A.childLocationId, { stockStatus: "BLOCKED", inventoryOwnerId: A.ownerId })] })))).toBe("LOCATION_LOCKED");
      const after = await withTenant(ctxA, (tx) => tx.execute<{ n: string }>(`SELECT count(*)::text AS n FROM public.stock_dimensions WHERE tenant_id = '${A.tenantId}'::uuid`));
      expect(after[0]?.n).toBe(before[0]?.n);
      // MAJOR-4: boyutu COUNTING lokasyonda olup locationIds'te unutulmuş plan da reddedilir (denetim = locationIds ∪ boyut lokasyonları).
      const forgotten = dim(A.itemNoneId, A.childLocationId, { stockStatus: "DAMAGED", inventoryOwnerId: A.ownerId });
      expect(await codeOf(run(empty({ dimensions: [forgotten] })))).toBe("LOCATION_LOCKED");
      const after2 = await withTenant(ctxA, (tx) => tx.execute<{ n: string }>(`SELECT count(*)::text AS n FROM public.stock_dimensions WHERE tenant_id = '${A.tenantId}'::uuid`));
      expect(after2[0]?.n).toBe(before[0]?.n);
      // Oturumlu istisna boyut lokasyonunu da kapsar: aynı oturumdaki COUNTING lokasyonda boyut kabul edilir.
      const okDim = await run(empty({ dimensions: [forgotten], countSessionId: session }));
      expect(okDim.locations).toEqual([{ locationId: A.childLocationId, status: "COUNTING", countSessionId: session }]);
      // Kapsanan lokasyon yokken countSessionId → VALIDATION_FAILED.
      expect(await codeOf(run(empty({ countSessionId: session })))).toBe("VALIDATION_FAILED");
    } finally {
      await setCounting(A.childLocationId, false);
    }
    expect((await run(empty({ locationIds: [A.childLocationId] }))).locations[0]?.status).toBe("IDLE");
  }, 30_000);

  it("kilit satırı silinmiş lokasyon (fikstür: migration rolü) → COUNT_LOCK_ROW_MISSING", async () => {
    const locationId = randomUUID();
    await adminTx(A.tenantId, async (q) => {
      await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, NULL, $4, 'T210 kilitsiz', 0, 'STORAGE')", [
        A.tenantId,
        locationId,
        A.warehouseId,
        `T210-${locationId.slice(0, 8)}`,
      ]);
      await q("DELETE FROM public.location_count_locks WHERE tenant_id = $1 AND location_id = $2", [A.tenantId, locationId]);
    });
    try {
      expect(await codeOf(run(empty({ locationIds: [locationId] })))).toBe("COUNT_LOCK_ROW_MISSING");
    } finally {
      await adminTx(A.tenantId, async (q) => {
        await q("DELETE FROM public.locations WHERE tenant_id = $1 AND id = $2", [A.tenantId, locationId]);
      });
    }
  }, 30_000);
});

describe("belge sürümü", () => {
  it("sürüm uyuşmazlığı → VERSION_CONFLICT; eşleşince kilitlenir", async () => {
    expect(await codeOf(run(empty({ document: { id: A.documentId, expectedVersion: 2 } })))).toBe("VERSION_CONFLICT");
    expect((await run(empty({ document: { id: A.documentId, expectedVersion: 1 } }))).document).toMatchObject({ id: A.documentId, version: 1 });
  });
  it("belge kilidi eşzamanlı sürüm artışını bekler: kilit tutulurken diğer transaction'ın kilidi bekler", async () => {
    let releaseSecondStarted = 0;
    const first = run(empty({ document: { id: A.documentId, expectedVersion: 1 } }), async (tx) => {
      const t0 = performance.now();
      await tx.execute("SELECT pg_sleep(0.6)");
      releaseSecondStarted = performance.now() - t0;
    });
    await new Promise((r) => setTimeout(r, 150));
    const t1 = performance.now();
    await run(empty({ document: { id: A.documentId, expectedVersion: 1 } }));
    const waited = performance.now() - t1;
    await first;
    expect(releaseSecondStarted).toBeGreaterThan(500);
    expect(waited).toBeGreaterThan(300);
  }, 30_000);
});
