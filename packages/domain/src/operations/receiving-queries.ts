// Mal kabul okuma sorguları (T-313; T-304 liste deseni). Hepsi `runTenantQuery` + `stock.view`; `tenant_id` yalnızca doğrulanmış üyelikten
// gelir ve her sorguda AÇIK süzgeçtir (RLS ikinci savunma). Depo kapsamı (A-46): liste kapsam süzgeciyle, tekil okuma `assertWarehouseVisible`
// ile (kapsam dışı/başka tenant kimliği `NOT_FOUND`, varlık sızmaz). Keyset (created_at, id), OFFSET yok (I-14); imleç biçimi ve takvim
// zamanı T-272 gibi doğrulanır (`isCalendarTime`); `limit` zorunlu üst sınırlıdır. Yazma yok; stok kuralı yok (kalan miktar yalnızca gösterim).
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery } from "../identity/access.ts";
import { assertWarehouseVisible, pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import { isCalendarTime, type TaskCallParams } from "./tasks.ts";

export const RECEIPT_STATUSES = ["DRAFT", "OPEN", "CLOSED", "CANCELLED"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const RECEIPT_LIST_LIMIT_DEFAULT = 30;
export const RECEIPT_LIST_LIMIT_MAX = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface ReceiptLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitId: string;
  readonly unitCode: string;
  /** Kullanıcıya gösterilecek birim adı (kod ikincil). */
  readonly unitName: string;
  /** Ondalık dizgiler (satır biriminde; float yok, I-09). */
  readonly expected: string;
  readonly received: string;
  readonly damaged: string;
  /** Gösterim: max(beklenen − kabul, 0). Fazla kabul kuralı komuttadır (receiveGoods). */
  readonly open: string;
}
export interface ReceiptView {
  readonly id: string;
  readonly warehouseId: string;
  readonly number: string;
  readonly supplierRef: string | null;
  readonly status: ReceiptStatus;
  readonly version: number;
  readonly createdKey: string;
  readonly lines: readonly ReceiptLineView[];
}
export interface ReceiptCursor {
  readonly createdKey: string;
  readonly id: string;
}
export interface ReceiptPage {
  readonly items: readonly ReceiptView[];
  readonly next: ReceiptCursor | null;
}
export interface ReceivingLocationView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
export interface ReceiptDetail extends ReceiptView {
  /** Deponun etkin KABUL lokasyonları (kod sırası). */
  readonly receivingLocations: readonly ReceivingLocationView[];
}

type ReceiptDbRow = {
  id: string;
  warehouse_id: string;
  number: string;
  supplier_ref: string | null;
  status: ReceiptStatus;
  version: number | string;
  created_key: string;
  lines: readonly {
    id: string;
    line_no: number;
    item_id: string;
    item_code: string;
    item_name: string;
    unit_id: string;
    unit_code: string;
    unit_name: string;
    expected: string;
    received: string;
    damaged: string;
    open: string;
  }[];
};

const uuid = (raw: unknown): string => {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
};

function cursorOf(raw: ReceiptCursor | undefined): { key: string; id: string } | null {
  if (raw === undefined) return null;
  if (typeof raw.createdKey !== "string" || !CURSOR_TIME_RE.test(raw.createdKey) || !isCalendarTime(raw.createdKey)) throw new AppError("VALIDATION_FAILED");
  return { key: raw.createdKey, id: uuid(raw.id) };
}
function limitOf(raw: number | undefined): number {
  if (raw === undefined) return RECEIPT_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(raw) || raw < 1 || raw > RECEIPT_LIST_LIMIT_MAX) throw new AppError("VALIDATION_FAILED");
  return raw;
}

const toView = (r: ReceiptDbRow): ReceiptView => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  number: r.number,
  supplierRef: r.supplier_ref,
  status: r.status,
  version: Number(r.version),
  createdKey: r.created_key,
  lines: r.lines.map((l) => ({
    id: l.id,
    lineNo: l.line_no,
    itemId: l.item_id,
    itemCode: l.item_code,
    itemName: l.item_name,
    unitId: l.unit_id,
    unitCode: l.unit_code,
    unitName: l.unit_name,
    expected: l.expected,
    received: l.received,
    damaged: l.damaged,
    open: l.open,
  })),
});

// Satırlar tek sorguda (LATERAL); tenant süzgeci her birleşimde açık. Miktarlar `::text` (numeric → dizgi).
const RECEIPT_SELECT = sql`SELECT r.id, r.warehouse_id, r.number, r.supplier_ref, r.status, r.version,
       to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key,
       COALESCE(l.lines, '[]'::jsonb) AS lines
  FROM public.inbound_receipts r
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'id', x.id, 'line_no', x.line_no, 'item_id', x.item_id, 'item_code', i.code, 'item_name', i.name,
             'unit_id', x.unit_id, 'unit_code', u.code, 'unit_name', u.name,
             'expected', x.expected_quantity::text, 'received', x.received_quantity::text, 'damaged', x.damaged_quantity::text,
             'open', GREATEST(x.expected_quantity - x.received_quantity, 0)::text) ORDER BY x.line_no) AS lines
      FROM public.inbound_receipt_lines x
      JOIN public.items i ON i.tenant_id = x.tenant_id AND i.id = x.item_id
      JOIN public.units u ON u.tenant_id = x.tenant_id AND u.id = x.unit_id
     WHERE x.tenant_id = r.tenant_id AND x.receipt_id = r.id) l ON true`;

