// T-222 (AC-36 girdisi): eşik üstü belge worker'da tek transaction'da işlenir. GERÇEK roller (wms_app, wms_worker), PgBouncer, gerçek pg-boss.
// Kapsam: aynı idempotency anahtarı, istek sahibi aktör, işleme kilidi, kalıcı hata (FAILED), worker çökmesi (gerçek SIGKILL) + bakım eşdeğeri ile yeniden teslim,
// sert sınır, ölçüm (madde 7). Fikstürler sentetiktir (G-09). Fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withSystemTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { consumeOnce, createJobQueue, installQueueSchema, type PgBossJobQueue } from "../../../packages/queue-adapter/src/index.ts";
import {
  approveDocument,
  cancelDocument,
  createStockDocument,
  postDocument,
  reserve,
  updateDraft,
  type DocumentLineInput,
  type StockDocCallParams,
} from "../../../packages/domain/src/stock/index.ts";
import { getPostingStatus } from "../../../packages/domain/src/stock/posting.ts";
import type { ConsumeOnceFn } from "../../../packages/domain/src/stock/jobs.ts";
import { createPostStockDocumentHandler, sweepExpiredPostingJobsOnWorker } from "../../../apps/worker/src/jobs/post-stock-document.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const reg = newRegistry();
const ROOT = path.resolve(import.meta.dirname, "../../..");
let app: DbClient;
let workerDb: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let counterUserId: string;
let producer: PgBossJobQueue;
const workers: PgBossJobQueue[] = [];

const NO_WAIT = { sleep: async () => undefined } as const;
const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const silent = { info: () => undefined, error: () => undefined };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const asUser = (userId: string, key: string | null = uuid(), extra: Partial<StockDocCallParams> = {}): StockDocCallParams & { queue: PgBossJobQueue } => ({
  db: app,
  principal: { userId, mfaVerified: true },
  tenantSlug: A.slug,
  clientKey: key,
  retry: NO_WAIT,
  timeouts: WIDE,
  queue: producer,
  ...extra,
});
const ownerP = (key: string | null = uuid()) => asUser(A.ownerUserId, key);
const pickerP = (key: string | null = uuid()) => asUser(A.memberUserId, key);

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}
async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}
const codeOf = (e: AppError): string => (e.detail === undefined ? e.code : `${e.code}/${e.detail}`);
async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

// --- fikstürler -------------------------------------------------------------------------------------------------------
async function mkItem(): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T222 urun',$4,'NONE',0)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId,
  ]);
  return id;
}
async function mkLoc(): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T222 lok',0,'STORAGE',false)", [
    A.tenantId, id, A.warehouseId, `L-${hex(10)}`,
  ]);
  return id;
}
const ln = (itemId: string, over: Partial<DocumentLineInput>): DocumentLineInput => ({
  itemId, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", ...over,
});
const many = (n: number, f: (i: number) => DocumentLineInput): DocumentLineInput[] => Array.from({ length: n }, (_, i) => f(i));
const docRow = async (id: string) =>
  (await q<{ status: string; version: number; number: string | null; posting_job_id: string | null; posting_requested_by: string | null; created_by: string }>(
    "SELECT status, version, number, posting_job_id, posting_requested_by, created_by FROM public.documents WHERE id = $1", [id]))[0] as {
    status: string; version: number; number: string | null; posting_job_id: string | null; posting_requested_by: string | null; created_by: string;
  };

