// Ters kayıt (T-224; I-08, AC-06, 05 §Geri alma ve arşiv, 16 §Senaryo C). `reverseDocument` (`reversal.create`): POSTED bir belgenin seçilen satırlarını,
// kalan ters çevrilmemiş miktarı aşmadan, yeni bir `REVERSAL` belgesiyle geri alır. Asıl belge ve satır içeriği değişmez; yalnızca asıl satırın
// `reversed_quantity` (yalnız artış) ve `reversal_status` (`PARTIAL|FULL`) alanları ilerler (DB tetikleyicisi bunu zorlar).
//
// Akış `executeStockCommand` 7 adımıdır; kilitler YALNIZCA `acquireStockLocks` ile, plan önceden tam bildirilerek alınır (I-15): asıl belge (sürümüyle)
// → lokasyonlar → ters yöndeki boyutlar/bakiyeler → seriler. Yeni `REVERSAL` belgesi bu transaction'da yaratılır (kilit gerekmez; ADR-018 §7).
// Plan salt okunur ve iş kuralı denetlemez; kurallar `apply`'da KİLİTLİ görüntüde işler (aynı anahtarlı tekrar saklı sonuca ulaşır).
//
// Ret kuralları (`REVERSAL_BLOCKED`, ayrıntılı): `EXCEEDS_REMAINING` (satır başına miktar ≤ base_quantity − reversed_quantity), `STOCK_USED` (ters yön
// bakiyeyi negatife düşürürdü: sonraki çıkış/taşıma/toplama tüketmiş), `STOCK_RESERVED` (stok var ama aktif rezervasyon kullanılabiliri düşürüyor),
// `SERIAL_IN_USE` (geri yazılacak seri başka boyutta pozitif). `DOCUMENT_STATE`: belge POSTED değil, işleme kilidi var (`posting_job_id`) ya da ters
// kaydın kendisi/desteklenmeyen tür. Bir ret hiçbir satır yazmaz (tek transaction). Kapalı dönem denetimi yoktur (A-71).
//
// A-xx (OPEN_QUESTIONS): A-224-1 senkron üst sınır 200 satır (`TOO_MANY_LINES`; worker yolu yok, satırlar gruplar hâlinde ayrı ters kayıtlarla çevrilir);
// A-224-2 `lines: "ALL"` = her satırın KALAN miktarı (kalanı 0 olanlar atlanır), miktarlar temel birimdedir (`base_quantity`; I-09);
// A-224-3 durum değiştiren STOCK_MOVE (kaynak durum ≠ hedef durum) ters çevrilmez: `REVERSAL_BLOCKED/STATUS_CHANGE` (0020 tetikleyicisi `target_stock_status`'u
// yalnız STOCK_MOVE'a bağlar; ters satır iki durumu taşıyamaz, Q-106); A-224-4 rezervasyonlar ters kayıtla yeniden kurulmaz/serbest bırakılmaz;
// A-224-5 yalnız STOCK_IN/STOCK_OUT/STOCK_MOVE belgeleri ve YALNIZ `source_kind` boş olanlar ters çevrilir: saha akışından gelen belge (kabul, sipariş,
// iade, sayım, görev) `REVERSAL_BLOCKED/SOURCE_LINKED` (bağlı kayıtlar kopmasın; düzeltme yolu Q-104); A-224-7 ters satır asıl satıra
// `document_lines.source_line_id` ile bağlanır (REVERSAL belgesinde bu sütun, `reversal_of_document_id` belgesinin satırını gösterir); A-224-8 ters satır
// miktarı I-09'a uyar: tam satırda asıl miktar/birim kopyalanır, kısmi satırda asıl birimde tam bölünüyorsa o birim, bölünmüyorsa ürünün temel birimi (katsayı 1).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { LockedState } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery, type AccessTx } from "../identity/access.ts";
import { assertWarehouseVisible, pgUuidArray } from "../warehouse/scope.ts";
import { EMPTY_LOCK_PLAN, executeStockCommand, type StockCommandApplied, type StockCommandPlan } from "./command.ts";
import { assertItemsActive, assertLocationsActiveInWarehouse, assertNotProcessing, readDocumentHeader, type StockDocCallParams } from "./documents.ts";
import type { StockCommandResult, StockResultLine } from "./idempotency.ts";
import { buildPostingPlan, dimensionIdentity, fromMicro, toMicro, type PostingKind, type PostingLine, type PostingPlan, type PostingStatus } from "./plan.ts";
import { assertSerialUnique } from "./rules.ts";

