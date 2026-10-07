// T-307: toplama görevlendirmesi, toplama ve "ürün bulunamadı" (ADR-021 §3/§6, ADR-009; 16 Temel kurallar 3 ve 9, Senaryo A adım 6, Senaryo D adım 6–7).
// GERÇEK roller (wms_app, pooler); fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile. Beklenen değerler docs/spec/16-stock-effects.md'den birebir; her adımdan
// sonra tüm sütunlar doğrulanır (defter toplamı = fiziksel, Σ ACTIVE rezervasyon = Σ reserved). Fikstürler sentetiktir (G-09). Bağımsız kanıt (AC-31/AC-40) T-317'dedir.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import * as ops from "../../../packages/domain/src/operations/index.ts";
import {
  approveQuality,
  cancelOrderLine,
  confirmPick,
  createInboundReceipt,
  createPickAssignment,
  createSalesOrder,
  openInboundReceipt,
  putaway,
  receiveGoods,
  reserveOrder,
} from "../../../packages/domain/src/operations/index.ts";
import { approveDocument, createStockDocument, postDocument, type DocumentLineInput, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

const NO_WAIT = { sleep: async () => undefined } as const;
/** Yeniden deneme YOK: 40P01/40001 sessizce yeniden denenip test yeşile dönmesin. */
const ONCE = { sleep: async () => undefined, maxAttempts: 1 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const callP = (world: TenantWorld, userId: string, key: string | null, extra: Partial<StockDocCallParams>): StockDocCallParams => ({
  db: app,
  principal: { userId, mfaVerified: true },
  tenantSlug: world.slug,
  clientKey: key,
  retry: NO_WAIT,
  ...extra,
});
const ownerP = (key: string | null = uuid(), extra: Partial<StockDocCallParams> = {}): StockDocCallParams => callP(A, A.ownerUserId, key, extra);
const pickerP = (key: string = uuid(), extra: Partial<StockDocCallParams> = {}): StockDocCallParams => callP(A, A.memberUserId, key, extra);
const ownerBP = (key: string = uuid()): StockDocCallParams => callP(B, B.ownerUserId, key, {});

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

// --- fikstürler ---------------------------------------------------------------------------------------------------------
async function mkItem(scale = 0): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T307 urun',$4,'NONE',$5)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId, scale,
  ]);
  return id;
}
async function mkLoc(kind: "RECEIVING" | "STORAGE" | "STAGING" = "STORAGE", code = `L-${hex(10)}`, warehouseId = A.warehouseId): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,'T307 lok',0,$5)", [
    A.tenantId, id, warehouseId, code, kind,
  ]);
  return id;
}
const ln = (item: string, qty: string, extra: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  itemId: item, unitId: A.unitId, quantity: qty, conversionFactor: "1", baseQuantity: qty, ...extra,
});
async function postDoc(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[], warehouseId = A.warehouseId): Promise<void> {
  const c = await createStockDocument(ownerP(), { kind, warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id = $1", [id]))[0] as { version: number };
  await postDocument(ownerP(), { documentId: id, expectedVersion: v.version });
}
const stockIn = (item: string, loc: string, qty: string, status: "AVAILABLE" | "QUARANTINE" | "DAMAGED" = "AVAILABLE", warehouseId = A.warehouseId) =>
  postDoc("STOCK_IN", [ln(item, qty, { targetLocationId: loc, stockStatus: status })], warehouseId);

interface Order {
  id: string;
  lineIds: string[];
  number: string;
}
async function mkOrder(lines: { item: string; qty: string }[], extra: { number?: string } = {}): Promise<Order> {
  const r = await createSalesOrder(ownerP(), {
    ...(extra.number === undefined ? {} : { number: extra.number }),
    customerRef: "T307-MUS",
    lines: lines.map((l) => ({ itemId: l.item, unitId: A.unitId, quantity: l.qty })),
  });
  const rows = await q<{ id: string }>("SELECT id FROM public.sales_order_lines WHERE order_id = $1 ORDER BY line_no", [r.documentId]);
  return { id: r.documentId as string, lineIds: rows.map((x) => x.id), number: r.documentNumber as string };
}
const lineRow = async (id: string) =>
  (await q<{ req: string; shp: string; ret: string; can: string }>(
    "SELECT requested_quantity::text AS req, shipped_quantity::text AS shp, returned_quantity::text AS ret, cancelled_quantity::text AS can FROM public.sales_order_lines WHERE id = $1", [id],
  ))[0] as { req: string; shp: string; ret: string; can: string };
/** S1 istenen / sevk / açık (+ iptal, iade). */
async function lineTriple(id: string): Promise<{ istenen: string; sevk: string; acik: string; iptal: string; iade: string }> {
  const r = await lineRow(id);
  return { istenen: n(r.req), sevk: n(r.shp), acik: n(Number(r.req) - Number(r.shp) - Number(r.can)), iptal: n(r.can), iade: n(r.ret) };
}
const reservationsOf = (lineId: string) =>
  q<{ id: string; status: string; quantity: string; location_id: string; stock_status: string; order_line_id: string; document_line_id: string | null }>(
    `SELECT r.id, r.status, r.quantity::text AS quantity, d.location_id, d.stock_status, r.order_line_id, r.document_line_id
       FROM public.reservations r JOIN public.stock_dimensions d ON d.tenant_id = r.tenant_id AND d.id = r.stock_dimension_id
      WHERE r.tenant_id = $1 AND r.order_line_id = $2 ORDER BY r.created_at, r.id`, [A.tenantId, lineId]);
const activeSum = async (lineId: string): Promise<string> =>
  n((await q<{ s: string }>("SELECT COALESCE(sum(quantity),0)::text AS s FROM public.reservations WHERE tenant_id=$1 AND order_line_id=$2 AND status='ACTIVE'", [A.tenantId, lineId]))[0]?.s as string);
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
async function audits(action: string, entityId: string): Promise<number> {
  return (await q("SELECT 1 FROM public.audit_logs WHERE tenant_id=$1 AND action=$2 AND entity_id=$3", [A.tenantId, action, entityId])).length;
}
/** Σ ACTIVE rezervasyon = Σ reserved_quantity (DB değişmezi). */
async function reservedMatches(item: string): Promise<void> {
  const r = await q<{ s: string }>(
    `SELECT COALESCE(sum(r.quantity),0)::text AS s FROM public.reservations r JOIN public.stock_dimensions d ON d.tenant_id=r.tenant_id AND d.id=r.stock_dimension_id
      WHERE r.tenant_id=$1 AND d.item_id=$2 AND r.status='ACTIVE'`, [A.tenantId, item]);
  expect(n(r[0]?.s as string), "Σ ACTIVE rezervasyon = Σ reserved_quantity").toBe(await reservedOf(item));
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
  await reservedMatches(item);
}

async function setQc(on: boolean): Promise<void> {
  await q("UPDATE public.tenant_settings SET receiving_qc_enabled = $2 WHERE tenant_id = $1", [A.tenantId, on]);
}
/** Senaryo A/D adım 1–3: kabul → kalite onayı → yerleştirme (T-305 komutları). */
async function receiveToShelf(lines: { item: string; expected: string; received: string; damaged?: string; shelf: string; putQty: string }[], kabul: string): Promise<void> {
  const c = await createInboundReceipt(ownerP(), {
    warehouseId: A.warehouseId,
    supplierRef: "T307-TED",
    lines: lines.map((l) => ({ itemId: l.item, unitId: A.unitId, expectedQuantity: l.expected })),
  });
  const receiptId = c.documentId as string;
  await openInboundReceipt(ownerP(), { receiptId, expectedVersion: 1 });
  const rl = await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id = $1 ORDER BY line_no", [receiptId]);
  await receiveGoods(pickerP(), {
    receiptId,
    lines: lines.map((l, i) => ({ lineId: rl[i]?.id as string, received: l.received, ...(l.damaged === undefined ? {} : { damaged: l.damaged }), locationId: kabul })),
  });
  await approveQuality(ownerP(), { receiptId });
  const tasks = await q<{ id: string; item_id: string }>("SELECT id, item_id FROM public.warehouse_tasks WHERE tenant_id=$1 AND source_id=$2 AND kind='PUTAWAY'", [A.tenantId, receiptId]);
  for (const l of lines) {
    const t = tasks.find((x) => x.item_id === l.item) as { id: string };
    await putaway(pickerP(), { taskId: t.id, sourceLocationId: kabul, targetLocationId: l.shelf, itemId: l.item, quantity: l.putQty });
  }
}


// --- T-307 yardımcıları -------------------------------------------------------------------------------------------------------
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
    await new Promise((r) => setTimeout(r, 10));
  }
}
const barcodes = new Map<string, string>();
/** Ürünün temel birim barkodu (T-208 `resolveBarcode` bunu çözer). */
async function bcOf(item: string): Promise<string> {
  const have = barcodes.get(item);
  if (have !== undefined) return have;
  const code = `BC${hex(12)}`;
  await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode, quantity) VALUES ($1,$2,$3,$4,NULL)", [A.tenantId, item, A.unitId, code]);
  barcodes.set(item, code);
  return code;
}
const codeOfLoc = async (loc: string): Promise<string> => (await q<{ code: string }>("SELECT code FROM public.locations WHERE id = $1", [loc]))[0]?.code as string;
interface TaskR { id: string; kind: string; status: string; quantity: string | null; location_id: string | null; item_id: string | null; source_line_id: string | null; assigned_membership_id: string | null; group_id: string | null; source_id: string | null }
const taskR = async (id: string): Promise<TaskR> =>
  (await q<TaskR>("SELECT id, kind, status, quantity::text AS quantity, location_id, item_id, source_line_id, assigned_membership_id, group_id, source_id FROM public.warehouse_tasks WHERE id = $1", [id]))[0] as TaskR;
