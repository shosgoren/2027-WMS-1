// T-281 (AC-16 genişletmesi, dış inceleme bulgu 1): worker ZORLA öldürülünce (SIGKILL) `active` kalan HER türden iş, süresi dolunca kuyruk bakımıyla
// (`startQueueMaintenance`; adaptör supervise:false) yeniden teslim edilir ya da denemeleri bitince `failed` + alarm logu olur; iş etkisi TAM bir kez.
// Çocuk süreç: gerçek handler'lar (esbuild ile paketlenmiş worker kaynağı) + gerçek rol ayrımı (wms_app/wms_worker). Zarif kapanış testi DEĞİL: kill -9.
// Süre aşımı gerçekten beklenir (işin `expire_seconds` değeri kısaltılır, zaman ileri alınmaz). Fikstürler sentetiktir (G-09).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withSystemTenant, withUser } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { QUEUE_EXPIRE_SECONDS, consumeOnce, createJobQueue, installQueueSchema, type PgBossJobQueue } from "../../../packages/queue-adapter/src/index.ts";
import { PLATFORM_NO_USER_ID } from "../../../packages/shared/src/queue.ts";
import { EMAIL_SEND_JOB_TYPE, buildEmailSendPayload, loadMailConfig } from "../../../packages/shared/src/mailer.ts";
import { createSealer } from "../../../packages/shared/src/seal.ts";
import { approveDocument, createStockDocument, postDocument, type DocumentLineInput, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import type { ConsumeOnceFn } from "../../../packages/domain/src/stock/jobs.ts";
import { createSendEmailHandler } from "../../../apps/worker/src/jobs/send-email.ts";
import { createResendMailer } from "../../../apps/worker/src/mail/resend.ts";
import { createPostStockDocumentHandler } from "../../../apps/worker/src/jobs/post-stock-document.ts";
import { startQueueMaintenance } from "../../../apps/worker/src/jobs/queue-maintenance.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const reg = newRegistry();
const ROOT = path.resolve(import.meta.dirname, "../../..");
const API_KEY = `k_${randomBytes(12).toString("hex")}`;
const SEAL_KEY = randomBytes(32).toString("hex");
/** Süresi dolmasının beklendiği kısa süre (sn); "erken kurtarma yok" varsayımı için yeterince uzun. */
const EXPIRE_SECONDS = 12;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);

