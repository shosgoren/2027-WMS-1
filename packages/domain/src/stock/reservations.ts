// Rezervasyon komutları (T-221; ADR-009 sert tahsis, 05 §Rezervasyon ve hareketler, 16 §Temel kurallar 2/5/7, I-04, I-15, A-76, A-145).
//
// Rezervasyon defter satırı ÜRETMEZ ve fiziksel miktarı değiştirmez (kural 2); yalnızca `reservations` satırı ve boyutun `reserved_quantity` yansıması
// yazılır (DB: reserved_quantity = Σ ACTIVE rezervasyon, ertelenmiş denetim). Her komut `executeStockCommand` içindedir; kilitler YALNIZCA
// `acquireStockLocks` ile ve plan önceden tam bildirilerek alınır (belge → sayım kilidi → bakiye → rezervasyon); burada kendi kilit sorgusu YOKTUR.
//   - `reserve` (`document.approve`): APPROVED `STOCK_OUT`/`STOCK_MOVE` belge satırını belirli boyutlara bağlar. Yalnızca kural 5'e uyan boyut
//     (AVAILABLE, STORAGE|STAGING, pick_blocked=false) rezerve edilir, aksi `INSUFFICIENT_STOCK`. Satır başına Σ ACTIVE ≤ satır `base_quantity`.
//   - `release` (`document.approve`): kısmi/tam; fiziksel stok yerinde (kural 7). Sonuçta `needsPutaway` (mal STAGING'te kalıyorsa) — görev 3A'dadır.
//   - `releaseForCancellation`: `cancelDocument`'ın açık rezervasyonları aynı transaction'da kapatma adımı (documents.ts stok tablosuna yazmaz, M-4).
//   - `closeReservations` / `moveReservations` / `applyReservedDeltas`: `posting.ts`'in çıkışta tüketim ve toplama taşıması için kullandığı yazıcılar.
// Yazımlar açık sütun listelidir (item_id/closed_at/created_at sunucu/tetikleyici değeridir). Kilitten SONRA lokasyon/ürün `FOR SHARE` okumaları
// `documents.ts` yardımcılarıyla yapılır.
//
// A-xx (rapor): A-221-1 `release` belge durumundan bağımsızdır (POSTED belgenin artık ACTIVE rezervasyonu da bırakılabilir; işleme kilidi hariç);
// A-221-2 `reserve`/`release` izni `document.approve`; A-221-3 `reserve` hareketin dokunduğu lokasyonları sayım kilidi denetimine sokar
// (`LOCATION_LOCKED`), `release`/iptal sokmaz (fiziksel hareket yok, iptal engellenemez); A-221-4 kısmi tüketim/serbest bırakma/taşımada rezervasyon
// BÖLÜNÜR: kalan ACTIVE satır azalır, kapanan/taşınan pay yeni satırdır (sonlanmış satır değişmez, DB koruması); A-221-5 taşıma hedefi de kural 5'e
// uygun olmalıdır (aksi `INSUFFICIENT_STOCK`); A-221-6 bölünen taşımada `expires_at` kopyalanır (geçmişse CHECK reddi → `VALIDATION_FAILED`).
import { sql } from "drizzle-orm";
import type { LockedState, StockDimensionKey } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery, type AccessTx, type Membership } from "../identity/access.ts";
import { pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import { EMPTY_LOCK_PLAN, executeStockCommand, type StockCommandOutcome, type StockCommandPlan } from "./command.ts";
import type { StockCommandResult } from "./idempotency.ts";
import {
  allocateAcross,
  dimensionIdentity,
  fromMicro,
  remainingToReserve,
  sourceColumns,
  toMicro,
  type LedgerEntry,
  type PostingKind,
  type ReservationSource,
  type ReservationSlice,
  type ReservationTake,
} from "./plan.ts";
import { readAvailability, type AvailabilityFilter, type AvailabilityRow } from "./availability.ts";
import {
  assertItemsActive,
  assertLocationsActiveInWarehouse,
  assertNotProcessing,
  cmp,
  lockedDimensionIdByIdentity,
  readDocumentHeader,
  readReservationPlanRows,
  stagedAmong,
  uniqueKeys,
  uuid,
  uuidOrNull,
  versionConflict,
  type ReservationPlanRow,
  type StockDocCallParams,
} from "./reservation-reads.ts";

// Okuma modülünün (reservation-reads.ts) rezervasyon okumaları buradan da erişilir kalır (posting.ts yolu değişmez).
export { readCancellationLockSet, readReservationPlanRows, type ReservationPlanRow } from "./reservation-reads.ts";

export const RESERVATION_EXPIRY_FLAG = "RESERVATION_EXPIRY_ENABLED";
/** A-76: otomatik süre aşımı işi yok; bayrak varsayılan KAPALI ve bu kartta yalnızca okunur. Yalnızca `true`/`1` açar. */
export function isReservationExpiryEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[RESERVATION_EXPIRY_FLAG]?.trim().toLowerCase();
  return v === "true" || v === "1";
}

const STATUSES: ReadonlySet<string> = new Set(["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"]);
const RESERVABLE_KINDS: ReadonlySet<string> = new Set(["STOCK_OUT", "STOCK_MOVE"]);
const MAX_ALLOCATIONS = 200;
const invalid = (): AppError => new AppError("VALIDATION_FAILED");
const documentState = (): AppError => new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" });

function positiveMicro(raw: unknown): bigint {
  if (typeof raw !== "string") throw invalid();
  const n = toMicro(raw);
  if (n <= 0n) throw invalid();
  return n;
}
function versionOf(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) throw invalid();
  return raw;
}

// --- girdiler --------------------------------------------------------------------------------------------------------------

