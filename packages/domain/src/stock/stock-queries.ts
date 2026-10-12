// Kullanıcıya açık stok sorguları (T-332a; "ürün nerede / raf içeriği"). Salt okuma: `runTenantQuery` + `stock.view`; `tenant_id` yalnızca doğrulanmış
// üyelikten gelir ve her sorguda AÇIK süzgeçtir (RLS ikinci savunma). Yazma/kilit yok (G-01, I-15 kapsamı dışı).
// - Depo kapsamı (A-46): kapsam süzgeci SQL'in içindedir; kapsam dışı depo satırları hiç görünmez. `stockByLocation`'da yok / başka tenant /
//   kapsam dışı lokasyon TEK sorguyla (kapsam süzgeçli) aranır ve üçü de aynı `NOT_FOUND`'u verir (aynı sorgu sayısı ve yol; varlık sızmaz).
// - Keyset sayfalama, OFFSET yok (I-14). İmleç opaktır (base64url JSON) ve sıkı doğrulanır. Sıra `COLLATE "C"` (deterministik).
// - Miktarlar `numeric(20,6)` metni (I-09; float yok). Bakiyesi sıfır olan boyutlar gösterilmez (A-332a-1).
// - Kullanılabilir (GLOSSARY, 16 kural 5; `availability.ts` ile aynı): AVAILABLE ∧ lokasyon STORAGE|STAGING ∧ !pick_blocked ise fiziksel − rezerve, aksi 0.
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery, type TenantAccessParams } from "../identity/access.ts";
import { pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import { fromMicro, toMicro } from "./plan.ts";

export type StockQueryParams = Omit<TenantAccessParams, "permission" | "recentAuth">;

export const STOCK_QUERY_LIMIT_DEFAULT = 50;
export const STOCK_QUERY_LIMIT_MAX = 100;
export const STOCK_STATUSES = ["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,1024}$/;
const CODE_MAX = 128;

const uuid = (raw: unknown): string => {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
};
const limitOf = (raw: unknown): number => {
  if (raw === undefined) return STOCK_QUERY_LIMIT_DEFAULT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > STOCK_QUERY_LIMIT_MAX) throw new AppError("VALIDATION_FAILED");
  return raw;
};
const okCode = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= CODE_MAX && !/[\u0000-\u001f\u007f]/.test(v);

function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}
/** İmleç: `arity` dizgeli JSON dizisi; sonuncusu boyut kimliği (UUID). Aksi `VALIDATION_FAILED`. */
function decodeCursor(raw: unknown, arity: number): string[] | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !CURSOR_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new AppError("VALIDATION_FAILED");
  }
  if (!Array.isArray(v) || v.length !== arity) throw new AppError("VALIDATION_FAILED");
  const last = v[arity - 1];
  for (const part of v.slice(0, arity - 1)) if (!okCode(part)) throw new AppError("VALIDATION_FAILED");
  return [...(v.slice(0, arity - 1) as string[]), uuid(last)];
}