interface Doc { id: string; version: number; lines: string[] }
async function mkApproved(kind: "STOCK_IN" | "STOCK_OUT", lines: DocumentLineInput[], creator: string = A.ownerUserId): Promise<Doc> {
  const c = await createStockDocument(asUser(creator), { kind, warehouseId: A.warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = await docRow(id);
  expect(v.status).toBe("APPROVED");
  const lineIds = (await q<{ id: string }>("SELECT id FROM public.document_lines WHERE document_id = $1 ORDER BY line_no", [id])).map((r) => r.id);
  return { id, version: v.version, lines: lineIds };
}
const requestPost = (d: Doc, p: StockDocCallParams & { queue: PgBossJobQueue } = pickerP()) =>
  postDocument(p, { documentId: d.id, expectedVersion: d.version });
const jobsOf = (docId: string) =>
  q<{ id: string; state: string; retry_count: number; started_on: Date | null; completed_on: Date | null }>(
    `SELECT id, state::text AS state, retry_count, started_on, completed_on FROM pgboss.job
      WHERE name = 'stock.document.post' AND data->'payload'->>'documentId' = $1 ORDER BY created_on`, [docId]);
const ledgerOf = (docId: string) =>
  q<{ quantity: string; created_xid: string; actor_user_id: string }>(
    "SELECT quantity::text AS quantity, created_xid::text AS created_xid, actor_user_id FROM public.stock_ledger WHERE tenant_id = $1 AND document_id = $2", [A.tenantId, docId]);
const idemOf = (clientKey: string) =>
  q<{ id: string; status: string; error_code: string | null; actor_user_id: string }>(
    "SELECT id, status, error_code, actor_user_id FROM public.idempotency_records WHERE tenant_id = $1 AND command_type = 'stock.document.post' AND client_key = $2", [A.tenantId, clientKey]);
const physical = async (item: string): Promise<string> =>
  Number((await q<{ s: string }>(
    "SELECT COALESCE(sum(b.quantity),0)::text AS s FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2",
    [A.tenantId, item]))[0]?.s).toFixed(6);
const statusOf = (docId: string) => getPostingStatus({ db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug }, docId);

function newWorker(
  consume: ConsumeOnceFn = consumeOnce as unknown as ConsumeOnceFn,
  /** Test kancası: `ctx.inTenant` çağrılarından HEMEN ÖNCE (1'den başlayan sıra numarasıyla) çalışır. */
  beforeInTenant?: (nth: number) => Promise<void>,
): Promise<PgBossJobQueue> {
  let nth = 0;
  const w = createJobQueue({
    connectionString: workerUrl,
    max: 3,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 20_000,
    runInTenant: async (tenantId, reason, fn) => {
      if (beforeInTenant !== undefined) await beforeInTenant(++nth);
      return withSystemTenant(app, tenantId, `queue.${reason}`, fn);
    },
  });
  workers.push(w);
  return w.start().then(async () => {
    await w.work("stock.document.post", createPostStockDocumentHandler({ db: app, consumeOnce: consume, logger: silent }));
    return w;
  });
}
async function stopWorkers(): Promise<void> {
  while (workers.length > 0) await workers.pop()?.stop();
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  workerDb = createDbClient({ url: workerUrl, poolMax: 2, prepare: false });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  await installQueueSchema({ url: env.databaseUrlDirect });
  A = await seedWorld(adm, reg, "A222");
  counterUserId = await mkUser(adm, reg, "counter222");
  await mkMembership(adm, A.tenantId, counterUserId, { roles: ["COUNTER"] });
  producer = createJobQueue({ connectionString: env.databaseUrl, max: 3, stopTimeoutMs: 5000 });
  await producer.start();
}, 120_000);

afterEach(async () => {
  await stopWorkers();
  await q("DELETE FROM pgboss.job WHERE name = 'stock.document.post' AND data->>'tenantId' = $1", [A.tenantId]);
});

afterAll(async () => {
  await stopWorkers();
  await producer.stop();
  await adm.end();
  await workerDb.close();
  await app.close();
}, 60_000);

describe("AC-36: eşik üstü belge (250 satır) worker'da, aynı anahtar", () => {
  it("istek PROCESSING döner; worker koşunca tek transaction'da POSTED; tekrar istek yeni iş üretmez; aynı anahtar saklı sonucu döner", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    const out = await requestPost(d, pickerP(key));
    expect(out).toMatchObject({ status: "PROCESSING", documentId: d.id });
    const row = await docRow(d.id);
    expect(row.status).toBe("APPROVED");
    expect(row.posting_job_id).not.toBeNull();
    expect(row.posting_requested_by).toBe(A.memberUserId);
    expect(await ledgerOf(d.id)).toHaveLength(0);
    expect((await idemOf(key))[0]).toMatchObject({ status: "IN_PROGRESS", actor_user_id: A.memberUserId });
    expect(await statusOf(d.id)).toEqual({ status: "PROCESSING" });

    // Aynı anahtarla tekrar → IN_PROGRESS sonucu (PROCESSING), yeni iş yok.
    expect(await requestPost(d, pickerP(key))).toMatchObject({ status: "PROCESSING", documentId: d.id });
    expect(await jobsOf(d.id)).toHaveLength(1);
    expect(((await jobsOf(d.id))[0] as { id: string }).id).toBe(row.posting_job_id);

    await newWorker();
    await waitFor(async () => (await docRow(d.id)).status === "POSTED", "document POSTED");
    const ledger = await ledgerOf(d.id);
    expect(ledger).toHaveLength(250);
    expect(new Set(ledger.map((l) => l.created_xid)).size).toBe(1); // tek transaction
    expect(await physical(x)).toBe("250.000000");
    const after = await docRow(d.id);
    expect(after).toMatchObject({ status: "POSTED", posting_job_id: null });
    expect(after.number).not.toBeNull();
    expect((await idemOf(key))[0]).toMatchObject({ status: "COMPLETED" });
    expect(await statusOf(d.id)).toEqual({ status: "POSTED" });
    expect(await q("SELECT 1 FROM public.processed_events WHERE tenant_id = $1 AND consumer = 'stock.document.post' AND event_id = $2", [A.tenantId, row.posting_job_id])).toHaveLength(1);
    await waitFor(async () => (await jobsOf(d.id))[0]?.state === "completed", "job completed");

    // Tamamlandıktan sonra aynı anahtar = saklı sonuç; farklı kullanıcı aynı anahtarla → IDEMPOTENCY_MISMATCH.
    const replay = await requestPost(d, pickerP(key));
    expect(replay).toMatchObject({ status: "POSTED", documentId: d.id, replayed: true, documentNumber: after.number });
    expect(codeOf(await failure(requestPost(d, asUser(A.ownerUserId, key))))).toBe("IDEMPOTENCY_MISMATCH");
    expect(await ledgerOf(d.id)).toHaveLength(250); // ikinci etki yok
    expect(await jobsOf(d.id)).toHaveLength(1);
  }, 120_000);

  it("istek sahibi aktör: belgeyi stock.post izni olmayan kullanıcı oluşturdu, yetkili kullanıcı işleme istedi → audit ve defter aktörü işleme isteyen", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(201, () => ln(x, { targetLocationId: loc })), counterUserId);
    expect((await docRow(d.id)).created_by).toBe(counterUserId);
    await requestPost(d, pickerP());
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).status === "POSTED", "document POSTED");
    const audit = await q<{ actor_user_id: string }>(
      "SELECT actor_user_id FROM public.audit_logs WHERE tenant_id = $1 AND action = 'stock_document.posted' AND entity_id = $2", [A.tenantId, d.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_user_id).toBe(A.memberUserId);
    expect(new Set((await ledgerOf(d.id)).map((l) => l.actor_user_id))).toEqual(new Set([A.memberUserId]));
    const hist = await q<{ actor_user_id: string; to_status: string }>(
      "SELECT actor_user_id, to_status FROM public.document_status_history WHERE tenant_id = $1 AND document_id = $2 AND to_status = 'POSTED'", [A.tenantId, d.id]);
    expect(hist[0]?.actor_user_id).toBe(A.memberUserId);
  }, 120_000);

  it("işleme kilidi: PROCESSING iken cancelDocument / updateDraft / approveDocument / reserve / yeni anahtarlı postDocument → DOCUMENT_STATE; durum değişmez", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const stockDoc = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: loc, quantity: "300", baseQuantity: "300" })]);
    await postDocument(ownerP(), { documentId: stockDoc.id, expectedVersion: stockDoc.version });
    const d = await mkApproved("STOCK_OUT", many(250, () => ln(x, { sourceLocationId: loc })));
    await requestPost(d);
    const v = await docRow(d.id);
    expect(v.posting_job_id).not.toBeNull();
    const cases: [string, () => Promise<unknown>][] = [
      ["cancelDocument", () => cancelDocument(ownerP(), { documentId: d.id, expectedVersion: v.version })],
      ["updateDraft", () => updateDraft(ownerP(), { documentId: d.id, expectedVersion: v.version, reason: "x" })],
      ["approveDocument", () => approveDocument(ownerP(), { documentId: d.id, expectedVersion: v.version })],
      ["reserve", () => reserve(ownerP(), { documentLineId: d.lines[0] as string, allocations: [{ dimension: { locationId: loc }, quantity: "1" }] })],
      ["postDocument (yeni anahtar)", () => requestPost({ ...d, version: v.version }, pickerP())],
    ];
    for (const [name, run] of cases) {
      expect(codeOf(await failure(run())), name).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    }
    // Eski sürümle (istek sürümü değiştirdi) yeni anahtar → sürüm denetimi önce: VERSION_CONFLICT (belge değişmez).
    expect((await failure(requestPost(d, pickerP()))).code).toBe("VERSION_CONFLICT");
    const after = await docRow(d.id);
    expect(after).toMatchObject({ status: "APPROVED", posting_job_id: v.posting_job_id, version: v.version });
    expect(await jobsOf(d.id)).toHaveLength(1);
    // İş koşunca belge işlenir (kilit yalnızca işleme süresince): STOCK_OUT 250 → bakiye 50.
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).status === "POSTED", "document POSTED");
    expect(await physical(x)).toBe("50.000000");
  }, 180_000);

  it("kalıcı hata: istek sahibinin üyeliği kalkınca → FAILED (FORBIDDEN), belge APPROVED + kilit yok, stok etkisi yok, iş kalıcı başarısız", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const lostUser = await mkUser(adm, reg, "lost222");
    const lostMembership = await mkMembership(adm, A.tenantId, lostUser, { roles: ["PICKER"] });
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, asUser(lostUser, key));
    await q("DELETE FROM public.membership_roles WHERE tenant_id = $1 AND membership_id = $2", [A.tenantId, lostMembership]);
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).posting_job_id === null, "failure recorded");
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "FORBIDDEN" });
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED", posting_requested_by: null });
    expect(await ledgerOf(d.id)).toHaveLength(0);
    expect(await physical(x)).toBe("0.000000");
    expect(await statusOf(d.id)).toEqual({ status: "FAILED", errorCode: "FORBIDDEN" });
    await waitFor(async () => (await jobsOf(d.id))[0]?.state === "failed", "job failed (kalıcı)");
    expect((await jobsOf(d.id))[0]?.retry_count).toBe(0); // ilk alımda sayaç 0; yeniden teslim yok (kalıcı hata)
    expect(await q("SELECT 1 FROM public.processed_events WHERE tenant_id = $1 AND consumer = 'stock.document.post' AND event_id = $2", [A.tenantId, (await jobsOf(d.id))[0]?.id])).toHaveLength(1);
    // Aynı anahtarla tekrar → saklı ret (FAILED), yeni iş yok.
    expect(codeOf(await failure(requestPost(d, asUser(lostUser, key))))).toBe("FORBIDDEN"); // üyelik yok: yetki katmanı önce
    expect(await jobsOf(d.id)).toHaveLength(1);
  }, 120_000);

  it("kalıcı hata: iş kuralı reddi (INSUFFICIENT_STOCK) → FAILED, stok etkisi yok; yeni anahtarla yeniden istenebilir", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_OUT", many(250, () => ln(x, { sourceLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).posting_job_id === null, "failure recorded");
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "INSUFFICIENT_STOCK" });
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED" });
    expect(await ledgerOf(d.id)).toHaveLength(0);
    expect(await statusOf(d.id)).toEqual({ status: "FAILED", errorCode: "INSUFFICIENT_STOCK" });
    // Yeni anahtar yeni istek: kilit açık olduğundan kabul edilir (PROCESSING).
    expect(await requestPost({ ...d, version: (await docRow(d.id)).version }, pickerP())).toMatchObject({ status: "PROCESSING" });
  }, 120_000);

  it("sert sınır: > 2.000 satır DOCUMENT_TOO_LARGE; işleme anında yeniden denetlenir (istekten sonra eklenen satırlar → FAILED)", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    // İstek anında 2.001 satır (bakım yolu simülasyonu: tetikleyiciler atlanır) → senkron istek aşırı belgeyi reddeder.
    const addLines = async (docId: string, total: number): Promise<void> => {
      await adm.query("BEGIN");
      try {
        await adm.query("SET LOCAL session_replication_role = replica");
        await adm.query(
          `INSERT INTO public.document_lines (tenant_id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id)
           SELECT tenant_id, document_id, g, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id
             FROM public.document_lines, generate_series(251, $2::int) g WHERE document_id = $1 AND line_no = 1`, [docId, total]);
        await adm.query("COMMIT");
      } catch (e) {
        await adm.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    };
    // (a) istek anında aşırı: reddedilir
    const big = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    await addLines(big.id, 2001);
    expect(codeOf(await failure(requestPost(big)))).toBe("VALIDATION_FAILED/DOCUMENT_TOO_LARGE");
    expect((await docRow(big.id)).posting_job_id).toBeNull();
    // (b) istekten sonra aşırı: worker yeniden denetler → FAILED
    const key = uuid();
    await requestPost(d, pickerP(key));
    await addLines(d.id, 2001);
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).posting_job_id === null, "failure recorded");
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "VALIDATION_FAILED/DOCUMENT_TOO_LARGE" });
    expect(await ledgerOf(d.id)).toHaveLength(0);
  }, 120_000);
});

