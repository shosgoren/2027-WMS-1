// T-293 (ADR-025): rehberli saha akışı — görev adım ilerlemesi. Gerçek wms_app bağlantısı + RLS + gerçek stok komutu (`putaway`). Fikstürler sentetik (G-09).
// Kapsam: B tenant'ı ve atanmamış üye okuyamaz/yazamaz; IDOR (fazla alan reddi); atama değişince eski ilerleme dönmez (A → B → A dahil); aynı anahtarla iki
// kayıt tek defter etkisi; ilerleme yazımı stok/defter/görev/audit satırlarını değiştirmez; yanlış raf/ürün/miktar adımı değiştirmez; migration up → down → up.
import pg from "pg";
import { readdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { MIGRATIONS_DIR, migrateDown, migrateUp } from "../../../packages/db/src/migrate.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import * as ops from "../../../packages/domain/src/operations/index.ts";
import {
  assignTask,
  beginSave,
  createInboundReceipt,
  getTaskProgress,
  nextTaskFor,
  openInboundReceipt,
  receiveGoods,
  recordTaskStep,
  resetTaskProgress,
  savePutawayTask,
  type RecordStepResult,
} from "../../../packages/domain/src/operations/index.ts";
import { runTenantCommand } from "../../../packages/domain/src/identity/access.ts";
import { createTasks } from "../../../packages/domain/src/operations/tasks.ts";
import type { StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const NO_WAIT = { sleep: async () => undefined } as const;
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let p2UserId: string;
let p2MembershipId: string;
let KABUL: string;
let R01: string;
let R02: string;
let STAGE: string;
let ARCH: string;
const scratchDbs: string[] = [];

const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const owner = () => ({ db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug });
const picker1 = () => ({ db: app, principal: { userId: A.memberUserId, mfaVerified: true }, tenantSlug: A.slug });
const picker2 = () => ({ db: app, principal: { userId: p2UserId, mfaVerified: true }, tenantSlug: A.slug });
const bMember = () => ({ db: app, principal: { userId: B.memberUserId, mfaVerified: true }, tenantSlug: B.slug });
const stockP = (p: { db: DbClient; principal: { userId: string; mfaVerified: boolean }; tenantSlug: string }, key: string | null = uuid()): StockDocCallParams => ({ ...p, clientKey: key, retry: NO_WAIT });

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

// --- fikstürler ---------------------------------------------------------------------------------------------------------
async function mkLoc(kind: "RECEIVING" | "STORAGE" | "STAGING", archived = false): Promise<string> {
  const id = uuid();
  await q(
    `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, status, archived_at)
     VALUES ($1,$2,$3,NULL,$4,'T293 lok',0,$5,$6,$7)`,
    [A.tenantId, id, A.warehouseId, `L-${hex(10).toUpperCase()}`, kind, archived ? "ARCHIVED" : "ACTIVE", archived ? new Date() : null],
  );
  return id;
}
const codeOfLoc = async (id: string): Promise<string> => (await q<{ code: string }>("SELECT code FROM public.locations WHERE id = $1", [id]))[0]?.code as string;

interface Job {
  readonly itemId: string;
  readonly itemCode: string;
  readonly barcode: string;
  readonly taskId: string;
}
/** Yeni ürün + barkod; KABUL rafında `qty` adet (mal kabul, KK kapalı) ve görevin KABUL'den yerleştirme görevi. Görev OPEN doğar. */
async function mkJob(qty = "10"): Promise<Job> {
  const itemId = uuid();
  const itemCode = `I-${hex(10)}`;
  const barcode = `869${hex(10)}`;
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T293 urun',$4,'NONE',0)", [A.tenantId, itemId, itemCode, A.unitId]);
  await q("INSERT INTO public.item_barcodes (tenant_id, item_id, barcode) VALUES ($1,$2,$3)", [A.tenantId, itemId, barcode]);
  const c = await createInboundReceipt(stockP(owner()), {
    warehouseId: A.warehouseId,
    supplierRef: "T293-TED",
    lines: [{ itemId, unitId: A.unitId, expectedQuantity: qty }],
  });
  const receiptId = c.documentId as string;
  await openInboundReceipt(stockP(owner()), { receiptId, expectedVersion: 1 });
  const line = (await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id = $1 ORDER BY line_no", [receiptId]))[0]?.id as string;
  await receiveGoods(stockP(picker1()), { receiptId, lines: [{ lineId: line, received: qty, locationId: KABUL }] });
  // QK kapalı: kabul stoğu doğrudan KABUL·KUL; yerleştirme görevi (OPEN) kabul akışı yerine iç yardımcıyla açılır (görev yalnızca saha komutu transaction'ında doğar).
  const [taskId] = await runTenantCommand({ ...owner(), permission: "stock.post" }, (tx, m) =>
    createTasks(tx, m, [{ warehouseId: A.warehouseId, kind: "PUTAWAY", locationId: KABUL, itemId, quantity: qty }]),
  );
  expect(taskId).toBeDefined();
  return { itemId, itemCode, barcode, taskId: taskId as string };
}
async function assign(taskId: string, membershipId: string): Promise<void> {
  const v = (await q<{ version: number }>("SELECT version FROM public.warehouse_tasks WHERE id = $1", [taskId]))[0]?.version as number;
  await assignTask(owner(), { taskId, membershipId, expectedVersion: Number(v) });
}
const progressRows = (taskId: string) =>
  q<{ membership_id: string; step: string; location_id: string | null; quantity: string | null; save_client_key: string | null; updated_at: Date; task_version: number }>(
    "SELECT membership_id, step, location_id, quantity::text AS quantity, save_client_key, updated_at, task_version FROM public.warehouse_task_progress WHERE tenant_id=$1 AND task_id=$2",
    [A.tenantId, taskId],
  );
const taskRow = async (id: string) => (await q<{ status: string; version: number }>("SELECT status, version FROM public.warehouse_tasks WHERE id=$1", [id]))[0] as { status: string; version: number };
const step = (taskId: string, s: "SCAN_ITEM" | "SCAN_TARGET", scannedCode: string, who = picker1(), extra: Record<string, unknown> = {}) =>
  recordTaskStep(who, { taskId, step: s, scannedCode, ...extra });
const qty = (taskId: string, quantity: string, who = picker1()) => recordTaskStep(who, { taskId, step: "ENTER_QUANTITY", quantity });
function rejected(r: RecordStepResult): Extract<RecordStepResult, { accepted: false }> {
  expect(r.accepted).toBe(false);
  return r as Extract<RecordStepResult, { accepted: false }>;
}
function accepted(r: RecordStepResult): Extract<RecordStepResult, { accepted: true }> {
  expect(r.accepted).toBe(true);
  return r as Extract<RecordStepResult, { accepted: true }>;
}

/** Tüm tenant satır sayıları (stok, defter, belge, görev, audit); ilerleme yazımı bunları değiştirmez (AC-20 deseni). */
async function counts(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of ["stock_ledger", "stock_balances", "stock_dimensions", "reservations", "documents", "document_lines", "idempotency_records", "audit_logs", "warehouse_tasks"]) {
    out[t] = (await q<{ c: string }>(`SELECT count(*)::text AS c FROM public.${t} WHERE tenant_id=$1`, [A.tenantId]))[0]?.c as string;
  }
  out.tasks_state = (await q<{ s: string }>("SELECT COALESCE(string_agg(id::text || status || version, ',' ORDER BY id), '') AS s FROM public.warehouse_tasks WHERE tenant_id=$1", [A.tenantId]))[0]?.s as string;
  out.balances_sum = (await q<{ s: string }>("SELECT COALESCE(sum(quantity),0)::text AS s FROM public.stock_balances WHERE tenant_id=$1", [A.tenantId]))[0]?.s as string;
  return out;
}
const ledgerCount = async (item: string): Promise<number> =>
  Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.stock_ledger WHERE tenant_id=$1 AND item_id=$2", [A.tenantId, item]))[0]?.c);
const balanceAt = async (item: string, loc: string): Promise<string> =>
  (await q<{ s: string }>(
    `SELECT COALESCE(sum(b.quantity),0)::text AS s FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.location_id=$3 AND s.stock_status='AVAILABLE'`,
    [A.tenantId, item, loc],
  ))[0]?.s as string;

/** wms_app (DATABASE_URL) ile ham transaction: yalnızca verilen tenant bağlamıyla. */
async function asApp<T>(tenantId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: env.databaseUrl });
  c.on("error", () => undefined);
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    try {
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A293");
  B = await seedWorld(adm, reg, "B293");
  p2UserId = await mkUser(adm, reg, "A293 picker2");
  p2MembershipId = await mkMembership(adm, A.tenantId, p2UserId, { roles: ["PICKER"] });
  await q("UPDATE public.tenant_settings SET receiving_qc_enabled = false WHERE tenant_id = $1", [A.tenantId]);
  KABUL = await mkLoc("RECEIVING");
  R01 = await mkLoc("STORAGE");
  R02 = await mkLoc("STORAGE");
  STAGE = await mkLoc("STAGING");
  ARCH = await mkLoc("STORAGE", true);
}, 180_000);

