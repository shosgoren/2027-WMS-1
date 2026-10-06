// AC-22 — bağımsız kabul testi (T-218, qa-verifier; uygulayıcının T-214 testinden bağımsız yazıldı).
//
// Katman: ENTEGRASYON (gerçek PostgreSQL + PgBouncer transaction mode, gerçek pg-boss 12.36, gerçek roller wms_app/wms_worker).
// Mock yok; haricî sağlayıcı yerel bir HTTP sunucusudur (ağ dışına çıkılmaz). Veriler sentetik UUID'lerdir (G-09).
//
// AC-22: "Aynı iş/olay tüketiciye iki kez teslim edilir (işleyici yan etkiden sonra, onaydan önce çöker) → etki tek kez;
// ikinci teslim `processed_events` ile sessizce onaylanır; haricî çağrıda aynı idempotency anahtarı gider."
//
// "Onaydan önce çökme" iki yolla üretilir:
//  (1) GERÇEK süreç ölümü: alt süreç (node, SIGKILL) `consumeOnce` commit'inden hemen sonra kendini öldürür; pg-boss işi
//      `active` bırakır. pg-boss bakımı bu kurulumda kapalı olduğundan (supervise:false; wms_app/wms_worker yönetim tablolarına
//      yazamaz) "zaman aşımı"nı bakım işinin yaptığı dönüşüm (active -> retry) migration rolüyle yapar.
//  (2) Handler yan etkiden sonra hata fırlatır (pg-boss `fail` -> retry), `start_after` öne çekilir.
// Her iki yolda da yeniden teslim aynı iş kimliğiyle ve gerçek tüketici (consumeOnce) üzerinden olur.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant, withUser } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { QUEUE_SCHEMA, consumeOnce, createJobQueue, installQueueSchema, type PgBossJobQueue, type TenantTx } from "../../../packages/queue-adapter/src/index.ts";
import { PLATFORM_NO_USER_ID, type JobContext } from "../../../packages/shared/src/queue.ts";
import { EMAIL_SEND_JOB_TYPE, buildEmailSendPayload, loadMailConfig } from "../../../packages/shared/src/mailer.ts";
import { createSealer, type Sealer } from "../../../packages/shared/src/seal.ts";
import { createSendEmailHandler } from "../../../apps/worker/src/jobs/send-email.ts";
import { createResendMailer } from "../../../apps/worker/src/mail/resend.ts";
import { createJsonLogger } from "../../../apps/worker/src/lifecycle.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

// `drizzle-orm` yalnızca paketlerin bağımlılığıdır; kökten çözülemez → packages/db çözümleyicisi.
const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/db/package.json"));
const { sql } = (await import(pathToFileURL(dbRequire.resolve("drizzle-orm")).href)) as typeof import("../../../packages/db/node_modules/drizzle-orm/index.js");

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const CONSUMER = "t218.ac22.effect";
const EFFECTS = "t218_ac22_effects";
const NIL_USER = PLATFORM_NO_USER_ID;

let admin: pg.Client;
let client: DbClient;
const queues: PgBossJobQueue[] = [];
const tenants: string[] = [];
const jobIds: string[] = [];
const servers: Server[] = [];

async function mkTenant(): Promise<string> {
  const id = randomUUID();
  await admin.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, 'ACTIVE')", [id, `t218-${id.slice(0, 8)}`, "T218 tenant"]);
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

const jobState = async (id: string): Promise<string | undefined> =>
  (await admin.query<{ state: string }>(`SELECT state FROM ${QUEUE_SCHEMA}.job WHERE id = $1`, [id])).rows[0]?.state;