let app: DbClient;
let workerDb: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let producer: PgBossJobQueue;
let outDir: string;
let bundle: string;
const cleanups: (() => Promise<void> | void)[] = [];
const jobIds: string[] = [];

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}
async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${what}`);
}
const jobRow = async (id: string) =>
  (await q<{ state: string; retry_count: number; retry_limit: number; unexpired: boolean }>(
    "SELECT state::text AS state, retry_count, retry_limit, (started_on + expire_seconds * interval '1 second') > now() AS unexpired FROM pgboss.job WHERE id = $1", [id]))[0];

// --- sahte e-posta sağlayıcısı (gerçek HTTP; Resend arayüzü) ---------------------------------------------------------------
interface ProviderCall { key: string | undefined; answered: boolean }
interface Provider { calls: ProviderCall[]; baseUrl: string; held: Promise<void>; holdFirst: boolean }
async function startProvider(holdFirst: boolean): Promise<Provider> {
  const calls: ProviderCall[] = [];
  const hung: ServerResponse[] = [];
  let signalHeld: () => void = () => undefined;
  const held = new Promise<void>((r) => (signalHeld = r));
  const server: Server = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on("end", () => {
      const call: ProviderCall = { key: req.headers["idempotency-key"] as string | undefined, answered: false };
      calls.push(call);
      if (holdFirst && calls.length === 1) {
        hung.push(res); // yanıt verilmez: istemci işleyici içinde askıda (worker kill -9 ile öldürülür)
        signalHeld();
        return;
      }
      call.answered = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: uuid() }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(async () => {
    for (const r of hung) r.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, held, holdFirst };
}

// --- çocuk süreç: gerçek worker kaynağı paketlenir (esbuild; apps/worker build ile aynı araç) ----------------------------------
const CHILD_ENTRY = `
import { createDbClient, withSystemTenant, withUser } from "@wms/db";
import { consumeOnce, createJobQueue } from "@wms/queue-adapter";
import { PLATFORM_NO_USER_ID } from "@wms/shared/queue";
import { loadMailConfig } from "@wms/shared/mailer";
import { createSealer } from "@wms/shared/seal";
import { createSendEmailHandler } from "./jobs/send-email.js";
import { createResendMailer } from "./mail/resend.js";
import { createPostStockDocumentHandler } from "./jobs/post-stock-document.js";
const only = process.env.ONLY_JOB;
const client = createDbClient({ url: process.env.DATABASE_URL, poolMax: 2, prepare: false });
const logger = { info() {}, error() {} };
const queue = createJobQueue({
  connectionString: process.env.DATABASE_URL_WORKER,
  pollingIntervalSeconds: 0.5,
  runInTenant: (tenantId, reason, fn) => withSystemTenant(client, tenantId, "queue." + reason, fn),
  runPlatform: (fn) => withUser(client, PLATFORM_NO_USER_ID, fn),
  logger,
});
await queue.start();
if (process.env.SCENARIO === "email") {
  const config = loadMailConfig({ MAIL_MODE: "resend", RESEND_API_KEY: process.env.API_KEY, MAIL_FROM: "noreply@example.invalid", MAIL_VERIFIED_DOMAIN: "example.invalid" });
  const handler = createSendEmailHandler({ sealer: createSealer(process.env.SEAL_KEY), config, mailer: createResendMailer({ apiKey: process.env.API_KEY, from: "noreply@example.invalid", baseUrl: process.env.PROVIDER_URL }), logger });
  await queue.work("email.send", (ctx) => (ctx.jobId === only ? handler(ctx) : Promise.resolve()));
} else {
  // Etkiler yazıldıktan sonra transaction AÇIKKEN sonsuza dek bekler.
  const hang = (tx, consumer, id, fn) => consumeOnce(tx, consumer, id, async (t) => { const r = await fn(t); console.log("IN_TX"); await new Promise(() => {}); return r; });
  const handler = createPostStockDocumentHandler({ db: client, consumeOnce: hang, logger });
  await queue.work("stock.document.post", (ctx) => (ctx.jobId === only ? handler(ctx) : Promise.resolve()));
}
console.log("READY");
setInterval(() => {}, 1 << 30);
`;

interface Child { ready: Promise<void>; inTx: () => Promise<void>; kill: () => Promise<void>; proc: ChildProcess }
function spawnWorker(scenario: "email" | "stock", onlyJob: string, providerUrl = ""): Child {
  const proc = spawn(process.execPath, [bundle], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: env.databaseUrl,
      DATABASE_URL_WORKER: workerUrl,
      SCENARIO: scenario,
      ONLY_JOB: onlyJob,
      PROVIDER_URL: providerUrl,
      API_KEY,
      SEAL_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  proc.stdout?.on("data", (b: Buffer) => void (out += b.toString()));
  proc.stderr?.on("data", (b: Buffer) => void (err += b.toString()));
  const wait = (token: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${token}: ${err.slice(0, 500)}`)), 60_000);
      const poll = setInterval(() => {
        if (out.includes(token)) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
      proc.once("exit", (code, signal) => {
        if (!out.includes(token)) {
          clearInterval(poll);
          clearTimeout(timer);
          reject(new Error(`child exited (${String(code ?? signal)}) before ${token}: ${err.slice(0, 500)}`));
        }
      });
    });
  const kill = (): Promise<void> =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once("exit", () => resolve());
      proc.kill("SIGKILL");
    });
  cleanups.push(kill);
  return { ready: wait("READY"), inTx: () => wait("IN_TX"), kill, proc };
}