describe("AC-16/AC-36: worker çökmesi (gerçek SIGKILL) ve bakım eşdeğeri ile yeniden teslim", () => {
  /** Çocuk süreç: gerçek worker handler'ı; `consumeOnce` sarmalayıcısı etkileri yazdıktan sonra transaction AÇIKKEN sonsuza dek bekler. */
  function spawnHangingWorker(): { ready: Promise<void>; inTx: Promise<void>; kill: () => Promise<void> } {
    const href = (p: string): string => pathToFileURL(path.join(ROOT, p)).href;
    const script = `
      const [db, qa, h] = await Promise.all([import(${JSON.stringify(href("packages/db/src/index.ts"))}), import(${JSON.stringify(href("packages/queue-adapter/src/index.ts"))}), import(${JSON.stringify(href("apps/worker/src/jobs/post-stock-document.ts"))})]);
      const client = db.createDbClient({ url: process.env.DATABASE_URL, poolMax: 2, prepare: false });
      const logger = { info() {}, error() {} };
      const hang = (tx, consumer, id, fn) => qa.consumeOnce(tx, consumer, id, async (t) => { const r = await fn(t); console.log("IN_TX"); await new Promise(() => {}); return r; });
      const queue = qa.createJobQueue({ connectionString: process.env.DATABASE_URL_WORKER, pollingIntervalSeconds: 0.5, runInTenant: (tenantId, reason, fn) => db.withSystemTenant(client, tenantId, "queue." + reason, fn), logger });
      await queue.start();
      await queue.work("stock.document.post", h.createPostStockDocumentHandler({ db: client, consumeOnce: hang, logger }));
      console.log("READY");
      setInterval(() => {}, 1 << 30);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: env.databaseUrl, DATABASE_URL_WORKER: workerUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const waiters: { token: string; resolve: () => void; reject: (e: Error) => void }[] = [];
    const settle = (): void => {
      for (const w of [...waiters]) {
        if (out.includes(w.token)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    };
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      settle();
    });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString();
    });
    const wait = (token: string): Promise<void> =>
      new Promise((resolve, reject) => {
        waiters.push({ token, resolve, reject });
        settle();
        child.once("exit", (code, signal) => {
          if (!out.includes(token)) reject(new Error(`child exited (${String(code ?? signal)}) before ${token}: ${err.slice(0, 500)}`));
        });
        setTimeout(() => reject(new Error(`timeout waiting for ${token}: ${err.slice(0, 500)}`)), 60_000).unref();
      });
    return {
      ready: wait("READY"),
      inTx: wait("IN_TX"),
      kill: () =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
    };
  }

  /** Çökmüş süreçten kalan sunucu oturumunun belge kilidini bırakması (bağlantı kopması → rollback) beklenir. */
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

  it("handler ortasında SIGKILL: iş 'active' kalır (supervise yok), bakım eşdeğeri retry'a çevirir, yeniden teslimde tek etki", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    await requestPost(d, pickerP());
    const child = spawnHangingWorker();
    try {
      await child.ready;
      await child.inTx; // etkiler yazıldı, transaction açık
      expect((await jobsOf(d.id))[0]?.state).toBe("active");
    } finally {
      await child.kill();
    }
    await docLockReleased(d.id);
    // Çökme sonrası: etki yok (rollback), iş hâlâ 'active'; kendiliğinden geri dönmez.
    expect(await ledgerOf(d.id)).toHaveLength(0);
    expect((await docRow(d.id)).status).toBe("APPROVED");
    await sleep(1500);
    expect((await jobsOf(d.id))[0]?.state).toBe("active");
    // Süresi dolmamış iş bakımda dokunulmaz.
    await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger: silent });
    expect((await jobsOf(d.id))[0]?.state).toBe("active");
    // Süre aşımı simülasyonu (varsayılan 15 dk): başlangıç geçmişe çekilir → bakım eşdeğeri retry'a çevirir.
    await q("UPDATE pgboss.job SET started_on = now() - interval '2 hours' WHERE id = $1", [(await jobsOf(d.id))[0]?.id]);
    await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger: silent });
    expect((await jobsOf(d.id))[0]?.state).toBe("retry");
    // Yeni worker yeniden teslimi işler: tek etki.
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).status === "POSTED", "document POSTED after redelivery");
    expect(await ledgerOf(d.id)).toHaveLength(250);
    expect(await physical(x)).toBe("250.000000");
    expect((await jobsOf(d.id))[0]?.retry_count).toBe(1); // ilk alımda 0; bir yeniden teslim → 1
    await waitFor(async () => (await jobsOf(d.id))[0]?.state === "completed", "job completed");
  }, 180_000);

  it("deneme hakkı biten süresi dolmuş iş 'failed' olur ve bakım turu belgeyi serbest bırakır: belge APPROVED + FAILED(INTERNAL), kilit yok (MAJOR-2)", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    const jobId = (await jobsOf(d.id))[0]?.id;
    await q("UPDATE pgboss.job SET state = 'active', started_on = now() - interval '2 hours', retry_count = retry_limit WHERE id = $1", [jobId]);
    await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger: silent });
    expect((await jobsOf(d.id))[0]?.state).toBe("failed");
    expect(await statusOf(d.id)).toEqual({ status: "FAILED", errorCode: "INTERNAL" });
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED", posting_job_id: null, posting_requested_by: null });
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "INTERNAL" });
    expect(await ledgerOf(d.id)).toHaveLength(0);
    // İşaretlendi: ikinci tur aynı işi yeniden işlemez (belge yeniden istenip kilitlense bile dokunulmaz).
    expect(((await q<{ output: { finalized?: boolean } }>("SELECT output FROM pgboss.job WHERE id = $1", [jobId]))[0] as { output: { finalized?: boolean } }).output.finalized).toBe(true);
    expect(await requestPost({ ...d, version: (await docRow(d.id)).version }, pickerP())).toMatchObject({ status: "PROCESSING" });
    await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger: silent });
    expect(await statusOf(d.id)).toEqual({ status: "PROCESSING" });
  }, 60_000);
});

describe("MAJOR-2: son denetimde geçici hata kalıcı sayılır; askıdaki kiracı bakım turuyla sonlanır", () => {
  /** İlk `consumeOnce` (işleme transaction'ı) geçici hata verir; sonrakiler (kalıcı hata yazımı) gerçek. */
  const failFirst = (): ConsumeOnceFn => {
    let n = 0;
    return (tx, consumer, id, fn) => {
      if (n++ === 0) return Promise.reject(new Error("transient boom"));
      return (consumeOnce as unknown as ConsumeOnceFn)(tx, consumer, id, fn);
    };
  };

  it("son denemede geçici hata → FAILED(INTERNAL), belge APPROVED + kilit yok, iş kalıcı başarısız", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    await q("UPDATE pgboss.job SET retry_count = retry_limit WHERE id = $1", [(await jobsOf(d.id))[0]?.id]);
    await newWorker(failFirst());
    await waitFor(async () => (await docRow(d.id)).posting_job_id === null, "failure recorded on final attempt");
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "INTERNAL" });
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED" });
    expect(await statusOf(d.id)).toEqual({ status: "FAILED", errorCode: "INTERNAL" });
    expect(await ledgerOf(d.id)).toHaveLength(0);
    await waitFor(async () => (await jobsOf(d.id))[0]?.state === "failed", "job failed");
  }, 90_000);

  it("son deneme DEĞİLSE geçici hata belgeyi kilitli bırakır (pg-boss yeniden dener); kalıcı yazım yok", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    await newWorker(failFirst());
    await waitFor(async () => (await jobsOf(d.id))[0]?.state === "retry", "job back to retry");
    expect((await docRow(d.id)).posting_job_id).not.toBeNull();
    expect((await idemOf(key))[0]).toMatchObject({ status: "IN_PROGRESS" });
  }, 90_000);

  it("kiracı askıdayken son denemede iş 'failed' olur ve belge kilitli kalır; askıdayken bakım turu ertelenir, kiracı açılınca belge FAILED(INTERNAL) olur", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    const jobId = (await jobsOf(d.id))[0]?.id;
    await q("UPDATE pgboss.job SET retry_count = retry_limit WHERE id = $1", [jobId]);
    await q("UPDATE public.tenants SET status = 'SUSPENDED' WHERE id = $1", [A.tenantId]);
    try {
      await newWorker();
      await waitFor(async () => (await jobsOf(d.id))[0]?.state === "failed", "job failed while tenant suspended");
      await stopWorkers();
      expect((await docRow(d.id)).posting_job_id).not.toBeNull(); // yazım yapılamadı
      await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger: silent });
      expect((await docRow(d.id)).posting_job_id).not.toBeNull(); // askıdayken ertelenir
      const o = ((await q<{ output: { finalizeAttempts?: number } }>("SELECT output FROM pgboss.job WHERE id = $1", [jobId]))[0] as { output: { finalizeAttempts?: number } }).output;
      expect(o.finalizeAttempts).toBe(1); // geri çekilme işaretlendi
    } finally {
      await q("UPDATE public.tenants SET status = 'ACTIVE' WHERE id = $1", [A.tenantId]);
    }
    // Geri çekilme süresi dolmuş say (5 dk beklemeden): kiracı açıkken bir sonraki tur sonlandırır.
    await q("UPDATE pgboss.job SET output = jsonb_set(output, '{nextFinalizeAt}', to_jsonb(now() - interval '1 minute')) WHERE id = $1", [jobId]);
    await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger: silent });
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED", posting_job_id: null });
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "INTERNAL" });
    expect(await statusOf(d.id)).toEqual({ status: "FAILED", errorCode: "INTERNAL" });
    expect(await ledgerOf(d.id)).toHaveLength(0);
  }, 120_000);
});

describe("MAJOR-1: MFA (TENANT_ADMIN istek sahibi) — worker MFA'yı yalnızca sunucu damgasıyla, sınırlı pencerede ve sıfırlanmadıysa tanır", () => {
  async function adminRequest(mfa: boolean = true): Promise<{ d: Doc; admin: string; key: string; x: string }> {
    const admin = await mkUser(adm, reg, "admin222");
    await mkMembership(adm, A.tenantId, admin, { roles: ["TENANT_ADMIN"] });
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    const out = await requestPost(d, asUser(admin, key, { principal: { userId: admin, mfaVerified: mfa } }));
    expect(out.status).toBe("PROCESSING");
    return { d, admin, key, x };
  }
  const stamp = (id: string) =>
    q<{ posting_mfa_verified_at: Date | null; posting_idempotency_record_id: string | null }>(
      "SELECT posting_mfa_verified_at, posting_idempotency_record_id FROM public.documents WHERE id = $1", [id]).then((r) => r[0] as { posting_mfa_verified_at: Date | null; posting_idempotency_record_id: string | null });
  /**
   * 0024 damga bekçisi: kilit doluyken damga doğrudan değiştirilemez, dolu MFA damgası yalnızca işlemin now() değeri olabilir. Bayat/gelecek damga ya da uyumsuz
   * kayıt kimliği durumu kurmak için kilit + damgalar tek UPDATE'te temizlenir, sonra AYNI kilit/istek sahibi ve istenen değer tek UPDATE'te (NULL → dolu)
   * yazılır. `mfaSql` now()'dan farklı bir damga ise (bayat/gelecek) bekçi bunu zaten reddeder: yalnızca bu test bağlantısında (süper kullanıcı)
   * `session_replication_role = replica` ile tetikleyici o ifade için atlanır; diğer oturumlar/dosyalar etkilenmez. Amaç worker'ın (`mayVouchMfa`) bu durumu
   * reddettiğini sınamaktır (bekçi bypass edilmiş/eski veri varsayımı). `mfaSql`: damga SQL ifadesi (null = damga varsa taze now(), yoksa NULL; eski değer aynen geri yazılamaz: bekçi yalnızca now() kabul eder), `recordId`: kayıt kimliği (null = mevcut).
   */
  const restamp = async (id: string, mfaSql: string | null, recordId: string | null): Promise<void> => {
    const cur = (await q<{ job: string; by: string; rec: string; mfa: Date | null }>(
      "SELECT posting_job_id AS job, posting_requested_by AS by, posting_idempotency_record_id AS rec, posting_mfa_verified_at AS mfa FROM public.documents WHERE id = $1", [id]))[0] as {
      job: string; by: string; rec: string; mfa: Date | null;
    };
    await q("UPDATE public.documents SET posting_job_id = NULL, posting_requested_by = NULL, posting_mfa_verified_at = NULL, posting_idempotency_record_id = NULL WHERE id = $1", [id]);
    const upd = (): Promise<unknown> =>
      q(
        `UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3, posting_idempotency_record_id = $4, posting_mfa_verified_at = ${mfaSql ?? (cur.mfa === null ? "NULL" : "now()")} WHERE id = $1`,
        [id, cur.job, cur.by, recordId ?? cur.rec],
      );
    if (mfaSql === null) {
      await upd();
      return;
    }
    await q("SET session_replication_role = replica");
    try {
      await upd();
    } finally {
      await q("RESET session_replication_role");
    }
  };
  const failedWith = async (d: Doc, key: string, code: string): Promise<void> => {
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).posting_job_id === null, "failure recorded");
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: code });
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED" });
    expect(await ledgerOf(d.id)).toHaveLength(0);
    await waitFor(async () => (await jobsOf(d.id))[0]?.state === "failed", "job failed (kalıcı)");
  };

  it("MFA'lı TENANT_ADMIN isteği başarıyla işlenir; bağlam sütunları sunucu tarafında yazılır ve POSTED'da temizlenir", async () => {
    const { d, admin, key, x } = await adminRequest(true);
    const s = await stamp(d.id);
    expect(s.posting_mfa_verified_at).not.toBeNull();
    expect(s.posting_idempotency_record_id).toBe((await idemOf(key))[0]?.id);
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).status === "POSTED", "document POSTED");
    expect(await physical(x)).toBe("250.000000");
    expect(new Set((await ledgerOf(d.id)).map((l) => l.actor_user_id))).toEqual(new Set([admin]));
    expect(await stamp(d.id)).toEqual({ posting_mfa_verified_at: null, posting_idempotency_record_id: null });
  }, 120_000);

  it("MFA damgası yoksa (NULL) kalıcı FORBIDDEN/MFA_REQUIRED; MFA gerektirmeyen rol (PICKER) MFA'sız oturumla yine işlenir", async () => {
    const { d, key } = await adminRequest(true);
    await q("UPDATE public.documents SET posting_mfa_verified_at = NULL WHERE id = $1", [d.id]);
    await failedWith(d, key, "FORBIDDEN/MFA_REQUIRED");
    await stopWorkers();
    // PICKER, mfaVerified=false oturum: damga NULL, worker yine işler (MFA yalnızca TENANT_ADMIN için aranır).
    const x = await mkItem();
    const loc = await mkLoc();
    const p = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    await requestPost(p, asUser(A.memberUserId, uuid(), { principal: { userId: A.memberUserId, mfaVerified: false } }));
    expect((await stamp(p.id)).posting_mfa_verified_at).toBeNull();
    await newWorker();
    await waitFor(async () => (await docRow(p.id)).status === "POSTED", "picker document POSTED");
  }, 120_000);

  it("istekten sonra kullanıcının MFA'sı sıfırlanırsa (two_factor_disabled) kalıcı FORBIDDEN/MFA_REQUIRED", async () => {
    const { d, admin, key } = await adminRequest(true);
    // Kimlik olayları yalnızca wms_auth yazar (0005/0007): gerçek yazıcı rolüyle.
    const authUrl = process.env.AUTH_DATABASE_URL;
    expect(authUrl).toBeTruthy();
    const authC = new pg.Client({ connectionString: authUrl });
    authC.on("error", () => undefined);
    await authC.connect();
    try {
      await authC.query("INSERT INTO public.security_events (user_id, event_type) VALUES ($1, 'two_factor_disabled')", [admin]);
    } finally {
      await authC.end();
    }
    await failedWith(d, key, "FORBIDDEN/MFA_REQUIRED");
  }, 120_000);

  it("pencere dışı damga (süresi dolmuş) kalıcı FORBIDDEN/MFA_REQUIRED", async () => {
    const { d, key } = await adminRequest(true);
    await restamp(d.id, "now() - interval '4 hours'", null);
    await failedWith(d, key, "FORBIDDEN/MFA_REQUIRED");
  }, 120_000);

  it("GELECEKTEKİ damga (negatif yaş) tanınmaz: kalıcı FORBIDDEN/MFA_REQUIRED (T-275 MAJOR; mayVouchMfa)", async () => {
    const { d, key } = await adminRequest(true);
    await restamp(d.id, "now() + interval '1 hour'", null);
    await failedWith(d, key, "FORBIDDEN/MFA_REQUIRED");
  }, 120_000);

  it("kayıt kimliği belgedeki posting_idempotency_record_id ile uyuşmazsa iş reddedilir; belge serbest kalır ama yükteki kayıt FAILED yapılmaz (MINOR-5)", async () => {
    // PICKER: MFA aranmaz, böylece ret doğrudan kayıt kimliği denetiminden gelir.
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    await restamp(d.id, null, uuid());
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).posting_job_id === null, "document released");
    await waitFor(async () => (await jobsOf(d.id))[0]?.state === "failed", "job failed (kalıcı)");
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED" });
    expect(await ledgerOf(d.id)).toHaveLength(0);
    expect((await idemOf(key))[0]).toMatchObject({ status: "IN_PROGRESS" }); // başka isteğin kaydı olabilir: dokunulmaz
  }, 120_000);

  it("belgedeki kayıt kimliği NULL ise uyuşmazlık sayılır: iş reddedilir, belge serbest kalır, kayıt FAILED yapılmaz (MINOR-2)", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    await q("UPDATE public.documents SET posting_idempotency_record_id = NULL WHERE id = $1", [d.id]);
    await newWorker();
    await waitFor(async () => (await docRow(d.id)).posting_job_id === null, "document released");
    await waitFor(async () => (await jobsOf(d.id))[0]?.state === "failed", "job failed (kalıcı)");
    expect(await ledgerOf(d.id)).toHaveLength(0);
    expect((await idemOf(key))[0]).toMatchObject({ status: "IN_PROGRESS" });
  }, 120_000);

  it("iş satırı okunamıyorsa (pencere hesaplanamaz) MFA tanınmaz: TENANT_ADMIN kalıcı FORBIDDEN/MFA_REQUIRED (fail-closed, MINOR-3)", async () => {
    const { d, key } = await adminRequest(true);
    // MFA kararı için ikinci ctx.inTenant çağrısından önce iş satırının zarf kiracısı değiştirilir: wms_app RLS'i satırı görmez (LEFT JOIN boş).
    await newWorker(undefined, async (nth) => {
      if (nth === 2) await q("UPDATE pgboss.job SET data = jsonb_set(data, '{tenantId}', to_jsonb($2::text)) WHERE data->'payload'->>'documentId' = $1", [d.id, uuid()]);
    });
    await waitFor(async () => (await docRow(d.id)).posting_job_id === null, "failure recorded");
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "FORBIDDEN/MFA_REQUIRED" });
    expect(await ledgerOf(d.id)).toHaveLength(0);
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED" });
  }, 120_000);
});

describe("bakım taraması açlık önlemi (doğrulama incelemesi MAJOR-1)", () => {
  const insertFailedJobs = async (tenantId: string, n: number, completedAgo: string): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = uuid();
      ids.push(id);
      await q(
        `INSERT INTO pgboss.job (id, name, data, state, completed_on) VALUES ($1, 'stock.document.post', $2::jsonb, 'failed', now() - $3::interval)`,
        [id, JSON.stringify({ v: 1, tenantId, actorUserId: uuid(), payload: { documentId: uuid(), idempotencyRecordId: uuid() } }), completedAgo],
      );
    }
    return ids;
  };
  const outputOf = async (id: string) =>
    ((await q<{ output: { finalized?: boolean; skipped?: string; finalizeAttempts?: number; nextFinalizeAt?: string } | null }>("SELECT output FROM pgboss.job WHERE id = $1", [id]))[0] as {
      output: { finalized?: boolean; skipped?: string; finalizeAttempts?: number; nextFinalizeAt?: string } | null;
    }).output;

  it("60 ertelenen iş (askıdaki kiracı) + başka kiracıdan 1 sonlandırılabilir iş: ilk turda sonlandırılır; ertelenenler geri çekilmeyle taranmaz; yeni (denenmemiş) iş öne geçer", async () => {
    const B = await seedWorld(adm, reg, "B222");
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    const jobId = (await jobsOf(d.id))[0]?.id;
    await q("UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1", [jobId]); // en yeni
    const deferredIds = await insertFailedJobs(B.tenantId, 60, "1 day"); // daha eski → eski-önce sıralamada önde
    await q("UPDATE public.tenants SET status = 'SUSPENDED' WHERE id = $1", [B.tenantId]);
    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = { info: () => undefined, error: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, ...(fields === undefined ? {} : { fields }) }) };
    try {
      await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger });
      // İlk turda sonlandırıldı.
      expect(await docRow(d.id)).toMatchObject({ status: "APPROVED", posting_job_id: null });
      expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "INTERNAL" });
      // 60 ertelenen iş: bir kez denendi, geri çekilme gelecekte, log başına bir satır (jobId + tenantId).
      for (const id of deferredIds) {
        const o = await outputOf(id);
        expect(o?.finalizeAttempts).toBe(1);
        expect(new Date(o?.nextFinalizeAt as string).getTime()).toBeGreaterThan(Date.now());
      }
      const deferLogs = logs.filter((l) => l.msg === "stock.async_post.finalize_deferred");
      expect(deferLogs).toHaveLength(60);
      expect(new Set(deferLogs.map((l) => l.fields?.jobId)).size).toBe(60);
      expect(deferLogs.every((l) => l.fields?.tenantId === B.tenantId)).toBe(true);
      // İkinci tur: ertelenenler taranmaz (deneme sayısı artmaz, yeni log yok).
      logs.length = 0;
      await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger });
      expect(logs).toHaveLength(0);
      expect((await outputOf(deferredIds[0] as string))?.finalizeAttempts).toBe(1);
    } finally {
      await q("UPDATE public.tenants SET status = 'ACTIVE' WHERE id = $1", [B.tenantId]);
      await q("DELETE FROM pgboss.job WHERE name = 'stock.document.post' AND data->>'tenantId' = $1", [B.tenantId]);
    }
  }, 180_000);

  it("CLOSING kiracı geri alınabilir (spec 12): ertelenir; kiracı yeniden açılınca (geri çekilme dolunca) belge FAILED(INTERNAL) olarak sonlandırılır", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(250, () => ln(x, { targetLocationId: loc })));
    const key = uuid();
    await requestPost(d, pickerP(key));
    const jobId = (await jobsOf(d.id))[0]?.id;
    await q("UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1", [jobId]);
    const logs: string[] = [];
    const logger = { info: () => undefined, error: (msg: string) => logs.push(msg) };
    await q("UPDATE public.tenants SET status = 'CLOSING' WHERE id = $1", [A.tenantId]);
    try {
      await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger });
      expect(logs).toEqual(["stock.async_post.finalize_deferred"]); // kalıcı atlama YOK
      expect((await docRow(d.id)).posting_job_id).not.toBeNull();
      expect((await outputOf(jobId as string))?.finalized).toBeUndefined();
    } finally {
      await q("UPDATE public.tenants SET status = 'ACTIVE' WHERE id = $1", [A.tenantId]); // kapanış geri alındı
    }
    await q("UPDATE pgboss.job SET output = jsonb_set(output, '{nextFinalizeAt}', to_jsonb(now() - interval '1 minute')) WHERE id = $1", [jobId]);
    await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger });
    expect(await docRow(d.id)).toMatchObject({ status: "APPROVED", posting_job_id: null });
    expect((await idemOf(key))[0]).toMatchObject({ status: "FAILED", error_code: "INTERNAL" });
    expect((await outputOf(jobId as string))?.finalized).toBe(true);
  }, 90_000);

  it("kiracı satırı yoksa (silinmiş) başarısız işler kalıcı atlanır: bir kez log, yeniden denenmez", async () => {
    const ghost = uuid(); // var olmayan kiracı
    const ids = await insertFailedJobs(ghost, 3, "1 hour");
    const logs: string[] = [];
    const logger = { info: () => undefined, error: (msg: string) => logs.push(msg) };
    try {
      await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger });
      for (const id of ids) expect(await outputOf(id)).toMatchObject({ finalized: true, skipped: "FORBIDDEN" });
      expect(logs.filter((m) => m === "stock.async_post.finalize_skipped")).toHaveLength(3);
      logs.length = 0;
      await sweepExpiredPostingJobsOnWorker({ workerDb, db: app, logger });
      expect(logs).toHaveLength(0);
    } finally {
      await q("DELETE FROM pgboss.job WHERE name = 'stock.document.post' AND data->>'tenantId' = $1", [ghost]);
    }
  }, 60_000);
});

describe("MAJOR-3: getPostingStatus depo kapsamı (IDOR)", () => {
  it("kapsam dışı belge NOT_FOUND döner (varlık sızdırılmaz); kapsamdaki ve kısıtsız kullanıcı durumu görür", async () => {
    const wh2 = uuid();
    await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,'D2','T222 Depo 2')", [A.tenantId, wh2]);
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", many(3, () => ln(x, { targetLocationId: loc })));
    const asPicker = () => getPostingStatus({ db: app, principal: { userId: A.memberUserId, mfaVerified: true }, tenantSlug: A.slug }, d.id);
    try {
      await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, A.memberMembershipId, wh2]);
      process.env.WAREHOUSE_SCOPE_ENABLED = "true";
      expect((await failure(asPicker())).code).toBe("NOT_FOUND");
      expect(await statusOf(d.id)).toEqual({ status: "APPROVED" }); // TENANT_ADMIN kısıtsız
      await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, A.memberMembershipId, A.warehouseId]);
      expect(await asPicker()).toEqual({ status: "APPROVED" }); // kapsama alınınca görünür
    } finally {
      delete process.env.WAREHOUSE_SCOPE_ENABLED;
      await q("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id=$1 AND membership_id=$2", [A.tenantId, A.memberMembershipId]);
    }
  }, 60_000);
});

describe("ölçüm (T-222 madde 7, MINOR-12; eşik değil, A-07/A-75 girdisi)", () => {
  it("2.000 satırlık belgenin worker transaction süresi ve aynı boyutlara eşzamanlı 20 senkron komutun VERSION_CONFLICT oranı", async () => {
    const x = await mkItem();
    const locs = await Promise.all(Array.from({ length: 10 }, () => mkLoc()));
    const big = await mkApproved("STOCK_IN", many(2000, (i) => ln(x, { targetLocationId: locs[i % 10] as string })));
    const small = await Promise.all(Array.from({ length: 20 }, (_, i) => mkApproved("STOCK_IN", [ln(x, { targetLocationId: locs[i % 10] as string })])));
    await requestPost(big);
    await newWorker();
    await waitFor(async () => (await jobsOf(big.id))[0]?.state === "active", "job active", 30_000);
    const sync = { sleep: async () => undefined } as const;
    const spans: { start: number; end: number }[] = [];
    const results = await Promise.allSettled(
      small.map(async (s) => {
        const start = Date.now();
        try {
          return await postDocument({ ...ownerP(), retry: sync, timeouts: { lockTimeoutMs: 2000, statementTimeoutMs: 10_000 } }, { documentId: s.id, expectedVersion: s.version });
        } finally {
          spans.push({ start, end: Date.now() });
        }
      }),
    );
    const conflicts = results.filter((r) => r.status === "rejected" && (r.reason as AppError).code === "VERSION_CONFLICT").length;
    const otherErrors = results.filter((r) => r.status === "rejected" && (r.reason as AppError).code !== "VERSION_CONFLICT").length;
    await waitFor(async () => (await docRow(big.id)).status === "POSTED", "big document POSTED");
    const job = (await jobsOf(big.id))[0];
    const workerMs = job?.started_on != null && job.completed_on != null ? job.completed_on.getTime() - job.started_on.getTime() : null;
    expect(otherErrors).toBe(0);
    expect(await ledgerOf(big.id)).toHaveLength(2000);
    // Çakışma penceresi: senkron komutun [başlangıç, bitiş] aralığı iş penceresiyle kesişiyor mu (örtüşme garanti değildir; rapora yazılır).
    const overlapping =
      job?.started_on != null && job.completed_on != null
        ? spans.filter((sp) => sp.start <= (job.completed_on as Date).getTime() && sp.end >= (job.started_on as Date).getTime()).length
        : null;
    const report = { lines: 2000, workerJobMs: workerMs, syncCommands: 20, syncOverlappingWorkerWindow: overlapping, versionConflicts: conflicts, versionConflictRate: conflicts / 20 };
    mkdirSync(path.join(ROOT, ".artifacts"), { recursive: true });
    writeFileSync(path.join(ROOT, ".artifacts", "t222-measurement.json"), JSON.stringify(report, null, 2));
    console.info(`[T-222 ölçüm] ${JSON.stringify(report)}`);
  }, 240_000);
});