const tasksByKind = (kind: string, loc: string) =>
  q<TaskR>("SELECT id, kind, status, quantity::text AS quantity, location_id, item_id, source_line_id, assigned_membership_id, group_id, source_id FROM public.warehouse_tasks WHERE tenant_id=$1 AND kind=$2 AND location_id=$3 ORDER BY created_at, id", [A.tenantId, kind, loc]);
const pickBlocked = async (loc: string): Promise<boolean> => (await q<{ p: boolean }>("SELECT pick_blocked AS p FROM public.locations WHERE id = $1", [loc]))[0]?.p as boolean;
const shipmentRows = async (item: string): Promise<number> =>
  Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.stock_ledger WHERE tenant_id=$1 AND item_id=$2 AND reason='SHIPMENT'", [A.tenantId, item]))[0]?.c);
const idemRows = async (commandType: string): Promise<number> =>
  Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.idempotency_records WHERE tenant_id=$1 AND command_type=$2", [A.tenantId, commandType]))[0]?.c);
async function doPick(taskId: string, found: string, loc: string, item: string, p: StockDocCallParams = pickerP()) {
  return confirmPick(p, { taskId, foundQuantity: found, scannedLocationCode: await codeOfLoc(loc), scannedItemBarcode: await bcOf(item) });
}
async function assign(orderIds: string[], extra: Partial<Parameters<typeof createPickAssignment>[1]> = {}, p: StockDocCallParams = ownerP()) {
  return createPickAssignment(p, { orderIds, ...extra });
}
/** Hedef STAGING = deponun kodu EN KÜÇÜK ACTIVE STAGING lokasyonu (A-307-1). Aynı depoyu paylaşan testlerde son oluşturulan en küçük koda sahip olsun diye kod azalan sayaçtan üretilir. */
let stagingSeq = 9_999_999;
const mkSevk = (): Promise<string> => mkLoc("STAGING", `0S${String(--stagingSeq).padStart(7, "0")}`);
const num = (p: string): string => `${p}-${hex(8)}`;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A307");
  B = await seedWorld(adm, reg, "B307");
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("dışa açık yüzey", () => {
  it("createPickAssignment/confirmPick açık; reallocateOrderLine, planPickTasks, createTasks, completeTask iç yardımcıdır", () => {
    expect(Object.keys(ops)).toEqual(expect.arrayContaining(["createPickAssignment", "confirmPick"]));
    for (const hidden of ["reallocateOrderLine", "planPickTasks", "pickShortfall", "scaledBaseQuantity", "createTasks", "completeTask", "allocateInTx", "releaseSelected"]) {
      expect(Object.keys(ops)).not.toContain(hidden);
    }
  });
});

