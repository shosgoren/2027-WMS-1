// T-308: kısmi sevk (sevk alanındaki rezervasyonu tüketir) ve müşteri iadesi (karantinaya) — ADR-021 §3, 16 Temel kurallar 4/5/6, Senaryo A adım 7–8, Senaryo D adım 8–9,
// AC-08 (sevk kolu), AC-10. GERÇEK roller (wms_app, pooler); fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile. Beklenen değerler docs/spec/16-stock-effects.md'den birebir;
// her adımdan sonra tüm sütunlar doğrulanır (defter toplamı = fiziksel, Σ ACTIVE rezervasyon = Σ reserved). Sevk, gerçek komutlarla (kabul → kalite → yerleştirme →
// sipariş → tahsis → toplama → sevk) test edilir; rezervasyon fikstürle yazılmaz. Fikstürler sentetiktir (G-09). Bağımsız kanıt (AC-31/AC-40) T-317'dedir.
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
  createCustomerReturn,
  createInboundReceipt,
  createPickAssignment,
  createSalesOrder,
  openInboundReceipt,
  putaway,
  receiveGoods,
  reserveOrder,
  shipOrder,
} from "../../../packages/domain/src/operations/index.ts";
import { approveDocument, createStockDocument, postDocument, reverseDocument, type DocumentLineInput, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
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
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T308 urun',$4,'NONE',$5)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId, scale,
  ]);
  return id;
}
async function mkLoc(kind: "RECEIVING" | "STORAGE" | "STAGING" = "STORAGE", code = `L-${hex(10)}`, warehouseId = A.warehouseId): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,'T308 lok',0,$5)", [
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
    customerRef: "T308-MUS",
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
    supplierRef: "T308-TED",
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

// --- T-307 yardımcıları (picking.int.test.ts ile aynı) -------------------------------------------------------------------------------------------------------
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
const shipmentRows = async (item: string): Promise<number> =>
  Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.stock_ledger WHERE tenant_id=$1 AND item_id=$2 AND reason='SHIPMENT'", [A.tenantId, item]))[0]?.c);
async function doPick(taskId: string, found: string, loc: string, item: string, p: StockDocCallParams = pickerP()) {
  return confirmPick(p, { taskId, foundQuantity: found, scannedLocationCode: await codeOfLoc(loc), scannedItemBarcode: await bcOf(item) });
}
async function assign(orderIds: string[], extra: Partial<Parameters<typeof createPickAssignment>[1]> = {}, p: StockDocCallParams = ownerP()) {
  return createPickAssignment(p, { orderIds, ...extra });
}
/** Hedef STAGING = deponun kodu EN KÜÇÜK ACTIVE STAGING lokasyonu (A-307-1). Aynı depoyu paylaşan testlerde son oluşturulan en küçük koda sahip olsun diye kod azalan sayaçtan üretilir. */
let stagingSeq = 9_999_999;
const mkSevk = (warehouseId = A.warehouseId): Promise<string> => mkLoc("STAGING", `0S${String(--stagingSeq).padStart(7, "0")}`, warehouseId);
const num = (p: string): string => `${p}-${hex(8)}`;

// --- T-308 yardımcıları ------------------------------------------------------------------------------------------------------
const docOf = async (id: string) =>
  (await q<{ kind: string; status: string; source_kind: string | null; source_id: string | null; reason: string | null }>(
    "SELECT kind, status, source_kind, source_id::text AS source_id, reason FROM public.documents WHERE tenant_id=$1 AND id=$2", [A.tenantId, id],
  ))[0] as { kind: string; status: string; source_kind: string | null; source_id: string | null; reason: string | null };
const docLines = (id: string) =>
  q<{ source_line_id: string | null; base_quantity: string; stock_status: string }>(
    "SELECT source_line_id::text AS source_line_id, base_quantity::text AS base_quantity, stock_status FROM public.document_lines WHERE tenant_id=$1 AND document_id=$2 ORDER BY line_no", [A.tenantId, id],
  );
const ledgerOf = (docId: string) =>
  q<{ quantity: string; reason: string; location_id: string; stock_status: string }>(
    `SELECT l.quantity::text AS quantity, l.reason, d.location_id, d.stock_status FROM public.stock_ledger l
       JOIN public.stock_dimensions d ON d.tenant_id=l.tenant_id AND d.id=l.stock_dimension_id
      WHERE l.tenant_id=$1 AND l.document_id=$2 ORDER BY l.quantity`, [A.tenantId, docId]);
const orderStatus = async (id: string): Promise<string> => (await q<{ status: string }>("SELECT status FROM public.sales_orders WHERE id=$1", [id]))[0]?.status as string;
const returnRows = async (item: string): Promise<number> =>
  Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.stock_ledger WHERE tenant_id=$1 AND item_id=$2 AND reason='RETURN'", [A.tenantId, item]))[0]?.c);
