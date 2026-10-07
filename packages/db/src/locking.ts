// Stok kilit sözleşmesi (T-210; 05 §Kilit sözleşmesi, I-15, ADR-017 §1-§5, ADR-018 §7).
//
// `acquireStockLocks(tx, tenantId, plan)` bu dosyanın TEK dışa açık işlevidir. Altı adım sabit sırada, dosya içidir
// (export edilmez; komutlar tek tek çağıramaz): belge → sayım kilidi → boyut/bakiye satırı güvence → bakiye → rezervasyon → seri.
// Her adımda tekil ve değişmez anahtar artan alınır; uygulama sırası (Set + sort) ile SQL `ORDER BY` birebir aynıdır:
//   - UUID: küçük harfe normalize edilmiş dize karşılaştırması = PostgreSQL `uuid` bayt sırası (sabit genişlikli hex).
//   - Boyut doğal anahtarı: (item_id, location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id),
//     NULL'lar ÖNCE (`NULLS FIRST`); `stock_status` yalnızca büyük harfli ASCII sabitleri olduğundan harmanlamadan bağımsızdır.
// Plan dışı satır gerekirse çağıran yeni planla BAŞTAN çalıştırır; "kilit genişletme" API'si yoktur.
//
// Her sorgu hem RLS'e (tenant bağlamı çağıranın `withTenant`/`withMembership` transaction'ında kurulu) hem de açık
// `tenant_id = $1` süzgecine dayanır. Değerler parametredir; SQL birleştirme yoktur (JSON/dizi parametreleri).
// 40P01/40001 yeniden denemesi bu işlevde DEĞİL, komut sarmalayıcısındadır (T-213). Hata sınıfı dışa açılmaz (yalnızca tip):
// alan katmanı `code` ile `AppError`'a eşler (packages/db `@wms/shared`'a bağlı değildir).
import { sql, type SQL } from "drizzle-orm";
import { isUuid, type TenantTx } from "./client.ts";
import { currentTenantId } from "./with-tenant.ts";

/** ADR-017 §1: boyut doğal anahtarı. `null` = anahtar bileşeni yok (NULLS NOT DISTINCT). */
export interface StockDimensionKey {
  readonly itemId: string;
  readonly locationId: string;
  readonly lotId: string | null;
  readonly serialId: string | null;
  readonly stockStatus: "AVAILABLE" | "QUARANTINE" | "DAMAGED" | "BLOCKED";
  readonly inventoryOwnerId: string | null;
  readonly handlingUnitId: string | null;
}

/** 05 §Kilit sözleşmesi: komutun ihtiyacının tamamı, kilitlemeden önce. */
export interface StockLockPlan {
  readonly document?: { readonly id: string; readonly expectedVersion: number };
  readonly locationIds: readonly string[];
  readonly dimensions: readonly StockDimensionKey[];
  readonly reservationIds: readonly string[];
  readonly serialIds: readonly string[];
  /** YALNIZCA sayım farkı komutu doldurur; sayım kilidi istisnasının tek anahtarı. */
  readonly countSessionId?: string;
}

export type StockLockErrorCode =
  | "VALIDATION_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "LOCATION_LOCKED"
  | "COUNT_LOCK_ROW_MISSING"
  | "INTERNAL";

/**
 * Kapalı bayrak (Q-56): `serials` satırı kilidi `wms_app` ile bugün alınamaz (0011 yalnızca SELECT+INSERT; satır kilidi UPDATE yetkisi ister,
 * 42501). Bayrak `STOCK_SERIAL_LOCK_ENABLED=true` değilse `serialIds` boş olmayan plan HİÇ sorgu çalıştırılmadan reddedilir; böylece
 * 42501 yakalanıp seri kilitsiz yeniden deneme yolu açılmaz. Çağrı anında okunur (yeniden başlatma gerekmez).
 */
const serialLockEnabled = (): boolean => process.env.STOCK_SERIAL_LOCK_ENABLED === "true";

/** Fırlatılan hata (sınıf dışa açılmaz; `name === "StockLockError"` ve `code` ile tanınır). 15 §Hata kodları kodlarıdır. */
export interface StockLockError extends Error {
  readonly name: "StockLockError";
  readonly code: StockLockErrorCode;
  readonly detail: string | undefined;
}

