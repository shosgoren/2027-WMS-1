// Ortak SALT OKUNUR modül (T-253): rezervasyon okumaları + belge/ürün/lokasyon okuma-denetim yardımcıları. `documents.ts` ↔ `reservations.ts`
// içe aktarma döngüsünü kırar: documents → reservations → reservation-reads; bu modül ikisinden de HİÇBİRİNE bağımlı değildir (birim testi
// import grafiğini doğrular). Stok tablolarına yazım burada YOKTUR (stock-sql-guard; yazıcılar `reservations.ts`'tedir).
//   - Rezervasyon okumaları (`readReservationPlanRows`, `readCancellationLockSet`, `stagedAmong`): kilit planı için KİLİTSİZ okuma; karar
//     kilitten SONRA aynı transaction'da yeniden okunan değerle verilir (çağıranlar `apply` içinde tekrar çağırır; kilitli görüntüyle karşılaştırılır).
//   - Belge/ürün/lokasyon yardımcıları (`readDocumentHeader`, `assertNotProcessing`, `assertItemsActive`, `assertLocationsActiveInWarehouse`):
//     documents.ts'ten TAŞINDI (davranış aynı); documents.ts adları yeniden dışa verir.
// Tüm sorgularda RLS'e EK olarak açık `tenant_id = $tenant` süzgeci vardır (savunma derinliği); kimlik girdileri sorgudan ÖNCE UUID olarak
// doğrulanır (geçersiz → `VALIDATION_FAILED`, DB `22P02` hatası değil).
// A-253-1: Zod `uuid()` kullanılmadı — `@wms/domain` zod'a bağımlı değildir (STACK.md/package.json kart kapsamı dışı); eşdeğer sıkı biçim denetimi
// (8-4-4-4-12 onaltılık) yapılır ve DB `uuid` türüyle birebir uyumludur (Zod 4 `uuid()` sürüm/varyant hanesini de ister; DB istemez).
import { sql } from "drizzle-orm";
import type { LockedState, StockDimensionKey } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import type { AccessTx, TenantAccessParams } from "../identity/access.ts";
import { pgUuidArray } from "../warehouse/scope.ts";
import type { StockCommandParams } from "./command.ts";
import { compareDimensionKeys, dimensionIdentity, type ReservationSource } from "./plan.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (): AppError => new AppError("VALIDATION_FAILED");
export const versionConflict = (): AppError => new AppError("VERSION_CONFLICT", { retryable: true });
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** UUID doğrular ve küçük harfe çevirir; aksi `VALIDATION_FAILED`. */
export function uuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw invalid();
  return raw.toLowerCase();
}
export function uuidOrNull(raw: unknown): string | null {
  return raw === undefined || raw === null ? null : uuid(raw);
}

/** Plan satırı: rezervasyon + boyut anahtarı + boyutun lokasyon deposu (kilitsiz okuma; apply kilitli görüntüyü doğrular). */
export interface ReservationPlanRow {
  readonly id: string;
  readonly status: string;
  /** Talep kaynağı (belge satırı | sipariş satırı; T-306). */
  readonly source: ReservationSource;
  readonly key: StockDimensionKey;
  readonly warehouseId: string;
  /** Boyutun lokasyon türü (T-306: serbest kalan mal `STAGING`'teyse geri yerleştirme görevi; kilitsiz okuma, karar kilitten sonra yeniden okunan satırla). */
  readonly locationKind: string;
}
export type PlanSelector =
  | { readonly ids: readonly string[] }
  | { readonly lineId: string }
  | { readonly documentId: string }
  /** T-306: bir sipariş satırının ACTIVE rezervasyonları. */
  | { readonly orderLineId: string };