describe("@AC-31 Senaryo A adım 6 (X, KABUL, R-01, SEVK; S1 = 4): görevlendirme + toplama", () => {
  it("rezervasyon 4 → görev → toplama 4: R-01 6, SEVK 4, fiziksel 10, rezerve 4, kullanılabilir 6; rezervasyon SEVK·KUL'a taşındı; görev DONE", async () => {
    await setQc(true);
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const SEVK = await mkSevk();
    const cols: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], kul: [KABUL, "AVAILABLE"], r01: [R01, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    await receiveToShelf([{ item: X, expected: "10", received: "10", shelf: R01, putQty: "10" }], KABUL);
    const s1 = await mkOrder([{ item: X, qty: "4" }]);
    const L = s1.lineIds[0] as string;
    await reserveOrder(ownerP(), { orderId: s1.id });
    await expectRow(X, cols, { r01: 10, fiz: 10, rez: 4, kullan: 6 }, "adım 5");
    const ledger5 = await ledgerCount(X);

    // Görevlendirme: stok etkisi YOK; tek PICK görevi (kaynak R-01, miktar 4), ortak group_id
    const a = await assign([s1.id]);
    expect(a.lines).toEqual([{ lineId: L, lineNo: 1, quantity: n(4) }]);
    expect(a.taskIds).toHaveLength(1);
    const t = await taskR(a.taskIds[0] as string);
    expect(t).toMatchObject({ kind: "PICK", status: "OPEN", quantity: n(4), location_id: R01, item_id: X, source_line_id: L, group_id: a.groupId, source_id: s1.id });
    await expectRow(X, cols, { r01: 10, fiz: 10, rez: 4, kullan: 6 }, "görevlendirme sonrası (stok etkisi yok)");
    expect(await ledgerCount(X)).toBe(ledger5);
    expect(await audits("pick_assignment.created", a.groupId as string)).toBe(1);

    // 6. Toplama 4 → SEVK
    const key = uuid();
    const r6 = await doPick(t.id, "4", R01, X, pickerP(key));
    expect(r6.status).toBe("POSTED");
    expect(r6.notFound).toBeUndefined();
    expect(r6.reallocation).toBeUndefined();
    expect(r6.foundQuantity).toBe(n(4));
    await expectRow(X, cols, { r01: 6, sevk: 4, fiz: 10, rez: 4, kullan: 6 }, "adım 6");
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(0), acik: n(4), iptal: n(0), iade: n(0) });
    expect((await reservationsOf(L)).filter((r) => r.status === "ACTIVE").map((r) => [r.location_id, r.stock_status, r.quantity])).toEqual([[SEVK, "AVAILABLE", n(4)]]);
    expect(await ledgerCount(X)).toBe(ledger5 + 2);
    const rows = await q<{ quantity: string; reason: string }>("SELECT l.quantity::text AS quantity, l.reason FROM public.stock_ledger l WHERE l.tenant_id=$1 AND l.document_id=$2 ORDER BY l.quantity", [A.tenantId, r6.documentId]);
    expect(rows.map((r) => [n(r.quantity), r.reason])).toEqual([[n(-4), "MOVE"], [n(4), "MOVE"]]);
    expect(await taskR(t.id)).toMatchObject({ status: "DONE" });
    expect(await pickBlocked(R01)).toBe(false);
    expect(await shipmentRows(X)).toBe(0);
    expect(await audits("warehouse_task.completed", t.id)).toBe(1);
    // Aynı anahtar: saklı sonuç, ikinci hareket yok.
    const again = await confirmPick(pickerP(key), { taskId: t.id, foundQuantity: "4", scannedLocationCode: await codeOfLoc(R01), scannedItemBarcode: await bcOf(X) });
    expect(again.replayed).toBe(true);
    expect(await ledgerCount(X)).toBe(ledger5 + 2);
    // Aynı görev farklı anahtarla: DOCUMENT_STATE; müşteri çıkışı (SHIPMENT) yok, stok değişmez.
    expect(codeOf(await failure(doPick(t.id, "4", R01, X)))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    await expectRow(X, cols, { r01: 6, sevk: 4, fiz: 10, rez: 4, kullan: 6 }, "ikinci onay sonrası");
    expect(await shipmentRows(X)).toBe(0);
    // Toplanmış (STORAGE dışı) rezervasyon için yeni görev üretilmez; satır listelenir (0).
    const a2 = await assign([s1.id]);
    expect(a2.lines).toEqual([{ lineId: L, lineNo: 1, quantity: n(0) }]);
    expect(a2.taskIds).toEqual([]);
  }, 180_000);
});