export interface StockBaseUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
/** Boyut satırı (ortak): izlenen boyutlar yoksa `null`. Miktarlar ondalık dizgi (ürünün temel biriminde). */
export interface StockRowCommon {
  readonly dimensionId: string;
  readonly stockStatus: StockStatus;
  readonly lot: { readonly id: string; readonly code: string; readonly expiryDate: string | null } | null;
  readonly serial: { readonly id: string; readonly serialNo: string } | null;
  readonly owner: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly handlingUnit: { readonly id: string; readonly code: string; readonly kind: "KOLI" | "PALET" } | null;
  readonly physical: string;
  readonly reserved: string;
  /** Kural 5: yalnızca AVAILABLE ∧ STORAGE|STAGING ∧ !pick_blocked boyutlarda fiziksel − rezerve; aksi `"0.000000"`. */
  readonly available: string;
}
export interface StockLocationFields {
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
  readonly locationKind: "RECEIVING" | "STORAGE" | "STAGING" | "TRANSIT";
  readonly pickBlocked: boolean;
}
export interface StockByItemRow extends StockRowCommon, StockLocationFields {}
export interface StockByLocationRow extends StockRowCommon {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly baseUnit: StockBaseUnit;
}
export interface StockTotals {
  readonly physical: string;
  readonly reserved: string;
  readonly available: string;
  /** Durum başına fiziksel toplam (her durum anahtarı vardır). */
  readonly physicalByStatus: Readonly<Record<StockStatus, string>>;
}
export interface StockByItemResult {
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly baseUnit: StockBaseUnit };
  readonly rows: readonly StockByItemRow[];
  /** Sonraki sayfa yoksa `null`. */
  readonly nextCursor: string | null;
  /** Çağıranın görebildiği TÜM satırların toplamı (yalnızca bu sayfanın değil). */
  readonly totals: StockTotals;
}
export interface StockByLocationResult {
  readonly location: StockLocationFields & { readonly id: string; readonly code: string; readonly name: string };
  readonly rows: readonly StockByLocationRow[];
  readonly nextCursor: string | null;
}

type DimDbRow = {
  dimension_id: string;
  stock_status: StockStatus;
  lot_id: string | null; lot_code: string | null; lot_expiry: string | null;
  serial_id: string | null; serial_no: string | null;
  owner_id: string | null; owner_code: string | null; owner_name: string | null;
  hu_id: string | null; hu_code: string | null; hu_kind: "KOLI" | "PALET" | null;
  physical: string; reserved: string; available: string;
};
const toCommon = (r: DimDbRow): StockRowCommon => ({
  dimensionId: r.dimension_id,
  stockStatus: r.stock_status,
  lot: r.lot_id === null ? null : { id: r.lot_id, code: r.lot_code as string, expiryDate: r.lot_expiry },
  serial: r.serial_id === null ? null : { id: r.serial_id, serialNo: r.serial_no as string },
  owner: r.owner_id === null ? null : { id: r.owner_id, code: r.owner_code as string, name: r.owner_name as string },
  handlingUnit: r.hu_id === null ? null : { id: r.hu_id, code: r.hu_code as string, kind: r.hu_kind as "KOLI" | "PALET" },
  physical: r.physical,
  reserved: r.reserved,
  available: r.available,
});

// Ortak SELECT parçaları. Her JOIN'de tenant eşitliği açık.
const DIM_COLS = sql`d.id AS dimension_id, d.stock_status,
       lt.id AS lot_id, lt.lot_code, lt.expiry_date::text AS lot_expiry,
       sr.id AS serial_id, sr.serial_no,
       ow.id AS owner_id, ow.code AS owner_code, ow.name AS owner_name,
       hu.id AS hu_id, hu.code AS hu_code, hu.kind AS hu_kind,
       b.quantity::text AS physical, b.reserved_quantity::text AS reserved,
       (CASE WHEN d.stock_status = 'AVAILABLE' AND l.kind IN ('STORAGE', 'STAGING') AND l.pick_blocked = false
             THEN b.quantity - b.reserved_quantity ELSE 0 END)::numeric(20,6)::text AS available`;
const DIM_JOINS = sql`FROM public.stock_balances b
  JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
  JOIN public.locations l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
  JOIN public.warehouses w ON w.tenant_id = l.tenant_id AND w.id = l.warehouse_id
  JOIN public.items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id
  JOIN public.units u ON u.tenant_id = i.tenant_id AND u.id = i.base_unit_id
  LEFT JOIN public.lots lt ON lt.tenant_id = d.tenant_id AND lt.id = d.lot_id
  LEFT JOIN public.serials sr ON sr.tenant_id = d.tenant_id AND sr.id = d.serial_id
  LEFT JOIN public.inventory_owners ow ON ow.tenant_id = d.tenant_id AND ow.id = d.inventory_owner_id
  LEFT JOIN public.handling_units hu ON hu.tenant_id = d.tenant_id AND hu.id = d.handling_unit_id`;