export interface ReservationDimensionInput {
  readonly locationId: string;
  readonly lotId?: string | null;
  readonly serialId?: string | null;
  readonly stockStatus?: StockDimensionKey["stockStatus"];
  readonly inventoryOwnerId?: string | null;
  readonly handlingUnitId?: string | null;
}
export interface ReservationAllocationInput {
  readonly dimension: ReservationDimensionInput;
  /** Pozitif ondalık dizgi (temel birim; I-09). */
  readonly quantity: string;
}
export interface ReserveInput {
  readonly documentLineId: string;
  readonly allocations: readonly ReservationAllocationInput[];
  /** İsteğe bağlı süre (ISO 8601, gelecekte); otomatik süre aşımı işi yoktur (A-76). */
  readonly expiresAt?: string | null;
  /** Verilmezse plan anındaki belge sürümü kullanılır (araya giren değişiklik `VERSION_CONFLICT`). */
  readonly expectedVersion?: number;
  readonly requestId?: string | null;
}
export interface ReleaseInput {
  /** Tam olarak biri verilir. */
  readonly reservationId?: string;
  readonly documentLineId?: string;
  /** Verilmezse tamamı; kısmi için pozitif ondalık dizgi. */
  readonly quantity?: string;
  readonly expectedVersion?: number;
  readonly requestId?: string | null;
}

type Normalized = { readonly key: StockDimensionKey; readonly qty: bigint };

function normalizeAllocations(itemId: string, raw: unknown): Normalized[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ALLOCATIONS) throw invalid();
  return (raw as unknown[]).map((a) => {
    if (a === null || typeof a !== "object") throw invalid();
    const { dimension: d, quantity } = a as { dimension?: unknown; quantity?: unknown };
    if (d === null || typeof d !== "object") throw invalid();
    const x = d as Record<string, unknown>;
    const status = x.stockStatus === undefined ? "AVAILABLE" : x.stockStatus;
    if (typeof status !== "string" || !STATUSES.has(status)) throw invalid();
    return {
      key: {
        itemId,
        locationId: uuid(x.locationId),
        lotId: uuidOrNull(x.lotId),
        serialId: uuidOrNull(x.serialId),
        stockStatus: status as StockDimensionKey["stockStatus"],
        inventoryOwnerId: uuidOrNull(x.inventoryOwnerId),
        handlingUnitId: uuidOrNull(x.handlingUnitId),
      },
      qty: positiveMicro(quantity),
    };
  });
}

// --- okumalar --------------------------------------------------------------------------------------------------------------

type LineRow = {
  line_id: string;
  document_id: string;
  item_id: string;
  base_quantity: string;
  warehouse_id: string;
  version: number | string;
};

/** Plan için salt okuma (kilitsiz): satır + belge başlığı. Yok → `NOT_FOUND`. */
async function readLine(tx: AccessTx, tenantId: string, lineId: string): Promise<LineRow> {
  const rows = await tx.execute<LineRow>(
    sql`SELECT l.id AS line_id, l.document_id, l.item_id, l.base_quantity::text AS base_quantity, d.warehouse_id, d.version
          FROM public.document_lines l
          JOIN public.documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
         WHERE l.tenant_id = ${tenantId}::uuid AND l.id = ${lineId}::uuid`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  return r;
}

async function locationWarehouses(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ warehouse_id: string }>(
    sql`SELECT DISTINCT warehouse_id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
  );
  return rows.map((r) => r.warehouse_id);
}

// --- ortak yazıcılar (posting.ts de kullanır) ---------------------------------------------------------------------------------

/**
 * Kural 5 uygunluğu: boyut `AVAILABLE`, lokasyon `STORAGE|STAGING` ve `pick_blocked = false`; aksi `INSUFFICIENT_STOCK` (ADR-009: sevke uygun
 * olmayan stok rezerve edilemez). Lokasyonlar çağıranın `assertLocationsActiveInWarehouse` ile `FOR SHARE` kilitlediği satırlardır.
 */
export async function assertReservableDimensions(
  tx: AccessTx,
  tenantId: string,
  dims: readonly { readonly id: string; readonly key: StockDimensionKey }[],
): Promise<void> {
  const ok = await reservableDimensionIds(tx, tenantId, dims);
  if (dims.some((d) => !ok.has(d.id))) throw new AppError("INSUFFICIENT_STOCK");
}

/** Kural 5'e uyan boyut kimlikleri (AVAILABLE ∧ STORAGE|STAGING ∧ !pick_blocked). Lokasyonu olmayan boyut → `NOT_FOUND`. */
async function reservableDimensionIds(
  tx: AccessTx,
  tenantId: string,
  dims: readonly { readonly id: string; readonly key: StockDimensionKey }[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const locIds = [...new Set(dims.map((d) => d.key.locationId))].sort(cmp);
  if (locIds.length === 0) return out;
  const rows = await tx.execute<{ id: string; kind: string; pick_blocked: boolean }>(
    sql`SELECT id, kind, pick_blocked FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(locIds)}::uuid[])`,
  );
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  for (const d of dims) {
    const l = byId.get(d.key.locationId.toLowerCase());
    if (l === undefined) throw new AppError("NOT_FOUND");
    if (d.key.stockStatus === "AVAILABLE" && (l.kind === "STORAGE" || l.kind === "STAGING") && !l.pick_blocked) out.add(d.id);
  }
  return out;
}

// --- ortak yazıcılar (posting.ts ve cancelDocument kullanır) ---------------------------------------------------------------------

/**
 * `reserved_quantity` değişimleri (işaretli, boyut kimliği → 1e-6 ölçekli). Yalnızca KİLİTLİ bakiye satırlarına yazılır (çağıran kilitli
 * görüntüden türetir). DB CHECK (0 ≤ reserved ≤ quantity) satır başına anında denetlenir; ihlal `VALIDATION_FAILED`'a eşlenir.
 */
export async function applyReservedDeltas(tx: AccessTx, tenantId: string, deltas: ReadonlyMap<string, bigint>): Promise<void> {
  const nonZero = [...deltas].filter(([, n]) => n !== 0n).sort(([a], [b]) => cmp(a, b));
  if (nonZero.length === 0) return;
  const json = JSON.stringify(nonZero.map(([dimension_id, n]) => ({ dimension_id, delta: fromMicro(n) })));
  const rows = await tx.execute<{ stock_dimension_id: string }>(
    sql`UPDATE public.stock_balances b SET reserved_quantity = b.reserved_quantity + w.delta, version = b.version + 1
          FROM jsonb_to_recordset(${json}::jsonb) AS w(dimension_id uuid, delta numeric)
         WHERE b.tenant_id = ${tenantId}::uuid AND b.stock_dimension_id = w.dimension_id
        RETURNING b.stock_dimension_id`,
  );
  if (rows.length !== nonZero.length) throw new AppError("INTERNAL");
}

/** Kilitli rezervasyonun işlenecek payı. */
export interface ReservationOp extends ReservationTake {
  readonly dimensionId: string;
  /** Talep kaynağı; bölünen payın yeni satırı aynı kaynağa yazılır (T-306: belge satırı | sipariş satırı). */
  readonly source: ReservationSource;
}

/**
 * Rezervasyonları kapatır (`CONSUMED`/`RELEASED`). Tam pay: satırın durumu değişir. Kısmi pay: kalan ACTIVE satırın miktarı azalır, kapanan pay
 * YENİ satırdır (önce ACTIVE eklenir, sonra durum değişir: `closed_at` sunucu değeridir, sonlanmış satır değişmez). Kapanan satır kimliklerini döndürür.
 */
export async function closeReservations(tx: AccessTx, tenantId: string, status: "CONSUMED" | "RELEASED", ops: readonly ReservationOp[]): Promise<string[]> {
  if (ops.length === 0) return [];
  const sorted = [...ops].sort((a, b) => cmp(a.id, b.id));
  const full = sorted.filter((o) => o.rest === 0n);
  const part = sorted.filter((o) => o.rest > 0n);
  const closed: string[] = [];
  if (part.length > 0) {
    const shrink = JSON.stringify(part.map((o) => ({ id: o.id, quantity: fromMicro(o.rest) })));
    const shrunk = await tx.execute<{ id: string }>(
      sql`UPDATE public.reservations r SET quantity = w.quantity
            FROM jsonb_to_recordset(${shrink}::jsonb) AS w(id uuid, quantity numeric)
           WHERE r.tenant_id = ${tenantId}::uuid AND r.id = w.id AND r.status = 'ACTIVE'
          RETURNING r.id`,
    );
    if (shrunk.length !== part.length) throw new AppError("INTERNAL");
    const slices = JSON.stringify(part.map((o, ord) => ({ ord, dimension_id: o.dimensionId, ...sourceColumns(o.source), quantity: fromMicro(o.take) })));
    const inserted = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.reservations (tenant_id, stock_dimension_id, document_line_id, order_line_id, quantity)
          SELECT ${tenantId}::uuid, w.dimension_id, w.document_line_id, w.order_line_id, w.quantity
            FROM jsonb_to_recordset(${slices}::jsonb) AS w(ord int, dimension_id uuid, document_line_id uuid, order_line_id uuid, quantity numeric)
           ORDER BY w.ord
          RETURNING id`,
    );
    if (inserted.length !== part.length) throw new AppError("INTERNAL");
    closed.push(...inserted.map((r) => r.id));
  }
  const closeIds = [...full.map((o) => o.id), ...closed];
  const done = await tx.execute<{ id: string }>(
    sql`UPDATE public.reservations SET status = ${status}
         WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(closeIds)}::uuid[]) AND status = 'ACTIVE'
        RETURNING id`,
  );
  if (done.length !== closeIds.length) throw new AppError("INTERNAL");
  return closeIds;
}

