// Stok belgesi yaşam döngüsü (T-213; 05 §Belge durumları, ADR-018 §6, I-08, I-11, A-03, A-07, A-71, A-79).
//
//   DRAFT ──approve──▶ APPROVED ──(T-217 işleme)──▶ POSTED        DRAFT/APPROVED ──cancel──▶ CANCELLED
//
// - Dört komut da `executeStockCommand` üzerinden geçer (idempotency, zaman aşımı, yeniden deneme, audit). Bu komutların stok etkisi
//   YOKTUR (16-stock-effects: DRAFT/APPROVED/CANCELLED stok etkisiz); kilit planı yalnızca belge başlığıdır.
// - Başlık, satır yazımından ÖNCE `acquireStockLocks` ile `FOR UPDATE` kilitlenir (0012 `document_lines_guard` üst belgeyi `FOR SHARE` okur:
//   önce başlığı kilitlemeyen iki eşzamanlı düzenleme kilit yükseltmesinde 40P01 alırdı — T-206 incelemesi MINOR-3). Başlık güncellemesi
//   (sürüm +1, DB tetikleyicisi) her `updateDraft`'ta satırlardan önce yapılır.
// - İşleme kilidi (M-6): `posting_job_id IS NOT NULL` iken `updateDraft`/`approveDocument`/`cancelDocument` → `DOCUMENT_STATE`
//   (`assertNotProcessing`; T-217/T-221 de kullanır).
// - Yazımlar açık sütun listelidir (Drizzle `insert()` varsayılan sütunları hedef listesine koyar → sunucu türetimli sütunlarda 42501).
// - Durum geçmişini `documents` tetikleyicisi yazar (doğrudan INSERT yasak); görev ayrımı yok (A-03 kapalı).
//
// A-xx varsayımları (rapor): (a) `approveDocument` en az 1 satır ister (boş belge işlenemez); (b) satırda `baseQuantity`
// = `quantity × conversionFactor` (6 hane) tutarlılığı SQL'de denetlenir, dönüşüm/ölçek kuralları T-208/T-217'dedir; (c) belge
// türleri yalnızca STOCK_IN/OUT/MOVE ile açılır (REVERSAL T-224'te); (d) iş tarihi tenant saat dilimine göre bugünden ileri olamaz (A-71).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import type { AccessTx, TenantAccessParams } from "../identity/access.ts";
import { pgUuidArray } from "../warehouse/scope.ts";
import { EMPTY_LOCK_PLAN, executeStockCommand, type StockCommandOutcome, type StockCommandParams } from "./command.ts";
import type { StockCommandResult, StockResultLine } from "./idempotency.ts";
import { yearOfBusinessDate } from "./numbering.ts";

/** Çağıran bağlamı: izin komuta bağlıdır; `clientKey` her komutta zorunludur (A-73). */
export type StockDocCallParams = Omit<TenantAccessParams, "permission" | "recentAuth"> & {
  readonly clientKey: string | null | undefined;
  readonly retry?: StockCommandParams<unknown>["retry"];
  readonly timeouts?: StockCommandParams<unknown>["timeouts"];
  readonly logger?: StockCommandParams<unknown>["logger"];
};

/** A-07: belge başına en çok 2.000 satır. */
export const MAX_DOCUMENT_LINES = 2000;
export const REASON_MAX = 500;

export type StockDocumentKind = "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE";
const CREATABLE_KINDS: ReadonlySet<string> = new Set(["STOCK_IN", "STOCK_OUT", "STOCK_MOVE"]);
const LINE_STOCK_STATUSES: ReadonlySet<string> = new Set(["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;
const CONTROL_RE = /\p{C}/u;

export interface DocumentLineInput {
  readonly itemId: string;
  readonly unitId: string;
  /** Pozitif ondalık dizgi (numeric(20,6); float yok — I-09). */
  readonly quantity: string;
  readonly conversionFactor: string;
  readonly baseQuantity: string;
  readonly sourceLocationId?: string | null;
  readonly targetLocationId?: string | null;
  readonly lotId?: string | null;
  readonly serialId?: string | null;
  readonly stockStatus?: "AVAILABLE" | "QUARANTINE" | "DAMAGED" | "BLOCKED";
  readonly inventoryOwnerId?: string | null;
  readonly handlingUnitId?: string | null;
}

interface NormalizedLine {
  readonly id: string;
  readonly line_no: number;
  readonly item_id: string;
  readonly unit_id: string;
  readonly quantity: string;
  readonly conversion_factor: string;
  readonly base_quantity: string;
  readonly source_location_id: string | null;
  readonly target_location_id: string | null;
  readonly lot_id: string | null;
  readonly serial_id: string | null;
  readonly stock_status: string;
  readonly inventory_owner_id: string | null;
  readonly handling_unit_id: string | null;
}

function uuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
}
function uuidOrNull(raw: unknown): string | null {
  return raw === undefined || raw === null ? null : uuid(raw);
}
function positiveDecimal(raw: unknown): string {
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw) || !/[1-9]/.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw;
}
function version(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) throw new AppError("VALIDATION_FAILED");
  return raw;
}
function reasonOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const v = raw.trim();
  if (v === "" || Array.from(v).length > REASON_MAX || CONTROL_RE.test(v)) throw new AppError("VALIDATION_FAILED");
  return v;
}
function businessDateOf(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  yearOfBusinessDate(raw);
  return raw;
}

