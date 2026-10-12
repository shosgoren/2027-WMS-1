// Sipariş okuma sorguları (T-314a; T-313 `receiving-queries.ts` deseni). Hepsi `runTenantQuery` + `stock.view` (mal kabul okumalarıyla aynı okuma izni;
// sipariş yazma komutları `document.create/approve` ister, okuma yalnızca görüntülemedir); `tenant_id` yalnızca doğrulanmış üyelikten gelir ve her
// sorguda AÇIK süzgeçtir (RLS ikinci savunma). Keyset (created_at, id), OFFSET yok (I-14); imleç biçimi ve takvim zamanı doğrulanır; `limit` üst sınırlıdır.
// Yazma yok, kilit yok, yeni tablo yok: her miktar mevcut tablolardan türetilir (numeric → metin, I-09; yuvarlama yok).
//
// Depo kapsamı (A-46): `sales_orders` satırında depo sütunu YOKTUR. Siparişin deposu, siparişe bağlı kayıtlardan türetilir: (a) rezervasyonunun
// (her durumda) boyutundaki lokasyonun deposu, (b) `warehouse_tasks` (source_kind = SALES_ORDER) deposu. Kapsam AÇIKKEN (resolveWarehouseScope ≠ null)
// sipariş yalnızca bu depolardan EN AZ BİRİ kapsamdaysa görünür; hiçbir bağı olmayan (henüz tahsis/görev yok) sipariş kapsamlı kullanıcıya
// GÖRÜNMEZ (fail-closed, A-314a-2). Liste süzgeçle, tekil okuma aynı koşulla çalışır; yok / başka tenant / kapsam dışı AYNI tek sorgu + aynı `NOT_FOUND`
// yolundan geçer (yanıt, sorgu sayısı ve yan etki farkı yok).
//
// A-xx (docs/OPEN_QUESTIONS.md): A-314a-1 miktar tanımları (aşağıda `SalesOrderLineView`); A-314a-2 kapsam kuralı (yukarıda); A-314a-3 sıralama eskiden yeniye.
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery } from "../identity/access.ts";
import { pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import { isCalendarTime, type TaskCallParams } from "./tasks.ts";

export const SALES_ORDER_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];
export const ORDER_LIST_LIMIT_DEFAULT = 30;
export const ORDER_LIST_LIMIT_MAX = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface SalesOrderListItem {
  readonly id: string;
  readonly number: string;
  readonly customerRef: string | null;
  readonly status: SalesOrderStatus;
  readonly version: number;
  /** Oluşturma zamanı, UTC, mikrosaniye (imleç anahtarı ile aynı biçim). */
  readonly createdKey: string;
  readonly lineCount: number;
  /** Açık miktarı > 0 olan satır sayısı (açık = istenen − sevk − iptal; A-314a-1). */
  readonly openLineCount: number;
}
export interface SalesOrderCursor {
  readonly createdKey: string;
  readonly id: string;
}
export interface SalesOrderPage {
  readonly items: readonly SalesOrderListItem[];
  readonly next: SalesOrderCursor | null;
}
export interface SalesOrderLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  /** Miktarların birimi: ürünün TEMEL birimi (satır miktarı temel birime çevrilerek saklanır, A-151). */
  readonly unitId: string;
  readonly unitCode: string;
  readonly unitName: string;
  /** Ondalık dizgiler (numeric(20,6) metni, örn. "4.000000"; float yok, I-09). */
  readonly requested: string;
  /** Σ ACTIVE rezervasyon (toplananlar dahil; sevk edilince CONSUMED olur ve düşer). */
  readonly allocated: string;
  /** Σ ACTIVE rezervasyonun SEVK alanında (STAGING lokasyonu) olan kısmı = toplanmış, sevki bekleyen (A-314a-1). */
  readonly picked: string;
  readonly shipped: string;
  /** istenen − sevk − iptal (A-306-4/A-140; iade girmez, 16 kural 6). */
  readonly open: string;
  readonly returned: string;
  readonly cancelled: string;
}
export interface SalesOrderDetail extends SalesOrderListItem {
  readonly lines: readonly SalesOrderLineView[];
}

