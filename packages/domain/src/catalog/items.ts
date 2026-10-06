// Ürün kartı komutları (T-208; A-68, A-87, A-16, A-33). Yazma `settings.manage`, okuma `stock.view`.
//
// - Stok DEĞİŞTİRMEZ (G-01); yalnızca katalog satırı yazar ve stok tablolarını OKUR. Bu yüzden `acquireStockLocks`
//   kullanılmaz; arşiv/stok-denetimi için yalnızca ürün KATALOG satırı `FOR UPDATE` ile kilitlenir (stok kilidi değil).
// - `base_unit_id`, `tracking_mode`, `quantity_scale` oluşturulduktan sonra değişmez (A-87; wms_app UPDATE yetkisi yok).
//   `updateItem` bu alanlar için fark isteği gelirse: stoklu üründe `IN_USE`, stoksuzda `VALIDATION_FAILED` (A-107).
// - "Stoklu" = ürünün herhangi bir stok boyutu (dolayısıyla defter/bakiye) var. `archiveItem`: pozitif bakiye ya da açık
//   (ACTIVE) rezervasyon varsa `IN_USE`. Kullanılmış kart silinmez; DELETE yoktur (05 §Geri alma).
import { sql } from "drizzle-orm";
import type { PickPolicy, TrackingMode } from "@wms/db";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx } from "../identity/access.ts";
import { loadItem, parseCode, parseName, parseUuid, type CatalogCommandParams, type ItemHeader } from "./units.ts";

const TRACKING: readonly TrackingMode[] = ["NONE", "LOT", "SERIAL", "LOT_AND_SERIAL"];
const PICK: readonly PickPolicy[] = ["FIFO", "FEFO"];

function parseTracking(raw: unknown): TrackingMode {
  if (typeof raw !== "string" || !(TRACKING as readonly string[]).includes(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as TrackingMode;
}
function parsePick(raw: unknown): PickPolicy {
  if (typeof raw !== "string" || !(PICK as readonly string[]).includes(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as PickPolicy;
}
function parseScale(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 6) throw new AppError("VALIDATION_FAILED");
  return raw;
}

export interface CreateItemInput {
  readonly code: string;
  readonly name: string;
  readonly baseUnitId: string;
  /** Varsayılan `NONE` (A-16). */
  readonly trackingMode?: TrackingMode;
  /** Varsayılan 0 (A-33). */
  readonly quantityScale?: number;
  /** Varsayılan `FIFO`. */
  readonly pickPolicy?: PickPolicy;
}

export interface UpdateItemInput {
  readonly itemId: string;
  readonly name?: string;
  readonly pickPolicy?: PickPolicy;
  // Değişmez alanlar (A-87): farklı değer istenirse ret (bkz. dosya başlığı).
  readonly trackingMode?: TrackingMode;
  readonly baseUnitId?: string;
  readonly quantityScale?: number;
}

export interface ItemRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly baseUnitId: string;
  readonly trackingMode: TrackingMode;
  readonly quantityScale: number;
  readonly pickPolicy: PickPolicy;
  readonly status: "ACTIVE" | "ARCHIVED";
}

function toRow(r: ItemHeader): ItemRow {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    baseUnitId: r.base_unit_id,
    trackingMode: r.tracking_mode as TrackingMode,
    quantityScale: r.quantity_scale,
    pickPolicy: r.pick_policy as PickPolicy,
    status: r.status,
  };
}

export async function createItem(params: CatalogCommandParams, input: CreateItemInput): Promise<{ readonly itemId: string }> {
  const code = parseCode(input.code);
  const name = parseName(input.name);
  const baseUnitId = parseUuid(input.baseUnitId);
  const trackingMode = input.trackingMode === undefined ? "NONE" : parseTracking(input.trackingMode);
  const quantityScale = input.quantityScale === undefined ? 0 : parseScale(input.quantityScale);
  const pickPolicy = input.pickPolicy === undefined ? "FIFO" : parsePick(input.pickPolicy);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const unit = await tx.execute<{ status: string }>(
      sql`SELECT status FROM public.units WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${baseUnitId}::uuid`,
    );
    if (unit[0] === undefined) throw new AppError("NOT_FOUND");
    if (unit[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale, pick_policy)
          VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${code}, ${name}, ${baseUnitId}::uuid, ${trackingMode},
                  ${quantityScale}::smallint, ${pickPolicy})
          ON CONFLICT ON CONSTRAINT items_tenant_code_key DO NOTHING
          RETURNING id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" });
    await appendAudit(tx, {
      action: "item.created",
      actorUserId: actor.userId,
      entityType: "item",
      entityId: id,
      requestId: requestId ?? null,
      changeSummary: { code, name, base_unit_id: baseUnitId, tracking_mode: trackingMode, quantity_scale: quantityScale, pick_policy: pickPolicy },
    });
    return { itemId: id };
  });
}

