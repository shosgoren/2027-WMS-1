// `withTenant(ctx, fn)` — tenant verisine tek erişim yolu (T-005b; 02 §Pooler uyumluluğu, I-02).
//
// Akış (15 §DB sözleşmesi): BEGIN → SELECT set_config('app.current_tenant_id', $1, true) →
// aynı `tx` üzerinde sorgular → COMMIT / ROLLBACK. `set_config(..., true)` transaction-local'dır:
// COMMIT/ROLLBACK sonrası bağlantıda kalmaz; transaction-mode pooler arkasında güvenlidir.
// `SET` / `SET SESSION` / `SET LOCAL` ve string birleştirme kullanılmaz; değer parametredir.
import { sql } from "drizzle-orm";
import { TenantContextError, isIssuedTenantContext, isUuid, rawDb, type TenantContext, type TenantTx } from "./client.ts";

/**
 * `fn`'i tek bir transaction içinde, tenant bağlamı kurulmuş olarak çalıştırır. `fn` yalnızca
 * `tx` alır; tüm sorgular `tx` üzerinden yapılmalıdır (global istemci lint ile yasak).
 *
 * - `ctx.tenantId` UUID değilse veya `ctx` `createTenantContext` ürünü değilse veritabanına
 *   hiçbir sorgu gönderilmeden `TenantContextError` (FORBIDDEN) ile reddedilir.
 * - `fn` (veya set_config) hata fırlatırsa transaction geri alınır ve hata AYNEN yeniden
 *   fırlatılır (G-07: yutulmaz).
 */
export async function withTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const tenantId: unknown = (ctx as { tenantId?: unknown } | null | undefined)?.tenantId;
  if (!isUuid(tenantId)) {
    throw new TenantContextError("tenant context rejected: tenantId is not a UUID");
  }
  if (!isIssuedTenantContext(ctx)) {
    throw new TenantContextError("tenant context rejected: not created by createTenantContext");
  }
  const db = rawDb(ctx.client);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * `tx` içinde kurulmuş tenant bağlamını (transaction-local ayar) okur; kurulmamış/UUID değilse `undefined`.
 * Yalnızca okur — bağlamı kuran tek yol `withTenant` ve `withMembership` ailesidir. Kuyruk bağdaştırıcısı
 * tenant kimliğini çağıran parametresinden değil buradan türetir (ADR-016 §12).
 */
export async function currentTenantId(tx: TenantTx): Promise<string | undefined> {
  const result: unknown = await tx.execute(sql`SELECT nullif(current_setting('app.current_tenant_id', true), '') AS tenant_id`);
  const rows: unknown = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
  const value = Array.isArray(rows) ? (rows[0] as { tenant_id?: unknown } | undefined)?.tenant_id : undefined;
  return isUuid(value) ? value : undefined;
}

/** `tx` içinde kurulmuş kimlik bağlamı (`app.current_user_id`); yoksa/UUID değilse `undefined`. Yalnızca okur. */
export async function currentUserId(tx: TenantTx): Promise<string | undefined> {
  const result: unknown = await tx.execute(sql`SELECT nullif(current_setting('app.current_user_id', true), '') AS user_id`);
  const rows: unknown = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
  const value = Array.isArray(rows) ? (rows[0] as { user_id?: unknown } | undefined)?.user_id : undefined;
  return isUuid(value) ? value : undefined;
}
