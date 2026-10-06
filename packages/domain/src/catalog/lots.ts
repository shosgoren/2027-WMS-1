// Lot kartı komutları (T-212; A-45, A-87, Q-47). Yazma `document.create`, okuma `stock.view`.
//
// - Stok DEĞİŞTİRMEZ (G-01): yalnızca `lots` satırı yazar. Lot kimlik alanları (`item_id`, `lot_code`) değişmez (A-87).
// - Yalnızca `LOT`/`LOT_AND_SERIAL` ürüne lot açılır (aksi `TRACKING_VIOLATION`). SKT/üretim tarihi tarih-only (`YYYY-MM-DD`).
// - Ürün satırı `FOR SHARE` ile okunur: `archiveItem` (`FOR UPDATE`) ile oluşturma yarışı serileşir; arşivli ürüne lot açılmaz.
// - Dış görünür metinler Unicode NFC'ye normalize edilir. Kapsam dışı/olmayan kayıt `NOT_FOUND` (tenant sızıntısı yok).
// - Audit `changeSummary`: `lot_code` içeren anahtar maskelenirdi (`code` alt dizesi); kimlik `entityId` ile izlenir.
import { sql } from "drizzle-orm";
import type { TrackingMode } from "@wms/db";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx } from "../identity/access.ts";
import { parseText, parseUuid, type CatalogCommandParams } from "./units.ts";

export const LOT_TRACKING_MODES: readonly TrackingMode[] = ["LOT", "LOT_AND_SERIAL"];
const SUPPLIER_LOT_MAX = 64;
export const LOT_LIST_MAX_LIMIT = 200;
export const LOT_LIST_DEFAULT_LIMIT = 50;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** NFC normalize + kırp + boş/kontrol karakteri reddi. */
export function parseNfcText(raw: unknown, max: number): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  return parseText(raw.normalize("NFC"), max);
}

/** Tarih-only `YYYY-MM-DD`; takvimde var olmayan gün (`2025-02-30`) reddedilir. Saat dilimi dönüşümü yok. */
export function parseDateOnly(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const m = DATE_RE.exec(raw);
  if (m === null) throw new AppError("VALIDATION_FAILED");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2999) throw new AppError("VALIDATION_FAILED");
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw new AppError("VALIDATION_FAILED");
  return raw;
}

/** Üretim ≤ SKT (ikisi de verilmişse). */
export function assertLotDates(productionDate: string | undefined, expiryDate: string | undefined): void {
  if (productionDate !== undefined && expiryDate !== undefined && expiryDate < productionDate) throw new AppError("VALIDATION_FAILED");
}

export interface CreateLotInput {
  readonly itemId: string;
  readonly lotCode: string;
  readonly productionDate?: string;
  readonly expiryDate?: string;
  readonly supplierLot?: string;
}

export interface LotRow {
  readonly id: string;
  readonly itemId: string;
  readonly lotCode: string;
  readonly productionDate: string | null;
  readonly expiryDate: string | null;
  readonly supplierLot: string | null;
}

type LotDb = {
  id: string;
  item_id: string;
  lot_code: string;
  production_date: string | null;
  expiry_date: string | null;
  supplier_lot: string | null;
};

const toRow = (r: LotDb): LotRow => ({
  id: r.id,
  itemId: r.item_id,
  lotCode: r.lot_code,
  productionDate: r.production_date,
  expiryDate: r.expiry_date,
  supplierLot: r.supplier_lot,
});

/** Takip modu × kart türü uyumu (saf; DB'siz test edilir). */
export function modeAllowsLot(mode: TrackingMode): boolean {
  return LOT_TRACKING_MODES.includes(mode);
}

/** Ürün satırını paylaşımlı kilitle okur (arşiv `FOR UPDATE` ile serileşir). */
export async function loadItemForTraceability(
  tx: AccessTx,
  tenantId: string,
  itemId: string,
): Promise<{ readonly tracking_mode: TrackingMode; readonly status: "ACTIVE" | "ARCHIVED" } | undefined> {
  const rows = await tx.execute<{ tracking_mode: TrackingMode; status: "ACTIVE" | "ARCHIVED" }>(
    sql`SELECT tracking_mode, status FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid FOR SHARE`,
  );
  return rows[0];
}

