// Kuyruk tüketici sözleşmesi (T-214, ADR-019): gerçek pg-boss + gerçek roller (wms_app/wms_worker), PgBouncer.
// - Aynı iş iki kez teslim → yan etki tablosunda tek satır (gerçek yeniden teslim: iş durumu `created`'a geri alınır).
// - Tenant A işi B satırı yazamaz; A ve B'de aynı (consumer, event_id) iki ayrı etki üretir.
// - Platform `processed_events` (tenant_id NULL) satırları PAYLAŞILAN veritabanına COMMIT EDİLMEZ (Supervisor notu, AC-04
//   taraması): bu testte platform yolu rollback eden transaction içinde sınanır.
// Sentetik UUID'ler (G-09). Yan etki tablosu testin kendi tablosudur ve sonunda silinir.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant, withUser } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import {
  QUEUE_SCHEMA,
  consumeOnce,
  createJobQueue,
  installQueueSchema,
  type PgBossJobQueue,
  type TenantTx,
} from "../../../packages/queue-adapter/src/index.ts";
import { JOB_TYPES, QueueError, parseJob } from "../../../packages/shared/src/queue.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

// `drizzle-orm` yalnızca paketlerin bağımlılığıdır; kökten çözülemez → packages/db çözümleyicisi.
const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/db/package.json"));
const { sql } = (await import(pathToFileURL(dbRequire.resolve("drizzle-orm")).href)) as typeof import("../../../packages/db/node_modules/drizzle-orm/index.js");

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const CONSUMER = "t214.effect";
const EFFECTS = "t214_effects";
const NIL_USER = "00000000-0000-0000-0000-000000000000";

let admin: pg.Client;
let client: DbClient;
const queues: PgBossJobQueue[] = [];
const tenants: string[] = [];

class Rollback extends Error {}

async function mkTenant(): Promise<string> {
  const id = randomUUID();
  await admin.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, 'ACTIVE')", [id, `t214-${id.slice(0, 8)}`, "T214 tenant"]);
  tenants.push(id);
  return id;
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

const effectRows = async (tenantId: string, jobId?: string) =>
  (await admin.query(`SELECT job_id FROM public.${EFFECTS} WHERE tenant_id = $1 ${jobId === undefined ? "" : "AND job_id = $2"}`, jobId === undefined ? [tenantId] : [tenantId, jobId])).rows;

/** Yan etki: tenant bağlamından türeyen tenant_id ile tek satır. */
const writeEffect = (tx: TenantTx, jobId: string) =>
  tx.execute(sql`INSERT INTO ${sql.identifier(EFFECTS)} (tenant_id, job_id) VALUES (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, ${jobId}::uuid)`);

beforeAll(async () => {
  client = createDbClient({ url: env.databaseUrl, ...DB_CLIENT_SETTINGS });
  admin = new pg.Client({ connectionString: env.databaseUrlDirect });
  admin.on("error", () => undefined);
  await admin.connect();
  await installQueueSchema({ url: env.databaseUrlDirect });
  await admin.query(`CREATE TABLE IF NOT EXISTS public.${EFFECTS} (tenant_id uuid NOT NULL, job_id uuid NOT NULL)`);
  await admin.query(`GRANT SELECT, INSERT ON public.${EFFECTS} TO wms_app`);
});

afterEach(async () => {
  while (queues.length > 0) await queues.pop()?.stop();
});

afterAll(async () => {
  await admin.query(`DROP TABLE IF EXISTS public.${EFFECTS}`);
  if (tenants.length > 0) {
    await admin.query("DELETE FROM public.processed_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
    await admin.query(`DELETE FROM ${QUEUE_SCHEMA}.job WHERE data->>'tenantId' = ANY($1::text[])`, [tenants]);
    await admin.query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [tenants]);
  }
  await admin.end();
  await client.close();
});

function queueFor(): PgBossJobQueue {
  const q = createJobQueue({
    connectionString: workerUrl,
    max: 3,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 5000,
    runInTenant: (tenantId, _reason, fn) => withTenant(createTenantContext(client, tenantId), fn),
    runPlatform: (fn) => withUser(client, NIL_USER, fn),
  });
  queues.push(q);
  return q;
}