// --- ikinci (sağlıklı) worker + bakım: süreç içi, gerçek handler'lar ---------------------------------------------------------
interface Rec { level: string; msg: string; fields?: Record<string, unknown> }
async function startRecoveryWorker(scenario: "email" | "stock", onlyJob: string, providerUrl = ""): Promise<{ logs: Rec[]; maintenance: ReturnType<typeof startQueueMaintenance> }> {
  const logs: Rec[] = [];
  const logger = {
    info: (msg: string, fields?: Record<string, unknown>) => void logs.push({ level: "info", msg, ...(fields === undefined ? {} : { fields }) }),
    error: (msg: string, fields?: Record<string, unknown>) => void logs.push({ level: "error", msg, ...(fields === undefined ? {} : { fields }) }),
  };
  const queue = createJobQueue({
    connectionString: workerUrl,
    max: 3,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 10_000,
    runInTenant: (tenantId, reason, fn) => withSystemTenant(app, tenantId, `queue.${reason}`, fn),
    runPlatform: (fn) => withUser(app, PLATFORM_NO_USER_ID, fn),
  });
  await queue.start();
  if (scenario === "email") {
    const config = loadMailConfig({ MAIL_MODE: "resend", RESEND_API_KEY: API_KEY, MAIL_FROM: "noreply@example.invalid", MAIL_VERIFIED_DOMAIN: "example.invalid" });
    const handler = createSendEmailHandler({
      sealer: createSealer(SEAL_KEY),
      config,
      mailer: createResendMailer({ apiKey: API_KEY, from: "noreply@example.invalid", baseUrl: providerUrl }),
      logger: { info: () => undefined, error: () => undefined },
    });
    await queue.work("email.send", (ctx) => (ctx.jobId === onlyJob ? handler(ctx) : Promise.resolve()));
  } else {
    const handler = createPostStockDocumentHandler({ db: app, consumeOnce: consumeOnce as unknown as ConsumeOnceFn, logger: { info: () => undefined, error: () => undefined } });
    await queue.work("stock.document.post", (ctx) => (ctx.jobId === onlyJob ? handler(ctx) : Promise.resolve()));
  }
  // Bakım: gerçek `startQueueMaintenance` (main.ts ile aynı işlev); yalnızca aralık kısa.
  const maintenance = startQueueMaintenance({ workerDb, db: app, logger, intervalMs: 500 });
  cleanups.push(async () => {
    maintenance.stop();
    await queue.stop();
  });
  return { logs, maintenance };
}

// --- e-posta işi -----------------------------------------------------------------------------------------------------------
async function enqueueEmail(retryLimit: number): Promise<string> {
  const payload = buildEmailSendPayload(createSealer(SEAL_KEY), {
    template: "password_reset",
    locale: "tr",
    to: `alice.${hex(6)}@example.invalid`,
    link: `https://app.example.invalid/reset/${hex(24)}`,
    tenantId: null,
  });
  const { jobId } = await producer.enqueuePlatform({ type: "email.send", payload: { ...payload, sealed: { ...payload.sealed } } });
  expect(jobId).not.toBeNull();
  const id = jobId as string;
  jobIds.push(id);
  // Süre aşımı gerçekten beklenir: yalnızca bu işin süresi kısaltılır; deneme hakkı senaryoya göre.
  await q("UPDATE pgboss.job SET expire_seconds = $2, retry_limit = $3 WHERE id = $1", [id, EXPIRE_SECONDS, retryLimit]);
  return id;
}
const processedCount = async (consumer: string, jobId: string): Promise<number> =>
  Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.processed_events WHERE consumer = $1 AND event_id = $2", [consumer, jobId]))[0]?.n);

// --- stok işleme işi -------------------------------------------------------------------------------------------------------
const NO_WAIT = { sleep: async () => undefined } as const;
const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const asUser = (userId: string): StockDocCallParams & { queue: PgBossJobQueue } => ({
  db: app, principal: { userId, mfaVerified: true }, tenantSlug: A.slug, clientKey: uuid(), retry: NO_WAIT, timeouts: WIDE, queue: producer,
});
const ln = (itemId: string, over: Partial<DocumentLineInput>): DocumentLineInput => ({
  itemId, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", ...over,
});
async function enqueueStockPost(): Promise<{ docId: string; jobId: string }> {
  const item = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T281 urun',$4,'NONE',0)", [A.tenantId, item, `I-${hex(10)}`, A.unitId]);
  const loc = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T281 lok',0,'STORAGE',false)", [A.tenantId, loc, A.warehouseId, `L-${hex(10)}`]);
  // 250 satır: eşik üstü → işleme kuyruğa gider (ADR-018 §6).
  const lines = Array.from({ length: 250 }, () => ln(item, { targetLocationId: loc }));
  const c = await createStockDocument(asUser(A.ownerUserId), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines });
  const docId = c.documentId as string;
  await approveDocument(asUser(A.ownerUserId), { documentId: docId, expectedVersion: 1 });
  const version = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id = $1", [docId]))[0]?.version as number;
  const out = await postDocument(asUser(A.memberUserId), { documentId: docId, expectedVersion: version });
  expect(out).toMatchObject({ status: "PROCESSING" });
  const jobId = (await q<{ id: string }>("SELECT id FROM pgboss.job WHERE name = 'stock.document.post' AND data->'payload'->>'documentId' = $1", [docId]))[0]?.id as string;
  jobIds.push(jobId);
  await q("UPDATE pgboss.job SET expire_seconds = $2 WHERE id = $1", [jobId, EXPIRE_SECONDS]);
  return { docId, jobId };
}
const ledgerCount = async (docId: string): Promise<number> =>
  Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_ledger WHERE tenant_id = $1 AND document_id = $2", [A.tenantId, docId]))[0]?.n);