/** A-224-1: tek ters kayıtta en çok 200 satır (A-07 senkron sınırı ile aynı). */
export const REVERSAL_MAX_LINES = 200;
/** Denetim kaydına satır dökümü konan en çok satır (`changeSummary` 8 KB sınırı). */
const AUDIT_LINES_MAX = 60;
const REASON_MAX = 500;
const KINDS: ReadonlySet<string> = new Set(["STOCK_IN", "STOCK_OUT", "STOCK_MOVE"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;
const CONTROL_RE = /\p{C}/u;
const MICRO = 1_000_000n;

const documentState = (): AppError => new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" });
const blocked = (detail: "EXCEEDS_REMAINING" | "STOCK_USED" | "STOCK_RESERVED" | "SERIAL_IN_USE" | "SOURCE_LINKED" | "STATUS_CHANGE"): AppError => new AppError("REVERSAL_BLOCKED", { detail });

// --- girdi (saf) ----------------------------------------------------------------------------------------------------------

export interface ReverseLineRequest {
  readonly lineId: string;
  /** Pozitif ondalık dizgi, ASIL satırın temel biriminde (`base_quantity`; I-09). */
  readonly quantity: string;
}
export interface ReverseDocumentInput {
  readonly documentId: string;
  /** `"ALL"`: her satırın kalan ters çevrilmemiş miktarı (A-224-2). */
  readonly lines: readonly ReverseLineRequest[] | "ALL";
  /** Zorunlu gerekçe (≤ 500 karakter); audit ve ters belgede saklanır. */
  readonly reason: string;
  readonly requestId?: string | null;
}
/** Doğrulanmış girdi (kimlikler küçük harf; satırlar `lineId` sıralı — istek özeti satır sırasından bağımsız olsun). */
export interface NormalizedReversal {
  readonly documentId: string;
  readonly lines: readonly { readonly lineId: string; readonly quantity: string; readonly micro: bigint }[] | "ALL";
  readonly reason: string;
}

export function normalizeReversalInput(input: ReverseDocumentInput): NormalizedReversal {
  if (typeof input !== "object" || input === null) throw new AppError("VALIDATION_FAILED");
  if (typeof input.documentId !== "string" || !UUID_RE.test(input.documentId)) throw new AppError("VALIDATION_FAILED");
  if (typeof input.reason !== "string") throw new AppError("VALIDATION_FAILED");
  const reason = input.reason.trim();
  if (reason === "" || Array.from(reason).length > REASON_MAX || CONTROL_RE.test(reason)) throw new AppError("VALIDATION_FAILED");
  const documentId = input.documentId.toLowerCase();
  if (input.lines === "ALL") return { documentId, lines: "ALL", reason };
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new AppError("VALIDATION_FAILED");
  if (input.lines.length > REVERSAL_MAX_LINES) throw new AppError("VALIDATION_FAILED", { detail: "TOO_MANY_LINES" });
  const seen = new Set<string>();
  const lines = (input.lines as readonly unknown[]).map((raw) => {
    const x = raw as { lineId?: unknown; quantity?: unknown } | null;
    if (x === null || typeof x !== "object" || typeof x.lineId !== "string" || !UUID_RE.test(x.lineId)) throw new AppError("VALIDATION_FAILED");
    if (typeof x.quantity !== "string" || !POSITIVE_DECIMAL_RE.test(x.quantity)) throw new AppError("VALIDATION_FAILED");
    const micro = toMicro(x.quantity);
    if (micro <= 0n) throw new AppError("VALIDATION_FAILED");
    const lineId = x.lineId.toLowerCase();
    if (seen.has(lineId)) throw new AppError("VALIDATION_FAILED"); // aynı satır iki kez: belirsiz toplam
    seen.add(lineId);
    return { lineId, quantity: x.quantity, micro };
  });
  lines.sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));
  return { documentId, lines, reason };
}

// --- seçim ve defter girdileri (saf) ----------------------------------------------------------------------------------------

/** Asıl belge satırı + ters çevrilmiş miktar (düz okuma görünümü). */
export interface SourceLine extends PostingLine {
  readonly unitId: string;
  readonly reversedQuantity: string;
}
export interface SelectedLine {
  readonly line: SourceLine;
  /** Bu istekte ters çevrilecek miktar (1e-6 ölçekli). */
  readonly micro: bigint;
}

/** Kalan ters çevrilmemiş miktar (1e-6): `base_quantity − reversed_quantity` (negatif olamaz). */
export function remainingMicro(line: Pick<SourceLine, "baseQuantity" | "reversedQuantity">): bigint {
  const r = toMicro(line.baseQuantity) - toMicro(line.reversedQuantity);
  return r < 0n ? 0n : r;
}

/** Ters çevrilmiş toplam ve durumu: tam kapanınca `FULL`, aksi `PARTIAL` (DB: `NONE` ⇔ 0). */
export function reversalStateAfter(baseQuantity: string, reversedBefore: string, add: bigint): { readonly reversed: bigint; readonly status: "PARTIAL" | "FULL" } {
  const reversed = toMicro(reversedBefore) + add;
  return { reversed, status: reversed >= toMicro(baseQuantity) ? "FULL" : "PARTIAL" };
}

/**
 * İstenen satırları kalanlarla eşler. Bilinmeyen satır `VALIDATION_FAILED`; kalanı aşan miktar `REVERSAL_BLOCKED`/`EXCEEDS_REMAINING`;
 * `ALL` hiçbir kalan bırakmamışsa `EXCEEDS_REMAINING`; 200 satır üstü `TOO_MANY_LINES`. Sonuç satır numarasına göre sıralıdır.
 */
