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
// A-xx: A-217-1 hedef durum sütunu yok (bkz. plan.ts); A-217-2 yeterlilik girişleri saymaz; A-217-3 defter nedeni belge türünden gelir
// (STOCK_IN→RECEIPT, STOCK_OUT→SHIPMENT, STOCK_MOVE→MOVE; diğer nedenler 3A belge türlerinde); A-145 satır lokasyonları belge deposunda;
// A-07 senkron üst sınırı 200 satır (üstü T-222; o zamana dek `VALIDATION_FAILED`/`DOCUMENT_STATE`, sahte başarı yok).
import { sql } from "drizzle-orm";
import type { LockedState } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";
import { pgUuidArray } from "../warehouse/scope.ts";
import { EMPTY_LOCK_PLAN, executeStockCommand, type StockCommandPlan } from "./command.ts";
import { assertLocationsInWarehouse, assertNotProcessing, readDocumentHeader, type StockDocCallParams } from "./documents.ts";
import type { StockCommandResult } from "./idempotency.ts";
import { buildPostingPlan, dimensionIdentity, fromMicro, toMicro, type PostingKind, type PostingLine, type PostingPlan, type PostingStatus } from "./plan.ts";
import {
  assertLineRules,
  assertSerialUnique,
  assertSufficient,
  type BalanceView,
  type ItemInfo,
  type LocationInfo,
  type SerialInfo,
} from "./rules.ts";
import type { TrackingMode } from "./tracking.ts";

/**
 * `locations`/`items` satır kilidi parçası. Bunlar STOK tablosu değildir (I-15 kapsamı dışı); eslint `stock-sql-guard`'ın dosya düzeyi
 * sezgisi (dosya stok tablosu adı içeriyor + ifadeli şablonda FOR SHARE) bu okumaları yanlış işaretlediği için kilit tümceciği ayrı
 * parça olarak verilir. Stok tablosu kilidi burada YOKTUR (yalnızca `acquireStockLocks`). Rapor Bulgusu: koruma sezgisi daraltılmalı.
 */
const SHARE_LOCK = sql`FOR SHARE`;

/** A-07: senkron işleme üst sınırı. */
export const SYNC_POST_MAX_LINES = 200;
const KINDS: ReadonlySet<string> = new Set(["STOCK_IN", "STOCK_OUT", "STOCK_MOVE"]);

export interface PostDocumentInput {
  readonly documentId: string;
  readonly expectedVersion: number;
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
  inventory_owner_id: string | null;
  handling_unit_id: string | null;
};

async function loadLines(tx: AccessTx, tenantId: string, documentId: string): Promise<PostingLine[]> {
  const rows = await tx.execute<LineRow>(
    sql`SELECT id, line_no, item_id, quantity::text AS quantity, conversion_factor::text AS conversion_factor, base_quantity::text AS base_quantity,
               source_location_id, target_location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id
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
    // A-217-1: tek durum sütunu; kaynak ve hedef durumu aynıdır.
    sourceStatus: r.stock_status,
    targetStatus: r.stock_status,
    inventoryOwnerId: r.inventory_owner_id,
    handlingUnitId: r.handling_unit_id,
  }));
}

/** Kilitli lokasyon satırları: `FOR SHARE` (arşivin `FOR NO KEY UPDATE`'iyle çakışır), kimliğe göre sıralı; ACTIVE denetimi rules'tadır. */
async function readLocationsShared(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<Map<string, LocationInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; warehouse_id: string; status: string }>(
    sql`SELECT id, warehouse_id, status FROM public.locations
         WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[]) ORDER BY id ${SHARE_LOCK}`,
  );
  return new Map(rows.map((r) => [r.id.toLowerCase(), { id: r.id, warehouseId: r.warehouse_id, status: r.status }]));
}

async function readItemsShared(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<Map<string, ItemInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; status: string; tracking_mode: TrackingMode; quantity_scale: number }>(
    sql`SELECT id, status, tracking_mode, quantity_scale FROM public.items
         WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[]) ORDER BY id ${SHARE_LOCK}`,
  );
  return new Map(rows.map((r) => [r.id.toLowerCase(), { id: r.id, status: r.status, trackingMode: r.tracking_mode, quantityScale: Number(r.quantity_scale) }]));
}

/** Yalnızca plan için: belge dışı lokasyonların depoları (değişmez sütun; kilitsiz okuma güvenli). */
async function locationWarehouses(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ warehouse_id: string }>(
    sql`SELECT DISTINCT warehouse_id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
  );
  return rows.map((r) => r.warehouse_id);
}