async function docLockReleased(docId: string): Promise<void> {
  await waitFor(async () => {
    await adm.query("BEGIN");
    try {
      await adm.query("SELECT 1 FROM public.documents WHERE id = $1 FOR UPDATE NOWAIT", [docId]);
      return true;
    } catch (e) {
      return (e as { code?: string }).code === "55P03" ? false : Promise.reject(e);
    } finally {
      await adm.query("ROLLBACK");
    }
  }, "document lock released after crash", 30_000);
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  workerDb = createDbClient({ url: workerUrl, poolMax: 2, prepare: false });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  await installQueueSchema({ url: env.databaseUrlDirect });
  A = await seedWorld(adm, reg, "A281");
  const counter = await mkUser(adm, reg, "counter281");
  await mkMembership(adm, A.tenantId, counter, { roles: ["COUNTER"] });
  producer = createJobQueue({ connectionString: env.databaseUrl, max: 3, stopTimeoutMs: 5000 });
  await producer.start();
  // Çocuk süreç paketi: apps/worker'ın kendi build'iyle aynı araç/ayarlar (esbuild; yerel ikili argon2 dışarıda).
  outDir = mkdtempSync(path.join(tmpdir(), "wms-t281-"));
  bundle = path.join(outDir, "crash-worker.mjs");
  const esbuild = (await import(pathToFileURL(path.join(ROOT, "apps/worker/node_modules/esbuild/lib/main.js")).href)) as typeof import("../../../apps/worker/node_modules/esbuild/lib/main.js");
  await esbuild.build({
    stdin: { contents: CHILD_ENTRY, resolveDir: path.join(ROOT, "apps/worker/src"), sourcefile: "crash-worker.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["@node-rs/argon2"],
    outfile: bundle,
    logLevel: "warning",
    banner: { js: "import { createRequire as __wmsCreateRequire } from 'node:module'; const require = __wmsCreateRequire(import.meta.url);" },
  });
}, 180_000);

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  if (jobIds.length > 0) await q("DELETE FROM pgboss.job WHERE id = ANY($1::uuid[])", [jobIds.splice(0)]);
});

afterAll(async () => {
  await producer.stop();
  await adm.end();
  await workerDb.close();
  await app.close();
  rmSync(outDir, { recursive: true, force: true });
}, 60_000);

describe("kuyruk süre tablosu", () => {
  it("kurulu kuyruklar QUEUE_EXPIRE_SECONDS ile hizalıdır (her tür için açık expireInSeconds)", async () => {
    const rows = await q<{ name: string; expire_seconds: number }>("SELECT name, expire_seconds FROM pgboss.queue");
    for (const [type, secs] of Object.entries(QUEUE_EXPIRE_SECONDS)) {
      expect(rows.find((r) => r.name === type)?.expire_seconds, type).toBe(secs);
    }
  });
});

