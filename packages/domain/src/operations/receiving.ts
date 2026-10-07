// Mal kabul ve kalite onayı komutları (T-305; ADR-021 §1-3, 06 §Mal kabul ve yerleştirme, 16 Senaryo A/D adım 1-3).
//
// Komutlar ve izinler: `createInboundReceipt`/`openInboundReceipt`/`cancelInboundReceipt` `document.create`; `receiveGoods` `stock.post`;
// `approveQuality` `document.approve` (A-132). Hepsi `executeStockCommand` üzerinden (istemci anahtarı zorunlu, idempotency, zaman aşımı,
// yeniden deneme, audit). Stok etkisi olan ikisi (`receiveGoods`, `approveQuality`) primitif belgeyi AYNI transaction'da oluşturur/onaylar/işler
// (`field-posting.ts`; tek istemci anahtarı saha komutunundur).
//
// Eşleme: kabul → `STOCK_IN`/`RECEIPT` (kalite açıkken `+(kabul−hasarlı) KABUL·QUARANTINE`, `+hasarlı KABUL·DAMAGED`; kapalıyken `AVAILABLE`);
// kalite onayı → `STOCK_MOVE`/`MOVE` `QUARANTINE → AVAILABLE` aynı lokasyonda (`target_stock_status`; T-258 beyaz listesi: DAMAGED hiçbir zaman
// AVAILABLE olmaz — bu komut hasarlı stoğa hiç dokunmaz, ayrıca DB tetikleyicisi 0020 ve plan.ts reddeder).
//
// Eşzamanlılık (Supervisor notu 1): satır yazan her komut önce saha başlığını `FOR UPDATE` kilitler (stok kilitlerinden SONRA); satırlar sonra yazılır.
// Kaynak bağlantısı (A-152) kilit altında doğrulanır: satır gerçekten bu belgeye ait değilse `NOT_FOUND`; UPDATE 0 satır dönerse `INTERNAL` (sessiz no-op yok).
//
// A-xx (rapor, docs/OPEN_QUESTIONS.md): A-305-1 numara öneki `KBL`; A-305-2 create/open/cancel izni `document.create`; A-305-3 fazla kabul
// `VALIDATION_FAILED` (OVER_RECEIPT ayrıntısı ERROR_DETAILS'te olmadığından ayrıntısız; bulgu); A-305-4 takipli (lot/seri) ürün kabulü bu kartta yok
// (TRACKING_VIOLATION); A-305-5 kısmi kabul sonrası eksik kalan belge `OPEN` kalır (kapatma komutu kartta yok); A-305-6 komut başına satır ≤ 200.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { appendAudit, type AuditEntry } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";
import { pgUuidArray } from "../warehouse/scope.ts";
import {
  EMPTY_LOCK_PLAN,
  SYNC_POST_MAX_LINES,
  assertItemsActive,
  executeStockCommand,
  nextDocumentNumber,
  type StockCommandOutcome,
  type StockCommandParams,
  type StockCommandResult,
  type StockDocCallParams,
} from "../stock/index.ts";
import {
  DECIMAL_RE,
  baseQuantityOf,
  decimalToMicro,
  documentState,
  emptyPlan,
  lockFieldHeader,
  microToDecimal,
  planFieldPosting,
  postFieldDocument,
  tenantToday,
  tooLarge,
  uuidOf,
  type FieldLine,
  type FieldPostSpec,
} from "./field-posting.ts";
import { createTasks, type NewTaskInput } from "./tasks.ts";

const SUPPLIER_REF_MAX = 100;
const REASON_MAX = 500;
const CONTROL_RE = /\p{C}/u;

type CommandSpec<I> = Pick<StockCommandParams<I, StockCommandResult>, "commandType" | "permission" | "input" | "plan" | "apply">;

function run<I>(params: StockDocCallParams, spec: CommandSpec<I>): Promise<StockCommandOutcome<StockCommandResult>> {
  return executeStockCommand<I, StockCommandResult>({
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

function completed(o: StockCommandOutcome<StockCommandResult>): StockCommandResult & { readonly replayed: boolean } {
  if (o.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true }); // senkron komutlarda beklenmez
  return { ...o.result, replayed: o.replayed };
}

function auditOf(action: AuditEntry["action"], receiptId: string, requestId: string | null | undefined, changeSummary: Record<string, unknown>, reason?: string | null) {
  return { action, entityType: "inbound_receipt", entityId: receiptId, requestId: requestId ?? null, reason: reason ?? null, changeSummary };
}

function positiveDecimal(raw: unknown): string {
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw) || decimalToMicro(raw) <= 0n) throw new AppError("VALIDATION_FAILED");
  return raw;
}
function nonNegativeDecimal(raw: unknown): string {
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw;
}
function versionOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) throw new AppError("VALIDATION_FAILED");
  return raw;
}
function textOrNull(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const v = raw.trim();
  if (v === "" || Array.from(v).length > max || CONTROL_RE.test(v)) throw new AppError("VALIDATION_FAILED");
  return v;
}
function arrayOf(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw)) throw new AppError("VALIDATION_FAILED");
  if (raw.length < 1) throw new AppError("VALIDATION_FAILED");
  if (raw.length > SYNC_POST_MAX_LINES) throw tooLarge();
  return raw as unknown[];
}
function objectOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as Record<string, unknown>;
}