const docCount = async (): Promise<number> => Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.documents WHERE tenant_id=$1", [A.tenantId]))[0]?.c);

const shipLines = (o: Order, lines: [number, string][], key: string | null = uuid(), p: Partial<StockDocCallParams> = {}, extra: { warehouseId?: string } = {}) =>
  shipOrder(ownerP(key, p), { orderId: o.id, lines: lines.map(([i, quantity]) => ({ orderLineId: o.lineIds[i] as string, quantity })), ...extra });
const retOf = (lineId: string, quantity: string, locationId: string, key: string | null = uuid(), reason = "müşteri iadesi", p: Partial<StockDocCallParams> = {}) =>
  createCustomerReturn(ownerP(key, p), { orderLineId: lineId, quantity, locationId, reason });
/** Siparişi tahsis eder, görevlendirir ve tüm görevleri tam miktarla toplar (rezervasyonlar SEVK'e taşınır). */
async function reserveAndPick(o: Order, item: string, loc: string, found: string, p: StockDocCallParams = pickerP()): Promise<readonly string[]> {
  await reserveOrder(ownerP(), { orderId: o.id });
  const a = await assign([o.id]);
  for (const id of a.taskIds) await doPick(id, found, loc, item, p);
  return a.taskIds;
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A308");
  B = await seedWorld(adm, reg, "B308");
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("dışa açık yüzey", () => {
  it("shipOrder/createCustomerReturn açık; planShipment, isShippableReservation ve iç tüketim yolu (consumes) dışarıya açılmaz", () => {
    expect(Object.keys(ops)).toEqual(expect.arrayContaining(["shipOrder", "createCustomerReturn"]));
    for (const hidden of ["planShipment", "isShippableReservation", "parseReturnReason", "returnableOf", "postFieldDocument", "createTasks", "completeTask"]) {
      expect(Object.keys(ops)).not.toContain(hidden);
    }
  });
});

describe("@AC-31 Senaryo A adım 7–8 (X, KABUL, R-01, SEVK; S1 = 4): kısmi sevk 3 ve müşteri iadesi 1", () => {
  it("adım 6 toplama → 7 sevk 3 (fiziksel 10 → 7, rezerve 1, S1 4/3/1) → 8 iade 1 (fiziksel 8, KABUL·KAR 1, iade 1) → 9 iptal; kapanmış siparişte iade yalnız returned'ı değiştirir", async () => {
    await setQc(true);
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const SEVK = await mkSevk();
    const cols: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], kul: [KABUL, "AVAILABLE"], r01: [R01, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    await receiveToShelf([{ item: X, expected: "10", received: "10", shelf: R01, putQty: "10" }], KABUL);
    const s1 = await mkOrder([{ item: X, qty: "4" }]);
    const L = s1.lineIds[0] as string;
    await reserveAndPick(s1, X, R01, "4");
    await expectRow(X, cols, { r01: 6, sevk: 4, fiz: 10, rez: 4, kullan: 6 }, "adım 6");
    expect(await shipmentRows(X)).toBe(0);

    // 7. Kısmi sevk 3 (sevk için yalnız stock.post gerekir: toplayıcı rolü)
    const key = uuid();
    const r7 = await shipOrder(pickerP(key), { orderId: s1.id, lines: [{ orderLineId: L, quantity: "3" }] });
    expect(r7.status).toBe("POSTED");
    expect(r7.replayed).toBe(false);
    await expectRow(X, cols, { r01: 6, sevk: 1, fiz: 7, rez: 1, kullan: 6 }, "adım 7");
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(3), acik: n(1), iptal: n(0), iade: n(0) });
    expect((await ledgerOf(r7.documentId as string)).map((r) => [n(r.quantity), r.reason, r.location_id, r.stock_status])).toEqual([[n(-3), "SHIPMENT", SEVK, "AVAILABLE"]]);
    expect(await docOf(r7.documentId as string)).toMatchObject({ kind: "STOCK_OUT", status: "POSTED", source_kind: "SALES_ORDER", source_id: s1.id });
    expect((await docLines(r7.documentId as string)).map((l) => [l.source_line_id, n(l.base_quantity), l.stock_status])).toEqual([[L, n(3), "AVAILABLE"]]);
    const res = await reservationsOf(L);
    expect(res.filter((r) => r.status === "ACTIVE").map((r) => [r.location_id, r.stock_status, r.quantity])).toEqual([[SEVK, "AVAILABLE", n(1)]]);
    expect(res.filter((r) => r.status === "CONSUMED").map((r) => [r.location_id, r.quantity, r.order_line_id])).toEqual([[SEVK, n(3), L]]);
    expect(await orderStatus(s1.id)).toBe("OPEN");
    expect(await shipmentRows(X)).toBe(1);
    expect(await audits("stock_document.posted", r7.documentId as string)).toBe(1);
    // Aynı anahtar: saklı sonuç, ikinci çıkış yok.
    const again = await shipOrder(pickerP(key), { orderId: s1.id, lines: [{ orderLineId: L, quantity: "3" }] });
    expect(again.replayed).toBe(true);
    expect(again.documentId).toBe(r7.documentId);
    await expectRow(X, cols, { r01: 6, sevk: 1, fiz: 7, rez: 1, kullan: 6 }, "tekrar sonrası");

    // 8. Müşteri iadesi 1 (S1 sevkine bağlı): +1 KABUL·KAR; açık miktar değişmez, sipariş yeniden açılmaz
    const r8 = await retOf(L, "1", KABUL, uuid(), "ürün kusurlu");
    expect(r8.status).toBe("POSTED");
    await expectRow(X, cols, { kar: 1, r01: 6, sevk: 1, fiz: 8, rez: 1, kullan: 6 }, "adım 8");
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(3), acik: n(1), iptal: n(0), iade: n(1) });
    expect((await ledgerOf(r8.documentId as string)).map((r) => [n(r.quantity), r.reason, r.location_id, r.stock_status])).toEqual([[n(1), "RETURN", KABUL, "QUARANTINE"]]);
    expect(await docOf(r8.documentId as string)).toMatchObject({ kind: "STOCK_IN", status: "POSTED", source_kind: "SALES_ORDER", source_id: s1.id, reason: "ürün kusurlu" });
    expect((await docLines(r8.documentId as string)).map((l) => [l.source_line_id, n(l.base_quantity), l.stock_status])).toEqual([[L, n(1), "QUARANTINE"]]);
    expect(await orderStatus(s1.id)).toBe("OPEN");
    expect(await returnRows(X)).toBe(1);

    // 9. Kalan 1 iptal (T-306): rezervasyon serbest; sipariş CLOSED
    await cancelOrderLine(ownerP(), { lineId: L, quantity: "1", reason: "müşteri iptal" });
    await expectRow(X, cols, { kar: 1, r01: 6, sevk: 1, fiz: 8, rez: 0, kullan: 7 }, "adım 9");
    expect(await orderStatus(s1.id)).toBe("CLOSED");
    // Kapanmış siparişte iade (A-154): yalnız returned artar; açık miktar ve durum değişmez
    await retOf(L, "2", KABUL);
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(3), acik: n(0), iptal: n(1), iade: n(3) });
    expect(await orderStatus(s1.id)).toBe("CLOSED");
    await expectRow(X, cols, { kar: 3, r01: 6, sevk: 1, fiz: 10, rez: 0, kullan: 7 }, "kapanmış siparişte iade");
    // sevk edilenin üstü: ret
    expect(codeOf(await failure(retOf(L, "1", KABUL)))).toBe("VALIDATION_FAILED/RETURN_EXCEEDS_SHIPPED");
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(3), acik: n(0), iptal: n(1), iade: n(3) });

    // Bağımlı işlem: sevk ve iade belgesi (kaynak bağlı) ters çevrilmez (T-224 B-1, A-224-5; Supervisor kararı): sipariş satırının shipped/returned'ı kopmaz
    for (const id of [r7.documentId as string, r8.documentId as string]) {
      const e = await failure(reverseDocument(ownerP(), { documentId: id, lines: "ALL", reason: "yanlış işlem" }));
      expect(codeOf(e)).toBe("REVERSAL_BLOCKED/SOURCE_LINKED");
    }
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(3), acik: n(0), iptal: n(1), iade: n(3) });
    await expectRow(X, cols, { kar: 3, r01: 6, sevk: 1, fiz: 10, rez: 0, kullan: 7 }, "ters kayıt reddi sonrası");
  }, 240_000);
});

