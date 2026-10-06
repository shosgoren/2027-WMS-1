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
  // işlev KAPALI ÇÖKER (42501, sessiz atlama yok). Migration (Q-56) inince bu test `state.serials` beklentisine çevrilir.
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
  it("seri kilidi bayrak AÇIKKEN bugün wms_app UPDATE yetkisi olmadığından 42501 ile kapalı çöker (Q-56)", async () => {
    expect(await withSerialFlag("true", () => sqlstateOf(run(empty({ serialIds: [A.serialId] }))))).toBe("42501");
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

  // T-238 (MINOR-6): lot/seri NULL ile dolu değer AYNI (item, location) önekinde yan yana. Gerçek tabloya eklenemez (takip modu tetikleyicisi lot/seri
  // doluluğunu üründe sabitler), bu yüzden uygulamanın NORMALİZE ETTİĞİ sıra, boyut eklemesi sorgusuna giden JSON'dan yakalanır (sorgu çalıştırılmaz,
  // transaction geri alınır) ve PostgreSQL'e AYNI satırlarda `ORDER BY … NULLS FIRST` yaptırılarak karşılaştırılır.
  it("lot/seri NULL + dolu karışımı (aynı item/location öneki): uygulama sırası = DB ORDER BY NULLS FIRST", async () => {
    // Lokasyonlar gerçek (sayım kilidi adımı onları görmeli); ürün/lot/seri/sahip rastgele (boyut ekleme sorgusu çalıştırılmaz).
    const [itemA, itemB, lot1, lot2, ser1, ser2, owner] = Array.from({ length: 7 }, () => randomUUID());
    const [locA, locB] = [A.rootLocationId, A.childLocationId];
    const keys: StockDimensionKey[] = [];
    for (const itemId of [itemA as string, itemB as string]) {
      for (const locationId of [locA as string, locB as string]) {
        for (const lotId of [null, lot1 as string, lot2 as string]) {
          for (const serialId of [null, ser1 as string, ser2 as string]) {
            for (const stockStatus of ["AVAILABLE", "BLOCKED"] as const) {
              for (const inventoryOwnerId of [null, owner as string]) {
                for (const handlingUnitId of [null, A.handlingUnitId]) keys.push(dim(itemId, locationId, { lotId, serialId, stockStatus, inventoryOwnerId, handlingUnitId }));
              }
            }
          }
        }
      }
    }
    expect(keys).toHaveLength(2 * 2 * 3 * 3 * 2 * 2 * 2);
    const shuffled = [...keys].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? 1 : -1));
    // `tx.execute` çağrılarını izleyen vekil: boyut ekleme sorgusunun JSON parametresini yakalar, sorguyu çalıştırmadan keser.
    const textOf = (q: unknown, out: { text: string; json: string | undefined }): void => {
      const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
      if (!Array.isArray(chunks)) return;
      for (const c of chunks) {
        const o = c as { value?: unknown; queryChunks?: unknown[] } | string | null;
        if (typeof o === "string") {
          if (o.startsWith("[")) out.json = o;
        } else if (o !== null && Array.isArray(o.queryChunks)) textOf(o, out);
        else if (o !== null && Array.isArray(o.value)) out.text += (o.value as string[]).join("");
        else if (o !== null && typeof o.value === "string" && o.value.startsWith("[")) out.json = o.value;
      }
    };
    let captured: string | undefined;
    class Captured extends Error {}
    await withTenant(ctxA, async (tx) => {
      const spy = new Proxy(tx, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target) as unknown;
          if (prop !== "execute") return v;
          return (q: unknown, ...rest: unknown[]) => {
            if (typeof q !== "string") {
              const seen = { text: "", json: undefined as string | undefined };
              textOf(q, seen);
              if (seen.text.includes("INSERT INTO public.stock_dimensions") && seen.json !== undefined) {
                captured = seen.json;
                throw new Captured("captured");
              }
            }
            return (v as (...a: unknown[]) => unknown).call(target, q, ...rest);
          };
        },
      });
      await acquireStockLocks(spy, A.tenantId, empty({ dimensions: shuffled }));
    }).catch((e: unknown) => {
      if (captured === undefined) throw e;
    });
    expect(captured).toBeDefined();
    const sent = JSON.parse(captured as string) as { ord: number; item_id: string; lot_id: string | null; serial_id: string | null; location_id: string }[];
    expect(sent).toHaveLength(keys.length);
    expect(sent.map((r) => r.ord)).toEqual(sent.map((_r, i) => i));
    // Karışım gerçekten var: aynı (item, location) önekinde hem NULL hem dolu lot/seri.
    const prefix = sent.filter((r) => r.item_id === itemA && r.location_id === locA);
    expect(prefix.some((r) => r.lot_id === null)).toBe(true);
    expect(prefix.some((r) => r.lot_id !== null)).toBe(true);
    expect(prefix.some((r) => r.serial_id === null)).toBe(true);
    expect(prefix.some((r) => r.serial_id !== null)).toBe(true);
    const rows = await withTenant(ctxA, (tx) =>
      // Yalnızca bu testin ürettiği rastgele UUID/sabit sözcüklerden oluşan JSON; değişmez (kullanıcı girdisi yok).
      tx.execute<{ ord: number }>(
        `SELECT w.ord FROM jsonb_to_recordset('${captured as string}'::jsonb) AS w(ord int, item_id uuid, location_id uuid, lot_id uuid, serial_id uuid, stock_status text, inventory_owner_id uuid, handling_unit_id uuid)
          ORDER BY w.item_id, w.location_id, w.lot_id NULLS FIRST, w.serial_id NULLS FIRST, w.stock_status, w.inventory_owner_id NULLS FIRST, w.handling_unit_id NULLS FIRST`,
      ),
    );
    expect(rows.map((r) => Number(r.ord))).toEqual(sent.map((r) => r.ord));
  });
});