describe("@AC-40 Senaryo D adım 6–7 (X 18, Y 9 + 1 hasarlı; S1 X5 · S2 X6+Y3 · S3 Y4)", () => {
  it("toplama S1+S2 (X 11, Y 3) → SEVK; toplama S3: 4 istenir, 3 bulunur: R-02 pick_blocked + COUNT görevi, yeniden tahsis: uygun Y yok", async () => {
    await setQc(true);
    const X = await mkItem();
    const Y = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE", `A1-${hex(6)}`);
    const R02 = await mkLoc("STORAGE", `A2-${hex(6)}`);
    const SEVK = await mkSevk();
    const colsX: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], kul: [KABUL, "AVAILABLE"], r01: [R01, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    const colsY: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], kul: [KABUL, "AVAILABLE"], dmg: [KABUL, "DAMAGED"], r02: [R02, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    await receiveToShelf(
      [
        { item: X, expected: "20", received: "18", shelf: R01, putQty: "18" },
        { item: Y, expected: "10", received: "10", damaged: "1", shelf: R02, putQty: "9" },
      ],
      KABUL,
    );
    const s1 = await mkOrder([{ item: X, qty: "5" }], { number: num("S1") });
    const s2 = await mkOrder([{ item: X, qty: "6" }, { item: Y, qty: "3" }], { number: num("S2") });
    const s3 = await mkOrder([{ item: Y, qty: "4" }], { number: num("S3") });
    for (const o of [s1, s2, s3]) await reserveOrder(ownerP(), { orderId: o.id });
    await expectRow(X, colsX, { r01: 18, fiz: 18, rez: 11, kullan: 7 }, "X adım 5");
    await expectRow(Y, colsY, { dmg: 1, r02: 9, fiz: 10, rez: 7, kullan: 2 }, "Y adım 5");
    const lx = await ledgerCount(X);
    const ly = await ledgerCount(Y);

    // 6. Görevlendirme S1+S2: lokasyon kodu sırası (R-01: S1 X5, S2 X6; sonra R-02: S2 Y3); stok etkisi yok
    const a = await assign([s2.id, s1.id]);
    expect(a.taskIds).toHaveLength(3);
    const ts = await Promise.all(a.taskIds.map((id) => taskR(id)));
    expect(ts.map((t) => [t.location_id, t.item_id, t.quantity, t.source_line_id])).toEqual([
      [R01, X, n(5), s1.lineIds[0]],
      [R01, X, n(6), s2.lineIds[0]],
      [R02, Y, n(3), s2.lineIds[1]],
    ]);
    expect(new Set(ts.map((t) => t.group_id))).toEqual(new Set([a.groupId]));
    await expectRow(X, colsX, { r01: 18, fiz: 18, rez: 11, kullan: 7 }, "X görevlendirme sonrası");
    expect(await ledgerCount(X)).toBe(lx);

    await doPick((ts[0] as TaskR).id, "5", R01, X);
    await expectRow(X, colsX, { r01: 13, sevk: 5, fiz: 18, rez: 11, kullan: 7 }, "X S1 toplandı");
    await doPick((ts[1] as TaskR).id, "6", R01, X);
    await expectRow(X, colsX, { r01: 7, sevk: 11, fiz: 18, rez: 11, kullan: 7 }, "X adım 6");
    await expectRow(Y, colsY, { dmg: 1, r02: 9, fiz: 10, rez: 7, kullan: 2 }, "Y S2 Y henüz toplanmadı");
    await doPick((ts[2] as TaskR).id, "3", R02, Y);
    await expectRow(Y, colsY, { dmg: 1, r02: 6, sevk: 3, fiz: 10, rez: 7, kullan: 2 }, "Y adım 6");
    expect(await ledgerCount(X)).toBe(lx + 4);
    expect(await ledgerCount(Y)).toBe(ly + 2);
    expect((await q<{ s: string }>("SELECT status AS s FROM public.warehouse_tasks WHERE group_id=$1 ORDER BY id", [a.groupId])).map((r) => r.s)).toEqual(["DONE", "DONE", "DONE"]);

    // 7. S3: Y 4 istenir, 3 bulunur, 1 "bulunamadı"
    const a3 = await assign([s3.id]);
    expect(a3.taskIds).toHaveLength(1);
    const t3 = await taskR(a3.taskIds[0] as string);
    expect(t3).toMatchObject({ location_id: R02, item_id: Y, quantity: n(4) });
    const r7 = await doPick(t3.id, "3", R02, Y);
    await expectRow(Y, colsY, { dmg: 1, r02: 3, sevk: 6, fiz: 10, rez: 6, kullan: 0 }, "Y adım 7");
    await expectRow(X, colsX, { r01: 7, sevk: 11, fiz: 18, rez: 11, kullan: 7 }, "X adım 7");
    expect(await ledgerCount(Y)).toBe(ly + 4); // yalnız −3/+3; eksik için defter satırı YOK (kural 9)
    expect(await ledgerCount(X)).toBe(lx + 4);
    expect(await pickBlocked(R02)).toBe(true);
    expect(await pickBlocked(R01)).toBe(false);
    const counts = await tasksByKind("COUNT", R02);
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ status: "OPEN", assigned_membership_id: null });
    expect(r7.notFound).toEqual({ shortQuantity: n(1), locationId: R02, countTaskId: counts[0]?.id });
    expect(r7.foundQuantity).toBe(n(3));
    expect(r7.reallocation).toMatchObject({ status: "NONE", quantity: n(0) }); // uygun Y yok
    // S3 satırı: 3 tahsisli (SEVK) + 1 rezervesiz; S2'nin Y3'ü SEVK'te
    const L3 = s3.lineIds[0] as string;
    expect(await activeSum(L3)).toBe(n(3));
    expect((await reservationsOf(L3)).filter((r) => r.status === "ACTIVE").map((r) => [r.location_id, r.quantity])).toEqual([[SEVK, n(3)]]);
    expect((await reservationsOf(L3)).filter((r) => r.status === "RELEASED").map((r) => [r.location_id, r.quantity])).toEqual([[R02, n(1)]]);
    expect(await lineTriple(L3)).toEqual({ istenen: n(4), sevk: n(0), acik: n(4), iptal: n(0), iade: n(0) });
    expect(await taskR(t3.id)).toMatchObject({ status: "DONE" });
    expect(await audits("pick.not_found", R02)).toBe(1);
    expect(await shipmentRows(Y)).toBe(0);
    // Yeniden tahsis ayrı komut/ayrı idempotency kaydı; ilk komut anahtarından türetilmemiş
    expect(await idemRows("sales_order.reallocate_line")).toBeGreaterThanOrEqual(1);
    // pick_blocked lokasyondan yeni tahsis önerilmez (kural 9): R-02'de 3 fiziksel var ama rezervesiz satır tahsis alamaz
    const re = await reserveOrder(ownerP(), { orderId: s3.id });
    expect(re.lines).toEqual([{ lineId: L3, lineNo: 1, quantity: n(0) }]);
  }, 240_000);
});