function lockPlanOf(documentId: string, expectedVersion: number, p: PostingPlan | undefined): StockCommandPlan["locks"] {
  const document = { id: documentId, expectedVersion };
  if (p === undefined) return { ...EMPTY_LOCK_PLAN, document };
  return { ...EMPTY_LOCK_PLAN, document, locationIds: p.locationIds, dimensions: p.dimensions, serialIds: p.serialIds };
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

/** `stock.post`: bkz. dosya başı. */
export async function postDocument(
  params: StockDocCallParams,
  input: PostDocumentInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  if (typeof input.documentId !== "string" || !UUID_RE.test(input.documentId)) throw new AppError("VALIDATION_FAILED");
  if (typeof input.expectedVersion !== "number" || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new AppError("VALIDATION_FAILED");
  }
  const documentId = input.documentId.toLowerCase();
  const expectedVersion = input.expectedVersion;
  const hashInput = { documentId, expectedVersion };
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
    plan: async (tx, _i, m) => {
      // Salt okuma; iş kuralı DENETLENMEZ (yeniden oynatma saklı sonuca ulaşır). Geçersiz/aşırı belge → yalnızca belge kilidi; apply reddeder.
      const head = await tx.execute<{ warehouse_id: string; kind: string }>(
        sql`SELECT warehouse_id, kind FROM public.documents WHERE tenant_id = ${m.tenantId}::uuid AND id = ${documentId}::uuid`,
      );
      const h = head[0];
      if (h === undefined) throw new AppError("NOT_FOUND");
      const lines = await loadLines(tx, m.tenantId, documentId);
      let built: PostingPlan | undefined;
      if (KINDS.has(h.kind) && lines.length >= 1 && lines.length <= SYNC_POST_MAX_LINES) {
        try {
          built = buildPostingPlan(h.kind as PostingKind, lines);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
        }
      }
      // A-145: satır lokasyonlarının depoları da kapsam denetimine girer (depo uyuşmazlığı apply'da reddedilir).
      const extra = built === undefined ? [] : await locationWarehouses(tx, m.tenantId, built.locationIds);
      return { warehouseIds: [...new Set([h.warehouse_id, ...extra])], locks: lockPlanOf(documentId, expectedVersion, built) };
    },
    apply: async (tx, locked, ctx) => {
      if (locked.document === undefined) throw new AppError("INTERNAL");
      const header = await readDocumentHeader(tx, ctx.tenantId, documentId); // belge kilitli
      assertNotProcessing(header); // M-6
      if (header.status !== "APPROVED") throw documentState();
      if (!KINDS.has(header.kind)) throw new AppError("VALIDATION_FAILED");
      const kind = header.kind as PostingKind;
      const lines = await loadLines(tx, ctx.tenantId, documentId);
      if (lines.length < 1) throw new AppError("VALIDATION_FAILED");
      if (lines.length > SYNC_POST_MAX_LINES) throw documentState(); // T-222 gelene dek kapalı yol: açık hata
      const built = buildPostingPlan(kind, lines);
      assertCovered(built, locked);

      // Kilitten SONRA: lokasyon ve ürün FOR SHARE + ACTIVE (T-243 MAJOR; arşivle çakışır).
      await assertLocationsInWarehouse(tx, ctx.tenantId, built.locationIds, locked.document.warehouseId); // A-145 (T-213 yardımcısı)
      const locations = await readLocationsShared(tx, ctx.tenantId, built.locationIds);
      const items = await readItemsShared(tx, ctx.tenantId, [...new Set(lines.map((l) => l.itemId.toLowerCase()))].sort());
      const serials = new Map<string, SerialInfo>(locked.serials.map((s) => [s.id.toLowerCase(), { id: s.id, itemId: s.itemId, lotId: s.lotId }]));
      assertLineRules(lines, locked.document.warehouseId, items, locations, serials);

      const dimIdByIdentity = new Map(locked.dimensions.map((d) => [dimensionIdentity(d.key), d.id]));
      const balanceByDim = new Map(locked.balances.map((b) => [b.stockDimensionId, b]));
      const balances = new Map<string, BalanceView>();
      for (const [identity, dimId] of dimIdByIdentity) {
        const b = balanceByDim.get(dimId);
        if (b === undefined) throw new AppError("INTERNAL");
        balances.set(identity, { quantity: toMicro(b.quantity), reserved: toMicro(b.reservedQuantity) });
      }
      assertSufficient(built, balances);

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
      await writeBalances(tx, ctx.tenantId, netByDimensionId);

      return {
        result: {
          documentId,
          status: "POSTED",
          lines: lines.map((l) => ({ lineId: l.lineId, lineNo: l.lineNo, quantity: l.quantity, baseQuantity: l.baseQuantity })),
        },
        audit: {
          action: "stock_document.posted",
          entityType: "stock_document",
          entityId: documentId,
          requestId: input.requestId ?? null,
          changeSummary: { kind, lineCount: lines.length, ledgerRows: built.entries.length, warehouseId: header.warehouseId },
        },
        // Numara EN SON; aynı UPDATE belgeyi POSTED yapar (sürüm +1 ve durum geçmişi DB tetikleyicilerindedir).
        numbering: { documentId, kind: kind, businessDate: header.businessDate, status: "POSTED" },
      };
    },
  });
  if (outcome.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true }); // senkron yolda beklenmez
  return { ...outcome.result, replayed: outcome.replayed };
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

/** Bakiye: ÖNCE tüm azaltmalar, SONRA artırmalar (iki ifade; seri kısmi tekil indeksi anında denetlenir). Net 0 olan boyuta dokunulmaz. */
async function writeBalances(tx: AccessTx, tenantId: string, netByDimensionId: ReadonlyMap<string, bigint>): Promise<void> {
  const dec = [...netByDimensionId].filter(([, n]) => n < 0n);
  const inc = [...netByDimensionId].filter(([, n]) => n > 0n);
  for (const group of [dec, inc]) {
    if (group.length === 0) continue;
    const json = JSON.stringify(group.map(([dimension_id, n]) => ({ dimension_id, delta: fromMicro(n) })));
    const rows = await tx.execute<{ stock_dimension_id: string }>(
      sql`UPDATE public.stock_balances b SET quantity = b.quantity + w.delta, version = b.version + 1
            FROM jsonb_to_recordset(${json}::jsonb) AS w(dimension_id uuid, delta numeric)
           WHERE b.tenant_id = ${tenantId}::uuid AND b.stock_dimension_id = w.dimension_id
          RETURNING b.stock_dimension_id`,
    );
    if (rows.length !== group.length) throw new AppError("INTERNAL");
  }
}