export interface LockedDocument {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly warehouseId: string;
}
export interface LockedLocation {
  readonly locationId: string;
  readonly status: "IDLE" | "COUNTING";
  readonly countSessionId: string | null;
}
export interface LockedDimension {
  readonly id: string;
  readonly key: StockDimensionKey;
}
export interface LockedBalance {
  readonly stockDimensionId: string;
  /** numeric(20,6) metni (I-09; float yok). */
  readonly quantity: string;
  readonly reservedQuantity: string;
  readonly version: string;
}
export interface LockedReservation {
  readonly id: string;
  readonly stockDimensionId: string;
  readonly documentLineId: string;
  readonly quantity: string;
  readonly status: string;
}
export interface LockedSerial {
  readonly id: string;
  readonly itemId: string;
  readonly serialNo: string;
  readonly lotId: string | null;
}

/** Kilitlenmiş satırların anlık görüntüsü; her dizi kendi sıra anahtarına göre artandır. İş kuralları bu görüntü üzerinde denetlenir. */
export interface LockedState {
  readonly document: LockedDocument | undefined;
  readonly locations: readonly LockedLocation[];
  readonly dimensions: readonly LockedDimension[];
  readonly balances: readonly LockedBalance[];
  readonly reservations: readonly LockedReservation[];
  readonly serials: readonly LockedSerial[];
}

