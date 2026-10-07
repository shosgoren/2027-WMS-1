// T-225: tutarlılık işi (ADR-019 §1, §8-§10; AC-21). GERÇEK roller (wms_app, wms_worker), PgBouncer, gerçek pg-boss.
// Kapsam: zamanlayıcı (tenant başına singletonKey, SUSPENDED atlanır, sayaç), tenant işi (OK / MISMATCH a+b+c, defter değişmez, B'nin farkı A'da yok),
// hata → koşu satırı yok + FAILED sinyali + yeniden denemede tek satır, runs+signals aynı transaction (MINOR-4), eşzamanlı stok komutları altında yanlış MISMATCH yok,
// salt-okur oturum (PG `transaction_read_only`), keyset parça sınırı. Fikstürler sentetiktir (G-09); fikstür/gözlem DATABASE_URL_DIRECT ile.
// Bilinçli fark YALNIZCA bu test veritabanında, tablo sahibi migration rolüyle tetikleyiciler geçici kapatılarak üretilir (üretim kodunda yok).
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import type { Logger } from "../../../packages/shared/src/log.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, setLocalReadOnly, withSystemTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { consumeOnce, createJobQueue, installQueueSchema, type PgBossJobQueue } from "../../../packages/queue-adapter/src/index.ts";
import { approveDocument, createStockDocument, postDocument, reserve, type DocumentLineInput, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { checkDimensionChunk, NIL_UUID } from "../../../packages/domain/src/stock/consistency.ts";
import { runConsistencyCheck, type ConsistencyCheckContext, type ConsumeOnceFn } from "../../../packages/domain/src/stock/jobs.ts";
import { consistencySingletonKey, createStockConsistencyHandler, runConsistencySchedule } from "../../../apps/worker/src/jobs/stock-consistency.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/db/package.json"));
const { sql } = (await import(pathToFileURL(dbRequire.resolve("drizzle-orm")).href)) as typeof import("../../../packages/db/node_modules/drizzle-orm/index.js");

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const reg = newRegistry();
const JOB = "stock.consistency.check";
const REASON = "queue.stock.consistency.check";
const NO_WAIT = { sleep: async () => undefined } as const;
const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const consume = consumeOnce as unknown as ConsumeOnceFn;

let app: DbClient;
let adm: pg.Client;
let queue: PgBossJobQueue;
const queues: PgBossJobQueue[] = [];
let A: TenantWorld;
let B: TenantWorld;
let C: TenantWorld;
let S: TenantWorld;

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
const P = (w: TenantWorld, key: string | null = uuid()): StockDocCallParams => ({
  db: app,
  principal: { userId: w.ownerUserId, mfaVerified: true },
  tenantSlug: w.slug,
  clientKey: key,
  retry: NO_WAIT,
  timeouts: WIDE,
});
const silent = { info: () => undefined, error: () => undefined };
/** Kaydedici günlükçü: sayaç/alarm günlüğünü doğrular. */
function recLogger() {
  const lines: { level: "info" | "error"; msg: string; fields: Record<string, unknown> | undefined }[] = [];
  return {
    lines,
    info: (msg: string, fields?: Record<string, unknown>) => void lines.push({ level: "info", msg, fields }),
    error: (msg: string, fields?: Record<string, unknown>) => void lines.push({ level: "error", msg, fields }),
  };
}