/** Satırları doğrular (biçim; kural değil) ve sunucu satır numarası/kimliği atar. > 2.000 satır → `DOCUMENT_TOO_LARGE`. */
function normalizeLines(raw: unknown): NormalizedLine[] {
  if (!Array.isArray(raw)) throw new AppError("VALIDATION_FAILED");
  if (raw.length > MAX_DOCUMENT_LINES) throw new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_TOO_LARGE" });
  return (raw as unknown[]).map((l, i) => {
    if (typeof l !== "object" || l === null || Array.isArray(l)) throw new AppError("VALIDATION_FAILED");
    const x = l as Record<string, unknown>;
    const status = x.stockStatus === undefined ? "AVAILABLE" : x.stockStatus;
    if (typeof status !== "string" || !LINE_STOCK_STATUSES.has(status)) throw new AppError("VALIDATION_FAILED");
    return {
      id: randomUUID(),
      line_no: i + 1,
      item_id: uuid(x.itemId),
      unit_id: uuid(x.unitId),
      quantity: positiveDecimal(x.quantity),
      conversion_factor: positiveDecimal(x.conversionFactor),
      base_quantity: positiveDecimal(x.baseQuantity),
      source_location_id: uuidOrNull(x.sourceLocationId),
      target_location_id: uuidOrNull(x.targetLocationId),
      lot_id: uuidOrNull(x.lotId),
      serial_id: uuidOrNull(x.serialId),
      stock_status: status,
      inventory_owner_id: uuidOrNull(x.inventoryOwnerId),
      handling_unit_id: uuidOrNull(x.handlingUnitId),
    };
  });
}

function recordset(lines: readonly NormalizedLine[]) {
  const json = JSON.stringify(lines);
  return sql`jsonb_to_recordset(${json}::jsonb) AS w(id uuid, line_no int, item_id uuid, unit_id uuid, quantity numeric, conversion_factor numeric, base_quantity numeric,
     source_location_id uuid, target_location_id uuid, lot_id uuid, serial_id uuid, stock_status text, inventory_owner_id uuid, handling_unit_id uuid)`;
}