describe("okutma doğrulaması ve durum denetimleri", () => {
  it("yanlış lokasyon / yanlış ürün / bilinmeyen barkod → VALIDATION_FAILED/SCAN_MISMATCH; stok, görev, pick_blocked değişmez; doğru okutma sonra başarılı", async () => {
    const X = await mkItem();
    const Z = await mkItem();
    const R = await mkLoc("STORAGE");
    const R2 = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "5");
    const o = await mkOrder([{ item: X, qty: "3" }]);
    await reserveOrder(ownerP(), { orderId: o.id });
    const a = await assign([o.id]);
    const id = a.taskIds[0] as string;
    const ledger = await ledgerCount(X);
    const fiz = await physical(X);
    const bad = [
      { loc: await codeOfLoc(R2), bc: await bcOf(X) },
      { loc: await codeOfLoc(R), bc: await bcOf(Z) },
      { loc: await codeOfLoc(R), bc: `YOK${hex(8)}` },
    ];
    for (const s of bad) {
      expect(codeOf(await failure(confirmPick(pickerP(), { taskId: id, foundQuantity: "3", scannedLocationCode: s.loc, scannedItemBarcode: s.bc })))).toBe("VALIDATION_FAILED/SCAN_MISMATCH");
    }
    // Kısmi "bulunamadı" bile yanlış okutmada işlenmez
    expect(codeOf(await failure(confirmPick(pickerP(), { taskId: id, foundQuantity: "0", scannedLocationCode: await codeOfLoc(R2), scannedItemBarcode: await bcOf(X) })))).toBe("VALIDATION_FAILED/SCAN_MISMATCH");
    expect(await ledgerCount(X)).toBe(ledger);
    expect(await physical(X)).toBe(fiz);
    expect(await reservedOf(X)).toBe(n(3));
    expect(await pickBlocked(R)).toBe(false);
    expect(await taskR(id)).toMatchObject({ status: "OPEN" });
    expect((await tasksByKind("COUNT", R)).length).toBe(0);
    await doPick(id, "3", R, X);
    expect(await taskR(id)).toMatchObject({ status: "DONE" });
  }, 120_000);

  it("fazla toplama VALIDATION_FAILED; başkasına atanmış görev PICKER'a FORBIDDEN, yönetici tamamlar; izin: READ_ONLY FORBIDDEN", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "5");
    const o = await mkOrder([{ item: X, qty: "3" }]);
    await reserveOrder(ownerP(), { orderId: o.id });
    const other = await mkUser(adm, reg, "A307 other picker");
    const otherM = await mkMembership(adm, A.tenantId, other, { roles: ["PICKER"] });
    const a = await assign([o.id], { assigneeMembershipId: otherM });
    const id = a.taskIds[0] as string;
    expect(await taskR(id)).toMatchObject({ status: "ASSIGNED", assigned_membership_id: otherM });
    expect(await audits("warehouse_task.assigned", id)).toBe(1);
    expect(codeOf(await failure(doPick(id, "3", R, X)))).toBe("FORBIDDEN"); // memberUser'a atanmamış
    expect(codeOf(await failure(doPick(id, "4", R, X, ownerP())))).toBe("VALIDATION_FAILED"); // beklenen 3
    const ro = await mkUser(adm, reg, "A307 readonly");
    await mkMembership(adm, A.tenantId, ro, { roles: ["READ_ONLY"] });
    expect(codeOf(await failure(doPick(id, "3", R, X, callP(A, ro, uuid(), {}))))).toBe("FORBIDDEN");
    await doPick(id, "3", R, X, callP(A, other, uuid(), {}));
    expect(await taskR(id)).toMatchObject({ status: "DONE" });
    expect(await physical(X)).toBe(n(5));
  }, 120_000);

  it("görevlendirme: PICKER document.approve ister; tahsissiz satır görev üretmez (0); kapanmış sipariş DOCUMENT_STATE; atanan üye izni/kapsamı doğrulanır; başka tenant NOT_FOUND", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "2");
    const o = await mkOrder([{ item: X, qty: "5" }, { item: X, qty: "1" }]); // iki satır; stok 2: ilk satır 2 alır, ikincisi tahsissiz
    await reserveOrder(ownerP(), { orderId: o.id });
    expect(codeOf(await failure(assign([o.id], {}, pickerP())))).toBe("FORBIDDEN");
    const ro = await mkUser(adm, reg, "A307 ro2");
    const roM = await mkMembership(adm, A.tenantId, ro, { roles: ["READ_ONLY"] });
    expect(codeOf(await failure(assign([o.id], { assigneeMembershipId: roM })))).toBe("VALIDATION_FAILED"); // stock.post yok
    expect(await q("SELECT 1 FROM public.warehouse_tasks WHERE source_id=$1", [o.id])).toHaveLength(0); // başarısız komut görev bırakmaz
    const a = await assign([o.id]);
    expect(a.lines).toEqual([{ lineId: o.lineIds[0], lineNo: 1, quantity: n(2) }, { lineId: o.lineIds[1], lineNo: 2, quantity: n(0) }]);
    expect(a.taskIds).toHaveLength(1);
    const b = await assign([o.id]); // açık görev düşülür: yeni görev yok
    expect(b.taskIds).toEqual([]);
    expect((await tasksByKind("PICK", R)).filter((t) => t.source_id === o.id)).toHaveLength(1);
    expect(codeOf(await failure(createPickAssignment(ownerBP(), { orderIds: [o.id] })))).toBe("NOT_FOUND");
    await cancelOrderLine(ownerP(), { lineId: o.lineIds[0] as string, quantity: "5" });
    await cancelOrderLine(ownerP(), { lineId: o.lineIds[1] as string, quantity: "1" });
    expect(codeOf(await failure(assign([o.id])))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    // Rezervasyonu iptalle kalkan görev bayattır: onay DOCUMENT_STATE (stok değişmez).
    expect(codeOf(await failure(doPick(a.taskIds[0] as string, "2", R, X)))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await physical(X)).toBe(n(2));
  }, 120_000);

  it("sayımdaki lokasyondan toplama LOCATION_LOCKED; stok/görev değişmez", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "4");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    await reserveOrder(ownerP(), { orderId: o.id });
    const a = await assign([o.id]);
    const session = uuid();
    await q("INSERT INTO public.count_sessions (tenant_id, id, warehouse_id, started_by) VALUES ($1,$2,$3,$4)", [A.tenantId, session, A.warehouseId, A.ownerMembershipId]);
    await q("UPDATE public.location_count_locks SET status='COUNTING', count_session_id=$3, locked_at=now(), locked_by=$4 WHERE tenant_id=$1 AND location_id=$2", [A.tenantId, R, session, A.ownerMembershipId]);
    try {
      expect((await failure(doPick(a.taskIds[0] as string, "4", R, X))).code).toBe("LOCATION_LOCKED");
      expect((await failure(doPick(a.taskIds[0] as string, "1", R, X))).code).toBe("LOCATION_LOCKED"); // "bulunamadı" da kilitli lokasyonda yazılmaz
      expect(await physical(X)).toBe(n(4));
      expect(await taskR(a.taskIds[0] as string)).toMatchObject({ status: "OPEN" });
      expect(await pickBlocked(R)).toBe(false);
    } finally {
      await q("UPDATE public.location_count_locks SET status='IDLE', count_session_id=NULL, locked_at=NULL, locked_by=NULL WHERE tenant_id=$1 AND location_id=$2", [A.tenantId, R]);
    }
  }, 120_000);

  it("koli barkodu: okutulan birim katsayısı ile temel birime çevrilir (A-20): 1 koli = 6 adet; beklenenden fazla (2 koli = 12) reddedilir", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await q("INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1,$2,$3,6)", [A.tenantId, X, A.boxUnitId]);
    const box = `BX${hex(10)}`;
    await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode, quantity) VALUES ($1,$2,$3,$4,NULL)", [A.tenantId, X, A.boxUnitId, box]);
    await stockIn(X, R, "12");
    const o = await mkOrder([{ item: X, qty: "6" }]);
    await reserveOrder(ownerP(), { orderId: o.id });
    const a = await assign([o.id]);
    const code = await codeOfLoc(R);
    expect(codeOf(await failure(confirmPick(pickerP(), { taskId: a.taskIds[0] as string, foundQuantity: "2", scannedLocationCode: code, scannedItemBarcode: box })))).toBe("VALIDATION_FAILED"); // 12 > beklenen 6
    const r = await confirmPick(pickerP(), { taskId: a.taskIds[0] as string, foundQuantity: "1", scannedLocationCode: code, scannedItemBarcode: box });
    expect(r.foundQuantity).toBe(n(6));
    expect(r.notFound).toBeUndefined();
    expect(await bal(X, R, "AVAILABLE")).toBe(n(6));
  }, 120_000);
});

