// Stok belgesi işleme (T-217; 05 §İşlem sözleşmesi 7 adım, 16 §Temel kurallar 1/3/4/5, I-04, I-05, I-09, I-15, AC-09, A-07, A-79).
//
// `postDocument` (`stock.post`): `APPROVED` belge → tek transaction'da defter + bakiye + `POSTED` (+ numara, audit, idempotency sonucu).
// - Kilitler YALNIZCA `acquireStockLocks` ile, planı önceden tam bildirerek alınır (executeStockCommand). Plan salt okunur ve iş kuralı
//   denetlemez; kurallar `apply`'da KİLİTLİ görüntüde işler. Plan ile kilitli görüntü uyuşmazsa (satırlar plandan sonra değişti) `VERSION_CONFLICT`.
// - Kilitten SONRA lokasyon (`FOR SHARE`, ACTIVE) ve ürün (`FOR SHARE`, ACTIVE) satırları okunur: arşiv `FOR NO KEY UPDATE` ile çakışır, böylece
//   arşivli lokasyonda pozitif stok oluşamaz (T-243 incelemesi MAJOR).
// - Seri kilidi bayrağı (A-121/Q-56) kapalıyken seri planı `acquireStockLocks`'ta reddedilir; burada serisiz yeniden deneme YOKTUR.
// - Yazımlar açık sütun listelidir: türetilen sütunlar (`item_id`, `created_xid`, `occurred_at`, `serial_key`) yazılmaz (sunucu/tetikleyici doldurur).
// - Bakiye güncellemesi: ÖNCE tüm azaltmalar, SONRA artırmalar (seri kısmi tekil indeksi ertelenemez; ADR-017 §3). Yalnızca kilitli satırlara yazılır.
//
// T-221 (ADR-009; 16 kural 2/5, Senaryo A adım 6-7): `STOCK_OUT` satırının KENDİ rezervasyonları (kaynak boyutta) işlemde tüketilir
// (`CONSUMED`; kısmi kalan ACTIVE) ve yeterlilik `quantity − (reserved − kendi rezervasyonu)` ile hesaplanır; `STOCK_MOVE` satırı `reservationMoves`
// ile verilen rezervasyonları malla birlikte hedef boyuta taşır. Rezervasyon satırı ve `reserved_quantity` yazımları `reservations.ts`'tedir;
// bakiye yazımı TEK ifadede (miktar + rezerve) yapılır: ÖNCE miktarı azalan boyutlar, SONRA diğerleri (CHECK 0 ≤ reserved ≤ quantity satır başına).
//
// T-248 durum değişimi ve rezervasyon (A-248-2, fail-closed): rezerve kısım durum DEĞİŞTİRMEZ. Rezervasyonsuz STOCK_MOVE'da kaynak boyutun
// `quantity − reserved` yeterliliği (assertSufficient) rezerveli kısmı korur → `INSUFFICIENT_STOCK`; `reservationMoves` ile taşınan rezervasyonun hedefi
// AVAILABLE olmak zorundadır (assertReservableDimensions) → AVAILABLE→QUARANTINE'e taşıma `INSUFFICIENT_STOCK`.
//
// A-xx: A-248-1 durum geçişi fail-closed beyaz liste (bkz. plan.ts; A-217-1/A-147 kaldırıldı); rezerveli kısım durum değiştirmez (aşağıda); A-217-2 yeterlilik girişleri saymaz; A-217-3 defter nedeni belge türünden gelir
// (STOCK_IN→RECEIPT, STOCK_OUT→SHIPMENT, STOCK_MOVE→MOVE; diğer nedenler 3A belge türlerinde); A-145 satır lokasyonları belge deposunda;
// A-07 senkron üst sınırı 200 satır; üstü (≤ 2.000, A-07) T-222 ile worker'da işlenir: istek yalnızca belgeyi kilitler, `posting_job_id` yazar, işi kuyruğa
// bırakır ve idempotency kaydını `IN_PROGRESS` tutar (`deferred`); worker aynı `plan/apply` çiftiyle (`buildPostCommand`, `worker: true`) `resume` ile tamamlar.
// A-222-1: eşik üstü `STOCK_MOVE` rezervasyon taşıması (`reservationMoves`) desteklenmez (iş yükünde taşıma yok) → `VALIDATION_FAILED`.
import { sql } from "drizzle-orm";
import type { LockedState } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import type { JobQueue } from "@wms/shared/queue";
import { runTenantQuery, type AccessTx } from "../identity/access.ts";
import { assertWarehouseVisible, pgUuidArray } from "../warehouse/scope.ts";
import {
  EMPTY_LOCK_PLAN,
  executeStockCommand,
  type StockCommandApplied,
  type StockCommandParams,
  type StockCommandPlan,
} from "./command.ts";
import {
  MAX_DOCUMENT_LINES,
  assertItemsActive,
  assertLocationsActiveInWarehouse,
  assertNotProcessing,
  readDocumentHeader,
  type DocumentHeader,
  type StockDocCallParams,
} from "./documents.ts";
import type { StockCommandResult } from "./idempotency.ts";
import {
  buildPostingPlan,
  dimensionIdentity,
  fromMicro,
  reservedExcluding,
  toMicro,
  type PostingKind,
  type PostingLine,
  type PostingPlan,
  type PostingStatus,
} from "./plan.ts";
import {
  assertReservableDimensions,
  closeReservations,
  moveReservations,
  planReservationEffects,
  type ReservationMoveInput,
} from "./reservations.ts";
import {
  assertLineRules,
  assertSerialUnique,
  assertSufficient,
  type BalanceView,
  type ItemInfo,
  type SerialInfo,
} from "./rules.ts";
import type { TrackingMode } from "./tracking.ts";