export interface StockByItemInput {
  readonly itemId: string;
  readonly afterKey?: string;
  readonly limit?: number;
}

/**
 * Bir ürünün lokasyon bazlı stoğu (boyut başına satır: lot/seri/sahip/taşıma birimi/durum ayrı). Sıra: depo kodu, lokasyon kodu, boyut kimliği.
 * Yok / başka tenant'ın ürünü `NOT_FOUND`. Kapsam dışı depodaki stok satırlarda ve toplamlarda görünmez.
 */
export async function stockByItem(params: StockQueryParams, input: StockByItemInput): Promise<StockByItemResult> {
  const itemId = uuid(input.itemId);
  const limit = limitOf(input.limit);
  const cur = decodeCursor(input.afterKey, 3);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const scopeSql = sql`(${scope === null}::boolean OR l.warehouse_id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))`;
    const head = await tx.execute<{ id: string; code: string; name: string; unit_id: string; unit_code: string; unit_name: string }>(
      sql`SELECT i.id, i.code, i.name, u.id AS unit_id, u.code AS unit_code, u.name AS unit_name
            FROM public.items i JOIN public.units u ON u.tenant_id = i.tenant_id AND u.id = i.base_unit_id
           WHERE i.tenant_id = ${m.tenantId}::uuid AND i.id = ${itemId}::uuid`,
    );
    const h = head[0];
    if (h === undefined) throw new AppError("NOT_FOUND");
    const rows = await tx.execute<
      DimDbRow & { warehouse_id: string; warehouse_code: string; warehouse_name: string; location_id: string; location_code: string; location_name: string; location_kind: StockByItemRow["locationKind"]; pick_blocked: boolean }
    >(
      sql`SELECT ${DIM_COLS}, w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
                 l.id AS location_id, l.code AS location_code, l.name AS location_name, l.kind AS location_kind, l.pick_blocked
            ${DIM_JOINS}
           WHERE b.tenant_id = ${m.tenantId}::uuid AND d.item_id = ${itemId}::uuid AND b.quantity <> 0 AND ${scopeSql}
             AND (${cur === null}::boolean OR (w.code COLLATE "C", l.code COLLATE "C", d.id) > (${cur?.[0] ?? ""}::text, ${cur?.[1] ?? ""}::text, ${cur?.[2] ?? "00000000-0000-0000-0000-000000000000"}::uuid))
           ORDER BY w.code COLLATE "C", l.code COLLATE "C", d.id
           LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last !== undefined ? encodeCursor([last.warehouse_code, last.location_code, last.dimension_id]) : null;
    const tot = await tx.execute<{ reserved: string; available: string; st: StockStatus; st_physical: string }>(
      sql`SELECT d.stock_status AS st, sum(b.quantity)::numeric(20,6)::text AS st_physical,
                 sum(b.reserved_quantity)::numeric(20,6)::text AS reserved,
                 COALESCE(sum(CASE WHEN d.stock_status = 'AVAILABLE' AND l.kind IN ('STORAGE', 'STAGING') AND l.pick_blocked = false
                                   THEN b.quantity - b.reserved_quantity ELSE 0 END), 0)::numeric(20,6)::text AS available
            ${DIM_JOINS}
           WHERE b.tenant_id = ${m.tenantId}::uuid AND d.item_id = ${itemId}::uuid AND b.quantity <> 0 AND ${scopeSql}
           GROUP BY d.stock_status`,
    );
    const byStatus: Record<StockStatus, bigint> = { AVAILABLE: 0n, QUARANTINE: 0n, DAMAGED: 0n, BLOCKED: 0n };
    let reserved = 0n;
    let available = 0n;
    for (const t of tot) {
      byStatus[t.st] = toMicro(t.st_physical);
      reserved += toMicro(t.reserved);
      available += toMicro(t.available);
    }
    const physical = byStatus.AVAILABLE + byStatus.QUARANTINE + byStatus.DAMAGED + byStatus.BLOCKED;
    return {
      item: { id: h.id, code: h.code, name: h.name, baseUnit: { id: h.unit_id, code: h.unit_code, name: h.unit_name } },
      rows: page.map((r) => ({
        ...toCommon(r),
        warehouseId: r.warehouse_id,
        warehouseCode: r.warehouse_code,
        warehouseName: r.warehouse_name,
        locationId: r.location_id,
        locationCode: r.location_code,
        locationName: r.location_name,
        locationKind: r.location_kind,
        pickBlocked: r.pick_blocked,
      })),
      nextCursor,
      totals: {
        physical: fromMicro(physical),
        reserved: fromMicro(reserved),
        available: fromMicro(available),
        physicalByStatus: {
          AVAILABLE: fromMicro(byStatus.AVAILABLE),
          QUARANTINE: fromMicro(byStatus.QUARANTINE),
          DAMAGED: fromMicro(byStatus.DAMAGED),
          BLOCKED: fromMicro(byStatus.BLOCKED),
        },
      },
    };
  });
}

export interface StockByLocationInput {
  readonly locationId: string;
  readonly afterKey?: string;
  readonly limit?: number;
}

/**
 * Bir lokasyonun ürün bazlı içeriği (boyut başına satır). Sıra: ürün kodu, boyut kimliği. Yok / başka tenant / kapsam dışı depodaki lokasyon
 * aynı `NOT_FOUND`. Toplam verilmez: farklı ürünlerin temel birimleri farklı olabilir (A-332a-3).
 */
export async function stockByLocation(params: StockQueryParams, input: StockByLocationInput): Promise<StockByLocationResult> {
  const locationId = uuid(input.locationId);
  const limit = limitOf(input.limit);
  const cur = decodeCursor(input.afterKey, 2);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const head = await tx.execute<{
      id: string; code: string; name: string; kind: StockLocationFields["locationKind"]; pick_blocked: boolean; warehouse_id: string; warehouse_code: string; warehouse_name: string;
    }>(
      sql`SELECT l.id, l.code, l.name, l.kind, l.pick_blocked, w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name
            FROM public.locations l JOIN public.warehouses w ON w.tenant_id = l.tenant_id AND w.id = l.warehouse_id
           WHERE l.tenant_id = ${m.tenantId}::uuid AND l.id = ${locationId}::uuid
             AND (${scope === null}::boolean OR l.warehouse_id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))`,
    );
    const h = head[0];
    if (h === undefined) throw new AppError("NOT_FOUND");
    const rows = await tx.execute<DimDbRow & { item_id: string; item_code: string; item_name: string; unit_id: string; unit_code: string; unit_name: string }>(
      sql`SELECT ${DIM_COLS}, i.id AS item_id, i.code AS item_code, i.name AS item_name, u.id AS unit_id, u.code AS unit_code, u.name AS unit_name
            ${DIM_JOINS}
           WHERE b.tenant_id = ${m.tenantId}::uuid AND d.location_id = ${locationId}::uuid AND b.quantity <> 0
             AND (${cur === null}::boolean OR (i.code COLLATE "C", d.id) > (${cur?.[0] ?? ""}::text, ${cur?.[1] ?? "00000000-0000-0000-0000-000000000000"}::uuid))
           ORDER BY i.code COLLATE "C", d.id
           LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      location: {
        id: h.id,
        code: h.code,
        name: h.name,
        warehouseId: h.warehouse_id,
        warehouseCode: h.warehouse_code,
        warehouseName: h.warehouse_name,
        locationId: h.id,
        locationCode: h.code,
        locationName: h.name,
        locationKind: h.kind,
        pickBlocked: h.pick_blocked,
      },
      rows: page.map((r) => ({
        ...toCommon(r),
        itemId: r.item_id,
        itemCode: r.item_code,
        itemName: r.item_name,
        baseUnit: { id: r.unit_id, code: r.unit_code, name: r.unit_name },
      })),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor([last.item_code, last.dimension_id]) : null,
    };
  });
}