/**
 * `cancelDocument.apply` adımı: belgenin ACTIVE rezervasyonlarını aynı transaction'da, kilitli görüntü üzerinde kapatır (`RELEASED`) ve boyut
 * `reserved_quantity`'sini düşürür; böylece ertelenmiş denetim (reserved = Σ ACTIVE) iptal sonrası tutar. Plan sonrası kümeye giren ya da
 * boyutu değişen rezervasyon (taşıma işlemi araya girdi) → `VERSION_CONFLICT` (kilit planı genişletilip baştan çalıştırılır; I-15).
 * Küme KİLİTTEN SONRA yeniden okunur (plan anındaki küme karara girmez). Döner: kapanan satır kimlikleri.
 */
export async function releaseForCancellation(tx: AccessTx, tenantId: string, locked: LockedState, documentId: string): Promise<string[]> {
  const fresh = await readReservationPlanRows(tx, tenantId, { documentId });
  if (fresh.length === 0) return [];
  const lockedById = new Map(locked.reservations.map((r) => [r.id.toLowerCase(), r]));
  const dimIds = lockedDimensionIdByIdentity(locked);
  const ops: ReservationOp[] = [];
  const deltas = new Map<string, bigint>();
  for (const r of fresh) {
    const lr = lockedById.get(r.id.toLowerCase());
    const dimId = dimIds.get(dimensionIdentity(r.key));
    if (lr === undefined || lr.status !== "ACTIVE" || dimId === undefined || lr.stockDimensionId !== dimId) throw versionConflict();
    const q = toMicro(lr.quantity);
    ops.push({ id: lr.id, take: q, rest: 0n, dimensionId: dimId, source: r.source });
    deltas.set(dimId, (deltas.get(dimId) ?? 0n) - q);
  }
  const closed = await closeReservations(tx, tenantId, "RELEASED", ops);
  await applyReservedDeltas(tx, tenantId, deltas);
  return closed;
}

export interface ReservationMoveOp extends ReservationTake {
  readonly source: ReservationSource;
  readonly sourceDimensionId: string;
  readonly targetDimensionId: string;
}

/**
 * Toplama taşıması (kural: rezervasyon malla birlikte hedef boyuta gider): tam pay → satırın `stock_dimension_id`'si hedefe güncellenir; kısmi pay →
 * kalan kaynakta azalır, taşınan pay hedefte YENİ ACTIVE satırdır (`expires_at` kopyalanır). Taşınan satır kimliklerini döndürür.
 */