describe("ürün bulunamadı: yeniden tahsis, tekrar, eşzamanlılık", () => {
  it("yeniden tahsis: başka lokasyonda stok varsa eksik kısım oraya tahsis edilir (pick_blocked hariç); aynı anahtarla tekrar yeniden tahsisi TEKRARLAMAZ; hiç bulunamadı (0)", async () => {
    const X = await mkItem();
    const R1 = await mkLoc("STORAGE", `B1-${hex(6)}`);
    const R2 = await mkLoc("STORAGE", `B2-${hex(6)}`);
    const SEVK = await mkSevk();
    await stockIn(X, R1, "4");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    const L = o.lineIds[0] as string;
    await reserveOrder(ownerP(), { orderId: o.id });
    await stockIn(X, R2, "5"); // alternatif stok
    const a = await assign([o.id]);
    const key = uuid();
    const r = await doPick(a.taskIds[0] as string, "3", R1, X, pickerP(key));
    expect(r.notFound).toMatchObject({ shortQuantity: n(1), locationId: R1 });
    expect(r.reallocation).toMatchObject({ status: "ALLOCATED", quantity: n(1) });
    expect(r.reallocation?.reservationIds).toHaveLength(1);
    expect((await reservationsOf(L)).filter((x) => x.status === "ACTIVE").map((x) => [x.location_id, x.quantity]).sort()).toEqual([[R2, n(1)], [SEVK, n(3)]].sort());
    expect(await bal(X, R1, "AVAILABLE")).toBe(n(1)); // fiziksel yerinde (sayım onayına dek)
    expect(await pickBlocked(R1)).toBe(true);
    expect(await activeSum(L)).toBe(n(4));
    await reservedMatches(X);
    const before = await idemRows("sales_order.reallocate_line");
    const rep = await confirmPick(pickerP(key), { taskId: a.taskIds[0] as string, foundQuantity: "3", scannedLocationCode: await codeOfLoc(R1), scannedItemBarcode: await bcOf(X) });
    expect(rep.replayed).toBe(true);
    expect(rep.reallocation).toBeUndefined();
    expect(rep.notFound).toMatchObject({ shortQuantity: n(1) });
    expect(await idemRows("sales_order.reallocate_line")).toBe(before);
    expect(await activeSum(L)).toBe(n(4));
    // Yeni görev: R2'deki 1 için; hiç bulunamaz (0): hareket yok, rezervasyon serbest, lokasyon bloklu
    const a2 = await assign([o.id]);
    expect(a2.taskIds).toHaveLength(1);
    const ledger = await ledgerCount(X);
    const r0 = await doPick(a2.taskIds[0] as string, "0", R2, X);
    expect(r0.status).toBeUndefined(); // belge yok
    expect(r0.foundQuantity).toBe(n(0));
    expect(r0.notFound).toMatchObject({ shortQuantity: n(1), locationId: R2 });
    expect(r0.reallocation).toMatchObject({ status: "NONE" }); // R1, R2 bloklu; SEVK dolu
    expect(await ledgerCount(X)).toBe(ledger);
    expect(await pickBlocked(R2)).toBe(true);
    expect(await activeSum(L)).toBe(n(3));
    expect(await reservedOf(X)).toBe(n(3));
    await reservedMatches(X);
    expect(await audits("pick.not_found", R2)).toBe(1);
  }, 180_000);

  it("eşzamanlı iki 'bulunamadı' aynı lokasyonda (farklı ürün): bariyerle ikisi de lokasyon kilidinde bekler; 40P01 sızmaz; ikisi de tutarlı; tek açık COUNT görevi", async () => {
    const I1 = await mkItem();
    const I2 = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(I1, R, "5");
    await stockIn(I2, R, "5");
    const o1 = await mkOrder([{ item: I1, qty: "3" }]);
    const o2 = await mkOrder([{ item: I2, qty: "3" }]);
    await reserveOrder(ownerP(), { orderId: o1.id });
    await reserveOrder(ownerP(), { orderId: o2.id });
    const a = await assign([o1.id, o2.id]);
    const byItem = new Map((await Promise.all(a.taskIds.map(taskR))).map((t) => [t.item_id, t.id]));
    const hold = new pg.Client({ connectionString: env.databaseUrlDirect });
    hold.on("error", () => undefined);
    await hold.connect();
    try {
      const pid = Number((await hold.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]?.p);
      await hold.query("BEGIN");
      await hold.query("SELECT 1 FROM public.locations WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE", [A.tenantId, R]);
      const p1 = doPick(byItem.get(I1) as string, "1", R, I1, pickerP(uuid(), { retry: ONCE })); // yeniden deneme YOK: 40P01 yeniden denemeyle gizlenmesin
      const p2 = doPick(byItem.get(I2) as string, "1", R, I2, pickerP(uuid(), { retry: ONCE }));
      await untilBlocked(pid, 2); // ikisi de stok + başlık + görev kilidini aldı, lokasyon satırında bekliyor
      await hold.query("COMMIT");
      const settled = await Promise.allSettled([p1, p2]);
      for (const st of settled) {
        if (st.status === "rejected") throw st.reason;
      }
      expect(await pickBlocked(R)).toBe(true);
      expect(await tasksByKind("COUNT", R)).toHaveLength(1);
      for (const [item, o] of [[I1, o1], [I2, o2]] as const) {
        expect(await bal(item, R, "AVAILABLE")).toBe(n(4));
        expect(await activeSum(o.lineIds[0] as string)).toBe(n(1)); // yalnız toplanan 1 SEVK'te rezerve; eksik 2 serbest, yeniden tahsis yok
        await reservedMatches(item);
        expect(await ledgerSum(item)).toBe(await physical(item));
      }
      for (const id of byItem.values()) expect(await taskR(id)).toMatchObject({ status: "DONE" });
    } finally {
      await hold.query("ROLLBACK").catch(() => undefined);
      await hold.end();
    }
  }, 120_000);

  it("eşzamanlı iki toplama (aynı sipariş, farklı görev) başlık kilidiyle seri çalışır; yeniden deneme olmadan 40P01/VERSION_CONFLICT yok", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    const R2 = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "3");
    await stockIn(X, R2, "3");
    const o = await mkOrder([{ item: X, qty: "6" }]);
    await reserveOrder(ownerP(), { orderId: o.id, overrides: [{ lineId: o.lineIds[0] as string, allocations: [{ dimension: { locationId: R }, quantity: "3" }, { dimension: { locationId: R2 }, quantity: "3" }] }] });
    const a = await assign([o.id]);
    expect(a.taskIds).toHaveLength(2);
    const ts = await Promise.all(a.taskIds.map(taskR));
    const hold = new pg.Client({ connectionString: env.databaseUrlDirect });
    hold.on("error", () => undefined);
    await hold.connect();
    try {
      const pid = Number((await hold.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]?.p);
      await hold.query("BEGIN");
      await hold.query("SELECT 1 FROM public.sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [A.tenantId, o.id]);
      const ps = ts.map((t) => doPick(t.id, "3", t.location_id as string, X, pickerP(uuid(), { retry: ONCE })));
      await untilBlocked(pid, 2);
      await hold.query("COMMIT");
      for (const r of await Promise.allSettled(ps)) if (r.status === "rejected") throw r.reason;
      expect(await bal(X, R, "AVAILABLE")).toBe(n(0));
      expect(await activeSum(o.lineIds[0] as string)).toBe(n(6));
      await reservedMatches(X);
    } finally {
      await hold.query("ROLLBACK").catch(() => undefined);
      await hold.end();
    }
  }, 120_000);
});