export async function createLot(params: CatalogCommandParams, input: CreateLotInput): Promise<{ readonly lotId: string }> {
  const itemId = parseUuid(input.itemId);
  const lotCode = parseNfcText(input.lotCode, 64);
  const productionDate = input.productionDate === undefined ? undefined : parseDateOnly(input.productionDate);
  const expiryDate = input.expiryDate === undefined ? undefined : parseDateOnly(input.expiryDate);
  assertLotDates(productionDate, expiryDate);
  const supplierLot = input.supplierLot === undefined ? undefined : parseNfcText(input.supplierLot, SUPPLIER_LOT_MAX);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "document.create" }, async (tx, actor) => {
    const item = await loadItemForTraceability(tx, actor.tenantId, itemId);
    if (item === undefined) throw new AppError("NOT_FOUND");
    if (item.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    if (!modeAllowsLot(item.tracking_mode)) throw new AppError("TRACKING_VIOLATION");
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.lots (tenant_id, id, item_id, lot_code, production_date, expiry_date, supplier_lot)
          VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${itemId}::uuid, ${lotCode},
                  ${productionDate ?? null}::date, ${expiryDate ?? null}::date, ${supplierLot ?? null})
          ON CONFLICT ON CONSTRAINT lots_tenant_item_lot_code_key DO NOTHING
          RETURNING id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" });
    await appendAudit(tx, {
      action: "lot.created",
      actorUserId: actor.userId,
      entityType: "lot",
      entityId: id,
      requestId: requestId ?? null,
      changeSummary: { item_id: itemId, production_date: productionDate ?? null, expiry_date: expiryDate ?? null, has_supplier_lot: supplierLot !== undefined },
    });
    return { lotId: id };
  });
}

export async function findLot(params: Omit<CatalogCommandParams, "requestId">, input: { readonly lotId: string }): Promise<LotRow> {
  const lotId = parseUuid(input.lotId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, actor) => {
    const rows = await tx.execute<LotDb>(
      sql`SELECT id, item_id, lot_code, production_date::text AS production_date, expiry_date::text AS expiry_date, supplier_lot
            FROM public.lots WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${lotId}::uuid`,
    );
    const r = rows[0];
    if (r === undefined) throw new AppError("NOT_FOUND");
    return toRow(r);
  });
}

export interface LotCursor {
  readonly lotCode: string;
  readonly id: string;
}
export interface ListLotsInput {
  readonly itemId: string;
  readonly limit?: number;
  /** Önceki sayfanın `nextCursor`'ı. */
  readonly after?: LotCursor;
}
export interface LotPage {
  readonly items: readonly LotRow[];
  readonly nextCursor: LotCursor | null;
}

/** Keyset sayfalama: `(lot_code, id)` artan. Olmayan/başka tenant ürünü `NOT_FOUND`. */
export async function listLots(params: Omit<CatalogCommandParams, "requestId">, input: ListLotsInput): Promise<LotPage> {
  const itemId = parseUuid(input.itemId);
  const limit = input.limit ?? LOT_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LOT_LIST_MAX_LIMIT) throw new AppError("VALIDATION_FAILED");
  const after = input.after === undefined ? undefined : { lotCode: parseNfcText(input.after.lotCode, 64), id: parseUuid(input.after.id) };
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, actor) => {
    const item = await tx.execute<{ x: number }>(
      sql`SELECT 1 AS x FROM public.items WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${itemId}::uuid`,
    );
    if (item[0] === undefined) throw new AppError("NOT_FOUND");
    const cond = after === undefined ? sql`` : sql`AND (lot_code, id) > (${after.lotCode}, ${after.id}::uuid)`;
    const rows = await tx.execute<LotDb>(
      sql`SELECT id, item_id, lot_code, production_date::text AS production_date, expiry_date::text AS expiry_date, supplier_lot
            FROM public.lots WHERE tenant_id = ${actor.tenantId}::uuid AND item_id = ${itemId}::uuid ${cond}
           ORDER BY lot_code, id LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit).map(toRow);
    const last = page[page.length - 1];
    const more = rows.length > limit && last !== undefined;
    return { items: page, nextCursor: more ? { lotCode: last.lotCode, id: last.id } : null };
  });
}

