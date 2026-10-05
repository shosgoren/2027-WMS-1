// Entegrasyon testi hedef ortamı (T-005a).
//
// WMS_INT_TARGET:
//   compose (varsayılan) — global-setup repodaki docker-compose.yml'den postgres + pgbouncer'ı
//                          (transaction mode) kaldırır ve bağlantı URL'lerini ortama yazar.
//   neon                 — URL'ler dışarıdan verilir; DATABASE_URL (uygulama rolü, pooler) ve
//                          DATABASE_URL_DIRECT (migration rolü, doğrudan) ZORUNLU. Eksikse açık
//                          hatayla düşülür; hiçbir test atlanmaz.
//
// Güvenlik (G-09): URL'ler, kullanıcı/parola log'a veya hata mesajına yazılmaz; yalnızca
// `maskHost` çıktısı kullanılır. Uygulama testleri uygulama rolü için yalnızca DATABASE_URL'i
// kullanır; DATABASE_URL_DIRECT yalnızca migration/kurulum fikstürleri içindir (RLS bypass yolu).

export const INT_TARGETS = ["compose", "neon"] as const;
export type IntTarget = (typeof INT_TARGETS)[number];

/** Uygulama rolü adı (I-03; .env.example ve infra/postgres/init/01-roles.sh ile aynı). */
export const APP_ROLE = "wms_app";

/** Testte PgBouncer `default_pool_size` varsayılanı (AC-05: bağlantı yeniden kullanımını zorlar). */
export const DEFAULT_INT_PGBOUNCER_POOL_SIZE = 2;

/** global-setup'ın compose hedefinde yazdığı PgBouncer yönetim konsolu URL'si (yalnızca compose). */
export const PGBOUNCER_ADMIN_URL_VAR = "WMS_INT_PGBOUNCER_ADMIN_URL";

export type Env = Readonly<Record<string, string | undefined>>;

export class IntEnvError extends Error {
  override name = "IntEnvError";
}

export interface IntEnv {
  target: IntTarget;
  /** Uygulama rolü, pooler üzerinden. */
  databaseUrl: string;
  /** Migration rolü, doğrudan. Yalnızca kurulum/migration fikstürleri kullanır. */
  databaseUrlDirect: string;
  /**
   * Teste özgü prepared statement geçersiz kılması (INT_DB_PREPARE). `undefined` → üretim
   * ayarı kullanılır (T-005b `DB_CLIENT_SETTINGS`); T-005d ölçümü için.
   */
  prepare: boolean | undefined;
}

function nonEmpty(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v;
}

/** WMS_INT_TARGET → hedef. Boş/yok → compose. Bilinmeyen değer → hata (değer yazılmaz). */
export function parseTarget(env: Env): IntTarget {
  const raw = nonEmpty(env, "WMS_INT_TARGET");
  if (raw === undefined) return "compose";
  const t = raw.trim();
  if ((INT_TARGETS as readonly string[]).includes(t)) return t as IntTarget;
  throw new IntEnvError(`WMS_INT_TARGET must be one of: ${INT_TARGETS.join(", ")}`);
}

/** INT_DB_PREPARE → `true|false`; yok/boş → undefined (üretim ayarı). */
export function parsePrepare(env: Env): boolean | undefined {
  const raw = nonEmpty(env, "INT_DB_PREPARE");
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new IntEnvError("INT_DB_PREPARE must be 'true' or 'false' (or unset to use the production setting)");
}

/** INT_PGBOUNCER_POOL_SIZE → pozitif tam sayı; yok/boş → 2. */
export function parsePoolSize(env: Env): number {
  const raw = nonEmpty(env, "INT_PGBOUNCER_POOL_SIZE");
  if (raw === undefined) return DEFAULT_INT_PGBOUNCER_POOL_SIZE;
  const v = raw.trim();
  if (!/^[1-9][0-9]{0,3}$/.test(v)) {
    throw new IntEnvError("INT_PGBOUNCER_POOL_SIZE must be a positive integer (1-9999)");
  }
  return Number(v);
}

function assertPostgresUrl(name: string, value: string): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    // Değer yazılmaz: içinde parola olabilir.
    throw new IntEnvError(`${name} is not a valid URL`);
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new IntEnvError(`${name} must use the postgres:// or postgresql:// scheme`);
  }
  if (u.hostname === "") throw new IntEnvError(`${name} has no host`);
}

/**
 * Hedef ortamını ayrıştırır. `neon`: iki URL de zorunlu; eksik olanların ADLARI hata mesajında,
 * değerleri asla. `compose`: URL'ler global-setup tarafından yazılmış olmalı.
 */
export function readIntEnv(env: Env): IntEnv {
  const target = parseTarget(env);
  const prepare = parsePrepare(env);
  const databaseUrl = nonEmpty(env, "DATABASE_URL");
  const databaseUrlDirect = nonEmpty(env, "DATABASE_URL_DIRECT");
  const missing = [
    ...(databaseUrl === undefined ? ["DATABASE_URL"] : []),
    ...(databaseUrlDirect === undefined ? ["DATABASE_URL_DIRECT"] : []),
  ];
  if (databaseUrl === undefined || databaseUrlDirect === undefined) {
    const hint =
      target === "neon"
        ? "WMS_INT_TARGET=neon requires DATABASE_URL (app role, pooler) and DATABASE_URL_DIRECT (migration role, direct)"
        : "compose target: these are written by tests/integration/harness/global-setup.ts — run via `pnpm test:int`";
    throw new IntEnvError(`missing ${missing.join(", ")} (${hint})`);
  }
  assertPostgresUrl("DATABASE_URL", databaseUrl);
  assertPostgresUrl("DATABASE_URL_DIRECT", databaseUrlDirect);
  return { target, databaseUrl, databaseUrlDirect, prepare };
}

/**
 * Log için maskeli host: ilk etiketin ilk 2 karakteri + `***` + kalan etiketler (+ port).
 * Kullanıcı, parola, veritabanı ve sorgu parametreleri asla dönmez. Çözülemezse `<invalid-url>`.
 */
export function maskHost(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "<invalid-url>";
  }
  const [first = "", ...rest] = u.hostname.split(".");
  const masked = [`${first.slice(0, 2)}***`, ...rest].join(".");
  return u.port === "" ? masked : `${masked}:${u.port}`;
}

/**
 * Hata mesajından URL'nin hassas parçalarını (tam URL, parola, kullanıcı adı dışındaki host)
 * çıkarır; host yerine maskeli host yazılır. Sürücü hataları (ör. ENOTFOUND <host>) için.
 */
export function redactUrl(message: string, url: string): string {
  let out = message.split(url).join("<url>");
  let u: URL | undefined;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  const secrets = [u.password, decodeURIComponent(u.password)].filter((s) => s.length > 0);
  for (const s of secrets) out = out.split(s).join("***");
  if (u.hostname !== "") out = out.split(u.hostname).join(maskHost(`postgres://${u.hostname}`));
  return out;
}