describe("AC-16 (T-281): gerçek SIGKILL → süresi dolan active iş kurtarılır (e-posta)", () => {
  it("kill -9 sonrası iş 'active' kalır, süresi dolunca bakım retry'a çevirir, yeni worker gönderir: sağlayıcıya TAM 1 başarılı teslim, tek processed_events", async () => {
    const provider = await startProvider(true);
    const jobId = await enqueueEmail(5);
    const child = spawnWorker("email", jobId, provider.baseUrl);
    await child.ready;
    await provider.held; // işleyici sağlayıcı çağrısında askıda; etki henüz gerçekleşmedi
    expect((await jobRow(jobId))?.state).toBe("active");
    await child.kill();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ key: jobId, answered: false });

    // Çökme sonrası: iş kendiliğinden geri dönmez (supervise yok) ve süresi dolmamış iş bakımda dokunulmaz.
    const { logs } = await startRecoveryWorker("email", jobId, provider.baseUrl);
    await sleep(2000);
    expect(await jobRow(jobId)).toMatchObject({ state: "active", retry_count: 0, unexpired: true });
    expect(provider.calls).toHaveLength(1);

    // Süre dolar (gerçek bekleme) → bakım retry'a çevirir → yeniden teslim → tek etki.
    await waitFor(async () => (await jobRow(jobId))?.state === "completed", "job completed after expiry", 90_000);
    expect(await jobRow(jobId)).toMatchObject({ state: "completed", retry_count: 1 });
    expect(provider.calls.filter((c) => c.answered)).toHaveLength(1);
    expect(provider.calls.every((c) => c.key === jobId)).toBe(true);
    expect(await processedCount(EMAIL_SEND_JOB_TYPE, jobId)).toBe(1);
    expect(logs.find((l) => l.msg === "queue.maintenance.requeued_expired")).toMatchObject({ level: "info", fields: { count: 1, byType: { "email.send": 1 } } });
    expect(logs.some((l) => l.msg === "queue.maintenance.expired_exhausted")).toBe(false);
  }, 150_000);

  it("deneme hakkı bitmişse süresi dolan iş 'failed' olur ve ALARM logu yazılır; iş etkisi YOK, yeniden teslim YOK", async () => {
    const provider = await startProvider(true);
    const jobId = await enqueueEmail(0);
    const child = spawnWorker("email", jobId, provider.baseUrl);
    await child.ready;
    await provider.held;
    await child.kill();
    const { logs, maintenance } = await startRecoveryWorker("email", jobId, provider.baseUrl);
    await sleep(2000);
    expect(await jobRow(jobId)).toMatchObject({ state: "active", unexpired: true });

    await waitFor(async () => (await jobRow(jobId))?.state === "failed", "job failed after expiry", 90_000);
    expect(await jobRow(jobId)).toMatchObject({ state: "failed", retry_count: 0 });
    const alarm = logs.find((l) => l.msg === "queue.maintenance.expired_exhausted");
    expect(alarm).toMatchObject({ level: "error", fields: { count: 1, byType: { "email.send": 1 }, jobIds: [jobId] } });
    // Yeni worker işi yeniden almaz; etki hiç gerçekleşmedi.
    await sleep(2500);
    expect(await jobRow(jobId)).toMatchObject({ state: "failed", retry_count: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls.filter((c) => c.answered)).toHaveLength(0);
    expect(await processedCount(EMAIL_SEND_JOB_TYPE, jobId)).toBe(0);
    expect(maintenance.totals().exhausted).toBe(1);
  }, 150_000);
});

describe("AC-16 (T-281): gerçek SIGKILL → süresi dolan active iş kurtarılır (stok işleme)", () => {
  it("transaction açıkken kill -9: etki geri alınır (0 satır); süre dolunca bakım retry'a çevirir; yeni worker işler → defterde TAM 250 satır, belge POSTED", async () => {
    const { docId, jobId } = await enqueueStockPost();
    const child = spawnWorker("stock", jobId);
    await child.ready;
    await child.inTx(); // etkiler yazıldı, transaction açık
    expect((await jobRow(jobId))?.state).toBe("active");
    await child.kill();
    await docLockReleased(docId);
    expect(await ledgerCount(docId)).toBe(0);

    const { logs } = await startRecoveryWorker("stock", jobId);
    await sleep(2000);
    expect(await jobRow(jobId)).toMatchObject({ state: "active", unexpired: true });
    expect(await ledgerCount(docId)).toBe(0);

    await waitFor(async () => (await jobRow(jobId))?.state === "completed", "stock job completed after expiry", 90_000);
    expect(await ledgerCount(docId)).toBe(250);
    expect((await q<{ status: string }>("SELECT status FROM public.documents WHERE id = $1", [docId]))[0]?.status).toBe("POSTED");
    expect(await jobRow(jobId)).toMatchObject({ retry_count: 1 });
    expect(logs.find((l) => l.msg === "queue.maintenance.requeued_expired")).toMatchObject({ fields: { count: 1, byType: { "stock.document.post": 1 } } });
  }, 150_000);
});
