// T-306: müşteri siparişi, sipariş satırına sert tahsis ve iptal (ADR-009, ADR-021 §4; 16 Senaryo A adım 4–5 ve 9, Senaryo D adım 4–5).
// GERÇEK roller (wms_app, pooler); fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile. Beklenen değerler docs/spec/16-stock-effects.md'den birebir;
// her adımdan sonra tüm sütunlar doğrulanır. Fikstürler sentetiktir (G-09). Bağımsız kanıt (AC-31/AC-40 tam akış) T-317'dedir.
//
// Senaryo A adım 6–8 (toplama, kısmi sevk, iade) T-307/T-308/T-309 kapsamındadır; adım 9'un ön koşulunu kurmak için bu testte YALNIZCA fikstür olarak
// (a) fiziksel hareketler gerçek belge komutlarıyla (STOCK_MOVE/STOCK_OUT/STOCK_IN), (b) rezervasyonun sevk boyutuna taşınması/tüketimi ve sipariş satırının
// shipped/returned değeri DATABASE_URL_DIRECT ile kurulur (aşağıda `standInForPickShipReturn`); adım 6–8 değerleri de tabloyla karşılaştırılır.
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
  cancelSalesOrder,
  createInboundReceipt,
  createSalesOrder,
  openInboundReceipt,
  putaway,
  receiveGoods,
  reserveOrder,
  updateDraftOrder,
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
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T306 urun',$4,'NONE',$5)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId, scale,
  ]);
  return id;
}
async function mkLoc(kind: "RECEIVING" | "STORAGE" | "STAGING" = "STORAGE", code = `L-${hex(10)}`, warehouseId = A.warehouseId): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,'T306 lok',0,$5)", [
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
    customerRef: "T306-MUS",
    lines: lines.map((l) => ({ itemId: l.item, unitId: A.unitId, quantity: l.qty })),
  });
  const rows = await q<{ id: string }>("SELECT id FROM public.sales_order_lines WHERE order_id = $1 ORDER BY line_no", [r.documentId]);
  return { id: r.documentId as string, lineIds: rows.map((x) => x.id), number: r.documentNumber as string };
}
const orderRow = async (id: string) =>
  (await q<{ status: string; version: number }>("SELECT status, version FROM public.sales_orders WHERE id = $1", [id]))[0] as { status: string; version: number };
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
const tasksOfOrder = (orderId: string) =>
  q<{ id: string; kind: string; status: string; quantity: string; item_id: string; location_id: string; source_line_id: string; source_kind: string }>(
    "SELECT id, kind, status, quantity::text AS quantity, item_id, location_id, source_line_id, source_kind FROM public.warehouse_tasks WHERE tenant_id=$1 AND source_id=$2 ORDER BY created_at, id",
    [A.tenantId, orderId]);
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
    supplierRef: "T306-TED",
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

/**
 * `pid` bağlantısının kilidini DOLAYLI da olsa (kuyrukta öncekini bekleyen dahil) bekleyen arka uç sayısı: zamanlamaya dayanmayan kapı.
 * Satır kilidi bekleyenler sıraya girer (ikinci bekleyen birinciyi bekler), bu yüzden bloklama zinciri izlenir.
 */
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

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A306");
  B = await seedWorld(adm, reg, "B306");
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("dışa açık yüzey", () => {
  it("genel komutlar açık; allocateInTx/releaseSelected/field-posting iç yardımcıdır", () => {
    expect(Object.keys(ops)).toEqual(expect.arrayContaining(["createSalesOrder", "updateDraftOrder", "reserveOrder", "cancelOrderLine", "cancelSalesOrder"]));
    for (const hidden of ["allocateInTx", "releaseSelected", "postFieldDocument", "createTasks", "completeTask", "suggestAllocation"]) {
      expect(Object.keys(ops)).not.toContain(hidden);
    }
  });
});