/** Açık sütun listeli, tek ifadelik satır yazımı (sunucu türetimli sütun yok). Başlık ÖNCEDEN kilitli olmalıdır. */
async function insertLines(tx: AccessTx, tenantId: string, documentId: string, lines: readonly NormalizedLine[]): Promise<readonly StockResultLine[]> {
  if (lines.length === 0) return [];
  const bad = await tx.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ${recordset(lines)} WHERE round(w.quantity * w.conversion_factor, 6) <> w.base_quantity`,
  );
  if (Number(bad[0]?.n ?? "0") > 0) throw new AppError("VALIDATION_FAILED"); // base_quantity = quantity × conversion_factor (A-xx b)
  await tx.execute(
    sql`INSERT INTO public.document_lines
          (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity,
           source_location_id, target_location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id)
        SELECT ${tenantId}::uuid, w.id, ${documentId}::uuid, w.line_no, w.item_id, w.unit_id, w.quantity, w.conversion_factor, w.base_quantity,
               w.source_location_id, w.target_location_id, w.lot_id, w.serial_id, w.stock_status, w.inventory_owner_id, w.handling_unit_id
          FROM ${recordset(lines)}
         ORDER BY w.line_no`,
  );
  return lines.map((l) => ({ lineId: l.id, lineNo: l.line_no, quantity: l.quantity, baseQuantity: l.base_quantity }));
}

// --- ortak yardımcılar (T-217/T-221 de kullanır) ----------------------------------------------------------------------

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

function documentState(): AppError {
  return new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" });
}

/**
 * Ürünleri `FOR SHARE` okur ve hepsinin ACTIVE olduğunu denetler (ARCHIVED ürüne hareket reddedilir; arşivleme `FOR NO KEY UPDATE`
 * ile çakışır). Eksik ürün → `NOT_FOUND`; ACTIVE değil → `VALIDATION_FAILED`. Kimliğe göre sıralı (kilit sırası sabit).
 */
export async function assertItemsActive(tx: AccessTx, tenantId: string, itemIds: readonly string[]): Promise<void> {
  const ids = [...new Set(itemIds.map((i) => i.toLowerCase()))].sort();
  if (ids.length === 0) return;
  const rows = await tx.execute<{ id: string; status: string }>(
    sql`SELECT id, status FROM public.items
         WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])
         ORDER BY id FOR SHARE`,
  );
  if (rows.length !== ids.length) throw new AppError("NOT_FOUND");
  if (rows.some((r) => r.status !== "ACTIVE")) throw new AppError("VALIDATION_FAILED");
}

async function assertWarehouseActive(tx: AccessTx, tenantId: string, warehouseId: string): Promise<void> {
  const rows = await tx.execute<{ status: string }>(
    sql`SELECT status FROM public.warehouses WHERE tenant_id = ${tenantId}::uuid AND id = ${warehouseId}::uuid FOR SHARE`,
  );
  if (rows[0] === undefined) throw new AppError("NOT_FOUND");
  if (rows[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
}

/** A-71: iş tarihi tenant saat dilimine göre bugünden ileri olamaz (geçmiş serbest). Dönen: tenant "bugün" (YYYY-MM-DD). */
async function assertBusinessDateNotFuture(tx: AccessTx, tenantId: string, businessDate: string | undefined): Promise<string> {
  const rows = await tx.execute<{ today: string }>(
    sql`SELECT (now() AT TIME ZONE COALESCE((SELECT time_zone FROM public.tenant_settings WHERE tenant_id = ${tenantId}::uuid), 'UTC'))::date::text AS today`,
  );
  const today = rows[0]?.today;
  if (today === undefined) throw new AppError("INTERNAL");
  if (businessDate !== undefined && businessDate > today) throw new AppError("VALIDATION_FAILED");
  return businessDate ?? today;
}

async function systemTypeVersionId(tx: AccessTx, kind: string): Promise<string> {
  // I-11/A-79: sistem fiş tipi v1 (tenant_id NULL). Sürüm satırı değişmez; belge oluşturulurken kimliği yazılır.
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = ${kind} AND version = 1`,
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new AppError("INTERNAL");
  return id;
}

const lockOnly = (documentId: string, expectedVersion: number) => ({ ...EMPTY_LOCK_PLAN, document: { id: documentId, expectedVersion } });

async function planFor(tx: AccessTx, tenantId: string, documentId: string, extraWarehouseIds: readonly string[], expectedVersion: number) {
  // Yalnızca depo kimliği için salt okuma; durum/kural denetimi apply'da KİLİTLİ görüntüde yapılır.
  const rows = await tx.execute<{ warehouse_id: string }>(
    sql`SELECT warehouse_id FROM public.documents WHERE tenant_id = ${tenantId}::uuid AND id = ${documentId}::uuid`,
  );
  const w = rows[0]?.warehouse_id;
  if (w === undefined) throw new AppError("NOT_FOUND");
  return { warehouseIds: [w, ...extraWarehouseIds], locks: lockOnly(documentId, expectedVersion) };
}

function run<I, R extends StockCommandResult>(
  params: StockDocCallParams,
  spec: Pick<StockCommandParams<I, R>, "commandType" | "permission" | "input" | "plan" | "apply">,
): Promise<StockCommandOutcome<R>> {
  return executeStockCommand<I, R>({
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    ...spec,
  });
}

function completed<R extends StockCommandResult>(o: StockCommandOutcome<R>): R & { readonly replayed: boolean } {
  if (o.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true }); // işleniyor: bu komutlarda beklenmez
  return { ...o.result, replayed: o.replayed };
}

// --- komutlar ---------------------------------------------------------------------------------------------------------

export interface CreateStockDocumentInput {
  readonly kind: StockDocumentKind;
  readonly warehouseId: string;
  /** `YYYY-MM-DD`; yoksa tenant saat diliminde bugün. */
  readonly businessDate?: string;
  readonly reason?: string | null;
  readonly lines?: readonly DocumentLineInput[];
  readonly requestId?: string | null;
}