describe("serbest STAGING stoğu ve açık REPUTAWAY görevi (T-306 MINOR-4)", () => {
  it("sevk alanındaki serbest mal yeni siparişe tahsis edilince REPUTAWAY görevi iptal edilir, artan serbest mal için tek yeni görev açılır", async () => {
    const X = await mkItem();
    const SEVK = await mkSevk(); // en küçük kod: A-138 tek-boyut seçimi de SEVK'i seçer (R kodu "ZR-")
    const R = await mkLoc("STORAGE", `ZR-${hex(6)}`);
    await stockIn(X, R, "6");
    const o1 = await mkOrder([{ item: X, qty: "3" }]);
    await reserveOrder(ownerP(), { orderId: o1.id });
    const a = await assign([o1.id]);
    await doPick(a.taskIds[0] as string, "3", R, X);
    await cancelOrderLine(ownerP(), { lineId: o1.lineIds[0] as string, quantity: "3" });
    const rep = await tasksByKind("REPUTAWAY", SEVK);
    expect(rep.map((t) => [t.status, t.quantity])).toEqual([["OPEN", n(3)]]);
    // Yeni sipariş 1: SEVK'teki serbest 3'ten 1 tahsis edilir
    const o2 = await mkOrder([{ item: X, qty: "1" }]);
    const r = await reserveOrder(ownerP(), { orderId: o2.id });
    expect(r.lines).toEqual([{ lineId: o2.lineIds[0], lineNo: 1, quantity: n(1) }]);
    expect((await reservationsOf(o2.lineIds[0] as string)).map((x) => [x.location_id, x.quantity])).toEqual([[SEVK, n(1)]]);
    const after = await tasksByKind("REPUTAWAY", SEVK);
    expect(after.map((t) => [t.status, t.quantity])).toEqual([["CANCELLED", n(3)], ["OPEN", n(2)]]);
    expect(await audits("warehouse_task.cancelled", rep[0]?.id as string)).toBe(1);
    // Kalan 2 serbest mal yerleştirilebilir (görev miktarı serbest miktarı aşmaz): görevsiz mal kalmadı
    const free = await q<{ f: string }>(
      "SELECT (b.quantity - b.reserved_quantity)::text AS f FROM public.stock_balances b JOIN public.stock_dimensions d ON d.tenant_id=b.tenant_id AND d.id=b.stock_dimension_id WHERE d.tenant_id=$1 AND d.item_id=$2 AND d.location_id=$3", [A.tenantId, X, SEVK]);
    expect(n(free[0]?.f as string)).toBe(n(2));
    // Tamamı tahsis: görev kalmaz
    const o3 = await mkOrder([{ item: X, qty: "2" }]);
    await reserveOrder(ownerP(), { orderId: o3.id });
    expect((await tasksByKind("REPUTAWAY", SEVK)).map((t) => [t.status, t.quantity])).toEqual([["CANCELLED", n(3)], ["CANCELLED", n(2)]]);
    await reservedMatches(X);
  }, 180_000);
});