class StockLockErrorImpl extends Error implements StockLockError {
  override readonly name = "StockLockError" as const;
  readonly code: StockLockErrorCode;
  readonly detail: string | undefined;
  constructor(code: StockLockErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

const STOCK_STATUS_SET: ReadonlySet<string> = new Set(["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"]);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** NULL önce (PostgreSQL `ORDER BY … NULLS FIRST`). */
const cmpNullsFirst = (a: string | null, b: string | null): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return cmp(a, b);
};

const uuid = (value: unknown, what: string): string => {
  if (!isUuid(value)) throw new StockLockErrorImpl("VALIDATION_FAILED", `${what} must be a UUID`);
  return value.toLowerCase();
};
const uuidOrNull = (value: unknown, what: string): string | null => (value === null ? null : uuid(value, what));

/** Tekilleştirilmiş, artan UUID listesi (`Set` + sort). */
const sortedUniqueIds = (values: readonly string[], what: string): string[] => {
  if (!Array.isArray(values)) throw new StockLockErrorImpl("VALIDATION_FAILED", `${what} must be an array`);
  return [...new Set(values.map((v) => uuid(v, what)))].sort(cmp);
};

const compareDimensionKeys = (a: StockDimensionKey, b: StockDimensionKey): number =>
  cmp(a.itemId, b.itemId) ||
  cmp(a.locationId, b.locationId) ||
  cmpNullsFirst(a.lotId, b.lotId) ||
  cmpNullsFirst(a.serialId, b.serialId) ||
  cmp(a.stockStatus, b.stockStatus) ||
  cmpNullsFirst(a.inventoryOwnerId, b.inventoryOwnerId) ||
  cmpNullsFirst(a.handlingUnitId, b.handlingUnitId);

const dimensionIdentity = (k: StockDimensionKey): string =>
  [k.itemId, k.locationId, k.lotId ?? "", k.serialId ?? "", k.stockStatus, k.inventoryOwnerId ?? "", k.handlingUnitId ?? ""].join("|");

const normalizeKey = (raw: StockDimensionKey): StockDimensionKey => {
  if (!STOCK_STATUS_SET.has(raw?.stockStatus)) throw new StockLockErrorImpl("VALIDATION_FAILED", "stockStatus is not a stock status");
  return {
    itemId: uuid(raw.itemId, "dimension.itemId"),
    locationId: uuid(raw.locationId, "dimension.locationId"),
    lotId: uuidOrNull(raw.lotId, "dimension.lotId"),
    serialId: uuidOrNull(raw.serialId, "dimension.serialId"),
    stockStatus: raw.stockStatus,
    inventoryOwnerId: uuidOrNull(raw.inventoryOwnerId, "dimension.inventoryOwnerId"),
    handlingUnitId: uuidOrNull(raw.handlingUnitId, "dimension.handlingUnitId"),
  };
};

interface NormalizedPlan {
  readonly document: { readonly id: string; readonly expectedVersion: number } | undefined;
  readonly locationIds: string[];
  readonly dimensions: StockDimensionKey[];
  readonly reservationIds: string[];
  readonly serialIds: string[];
  readonly countSessionId: string | undefined;
}

/** Plan normalizasyonu: doğrulama, küçük harf, tekilleştirme, sıralama. Boş adım boş dizidir (adım atlanır). */
const normalizePlan = (plan: StockLockPlan): NormalizedPlan => {
  let document: NormalizedPlan["document"];
  if (plan.document !== undefined) {
    const v = plan.document.expectedVersion;
    if (!Number.isSafeInteger(v) || v < 0) throw new StockLockErrorImpl("VALIDATION_FAILED", "document.expectedVersion must be a non-negative integer");
    document = { id: uuid(plan.document.id, "document.id"), expectedVersion: v };
  }
  const serialIds = sortedUniqueIds(plan.serialIds, "serialIds");
  if (serialIds.length > 0 && !serialLockEnabled()) {
    throw new StockLockErrorImpl("VALIDATION_FAILED", "serial locking is disabled (STOCK_SERIAL_LOCK_ENABLED, Q-56)");
  }
  const unique = new Map<string, StockDimensionKey>();
  for (const raw of plan.dimensions) {
    const k = normalizeKey(raw);
    unique.set(dimensionIdentity(k), k);
  }
  return {
    document,
    locationIds: sortedUniqueIds(plan.locationIds, "locationIds"),
    dimensions: [...unique.values()].sort(compareDimensionKeys),
    reservationIds: sortedUniqueIds(plan.reservationIds, "reservationIds"),
    serialIds,
    countSessionId: plan.countSessionId === undefined ? undefined : uuid(plan.countSessionId, "countSessionId"),
  };
};

/** Denetlenen lokasyon kümesi: `locationIds` ∪ `dimensions[].locationId` (boyutu olup `locationIds`'te unutulan lokasyon da denetlenir). */
const auditedLocationIds = (p: NormalizedPlan): string[] => [...new Set([...p.locationIds, ...p.dimensions.map((d) => d.locationId)])].sort(cmp);

/**
 * Sayım kilidi kararı (saf): sayım oturumu verilmemişse hiçbir lokasyon COUNTING olamaz; verilmişse İSTİSNA yalnızca TÜM
 * lokasyonlar aynı oturuma kilitliyken geçer (biri IDLE ya da başka oturumdaysa reddedilir). Reddedilen lokasyon ya da `null`.
 */
const firstBlockedLocation = (rows: readonly LockedLocation[], countSessionId: string | undefined): string | null => {
  for (const r of rows) {
    const allowed = countSessionId === undefined ? r.status === "IDLE" : r.status === "COUNTING" && r.countSessionId === countSessionId;
    if (!allowed) return r.locationId;
  }
  return null;
};

const uuidArray = (ids: readonly string[]): SQL => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function lockDocument(tx: TenantTx, tenantId: string, doc: NonNullable<NormalizedPlan["document"]>): Promise<LockedDocument> {
  const rows = await tx.execute<Row>(
    sql`SELECT id, version, status, warehouse_id FROM public.documents WHERE tenant_id = ${tenantId}::uuid AND id = ${doc.id}::uuid FOR UPDATE`,
  );
  const r = rows[0];
  if (r === undefined) throw new StockLockErrorImpl("NOT_FOUND", "document");
  const version = Number(r.version);
  if (version !== doc.expectedVersion) throw new StockLockErrorImpl("VERSION_CONFLICT", "document version changed");
  return { id: str(r.id), version, status: str(r.status), warehouseId: str(r.warehouse_id) };
}

async function assertLocationsNotCounting(tx: TenantTx, tenantId: string, ids: readonly string[], countSessionId: string | undefined): Promise<LockedLocation[]> {
  const ar = uuidArray(ids);
  const lockMode = countSessionId === undefined ? sql`FOR SHARE` : sql`FOR UPDATE`;
  const rows = await tx.execute<Row>(
    sql`SELECT location_id, status, count_session_id FROM public.location_count_locks
         WHERE tenant_id = ${tenantId}::uuid AND location_id = ANY(${ar}) ORDER BY location_id ${lockMode}`,
  );
  const locations: LockedLocation[] = rows.map((r) => ({
    locationId: str(r.location_id),
    status: str(r.status) as LockedLocation["status"],
    countSessionId: strOrNull(r.count_session_id),
  }));
  const found = new Set(locations.map((l) => l.locationId));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    // Varlık oracle'ı yok (15 §Öncelik kuralı): lokasyon çağıranın tenant'ında görünmüyorsa NOT_FOUND; görünüyor ama
    // kilit satırı yoksa veri bütünlüğü ihlali (COUNT_LOCK_ROW_MISSING).
    const visible = await tx.execute<Row>(
      sql`SELECT id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${uuidArray(missing)})`,
    );
    if (visible.length < missing.length) throw new StockLockErrorImpl("NOT_FOUND", "location");
    throw new StockLockErrorImpl("COUNT_LOCK_ROW_MISSING", "location count lock row missing");
  }
  if (firstBlockedLocation(locations, countSessionId) !== null) throw new StockLockErrorImpl("LOCATION_LOCKED", "location is locked");
  return locations;
}