/** `document.create`: `DRAFT` belge + satırlar. Satır sayısı > 2.000 → `VALIDATION_FAILED`/`DOCUMENT_TOO_LARGE`. */
export async function createStockDocument(
  params: StockDocCallParams,
  input: CreateStockDocumentInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  if (typeof input.kind !== "string" || !CREATABLE_KINDS.has(input.kind)) throw new AppError("VALIDATION_FAILED");
  const kind = input.kind;
  const warehouseId = uuid(input.warehouseId);
  const businessDate = businessDateOf(input.businessDate);
  const reason = reasonOf(input.reason);
  const lines = normalizeLines(input.lines ?? []);
  // İstek özeti yalnızca düz girdidir (satır kimlikleri sunucuda üretilir → özete girmez).
  const hashInput = { kind, warehouseId, businessDate, reason, lines: (input.lines ?? []) as unknown };
  return completed(
    await run<typeof hashInput, StockCommandResult>(params, {
      commandType: "stock.document.create",
      permission: "document.create",
      input: hashInput,
      plan: async () => ({ warehouseIds: [warehouseId], locks: EMPTY_LOCK_PLAN }),
      apply: async (tx, _locked, ctx) => {
        await assertWarehouseActive(tx, ctx.tenantId, warehouseId);
        const date = await assertBusinessDateNotFuture(tx, ctx.tenantId, businessDate);
        await assertItemsActive(tx, ctx.tenantId, lines.map((l) => l.item_id));
        const typeVersionId = await systemTypeVersionId(tx, kind);
        const documentId = randomUUID();
        await tx.execute(
          sql`INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, reason, created_by)
              VALUES (${ctx.tenantId}::uuid, ${documentId}::uuid, ${kind}, ${typeVersionId}::uuid, ${warehouseId}::uuid, ${date}::date, ${reason}, ${ctx.userId}::uuid)`,
        );
        const resultLines = await insertLines(tx, ctx.tenantId, documentId, lines);
        return {
          result: { documentId, status: "DRAFT", lines: resultLines },
          audit: {
            action: "stock_document.created",
            entityType: "stock_document",
            entityId: documentId,
            requestId: input.requestId ?? null,
            changeSummary: { kind, warehouseId, businessDate: date, lineCount: lines.length },
          },
        };
      },
    }),
  );
}

export interface UpdateDraftInput {
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly warehouseId?: string;
  readonly businessDate?: string;
  /** `null` gerekçeyi temizler; verilmezse değişmez. */
  readonly reason?: string | null;
  /** Verilirse satırlar TÜMÜYLE değiştirilir; verilmezse korunur. */
  readonly lines?: readonly DocumentLineInput[];
  readonly requestId?: string | null;
}

/**
 * `document.create`: `DRAFT` belgeyi sürüm denetimiyle günceller. Sürüm uyuşmazlığı `VERSION_CONFLICT`; `DRAFT` değilse ya da işleme kilidi
 * varsa `DOCUMENT_STATE`. Kayıtlı bir audit eylemi (`stock_document.updated`) yoktur → audit YAZILMAZ (rapor Bulgusu; kart eki gerekli).
 */
export async function updateDraft(
  params: StockDocCallParams,
  input: UpdateDraftInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const documentId = uuid(input.documentId);
  const expectedVersion = version(input.expectedVersion);
  const warehouseId = input.warehouseId === undefined ? undefined : uuid(input.warehouseId);
  const businessDate = businessDateOf(input.businessDate);
  const reason = input.reason === undefined ? undefined : reasonOf(input.reason);
  const lines = input.lines === undefined ? undefined : normalizeLines(input.lines);
  const hashInput = { documentId, expectedVersion, warehouseId, businessDate, reason, lines: input.lines as unknown };
  return completed(
    await run<typeof hashInput, StockCommandResult>(params, {
      commandType: "stock.document.update",
      permission: "document.create",
      input: hashInput,
      plan: (tx, _i, m) => planFor(tx, m.tenantId, documentId, warehouseId === undefined ? [] : [warehouseId], expectedVersion),
      apply: async (tx, locked, ctx) => {
        if (locked.document === undefined) throw new AppError("INTERNAL");
        const header = await readDocumentHeader(tx, ctx.tenantId, documentId); // kilit altında
        assertNotProcessing(header);
        if (header.status !== "DRAFT") throw documentState();
        if (warehouseId !== undefined && warehouseId !== header.warehouseId) await assertWarehouseActive(tx, ctx.tenantId, warehouseId);
        const date = await assertBusinessDateNotFuture(tx, ctx.tenantId, businessDate ?? header.businessDate);
        if (lines !== undefined) await assertItemsActive(tx, ctx.tenantId, lines.map((l) => l.item_id));
        // Başlık ÖNCE (sürüm +1 tetikleyiciyle; kilit zaten bizde), satırlar SONRA.
        await tx.execute(
          sql`UPDATE public.documents
                 SET warehouse_id = ${warehouseId ?? header.warehouseId}::uuid,
                     business_date = ${date}::date,
                     reason = ${reason === undefined ? header.reason : reason}
               WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${documentId}::uuid`,
        );
        let resultLines: readonly StockResultLine[] | undefined;
        if (lines !== undefined) {
          await tx.execute(sql`DELETE FROM public.document_lines WHERE tenant_id = ${ctx.tenantId}::uuid AND document_id = ${documentId}::uuid`);
          resultLines = await insertLines(tx, ctx.tenantId, documentId, lines);
        }
        return { result: { documentId, status: "DRAFT", ...(resultLines === undefined ? {} : { lines: resultLines }) }, audit: null };
      },
    }),
  );
}