type ListDbRow = {
  id: string;
  number: string;
  customer_ref: string | null;
  status: SalesOrderStatus;
  version: number | string;
  created_key: string;
  line_count: number | string;
  open_line_count: number | string;
};
type LineDbRow = {
  id: string;
  line_no: number | string;
  item_id: string;
  item_code: string;
  item_name: string;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  requested: string;
  allocated: string;
  picked: string;
  shipped: string;
  open: string;
  returned: string;
  cancelled: string;
};

const uuid = (raw: unknown): string => {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
};
function cursorOf(raw: SalesOrderCursor | undefined): { key: string; id: string } | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null) throw new AppError("VALIDATION_FAILED");
  if (typeof raw.createdKey !== "string" || !CURSOR_TIME_RE.test(raw.createdKey) || !isCalendarTime(raw.createdKey)) throw new AppError("VALIDATION_FAILED");
  return { key: raw.createdKey, id: uuid(raw.id) };
}
function limitOf(raw: number | undefined): number {
  if (raw === undefined) return ORDER_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(raw) || raw < 1 || raw > ORDER_LIST_LIMIT_MAX) throw new AppError("VALIDATION_FAILED");
  return raw;
}
const toListItem = (r: ListDbRow): SalesOrderListItem => ({
  id: r.id,
  number: r.number,
  customerRef: r.customer_ref,
  status: r.status,
  version: Number(r.version),
  createdKey: r.created_key,
  lineCount: Number(r.line_count),
  openLineCount: Number(r.open_line_count),
});

