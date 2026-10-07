// Saha komutlarının ortak bileşik yardımcısı (T-305; ADR-021 §2-3, 05 §İşlem sözleşmesi, I-15, G-01).
//
// Saha komutu (kabul, kalite onayı, yerleştirme…) TEK `executeStockCommand` transaction'ında, saha komutunun tek istemci anahtarıyla:
//   primitif belgeyi oluştur (`source_kind`/`source_id`/`source_line_id` dolu) → onayla → işle (`postApprovedDocumentInTx`).
// Primitif belge ayrı anahtarla tekrar işlenemez: belge bu transaction'da doğar ve aynı transaction'da `POSTED` olur.
//
// - Kilitler YALNIZCA `acquireStockLocks` ile (executeStockCommand), plan önceden tam bildirilir: `planFieldPosting` satırlardan boyut/lokasyon planını
//   çıkarır (belge henüz yok → plan'da `document` yok; belgeyi başka transaction göremez). Plan kilitli görüntüyü kapsamıyorsa çekirdek `VERSION_CONFLICT`.
// - Defter/bakiye yazımı yalnızca stok paketinin posting çekirdeğindedir; bu dosya stok tablolarına dokunmaz (lint: wms/stock-sql-guard).
// - Saha başlığı kilidi (T-301 incelemesi, Supervisor notu 1): satır yazan her saha komutu önce başlığı `FOR UPDATE` ile kilitler (`lockFieldHeader`);
//   0016 `field_docs_lines_guard_closed` satır UPDATE'inde başlığı `FOR SHARE` okur, kilit yükseltmesi 40P01 üretirdi. Sıra: stok kilitleri → saha başlığı.
// - Satır sayısı ≤ 200 senkron (A-142/A-07); üstü `VALIDATION_FAILED`/`DOCUMENT_TOO_LARGE` (T-222 async yolu bu kartta kullanılmaz).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { LockedState } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";
import { toBase } from "../catalog/quantity.ts";
import { pgUuidArray } from "../warehouse/scope.ts";
import {
  EMPTY_LOCK_PLAN,
  SYNC_POST_MAX_LINES,
  buildPostingPlan,
  postApprovedDocumentInTx,
  registerTxCreatedDocument,
  type PostingKind,
  type PostingLine,
  type PostingStatus,
  type StockCommandApplied,
  type StockCommandContext,
  type StockCommandPlan,
} from "../stock/index.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Kabul edilen ondalık biçim (numeric(20,6); float yok — I-09). */
export const DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;

export const uuidOf = (raw: unknown): string => {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
};
export const documentState = (): AppError => new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" });
export const tooLarge = (): AppError => new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_TOO_LARGE" });

// --- ondalık (I-09): 1e-6 ölçekli tam sayı ---------------------------------------------------------------------------------
const MICRO = 1_000_000n;
export function decimalToMicro(text: unknown): bigint {
  if (typeof text !== "string" || !DECIMAL_RE.test(text)) throw new AppError("VALIDATION_FAILED");
  const [whole = "0", frac = ""] = text.split(".");
  return BigInt(whole) * MICRO + BigInt((frac + "000000").slice(0, 6));
}
export function microToDecimal(n: bigint): string {
  if (n < 0n) throw new AppError("INTERNAL");
  return `${(n / MICRO).toString()}.${(n % MICRO).toString().padStart(6, "0")}`;
}
/**
 * `quantity × factor` → temel birim miktarı, 6 basamaklı dizgi. TEK yol `catalog/quantity.ts` `toBase`'dir (T-287; K-3): sonuç 6 ondalığa
 * inmiyorsa YUVARLANMAZ, `VALIDATION_FAILED`/`QUANTITY_SCALE` ile reddedilir (eskiden 6. basamağa yarım yukarı yuvarlanırdı). Ürün ölçeği
 * denetimi (`quantity_scale`) çağıranda/posting çekirdeğinde ayrıca uygulanır.
 */
export function baseQuantityOf(quantity: string, factor: string): string {
  return microToDecimal(decimalToMicro(toBase(quantity, factor, 6)));
}

