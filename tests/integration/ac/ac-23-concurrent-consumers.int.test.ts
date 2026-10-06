// AC-23 — bağımsız kabul testi (T-218, qa-verifier).
//
// Katman: ENTEGRASYON (gerçek PostgreSQL + PgBouncer transaction mode, gerçek pg-boss 12.36, gerçek roller wms_app/wms_worker).
// Mock yok. Veriler sentetik UUID'lerdir (G-09).
//
// AC-23: "Aynı kuyruğu iki işleyici örneği eşzamanlı tüketir → hiçbir iş iki örnekte birlikte yürütülmez; toplam işlenen =
// toplam kuyruğa giren." İki ayrı `createJobQueue` örneği, her biri kendi pg-boss havuzu (wms_worker) ve kendi wms_app havuzuyla;
// 500 iş. İş başına yürütme sayacı ve "uçuşta" kümesi handler'da tutulur (üretim koduna bağlı olmayan bağımsız gözlem); yan etki
// `consumeOnce` ile yazılır, `processed_events` satır sayısı ayrıca doğrulanır.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { QUEUE_SCHEMA, consumeOnce, createJobQueue, installQueueSchema, type PgBossJobQueue, type TenantTx } from "../../../packages/queue-adapter/src/index.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

// `drizzle-orm` yalnızca paketlerin bağımlılığıdır; kökten çözülemez → packages/db çözümleyicisi.
const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/db/package.json"));
const { sql } = (await import(pathToFileURL(dbRequire.resolve("drizzle-orm")).href)) as typeof import("../../../packages/db/node_modules/drizzle-orm/index.js");

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const CONSUMER = "t218.ac23.effect";
const EFFECTS = "t218_ac23_effects";
const TOTAL = 500;
/** Örnek başına yoklayıcı sayısı: yoklama başına tek iş (batchSize 1) alındığından 500 iş makul sürede bitsin diye. */
const LOOPS_PER_INSTANCE = 6;

let admin: pg.Client;
const clients: DbClient[] = [];
const queues: PgBossJobQueue[] = [];
const tenants: string[] = [];
const jobIds: string[] = [];

async function mkTenant(): Promise<string> {
  const id = randomUUID();
  await admin.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, 'ACTIVE')", [id, `t218b-${id.slice(0, 8)}`, "T218 tenant"]);
  tenants.push(id);
  return id;
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: env.databaseUrlDirect });
  admin.on("error", () => undefined);
  await admin.connect();
  await installQueueSchema({ url: env.databaseUrlDirect });
  await admin.query(`CREATE TABLE IF NOT EXISTS public.${EFFECTS} (tenant_id uuid NOT NULL, job_id uuid NOT NULL)`);
  await admin.query(`GRANT SELECT, INSERT ON public.${EFFECTS} TO wms_app`);
});

afterEach(async () => {
  while (queues.length > 0) await queues.pop()?.stop();
  while (clients.length > 0) await clients.pop()?.close();
});

afterAll(async () => {
  await admin.query(`DROP TABLE IF EXISTS public.${EFFECTS}`);
  if (jobIds.length > 0) await admin.query(`DELETE FROM ${QUEUE_SCHEMA}.job WHERE id = ANY($1::uuid[])`, [jobIds]);
  await admin.query("DELETE FROM public.processed_events WHERE consumer = $1", [CONSUMER]);
  if (tenants.length > 0) await admin.query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await admin.end();
});

/** Bağımsız bir "işleyici örneği": kendi wms_app havuzu + kendi pg-boss havuzu (wms_worker). */
function newInstance(): { readonly queue: PgBossJobQueue; readonly client: DbClient } {
  const client = createDbClient({ url: env.databaseUrl, ...DB_CLIENT_SETTINGS });
  clients.push(client);
  const queue = createJobQueue({
    connectionString: workerUrl,
    max: 8,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 10_000,
    runInTenant: (tenantId, _reason, fn) => withTenant(createTenantContext(client, tenantId), fn),
  });
  queues.push(queue);
  return { queue, client };
}