export async function readReservationPlanRows(tx: AccessTx, tenantId: string, sel: PlanSelector): Promise<ReservationPlanRow[]> {
  type R = {
    id: string; status: string; document_line_id: string | null; order_line_id: string | null; item_id: string; location_id: string; lot_id: string | null; serial_id: string | null;
    stock_status: StockDimensionKey["stockStatus"]; inventory_owner_id: string | null; handling_unit_id: string | null; warehouse_id: string; location_kind: string;
  };
  const tenant = uuid(tenantId);
  // Sorgudan ÖNCE doğrula: geçersiz kimlik DB hatasına dönüşmez.
  const ids = "ids" in sel ? sel.ids.map(uuid) : [];
  const lineId = "lineId" in sel ? uuid(sel.lineId) : "";
  const documentId = "documentId" in sel ? uuid(sel.documentId) : "";
  const orderLineId = "orderLineId" in sel ? uuid(sel.orderLineId) : "";
  const cols = sql`r.id, r.status, r.document_line_id, r.order_line_id, d.item_id, d.location_id, d.lot_id, d.serial_id, d.stock_status, d.inventory_owner_id, d.handling_unit_id, loc.warehouse_id, loc.kind AS location_kind`;
  const from = sql`public.reservations r
          JOIN public.stock_dimensions d ON d.tenant_id = r.tenant_id AND d.id = r.stock_dimension_id
          JOIN public.locations loc ON loc.tenant_id = d.tenant_id AND loc.id = d.location_id
          LEFT JOIN public.document_lines l ON l.tenant_id = r.tenant_id AND l.id = r.document_line_id`;
  let rows: R[];
  if ("ids" in sel) {
    rows = await tx.execute<R>(sql`SELECT ${cols} FROM ${from} WHERE r.tenant_id = ${tenant}::uuid AND r.id = ANY(${pgUuidArray(ids)}::uuid[]) ORDER BY r.id`);
  } else if ("lineId" in sel) {
    rows = await tx.execute<R>(
      sql`SELECT ${cols} FROM ${from} WHERE r.tenant_id = ${tenant}::uuid AND r.document_line_id = ${lineId}::uuid AND r.status = 'ACTIVE' ORDER BY r.id`,
    );
  } else if ("orderLineId" in sel) {
    rows = await tx.execute<R>(
      sql`SELECT ${cols} FROM ${from} WHERE r.tenant_id = ${tenant}::uuid AND r.order_line_id = ${orderLineId}::uuid AND r.status = 'ACTIVE' ORDER BY r.id`,
    );
  } else {
    rows = await tx.execute<R>(
      sql`SELECT ${cols} FROM ${from} WHERE r.tenant_id = ${tenant}::uuid AND l.document_id = ${documentId}::uuid AND r.status = 'ACTIVE' ORDER BY r.id`,
    );
  }
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    source: sourceOfRow(r),
    warehouseId: r.warehouse_id,
    locationKind: r.location_kind,
    key: {
      itemId: r.item_id,
      locationId: r.location_id,
      lotId: r.lot_id,
      serialId: r.serial_id,
      stockStatus: r.stock_status,
      inventoryOwnerId: r.inventory_owner_id,
      handlingUnitId: r.handling_unit_id,
    },
  }));
}

/** Siparişin satırları başına Σ ACTIVE rezervasyon (numeric metni; kilitsiz okuma — karar çağıranın başlık kilidi altında yaptığı çağrıyla verilir; T-306). */
export async function readOrderReservedSums(tx: AccessTx, tenantId: string, orderId: string): Promise<Map<string, string>> {
  const tenant = uuid(tenantId);
  const order = uuid(orderId);
  const rows = await tx.execute<{ order_line_id: string; s: string }>(
    sql`SELECT r.order_line_id, sum(r.quantity)::text AS s FROM public.reservations r
         JOIN public.sales_order_lines l ON l.tenant_id = r.tenant_id AND l.id = r.order_line_id
        WHERE r.tenant_id = ${tenant}::uuid AND l.order_id = ${order}::uuid AND r.status = 'ACTIVE'
        GROUP BY r.order_line_id`,
  );
  return new Map(rows.map((x) => [x.order_line_id.toLowerCase(), x.s]));
}

/** Tahsis adayı ham satırı: bir boyut + lokasyonu + kullanılabilir miktar (kural 5 süzgeci çağıranda; T-306). */
export interface AllocationBalanceRow {
  readonly key: StockDimensionKey;
  readonly locationCode: string;
  readonly locationKind: string;
  readonly pickBlocked: boolean;
  /** Lokasyon sayımda (`location_count_locks.status = COUNTING`). */
  readonly counting: boolean;
  /** `quantity − reserved_quantity` (numeric metni). */
  readonly available: string;
}

/**
 * Ürünlerin AVAILABLE, ACTIVE lokasyondaki ve kullanılabilir miktarı > 0 olan boyutları (kilitsiz okuma; yalnızca ÖNERİ içindir — kural 5 ve yeterlilik
 * kilit altında `allocateInTx`'te yeniden uygulanır). `pick_blocked`/tür/sayım süzgeci çağıranda (saf `isAllocationCandidate`), böylece elenen aday görünür kalır.
 */
