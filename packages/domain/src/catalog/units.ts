// Birim ve birim dönüşümü komutları (T-208; A-68, I-09). Yazma `settings.manage`, okuma `stock.view`.
//
// - Hepsi `runTenantCommand`/`runTenantQuery` içinde (güncel üyelik + izin, tenant bağlamı `set_config(..., true)`); `tenant_id`
//   yalnızca üyelik bağlamından gelir, tüm erişim `tx` üzerindendir. Audit aynı transaction'da (I-12).
// - Kod tekrarı `ON CONFLICT … DO NOTHING` ile yakalanır → `VALIDATION_FAILED` + `CODE_TAKEN` (yarış güvenli).
// - Dönüşüm katsayısı belge satırına KOPYALANIR (I-09); `setUnitConversion` yalnızca katalog satırını değiştirir,
//   geçmiş belgeler etkilenmez. Temel birim için satır yoktur (katsayı 1 örtük; DB tetikleyicisi de reddeder).
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx, type TenantAccessParams } from "../identity/access.ts";
import { assertConversionFactor } from "./quantity.ts";

export type CatalogCommandParams = Omit<TenantAccessParams, "permission"> & { readonly requestId?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_MAX = 64;
const NAME_MAX = 200;

export function parseUuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
}

/** Kırpılmış, boş olmayan, kontrol karakteri içermeyen metin. */
export function parseText(raw: unknown, max: number): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const v = raw.trim();
  if (v === "" || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new AppError("VALIDATION_FAILED");
  return v;
}

export const parseCode = (raw: unknown): string => parseText(raw, CODE_MAX);
export const parseName = (raw: unknown): string => parseText(raw, NAME_MAX);

export type UnitRow = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
};

export interface UnitConversionResult {
  readonly itemId: string;
  readonly unitId: string;
  /** Kanonik dizgi (sondaki sıfırlar atılmış). */
  readonly factor: string;
}

export async function createUnit(
  params: CatalogCommandParams,
  input: { readonly code: string; readonly name: string },
): Promise<{ readonly unitId: string }> {
  const code = parseCode(input.code);
  const name = parseName(input.name);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.units (tenant_id, id, code, name)
          VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${code}, ${name})
          ON CONFLICT ON CONSTRAINT units_tenant_code_key DO NOTHING
          RETURNING id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" });
    await appendAudit(tx, {
      action: "unit.created",
      actorUserId: actor.userId,
      entityType: "unit",
      entityId: id,
      requestId: requestId ?? null,
      changeSummary: { code, name },
    });
    return { unitId: id };
  });
}

export async function renameUnit(
  params: CatalogCommandParams,
  input: { readonly unitId: string; readonly name: string },
): Promise<{ readonly unitId: string; readonly changed: boolean }> {
  const unitId = parseUuid(input.unitId);
  const name = parseName(input.name);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const cur = await tx.execute<{ name: string }>(
      sql`SELECT name FROM public.units WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${unitId}::uuid FOR UPDATE`,
    );
    const before = cur[0]?.name;
    if (before === undefined) throw new AppError("NOT_FOUND");
    if (before === name) return { unitId, changed: false };
    await tx.execute(
      sql`UPDATE public.units SET name = ${name} WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${unitId}::uuid`,
    );
    await appendAudit(tx, {
      action: "unit.updated",
      actorUserId: actor.userId,
      entityType: "unit",
      entityId: unitId,
      requestId: requestId ?? null,
      changeSummary: { from_name: before, to_name: name },
    });
    return { unitId, changed: true };
  });
}

export async function listUnits(params: Omit<CatalogCommandParams, "requestId">): Promise<readonly UnitRow[]> {
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, actor) => {
    const rows = await tx.execute<UnitRow>(
      sql`SELECT id, code, name, status FROM public.units WHERE tenant_id = ${actor.tenantId}::uuid ORDER BY code`,
    );
    return [...rows];
  });
}

/**
 * Ürün-birim dönüşüm katsayısı (1 `unitId` = `factor` temel birim). Temel birim için `UNIT_CONVERSION_INVALID`;
 * katsayı > 0, ≤ 6 ondalık. Var olan satır güncellenir (belgelerdeki kopyalar etkilenmez, I-09).
 */
export async function setUnitConversion(
  params: CatalogCommandParams,
  input: { readonly itemId: string; readonly unitId: string; readonly factor: string },
): Promise<UnitConversionResult> {
  const itemId = parseUuid(input.itemId);
  const unitId = parseUuid(input.unitId);
  const factor = assertConversionFactor(input.factor);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const item = await loadItem(tx, actor.tenantId, itemId);
    if (item === undefined) throw new AppError("NOT_FOUND");
    if (item.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    const unit = await tx.execute<{ status: string }>(
      sql`SELECT status FROM public.units WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${unitId}::uuid`,
    );
    if (unit[0] === undefined) throw new AppError("NOT_FOUND");
    if (unit[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    if (item.base_unit_id === unitId) throw new AppError("VALIDATION_FAILED", { detail: "UNIT_CONVERSION_INVALID" });
    const prev = await tx.execute<{ to_base_factor: string }>(
      sql`SELECT to_base_factor::text AS to_base_factor FROM public.unit_conversions
           WHERE tenant_id = ${actor.tenantId}::uuid AND item_id = ${itemId}::uuid AND unit_id = ${unitId}::uuid FOR UPDATE`,
    );
    await tx.execute(
      sql`INSERT INTO public.unit_conversions (tenant_id, id, item_id, unit_id, to_base_factor)
          VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${itemId}::uuid, ${unitId}::uuid, ${factor}::numeric)
          ON CONFLICT ON CONSTRAINT unit_conversions_tenant_item_unit_key
          DO UPDATE SET to_base_factor = EXCLUDED.to_base_factor`,
    );
    await appendAudit(tx, {
      action: "unit_conversion.set",
      actorUserId: actor.userId,
      entityType: "item",
      entityId: itemId,
      requestId: requestId ?? null,
      changeSummary: { unit_id: unitId, factor, previous_factor: prev[0]?.to_base_factor ?? null },
    });
    return { itemId, unitId, factor };
  });
}

export type ItemHeader = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly base_unit_id: string;
  readonly tracking_mode: string;
  readonly quantity_scale: number;
  readonly pick_policy: string;
  readonly status: "ACTIVE" | "ARCHIVED";
};

/** Ürün satırı (RLS + açık tenant filtresi); `forUpdate` ürün satırını kilitler (katalog satırı, stok kilidi değil). */
export async function loadItem(tx: AccessTx, tenantId: string, itemId: string, forUpdate = false): Promise<ItemHeader | undefined> {
  const rows = forUpdate
    ? await tx.execute<ItemHeader>(
        sql`SELECT id, code, name, base_unit_id, tracking_mode, quantity_scale, pick_policy, status FROM public.items
             WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid FOR UPDATE`,
      )
    : await tx.execute<ItemHeader>(
        sql`SELECT id, code, name, base_unit_id, tracking_mode, quantity_scale, pick_policy, status FROM public.items
             WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid`,
      );
  return rows[0];
}
