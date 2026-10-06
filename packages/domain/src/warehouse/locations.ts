// Lokasyon komutları ve okuyucuları (T-205; A-68, A-83, A-86, A-89; 0010 tetikleyicileri).
//
// - Eşzamanlılık (READ COMMITTED): `createLocation` depo ve ebeveyn satırını `FOR SHARE` okur; `archiveLocation`/`archiveWarehouse`
//   hedef satırı `FOR NO KEY UPDATE` okur (stok komutlarının FK KEY SHARE'iyle çakışmaz, `FOR SHARE` ile çakışır); `archiveLocation`
//   önce sayım kilidini `acquireStockLocks` ile (I-15: sayım kilidi önce; tek kilit yolu, FOR SHARE → COUNTING ise `IN_USE`), sonra lokasyon satırını kilitler; değişiklik komutları (`loadActive`,
//   `renameWarehouse`) da satırı kilitleyerek okur (arşivli kayıt güncellenemez) ve kontrolleri kilitten SONRA yapar →
//   arşivli ebeveyn/depo altında aktif lokasyon oluşamaz (FK KEY SHARE tek başına NO KEY UPDATE ile çakışmaz).
// - Kapsam dışı depo/lokasyon `NOT_FOUND` (varlık sızmaz); stok komutları `assertWarehouseInScope` ile `FORBIDDEN` verir.
// - Yazma `settings.manage`, okuma `stock.view`; her yazma aynı transaction'da `appendAudit`. Ham INSERT açık sütunlarla
//   (sütun düzeyi yetki, bkz. warehouses.ts). `depth`/`parent_id`/`warehouse_id` değişmez (tetikleyici zorlar); `code` T-251'den beri `renameLocation` ile değişir.
// - `depth` = ebeveyn + 1 (tetikleyici de doğrular, fail-closed). `TRANSIT` yalnızca kök düzeyde. Sayım kilidi satırı 0010
//   tetikleyicisiyle oluşur; komut aynı transaction'da varlığını doğrular (yoksa `COUNT_LOCK_ROW_MISSING`).
// - `pick_blocked` değişimi bu kartta yok (3A). Ağaçta taşıma, import ve sayım kilidi alma kapsam dışı.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { acquireStockLocks, appendAudit, type StockLockError } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx, type Membership } from "../identity/access.ts";
import {
  CODE_MAX,
  codeTaken,
  inUse,
  insertCodeHistory,
  mapCodeConflict,
  normalizeCode,
  normalizeName,
  parseLimit,
  parseUuid,
  type WarehouseCallParams,
} from "./warehouses.ts";
import { assertWarehouseVisible, pgUuidArray, resolveWarehouseScope } from "./scope.ts";
import { countLockRowExists, hasPositiveBalance } from "./stock-usage.ts";

export const LOCATION_KIND_LIST = ["RECEIVING", "STORAGE", "STAGING", "TRANSIT"] as const;
export type LocationKindValue = (typeof LOCATION_KIND_LIST)[number];
/** Savunma sınırı (A-98 önerisi): `depth` smallint'tir; makul ağaç Depo→Bölge→Raf→Kat→Göz'dür. */
export const MAX_LOCATION_DEPTH = 16;

export function parseKind(raw: unknown): LocationKindValue {
  if (typeof raw !== "string" || !(LOCATION_KIND_LIST as readonly string[]).includes(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as LocationKindValue;
}

/** Çocuğun derinliği (`ebeveyn + 1`; ebeveynsiz kök 0). Sınır aşımı `VALIDATION_FAILED`. */
export function childDepth(parentDepth: number | null): number {
  if (parentDepth === null) return 0;
  if (!Number.isInteger(parentDepth) || parentDepth < 0) throw new AppError("VALIDATION_FAILED");
  const d = parentDepth + 1;
  if (d > MAX_LOCATION_DEPTH) throw new AppError("VALIDATION_FAILED");
  return d;
}

export interface LocationRow {
  readonly id: string;
  readonly warehouseId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly depth: number;
  readonly kind: LocationKindValue;
  readonly pickBlocked: boolean;
  readonly status: "ACTIVE" | "ARCHIVED";
}

type LocationDbRow = {
  id: string;
  warehouse_id: string;
  parent_id: string | null;
  code: string;
  name: string;
  depth: number | string;
  kind: LocationKindValue;
  pick_blocked: boolean;
  status: "ACTIVE" | "ARCHIVED";
};
const toRow = (r: LocationDbRow): LocationRow => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  parentId: r.parent_id,
  code: r.code,
  name: r.name,
  depth: Number(r.depth),
  kind: r.kind,
  pickBlocked: r.pick_blocked,
  status: r.status,
});
const COLS = sql`id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked, status`;
const COLS_L = "l.id, l.warehouse_id, l.parent_id, l.code, l.name, l.depth, l.kind, l.pick_blocked, l.status";

