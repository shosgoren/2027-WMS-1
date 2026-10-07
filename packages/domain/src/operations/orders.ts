// Müşteri siparişi, sipariş satırına rezervasyon (sert tahsis) ve iptal (T-306; ADR-009, ADR-021 §4, 16 Senaryo A adım 4-5 ve 9, Senaryo D adım 4-5).
//
// Komutlar (hepsi `executeStockCommand`: istemci anahtarı zorunlu, idempotency, zaman aşımı, yeniden deneme, audit):
//   - `createSalesOrder` / `updateDraftOrder` (`document.create`): sipariş OPEN doğar; stok etkisi YOK (kural 2). Satır miktarı temel birime çevrilerek
//     saklanır (A-151; birim katsayısı satır oluşurken uygulanır = katsayı kopyası).
//   - `reserveOrder` (`document.approve`): satır başına A-138 önerisi (veya `overrides`) → `allocateInTx` (reservations.ts) ile TEK transaction'da atomik
//     tahsis. Yetersiz stok RET DEĞİL: satır kısmi tahsisli/rezervesiz açık kalır; sonuçta satır başına tahsis edilen miktar döner. Defter satırı yok.
//   - `cancelOrderLine` / `cancelSalesOrder` (`document.approve`): rezervasyon serbest (fiziksel stok yerinde, kural 7); serbest kalan mal `STAGING`'teyse
//     `REPUTAWAY` görevi AYNI transaction'da oluşur (16 Senaryo A adım 9).
//
// Kilitler: stok kilitleri YALNIZCA `acquireStockLocks` ile (executeStockCommand; plan önceden ve tam bildirilir). Sipariş başlığı (`sales_orders`, stok
// kilit tablosu değildir) stok kilitlerinden SONRA `FOR UPDATE` ile kilitlenir ve satırlar ondan sonra yazılır (Supervisor notu 1: 0016
// `field_docs_lines_guard_closed` satır UPDATE'inde başlığı `FOR SHARE` okur; önce `FOR UPDATE` olmazsa kilit yükseltmesi 40P01 üretirdi). Tüm sipariş
// komutları aynı başlığı aynı sırayla kilitler → bir siparişin komutları seri çalışır; sıra sabit (stok → başlık) olduğundan döngü yoktur.
// Karar kilit sonrası yeniden okunan değerle verilir (T-253): plan anındaki okuma yalnızca kilit planı içindir.
//
// A-xx (rapor, docs/OPEN_QUESTIONS.md): A-306-1 "taslak" = OPEN sipariş, hiçbir satırında ACTIVE rezervasyon/sevk/iptal yok (DB'de DRAFT durumu yoktur,
// 0016); satır silinemez (DELETE yetkisi yok), satır "kaldırma" = miktarı 0'a çekme; A-306-2 sipariş numarası: isteğe bağlı müşteri numarası
// (tenant içinde tekil) ya da sistem üretimi `SIP-<YYYY>-<8 hane>` (sıralı numara 0016 sonrası `number_sequences` türü ister: kapsam dışı bulgu);
// A-306-3 `cancelOrderLine`/`cancelSalesOrder` izni `document.approve` (rezervasyon serbest bırakma A-221-2 ile aynı); A-306-4 açık miktar 0 olunca
// sipariş `CLOSED` (A-140); hiç sevk edilmeden tamamı iptal edilirse `CANCELLED`; A-306-5 takipli (lot/seri) ürün için otomatik öneri yok (elle tahsis);
// A-306-6 `cancelSalesOrder` yalnızca hiç sevk yapılmamış siparişte (aksi `DOCUMENT_STATE`; kalan satırlar `cancelOrderLine` ile iptal edilir);
// A-306-7 iptalde önce toplanmamış (STAGING dışı) pay serbest bırakılır, sevk alanındaki mal en sona kalır; A-306-8 hiç tahsis yapılamayan
// `reserveOrder` çağrısı audit yazmaz (durum değişimi yok; idempotency kaydı yine tutulur).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { StockDimensionKey } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";
import { pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import {
  EMPTY_LOCK_PLAN,
  SYNC_POST_MAX_LINES,
  assertItemsActive,
  executeStockCommand,
  type StockCommandOutcome,
  type StockCommandParams,
  type StockCommandPlan,
  type StockCommandResult,
  type StockDocCallParams,
} from "../stock/index.ts";
import { readAllocationBalances, readOrderReservedSums, readReservationPlanRows, uniqueKeys, type ReservationPlanRow } from "../stock/reservation-reads.ts";
import { allocateInTx, releaseSelected, type AllocationRequest } from "../stock/reservations.ts";
import { dimensionIdentity, fromMicro, toMicro } from "../stock/plan.ts";
import { baseQuantityOf, decimalToMicro, documentState, emptyPlan, microToDecimal, tenantToday, tooLarge, uuidOf, DECIMAL_RE } from "./field-posting.ts";
import { suggestAllocation, type AllocationCandidate } from "./allocation.ts";
import { createTasks, type NewTaskInput } from "./tasks.ts";

const CUSTOMER_REF_MAX = 100;
/** Sistem üretimi sipariş numarası çakışmasında aynı transaction'da en çok deneme (T-306 MAJOR-2). */
const GENERATED_NUMBER_ATTEMPTS = 5;
const ORDER_NUMBER_MAX = 40;
const REASON_MAX = 500;
const CONTROL_RE = /\p{C}/u;
const STATUSES = new Set(["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"]);

type CommandSpec<I> = Pick<StockCommandParams<I, StockCommandResult>, "commandType" | "permission" | "input" | "plan" | "apply">;
type Done = StockCommandResult & { readonly replayed: boolean };

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
function completed(o: StockCommandOutcome<StockCommandResult>): Done {
  if (o.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true }); // senkron komutlarda beklenmez
  return { ...o.result, replayed: o.replayed };
}