export interface TransitionInput {
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly requestId?: string | null;
}

/** `document.approve`: `DRAFT → APPROVED` (A-03: görev ayrımı yok). Boş belge (satırsız) onaylanamaz (A-xx a). */
export async function approveDocument(
  params: StockDocCallParams,
  input: TransitionInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const documentId = uuid(input.documentId);
  const expectedVersion = version(input.expectedVersion);
  const hashInput = { documentId, expectedVersion };
  return completed(
    await run<typeof hashInput, StockCommandResult>(params, {
      commandType: "stock.document.approve",
      permission: "document.approve",
      input: hashInput,
      plan: (tx, _i, m) => planFor(tx, m.tenantId, documentId, [], expectedVersion),
      apply: async (tx, locked, ctx) => {
        if (locked.document === undefined) throw new AppError("INTERNAL");
        const header = await readDocumentHeader(tx, ctx.tenantId, documentId);
        assertNotProcessing(header);
        if (header.status !== "DRAFT") throw documentState();
        const count = await tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM public.document_lines WHERE tenant_id = ${ctx.tenantId}::uuid AND document_id = ${documentId}::uuid`,
        );
        if (Number(count[0]?.n ?? "0") < 1) throw new AppError("VALIDATION_FAILED");
        await tx.execute(
          sql`UPDATE public.documents SET status = 'APPROVED' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${documentId}::uuid`,
        );
        return {
          result: { documentId, status: "APPROVED" },
          audit: {
            action: "stock_document.approved",
            entityType: "stock_document",
            entityId: documentId,
            requestId: input.requestId ?? null,
            changeSummary: { fromStatus: "DRAFT", toStatus: "APPROVED", lineCount: Number(count[0]?.n ?? "0") },
          },
        };
      },
    }),
  );
}

export interface CancelDocumentInput extends TransitionInput {
  readonly reason?: string | null;
}

/** `document.create`: `DRAFT`/`APPROVED → CANCELLED`; `POSTED`/`CANCELLED` → `DOCUMENT_STATE`; işleme kilidi varsa `DOCUMENT_STATE`. */
export async function cancelDocument(
  params: StockDocCallParams,
  input: CancelDocumentInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const documentId = uuid(input.documentId);
  const expectedVersion = version(input.expectedVersion);
  const reason = reasonOf(input.reason);
  const hashInput = { documentId, expectedVersion, reason };
  return completed(
    await run<typeof hashInput, StockCommandResult>(params, {
      commandType: "stock.document.cancel",
      permission: "document.create",
      input: hashInput,
      plan: (tx, _i, m) => planFor(tx, m.tenantId, documentId, [], expectedVersion),
      apply: async (tx, locked, ctx) => {
        if (locked.document === undefined) throw new AppError("INTERNAL");
        const header = await readDocumentHeader(tx, ctx.tenantId, documentId);
        assertNotProcessing(header);
        if (header.status !== "DRAFT" && header.status !== "APPROVED") throw documentState();
        await tx.execute(
          sql`UPDATE public.documents SET status = 'CANCELLED', reason = ${reason ?? header.reason}
               WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${documentId}::uuid`,
        );
        return {
          result: { documentId, status: "CANCELLED" },
          audit: {
            action: "stock_document.cancelled",
            entityType: "stock_document",
            entityId: documentId,
            reason,
            requestId: input.requestId ?? null,
            changeSummary: { fromStatus: header.status, toStatus: "CANCELLED" },
          },
        };
      },
    }),
  );
}
