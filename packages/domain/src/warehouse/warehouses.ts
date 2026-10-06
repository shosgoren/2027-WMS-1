// Depo kartı komutları ve okuyucuları (T-205; A-45, A-68, A-83, A-86, A-77).
//
// - Yazma: `runTenantCommand(settings.manage)` (A-68: yalnızca TENANT_ADMIN); okuma: `runTenantQuery(stock.view)`. Her yazma aynı
//   transaction'da `appendAudit` (I-12). `tenant_id` yalnızca doğrulanmış üyelikten gelir (RLS WITH CHECK ayrıca korur).
// - `wms_app` INSERT yetkisi sütun düzeyindedir (`created_at`/`status`/`archived_at` yok) → Drizzle `insert()` DEĞİL, açık sütunlu
//   ham INSERT kullanılır (varsayılan sütunlar listeye girmez).
// - Kod: kırp + yalnızca ASCII a-z büyütülür (yerel ayar yok; `ı`/`İ`/`ß` gibi karakterler ham saklanır, karşılaştırma tam
//   eşleşme). `code` T-251'den beri değiştirilebilir (A-83 kalktı): `renameWarehouse`/`renameLocation` kod değişimini `code_history` + `*.code_changed` audit
//   ile aynı transaction'da yazar; eşzamanlı aynı koda iki değişimde kaybeden `CODE_TAKEN` alır.
// - Arşiv: hedef satır `FOR NO KEY UPDATE` (createLocation `FOR SHARE` okur → arşiv/oluşturma yarışı serileşir); aktif lokasyon veya pozitif bakiye → `IN_USE` (bakiye okuması salt SELECT). Arşivle eşzamanlı stok girişi yarışı:
//   `archiveLocation` sayım kilidini `acquireStockLocks` ile `FOR SHARE` alır (T-243) — bu, stok komutunun aynı kipteki kilidiyle
//   ÇAKIŞMAZ. Serileşmeyi stok yazıcısı sağlar: T-217 yazıcıları `acquireStockLocks` sonrası lokasyon satırını `FOR SHARE` ile okuyup
//   `ACTIVE` denetler (arşivin `FOR NO KEY UPDATE`'iyle çakışır; sıra sayım kilidi → lokasyon). T-217 kartı + kapı testi zorunlu.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx, type TenantAccessParams } from "../identity/access.ts";
import { assertWarehouseVisible, pgUuidArray, resolveWarehouseScope } from "./scope.ts";
import { hasPositiveBalance } from "./stock-usage.ts";

/** Çağıran bağlamı (izin komuta bağlıdır; çağıran veremez). */
export type WarehouseCallParams = Omit<TenantAccessParams, "permission" | "recentAuth">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODE_MAX = 64;
const NAME_MAX = 200;
const CONTROL_RE = /\p{C}/u;
const MARK_RE = /\p{Mn}/u;

export function parseUuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
}

/**
 * NFC'ye çevir, kırp, yalnızca ASCII küçük harfleri büyüt. Boş, çok uzun, denetim karakteri veya NFC sonrası kalan birleştirici
 * işaret (`\p{Mn}`) içeren değer → `VALIDATION_FAILED`. Gerekçe: kanonik eşdeğer yazımlar (`I`+U+0307 ≡ `İ`) aynı koda iner,
 * böylece görsel olarak aynı iki kod ayrı kayıt olamaz; bileşik karaktere dönüşemeyen işaretler görünmez/aldatıcı olduğundan reddedilir.
 */
export function normalizeCode(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const v = raw.normalize("NFC").trim().replace(/[a-z]/g, (c) => c.toUpperCase());
  if (v === "" || Array.from(v).length > CODE_MAX || CONTROL_RE.test(v) || MARK_RE.test(v)) throw new AppError("VALIDATION_FAILED");
  return v;
}

export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const v = raw.trim();
  if (v === "" || Array.from(v).length > NAME_MAX || CONTROL_RE.test(v)) throw new AppError("VALIDATION_FAILED");
  return v;
}

export function codeTaken(): AppError {
  return new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" });
}
export function inUse(): AppError {
  return new AppError("VALIDATION_FAILED", { detail: "IN_USE" });
}

export interface WarehouseRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

type WarehouseDbRow = {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  created_at: Date | string;
  archived_at: Date | string | null;
};
const toRow = (r: WarehouseDbRow): WarehouseRow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  status: r.status,
  createdAt: new Date(r.created_at),
  archivedAt: r.archived_at === null ? null : new Date(r.archived_at),
});