export interface CreateLocationInput {
  readonly warehouseId: string;
  readonly parentId?: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: LocationKindValue;
  readonly requestId?: string | null;
}

export async function createLocation(params: WarehouseCallParams, input: CreateLocationInput): Promise<{ readonly locationId: string; readonly depth: number }> {
  const warehouseId = parseUuid(input.warehouseId);
  const parentId = input.parentId === undefined || input.parentId === null ? null : parseUuid(input.parentId);
  const code = normalizeCode(input.code);
  const name = normalizeName(input.name);
  const kind = parseKind(input.kind);
  if (kind === "TRANSIT" && parentId !== null) throw new AppError("VALIDATION_FAILED", { detail: "PARENT_INVALID" });
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    await assertWarehouseVisible(tx, m, [warehouseId]);
    const wh = await tx.execute<{ status: string }>(
      sql`SELECT status FROM public.warehouses WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid FOR SHARE`,
    );
    if (wh[0] === undefined) throw new AppError("NOT_FOUND");
    if (wh[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    let parentDepth: number | null = null;
    if (parentId !== null) {
      const p = await tx.execute<{ depth: number | string; status: string }>(
        sql`SELECT depth, status FROM public.locations
             WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND id = ${parentId}::uuid
             FOR SHARE`,
      );
      const parent = p[0];
      if (parent === undefined || parent.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED", { detail: "PARENT_INVALID" });
      parentDepth = Number(parent.depth);
    }
    const depth = childDepth(parentDepth);
    const id = randomUUID();
    const ins = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
          VALUES (${m.tenantId}::uuid, ${id}::uuid, ${warehouseId}::uuid, ${parentId}::uuid, ${code}, ${name}, ${depth}, ${kind})
          ON CONFLICT ON CONSTRAINT locations_tenant_warehouse_code_key DO NOTHING
          RETURNING id`,
    );
    if (ins[0] === undefined) throw codeTaken();
    if (!(await countLockRowExists(tx, m.tenantId, id))) throw new AppError("COUNT_LOCK_ROW_MISSING");
    await appendAudit(tx, {
      action: "location.created",
      actorUserId: m.userId,
      entityType: "location",
      entityId: id,
      requestId: input.requestId ?? null,
      changeSummary: { warehouse_id: warehouseId, parent_id: parentId, depth, kind, name },
    });
    return { locationId: id, depth };
  });
}

/** Değişiklik komutlarının ortak ön okuması: satır yoksa `NOT_FOUND`, arşivliyse `VALIDATION_FAILED`; kapsam denetimi. */
async function loadActive(tx: AccessTx, m: Membership, locationId: string): Promise<LocationRow> {
  const rows = await tx.execute<LocationDbRow>(
    sql`SELECT ${COLS} FROM public.locations WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid FOR NO KEY UPDATE`,
  );
  if (rows[0] === undefined) throw new AppError("NOT_FOUND");
  const row = toRow(rows[0]);
  await assertWarehouseVisible(tx, m, [row.warehouseId]);
  if (row.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
  return row;
}

export interface RenameLocationInput {
  readonly locationId: string;
  /** Ad ve/veya kod (en az biri). */
  readonly name?: string;
  /** Yeni lokasyon kodu (T-251): depo içi benzersiz; ARCHIVED değiştirilemez; ağaç/derinlik değişmez. */
  readonly code?: string;
  readonly requestId?: string | null;
}

export async function renameLocation(params: WarehouseCallParams, input: RenameLocationInput): Promise<{ readonly changed: boolean }> {
  const locationId = parseUuid(input.locationId);
  if (input.name === undefined && input.code === undefined) throw new AppError("VALIDATION_FAILED");
  const name = input.name === undefined ? undefined : normalizeName(input.name);
  const code = input.code === undefined ? undefined : normalizeCode(input.code);
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const cur = await loadActive(tx, m, locationId);
    const newName = name ?? cur.name;
    const newCode = code ?? cur.code;
    const nameChanged = newName !== cur.name;
    const codeChanged = newCode !== cur.code;
    if (!nameChanged && !codeChanged) return { changed: false };
    try {
      await tx.execute(
        sql`UPDATE public.locations SET name = ${newName}, code = ${newCode} WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid`,
      );
    } catch (e) {
      throw codeChanged ? mapCodeConflict(e) : e;
    }
    if (nameChanged) {
      await appendAudit(tx, {
        action: "location.updated",
        actorUserId: m.userId,
        entityType: "location",
        entityId: locationId,
        requestId: input.requestId ?? null,
        changeSummary: { from_name: cur.name, to_name: newName },
      });
    }
    if (codeChanged) {
      await insertCodeHistory(tx, m, "location", locationId, cur.code, newCode);
      await appendAudit(tx, {
        action: "location.code_changed",
        actorUserId: m.userId,
        entityType: "location",
        entityId: locationId,
        requestId: input.requestId ?? null,
        changeSummary: { from_code: cur.code, to_code: newCode },
      });
    }
    return { changed: true };
  });
}

export interface SetLocationKindInput {
  readonly locationId: string;
  readonly kind: LocationKindValue;
  readonly requestId?: string | null;
}

/** Yalnızca lokasyonda pozitif bakiye yoksa (aksi `IN_USE`); `TRANSIT` yalnızca kök düzeyde. */
export async function setLocationKind(params: WarehouseCallParams, input: SetLocationKindInput): Promise<{ readonly changed: boolean }> {
  const locationId = parseUuid(input.locationId);
  const kind = parseKind(input.kind);
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const cur = await loadActive(tx, m, locationId);
    if (cur.kind === kind) return { changed: false };
    if (kind === "TRANSIT" && cur.parentId !== null) throw new AppError("VALIDATION_FAILED", { detail: "PARENT_INVALID" });
    if (await hasPositiveBalance(tx, m.tenantId, { locationId })) throw inUse();
    await tx.execute(sql`UPDATE public.locations SET kind = ${kind} WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid`);
    await appendAudit(tx, {
      action: "location.updated",
      actorUserId: m.userId,
      entityType: "location",
      entityId: locationId,
      requestId: input.requestId ?? null,
      changeSummary: { from_kind: cur.kind, to_kind: kind },
    });
    return { changed: true };
  });
}

export interface ArchiveLocationInput {
  readonly locationId: string;
  readonly requestId?: string | null;
}

/** `acquireStockLocks` hatasını alan hatasına eşler: açık sayım → `IN_USE`; diğer bilinen kodlar aynı adla; bilinmeyen olduğu gibi yeniden fırlar. */
function mapStockLockError(e: unknown): unknown {
  if (!(e instanceof Error) || e.name !== "StockLockError") return e;
  const code = (e as StockLockError).code;
  if (code === "LOCATION_LOCKED") return inUse();
  if (code === "NOT_FOUND" || code === "COUNT_LOCK_ROW_MISSING") return new AppError(code);
  return e;
}

/** Aktif alt lokasyon, pozitif bakiye veya açık sayım (COUNTING) → `IN_USE`. Sayım kilidi satırı kalır. Arşivli lokasyon no-op. */
export async function archiveLocation(params: WarehouseCallParams, input: ArchiveLocationInput): Promise<{ readonly archived: boolean }> {
  const locationId = parseUuid(input.locationId);
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    // Kilit sırası (I-15): sayım kilidi satırı → lokasyon satırı. `warehouse_id` değişmez (tetikleyici) → kilitsiz ön okuma güvenli.
    const pre = await tx.execute<{ warehouse_id: string }>(
      sql`SELECT warehouse_id FROM public.locations WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid`,
    );
    if (pre[0] === undefined) throw new AppError("NOT_FOUND");
    await assertWarehouseVisible(tx, m, [pre[0].warehouse_id]);
    try {
      await acquireStockLocks(tx, m.tenantId, { locationIds: [locationId], dimensions: [], reservationIds: [], serialIds: [] });
    } catch (e) {
      throw mapStockLockError(e);
    }
    const rows = await tx.execute<LocationDbRow>(
      sql`SELECT ${COLS} FROM public.locations WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid FOR NO KEY UPDATE`,
    );
    if (rows[0] === undefined) throw new AppError("NOT_FOUND");
    const cur = toRow(rows[0]);
    if (cur.status === "ARCHIVED") return { archived: false };
    const child = await tx.execute<{ used: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM public.locations
                          WHERE tenant_id = ${m.tenantId}::uuid AND parent_id = ${locationId}::uuid AND status = 'ACTIVE') AS used`,
    );
    if (child[0]?.used === true) throw inUse();
    if (await hasPositiveBalance(tx, m.tenantId, { locationId })) throw inUse();
    await tx.execute(
      sql`UPDATE public.locations SET status = 'ARCHIVED', archived_at = now()
           WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid AND status = 'ACTIVE'`,
    );
    await appendAudit(tx, {
      action: "location.archived",
      actorUserId: m.userId,
      entityType: "location",
      entityId: locationId,
      requestId: input.requestId ?? null,
      changeSummary: { warehouse_id: cur.warehouseId },
    });
    return { archived: true };
  });
}