afterAll(async () => {
  for (const name of scratchDbs) await q(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await adm.end();
  await app.close();
}, 60_000);

describe("dışa açık yüzey", () => {
  it("ilerleme komutları açık; saf yardımcılar (parseRecordStepInput) ve iç yardımcılar açık değil", () => {
    expect(Object.keys(ops)).toEqual(expect.arrayContaining(["getTaskProgress", "recordTaskStep", "beginSave", "savePutawayTask", "resetTaskProgress", "nextTaskFor"]));
    expect(Object.keys(ops)).not.toContain("parseRecordStepInput");
    expect(Object.keys(ops)).not.toContain("completeTask");
    expect(Object.keys(ops)).not.toContain("createTasks");
  });
});

describe("rehberli yerleştirme akışı (A-293-3): ürün → hedef raf → miktar → kaydet", () => {
  it("doğru sıra ilerler; yanlış okutma adımı değiştirmez (beklenen + okunan değerle); sayfa yenilenince aynı adım; kayıt görevi DONE yapar", async () => {
    const job = await mkJob();
    const other = await mkJob(); // başka ürün (yanlış ürün okutma)
    await assign(job.taskId, A.memberMembershipId);

    const v0 = await getTaskProgress(picker1(), { taskId: job.taskId });
    expect(v0).toMatchObject({ step: "SCAN_ITEM", taskStatus: "ASSIGNED", itemCode: job.itemCode, expectedQuantity: "10", sourceLocationCode: await codeOfLoc(KABUL), targetLocationCode: null, quantity: null, saveClientKey: null });
    expect(await progressRows(job.taskId)).toHaveLength(0);

    // Yanlış ürün / bilinmeyen kod: ilerleme DEĞİŞMEZ.
    const wrong = rejected(await step(job.taskId, "SCAN_ITEM", other.barcode));
    expect(wrong).toMatchObject({ code: "VALIDATION_FAILED", detail: "SCAN_MISMATCH", reason: "WRONG_ITEM", expected: job.itemCode, scanned: other.itemCode });
    expect(wrong.progress.step).toBe("SCAN_ITEM");
    expect(rejected(await step(job.taskId, "SCAN_ITEM", "NOPE-0000")).reason).toBe("UNKNOWN_CODE");
    expect(await progressRows(job.taskId)).toHaveLength(0);
    // Sıra dışı: ürün doğrulanmadan raf/miktar.
    expect(codeOf(await failure(step(job.taskId, "SCAN_TARGET", await codeOfLoc(R01))))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(qty(job.taskId, "10")))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");

    const s1 = accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    expect(s1.progress.step).toBe("SCAN_TARGET");
    // Yeniden gönderim (yanıt kaybı): doğrulanır, ilerleme değişmez.
    expect(accepted(await step(job.taskId, "SCAN_ITEM", job.barcode)).progress.step).toBe("SCAN_TARGET");

    // Hedef raf kuralı (A-305-8): kaynak raf, STORAGE olmayan, arşivli, bilinmeyen raf reddedilir; adım DEĞİŞMEZ.
    const before = (await progressRows(job.taskId))[0];
    expect(rejected(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(KABUL))).reason).toBe("SAME_AS_SOURCE");
    const notStorage = rejected(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(STAGE)));
    expect(notStorage).toMatchObject({ reason: "NOT_STORAGE", scannedKind: "STAGING", scanned: await codeOfLoc(STAGE) });
    expect(rejected(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(ARCH))).reason).toBe("LOCATION_ARCHIVED");
    expect(rejected(await step(job.taskId, "SCAN_TARGET", "YOK-RAF-1")).reason).toBe("UNKNOWN_CODE");
    expect(rejected(await step(job.taskId, "SCAN_TARGET", "\u0007\u0001")).reason).toBe("UNKNOWN_CODE"); // denetim karakteri: istisna değil, okutma reddi
    const unchanged = (await progressRows(job.taskId))[0];
    expect(unchanged).toEqual(before); // satır birebir aynı (updated_at dahil): hiç yazım yok
    expect(unchanged?.step).toBe("SCAN_TARGET");

    // Küçük harf okutma (kod normalleştirilir) + doğru raf.
    const r01Code = await codeOfLoc(R01);
    expect(accepted(await step(job.taskId, "SCAN_TARGET", r01Code.toLowerCase())).progress).toMatchObject({ step: "ENTER_QUANTITY", targetLocationCode: r01Code });

    // Miktar görevle birebir (A-305-7): fazla, eksik, sıfır reddedilir.
    for (const bad of ["11", "9", "0", "9.999999"]) {
      expect(rejected(await qty(job.taskId, bad))).toMatchObject({ reason: "WRONG_QUANTITY", detail: null, expected: "10", scanned: bad === "9.999999" ? "9.999999" : bad });
    }
    expect((await progressRows(job.taskId))[0]?.step).toBe("ENTER_QUANTITY");
    expect(codeOf(await failure(qty(job.taskId, "ten")))).toBe("VALIDATION_FAILED"); // biçim hatası (UI'da olmaz)
    expect(accepted(await qty(job.taskId, "10.000000")).progress).toMatchObject({ step: "CONFIRM", quantity: "10" });

    // Hedef raf CONFIRM'da değiştirilebilir (miktar korunur).
    const r02Code = await codeOfLoc(R02);
    expect(accepted(await step(job.taskId, "SCAN_TARGET", r02Code)).progress).toMatchObject({ step: "CONFIRM", targetLocationCode: r02Code, quantity: "10" });

    // "Sayfa yenilendi": sunucu aynı adımı verir.
    expect(await getTaskProgress(picker1(), { taskId: job.taskId })).toMatchObject({ step: "CONFIRM", targetLocationCode: r02Code, quantity: "10", saveClientKey: null });

    // Kaydet: anahtar ilerlemede, stok komutu aynı anahtarla.
    const ledgerBefore = await ledgerCount(job.itemId);
    const saved = await savePutawayTask(stockP(picker1(), null), { taskId: job.taskId });
    expect(saved.replayed).toBe(false);
    expect(await taskRow(job.taskId)).toMatchObject({ status: "DONE" });
    expect(await ledgerCount(job.itemId)).toBe(ledgerBefore + 2); // yalnızca −10/+10 (ikinci stok girişi yok)
    expect(await balanceAt(job.itemId, R02)).toBe("10.000000");
    expect(await balanceAt(job.itemId, KABUL)).toBe("0.000000");
    // Tamamlandı yalnızca görev DONE iken söylenir: ilerleme görünümü DONE'ı gösterir, adım yok.
    expect(await getTaskProgress(picker1(), { taskId: job.taskId })).toMatchObject({ taskStatus: "DONE", step: null });
  });

  it("görevsiz/atanmamış tür dışı görev: PICK görevi rehberli akışa kapalı (VALIDATION_FAILED)", async () => {
    const [pickId] = await runTenantCommand({ ...owner(), permission: "stock.post" }, (tx, m) =>
      createTasks(tx, m, [{ warehouseId: A.warehouseId, kind: "PICK", locationId: R01, itemId: A.itemId, quantity: "1" }]),
    );
    await assign(pickId as string, A.memberMembershipId);
    expect((await failure(getTaskProgress(picker1(), { taskId: pickId as string }))).code).toBe("VALIDATION_FAILED");
  });
});