describe("@AC-31 Senaryo A adım 4–5 ve 9 (X, KABUL, R-01, SEVK; sipariş S1 = 4)", () => {
  it("sipariş oluşur (stok etkisi yok) → rezervasyon 4 → [6–8 fikstür] → kalan 1 iptal: rezerve 0, REPUTAWAY görevi", async () => {
    await setQc(true);
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const SEVK = await mkLoc("STAGING");
    const cols: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], kul: [KABUL, "AVAILABLE"], r01: [R01, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    await receiveToShelf([{ item: X, expected: "10", received: "10", shelf: R01, putQty: "10" }], KABUL);
    await expectRow(X, cols, { r01: 10, fiz: 10, rez: 0, kullan: 10 }, "adım 3");
    const ledger3 = await ledgerCount(X);

    // 4. Sipariş S1 oluşur (4): defter/bakiye değişmez; S1 4 / 0 / 4
    const s1 = await mkOrder([{ item: X, qty: "4" }]);
    const L = s1.lineIds[0] as string;
    await expectRow(X, cols, { r01: 10, fiz: 10, rez: 0, kullan: 10 }, "adım 4");
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(0), acik: n(4), iptal: n(0), iade: n(0) });
    expect(await ledgerCount(X)).toBe(ledger3);
    expect(s1.number).toMatch(/^SIP-\d{4}-[0-9A-F]{8}$/);
    expect(await audits("sales_order.created", s1.id)).toBe(1);
    expect(await orderRow(s1.id)).toMatchObject({ status: "OPEN" });

    // 5. Rezervasyon 4 (R-01·KUL'a): rezerve 4, kullanılabilir 6, defter satırı YOK (kural 2)
    const r5 = await reserveOrder(ownerP(), { orderId: s1.id });
    expect(r5.lines).toEqual([{ lineId: L, lineNo: 1, quantity: n(4) }]);
    await expectRow(X, cols, { r01: 10, fiz: 10, rez: 4, kullan: 6 }, "adım 5");
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(0), acik: n(4), iptal: n(0), iade: n(0) });
    expect(await ledgerCount(X)).toBe(ledger3);
    const res = await reservationsOf(L);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ status: "ACTIVE", quantity: n(4), location_id: R01, stock_status: "AVAILABLE", order_line_id: L, document_line_id: null });
    expect(await audits("reservation.created", s1.id)).toBe(1);
    // Aynı anahtarla tekrar: tek etki.
    const key = uuid();
    const again = await reserveOrder(ownerP(key), { orderId: s1.id });
    const replay = await reserveOrder(ownerP(key), { orderId: s1.id });
    expect(replay.replayed).toBe(true);
    expect(again.lines).toEqual([{ lineId: L, lineNo: 1, quantity: n(0) }]); // zaten tam tahsisli: yeni tahsis yok
    expect(await activeSum(L)).toBe(n(4));

    // 6–8 (T-307/308/309 kapsamı): fikstür — toplama 4 → SEVK, kısmi sevk 3, iade 1 (+1 KABUL·KAR)
    await standInForPickShipReturn({ item: X, r01: R01, sevk: SEVK, kabul: KABUL, lineId: L });
    // 7. satır (kısmi sevk 3): R-01 6, SEVK 1, fiziksel 7 + 8. satır (iade 1: KABUL·KAR 1) → fiziksel 8, rezerve 1, kullanılabilir 6
    await expectRow(X, cols, { kar: 1, r01: 6, sevk: 1, fiz: 8, rez: 1, kullan: 6 }, "adım 6–8 (fikstür sonrası)");
    expect((await reservationsOf(L)).filter((r) => r.status === "ACTIVE").map((r) => [r.location_id, r.quantity])).toEqual([[SEVK, n(1)]]);
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(3), acik: n(1), iptal: n(0), iade: n(1) });
    const ledger8 = await ledgerCount(X);

    // 9. S1 kalan 1 iptal: rezervasyon 1 serbest; geri yerleştirme görevi; fiziksel stok yerinde
    const key9 = uuid();
    const r9 = await cancelOrderLine(ownerP(key9), { lineId: L, quantity: "1", reason: "musteri vazgecti" });
    expect(r9.lines).toEqual([{ lineId: L, lineNo: 1, quantity: n(1) }]);
    await expectRow(X, cols, { kar: 1, r01: 6, sevk: 1, fiz: 8, rez: 0, kullan: 7 }, "adım 9");
    expect(await lineTriple(L)).toEqual({ istenen: n(4), sevk: n(3), acik: n(0), iptal: n(1), iade: n(1) });
    expect(await ledgerCount(X)).toBe(ledger8); // defter değişmez (kural 7)
    expect(await activeSum(L)).toBe(n(0));
    const closed = (await reservationsOf(L)).filter((r) => r.status === "RELEASED");
    expect(closed.map((r) => r.quantity)).toEqual([n(1)]);
    const tasks = await tasksOfOrder(s1.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "REPUTAWAY", status: "OPEN", quantity: n(1), item_id: X, location_id: SEVK, source_line_id: L, source_kind: "SALES_ORDER" });
    expect(await orderRow(s1.id)).toMatchObject({ status: "CLOSED" }); // A-140: açık 0
    expect(await audits("sales_order.line_cancelled", L)).toBe(1);
    expect(await audits("reservation.created", s1.id)).toBe(1);
    // Tekrar (aynı anahtar): ikinci görev/etki yok.
    expect((await cancelOrderLine(ownerP(key9), { lineId: L, quantity: "1", reason: "musteri vazgecti" })).replayed).toBe(true);
    expect(await tasksOfOrder(s1.id)).toHaveLength(1);
    // Kapanmış siparişte yeni iptal/tahsis yok.
    expect(codeOf(await failure(cancelOrderLine(ownerP(), { lineId: L, quantity: "1" })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(reserveOrder(ownerP(), { orderId: s1.id })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
  }, 120_000);
});

/** Adım 6–8 fikstürü (bkz. dosya başı): fiziksel hareketler gerçek belge komutlarıyla; rezervasyon/sipariş sayaçları doğrudan. */
async function standInForPickShipReturn(a: { item: string; r01: string; sevk: string; kabul: string; lineId: string }): Promise<void> {
  await postDoc("STOCK_MOVE", [ln(a.item, "4", { sourceLocationId: a.r01, targetLocationId: a.sevk })]); // 6. toplama 4 → SEVK
  await postDoc("STOCK_OUT", [ln(a.item, "3", { sourceLocationId: a.sevk })]); // 7. kısmi sevk 3
  await postDoc("STOCK_IN", [ln(a.item, "1", { targetLocationId: a.kabul, stockStatus: "QUARANTINE" })]); // 8. müşteri iadesi 1 → KABUL·KAR
  const dims = await q<{ id: string; location_id: string }>(
    "SELECT id, location_id FROM public.stock_dimensions WHERE tenant_id=$1 AND item_id=$2 AND stock_status='AVAILABLE'", [A.tenantId, a.item]);
  const r01 = (dims.find((d) => d.location_id === a.r01) as { id: string }).id;
  const sevk = (dims.find((d) => d.location_id === a.sevk) as { id: string }).id;
  await adm.query("BEGIN");
  try {
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]); // ertelenmiş denetim tetikleyicisi tenant bağlamı ister
    const r = (await q<{ id: string }>("SELECT id FROM public.reservations WHERE tenant_id=$1 AND order_line_id=$2 AND status='ACTIVE'", [A.tenantId, a.lineId]))[0] as { id: string };
    await adm.query("UPDATE public.reservations SET stock_dimension_id = $2 WHERE id = $1", [r.id, sevk]);
    await adm.query("UPDATE public.reservations SET quantity = 1 WHERE id = $1", [r.id]);
    const consumed = (await q<{ id: string }>(
      "INSERT INTO public.reservations (tenant_id, stock_dimension_id, order_line_id, quantity) VALUES ($1,$2,$3,3) RETURNING id", [A.tenantId, sevk, a.lineId]))[0] as { id: string };
    await adm.query("UPDATE public.reservations SET status = 'CONSUMED' WHERE id = $1", [consumed.id]);
    await adm.query("UPDATE public.stock_balances SET reserved_quantity = reserved_quantity - 4 WHERE tenant_id=$1 AND stock_dimension_id=$2", [A.tenantId, r01]);
    await adm.query("UPDATE public.stock_balances SET reserved_quantity = reserved_quantity + 1 WHERE tenant_id=$1 AND stock_dimension_id=$2", [A.tenantId, sevk]);
    await adm.query("UPDATE public.sales_order_lines SET shipped_quantity = 3, returned_quantity = 1 WHERE id = $1", [a.lineId]);
    await adm.query("COMMIT");
  } catch (e) {
    await adm.query("ROLLBACK");
    throw e;
  }
}

