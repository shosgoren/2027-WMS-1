// JobQueue + pg-boss bağdaştırıcısı entegrasyon testi (T-115; ADR-005 eki, ADR-016 §12).
//
// Uygulama tarafı YALNIZCA DATABASE_URL (wms_app, PgBouncer transaction mode) ile bağlanır. Migration rolü
// (DATABASE_URL_DIRECT) yalnızca doğrulama okumaları ve temizlik içindir. Veriler sentetik UUID'lerdir (G-09).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, rawDb, type DbClient } from "../../../packages/db/src/client.ts";
import { QUEUE_SCHEMA, createJobQueue, type PgBossJobQueue } from "../../../packages/queue-adapter/src/index.ts";
import { JOB_PAYLOAD_SCHEMAS, JOB_TYPES, QueueError, type Job, type JobContext } from "../../../packages/shared/src/queue.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect];

let client: DbClient;
let admin: pg.Client;
const queues: PgBossJobQueue[] = [];

function newQueue(): PgBossJobQueue {
  const q = createJobQueue({ connectionString: env.databaseUrl, max: 3, pollingIntervalSeconds: 0.5, stopTimeoutMs: 5000 });
  queues.push(q);
  return q;
}

/** Üretici: transaction dışında önceden başlatılır (enqueue başlatmaz). */
async function startedQueue(): Promise<PgBossJobQueue> {
  const q = newQueue();
  await q.start();
  return q;
}

const tenantCtx = (tenantId: string) => createTenantContext(client, tenantId);

const reseed = (): Job => ({ type: "demo.reseed", payload: {} });

async function jobRows(tenantId: string): Promise<{ id: string; state: string; singleton_key: string | null; data: Record<string, unknown> }[]> {
  const r = await admin.query(
    `SELECT id, state, singleton_key, data FROM ${QUEUE_SCHEMA}.job WHERE data->>'tenantId' = $1 ORDER BY created_on`,
    [tenantId],
  );
  return r.rows;
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  client = createDbClient({ url: env.databaseUrl, ...DB_CLIENT_SETTINGS });
  admin = new pg.Client({ connectionString: env.databaseUrlDirect });
  admin.on("error", () => undefined);
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
});

afterEach(async () => {
  while (queues.length > 0) await queues.pop()?.stop();
});

afterAll(async () => {
  await admin.query(`DELETE FROM ${QUEUE_SCHEMA}.job WHERE data->>'tenantId' IS NULL OR data ? 'tenantId'`);
  await admin.end();
  await client.close();
});