describe("eşzamanlı ters sıralı planlar: deadlock yok (bariyerli, olasılıksız)", () => {
  // T-238 (T-210 son inceleme MINOR-2/3): zamanlamaya (pg_sleep) DAYANMAZ.
  //  * Her taraf kendi transaction'ında önce `ALIVE` kilidini (advisory 238,i) alır; JS kapısı iki tarafın da yaşadığını garantiler.
  //  * `zz_t238_dimension_barrier` (yalnızca bu testin lokasyonunda etkin; `t238.loc` ayarı yoksa hiçbir şey yapmaz) her tarafın 2. boyut
  //    satırından ÖNCE bariyer kurar: karşı taraf da bariyere gelene, ya da karşı tarafı BENİM kilidim bekletene, ya da karşı taraf bitene dek bekler.
  //    Böylece sıralama yokken iki taraf da ilk satırını eklemiş olarak karşı satıra gider => 40P01 HER koşuda; sıralıyken ikinci taraf
  //    ilk satırda birinciyi bekler (bariyer "beni bekliyor" koşuluyla açılır) => deadlock imkânsızdır.
  // Mutasyon kanıtı: `normalizePlan` içindeki `.sort(compareDimensionKeys)` kaldırılınca bu test her koşuda kırmızıdır (rapor: 10/10).
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
  /** İki tarafın birlikte geçtiği kapı; bir taraf düşerse diğeri takılı kalmasın diye zaman aşımı vardır. */
  const makeGate = (parties: number) => {
    let arrived = 0;
    const waiters: (() => void)[] = [];
    return {
      arrive: (): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("t238 gate timeout")), 30_000);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
          if (++arrived === parties) for (const w of waiters) w();
        }),
    };
  };
  type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
  /** Taraf `me` (1|2): kimlik/lokasyon ayarları + ALIVE kilidi, kapı, sonra iş. */
  const party = <T,>(me: 1 | 2, locationId: string, gate: ReturnType<typeof makeGate>, work: (tx: Tx) => Promise<T>): Promise<T> =>
    withTenant(ctxA, async (tx) => {
      await tx.execute(`SELECT set_config('t238.me', '${me}', true), set_config('t238.loc', '${locationId}', true), pg_advisory_xact_lock(238, ${me})`);
      await gate.arrive();
      return work(tx);
    });

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
    await admin.query(`
      CREATE OR REPLACE FUNCTION public.t238_dimension_barrier() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE
        loc text := nullif(current_setting('t238.loc', true), '');
        me int; other int; n int;
        t0 timestamptz := clock_timestamp();
      BEGIN
        IF loc IS NULL OR NEW.location_id::text <> loc THEN RETURN NEW; END IF;
        me := current_setting('t238.me')::int;
        other := 3 - me;
        n := coalesce(nullif(current_setting('t238.n', true), ''), '0')::int + 1;
        PERFORM set_config('t238.n', n::text, true);
        IF n <> 2 THEN RETURN NEW; END IF;
        PERFORM pg_advisory_xact_lock(238, 10 + me);
        LOOP
          EXIT WHEN EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 238::oid AND objid = (10 + other)::oid AND granted)
            OR NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 238::oid AND objid = other::oid AND granted)
            OR EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                        WHERE l.locktype = 'advisory' AND l.classid = 238::oid AND l.objid = other::oid AND l.granted
                          AND pg_backend_pid() = ANY (pg_blocking_pids(a.pid)));
          IF clock_timestamp() - t0 > interval '30 seconds' THEN RAISE EXCEPTION 't238 barrier timeout'; END IF;
          PERFORM pg_sleep(0.005);
        END LOOP;
        RETURN NEW;
      END
      $fn$`);
    await admin.query("DROP TRIGGER IF EXISTS zz_t238_dimension_barrier ON public.stock_dimensions");
    await admin.query("CREATE TRIGGER zz_t238_dimension_barrier BEFORE INSERT ON public.stock_dimensions FOR EACH ROW EXECUTE FUNCTION public.t238_dimension_barrier()");
  }, 60_000);

  afterAll(async () => {
    await admin.query("DROP TRIGGER IF EXISTS zz_t238_dimension_barrier ON public.stock_dimensions");
    await admin.query("DROP FUNCTION IF EXISTS public.t238_dimension_barrier()");
  }, 60_000);

  it("acquireStockLocks: bariyerde buluşan iki işlem, ters sıralı boyut ve rezervasyon planları; her tur taze lokasyon; deadlock'suz", async () => {
    const reservations = [A.reservationId, ...extraReservations];
    for (let round = 0; round < 3; round++) {
      const locationId = await freshLocation();
      const keys = roundKeys(locationId);
      const forward = empty({ dimensions: keys, reservationIds: reservations });
      const backward = empty({ dimensions: [...keys].reverse(), reservationIds: [...reservations].reverse() });
      const gate = makeGate(2);
      const outcomes = await Promise.all([
        sqlstateOf(party(1, locationId, gate, (tx) => acquireStockLocks(tx, A.tenantId, forward))),
        sqlstateOf(party(2, locationId, gate, (tx) => acquireStockLocks(tx, A.tenantId, backward))),
      ]);
      expect(outcomes).toEqual([undefined, undefined]);
    }
  }, 120_000);

  it("kontrol 1 (donanım): AYNI bariyer, ters sırayla elle eklenen iki satırda her koşuda tam bir 40P01 üretir", async () => {
    const locationId = await freshLocation();
    const row = (status: string) => `('${A.tenantId}'::uuid, '${A.itemNoneId}'::uuid, '${locationId}'::uuid, NULL, NULL, '${status}', NULL, NULL)`;
    const insert = (rows: string[]) => (tx: Tx) =>
      tx.execute(
        `INSERT INTO public.stock_dimensions (tenant_id, item_id, location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id) VALUES ${rows.join(", ")}`,
      );
    const a = row("AVAILABLE");
    const b = row("QUARANTINE");
    const gate = makeGate(2);
    const results = await Promise.all([sqlstateOf(party(1, locationId, gate, insert([a, b]))), sqlstateOf(party(2, locationId, gate, insert([b, a])))]);
    expect(results.filter((r) => r === "40P01")).toHaveLength(1);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
  }, 30_000);

  it("kontrol 2: AYNI satır kümesi (kendi lokasyonu; 8 bakiye) elle ters sırayla kilitlenince JS kapısıyla her koşuda tam bir 40P01 üretir", async () => {
    const locationId = await freshLocation();
    const seeded = await run(empty({ dimensions: roundKeys(locationId) }));
    const ids = seeded.dimensions.map((d) => d.id);
    expect(ids).toHaveLength(8);
    const gate = makeGate(2);
    const lockAll = (order: string[]) =>
      withTenant(ctxA, async (tx) => {
        for (const [n, id] of order.entries()) {
          await tx.execute(`SELECT 1 FROM public.stock_balances WHERE tenant_id = '${A.tenantId}'::uuid AND stock_dimension_id = '${id}'::uuid FOR UPDATE`);
          if (n === 0) await gate.arrive(); // iki taraf da ilk kilidi aldıktan sonra karşı kilide gider
        }
      });
    const results = await Promise.all([sqlstateOf(lockAll(ids)), sqlstateOf(lockAll([...ids].reverse()))]);
    expect(results.filter((r) => r === "40P01")).toHaveLength(1);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
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