async function assertWarehouseActive(tx: AccessTx, tenantId: string, warehouseId: string): Promise<void> {
  const rows = await tx.execute<{ status: string }>(
    sql`SELECT status FROM public.warehouses WHERE tenant_id = ${tenantId}::uuid AND id = ${warehouseId}::uuid FOR SHARE`,
  );
  if (rows[0] === undefined) throw new AppError("NOT_FOUND");
  if (rows[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
}

/** Kilitsiz depo okuma (yalnızca kapsam denetimi için; kural apply'dadır). */
async function receiptWarehouse(tx: AccessTx, tenantId: string, receiptId: string): Promise<string> {
  const rows = await tx.execute<{ warehouse_id: string }>(
    sql`SELECT warehouse_id FROM public.inbound_receipts WHERE tenant_id = ${tenantId}::uuid AND id = ${receiptId}::uuid`,
  );
  const w = rows[0]?.warehouse_id;
  if (w === undefined) throw new AppError("NOT_FOUND");
  return w;
}

// ---------------------------------------------------------------------------------------------------------------------
// createInboundReceipt
// ---------------------------------------------------------------------------------------------------------------------
export interface InboundReceiptLineInput {
  readonly itemId: string;
  readonly unitId: string;
  /** Beklenen miktar, `unitId` biriminde (pozitif ondalık dizgi). */
  readonly expectedQuantity: string;
}
export interface CreateInboundReceiptInput {
  readonly warehouseId: string;
  readonly supplierRef?: string | null;
  readonly lines: readonly InboundReceiptLineInput[];
  readonly requestId?: string | null;
}

/**
 * `document.create`: beklenen teslim (DRAFT). Dönüşüm katsayısı satırda KOPYALANIR (I-09): temel birim → 1, aksi `unit_conversions`; katsayısı olmayan
 * birim `VALIDATION_FAILED`. Sonuç: `documentId` = KABUL BELGESİ kimliği (beyaz liste yalnızca bu alanı taşır), `documentNumber` = `KBL-…`.
 */
export async function createInboundReceipt(
  params: StockDocCallParams,
  input: CreateInboundReceiptInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const warehouseId = uuidOf(input.warehouseId);
  const supplierRef = textOrNull(input.supplierRef, SUPPLIER_REF_MAX);
  const lines = arrayOf(input.lines).map((raw) => {
    const x = objectOf(raw);
    return { itemId: uuidOf(x.itemId), unitId: uuidOf(x.unitId), expectedQuantity: positiveDecimal(x.expectedQuantity) };
  });
  const hashInput = { warehouseId, supplierRef, lines };
  return completed(
    await run(params, {
      commandType: "inbound_receipt.create",
      permission: "document.create",
      input: hashInput,
      plan: async () => emptyPlan([warehouseId]),
      apply: async (tx, _locked, ctx) => {
        await assertWarehouseActive(tx, ctx.tenantId, warehouseId);
        const itemIds = [...new Set(lines.map((l) => l.itemId))].sort();
        await assertItemsActive(tx, ctx.tenantId, itemIds);
        // A-305-4: takipli (LOT/SERIAL) ürünün kabulü bu kartta yok → belge hiç açılmaz (kabulde TRACKING_VIOLATION'a düşmesin).
        const tracked = await tx.execute<{ id: string }>(
          sql`SELECT id FROM public.items WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${pgUuidArray(itemIds)}::uuid[]) AND tracking_mode <> 'NONE'`,
        );
        if (tracked.length > 0) throw new AppError("VALIDATION_FAILED");
        const factors = await tx.execute<{ item_id: string; unit_id: string; factor: string }>(
          sql`SELECT i.id AS item_id, i.base_unit_id AS unit_id, '1.000000' AS factor FROM public.items i
               WHERE i.tenant_id = ${ctx.tenantId}::uuid AND i.id = ANY(${pgUuidArray(itemIds)}::uuid[])
              UNION ALL
              SELECT c.item_id, c.unit_id, c.to_base_factor::text FROM public.unit_conversions c
               WHERE c.tenant_id = ${ctx.tenantId}::uuid AND c.item_id = ANY(${pgUuidArray(itemIds)}::uuid[])`,
        );
        const factorOf = new Map(factors.map((f) => [`${f.item_id.toLowerCase()}|${f.unit_id.toLowerCase()}`, f.factor]));
        const resolved = lines.map((l) => {
          const f = factorOf.get(`${l.itemId}|${l.unitId}`);
          if (f === undefined) throw new AppError("VALIDATION_FAILED"); // birimin bu ürün için dönüşümü yok
          return { ...l, factor: f };
        });
        const date = await tenantToday(tx, ctx.tenantId);
        const number = await nextDocumentNumber(tx, ctx.tenantId, "INBOUND_RECEIPT", date);
        const receiptId = randomUUID();
        await tx.execute(
          sql`INSERT INTO public.inbound_receipts (tenant_id, id, warehouse_id, number, supplier_ref, created_by)
              VALUES (${ctx.tenantId}::uuid, ${receiptId}::uuid, ${warehouseId}::uuid, ${number}, ${supplierRef}, ${ctx.userId}::uuid)`,
        );
        const json = JSON.stringify(
          resolved.map((l, i) => ({ id: randomUUID(), line_no: i + 1, item_id: l.itemId, unit_id: l.unitId, factor: l.factor, expected: l.expectedQuantity })),
        );
        await tx.execute(
          sql`INSERT INTO public.inbound_receipt_lines (tenant_id, id, receipt_id, line_no, item_id, unit_id, conversion_factor, expected_quantity)
              SELECT ${ctx.tenantId}::uuid, w.id, ${receiptId}::uuid, w.line_no, w.item_id, w.unit_id, w.factor, w.expected
                FROM jsonb_to_recordset(${json}::jsonb) AS w(id uuid, line_no int, item_id uuid, unit_id uuid, factor numeric, expected numeric)
               ORDER BY w.line_no`,
        );
        return {
          result: { documentId: receiptId, documentNumber: number, status: "DRAFT" },
          audit: auditOf("inbound_receipt.created", receiptId, input.requestId, { warehouseId, number, lineCount: lines.length }),
        };
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// openInboundReceipt / cancelInboundReceipt
// ---------------------------------------------------------------------------------------------------------------------
export interface ReceiptTransitionInput {
  readonly receiptId: string;
  readonly expectedVersion: number;
  readonly requestId?: string | null;
}

/** Sonlanmış → `DOCUMENT_STATE`; sonra sürüm → `VERSION_CONFLICT` (A-184 sırası). */
function guardVersion(status: string, version: number, expectedVersion: number): void {
  if (status === "CLOSED" || status === "CANCELLED") throw documentState();
  if (version !== expectedVersion) throw new AppError("VERSION_CONFLICT");
}

/** `document.create`: `DRAFT → OPEN`. */
export async function openInboundReceipt(
  params: StockDocCallParams,
  input: ReceiptTransitionInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const receiptId = uuidOf(input.receiptId);
  const expectedVersion = versionOf(input.expectedVersion);
  return completed(
    await run(params, {
      commandType: "inbound_receipt.open",
      permission: "document.create",
      input: { receiptId, expectedVersion },
      plan: async (tx, _i, m) => emptyPlan([await receiptWarehouse(tx, m.tenantId, receiptId)]),
      apply: async (tx, _locked, ctx) => {
        const h = await lockFieldHeader(tx, ctx.tenantId, "inbound_receipts", receiptId);
        guardVersion(h.status, h.version, expectedVersion);
        if (h.status !== "DRAFT") throw documentState();
        const upd = await tx.execute<{ id: string }>(
          sql`UPDATE public.inbound_receipts SET status = 'OPEN' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${receiptId}::uuid RETURNING id`,
        );
        if (upd[0] === undefined) throw new AppError("INTERNAL");
        return {
          result: { documentId: receiptId, documentNumber: h.number },
          audit: auditOf("inbound_receipt.opened", receiptId, input.requestId, { fromStatus: "DRAFT", toStatus: "OPEN" }),
        };
      },
    }),
  );
}

export interface CancelInboundReceiptInput extends ReceiptTransitionInput {
  readonly reason?: string | null;
}

/** `document.create`: `DRAFT`/`OPEN → CANCELLED`; kabul yapılmışsa (Σ kabul > 0) `DOCUMENT_STATE`. */
export async function cancelInboundReceipt(
  params: StockDocCallParams,
  input: CancelInboundReceiptInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const receiptId = uuidOf(input.receiptId);
  const expectedVersion = versionOf(input.expectedVersion);
  const reason = textOrNull(input.reason, REASON_MAX);
  return completed(
    await run(params, {
      commandType: "inbound_receipt.cancel",
      permission: "document.create",
      input: { receiptId, expectedVersion, reason },
      plan: async (tx, _i, m) => emptyPlan([await receiptWarehouse(tx, m.tenantId, receiptId)]),
      apply: async (tx, _locked, ctx) => {
        const h = await lockFieldHeader(tx, ctx.tenantId, "inbound_receipts", receiptId);
        guardVersion(h.status, h.version, expectedVersion);
        // Kabul yazımı başlık kilidi altındadır: burada okunan toplam kararlıdır.
        const sum = await tx.execute<{ n: string }>(
          sql`SELECT COALESCE(sum(received_quantity), 0)::text AS n FROM public.inbound_receipt_lines
               WHERE tenant_id = ${ctx.tenantId}::uuid AND receipt_id = ${receiptId}::uuid`,
        );
        if (decimalToMicro(sum[0]?.n ?? "0") > 0n) throw documentState();
        const upd = await tx.execute<{ id: string }>(
          sql`UPDATE public.inbound_receipts SET status = 'CANCELLED' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${receiptId}::uuid RETURNING id`,
        );
        if (upd[0] === undefined) throw new AppError("INTERNAL");
        return {
          result: { documentId: receiptId, documentNumber: h.number, status: "CANCELLED" },
          audit: auditOf("inbound_receipt.cancelled", receiptId, input.requestId, { fromStatus: h.status, toStatus: "CANCELLED" }, reason),
        };
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// receiveGoods
// ---------------------------------------------------------------------------------------------------------------------
export interface ReceiveLineInput {
  readonly lineId: string;
  /** Fiziksel kabul (bu komutta gelen; hasarlı dahil), satır biriminde. */
  readonly received: string;
  /** Bunlardan hasarlı olan (≤ received). Yoksa 0. */
  readonly damaged?: string;
  /** RECEIVING türünde lokasyon. */
  readonly locationId: string;
}
export interface ReceiveGoodsInput {
  readonly receiptId: string;
  readonly lines: readonly ReceiveLineInput[];
  readonly requestId?: string | null;
}

type ReceiptLineRow = {
  id: string;
  item_id: string;
  unit_id: string;
  conversion_factor: string;
  expected_quantity: string;
  received_quantity: string;
  damaged_quantity: string;
}
const readReceiptLines = (tx: AccessTx, tenantId: string, receiptId: string): Promise<ReceiptLineRow[]> =>
  tx.execute<ReceiptLineRow>(
    sql`SELECT id, item_id, unit_id, conversion_factor::text AS conversion_factor, expected_quantity::text AS expected_quantity,
               received_quantity::text AS received_quantity, damaged_quantity::text AS damaged_quantity
          FROM public.inbound_receipt_lines WHERE tenant_id = ${tenantId}::uuid AND receipt_id = ${receiptId}::uuid ORDER BY line_no`,
  );

async function qcEnabled(tx: AccessTx, tenantId: string): Promise<boolean> {
  const rows = await tx.execute<{ on: boolean }>(
    sql`SELECT receiving_qc_enabled AS on FROM public.tenant_settings WHERE tenant_id = ${tenantId}::uuid`,
  );
  return rows[0]?.on ?? true; // A-06: satır yoksa varsayılan açık
}

/** RECEIVING türü dışı ya da bulunamayan lokasyon: bulunamayan `NOT_FOUND`, tür uyuşmazlığı `VALIDATION_FAILED` (kilit altında çağrılır). */
async function assertLocationKinds(tx: AccessTx, tenantId: string, ids: readonly string[], kind: "RECEIVING" | "STORAGE"): Promise<void> {
  const uniq = [...new Set(ids)];
  const rows = await tx.execute<{ id: string; kind: string }>(
    sql`SELECT id, kind FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(uniq)}::uuid[])`,
  );
  if (rows.length !== uniq.length) throw new AppError("NOT_FOUND");
  if (rows.some((r) => r.kind !== kind)) throw new AppError("VALIDATION_FAILED");
}

interface ParsedReceive {
  readonly lineId: string;
  readonly received: string;
  readonly damaged: string;
  readonly locationId: string;
}

function parseReceive(input: ReceiveGoodsInput): { receiptId: string; lines: ParsedReceive[] } {
  const receiptId = uuidOf(input.receiptId);
  const seen = new Set<string>();
  const lines = arrayOf(input.lines).map((raw) => {
    const x = objectOf(raw);
    const lineId = uuidOf(x.lineId);
    if (seen.has(lineId)) throw new AppError("VALIDATION_FAILED"); // A-305-6: komutta satır başına tek giriş
    seen.add(lineId);
    const received = positiveDecimal(x.received);
    const damaged = x.damaged === undefined ? "0" : nonNegativeDecimal(x.damaged);
    if (decimalToMicro(damaged) > decimalToMicro(received)) throw new AppError("VALIDATION_FAILED"); // hasarlı > kabul
    return { lineId, received, damaged, locationId: uuidOf(x.locationId) };
  });
  return { receiptId, lines };
}

/** Kabul satırlarından primitif `STOCK_IN` spesifikasyonu. Kural denetimleri (fazla kabul, lokasyon türü) çağıranındır. */
function receiveSpec(warehouseId: string, receiptId: string, qc: boolean, lines: readonly ParsedReceive[], rows: readonly ReceiptLineRow[]): FieldPostSpec {
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const out: FieldLine[] = [];
  for (const l of lines) {
    const row = byId.get(l.lineId);
    if (row === undefined) throw new AppError("NOT_FOUND"); // A-152: satır bu belgeye ait değil (varlık sızdırılmaz)
    const damaged = decimalToMicro(l.damaged);
    const good = decimalToMicro(l.received) - damaged;
    const base = (qty: bigint, status: "AVAILABLE" | "QUARANTINE" | "DAMAGED"): FieldLine => {
      const quantity = microToDecimal(qty);
      return {
        itemId: row.item_id,
        unitId: row.unit_id,
        quantity,
        conversionFactor: row.conversion_factor,
        baseQuantity: baseQuantityOf(quantity, row.conversion_factor),
        sourceLocationId: null,
        targetLocationId: l.locationId,
        stockStatus: status,
        targetStockStatus: null,
        sourceLineId: row.id,
      };
    };
    if (good > 0n) out.push(base(good, qc ? "QUARANTINE" : "AVAILABLE"));
    if (damaged > 0n) out.push(base(damaged, "DAMAGED")); // hasarlı hiçbir zaman kullanılabilir sayılmaz
  }
  return { kind: "STOCK_IN", warehouseId, sourceKind: "INBOUND_RECEIPT", sourceId: receiptId, lines: out };
}

/**
 * `stock.post`: fiziksel kabul. Belge `OPEN` olmalı (beklenen teslimsiz kabul yok; A-133). Fazla kabul (`kabul toplamı > beklenen`) `VALIDATION_FAILED` (A-305-3);
 * hasarlı > kabul ya da RECEIVING dışı hedef `VALIDATION_FAILED`. Kısmi kabul satırı açık bırakır; tüm satırlar tamamlanınca belge `CLOSED`.
 */
export async function receiveGoods(
  params: StockDocCallParams,
  input: ReceiveGoodsInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const { receiptId, lines } = parseReceive(input);
  const hashInput = { receiptId, lines };
  return completed(
    await run(params, {
      commandType: "inbound_receipt.receive",
      permission: "stock.post",
      input: hashInput,
      plan: async (tx, _i, m) => {
        const warehouseId = await receiptWarehouse(tx, m.tenantId, receiptId);
        try {
          const spec = receiveSpec(warehouseId, receiptId, await qcEnabled(tx, m.tenantId), lines, await readReceiptLines(tx, m.tenantId, receiptId));
          return await planFieldPosting(tx, m.tenantId, spec);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          return { warehouseIds: [warehouseId], locks: EMPTY_LOCK_PLAN }; // apply kilit altında asıl hatayı verir
        }
      },
      apply: async (tx, locked, ctx) => {
        const h = await lockFieldHeader(tx, ctx.tenantId, "inbound_receipts", receiptId); // stok kilitlerinden SONRA, satır yazımından ÖNCE
        if (h.status !== "OPEN") throw documentState();
        const rows = await readReceiptLines(tx, ctx.tenantId, receiptId);
        const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
        for (const l of lines) {
          const row = byId.get(l.lineId);
          if (row === undefined) throw new AppError("NOT_FOUND");
          if (decimalToMicro(row.received_quantity) + decimalToMicro(l.received) > decimalToMicro(row.expected_quantity)) {
            throw new AppError("VALIDATION_FAILED"); // A-133: fazla kabul reddedilir (A-305-3)
          }
        }
        await assertLocationKinds(tx, ctx.tenantId, lines.map((l) => l.locationId), "RECEIVING");
        const spec = receiveSpec(h.warehouseId, receiptId, await qcEnabled(tx, ctx.tenantId), lines, rows);
        const applied = await postFieldDocument(tx, locked, ctx, spec, input.requestId ?? null);

        // Kabul satırları (kaynak bağlantısı kilit altında: UPDATE 0 satır → hata, sessiz no-op yok).
        const json = JSON.stringify(lines.map((l) => ({ id: l.lineId, received: l.received, damaged: l.damaged })));
        const upd = await tx.execute<{ id: string }>(
          sql`UPDATE public.inbound_receipt_lines r
                 SET received_quantity = r.received_quantity + w.received, damaged_quantity = r.damaged_quantity + w.damaged
                FROM jsonb_to_recordset(${json}::jsonb) AS w(id uuid, received numeric, damaged numeric)
               WHERE r.tenant_id = ${ctx.tenantId}::uuid AND r.receipt_id = ${receiptId}::uuid AND r.id = w.id
              RETURNING r.id`,
        );
        if (upd.length !== lines.length) throw new AppError("INTERNAL");
        const open = await tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM public.inbound_receipt_lines
               WHERE tenant_id = ${ctx.tenantId}::uuid AND receipt_id = ${receiptId}::uuid AND received_quantity < expected_quantity`,
        );
        const allDone = Number(open[0]?.n ?? "1") === 0;
        if (allDone) {
          const closed = await tx.execute<{ id: string }>(
            sql`UPDATE public.inbound_receipts SET status = 'CLOSED' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${receiptId}::uuid AND status = 'OPEN' RETURNING id`,
          );
          if (closed[0] === undefined) throw new AppError("INTERNAL");
        }
        await appendAudit(tx, {
          ...auditOf("inbound_receipt.received", receiptId, input.requestId, {
            documentId: applied.result.documentId ?? null,
            lineCount: lines.length,
            qualityControl: spec.lines.some((l) => l.stockStatus === "QUARANTINE"),
            closed: allDone,
          }),
          actorUserId: ctx.userId,
        });
        return applied;
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// approveQuality
// ---------------------------------------------------------------------------------------------------------------------
export interface QualityReceiptLineInput {
  readonly lineId: string;
  /** Kabulün konulduğu RECEIVING lokasyonu (onay aynı lokasyonda durum değiştirir). */
  readonly locationId: string;
  readonly quantity: string;
}
export interface QualityDimensionInput {
  readonly itemId: string;
  readonly locationId: string;
  /** Temel birimde. */
  readonly quantity: string;
}
/** Ya `receiptId` (+ isteğe bağlı `lines`; yoksa belgenin bekleyen karantina miktarının TAMAMI) ya da `dimensions`. */
export type ApproveQualityInput =
  | { readonly receiptId: string; readonly lines?: readonly QualityReceiptLineInput[]; readonly dimensions?: undefined; readonly requestId?: string | null }
  | { readonly receiptId?: undefined; readonly lines?: undefined; readonly dimensions: readonly QualityDimensionInput[]; readonly requestId?: string | null };

type ParsedApproval =
  | { readonly mode: "RECEIPT"; readonly receiptId: string; readonly lines: readonly QualityReceiptLineInput[] | null }
  | { readonly mode: "DIMENSIONS"; readonly dimensions: readonly QualityDimensionInput[] };

function parseApproval(input: ApproveQualityInput): ParsedApproval {
  const hasReceipt = input.receiptId !== undefined;
  const hasDims = input.dimensions !== undefined;
  if (hasReceipt === hasDims) throw new AppError("VALIDATION_FAILED"); // tam olarak biri
  if (hasReceipt) {
    const receiptId = uuidOf(input.receiptId);
    if (input.lines === undefined) return { mode: "RECEIPT", receiptId, lines: null };
    const seen = new Set<string>();
    const lines = arrayOf(input.lines).map((raw) => {
      const x = objectOf(raw);
      const l = { lineId: uuidOf(x.lineId), locationId: uuidOf(x.locationId), quantity: positiveDecimal(x.quantity) };
      const k = `${l.lineId}|${l.locationId}`;
      if (seen.has(k)) throw new AppError("VALIDATION_FAILED");
      seen.add(k);
      return l;
    });
    return { mode: "RECEIPT", receiptId, lines };
  }
  const seen = new Set<string>();
  const dimensions = arrayOf(input.dimensions).map((raw) => {
    const x = objectOf(raw);
    const d = { itemId: uuidOf(x.itemId), locationId: uuidOf(x.locationId), quantity: positiveDecimal(x.quantity) };
    const k = `${d.itemId}|${d.locationId}`;
    if (seen.has(k)) throw new AppError("VALIDATION_FAILED");
    seen.add(k);
    return d;
  });
  return { mode: "DIMENSIONS", dimensions };
}

type PendingRow = {
  line_id: string;
  receipt_id: string;
  item_id: string;
  location_id: string;
  /** TEMEL birimde (I-09): kabul girişleri − onay çıkışları. */
  pending: string;
};
interface PendingFilter {
  readonly receiptId?: string;
  readonly itemId?: string;
  readonly locationId?: string;
}
/**
 * Bekleyen karantina (kabul satırı, lokasyon) kırılımında, TEMEL birimde, FIFO sıralı (kabul belgesi `created_at`, kimlik, satır no):
 * işlenmiş kabul girişleri (`QUARANTINE`) − işlenmiş onay çıkışları (`QUARANTINE → AVAILABLE`). Onay satırları kabul satırına `source_line_id` ile bağlıdır
 * (belge kaynağından bağımsız: `dimensions` onayı da bir kabul satırına atfedilir), böylece iki varyant AYNI sayaca yazar ve bekleyen miktar sapmaz.
 * Başlık kilidi altında kararlıdır (kabul ve her iki onay yolu ilgili başlıkları kilitler).
 */
async function pendingQuarantine(tx: AccessTx, tenantId: string, f: PendingFilter): Promise<PendingRow[]> {
  const receiptId = f.receiptId ?? null;
  const itemId = f.itemId ?? null;
  const locationId = f.locationId ?? null;
  return tx.execute<PendingRow>(
    sql`SELECT x.line_id, rl.receipt_id, rl.item_id, x.location_id, sum(x.q)::text AS pending FROM (
          SELECT dl.source_line_id AS line_id, dl.target_location_id AS location_id, dl.base_quantity AS q
            FROM public.document_lines dl JOIN public.documents d ON d.tenant_id = dl.tenant_id AND d.id = dl.document_id
           WHERE d.tenant_id = ${tenantId}::uuid AND d.source_kind = 'INBOUND_RECEIPT' AND d.status = 'POSTED' AND d.kind = 'STOCK_IN'
             AND dl.stock_status = 'QUARANTINE' AND dl.source_line_id IS NOT NULL
          UNION ALL
          SELECT dl.source_line_id, dl.source_location_id, -dl.base_quantity
            FROM public.document_lines dl JOIN public.documents d ON d.tenant_id = dl.tenant_id AND d.id = dl.document_id
           WHERE d.tenant_id = ${tenantId}::uuid AND d.status = 'POSTED' AND d.kind = 'STOCK_MOVE'
             AND dl.stock_status = 'QUARANTINE' AND dl.target_stock_status = 'AVAILABLE' AND dl.source_line_id IS NOT NULL
        ) x
        JOIN public.inbound_receipt_lines rl ON rl.tenant_id = ${tenantId}::uuid AND rl.id = x.line_id
        JOIN public.inbound_receipts r ON r.tenant_id = rl.tenant_id AND r.id = rl.receipt_id
       WHERE (${receiptId}::uuid IS NULL OR rl.receipt_id = ${receiptId}::uuid)
         AND (${itemId}::uuid IS NULL OR rl.item_id = ${itemId}::uuid)
         AND (${locationId}::uuid IS NULL OR x.location_id = ${locationId}::uuid)
       GROUP BY x.line_id, rl.receipt_id, rl.item_id, x.location_id, r.created_at, rl.line_no
      HAVING sum(x.q) > 0
       ORDER BY r.created_at, rl.receipt_id, rl.line_no, x.location_id`,
  );
}

interface ApprovalPlan {
  readonly warehouseId: string;
  readonly spec: FieldPostSpec;
  /** Onaylanan her satır için görev girdisi (yerleştirme). */
  readonly tasks: readonly NewTaskInput[];
  /** Kilitlenecek kabul başlıkları (kimliğe göre sıralı; yalnızca `dimensions` yolunda apply'da kilitlenir). */
  readonly receiptIds: readonly string[];
}

type ApprovalItem = {
  readonly base_unit_id: string;
  readonly id: string;
};
async function readApprovalItems(tx: AccessTx, tenantId: string, itemIds: readonly string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(itemIds)];
  const items = await tx.execute<ApprovalItem>(
    sql`SELECT id, base_unit_id FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(uniq)}::uuid[])`,
  );
  if (items.length !== uniq.length) throw new AppError("NOT_FOUND");
  return new Map(items.map((i) => [i.id.toLowerCase(), i.base_unit_id]));
}

/** Onay satırı: HER ZAMAN ürünün temel biriminde (katsayı 1) — bekleyen sayaç temel birimdedir; `sourceLineId` atıf içindir. */
function approvalLine(itemId: string, unitId: string, locationId: string, qtyMicro: bigint, sourceLineId: string | null): FieldLine {
  const quantity = microToDecimal(qtyMicro);
  return {
    itemId,
    unitId,
    quantity,
    conversionFactor: "1.000000",
    baseQuantity: quantity,
    sourceLocationId: locationId,
    targetLocationId: locationId,
    stockStatus: "QUARANTINE",
    targetStockStatus: "AVAILABLE",
    sourceLineId,
  };
}

/**
 * Onay spesifikasyonu. RECEIPT: belgenin kendi bekleyen karantinası (açık `lines` verilmişse o miktarlar; kabul birimi → temel birim, bekleyeni aşamaz).
 * DIMENSIONS: (ürün, lokasyon) miktarı, o boyutu bekleyen kabul satırlarına FIFO dağıtılır (en eski kabul önce); artan miktar (iade vb. kabul dışı karantina)
 * kaynaksız satır olur. Her atıf `source_line_id` ile işlenir → bekleyen sayaç iki yolda da tutarlı. `receiptWh`: RECEIPT yolunda kilitli/okunan depo.
 */
async function buildApproval(tx: AccessTx, tenantId: string, p: ParsedApproval, receiptWh: string | null): Promise<ApprovalPlan> {
  if (p.mode === "RECEIPT") {
    const warehouseId = receiptWh as string;
    const rows = await readReceiptLines(tx, tenantId, p.receiptId);
    const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
    const pending = await pendingQuarantine(tx, tenantId, { receiptId: p.receiptId });
    const pendingOf = new Map(pending.map((r) => [`${r.line_id.toLowerCase()}|${r.location_id.toLowerCase()}`, decimalToMicro(r.pending)]));
    const wanted =
      p.lines === null
        ? pending.map((r) => ({ lineId: r.line_id.toLowerCase(), locationId: r.location_id.toLowerCase(), base: decimalToMicro(r.pending) }))
        : p.lines.map((l) => {
            const row = byId.get(l.lineId);
            if (row === undefined) throw new AppError("NOT_FOUND"); // A-152: satır bu belgeye ait değil
            return { lineId: l.lineId, locationId: l.locationId, base: decimalToMicro(baseQuantityOf(l.quantity, row.conversion_factor)) };
          });
    if (wanted.length === 0) throw new AppError("VALIDATION_FAILED"); // onaylanacak karantina yok
    const units = await readApprovalItems(tx, tenantId, wanted.map((w) => (byId.get(w.lineId) as ReceiptLineRow).item_id.toLowerCase()));
    const lines: FieldLine[] = [];
    const tasks: NewTaskInput[] = [];
    for (const w of wanted) {
      const row = byId.get(w.lineId);
      if (row === undefined) throw new AppError("NOT_FOUND");
      const avail = pendingOf.get(`${w.lineId}|${w.locationId}`);
      if (avail === undefined || w.base <= 0n || w.base > avail) throw new AppError("VALIDATION_FAILED");
      lines.push(approvalLine(row.item_id, units.get(row.item_id.toLowerCase()) as string, w.locationId, w.base, row.id));
      tasks.push({
        warehouseId,
        kind: "PUTAWAY",
        sourceKind: "INBOUND_RECEIPT",
        sourceId: p.receiptId,
        sourceLineId: row.id,
        locationId: w.locationId,
        itemId: row.item_id,
        quantity: microToDecimal(w.base),
      });
    }
    return { warehouseId, spec: { kind: "STOCK_MOVE", warehouseId, sourceKind: "INBOUND_RECEIPT", sourceId: p.receiptId, lines }, tasks, receiptIds: [] };
  }
  // DIMENSIONS: depo lokasyonlardan; hepsi aynı depoda olmalı (çekirdek A-145 denetler).
  const locIds = [...new Set(p.dimensions.map((d) => d.locationId))];
  const locs = await tx.execute<{ id: string; warehouse_id: string }>(
    sql`SELECT id, warehouse_id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(locIds)}::uuid[])`,
  );
  if (locs.length !== locIds.length) throw new AppError("NOT_FOUND");
  const warehouseId = (locs[0] as { warehouse_id: string }).warehouse_id;
  const units = await readApprovalItems(tx, tenantId, p.dimensions.map((d) => d.itemId));
  const lines: FieldLine[] = [];
  const tasks: NewTaskInput[] = [];
  const receipts = new Set<string>();
  for (const d of p.dimensions) {
    const unitId = units.get(d.itemId) as string;
    let left = decimalToMicro(d.quantity);
    for (const r of await pendingQuarantine(tx, tenantId, { itemId: d.itemId, locationId: d.locationId })) {
      if (left === 0n) break;
      const have = decimalToMicro(r.pending);
      const take = have < left ? have : left;
      lines.push(approvalLine(d.itemId, unitId, d.locationId, take, r.line_id));
      tasks.push({
        warehouseId,
        kind: "PUTAWAY",
        sourceKind: "INBOUND_RECEIPT",
        sourceId: r.receipt_id,
        sourceLineId: r.line_id,
        locationId: d.locationId,
        itemId: d.itemId,
        quantity: microToDecimal(take),
      });
      receipts.add(r.receipt_id.toLowerCase());
      left -= take;
    }
    if (left > 0n) {
      // Kabul dışı karantina (kaynaksız): bekleyen sayaçlara yazılmaz; yeterlilik (QUARANTINE bakiyesi) motorda denetlenir.
      lines.push(approvalLine(d.itemId, unitId, d.locationId, left, null));
      tasks.push({ warehouseId, kind: "PUTAWAY", locationId: d.locationId, itemId: d.itemId, quantity: microToDecimal(left) });
    }
  }
  return { warehouseId, spec: { kind: "STOCK_MOVE", warehouseId, sourceKind: null, sourceId: null, lines }, tasks, receiptIds: [...receipts].sort() };
}

/**
 * `document.approve` (A-132): kalite onayı = `STOCK_MOVE`/`MOVE` `QUARANTINE → AVAILABLE`, aynı lokasyonda (`targetStockStatus: AVAILABLE`; T-258 beyaz listesi).
 * `DAMAGED` stoğa hiç dokunulmaz (DAMAGED → AVAILABLE hiçbir yolla yoktur). Onaylanan her miktar için aynı transaction'da `PUTAWAY` görevi (OPEN) açılır.
 * Kabul belgesi varyantında miktar belgenin bekleyen karantinasıyla sınırlıdır (fazlası `VALIDATION_FAILED`); aynı başlık kilidiyle serileştirilir.
 */
export async function approveQuality(
  params: StockDocCallParams,
  input: ApproveQualityInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const parsed = parseApproval(input);
  const hashInput = parsed.mode === "RECEIPT" ? { receiptId: parsed.receiptId, lines: parsed.lines } : { dimensions: parsed.dimensions };
  return completed(
    await run(params, {
      commandType: "inbound_receipt.approve_quality",
      permission: "document.approve",
      input: hashInput,
      plan: async (tx, _i, m) => {
        const receiptWh = parsed.mode === "RECEIPT" ? await receiptWarehouse(tx, m.tenantId, parsed.receiptId) : null;
        try {
          const b = await buildApproval(tx, m.tenantId, parsed, receiptWh);
          return await planFieldPosting(tx, m.tenantId, b.spec);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          return emptyPlan(receiptWh === null ? [] : [receiptWh]);
        }
      },
      apply: async (tx, locked, ctx) => {
        let receiptWh: string | null = null;
        if (parsed.mode === "RECEIPT") {
          receiptWh = (await lockFieldHeader(tx, ctx.tenantId, "inbound_receipts", parsed.receiptId)).warehouseId;
        } else {
          // `dimensions`: atıf yapılabilecek kabul başlıklarını (kimliğe göre sıralı, stok kilitlerinden SONRA) kilitle, SONRA yeniden hesapla.
          const first = await buildApproval(tx, ctx.tenantId, parsed, null);
          for (const id of first.receiptIds) await lockFieldHeader(tx, ctx.tenantId, "inbound_receipts", id);
        }
        const b = await buildApproval(tx, ctx.tenantId, parsed, receiptWh);
        const applied = await postFieldDocument(tx, locked, ctx, b.spec, input.requestId ?? null);
        await createTasks(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, b.tasks, input.requestId ?? null);
        return applied;
      },
    }),
  );
}