// --- girdi doğrulama ---------------------------------------------------------------------------------------------------------------
const invalid = (): AppError => new AppError("VALIDATION_FAILED");
function positiveDecimal(raw: unknown): string {
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw) || decimalToMicro(raw) <= 0n) throw invalid();
  return raw;
}
function nonNegativeDecimal(raw: unknown): string {
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw)) throw invalid();
  return raw;
}
function versionOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) throw invalid();
  return raw;
}
function textOrNull(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw invalid();
  const v = raw.trim();
  if (v === "" || Array.from(v).length > max || CONTROL_RE.test(v)) throw invalid();
  return v;
}
function arrayOf(raw: unknown, min = 1): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length < min) throw invalid();
  if (raw.length > SYNC_POST_MAX_LINES) throw tooLarge();
  return raw as unknown[];
}
function objectOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid();
  return raw as Record<string, unknown>;
}
const uuidOrNull = (raw: unknown): string | null => (raw === undefined || raw === null ? null : uuidOf(raw));

// --- okumalar ----------------------------------------------------------------------------------------------------------------------
interface OrderHeader {
  readonly id: string;
  readonly status: string;
  readonly version: number;
  readonly number: string;
}
/** Kilitsiz okuma (yalnızca plan/varlık denetimi). Yok / başka tenant → `NOT_FOUND`. */
async function readOrder(tx: AccessTx, tenantId: string, orderId: string): Promise<OrderHeader> {
  const rows = await tx.execute<{ id: string; status: string; version: number | string; number: string }>(
    sql`SELECT id, status, version, number FROM public.sales_orders WHERE tenant_id = ${tenantId}::uuid AND id = ${orderId}::uuid`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  return { id: r.id, status: r.status, version: Number(r.version), number: r.number };
}
/**
 * Sipariş başlığını `FOR UPDATE` ile kilitler (stok kilitlerinden SONRA, satır yazımından ÖNCE; bkz. dosya başı). `sales_orders` stok kilit tablosu
 * değildir; stok kilitleri `acquireStockLocks`'tadır. (T-305'in `lockFieldHeader`ı yalnızca kabul belgesi içindir; o dosyaya dokunulmaz.)
 */
async function lockOrder(tx: AccessTx, tenantId: string, orderId: string): Promise<OrderHeader> {
  const rows = await tx.execute<{ id: string; status: string; version: number | string; number: string }>(
    sql`SELECT id, status, version, number FROM public.sales_orders WHERE tenant_id = ${tenantId}::uuid AND id = ${orderId}::uuid FOR UPDATE`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  return { id: r.id, status: r.status, version: Number(r.version), number: r.number };
}

interface OrderLine {
  readonly id: string;
  readonly orderId: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly requested: bigint;
  readonly shipped: bigint;
  readonly cancelled: bigint;
  /** Σ ACTIVE rezervasyon (1e-6). */
  readonly active: bigint;
}
const openOf = (l: OrderLine): bigint => l.requested - l.shipped - l.cancelled;
/** Tahsis edilebilir miktar: açık − Σ ACTIVE (negatif olamaz). */
const unreservedOf = (l: OrderLine): bigint => {
  const r = openOf(l) - l.active;
  return r < 0n ? 0n : r;
};

/** Siparişin satırları (kilitsiz; karar çağıranın başlık kilidi altında yaptığı çağrıyla verilir) + ACTIVE rezervasyon toplamları. */
async function readLines(tx: AccessTx, tenantId: string, orderId: string): Promise<OrderLine[]> {
  const rows = await tx.execute<{
    id: string; order_id: string; line_no: number; item_id: string; requested: string; shipped: string; cancelled: string;
  }>(
    sql`SELECT id, order_id, line_no, item_id, requested_quantity::text AS requested, shipped_quantity::text AS shipped, cancelled_quantity::text AS cancelled
          FROM public.sales_order_lines WHERE tenant_id = ${tenantId}::uuid AND order_id = ${orderId}::uuid ORDER BY line_no`,
  );
  const sumOf = new Map([...(await readOrderReservedSums(tx, tenantId, orderId))].map(([k, v]) => [k, toMicro(v)]));
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    lineNo: Number(r.line_no),
    itemId: r.item_id,
    requested: toMicro(r.requested),
    shipped: toMicro(r.shipped),
    cancelled: toMicro(r.cancelled),
    active: sumOf.get(r.id.toLowerCase()) ?? 0n,
  }));
}