describe("AC-23 iki işleyici örneği, tek kuyruk", () => {
  it(`@AC-23 iki ayrı createJobQueue örneği ${TOTAL} işi eşzamanlı tüketir → her iş tam bir kez yürütülür, toplam = ${TOTAL}, processed_events = ${TOTAL}`, async () => {
    const tenantA = await mkTenant();
    const tenantB = await mkTenant();
    const mine = new Set<string>();

    // Üretici: iki tenant, tenant işleri (aynı transaction'da yazılan pg-boss işleri).
    const producer = newInstance();
    await producer.queue.start();
    for (const tenantId of [tenantA, tenantB]) {
      await withTenant(createTenantContext(producer.client, tenantId), async (tx) => {
        for (let i = 0; i < TOTAL / 2; i += 1) {
          const { jobId } = await producer.queue.enqueue(tx, { type: "demo.reseed", payload: {} });
          expect(jobId).not.toBeNull();
          mine.add(jobId as string);
          jobIds.push(jobId as string);
        }
      });
    }
    expect(mine.size).toBe(TOTAL);

    // Yürütme gözlemi: iş başına sayaç, uçuşta kümesi (aynı iş iki örnekte birlikte yürütülür mü), örnek başına işlenen.
    const executions = new Map<string, number>();
    const inFlight = new Map<string, string>();
    const overlaps: string[] = [];
    const perInstance = new Map<string, number>();

    const instances = [newInstance(), newInstance()];
    for (const [idx, inst] of instances.entries()) {
      const name = `instance-${idx}`;
      perInstance.set(name, 0);
      const handler = async (ctx: { readonly jobId: string; inTenant: <R>(fn: (tx: TenantTx) => Promise<R>) => Promise<R> }): Promise<void> => {
        if (!mine.has(ctx.jobId)) {
          return; // başka testlerden kalan aynı türde iş: bu testin konusu değil, sessizce tamamlanır
        }
        if (inFlight.has(ctx.jobId)) overlaps.push(ctx.jobId);
        inFlight.set(ctx.jobId, name);
        executions.set(ctx.jobId, (executions.get(ctx.jobId) ?? 0) + 1);
        try {
          // Pencereyi genişlet: yarış varsa çakışma görünür olsun.
          await new Promise((r) => setTimeout(r, 15));
          await ctx.inTenant((tx: TenantTx) =>
            consumeOnce(tx, CONSUMER, ctx.jobId, (t) =>
              t.execute(sql`INSERT INTO ${sql.identifier(EFFECTS)} (tenant_id, job_id) VALUES (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, ${ctx.jobId}::uuid)`),
            ),
          );
          perInstance.set(name, (perInstance.get(name) ?? 0) + 1);
        } finally {
          inFlight.delete(ctx.jobId);
        }
      };
      for (let l = 0; l < LOOPS_PER_INSTANCE; l += 1) await inst.queue.work("demo.reseed", handler);
    }

    const done = async (): Promise<boolean> => {
      const r = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${QUEUE_SCHEMA}.job WHERE id = ANY($1::uuid[]) AND state = 'completed'`, [[...mine]]);
      return Number(r.rows[0]?.n) === TOTAL;
    };
    await waitFor(done, `${TOTAL} iş completed`, 150_000);
    // Geç gelen yinelenen teslimlere zaman tanı (SKIP LOCKED ihlali varsa sayaç artar).
    await new Promise((r) => setTimeout(r, 2000));

    expect(overlaps, "aynı iş iki yürütmede birlikte uçuşta olmamalı").toEqual([]);
    const counts = [...executions.values()];
    expect(executions.size, "her iş yürütülmüş").toBe(TOTAL);
    expect(counts.filter((c) => c !== 1), "yürütme sayacı her iş için 1").toEqual([]);
    expect(counts.reduce((a, b) => a + b, 0), "toplam işlenen = toplam kuyruğa giren").toBe(TOTAL);
    expect([...perInstance.values()].reduce((a, b) => a + b, 0)).toBe(TOTAL);
    for (const [name, n] of perInstance) expect(n, `${name} en az bir iş işlemeli (eşzamanlılık gerçekten sınandı)`).toBeGreaterThan(0);

    const pe = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM public.processed_events WHERE consumer = $1 AND event_id = ANY($2::uuid[])", [CONSUMER, [...mine]]);
    expect(Number(pe.rows[0]?.n)).toBe(TOTAL);
    const eff = await admin.query<{ n: string; d: string }>(`SELECT count(*)::text AS n, count(DISTINCT job_id)::text AS d FROM public.${EFFECTS} WHERE job_id = ANY($1::uuid[])`, [[...mine]]);
    expect(eff.rows[0]).toEqual({ n: String(TOTAL), d: String(TOTAL) });
    const states = await admin.query<{ state: string; n: string }>(`SELECT state, count(*)::text AS n FROM ${QUEUE_SCHEMA}.job WHERE id = ANY($1::uuid[]) GROUP BY state`, [[...mine]]);
    expect(states.rows).toEqual([{ state: "completed", n: String(TOTAL) }]);
  }, 240_000);
});