describe("consumeOnce: gerçek pg-boss", () => {
  it("aynı iş iki kez teslim edilir → yan etki tablosunda tek satır", async () => {
    const tenantId = await mkTenant();
    const q = queueFor();
    await q.start();
    const seen: string[] = [];
    await q.work("demo.reseed", async (ctx) => {
      seen.push(ctx.jobId);
      await ctx.inTenant((tx) => consumeOnce(tx, CONSUMER, ctx.jobId, (t) => writeEffect(t, ctx.jobId)));
    });
    const { jobId } = await withTenant(createTenantContext(client, tenantId), (tx) => q.enqueue(tx, { type: "demo.reseed", payload: {} }));
    expect(jobId).not.toBeNull();
    const id = jobId as string;
    await waitFor(() => seen.length === 1, "ilk teslim");
    await waitFor(async () => (await admin.query(`SELECT state FROM ${QUEUE_SCHEMA}.job WHERE id = $1`, [id])).rows[0]?.state === "completed", "completed");
    // Gerçek yeniden teslim: tamamlanmış işi aynı kimlikle yeniden alınabilir yap.
    await admin.query(`UPDATE ${QUEUE_SCHEMA}.job SET state = 'created', completed_on = NULL, started_on = NULL WHERE id = $1`, [id]);
    await waitFor(() => seen.length === 2, "ikinci teslim");
    await waitFor(async () => (await admin.query(`SELECT state FROM ${QUEUE_SCHEMA}.job WHERE id = $1`, [id])).rows[0]?.state === "completed", "completed 2");
    expect(seen).toEqual([id, id]);
    expect(await effectRows(tenantId, id)).toHaveLength(1);
    const pe = await admin.query("SELECT 1 FROM public.processed_events WHERE tenant_id = $1 AND consumer = $2 AND event_id = $3", [tenantId, CONSUMER, id]);
    expect(pe.rows).toHaveLength(1);
  });

  it("eşzamanlı iki tüketici aynı olayı uygular → tek yan etki (tekillik savunması)", async () => {
    const tenantId = await mkTenant();
    const eventId = randomUUID();
    const ctx = createTenantContext(client, tenantId);
    const run = () => withTenant(ctx, (tx) => consumeOnce(tx, CONSUMER, eventId, (t) => writeEffect(t, eventId)));
    const results = await Promise.all([run(), run(), run()]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await effectRows(tenantId, eventId)).toHaveLength(1);
  });

  it("A ve B'de aynı (consumer, event_id) iki ayrı etki üretir", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const eventId = randomUUID();
    for (const t of [a, b]) {
      const r = await withTenant(createTenantContext(client, t), (tx) => consumeOnce(tx, CONSUMER, eventId, (x) => writeEffect(x, eventId)));
      expect(r.applied).toBe(true);
    }
    expect(await effectRows(a, eventId)).toHaveLength(1);
    expect(await effectRows(b, eventId)).toHaveLength(1);
    const pe = await admin.query("SELECT tenant_id FROM public.processed_events WHERE consumer = $1 AND event_id = $2", [CONSUMER, eventId]);
    expect(pe.rows.map((r) => r.tenant_id).sort()).toEqual([a, b].sort());
  });

  it("tenant A bağlamı B tenant'ı için processed_events satırı yazamaz (RLS)", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const app = new pg.Client({ connectionString: env.databaseUrl });
    app.on("error", () => undefined);
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [a]);
      await expect(app.query("INSERT INTO public.processed_events (tenant_id, consumer, event_id) VALUES ($1, $2, $3)", [b, CONSUMER, randomUUID()])).rejects.toMatchObject({ code: "42501" });
      await app.query("ROLLBACK");
      // Tenant bağlamı doluyken NULL (platform) satırı da yazılamaz.
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [a]);
      await expect(app.query("INSERT INTO public.processed_events (tenant_id, consumer, event_id) VALUES (NULL, $1, $2)", [CONSUMER, randomUUID()])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
      await app.end();
    }
  });

  it("platform işi: tenant bağlamı boş transaction'da tenant_id NULL, ikinci çağrıda etki yok (rollback; commit yok)", async () => {
    const eventId = randomUUID();
    await expect(
      withUser(client, NIL_USER, async (tx) => {
        const fn = (t: TenantTx) => Promise.resolve(t);
        expect((await consumeOnce(tx, CONSUMER, eventId, fn)).applied).toBe(true);
        expect((await consumeOnce(tx, CONSUMER, eventId, fn)).applied).toBe(false);
        const r: unknown = await tx.execute(sql`SELECT count(*)::int AS n FROM processed_events WHERE tenant_id IS NULL AND consumer = ${CONSUMER} AND event_id = ${eventId}::uuid`);
        const rows = (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<{ n: number }>;
        expect(rows[0]?.n).toBe(1);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    const left = await admin.query("SELECT 1 FROM public.processed_events WHERE tenant_id IS NULL AND event_id = $1", [eventId]);
    expect(left.rows).toEqual([]);
  });
});

describe("Faz 2 iş türleri", () => {
  it("stock.document.post actorUserId'siz → VALIDATION_FAILED; ile → geçer; yük şeması strict", () => {
    const payload = { documentId: randomUUID(), idempotencyRecordId: randomUUID() };
    expect(() => parseJob({ type: "stock.document.post", payload })).toThrow(QueueError);
    try {
      parseJob({ type: "stock.document.post", payload });
    } catch (e) {
      expect((e as QueueError).code).toBe("VALIDATION_FAILED");
    }
    expect(parseJob({ type: "stock.document.post", payload, actorUserId: randomUUID() }).type).toBe("stock.document.post");
    expect(() => parseJob({ type: "stock.document.post", payload: { ...payload, extra: 1 }, actorUserId: randomUUID() })).toThrow(QueueError);
    expect(parseJob({ type: "stock.consistency.check", payload: {} }).type).toBe("stock.consistency.check");
    expect(() => parseJob({ type: "stock.consistency.check", payload: { x: 1 } })).toThrow(QueueError);
    expect(JOB_TYPES).toContain("stock.consistency.check");
  });

  it("enqueue: actorUserId'siz stock.document.post reddedilir ve iş yazılmaz", async () => {
    const tenantId = await mkTenant();
    const q = queueFor();
    await q.start();
    await expect(
      withTenant(createTenantContext(client, tenantId), (tx) =>
        q.enqueue(tx, { type: "stock.document.post", payload: { documentId: randomUUID(), idempotencyRecordId: randomUUID() } }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const n = await admin.query(`SELECT 1 FROM ${QUEUE_SCHEMA}.job WHERE data->>'tenantId' = $1`, [tenantId]);
    expect(n.rows).toEqual([]);
  });

  it("zarfta actorUserId'si olmayan stock.document.post (elle yazılmış) tüketicide kalıcı hata; handler çağrılmaz", async () => {
    const tenantId = await mkTenant();
    const q = queueFor();
    let called = 0;
    await q.work("stock.document.post", () => {
      called += 1;
      return Promise.resolve();
    });
    const id = randomUUID();
    await admin.query(`INSERT INTO ${QUEUE_SCHEMA}.job (id, name, data) VALUES ($1, 'stock.document.post', $2::jsonb)`, [
      id,
      JSON.stringify({ v: 1, tenantId, actorUserId: null, payload: { documentId: randomUUID(), idempotencyRecordId: randomUUID() } }),
    ]);
    await waitFor(async () => (await admin.query(`SELECT state FROM ${QUEUE_SCHEMA}.job WHERE id = $1`, [id])).rows[0]?.state === "failed", "failed");
    expect(called).toBe(0);
  });

  it("worker açılış denetimi: her kayıtlı tür ya handler'a bağlanır ya DEFERRED_JOB_TYPES'ta (yeni türler açılışı düşürmez)", () => {
    // main.ts üst düzey süreçtir (import edilemez); `undecided` denetimini besleyen iki küme kaynaktan okunur.
    const src = readFileSync(path.resolve(import.meta.dirname, "../../../apps/worker/src/main.ts"), "utf8");
    const deferred = /const DEFERRED_JOB_TYPES[^=]*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? "";
    const handled = new Set([...src.matchAll(/HANDLERS\["([a-z.]+)"\]\s*=/g)].map((m) => m[1]));
    for (const type of JOB_TYPES) {
      expect(handled.has(type) || deferred.includes(`"${type}"`), type).toBe(true);
    }
    expect(deferred).toContain('"stock.document.post"');
    expect(deferred).toContain('"stock.consistency.check"');
  });
});