async function hasStockDimension(tx: AccessTx, tenantId: string, itemId: string): Promise<boolean> {
  const r = await tx.execute<{ x: number }>(
    sql`SELECT 1 AS x FROM public.stock_dimensions WHERE tenant_id = ${tenantId}::uuid AND item_id = ${itemId}::uuid LIMIT 1`,
  );
  return r[0] !== undefined;
}

export async function updateItem(params: CatalogCommandParams, input: UpdateItemInput): Promise<{ readonly itemId: string; readonly changed: boolean }> {
  const itemId = parseUuid(input.itemId);
  const name = input.name === undefined ? undefined : parseName(input.name);
  const pickPolicy = input.pickPolicy === undefined ? undefined : parsePick(input.pickPolicy);
  const trackingMode = input.trackingMode === undefined ? undefined : parseTracking(input.trackingMode);
  const baseUnitId = input.baseUnitId === undefined ? undefined : parseUuid(input.baseUnitId);
  const quantityScale = input.quantityScale === undefined ? undefined : parseScale(input.quantityScale);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const cur = await loadItem(tx, actor.tenantId, itemId, "update");
    if (cur === undefined) throw new AppError("NOT_FOUND");
    const immutableChange =
      (trackingMode !== undefined && trackingMode !== cur.tracking_mode) ||
      (baseUnitId !== undefined && baseUnitId !== cur.base_unit_id) ||
      (quantityScale !== undefined && quantityScale !== cur.quantity_scale);
    if (immutableChange) {
      if (await hasStockDimension(tx, actor.tenantId, itemId)) throw new AppError("VALIDATION_FAILED", { detail: "IN_USE" });
      throw new AppError("VALIDATION_FAILED"); // stoksuz olsa da A-87: bu alanlar oluşturulduktan sonra değişmez
    }
    if (cur.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    const newName = name ?? cur.name;
    const newPick = pickPolicy ?? (cur.pick_policy as PickPolicy);
    if (newName === cur.name && newPick === cur.pick_policy) return { itemId, changed: false };
    await tx.execute(
      sql`UPDATE public.items SET name = ${newName}, pick_policy = ${newPick}
           WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${itemId}::uuid`,
    );
    await appendAudit(tx, {
      action: "item.updated",
      actorUserId: actor.userId,
      entityType: "item",
      entityId: itemId,
      requestId: requestId ?? null,
      changeSummary: { from_name: cur.name, to_name: newName, from_pick_policy: cur.pick_policy, to_pick_policy: newPick },
    });
    return { itemId, changed: true };
  });
}

export async function archiveItem(params: CatalogCommandParams, input: { readonly itemId: string }): Promise<{ readonly itemId: string; readonly changed: boolean }> {
  const itemId = parseUuid(input.itemId);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const cur = await loadItem(tx, actor.tenantId, itemId, "update");
    if (cur === undefined) throw new AppError("NOT_FOUND");
    if (cur.status === "ARCHIVED") return { itemId, changed: false };
    const positive = await tx.execute<{ x: number }>(
      sql`SELECT 1 AS x FROM public.stock_balances b
            JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
           WHERE d.tenant_id = ${actor.tenantId}::uuid AND d.item_id = ${itemId}::uuid AND (b.quantity > 0 OR b.reserved_quantity > 0)
           LIMIT 1`,
    );
    if (positive[0] !== undefined) throw new AppError("VALIDATION_FAILED", { detail: "IN_USE" });
    const open = await tx.execute<{ x: number }>(
      sql`SELECT 1 AS x FROM public.reservations
           WHERE tenant_id = ${actor.tenantId}::uuid AND item_id = ${itemId}::uuid AND status = 'ACTIVE' LIMIT 1`,
    );
    if (open[0] !== undefined) throw new AppError("VALIDATION_FAILED", { detail: "IN_USE" });
    await tx.execute(
      sql`UPDATE public.items SET status = 'ARCHIVED', archived_at = now()
           WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${itemId}::uuid`,
    );
    await appendAudit(tx, {
      action: "item.archived",
      actorUserId: actor.userId,
      entityType: "item",
      entityId: itemId,
      requestId: requestId ?? null,
      changeSummary: { code: cur.code },
    });
    return { itemId, changed: true };
  });
}

export async function getItem(params: Omit<CatalogCommandParams, "requestId">, input: { readonly itemId: string }): Promise<ItemRow> {
  const itemId = parseUuid(input.itemId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, actor) => {
    const r = await loadItem(tx, actor.tenantId, itemId);
    if (r === undefined) throw new AppError("NOT_FOUND");
    return toRow(r);
  });
}

export async function listItems(params: Omit<CatalogCommandParams, "requestId">): Promise<readonly ItemRow[]> {
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, actor) => {
    const rows = await tx.execute<ItemHeader>(
      sql`SELECT id, code, name, base_unit_id, tracking_mode, quantity_scale, pick_policy, status FROM public.items
           WHERE tenant_id = ${actor.tenantId}::uuid ORDER BY code`,
    );
    return rows.map(toRow);
  });
}
