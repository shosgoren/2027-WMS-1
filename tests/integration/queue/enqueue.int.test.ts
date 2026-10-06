// JobQueue + pg-boss bağdaştırıcısı entegrasyon testi (T-115; ADR-005 eki, ADR-016 §12).
//
// Uygulama tarafı YALNIZCA DATABASE_URL (wms_app, PgBouncer transaction mode) ile bağlanır. Migration rolü
// (DATABASE_URL_DIRECT) yalnızca doğrulama okumaları ve temizlik içindir. Veriler sentetik UUID'lerdir (G-09).
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, currentTenantId, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, rawDb, type DbClient } from "../../../packages/db/src/client.ts";
import type { TenantTx } from "../../../packages/queue-adapter/src/index.ts";
import { QUEUE_SCHEMA, assertBamCommandsExpected, createJobQueue, installQueueSchema, isExpectedBamCommand, pgBossAsyncCommandsForVerification, type PgBossJobQueue } from "../../../packages/queue-adapter/src/index.ts";
import { JOB_PAYLOAD_SCHEMAS, JOB_TYPES, QueueError, type Job, type JobContext } from "../../../packages/shared/src/queue.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

// `drizzle-orm` yalnızca paketlerin bağımlılığıdır; kökten çözülemez → packages/db çözümleyicisi.
const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/db/package.json"));
const { sql } = (await import(pathToFileURL(dbRequire.resolve("drizzle-orm")).href)) as typeof import("../../../packages/db/node_modules/drizzle-orm/index.js");

const env = readIntEnv(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect];

let client: DbClient;
let admin: pg.Client;
const queues: PgBossJobQueue[] = [];