export interface CreateWarehouseInput {
  readonly code: string;
  readonly name: string;
  readonly requestId?: string | null;
}

export async function createWarehouse(params: WarehouseCallParams, input: CreateWarehouseInput): Promise<{ readonly warehouseId: string }> {
  const code = normalizeCode(input.code);
  const name = normalizeName(input.name);
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const id = randomUUID();
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.warehouses (tenant_id, id, code, name)
          VALUES (${m.tenantId}::uuid, ${id}::uuid, ${code}, ${name})
          ON CONFLICT ON CONSTRAINT warehouses_tenant_code_key DO NOTHING
          RETURNING id`,
    );
    if (rows[0] === undefined) throw codeTaken();
    await appendAudit(tx, {
      action: "warehouse.created",
      actorUserId: m.userId,
      entityType: "warehouse",
      entityId: id,
      requestId: input.requestId ?? null,
      changeSummary: { name },
    });
    return { warehouseId: id };
  });
}

/** 23505 (eşzamanlı aynı koda iki değişimde kaybeden) → `CODE_TAKEN`; diğer hatalar aynen. */
export function mapCodeConflict(e: unknown): unknown {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    if ((cur as { code?: unknown }).code === "23505") return codeTaken();
    cur = (cur as { cause?: unknown }).cause;
  }
  return e;
}

/** Kod geçmişi satırı (T-251); çağıranın transaction'ında, kod UPDATE'iyle birlikte yazılır. */
export async function insertCodeHistory(
  tx: AccessTx,
  m: { readonly tenantId: string; readonly userId: string },
  entityType: "warehouse" | "location",
  entityId: string,
  oldCode: string,
  newCode: string,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO public.code_history (tenant_id, id, entity_type, entity_id, old_code, new_code, changed_by)
        VALUES (${m.tenantId}::uuid, gen_random_uuid(), ${entityType}, ${entityId}::uuid, ${oldCode}, ${newCode}, ${m.userId}::uuid)`,
  );
}

export interface RenameWarehouseInput {
  readonly warehouseId: string;
  /** Ad ve/veya kod (en az biri). */
  readonly name?: string;
  /** Yeni depo kodu (T-251): `normalizeCode` biçimi, tenant içi benzersiz; ARCHIVED değiştirilemez. */
  readonly code?: string;
  readonly requestId?: string | null;
}

export async function renameWarehouse(params: WarehouseCallParams, input: RenameWarehouseInput): Promise<{ readonly changed: boolean }> {
  const warehouseId = parseUuid(input.warehouseId);
  if (input.name === undefined && input.code === undefined) throw new AppError("VALIDATION_FAILED");
  const name = input.name === undefined ? undefined : normalizeName(input.name);
  const code = input.code === undefined ? undefined : normalizeCode(input.code);
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    await assertWarehouseVisible(tx, m, [warehouseId]);
    const cur = await tx.execute<{ name: string; code: string; status: string }>(
      sql`SELECT name, code, status FROM public.warehouses WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid FOR NO KEY UPDATE`,
    );
    const row = cur[0];
    if (row === undefined) throw new AppError("NOT_FOUND");
    if (row.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    const newName = name ?? row.name;
    const newCode = code ?? row.code;
    const nameChanged = newName !== row.name;
    const codeChanged = newCode !== row.code;
    if (!nameChanged && !codeChanged) return { changed: false };
    try {
      await tx.execute(
        sql`UPDATE public.warehouses SET name = ${newName}, code = ${newCode} WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid`,
      );
    } catch (e) {
      throw codeChanged ? mapCodeConflict(e) : e;
    }
    if (nameChanged) {
      await appendAudit(tx, {
        action: "warehouse.updated",
        actorUserId: m.userId,
        entityType: "warehouse",
        entityId: warehouseId,
        requestId: input.requestId ?? null,
        changeSummary: { from_name: row.name, to_name: newName },
      });
    }
    if (codeChanged) {
      await insertCodeHistory(tx, m, "warehouse", warehouseId, row.code, newCode);
      await appendAudit(tx, {
        action: "warehouse.code_changed",
        actorUserId: m.userId,
        entityType: "warehouse",
        entityId: warehouseId,
        requestId: input.requestId ?? null,
        changeSummary: { from_code: row.code, to_code: newCode },
      });
    }
    return { changed: true };
  });
}

export interface ArchiveWarehouseInput {
  readonly warehouseId: string;
  readonly requestId?: string | null;
}

