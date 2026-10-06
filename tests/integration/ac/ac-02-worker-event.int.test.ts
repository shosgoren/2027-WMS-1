// AC-02 (worker olayı kolu) — bağımsız kabul testi (T-218, qa-verifier). Stok kolu T-220'dedir.
//
// Katman: ENTEGRASYON (gerçek PostgreSQL + PgBouncer transaction mode, gerçek roller wms_app/wms_worker/wms_auth/wms_ops).
// Mock yok. RLS kanıtları `wms_app` (DATABASE_URL) ile; DATABASE_URL_DIRECT yalnızca fikstür kurulumu/temizlik/katalog okuması.
// Veriler sentetik UUID'lerdir (G-09). Yazma denemeleri BEGIN ... ROLLBACK içindedir: stock_consistency_signals append-only'dir
// (silinemez) ve başka testlerin sayımlarını kirletmemelidir.
//
// AC-02: "Aynı stok isteği / worker olayı tekrar → tek etki, önceki sonuç." Tekillik `(tenant_id, consumer, event_id)` (ADR-019 §2).
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant, withUser } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { consumeOnce, type TenantTx } from "../../../packages/queue-adapter/src/index.ts";
import { PLATFORM_NO_USER_ID } from "../../../packages/shared/src/queue.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

// `drizzle-orm` yalnızca paketlerin bağımlılığıdır; kökten çözülemez → packages/db çözümleyicisi.
const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/db/package.json"));
const { sql } = (await import(pathToFileURL(dbRequire.resolve("drizzle-orm")).href)) as typeof import("../../../packages/db/node_modules/drizzle-orm/index.js");

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const CONSUMER = "t218.ac02.effect";
const EFFECTS = "t218_ac02_effects";
const PROBE_FN = "wms_probe.active_tenant_ids(uuid, integer)";
const SYSTEM_REASON = "queue.stock.consistency.check";

let admin: pg.Client;
let client: DbClient;
const tenants: string[] = [];

async function mkTenant(): Promise<string> {
  const id = randomUUID();
  await admin.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, 'ACTIVE')", [id, `t218c-${id.slice(0, 8)}`, "T218 tenant"]);
  tenants.push(id);
  return id;
}

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? [])) as Record<string, unknown>[];

const writeEffect = (tx: TenantTx, eventId: string) =>
  tx.execute(sql`INSERT INTO ${sql.identifier(EFFECTS)} (tenant_id, event_id) VALUES (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, ${eventId}::uuid)`);

const effectRows = async (eventId: string) => (await admin.query<{ tenant_id: string | null }>(`SELECT tenant_id FROM public.${EFFECTS} WHERE event_id = $1`, [eventId])).rows;