// --- belge spesifikasyonu --------------------------------------------------------------------------------------------------
export interface FieldLine {
  readonly itemId: string;
  readonly unitId: string;
  /** Satır biriminde miktar. */
  readonly quantity: string;
  readonly conversionFactor: string;
  readonly baseQuantity: string;
  readonly sourceLocationId: string | null;
  readonly targetLocationId: string | null;
  readonly stockStatus: PostingStatus;
  /** Yalnız `STOCK_MOVE` (durum değişimi); `null` = kaynakla aynı. */
  readonly targetStockStatus: PostingStatus | null;
  /** Saha belgesi satırı (kabul satırı…) — A-152 kaynak bağlantısı. */
  readonly sourceLineId: string | null;
}

export type FieldSourceKind = "INBOUND_RECEIPT" | "TASK" | "COUNT_SESSION";

export interface FieldPostSpec {
  /** `COUNT_ADJUSTMENT` (T-309): satır başına tek uç (`−` kaynak, `+` hedef); plan `countSessionId` taşımalıdır (çağıran komutun planı). */
  readonly kind: Extract<PostingKind, "STOCK_IN" | "STOCK_MOVE" | "COUNT_ADJUSTMENT">;
  readonly warehouseId: string;
  readonly sourceKind: FieldSourceKind | null;
  readonly sourceId: string | null;
  readonly lines: readonly FieldLine[];
}

function postingLines(spec: FieldPostSpec, ids: readonly string[]): PostingLine[] {
  return spec.lines.map((l, i) => ({
    lineId: ids[i] as string,
    lineNo: i + 1,
    itemId: l.itemId,
    quantity: l.quantity,
    conversionFactor: l.conversionFactor,
    baseQuantity: l.baseQuantity,
    sourceLocationId: l.sourceLocationId,
    targetLocationId: l.targetLocationId,
    lotId: null,
    serialId: null,
    sourceStatus: l.stockStatus,
    targetStatus: l.targetStockStatus ?? l.stockStatus,
    inventoryOwnerId: null,
    handlingUnitId: null,
  }));
}

function assertSize(spec: FieldPostSpec): void {
  if (spec.lines.length < 1) throw new AppError("VALIDATION_FAILED");
  if (spec.lines.length > SYNC_POST_MAX_LINES) throw tooLarge();
}

/**
 * Kilit planı (salt okuma; iş kuralı DENETLEMEZ): satırlardan boyutlar + lokasyonlar. Lokasyonların depoları kapsam denetimine girer
 * (A-145 eşitliği çekirdekte kilit altında denetlenir). Biçim hatası `VALIDATION_FAILED` (çağıran plan'da yakalayıp boş plana düşebilir).
 */
export async function planFieldPosting(tx: AccessTx, tenantId: string, spec: FieldPostSpec): Promise<StockCommandPlan> {
  assertSize(spec);
  const built = buildPostingPlan(spec.kind, postingLines(spec, spec.lines.map(() => randomUUID())));
  const rows =
    built.locationIds.length === 0
      ? []
      : await tx.execute<{ warehouse_id: string }>(
          sql`SELECT DISTINCT warehouse_id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(built.locationIds)}::uuid[])`,
        );
  return {
    warehouseIds: [...new Set([spec.warehouseId, ...rows.map((r) => r.warehouse_id)])],
    locks: { ...EMPTY_LOCK_PLAN, locationIds: built.locationIds, dimensions: built.dimensions, serialIds: built.serialIds },
  };
}

/** Yalnızca depo kimliği (plan'da spesifikasyon kurulamadığında: kilitsiz plan; apply asıl hatayı verir). */
export const emptyPlan = (warehouseIds: readonly string[]): StockCommandPlan => ({ warehouseIds, locks: EMPTY_LOCK_PLAN });

/** A-71: tenant saat diliminde bugün (YYYY-MM-DD). */
export async function tenantToday(tx: AccessTx, tenantId: string): Promise<string> {
  const rows = await tx.execute<{ today: string }>(
    sql`SELECT (now() AT TIME ZONE COALESCE((SELECT time_zone FROM public.tenant_settings WHERE tenant_id = ${tenantId}::uuid), 'UTC'))::date::text AS today`,
  );
  const today = rows[0]?.today;
  if (today === undefined) throw new AppError("INTERNAL");
  return today;
}

type HeaderTable = "inbound_receipts";
export interface FieldHeader {
  readonly id: string;
  readonly warehouseId: string;
  readonly status: string;
  readonly version: number;
  readonly number: string;
}

/**
 * Saha başlığını `FOR UPDATE` ile kilitler (satır yazımından ÖNCE; bkz. dosya başı). Yok / başka tenant → `NOT_FOUND`.
 * Not: yalnızca saha başlık tablosudur (stok kilit tablosu değil); stok kilitleri `acquireStockLocks`'tadır.
 */