describe("@AC-40 Senaryo D adım 8–9 (X 18, Y 9 + 1 hasarlı; S1 X5 · S2 X6+Y3 · S3 Y4)", () => {
  it("adım 8 sevk: S1 X5 tam · S2 X6 tam + Y2 kısmi · S3 Y3 (X −11, Y −5); adım 9 S1'den X 1 iade; belge/sipariş son durumu tablosu", async () => {
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
    // 6. Toplama S1+S2 (X 11, Y 3) → SEVK
    const a = await assign([s2.id, s1.id]);
    const ts = await Promise.all(a.taskIds.map((id) => taskR(id)));
    for (const t of ts) await doPick(t.id, t.quantity as string, t.location_id as string, t.item_id as string);
    await expectRow(X, colsX, { r01: 7, sevk: 11, fiz: 18, rez: 11, kullan: 7 }, "X adım 6");
    await expectRow(Y, colsY, { dmg: 1, r02: 6, sevk: 3, fiz: 10, rez: 7, kullan: 2 }, "Y adım 6");
    // 7. Toplama S3: Y 4 istenir, 3 bulunur
    const a3 = await assign([s3.id]);
    const t3 = await taskR(a3.taskIds[0] as string);
    await doPick(t3.id, "3", R02, Y);
    await expectRow(Y, colsY, { dmg: 1, r02: 3, sevk: 6, fiz: 10, rez: 6, kullan: 0 }, "Y adım 7");
    const lx = await ledgerCount(X);
    const ly = await ledgerCount(Y);

    // 8. Sevk: S1 X5 tam · S2 X6 tam + Y 2 kısmi · S3 Y3
    const d1 = await shipLines(s1, [[0, "5"]]);
    await expectRow(X, colsX, { r01: 7, sevk: 6, fiz: 13, rez: 6, kullan: 7 }, "X S1 sevk");
    const d2 = await shipLines(s2, [[0, "6"], [1, "2"]]);
    const d3 = await shipLines(s3, [[0, "3"]]);
    await expectRow(X, colsX, { r01: 7, fiz: 7, rez: 0, kullan: 7 }, "X adım 8");
    await expectRow(Y, colsY, { dmg: 1, r02: 3, sevk: 1, fiz: 5, rez: 1, kullan: 0 }, "Y adım 8");
    expect(await ledgerCount(X)).toBe(lx + 2);
    expect(await ledgerCount(Y)).toBe(ly + 2);
    expect((await ledgerOf(d1.documentId as string)).map((r) => [n(r.quantity), r.reason, r.location_id])).toEqual([[n(-5), "SHIPMENT", SEVK]]);
    expect((await ledgerOf(d2.documentId as string)).map((r) => [n(r.quantity), r.reason, r.location_id])).toEqual([[n(-6), "SHIPMENT", SEVK], [n(-2), "SHIPMENT", SEVK]]);
    expect((await ledgerOf(d3.documentId as string)).map((r) => [n(r.quantity), r.reason])).toEqual([[n(-3), "SHIPMENT"]]);
    expect(await shipmentRows(X)).toBe(2);
    expect(await shipmentRows(Y)).toBe(2);
    // S2'nin Y'si: 1 rezerve, SEVK'te bekliyor; S3: rezervesiz (stok yok)
    expect(await activeSum(s2.lineIds[1] as string)).toBe(n(1));
    expect((await reservationsOf(s2.lineIds[1] as string)).filter((r) => r.status === "ACTIVE").map((r) => [r.location_id, r.quantity])).toEqual([[SEVK, n(1)]]);
    expect(await activeSum(s3.lineIds[0] as string)).toBe(n(0));

    // 9. Müşteri iadesi: S1'den X 1 → +1 KABUL·KAR
    await retOf(s1.lineIds[0] as string, "1", KABUL);
    await expectRow(X, colsX, { kar: 1, r01: 7, fiz: 8, rez: 0, kullan: 7 }, "X adım 9");
    await expectRow(Y, colsY, { dmg: 1, r02: 3, sevk: 1, fiz: 5, rez: 1, kullan: 0 }, "Y adım 9");

    // Belge ve sipariş son durumu (S2 Y3 → 2 sevk, 1 açık; S3 Y4 → 3 sevk, 1 açık)
    expect(await lineTriple(s1.lineIds[0] as string)).toEqual({ istenen: n(5), sevk: n(5), acik: n(0), iptal: n(0), iade: n(1) });
    expect(await lineTriple(s2.lineIds[0] as string)).toEqual({ istenen: n(6), sevk: n(6), acik: n(0), iptal: n(0), iade: n(0) });
    expect(await lineTriple(s2.lineIds[1] as string)).toEqual({ istenen: n(3), sevk: n(2), acik: n(1), iptal: n(0), iade: n(0) });
    expect(await lineTriple(s3.lineIds[0] as string)).toEqual({ istenen: n(4), sevk: n(3), acik: n(1), iptal: n(0), iade: n(0) });
    expect([await orderStatus(s1.id), await orderStatus(s2.id), await orderStatus(s3.id)]).toEqual(["CLOSED", "OPEN", "OPEN"]);
  }, 300_000);
});