const CREATED_KEY = sql`to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const LINE_COUNTS = sql`SELECT count(*) AS line_count,
         count(*) FILTER (WHERE x.requested_quantity - x.shipped_quantity - x.cancelled_quantity > 0) AS open_line_count
    FROM public.sales_order_lines x
   WHERE x.tenant_id = o.tenant_id AND x.order_id = o.id`;

/** Kapsam koşulu (yalnızca kapsam AÇIKKEN anlamlı): bkz. dosya başı. `scope === null` → koşul kendiliğinden doğru. */
function visibleSql(scope: readonly string[] | null) {
  const ids = pgUuidArray(scope ?? []);
  return sql`(${scope === null}::boolean OR EXISTS (
      SELECT 1 FROM public.sales_order_lines vl
        JOIN public.reservations vr ON vr.tenant_id = vl.tenant_id AND vr.order_line_id = vl.id
        JOIN public.stock_dimensions vd ON vd.tenant_id = vr.tenant_id AND vd.id = vr.stock_dimension_id
        JOIN public.locations vloc ON vloc.tenant_id = vd.tenant_id AND vloc.id = vd.location_id
       WHERE vl.tenant_id = o.tenant_id AND vl.order_id = o.id AND vloc.warehouse_id = ANY(${ids}::uuid[]))
    OR EXISTS (
      SELECT 1 FROM public.warehouse_tasks vt
       WHERE vt.tenant_id = o.tenant_id AND vt.source_kind = 'SALES_ORDER' AND vt.source_id = o.id AND vt.warehouse_id = ANY(${ids}::uuid[])))`;
}

export interface ListSalesOrdersInput {
  readonly status?: SalesOrderStatus;
  /** Önceki sayfanın `next` değeri. */
  readonly afterKey?: SalesOrderCursor;
  readonly limit?: number;
}

/** Sipariş listesi: eskiden yeniye (created_at, id), keyset; kapsam dışı siparişler görünmez. */
export async function listSalesOrders(params: TaskCallParams, input: ListSalesOrdersInput = {}): Promise<SalesOrderPage> {
  const limit = limitOf(input.limit);
  const cur = cursorOf(input.afterKey);
  const status = input.status ?? null;
  if (status !== null && !(SALES_ORDER_STATUSES as readonly string[]).includes(status)) throw new AppError("VALIDATION_FAILED");
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const rows = await tx.execute<ListDbRow>(
      sql`SELECT o.id, o.number, o.customer_ref, o.status, o.version, ${CREATED_KEY} AS created_key, c.line_count, c.open_line_count
            FROM public.sales_orders o
            CROSS JOIN LATERAL (${LINE_COUNTS}) c
           WHERE o.tenant_id = ${m.tenantId}::uuid
             AND (${status}::text IS NULL OR o.status = ${status}::text)
             AND ${visibleSql(scope)}
             AND (${cur === null}::boolean OR (o.created_at, o.id) > (${cur?.key ?? "1970-01-01T00:00:00.000000Z"}::timestamptz, ${cur?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
           ORDER BY o.created_at, o.id
           LIMIT ${limit + 1}`,
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items: items.map(toListItem), next: rows.length > limit && last !== undefined ? { createdKey: last.created_key, id: last.id } : null };
  });
}

/** Tek sipariş: başlık + satır başına miktar dökümü. Yok / başka tenant / kapsam dışı → AYNI `NOT_FOUND`. */
export async function getSalesOrder(params: TaskCallParams, input: { readonly orderId: string }): Promise<SalesOrderDetail> {
  const orderId = uuid(input.orderId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    // Varlık ve görünürlük TEK sorguda: yok ile kapsam dışı ayırt edilemez.
    const heads = await tx.execute<ListDbRow>(
      sql`SELECT o.id, o.number, o.customer_ref, o.status, o.version, ${CREATED_KEY} AS created_key, c.line_count, c.open_line_count
            FROM public.sales_orders o
            CROSS JOIN LATERAL (${LINE_COUNTS}) c
           WHERE o.tenant_id = ${m.tenantId}::uuid AND o.id = ${orderId}::uuid AND ${visibleSql(scope)}`,
    );
    const head = heads[0];
    if (head === undefined) throw new AppError("NOT_FOUND");
    const lines = await tx.execute<LineDbRow>(
      sql`SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name, u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
                 l.requested_quantity::text AS requested,
                 COALESCE(rs.allocated, 0)::numeric(20, 6)::text AS allocated,
                 COALESCE(rs.picked, 0)::numeric(20, 6)::text AS picked,
                 l.shipped_quantity::text AS shipped,
                 (l.requested_quantity - l.shipped_quantity - l.cancelled_quantity)::text AS open,
                 l.returned_quantity::text AS returned,
                 l.cancelled_quantity::text AS cancelled
            FROM public.sales_order_lines l
            JOIN public.items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
            JOIN public.units u ON u.tenant_id = i.tenant_id AND u.id = i.base_unit_id
            LEFT JOIN LATERAL (
              SELECT sum(r.quantity) AS allocated, sum(r.quantity) FILTER (WHERE loc.kind = 'STAGING') AS picked
                FROM public.reservations r
                JOIN public.stock_dimensions d ON d.tenant_id = r.tenant_id AND d.id = r.stock_dimension_id
                JOIN public.locations loc ON loc.tenant_id = d.tenant_id AND loc.id = d.location_id
               WHERE r.tenant_id = l.tenant_id AND r.order_line_id = l.id AND r.status = 'ACTIVE') rs ON true
           WHERE l.tenant_id = ${m.tenantId}::uuid AND l.order_id = ${orderId}::uuid
           ORDER BY l.line_no`,
    );
    return {
      ...toListItem(head),
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: Number(l.line_no),
        itemId: l.item_id,
        itemCode: l.item_code,
        itemName: l.item_name,
        unitId: l.unit_id,
        unitCode: l.unit_code,
        unitName: l.unit_name,
        requested: l.requested,
        allocated: l.allocated,
        picked: l.picked,
        shipped: l.shipped,
        open: l.open,
        returned: l.returned,
        cancelled: l.cancelled,
      })),
    };
  });
}