async function readLine(tx: AccessTx, tenantId: string, lineId: string): Promise<{ readonly orderId: string }> {
  const rows = await tx.execute<{ order_id: string }>(
    sql`SELECT order_id FROM public.sales_order_lines WHERE tenant_id = ${tenantId}::uuid AND id = ${lineId}::uuid`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  return { orderId: r.order_id };
}

function auditOf(action: "sales_order.created" | "sales_order.updated" | "sales_order.cancelled" | "sales_order.line_cancelled" | "reservation.created", entityType: string, entityId: string, requestId: string | null | undefined, changeSummary: Record<string, unknown>, reason?: string | null) {
  return { action, entityType, entityId, requestId: requestId ?? null, reason: reason ?? null, changeSummary };
}

/** Sonlanmış (CLOSED/CANCELLED) → `DOCUMENT_STATE`; sonra sürüm → `VERSION_CONFLICT` (A-184 sırası). */
function guardVersion(h: OrderHeader, expectedVersion: number): void {
  if (h.status !== "OPEN") throw documentState();
  if (h.version !== expectedVersion) throw new AppError("VERSION_CONFLICT");
}

// ---------------------------------------------------------------------------------------------------------------------
// createSalesOrder / updateDraftOrder
// ---------------------------------------------------------------------------------------------------------------------
export interface SalesOrderLineInput {
  readonly itemId: string;
  readonly unitId: string;
  /** İstenen miktar, `unitId` biriminde (pozitif ondalık dizgi); temel birime çevrilerek saklanır (A-151). */
  readonly quantity: string;
}
export interface CreateSalesOrderInput {
  /** İsteğe bağlı müşteri sipariş numarası (tenant içinde tekil); yoksa sistem üretir (A-306-2). */
  readonly number?: string | null;
  readonly customerRef?: string | null;
  readonly lines: readonly SalesOrderLineInput[];
  readonly requestId?: string | null;
}

function parseNewLines(raw: unknown): { itemId: string; unitId: string; quantity: string }[] {
  return arrayOf(raw).map((l) => {
    const x = objectOf(l);
    return { itemId: uuidOf(x.itemId), unitId: uuidOf(x.unitId), quantity: positiveDecimal(x.quantity) };
  });
}

/** Satırları temel birime çevirir (katsayı: temel birim 1, aksi `unit_conversions`); ölçeğe uymayan miktar `QUANTITY_SCALE`. */
async function resolveBaseQuantities(
  tx: AccessTx,
  tenantId: string,
  lines: readonly { itemId: string; unitId: string; quantity: string }[],
): Promise<{ itemId: string; base: string }[]> {
  const itemIds = [...new Set(lines.map((l) => l.itemId))].sort();
  await assertItemsActive(tx, tenantId, itemIds);
  const factors = await tx.execute<{ item_id: string; unit_id: string; factor: string }>(
    sql`SELECT i.id AS item_id, i.base_unit_id AS unit_id, '1.000000' AS factor FROM public.items i
         WHERE i.tenant_id = ${tenantId}::uuid AND i.id = ANY(${pgUuidArray(itemIds)}::uuid[])
        UNION ALL
        SELECT c.item_id, c.unit_id, c.to_base_factor::text FROM public.unit_conversions c
         WHERE c.tenant_id = ${tenantId}::uuid AND c.item_id = ANY(${pgUuidArray(itemIds)}::uuid[])`,
  );
  const factorOf = new Map(factors.map((f) => [`${f.item_id.toLowerCase()}|${f.unit_id.toLowerCase()}`, f.factor]));
  const scales = await tx.execute<{ id: string; quantity_scale: number }>(
    sql`SELECT id, quantity_scale FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(itemIds)}::uuid[])`,
  );
  const divisorOf = new Map(scales.map((s) => [s.id.toLowerCase(), 10n ** BigInt(6 - Number(s.quantity_scale))]));
  return lines.map((l) => {
    const f = factorOf.get(`${l.itemId}|${l.unitId}`);
    if (f === undefined) throw invalid(); // birimin bu ürün için dönüşümü yok
    const base = baseQuantityOf(l.quantity, f);
    const d = divisorOf.get(l.itemId) as bigint;
    if (decimalToMicro(base) <= 0n) throw invalid();
    if (decimalToMicro(base) % d !== 0n) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });
    return { itemId: l.itemId, base };
  });
}

async function insertLines(tx: AccessTx, tenantId: string, orderId: string, firstLineNo: number, lines: readonly { itemId: string; base: string }[]): Promise<void> {
  const json = JSON.stringify(lines.map((l, i) => ({ id: randomUUID(), line_no: firstLineNo + i, item_id: l.itemId, requested: l.base })));
  await tx.execute(
    sql`INSERT INTO public.sales_order_lines (tenant_id, id, order_id, line_no, item_id, requested_quantity)
        SELECT ${tenantId}::uuid, w.id, ${orderId}::uuid, w.line_no, w.item_id, w.requested
          FROM jsonb_to_recordset(${json}::jsonb) AS w(id uuid, line_no int, item_id uuid, requested numeric)
         ORDER BY w.line_no`,
  );
}