export async function lockFieldHeader(tx: AccessTx, tenantId: string, table: HeaderTable, id: string): Promise<FieldHeader> {
  const rows = await tx.execute<{ id: string; warehouse_id: string; status: string; version: number; number: string }>(
    sql`SELECT id, warehouse_id, status, version, number FROM public.inbound_receipts
         WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  return { id: r.id, warehouseId: r.warehouse_id, status: r.status, version: Number(r.version), number: r.number };
}

async function assertWarehouseActive(tx: AccessTx, tenantId: string, warehouseId: string): Promise<void> {
  const rows = await tx.execute<{ status: string }>(
    sql`SELECT status FROM public.warehouses WHERE tenant_id = ${tenantId}::uuid AND id = ${warehouseId}::uuid FOR SHARE`,
  );
  if (rows[0] === undefined) throw new AppError("NOT_FOUND");
  if (rows[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
}

async function systemTypeVersionId(tx: AccessTx, kind: string): Promise<string> {
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = ${kind} AND version = 1`,
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new AppError("INTERNAL");
  return id;
}

/**
 * Primitif belgeyi aynı transaction'da oluştur → onayla → işle. Çağıran `executeStockCommand`'ın `apply`'ındadır ve planı `planFieldPosting` ile
 * bildirmiştir. Dönen `StockCommandApplied` (audit `stock_document.posted`, numara, beyaz listeli sonuç) apply'dan olduğu gibi döndürülür.
 */
export async function postFieldDocument(
  tx: AccessTx,
  locked: LockedState,
  ctx: StockCommandContext,
  spec: FieldPostSpec,
  requestId: string | null,
): Promise<StockCommandApplied> {
  assertSize(spec);
  if ((spec.sourceKind === null) !== (spec.sourceId === null)) throw new AppError("INTERNAL");
  await assertWarehouseActive(tx, ctx.tenantId, spec.warehouseId);
  const date = await tenantToday(tx, ctx.tenantId);
  const typeVersionId = await systemTypeVersionId(tx, spec.kind);
  const documentId = randomUUID();
  registerTxCreatedDocument(tx, documentId); // çekirdek: bu belge bu transaction'da doğdu (kilit planında belge yok)
  await tx.execute(
    sql`INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by, source_kind, source_id)
        VALUES (${ctx.tenantId}::uuid, ${documentId}::uuid, ${spec.kind}, ${typeVersionId}::uuid, ${spec.warehouseId}::uuid, ${date}::date,
                ${ctx.userId}::uuid, ${spec.sourceKind}, ${spec.sourceId}::uuid)`,
  );
  const json = JSON.stringify(
    spec.lines.map((l, i) => ({
      id: randomUUID(),
      line_no: i + 1,
      item_id: l.itemId,
      unit_id: l.unitId,
      quantity: l.quantity,
      conversion_factor: l.conversionFactor,
      base_quantity: l.baseQuantity,
      source_location_id: l.sourceLocationId,
      target_location_id: l.targetLocationId,
      stock_status: l.stockStatus,
      target_stock_status: l.targetStockStatus,
      source_line_id: l.sourceLineId,
    })),
  );
  await tx.execute(
    sql`INSERT INTO public.document_lines
          (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity,
           source_location_id, target_location_id, stock_status, target_stock_status, source_line_id)
        SELECT ${ctx.tenantId}::uuid, w.id, ${documentId}::uuid, w.line_no, w.item_id, w.unit_id, w.quantity, w.conversion_factor, w.base_quantity,
               w.source_location_id, w.target_location_id, w.stock_status, w.target_stock_status, w.source_line_id
          FROM jsonb_to_recordset(${json}::jsonb) AS w(id uuid, line_no int, item_id uuid, unit_id uuid, quantity numeric, conversion_factor numeric,
               base_quantity numeric, source_location_id uuid, target_location_id uuid, stock_status text, target_stock_status text, source_line_id uuid)
         ORDER BY w.line_no`,
  );
  const approved = await tx.execute<{ id: string }>(
    sql`UPDATE public.documents SET status = 'APPROVED'
         WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${documentId}::uuid AND status = 'DRAFT' RETURNING id`,
  );
  if (approved[0] === undefined) throw new AppError("INTERNAL");
  return postApprovedDocumentInTx(tx, locked, ctx, documentId, { requestId });
}