export function selectReversalLines(all: readonly SourceLine[], req: NormalizedReversal["lines"]): SelectedLine[] {
  const ordered = [...all].sort((a, b) => a.lineNo - b.lineNo);
  let out: SelectedLine[];
  if (req === "ALL") {
    out = ordered.flatMap((line) => {
      const rest = remainingMicro(line);
      return rest > 0n ? [{ line, micro: rest }] : [];
    });
    if (out.length === 0) throw blocked("EXCEEDS_REMAINING");
  } else {
    const byId = new Map(ordered.map((l) => [l.lineId.toLowerCase(), l]));
    out = req.map((r) => {
      const line = byId.get(r.lineId);
      if (line === undefined) throw new AppError("VALIDATION_FAILED");
      if (r.micro > remainingMicro(line)) throw blocked("EXCEEDS_REMAINING");
      return { line, micro: r.micro };
    });
    out.sort((a, b) => a.line.lineNo - b.line.lineNo);
  }
  if (out.length > REVERSAL_MAX_LINES) throw new AppError("VALIDATION_FAILED", { detail: "TOO_MANY_LINES" });
  return out;
}

/** Ters çevrilecek miktarlarla asıl yönde plan kurulur (biçim/boyut doğrulaması `buildPostingPlan`'da), defter girdileri işaret değiştirir. */
export function buildReversalPlan(kind: PostingKind, selection: readonly SelectedLine[]): PostingPlan {
  // A-224-3: durum değiştiren taşıma ters çevrilmez (ters satır iki durumu taşıyamaz; Q-106).
  if (kind === "STOCK_MOVE" && selection.some((s) => s.line.sourceStatus !== s.line.targetStatus)) throw blocked("STATUS_CHANGE");
  const plan = buildPostingPlan(
    kind,
    selection.map((s) => ({ ...s.line, baseQuantity: fromMicro(s.micro) })),
  );
  const entries = plan.entries.map((e) => ({ ...e, delta: -e.delta }));
  const net = new Map([...plan.net].map(([k, v]) => [k, -v]));
  const outTotals = new Map<string, bigint>();
  for (const e of entries) {
    if (e.delta < 0n) outTotals.set(dimensionIdentity(e.key), (outTotals.get(dimensionIdentity(e.key)) ?? 0n) - e.delta);
  }
  // `reason` tipi (RECEIPT|SHIPMENT|MOVE) yazılmaz: defter nedeni yazım anında `REVERSAL` olur (A-79).
  return { ...plan, entries, net, outTotals };
}

export interface BalanceSnapshot {
  readonly quantity: bigint;
  readonly reserved: bigint;
}
/**
 * Ters yön çıkışları yeterli mi (I-05)? Önce satır sırasıyla: bakiye çıkıştan azsa `STOCK_USED` (sonraki hareket tüketmiş), bakiye yeter ama
 * rezerve düşülünce yetmiyorsa `STOCK_RESERVED`. Eksik boyut 0 sayılır.
 */
export function assertReversalCovered(plan: PostingPlan, balances: ReadonlyMap<string, BalanceSnapshot>): void {
  for (const e of plan.entries) {
    if (e.delta >= 0n) continue;
    const id = dimensionIdentity(e.key);
    const out = plan.outTotals.get(id) ?? 0n;
    const b = balances.get(id) ?? { quantity: 0n, reserved: 0n };
    if (b.quantity < out) throw blocked("STOCK_USED");
    if (b.quantity - b.reserved < out) throw blocked("STOCK_RESERVED");
  }
}

// --- okuma ---------------------------------------------------------------------------------------------------------------------

type LineRow = {
  id: string;
  line_no: number;
  item_id: string;
  unit_id: string;
  quantity: string;
  conversion_factor: string;
  base_quantity: string;
  reversed_quantity: string;
  source_location_id: string | null;
  target_location_id: string | null;
  lot_id: string | null;
  serial_id: string | null;
  stock_status: PostingStatus;
  target_stock_status: PostingStatus | null;
  inventory_owner_id: string | null;
  handling_unit_id: string | null;
};

async function loadSourceLines(tx: AccessTx, tenantId: string, documentId: string): Promise<SourceLine[]> {
  const rows = await tx.execute<LineRow>(
    sql`SELECT id, line_no, item_id, unit_id, quantity::text AS quantity, conversion_factor::text AS conversion_factor, base_quantity::text AS base_quantity,
               reversed_quantity::text AS reversed_quantity, source_location_id, target_location_id, lot_id, serial_id, stock_status, target_stock_status,
               inventory_owner_id, handling_unit_id
          FROM public.document_lines WHERE tenant_id = ${tenantId}::uuid AND document_id = ${documentId}::uuid ORDER BY line_no`,
  );
  return rows.map((r) => ({
    lineId: r.id,
    lineNo: Number(r.line_no),
    itemId: r.item_id,
    unitId: r.unit_id,
    quantity: r.quantity,
    conversionFactor: r.conversion_factor,
    baseQuantity: r.base_quantity,
    reversedQuantity: r.reversed_quantity,
    sourceLocationId: r.source_location_id,
    targetLocationId: r.target_location_id,
    lotId: r.lot_id,
    serialId: r.serial_id,
    sourceStatus: r.stock_status,
    targetStatus: r.target_stock_status ?? r.stock_status,
    inventoryOwnerId: r.inventory_owner_id,
    handlingUnitId: r.handling_unit_id,
  }));
}

