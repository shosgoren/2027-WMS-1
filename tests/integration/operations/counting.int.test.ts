// T-309: kilitli sayım (06 §Sayım kilidi yaşam döngüsü; ADR-021 §3/§5/§6; 16 Senaryo A adım 11 ve Senaryo D adım 10; AC-13, AC-39).
// GERÇEK roller (wms_app, pooler); fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile. Beklenen değerler docs/spec/16-stock-effects.md'den birebir; her adımdan sonra tüm
// sütunlar doğrulanır (defter toplamı = fiziksel). Sevk/iade komutları T-308 dalındadır: senaryoların sayımdan ÖNCEKİ durumu stok komutlarıyla (STOCK_IN) kurulur;
// tam akışın gerçek komutlarla yeniden doğrulaması T-317'dedir. Fikstürler sentetiktir (G-09).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireStockLocks, createDbClient, withSystemTenant, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import * as ops from "../../../packages/domain/src/operations/index.ts";
import {
  approveCount,
  cancelCount,
  createSalesOrder,
  findAbandonedCounts,
  postCountAdjustment,
  putaway,
  recordCount,
  reserveOrder,
  startCount,
  submitCount,
} from "../../../packages/domain/src/operations/index.ts";
import * as stockApi from "../../../packages/domain/src/stock/index.ts";
import { approveDocument, createStockDocument, postDocument, reverseDocument, type DocumentLineInput, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { archiveLocation } from "../../../packages/domain/src/warehouse/index.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
/** Ayrı bağlantı: açık tutulan fikstür transaction'ı (süren stok işlemi / arşiv yarışı); `adm` sorguları aynı transaction'a girmesin. */
let hold: pg.Client;
let A: TenantWorld;
let MGR: { userId: string; membershipId: string };
let COUNTER: { userId: string; membershipId: string };

const NO_WAIT = { sleep: async () => undefined } as const;
/** Yeniden deneme YOK: 40P01/55P03 sessizce yeniden denenip test yeşile dönmesin. */
const ONCE = { sleep: async () => undefined, maxAttempts: 1 } as const;
/** Süren işlemi bekleyen komutlar için uzun kilit bekleme süresi (varsayılan 2 sn). */
const LONG = { lockTimeoutMs: 25_000, statementTimeoutMs: 40_000 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const callP = (userId: string, key: string | null, extra: Partial<StockDocCallParams> = {}): StockDocCallParams => ({
  db: app,
  principal: { userId, mfaVerified: true },
  tenantSlug: A.slug,
  clientKey: key,
  retry: NO_WAIT,
  ...extra,
});
const ownerP = (extra: Partial<StockDocCallParams> = {}): StockDocCallParams => callP(A.ownerUserId, uuid(), extra);
const mgrP = (extra: Partial<StockDocCallParams> = {}): StockDocCallParams => callP(MGR.userId, uuid(), extra);
const counterP = (extra: Partial<StockDocCallParams> = {}): StockDocCallParams => callP(COUNTER.userId, uuid(), extra);
const pickerP = (extra: Partial<StockDocCallParams> = {}): StockDocCallParams => callP(A.memberUserId, uuid(), extra);

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
const n = (v: string | number): string => Number(v).toFixed(6);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- fikstürler ---------------------------------------------------------------------------------------------------------
async function mkItem(scale = 0): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T309 urun',$4,'NONE',$5)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId, scale,
  ]);
  return id;
}
async function mkLoc(kind: "RECEIVING" | "STORAGE" | "STAGING" = "STORAGE", warehouseId = A.warehouseId): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,'T309 lok',0,$5)", [
    A.tenantId, id, warehouseId, `L-${hex(10)}`, kind,
  ]);
  return id;
}
const ln = (item: string, qty: string, extra: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  itemId: item, unitId: A.unitId, quantity: qty, conversionFactor: "1", baseQuantity: qty, ...extra,
});
async function mkDoc(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[]): Promise<{ id: string; version: number }> {
  const c = await createStockDocument(ownerP(), { kind, warehouseId: A.warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id = $1", [id]))[0] as { version: number };
  return { id, version: v.version };
}
async function postDoc(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[], extra: Partial<StockDocCallParams> = {}): Promise<void> {
  const d = await mkDoc(kind, lines);
  await postDocument(ownerP(extra), { documentId: d.id, expectedVersion: d.version });
}
const stockIn = (item: string, loc: string, qty: string, status: "AVAILABLE" | "QUARANTINE" | "DAMAGED" = "AVAILABLE") =>
  postDoc("STOCK_IN", [ln(item, qty, { targetLocationId: loc, stockStatus: status })]);

async function bal(item: string, loc: string, status: string): Promise<string> {
  const r = await q<{ quantity: string }>(
    `SELECT b.quantity::text AS quantity FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id = b.tenant_id AND s.id = b.stock_dimension_id
      WHERE s.tenant_id = $1 AND s.item_id = $2 AND s.location_id = $3 AND s.stock_status = $4`, [A.tenantId, item, loc, status]);
  return n(r[0]?.quantity ?? "0");
}
const sum = async (sqlText: string, item: string): Promise<string> => n((await q<{ s: string }>(sqlText, [A.tenantId, item]))[0]?.s as string);
const physical = (item: string) => sum("SELECT COALESCE(sum(b.quantity),0)::text AS s FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2", item);
const reservedOf = (item: string) => sum("SELECT COALESCE(sum(b.reserved_quantity),0)::text AS s FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2", item);
/** 16 kural 5: AVAILABLE ∧ STORAGE|STAGING ∧ pick_blocked=false − rezerve. */
const available = (item: string) =>
  sum(`SELECT COALESCE(sum(b.quantity - b.reserved_quantity),0)::text AS s FROM public.stock_balances b
         JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
         JOIN public.locations l ON l.tenant_id=s.tenant_id AND l.id=s.location_id
        WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.stock_status='AVAILABLE' AND l.kind IN ('STORAGE','STAGING') AND l.pick_blocked=false`, item);
const ledgerSum = (item: string) => sum("SELECT COALESCE(sum(quantity),0)::text AS s FROM public.stock_ledger WHERE tenant_id=$1 AND item_id=$2", item);
const ledgerCount = async (item: string): Promise<number> =>
  Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.stock_ledger WHERE tenant_id=$1 AND item_id=$2", [A.tenantId, item]))[0]?.c);
async function audits(action: string, entityId: string): Promise<{ reason: string | null }[]> {
  return q<{ reason: string | null }>("SELECT reason FROM public.audit_logs WHERE tenant_id=$1 AND action=$2 AND entity_id=$3", [A.tenantId, action, entityId]);
}

type Num = string | number;
/** Senaryo tablosu satırı: adlandırılmış sütunlar (lokasyon, durum) + fiziksel/rezerve/kullanılabilir. Tüm sütunlar tek çağrıda doğrulanır. */
async function expectRow(item: string, cols: Record<string, [string, string]>, e: Record<string, Num> & { fiz: Num; rez: Num; kullan: Num }, label: string): Promise<void> {
  const got: Record<string, string> = {};
  for (const [name, [loc, status]] of Object.entries(cols)) got[name] = await bal(item, loc, status);
  got.fiz = await physical(item);
  got.rez = await reservedOf(item);
  got.kullan = await available(item);
  const want: Record<string, string> = {};
  for (const k of Object.keys(got)) want[k] = n(e[k] ?? 0);
  expect(got, label).toEqual(want);
  expect(await ledgerSum(item), `${label} defter toplamı = fiziksel`).toBe(got.fiz);
}

interface LockR { status: string; count_session_id: string | null; locked_by: string | null; locked_at: Date | null }
const lockOf = async (loc: string): Promise<LockR> =>
  (await q<LockR>("SELECT status, count_session_id, locked_by, locked_at FROM public.location_count_locks WHERE location_id = $1", [loc]))[0] as LockR;
interface SessR { status: string; blind: boolean; approved_by: string | null; started_by: string; cancel_reason: string | null; warehouse_id: string }
const sessOf = async (id: string): Promise<SessR> =>
  (await q<SessR>("SELECT status, blind, approved_by, started_by, cancel_reason, warehouse_id FROM public.count_sessions WHERE id = $1", [id]))[0] as SessR;
const linesOf = (sid: string) =>
  q<{ location_id: string; item_id: string; stock_dimension_id: string | null; reference_quantity: string; counted_quantity: string | null }>(
    "SELECT location_id, item_id, stock_dimension_id, reference_quantity::text AS reference_quantity, counted_quantity::text AS counted_quantity FROM public.count_session_lines WHERE session_id = $1 ORDER BY location_id, item_id, id", [sid]);
const pickBlocked = async (loc: string): Promise<boolean> => (await q<{ p: boolean }>("SELECT pick_blocked AS p FROM public.locations WHERE id = $1", [loc]))[0]?.p as boolean;
const sessionCount = async (): Promise<number> => Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.count_sessions WHERE tenant_id=$1", [A.tenantId]))[0]?.c);
const adjLedger = (docId: string) =>
  q<{ item_id: string; location_id: string; stock_status: string; quantity: string; reason: string }>(
    `SELECT s.item_id, s.location_id, s.stock_status, l.quantity::text AS quantity, l.reason
       FROM public.stock_ledger l JOIN public.stock_dimensions s ON s.tenant_id = l.tenant_id AND s.id = l.stock_dimension_id
      WHERE l.tenant_id = $1 AND l.document_id = $2 ORDER BY s.location_id, s.item_id`, [A.tenantId, docId]);

async function blockedBy(pid: number): Promise<number> {
  const rows = await q<{ c: string }>(
    `WITH RECURSIVE w(pid) AS (
       SELECT a.pid FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))
       UNION
       SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY (pg_blocking_pids(a.pid)))
     SELECT count(*)::text AS c FROM w`,
    [pid],
  );
  return Number(rows[0]?.c);
}
async function untilBlocked(pid: number, count: number): Promise<void> {
  const t0 = Date.now();
  while ((await blockedBy(pid)) < count) {
    if (Date.now() - t0 > 30_000) throw new Error(`kapı: ${count} komut bloklanmadı`);
    await delay(10);
  }
}
const holdPid = async (): Promise<number> => Number((await hold.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]?.p);
async function holdBegin(): Promise<void> {
  await hold.query("BEGIN");
  await hold.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
}
type Settled = { state: "pending" } | { state: "resolved" } | { state: "rejected"; error: unknown };
/** Söz henüz sonuçlanmadı mı? (`ms` boyunca bekler.) */
async function peek(p: Promise<unknown>, ms = 400): Promise<Settled> {
  return Promise.race([
    p.then((): Settled => ({ state: "resolved" }), (error: unknown): Settled => ({ state: "rejected", error })),
    delay(ms).then((): Settled => ({ state: "pending" })),
  ]);
}

/** Tam sayım turu: başlat → say → gönder → onayla (yönetici) → fark fişini işle. */
async function startOn(locs: string[], extra: Partial<Parameters<typeof startCount>[1]> = {}): Promise<string> {
  return (await startCount(ownerP(), { warehouseId: A.warehouseId, locationIds: locs, ...extra })).sessionId;
}
const rec = (sid: string, lines: { loc: string; item: string; qty: string; status?: "AVAILABLE" | "QUARANTINE" | "DAMAGED" | "BLOCKED" }[]) =>
  recordCount(counterP(), { sessionId: sid, lines: lines.map((l) => ({ locationId: l.loc, itemId: l.item, countedQuantity: l.qty, ...(l.status === undefined ? {} : { stockStatus: l.status }) })) });
async function approveFlow(sid: string): Promise<Awaited<ReturnType<typeof approveCount>>> {
  await submitCount(counterP(), { sessionId: sid });
  return approveCount(mgrP(), { sessionId: sid });
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  hold = new pg.Client({ connectionString: env.databaseUrlDirect });
  hold.on("error", () => undefined);
  await hold.connect();
  A = await seedWorld(adm, reg, "A309");
  const m = await mkUser(adm, reg, "A309 manager");
  MGR = { userId: m, membershipId: await mkMembership(adm, A.tenantId, m, { roles: ["WAREHOUSE_MANAGER"] }) };
  const c = await mkUser(adm, reg, "A309 counter");
  COUNTER = { userId: c, membershipId: await mkMembership(adm, A.tenantId, c, { roles: ["COUNTER"] }) };
}, 120_000);

afterAll(async () => {
  await hold.query("ROLLBACK").catch(() => undefined);
  await hold.end();
  await adm.end();
  await app.close();
}, 60_000);

describe("dışa açık yüzey", () => {
  it("sayım komutları açık; kilit durum yazımı (setLocationsCounting/releaseCountLocks) hiçbir genel yüzeyde YOK", () => {
    expect(Object.keys(ops)).toEqual(expect.arrayContaining(["startCount", "recordCount", "submitCount", "approveCount", "postCountAdjustment", "cancelCount", "findAbandonedCounts"]));
    for (const hidden of ["setLocationsCounting", "releaseCountLocks", "completeTask", "createTasks"]) {
      expect(Object.keys(ops)).not.toContain(hidden);
      expect(Object.keys(stockApi)).not.toContain(hidden);
    }
  });
});

describe("@AC-31 Senaryo A adım 11 (X; KABUL, R-01, SEVK): sayım R-01 sistem 7, sayılan 6, fark onayı", () => {
  it("−1 R-01·KUL (neden SAYIM = COUNT_DIFF): KAR 1 · KUL 0 · R-01 6 · SEVK 0 · fiziksel 7 · rezerve 0 · kullanılabilir 6; fark fişi ters çevrilemez", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const SEVK = await mkLoc("STAGING");
    const cols: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], kul: [KABUL, "AVAILABLE"], r01: [R01, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    // Adım 10 sonrası durum (sevk/iade komutları T-308'de): KAR 1, R-01 7.
    await stockIn(X, KABUL, "1", "QUARANTINE");
    await stockIn(X, R01, "7");
    await expectRow(X, cols, { kar: 1, r01: 7, fiz: 8, rez: 0, kullan: 7 }, "adım 10");

    const sid = await startOn([R01]);
    expect(await linesOf(sid)).toEqual([expect.objectContaining({ location_id: R01, item_id: X, reference_quantity: n(7), counted_quantity: null })]);
    await rec(sid, [{ loc: R01, item: X, qty: "6" }]);
    const ap = await approveFlow(sid);
    expect(ap).toEqual({ status: "APPROVED", differences: [{ locationId: R01, itemId: X, stockStatus: "AVAILABLE", referenceQuantity: n(7), countedQuantity: n(6), difference: "-1.000000" }] });
    const posted = await postCountAdjustment(mgrP(), { sessionId: sid });
    expect(posted).toMatchObject({ status: "POSTED", replayed: false });
    expect(posted.documentNumber).toMatch(/^SAY-\d{4}-\d{6}$/);

    await expectRow(X, cols, { kar: 1, r01: 6, fiz: 7, rez: 0, kullan: 6 }, "adım 11");
    expect(await adjLedger(posted.documentId as string)).toEqual([{ item_id: X, location_id: R01, stock_status: "AVAILABLE", quantity: "-1.000000", reason: "COUNT_DIFF" }]);
    const doc = (await q<{ kind: string; status: string; source_kind: string; source_id: string }>("SELECT kind, status, source_kind, source_id FROM public.documents WHERE id = $1", [posted.documentId]))[0];
    expect(doc).toEqual({ kind: "COUNT_ADJUSTMENT", status: "POSTED", source_kind: "COUNT_SESSION", source_id: sid });
    expect((await lockOf(R01)).status).toBe("IDLE");
    expect((await sessOf(sid)).status).toBe("POSTED");

    // T-224: sayım fark fişi ters kayıtla geri alınamaz; hiçbir şey yazılmaz. BEKLENEN `REVERSAL_BLOCKED/SOURCE_LINKED` (source_kind dolu) idi; fiili kod
    // `VALIDATION_FAILED/DOCUMENT_STATE`: reversal.ts tür denetimi (yalnız STOCK_IN/OUT/MOVE) `source_kind` denetiminden ÖNCE gelir (kart Supervisor kararı notu, Q-123).
    const ledgerBefore = await ledgerCount(X);
    const rev = await failure(reverseDocument(ownerP(), { documentId: posted.documentId as string, lines: "ALL", reason: "T309 ters kayit denemesi" }));
    expect(codeOf(rev)).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await ledgerCount(X)).toBe(ledgerBefore);
    expect(await bal(X, R01, "AVAILABLE")).toBe(n(6));
  });
});