/** A-07: senkron işleme üst sınırı. */
export const SYNC_POST_MAX_LINES = 200;
const KINDS: ReadonlySet<string> = new Set(["STOCK_IN", "STOCK_OUT", "STOCK_MOVE"]);

export interface PostDocumentInput {
  readonly documentId: string;
  readonly expectedVersion: number;
  /** Yalnızca `STOCK_MOVE`: satır → taşınacak rezervasyonlar (toplama; rezervasyon malla birlikte hedef boyuta gider). */
  readonly reservationMoves?: readonly ReservationMoveInput[];
  readonly requestId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const documentState = (): AppError => new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" });

type LineRow = {
  id: string;
  line_no: number;
  item_id: string;
  quantity: string;
  conversion_factor: string;
  base_quantity: string;
  source_location_id: string | null;
  target_location_id: string | null;
  lot_id: string | null;
  serial_id: string | null;
  stock_status: PostingStatus;
  target_stock_status: PostingStatus | null;
  inventory_owner_id: string | null;
  handling_unit_id: string | null;
};

async function loadLines(tx: AccessTx, tenantId: string, documentId: string): Promise<PostingLine[]> {
  const rows = await tx.execute<LineRow>(
    sql`SELECT id, line_no, item_id, quantity::text AS quantity, conversion_factor::text AS conversion_factor, base_quantity::text AS base_quantity,
               source_location_id, target_location_id, lot_id, serial_id, stock_status, target_stock_status, inventory_owner_id, handling_unit_id
          FROM public.document_lines WHERE tenant_id = ${tenantId}::uuid AND document_id = ${documentId}::uuid ORDER BY line_no`,
  );
  return rows.map((r) => ({
    lineId: r.id,
    lineNo: Number(r.line_no),
    itemId: r.item_id,
    quantity: r.quantity,
    conversionFactor: r.conversion_factor,
    baseQuantity: r.base_quantity,
    sourceLocationId: r.source_location_id,
    targetLocationId: r.target_location_id,
    lotId: r.lot_id,
    serialId: r.serial_id,
    // T-248: hedef durum NULL ise kaynakla aynı (durum değişimi yok).
    sourceStatus: r.stock_status,
    targetStatus: r.target_stock_status ?? r.stock_status,
    inventoryOwnerId: r.inventory_owner_id,
    handlingUnitId: r.handling_unit_id,
  }));
}

/** Ürün takip bilgisi (düz okuma): satırlar `assertItemsActive` ile `FOR SHARE` kilitlidir (ürün takip modu/ölçeği değişmez; A-87). */
async function readItemInfo(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<Map<string, ItemInfo>> {
  const rows = await tx.execute<{ id: string; tracking_mode: TrackingMode; quantity_scale: number }>(
    sql`SELECT id, tracking_mode, quantity_scale FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
  );
  return new Map(rows.map((r) => [r.id.toLowerCase(), { id: r.id, trackingMode: r.tracking_mode, quantityScale: Number(r.quantity_scale) }]));
}

/** Yalnızca plan için: belge dışı lokasyonların depoları (değişmez sütun; kilitsiz okuma güvenli). */
async function locationWarehouses(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ warehouse_id: string }>(
    sql`SELECT DISTINCT warehouse_id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
  );
  return rows.map((r) => r.warehouse_id);
}

function lockPlanOf(documentId: string, expectedVersion: number, p: PostingPlan | undefined, reservationIds: readonly string[]): StockCommandPlan["locks"] {
  const document = { id: documentId, expectedVersion };
  if (p === undefined) return { ...EMPTY_LOCK_PLAN, document };
  return { ...EMPTY_LOCK_PLAN, document, locationIds: p.locationIds, dimensions: p.dimensions, serialIds: p.serialIds, reservationIds };
}

/** Belge satırlarının ACTIVE rezervasyon kimlikleri (kilitsiz okuma; plan kilidine girer — kümeyi belge kilidi sabitler). */
async function activeReservationIdsOfDocument(tx: AccessTx, tenantId: string, documentId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT r.id FROM public.reservations r JOIN public.document_lines l ON l.tenant_id = r.tenant_id AND l.id = r.document_line_id
         WHERE r.tenant_id = ${tenantId}::uuid AND l.document_id = ${documentId}::uuid AND r.status = 'ACTIVE' ORDER BY r.id`,
  );
  return rows.map((r) => r.id);
}

/** `reservationMoves` girdisini normalleştirir (UUID, küçük harf, sıralı); biçim hatası `VALIDATION_FAILED`. */
function normalizeMoves(raw: unknown): ReservationMoveInput[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > SYNC_POST_MAX_LINES) throw new AppError("VALIDATION_FAILED");
  const out = (raw as unknown[]).map((m) => {
    const x = m as { lineId?: unknown; reservationIds?: unknown } | null;
    if (x === null || typeof x !== "object" || typeof x.lineId !== "string" || !UUID_RE.test(x.lineId) || !Array.isArray(x.reservationIds)) {
      throw new AppError("VALIDATION_FAILED");
    }
    const ids = (x.reservationIds as unknown[]).map((i) => {
      if (typeof i !== "string" || !UUID_RE.test(i)) throw new AppError("VALIDATION_FAILED");
      return i.toLowerCase();
    });
    return { lineId: x.lineId.toLowerCase(), reservationIds: [...new Set(ids)].sort() };
  });
  return out.sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));
}

/** Plan kilitli görüntüyü tam kapsıyor mu (I-15: yalnızca kilitli satırlara yazılır). */
function assertCovered(p: PostingPlan, locked: LockedState): void {
  const dims = new Set(locked.dimensions.map((d) => dimensionIdentity(d.key)));
  const locs = new Set(locked.locations.map((l) => l.locationId.toLowerCase()));
  const serials = new Set(locked.serials.map((s) => s.id.toLowerCase()));
  const ok =
    p.dimensions.every((d) => dims.has(dimensionIdentity(d))) &&
    p.locationIds.every((l) => locs.has(l)) &&
    p.serialIds.every((s) => serials.has(s));
  if (!ok) throw new AppError("VERSION_CONFLICT", { retryable: true });
}

const tooLarge = (): AppError => new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_TOO_LARGE" });

export interface PostDocumentParams extends StockDocCallParams {
  /** Eşik üstü belge için kuyruk (yalnızca `enqueue`); verilmezse eşik üstü belge `FEATURE_DISABLED` ile reddedilir (sahte başarı yok). */
  readonly queue?: Pick<JobQueue<AccessTx>, "enqueue">;
}

/** `postDocument` yanıtı: senkron sonuç ya da eşik üstü belge için `PROCESSING` (yoklama: `getPostingStatus`). */
export type PostDocumentResult = Omit<StockCommandResult, "status"> & {
  readonly status?: StockCommandResult["status"] | "PROCESSING";
  readonly replayed: boolean;
};

export interface PostCommandOptions {
  readonly documentId: string;
  /** `null`: worker (belge işleme kilidi altında, sürüm kilit planında okunur). */
  readonly expectedVersion: number | null;
  readonly moves: readonly ReservationMoveInput[] | undefined;
  readonly requestId: string | null | undefined;
  /** Worker yolu: eşik üstü belge işlenir (≤ 2.000) ve işleme kilidi (`posting_job_id`) beklenen durumdur; çağıran (jobs.ts) kimliği doğrular. */
  readonly worker: boolean;
  readonly queue?: PostDocumentParams["queue"];
  /** İstek yolu: isteği yapan oturum MFA doğrulanmış mı (eşik üstü belgede sunucu tarafında `posting_mfa_verified_at` olur; worker MFA'yı yalnızca buradan türetir). */
  readonly requesterMfaVerified?: boolean;
}

/** Senkron ve worker yolunun ORTAK `plan/apply` çifti (`executeStockCommand`'a verilir). */
export function buildPostCommand(o: PostCommandOptions): Pick<StockCommandParams<unknown>, "plan" | "apply"> {
  const { documentId, moves } = o;
  const maxPlanLines = o.worker ? MAX_DOCUMENT_LINES : SYNC_POST_MAX_LINES;
  return {
    plan: async (tx, _i, m) => {
      // Salt okuma; iş kuralı DENETLENMEZ (yeniden oynatma saklı sonuca ulaşır). Geçersiz/aşırı belge → yalnızca belge kilidi; apply reddeder.
      const head = await tx.execute<{ warehouse_id: string; kind: string; version: number | string }>(
        sql`SELECT warehouse_id, kind, version FROM public.documents WHERE tenant_id = ${m.tenantId}::uuid AND id = ${documentId}::uuid`,
      );
      const h = head[0];
      if (h === undefined) throw new AppError("NOT_FOUND");
      const expectedVersion = o.expectedVersion ?? Number(h.version);
      const lines = await loadLines(tx, m.tenantId, documentId);
      let built: PostingPlan | undefined;
      if (KINDS.has(h.kind) && lines.length >= 1 && lines.length <= maxPlanLines) {
        try {
          built = buildPostingPlan(h.kind as PostingKind, lines);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
        }
      }
      // T-221: STOCK_OUT satırlarının rezervasyonları (tüketim) ve STOCK_MOVE'un taşıdığı rezervasyonlar kilit planındadır (I-15 adım 5).
      const reservationIds =
        built === undefined ? [] : h.kind === "STOCK_OUT" ? await activeReservationIdsOfDocument(tx, m.tenantId, documentId) : (moves ?? []).flatMap((x) => x.reservationIds);
      // A-145: satır lokasyonlarının depoları da kapsam denetimine girer (depo uyuşmazlığı apply'da reddedilir).
      const extra = built === undefined ? [] : await locationWarehouses(tx, m.tenantId, built.locationIds);
      return { warehouseIds: [...new Set([h.warehouse_id, ...extra])], locks: lockPlanOf(documentId, expectedVersion, built, [...new Set(reservationIds)].sort()) };
    },
    apply: async (tx, locked, ctx): Promise<StockCommandApplied> => {
      if (locked.document === undefined) throw new AppError("INTERNAL");
      const header = await readDocumentHeader(tx, ctx.tenantId, documentId); // belge kilitli
      if (!o.worker) assertNotProcessing(header); // M-6 (worker'da kilit beklenen durumdur; jobs.ts işi doğrular)
      if (header.status !== "APPROVED") throw documentState();
      if (!KINDS.has(header.kind)) throw new AppError("VALIDATION_FAILED");
      const kind = header.kind as PostingKind;
      const lines = await loadLines(tx, ctx.tenantId, documentId);
      if (lines.length < 1) throw new AppError("VALIDATION_FAILED");
      if (lines.length > MAX_DOCUMENT_LINES) throw tooLarge(); // sert sınır; işleme anında yeniden denetlenir
      if (lines.length > SYNC_POST_MAX_LINES && !o.worker) return deferToWorker(tx, ctx, header, o);
      const built = buildPostingPlan(kind, lines);
      assertCovered(built, locked);

      // Kilitten SONRA: lokasyon ve ürün FOR SHARE + ACTIVE (T-243 MAJOR; arşivle çakışır).
      // Sıra: lokasyon (FOR SHARE, ACTIVE, depo eşitliği A-145) → ürün (FOR SHARE, ACTIVE); ikisi de documents.ts yardımcıları.
      await assertLocationsActiveInWarehouse(tx, ctx.tenantId, built.locationIds, locked.document.warehouseId);
      const itemIds = [...new Set(lines.map((l) => l.itemId.toLowerCase()))].sort();
      await assertItemsActive(tx, ctx.tenantId, itemIds, { archivedDetail: "IN_USE" });
      const items = await readItemInfo(tx, ctx.tenantId, itemIds);
      const serials = new Map<string, SerialInfo>(locked.serials.map((s) => [s.id.toLowerCase(), { id: s.id, itemId: s.itemId, lotId: s.lotId }]));
      assertLineRules(lines, items, serials);

      const dimIdByIdentity = new Map(locked.dimensions.map((d) => [dimensionIdentity(d.key), d.id]));
      const balanceByDim = new Map(locked.balances.map((b) => [b.stockDimensionId, b]));
      // Rezervasyon etkisi (T-221): kilitli görüntüden; yeterlilikte işlenen satırın KENDİ rezervasyonu rezerveden düşülür.
      const fx = planReservationEffects({ kind, entries: built.entries, locked, dimIdByIdentity, moves });
      const balances = new Map<string, BalanceView>();
      for (const [identity, dimId] of dimIdByIdentity) {
        const b = balanceByDim.get(dimId);
        if (b === undefined) throw new AppError("INTERNAL");
        balances.set(identity, { quantity: toMicro(b.quantity), reserved: reservedExcluding(toMicro(b.reservedQuantity), fx.ownReserved.get(identity) ?? 0n) });
      }
      assertSufficient(built, balances);
      await assertReservableDimensions(tx, ctx.tenantId, fx.targetDims); // taşınan rezervasyonun hedefi de kural 5'e uygun olmalı

      const netByDimensionId = new Map<string, bigint>();
      const serialOfDimension = new Map<string, string>();
      for (const [identity, net] of built.net) {
        const dimId = dimIdByIdentity.get(identity) as string;
        netByDimensionId.set(dimId, net);
      }
      for (const d of locked.dimensions) if (d.key.serialId !== null) serialOfDimension.set(d.id, d.key.serialId);
      if (built.serialIds.length > 0) {
        const existing = await readPositiveSerialBalances(tx, ctx.tenantId, built.serialIds);
        assertSerialUnique(existing, netByDimensionId, serialOfDimension);
      }

      await writeLedger(tx, ctx.tenantId, documentId, header.businessDate, ctx.userId, built, dimIdByIdentity);
      await writeBalances(tx, ctx.tenantId, netByDimensionId, fx.reservedDelta);
      const consumed = await closeReservations(tx, ctx.tenantId, "CONSUMED", fx.consumeOps);
      const moved = await moveReservations(tx, ctx.tenantId, fx.moveOps);
      const touched = [...consumed, ...moved];

      return {
        result: {
          documentId,
          status: "POSTED",
          ...(touched.length === 0 ? {} : { reservationIds: touched }),
          lines: lines.map((l) => ({ lineId: l.lineId, lineNo: l.lineNo, quantity: l.quantity, baseQuantity: l.baseQuantity })),
        },
        audit: {
          action: "stock_document.posted",
          entityType: "stock_document",
          entityId: documentId,
          requestId: o.requestId ?? null,
          changeSummary: { kind, lineCount: lines.length, ledgerRows: built.entries.length, warehouseId: header.warehouseId, reservationsConsumed: consumed.length, reservationsMoved: moved.length },
        },
        // Numara EN SON; aynı UPDATE belgeyi POSTED yapar (sürüm +1 ve durum geçmişi DB tetikleyicilerindedir).
        numbering: { documentId, kind: kind, businessDate: header.businessDate, status: "POSTED" },
      };
    },
  };
}

/**
 * Eşik üstü belge (T-222, ADR-018 §6): belge kilitli (acquireStockLocks) ve APPROVED iken işi kuyruğa bırakır, `posting_job_id` +
 * `posting_requested_by` yazar. İdempotency kaydı `IN_PROGRESS` kalır (`deferred`). `enqueue` aynı transaction'dadır: geri alma işi de geri alır.
 */
async function deferToWorker(
  tx: AccessTx,
  ctx: { readonly tenantId: string; readonly userId: string; readonly idempotencyRecordId: string },
  header: DocumentHeader,
  o: PostCommandOptions,
): Promise<StockCommandApplied> {
  if (o.moves !== undefined && o.moves.length > 0) throw new AppError("VALIDATION_FAILED"); // A-222-1
  // Kuyruk bağlanmamışsa eşik üstü belge işlenemez: açık hata (sahte başarı yok); T-217'den beri değişmeyen davranış.
  if (o.queue === undefined) throw documentState();
  const enq = await o.queue.enqueue(tx, {
    type: "stock.document.post",
    actorUserId: ctx.userId,
    payload: { documentId: header.id, idempotencyRecordId: ctx.idempotencyRecordId },
    singletonKey: header.id,
  });
  // `singletonKey` çakışması: önceki iş hâlâ sonlanıyor (FAILED yazıldı, kuyruk satırı kapanmadı). Yeniden denenebilir geçici durum.
  if (enq.jobId === null) throw new AppError("VERSION_CONFLICT", { retryable: true });
  const rows = await tx.execute<{ id: string }>(
    // Bağlam `posting_job_id` ile AYNI ifadede, sunucu tarafında yazılır (0023): MFA damgası DB saati; kayıt kimliği bu isteğin IN_PROGRESS kaydı.
    sql`UPDATE public.documents SET posting_job_id = ${enq.jobId}::uuid, posting_requested_by = ${ctx.userId}::uuid,
               posting_mfa_verified_at = CASE WHEN ${o.requesterMfaVerified === true}::boolean THEN now() ELSE NULL END,
               posting_idempotency_record_id = ${ctx.idempotencyRecordId}::uuid
         WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${header.id}::uuid AND status = 'APPROVED' AND posting_job_id IS NULL RETURNING id`,
  );
  if (rows[0] === undefined) throw documentState();
  return { result: { documentId: header.id, status: "APPROVED" }, audit: null, deferred: true };
}

/** `stock.post`: bkz. dosya başı. */
export async function postDocument(params: PostDocumentParams, input: PostDocumentInput): Promise<PostDocumentResult> {
  if (typeof input.documentId !== "string" || !UUID_RE.test(input.documentId)) throw new AppError("VALIDATION_FAILED");
  if (typeof input.expectedVersion !== "number" || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new AppError("VALIDATION_FAILED");
  }
  const documentId = input.documentId.toLowerCase();
  const expectedVersion = input.expectedVersion;
  const moves = normalizeMoves(input.reservationMoves);
  // Yalnızca verildiyse özete girer: önceki (taşımasız) isteklerin özeti değişmez.
  const hashInput = moves === undefined ? { documentId, expectedVersion } : { documentId, expectedVersion, reservationMoves: moves };
  const outcome = await executeStockCommand<typeof hashInput, StockCommandResult>({
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    commandType: "stock.document.post",
    permission: "stock.post",
    input: hashInput,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    ...buildPostCommand({ documentId, expectedVersion, moves, requestId: input.requestId, worker: false, requesterMfaVerified: params.principal?.mfaVerified === true, ...(params.queue === undefined ? {} : { queue: params.queue }) }),
  });
  // IN_PROGRESS: eşik üstü belge kuyrukta (bu istek ya da aynı anahtarlı önceki istek); sonuç `getPostingStatus` ile yoklanır.
  // Yeni istek ile aynı anahtarlı tekrar ayırt edilmez (ikisi de IN_PROGRESS): `replayed` bu yanıtta anlamsızdır, false.
  if (outcome.status !== "COMPLETED") return { documentId, status: "PROCESSING", replayed: false };
  return { ...outcome.result, replayed: outcome.replayed };
}

export type PostingStatusView =
  | { readonly status: "DRAFT" | "APPROVED" | "PROCESSING" | "POSTED" | "CANCELLED" }
  | { readonly status: "FAILED"; readonly errorCode: string };

/**
 * `stock.view`: `DRAFT|APPROVED|PROCESSING|POSTED|FAILED(kod)` (UI yoklar, T-229). `FAILED`: belge `APPROVED`, işleme kilidi yok ve en son worker
 * kaydı `FAILED` (kayıtta yalnızca `result.documentId` bağıdır).
 */
export async function getPostingStatus(params: Omit<StockDocCallParams, "clientKey">, documentId: string): Promise<PostingStatusView> {
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) throw new AppError("VALIDATION_FAILED");
  const id = documentId.toLowerCase();
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const rows = await tx.execute<{ status: DocumentHeader["status"]; posting_job_id: string | null; warehouse_id: string }>(
      sql`SELECT status, posting_job_id, warehouse_id FROM public.documents WHERE tenant_id = ${m.tenantId}::uuid AND id = ${id}::uuid`,
    );
    const d = rows[0];
    if (d === undefined) throw new AppError("NOT_FOUND");
    await assertWarehouseVisible(tx, m, [d.warehouse_id]); // kapsam dışı belge varlık sızdırmaz: NOT_FOUND (T-222 inceleme MAJOR-3)
    if (d.posting_job_id !== null) return { status: "PROCESSING" } as const;
    if (d.status !== "APPROVED") return { status: d.status } as const;
    const failed = await tx.execute<{ error_code: string | null }>(
      sql`SELECT error_code FROM public.idempotency_records
           WHERE tenant_id = ${m.tenantId}::uuid AND command_type = 'stock.document.post' AND status = 'FAILED' AND result->>'documentId' = ${id}
           ORDER BY completed_at DESC LIMIT 1`,
    );
    const code = failed[0]?.error_code;
    return code === undefined || code === null ? ({ status: "APPROVED" } as const) : ({ status: "FAILED", errorCode: code } as const);
  });
}

/** Salt okuma: planlanan serilerin pozitif bakiyeli boyutları (belge dışı boyutlar dahil; seri kilidi altında kararlıdır). */
async function readPositiveSerialBalances(tx: AccessTx, tenantId: string, serialIds: readonly string[]): Promise<Map<string, Map<string, bigint>>> {
  const rows = await tx.execute<{ dimension_id: string; serial_id: string; quantity: string }>(
    sql`SELECT d.id AS dimension_id, d.serial_id, b.quantity::text AS quantity
          FROM public.stock_balances b
          JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
         WHERE b.tenant_id = ${tenantId}::uuid AND d.serial_id = ANY(${pgUuidArray(serialIds)}::uuid[]) AND b.quantity > 0`,
  );
  const out = new Map<string, Map<string, bigint>>();
  for (const r of rows) {
    const m = out.get(r.serial_id) ?? new Map<string, bigint>();
    m.set(r.dimension_id, toMicro(r.quantity));
    out.set(r.serial_id, m);
  }
  return out;
}

/** Defter satırları (açık sütun listesi: item_id/created_xid/occurred_at sunucu/tetikleyici türetimidir). Tek ifade, satır sırasıyla. */
async function writeLedger(
  tx: AccessTx,
  tenantId: string,
  documentId: string,
  businessDate: string,
  actorUserId: string,
  plan: PostingPlan,
  dimIdByIdentity: ReadonlyMap<string, string>,
): Promise<void> {
  const json = JSON.stringify(
    plan.entries.map((e, ord) => ({
      ord,
      line_id: e.lineId,
      dimension_id: dimIdByIdentity.get(dimensionIdentity(e.key)),
      quantity: fromMicro(e.delta),
      reason: e.reason,
    })),
  );
  const rows = await tx.execute<{ id: string }>(
    sql`INSERT INTO public.stock_ledger (tenant_id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, actor_user_id)
        SELECT ${tenantId}::uuid, ${documentId}::uuid, w.line_id, w.dimension_id, w.quantity, w.reason, ${businessDate}::date, ${actorUserId}::uuid
          FROM jsonb_to_recordset(${json}::jsonb) AS w(ord int, line_id uuid, dimension_id uuid, quantity numeric, reason text)
         ORDER BY w.ord
        RETURNING id`,
  );
  if (rows.length !== plan.entries.length) throw new AppError("INTERNAL");
}

/**
 * Bakiye: miktarı AZALAN boyutlar ÖNCE, sonra diğerleri (iki ifade; seri kısmi tekil indeksi anında denetlenir). Her ifade satır başına miktar ve
 * rezerve değişimini birlikte uygular (CHECK 0 ≤ reserved ≤ quantity satırın nihai değerine bakar). Değişmeyen boyuta dokunulmaz.
 */
async function writeBalances(
  tx: AccessTx,
  tenantId: string,
  netByDimensionId: ReadonlyMap<string, bigint>,
  reservedDelta: ReadonlyMap<string, bigint>,
): Promise<void> {
  const ids = new Set<string>([...netByDimensionId.keys(), ...reservedDelta.keys()]);
  const rows = [...ids]
    .map((id) => ({ id, q: netByDimensionId.get(id) ?? 0n, r: reservedDelta.get(id) ?? 0n }))
    .filter((x) => x.q !== 0n || x.r !== 0n);
  const dec = rows.filter((x) => x.q < 0n);
  const inc = rows.filter((x) => x.q >= 0n);
  for (const group of [dec, inc]) {
    if (group.length === 0) continue;
    const json = JSON.stringify(group.map((x) => ({ dimension_id: x.id, delta: fromMicro(x.q), reserved_delta: fromMicro(x.r) })));
    const updated = await tx.execute<{ stock_dimension_id: string }>(
      sql`UPDATE public.stock_balances b SET quantity = b.quantity + w.delta, reserved_quantity = b.reserved_quantity + w.reserved_delta, version = b.version + 1
            FROM jsonb_to_recordset(${json}::jsonb) AS w(dimension_id uuid, delta numeric, reserved_delta numeric)
           WHERE b.tenant_id = ${tenantId}::uuid AND b.stock_dimension_id = w.dimension_id
          RETURNING b.stock_dimension_id`,
    );
    if (updated.length !== group.length) throw new AppError("INTERNAL");
  }
}