describe("kaydet: istemci anahtarı ilerlemede, aynı anahtarla tek defter etkisi (ADR-018)", () => {
  it("aynı anahtarla iki kayıt tek defter etkisi üretir; anahtar kayıt öncesi KALICI; yeniden gönderim replayed", async () => {
    const job = await mkJob();
    await assign(job.taskId, A.memberMembershipId);
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    accepted(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(R01)));
    accepted(await qty(job.taskId, "10"));

    // Yalnızca anahtarı yaz (yanıt kaybı senaryosu: istemci ikinci adıma hiç ulaşmadı).
    const first = await beginSave(picker1(), { taskId: job.taskId });
    const again = await beginSave(picker1(), { taskId: job.taskId });
    expect(again.clientKey).toBe(first.clientKey); // yeniden gönderimde AYNI anahtar
    expect(first.progress.step).toBe("SAVING");
    expect((await progressRows(job.taskId))[0]).toMatchObject({ step: "SAVING", save_client_key: first.clientKey });
    // SAVING'de yeni okutma/miktar kabul edilmez (anahtar başka girdiyle kullanılamaz).
    expect(codeOf(await failure(step(job.taskId, "SCAN_TARGET", await codeOfLoc(R02))))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");

    const ledgerBefore = await ledgerCount(job.itemId);
    const r1 = await savePutawayTask(stockP(picker1(), null), { taskId: job.taskId });
    expect(r1.replayed).toBe(false);
    const afterFirst = { ledger: await ledgerCount(job.itemId), bal: await balanceAt(job.itemId, R01), counts: await counts() };
    expect(afterFirst.ledger).toBe(ledgerBefore + 2);
    // İkinci kayıt (yanıt kaybolmuştu): görev zaten DONE; aynı anahtar saklı sonucu döndürür, defter ETKİSİ YOK.
    const r2 = await savePutawayTask(stockP(picker1(), null), { taskId: job.taskId });
    expect(r2.replayed).toBe(true);
    expect({ ledger: await ledgerCount(job.itemId), bal: await balanceAt(job.itemId, R01), counts: await counts() }).toEqual(afterFirst);
    expect((await progressRows(job.taskId))[0]?.save_client_key).toBe(first.clientKey); // kayıt tek anahtarla yapıldı
    // Doğrudan stok komutu aynı anahtarla da aynı sonucu verir (iki yol aynı idempotency kaydı).
    const direct = await ops.putaway(stockP(picker1(), first.clientKey), {
      taskId: job.taskId,
      sourceLocationId: KABUL,
      targetLocationId: R01,
      itemId: job.itemId,
      quantity: "10.000000",
    });
    expect(direct.replayed).toBe(true);
    expect(await ledgerCount(job.itemId)).toBe(ledgerBefore + 2);
  });

  it("adımlar tamamlanmadan kaydet reddedilir (DOCUMENT_STATE); stok değişmez; baştan başla yeni anahtar verir", async () => {
    const job = await mkJob();
    await assign(job.taskId, A.memberMembershipId);
    const c0 = await counts();
    expect(codeOf(await failure(savePutawayTask(stockP(picker1(), null), { taskId: job.taskId })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    expect(codeOf(await failure(beginSave(picker1(), { taskId: job.taskId })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await counts()).toEqual(c0);

    accepted(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(R01)));
    accepted(await qty(job.taskId, "10"));
    const k1 = (await beginSave(picker1(), { taskId: job.taskId })).clientKey;
    const reset = await resetTaskProgress(picker1(), { taskId: job.taskId });
    expect(reset).toMatchObject({ step: "SCAN_ITEM", saveClientKey: null });
    expect(await progressRows(job.taskId)).toHaveLength(0);
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    accepted(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(R01)));
    accepted(await qty(job.taskId, "10"));
    expect((await beginSave(picker1(), { taskId: job.taskId })).clientKey).not.toBe(k1);
  });
});

describe("yetki: yalnızca atanan üye; başka tenant NOT_FOUND", () => {
  it("atanmamış üye (başka PICKER, atanmamış/OPEN görev, ADMIN) ilerlemeyi okuyamaz ve yazamaz; ilerleme oluşmaz", async () => {
    const job = await mkJob();
    // OPEN (kimseye atanmamış) görev: kimse yazamaz.
    expect((await failure(getTaskProgress(picker1(), { taskId: job.taskId }))).code).toBe("FORBIDDEN");
    expect((await failure(step(job.taskId, "SCAN_ITEM", job.barcode))).code).toBe("FORBIDDEN");
    await assign(job.taskId, A.memberMembershipId);
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    const rowsBefore = await progressRows(job.taskId);
    const c0 = await counts();
    for (const who of [picker2(), owner()]) {
      expect((await failure(getTaskProgress(who, { taskId: job.taskId }))).code).toBe("FORBIDDEN");
      expect((await failure(step(job.taskId, "SCAN_TARGET", await codeOfLoc(R01), who))).code).toBe("FORBIDDEN");
      expect((await failure(qty(job.taskId, "10", who))).code).toBe("FORBIDDEN");
      expect((await failure(beginSave(who, { taskId: job.taskId }))).code).toBe("FORBIDDEN");
      expect((await failure(savePutawayTask(stockP(who, null), { taskId: job.taskId }))).code).toBe("FORBIDDEN");
      expect((await failure(resetTaskProgress(who, { taskId: job.taskId }))).code).toBe("FORBIDDEN");
    }
    expect(await progressRows(job.taskId)).toEqual(rowsBefore); // başkası ne okudu ne değiştirdi
    expect(await counts()).toEqual(c0);
    // Başkasına atanmış görev "sıradaki görev"de de görünmez.
    expect((await failure(nextTaskFor(picker2(), { afterTaskId: job.taskId }))).code).toBe("FORBIDDEN");
  });

  it("B tenant'ı A'nın görevinde ilerleme okuyamaz/yazamaz (NOT_FOUND); ham wms_app oturumu RLS ile satırı göremez ve yazamaz", async () => {
    const job = await mkJob();
    await assign(job.taskId, A.memberMembershipId);
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    const rowsBefore = await progressRows(job.taskId);
    expect((await failure(getTaskProgress(bMember(), { taskId: job.taskId }))).code).toBe("NOT_FOUND");
    expect((await failure(step(job.taskId, "SCAN_ITEM", job.barcode, bMember()))).code).toBe("NOT_FOUND");
    expect((await failure(qty(job.taskId, "10", bMember()))).code).toBe("NOT_FOUND");
    expect((await failure(beginSave(bMember(), { taskId: job.taskId }))).code).toBe("NOT_FOUND");
    expect((await failure(resetTaskProgress(bMember(), { taskId: job.taskId }))).code).toBe("NOT_FOUND");
    expect((await failure(nextTaskFor(bMember(), { afterTaskId: job.taskId }))).code).toBe("NOT_FOUND");
    expect(await progressRows(job.taskId)).toEqual(rowsBefore);

    // Ham SQL (uygulama rolü): B bağlamı A'nın satırını görmez, silemez, güncelleyemez; A'nın tenant_id'siyle B bağlamında yazamaz.
    await asApp(B.tenantId, async (c) => {
      expect((await c.query("SELECT 1 FROM public.warehouse_task_progress WHERE task_id = $1", [job.taskId])).rowCount).toBe(0);
      expect((await c.query("UPDATE public.warehouse_task_progress SET step = 'CONFIRM' WHERE task_id = $1", [job.taskId])).rowCount).toBe(0);
      expect((await c.query("DELETE FROM public.warehouse_task_progress WHERE task_id = $1", [job.taskId])).rowCount).toBe(0);
    });
    await expect(
      asApp(B.tenantId, async (c) => {
        await c.query("INSERT INTO public.warehouse_task_progress (tenant_id, task_id, membership_id, task_version, step, item_id) VALUES ($1,$2,$3,1,'SCAN_TARGET',$4)", [
          A.tenantId, job.taskId, A.memberMembershipId, job.itemId,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);
    // Bağlamsız (tenant ayarı yok) oturum satır görmez.
    const bare = new pg.Client({ connectionString: env.databaseUrl });
    bare.on("error", () => undefined);
    await bare.connect();
    try {
      await bare.query("BEGIN");
      expect((await bare.query("SELECT 1 FROM public.warehouse_task_progress")).rowCount).toBe(0);
      await bare.query("ROLLBACK");
    } finally {
      await bare.end();
    }
    expect(await progressRows(job.taskId)).toEqual(rowsBefore);
  });

  it("DB savunması: başka tenant üyeliği FK ile reddedilir; adım/miktar/anahtar tutarlılığı CHECK ile; kimlik sütunları UPDATE'te yok; diğer roller yetkisiz", async () => {
    const job = await mkJob();
    await assign(job.taskId, A.memberMembershipId);
    const ver = (await taskRow(job.taskId)).version;
    const ins = (membership: string, st: string, extra: { qty?: string | null; key?: string | null; loc?: string | null } = {}) =>
      q(
        "INSERT INTO public.warehouse_task_progress (tenant_id, task_id, membership_id, task_version, step, item_id, location_id, quantity, save_client_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [A.tenantId, job.taskId, membership, ver, st, job.itemId, extra.loc ?? null, extra.qty ?? null, extra.key ?? null],
      );
    await expect(ins(B.memberMembershipId, "SCAN_TARGET")).rejects.toThrow(/warehouse_task_progress_membership_fkey/);
    await expect(ins(A.memberMembershipId, "SAVING", { loc: R01, qty: "10" })).rejects.toThrow(/warehouse_task_progress_save_key_chk/); // SAVING ⇔ anahtar
    await expect(ins(A.memberMembershipId, "SCAN_TARGET", { key: uuid() })).rejects.toThrow(/warehouse_task_progress_save_key_chk/);
    await expect(ins(A.memberMembershipId, "CONFIRM", { loc: R01 })).rejects.toThrow(/warehouse_task_progress_quantity_chk/);
    await expect(ins(A.memberMembershipId, "ENTER_QUANTITY")).rejects.toThrow(/warehouse_task_progress_location_chk/);
    await expect(ins(A.memberMembershipId, "DONE", { loc: R01, qty: "1" })).rejects.toThrow(/violates check constraint "warehouse_task_progress_(step|quantity)_chk"/); // beyaz liste dışı adım
    expect(await progressRows(job.taskId)).toHaveLength(0);

    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    // Her ifade kendi transaction'ında (reddedilen ifade transaction'ı iptal eder).
    for (const [sqlText, params] of [
      ["UPDATE public.warehouse_task_progress SET task_id = $2 WHERE task_id = $1", [job.taskId, uuid()]],
      ["UPDATE public.warehouse_task_progress SET tenant_id = $2 WHERE task_id = $1", [job.taskId, B.tenantId]],
      ["UPDATE public.warehouse_task_progress SET membership_id = membership_id, created_at = now() WHERE task_id = $1", [job.taskId]],
      ["TRUNCATE public.warehouse_task_progress", []],
    ] as const) {
      await expect(asApp(A.tenantId, (c) => c.query(sqlText, [...params])), sqlText).rejects.toThrow(/permission denied/);
    }
    const roles = await q<{ rolname: string; any: boolean }>(
      `SELECT rolname, has_table_privilege(rolname, 'public.warehouse_task_progress', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
              OR has_any_column_privilege(rolname, 'public.warehouse_task_progress', 'SELECT, INSERT, UPDATE, REFERENCES') AS any
         FROM pg_roles WHERE rolname LIKE 'wms\\_%' AND rolname <> 'wms_app' AND NOT rolsuper
          AND oid <> (SELECT relowner FROM pg_class WHERE oid = 'public.warehouse_task_progress'::regclass) ORDER BY 1`,
    );
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter((r) => r.any)).toEqual([]);
    const pub = await q("SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid = 'public.warehouse_task_progress'::regclass AND a.grantee = 0");
    expect(pub).toHaveLength(0);
  });
});

describe("IDOR: kimlikler istemciden alınmaz", () => {
  it("fazla alan (membershipId/locationId/itemId ve snake_case) VALIDATION_FAILED; başkası adına/istemci kaynaklı lokasyon-ürünle yazım yok", async () => {
    const job = await mkJob();
    const decoy = await mkJob(); // başka ürünün barkodu
    await assign(job.taskId, A.memberMembershipId);
    const c0 = await counts();
    const extras: Record<string, unknown>[] = [
      { membershipId: p2MembershipId },
      { membership_id: p2MembershipId },
      { locationId: R02 },
      { location_id: R02 },
      { itemId: A.itemTwoId },
      { item_id: A.itemTwoId },
      { tenantId: B.tenantId },
    ];
    for (const extra of extras) {
      const e1 = await failure(recordTaskStep(picker1(), { taskId: job.taskId, step: "SCAN_ITEM", scannedCode: job.barcode, ...extra }));
      expect(e1.code, JSON.stringify(extra)).toBe("VALIDATION_FAILED");
      expect((await failure(getTaskProgress(picker1(), { taskId: job.taskId, ...extra } as never))).code).toBe("VALIDATION_FAILED");
      expect((await failure(beginSave(picker1(), { taskId: job.taskId, ...extra } as never))).code).toBe("VALIDATION_FAILED");
    }
    expect(await progressRows(job.taskId)).toHaveLength(0);
    // Ürün adımında lokasyon alanı, raf adımında ürün alanı, miktar adımında kod alanı: hepsi reddedilir.
    expect((await failure(recordTaskStep(picker1(), { taskId: job.taskId, step: "ENTER_QUANTITY", quantity: "10", scannedCode: "x" }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(recordTaskStep(picker1(), { taskId: job.taskId, step: "SCAN_ITEM", scannedCode: job.barcode, quantity: "10" }))).code).toBe("VALIDATION_FAILED");
    // Başka ürünün barkodu okutulur ve "kimlik" gibi davranamaz: çözüm sunucuda, görevin ürünüyle eşleşmeli.
    expect(rejected(await step(job.taskId, "SCAN_ITEM", decoy.barcode)).reason).toBe("WRONG_ITEM");
    // Başka tenant'ın raf kodu görevin deposunda çözülmez (A'da yok): bilinmeyen kod.
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    const bLoc = (await q<{ code: string }>("SELECT code FROM public.locations WHERE tenant_id=$1 AND kind='STORAGE' LIMIT 1", [B.tenantId]))[0]?.code;
    if (bLoc !== undefined && !(await q("SELECT 1 FROM public.locations WHERE tenant_id=$1 AND warehouse_id=$2 AND code=$3", [A.tenantId, A.warehouseId, bLoc])).length) {
      expect(rejected(await step(job.taskId, "SCAN_TARGET", bLoc)).reason).toBe("UNKNOWN_CODE");
    }
    expect(await counts()).toEqual(c0); // reddedilen/yalnız-ilerleme çağrıları stok/defter/görev/audit satırlarına dokunmadı
  });
});

describe("atama değişimi ve görev sonlanması: eski ilerleme dönmez (A-293-4)", () => {
  it("A → B: yeni atanan baştan başlar, eskisi FORBIDDEN; B → A geri atanınca eski ilerleme DÖNMEZ", async () => {
    const job = await mkJob();
    await assign(job.taskId, A.memberMembershipId);
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    accepted(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(R01)));
    expect((await getTaskProgress(picker1(), { taskId: job.taskId })).step).toBe("ENTER_QUANTITY");

    await assign(job.taskId, p2MembershipId); // P1 → P2
    expect((await failure(getTaskProgress(picker1(), { taskId: job.taskId }))).code).toBe("FORBIDDEN");
    expect((await failure(qty(job.taskId, "10", picker1()))).code).toBe("FORBIDDEN"); // eski atanan artık yazamaz
    const v2 = await getTaskProgress(picker2(), { taskId: job.taskId });
    expect(v2).toMatchObject({ step: "SCAN_ITEM", targetLocationCode: null, quantity: null }); // yeni atanan baştan başlar (eski satır okunmaz)

    await assign(job.taskId, A.memberMembershipId); // P2 → P1: P2 hiçbir şey yazmadı; eski satır (P1'in) sürüm farkıyla geçersiz
    const back = await getTaskProgress(picker1(), { taskId: job.taskId });
    expect(back).toMatchObject({ step: "SCAN_ITEM", targetLocationCode: null });
    // Yazım eski satırı siler ve baştan başlar.
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    const rows = await progressRows(job.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: "SCAN_TARGET", membership_id: A.memberMembershipId, location_id: null });
    expect(Number(rows[0]?.task_version)).toBe((await taskRow(job.taskId)).version);
  });

  it("görev CANCELLED olunca ilerleme yazılamaz/görünmez; kayıt anahtarı olsa da kaydet reddedilir; nextTaskFor eski satırı siler", async () => {
    const job = await mkJob();
    await assign(job.taskId, A.memberMembershipId);
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    accepted(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(R01)));
    accepted(await qty(job.taskId, "10"));
    await beginSave(picker1(), { taskId: job.taskId });
    const v = (await taskRow(job.taskId)).version;
    await ops.cancelTask(owner(), { taskId: job.taskId, expectedVersion: v, reason: "T293 iptal" });
    expect(await getTaskProgress(picker1(), { taskId: job.taskId })).toMatchObject({ taskStatus: "CANCELLED", step: null, saveClientKey: null });
    expect(codeOf(await failure(step(job.taskId, "SCAN_ITEM", job.barcode)))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(savePutawayTask(stockP(picker1(), null), { taskId: job.taskId })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect((await taskRow(job.taskId)).status).toBe("CANCELLED");
    expect(await progressRows(job.taskId)).toHaveLength(1); // henüz silinmedi
    await nextTaskFor(picker1(), { afterTaskId: job.taskId });
    expect(await progressRows(job.taskId)).toHaveLength(0); // ADR-025: bitmiş görevin satırı silinir
  });

  it("expectedVersion (görev sürümü) uyuşmazsa VERSION_CONFLICT; ilerleme yazılmaz", async () => {
    const job = await mkJob();
    await assign(job.taskId, A.memberMembershipId);
    const v = (await taskRow(job.taskId)).version;
    expect((await failure(step(job.taskId, "SCAN_ITEM", job.barcode, picker1(), { expectedVersion: v + 1 }))).code).toBe("VERSION_CONFLICT");
    expect(await progressRows(job.taskId)).toHaveLength(0);
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode, picker1(), { expectedVersion: v }));
  });
});

describe("ilerleme yazımı stok/defter/görev satırlarını değiştirmez (AC-20 deseni)", () => {
  it("tüm adımlar + yanlış okutmalar + anahtar yazımı: stok, defter, belge, idempotency, audit ve görev satırları birebir aynı", async () => {
    const job = await mkJob();
    await assign(job.taskId, A.memberMembershipId);
    const c0 = await counts();
    accepted(await step(job.taskId, "SCAN_ITEM", job.barcode));
    rejected(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(STAGE)));
    accepted(await step(job.taskId, "SCAN_TARGET", await codeOfLoc(R01)));
    rejected(await qty(job.taskId, "3"));
    accepted(await qty(job.taskId, "10"));
    await getTaskProgress(picker1(), { taskId: job.taskId });
    const k = await beginSave(picker1(), { taskId: job.taskId }); // anahtarı yazar; stok komutu YOK
    expect(k.progress.step).toBe("SAVING");
    expect(await counts()).toEqual(c0); // görev sürümü/durumu dahil (tasks_state)
    await resetTaskProgress(picker1(), { taskId: job.taskId });
    expect(await counts()).toEqual(c0);
  });
});

describe("sıradaki görev (A-293-2)", () => {
  it("(ikinci PICKER, temiz kuyruk) bana atanmış, aynı depo, önce aynı grup, sonra created_at; OPEN görev otomatik üstlenilmez; DONE/başkasının görevi dönmez", async () => {
    const [t1, t2, t3] = await Promise.all([mkJob(), mkJob(), mkJob()]);
    const open = await mkJob(); // OPEN kalır
    // t1 DONE olacak; t2 başka grupta (eski), t3 t1 ile aynı grupta (yeni).
    const group = uuid();
    await q("UPDATE public.warehouse_tasks SET group_id = $2 WHERE id = ANY($1::uuid[])", [[(t1 as Job).taskId, (t3 as Job).taskId], group]);
    for (const j of [t1, t2, t3] as Job[]) await assign(j.taskId, p2MembershipId);
    await assign((open as Job).taskId, A.memberMembershipId); // başkasının görevi

    // t1'i rehberli akışla bitir.
    const j1 = t1 as Job;
    accepted(await step(j1.taskId, "SCAN_ITEM", j1.barcode, picker2()));
    accepted(await step(j1.taskId, "SCAN_TARGET", await codeOfLoc(R01), picker2()));
    accepted(await qty(j1.taskId, "10", picker2()));
    await savePutawayTask(stockP(picker2(), null), { taskId: j1.taskId });
    expect((await taskRow(j1.taskId)).status).toBe("DONE");

    const next = await nextTaskFor(picker2(), { afterTaskId: j1.taskId });
    expect(next?.id).toBe((t3 as Job).taskId); // aynı grup önce (t2 daha eski olsa da)
    expect(next).toMatchObject({ kind: "PUTAWAY", warehouseId: A.warehouseId, groupId: group });
    expect(await progressRows(j1.taskId)).toHaveLength(0); // DONE görevin satırı silindi

    // t3'ü bitir → sıradaki t2 (grup kalmadı; created_at sırası); sonra yok.
    const j3 = t3 as Job;
    accepted(await step(j3.taskId, "SCAN_ITEM", j3.barcode, picker2()));
    accepted(await step(j3.taskId, "SCAN_TARGET", await codeOfLoc(R01), picker2()));
    accepted(await qty(j3.taskId, "10", picker2()));
    await savePutawayTask(stockP(picker2(), null), { taskId: j3.taskId });
    expect((await nextTaskFor(picker2(), { afterTaskId: j3.taskId }))?.id).toBe((t2 as Job).taskId);
    const j2 = t2 as Job;
    accepted(await step(j2.taskId, "SCAN_ITEM", j2.barcode, picker2()));
    accepted(await step(j2.taskId, "SCAN_TARGET", await codeOfLoc(R01), picker2()));
    accepted(await qty(j2.taskId, "10", picker2()));
    await savePutawayTask(stockP(picker2(), null), { taskId: j2.taskId });
    expect(await nextTaskFor(picker2(), { afterTaskId: j2.taskId })).toBeNull(); // OPEN ve başkasının görevi dönmez; otomatik üstlenme yok
    expect((await taskRow((open as Job).taskId)).status).toBe("ASSIGNED");
    expect((await failure(nextTaskFor(picker2(), { afterTaskId: j2.taskId, membershipId: p2MembershipId } as never))).code).toBe("VALIDATION_FAILED"); // strict
  });
});

describe("migration 0026: up → down → up", () => {
  it("yeni veritabanında 0026 geri alınır (tablo kalkar) ve yeniden uygulanır; RLS/politika/yetki doğrulaması migration içinde koşar", async () => {
    const name = `wms_tp_${randomBytes(5).toString("hex")}`;
    await q(`CREATE DATABASE ${name}`);
    scratchDbs.push(name);
    const u = new URL(env.databaseUrlDirect);
    u.pathname = `/${name}`;
    const url = u.toString();
    const versions = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql")).map((f) => f.slice(0, 4)).sort();
    const idx = versions.indexOf("0026");
    expect(idx).toBeGreaterThan(0);
    const previous = versions[idx - 1] as string;
    const first = await migrateUp({ url });
    expect(first.applied).toContain("0026");
    const exists = async (): Promise<boolean> => {
      const c = new pg.Client({ connectionString: url });
      c.on("error", () => undefined);
      await c.connect();
      try {
        return (await c.query("SELECT to_regclass('public.warehouse_task_progress') IS NOT NULL AS e")).rows[0].e as boolean;
      } finally {
        await c.end();
      }
    };
    expect(await exists()).toBe(true);
    const down = await migrateDown({ url, to: previous, wmsEnv: "ci" });
    expect(down.reverted).toContain("0026");
    expect(await exists()).toBe(false);
    const again = await migrateUp({ url });
    expect(again.applied).toEqual(["0026", ...versions.slice(idx + 1)]);
    expect(await exists()).toBe(true);
  }, 300_000);
});
