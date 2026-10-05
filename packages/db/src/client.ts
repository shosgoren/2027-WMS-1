// `@wms/db/internal` — ham Drizzle istemcisi ve TenantContext oluşturucusu (T-005b).
//
// Bu alt yol YALNIZCA `packages/db/**` ve `tests/integration/**` içinden import edilebilir
// (eslint.config.mjs, no-restricted-imports). Tenant verisine erişen kod `@wms/db`'deki
// `withTenant(ctx, tx => …)`'i kullanır (02 §Pooler uyumluluğu, I-02). TenantContext yalnızca
// doğrulanmış üyelikten oluşturulur (I-01); Faz 1 kimlik modülü bu alt yolun izin listesine o
// kartta eklenir.
//
// Sürücü: postgres.js + drizzle-orm/postgres-js (Q-03 — "T-005d Neon koşusuna kadar aday").
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export interface DbClientOptions {
  /** Bağlantı URL'si. Uygulama: DATABASE_URL (uygulama rolü, pooler). Asla loglanmaz (G-09). */
  readonly url: string;
  /** Süreç başına azami fiziksel bağlantı (postgres.js `max`). */
  readonly poolMax: number;
  /** Protokol düzeyi (adlı) prepared statement (postgres.js `prepare`). */
  readonly prepare: boolean;
}

/**
 * Üretim ve test sürücü ayarlarının TEK kaynağı. URL ortamdan gelir; bu değerler kodda
 * başka yerde varsayılan olarak bulunmaz.
 *
 * - `prepare: false` — A-öneri: pooler sürümünden/ayarından bağımsız güvenli seçenek
 *   (transaction-mode pooler arkasında adlı prepared statement başka fiziksel bağlantıya
 *   düşebilir). DOĞRULANMADI: T-005d Neon pooler'ında ölçer (Q-04), T-005e kesinleştirir.
 * - `poolMax: 10` — A-öneri: postgres.js'in kendi varsayılanı, burada açıkça yazılır;
 *   gerçek değer pooler/sağlayıcı bağlantı sınırıyla T-005d/T-005e'de belirlenir.
 */
export const DB_CLIENT_SETTINGS: Readonly<Pick<DbClientOptions, "poolMax" | "prepare">> = Object.freeze({
  poolMax: 10,
  prepare: false,
});

/** Ham Drizzle veritabanı (postgres.js). Yalnızca `packages/db` içinde kullanılır. */
export type DrizzleDb = ReturnType<typeof createDrizzle>;

/** Tenant transaction'ı: `withTenant` callback'inin aldığı tek erişim yolu. */
export type TenantTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

declare const dbClientBrand: unique symbol;

/**
 * Opak istemci tutamacı. Sorgu yöntemi YOKTUR: tenant verisine yalnızca `withTenant` ile,
 * ham Drizzle'a yalnızca `rawDb` (bu alt yol) ile erişilir. ADR-003: global istemciyle
 * transaction dışı sorgu riskini tip düzeyinde kapatır.
 */
export interface DbClient {
  readonly [dbClientBrand]: true;
  /** Havuzu kapatır; bekleyen sorgular tamamlanır (postgres.js `sql.end()`). */
  close(): Promise<void>;
}

export class DbClientConfigError extends Error {
  override name = "DbClientConfigError";
}

const rawByClient = new WeakMap<DbClient, DrizzleDb>();

function createDrizzle(sql: postgres.Sql) {
  return drizzle({ client: sql });
}

/**
 * Havuz + Drizzle istemcisi. `url`, `poolMax`, `prepare` zorunludur; varsayılan yok.
 * Bağlantı tembeldir: ilk sorguya kadar ağ erişimi olmaz (postgres.js).
 * Hata mesajları URL değerini içermez (G-09).
 */
export function createDbClient(options: DbClientOptions): DbClient {
  const { url, poolMax, prepare } = options;
  if (typeof url !== "string" || url.trim() === "") {
    throw new DbClientConfigError("createDbClient: url is required");
  }
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new DbClientConfigError("createDbClient: url is not a valid URL");
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new DbClientConfigError("createDbClient: url must use the postgres:// or postgresql:// scheme");
  }
  if (!Number.isInteger(poolMax) || poolMax < 1) {
    throw new DbClientConfigError("createDbClient: poolMax must be a positive integer");
  }
  if (typeof prepare !== "boolean") {
    throw new DbClientConfigError("createDbClient: prepare must be a boolean");
  }

  const sql = postgres(url, { max: poolMax, prepare });
  const handle = Object.freeze({
    close: () => sql.end(),
  }) as unknown as DbClient;
  rawByClient.set(handle, createDrizzle(sql));
  return handle;
}

/** Tutamacın ham Drizzle istemcisi. Tutamaç `createDbClient`'tan gelmediyse hata. */
export function rawDb(client: DbClient): DrizzleDb {
  const db = rawByClient.get(client);
  if (db === undefined) {
    throw new DbClientConfigError("rawDb: not a DbClient created by createDbClient");
  }
  return db;
}

// ---------------------------------------------------------------------------------------------
// TenantContext (I-01, I-02)
// ---------------------------------------------------------------------------------------------

declare const tenantContextBrand: unique symbol;

/**
 * Doğrulanmış üyelikten gelen tenant bağlamı. Markalıdır: nesne literaliyle oluşturulamaz;
 * yalnızca `createTenantContext` üretir ve çalışma anında da `withTenant` bunu denetler.
 */
export interface TenantContext {
  readonly [tenantContextBrand]: true;
  readonly tenantId: string;
  readonly client: DbClient;
}

/** Tenant bağlamı eksik/geçersiz → ret (I-02). Kod: 15 §Hata kodları `FORBIDDEN`. */
export class TenantContextError extends Error {
  override name = "TenantContextError";
  readonly code = "FORBIDDEN";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const issuedContexts = new WeakSet<object>();

/**
 * Doğrulanmış üyelikten tenant bağlamı oluşturur (I-01: çağıran üyeliği doğrulamış olmalıdır;
 * istemcinin gönderdiği tenant_id tek başına yeterli değildir). `tenantId` kanonik UUID değilse
 * veya `client` bir `DbClient` değilse ret.
 */
export function createTenantContext(client: DbClient, tenantId: string): TenantContext {
  if (!isUuid(tenantId)) {
    throw new TenantContextError("tenant context rejected: tenantId is not a UUID");
  }
  rawDb(client);
  const ctx = Object.freeze({ tenantId, client }) as unknown as TenantContext;
  issuedContexts.add(ctx);
  return ctx;
}

/** `createTenantContext` tarafından üretilmiş bağlam mı (çalışma anı marka denetimi). */
export function isIssuedTenantContext(ctx: unknown): ctx is TenantContext {
  return typeof ctx === "object" && ctx !== null && issuedContexts.has(ctx);
}