/** `document.create`: sipariş (OPEN). Sonuç: `documentId` = SİPARİŞ kimliği, `documentNumber` = sipariş numarası. */
export async function createSalesOrder(params: StockDocCallParams, input: CreateSalesOrderInput): Promise<Done> {
  const number = textOrNull(input.number, ORDER_NUMBER_MAX);
  const customerRef = textOrNull(input.customerRef, CUSTOMER_REF_MAX);
  const lines = parseNewLines(input.lines);
  const hashInput = { number, customerRef, lines };
  return completed(
    await run(params, {
      commandType: "sales_order.create",
      permission: "document.create",
      input: hashInput,
      plan: async () => emptyPlan([]),
      apply: async (tx, _locked, ctx) => {
        const resolved = await resolveBaseQuantities(tx, ctx.tenantId, lines);
        // Numara çakışması istisna DEĞİL: `ON CONFLICT DO NOTHING` (23505 transaction'ı bozmaz, istemci anahtarına kalıcı ret yazılmaz — T-306 MAJOR-2/MINOR-1).
        // Müşteri numarası çakışırsa `CODE_TAKEN`; sistem üretimi numara çakışırsa aynı transaction'da yeni numara (sınırlı: GENERATED_NUMBER_ATTEMPTS).
        const year = number === null ? (await tenantToday(tx, ctx.tenantId)).slice(0, 4) : "";
        const orderId = randomUUID();
        let orderNumber: string | null = null;
        for (let attempt = 0; attempt < (number === null ? GENERATED_NUMBER_ATTEMPTS : 1) && orderNumber === null; attempt++) {
          const candidate = number ?? `SIP-${year}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
          const ins = await tx.execute<{ id: string }>(
            sql`INSERT INTO public.sales_orders (tenant_id, id, number, customer_ref, created_by)
                VALUES (${ctx.tenantId}::uuid, ${orderId}::uuid, ${candidate}, ${customerRef}, ${ctx.userId}::uuid)
                ON CONFLICT ON CONSTRAINT sales_orders_tenant_number_key DO NOTHING
                RETURNING id`,
          );
          if (ins[0] !== undefined) orderNumber = candidate;
        }
        if (orderNumber === null) {
          if (number !== null) throw new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" });
          throw new AppError("INTERNAL"); // üretilen numara art arda çakıştı (olasılık ihmal edilebilir); kalıcı ret yazılmaz
        }
        await insertLines(tx, ctx.tenantId, orderId, 1, resolved);
        return {
          result: { documentId: orderId, documentNumber: orderNumber },
          audit: auditOf("sales_order.created", "sales_order", orderId, input.requestId, { number: orderNumber, lineCount: lines.length }),
        };
      },
    }),
  );
}

export interface UpdateDraftOrderInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  /** `undefined` = değişmez; `null` = temizle. */
  readonly customerRef?: string | null;
  /** Mevcut satırın istenen miktarı (TEMEL birimde; 0 = satır kaldırıldı — satır silinemez, A-306-1). */
  readonly changes?: readonly { readonly lineId: string; readonly quantity: string }[];
  readonly addLines?: readonly SalesOrderLineInput[];
  readonly requestId?: string | null;
}

/** `document.create`: yalnızca taslak (A-306-1: OPEN ve hiçbir satırda ACTIVE rezervasyon/sevk/iptal yok). Sürüm uyuşmazlığı `VERSION_CONFLICT`. */
export async function updateDraftOrder(params: StockDocCallParams, input: UpdateDraftOrderInput): Promise<Done> {
  const orderId = uuidOf(input.orderId);
  const expectedVersion = versionOf(input.expectedVersion);
  const customerRefGiven = input.customerRef !== undefined;
  const customerRef = textOrNull(input.customerRef, CUSTOMER_REF_MAX);
  const changes = input.changes === undefined ? [] : arrayOf(input.changes, 0).map((c) => {
    const x = objectOf(c);
    return { lineId: uuidOf(x.lineId), quantity: nonNegativeDecimal(x.quantity) };
  });
  if (new Set(changes.map((c) => c.lineId)).size !== changes.length) throw invalid();
  const addLines = input.addLines === undefined ? [] : parseNewLines(input.addLines);
  if (!customerRefGiven && changes.length === 0 && addLines.length === 0) throw invalid();
  const hashInput = { orderId, expectedVersion, customerRef: customerRefGiven ? customerRef : undefined, changes, addLines };
  return completed(
    await run(params, {
      commandType: "sales_order.update_draft",
      permission: "document.create",
      input: hashInput,
      plan: async (tx, _i, m) => {
        await readOrder(tx, m.tenantId, orderId);
        return emptyPlan([]);
      },
      apply: async (tx, _locked, ctx) => {
        const h = await lockOrder(tx, ctx.tenantId, orderId);
        guardVersion(h, expectedVersion);
        const lines = await readLines(tx, ctx.tenantId, orderId);
        if (lines.some((l) => l.active > 0n || l.shipped > 0n || l.cancelled > 0n)) throw documentState();
        if (lines.length + addLines.length > SYNC_POST_MAX_LINES) throw tooLarge();
        const byId = new Map(lines.map((l) => [l.id.toLowerCase(), l]));
        if (changes.some((c) => !byId.has(c.lineId))) throw new AppError("NOT_FOUND"); // kaynak bağlantısı kilit altında: satır bu siparişe ait olmalı
        if (changes.length > 0) {
          const itemIds = [...new Set(changes.map((c) => (byId.get(c.lineId) as OrderLine).itemId.toLowerCase()))].sort();
          const scales = await tx.execute<{ id: string; quantity_scale: number }>(
            sql`SELECT id, quantity_scale FROM public.items WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${pgUuidArray(itemIds)}::uuid[])`,
          );
          const divisorOf = new Map(scales.map((s) => [s.id.toLowerCase(), 10n ** BigInt(6 - Number(s.quantity_scale))]));
          for (const c of changes) {
            const d = divisorOf.get((byId.get(c.lineId) as OrderLine).itemId.toLowerCase()) as bigint;
            if (decimalToMicro(c.quantity) % d !== 0n) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });
          }
          const json = JSON.stringify(changes.map((c) => ({ id: c.lineId, quantity: c.quantity })));
          const upd = await tx.execute<{ id: string }>(
            sql`UPDATE public.sales_order_lines l SET requested_quantity = w.quantity
                  FROM jsonb_to_recordset(${json}::jsonb) AS w(id uuid, quantity numeric)
                 WHERE l.tenant_id = ${ctx.tenantId}::uuid AND l.order_id = ${orderId}::uuid AND l.id = w.id
                RETURNING l.id`,
          );
          if (upd.length !== changes.length) throw new AppError("INTERNAL"); // sessiz no-op yok
        }
        if (addLines.length > 0) {
          const resolved = await resolveBaseQuantities(tx, ctx.tenantId, addLines);
          const nextNo = lines.reduce((a, l) => Math.max(a, l.lineNo), 0) + 1;
          await insertLines(tx, ctx.tenantId, orderId, nextNo, resolved);
        }
        // Başlık UPDATE'i sürümü artırır (tetikleyici); müşteri referansı verilmediyse aynı değer yazılır.
        const upd = await tx.execute<{ id: string }>(
          customerRefGiven
            ? sql`UPDATE public.sales_orders SET customer_ref = ${customerRef} WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderId}::uuid RETURNING id`
            : sql`UPDATE public.sales_orders SET customer_ref = customer_ref WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderId}::uuid RETURNING id`,
        );
        if (upd[0] === undefined) throw new AppError("INTERNAL");
        return {
          result: { documentId: orderId, documentNumber: h.number },
          audit: auditOf("sales_order.updated", "sales_order", orderId, input.requestId, {
            changedLines: changes.length,
            addedLines: addLines.length,
            customerRefChanged: customerRefGiven,
          }),
        };
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// reserveOrder
// ---------------------------------------------------------------------------------------------------------------------
export interface OrderAllocationOverride {
  readonly lineId: string;
  readonly allocations: readonly {
    readonly dimension: {
      readonly locationId: string;
      readonly lotId?: string | null;
      readonly serialId?: string | null;
      readonly stockStatus?: StockDimensionKey["stockStatus"];
      readonly inventoryOwnerId?: string | null;
      readonly handlingUnitId?: string | null;
    };
    /** Pozitif ondalık dizgi (temel birim). */
    readonly quantity: string;
  }[];
}
export interface ReserveOrderInput {
  readonly orderId: string;
  /** Elle tahsis (A-138 önerisini değiştirme); öneri yerine geçer, `document.approve` zaten komut iznidir. */
  readonly overrides?: readonly OrderAllocationOverride[];
  readonly requestId?: string | null;
}

type PlannedLine = { readonly lineId: string; readonly itemId: string; readonly allocations: { key: StockDimensionKey; qty: bigint }[]; readonly clamp: boolean };

function parseOverrides(raw: unknown): { lineId: string; allocations: { locationId: string; lotId: string | null; serialId: string | null; stockStatus: StockDimensionKey["stockStatus"]; inventoryOwnerId: string | null; handlingUnitId: string | null; quantity: string }[] }[] {
  if (raw === undefined) return [];
  const list = arrayOf(raw, 0).map((o) => {
    const x = objectOf(o);
    const allocations = arrayOf(x.allocations).map((a) => {
      const ax = objectOf(a);
      const d = objectOf(ax.dimension);
      const status = d.stockStatus === undefined ? "AVAILABLE" : d.stockStatus;
      if (typeof status !== "string" || !STATUSES.has(status)) throw invalid();
      return {
        locationId: uuidOf(d.locationId),
        lotId: uuidOrNull(d.lotId),
        serialId: uuidOrNull(d.serialId),
        stockStatus: status as StockDimensionKey["stockStatus"],
        inventoryOwnerId: uuidOrNull(d.inventoryOwnerId),
        handlingUnitId: uuidOrNull(d.handlingUnitId),
        quantity: positiveDecimal(ax.quantity),
      };
    });
    return { lineId: uuidOf(x.lineId), allocations };
  });
  if (new Set(list.map((o) => o.lineId)).size !== list.length) throw invalid();
  return list;
}

/** Ürünler için A-138 adayları (kilitsiz okuma; kural 5 süzgeci `isAllocationCandidate`'te ve kilit altında `allocateInTx`'te yeniden uygulanır). */
async function readCandidates(tx: AccessTx, tenantId: string, itemIds: readonly string[], scope: readonly string[] | null): Promise<Map<string, AllocationCandidate[]>> {
  const out = new Map<string, AllocationCandidate[]>();
  for (const r of await readAllocationBalances(tx, tenantId, itemIds, scope)) {
    const list = out.get(r.key.itemId) ?? [];
    list.push({ key: r.key, locationCode: r.locationCode, locationKind: r.locationKind, pickBlocked: r.pickBlocked, counting: r.counting, available: toMicro(r.available) });
    out.set(r.key.itemId, list);
  }
  return out;
}

async function locationWarehouses(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ warehouse_id: string }>(
    sql`SELECT DISTINCT warehouse_id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
  );
  return rows.map((r) => r.warehouse_id);
}

/**
 * `document.approve`: siparişin tahsis edilmemiş açık miktarını belirli stok boyutlarına bağlar (sert tahsis). Sonuç `reservationIds` (yeni satırlar) +
 * `lines[{lineId, lineNo, quantity}]` (BU çağrıda tahsis edilen toplam; 0 = tahsissiz). Yetersiz stok ret değildir (öneri yolu); elle zorlanan
 * (`overrides`) kural 5'e uymayan/yetmeyen boyut `INSUFFICIENT_STOCK`. Sipariş OPEN olmalı (aksi `DOCUMENT_STATE`).
 */
export async function reserveOrder(params: StockDocCallParams, input: ReserveOrderInput): Promise<Done> {
  const orderId = uuidOf(input.orderId);
  const overrides = parseOverrides(input.overrides);
  const hashInput = { orderId, overrides };
  let planned: readonly PlannedLine[] = [];
  return completed(
    await run(params, {
      commandType: "sales_order.reserve",
      permission: "document.approve",
      input: hashInput,
      plan: async (tx, _i, m): Promise<StockCommandPlan> => {
        await readOrder(tx, m.tenantId, orderId);
        const lines = await readLines(tx, m.tenantId, orderId);
        const known = new Set(lines.map((l) => l.id.toLowerCase()));
        if (overrides.some((o) => !known.has(o.lineId))) throw invalid();
        // Depo kapsamı (T-306 MAJOR-1): kapsam dışı depodaki stok ÖNERİLMEZ ve varlığı sızdırılmaz (resolveWarehouseScope ile aynı anlam; `null` = kısıtsız).
        const scope = await resolveWarehouseScope(tx, m);
        const candidates = await readCandidates(tx, m.tenantId, [...new Set(lines.map((l) => l.itemId.toLowerCase()))], scope);
        const overrideOf = new Map(overrides.map((o) => [o.lineId, o]));
        const out: PlannedLine[] = [];
        for (const l of lines) {
          const itemId = l.itemId.toLowerCase();
          const ov = overrideOf.get(l.id.toLowerCase());
          const need = unreservedOf(l);
          if (ov !== undefined) {
            out.push({
              lineId: l.id,
              itemId,
              clamp: false,
              allocations: ov.allocations.map((a) => ({
                key: { itemId, locationId: a.locationId, lotId: a.lotId, serialId: a.serialId, stockStatus: a.stockStatus, inventoryOwnerId: a.inventoryOwnerId, handlingUnitId: a.handlingUnitId },
                qty: decimalToMicro(a.quantity),
              })),
            });
          } else if (need > 0n) {
            const pool = candidates.get(itemId) ?? [];
            out.push({ lineId: l.id, itemId, clamp: true, allocations: suggestAllocation(pool, need) });
          } else {
            out.push({ lineId: l.id, itemId, clamp: true, allocations: [] });
          }
          // Aynı ürünün sonraki satırı aynı boş miktarı ikinci kez önermesin: bu satırın önerisi/elle tahsisi adaylardan düşülür.
          const last = out[out.length - 1] as PlannedLine;
          const pool = candidates.get(itemId) ?? [];
          for (const a of last.allocations) {
            const c = pool.find((x) => dimensionIdentity(x.key) === dimensionIdentity(a.key));
            if (c !== undefined) pool[pool.indexOf(c)] = { ...c, available: c.available - a.qty };
          }
        }
        planned = out;
        const keys = uniqueKeys(out.flatMap((p) => p.allocations.map((a) => a.key)));
        const locationIds = [...new Set(keys.map((k) => k.locationId))].sort();
        const warehouseIds = await locationWarehouses(tx, m.tenantId, locationIds);
        return { warehouseIds, locks: { ...EMPTY_LOCK_PLAN, locationIds, dimensions: keys } };
      },
      apply: async (tx, locked, ctx) => {
        const h = await lockOrder(tx, ctx.tenantId, orderId);
        if (h.status !== "OPEN") throw documentState();
        // Kilitten SONRA yeniden oku (T-253): kapasite = açık − Σ ACTIVE, başlık kilidi altındaki değerle.
        const lines = await readLines(tx, ctx.tenantId, orderId);
        const byId = new Map(lines.map((l) => [l.id.toLowerCase(), l]));
        const requests: (AllocationRequest & { readonly lineId: string })[] = [];
        for (const p of planned) {
          const l = byId.get(p.lineId.toLowerCase());
          if (l === undefined) throw new AppError("VERSION_CONFLICT", { retryable: true }); // plandan sonra satır kümesi değişti
          if (p.allocations.length === 0) continue;
          requests.push({ lineId: l.id, source: { kind: "ORDER_LINE", lineId: l.id.toLowerCase() }, itemId: p.itemId, allocations: p.allocations, capacity: unreservedOf(l), clamp: p.clamp });
        }
        const out = await allocateInTx(tx, locked, ctx.tenantId, requests, { warehouseId: null, expiresAt: null });
        const allocatedOf = new Map(requests.map((r, i) => [r.lineId.toLowerCase(), out.allocated[i] as bigint]));
        const total = out.allocated.reduce((a, x) => a + x, 0n);
        return {
          result: {
            documentId: orderId,
            reservationIds: out.reservationIds,
            lines: planned.map((p) => {
              const l = byId.get(p.lineId.toLowerCase()) as OrderLine;
              return { lineId: l.id, lineNo: l.lineNo, quantity: fromMicro(allocatedOf.get(l.id.toLowerCase()) ?? 0n) };
            }),
          },
          audit:
            out.reservationIds.length === 0
              ? null
              : auditOf("reservation.created", "sales_order", orderId, input.requestId, {
                  allocationCount: out.reservationIds.length,
                  quantity: fromMicro(total),
                  overridden: overrides.length > 0,
                }),
        };
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// cancelOrderLine / cancelSalesOrder
// ---------------------------------------------------------------------------------------------------------------------
/** Serbest kalan mal STAGING'teyse (kural 7) lokasyon başına tek `REPUTAWAY` görevi (ADR-021 §6: kaynak = sipariş, sipariş satırı). */
function reputawayTasks(orderId: string, lineId: string, parts: readonly { readonly row: ReservationPlanRow; readonly take: bigint }[]): NewTaskInput[] {
  const byLoc = new Map<string, { row: ReservationPlanRow; qty: bigint }>();
  for (const p of parts) {
    if (p.row.locationKind !== "STAGING") continue;
    const k = `${p.row.key.locationId}|${p.row.key.itemId}`;
    const cur = byLoc.get(k);
    byLoc.set(k, { row: p.row, qty: (cur?.qty ?? 0n) + p.take });
  }
  return [...byLoc.values()].map((v) => ({
    warehouseId: v.row.warehouseId,
    kind: "REPUTAWAY" as const,
    sourceKind: "SALES_ORDER" as const,
    sourceId: orderId,
    sourceLineId: lineId,
    locationId: v.row.key.locationId,
    itemId: v.row.key.itemId,
    quantity: microToDecimal(v.qty),
  }));
}

/** Kilit planı: satırların ACTIVE rezervasyonları + boyutları (kilitsiz okuma; kümeyi başlık kilidi sabitler, kilit sonrası yeniden okunur). */
async function cancellationPlan(tx: AccessTx, tenantId: string, lineIds: readonly string[]): Promise<StockCommandPlan> {
  const rows: ReservationPlanRow[] = [];
  for (const id of lineIds) rows.push(...(await readReservationPlanRows(tx, tenantId, { orderLineId: id })));
  return {
    warehouseIds: [...new Set(rows.map((r) => r.warehouseId))],
    locks: {
      ...EMPTY_LOCK_PLAN,
      dimensions: uniqueKeys(rows.map((r) => r.key)),
      reservationIds: rows.map((r) => r.id).sort(),
    },
  };
}

export interface CancelOrderLineInput {
  readonly lineId: string;
  /** Temel birimde pozitif ondalık dizgi; açık miktardan büyük olamaz. */
  readonly quantity: string;
  readonly reason?: string | null;
  readonly requestId?: string | null;
}

/**
 * `document.approve`: kalan satır iptali (A-140: kısmi iptal). `cancelled` artar; tahsisli miktar artık açık miktarı aşıyorsa AŞAN kısım serbest bırakılır
 * (fiziksel stok yerinde); mal `STAGING`'teyse `REPUTAWAY` görevi oluşur (Senaryo A adım 9). Açık miktar 0'a inince sipariş kapanır (A-306-4).
 */
export async function cancelOrderLine(params: StockDocCallParams, input: CancelOrderLineInput): Promise<Done> {
  const lineId = uuidOf(input.lineId);
  const quantity = positiveDecimal(input.quantity);
  const reason = textOrNull(input.reason, REASON_MAX);
  const qty = decimalToMicro(quantity);
  return completed(
    await run(params, {
      commandType: "sales_order.cancel_line",
      permission: "document.approve",
      input: { lineId, quantity, reason },
      plan: async (tx, _i, m) => {
        await readLine(tx, m.tenantId, lineId);
        return cancellationPlan(tx, m.tenantId, [lineId]);
      },
      apply: async (tx, locked, ctx) => {
        const { orderId } = await readLine(tx, ctx.tenantId, lineId);
        const h = await lockOrder(tx, ctx.tenantId, orderId);
        if (h.status !== "OPEN") throw documentState();
        const lines = await readLines(tx, ctx.tenantId, orderId);
        const line = lines.find((l) => l.id.toLowerCase() === lineId);
        if (line === undefined) throw new AppError("NOT_FOUND");
        const open = openOf(line);
        if (qty > open) throw invalid();
        const itemScale = await tx.execute<{ quantity_scale: number }>(
          sql`SELECT quantity_scale FROM public.items WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${line.itemId}::uuid`,
        );
        if (qty % 10n ** BigInt(6 - Number(itemScale[0]?.quantity_scale ?? 0)) !== 0n) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });

        // Tahsis, kalan açık miktarı (open − qty) aşıyorsa aşan kısım serbest kalır.
        const rows = await readReservationPlanRows(tx, ctx.tenantId, { orderLineId: lineId });
        const active = rows.reduce((a, r) => a + toMicro(lockedQuantity(locked, r.id)), 0n);
        const excess = active - (open - qty);
        let closedIds: string[] = [];
        let tasks: readonly string[] = [];
        let released = 0n;
        if (excess > 0n) {
          const rel = await releaseSelected(tx, ctx.tenantId, locked, rows, excess, { stagedLast: true });
          closedIds = rel.closedIds;
          released = rel.amount;
          tasks = await createTasks(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, reputawayTasks(orderId, lineId, rel.parts), input.requestId ?? null);
        }
        const upd = await tx.execute<{ id: string }>(
          sql`UPDATE public.sales_order_lines SET cancelled_quantity = cancelled_quantity + ${fromMicro(qty)}::numeric
               WHERE tenant_id = ${ctx.tenantId}::uuid AND order_id = ${orderId}::uuid AND id = ${lineId}::uuid RETURNING id`,
        );
        if (upd[0] === undefined) throw new AppError("INTERNAL"); // sessiz no-op yok
        const after = lines.map((l) => (l.id.toLowerCase() === lineId ? { ...l, cancelled: l.cancelled + qty } : l));
        if (after.every((l) => openOf(l) === 0n)) {
          const status = after.some((l) => l.shipped > 0n) ? "CLOSED" : "CANCELLED";
          const done = await tx.execute<{ id: string }>(
            sql`UPDATE public.sales_orders SET status = ${status} WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderId}::uuid RETURNING id`,
          );
          if (done[0] === undefined) throw new AppError("INTERNAL");
        }
        return {
          result: { documentId: orderId, reservationIds: closedIds, lines: [{ lineId, lineNo: line.lineNo, quantity: fromMicro(qty) }] },
          audit: auditOf("sales_order.line_cancelled", "sales_order_line", lineId, input.requestId, {
            orderId,
            quantity: fromMicro(qty),
            releasedQuantity: fromMicro(released),
            reputawayTasks: tasks.length,
          }, reason),
        };
      },
    }),
  );
}

/** Kilitli görüntüdeki rezervasyon miktarı (kilitli satır yoksa plan bayat: `VERSION_CONFLICT`). */
function lockedQuantity(locked: { readonly reservations: readonly { readonly id: string; readonly quantity: string }[] }, id: string): string {
  const r = locked.reservations.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (r === undefined) throw new AppError("VERSION_CONFLICT", { retryable: true });
  return r.quantity;
}

export interface CancelSalesOrderInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly reason?: string | null;
  readonly requestId?: string | null;
}

/**
 * `document.approve`: siparişin tamamı iptal (`OPEN → CANCELLED`); yalnızca hiç sevk yapılmamışsa (A-306-6). Tüm tahsisler serbest kalır; STAGING'teki mal için
 * `REPUTAWAY` görevi oluşur; her satırın `cancelled` değeri istenene tamamlanır.
 */
export async function cancelSalesOrder(params: StockDocCallParams, input: CancelSalesOrderInput): Promise<Done> {
  const orderId = uuidOf(input.orderId);
  const expectedVersion = versionOf(input.expectedVersion);
  const reason = textOrNull(input.reason, REASON_MAX);
  return completed(
    await run(params, {
      commandType: "sales_order.cancel",
      permission: "document.approve",
      input: { orderId, expectedVersion, reason },
      plan: async (tx, _i, m) => {
        await readOrder(tx, m.tenantId, orderId);
        const lines = await readLines(tx, m.tenantId, orderId);
        return cancellationPlan(tx, m.tenantId, lines.map((l) => l.id));
      },
      apply: async (tx, locked, ctx) => {
        const h = await lockOrder(tx, ctx.tenantId, orderId);
        guardVersion(h, expectedVersion);
        const lines = await readLines(tx, ctx.tenantId, orderId);
        if (lines.some((l) => l.shipped > 0n)) throw documentState();
        const closedIds: string[] = [];
        let tasks = 0;
        for (const l of lines) {
          const rows = await readReservationPlanRows(tx, ctx.tenantId, { orderLineId: l.id });
          if (rows.length === 0) continue;
          const rel = await releaseSelected(tx, ctx.tenantId, locked, rows, null, { stagedLast: true });
          closedIds.push(...rel.closedIds);
          const created = await createTasks(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, reputawayTasks(orderId, l.id, rel.parts), input.requestId ?? null);
          tasks += created.length;
        }
        const upd = await tx.execute<{ id: string }>(
          sql`UPDATE public.sales_order_lines SET cancelled_quantity = requested_quantity - shipped_quantity
               WHERE tenant_id = ${ctx.tenantId}::uuid AND order_id = ${orderId}::uuid RETURNING id`,
        );
        if (upd.length !== lines.length) throw new AppError("INTERNAL");
        const done = await tx.execute<{ id: string }>(
          sql`UPDATE public.sales_orders SET status = 'CANCELLED' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderId}::uuid RETURNING id`,
        );
        if (done[0] === undefined) throw new AppError("INTERNAL");
        return {
          result: { documentId: orderId, documentNumber: h.number, status: "CANCELLED", reservationIds: closedIds },
          audit: auditOf("sales_order.cancelled", "sales_order", orderId, input.requestId, { releasedReservations: closedIds.length, reputawayTasks: tasks }, reason),
        };
      },
    }),
  );
}