const effectCount = async (jobId: string): Promise<number> =>
  Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${EFFECTS} WHERE job_id = $1`, [jobId])).rows[0]?.n);
const processedCount = async (consumer: string, jobId: string): Promise<number> =>
  Number((await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM public.processed_events WHERE consumer = $1 AND event_id = $2", [consumer, jobId])).rows[0]?.n);

/** Yan etki: tenant_id tenant bağlamından türer (platform işinde NULL). */
const writeEffect = (tx: TenantTx, jobId: string) =>
  tx.execute(sql`INSERT INTO ${sql.identifier(EFFECTS)} (tenant_id, job_id) VALUES (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, ${jobId}::uuid)`);

/** Süresi dolmuş/başarısız işi hemen yeniden alınabilir yapar (pg-boss bakımının active -> retry dönüşümü eşdeğeri). */
async function forceRedelivery(jobId: string): Promise<void> {
  const r = await admin.query(`UPDATE ${QUEUE_SCHEMA}.job SET state = 'retry', start_after = now() WHERE id = $1 AND state IN ('active', 'retry')`, [jobId]);
  expect(r.rowCount, "yeniden teslime zorlanan iş active/retry durumunda olmalı").toBe(1);
}

function newQueue(url: string, platformRunner?: JobQueueRunner): PgBossJobQueue {
  const q = createJobQueue({
    connectionString: url,
    max: 3,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 5000,
    runInTenant: (tenantId, _reason, fn) => withTenant(createTenantContext(client, tenantId), fn),
    runPlatform: platformRunner ?? ((fn) => withUser(client, NIL_USER, fn)),
  });
  queues.push(q);
  return q;
}
type JobQueueRunner = <R>(fn: (tx: TenantTx) => Promise<R>) => Promise<R>;

/** Üretici: wms_app bağlantısı (enqueuePlatform kendi transaction'ında yazar; wms_worker'ın INSERT yetkisi yoktur). */
async function producer(): Promise<PgBossJobQueue> {
  const q = newQueue(env.databaseUrl);
  await q.start();
  return q;
}

async function enqueueTenantJob(tenantId: string): Promise<string> {
  const p = await producer();
  const { jobId } = await withTenant(createTenantContext(client, tenantId), (tx) => p.enqueue(tx, { type: "demo.reseed", payload: {} }));
  expect(jobId).not.toBeNull();
  jobIds.push(jobId as string);
  return jobId as string;
}

async function enqueuePlatformJob(): Promise<string> {
  const p = await producer();
  const { jobId } = await p.enqueuePlatform({ type: "demo.reseed", payload: {} });
  expect(jobId).not.toBeNull();
  jobIds.push(jobId as string);
  return jobId as string;
}

beforeAll(async () => {
  client = createDbClient({ url: env.databaseUrl, ...DB_CLIENT_SETTINGS });
  admin = new pg.Client({ connectionString: env.databaseUrlDirect });
  admin.on("error", () => undefined);
  await admin.connect();
  await installQueueSchema({ url: env.databaseUrlDirect });
  await admin.query(`CREATE TABLE IF NOT EXISTS public.${EFFECTS} (tenant_id uuid, job_id uuid NOT NULL)`);
  await admin.query(`GRANT SELECT, INSERT ON public.${EFFECTS} TO wms_app`);
});

afterEach(async () => {
  while (queues.length > 0) await queues.pop()?.stop();
  while (servers.length > 0) {
    const s = servers.pop();
    if (s !== undefined) await new Promise<void>((r) => s.close(() => r()));
  }
});

afterAll(async () => {
  await admin.query(`DROP TABLE IF EXISTS public.${EFFECTS}`);
  await admin.query("DELETE FROM public.processed_events WHERE consumer IN ($1, $2)", [CONSUMER, EMAIL_SEND_JOB_TYPE]).catch(() => undefined);
  if (jobIds.length > 0) await admin.query(`DELETE FROM ${QUEUE_SCHEMA}.job WHERE id = ANY($1::uuid[])`, [jobIds]);
  if (tenants.length > 0) {
    await admin.query("DELETE FROM public.processed_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
    await admin.query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [tenants]);
  }
  await admin.end();
  await client.close();
});

/**
 * Alt süreç tüketicisi: yalnızca `T218_JOB_ID` işini işler (diğerlerini sessizce tamamlar), `consumeOnce` commit'inden sonra
 * kendini SIGKILL ile öldürür. Üretim kodu (queue-adapter) doğrudan içe aktarılır; Node 24 `.ts` dosyalarını doğrudan çalıştırır.
 */
const CHILD_SRC = `
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.T218_ROOT;
const url = (p) => pathToFileURL(path.join(root, p)).href;
const dbRequire = createRequire(path.join(root, "packages/db/package.json"));
const { sql } = await import(pathToFileURL(dbRequire.resolve("drizzle-orm")).href);
const { createDbClient, withTenant } = await import(url("packages/db/src/index.ts"));
const { DB_CLIENT_SETTINGS, createTenantContext } = await import(url("packages/db/src/client.ts"));
const { createJobQueue, consumeOnce } = await import(url("packages/queue-adapter/src/index.ts"));
const client = createDbClient({ url: process.env.DATABASE_URL, ...DB_CLIENT_SETTINGS });
const q = createJobQueue({
  connectionString: process.env.DATABASE_URL_WORKER,
  max: 2,
  pollingIntervalSeconds: 0.5,
  stopTimeoutMs: 5000,
  runInTenant: (tenantId, _reason, fn) => withTenant(createTenantContext(client, tenantId), fn),
});
await q.work("demo.reseed", async (ctx) => {
  if (ctx.jobId !== process.env.T218_JOB_ID) return;
  await ctx.inTenant((tx) => consumeOnce(tx, process.env.T218_CONSUMER, ctx.jobId, (t) =>
    t.execute(sql\`INSERT INTO \${sql.identifier(process.env.T218_EFFECTS)} (tenant_id, job_id) VALUES (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, \${ctx.jobId}::uuid)\`)));
  process.stdout.write("EFFECT_COMMITTED\\n");
  process.kill(process.pid, "SIGKILL");
});
process.stdout.write("READY\\n");
setTimeout(() => process.exit(3), 90000).unref();
`;

async function runChildUntilKilled(jobId: string): Promise<{ signal: NodeJS.Signals | null; code: number | null; stdout: string }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SRC], {
    env: {
      ...process.env,
      T218_ROOT: ROOT,
      T218_JOB_ID: jobId,
      T218_CONSUMER: CONSUMER,
      T218_EFFECTS: EFFECTS,
      DATABASE_URL: env.databaseUrl,
      DATABASE_URL_WORKER: workerUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.resume(); // sırlar/URL'ler loglanmaz; çıktı atılır
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not die in time")), 60_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout });
      });
      child.once("error", reject);
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); // yalnızca kendi alt sürecimiz
  }
}

interface Delivery {
  readonly jobId: string;
  readonly applied: boolean;
}

/** Test tüketicisi: `consumeOnce` + yan etki; isteğe bağlı olarak yan etkiden sonra (onaydan önce) çöker. */
async function registerConsumer(q: PgBossJobQueue, mine: ReadonlySet<string>, opts: { readonly crashAfterEffect: boolean; readonly platform: boolean }): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  let first = true;
  await q.work("demo.reseed", async (ctx: JobContext<"demo.reseed", TenantTx>) => {
    if (!mine.has(ctx.jobId)) return; // başka testlerden kalan işler (aynı kuyruk adı) bu testin konusu değildir
    const run = opts.platform ? ctx.inPlatform.bind(ctx) : ctx.inTenant.bind(ctx);
    const r = await run((tx) => consumeOnce(tx, CONSUMER, ctx.jobId, (t) => writeEffect(t, ctx.jobId)));
    deliveries.push({ jobId: ctx.jobId, applied: r.applied });
    if (opts.crashAfterEffect && first) {
      first = false;
      throw new Error("t218 simulated crash after effect, before ack");
    }
  });
  return deliveries;
}