describe("@AC-10 aynı siparişin toplama ve sevki: müşteri çıkışı bir kez", () => {
  it("toplama (MOVE) çıkış üretmez; ilk sevk tek − satırı yazar; aynı anahtar saklı sonuç; ikinci anahtar ret; DB CHECK son savunma", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "6");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    const L = o.lineIds[0] as string;
    await reserveAndPick(o, X, R, "4");
    expect(await shipmentRows(X)).toBe(0); // toplama müşteri çıkışı değildir
    const key = uuid();
    const first = await shipLines(o, [[0, "4"]], key);
    expect(await shipmentRows(X)).toBe(1);
    expect(await physical(X)).toBe(n(2));
    expect(await orderStatus(o.id)).toBe("CLOSED");
    const docs = await docCount();
    // aynı anahtar → önceki sonuç; farklı anahtar → ret (tüketilecek rezervasyon / açık sipariş kalmadı)
    const same = await shipLines(o, [[0, "4"]], key);
    expect([same.replayed, same.documentId]).toEqual([true, first.documentId]);
    expect(codeOf(await failure(shipLines(o, [[0, "4"]])))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    // aynı anahtar, farklı içerik → IDEMPOTENCY_MISMATCH
    expect(codeOf(await failure(shipLines(o, [[0, "3"]], key)))).toBe("IDEMPOTENCY_MISMATCH");
    expect(await shipmentRows(X)).toBe(1);
    expect(await physical(X)).toBe(n(2));
    expect(await docCount()).toBe(docs);
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(4), acik: n(0), iptal: n(0), iade: n(0) });
    // Son savunma: DB CHECK shipped + cancelled ≤ requested (süper kullanıcı bile aşamaz)
    await expect(adm.query("UPDATE public.sales_order_lines SET shipped_quantity = 5 WHERE id = $1", [L])).rejects.toMatchObject({ code: "23514" });
    await expect(adm.query("UPDATE public.sales_order_lines SET cancelled_quantity = 1 WHERE id = $1", [L])).rejects.toMatchObject({ code: "23514" });
  }, 120_000);

  it("kısmi sevkten sonra ikinci sevk yalnız kalan rezervasyon kadar; fazlası INSUFFICIENT_STOCK ve hiçbir şey yazılmaz", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "6");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    await reserveAndPick(o, X, R, "4");
    await shipLines(o, [[0, "3"]]);
    const docs = await docCount();
    expect(codeOf(await failure(shipLines(o, [[0, "3"]])))).toBe("INSUFFICIENT_STOCK");
    expect(await shipmentRows(X)).toBe(1);
    expect(await docCount()).toBe(docs);
    expect(await physical(X)).toBe(n(3));
    await shipLines(o, [[0, "1"]]);
    expect(await shipmentRows(X)).toBe(2);
    expect(await orderStatus(o.id)).toBe("CLOSED");
    expect(await reservedOf(X)).toBe(n(0));
    await reservedMatches(X);
  }, 120_000);
});