/** Bir bağlantı üzerinde tek transaction; her zaman ROLLBACK (kalıcı iz bırakmaz). */
async function inRolledBackTx<T>(url: string, tenantId: string | undefined, systemReason: string | undefined, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  await c.connect();
  try {
    await c.query("BEGIN");
    if (tenantId !== undefined) await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    if (systemReason !== undefined) await c.query("SELECT set_config('app.system_reason', $1, true)", [systemReason]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

/** Sorgu `42501` ile reddedilmeli; reddedilen ifade transaction'ı bozar, bu yüzden çağrı başına yeni bağlantı kullanılır. */
async function expect42501(url: string, tenantId: string | undefined, systemReason: string | undefined, text: string, params: unknown[] = []): Promise<void> {
  await inRolledBackTx(url, tenantId, systemReason, async (c) => {
    await expect(c.query(text, params)).rejects.toMatchObject({ code: "42501" });
  });
}

beforeAll(async () => {
  client = createDbClient({ url: env.databaseUrl, ...DB_CLIENT_SETTINGS });
  admin = new pg.Client({ connectionString: env.databaseUrlDirect });
  admin.on("error", () => undefined);
  await admin.connect();
  await admin.query(`CREATE TABLE IF NOT EXISTS public.${EFFECTS} (tenant_id uuid, event_id uuid NOT NULL)`);
  await admin.query(`GRANT SELECT, INSERT ON public.${EFFECTS} TO wms_app`);
});

afterAll(async () => {
  await admin.query(`DROP TABLE IF EXISTS public.${EFFECTS}`);
  await admin.query("DELETE FROM public.processed_events WHERE consumer = $1", [CONSUMER]);
  if (tenants.length > 0) {
    await admin.query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [tenants]);
  }
  await admin.end();
  await client.close();
});

describe("AC-02 worker olayı: tekrar → tek etki, önceki sonuç", () => {
  it("@AC-02 aynı (tenant, consumer, olay kimliği) ikinci consumeOnce → applied=false, fn çalışmaz, etki tek", async () => {
    const tenantId = await mkTenant();
    const eventId = randomUUID();
    let fnCalls = 0;
    const run = () =>
      withTenant(createTenantContext(client, tenantId), (tx) =>
        consumeOnce(tx, CONSUMER, eventId, async (t) => {
          fnCalls += 1;
          await writeEffect(t, eventId);
          return "ilk-sonuç";
        }),
      );
    const first = await run();
    const second = await run();
    const third = await run();
    expect(first).toEqual({ applied: true, result: "ilk-sonuç" });
    expect(second).toEqual({ applied: false });
    expect(third).toEqual({ applied: false });
    expect(fnCalls).toBe(1);
    expect(await effectRows(eventId)).toEqual([{ tenant_id: tenantId }]);
  });

  it("@AC-02 fn hata fırlatırsa processed_events satırı da geri alınır → yeniden teslim etkiyi uygular (kayıp iş yok)", async () => {
    const tenantId = await mkTenant();
    const eventId = randomUUID();
    const ctx = createTenantContext(client, tenantId);
    await expect(
      withTenant(ctx, (tx) =>
        consumeOnce(tx, CONSUMER, eventId, async (t) => {
          await writeEffect(t, eventId);
          throw new Error("t218 etki hatası");
        }),
      ),
    ).rejects.toThrow("t218 etki hatası");
    expect(await effectRows(eventId)).toEqual([]);
    const again = await withTenant(ctx, (tx) => consumeOnce(tx, CONSUMER, eventId, (t) => writeEffect(t, eventId)));
    expect(again.applied).toBe(true);
    expect(await effectRows(eventId)).toHaveLength(1);
  });

  it("@AC-02 farklı tenant bağlamında aynı (consumer, olay kimliği) → İKİ ayrı etki; B'nin etkisi A'nın satırı yüzünden yutulmaz", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const eventId = randomUUID();
    const ra = await withTenant(createTenantContext(client, a), (tx) => consumeOnce(tx, CONSUMER, eventId, (t) => writeEffect(t, eventId)));
    const rb = await withTenant(createTenantContext(client, b), (tx) => consumeOnce(tx, CONSUMER, eventId, (t) => writeEffect(t, eventId)));
    expect(ra.applied).toBe(true);
    expect(rb.applied).toBe(true);
    expect((await effectRows(eventId)).map((r) => r.tenant_id).sort()).toEqual([a, b].sort());
    const pe = await admin.query<{ tenant_id: string }>("SELECT tenant_id FROM public.processed_events WHERE consumer = $1 AND event_id = $2", [CONSUMER, eventId]);
    expect(pe.rows.map((r) => r.tenant_id).sort()).toEqual([a, b].sort());
    // Her tenant kendi içinde yine tekilleşir.
    const rb2 = await withTenant(createTenantContext(client, b), (tx) => consumeOnce(tx, CONSUMER, eventId, (t) => writeEffect(t, eventId)));
    expect(rb2.applied).toBe(false);
    expect(await effectRows(eventId)).toHaveLength(2);
  });

  it("@AC-02 görünürlük: A'nın satırı B'den görünmez; tenant bağlamında platform (tenant_id NULL) satırı görünmez; platform bağlamında tenant satırı görünmez", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const eventId = randomUUID();
    await withTenant(createTenantContext(client, a), (tx) => consumeOnce(tx, CONSUMER, eventId, (t) => writeEffect(t, eventId)));
    // Platform satırı (tenant bağlamı boş wms_app transaction'ı): tekillik testi için aynı kimlikle.
    const platformEvent = randomUUID();
    const platformRes = await withUser(client, PLATFORM_NO_USER_ID, (tx) => consumeOnce(tx, CONSUMER, platformEvent, (t) => writeEffect(t, platformEvent)));
    expect(platformRes.applied).toBe(true);
    // Aynı kimlik platformda ikinci kez uygulanmaz.
    const platformAgain = await withUser(client, PLATFORM_NO_USER_ID, (tx) => consumeOnce(tx, CONSUMER, platformEvent, (t) => writeEffect(t, platformEvent)));
    expect(platformAgain.applied).toBe(false);

    const visible = (ctxTenant: string | null, ev: string) =>
      ctxTenant === null
        ? withUser(client, PLATFORM_NO_USER_ID, async (tx) => rowsOf(await tx.execute(sql`SELECT tenant_id FROM processed_events WHERE consumer = ${CONSUMER} AND event_id = ${ev}::uuid`)))
        : withTenant(createTenantContext(client, ctxTenant), async (tx) => rowsOf(await tx.execute(sql`SELECT tenant_id FROM processed_events WHERE consumer = ${CONSUMER} AND event_id = ${ev}::uuid`)));

    expect(await visible(a, eventId)).toEqual([{ tenant_id: a }]);
    expect(await visible(b, eventId), "B, A'nın satırını göremez").toEqual([]);
    expect(await visible(null, eventId), "platform bağlamı tenant satırını göremez").toEqual([]);
    expect(await visible(a, platformEvent), "tenant bağlamında platform satırı görünmez").toEqual([]);
    expect(await visible(b, platformEvent)).toEqual([]);
    expect(await visible(null, platformEvent)).toEqual([{ tenant_id: null }]);
    // Platform satırının varlığı tenant'ın aynı kimliği işlemesini engellemez (NULL ayrı kapsam).
    const tenantSame = await withTenant(createTenantContext(client, a), (tx) => consumeOnce(tx, CONSUMER, platformEvent, (t) => writeEffect(t, platformEvent)));
    expect(tenantSame.applied).toBe(true);
  });
});