export interface ListInboundReceiptsInput {
  readonly status?: ReceiptStatus;
  readonly warehouseId?: string;
  readonly after?: ReceiptCursor;
  readonly limit?: number;
}

/** Beklenen teslim listesi (satırlarıyla): eskiden yeniye (created_at, id), keyset; kapsam dışı depo satırları görünmez. */
export async function listInboundReceipts(params: TaskCallParams, input: ListInboundReceiptsInput = {}): Promise<ReceiptPage> {
  const limit = limitOf(input.limit);
  const cur = cursorOf(input.after);
  const status = input.status ?? null;
  if (status !== null && !(RECEIPT_STATUSES as readonly string[]).includes(status)) throw new AppError("VALIDATION_FAILED");
  const warehouseId = input.warehouseId === undefined ? null : uuid(input.warehouseId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const rows = await tx.execute<ReceiptDbRow>(
      sql`${RECEIPT_SELECT}
           WHERE r.tenant_id = ${m.tenantId}::uuid
             AND (${status}::text IS NULL OR r.status = ${status}::text)
             AND (${warehouseId}::uuid IS NULL OR r.warehouse_id = ${warehouseId}::uuid)
             AND (${scope === null}::boolean OR r.warehouse_id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))
             AND (${cur === null}::boolean OR (r.created_at, r.id) > (${cur?.key ?? "1970-01-01T00:00:00.000000Z"}::timestamptz, ${cur?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
           ORDER BY r.created_at, r.id
           LIMIT ${limit + 1}`,
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items: items.map(toView), next: rows.length > limit && last !== undefined ? { createdKey: last.created_key, id: last.id } : null };
  });
}

/** Tek teslim + deponun KABUL lokasyonları. Başka tenant'ın, olmayan ya da kapsam dışı depodaki kimlik `NOT_FOUND`. */
export async function getInboundReceipt(params: TaskCallParams, input: { readonly receiptId: string }): Promise<ReceiptDetail> {
  const receiptId = uuid(input.receiptId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const rows = await tx.execute<ReceiptDbRow>(sql`${RECEIPT_SELECT} WHERE r.tenant_id = ${m.tenantId}::uuid AND r.id = ${receiptId}::uuid`);
    const row = rows[0];
    if (row === undefined) throw new AppError("NOT_FOUND");
    await assertWarehouseVisible(tx, m, [row.warehouse_id]);
    const locs = await tx.execute<{ id: string; code: string; name: string }>(
      sql`SELECT id, code, name FROM public.locations
           WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${row.warehouse_id}::uuid AND kind = 'RECEIVING' AND status = 'ACTIVE'
           ORDER BY code COLLATE "C", id`,
    );
    return { ...toView(row), receivingLocations: locs.map((l) => ({ id: l.id, code: l.code, name: l.name })) };
  });
}

/**
 * Bir lokasyondaki bir ürünün yerleştirilebilir (AVAILABLE, rezervesiz) miktarı; yoksa `"0"`. Lokasyon başka tenant'ınsa/olmayansa/kapsam
 * dışıysa `NOT_FOUND`. Yalnızca gösterim (varsayılan miktar); yerleştirme kuralları `putaway` komutundadır.
 */
export async function getAvailableAtLocation(
  params: TaskCallParams,
  input: { readonly locationId: string; readonly itemId: string },
): Promise<{ readonly quantity: string }> {
  const locationId = uuid(input.locationId);
  const itemId = uuid(input.itemId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const loc = await tx.execute<{ warehouse_id: string }>(
      sql`SELECT warehouse_id FROM public.locations WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid`,
    );
    if (loc[0] === undefined) throw new AppError("NOT_FOUND");
    await assertWarehouseVisible(tx, m, [loc[0].warehouse_id]);
    const sum = await tx.execute<{ q: string }>(
      sql`SELECT COALESCE(sum(b.quantity - b.reserved_quantity), 0)::text AS q
            FROM public.stock_dimensions s
            JOIN public.stock_balances b ON b.tenant_id = s.tenant_id AND b.stock_dimension_id = s.id
           WHERE s.tenant_id = ${m.tenantId}::uuid AND s.location_id = ${locationId}::uuid AND s.item_id = ${itemId}::uuid
             AND s.stock_status = 'AVAILABLE'`,
    );
    return { quantity: sum[0]?.q ?? "0" };
  });
}

export interface LocationBrief {
  readonly id: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: "RECEIVING" | "STORAGE" | "STAGING" | "TRANSIT";
}

/** Tek lokasyonun kısa kartı (görev kaynağını göstermek için). Başka tenant'ın/olmayan/kapsam dışı depodaki kimlik `NOT_FOUND`. */
export async function getLocationBrief(params: TaskCallParams, input: { readonly locationId: string }): Promise<LocationBrief> {
  const locationId = uuid(input.locationId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const rows = await tx.execute<{ id: string; warehouse_id: string; code: string; name: string; kind: LocationBrief["kind"] }>(
      sql`SELECT id, warehouse_id, code, name, kind FROM public.locations WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid`,
    );
    const r = rows[0];
    if (r === undefined) throw new AppError("NOT_FOUND");
    await assertWarehouseVisible(tx, m, [r.warehouse_id]);
    return { id: r.id, warehouseId: r.warehouse_id, code: r.code, name: r.name, kind: r.kind };
  });
}