describe("@AC-40 Senaryo D adım 4–5 (X 18 @R-01; Y 9 @R-02 + 1 hasarlı; S1 X5 · S2 X6+Y3 · S3 Y4)", () => {
  it("üç sipariş oluşur (stok etkisi yok); rezervasyon: X rezerve 11 / kullanılabilir 7, Y rezerve 7 / kullanılabilir 2", async () => {
    await setQc(true);
    const X = await mkItem();
    const Y = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const R02 = await mkLoc("STORAGE");
    const SEVK = await mkLoc("STAGING");
    const colsX: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], kul: [KABUL, "AVAILABLE"], r01: [R01, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    const colsY: Record<string, [string, string]> = { kar: [KABUL, "QUARANTINE"], kul: [KABUL, "AVAILABLE"], dmg: [KABUL, "DAMAGED"], r02: [R02, "AVAILABLE"], sevk: [SEVK, "AVAILABLE"] };
    await receiveToShelf(
      [
        { item: X, expected: "20", received: "18", shelf: R01, putQty: "18" },
        { item: Y, expected: "10", received: "10", damaged: "1", shelf: R02, putQty: "9" },
      ],
      KABUL,
    );
    await expectRow(X, colsX, { r01: 18, fiz: 18, rez: 0, kullan: 18 }, "X adım 3");
    await expectRow(Y, colsY, { dmg: 1, r02: 9, fiz: 10, rez: 0, kullan: 9 }, "Y adım 3");
    const lx = await ledgerCount(X);
    const ly = await ledgerCount(Y);

    // 4. S1, S2, S3 oluşur: tablolar değişmez
    const s1 = await mkOrder([{ item: X, qty: "5" }]);
    const s2 = await mkOrder([{ item: X, qty: "6" }, { item: Y, qty: "3" }]);
    const s3 = await mkOrder([{ item: Y, qty: "4" }]);
    await expectRow(X, colsX, { r01: 18, fiz: 18, rez: 0, kullan: 18 }, "X adım 4");
    await expectRow(Y, colsY, { dmg: 1, r02: 9, fiz: 10, rez: 0, kullan: 9 }, "Y adım 4");
    expect(await ledgerCount(X)).toBe(lx);
    expect(await ledgerCount(Y)).toBe(ly);

    // 5. Rezervasyon: S1 X5, S2 X6+Y3, S3 Y4
    await reserveOrder(ownerP(), { orderId: s1.id });
    await reserveOrder(ownerP(), { orderId: s2.id });
    await reserveOrder(ownerP(), { orderId: s3.id });
    await expectRow(X, colsX, { r01: 18, fiz: 18, rez: 11, kullan: 7 }, "X adım 5");
    await expectRow(Y, colsY, { dmg: 1, r02: 9, fiz: 10, rez: 7, kullan: 2 }, "Y adım 5");
    expect(await ledgerCount(X)).toBe(lx);
    expect(await ledgerCount(Y)).toBe(ly);
    const got = async (o: Order, i: number) => (await reservationsOf(o.lineIds[i] as string)).map((r) => [r.location_id, r.stock_status, r.quantity, r.status]);
    expect(await got(s1, 0)).toEqual([[R01, "AVAILABLE", n(5), "ACTIVE"]]);
    expect(await got(s2, 0)).toEqual([[R01, "AVAILABLE", n(6), "ACTIVE"]]);
    expect(await got(s2, 1)).toEqual([[R02, "AVAILABLE", n(3), "ACTIVE"]]);
    expect(await got(s3, 0)).toEqual([[R02, "AVAILABLE", n(4), "ACTIVE"]]);
    expect(await lineTriple(s2.lineIds[1] as string)).toMatchObject({ istenen: n(3), sevk: n(0), acik: n(3) });
  }, 180_000);
});

describe("@AC-08 tahsis kolu: sevke uygun olmayan stok", () => {
  async function plain(label: string, build: (item: string) => Promise<{ loc: string; status: string }>): Promise<void> {
    const X = await mkItem();
    const { loc, status } = await build(X);
    const o = await mkOrder([{ item: X, qty: "2" }]);
    const L = o.lineIds[0] as string;
    const fiz = await physical(X);
    // Öneri yolu: aday yok → satır rezervesiz açık kalır (ret değil), yan etki yok.
    const r = await reserveOrder(ownerP(), { orderId: o.id });
    expect(r.lines, `${label} öneri`).toEqual([{ lineId: L, lineNo: 1, quantity: n(0) }]);
    expect(await activeSum(L), label).toBe(n(0));
    expect(await reservedOf(X), label).toBe(n(0));
    // Elle zorlanırsa INSUFFICIENT_STOCK; hiçbir şey yazılmaz.
    const e = await failure(reserveOrder(ownerP(), { orderId: o.id, overrides: [{ lineId: L, allocations: [{ dimension: { locationId: loc, stockStatus: status as "AVAILABLE" }, quantity: "2" }] }] }));
    expect(codeOf(e), `${label} elle`).toBe("INSUFFICIENT_STOCK");
    expect(await activeSum(L), label).toBe(n(0));
    expect(await reservedOf(X), label).toBe(n(0));
    expect(await physical(X), label).toBe(fiz);
    expect(await audits("reservation.created", o.id), label).toBe(0);
  }
  it("KABUL·KAR (QUARANTINE) rezerve edilemez", () => plain("KAR", async (X) => { const l = await mkLoc("STORAGE"); await stockIn(X, l, "5", "QUARANTINE"); return { loc: l, status: "QUARANTINE" }; }));
  it("DAMAGED rezerve edilemez", () => plain("DMG", async (X) => { const l = await mkLoc("STORAGE"); await stockIn(X, l, "5", "DAMAGED"); return { loc: l, status: "DAMAGED" }; }));
  it("RECEIVING lokasyonundaki AVAILABLE stok rezerve edilemez (KABUL·KUL)", () => plain("KUL", async (X) => { const l = await mkLoc("RECEIVING"); await stockIn(X, l, "5"); return { loc: l, status: "AVAILABLE" }; }));
  it("pick_blocked lokasyon rezerve edilemez (kural 9: yeniden tahsis kullanmaz)", () =>
    plain("PB", async (X) => { const l = await mkLoc("STORAGE"); await stockIn(X, l, "5"); await q("UPDATE public.locations SET pick_blocked = true WHERE id = $1", [l]); return { loc: l, status: "AVAILABLE" }; }));
});