describe("@AC-40 Senaryo D adım 10 (X, Y; KABUL, R-01, R-02, SEVK): kilitli sayım R-01 ve R-02, fark onayı", () => {
  it("X R-01 sistem 7 sayılan 7 → satır YOK; Y R-02 sistem 3 sayılan 0 → −3 R-02; kilitler, pick_blocked kalkar, COUNT görevi DONE", async () => {
    const X = await mkItem();
    const Y = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const R02 = await mkLoc("STORAGE");
    const SEVK = await mkLoc("STAGING");
    // Adım 9 sonrası durum (sevk/iade T-308'de): X KAR 1 + R-01 7; Y DMG 1 + R-02 3 + SEVK 1.
    await stockIn(X, KABUL, "1", "QUARANTINE");
    await stockIn(X, R01, "7");
    await stockIn(Y, KABUL, "1", "DAMAGED");
    await stockIn(Y, R02, "3");
    await stockIn(Y, SEVK, "1");
    // Adım 7: R-02 `pick_blocked` + açık sayım görevi (T-307 "ürün bulunamadı").
    await q("UPDATE public.locations SET pick_blocked = true WHERE id = $1", [R02]);
    const taskId = uuid();
    await q("INSERT INTO public.warehouse_tasks (tenant_id, id, warehouse_id, kind, location_id) VALUES ($1,$2,$3,'COUNT',$4)", [A.tenantId, taskId, A.warehouseId, R02]);
    const xCols: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], r01: [R01, "AVAILABLE"] };
    const yCols: Record<string, [string, string]> = { dmg: [KABUL, "DAMAGED"], r02: [R02, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    await expectRow(X, xCols, { kar: 1, r01: 7, fiz: 8, rez: 0, kullan: 7 }, "X adım 9");
    await expectRow(Y, yCols, { dmg: 1, r02: 3, sevk: 1, fiz: 5, rez: 0, kullan: 1 }, "Y adım 9 (R-02 pick_blocked → kullanılabilir yalnız SEVK)");
    const xLedgerBefore = await ledgerCount(X);

    const sid = await startOn([R01, R02]);
    await rec(sid, [{ loc: R01, item: X, qty: "7" }, { loc: R02, item: Y, qty: "0" }]);
    const ap = await approveFlow(sid);
    expect(ap.differences).toEqual([{ locationId: R02, itemId: Y, stockStatus: "AVAILABLE", referenceQuantity: n(3), countedQuantity: n(0), difference: "-3.000000" }]);
    const posted = await postCountAdjustment(mgrP(), { sessionId: sid });

    expect(await adjLedger(posted.documentId as string)).toEqual([{ item_id: Y, location_id: R02, stock_status: "AVAILABLE", quantity: "-3.000000", reason: "COUNT_DIFF" }]);
    expect(await ledgerCount(X), "X için defter satırı yok").toBe(xLedgerBefore);
    await expectRow(X, xCols, { kar: 1, r01: 7, fiz: 8, rez: 0, kullan: 7 }, "X adım 10");
    await expectRow(Y, yCols, { dmg: 1, r02: 0, sevk: 1, fiz: 2, rez: 0, kullan: 1 }, "Y adım 10");
    for (const loc of [R01, R02]) expect(await lockOf(loc), "kilit IDLE").toEqual({ status: "IDLE", count_session_id: null, locked_by: null, locked_at: null });
    expect(await pickBlocked(R02), "pick_blocked kalktı").toBe(false);
    const t = (await q<{ status: string; completed_at: Date | null }>("SELECT status, completed_at FROM public.warehouse_tasks WHERE id = $1", [taskId]))[0];
    expect(t?.status).toBe("DONE");
    expect(t?.completed_at).not.toBeNull();
    expect((await sessOf(sid)).status).toBe("POSTED");
    expect((await audits("count.posted", sid)).length).toBe(1);
  });
});