async function ensureDimensions(tx: TenantTx, tenantId: string, keys: readonly StockDimensionKey[]): Promise<LockedDimension[]> {
  const json = JSON.stringify(
    keys.map((k, i) => ({
      ord: i,
      item_id: k.itemId,
      location_id: k.locationId,
      lot_id: k.lotId,
      serial_id: k.serialId,
      stock_status: k.stockStatus,
      inventory_owner_id: k.inventoryOwnerId,
      handling_unit_id: k.handlingUnitId,
    })),
  );
  const recordset = sql`jsonb_to_recordset(${json}::jsonb) AS w(ord int, item_id uuid, location_id uuid, lot_id uuid, serial_id uuid, stock_status text, inventory_owner_id uuid, handling_unit_id uuid)`;
  // Sıralı ekleme: uygulama sırası = doğal anahtar sırası (`ord`; sütun tanım listesi WITH ORDINALITY ile birlikte kullanılamaz). Çakışma (eşzamanlı ekleyen) sessizce atlanır.
  await tx.execute(
    sql`INSERT INTO public.stock_dimensions (tenant_id, item_id, location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id)
        SELECT ${tenantId}::uuid, w.item_id, w.location_id, w.lot_id, w.serial_id, w.stock_status, w.inventory_owner_id, w.handling_unit_id
          FROM ${recordset} ORDER BY w.ord
        ON CONFLICT ON CONSTRAINT stock_dimensions_natural_key DO NOTHING`,
  );
  const rows = await tx.execute<Row>(
    sql`SELECT d.id, d.item_id, d.location_id, d.lot_id, d.serial_id, d.stock_status, d.inventory_owner_id, d.handling_unit_id, w.ord
          FROM ${recordset}
          JOIN public.stock_dimensions d
            ON d.tenant_id = ${tenantId}::uuid AND d.item_id = w.item_id AND d.location_id = w.location_id
           AND d.lot_id IS NOT DISTINCT FROM w.lot_id AND d.serial_id IS NOT DISTINCT FROM w.serial_id
           AND d.stock_status = w.stock_status AND d.inventory_owner_id IS NOT DISTINCT FROM w.inventory_owner_id
           AND d.handling_unit_id IS NOT DISTINCT FROM w.handling_unit_id
         ORDER BY w.ord`,
  );
  if (rows.length !== keys.length) throw new StockLockErrorImpl("INTERNAL", "stock dimension rows not found after ensure");
  return rows.map((r) => ({
    id: str(r.id),
    key: {
      itemId: str(r.item_id),
      locationId: str(r.location_id),
      lotId: strOrNull(r.lot_id),
      serialId: strOrNull(r.serial_id),
      stockStatus: str(r.stock_status) as StockDimensionKey["stockStatus"],
      inventoryOwnerId: strOrNull(r.inventory_owner_id),
      handlingUnitId: strOrNull(r.handling_unit_id),
    },
  }));
}

async function ensureBalanceRows(tx: TenantTx, tenantId: string, dimensionIds: readonly string[]): Promise<void> {
  // `stock_dimension_id` artan; miktar/rezerve/sürüm sütun varsayılanlarıdır (0); `serial_key` tetikleyiciyle yazılır.
  await tx.execute(
    sql`INSERT INTO public.stock_balances (tenant_id, stock_dimension_id)
        SELECT ${tenantId}::uuid, u.id FROM unnest(${uuidArray(dimensionIds)}) AS u(id) ORDER BY u.id
        ON CONFLICT ON CONSTRAINT stock_balances_pkey DO NOTHING`,
  );
}

async function lockBalances(tx: TenantTx, tenantId: string, dimensionIds: readonly string[]): Promise<LockedBalance[]> {
  const rows = await tx.execute<Row>(
    sql`SELECT stock_dimension_id, quantity::text AS quantity, reserved_quantity::text AS reserved_quantity, version::text AS version
          FROM public.stock_balances
         WHERE tenant_id = ${tenantId}::uuid AND stock_dimension_id = ANY(${uuidArray(dimensionIds)})
         ORDER BY stock_dimension_id FOR UPDATE`,
  );
  if (rows.length !== dimensionIds.length) throw new StockLockErrorImpl("INTERNAL", "stock balance rows missing after ensure");
  return rows.map((r) => ({
    stockDimensionId: str(r.stock_dimension_id),
    quantity: str(r.quantity),
    reservedQuantity: str(r.reserved_quantity),
    version: str(r.version),
  }));
}

