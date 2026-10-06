// Depo kapsamı denetimi (T-205; A-46, A-77) — `WAREHOUSE_SCOPE_ENABLED` bayrağı, varsayılan KAPALI.
//
// - Bayrak kapalı: `assertWarehouseInScope` no-op (A-46: tenant kapsamı sürer).
// - Bayrak açık: `TENANT_ADMIN` her zaman geçer; diğer rollerde kapsam satırı yoksa tüm depolar, varsa yalnızca listelenenler;
//   aksi `FORBIDDEN`/`WAREHOUSE_OUT_OF_SCOPE`. BİLİNEN RİSK (A-77, MINOR-8): "satır yoksa tüm depolar" fail-open'dır; bayrak
//   AÇILMADAN önce bu kural yeniden karara bağlanır (Q-23).
// - Bayrak ortamdan çağrı anında okunur (`process.env`); yalnızca `true`/`1` açar, başka her değer (ve tanımsız) kapalıdır.
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, type AccessTx, type Membership, type TenantAccessParams } from "../identity/access.ts";

export const WAREHOUSE_SCOPE_FLAG = "WAREHOUSE_SCOPE_ENABLED";

export function isWarehouseScopeEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[WAREHOUSE_SCOPE_FLAG]?.trim().toLowerCase();
  return v === "true" || v === "1";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Doğrulanmış UUID listesini Postgres dizi değişmezine çevirir (`'{a,b}'::uuid[]`); sürücü dizi genişletmesinden kaçınır. */
export function pgUuidArray(ids: readonly string[]): string {
  for (const id of ids) if (!UUID_RE.test(id)) throw new AppError("VALIDATION_FAILED");
  return `{${ids.join(",")}}`;
}

/**
 * Çağıranın erişebildiği depolar: `null` = kısıtsız (bayrak kapalı, `TENANT_ADMIN` ya da kapsam satırı yok), aksi izinli kimlikler.
 * Salt SELECT; kilit yok.
 */
export async function resolveWarehouseScope(
  tx: AccessTx,
  membership: Membership,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly string[] | null> {
  if (!isWarehouseScopeEnabled(env)) return null;
  if (membership.roles.includes("TENANT_ADMIN")) return null;
  const rows = await tx.execute<{ warehouse_id: string }>(
    sql`SELECT warehouse_id FROM public.membership_warehouse_scopes
         WHERE tenant_id = ${membership.tenantId}::uuid AND membership_id = ${membership.membershipId}::uuid
         ORDER BY warehouse_id`,
  );
  return rows.length === 0 ? null : rows.map((r) => r.warehouse_id);
}

/** İstenen depoların tümü kapsamda değilse `FORBIDDEN`/`WAREHOUSE_OUT_OF_SCOPE`. Bayrak kapalıyken no-op. */
export async function assertWarehouseInScope(
  tx: AccessTx,
  membership: Membership,
  warehouseIds: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const allowed = await resolveWarehouseScope(tx, membership, env);
  if (allowed === null) return;
  const set = new Set(allowed);
  for (const id of warehouseIds) {
    if (!set.has(id.toLowerCase())) throw new AppError("FORBIDDEN", { detail: "WAREHOUSE_OUT_OF_SCOPE" });
  }
}

export type ScopeCallParams = Omit<TenantAccessParams, "permission" | "recentAuth">;

export interface SetScopesInput {
  readonly membershipId: string;
  /** Boş liste = tüm kapsam satırları silinir (A-77: kapsam satırı yoksa tüm depolar). */
  readonly warehouseIds: readonly string[];
  readonly requestId?: string | null;
}

/** Üyeliğin depo kapsamını değiştirir (`users.manage`); hedef üyelik satırı serileştirme için `FOR UPDATE` kilitlenir. */
export async function setMembershipWarehouseScopes(
  params: ScopeCallParams,
  input: SetScopesInput,
): Promise<{ readonly warehouseIds: readonly string[] }> {
  const membershipId = uuid(input.membershipId);
  if (!Array.isArray(input.warehouseIds) || input.warehouseIds.length > 1000) throw new AppError("VALIDATION_FAILED");
  const ids = [...new Set(input.warehouseIds.map(uuid))].sort();
  return runTenantCommand({ ...params, permission: "users.manage" }, async (tx, m) => {
    const target = await tx.execute<{ id: string }>(
      sql`SELECT id FROM public.tenant_memberships
           WHERE tenant_id = ${m.tenantId}::uuid AND id = ${membershipId}::uuid AND status = 'ACTIVE'
           FOR UPDATE`,
    );
    if (target[0] === undefined) throw new AppError("NOT_FOUND");
    if (ids.length > 0) {
      const found = await tx.execute<{ id: string }>(
        sql`SELECT id FROM public.warehouses WHERE tenant_id = ${m.tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
      );
      if (found.length !== ids.length) throw new AppError("NOT_FOUND");
    }
    const before = await tx.execute<{ warehouse_id: string }>(
      sql`SELECT warehouse_id FROM public.membership_warehouse_scopes
           WHERE tenant_id = ${m.tenantId}::uuid AND membership_id = ${membershipId}::uuid ORDER BY warehouse_id`,
    );
    await tx.execute(
      sql`DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = ${m.tenantId}::uuid AND membership_id = ${membershipId}::uuid`,
    );
    for (const w of ids) {
      await tx.execute(
        sql`INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id)
            VALUES (${m.tenantId}::uuid, ${membershipId}::uuid, ${w}::uuid)`,
      );
    }
    await appendAudit(tx, {
      action: "warehouse_scope.changed",
      actorUserId: m.userId,
      entityType: "membership",
      entityId: membershipId,
      requestId: input.requestId ?? null,
      changeSummary: { from_warehouse_ids: before.map((r) => r.warehouse_id), to_warehouse_ids: ids },
    });
    return { warehouseIds: ids };
  });
}

function uuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
}
