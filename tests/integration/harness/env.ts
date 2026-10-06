// Entegrasyon testi hedef ortamı (T-005a).
//
// WMS_INT_TARGET:
//   compose (varsayılan) — global-setup repodaki docker-compose.yml'den postgres + pgbouncer'ı
//                          (transaction mode) kaldırır ve bağlantı URL'lerini ortama yazar.
//   neon                 — URL'ler dışarıdan verilir; DATABASE_URL (uygulama rolü, pooler) ve
//                          DATABASE_URL_DIRECT (migration rolü, doğrudan) ve AUTH_DATABASE_URL
//                          (kimlik rolü wms_auth, pooler) ZORUNLU. Eksikse açık
//                          hatayla düşülür; hiçbir test atlanmaz.
//
// Güvenlik (G-09): URL'ler, kullanıcı/parola log'a veya hata mesajına yazılmaz; yalnızca
// `maskHost` çıktısı kullanılır. Artefakta/konsola yazılan hata metni (ve hata zinciri) tek
// yardımcıdan geçer: `redactErrorChain` (T-005g). Uygulama testleri uygulama rolü için yalnızca DATABASE_URL'i
// kullanır; DATABASE_URL_DIRECT yalnızca migration/kurulum fikstürleri içindir (RLS bypass yolu).

export const INT_TARGETS = ["compose", "neon"] as const;
export type IntTarget = (typeof INT_TARGETS)[number];

/** Uygulama rolü adı (I-03; .env.example ve infra/postgres/init/01-roles.sh ile aynı). */
export const APP_ROLE = "wms_app";

/** Kuyruk tüketicisi rolü adı (T-115c; .env.example ve 01-roles.sh ile aynı). */
export const WORKER_ROLE = "wms_worker";

/** Kimlik rolü adı (ADR-014 §10; .env.example ve infra/postgres/init/01-roles.sh ile aynı). */
export const AUTH_ROLE = "wms_auth";

/** Kimlik yoklama işlevlerinin NOLOGIN sahibi rolü (ADR-015 §4). */
export const PROBE_ROLE = "wms_identity_probe";

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
 * Kimlik rolü (wms_auth, pooler) URL'si: AUTH_DATABASE_URL. Her iki hedefte zorunlu (compose'ta
 * global-setup yazar); yoksa/geçersizse açık hata — atlama yok (G-11). Değer hata metnine yazılmaz.
 * `readIntEnv` sözleşmesi (T-005a testleri) değişmesin diye ayrı işlevdir.
 */
export function readAuthDatabaseUrl(env: Env): string {
  const url = nonEmpty(env, "AUTH_DATABASE_URL");
  if (url === undefined) {
    const hint =
      parseTarget(env) === "neon"
        ? "WMS_INT_TARGET=neon requires AUTH_DATABASE_URL (auth role wms_auth, pooler)"
        : "compose target: written by tests/integration/harness/global-setup.ts — run via `pnpm test:int`";
    throw new IntEnvError(`missing AUTH_DATABASE_URL (${hint})`);
  }
  assertPostgresUrl("AUTH_DATABASE_URL", url);
  return url;
}

/** Worker rolü (wms_worker, pooler) URL'si: DATABASE_URL_WORKER (T-115c). Her iki hedefte zorunlu; değer hata metnine yazılmaz. */
export function readWorkerDatabaseUrl(env: Env): string {
  const url = nonEmpty(env, "DATABASE_URL_WORKER");
  if (url === undefined) {
    const hint =
      parseTarget(env) === "neon"
        ? "WMS_INT_TARGET=neon requires DATABASE_URL_WORKER (worker role wms_worker, pooler)"
        : "compose target: written by tests/integration/harness/global-setup.ts — run via `pnpm test:int`";
    throw new IntEnvError(`missing DATABASE_URL_WORKER (${hint})`);
  }
  assertPostgresUrl("DATABASE_URL_WORKER", url);
  return url;
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

/** `decodeURIComponent` bozuk kaçışta hata atar; o durumda ham değer kullanılır. */
function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Hata mesajından URL'nin hassas parçalarını (tam URL, parola, kullanıcı adı, host) çıkarır;
 * parola ve kullanıcı adı `***`, host maskeli host olur. Sürücü hataları (ör. ENOTFOUND <host>,
 * `password authentication failed for user "<kullanıcı>"`) için.
 */
export function redactUrl(message: string, url: string): string {
  let out = message.split(url).join("<url>");
  let u: URL | undefined;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  // Uzun olan önce: kısa bir parça, uzun olanın içinde kalıp onu yarım bırakmasın.
  const secrets = [u.password, decoded(u.password), u.username, decoded(u.username)]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const s of secrets) out = out.split(s).join("***");
  if (u.hostname !== "") out = out.split(u.hostname).join(maskHost(`postgres://${u.hostname}`));
  return out;
}

/** Bilinmeyen (ör. sürücünün yeniden kurduğu) bağlantı URL'leri: şema + kimlik/host bölümü. */
const ANY_PG_URL_RE = /postgres(?:ql)?:\/\/[^\s"'`<>]+/gi;

/** Hata zincirinde izlenen azami `cause` derinliği ve çıktı uzunluğu. */
export const ERROR_CHAIN_MAX_DEPTH = 5;
export const ERROR_CHAIN_MAX_LENGTH = 500;

/**
 * Int testlerinde artefakta/konsola yazılan hata metni için TEK maskeleme yardımcısı (T-005g):
 * `cause` zincirini (en çok 5 halka) `a <- b <- c` olarak birleştirir; verilen her URL için
 * `redactUrl` uygular (tam URL, kullanıcı, parola, host), ardından kalan her postgres URL'sini
 * `<url>` yapar ve 500 karakterle sınırlar. Maskeleme kesmeden ÖNCE yapılır (yarım sır kalmaz).
 */
export function redactErrorChain(e: unknown, urls: readonly string[]): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < ERROR_CHAIN_MAX_DEPTH && cur !== null && cur !== undefined; depth++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  let out = parts.join(" <- ");
  for (const url of urls) out = redactUrl(out, url);
  return out.replace(ANY_PG_URL_RE, "<url>").slice(0, ERROR_CHAIN_MAX_LENGTH);
}

/** Bir `IntEnv`'in maskelenecek URL'leri (uygulama + doğrudan). */
export function secretUrls(env: Pick<IntEnv, "databaseUrl" | "databaseUrlDirect">): readonly string[] {
  return [env.databaseUrl, env.databaseUrlDirect];
}