async function lockReservations(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<LockedReservation[]> {
  const rows = await tx.execute<Row>(
    sql`SELECT id, stock_dimension_id, document_line_id, quantity::text AS quantity, status
          FROM public.reservations
         WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${uuidArray(ids)})
         ORDER BY id FOR UPDATE`,
  );
  if (rows.length !== ids.length) throw new StockLockErrorImpl("NOT_FOUND", "reservation");
  return rows.map((r) => ({
    id: str(r.id),
    stockDimensionId: str(r.stock_dimension_id),
    documentLineId: str(r.document_line_id),
    quantity: str(r.quantity),
    status: str(r.status),
  }));
}

/**
 * T-256 (40P01 kök nedeni): adım 3'te YENİ boyut satırı eklenirken `stock_dimensions_serial_fkey` `serials` satırında `FOR KEY SHARE`
 * alır (transaction sonuna dek). Burada `FOR UPDATE` olsaydı KEY SHARE ile çakışırdı: aynı seriyi isteyen iki işlem adım 3'te
 * KEY SHARE'i birlikte alıp adım 6'da birbirini beklerdi (tek anahtar olduğundan id sırası çözmez). `FOR NO KEY UPDATE` KEY SHARE ile
 * çakışmaz, kendisiyle çakışır: aynı seriyi kilitleyen komutlar yine seri çalışır; seri satırı değişmez (anahtar sütunlar zaten
 * değişmez; 0015 tetikleyicisi). Sıra (id artan) ve adım yeri (I-15: en son) aynı kalır.
 */
async function lockSerials(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<LockedSerial[]> {
  const rows = await tx.execute<Row>(
    sql`SELECT id, item_id, serial_no, lot_id FROM public.serials
         WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${uuidArray(ids)})
         ORDER BY id FOR NO KEY UPDATE`,
  );
  if (rows.length !== ids.length) throw new StockLockErrorImpl("NOT_FOUND", "serial");
  return rows.map((r) => ({ id: str(r.id), itemId: str(r.item_id), serialNo: str(r.serial_no), lotId: strOrNull(r.lot_id) }));
}

/**
 * Stok kilitlerinin TEK giriş noktası (I-15). `tx` tenant bağlamı kurulmuş transaction olmalıdır; `tenantId` o bağlamla
 * aynıdır (RLS ek olarak zorlar). Plan önceden ve tam bildirilir; adımlar sabit sırada, boş olanlar atlanarak çalışır.
 */
export async function acquireStockLocks(tx: TenantTx, tenantId: string, plan: StockLockPlan): Promise<LockedState> {
  const tenant = uuid(tenantId, "tenantId");
  const p = normalizePlan(plan);
  const audited = auditedLocationIds(p);
  if (p.countSessionId !== undefined && audited.length === 0) {
    throw new StockLockErrorImpl("VALIDATION_FAILED", "countSessionId requires at least one location in the plan");
  }
  // Çağıranın tenantId'si transaction'daki tenant bağlamıyla aynı olmalı (RLS başka tenant'ı süzer; yanlış kimlik sessiz boş sonuç olmasın).
  const contextTenant = await currentTenantId(tx);
  if (contextTenant === undefined || contextTenant.toLowerCase() !== tenant) {
    throw new StockLockErrorImpl("FORBIDDEN", "tenantId does not match the transaction tenant context");
  }

  const document = p.document === undefined ? undefined : await lockDocument(tx, tenant, p.document);
  const locations = audited.length === 0 ? [] : await assertLocationsNotCounting(tx, tenant, audited, p.countSessionId);

  let dimensions: LockedDimension[] = [];
  let balances: LockedBalance[] = [];
  if (p.dimensions.length > 0) {
    dimensions = await ensureDimensions(tx, tenant, p.dimensions);
    const ids = [...new Set(dimensions.map((d) => d.id))].sort(cmp);
    await ensureBalanceRows(tx, tenant, ids);
    balances = await lockBalances(tx, tenant, ids);
  }
  const reservations = p.reservationIds.length === 0 ? [] : await lockReservations(tx, tenant, p.reservationIds);
  const serials = p.serialIds.length === 0 ? [] : await lockSerials(tx, tenant, p.serialIds);
  return { document, locations, dimensions, balances, reservations, serials };
}