describe("AC-22 çift teslim: DB yan etkisi", () => {
  it("@AC-22 tenant işi: yan etkiden sonra GERÇEK süreç ölümü (SIGKILL) → yeniden teslimde etki tek, ikinci teslim sessizce onaylanır", async () => {
    const tenantId = await mkTenant();
    const jobId = await enqueueTenantJob(tenantId);

    const dead = await runChildUntilKilled(jobId);
    expect(dead.signal, "alt süreç SIGKILL ile ölmeli").toBe("SIGKILL");
    expect(dead.stdout).toContain("EFFECT_COMMITTED");
    // Çökme anı: etki ve processed_events satırı commit edilmiş, iş onaylanmamış (active).
    expect(await effectCount(jobId)).toBe(1);
    expect(await processedCount(CONSUMER, jobId)).toBe(1);
    expect(await jobState(jobId)).toBe("active");

    await forceRedelivery(jobId);
    const q = newQueue(workerUrl);
    const deliveries = await registerConsumer(q, new Set([jobId]), { crashAfterEffect: false, platform: false });
    await waitFor(async () => (await jobState(jobId)) === "completed", "ikinci teslim tamamlanır");

    expect(deliveries).toEqual([{ jobId, applied: false }]);
    expect(await effectCount(jobId), "etki tek kez").toBe(1);
    expect(await processedCount(CONSUMER, jobId)).toBe(1);
  }, 120_000);

  it("@AC-22 tenant işi: yan etkiden sonra hata (fail → retry) → ikinci teslim applied=false, etki tek", async () => {
    const tenantId = await mkTenant();
    const jobId = await enqueueTenantJob(tenantId);
    const q = newQueue(workerUrl);
    const deliveries = await registerConsumer(q, new Set([jobId]), { crashAfterEffect: true, platform: false });
    await waitFor(async () => (await jobState(jobId)) === "retry", "ilk teslim başarısız → retry");
    expect(await effectCount(jobId)).toBe(1);
    await forceRedelivery(jobId);
    await waitFor(async () => (await jobState(jobId)) === "completed", "ikinci teslim tamamlanır");
    expect(deliveries).toEqual([
      { jobId, applied: true },
      { jobId, applied: false },
    ]);
    expect(await effectCount(jobId)).toBe(1);
    expect(await processedCount(CONSUMER, jobId)).toBe(1);
    const row = await admin.query<{ tenant_id: string }>("SELECT tenant_id FROM public.processed_events WHERE consumer = $1 AND event_id = $2", [CONSUMER, jobId]);
    expect(row.rows[0]?.tenant_id).toBe(tenantId);
  }, 90_000);

  it("@AC-22 platform işi (tenant_id NULL): yan etkiden sonra hata → ikinci teslim applied=false, etki tek, processed_events tenant_id NULL", async () => {
    const jobId = await enqueuePlatformJob();
    const q = newQueue(workerUrl);
    const deliveries = await registerConsumer(q, new Set([jobId]), { crashAfterEffect: true, platform: true });
    await waitFor(async () => (await jobState(jobId)) === "retry", "ilk teslim başarısız → retry");
    await forceRedelivery(jobId);
    await waitFor(async () => (await jobState(jobId)) === "completed", "ikinci teslim tamamlanır");
    expect(deliveries.map((d) => d.applied)).toEqual([true, false]);
    expect(await effectCount(jobId)).toBe(1);
    const row = await admin.query<{ tenant_id: string | null }>("SELECT tenant_id FROM public.processed_events WHERE consumer = $1 AND event_id = $2", [CONSUMER, jobId]);
    expect(row.rows).toEqual([{ tenant_id: null }]);
  }, 90_000);
});