describe("tahsis kuralları", () => {
  it("yetersiz stok ret değildir: kısmi tahsis; sonra stok gelince kalan açık miktar tahsis edilir (kapasite = açık − Σ ACTIVE)", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await stockIn(X, R, "3");
    const o = await mkOrder([{ item: X, qty: "5" }]);
    const L = o.lineIds[0] as string;
    const r1 = await reserveOrder(ownerP(), { orderId: o.id });
    expect(r1.lines).toEqual([{ lineId: L, lineNo: 1, quantity: n(3) }]);
    expect(await activeSum(L)).toBe(n(3));
    expect(await available(X)).toBe(n(0));
    await stockIn(X, R, "10");
    const r2 = await reserveOrder(ownerP(), { orderId: o.id });
    expect(r2.lines).toEqual([{ lineId: L, lineNo: 1, quantity: n(2) }]); // 5 − 3
    expect(await activeSum(L)).toBe(n(5));
    expect(await reservedOf(X)).toBe(n(5));
    expect(await available(X)).toBe(n(8));
    await reservedMatches(X);
  });

  it("A-138: tek boyut yetiyorsa o; eşitlikte lokasyon kodu artan; bir ürünün iki satırı aynı boş stoğu iki kez önermez", async () => {
    const X = await mkItem();
    const b = await mkLoc("STORAGE", `B-${hex(6)}`);
    const a = await mkLoc("STORAGE", `A-${hex(6)}`);
    await stockIn(X, b, "10");
    await stockIn(X, a, "10");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    await reserveOrder(ownerP(), { orderId: o.id });
    expect((await reservationsOf(o.lineIds[0] as string)).map((r) => [r.location_id, r.quantity])).toEqual([[a, n(4)]]);
    // İki satırlı sipariş: 8 + 8; A'da 6 kaldı, B'de 10 → ilk satır B (A yetmez), ikinci satır A'da 6 + B'de 2.
    const o2 = await mkOrder([{ item: X, qty: "8" }, { item: X, qty: "8" }]);
    const r = await reserveOrder(ownerP(), { orderId: o2.id });
    expect(r.lines?.map((l) => l.quantity)).toEqual([n(8), n(8)]);
    expect((await reservationsOf(o2.lineIds[0] as string)).map((x) => [x.location_id, x.quantity])).toEqual([[b, n(8)]]);
    expect((await reservationsOf(o2.lineIds[1] as string)).map((x) => [x.location_id, x.quantity]).sort()).toEqual([[a, n(6)], [b, n(2)]].sort());
    await reservedMatches(X);
  });

  it("elle tahsis (override): sevk alanına (STAGING) tahsis geçerli; açık miktarı aşan elle tahsis VALIDATION_FAILED; yetmeyen INSUFFICIENT_STOCK; yabancı satır VALIDATION_FAILED", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    const S = await mkLoc("STAGING");
    await stockIn(X, R, "5");
    await stockIn(X, S, "2");
    const o = await mkOrder([{ item: X, qty: "3" }]);
    const L = o.lineIds[0] as string;
    const al = (loc: string, qty: string) => ({ dimension: { locationId: loc }, quantity: qty });
    expect(codeOf(await failure(reserveOrder(ownerP(), { orderId: o.id, overrides: [{ lineId: L, allocations: [al(R, "4")] }] })))).toBe("VALIDATION_FAILED"); // 4 > açık 3
    expect(codeOf(await failure(reserveOrder(ownerP(), { orderId: o.id, overrides: [{ lineId: L, allocations: [al(S, "3")] }] })))).toBe("INSUFFICIENT_STOCK"); // STAGING'te 2 var
    expect(codeOf(await failure(reserveOrder(ownerP(), { orderId: o.id, overrides: [{ lineId: uuid(), allocations: [al(R, "1")] }] })))).toBe("VALIDATION_FAILED");
    expect(await reservedOf(X)).toBe(n(0));
    await reserveOrder(ownerP(), { orderId: o.id, overrides: [{ lineId: L, allocations: [al(S, "2"), al(R, "1")] }] });
    expect((await reservationsOf(L)).map((r) => [r.location_id, r.quantity]).sort()).toEqual([[S, n(2)], [R, n(1)]].sort());
    await reservedMatches(X);
  });

  it("izin ve izolasyon: PICKER document.approve ister (FORBIDDEN); başka tenant siparişi görmez (NOT_FOUND)", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await stockIn(X, R, "2");
    const o = await mkOrder([{ item: X, qty: "2" }]);
    expect((await failure(reserveOrder(pickerP(), { orderId: o.id }))).code).toBe("FORBIDDEN");
    expect((await failure(reserveOrder(ownerBP(), { orderId: o.id }))).code).toBe("NOT_FOUND");
    expect((await failure(cancelOrderLine(ownerBP(), { lineId: o.lineIds[0] as string, quantity: "1" }))).code).toBe("NOT_FOUND");
    expect((await failure(cancelSalesOrder(ownerBP(), { orderId: o.id, expectedVersion: 1 }))).code).toBe("NOT_FOUND");
    expect(await reservedOf(X)).toBe(n(0));
  });

  it("anahtarsız komut IDEMPOTENCY_KEY_REQUIRED; aynı anahtar farklı girdi IDEMPOTENCY_MISMATCH", async () => {
    const X = await mkItem();
    const o = await mkOrder([{ item: X, qty: "2" }]);
    expect(codeOf(await failure(reserveOrder(ownerP(null), { orderId: o.id })))).toBe("VALIDATION_FAILED/IDEMPOTENCY_KEY_REQUIRED");
    const key = uuid();
    await cancelOrderLine(ownerP(key), { lineId: o.lineIds[0] as string, quantity: "1" });
    expect((await failure(cancelOrderLine(ownerP(key), { lineId: o.lineIds[0] as string, quantity: "2" }))).code).toBe("IDEMPOTENCY_MISMATCH");
  });
});

