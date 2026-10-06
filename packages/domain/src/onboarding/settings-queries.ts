// Ayarlar sayfası salt okunur sorgusu (T-122a). Yazma: `updateTenantSettings` (workspace.ts).
// Web tablo erişimi olmadan (T-127a) yalnızca bu okuyucuyu çağırır; `runTenantQuery` (üyelik + izin + MFA + RLS).
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery, type TenantAccessParams } from "../identity/access.ts";

export interface TenantSettingsView {
  readonly name: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly slug: string;
}

/** Ayar formu verisi; izin `settings.manage` (yetkisiz → FORBIDDEN). */
export async function getTenantSettings(params: Omit<TenantAccessParams, "permission" | "recentAuth">): Promise<TenantSettingsView> {
  return runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, membership) => {
    const rows = await tx.execute<{ name: string; slug: string; locale: string; time_zone: string }>(
      sql`SELECT t.name, t.slug, s.locale, s.time_zone
            FROM public.tenants t JOIN public.tenant_settings s ON s.tenant_id = t.id
           WHERE t.id = ${membership.tenantId}::uuid`,
    );
    const r = rows[0];
    if (r === undefined) throw new AppError("NOT_FOUND");
    return { name: r.name, locale: r.locale, timeZone: r.time_zone, slug: r.slug };
  });
}