describe("@AC-08 sevke uygun olmayan stok: sevk kolu", () => {
  it("raftaki (toplanmamış) rezervasyon ve rezervasyonsuz satır sevk edilemez: INSUFFICIENT_STOCK; hiçbir şey değişmez", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "5");
    const reserved = await mkOrder([{ item: X, qty: "3" }]);
    await reserveOrder(ownerP(), { orderId: reserved.id }); // rezervasyon R'de (STORAGE): henüz sevk alanında değil
    const none = await mkOrder([{ item: X, qty: "2" }]); // tahsissiz
    const docs = await docCount();
    expect(codeOf(await failure(shipLines(reserved, [[0, "3"]])))).toBe("INSUFFICIENT_STOCK");
    expect(codeOf(await failure(shipLines(none, [[0, "2"]])))).toBe("INSUFFICIENT_STOCK");
    expect(await docCount()).toBe(docs);
    expect(await shipmentRows(X)).toBe(0);
    expect(await physical(X)).toBe(n(5));
    expect(await reservedOf(X)).toBe(n(3));
    expect(await available(X)).toBe(n(2));
    await reservedMatches(X);
  }, 120_000);

  it("karantinadaki iade stoğu sevk edilemez ve kullanılabilir miktara girmez (Senaryo A adım 8 sonrası)", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R = await mkLoc("STORAGE");
    const SEVK = await mkSevk();
    await stockIn(X, R, "4");
    const s1 = await mkOrder([{ item: X, qty: "4" }]);
    await reserveAndPick(s1, X, R, "4");
    await shipLines(s1, [[0, "4"]]);
    await retOf(s1.lineIds[0] as string, "2", KABUL); // fiziksel 2 = KABUL·KAR 2
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(2));
    expect(await available(X)).toBe(n(0));
    // yeni sipariş: karantina stoğu tahsis edilmez; sevk denemesi ret; kullanılabilir değişmez
    const s2 = await mkOrder([{ item: X, qty: "2" }]);
    const re = await reserveOrder(ownerP(), { orderId: s2.id });
    expect(re.lines).toEqual([{ lineId: s2.lineIds[0], lineNo: 1, quantity: n(0) }]);
    const ledger = await ledgerCount(X);
    expect(codeOf(await failure(shipLines(s2, [[0, "2"]])))).toBe("INSUFFICIENT_STOCK");
    // Kullanıcı karantina boyutuna elle rezervasyon veremez; iade edilen sipariş satırının kendisi de yeniden sevk edilemez (tüketilecek rezervasyon yok)
    expect(codeOf(await failure(shipLines(s1, [[0, "1"]])))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await ledgerCount(X)).toBe(ledger);
    expect(await available(X)).toBe(n(0));
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(2));
    expect(await bal(X, SEVK, "AVAILABLE")).toBe(n(0));
    await reservedMatches(X);
  }, 180_000);

  it("genel belge STOCK_OUT'u rezerve sevk stoğunu tüketemez (A-134): rezervasyon korunur", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    const SEVK = await mkSevk();
    await stockIn(X, R, "4");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    await reserveAndPick(o, X, R, "4");
    await expect(postDoc("STOCK_OUT", [ln(X, "4", { sourceLocationId: SEVK, stockStatus: "AVAILABLE" })])).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await shipmentRows(X)).toBe(0);
    expect(await reservedOf(X)).toBe(n(4));
    expect(await physical(X)).toBe(n(4));
    await shipLines(o, [[0, "4"]]); // gerçek sevk yolu çalışır
    expect(await shipmentRows(X)).toBe(1);
  }, 120_000);
});