function newQueue(): PgBossJobQueue {
  const q = createJobQueue({
    connectionString: env.databaseUrl,
    max: 3,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 5000,
    runInTenant: (tenantId, _reason, fn) => withTenant(createTenantContext(client, tenantId), fn),
  });
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

/** Handler'ın tenant bağlamı: yalnızca `inTenant` üzerinden, transaction'daki ayardan okunur. */
const tenantOfCtx = (ctx: JobContext<"demo.reseed", TenantTx>): Promise<string | undefined> =>
  ctx.hasTenant ? ctx.inTenant((tx) => currentTenantId(tx)) : Promise.resolve(undefined);

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
    // Şema kurulumu migration rolüyle (pnpm db:migrate sonrasındaki install-cli ile aynı işlev).
    await installQueueSchema({ url: env.databaseUrlDirect });
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

describe("wms_app en dar yetki (BLOCKER: bam/version/queue)", () => {
  async function asApp<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const app = new pg.Client({ connectionString: env.databaseUrl });
    app.on("error", () => undefined);
    await app.connect();
    try {
      return await fn(app);
    } finally {
      await app.end();
    }
  }
  const denied = { code: "42501" };

  it("bam: SELECT/INSERT/UPDATE/DELETE yok", async () => {
    await asApp(async (c) => {
      await expect(c.query(`SELECT 1 FROM ${QUEUE_SCHEMA}.bam`)).rejects.toMatchObject(denied);
      await expect(
        c.query(`INSERT INTO ${QUEUE_SCHEMA}.bam (name, version, table_name, command) VALUES ('x', 1, 'job', 'SELECT 1')`),
      ).rejects.toMatchObject(denied);
      await expect(c.query(`UPDATE ${QUEUE_SCHEMA}.bam SET command = 'SELECT 1'`)).rejects.toMatchObject(denied);
      await expect(c.query(`DELETE FROM ${QUEUE_SCHEMA}.bam`)).rejects.toMatchObject(denied);
    });
  });

  it("version ve queue: yazma yok; version'da yalnızca version sütunu okunur", async () => {
    await asApp(async (c) => {
      await expect(c.query(`UPDATE ${QUEUE_SCHEMA}.version SET bam_on = NULL`)).rejects.toMatchObject(denied);
      await expect(c.query(`INSERT INTO ${QUEUE_SCHEMA}.version (version) VALUES (1)`)).rejects.toMatchObject(denied);
      await expect(c.query(`SELECT bam_on FROM ${QUEUE_SCHEMA}.version`)).rejects.toMatchObject(denied);
      await expect(c.query(`UPDATE ${QUEUE_SCHEMA}.queue SET retry_limit = 99`)).rejects.toMatchObject(denied);
      await expect(c.query(`DELETE FROM ${QUEUE_SCHEMA}.queue`)).rejects.toMatchObject(denied);
      await expect(
        c.query(`INSERT INTO ${QUEUE_SCHEMA}.queue (name, policy, table_name) VALUES ('evil', 'standard', 'job')`),
      ).rejects.toMatchObject(denied);
    });
  });

  it("schedule, subscription, instance, job_dependency: erişim yok; pgboss'ta wms_app hiçbir nesnenin sahibi değil", async () => {
    await asApp(async (c) => {
      for (const t of ["schedule", "subscription", "instance", "job_dependency", "queue_stats", "warning"]) {
        await expect(c.query(`SELECT 1 FROM ${QUEUE_SCHEMA}.${t}`), t).rejects.toMatchObject(denied);
      }
    });
    const owned = await admin.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND pg_get_userbyid(c.relowner) = 'wms_app'`,
      [QUEUE_SCHEMA],
    );
    expect(owned.rows).toEqual([]);
    const fns = await admin.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND pg_get_userbyid(p.proowner) = 'wms_app'`,
      [QUEUE_SCHEMA],
    );
    expect(fns.rows).toEqual([]);
  });

  it("bekleyen bam komutu beklenen biçimde değilse kurulum reddedilir (fail-closed) ve komut çalışmaz", async () => {
    expect(() => assertBamCommandsExpected([`ALTER ROLE wms_app SUPERUSER`])).toThrow(/unexpected pending/);
    expect(() => assertBamCommandsExpected([`CREATE INDEX a ON ${QUEUE_SCHEMA}.job (name); ALTER ROLE wms_app SUPERUSER`])).toThrow();
    const id = randomUUID();
    await admin.query(
      `INSERT INTO ${QUEUE_SCHEMA}.bam (id, name, version, table_name, command) VALUES ($1, 't115-evil', 1, 'job', 'ALTER ROLE wms_app SUPERUSER')`,
      [id],
    );
    try {
      await expect(installQueueSchema({ url: env.databaseUrlDirect })).rejects.toMatchObject({ name: "QueueInstallError" });
      const r = await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = 'wms_app'`);
      expect(r.rows[0].rolsuper).toBe(false);
    } finally {
      await admin.query(`DELETE FROM ${QUEUE_SCHEMA}.bam WHERE id = $1`, [id]);
      // Reddedilen koşu yetkileri geri aldı (fail-closed) ve geri vermedi; temiz kurulum yetkileri yeniden verir.
      await installQueueSchema({ url: env.databaseUrlDirect });
    }
  });

  it("allowlist: kurulu pg-boss'un gerçek async komutlarının hepsi kabul; dar dilbilgisi dışı örnekler ret", () => {
    const real = pgBossAsyncCommandsForVerification();
    expect(real.length).toBeGreaterThanOrEqual(9);
    for (const c of real) expect(isExpectedBamCommand(c), c).toBe(true);
    expect(isExpectedBamCommand(`DROP INDEX CONCURRENTLY IF EXISTS ${QUEUE_SCHEMA}.job_common_i5`)).toBe(true);
    const bad = [
      `ALTER TABLE ${QUEUE_SCHEMA}.job ADD COLUMN x int`,
      `CREATE INDEX a ON ${QUEUE_SCHEMA}.job (lower(name))`,
      `CREATE INDEX a ON ${QUEUE_SCHEMA}.job ((SELECT 1))`,
      `CREATE INDEX a ON ${QUEUE_SCHEMA}.job (name) WHERE name = (SELECT 1)`,
      `CREATE INDEX a ON ${QUEUE_SCHEMA}.job (name) WHERE pg_sleep(1) IS NULL`,
      `CREATE INDEX a ON public.job (name)`,
      `CREATE INDEX a ON ${QUEUE_SCHEMA}.job (name); ALTER ROLE wms_app SUPERUSER`,
      `CREATE INDEX a ON ${QUEUE_SCHEMA}.job (name) WHERE state = 'x' OR true`,
      `DROP INDEX public.some_index`,
      `DROP TABLE ${QUEUE_SCHEMA}.job`,
    ];
    for (const c of bad) expect(isExpectedBamCommand(c), c).toBe(false);
  });

  it("pgboss işlevlerinde PUBLIC EXECUTE yok; wms_app yalnızca job_now() çalıştırır", async () => {
    await asApp(async (c) => {
      await expect(c.query(`SELECT ${QUEUE_SCHEMA}.job_now()`)).resolves.toBeDefined();
      await expect(c.query(`SELECT ${QUEUE_SCHEMA}.job_table_run('SELECT 1')`)).rejects.toMatchObject(denied);
      await expect(c.query(`SELECT ${QUEUE_SCHEMA}.create_queue('x', '{}'::jsonb)`)).rejects.toMatchObject(denied);
    });
    const r = await admin.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND has_function_privilege('public', p.oid, 'EXECUTE')`,
      [QUEUE_SCHEMA],
    );
    expect(r.rows).toEqual([]);
  });

  it("install-cli: DATABASE_URL ile aynı hedef reddedilir", async () => {
    const cli = path.resolve(import.meta.dirname, "../../../packages/queue-adapter/src/install-cli.ts");
    const run = promisify(execFile);
    await expect(
      run(process.execPath, [cli], { env: { ...process.env, DATABASE_URL: env.databaseUrlDirect, DATABASE_URL_DIRECT: env.databaseUrlDirect } }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("kurulum uygulama rolüyle çalıştırılamaz", async () => {
    await expect(installQueueSchema({ url: env.databaseUrl })).rejects.toMatchObject({ name: "QueueInstallError" });
  });

  it("üretici ve tüketici yolları dar yetkiyle çalışır (job tablosu DML)", async () => {
    await asApp(async (c) => {
      await expect(c.query(`SELECT count(*) FROM ${QUEUE_SCHEMA}.job`)).resolves.toBeDefined();
      await expect(c.query(`SELECT name FROM ${QUEUE_SCHEMA}.queue LIMIT 1`)).resolves.toBeDefined();
    });
  });
});

describe("enqueue + worker tüketimi", () => {
  it("commit edilen transaction'daki iş tüketilir; tenant kimliği transaction'dan türetilir", async () => {
    const tenantId = randomUUID();
    const seen: JobContext[] = [];
    const worker = newQueue();
    await worker.work("demo.reseed", async (ctx) => {
      if ((await tenantOfCtx(ctx)) === tenantId) seen.push(ctx);
    });
    const producer = await startedQueue();
    const res = await withTenant(tenantCtx(tenantId), (tx) => producer.enqueue(tx, reseed()));
    expect(res.jobId).toEqual(expect.any(String));
    await waitFor(() => seen.length === 1, "iş tüketimi");
    expect(seen[0]).toMatchObject({ type: "demo.reseed", hasTenant: true, actorUserId: null, payload: {} });
    expect(seen[0]).not.toHaveProperty("tenantId");
    const rows = await jobRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ v: 1, tenantId, payload: {} });
  });

  it("geri alınan transaction'daki iş hiç oluşmaz ve tüketilmez", async () => {
    const tenantId = randomUUID();
    const seen: string[] = [];
    const worker = newQueue();
    await worker.work("demo.reseed", async (ctx) => {
      if ((await tenantOfCtx(ctx)) === tenantId) seen.push(ctx.jobId);
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
      if ((await tenantOfCtx(ctx)) === tenantId) count.push(ctx.jobId);
    });
    await first.stop();
    const afterStop = count.length;

    const second = newQueue();
    await second.work("demo.reseed", async (ctx) => {
      if ((await tenantOfCtx(ctx)) === tenantId) count.push(ctx.jobId);
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
      if (ctx.actorUserId === marker) await expect(ctx.inTenant(async () => 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    const res = await (await startedQueue()).enqueuePlatform({ type: "demo.reseed", payload: {}, actorUserId: marker });
    expect(res.jobId).toEqual(expect.any(String));
    await waitFor(() => seen.length === 1, "platform işi");
    expect(seen[0]?.hasTenant).toBe(false);
  });
});

describe("kalıcı / geçici hata (T-116b)", () => {
  // `fail` yolu pg-boss'ta DELETE + INSERT ile çalışır; `wms_app`'te job DELETE yetkisi yoktur (T-115 en dar yetki).
  // Tüketici yetkileri `wms_worker` ile T-115c'de tanımlanır; o zamana dek bu testler tüketiciyi migration rolüyle
  // bağlar (sınıflama ve durum geçişleri doğrulanır, yetki modeli değil). Bkz. T-116b raporu bulgusu.
  const failPathWorker = (): PgBossJobQueue => {
    const q = createJobQueue({
      connectionString: env.databaseUrlDirect,
      max: 3,
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 5000,
      runInTenant: (tenantId, _reason, fn) => withTenant(createTenantContext(client, tenantId), fn),
    });
    queues.push(q);
    return q;
  };
  const stateOf = async (tenantId: string) => {
    const r = await admin.query(`SELECT state, retry_count, retry_limit, output FROM ${QUEUE_SCHEMA}.job WHERE data->>'tenantId' = $1`, [tenantId]);
    return r.rows as { state: string; retry_count: number; retry_limit: number; output: Record<string, unknown> | null }[];
  };

  it("kalıcı hata (permanent: true) yeniden denenmeden failed olur; çıktıda yalnızca ad/kod, mesaj yok", async () => {
    const tenantId = randomUUID();
    const calls: string[] = [];
    const secret = `secret-${randomUUID()}`;
    const worker = failPathWorker();
    await worker.work("demo.reseed", async (ctx) => {
      if ((await tenantOfCtx(ctx)) !== tenantId) return;
      calls.push(ctx.jobId);
      throw Object.assign(new Error(secret), { name: "MailError", code: "MAIL_DELIVERY_DISABLED", permanent: true });
    });
    const producer = await startedQueue();
    await withTenant(tenantCtx(tenantId), (tx) => producer.enqueue(tx, reseed()));
    await waitFor(async () => (await stateOf(tenantId))[0]?.state === "failed", "kalıcı hata -> failed");
    const row = (await stateOf(tenantId))[0];
    expect(row?.retry_limit).toBeGreaterThan(0);
    expect(row?.retry_count).toBe(0);
    expect(row?.output).toMatchObject({ permanent: true, name: "MailError", code: "MAIL_DELIVERY_DISABLED" });
    expect(JSON.stringify(row?.output)).not.toContain(secret);
    await sleep(2000);
    expect(calls).toHaveLength(1);
  });

  it("geçici hata yeniden denenir (state retry, tamamlanmış sayılmaz)", async () => {
    const tenantId = randomUUID();
    let calls = 0;
    const worker = failPathWorker();
    await worker.work("demo.reseed", async (ctx) => {
      if ((await tenantOfCtx(ctx)) !== tenantId) return;
      calls += 1;
      throw Object.assign(new Error("transient"), { permanent: false });
    });
    const producer = await startedQueue();
    await withTenant(tenantCtx(tenantId), (tx) => producer.enqueue(tx, reseed()));
    await waitFor(async () => (await stateOf(tenantId))[0]?.state === "retry", "geçici hata -> retry");
    const row = (await stateOf(tenantId))[0];
    expect(row?.retry_count).toBeLessThan(row?.retry_limit ?? 0); // kalan deneme hakkı var (sayaç bir sonraki alımda artar)
    expect(calls).toBe(1);
  });

  it("başarılı iş completed olur (perJobResults yolu)", async () => {
    const tenantId = randomUUID();
    const worker = newQueue();
    await worker.work("demo.reseed", async () => undefined);
    const producer = await startedQueue();
    await withTenant(tenantCtx(tenantId), (tx) => producer.enqueue(tx, reseed()));
    await waitFor(async () => (await stateOf(tenantId))[0]?.state === "completed", "completed");
  });
});

describe("tenant bağlamı ve yük güvenliği", () => {
  it("işlemde kimlik bağlamı varsa actorUserId ondan türetilir; çelişen actor reddedilir", async () => {
    const tenantId = randomUUID();
    const user = randomUUID();
    const producer = await startedQueue();
    await withTenant(tenantCtx(tenantId), async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${user}, true)`);
      await expect(producer.enqueue(tx, { ...reseed(), actorUserId: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await producer.enqueue(tx, reseed());
    });
    expect((await jobRows(tenantId))[0]?.data).toMatchObject({ actorUserId: user });
  });

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