export async function moveReservations(tx: AccessTx, tenantId: string, ops: readonly ReservationMoveOp[]): Promise<string[]> {
  if (ops.length === 0) return [];
  const sorted = [...ops].sort((a, b) => cmp(a.id, b.id));
  const full = sorted.filter((o) => o.rest === 0n);
  const part = sorted.filter((o) => o.rest > 0n);
  const moved: string[] = [];
  if (full.length > 0) {
    const json = JSON.stringify(full.map((o) => ({ id: o.id, dimension_id: o.targetDimensionId })));
    const rows = await tx.execute<{ id: string }>(
      sql`UPDATE public.reservations r SET stock_dimension_id = w.dimension_id
            FROM jsonb_to_recordset(${json}::jsonb) AS w(id uuid, dimension_id uuid)
           WHERE r.tenant_id = ${tenantId}::uuid AND r.id = w.id AND r.status = 'ACTIVE'
          RETURNING r.id`,
    );
    if (rows.length !== full.length) throw new AppError("INTERNAL");
    moved.push(...rows.map((r) => r.id));
  }
  if (part.length > 0) {
    const shrink = JSON.stringify(part.map((o) => ({ id: o.id, quantity: fromMicro(o.rest) })));
    const shrunk = await tx.execute<{ id: string }>(
      sql`UPDATE public.reservations r SET quantity = w.quantity
            FROM jsonb_to_recordset(${shrink}::jsonb) AS w(id uuid, quantity numeric)
           WHERE r.tenant_id = ${tenantId}::uuid AND r.id = w.id AND r.status = 'ACTIVE'
          RETURNING r.id`,
    );
    if (shrunk.length !== part.length) throw new AppError("INTERNAL");
    const slices = JSON.stringify(part.map((o, ord) => ({ ord, src: o.id, dimension_id: o.targetDimensionId, quantity: fromMicro(o.take) })));
    const inserted = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.reservations (tenant_id, stock_dimension_id, document_line_id, order_line_id, quantity, expires_at)
          SELECT ${tenantId}::uuid, w.dimension_id, s.document_line_id, s.order_line_id, w.quantity, s.expires_at
            FROM jsonb_to_recordset(${slices}::jsonb) AS w(ord int, src uuid, dimension_id uuid, quantity numeric)
            JOIN public.reservations s ON s.tenant_id = ${tenantId}::uuid AND s.id = w.src
           ORDER BY w.ord
          RETURNING id`,
    );
    if (inserted.length !== part.length) throw new AppError("INTERNAL");
    moved.push(...inserted.map((r) => r.id));
  }
  return moved;
}

// --- işleme etkisi (posting.ts): çıkışta tüketim ve toplama taşıması (saf; kilitli görüntü üzerinde) -------------------------------------

/** `STOCK_MOVE` satırının taşıdığı rezervasyonlar (toplama: rezervasyon malla birlikte hedef boyuta gider). */
export interface ReservationMoveInput {
  readonly lineId: string;
  readonly reservationIds: readonly string[];
}

export interface ReservationEffects {
  readonly consumeOps: readonly ReservationOp[];
  readonly moveOps: readonly ReservationMoveOp[];
  /** Boyut kimliği → `reserved_quantity` değişimi (işaretli). */
  readonly reservedDelta: ReadonlyMap<string, bigint>;
  /** Boyut kimliği (`dimensionIdentity`) → bu işlemde o boyuttan çıkan KENDİ rezervasyonu (yeterlilikte `reserved`'dan düşülür). */
  readonly ownReserved: ReadonlyMap<string, bigint>;
  /** Rezervasyonun taşındığı hedef boyutlar (kural 5 uygunluğu denetlenir). */
  readonly targetDims: readonly { readonly id: string; readonly key: StockDimensionKey }[];
}

const NO_EFFECTS: ReservationEffects = { consumeOps: [], moveOps: [], reservedDelta: new Map(), ownReserved: new Map(), targetDims: [] };

/**
 * İşleme planından rezervasyon etkisi (16 Senaryo A adım 6-7). `STOCK_OUT`: satırın KENDİ ACTIVE rezervasyonlarından, satırın kaynak boyutundakiler
 * önce tüketilir (`min(Σ, çıkış)`; kalan ACTIVE). `STOCK_MOVE`: `moves` ile verilen rezervasyonlar satırın kaynak boyutunda olmalı; `min(Σ, miktar)`
 * kadarı hedef boyuta taşınır. Başka boyuttaki ya da başka satırın rezervasyonuna dokunulmaz. Kilitli görüntüde olmayan/ACTIVE olmayan/kaynak boyutta
 * olmayan rezervasyon `VALIDATION_FAILED`. Aynı rezervasyon iki satırda geçemez.
 */
export function planReservationEffects(args: {
  readonly kind: PostingKind;
  readonly entries: readonly LedgerEntry[];
  readonly locked: LockedState;
  readonly dimIdByIdentity: ReadonlyMap<string, string>;
  readonly moves?: readonly ReservationMoveInput[] | undefined;
}): ReservationEffects {
  const { kind, entries, locked, dimIdByIdentity } = args;
  const moves = args.moves ?? [];
  if (kind === "STOCK_IN") {
    if (moves.length > 0) throw invalid();
    return NO_EFFECTS;
  }
  const dimOf = (k: StockDimensionKey): string => {
    const id = dimIdByIdentity.get(dimensionIdentity(k));
    if (id === undefined) throw new AppError("INTERNAL");
    return id;
  };
  const byLine = new Map<string, LedgerEntry[]>();
  for (const e of entries) byLine.set(e.lineId.toLowerCase(), [...(byLine.get(e.lineId.toLowerCase()) ?? []), e]);
  const lockedActive = new Map(locked.reservations.filter((r) => r.status === "ACTIVE").map((r) => [r.id.toLowerCase(), r]));
  const consumeOps: ReservationOp[] = [];
  const moveOps: ReservationMoveOp[] = [];
  const reservedDelta = new Map<string, bigint>();
  const ownReserved = new Map<string, bigint>();
  const targetDims = new Map<string, { id: string; key: StockDimensionKey }>();
  const bump = (m: Map<string, bigint>, k: string, d: bigint): void => void m.set(k, (m.get(k) ?? 0n) + d);

  if (kind === "STOCK_OUT") {
    if (moves.length > 0) throw invalid();
    for (const [lineId, es] of byLine) {
      const e = es[0] as LedgerEntry;
      const dimId = dimOf(e.key);
      const slices = [...lockedActive.values()]
        .filter((r) => r.documentLineId !== null && r.documentLineId.toLowerCase() === lineId && r.stockDimensionId === dimId)
        .map((r) => ({ id: r.id, quantity: toMicro(r.quantity) }));
      const sum = slices.reduce((a, s) => a + s.quantity, 0n);
      const out = -e.delta;
      const amount = sum < out ? sum : out;
      if (amount <= 0n) continue;
      for (const t of allocateAcross(slices, amount)) consumeOps.push({ ...t, dimensionId: dimId, source: { kind: "DOCUMENT_LINE", lineId } });
      bump(reservedDelta, dimId, -amount);
      bump(ownReserved, dimensionIdentity(e.key), amount);
    }
    return { consumeOps, moveOps, reservedDelta, ownReserved, targetDims: [] };
  }

  // STOCK_MOVE
  const seenLines = new Set<string>();
  const seenReservations = new Set<string>();
  for (const mv of moves) {
    const lineId = uuid(mv.lineId);
    const es = byLine.get(lineId);
    if (es === undefined || es.length !== 2 || seenLines.has(lineId)) throw invalid();
    seenLines.add(lineId);
    if (!Array.isArray(mv.reservationIds) || mv.reservationIds.length < 1 || mv.reservationIds.length > MAX_ALLOCATIONS) throw invalid();
    const from = es.find((e) => e.delta < 0n) as LedgerEntry;
    const to = es.find((e) => e.delta > 0n) as LedgerEntry;
    const sourceId = dimOf(from.key);
    const targetId = dimOf(to.key);
    const slices: ReservationSlice[] = [];
    const lineOf = new Map<string, ReservationSource>();
    for (const raw of mv.reservationIds) {
      const id = uuid(raw);
      if (seenReservations.has(id)) throw invalid();
      seenReservations.add(id);
      const r = lockedActive.get(id);
      if (r === undefined || r.stockDimensionId !== sourceId) throw invalid();
      // Sipariş satırı rezervasyonunun toplamada hedef boyuta taşınması T-307'nin kapsamıdır (LockedReservation sipariş kaynağını taşımaz): burada reddedilir.
      if (r.documentLineId === null) throw invalid();
      slices.push({ id: r.id, quantity: toMicro(r.quantity) });
      lineOf.set(r.id, { kind: "DOCUMENT_LINE", lineId: r.documentLineId });
    }
    const sum = slices.reduce((a, s) => a + s.quantity, 0n);
    const qty = to.delta;
    const amount = sum < qty ? sum : qty;
    for (const t of allocateAcross(slices, amount)) {
      moveOps.push({ ...t, source: lineOf.get(t.id) as ReservationSource, sourceDimensionId: sourceId, targetDimensionId: targetId });
    }
    bump(reservedDelta, sourceId, -amount);
    bump(reservedDelta, targetId, amount);
    bump(ownReserved, dimensionIdentity(from.key), amount);
    targetDims.set(targetId, { id: targetId, key: to.key });
  }
  return { consumeOps, moveOps, reservedDelta, ownReserved, targetDims: [...targetDims.values()] };
}

// --- tahsis / serbest bırakma çekirdeği (T-306: belge satırı ve sipariş satırı ortak; aynı kilit planı, aynı kural 5 süzgeci) ----------------------

/** Bir talep kaynağı için normalleştirilmiş tahsis isteği (boyutlar ürüne göre kurulmuştur). */
export interface AllocationRequest {
  readonly source: ReservationSource;
  readonly itemId: string;
  readonly allocations: readonly { readonly key: StockDimensionKey; readonly qty: bigint }[];
  /** Bu çağrıda eklenebilecek en çok miktar (satır miktarı − Σ ACTIVE; sipariş satırı: açık − Σ ACTIVE). */
  readonly capacity: bigint;
  /**
   * `true` (A-138 önerisi): kilitli bakiye plandan bayatsa (eşzamanlı tahsis, `pick_blocked`) istek KIRPILIR — yetmeyen kısım tahsissiz kalır (ret değil).
   * `false` (elle/belge): yetersiz → `INSUFFICIENT_STOCK`, kapasite aşımı → `VALIDATION_FAILED`.
   */
  readonly clamp: boolean;
}
export interface AllocationOutcome {
  /** Eklenen rezervasyon satırları (istek sırasıyla, istek içinde verilen sırayla). */
  readonly reservationIds: readonly string[];
  /** İstek başına tahsis edilen toplam (1e-6 ölçekli). */
  readonly allocated: readonly bigint[];
}

/**
 * Atomik tahsis: `acquireStockLocks` SONRASI, kilitli görüntü üzerinde. Sıra (T-221 ile aynı): lokasyon (FOR SHARE, ACTIVE) → ürün (FOR SHARE) →
 * ölçek → kural 5 uygunluğu → yeterlilik (quantity − reserved ≥ tahsis) → satır kapasitesi → rezervasyon satırları → `reserved_quantity`.
 * Kilit sorgusu YOKTUR; planda bildirilmemiş boyut `VERSION_CONFLICT`. `opts.warehouseId`: belge deposu (A-145 eşitliği) ya da `null` (sipariş).
 */
export async function allocateInTx(
  tx: AccessTx,
  locked: LockedState,
  tenantId: string,
  requests: readonly AllocationRequest[],
  opts: { readonly warehouseId: string | null; readonly expiresAt: string | null },
): Promise<AllocationOutcome> {
  const allKeys = uniqueKeys(requests.flatMap((r) => r.allocations.map((a) => a.key)));
  if (allKeys.length === 0) return { reservationIds: [], allocated: requests.map(() => 0n) };
  await assertLocationsActiveInWarehouse(tx, tenantId, allKeys.map((d) => d.locationId), opts.warehouseId);
  const itemIds = [...new Set(requests.map((r) => r.itemId.toLowerCase()))].sort(cmp);
  await assertItemsActive(tx, tenantId, itemIds, { archivedDetail: "IN_USE" });
  const scales = await tx.execute<{ id: string; quantity_scale: number }>(
    sql`SELECT id, quantity_scale FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(itemIds)}::uuid[])`,
  );
  const divisorOf = new Map(scales.map((x) => [x.id.toLowerCase(), 10n ** BigInt(6 - Number(x.quantity_scale ?? 0))]));
  for (const r of requests) {
    const d = divisorOf.get(r.itemId.toLowerCase());
    if (d === undefined) throw new AppError("NOT_FOUND");
    if (!r.clamp && r.allocations.some((a) => a.qty % d !== 0n)) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });
  }

  const dimIds = lockedDimensionIdByIdentity(locked);
  const idOf = (k: StockDimensionKey): string => {
    const id = dimIds.get(dimensionIdentity(k));
    if (id === undefined) throw versionConflict(); // plan bayat: boyut kilit planında yok
    return id;
  };
  const resolved = allKeys.map((k) => ({ id: idOf(k), key: k }));
  const reservable = await reservableDimensionIds(tx, tenantId, resolved);
  for (const r of requests) {
    if (!r.clamp && r.allocations.some((a) => !reservable.has(idOf(a.key)))) throw new AppError("INSUFFICIENT_STOCK");
  }

  // Yeterlilik (kilitli bakiye): quantity − reserved − bu komutta önceki tahsisler ≥ tahsis.
  const balanceByDim = new Map(locked.balances.map((b) => [b.stockDimensionId, b]));
  const taken = new Map<string, bigint>();
  const finals: { readonly req: AllocationRequest; readonly rows: { readonly dimId: string; readonly qty: bigint }[] }[] = [];
  for (const r of requests) {
    const divisor = divisorOf.get(r.itemId.toLowerCase()) as bigint;
    const rows: { dimId: string; qty: bigint }[] = [];
    let left = r.capacity;
    for (const a of r.allocations) {
      const id = idOf(a.key);
      const b = balanceByDim.get(id);
      if (b === undefined) throw new AppError("INTERNAL");
      const free = toMicro(b.quantity) - toMicro(b.reservedQuantity) - (taken.get(id) ?? 0n);
      let qty = a.qty;
      if (r.clamp) {
        if (!reservable.has(id)) continue;
        if (qty > free) qty = free;
        if (qty > left) qty = left;
        qty -= qty % divisor;
        if (qty <= 0n) continue;
      } else if (free < qty) {
        throw new AppError("INSUFFICIENT_STOCK");
      }
      taken.set(id, (taken.get(id) ?? 0n) + qty);
      left -= qty;
      rows.push({ dimId: id, qty });
    }
    finals.push({ req: r, rows });
  }
  // Satır başına Σ ACTIVE ≤ satır miktarı (çağıranın kilitli kaynağı üzerinde hesaplanan kapasite).
  const allocated = finals.map((f) => f.rows.reduce((a, x) => a + x.qty, 0n));
  finals.forEach((f, i) => {
    if ((allocated[i] as bigint) > f.req.capacity) throw invalid();
  });
  const flat = finals.flatMap((f) => f.rows.map((row) => ({ source: f.req.source, ...row })));
  if (flat.length === 0) return { reservationIds: [], allocated };
  const json = JSON.stringify(flat.map((x, ord) => ({ ord, dimension_id: x.dimId, ...sourceColumns(x.source), quantity: fromMicro(x.qty) })));
  const inserted = await tx.execute<{ id: string }>(
    sql`INSERT INTO public.reservations (tenant_id, stock_dimension_id, document_line_id, order_line_id, quantity, expires_at)
        SELECT ${tenantId}::uuid, w.dimension_id, w.document_line_id, w.order_line_id, w.quantity, ${opts.expiresAt}::timestamptz
          FROM jsonb_to_recordset(${json}::jsonb) AS w(ord int, dimension_id uuid, document_line_id uuid, order_line_id uuid, quantity numeric)
         ORDER BY w.ord
        RETURNING id`,
  );
  if (inserted.length !== flat.length) throw new AppError("INTERNAL");
  await applyReservedDeltas(tx, tenantId, taken);
  return { reservationIds: inserted.map((r) => r.id), allocated };
}

export interface ReleasedPart {
  readonly row: ReservationPlanRow;
  readonly take: bigint;
}
/**
 * Seçili (kilit sonrası yeniden okunmuş, ACTIVE) rezervasyonlardan `wanted` (null = tamamı) kadarını serbest bırakır: kısmi payda satır bölünür
 * (A-221-4). `stagedLast`: serbest bırakma önceliği — sevk alanında (STAGING) bekleyen mal en sona bırakılır (önce toplanmamış pay; sipariş iptali).
 * Kilitli görüntüyle uyumsuz satır → `VERSION_CONFLICT` (plan bayat). Fiziksel stok yerinde (kural 7). `wanted` seçimi aşarsa `VALIDATION_FAILED`.
 */
export async function releaseSelected(
  tx: AccessTx,
  tenantId: string,
  locked: LockedState,
  selected: readonly ReservationPlanRow[],
  wanted: bigint | null,
  opts: { readonly stagedLast?: boolean } = {},
): Promise<{ readonly closedIds: string[]; readonly amount: bigint; readonly parts: ReleasedPart[] }> {
  const lockedById = new Map(locked.reservations.map((r) => [r.id.toLowerCase(), r]));
  const dimIds = lockedDimensionIdByIdentity(locked);
  const slices: ReservationSlice[] = [];
  const meta = new Map<string, { dimensionId: string; row: ReservationPlanRow }>();
  for (const r of selected) {
    const lr = lockedById.get(r.id.toLowerCase());
    const dimId = dimIds.get(dimensionIdentity(r.key));
    if (lr === undefined || lr.status !== "ACTIVE" || dimId === undefined || lr.stockDimensionId !== dimId) throw versionConflict();
    slices.push({ id: lr.id, quantity: toMicro(lr.quantity) });
    meta.set(lr.id, { dimensionId: dimId, row: r });
  }
  const available = slices.reduce((a, s) => a + s.quantity, 0n);
  const amount = wanted ?? available;
  if (amount <= 0n || amount > available) throw invalid();
  const first = selected[0] as ReservationPlanRow;
  const scale = await tx.execute<{ quantity_scale: number }>(
    sql`SELECT quantity_scale FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ${first.key.itemId}::uuid`,
  );
  if (amount % 10n ** BigInt(6 - Number(scale[0]?.quantity_scale ?? 0)) !== 0n) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });

  const staged = (s: ReservationSlice): boolean => (meta.get(s.id) as { row: ReservationPlanRow }).row.locationKind === "STAGING";
  const tiers: ReservationSlice[][] = opts.stagedLast === true ? [slices.filter((s) => !staged(s)), slices.filter(staged)] : [slices];
  const takes: ReservationTake[] = [];
  let left = amount;
  for (const tier of tiers) {
    const have = tier.reduce((a, s) => a + s.quantity, 0n);
    const part = have < left ? have : left;
    if (part > 0n) takes.push(...allocateAcross(tier, part));
    left -= part;
  }
  const ops: ReservationOp[] = takes.map((t) => {
    const m = meta.get(t.id) as { dimensionId: string; row: ReservationPlanRow };
    return { ...t, dimensionId: m.dimensionId, source: m.row.source };
  });
  const closedIds = await closeReservations(tx, tenantId, "RELEASED", ops);
  const deltas = new Map<string, bigint>();
  for (const o of ops) deltas.set(o.dimensionId, (deltas.get(o.dimensionId) ?? 0n) - o.take);
  await applyReservedDeltas(tx, tenantId, deltas);
  return { closedIds, amount, parts: takes.map((t) => ({ row: (meta.get(t.id) as { row: ReservationPlanRow }).row, take: t.take })) };
}

// --- reserve -----------------------------------------------------------------------------------------------------------------

type Run = StockCommandResult & { readonly replayed: boolean };

function common(params: StockDocCallParams) {
  return {
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
  };
}
function completedOf(o: StockCommandOutcome<StockCommandResult>): Run {
  if (o.status !== "COMPLETED") throw versionConflict();
  return { ...o.result, replayed: o.replayed };
}

function parseExpiresAt(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw invalid();
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= Date.now()) throw invalid();
  return new Date(ms).toISOString();
}

/** `document.approve`: bkz. dosya başı. Sonuç `reservationIds` (yeni satırlar) + `lines[{lineId, quantity}]` (toplam tahsis). */
export async function reserve(params: StockDocCallParams, input: ReserveInput): Promise<Run> {
  const documentLineId = uuid(input.documentLineId);
  const expectedVersion = versionOf(input.expectedVersion);
  const expiresAt = parseExpiresAt(input.expiresAt);
  // Boyut anahtarının ürünü satırdan türer; biçim doğrulaması ürün bilinmeden de yapılır (ürün yer tutucusuyla), özet girdiden hesaplanır.
  const shape = normalizeAllocations("00000000-0000-4000-8000-000000000000", input.allocations);
  const hashInput = {
    documentLineId,
    expectedVersion: expectedVersion ?? null,
    expiresAt,
    allocations: shape.map((a) => ({
      locationId: a.key.locationId,
      lotId: a.key.lotId,
      serialId: a.key.serialId,
      stockStatus: a.key.stockStatus,
      inventoryOwnerId: a.key.inventoryOwnerId,
      handlingUnitId: a.key.handlingUnitId,
      quantity: fromMicro(a.qty),
    })),
  };
  return completedOf(
    await executeStockCommand<typeof hashInput, StockCommandResult>({
      ...common(params),
      commandType: "stock.reservation.reserve",
      permission: "document.approve",
      input: hashInput,
      plan: async (tx, _i, m): Promise<StockCommandPlan> => {
        const line = await readLine(tx, m.tenantId, documentLineId);
        const allocs = normalizeAllocations(line.item_id.toLowerCase(), input.allocations);
        const dims = uniqueKeys(allocs.map((a) => a.key));
        const locationIds = [...new Set(dims.map((d) => d.locationId))].sort(cmp);
        const serialIds = [...new Set(dims.flatMap((d) => (d.serialId === null ? [] : [d.serialId])))].sort(cmp);
        const extra = await locationWarehouses(tx, m.tenantId, locationIds);
        return {
          // Depo kapsamı: belge deposu + tahsis edilen lokasyonların depoları (kapsam dışı depo → FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE).
          warehouseIds: [...new Set([line.warehouse_id, ...extra])],
          locks: {
            ...EMPTY_LOCK_PLAN,
            document: { id: line.document_id, expectedVersion: expectedVersion ?? Number(line.version) },
            locationIds,
            dimensions: dims,
            serialIds,
          },
        };
      },
      apply: async (tx, locked, ctx) => {
        if (locked.document === undefined) throw new AppError("INTERNAL");
        const line = await readLine(tx, ctx.tenantId, documentLineId);
        if (line.document_id.toLowerCase() !== locked.document.id.toLowerCase()) throw versionConflict();
        const header = await readDocumentHeader(tx, ctx.tenantId, line.document_id); // belge kilitli
        assertNotProcessing(header); // M-6
        if (header.status !== "APPROVED" || !RESERVABLE_KINDS.has(header.kind)) throw documentState();
        const itemId = line.item_id.toLowerCase();
        const allocs = normalizeAllocations(itemId, input.allocations);
        // Satır başına Σ ACTIVE ≤ satır miktarı (belge kilitli: aynı satıra başka tahsis giremez; taşıma/tüketim toplamı artırmaz).
        const sum = await tx.execute<{ s: string }>(
          sql`SELECT COALESCE(sum(quantity), 0)::text AS s FROM public.reservations
               WHERE tenant_id = ${ctx.tenantId}::uuid AND document_line_id = ${documentLineId}::uuid AND status = 'ACTIVE'`,
        );
        const out = await allocateInTx(
          tx,
          locked,
          ctx.tenantId,
          [
            {
              source: { kind: "DOCUMENT_LINE", lineId: documentLineId },
              itemId,
              allocations: allocs,
              capacity: remainingToReserve(toMicro(line.base_quantity), toMicro(sum[0]?.s ?? "0")),
              clamp: false,
            },
          ],
          { warehouseId: header.warehouseId, expiresAt },
        );
        const total = out.allocated.reduce((a, x) => a + x, 0n);
        const inserted = out.reservationIds.map((id) => ({ id }));

        return {
          result: {
            documentId: line.document_id,
            reservationIds: inserted.map((r) => r.id),
            lines: [{ lineId: documentLineId, quantity: fromMicro(total) }],
          },
          audit: {
            action: "reservation.created",
            entityType: "stock_document",
            entityId: line.document_id,
            requestId: input.requestId ?? null,
            changeSummary: { documentLineId, allocationCount: allocs.length, quantity: fromMicro(total) },
          },
        };
      },
    }),
  );
}

// --- release -----------------------------------------------------------------------------------------------------------------

export type ReleaseResult = Run & {
  /** Serbest kalan mal sevk alanında (STAGING) duruyorsa `true`: geri yerleştirme görevi 3A'nın görev modelindedir (bu kartta görev yok). */
  readonly needsPutaway: boolean;
};

/** `document.approve`: bkz. dosya başı. `needsPutaway` kalıcı sonuçta DEĞİL (beyaz liste), kapanan satırların boyutundan her çağrıda türetilir. */
export async function release(params: StockDocCallParams, input: ReleaseInput): Promise<ReleaseResult> {
  const hasReservation = input.reservationId !== undefined;
  const hasLine = input.documentLineId !== undefined;
  if (hasReservation === hasLine) throw invalid(); // tam olarak biri
  const reservationId = hasReservation ? uuid(input.reservationId) : null;
  const lineSel = hasLine ? uuid(input.documentLineId) : null;
  const wanted = input.quantity === undefined ? null : positiveMicro(input.quantity);
  const expectedVersion = versionOf(input.expectedVersion);
  const hashInput = { reservationId, documentLineId: lineSel, quantity: wanted === null ? null : fromMicro(wanted), expectedVersion: expectedVersion ?? null };

  const outcome = completedOf(
    await executeStockCommand<typeof hashInput, StockCommandResult>({
      ...common(params),
      commandType: "stock.reservation.release",
      permission: "document.approve",
      input: hashInput,
      plan: async (tx, _i, m): Promise<StockCommandPlan> => {
        const rows = await readReservationPlanRows(tx, m.tenantId, reservationId !== null ? { ids: [reservationId] } : { lineId: lineSel as string });
        let lineId = lineSel;
        if (reservationId !== null) {
          const r = rows[0];
          if (r === undefined) throw new AppError("NOT_FOUND");
          if (r.source.kind !== "DOCUMENT_LINE") throw invalid(); // sipariş rezervasyonu `cancelOrderLine` ile bırakılır (T-306)
          lineId = r.source.lineId;
        }
        const line = await readLine(tx, m.tenantId, lineId as string);
        const active = rows.filter((r) => r.status === "ACTIVE");
        return {
          warehouseIds: [...new Set([line.warehouse_id, ...active.map((r) => r.warehouseId)])],
          locks: {
            ...EMPTY_LOCK_PLAN,
            document: { id: line.document_id, expectedVersion: expectedVersion ?? Number(line.version) },
            dimensions: uniqueKeys(active.map((r) => r.key)),
            reservationIds: active.map((r) => r.id).sort(cmp),
          },
        };
      },
      apply: async (tx, locked, ctx) => {
        if (locked.document === undefined) throw new AppError("INTERNAL");
        const header = await readDocumentHeader(tx, ctx.tenantId, locked.document.id);
        assertNotProcessing(header); // M-6: işleme sırasında serbest bırakma yok
        // Kilitten sonra seçimi yeniden oku (belge kilitli ⇒ satırın ACTIVE kümesi büyüyemez); kümede olmayan ⇒ plan bayat.
        const fresh = await readReservationPlanRows(tx, ctx.tenantId, reservationId !== null ? { ids: [reservationId] } : { lineId: lineSel as string });
        const selected = fresh.filter((r) => r.status === "ACTIVE");
        if (reservationId !== null && fresh[0] !== undefined && fresh[0].status !== "ACTIVE") throw invalid(); // kapalı rezervasyon serbest bırakılamaz
        if (selected.length === 0) throw invalid(); // bırakılacak aktif rezervasyon yok
        const first = selected[0] as ReservationPlanRow;
        if (first.source.kind !== "DOCUMENT_LINE") throw invalid();
        const rel = await releaseSelected(tx, ctx.tenantId, locked, selected, wanted);
        const closed = rel.closedIds;
        const amount = rel.amount;
        const firstLineId = first.source.lineId;
        return {
          result: {
            documentId: locked.document.id,
            reservationIds: closed,
            lines: [{ lineId: firstLineId, quantity: fromMicro(amount) }],
          },
          audit: {
            action: "reservation.released",
            entityType: "stock_document",
            entityId: locked.document.id,
            requestId: input.requestId ?? null,
            changeSummary: { documentLineId: firstLineId, reservationCount: closed.length, quantity: fromMicro(amount), via: "release" },
          },
        };
      },
    }),
  );
  const ids = outcome.reservationIds ?? [];
  const needsPutaway = ids.length === 0 ? false : await runTenantQuery({ ...params, permission: "document.approve" }, (tx, m) => stagedAmong(tx, m.tenantId, ids));
  return { ...outcome, needsPutaway };
}

// --- depo kapsamı süzgeçli kullanılabilir stok ----------------------------------------------------------------------------------

/**
 * `readAvailability` + depo kapsamı (T-217 incelemesi MINOR-1): çağıranın kapsamı dışındaki depoların lokasyonları sonuçtan ÇIKARILIR
 * (kapsam kısıtsızsa — bayrak kapalı, `TENANT_ADMIN` ya da kapsam satırı yok — süzgeç yoktur). `filter.locationId` kapsam dışı depodaysa
 * varlık sızdırılmaz: `NOT_FOUND`. Rezervasyon ve ekranlar bu işlevi kullanır; ham `readAvailability` kapsamı bilmez.
 */
export async function readScopedAvailability(
  tx: AccessTx,
  membership: Membership,
  filter: AvailabilityFilter,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly AvailabilityRow[]> {
  const allowed = await resolveWarehouseScope(tx, membership, env);
  const set = allowed === null ? null : new Set(allowed.map((a) => a.toLowerCase()));
  if (set !== null && filter.locationId !== undefined) {
    const w = await locationWarehouses(tx, membership.tenantId, [filter.locationId.toLowerCase()]);
    if (w.some((x) => !set.has(x.toLowerCase()))) throw new AppError("NOT_FOUND");
  }
  const rows = await readAvailability(tx, membership.tenantId, filter);
  if (set === null || rows.length === 0) return rows;
  const whs = await tx.execute<{ id: string; warehouse_id: string }>(
    sql`SELECT id, warehouse_id FROM public.locations WHERE tenant_id = ${membership.tenantId}::uuid AND id = ANY(${pgUuidArray(rows.map((r) => r.locationId))}::uuid[])`,
  );
  const whOf = new Map(whs.map((w) => [w.id.toLowerCase(), w.warehouse_id.toLowerCase()]));
  return rows.filter((r) => set.has(whOf.get(r.locationId.toLowerCase()) ?? ""));
}