/** Depo yoksa (veya başka tenant'ta) `NOT_FOUND`; kapsam dışı depoyla aynı yanıt. */
async function assertWarehouseExists(tx: AccessTx, tenantId: string, warehouseId: string): Promise<void> {
  const r = await tx.execute<{ id: string }>(sql`SELECT id FROM public.warehouses WHERE tenant_id = ${tenantId}::uuid AND id = ${warehouseId}::uuid`);
  if (r[0] === undefined) throw new AppError("NOT_FOUND");
}

export interface LocationTreeCursor {
  readonly depth: number;
  readonly code: string;
  readonly id: string;
}

export interface GetLocationTreeInput {
  readonly warehouseId: string;
  readonly includeArchived?: boolean;
  /** Keyset imleci `(depth, code, id)` — OFFSET yok (I-14). */
  readonly after?: LocationTreeCursor;
  readonly limit?: number;
}

export interface LocationTreePage {
  /** Derinlik, sonra `code` (`COLLATE "C"`), sonra `id` sırasıyla; ağaç `parentId` ile kurulur. */
  readonly items: readonly LocationRow[];
  readonly next: LocationTreeCursor | null;
}

export async function getLocationTree(params: WarehouseCallParams, input: GetLocationTreeInput): Promise<LocationTreePage> {
  const warehouseId = parseUuid(input.warehouseId);
  const limit = parseLimit(input.limit);
  const after = input.after;
  if (
    after !== undefined &&
    (!Number.isInteger(after.depth) || after.depth < 0 || after.depth > MAX_LOCATION_DEPTH || typeof after.code !== "string" || Array.from(after.code).length > CODE_MAX)
  ) {
    throw new AppError("VALIDATION_FAILED");
  }
  const afterId = after === undefined ? null : parseUuid(after.id);
  const includeArchived = input.includeArchived === true;
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    await assertWarehouseExists(tx, m.tenantId, warehouseId);
    await assertWarehouseVisible(tx, m, [warehouseId]);
    const rows = await tx.execute<LocationDbRow>(
      sql`SELECT ${COLS} FROM public.locations
           WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid
             AND (${includeArchived} OR status = 'ACTIVE')
             AND (${afterId}::uuid IS NULL
                  OR (depth, code COLLATE "C", id) > (${after?.depth ?? 0}::smallint, ${after?.code ?? ""}::text COLLATE "C", ${afterId}::uuid))
           ORDER BY depth, code COLLATE "C", id
           LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit).map(toRow);
    const last = page[page.length - 1];
    return {
      items: page,
      next: rows.length > limit && last !== undefined ? { depth: last.depth, code: last.code, id: last.id } : null,
    };
  });
}

/** Depo içinde koda göre tam eşleşme (kod normalleştirilir). Yoksa `null`. */
export async function findLocationByCode(
  params: WarehouseCallParams,
  input: { readonly warehouseId: string; readonly code: string },
): Promise<(LocationRow & { readonly renamedFrom?: string }) | null> {
  const warehouseId = parseUuid(input.warehouseId);
  const code = normalizeCode(input.code);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    await assertWarehouseExists(tx, m.tenantId, warehouseId);
    await assertWarehouseVisible(tx, m, [warehouseId]);
    const rows = await tx.execute<LocationDbRow>(
      sql`SELECT ${COLS} FROM public.locations
           WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND code = ${code}`,
    );
    if (rows[0] !== undefined) return toRow(rows[0]);
    // T-251: güncel eşleşme yoksa eski kod geçmişi; aynı depodaki en son eşleşen kart döner ("bu kod X olarak değişti").
    const old = await tx.execute<LocationDbRow>(
      sql`SELECT ${sql.raw(COLS_L)} FROM public.code_history h
            JOIN public.locations l ON l.tenant_id = h.tenant_id AND l.id = h.entity_id
           WHERE h.tenant_id = ${m.tenantId}::uuid AND h.entity_type = 'location' AND h.old_code = ${code}
             AND l.warehouse_id = ${warehouseId}::uuid
           ORDER BY h.changed_at DESC, h.id DESC LIMIT 1`,
    );
    return old[0] === undefined ? null : { ...toRow(old[0]), renamedFrom: code };
  });
}

export const COUNT_WAREHOUSES_MAX = 100;

export interface CountLocationsByWarehouseInput {
  readonly warehouseIds: readonly string[];
  /** `getLocationTree` ile aynı tanım: varsayılan yalnızca `ACTIVE` lokasyonlar; `true` ise arşivliler de sayılır. */
  readonly includeArchived?: boolean;
}

/**
 * Depo başına lokasyon sayısı, tek sorgu (`GROUP BY`). En çok {@link COUNT_WAREHOUSES_MAX} kimlik (aşarsa/boşsa/geçersizse `VALIDATION_FAILED`).
 * Kapsam dışı, başka tenant'ta ya da hiç olmayan depolar sonuçta YOKTUR (hata vermez, varlık sızmaz); görünür ama lokasyonsuz depo `0`.
 */
export async function countLocationsByWarehouse(
  params: WarehouseCallParams,
  input: CountLocationsByWarehouseInput,
): Promise<ReadonlyMap<string, number>> {
  if (!Array.isArray(input.warehouseIds) || input.warehouseIds.length < 1 || input.warehouseIds.length > COUNT_WAREHOUSES_MAX) {
    throw new AppError("VALIDATION_FAILED");
  }
  const ids = [...new Set(input.warehouseIds.map(parseUuid))];
  const includeArchived = input.includeArchived === true;
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const rows = await tx.execute<{ warehouse_id: string; n: string | number }>(
      sql`SELECT w.id AS warehouse_id, count(l.id) AS n
            FROM public.warehouses w
            LEFT JOIN public.locations l
              ON l.tenant_id = w.tenant_id AND l.warehouse_id = w.id AND (${includeArchived} OR l.status = 'ACTIVE')
           WHERE w.tenant_id = ${m.tenantId}::uuid
             AND w.id = ANY(${pgUuidArray(ids)}::uuid[])
             AND (${scope === null}::boolean OR w.id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))
           GROUP BY w.id`,
    );
    return new Map(rows.map((r) => [r.warehouse_id, Number(r.n)] as const));
  });
}