// --- fikstürler -------------------------------------------------------------------------------------------------------
async function mkItem(w: TenantWorld): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T225 urun',$4,'NONE',0)", [w.tenantId, id, `I-${hex(10)}`, w.unitId]);
  return id;
}
async function mkLoc(w: TenantWorld): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T225 lok',0,'STORAGE',false)", [
    w.tenantId, id, w.warehouseId, `L-${hex(10)}`,
  ]);
  return id;
}
const ln = (w: TenantWorld, itemId: string, over: Partial<DocumentLineInput>): DocumentLineInput => ({ itemId, unitId: w.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", ...over });
const qty = (n: string): Partial<DocumentLineInput> => ({ quantity: n, baseQuantity: n });
async function mkApproved(w: TenantWorld, kind: "STOCK_IN" | "STOCK_OUT", lines: DocumentLineInput[]): Promise<{ id: string; lines: string[] }> {
  const c = await createStockDocument(P(w), { kind, warehouseId: w.warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(P(w), { documentId: id, expectedVersion: 1 });
  const lineIds = (await q<{ id: string }>("SELECT id FROM public.document_lines WHERE document_id = $1 ORDER BY line_no", [id])).map((r) => r.id);
  return { id, lines: lineIds };
}
async function postDoc(w: TenantWorld, docId: string): Promise<void> {
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id = $1", [docId]))[0]?.version as number;
  await postDocument(P(w), { documentId: docId, expectedVersion: v });
}
/** Tenant'a gerçek stok komutlarıyla: n adet giriş + `rsv` adet rezervasyon. Dönen: boyut/lokasyon. */
async function stockUp(w: TenantWorld, n: string, rsv: string): Promise<{ item: string; loc: string }> {
  const item = await mkItem(w);
  const loc = await mkLoc(w);
  await postDoc(w, (await mkApproved(w, "STOCK_IN", [ln(w, item, { targetLocationId: loc, ...qty(n) })])).id);
  const out = await mkApproved(w, "STOCK_OUT", [ln(w, item, { sourceLocationId: loc, ...qty(rsv) })]);
  await reserve(P(w), { documentLineId: out.lines[0] as string, allocations: [{ dimension: { locationId: loc }, quantity: rsv }] });
  return { item, loc };
}
/** Tenant stok durumunun ayrıntılı parmak izi (sayı + toplamlar + içerik özeti): "defter değişmedi" karşılaştırması. */
async function snapshot(w: TenantWorld): Promise<Record<string, string>> {
  const one = async (text: string): Promise<string> => JSON.stringify((await q(text, [w.tenantId]))[0]);
  return {
    ledger: await one("SELECT count(*)::int AS n, COALESCE(sum(quantity),0)::text AS s, md5(string_agg(id::text || quantity::text, ',' ORDER BY id)) AS h FROM public.stock_ledger WHERE tenant_id = $1"),
    balances: await one("SELECT count(*)::int AS n, COALESCE(sum(quantity),0)::text AS s, COALESCE(sum(reserved_quantity),0)::text AS r, md5(string_agg(stock_dimension_id::text || quantity::text || reserved_quantity::text || version::text, ',' ORDER BY stock_dimension_id)) AS h FROM public.stock_balances WHERE tenant_id = $1"),
    reservations: await one("SELECT count(*)::int AS n, COALESCE(sum(quantity),0)::text AS s, md5(string_agg(id::text || status || quantity::text, ',' ORDER BY id)) AS h FROM public.reservations WHERE tenant_id = $1"),
    locks: await one("SELECT count(*)::int AS n FROM public.location_count_locks WHERE tenant_id = $1"),
  };
}
const runsOf = (w: TenantWorld) =>
  q<{ job_id: string; status: string; mismatch_count: number; checked_dimensions: string; findings: { check: string; id: string }[] }>(
    "SELECT job_id, status, mismatch_count, checked_dimensions::text AS checked_dimensions, findings FROM public.stock_consistency_runs WHERE tenant_id = $1 AND id <> $2 ORDER BY finished_at", [w.tenantId, w.consistencyRunId]);
async function signalCounts(): Promise<Record<string, number>> {
  const rows = await q<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM public.stock_consistency_signals GROUP BY status");
  return { OK: 0, MISMATCH: 0, FAILED: 0, ...Object.fromEntries(rows.map((r) => [r.status, r.n])) };
}
const delta = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => Object.fromEntries(Object.keys(a).map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]));

function ctxFor(w: TenantWorld, jobId: string = uuid(), wrap?: (n: number) => void): ConsistencyCheckContext {
  let n = 0;
  return {
    jobId,
    type: JOB,
    hasTenant: true,
    actorUserId: null,
    payload: {},
    inTenant: async (fn: (tx: never) => Promise<unknown>) => {
      wrap?.(++n);
      return withSystemTenant(app, w.tenantId, REASON, fn as never);
    },
    inPlatform: async () => {
      throw new Error("not a platform job");
    },
  } as unknown as ConsistencyCheckContext;
}
const check = (w: TenantWorld, jobId?: string, logger: Logger = silent) => runConsistencyCheck({ consumeOnce: consume, logger }, ctxFor(w, jobId));

/** Test-yalnız: sahip rolüyle ilgili tablolardaki kullanıcı tetikleyicilerini (ENABLE ALWAYS dahil) geçici kapatıp `body`'yi çalıştırır; öncekiyle AYNI kipte geri açar. */
async function withTriggersOff(tables: string[], body: () => Promise<void>): Promise<void> {
  await adm.query("BEGIN");
  try {
    const trg = (
      await adm.query<{ relname: string; tgname: string; tgenabled: string }>(
        `SELECT c.relname, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1) AND NOT t.tgisinternal`, [tables])
    ).rows;
    for (const t of trg) await adm.query(`ALTER TABLE public."${t.relname}" DISABLE TRIGGER "${t.tgname}"`);
    await body();
    const mode: Record<string, string> = { O: "ENABLE", A: "ENABLE ALWAYS", R: "ENABLE REPLICA" };
    for (const t of trg) if (mode[t.tgenabled] !== undefined) await adm.query(`ALTER TABLE public."${t.relname}" ${mode[t.tgenabled]} TRIGGER "${t.tgname}"`);
    await adm.query("COMMIT");
  } catch (e) {
    await adm.query("ROLLBACK");
    throw e;
  }
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  await installQueueSchema({ url: env.databaseUrlDirect });
  A = await seedWorld(adm, reg, "A225");
  B = await seedWorld(adm, reg, "B225");
  C = await seedWorld(adm, reg, "C225");
  S = await seedWorld(adm, reg, "S225", { status: "SUSPENDED" });
  queue = createJobQueue({
    connectionString: workerUrl,
    max: 3,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 20_000,
    runInTenant: (tenantId, reason, fn) => withSystemTenant(app, tenantId, `queue.${reason}`, fn),
  });
  queues.push(queue);
  await queue.start();
}, 120_000);

afterEach(async () => {
  await q(`DELETE FROM pgboss.job WHERE name = $1`, [JOB]);
});

afterAll(async () => {
  for (const x of queues) await x.stop();
  await q(`DELETE FROM pgboss.job WHERE name = $1`, [JOB]);
  await adm.end();
  await app.close();
}, 120_000);

describe("zamanlayıcı: tenant listesi (wms_worker + dar işlev) ve tenant başına iş", () => {
  const enqueueFor = (tenantId: string) =>
    withSystemTenant(app, tenantId, "stock.consistency.schedule", (tx) => queue.enqueue(tx, { type: JOB, payload: {}, singletonKey: consistencySingletonKey(tenantId) }));
  const jobsOf = (tenantId: string) =>
    q<{ id: string; state: string; singleton_key: string; tenant: string }>(
      "SELECT id, state::text AS state, singleton_key, data->>'tenantId' AS tenant FROM pgboss.job WHERE name = $1 AND data->>'tenantId' = $2", [JOB, tenantId]);

  it("3 ACTIVE + 1 SUSPENDED: ACTIVE sayısı kadar listelenir, 3 ayrı iş (tenant başına anahtar), SUSPENDED yok; ikinci koşu tekilleştirir", async () => {
    const log = recLogger();
    const activeCount = Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.tenants WHERE status = 'ACTIVE'"))[0]?.n);
    const r1 = await runConsistencySchedule({ listActiveTenantIds: (a, l) => queue.listActiveTenantIds(a, l), enqueueFor, logger: log });
    expect(r1).toMatchObject({ listed: activeCount, enqueued: activeCount, failed: 0, listFailed: false });
    expect(log.lines.filter((l) => l.level === "error")).toEqual([]);
    expect(log.lines.find((l) => l.msg === "stock.consistency.scheduled")?.fields).toMatchObject({ listed: activeCount, enqueued: activeCount });
    for (const w of [A, B, C]) {
      const jobs = await jobsOf(w.tenantId);
      expect(jobs).toHaveLength(1);
      // adaptör anahtarı `<tenantId>/` önekler; zamanlayıcı anahtarı tenant kimliğini içerir.
      expect(jobs[0]?.singleton_key).toBe(`${w.tenantId}/stock-consistency/${w.tenantId}`);
    }
    expect(await jobsOf(S.tenantId)).toHaveLength(0);
    // Aynı anahtarlı bekleyen iş varken ikinci koşu yeni iş yazmaz.
    const r2 = await runConsistencySchedule({ listActiveTenantIds: (a, l) => queue.listActiveTenantIds(a, l), enqueueFor, logger: silent });
    expect(r2).toMatchObject({ listed: activeCount, enqueued: 0, deduplicated: activeCount });
    expect(await jobsOf(A.tenantId)).toHaveLength(1);
  }, 120_000);

  it("listActiveTenantIds: sayfa sınırı (1..500) ve UUID doğrulanır; keyset sıralıdır", async () => {
    await expect(queue.listActiveTenantIds(NIL_UUID, 0)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(queue.listActiveTenantIds(NIL_UUID, 501)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(queue.listActiveTenantIds("not-a-uuid", 10)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const page1 = await queue.listActiveTenantIds(NIL_UUID, 2);
    expect(page1.length).toBeGreaterThanOrEqual(2);
    const page2 = await queue.listActiveTenantIds(page1[1] as string, 500);
    expect(page2.every((id) => id > (page1[1] as string))).toBe(true);
    expect([...page1, ...page2]).toEqual([...page1, ...page2].slice().sort());
  });

  it("uçtan uca: worker handler'ı 3 işi tüketir → 3 koşu satırı (OK) + 3 sinyal; SUSPENDED tenant'a satır yok", async () => {
    const mine = new Set([A.tenantId, B.tenantId, C.tenantId]);
    await stockUp(A, "10", "4");
    const before = await signalCounts();
    const w = createJobQueue({
      connectionString: workerUrl,
      max: 3,
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 20_000,
      runInTenant: (tenantId, reason, fn) => withSystemTenant(app, tenantId, `queue.${reason}`, fn),
    });
    queues.push(w);
    await w.start();
    await w.work(JOB, createStockConsistencyHandler({ consumeOnce: consume, logger: silent }));
    // Yalnız bu testin tenant'ları kuyruklanır (kalıntı tenant'lar sinyal sayısını bozmasın); listeleme gerçektir.
    const r = await runConsistencySchedule({
      listActiveTenantIds: (a, l) => w.listActiveTenantIds(a, l),
      enqueueFor: (id) =>
        mine.has(id)
          ? withSystemTenant(app, id, "stock.consistency.schedule", (tx) => w.enqueue(tx, { type: JOB, payload: {}, singletonKey: consistencySingletonKey(id) }))
          : Promise.resolve({ jobId: null }),
      logger: silent,
    });
    expect(r.enqueued).toBe(3);
    await waitFor(async () => (await runsOf(A)).length === 1 && (await runsOf(B)).length === 1 && (await runsOf(C)).length === 1, "3 koşu satırı");
    await w.stop();
    queues.splice(queues.indexOf(w), 1);
    for (const x of [A, B, C]) expect((await runsOf(x)).map((r2) => r2.status)).toEqual(["OK"]);
    expect(await runsOf(S)).toHaveLength(0);
    expect(delta(before, await signalCounts())).toEqual({ OK: 3, MISMATCH: 0, FAILED: 0 });
  }, 120_000);
});

describe("tenant işi: karşılaştırma", () => {
  it("temiz veri → OK; checked_dimensions > 0; salt-okur: defter/bakiye/rezervasyon/kilit parmak izi birebir", async () => {
    await stockUp(A, "10", "4");
    const snap = await snapshot(A);
    const sig = await signalCounts();
    const out = await check(A);
    expect(out).toMatchObject({ status: "OK", applied: true });
    const runs = (await runsOf(A)).filter((r) => r.job_id !== undefined);
    expect(runs.at(-1)).toMatchObject({ status: "OK", mismatch_count: 0, findings: [] });
    expect(Number(runs.at(-1)?.checked_dimensions)).toBeGreaterThan(0);
    expect(delta(sig, await signalCounts())).toEqual({ OK: 1, MISMATCH: 0, FAILED: 0 });
    expect(await snapshot(A)).toEqual(snap);
  }, 120_000);

  it("@AC-21 bilinçli fark (bakiye miktarı + rezerve + eksik kilit satırı) → MISMATCH a+b+c; defter değişmez; B'nin farkı A'nın koşusunda görünmez; sinyal tenant'sız", async () => {
    const X = await seedWorld(adm, reg, "X225");
    const Y = await seedWorld(adm, reg, "Y225");
    const x = await stockUp(X, "10", "4");
    const y = await stockUp(Y, "10", "4");
    const dimX = (await q<{ id: string }>("SELECT id FROM public.stock_dimensions WHERE tenant_id = $1 AND location_id = $2", [X.tenantId, x.loc]))[0]?.id as string;
    const dimY = (await q<{ id: string }>("SELECT id FROM public.stock_dimensions WHERE tenant_id = $1 AND location_id = $2", [Y.tenantId, y.loc]))[0]?.id as string;
    // Önce temiz → OK.
    expect((await check(X)).status).toBe("OK");
    expect((await check(Y)).status).toBe("OK");
    // Test-yalnız bozma: Y'de bakiye +1; X'te bakiye +1, rezerve +1 ve bir kilit satırı silinir. Defter/rezervasyon satırlarına dokunulmaz.
    // T-291: kasıtlı bozma test sonunda `finally` ile geri alınır (ortak int DB'de restore/tutarlılık denetimleri (T-284) sonraki dosyalarda
    // yanlış kırmızı vermesin). Silinen kilit satırı geri yüklenmek üzere saklanır. Assertion'lar değişmez.
    const lockRows = (await adm.query("SELECT * FROM public.location_count_locks WHERE tenant_id = $1 AND location_id = $2", [X.tenantId, x.loc])).rows as Record<string, unknown>[];
    await withTriggersOff(["stock_balances", "location_count_locks"], async () => {
      await adm.query("UPDATE public.stock_balances SET quantity = quantity + 1 WHERE tenant_id = $1 AND stock_dimension_id = $2", [Y.tenantId, dimY]);
      await adm.query("UPDATE public.stock_balances SET quantity = quantity + 1, reserved_quantity = reserved_quantity + 1 WHERE tenant_id = $1 AND stock_dimension_id = $2", [X.tenantId, dimX]);
      await adm.query("DELETE FROM public.location_count_locks WHERE tenant_id = $1 AND location_id = $2", [X.tenantId, x.loc]);
    });
    try {
    const snapX = await snapshot(X);
    const snapY = await snapshot(Y);
    const sig = await signalCounts();
    const log = recLogger();
    const outX = await check(X, undefined, log);
    expect(outX.status).toBe("MISMATCH");
    expect(outX.report.mismatchCount).toBe(3);
    const row = (await runsOf(X)).at(-1) as { status: string; mismatch_count: number; findings: { check: string; id: string }[] };
    expect(row.status).toBe("MISMATCH");
    expect(row.mismatch_count).toBe(3);
    expect([...row.findings].sort((p, r) => p.check.localeCompare(r.check))).toEqual([
      { check: "a", id: dimX },
      { check: "b", id: dimX },
      { check: "c", id: x.loc },
    ]);
    // Yalnız kimlik + tür: kişisel veri/miktar yok.
    expect(JSON.stringify(row.findings)).not.toMatch(/quantity|email|name/i);
    expect(log.lines.find((l) => l.msg === "stock.consistency.mismatch")).toMatchObject({ level: "error", fields: { tenantId: X.tenantId, count: 3 } });
    // Y'nin koşusu yalnız Y'nin farkını görür (a); X'in kimlikleri yok.
    const outY = await check(Y);
    expect(outY.report.findings).toEqual([{ check: "a", id: dimY }]);
    // Başka tenant'ın farkı temiz tenant'ın koşusunda görünmez.
    expect((await check(A)).status).toBe("OK");
    expect(delta(sig, await signalCounts())).toEqual({ OK: 1, MISMATCH: 2, FAILED: 0 });
    // Otomatik düzeltme yok: defter/bakiye/rezervasyon/kilit olduğu gibi (bozuk kalır, araştırılabilir).
    expect(await snapshot(X)).toEqual(snapX);
    expect(await snapshot(Y)).toEqual(snapY);
    // Sinyal tablosunda tenant sütunu yok (M-7).
    expect((await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_consistency_signals' AND column_name LIKE '%tenant%'"))).toHaveLength(0);
    } finally {
      await withTriggersOff(["stock_balances", "location_count_locks"], async () => {
        await adm.query("UPDATE public.stock_balances SET quantity = quantity - 1 WHERE tenant_id = $1 AND stock_dimension_id = $2", [Y.tenantId, dimY]);
        await adm.query("UPDATE public.stock_balances SET quantity = quantity - 1, reserved_quantity = reserved_quantity - 1 WHERE tenant_id = $1 AND stock_dimension_id = $2", [X.tenantId, dimX]);
        for (const r of lockRows) {
          const cols = Object.keys(r);
          await adm.query(`INSERT INTO public.location_count_locks (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, k) => `$${k + 1}`).join(", ")})`, cols.map((c) => r[c]));
        }
      });
    }
  }, 180_000);

  it("(d) seri başına birden çok pozitif boyut: kısmi tekil indeks geçici kaldırılınca tespit edilir; indeks aynı tanımla geri kurulur", async () => {
    const X = await seedWorld(adm, reg, "D225");
    const { loc, item } = await stockUp(X, "5", "1");
    const serial = uuid();
    await q("INSERT INTO public.serials (tenant_id, id, item_id, serial_no) VALUES ($1,$2,$3,$4)", [X.tenantId, serial, item, `SN-${hex(8)}`]);
    const IDX = "stock_balances_serial_positive_key";
    const def = (await q<{ d: string }>("SELECT pg_get_indexdef(c.oid) AS d FROM pg_class c WHERE c.relname = $1 AND c.relkind = 'i'", [IDX]))[0]?.d as string;
    expect(def).toContain("UNIQUE");
    const dimIns = (status: string) =>
      q<{ id: string }>("INSERT INTO public.stock_dimensions (tenant_id, item_id, location_id, serial_id, stock_status) VALUES ($1,$2,$3,$4,$5) RETURNING id", [X.tenantId, item, loc, serial, status]);
    // Savunma katmanı 1: ikinci pozitif seri satırı DB'de reddedilir (bu yüzden (d) yalnızca bozulmuş veride tetiklenir).
    let dims: string[] = [];
    try {
      await withTriggersOff(["stock_dimensions", "stock_balances"], async () => {
        dims = [(await dimIns("AVAILABLE"))[0]?.id as string, (await dimIns("QUARANTINE"))[0]?.id as string];
        await adm.query("INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, serial_key) VALUES ($1,$2,1,$3)", [X.tenantId, dims[0], serial]);
        await adm.query("SAVEPOINT s1");
        await expect(adm.query("INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, serial_key) VALUES ($1,$2,1,$3)", [X.tenantId, dims[1], serial])).rejects.toMatchObject({ code: "23505" });
        await adm.query("ROLLBACK TO SAVEPOINT s1");
        await adm.query(`DROP INDEX public.${IDX}`);
        await adm.query("INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, serial_key) VALUES ($1,$2,1,$3)", [X.tenantId, dims[1], serial]);
      });
      const out = await check(X);
      expect(out.status).toBe("MISMATCH");
      expect(out.report.findings).toContainEqual({ check: "d", id: serial });
    } finally {
      await withTriggersOff(["stock_dimensions", "stock_balances"], async () => {
        await adm.query("DELETE FROM public.stock_balances WHERE tenant_id = $1 AND serial_key = $2", [X.tenantId, serial]);
        const exists = (await adm.query("SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'i'", [IDX])).rowCount;
        if (exists === 0) await adm.query(def);
      });
    }
    expect((await q("SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'i'", [IDX]))).toHaveLength(1);
  }, 180_000);

  it("keyset parça sınırı: küçük parçalarla yürüyüş tüm boyutları bir kez görür ve farkı yakalar", async () => {
    const X = await seedWorld(adm, reg, "K225");
    const locs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const item = await mkItem(X);
      const loc = await mkLoc(X);
      locs.push(loc);
      await postDoc(X, (await mkApproved(X, "STOCK_IN", [ln(X, item, { targetLocationId: loc, ...qty("3") })])).id);
    }
    const dims = (await q<{ id: string }>("SELECT id FROM public.stock_dimensions WHERE tenant_id = $1 ORDER BY id", [X.tenantId])).map((r) => r.id);
    const bad = (await q<{ id: string }>("SELECT id FROM public.stock_dimensions WHERE tenant_id = $1 AND location_id = $2", [X.tenantId, locs[2]]))[0]?.id as string;
    await withTriggersOff(["stock_balances"], async () => {
      await adm.query("UPDATE public.stock_balances SET quantity = quantity + 2 WHERE tenant_id = $1 AND stock_dimension_id = $2", [X.tenantId, bad]);
    });
    try {
    const seen: string[] = [];
    const flagged: string[] = [];
    let after = NIL_UUID;
    let chunks = 0;
    for (;;) {
      const r = await withSystemTenant(app, X.tenantId, REASON, async (tx) => {
        await setLocalReadOnly(tx);
        return checkDimensionChunk(tx as never, X.tenantId, after, 2);
      });
      chunks += 1;
      if (r.checked === 0) break;
      flagged.push(...r.samples.map((s) => s.id));
      after = r.last as string;
      seen.push(after);
      if (r.checked < 2) break;
    }
    expect(chunks).toBe(Math.ceil(dims.length / 2) + (dims.length % 2 === 0 ? 1 : 0));
    expect(flagged).toEqual([bad]);
    expect(seen.at(-1)).toBe(dims.at(-1));
    } finally {
      // T-291: kasıtlı bozma geri alınır (ortak int DB).
      await withTriggersOff(["stock_balances"], async () => {
        await adm.query("UPDATE public.stock_balances SET quantity = quantity - 2 WHERE tenant_id = $1 AND stock_dimension_id = $2", [X.tenantId, bad]);
      });
    }
  }, 180_000);
});

describe("dayanıklılık", () => {
  it("handler ortasında hata → koşu satırı YOK, FAILED sinyali (tenant'sız); yeniden denemede (aynı iş kimliği) tek tamamlanmış satır", async () => {
    const jobId = uuid();
    const sig = await signalCounts();
    const log = recLogger();
    let thrown = false;
    const ctx = ctxFor(A, jobId, (n) => {
      if (n === 2 && !thrown) {
        thrown = true;
        throw new Error("simulated crash");
      }
    });
    await expect(runConsistencyCheck({ consumeOnce: consume, logger: log }, ctx)).rejects.toThrow("simulated crash");
    expect((await runsOf(A)).filter((r) => r.job_id === jobId)).toHaveLength(0);
    expect(delta(sig, await signalCounts())).toEqual({ OK: 0, MISMATCH: 0, FAILED: 1 });
    expect(log.lines.find((l) => l.msg === "stock.consistency.failed")).toMatchObject({ level: "error" });
    // pg-boss yeniden teslimi: aynı iş kimliği.
    const out = await runConsistencyCheck({ consumeOnce: consume, logger: silent }, ctx);
    expect(out.applied).toBe(true);
    expect((await runsOf(A)).filter((r) => r.job_id === jobId)).toHaveLength(1);
    expect(delta(sig, await signalCounts())).toEqual({ OK: 1, MISMATCH: 0, FAILED: 1 });
  }, 120_000);

  it("aynı işin yeniden teslimi etkisiz: tek koşu satırı, tek sinyal, tek processed_events", async () => {
    const jobId = uuid();
    const sig = await signalCounts();
    expect((await check(B, jobId)).applied).toBe(true);
    expect((await check(B, jobId)).applied).toBe(false);
    expect((await runsOf(B)).filter((r) => r.job_id === jobId)).toHaveLength(1);
    expect(delta(sig, await signalCounts())).toEqual({ OK: 1, MISMATCH: 0, FAILED: 0 });
    expect(await q("SELECT 1 FROM public.processed_events WHERE tenant_id = $1 AND consumer = 'stock.consistency.check' AND event_id = $2", [B.tenantId, jobId])).toHaveLength(1);
  }, 120_000);

  it("MINOR-4: runs INSERT'i 23505 verirse sinyal ve processed_events AYNI transaction'da geri alınır (OK/MISMATCH sinyali eklenmez)", async () => {
    const jobId = uuid();
    // Bu iş kimliği için koşu satırı var ama processed_events yok (tutarsız ön durum): son transaction runs INSERT'inde 23505 alır.
    await q("INSERT INTO public.stock_consistency_runs (tenant_id, job_id, started_at, finished_at, status, checked_dimensions, mismatch_count) VALUES ($1,$2,now(),now(),'OK',0,0)", [C.tenantId, jobId]);
    const sig = await signalCounts();
    await expect(check(C, jobId)).rejects.toBeTruthy();
    // Yalnız FAILED sinyali (ayrı transaction) eklenir; OK/MISMATCH sinyali ve processed_events yok.
    expect(delta(sig, await signalCounts())).toEqual({ OK: 0, MISMATCH: 0, FAILED: 1 });
    expect(await q("SELECT 1 FROM public.processed_events WHERE tenant_id = $1 AND consumer = 'stock.consistency.check' AND event_id = $2", [C.tenantId, jobId])).toHaveLength(0);
    expect((await runsOf(C)).filter((r) => r.job_id === jobId)).toHaveLength(1);
  }, 120_000);

  it("eşzamanlı stok komutları sürerken tekrarlı koşular → yanlış MISMATCH yok", async () => {
    const X = await seedWorld(adm, reg, "Z225");
    const item = await mkItem(X);
    const locs = [await mkLoc(X), await mkLoc(X), await mkLoc(X)];
    const lane = async (loc: string): Promise<void> => {
      for (let i = 0; i < 6; i++) {
        await postDoc(X, (await mkApproved(X, "STOCK_IN", [ln(X, item, { targetLocationId: loc, ...qty("5") })])).id);
        const out = await mkApproved(X, "STOCK_OUT", [ln(X, item, { sourceLocationId: loc, ...qty("2") })]);
        await reserve(P(X), { documentLineId: out.lines[0] as string, allocations: [{ dimension: { locationId: loc }, quantity: "2" }] });
        await postDoc(X, out.id);
      }
    };
    let done = false;
    const lanes = Promise.all(locs.map(lane)).finally(() => {
      done = true;
    });
    const statuses: string[] = [];
    while (!done || statuses.length < 3) {
      statuses.push((await check(X)).status);
      if (statuses.length > 60) break;
    }
    await lanes;
    statuses.push((await check(X)).status);
    expect(statuses.length).toBeGreaterThanOrEqual(4);
    expect(statuses.every((s) => s === "OK")).toBe(true);
  }, 300_000);
});

describe("salt-okur oturum (G-04: kurulu PG'de doğrulandı)", () => {
  it("tenant kilidi + sorgudan SONRA transaction_read_only açılır; yazma 25006 ile reddedilir", async () => {
    let ro: unknown;
    const attempt = withSystemTenant(app, A.tenantId, REASON, async (tx) => {
      await tx.execute(sql`SELECT 1`);
      await setLocalReadOnly(tx);
      ro = (await tx.execute<{ v: string }>(sql`SELECT current_setting('transaction_read_only') AS v`))[0]?.v;
      await tx.execute(sql`INSERT INTO public.stock_consistency_signals (status, mismatch_count) VALUES ('OK', 0)`);
    });
    const err = (await attempt.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: unknown; cause?: { code?: unknown } } | undefined;
    expect(ro).toBe("on");
    expect(err?.cause?.code ?? err?.code).toBe("25006");
  });
});