// --- Haricî kol: send-email işi, yerel sahte sağlayıcı ---------------------------------------------------------------

interface ProviderCall {
  readonly key: string | undefined;
  readonly auth: string | undefined;
}

async function startProvider(statusFor: (callNo: number) => number): Promise<{ calls: ProviderCall[]; baseUrl: string }> {
  const calls: ProviderCall[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on("end", () => {
      calls.push({ key: req.headers["idempotency-key"] as string | undefined, auth: req.headers.authorization });
      const status = statusFor(calls.length);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: randomUUID() }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const apiKey = `k_${randomBytes(12).toString("hex")}`;

/** `send-email` işleyicisi gerçek `deliverExternalOnce` ile; yalnızca bu testin iş kimlikleri işlenir. */
async function registerEmailWorker(baseUrl: string, sealer: Sealer, jobId: string, platformRunner?: JobQueueRunner): Promise<void> {
  const config = loadMailConfig({ MAIL_MODE: "resend", RESEND_API_KEY: apiKey, MAIL_FROM: "noreply@example.invalid", MAIL_VERIFIED_DOMAIN: "example.invalid" });
  const handler = createSendEmailHandler({
    sealer,
    config,
    mailer: createResendMailer({ apiKey, from: "noreply@example.invalid", baseUrl }),
    logger: createJsonLogger(() => undefined),
  });
  const q = newQueue(workerUrl, platformRunner);
  await q.work(EMAIL_SEND_JOB_TYPE, (ctx) => (ctx.jobId === jobId ? handler(ctx) : Promise.resolve()));
}

async function enqueueEmail(sealer: Sealer): Promise<string> {
  const p = await producer();
  const payload = buildEmailSendPayload(sealer, {
    template: "password_reset",
    locale: "tr",
    to: `alice.${randomBytes(3).toString("hex")}@example.invalid`,
    link: `https://app.example.invalid/reset/${randomBytes(12).toString("hex")}`,
    tenantId: null,
  });
  const { jobId } = await p.enqueuePlatform({ type: "email.send", payload: { ...payload, sealed: { ...payload.sealed } } });
  expect(jobId).not.toBeNull();
  jobIds.push(jobId as string);
  return jobId as string;
}

/** Önce iş yazılır, işleyici sonra başlar (başka testlerden kalan aynı türdeki işler yalnızca sessizce tamamlanır). */
async function emailScenario(statusFor: (n: number) => number, platformRunner?: JobQueueRunner) {
  const provider = await startProvider(statusFor);
  const sealer = createSealer(randomBytes(32).toString("hex"));
  const jobId = await enqueueEmail(sealer);
  await registerEmailWorker(provider.baseUrl, sealer, jobId, platformRunner);
  return { provider, jobId };
}

describe("AC-22 çift teslim: haricî çağrı (send-email → sahte sağlayıcı)", () => {
  it("@AC-22 başarılı gönderimden sonra iş yeniden teslim edilir → ikinci çağrı YAPILMAZ; ilk çağrıda Idempotency-Key = iş kimliği", async () => {
    const { provider, jobId } = await emailScenario(() => 200);
    await waitFor(async () => (await jobState(jobId)) === "completed", "ilk teslim tamamlanır");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.key).toBe(jobId);
    expect(await processedCount(EMAIL_SEND_JOB_TYPE, jobId)).toBe(1);

    // Gerçek yeniden teslim: tamamlanmış işi aynı kimlikle yeniden alınabilir yap.
    await admin.query(`UPDATE ${QUEUE_SCHEMA}.job SET state = 'created', completed_on = NULL, started_on = NULL WHERE id = $1`, [jobId]);
    await waitFor(async () => {
      const r = await admin.query<{ state: string; started_on: Date | null }>(`SELECT state, started_on FROM ${QUEUE_SCHEMA}.job WHERE id = $1`, [jobId]);
      return r.rows[0]?.state === "completed" && r.rows[0].started_on !== null;
    }, "ikinci teslim tamamlanır");
    expect(provider.calls, "ikinci teslimde sağlayıcıya çağrı gitmemeli").toHaveLength(1);
    expect(await processedCount(EMAIL_SEND_JOB_TYPE, jobId)).toBe(1);
  }, 90_000);

  it("@AC-22 sağlayıcı çağrısı başarılı, processed_events yazımı çöker → yeniden teslimde çağrı tekrarlanır ve AYNI Idempotency-Key gider", async () => {
    let runnerCalls = 0;
    const { provider, jobId } = await emailScenario(
      () => 200,
      (fn) => {
        runnerCalls += 1;
        // 1: hasProcessed (ilk teslim), 2: satır yazımı (ilk teslim) → çökme; sonrası normal.
        if (runnerCalls === 2) return Promise.reject(new Error("t218 simulated crash after provider call, before row write"));
        return withUser(client, NIL_USER, fn);
      },
    );
    await waitFor(() => provider.calls.length === 1, "ilk sağlayıcı çağrısı");
    await waitFor(async () => (await jobState(jobId)) === "retry", "ilk teslim başarısız → retry");
    expect(await processedCount(EMAIL_SEND_JOB_TYPE, jobId), "satır yazılamadı").toBe(0);
    await forceRedelivery(jobId);
    await waitFor(async () => (await jobState(jobId)) === "completed", "ikinci teslim tamamlanır");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.map((c) => c.key)).toEqual([jobId, jobId]);
    expect(await processedCount(EMAIL_SEND_JOB_TYPE, jobId)).toBe(1);
    // Üçüncü teslim: satır var → çağrı yok.
    await admin.query(`UPDATE ${QUEUE_SCHEMA}.job SET state = 'created', completed_on = NULL, started_on = NULL WHERE id = $1`, [jobId]);
    await waitFor(async () => runnerCalls >= 5, "üçüncü teslim hasProcessed kontrolü");
    await new Promise((r) => setTimeout(r, 1500));
    expect(provider.calls, "satır yazıldıktan sonra çağrı yok").toHaveLength(2);
  }, 120_000);

  it("@AC-22 ilk sağlayıcı çağrısı 503 → iş yeniden denenir; her çağrıda aynı Idempotency-Key; satır yalnızca başarıdan sonra", async () => {
    const { provider, jobId } = await emailScenario((n) => (n === 1 ? 503 : 200));
    await waitFor(async () => (await jobState(jobId)) === "retry", "503 → retry");
    expect(await processedCount(EMAIL_SEND_JOB_TYPE, jobId), "başarısız çağrıdan sonra satır yok").toBe(0);
    await forceRedelivery(jobId);
    await waitFor(async () => (await jobState(jobId)) === "completed", "ikinci teslim tamamlanır");
    expect(provider.calls.map((c) => c.key)).toEqual([jobId, jobId]);
    expect(await processedCount(EMAIL_SEND_JOB_TYPE, jobId)).toBe(1);
  }, 90_000);
});