async function locationWarehouses(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ warehouse_id: string }>(
    sql`SELECT DISTINCT warehouse_id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
  );
  return rows.map((r) => r.warehouse_id);
}

/** Kilitli görüntü planı tam kapsıyor mu (I-15: yalnızca kilitli satırlara yazılır); aksi plan bayat → `VERSION_CONFLICT`. */
function assertCovered(p: PostingPlan, locked: LockedState): void {
  const dims = new Set(locked.dimensions.map((d) => dimensionIdentity(d.key)));
  const locs = new Set(locked.locations.map((l) => l.locationId.toLowerCase()));
  const serials = new Set(locked.serials.map((s) => s.id.toLowerCase()));
  const ok = p.dimensions.every((d) => dims.has(dimensionIdentity(d))) && p.locationIds.every((l) => locs.has(l)) && p.serialIds.every((s) => serials.has(s));
  if (!ok) throw new AppError("VERSION_CONFLICT", { retryable: true });
}

// --- komut ---------------------------------------------------------------------------------------------------------------------

export type ReverseDocumentResult = StockCommandResult & { readonly replayed: boolean };

/** `reversal.create`: bkz. dosya başı. Sonuç `documentId` = yeni REVERSAL belgesi; `lines[]` asıl satırlar (`baseQuantity` bu istek, `reversedQuantity` toplam). */
export async function reverseDocument(params: StockDocCallParams, input: ReverseDocumentInput): Promise<ReverseDocumentResult> {
  const req = normalizeReversalInput(input);
  const { documentId } = req;
  // Özet: satırlar `lineId` sıralı; sunucu alanları (requestId vb.) özete girmez.
  const hashInput = { documentId, lines: req.lines === "ALL" ? "ALL" : req.lines.map((l) => ({ lineId: l.lineId, quantity: l.micro.toString() })), reason: req.reason };
  const outcome = await executeStockCommand<typeof hashInput, StockCommandResult>({
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    commandType: "stock.document.reverse",
    permission: "reversal.create",
    input: hashInput,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    plan: async (tx, _i, m): Promise<StockCommandPlan> => {
      const head = await tx.execute<{ warehouse_id: string; kind: string; version: number | string; source_kind: string | null }>(
        sql`SELECT warehouse_id, kind, version, source_kind FROM public.documents WHERE tenant_id = ${m.tenantId}::uuid AND id = ${documentId}::uuid`,
      );
      const h = head[0];
      if (h === undefined) throw new AppError("NOT_FOUND");
      const document = { id: documentId, expectedVersion: Number(h.version) };
      // Plan iş kuralı denetlemez: geçersiz seçim/tür → yalnızca belge kilidi; `apply` reddeder (yeniden oynatma saklı sonuca ulaşır).
      let built: PostingPlan | undefined;
      if (KINDS.has(h.kind) && h.source_kind === null) {
        try {
          built = buildReversalPlan(h.kind as PostingKind, selectReversalLines(await loadSourceLines(tx, m.tenantId, documentId), req.lines));
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
        }
      }
      if (built === undefined) return { warehouseIds: [h.warehouse_id], locks: { ...EMPTY_LOCK_PLAN, document } };
      const extra = await locationWarehouses(tx, m.tenantId, built.locationIds);
      return {
        warehouseIds: [...new Set([h.warehouse_id, ...extra])],
        locks: { ...EMPTY_LOCK_PLAN, document, locationIds: built.locationIds, dimensions: built.dimensions, serialIds: built.serialIds },
      };
    },
    apply: async (tx, locked, ctx): Promise<StockCommandApplied> => {
      if (locked.document === undefined || locked.document.id.toLowerCase() !== documentId) throw new AppError("INTERNAL");
      const header = await readDocumentHeader(tx, ctx.tenantId, documentId); // belge kilitli
      assertNotProcessing(header); // işleme kilidi (M-6): ters kayıt reddedilir
      if (header.status !== "POSTED" || !KINDS.has(header.kind)) throw documentState(); // DRAFT/APPROVED/CANCELLED, ters kaydın ters kaydı, desteklenmeyen tür
      // B-1 (A-224-5): saha akışından gelen belge (`source_kind` dolu) ters çevrilmez; bağlı sipariş/rezervasyon/kabul/sayım kayıtları kopmasın.
      if ((await readSourceKind(tx, ctx.tenantId, documentId)) !== null) throw blocked("SOURCE_LINKED");
      const kind = header.kind as PostingKind;
      const selection = selectReversalLines(await loadSourceLines(tx, ctx.tenantId, documentId), req.lines);
      const plan = buildReversalPlan(kind, selection);
      assertCovered(plan, locked);

      const baseUnitByItem = await assertItemScale(tx, ctx.tenantId, selection);
      // Stok doğan (artan) boyutlar: lokasyon ve ürün ACTIVE kalmalı (arşivli lokasyonda pozitif stok oluşamaz; T-243). Kilitten SONRA, FOR SHARE.
      const receiving = plan.entries.filter((e) => e.delta > 0n).map((e) => e.key);
      await assertLocationsActiveInWarehouse(tx, ctx.tenantId, [...new Set(receiving.map((k) => k.locationId))].sort(), header.warehouseId);
      await assertItemsActive(tx, ctx.tenantId, [...new Set(receiving.map((k) => k.itemId))].sort(), { archivedDetail: "IN_USE" });

      const dimIdByIdentity = new Map(locked.dimensions.map((d) => [dimensionIdentity(d.key), d.id]));
      const balanceByDim = new Map(locked.balances.map((b) => [b.stockDimensionId, b]));
      const balances = new Map<string, BalanceSnapshot>();
      for (const [identity, dimId] of dimIdByIdentity) {
        const b = balanceByDim.get(dimId);
        if (b === undefined) throw new AppError("INTERNAL");
        balances.set(identity, { quantity: toMicro(b.quantity), reserved: toMicro(b.reservedQuantity) });
      }
      assertReversalCovered(plan, balances);

      const netByDimensionId = new Map<string, bigint>();
      const serialOfDimension = new Map<string, string>();
      for (const [identity, net] of plan.net) netByDimensionId.set(dimIdByIdentity.get(identity) as string, net);
      for (const d of locked.dimensions) if (d.key.serialId !== null) serialOfDimension.set(d.id, d.key.serialId);
      if (plan.serialIds.length > 0) {
        try {
          assertSerialUnique(await readPositiveSerialBalances(tx, ctx.tenantId, plan.serialIds), netByDimensionId, serialOfDimension);
        } catch (e) {
          if (e instanceof AppError && e.code === "TRACKING_VIOLATION") throw blocked("SERIAL_IN_USE");
          throw e;
        }
      }

      // --- yazım: REVERSAL belgesi (taslak + satırlar) → defter → bakiye → asıl satırlar → onay; numara/POSTED executeStockCommand'da (EN SON) ---
      const businessDate = await tenantToday(tx, ctx.tenantId);
      const reversalId = randomUUID();
      const typeVersionId = await systemTypeVersionId(tx);
      await tx.execute(
        sql`INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, reversal_of_document_id, reason, created_by)
            VALUES (${ctx.tenantId}::uuid, ${reversalId}::uuid, 'REVERSAL', ${typeVersionId}::uuid, ${header.warehouseId}::uuid, ${businessDate}::date, ${documentId}::uuid, ${req.reason}, ${ctx.userId}::uuid)`,
      );
      const reversalLineIdBySource = await insertReversalLines(tx, ctx.tenantId, reversalId, selection, baseUnitByItem);
      await writeLedger(tx, ctx.tenantId, reversalId, businessDate, ctx.userId, plan, dimIdByIdentity, reversalLineIdBySource);
      await writeBalances(tx, ctx.tenantId, netByDimensionId);
      const states = await advanceSourceLines(tx, ctx.tenantId, documentId, selection);
      await tx.execute(
        sql`UPDATE public.documents SET status = 'APPROVED' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${reversalId}::uuid AND status = 'DRAFT'`,
      );

      const lines: StockResultLine[] = selection.map((s) => ({
        lineId: s.line.lineId,
        lineNo: s.line.lineNo,
        baseQuantity: fromMicro(s.micro),
        reversedQuantity: fromMicro(states.get(s.line.lineId.toLowerCase())?.reversed ?? 0n),
      }));
      return {
        result: { documentId: reversalId, status: "POSTED", lines },
        audit: {
          action: "stock_document.reversed",
          entityType: "stock_document",
          entityId: documentId,
          reason: req.reason,
          requestId: input.requestId ?? null,
          changeSummary: {
            reversalDocumentId: reversalId,
            reversalOfDocumentId: documentId,
            kind,
            lineCount: selection.length,
            // M-2: asıl satır kimlikleri ve miktarlar (8 KB denetim sınırı: çok satırda yalnız sayı; tam bağ ters belge satırlarındaki `source_line_id`'dedir).
            ...(selection.length <= AUDIT_LINES_MAX
              ? { lines: selection.map((s) => ({ sourceLineId: s.line.lineId, quantity: fromMicro(s.micro) })) }
              : { linesOmitted: selection.length }),
            fullyReversedLines: [...states.values()].filter((s) => s.status === "FULL").length,
            ledgerRows: plan.entries.length,
            warehouseId: header.warehouseId,
          },
        },
        numbering: { documentId: reversalId, kind: "REVERSAL", businessDate, status: "POSTED" },
      };
    },
  });
  if (outcome.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true }); // bu komut kuyruğa bırakılmaz; beklenmez
  return { ...outcome.result, replayed: outcome.replayed };
}

// --- kapasite okuması (kullanıcıya "en çok X" bilgisi) ----------------------------------------------------------------------------

export interface ReversalCapacityLine {
  readonly lineId: string;
  readonly lineNo: number;
  readonly baseQuantity: string;
  readonly reversedQuantity: string;
  /** `base_quantity − reversed_quantity`. */
  readonly remaining: string;
  /** Şu an en çok ters çevrilebilecek miktar: bakiye − rezerve (aynı boyutu paylaşan satırlar sırayla paylaşır), arşivli lokasyon/ürün, seri çakışması ve durum değiştiren taşıma hesaba katılır. */
  readonly maxReversible: string;
  /** Her zaman `true`: kilitsiz okuma, bilgi amaçlıdır; karar `reverseDocument`'ta kilit altında verilir (UI "en çok X" yerine "yaklaşık" göstermelidir). */
  readonly estimated: true;
}

/**
 * `reversal.create`: POSTED belgenin satır başına kalan ve şu an geri alınabilir miktarı (Senaryo C "kalan X; en çok X"). `source_kind` dolu belge
 * `REVERSAL_BLOCKED/SOURCE_LINKED` (B-1). Aynı azalan boyutu paylaşan satırlar satır sırasıyla kullanılabilirden payını alır (m-3).
 */
export async function getReversalCapacity(params: Omit<StockDocCallParams, "clientKey">, documentId: string): Promise<ReversalCapacityLine[]> {
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) throw new AppError("VALIDATION_FAILED");
  const id = documentId.toLowerCase();
  return runTenantQuery({ ...params, permission: "reversal.create" }, async (tx, m) => {
    const head = await tx.execute<{ warehouse_id: string; kind: string; status: string; source_kind: string | null }>(
      sql`SELECT warehouse_id, kind, status, source_kind FROM public.documents WHERE tenant_id = ${m.tenantId}::uuid AND id = ${id}::uuid`,
    );
    const h = head[0];
    if (h === undefined) throw new AppError("NOT_FOUND");
    await assertWarehouseVisible(tx, m, [h.warehouse_id]); // kapsam dışı belge varlık sızdırmaz
    if (h.status !== "POSTED" || !KINDS.has(h.kind)) throw documentState();
    if (h.source_kind !== null) throw blocked("SOURCE_LINKED");
    type Row = {
      id: string; line_no: number; base_quantity: string; reversed_quantity: string; status_change: boolean;
      dim_id: string | null; available: string | null; receiving_blocked: boolean;
    };
    const rows = await tx.execute<Row>(
      // Azalan boyut: STOCK_IN/STOCK_MOVE'da hedef boyut (durum: hedef ?? kaynak). Artan boyut: STOCK_OUT/STOCK_MOVE'da kaynak; lokasyon/ürün ACTIVE değilse
      // ya da seri başka yerde pozitifse geri yazılamaz (reverseDocument ile aynı kurallar, kilitsiz).
      sql`SELECT l.id, l.line_no, l.base_quantity::text AS base_quantity, l.reversed_quantity::text AS reversed_quantity,
                 (l.target_stock_status IS NOT NULL AND l.target_stock_status <> l.stock_status) AS status_change,
                 d.id AS dim_id,
                 CASE WHEN ${h.kind} = 'STOCK_OUT' THEN NULL ELSE GREATEST(COALESCE(b.quantity - b.reserved_quantity, 0), 0)::text END AS available,
                 (${h.kind} <> 'STOCK_IN' AND (
                    EXISTS (SELECT 1 FROM public.locations sl WHERE sl.tenant_id = l.tenant_id AND sl.id = l.source_location_id AND sl.status <> 'ACTIVE')
                    OR EXISTS (SELECT 1 FROM public.items it WHERE it.tenant_id = l.tenant_id AND it.id = l.item_id AND it.status <> 'ACTIVE')
                    OR (l.serial_id IS NOT NULL AND ${h.kind} = 'STOCK_OUT' AND EXISTS (
                         SELECT 1 FROM public.stock_balances sb JOIN public.stock_dimensions sd ON sd.tenant_id = sb.tenant_id AND sd.id = sb.stock_dimension_id
                          WHERE sb.tenant_id = l.tenant_id AND sd.serial_id = l.serial_id AND sb.quantity > 0))
                 )) AS receiving_blocked
            FROM public.document_lines l
            LEFT JOIN public.stock_dimensions d ON d.tenant_id = l.tenant_id AND d.item_id = l.item_id AND d.location_id = l.target_location_id
                 AND d.lot_id IS NOT DISTINCT FROM l.lot_id AND d.serial_id IS NOT DISTINCT FROM l.serial_id
                 AND d.stock_status = COALESCE(l.target_stock_status, l.stock_status)
                 AND d.inventory_owner_id IS NOT DISTINCT FROM l.inventory_owner_id AND d.handling_unit_id IS NOT DISTINCT FROM l.handling_unit_id
            LEFT JOIN public.stock_balances b ON b.tenant_id = d.tenant_id AND b.stock_dimension_id = d.id
           WHERE l.tenant_id = ${m.tenantId}::uuid AND l.document_id = ${id}::uuid ORDER BY l.line_no`,
    );
    const left = new Map<string, bigint>(); // azalan boyut → kalan kullanılabilir (satır sırasıyla tüketilir)
    return rows.map((r) => {
      const remaining = remainingMicro({ baseQuantity: r.base_quantity, reversedQuantity: r.reversed_quantity });
      let max = remaining;
      if (r.status_change || r.receiving_blocked) max = 0n;
      else if (r.available !== null && r.dim_id !== null) {
        const avail = left.get(r.dim_id) ?? toMicro(r.available);
        max = avail < remaining ? avail : remaining;
        left.set(r.dim_id, avail - max);
      } else if (r.available !== null) max = 0n; // azalan boyut yok = hiç stok yok
      return {
        lineId: r.id,
        lineNo: Number(r.line_no),
        baseQuantity: r.base_quantity,
        reversedQuantity: r.reversed_quantity,
        remaining: fromMicro(remaining),
        maxReversible: fromMicro(max),
        estimated: true as const,
      };
    });
  });
}

// --- yardımcılar ---------------------------------------------------------------------------------------------------------------

/** Ters miktar ürünün ondalık ölçeğine uymalı (örn. ölçek 0 ürünü 0,5 ters çevrilemez; A-87). Dönen: ürün → temel birim (ters satır miktarı için). */
async function assertItemScale(tx: AccessTx, tenantId: string, selection: readonly SelectedLine[]): Promise<Map<string, string>> {
  const ids = [...new Set(selection.map((s) => s.line.itemId.toLowerCase()))];
  const rows = await tx.execute<{ id: string; quantity_scale: number; base_unit_id: string }>(
    sql`SELECT id, quantity_scale, base_unit_id FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
  );
  const scale = new Map(rows.map((r) => [r.id.toLowerCase(), Number(r.quantity_scale)]));
  for (const s of selection) {
    const sc = scale.get(s.line.itemId.toLowerCase());
    if (sc === undefined) throw new AppError("NOT_FOUND");
    if (s.micro % 10n ** BigInt(6 - sc) !== 0n) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });
  }
  return new Map(rows.map((r) => [r.id.toLowerCase(), r.base_unit_id]));
}