describe("sevk girdi ve kaynak doğrulaması (A-152, A-308-1/2)", () => {
  it("yinelenen satır, sıfır/ondalık-ölçek ihlali, başka siparişin satırı, boş satır listesi ve başka tenant → ret; stok değişmez", async () => {
    const X = await mkItem(); // quantity_scale 0: kesirli miktar sevk edilemez
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "6");
    const o = await mkOrder([{ item: X, qty: "3" }]);
    const other = await mkOrder([{ item: X, qty: "3" }]);
    await reserveAndPick(o, X, R, "3");
    const docs = await docCount();
    expect(codeOf(await failure(shipLines(o, [[0, "1"], [0, "1"]])))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(shipLines(o, [[0, "0"]])))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(shipLines(o, [[0, "1.5"]])))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(codeOf(await failure(shipLines(o, [[0, "1.0000001"]])))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(shipOrder(ownerP(), { orderId: o.id, lines: [] })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(shipOrder(ownerP(), { orderId: o.id, lines: [{ orderLineId: other.lineIds[0] as string, quantity: "1" }] })))).toBe("NOT_FOUND"); // başka siparişin satırı
    expect(codeOf(await failure(shipOrder(ownerP(), { orderId: uuid(), lines: [{ orderLineId: o.lineIds[0] as string, quantity: "1" }] })))).toBe("NOT_FOUND");
    expect(codeOf(await failure(shipOrder(ownerBP(), { orderId: o.id, lines: [{ orderLineId: o.lineIds[0] as string, quantity: "1" }] })))).toBe("NOT_FOUND"); // başka tenant
    expect(await docCount()).toBe(docs);
    expect(await shipmentRows(X)).toBe(0);
    expect(await lineTriple(o.lineIds[0] as string)).toEqual({ istenen: n(3), sevk: n(0), acik: n(3), iptal: n(0), iade: n(0) });
    expect(await reservedOf(X)).toBe(n(3));
    // iptal edilmiş siparişin sevki yok
    const c = await mkOrder([{ item: X, qty: "1" }]);
    await cancelOrderLine(ownerP(), { lineId: c.lineIds[0] as string, quantity: "1", reason: "iptal" });
    expect(codeOf(await failure(shipLines(c, [[0, "1"]])))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
  }, 120_000);

  it("A-308-2: bir satırın rezervasyonları iki depoda ise warehouseId zorunludur; her depodan ayrı sevk edilir ve satır kapanır", async () => {
    const WB = uuid();
    await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,$3,'T308 depo B')", [A.tenantId, WB, `W${hex(6)}`]);
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    const RB = await mkLoc("STORAGE", `L-${hex(10)}`, WB);
    await mkSevk();
    const SEVKB = await mkSevk(WB);
    await stockIn(X, R, "2");
    await stockIn(X, RB, "2", "AVAILABLE", WB);
    const o = await mkOrder([{ item: X, qty: "4" }]);
    await reserveOrder(ownerP(), { orderId: o.id });
    const a = await assign([o.id]);
    expect(a.taskIds).toHaveLength(2);
    for (const id of a.taskIds) {
      const t = await taskR(id);
      await doPick(id, t.quantity as string, t.location_id as string, X);
    }
    expect(await bal(X, SEVKB, "AVAILABLE")).toBe(n(2));
    const docs = await docCount();
    expect(codeOf(await failure(shipLines(o, [[0, "2"]])))).toBe("VALIDATION_FAILED"); // hangi depo? belirsiz
    expect(codeOf(await failure(shipLines(o, [[0, "3"]], uuid(), {}, { warehouseId: A.warehouseId })))).toBe("INSUFFICIENT_STOCK"); // depoda yalnız 2
    expect(await docCount()).toBe(docs);
    const w1 = await shipLines(o, [[0, "2"]], uuid(), {}, { warehouseId: A.warehouseId });
    expect((await q<{ warehouse_id: string }>("SELECT warehouse_id FROM public.documents WHERE id=$1", [w1.documentId]))[0]?.warehouse_id).toBe(A.warehouseId);
    expect(await orderStatus(o.id)).toBe("OPEN");
    const w2 = await shipLines(o, [[0, "2"]]); // artık tek depo kaldı: warehouseId gerekmez
    expect((await q<{ warehouse_id: string }>("SELECT warehouse_id FROM public.documents WHERE id=$1", [w2.documentId]))[0]?.warehouse_id).toBe(WB);
    expect(await orderStatus(o.id)).toBe("CLOSED");
    expect(await physical(X)).toBe(n(0));
    expect(await shipmentRows(X)).toBe(2);
    await reservedMatches(X);
  }, 240_000);
});