describe("belge yolu rezervasyon taşıma kuralı (T-307: reservations.ts:452 reddi YALNIZ toplama yolunda kalktı)", () => {
  it("belge STOCK_MOVE + reservationMoves ile SİPARİŞ rezervasyonu taşınamaz (VALIDATION_FAILED); hiçbir şey değişmez; toplama yolu aynı rezervasyonu taşır", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    const SEVK = await mkSevk();
    await stockIn(X, R, "5");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    const L = o.lineIds[0] as string;
    const rv = await reserveOrder(ownerP(), { orderId: o.id });
    const c = await createStockDocument(ownerP(), { kind: "STOCK_MOVE", warehouseId: A.warehouseId, lines: [ln(X, "4", { sourceLocationId: R, targetLocationId: SEVK })] });
    const docId = c.documentId as string;
    await approveDocument(ownerP(), { documentId: docId, expectedVersion: 1 });
    const lineId = (await q<{ id: string }>("SELECT id FROM public.document_lines WHERE document_id=$1", [docId]))[0]?.id as string;
    const ver = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [docId]))[0]?.version as number;
    const ledger = await ledgerCount(X);
    const e = await failure(postDocument(ownerP(), { documentId: docId, expectedVersion: ver, reservationMoves: [{ lineId, reservationIds: rv.reservationIds as string[] }] }));
    expect(codeOf(e)).toBe("VALIDATION_FAILED");
    expect(await ledgerCount(X)).toBe(ledger);
    expect(await bal(X, R, "AVAILABLE")).toBe(n(5));
    expect(await bal(X, SEVK, "AVAILABLE")).toBe(n(0));
    expect((await reservationsOf(L)).map((r) => [r.status, r.location_id, r.quantity])).toEqual([["ACTIVE", R, n(4)]]);
    expect((await q<{ status: string }>("SELECT status FROM public.documents WHERE id=$1", [docId]))[0]?.status).toBe("APPROVED");
    await reservedMatches(X);
    // Aynı rezervasyon toplama yolundan taşınır.
    const a = await assign([o.id]);
    await doPick(a.taskIds[0] as string, "4", R, X);
    expect((await reservationsOf(L)).filter((r) => r.status === "ACTIVE").map((r) => [r.location_id, r.quantity])).toEqual([[SEVK, n(4)]]);
    await reservedMatches(X);
  }, 120_000);
});

describe("depo kapsamı (flag WAREHOUSE_SCOPE_ENABLED)", () => {
  afterAll(async () => {
    delete process.env.WAREHOUSE_SCOPE_ENABLED;
    await adm.query("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = $1 AND membership_id <> $2", [A.tenantId, A.ownerMembershipId]);
  });
  it("kapsam dışı depodaki toplama FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE (stok değişmez); kapsamlı yönetici kapsam dışı satır için görev üretmez (0, sızıntı yok)", async () => {
    const WB = uuid();
    await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,$3,'T307 depo B')", [A.tenantId, WB, `W${hex(6)}`]);
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "3");
    const o = await mkOrder([{ item: X, qty: "3" }]);
    await reserveOrder(ownerP(), { orderId: o.id });
    const a = await assign([o.id]);
    const pickerB = await mkUser(adm, reg, "A307 scoped picker");
    const pM = await mkMembership(adm, A.tenantId, pickerB, { roles: ["PICKER"] });
    const mgr = await mkUser(adm, reg, "A307 scoped mgr");
    const mM = await mkMembership(adm, A.tenantId, mgr, { roles: ["WAREHOUSE_MANAGER"] });
    for (const m of [pM, mM]) await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, m, WB]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const e = await failure(doPick(a.taskIds[0] as string, "3", R, X, callP(A, pickerB, uuid(), {})));
    expect(codeOf(e)).toBe("FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE");
    expect(await physical(X)).toBe(n(3));
    expect(await taskR(a.taskIds[0] as string)).toMatchObject({ status: "OPEN" });
    const o2 = await mkOrder([{ item: X, qty: "1" }]);
    await stockIn(X, await mkLoc("STORAGE"), "1");
    await reserveOrder(ownerP(), { orderId: o2.id });
    const g = await createPickAssignment(callP(A, mgr, uuid(), {}), { orderIds: [o2.id] });
    expect(g.taskIds).toEqual([]);
    expect(g.lines).toEqual([{ lineId: o2.lineIds[0], lineNo: 1, quantity: n(0) }]);
  }, 120_000);
});