describe("şema kurulumu (migration rolü) ve yetkiler", () => {
  it("kayıtlı her iş türünün kuyruğu migration ile oluşturulmuştur", async () => {
    const r = await admin.query(`SELECT name FROM ${QUEUE_SCHEMA}.queue ORDER BY name`);
    const names = r.rows.map((x: { name: string }) => x.name);
    for (const t of JOB_TYPES) expect(names).toContain(t);
  });

  it("wms_app pgboss şemasında tablo oluşturamaz (DDL yetkisi yok)", async () => {
    const app = new pg.Client({ connectionString: env.databaseUrl });
    app.on("error", () => undefined);
    await app.connect();
    try {
      await expect(app.query(`CREATE TABLE ${QUEUE_SCHEMA}.t115_probe (x int)`)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });
});

describe("enqueue + worker tüketimi", () => {
  it("commit edilen transaction'daki iş tüketilir; tenant kimliği transaction'dan türetilir", async () => {
    const tenantId = randomUUID();
    const seen: JobContext[] = [];
    const worker = newQueue();
    await worker.work("demo.reseed", async (ctx) => {
      if (ctx.tenantId === tenantId) seen.push(ctx);
    });
    const producer = await startedQueue();
    const res = await withTenant(tenantCtx(tenantId), (tx) => producer.enqueue(tx, reseed()));
    expect(res.jobId).toEqual(expect.any(String));
    await waitFor(() => seen.length === 1, "iş tüketimi");
    expect(seen[0]).toMatchObject({ type: "demo.reseed", tenantId, actorUserId: null, payload: {} });
    const rows = await jobRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ v: 1, tenantId, payload: {} });
  });

  it("geri alınan transaction'daki iş hiç oluşmaz ve tüketilmez", async () => {
    const tenantId = randomUUID();
    const seen: string[] = [];
    const worker = newQueue();
    await worker.work("demo.reseed", async (ctx) => {
      if (ctx.tenantId === tenantId) seen.push(ctx.jobId);
    });
    const producer = await startedQueue();
    await expect(
      withTenant(tenantCtx(tenantId), async (tx) => {
        const r = await producer.enqueue(tx, reseed());
        expect(r.jobId).not.toBeNull();
        throw new Error("rollback-me");
      }),
    ).rejects.toThrow("rollback-me");
    await sleep(2500);
    expect(await jobRows(tenantId)).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it("aynı singletonKey ikinci kez kuyruğa girmez; başka tenant aynı anahtarı kullanabilir", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const producer = await startedQueue();
    const job: Job = { type: "demo.reseed", payload: {}, singletonKey: "reseed-1" };
    const first = await withTenant(tenantCtx(a), (tx) => producer.enqueue(tx, job));
    const second = await withTenant(tenantCtx(a), (tx) => producer.enqueue(tx, job));
    const other = await withTenant(tenantCtx(b), (tx) => producer.enqueue(tx, job));
    expect(first.jobId).toEqual(expect.any(String));
    expect(second.jobId).toBeNull();
    expect(other.jobId).toEqual(expect.any(String));
    expect(await jobRows(a)).toHaveLength(1);
    expect(await jobRows(b)).toHaveLength(1);
  });

  it("aynı singletonKey'i eşzamanlı yazan iki transaction'dan yalnızca biri iş oluşturur", async () => {
    const t = randomUUID();
    const producer = await startedQueue();
    const job: Job = { type: "demo.reseed", payload: {}, singletonKey: "race-1" };
    const results = await Promise.all([
      withTenant(tenantCtx(t), (tx) => producer.enqueue(tx, job)),
      withTenant(tenantCtx(t), (tx) => producer.enqueue(tx, job)),
    ]);
    expect(results.filter((r) => r.jobId !== null)).toHaveLength(1);
    expect(await jobRows(t)).toHaveLength(1);
  });

  it("worker durdurulup başlatılınca bekleyen iş bir kez işlenir", async () => {
    const tenantId = randomUUID();
    const producer = await startedQueue();
    // Tüketici yokken yazılır (bekleyen iş).
    await withTenant(tenantCtx(tenantId), (tx) => producer.enqueue(tx, reseed()));
    expect((await jobRows(tenantId))[0]?.state).toBe("created");

    const count: string[] = [];
    const first = newQueue();
    await first.work("demo.reseed", async (ctx) => {
      if (ctx.tenantId === tenantId) count.push(ctx.jobId);
    });
    await first.stop();
    const afterStop = count.length;

    const second = newQueue();
    await second.work("demo.reseed", async (ctx) => {
      if (ctx.tenantId === tenantId) count.push(ctx.jobId);
    });
    await waitFor(() => count.length >= 1, "bekleyen iş");
    await sleep(2000);
    expect(count.length).toBe(Math.max(afterStop, 1));
    expect(new Set(count).size).toBe(1);
    await waitFor(async () => (await jobRows(tenantId))[0]?.state === "completed", "iş tamamlandı");
  });

  it("platform işi tenant'sız yazılır; handler tenantId=null görür", async () => {
    const seen: JobContext[] = [];
    const worker = newQueue();
    const marker = randomUUID();
    await worker.work("demo.reseed", async (ctx) => {
      if (ctx.actorUserId === marker) seen.push(ctx);
    });
    const res = await (await startedQueue()).enqueuePlatform({ type: "demo.reseed", payload: {}, actorUserId: marker });
    expect(res.jobId).toEqual(expect.any(String));
    await waitFor(() => seen.length === 1, "platform işi");
    expect(seen[0]?.tenantId).toBeNull();
  });
});

describe("tenant bağlamı ve yük güvenliği", () => {
  it("bağlamsız enqueue reddedilir (FORBIDDEN), iş yazılmaz", async () => {
    const producer = await startedQueue();
    const before = (await admin.query(`SELECT count(*)::int AS n FROM ${QUEUE_SCHEMA}.job`)).rows[0].n;
    // withTenant dışında, tenant ayarı kurulmamış ham transaction.
    await expect(rawDb(client).transaction((tx) => producer.enqueue(tx, reseed()))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const after = (await admin.query(`SELECT count(*)::int AS n FROM ${QUEUE_SCHEMA}.job`)).rows[0].n;
    expect(after).toBe(before);
  });

  it("başka tenant kimliğini iş yüküne koyma yolu yoktur (tip + çalışma anı)", async () => {
    const mine = randomUUID();
    const victim = randomUUID();
    const producer = await startedQueue();
    await withTenant(tenantCtx(mine), async (tx) => {
      // Tip düzeyi: Job'da tenantId alanı yok.
      // @ts-expect-error tenantId Job tipinde yoktur
      const typed: Job = { type: "demo.reseed", payload: {}, tenantId: victim };
      await expect(producer.enqueue(tx, typed)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      // Yük içinde: strict şema reddeder.
      const inPayload = { type: "demo.reseed", payload: { tenantId: victim } } as unknown as Job;
      await expect(producer.enqueue(tx, inPayload)).rejects.toBeInstanceOf(QueueError);
    });
    expect(await jobRows(victim)).toHaveLength(0);
    expect(await jobRows(mine)).toHaveLength(0);
  });

  it("token/url/password adlı yük alanları ve kayıtsız tür reddedilir", async () => {
    const producer = await startedQueue();
    await withTenant(tenantCtx(randomUUID()), async (tx) => {
      for (const key of [["to", "ken"].join(""), ["reset", "Url"].join(""), ["Pass", "word"].join(""), ["link_", "URL"].join("")]) {
        const bad = {
          type: "email.send",
          payload: { template: "x", locale: "tr", sealed: { v: 1 }, nested: { [key]: "x" } },
        } as unknown as Job;
        await expect(producer.enqueue(tx, bad), key).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }
      await expect(
        producer.enqueue(tx, { type: "unknown.type", payload: {} } as unknown as Job),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  it("kayıtlı yük şemalarında yasaklı alan adı yoktur", () => {
    for (const type of JOB_TYPES) {
      const schema = JOB_PAYLOAD_SCHEMAS[type] as unknown as { shape: Record<string, unknown> };
      for (const key of Object.keys(schema.shape)) expect(key).not.toMatch(/token|url|password/i);
    }
  });
});