describe("sipariş yaşam döngüsü", () => {
  it("createSalesOrder: birim katsayısı uygulanır (KOLI×12 → temel birim), müşteri numarası tekil, ölçek ihlali QUANTITY_SCALE", async () => {
    const X = await mkItem();
    await q("INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1,$2,$3,12)", [A.tenantId, X, A.boxUnitId]);
    const num = `MUS-${hex(8)}`;
    const r = await createSalesOrder(ownerP(), { number: num, lines: [{ itemId: X, unitId: A.boxUnitId, quantity: "2" }, { itemId: X, unitId: A.unitId, quantity: "3" }] });
    expect(r.documentNumber).toBe(num);
    const lines = await q<{ q: string }>("SELECT requested_quantity::text AS q FROM public.sales_order_lines WHERE order_id=$1 ORDER BY line_no", [r.documentId]);
    expect(lines.map((l) => n(l.q))).toEqual([n(24), n(3)]);
    expect(codeOf(await failure(createSalesOrder(ownerP(), { number: num, lines: [{ itemId: X, unitId: A.unitId, quantity: "1" }] })))).toBe("VALIDATION_FAILED/CODE_TAKEN");
    expect(codeOf(await failure(createSalesOrder(ownerP(), { lines: [{ itemId: X, unitId: A.unitId, quantity: "1.5" }] })))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect((await failure(createSalesOrder(ownerP(), { lines: [] }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(createSalesOrder(ownerP(), { lines: [{ itemId: X, unitId: A.unitId, quantity: "0" }] }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(createSalesOrder(pickerP(), { lines: [{ itemId: X, unitId: A.unitId, quantity: "1" }] }))).code).toBe("FORBIDDEN");
  });

  it("updateDraftOrder: yalnız taslakta (rezervasyon/iptal yoksa); sürüm kontrolü; satır ekleme/miktar değişimi", async () => {
    const X = await mkItem();
    const Y = await mkItem();
    const R = await mkLoc("STORAGE");
    await stockIn(X, R, "5");
    const o = await mkOrder([{ item: X, qty: "2" }]);
    const L = o.lineIds[0] as string;
    const v1 = (await orderRow(o.id)).version;
    expect((await failure(updateDraftOrder(ownerP(), { orderId: o.id, expectedVersion: v1 + 5, customerRef: "x" }))).code).toBe("VERSION_CONFLICT");
    await updateDraftOrder(ownerP(), { orderId: o.id, expectedVersion: v1, customerRef: "GUNCEL", changes: [{ lineId: L, quantity: "3" }], addLines: [{ itemId: Y, unitId: A.unitId, quantity: "4" }] });
    expect((await orderRow(o.id)).version).toBe(v1 + 1);
    const lines = await q<{ id: string; q: string; line_no: number }>("SELECT id, requested_quantity::text AS q, line_no FROM public.sales_order_lines WHERE order_id=$1 ORDER BY line_no", [o.id]);
    expect(lines.map((l) => [l.line_no, n(l.q)])).toEqual([[1, n(3)], [2, n(4)]]);
    expect(await audits("sales_order.updated", o.id)).toBe(1);
    // Başka siparişin satırı bu siparişte değiştirilemez (kaynak bağlantısı kilit altında): NOT_FOUND, sessiz no-op yok.
    const other = await mkOrder([{ item: X, qty: "1" }]);
    expect((await failure(updateDraftOrder(ownerP(), { orderId: o.id, expectedVersion: v1 + 1, changes: [{ lineId: other.lineIds[0] as string, quantity: "9" }] }))).code).toBe("NOT_FOUND");
    expect(n((await lineRow(other.lineIds[0] as string)).req)).toBe(n(1));
    // Rezervasyon sonrası taslak değildir.
    await reserveOrder(ownerP(), { orderId: o.id });
    expect(codeOf(await failure(updateDraftOrder(ownerP(), { orderId: o.id, expectedVersion: v1 + 1, customerRef: "yine" })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
  });

  it("cancelOrderLine: tahsis açık miktarı aşmıyorsa serbest bırakma yok; aşan kısım serbest kalır (toplanmamış pay önce); açık 0 → sipariş kapanır (hiç sevk yok → CANCELLED)", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    const S = await mkLoc("STAGING");
    await stockIn(X, R, "3");
    await stockIn(X, S, "2");
    const o = await mkOrder([{ item: X, qty: "6" }]);
    const L = o.lineIds[0] as string;
    const al = (loc: string, qty: string) => ({ dimension: { locationId: loc }, quantity: qty });
    await reserveOrder(ownerP(), { orderId: o.id, overrides: [{ lineId: L, allocations: [al(R, "3"), al(S, "2")] }] });
    expect(await activeSum(L)).toBe(n(5)); // açık 6, tahsis 5
    // 1 iptal → açık 5 ≥ tahsis 5: serbest bırakma YOK, görev YOK.
    const c1 = await cancelOrderLine(ownerP(), { lineId: L, quantity: "1" });
    expect(c1.reservationIds).toEqual([]);
    expect(await activeSum(L)).toBe(n(5));
    expect(await tasksOfOrder(o.id)).toHaveLength(0);
    // 2 iptal → açık 3 < tahsis 5: 2 serbest; önce toplanmamış (R-01) pay; STAGING'e dokunulmaz → görev yok.
    await cancelOrderLine(ownerP(), { lineId: L, quantity: "2" });
    expect(await activeSum(L)).toBe(n(3));
    expect((await reservationsOf(L)).filter((r) => r.status === "ACTIVE").map((r) => [r.location_id, r.quantity]).sort()).toEqual([[R, n(1)], [S, n(2)]].sort());
    expect(await tasksOfOrder(o.id)).toHaveLength(0);
    // Fazla iptal (açık 3'ten büyük) reddedilir.
    expect((await failure(cancelOrderLine(ownerP(), { lineId: L, quantity: "4" }))).code).toBe("VALIDATION_FAILED");
    // Kalan 3 iptal → tümü serbest; STAGING'teki 2 için REPUTAWAY; sipariş CANCELLED (sevk yok).
    await cancelOrderLine(ownerP(), { lineId: L, quantity: "3" });
    expect(await activeSum(L)).toBe(n(0));
    const tasks = await tasksOfOrder(o.id);
    expect(tasks.map((t) => [t.kind, t.location_id, t.quantity, t.status])).toEqual([["REPUTAWAY", S, n(2), "OPEN"]]);
    expect(await orderRow(o.id)).toMatchObject({ status: "CANCELLED" });
    expect(await reservedOf(X)).toBe(n(0));
    expect(await physical(X)).toBe(n(5)); // fiziksel stok yerinde (kural 7)
    await reservedMatches(X);
  });

  it("cancelSalesOrder: tüm tahsis serbest, STAGING'teki mal için görev, satırlar iptal, CANCELLED; sevk varsa DOCUMENT_STATE; tekrar DOCUMENT_STATE; sürüm kontrolü", async () => {
    const X = await mkItem();
    const Y = await mkItem();
    const R = await mkLoc("STORAGE");
    const S = await mkLoc("STAGING");
    await stockIn(X, R, "4");
    await stockIn(Y, S, "3");
    const o = await mkOrder([{ item: X, qty: "4" }, { item: Y, qty: "3" }]);
    await reserveOrder(ownerP(), { orderId: o.id });
    expect(await reservedOf(X)).toBe(n(4));
    expect(await reservedOf(Y)).toBe(n(3));
    const v = (await orderRow(o.id)).version;
    expect((await failure(cancelSalesOrder(ownerP(), { orderId: o.id, expectedVersion: v + 1 }))).code).toBe("VERSION_CONFLICT");
    const r = await cancelSalesOrder(ownerP(), { orderId: o.id, expectedVersion: v, reason: "iptal" });
    expect(r.status).toBe("CANCELLED");
    expect(await orderRow(o.id)).toMatchObject({ status: "CANCELLED" });
    expect(await reservedOf(X)).toBe(n(0));
    expect(await reservedOf(Y)).toBe(n(0));
    expect(await physical(X)).toBe(n(4));
    expect(await physical(Y)).toBe(n(3));
    const tasks = await tasksOfOrder(o.id);
    expect(tasks.map((t) => [t.kind, t.item_id, t.location_id, t.quantity])).toEqual([["REPUTAWAY", Y, S, n(3)]]);
    expect((await lineRow(o.lineIds[0] as string)).can).toBe(n(4));
    expect(await audits("sales_order.cancelled", o.id)).toBe(1);
    expect(codeOf(await failure(cancelSalesOrder(ownerP(), { orderId: o.id, expectedVersion: v + 1 })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    // Sevk yapılmış sipariş tümden iptal edilemez (kalan satırlar cancelOrderLine ile).
    const o2 = await mkOrder([{ item: X, qty: "2" }]);
    await q("UPDATE public.sales_order_lines SET shipped_quantity = 1 WHERE id = $1", [o2.lineIds[0]]);
    expect(codeOf(await failure(cancelSalesOrder(ownerP(), { orderId: o2.id, expectedVersion: 1 })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
  });
});

describe("eşzamanlılık (bariyerli, olasılıksız)", () => {
  it("iki sipariş aynı son stoğa eşzamanlı: biri tahsisli, öteki tahsissiz (ret değil); çift tahsis yok", async () => {
    // Bariyer: ayrı bağlantı bakiye satırını FOR UPDATE tutar; iki komut da planı (kilitsiz) bitirip bakiye kilidinde BLOKLANANA dek serbest bırakılmaz.
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await stockIn(X, R, "3");
    const o1 = await mkOrder([{ item: X, qty: "3" }]);
    const o2 = await mkOrder([{ item: X, qty: "3" }]);
    const hold = new pg.Client({ connectionString: env.databaseUrlDirect });
    hold.on("error", () => undefined);
    await hold.connect();
    try {
      const pid = Number((await hold.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]?.p);
      await hold.query("BEGIN");
      await hold.query(
        `SELECT 1 FROM public.stock_balances b JOIN public.stock_dimensions d ON d.tenant_id=b.tenant_id AND d.id=b.stock_dimension_id
          WHERE d.tenant_id=$1 AND d.item_id=$2 FOR UPDATE OF b`, [A.tenantId, X]);
      const p1 = reserveOrder(ownerP(uuid(), { retry: ONCE }), { orderId: o1.id });
      const p2 = reserveOrder(ownerP(uuid(), { retry: ONCE }), { orderId: o2.id });
      await untilBlocked(pid, 2);
      await hold.query("COMMIT");
      const [r1, r2] = await Promise.all([p1, p2]);
      const q1 = Number(r1.lines?.[0]?.quantity);
      const q2 = Number(r2.lines?.[0]?.quantity);
      expect([q1, q2].sort()).toEqual([0, 3]); // tam olarak biri tahsisli
      expect(await reservedOf(X)).toBe(n(3));
      expect(await available(X)).toBe(n(0));
      expect(Number(await activeSum(o1.lineIds[0] as string)) + Number(await activeSum(o2.lineIds[0] as string))).toBe(3);
      await reservedMatches(X);
      // Kaybeden sipariş açık kalır; stok gelince tahsis edilir.
      await stockIn(X, R, "3");
      const loser = q1 === 0 ? o1 : o2;
      expect((await reserveOrder(ownerP(), { orderId: loser.id })).lines?.[0]?.quantity).toBe(n(3));
      await reservedMatches(X);
    } finally {
      await hold.query("ROLLBACK").catch(() => undefined);
      await hold.end();
    }
  }, 120_000);

  it("aynı siparişin iki satır komutu eşzamanlı: başlık FOR UPDATE ile seri, 40P01 yok, sipariş durumu doğru (Supervisor notu 1)", async () => {
    const X = await mkItem();
    const o = await mkOrder([{ item: X, qty: "2" }, { item: X, qty: "3" }]);
    const hold = new pg.Client({ connectionString: env.databaseUrlDirect });
    hold.on("error", () => undefined);
    await hold.connect();
    try {
      const pid = Number((await hold.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]?.p);
      await hold.query("BEGIN");
      await hold.query("SELECT 1 FROM public.sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [A.tenantId, o.id]);
      const p1 = cancelOrderLine(ownerP(uuid(), { retry: ONCE }), { lineId: o.lineIds[0] as string, quantity: "2" });
      const p2 = cancelOrderLine(ownerP(uuid(), { retry: ONCE }), { lineId: o.lineIds[1] as string, quantity: "3" });
      await untilBlocked(pid, 2); // ikisi de başlık kilidinde: başlık kilidi satır yazımından ÖNCE alınıyor
      await hold.query("COMMIT");
      await Promise.all([p1, p2]); // 40P01 olsaydı ONCE ile reddedilirdi
      expect(await orderRow(o.id)).toMatchObject({ status: "CANCELLED" }); // son iptal siparişi kapatır: bayat okuma olsaydı OPEN kalırdı
      expect((await lineRow(o.lineIds[0] as string)).can).toBe(n(2));
      expect((await lineRow(o.lineIds[1] as string)).can).toBe(n(3));
    } finally {
      await hold.query("ROLLBACK").catch(() => undefined);
      await hold.end();
    }
  }, 120_000);

  it("reserveOrder ile cancelSalesOrder eşzamanlı (aynı sipariş): bariyerle GERÇEKTEN örtüşür, seri çalışır, deadlock yok, rezerve = Σ ACTIVE", async () => {
    const X = await mkItem();
    const R = await mkLoc("STORAGE");
    await stockIn(X, R, "6");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    const L = o.lineIds[0] as string;
    await reserveOrder(ownerP(), { orderId: o.id, overrides: [{ lineId: L, allocations: [{ dimension: { locationId: R }, quantity: "2" }] }] });
    const v = (await orderRow(o.id)).version;
    const hold = new pg.Client({ connectionString: env.databaseUrlDirect });
    hold.on("error", () => undefined);
    await hold.connect();
    try {
      const pid = Number((await hold.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]?.p);
      await hold.query("BEGIN");
      // İki komut da planı bitirip (kilitsiz) bloklanana dek bırakılmaz: biri başlık kilidinde, öteki ortak bakiye/rezervasyon kilidinde bekler.
      await hold.query("SELECT 1 FROM public.sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [A.tenantId, o.id]);
      const p1 = reserveOrder(ownerP(uuid(), { retry: ONCE }), { orderId: o.id });
      const p2 = cancelSalesOrder(ownerP(uuid(), { retry: ONCE }), { orderId: o.id, expectedVersion: v });
      await untilBlocked(pid, 2);
      await hold.query("COMMIT");
      const settled = await Promise.allSettled([p1, p2]);
      for (const st of settled) {
        if (st.status === "rejected") expect(["VERSION_CONFLICT", "VALIDATION_FAILED"]).toContain((st.reason as AppError).code); // iş kuralı reddi; 40P01/INTERNAL değil
      }
      expect(settled.some((st) => st.status === "fulfilled")).toBe(true);
      expect(await reservedOf(X)).toBe(await activeSum(L));
      await reservedMatches(X);
    } finally {
      await hold.query("ROLLBACK").catch(() => undefined);
      await hold.end();
    }
  }, 120_000);
});

describe("depo kapsamı (T-306 MAJOR-1; flag WAREHOUSE_SCOPE_ENABLED)", () => {
  afterAll(async () => {
    delete process.env.WAREHOUSE_SCOPE_ENABLED;
    await adm.query("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = $1 AND membership_id <> $2", [A.tenantId, A.ownerMembershipId]);
  });
  it("kapsamlı yönetici yalnızca kendi deposundan tahsis alır; kapsam dışı stok önerilmez/sızmaz; replay saklı sonucu döner; kapsamsız yönetici öteki depodan alır", async () => {
    const WB = uuid();
    await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,$3,'T306 depo B')", [A.tenantId, WB, `W${hex(6)}`]);
    const mgrUser = await mkUser(adm, reg, "A306 mgr");
    const mgrMembership = await mkMembership(adm, A.tenantId, mgrUser, { roles: ["WAREHOUSE_MANAGER"] });
    const free = await mkUser(adm, reg, "A306 mgr2");
    await mkMembership(adm, A.tenantId, free, { roles: ["WAREHOUSE_MANAGER"] }); // kapsam satırı yok → kısıtsız
    await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, mgrMembership, A.warehouseId]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const mgr = (key: string = uuid()) => callP(A, mgrUser, key, {});
    const X = await mkItem();
    // B deposu: daha çok stok ve alfabetik olarak önde (A-138 tek başına B'yi seçerdi); A deposu: yetecek kadar.
    const inB = await mkLoc("STORAGE", `0B-${hex(6)}`, WB);
    const inA = await mkLoc("STORAGE", `Z-${hex(6)}`);
    await stockIn(X, inB, "10", "AVAILABLE", WB);
    await stockIn(X, inA, "5");
    const o = await mkOrder([{ item: X, qty: "4" }]);
    const L = o.lineIds[0] as string;
    const key = uuid();
    const r1 = await reserveOrder(mgr(key), { orderId: o.id });
    expect(r1.lines).toEqual([{ lineId: L, lineNo: 1, quantity: n(4) }]);
    expect((await reservationsOf(L)).map((r) => [r.location_id, r.quantity])).toEqual([[inA, n(4)]]);
    expect(await bal(X, inB, "AVAILABLE")).toBe(n(10));
    expect(Number(await reservedOf(X))).toBe(4);
    // Replay: saklı sonuç (FORBIDDEN/yeni tahsis değil).
    const r2 = await reserveOrder(mgr(key), { orderId: o.id });
    expect(r2.replayed).toBe(true);
    expect(r2.lines).toEqual(r1.lines);
    expect(await activeSum(L)).toBe(n(4));
    // Kapsam dışı depoda stok olsa bile öneri yok: yalnızca B'de stoğu olan ürün için tahsissiz kalır, hata/sızıntı yok.
    const Y = await mkItem();
    await stockIn(Y, await mkLoc("STORAGE", `0Y-${hex(6)}`, WB), "5", "AVAILABLE", WB);
    const oy = await mkOrder([{ item: Y, qty: "2" }]);
    expect((await reserveOrder(mgr(), { orderId: oy.id })).lines).toEqual([{ lineId: oy.lineIds[0] as string, lineNo: 1, quantity: n(0) }]);
    expect(await reservedOf(Y)).toBe(n(0));
    // Elle B deposuna tahsis → FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE (açık kapsam ihlali).
    const e = await failure(reserveOrder(mgr(), { orderId: oy.id, overrides: [{ lineId: oy.lineIds[0] as string, allocations: [{ dimension: { locationId: (await q<{ id: string }>("SELECT id FROM public.locations WHERE warehouse_id=$1 LIMIT 1", [WB]))[0]?.id as string }, quantity: "2" }] }] }));
    expect(codeOf(e)).toBe("FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE");
    // Kısıtsız yönetici (kapsam satırı yok) aynı ürünü B deposundan alır: süzgeç gerçekten kapsamdan geliyor.
    const unrestricted = callP(A, free, uuid(), {});
    expect((await reserveOrder(unrestricted, { orderId: oy.id })).lines).toEqual([{ lineId: oy.lineIds[0] as string, lineNo: 1, quantity: n(2) }]);
  }, 120_000);
});

describe("sipariş numarası çakışması (T-306 MAJOR-2, MINOR-1)", () => {
  const setup = async (skips: number): Promise<void> => {
    await adm.query("CREATE TABLE public.t306_skip (n int NOT NULL)");
    await adm.query("INSERT INTO public.t306_skip VALUES ($1)", [skips]);
    await adm.query("GRANT SELECT, UPDATE ON public.t306_skip TO PUBLIC");
    await adm.query(`CREATE FUNCTION public.t306_skip_number() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.number LIKE 'SIP-%' AND (SELECT n FROM public.t306_skip) > 0 THEN
          UPDATE public.t306_skip SET n = n - 1;
          RETURN NULL; -- ON CONFLICT DO NOTHING ile aynı gözlenebilir sonuç: satır eklenmedi
        END IF;
        RETURN NEW;
      END $fn$`);
    await adm.query("CREATE TRIGGER t306_skip_number BEFORE INSERT ON public.sales_orders FOR EACH ROW EXECUTE FUNCTION public.t306_skip_number()");
  };
  const teardown = async (): Promise<void> => {
    await adm.query("DROP TRIGGER IF EXISTS t306_skip_number ON public.sales_orders");
    await adm.query("DROP FUNCTION IF EXISTS public.t306_skip_number()");
    await adm.query("DROP TABLE IF EXISTS public.t306_skip");
  };
  it("üretilen numara çakışırsa aynı transaction'da yeni numarayla başarır; sınır aşılırsa kalıcı ret yazılmaz (aynı anahtar sonra başarılı)", async () => {
    const X = await mkItem();
    await setup(2);
    try {
      const r = await createSalesOrder(ownerP(), { lines: [{ itemId: X, unitId: A.unitId, quantity: "1" }] });
      expect(r.documentNumber).toMatch(/^SIP-\d{4}-[0-9A-F]{8}$/);
      expect((await q("SELECT 1 FROM public.sales_orders WHERE id=$1", [r.documentId])).length).toBe(1);
      await adm.query("UPDATE public.t306_skip SET n = 5"); // 5 deneme de çakışır
      const key = uuid();
      expect((await failure(createSalesOrder(ownerP(key), { lines: [{ itemId: X, unitId: A.unitId, quantity: "1" }] }))).code).toBe("INTERNAL");
      await adm.query("UPDATE public.t306_skip SET n = 0");
      const again = await createSalesOrder(ownerP(key), { lines: [{ itemId: X, unitId: A.unitId, quantity: "1" }] });
      expect(again.replayed).toBe(false); // ret anahtara yazılmamıştı
      expect(again.documentNumber).toMatch(/^SIP-/);
      // Müşteri numarası ise (tetikleyici yalnızca SIP- üretilenleri atlar) çakışma CODE_TAKEN kalır.
    } finally {
      await teardown();
    }
  });
  it("aynı müşteri numarasıyla eşzamanlı iki oluşturma: biri başarılı, öteki CODE_TAKEN (INTERNAL/23505 değil)", async () => {
    const X = await mkItem();
    const num = `MUS-${hex(10)}`;
    const hold = new pg.Client({ connectionString: env.databaseUrlDirect });
    hold.on("error", () => undefined);
    await hold.connect();
    try {
      const pid = Number((await hold.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]?.p);
      await hold.query("BEGIN");
      await hold.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      await hold.query("INSERT INTO public.sales_orders (tenant_id, id, number, created_by) VALUES ($1,$2,$3,$4)", [A.tenantId, uuid(), num, A.ownerUserId]);
      const mk = () => createSalesOrder(ownerP(uuid(), { retry: ONCE }), { number: num, lines: [{ itemId: X, unitId: A.unitId, quantity: "1" }] });
      const p1 = mk();
      const p2 = mk();
      await untilBlocked(pid, 2); // ikisi de eklenmemiş (bekleyen) aynı numaranın dizin girdisinde
      await hold.query("ROLLBACK"); // numara boşalır: tam olarak biri kazanır
      const settled = await Promise.allSettled([p1, p2]);
      const ok = settled.filter((x) => x.status === "fulfilled");
      const bad = settled.filter((x): x is PromiseRejectedResult => x.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(codeOf(bad[0]?.reason as AppError)).toBe("VALIDATION_FAILED/CODE_TAKEN");
      expect((await q("SELECT 1 FROM public.sales_orders WHERE tenant_id=$1 AND number=$2", [A.tenantId, num])).length).toBe(1);
    } finally {
      await hold.query("ROLLBACK").catch(() => undefined);
      await hold.end();
    }
  }, 120_000);
});