async function readSourceKind(tx: AccessTx, tenantId: string, documentId: string): Promise<string | null> {
  const rows = await tx.execute<{ source_kind: string | null }>(
    sql`SELECT source_kind FROM public.documents WHERE tenant_id = ${tenantId}::uuid AND id = ${documentId}::uuid`,
  );
  if (rows[0] === undefined) throw new AppError("NOT_FOUND");
  return rows[0].source_kind;
}

/** Tenant saat diliminde bugün (A-71: iş tarihi bugünden ileri olamaz; ters kayıt bugünün tarihiyle yazılır). */
async function tenantToday(tx: AccessTx, tenantId: string): Promise<string> {
  const rows = await tx.execute<{ today: string }>(
    sql`SELECT (now() AT TIME ZONE COALESCE((SELECT time_zone FROM public.tenant_settings WHERE tenant_id = ${tenantId}::uuid), 'UTC'))::date::text AS today`,
  );
  const today = rows[0]?.today;
  if (today === undefined) throw new AppError("INTERNAL");
  return today;
}

async function systemTypeVersionId(tx: AccessTx): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = 'REVERSAL' AND version = 1`);
  const id = rows[0]?.id;
  if (id === undefined) throw new AppError("INTERNAL");
  return id;
}

/**
 * Ters satır miktarı (A-224-8, I-09: `base = round(quantity × katsayı, 6)` korunur, değer uydurulmaz): tam satırda asıl miktar/birim/katsayı aynen kopyalanır;
 * kısmi satırda asıl birimde `quantity = round(base/katsayı)` geri çarpımda tam `base`'i veriyorsa o birim, vermiyorsa ürünün temel birimi (katsayı 1,
 * miktar = base). Saf.
 */
export function reversalLineQuantity(
  line: Pick<SourceLine, "quantity" | "conversionFactor" | "baseQuantity" | "unitId">,
  micro: bigint,
  baseUnitId: string,
): { readonly unitId: string; readonly quantity: string; readonly conversionFactor: string } {
  if (micro === toMicro(line.baseQuantity)) return { unitId: line.unitId, quantity: line.quantity, conversionFactor: line.conversionFactor };
  const cf = toMicro(line.conversionFactor);
  const q = (micro * MICRO + cf / 2n) / cf;
  if (q > 0n && (q * cf + MICRO / 2n) / MICRO === micro) return { unitId: line.unitId, quantity: fromMicro(q), conversionFactor: line.conversionFactor };
  return { unitId: baseUnitId, quantity: fromMicro(micro), conversionFactor: fromMicro(MICRO) };
}

/**
 * REVERSAL belgesinin satırları: asıl satırın tersi yönde (kaynak ↔ hedef), `source_line_id` = asıl satır (M-2, A-224-7). Durum değiştiren taşıma buraya
 * gelmez (A-224-3), bu yüzden `stock_status` iki uçta aynıdır. Satır kimliği asıl satıra eşlenir (defter FK'si).
 */
async function insertReversalLines(
  tx: AccessTx,
  tenantId: string,
  reversalId: string,
  selection: readonly SelectedLine[],
  baseUnitByItem: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const idBySource = new Map<string, string>();
  const rows = selection.map((s, i) => {
    const id = randomUUID();
    idBySource.set(s.line.lineId.toLowerCase(), id);
    const baseUnit = baseUnitByItem.get(s.line.itemId.toLowerCase());
    if (baseUnit === undefined) throw new AppError("INTERNAL");
    const qn = reversalLineQuantity(s.line, s.micro, baseUnit);
    return {
      id,
      line_no: i + 1,
      item_id: s.line.itemId,
      unit_id: qn.unitId,
      quantity: qn.quantity,
      conversion_factor: qn.conversionFactor,
      base_quantity: fromMicro(s.micro),
      source_location_id: s.line.targetLocationId,
      target_location_id: s.line.sourceLocationId,
      lot_id: s.line.lotId,
      serial_id: s.line.serialId,
      stock_status: s.line.targetStatus,
      inventory_owner_id: s.line.inventoryOwnerId,
      handling_unit_id: s.line.handlingUnitId,
      source_line_id: s.line.lineId,
    };
  });
  await tx.execute(
    sql`INSERT INTO public.document_lines
          (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity,
           source_location_id, target_location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id, source_line_id)
        SELECT ${tenantId}::uuid, w.id, ${reversalId}::uuid, w.line_no, w.item_id, w.unit_id, w.quantity, w.conversion_factor, w.base_quantity,
               w.source_location_id, w.target_location_id, w.lot_id, w.serial_id, w.stock_status, w.inventory_owner_id, w.handling_unit_id, w.source_line_id
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
               AS w(id uuid, line_no int, item_id uuid, unit_id uuid, quantity numeric, conversion_factor numeric, base_quantity numeric,
                    source_location_id uuid, target_location_id uuid, lot_id uuid, serial_id uuid, stock_status text, inventory_owner_id uuid, handling_unit_id uuid, source_line_id uuid)
         ORDER BY w.line_no`,
  );
  return idBySource;
}

/** Defter satırları (açık sütun listesi; nedeni `REVERSAL`). Defter satırı REVERSAL belgesinin satırına bağlanır (FK); o satır `source_line_id` ile asıl satıra bağlıdır. */
async function writeLedger(
  tx: AccessTx,
  tenantId: string,
  reversalId: string,
  businessDate: string,
  actorUserId: string,
  plan: PostingPlan,
  dimIdByIdentity: ReadonlyMap<string, string>,
  reversalLineIdBySource: ReadonlyMap<string, string>,
): Promise<void> {
  const json = JSON.stringify(
    plan.entries.map((e, ord) => ({
      ord,
      line_id: reversalLineIdBySource.get(e.lineId.toLowerCase()),
      dimension_id: dimIdByIdentity.get(dimensionIdentity(e.key)),
      quantity: fromMicro(e.delta),
    })),
  );
  const rows = await tx.execute<{ id: string }>(
    sql`INSERT INTO public.stock_ledger (tenant_id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, actor_user_id)
        SELECT ${tenantId}::uuid, ${reversalId}::uuid, w.line_id, w.dimension_id, w.quantity, 'REVERSAL', ${businessDate}::date, ${actorUserId}::uuid
          FROM jsonb_to_recordset(${json}::jsonb) AS w(ord int, line_id uuid, dimension_id uuid, quantity numeric)
         ORDER BY w.ord
        RETURNING id`,
  );
  if (rows.length !== plan.entries.length) throw new AppError("INTERNAL");
}

/** Bakiye: miktarı AZALAN boyutlar ÖNCE, sonra artanlar (seri kısmi tekil indeksi anında denetlenir; posting.ts ile aynı sıra). Yalnızca kilitli satırlara yazılır. */
async function writeBalances(tx: AccessTx, tenantId: string, netByDimensionId: ReadonlyMap<string, bigint>): Promise<void> {
  const rows = [...netByDimensionId].map(([id, q]) => ({ id, q })).filter((x) => x.q !== 0n);
  for (const group of [rows.filter((x) => x.q < 0n), rows.filter((x) => x.q > 0n)]) {
    if (group.length === 0) continue;
    const json = JSON.stringify(group.map((x) => ({ dimension_id: x.id, delta: fromMicro(x.q) })));
    const updated = await tx.execute<{ stock_dimension_id: string }>(
      sql`UPDATE public.stock_balances b SET quantity = b.quantity + w.delta, version = b.version + 1
            FROM jsonb_to_recordset(${json}::jsonb) AS w(dimension_id uuid, delta numeric)
           WHERE b.tenant_id = ${tenantId}::uuid AND b.stock_dimension_id = w.dimension_id
          RETURNING b.stock_dimension_id`,
    );
    if (updated.length !== group.length) throw new AppError("INTERNAL");
  }
}

/** Asıl satırlarda `reversed_quantity` artışı + `reversal_status` (tek ifade). Belge kilitli; kalan aşımı SQL'de de dışlanır (savunma derinliği). */
async function advanceSourceLines(
  tx: AccessTx,
  tenantId: string,
  documentId: string,
  selection: readonly SelectedLine[],
): Promise<Map<string, { readonly reversed: bigint; readonly status: "PARTIAL" | "FULL" }>> {
  const states = new Map(selection.map((s) => [s.line.lineId.toLowerCase(), reversalStateAfter(s.line.baseQuantity, s.line.reversedQuantity, s.micro)]));
  const json = JSON.stringify(selection.map((s) => ({ line_id: s.line.lineId, add: fromMicro(s.micro) })));
  const rows = await tx.execute<{ id: string }>(
    sql`UPDATE public.document_lines l
           SET reversed_quantity = l.reversed_quantity + w.add,
               reversal_status = CASE WHEN l.reversed_quantity + w.add >= l.base_quantity THEN 'FULL' ELSE 'PARTIAL' END
          FROM jsonb_to_recordset(${json}::jsonb) AS w(line_id uuid, add numeric)
         WHERE l.tenant_id = ${tenantId}::uuid AND l.document_id = ${documentId}::uuid AND l.id = w.line_id
           AND l.reversed_quantity + w.add <= l.base_quantity
        RETURNING l.id`,
  );
  if (rows.length !== selection.length) throw new AppError("INTERNAL");
  return states;
}

/** Salt okuma: geri yazılacak serilerin pozitif bakiyeli boyutları (seri kilidi altında kararlıdır; posting.ts ile aynı sorgu biçimi). */
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
