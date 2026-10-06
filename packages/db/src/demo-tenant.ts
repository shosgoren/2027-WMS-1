// Demo tenant kimliği ve kurulumu (T-123; ADR-016 4. tur MINOR-6, A-43).
//
// - `DEMO_TENANT_ID`: slug sabitinden (`DEMO_TENANT_SLUG`) sabit ad alanıyla türetilen UUIDv5 (RFC 9562 §5.5). Kimlik
//   iş yükünden/ortam değişkeninden ALINMAZ; worker işi ve `packages/domain/src/demo/seed.ts` aynı sabiti kullanır.
// - `ensureDemoTenant`: `is_demo=true` satırını yalnızca migration rolüyle (`wms_app` is_demo yazamaz) ve yalnızca
//   `WMS_ENV` ∈ local|staging VE `DEMO_MODE=1` iken, idempotent kurar. Üyelik/kullanıcı oluşturmaz (iş: seed.ts).
//   `slug='demo'` satırı farklı kimlikle veya `is_demo=false` ile varsa HATA (fail-closed; satıra dokunulmaz).
import { createHash } from "node:crypto";
import type { Sql } from "postgres";

export const DEMO_TENANT_SLUG = "demo";
export const DEMO_TENANT_NAME = "Demo Ambalaj A.Ş.";
/** Sabit ad alanı (rastgele üretilmiş, değişmez). Değiştirmek tüm ortamlarda demo kimliğini değiştirir. */
export const DEMO_TENANT_NAMESPACE = "5b0a7f4e-8d1c-4c8e-9a3b-2f6d1e7c4a90";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 9562 §5.5 UUIDv5 (SHA-1): ad alanı baytları + ad (UTF-8). */
export function uuidV5(name: string, namespace: string): string {
  if (!UUID_RE.test(namespace)) throw new Error("uuidV5: namespace is not a UUID");
  const ns = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = ((b[6] as number) & 0x0f) | 0x50;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const DEMO_TENANT_ID: string = uuidV5(DEMO_TENANT_SLUG, DEMO_TENANT_NAMESPACE);

export type DemoEnv = Readonly<Record<string, string | undefined>>;

/** Demo yalnızca `WMS_ENV` açıkça local|staging VE `DEMO_MODE` tam "1" iken açık; tanımsız/başka her şey kapalı. */
export function demoModeEnabled(env: DemoEnv): boolean {
  const wmsEnv = env.WMS_ENV?.trim();
  return (wmsEnv === "local" || wmsEnv === "staging") && env.DEMO_MODE?.trim() === "1";
}

export class DemoTenantError extends Error {
  override name = "DemoTenantError";
}

export type EnsureDemoTenantResult = "disabled" | "created" | "exists";

/**
 * `sql`: migration rolüyle bağlı tek bağlantı (çağıran `assertMigrationRole` ile doğrular). Kapalıysa hiçbir sorgu
 * göndermez. Tek transaction; `tenants` ve `tenant_settings` satırı `ON CONFLICT DO NOTHING` ile idempotent.
 * Ad/ayar bozulması burada onarılmaz (seed.ts onarır); yalnızca kimlik/`is_demo` tutarlılığı denetlenir.
 */
export async function ensureDemoTenant(sql: Sql, env: DemoEnv): Promise<EnsureDemoTenantResult> {
  if (!demoModeEnabled(env)) return "disabled";
  return sql.begin(async (tx): Promise<EnsureDemoTenantResult> => {
    // Tenant bağlamı transaction-local; RLS'i zorlayan (BYPASSRLS'siz) sahip rolde de INSERT geçer.
    await tx`SELECT set_config('app.current_tenant_id', ${DEMO_TENANT_ID}, true)`;
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO public.tenants (id, slug, name, is_demo)
      VALUES (${DEMO_TENANT_ID}::uuid, ${DEMO_TENANT_SLUG}, ${DEMO_TENANT_NAME}, true)
      ON CONFLICT DO NOTHING
      RETURNING id`;
    const rows = await tx<{ id: string; slug: string; is_demo: boolean }[]>`
      SELECT id, slug, is_demo FROM public.tenants WHERE slug = ${DEMO_TENANT_SLUG} OR id = ${DEMO_TENANT_ID}::uuid`;
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || row.id !== DEMO_TENANT_ID || row.slug !== DEMO_TENANT_SLUG || !row.is_demo) {
      throw new DemoTenantError("ensureDemoTenant: slug 'demo' beklenen kimlik ve is_demo=true ile bulunamadı (fail-closed)");
    }
    // Başlangıç ayarları; terminoloji/şablon/ad onarımı worker işindedir (seed.ts `reseedDemo`).
    await tx`
      INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, sector_template_key, sector_template_version, terminology, onboarding_status, onboarding_steps)
      VALUES (${DEMO_TENANT_ID}::uuid, 'tr', 'Europe/Istanbul', 'PACKAGING_SUPPLIES', 1, '{}'::jsonb, 'IN_PROGRESS', '[]'::jsonb)
      ON CONFLICT (tenant_id) DO NOTHING`;
    return inserted.length > 0 ? "created" : "exists";
  });
}