describe("AC-02 / B-2: güvenilirlik tabloları rol ayrımı", () => {
  it("@AC-02 wms_app: processed_events, stock_consistency_runs ve stock_consistency_signals yazımı (system_reason ile) çalışır; sebepsiz/yanlış tenant 42501", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const runCols = "(tenant_id, job_id, started_at, finished_at, status, checked_dimensions, mismatch_count)";
    const runVals = (t: string) => [t, randomUUID()];
    const runSql = `INSERT INTO public.stock_consistency_runs ${runCols} VALUES ($1, $2, now(), now(), 'OK', 3, 0)`;

    await inRolledBackTx(env.databaseUrl, a, undefined, async (c) => {
      const r = await c.query("INSERT INTO public.processed_events (tenant_id, consumer, event_id) VALUES ($1, $2, $3)", [a, CONSUMER, randomUUID()]);
      expect(r.rowCount).toBe(1);
    });
    await inRolledBackTx(env.databaseUrl, a, SYSTEM_REASON, async (c) => {
      expect((await c.query(runSql, runVals(a))).rowCount).toBe(1);
    });
    await inRolledBackTx(env.databaseUrl, undefined, SYSTEM_REASON, async (c) => {
      expect((await c.query("INSERT INTO public.stock_consistency_signals (status, mismatch_count) VALUES ('OK', 0)")).rowCount).toBe(1);
    });

    // system_reason yok → RLS WITH CHECK reddi.
    await expect42501(env.databaseUrl, a, undefined, runSql, runVals(a));
    await expect42501(env.databaseUrl, undefined, undefined, "INSERT INTO public.stock_consistency_signals (status, mismatch_count) VALUES ('OK', 0)");
    // Yanlış sebep.
    await expect42501(env.databaseUrl, a, "baska.sebep", runSql, runVals(a));
    // Tenant A bağlamında B için koşu satırı yazılamaz.
    await expect42501(env.databaseUrl, a, SYSTEM_REASON, runSql, runVals(b));
    // wms_app signals tablosunu okuyamaz.
    await expect42501(env.databaseUrl, undefined, SYSTEM_REASON, "SELECT 1 FROM public.stock_consistency_signals");
  });

  it("@AC-02 wms_worker: processed_events, stock_consistency_runs, stock_consistency_signals okuma ve yazma → 42501", async () => {
    const a = await mkTenant();
    for (const t of ["processed_events", "stock_consistency_runs", "stock_consistency_signals"]) {
      await expect42501(workerUrl, a, SYSTEM_REASON, `SELECT 1 FROM public.${t}`);
    }
    await expect42501(workerUrl, a, SYSTEM_REASON, "INSERT INTO public.processed_events (tenant_id, consumer, event_id) VALUES ($1, $2, $3)", [a, CONSUMER, randomUUID()]);
    await expect42501(workerUrl, a, SYSTEM_REASON, "INSERT INTO public.stock_consistency_runs (tenant_id, job_id, started_at, finished_at, status, checked_dimensions, mismatch_count) VALUES ($1, $2, now(), now(), 'OK', 1, 0)", [a, randomUUID()]);
    await expect42501(workerUrl, undefined, SYSTEM_REASON, "INSERT INTO public.stock_consistency_signals (status, mismatch_count) VALUES ('OK', 0)");
    // Katalog: wms_worker public şemasında hiçbir tablo yetkisi taşımaz.
    const g = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM information_schema.role_table_grants WHERE grantee = 'wms_worker' AND table_schema = 'public'");
    expect(g.rows[0]?.n).toBe("0");
  });

  it("@AC-02 wms_probe.active_tenant_ids: EXECUTE yalnızca wms_worker'da (katalog); PUBLIC/wms_app/wms_auth/wms_ops yok; wms_worker çağırabilir, wms_app 42501", async () => {
    const priv = async (role: string): Promise<boolean> =>
      (await admin.query<{ v: boolean }>("SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS v", [role, PROBE_FN])).rows[0]?.v === true;
    expect(await priv("wms_worker")).toBe(true);
    for (const role of ["wms_app", "wms_auth", "wms_ops"]) expect(await priv(role), `${role} EXECUTE`).toBe(false);

    // Süper kullanıcı olmayan hiçbir rol (sahip hariç) EXECUTE taşımamalı; PUBLIC (grantee 0) yok.
    const holders = await admin.query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_roles r
        WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
          AND has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE')
        ORDER BY r.rolname`,
      [PROBE_FN],
    );
    expect(holders.rows.map((r) => r.rolname)).toEqual(["wms_identity_probe", "wms_worker"]);
    const acl = await admin.query<{ grantee: string }>(
      `SELECT a.grantee::text AS grantee FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE'`,
      [PROBE_FN],
    );
    expect(acl.rows.some((r) => r.grantee === "0"), "PUBLIC EXECUTE yok").toBe(false);
    const names = await admin.query<{ rolname: string }>(`SELECT r.rolname FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE' ORDER BY r.rolname`, [PROBE_FN]);
    expect(names.rows.map((r) => r.rolname)).toEqual(["wms_identity_probe", "wms_worker"]);

    // Fiilî çağrı: wms_worker çalıştırır (sıfır-UUID sentinel + sınırlı sayfa), wms_app 42501.
    const w = new pg.Client({ connectionString: workerUrl });
    w.on("error", () => undefined);
    await w.connect();
    try {
      const r = await w.query("SELECT * FROM wms_probe.active_tenant_ids('00000000-0000-0000-0000-000000000000'::uuid, 5)");
      expect(r.rows.length).toBeLessThanOrEqual(5);
    } finally {
      await w.end();
    }
    await expect42501(env.databaseUrl, undefined, undefined, "SELECT * FROM wms_probe.active_tenant_ids('00000000-0000-0000-0000-000000000000'::uuid, 5)");
  });
});