export async function readAllocationBalances(tx: AccessTx, tenantId: string, itemIds: readonly string[]): Promise<AllocationBalanceRow[]> {
  const tenant = uuid(tenantId);
  const items = itemIds.map(uuid);
  if (items.length === 0) return [];
  const rows = await tx.execute<{
    item_id: string; location_id: string; lot_id: string | null; serial_id: string | null; stock_status: StockDimensionKey["stockStatus"];
    inventory_owner_id: string | null; handling_unit_id: string | null; code: string; kind: string; pick_blocked: boolean; counting: boolean; available: string;
  }>(
    sql`SELECT d.item_id, d.location_id, d.lot_id, d.serial_id, d.stock_status, d.inventory_owner_id, d.handling_unit_id,
               l.code, l.kind, l.pick_blocked,
               EXISTS (SELECT 1 FROM public.location_count_locks c WHERE c.tenant_id = d.tenant_id AND c.location_id = d.location_id AND c.status = 'COUNTING') AS counting,
               (b.quantity - b.reserved_quantity)::text AS available
          FROM public.stock_balances b
          JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
          JOIN public.locations l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
         WHERE b.tenant_id = ${tenant}::uuid AND d.item_id = ANY(${pgUuidArray(items)}::uuid[])
           AND d.stock_status = 'AVAILABLE' AND l.status = 'ACTIVE' AND b.quantity - b.reserved_quantity > 0
         ORDER BY d.item_id, l.code, d.id`,
  );
  return rows.map((r) => ({
    key: {
      itemId: r.item_id.toLowerCase(),
      locationId: r.location_id.toLowerCase(),
      lotId: r.lot_id,
      serialId: r.serial_id,
      stockStatus: r.stock_status,
      inventoryOwnerId: r.inventory_owner_id,
      handlingUnitId: r.handling_unit_id,
    },
    locationCode: r.code,
    locationKind: r.kind,
    pickBlocked: r.pick_blocked,
    counting: r.counting,
    available: r.available,
  }));
}

/** Satırın kaynağı: DB XOR CHECK'i garanti eder; ikisi de dolu/boşsa bütünlük ihlali (`INTERNAL`, sessiz seçim yok). */
function sourceOfRow(r: { document_line_id: string | null; order_line_id: string | null }): ReservationSource {
  if (r.document_line_id !== null && r.order_line_id === null) return { kind: "DOCUMENT_LINE", lineId: r.document_line_id };
  if (r.document_line_id === null && r.order_line_id !== null) return { kind: "ORDER_LINE", lineId: r.order_line_id };
  throw new AppError("INTERNAL");
}

export const uniqueKeys = (keys: readonly StockDimensionKey[]): StockDimensionKey[] =>
  [...new Map(keys.map((k) => [dimensionIdentity(k), k])).values()].sort(compareDimensionKeys);

/** Planın boyutları kilitli görüntüde var mı (I-15: yalnızca kilitli satırlara yazılır); yoksa plan bayat: `VERSION_CONFLICT`. */
export function lockedDimensionIdByIdentity(locked: LockedState): Map<string, string> {
  return new Map(locked.dimensions.map((d) => [dimensionIdentity(d.key), d.id]));
}