describe("@AC-39 sayım kilidi yaşam döngüsü", () => {
  it("yeni lokasyon oluşturulur → kilit satırı aynı transaction'da vardır (IDLE)", async () => {
    const loc = await mkLoc();
    expect(await lockOf(loc)).toEqual({ status: "IDLE", count_session_id: null, locked_by: null, locked_at: null });
  });

  it("süren STOCK_IN varken sayım başlatılır: başlatma işlemin BİTMESİNİ bekler (kısmi kilit yok); referans süren yazıcının etkisini içerir", async () => {
    const X = await mkItem();
    const L = await mkLoc();
    await stockIn(X, L, "2"); // GRS numara satırı oluşur
    const d = await mkDoc("STOCK_IN", [ln(X, "5", { targetLocationId: L })]);
    // `number_sequences` satırını tutan fikstür: STOCK_IN defter+bakiyeyi yazar, lokasyon FOR SHARE'ini TUTARKEN numara adımında (komutun SON kilidi) bekler.
    await holdBegin();
    await hold.query("SELECT 1 FROM public.number_sequences WHERE tenant_id = $1 AND document_kind = 'STOCK_IN' FOR UPDATE", [A.tenantId]);
    const pid = await holdPid();
    const inflight = postDocument(ownerP({ timeouts: LONG }), { documentId: d.id, expectedVersion: d.version });
    inflight.catch(() => undefined);
    await untilBlocked(pid, 1);
    const starting = startCount(ownerP({ timeouts: LONG }), { warehouseId: A.warehouseId, locationIds: [L] });
    starting.catch(() => undefined);
    await untilBlocked(pid, 2); // başlatma, süren işlemin FOR SHARE'ini bekliyor
    expect((await peek(starting)).state, "başlatma süren işlem bitmeden tamamlanmaz").toBe("pending");
    expect((await lockOf(L)).status, "kilit henüz alınmadı").toBe("IDLE");
    await hold.query("COMMIT");

    await inflight;
    const started = await starting;
    // Referans bakiye bekleme SONRASI okunur: süren yazıcının +5'i içindedir.
    expect(await linesOf(started.sessionId)).toEqual([expect.objectContaining({ location_id: L, item_id: X, reference_quantity: n(7) })]);
    expect(await bal(X, L, "AVAILABLE")).toBe(n(7));
    const lk = await lockOf(L);
    expect(lk).toMatchObject({ status: "COUNTING", count_session_id: started.sessionId });
    expect(lk.locked_by).toBe(A.ownerMembershipId);
    expect(lk.locked_at).not.toBeNull();
    expect(await sessOf(started.sessionId)).toMatchObject({ status: "COUNTING", blind: true, started_by: A.ownerMembershipId, approved_by: null });
    expect((await audits("count.started", started.sessionId)).length).toBe(1);
    await cancelCount(ownerP(), { sessionId: started.sessionId, reason: "T309 test temizligi" });
  });

  it("(a)–(d) reddedilir ve hiçbir şey yazmaz; (e) doğru oturumun onaylı fark fişi işler ve kilitleri AYNI transaction'da IDLE yapar", async () => {
    const X = await mkItem();
    const L1 = await mkLoc();
    const L2 = await mkLoc();
    const L3 = await mkLoc(); // B/C oturumlarının lokasyonu
    const L4 = await mkLoc(); // hiçbir oturuma kilitli olmayan (IDLE) lokasyon
    await stockIn(X, L1, "6");
    await stockIn(X, L2, "4");
    await stockIn(X, L3, "9");
    await stockIn(X, L4, "1");
    const sidA = await startOn([L1, L2]);
    const snap = async () => ({ l1: await bal(X, L1, "AVAILABLE"), l2: await bal(X, L2, "AVAILABLE"), l3: await bal(X, L3, "AVAILABLE"), n: await ledgerCount(X) });
    const before = await snap();

    // (a) normal hareket: kaynak ve hedef olarak LOCATION_LOCKED.
    const aIn = await mkDoc("STOCK_IN", [ln(X, "1", { targetLocationId: L1 })]);
    expect(codeOf(await failure(postDocument(ownerP(), { documentId: aIn.id, expectedVersion: aIn.version })))).toBe("LOCATION_LOCKED");
    const aOut = await mkDoc("STOCK_OUT", [ln(X, "1", { sourceLocationId: L2 })]);
    expect(codeOf(await failure(postDocument(ownerP(), { documentId: aOut.id, expectedVersion: aOut.version })))).toBe("LOCATION_LOCKED");

    // (c) onaysız oturumun fark fişi (COUNTING ve SUBMITTED): DOCUMENT_STATE.
    expect(codeOf(await failure(postCountAdjustment(mgrP(), { sessionId: sidA })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    await rec(sidA, [{ loc: L1, item: X, qty: "5" }, { loc: L2, item: X, qty: "4" }]);
    await submitCount(counterP(), { sessionId: sidA });
    expect(codeOf(await failure(postCountAdjustment(mgrP(), { sessionId: sidA })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");

    // (b) başka oturumun fark fişi: oturum B (L3'e kilitli, onaylı) satırı A'nın kilitli lokasyonunu (L1) da kapsıyor → LOCATION_LOCKED.
    const sidB = await startOn([L3]);
    await q("INSERT INTO public.count_session_lines (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity) VALUES ($1,$2,$3,$4,$5,NULL,$6,0)", [A.tenantId, uuid(), sidB, A.warehouseId, L1, X]);
    await q("UPDATE public.count_session_lines SET counted_quantity = 99, counted_by = $2 WHERE session_id = $1 AND location_id = $3", [sidB, A.ownerMembershipId, L1]);
    await rec(sidB, [{ loc: L3, item: X, qty: "9" }]);
    await approveFlow(sidB);
    expect(codeOf(await failure(postCountAdjustment(mgrP(), { sessionId: sidB })))).toBe("LOCATION_LOCKED");
    // Aynı denetim kilit düzeyinde: B'nin kimliğiyle A'nın lokasyonu istenir.
    const ctxA = createTenantContext(app, A.tenantId);
    const lockLevel = await withTenant(ctxA, (tx) => acquireStockLocks(tx, A.tenantId, { locationIds: [L1], dimensions: [], reservationIds: [], serialIds: [], countSessionId: sidB })).then(
      () => "OK",
      (e: { code?: string }) => e.code,
    );
    expect(lockLevel).toBe("LOCATION_LOCKED");

    // (d) kilitli + kilitsiz lokasyona birlikte yazan fark fişi: oturum C L3'e kilitli; satırlarından biri kilitsiz (IDLE) L4'e uzanır.
    await cancelCount(ownerP(), { sessionId: sidB, reason: "T309 test B" });
    const sidC = await startOn([L3]);
    await q("INSERT INTO public.count_session_lines (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity) VALUES ($1,$2,$3,$4,$5,NULL,$6,0)", [A.tenantId, uuid(), sidC, A.warehouseId, L4, X]);
    await q("UPDATE public.count_session_lines SET counted_quantity = 0, counted_by = $2 WHERE session_id = $1 AND location_id = $3", [sidC, A.ownerMembershipId, L4]);
    await rec(sidC, [{ loc: L3, item: X, qty: "8" }]);
    await approveFlow(sidC);
    expect(codeOf(await failure(postCountAdjustment(mgrP(), { sessionId: sidC })))).toBe("LOCATION_LOCKED");
    expect((await lockOf(L3)).status, "ret kilidi açmaz").toBe("COUNTING");
    expect(await bal(X, L3, "AVAILABLE")).toBe(n(9));
    expect(await bal(X, L4, "AVAILABLE")).toBe(n(1));
    expect(await snap()).toEqual(before);
    await cancelCount(ownerP(), { sessionId: sidC, reason: "T309 test C" });
    expect((await lockOf(L3)).status).toBe("IDLE");

    // (e) doğru oturum, onaylı: L1 6→5 (−1). L2 değişmez. İşler ve kilitleri IDLE yapar.
    await approveCount(mgrP(), { sessionId: sidA });
    const key = uuid();
    const done = await postCountAdjustment(callP(MGR.userId, key), { sessionId: sidA });
    expect(await adjLedger(done.documentId as string)).toEqual([{ item_id: X, location_id: L1, stock_status: "AVAILABLE", quantity: "-1.000000", reason: "COUNT_DIFF" }]);
    expect(await bal(X, L1, "AVAILABLE")).toBe(n(5));
    expect(await bal(X, L2, "AVAILABLE")).toBe(n(4));
    for (const loc of [L1, L2]) expect((await lockOf(loc)).status).toBe("IDLE");
    expect((await sessOf(sidA)).status).toBe("POSTED");
    // Kilitler açıldı: normal hareket artık geçer.
    await postDocument(ownerP(), { documentId: aIn.id, expectedVersion: aIn.version });
    expect(await bal(X, L1, "AVAILABLE")).toBe(n(6));
    // Aynı anahtarla tekrar: saklı sonuç, ikinci defter satırı yok.
    const ledgerAfter = await ledgerCount(X);
    const again = await postCountAdjustment(callP(MGR.userId, key), { sessionId: sidA });
    expect(again).toMatchObject({ documentId: done.documentId, replayed: true });
    expect(await ledgerCount(X)).toBe(ledgerAfter);
    // POSTED oturum yeniden işlenemez (yeni anahtar).
    expect(codeOf(await failure(postCountAdjustment(mgrP(), { sessionId: sidA })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
  });

  it("iptal: fark UYGULANMAZ, kilitler aynı transaction'da IDLE, gerekçe audit'e; pick_blocked ve açık görev olduğu gibi kalır", async () => {
    const X = await mkItem();
    const L1 = await mkLoc();
    const L2 = await mkLoc();
    await stockIn(X, L1, "6");
    await q("UPDATE public.locations SET pick_blocked = true WHERE id = $1", [L1]);
    const taskId = uuid();
    await q("INSERT INTO public.warehouse_tasks (tenant_id, id, warehouse_id, kind, location_id) VALUES ($1,$2,$3,'COUNT',$4)", [A.tenantId, taskId, A.warehouseId, L1]);
    const sid = await startOn([L1, L2]);
    await rec(sid, [{ loc: L1, item: X, qty: "1" }]);
    await approveFlow(sid);
    const nBefore = await ledgerCount(X);
    const res = await cancelCount(ownerP(), { sessionId: sid, reason: "  sayim yanlis lokasyonda yapildi  " });
    expect(res).toMatchObject({ status: "CANCELLED", replayed: false });
    expect(await sessOf(sid)).toMatchObject({ status: "CANCELLED", cancel_reason: "sayim yanlis lokasyonda yapildi" });
    for (const loc of [L1, L2]) expect((await lockOf(loc)).status).toBe("IDLE");
    expect(await ledgerCount(X)).toBe(nBefore);
    expect(await bal(X, L1, "AVAILABLE")).toBe(n(6));
    expect(await pickBlocked(L1)).toBe(true);
    expect((await q<{ status: string }>("SELECT status FROM public.warehouse_tasks WHERE id = $1", [taskId]))[0]?.status).toBe("OPEN");
    expect((await audits("count.cancelled", sid)).map((a) => a.reason)).toEqual(["sayim yanlis lokasyonda yapildi"]);
    // Kapanmış oturum tekrar iptal/işlem edilemez; yeni sayım aynı lokasyonlarda başlayabilir.
    expect(codeOf(await failure(cancelCount(ownerP(), { sessionId: sid, reason: "tekrar" })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(postCountAdjustment(mgrP(), { sessionId: sid })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    const again = await startOn([L1, L2]);
    await cancelCount(ownerP(), { sessionId: again, reason: "T309 temizlik" });
  });
});

describe("@AC-13 sayımdaki lokasyona hareket → LOCATION_LOCKED", () => {
  it("kaynak ve hedef olarak her komut türü reddedilir (hiçbir şey yazmaz); okuma ve sayım girişi serbest", async () => {
    const X = await mkItem();
    const LOCKED = await mkLoc();
    const FREE = await mkLoc();
    await stockIn(X, LOCKED, "5");
    await stockIn(X, FREE, "5");
    const sid = await startOn([LOCKED]);
    const before = { ledger: await ledgerCount(X), locked: await bal(X, LOCKED, "AVAILABLE"), free: await bal(X, FREE, "AVAILABLE") };
    const cases: Record<string, DocumentLineInput> = {
      "STOCK_IN hedef": ln(X, "1", { targetLocationId: LOCKED }),
      "STOCK_OUT kaynak": ln(X, "1", { sourceLocationId: LOCKED }),
    };
    for (const [name, line] of Object.entries(cases)) {
      const d = await mkDoc(name.startsWith("STOCK_IN") ? "STOCK_IN" : "STOCK_OUT", [line]);
      expect(codeOf(await failure(postDocument(ownerP(), { documentId: d.id, expectedVersion: d.version }))), name).toBe("LOCATION_LOCKED");
    }
    const asSource = await mkDoc("STOCK_MOVE", [ln(X, "1", { sourceLocationId: LOCKED, targetLocationId: FREE })]);
    expect(codeOf(await failure(postDocument(ownerP(), { documentId: asSource.id, expectedVersion: asSource.version }))), "STOCK_MOVE kaynak").toBe("LOCATION_LOCKED");
    const asTarget = await mkDoc("STOCK_MOVE", [ln(X, "1", { sourceLocationId: FREE, targetLocationId: LOCKED })]);
    expect(codeOf(await failure(postDocument(ownerP(), { documentId: asTarget.id, expectedVersion: asTarget.version }))), "STOCK_MOVE hedef").toBe("LOCATION_LOCKED");
    expect(codeOf(await failure(putaway(pickerP(), { sourceLocationId: FREE, targetLocationId: LOCKED, itemId: X, quantity: "1" }))), "yerleştirme hedef").toBe("LOCATION_LOCKED");
    expect(codeOf(await failure(putaway(pickerP(), { sourceLocationId: LOCKED, targetLocationId: FREE, itemId: X, quantity: "1" }))), "yerleştirme kaynak").toBe("LOCATION_LOCKED");
    expect({ ledger: await ledgerCount(X), locked: await bal(X, LOCKED, "AVAILABLE"), free: await bal(X, FREE, "AVAILABLE") }).toEqual(before);
    // Sayım girişi (stok yazmaz) kilitli lokasyonda serbest; okuma serbest.
    await rec(sid, [{ loc: LOCKED, item: X, qty: "5" }]);
    expect(await ops.getAvailableAtLocation(ownerP(), { locationId: LOCKED, itemId: X }), "okuma serbest").toEqual({ quantity: n(5) });
    await cancelCount(ownerP(), { sessionId: sid, reason: "T309 temizlik" });
    await postDocument(ownerP(), { documentId: asTarget.id, expectedVersion: asTarget.version }); // kilit açıldı → artık geçer
    expect(await bal(X, LOCKED, "AVAILABLE")).toBe(n(6));
  });

  it("kısmi kilit yok: biri zaten COUNTING ise başlatma tümüyle reddedilir; kilitler/oturum değişmez", async () => {
    const L1 = await mkLoc();
    const L2 = await mkLoc();
    const first = await startOn([L2]);
    const sessions = await sessionCount();
    expect(codeOf(await failure(startCount(ownerP(), { warehouseId: A.warehouseId, locationIds: [L1, L2] })))).toBe("LOCATION_LOCKED");
    expect((await lockOf(L1)).status, "L1 kilitlenmedi").toBe("IDLE");
    expect(await lockOf(L2)).toMatchObject({ status: "COUNTING", count_session_id: first });
    expect(await sessionCount()).toBe(sessions);
    await cancelCount(ownerP(), { sessionId: first, reason: "T309 temizlik" });
  });

  it("lock_timeout aşılır ve yeniden deneme tükenirse LOCATION_LOCKED (ham VERSION_CONFLICT/INTERNAL değil); oturum ve kilit oluşmaz", async () => {
    const L = await mkLoc();
    await holdBegin();
    await hold.query("SELECT 1 FROM public.location_count_locks WHERE location_id = $1 FOR SHARE", [L]);
    try {
      const sessions = await sessionCount();
      const e = await failure(startCount(ownerP({ retry: ONCE, timeouts: { lockTimeoutMs: 300, statementTimeoutMs: 10_000 } }), { warehouseId: A.warehouseId, locationIds: [L] }));
      expect(e.code).toBe("LOCATION_LOCKED");
      expect(await sessionCount()).toBe(sessions);
    } finally {
      await hold.query("ROLLBACK");
    }
    expect((await lockOf(L)).status).toBe("IDLE");
  });
});

describe("arşiv yarışı (T-217 Supervisor notu): arşivli lokasyon hiçbir zaman COUNTING olmaz", () => {
  it("arşiv (sayım kilidi FOR SHARE + lokasyon güncellemesi) sürerken başlatma bekler; arşiv commit edince lokasyon ACTIVE değil → reddedilir, kilit IDLE", async () => {
    const L = await mkLoc();
    await holdBegin();
    await hold.query("SELECT 1 FROM public.location_count_locks WHERE location_id = $1 FOR SHARE", [L]);
    await hold.query("UPDATE public.locations SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [L]);
    const pid = await holdPid();
    const sessions = await sessionCount();
    const starting = startCount(ownerP({ timeouts: LONG }), { warehouseId: A.warehouseId, locationIds: [L] });
    starting.catch(() => undefined);
    await untilBlocked(pid, 1);
    expect((await peek(starting)).state).toBe("pending");
    await hold.query("COMMIT");
    const e = await failure(starting);
    expect(codeOf(e)).toBe("VALIDATION_FAILED/IN_USE");
    expect((await lockOf(L)).status).toBe("IDLE");
    expect(await sessionCount()).toBe(sessions);
    const st = (await q<{ status: string }>("SELECT status FROM public.locations WHERE id = $1", [L]))[0]?.status;
    expect(st).toBe("ARCHIVED");
  });

  it("gerçek archiveLocation ile eşzamanlı: hiçbir turda (ARCHIVED ∧ COUNTING) birlikte oluşmaz; biri bekler, sonuç IN_USE ya da başlatma reddi", async () => {
    const adminP = { db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug, retry: NO_WAIT };
    for (let i = 0; i < 6; i++) {
      const L = await mkLoc();
      const [s, a] = await Promise.allSettled([
        startCount(ownerP({ timeouts: LONG }), { warehouseId: A.warehouseId, locationIds: [L] }),
        archiveLocation(adminP as never, { locationId: L }),
      ]);
      const row = (await q<{ status: string; lock: string }>(
        "SELECT l.status, k.status AS lock FROM public.locations l JOIN public.location_count_locks k ON k.location_id = l.id WHERE l.id = $1", [L]))[0] as { status: string; lock: string };
      expect(row.status === "ARCHIVED" && row.lock === "COUNTING", `tur ${i}: arşivli ∧ COUNTING olamaz (${s.status}/${a.status})`).toBe(false);
      expect(s.status === "fulfilled" || a.status === "fulfilled", `tur ${i}: en az biri başarılı`).toBe(true);
      if (s.status === "fulfilled") await cancelCount(ownerP(), { sessionId: s.value.sessionId, reason: "T309 temizlik" }).catch(() => undefined);
    }
  });
});

describe("sayım kuralları", () => {
  it("izinler (A-132): sayaç yalnız girer/gönderir; başlatma/iptal document.approve, onay ve fark fişi count_diff.approve; toplayıcı sayım giremez", async () => {
    const X = await mkItem();
    const L = await mkLoc();
    await stockIn(X, L, "3");
    expect(codeOf(await failure(startCount(counterP(), { warehouseId: A.warehouseId, locationIds: [L] })))).toBe("FORBIDDEN");
    const sid = await startOn([L]);
    expect(codeOf(await failure(recordCount(pickerP(), { sessionId: sid, lines: [{ locationId: L, itemId: X, countedQuantity: "3" }] })))).toBe("FORBIDDEN");
    await rec(sid, [{ loc: L, item: X, qty: "3" }]);
    await submitCount(counterP(), { sessionId: sid });
    expect(codeOf(await failure(approveCount(counterP(), { sessionId: sid })))).toBe("FORBIDDEN");
    expect(codeOf(await failure(cancelCount(counterP(), { sessionId: sid, reason: "x" })))).toBe("FORBIDDEN");
    await approveCount(mgrP(), { sessionId: sid });
    expect(codeOf(await failure(postCountAdjustment(counterP(), { sessionId: sid })))).toBe("FORBIDDEN");
    const posted = await postCountAdjustment(mgrP(), { sessionId: sid });
    expect(posted.documentId, "fark yok → belge açılmaz").toBeUndefined();
    expect(posted.status).toBe("POSTED");
    expect((await lockOf(L)).status, "fark olmasa da kilit açılır").toBe("IDLE");
    expect((await sessOf(sid)).status).toBe("POSTED");
  });

  it("durum makinesi atlamasız: sayılmamış satırla gönderme/onay reddedilir; COUNTING'den onay iki geçişi yapar; onaylı oturumda giriş DOCUMENT_STATE; approved_by yalnız onaylayan", async () => {
    const X = await mkItem();
    const Y = await mkItem();
    const L = await mkLoc();
    await stockIn(X, L, "3");
    await stockIn(Y, L, "2");
    const sid = await startOn([L]);
    expect(codeOf(await failure(submitCount(counterP(), { sessionId: sid })))).toBe("VALIDATION_FAILED");
    await rec(sid, [{ loc: L, item: X, qty: "3" }]);
    expect(codeOf(await failure(approveCount(mgrP(), { sessionId: sid })))).toBe("VALIDATION_FAILED"); // Y sayılmadı: sıfır SAYILMAZ (A-309-3)
    expect((await sessOf(sid)).status).toBe("COUNTING");
    await rec(sid, [{ loc: L, item: Y, qty: "2" }]);
    expect((await sessOf(sid)).approved_by).toBeNull();
    await approveCount(mgrP(), { sessionId: sid }); // COUNTING → SUBMITTED → APPROVED
    expect(await sessOf(sid)).toMatchObject({ status: "APPROVED", approved_by: MGR.membershipId });
    expect((await audits("count.approved", sid)).length).toBe(1);
    expect(codeOf(await failure(approveCount(mgrP(), { sessionId: sid })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(rec(sid, [{ loc: L, item: X, qty: "1" }])))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(submitCount(counterP(), { sessionId: sid })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    // approved_by başka onaylayıcıyla ezilmez (komut düzeyi; DB tetikleyicisi önerisi Q-121).
    await postCountAdjustment(ownerP(), { sessionId: sid });
    expect((await sessOf(sid)).approved_by).toBe(MGR.membershipId);
  });

  it("sayım girişi I-09: ürün ölçeğine (ve 6 ondalığa) inmeyen miktar QUANTITY_SCALE ile reddedilir, YUVARLANMAZ; kilit dışı lokasyon/yinelenen satır/negatif reddedilir", async () => {
    const WHOLE = await mkItem(0);
    const DEC = await mkItem(3);
    const L = await mkLoc();
    const OTHER = await mkLoc();
    await stockIn(WHOLE, L, "4");
    const sid = await startOn([L]);
    const bad = (qty: string, item = WHOLE) => failure(rec(sid, [{ loc: L, item, qty }]));
    expect(codeOf(await bad("2.5"))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(codeOf(await bad("1.0000001"))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(codeOf(await bad("1.2345", DEC))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(codeOf(await bad("-1"))).toBe("VALIDATION_FAILED");
    expect(codeOf(await bad("abc"))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(recordCount(counterP(), { sessionId: sid, lines: [{ locationId: OTHER, itemId: WHOLE, countedQuantity: "1" }] })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(recordCount(counterP(), { sessionId: sid, lines: [{ locationId: L, itemId: WHOLE, countedQuantity: "1" }, { locationId: L, itemId: WHOLE, countedQuantity: "2" }] })))).toBe("VALIDATION_FAILED");
    expect((await linesOf(sid))[0]?.counted_quantity, "hiçbir hatalı giriş yazılmadı").toBeNull();
    await rec(sid, [{ loc: L, item: DEC, qty: "1.125" }]); // sistemde olmayan bulgu: boyutsuz satır, referans 0 (A-309-4)
    const found = (await linesOf(sid)).find((l) => l.item_id === DEC);
    expect(found).toMatchObject({ stock_dimension_id: null, reference_quantity: n(0), counted_quantity: "1.125000" });
    await cancelCount(ownerP(), { sessionId: sid, reason: "T309 temizlik" });
  });

  it("sistemde olmayan bulgu AVAILABLE boyutuna + yazılır; fark KİLİTLİ bakiyeye göredir (referans değil); bayat referans sonucu değiştirmez", async () => {
    const X = await mkItem();
    const FOUND = await mkItem();
    const L = await mkLoc();
    await stockIn(X, L, "7");
    // El kurulumu oturum (fikstür): referans 99, gerçek kilitli bakiye 7, sayılan 6 → fark −1 (−93 değil).
    const sid = uuid();
    await q("INSERT INTO public.count_sessions (tenant_id, id, warehouse_id, blind, started_by) VALUES ($1,$2,$3,true,$4)", [A.tenantId, sid, A.warehouseId, A.ownerMembershipId]);
    const dimId = (await q<{ id: string }>("SELECT id FROM public.stock_dimensions WHERE tenant_id=$1 AND item_id=$2 AND location_id=$3", [A.tenantId, X, L]))[0]?.id as string;
    await q("INSERT INTO public.count_session_lines (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,99)", [A.tenantId, uuid(), sid, A.warehouseId, L, dimId, X]);
    await q("INSERT INTO public.count_session_lines (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity) VALUES ($1,$2,$3,$4,$5,NULL,$6,0)", [A.tenantId, uuid(), sid, A.warehouseId, L, FOUND]);
    await q("UPDATE public.count_session_lines SET counted_quantity = 6, counted_by = $2 WHERE session_id = $1 AND item_id = $3", [sid, A.ownerMembershipId, X]);
    await q("UPDATE public.count_session_lines SET counted_quantity = 3, counted_by = $2 WHERE session_id = $1 AND item_id = $3", [sid, A.ownerMembershipId, FOUND]);
    await q("UPDATE public.count_sessions SET status = 'SUBMITTED' WHERE id = $1", [sid]);
    await q("UPDATE public.count_sessions SET status = 'APPROVED', approved_by = $2 WHERE id = $1", [sid, MGR.membershipId]);
    await q("UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE location_id = $1", [L, sid, A.ownerMembershipId]);
    const done = await postCountAdjustment(mgrP(), { sessionId: sid });
    expect((await adjLedger(done.documentId as string)).map((r) => [r.item_id, r.quantity, r.stock_status]).sort()).toEqual(
      [[FOUND, "3.000000", "AVAILABLE"], [X, "-1.000000", "AVAILABLE"]].sort(),
    );
    expect(await bal(X, L, "AVAILABLE")).toBe(n(6));
    expect(await bal(FOUND, L, "AVAILABLE")).toBe(n(3));
    expect((await lockOf(L)).status).toBe("IDLE");
  });

  it("satır lokasyonu ≠ boyutun lokasyonu (Supervisor notu 2): işlem geri alınır — kilitler COUNTING, defter ve bakiye değişmez", async () => {
    const X = await mkItem();
    const L = await mkLoc();
    const M = await mkLoc();
    await stockIn(X, L, "4");
    await stockIn(X, M, "4");
    const dimL = (await q<{ id: string }>("SELECT id FROM public.stock_dimensions WHERE tenant_id=$1 AND item_id=$2 AND location_id=$3", [A.tenantId, X, L]))[0]?.id as string;
    const sid = uuid();
    await q("INSERT INTO public.count_sessions (tenant_id, id, warehouse_id, blind, started_by) VALUES ($1,$2,$3,true,$4)", [A.tenantId, sid, A.warehouseId, A.ownerMembershipId]);
    // Satır M diyor, boyut L'nin (FK yalnızca ürün eşitliğini zorlar).
    await q("INSERT INTO public.count_session_lines (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,4)", [A.tenantId, uuid(), sid, A.warehouseId, M, dimL, X]);
    await q("UPDATE public.count_session_lines SET counted_quantity = 1, counted_by = $2 WHERE session_id = $1", [sid, A.ownerMembershipId]);
    await q("UPDATE public.count_sessions SET status = 'SUBMITTED' WHERE id = $1", [sid]);
    await q("UPDATE public.count_sessions SET status = 'APPROVED', approved_by = $2 WHERE id = $1", [sid, MGR.membershipId]);
    await q("UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE location_id = ANY($1)", [[L, M], sid, A.ownerMembershipId]);
    const nBefore = await ledgerCount(X);
    const e = await failure(postCountAdjustment(mgrP(), { sessionId: sid }));
    expect(e.code).toBe("INTERNAL");
    expect(await ledgerCount(X)).toBe(nBefore);
    expect(await bal(X, L, "AVAILABLE")).toBe(n(4));
    expect(await bal(X, M, "AVAILABLE")).toBe(n(4));
    for (const loc of [L, M]) expect(await lockOf(loc)).toMatchObject({ status: "COUNTING", count_session_id: sid });
    expect((await sessOf(sid)).status).toBe("APPROVED");
  });

  it("sayılan rezerve miktarın altına inemez (A-309-5, Q-122): INSUFFICIENT_STOCK; tüm işlem geri alınır (kilitler COUNTING, bakiye ve rezervasyon değişmez)", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await stockIn(X, R, "5");
    const o = await createSalesOrder(ownerP(), { customerRef: "T309-MUS", lines: [{ itemId: X, unitId: A.unitId, quantity: "3" }] });
    await reserveOrder(ownerP(), { orderId: o.documentId as string });
    expect(await reservedOf(X)).toBe(n(3));
    const sid = await startOn([R]);
    await rec(sid, [{ loc: R, item: X, qty: "1" }]); // 5 → 1 ama 3'ü rezerve
    await approveFlow(sid);
    const nBefore = await ledgerCount(X);
    expect(codeOf(await failure(postCountAdjustment(mgrP(), { sessionId: sid })))).toBe("INSUFFICIENT_STOCK");
    expect(await ledgerCount(X)).toBe(nBefore);
    expect(await bal(X, R, "AVAILABLE")).toBe(n(5));
    expect(await reservedOf(X)).toBe(n(3));
    expect(await lockOf(R)).toMatchObject({ status: "COUNTING", count_session_id: sid });
    expect((await sessOf(sid)).status).toBe("APPROVED");
    // Yetkili çıkış yolu: iptal.
    await cancelCount(ownerP(), { sessionId: sid, reason: "T309 rezerve altina inemez" });
    expect((await lockOf(R)).status).toBe("IDLE");
  });

  it("başlatma doğrulamaları: takipli bakiye (A-309-2), başka depo, arşivli lokasyon ve tekrar anahtarı", async () => {
    // Takipli (lot/seri/sahip/taşıma birimi) boyutu olan lokasyon: world fikstürünün seri boyutu.
    const serialLoc = (await q<{ location_id: string }>("SELECT location_id FROM public.stock_dimensions WHERE id = $1", [A.serialDimensionId]))[0]?.location_id as string;
    expect(codeOf(await failure(startCount(ownerP(), { warehouseId: A.warehouseId, locationIds: [serialLoc] })))).toBe("VALIDATION_FAILED");
    expect((await lockOf(serialLoc)).status).toBe("IDLE");
    // Başka depodaki lokasyon.
    const WB = uuid();
    await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,$3,'T309 depo B')", [A.tenantId, WB, `W${hex(6)}`]);
    const foreign = await mkLoc("STORAGE", WB);
    expect(codeOf(await failure(startCount(ownerP(), { warehouseId: A.warehouseId, locationIds: [foreign] })))).toBe("VALIDATION_FAILED/LOCATION_WAREHOUSE_MISMATCH");
    // Arşivli lokasyon.
    const arch = await mkLoc();
    await q("UPDATE public.locations SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [arch]);
    expect(codeOf(await failure(startCount(ownerP(), { warehouseId: A.warehouseId, locationIds: [arch] })))).toBe("VALIDATION_FAILED/IN_USE");
    // Biçim: boş liste, geçersiz kimlik, anahtarsız istek.
    expect(codeOf(await failure(startCount(ownerP(), { warehouseId: A.warehouseId, locationIds: [] })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(startCount(ownerP(), { warehouseId: A.warehouseId, locationIds: ["x"] })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(startCount(callP(A.ownerUserId, null), { warehouseId: A.warehouseId, locationIds: [await mkLoc()] })))).toBe("VALIDATION_FAILED/IDEMPOTENCY_KEY_REQUIRED");
    // Aynı anahtar: aynı oturum, ikinci oturum/kilit yok; kör varsayılan açık.
    const L = await mkLoc();
    const key = uuid();
    const one = await startCount(callP(A.ownerUserId, key), { warehouseId: A.warehouseId, locationIds: [L] });
    const sessions = await sessionCount();
    const two = await startCount(callP(A.ownerUserId, key), { warehouseId: A.warehouseId, locationIds: [L] });
    expect(two).toMatchObject({ sessionId: one.sessionId, replayed: true });
    expect(await sessionCount()).toBe(sessions);
    expect((await sessOf(one.sessionId)).blind).toBe(true);
    await cancelCount(ownerP(), { sessionId: one.sessionId, reason: "T309 temizlik" });
    const open = await startOn([L], { blind: false });
    expect((await sessOf(open)).blind).toBe(false);
    await cancelCount(ownerP(), { sessionId: open, reason: "T309 temizlik" });
  });

  it("başka tenant'ın oturumu NOT_FOUND (varlık sızmaz)", async () => {
    const other = await seedWorld(adm, reg, "B309");
    const L = other.rootLocationId;
    const sid = (await startCount(callP(other.ownerUserId, uuid(), { tenantSlug: other.slug }), { warehouseId: other.warehouseId, locationIds: [L] })).sessionId;
    expect(codeOf(await failure(cancelCount(ownerP(), { sessionId: sid, reason: "x" })))).toBe("NOT_FOUND");
    expect(codeOf(await failure(recordCount(counterP(), { sessionId: sid, lines: [{ locationId: L, itemId: A.itemNoneId, countedQuantity: "1" }] })))).toBe("NOT_FOUND");
    expect((await q<{ status: string }>("SELECT status FROM public.location_count_locks WHERE location_id = $1", [L]))[0]?.status).toBe("COUNTING");
  });
});

describe("terk edilmiş sayım alarmı (06; A-136 varsayılan 8 saat)", () => {
  it("süre dolunca findAbandonedCounts oturumu bildirir; kilidi AÇMAZ ve oturumu değiştirmez; tenant ayarı eşiği değiştirir", async () => {
    const L1 = await mkLoc();
    const L2 = await mkLoc();
    const sid = await startOn([L1, L2]);
    const check = () => withSystemTenant(app, A.tenantId, "stock.count.abandon.check", (tx) => findAbandonedCounts(tx, A.tenantId));
    expect((await check()).filter((a) => a.sessionId === sid), "yeni sayım terk değil").toEqual([]);
    await q("UPDATE public.location_count_locks SET locked_at = now() - interval '7 hours' WHERE location_id = ANY($1)", [[L1, L2]]);
    expect((await check()).filter((a) => a.sessionId === sid), "7 saat < 8").toEqual([]);
    await q("UPDATE public.location_count_locks SET locked_at = now() - interval '9 hours' WHERE location_id = $1", [L1]);
    const hit = (await check()).filter((a) => a.sessionId === sid);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ sessionId: sid, warehouseId: A.warehouseId, sessionStatus: "COUNTING", lockedLocations: 1, thresholdHours: 8 });
    expect(hit[0]?.openHours).toBeGreaterThan(8.9);
    // Eşik tenant ayarıdır (1..168).
    await q("UPDATE public.tenant_settings SET count_abandon_hours = 6 WHERE tenant_id = $1", [A.tenantId]);
    try {
      const six = (await check()).filter((a) => a.sessionId === sid);
      expect(six[0]).toMatchObject({ lockedLocations: 2, thresholdHours: 6 });
    } finally {
      await q("UPDATE public.tenant_settings SET count_abandon_hours = 8 WHERE tenant_id = $1", [A.tenantId]);
    }
    // Otomatik açılmaz: kilitler ve oturum yerinde.
    for (const loc of [L1, L2]) expect(await lockOf(loc)).toMatchObject({ status: "COUNTING", count_session_id: sid });
    expect((await sessOf(sid)).status).toBe("COUNTING");
    // Yalnızca yetkili iptal kapatır; sonra alarm kalmaz.
    await cancelCount(ownerP(), { sessionId: sid, reason: "T309 terk edilmis sayim iptali" });
    expect((await check()).filter((a) => a.sessionId === sid)).toEqual([]);
  });
});