/** Aktif lokasyonu veya pozitif bakiyesi olan depo `IN_USE`. Zaten arşivli depo no-op (`archived: false`). */
export async function archiveWarehouse(params: WarehouseCallParams, input: ArchiveWarehouseInput): Promise<{ readonly archived: boolean }> {
  const warehouseId = parseUuid(input.warehouseId);
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    await assertWarehouseVisible(tx, m, [warehouseId]);
    // FOR NO KEY UPDATE (stok komutlarının FK KEY SHARE'iyle çakışmaz, FOR SHARE ile çakışır): eşzamanlı `createLocation` (depo satırını FOR SHARE okur) ile serileştirir; kontroller kilitten SONRA yeni görüntüyle çalışır.
    const cur = await tx.execute<{ status: string }>(
      sql`SELECT status FROM public.warehouses WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid FOR NO KEY UPDATE`,
    );
    if (cur[0] === undefined) throw new AppError("NOT_FOUND");
    if (cur[0].status === "ARCHIVED") return { archived: false };
    const active = await tx.execute<{ used: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM public.locations
                          WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND status = 'ACTIVE') AS used`,
    );
    if (active[0]?.used === true) throw inUse();
    if (await hasPositiveBalance(tx, m.tenantId, { warehouseId })) throw inUse();
    await tx.execute(
      sql`UPDATE public.warehouses SET status = 'ARCHIVED', archived_at = now()
           WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid AND status = 'ACTIVE'`,
    );
    await appendAudit(tx, {
      action: "warehouse.archived",
      actorUserId: m.userId,
      entityType: "warehouse",
      entityId: warehouseId,
      requestId: input.requestId ?? null,
      changeSummary: {},
    });
    return { archived: true };
  });
}

export interface ListWarehousesInput {
  readonly includeArchived?: boolean;
  /** Keyset imleci: son görülen `code` (tam eşleşme sırası, `COLLATE "C"`); OFFSET yok (I-14). */
  readonly afterCode?: string;
  readonly limit?: number;
}

export interface ListWarehousesResult {
  readonly items: readonly WarehouseRow[];
  readonly nextAfterCode: string | null;
}

export const LIST_LIMIT_DEFAULT = 200;
export const LIST_LIMIT_MAX = 1000;

export function parseLimit(raw: number | undefined): number {
  if (raw === undefined) return LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(raw) || raw < 1 || raw > LIST_LIMIT_MAX) throw new AppError("VALIDATION_FAILED");
  return raw;
}

/** Depo kapsamı açıkken yalnızca çağıranın kapsamındaki depolar döner (kapalıyken tümü). */
export async function listWarehouses(params: WarehouseCallParams, input: ListWarehousesInput = {}): Promise<ListWarehousesResult> {
  const limit = parseLimit(input.limit);
  const after = input.afterCode === undefined ? null : normalizeCode(input.afterCode);
  const includeArchived = input.includeArchived === true;
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const rows = await tx.execute<WarehouseDbRow>(
      sql`SELECT id, code, name, status, created_at, archived_at
            FROM public.warehouses
           WHERE tenant_id = ${m.tenantId}::uuid
             AND (${includeArchived} OR status = 'ACTIVE')
             AND (${after}::text IS NULL OR code COLLATE "C" > ${after}::text COLLATE "C")
             AND (${scope === null}::boolean OR id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))
           ORDER BY code COLLATE "C"
           LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit).map(toRow);
    const last = page[page.length - 1];
    return { items: page, nextAfterCode: rows.length > limit && last !== undefined ? last.code : null };
  });
}

/**
 * Tek depo okuyucusu. Görünürlük `listWarehouses` ile birebir aynıdır (aynı izin `stock.view`, aynı kapsam; arşivli depo da döner).
 * Kapsam dışı, başka tenant'ta ya da hiç olmayan depo AYNI `NOT_FOUND` hatasını verir (varlık sızmaz).
 */
export async function getWarehouse(params: WarehouseCallParams, input: { readonly warehouseId: string }): Promise<WarehouseRow> {
  const warehouseId = parseUuid(input.warehouseId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    await assertWarehouseVisible(tx, m, [warehouseId]);
    const rows = await tx.execute<WarehouseDbRow>(
      sql`SELECT id, code, name, status, created_at, archived_at
            FROM public.warehouses
           WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid`,
    );
    const row = rows[0];
    if (row === undefined) throw new AppError("NOT_FOUND");
    return toRow(row);
  });
}