describe("müşteri iadesi doğrulaması (A-135, A-150, A-308-4..7)", () => {
  it("sevk edilmemiş ya da sevkin üstü iade RETURN_EXCEEDS_SHIPPED; kümülatif sınır; RECEIVING dışı lokasyon, bilinmeyen lokasyon, boş neden, ölçek ihlali ve başka tenant ret; hiçbir şey yazılmaz", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "5");
    const o = await mkOrder([{ item: X, qty: "3" }]);
    const L = o.lineIds[0] as string;
    const docs0 = await docCount();
    // henüz sevk yok
    expect(codeOf(await failure(retOf(L, "1", KABUL)))).toBe("VALIDATION_FAILED/RETURN_EXCEEDS_SHIPPED");
    await reserveAndPick(o, X, R, "3");
    await shipLines(o, [[0, "3"]]);
    const docs = await docCount();
    expect(docs).toBeGreaterThan(docs0);
    expect(codeOf(await failure(retOf(L, "4", KABUL)))).toBe("VALIDATION_FAILED/RETURN_EXCEEDS_SHIPPED");
    expect(codeOf(await failure(retOf(L, "1", R)))).toBe("VALIDATION_FAILED"); // STORAGE lokasyonuna iade yok
    expect(codeOf(await failure(retOf(L, "1", uuid())))).toBe("NOT_FOUND");
    expect(codeOf(await failure(retOf(uuid(), "1", KABUL)))).toBe("NOT_FOUND");
    expect(codeOf(await failure(retOf(L, "1", KABUL, uuid(), "   ")))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(retOf(L, "0", KABUL)))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(retOf(L, "0.5", KABUL)))).toBe("VALIDATION_FAILED/QUANTITY_SCALE"); // ürün ölçeği 0
    expect(codeOf(await failure(createCustomerReturn(ownerBP(), { orderLineId: L, quantity: "1", locationId: KABUL, reason: "x" })))).toBe("NOT_FOUND"); // başka tenant
    expect(await docCount()).toBe(docs);
    expect(await returnRows(X)).toBe(0);
    expect(await lineTriple(L)).toEqual({ istenen: n(3), sevk: n(3), acik: n(0), iptal: n(0), iade: n(0) });
    // kümülatif: 2 + 1 = 3 olur; 4. birim reddedilir
    const key = uuid();
    await retOf(L, "2", KABUL, key);
    const rep = await retOf(L, "2", KABUL, key);
    expect(rep.replayed).toBe(true);
    expect(await returnRows(X)).toBe(1);
    expect(codeOf(await failure(retOf(L, "2", KABUL)))).toBe("VALIDATION_FAILED/RETURN_EXCEEDS_SHIPPED");
    await retOf(L, "1", KABUL);
    expect((await lineTriple(L)).iade).toBe(n(3));
    expect(codeOf(await failure(retOf(L, "0.000001", KABUL)))).toBe("VALIDATION_FAILED/RETURN_EXCEEDS_SHIPPED");
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(3));
    expect(await ledgerSum(X)).toBe(await physical(X));
  }, 180_000);

  it("kesirli ölçekli ürün: iade/sevk miktarı toBase tek yolundan geçer, 6 ondalığa inen miktar kabul edilir", async () => {
    const X = await mkItem(3); // quantity_scale 3
    const KABUL = await mkLoc("RECEIVING");
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "5");
    const o = await mkOrder([{ item: X, qty: "2.5" }]);
    await reserveAndPick(o, X, R, "2.5");
    expect(codeOf(await failure(shipLines(o, [[0, "1.2345"]])))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    await shipLines(o, [[0, "2.125"]]);
    expect(await physical(X)).toBe(n(2.875));
    expect(codeOf(await failure(retOf(o.lineIds[0] as string, "0.0005", KABUL)))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    await retOf(o.lineIds[0] as string, "0.125", KABUL);
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(0.125));
    expect(await lineTriple(o.lineIds[0] as string)).toEqual({ istenen: n(2.5), sevk: n(2.125), acik: n(0.375), iptal: n(0), iade: n(0.125) });
  }, 180_000);
});