/** Kapanan rezervasyonlardan biri STAGING lokasyondaki boyuttaysa mal sevk alanında kalıyor demektir (kural 7). */
export async function stagedAmong(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<boolean> {
  const tenant = uuid(tenantId);
  const valid = ids.map(uuid);
  const rows = await tx.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n
          FROM public.reservations r
          JOIN public.stock_dimensions d ON d.tenant_id = r.tenant_id AND d.id = r.stock_dimension_id
          JOIN public.locations l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
         WHERE r.tenant_id = ${tenant}::uuid AND r.id = ANY(${pgUuidArray(valid)}::uuid[]) AND l.kind = 'STAGING'`,
  );
  return Number(rows[0]?.n ?? "0") > 0;
}

/** `cancelDocument` planı için: belgenin açık rezervasyonları, boyutları ve depoları (kilitsiz okuma; kilit planına girer). */
export async function readCancellationLockSet(
  tx: AccessTx,
  tenantId: string,
  documentId: string,
): Promise<{ readonly reservationIds: string[]; readonly dimensions: StockDimensionKey[]; readonly warehouseIds: string[] }> {
  const rows = await readReservationPlanRows(tx, tenantId, { documentId });
  return {
    reservationIds: rows.map((r) => r.id).sort(cmp),
    dimensions: uniqueKeys(rows.map((r) => r.key)),
    warehouseIds: [...new Set(rows.map((r) => r.warehouseId))],
  };
}

// --- belge / ürün / lokasyon ortak okumaları (documents.ts ve reservations.ts/posting.ts kullanır; döngüyü kıran taşıma) ------------------

/** Çağıran bağlamı: izin komuta bağlıdır; `clientKey` her komutta zorunludur (A-73). */
export type StockDocCallParams = Omit<TenantAccessParams, "permission" | "recentAuth"> & {
  readonly clientKey: string | null | undefined;
  readonly retry?: StockCommandParams<unknown>["retry"];
  readonly timeouts?: StockCommandParams<unknown>["timeouts"];
  readonly logger?: StockCommandParams<unknown>["logger"];
};


export interface DocumentHeader {
  readonly id: string;
  readonly kind: string;
  readonly status: "DRAFT" | "APPROVED" | "POSTED" | "CANCELLED";
  readonly version: number;
  readonly warehouseId: string;
  readonly businessDate: string;
  readonly reason: string | null;
  readonly postingJobId: string | null;
}

/**
 * Belge başlığını okur. ÇAĞIRAN başlığı daha önce `acquireStockLocks` ile `FOR UPDATE` kilitlemiş olmalıdır (kilitli görüntü: durum
 * ve `posting_job_id` kilit altında okunur). Yoksa `NOT_FOUND`.
 */
export async function readDocumentHeader(tx: AccessTx, tenantId: string, documentId: string): Promise<DocumentHeader> {
  const rows = await tx.execute<{
    id: string; kind: string; status: DocumentHeader["status"]; version: number | string; warehouse_id: string; business_date: string; reason: string | null; posting_job_id: string | null;
  }>(
    sql`SELECT id, kind, status, version, warehouse_id, business_date::text AS business_date, reason, posting_job_id
          FROM public.documents WHERE tenant_id = ${tenantId}::uuid AND id = ${documentId}::uuid`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    version: Number(r.version),
    warehouseId: r.warehouse_id,
    businessDate: r.business_date,
    reason: r.reason,
    postingJobId: r.posting_job_id,
  };
}

/** İşleme kilidi (M-6, ADR-018 §6): `posting_job_id` doluyken düzenleme/onay/iptal/rezervasyon/yeni işleme → `DOCUMENT_STATE`. */
export function assertNotProcessing(header: Pick<DocumentHeader, "postingJobId">): void {
  if (header.postingJobId !== null) throw new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" });
}

/**
 * Ürünleri `FOR SHARE` okur ve hepsinin ACTIVE olduğunu denetler (ARCHIVED ürüne hareket reddedilir; arşivleme `FOR NO KEY UPDATE`
 * ile çakışır). Eksik ürün → `NOT_FOUND`; ACTIVE değil → `VALIDATION_FAILED`. Kimliğe göre sıralı (kilit sırası sabit).
 */
export async function assertItemsActive(
  tx: AccessTx,
  tenantId: string,
  itemIds: readonly string[],
  opts: { readonly archivedDetail?: "IN_USE" } = {},
): Promise<void> {
  const ids = [...new Set(itemIds.map((i) => i.toLowerCase()))].sort();
  if (ids.length === 0) return;
  const rows = await tx.execute<{ id: string; status: string }>(
    sql`SELECT id, status FROM public.items
         WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])
         ORDER BY id FOR SHARE`,
  );
  if (rows.length !== ids.length) throw new AppError("NOT_FOUND");
  if (rows.some((r) => r.status !== "ACTIVE")) {
    throw new AppError("VALIDATION_FAILED", opts.archivedDetail === undefined ? {} : { detail: opts.archivedDetail });
  }
}

/**
 * T-217 (T-243 MAJOR): stok yazıcısı için lokasyon denetimi. Kimliğe göre sıralı `FOR SHARE` (arşivin `FOR NO KEY UPDATE`'iyle çakışır),
 * sonra: yok/başka tenant → `NOT_FOUND`; başka depo → `VALIDATION_FAILED`/`LOCATION_WAREHOUSE_MISMATCH` (A-145);
 * `ACTIVE` değil → `VALIDATION_FAILED`/`IN_USE`. `acquireStockLocks` SONRASI çağrılır (kilit sırası: sayım kilidi → lokasyon).
 */
export async function assertLocationsActiveInWarehouse(
  tx: AccessTx,
  tenantId: string,
  locationIds: readonly string[],
  /** `null` (T-306): sipariş tahsisi — siparişin deposu yoktur; lokasyonların depoları komut planında kapsam denetimine girer, eşitlik aranmaz. */
  warehouseId: string | null,
): Promise<void> {
  if (locationIds.length === 0) return;
  const ids = [...new Set(locationIds.map((i) => i.toLowerCase()))].sort();
  const rows = await tx.execute<{ id: string; warehouse_id: string; status: string }>(
    sql`SELECT id, warehouse_id, status FROM public.locations
         WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])
         ORDER BY id FOR SHARE`,
  );
  if (rows.length !== ids.length) throw new AppError("NOT_FOUND");
  if (warehouseId !== null && rows.some((r) => r.warehouse_id.toLowerCase() !== warehouseId.toLowerCase())) {
    throw new AppError("VALIDATION_FAILED", { detail: "LOCATION_WAREHOUSE_MISMATCH" });
  }
  if (rows.some((r) => r.status !== "ACTIVE")) throw new AppError("VALIDATION_FAILED", { detail: "IN_USE" });
}