describe("eşzamanlılık (Supervisor notu 1; yeniden deneme YOK: 40P01 görünür olur)", () => {
  it("aynı siparişi iki farklı anahtarla eşzamanlı sevk: biri başarılı, diğeri ret; tek çıkış, kilitlenme yok", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "4");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    await reserveAndPick(o, X, R, "4");
    const res = await Promise.allSettled([shipLines(o, [[0, "4"]], uuid(), { retry: NO_WAIT }), shipLines(o, [[0, "4"]], uuid(), { retry: NO_WAIT })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(AppError);
    expect(["VALIDATION_FAILED/DOCUMENT_STATE", "INSUFFICIENT_STOCK"]).toContain(codeOf(rej.reason as AppError));
    expect(await shipmentRows(X)).toBe(1);
    expect(await physical(X)).toBe(n(0));
    expect(await orderStatus(o.id)).toBe("CLOSED");
    await reservedMatches(X);
  }, 120_000);

  it("iki kısmi sevk eşzamanlı (2 + 2): ikisi de başarılı, shipped 4, sipariş CLOSED; kilit yükseltmesi (40P01) yok", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "4");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    await reserveAndPick(o, X, R, "4");
    const res = await Promise.allSettled([shipLines(o, [[0, "2"]], uuid(), { retry: ONCE }), shipLines(o, [[0, "2"]], uuid(), { retry: ONCE })]);
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await lineTriple(o.lineIds[0] as string)).toEqual({ istenen: n(4), sevk: n(4), acik: n(0), iptal: n(0), iade: n(0) });
    expect(await shipmentRows(X)).toBe(2);
    expect(await orderStatus(o.id)).toBe("CLOSED");
    await reservedMatches(X);
  }, 120_000);

  it("eşzamanlı iki iade sevk edilenin üstüne çıkamaz: 3 sevkte 2 + 2 → biri RETURN_EXCEEDS_SHIPPED; sevk ve iade birlikte kilitlenmez", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "5");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    const L = o.lineIds[0] as string;
    await reserveAndPick(o, X, R, "4");
    await shipLines(o, [[0, "3"]]);
    const res = await Promise.allSettled([retOf(L, "2", KABUL, uuid(), "a", { retry: ONCE }), retOf(L, "2", KABUL, uuid(), "b", { retry: ONCE })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(codeOf((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as AppError)).toBe("VALIDATION_FAILED/RETURN_EXCEEDS_SHIPPED");
    expect((await lineTriple(L)).iade).toBe(n(2));
    // sevk (kalan 1) ile iade (kalan 1) eşzamanlı: aynı sipariş başlığı/satırı kilidi sırayla alınır
    const mix = await Promise.allSettled([shipLines(o, [[0, "1"]], uuid(), { retry: ONCE }), retOf(L, "1", KABUL, uuid(), "c", { retry: ONCE })]);
    expect(mix.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(4), acik: n(0), iptal: n(0), iade: n(3) });
    expect(await ledgerSum(X)).toBe(await physical(X));
    await reservedMatches(X);
  }, 180_000);
});

describe("depo kapsamı (flag WAREHOUSE_SCOPE_ENABLED)", () => {
  afterAll(async () => {
    delete process.env.WAREHOUSE_SCOPE_ENABLED;
    await adm.query("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = $1 AND membership_id <> $2", [A.tenantId, A.ownerMembershipId]);
  });
  it("kapsam dışı depodan sevk ve iade FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE; stok ve sipariş değişmez", async () => {
    const WB = uuid();
    await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,$3,'T308 kapsam B')", [A.tenantId, WB, `W${hex(6)}`]);
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R = await mkLoc("STORAGE");
    await mkSevk();
    await stockIn(X, R, "4");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    await reserveAndPick(o, X, R, "4");
    await shipLines(o, [[0, "2"]]);
    const scoped = await mkUser(adm, reg, "A308 scoped");
    const m = await mkMembership(adm, A.tenantId, scoped, { roles: ["PICKER"] });
    await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, m, WB]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const docs = await docCount();
    expect(codeOf(await failure(shipOrder(callP(A, scoped, uuid(), {}), { orderId: o.id, lines: [{ orderLineId: o.lineIds[0] as string, quantity: "2" }] })))).toBe("FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE");
    expect(codeOf(await failure(createCustomerReturn(callP(A, scoped, uuid(), {}), { orderLineId: o.lineIds[0] as string, quantity: "1", locationId: KABUL, reason: "x" })))).toBe("FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE");
    expect(await docCount()).toBe(docs);
    expect(await lineTriple(o.lineIds[0] as string)).toEqual({ istenen: n(4), sevk: n(2), acik: n(2), iptal: n(0), iade: n(0) });
  }, 120_000);
});
