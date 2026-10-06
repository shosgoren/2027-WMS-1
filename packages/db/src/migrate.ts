// Migration koşturucusu (T-101, ADR-015): `NNNN_<ad>.up.sql` / `.down.sql` çiftleri, özetli defter
// `wms_meta.schema_migrations`, `pg_advisory_xact_lock` ile tek koşu, yalnızca doğrudan bağlantı
// (`DATABASE_URL_DIRECT`, migration rolü).
//
// CLI (doğrudan çalıştırılınca): `node src/migrate.ts up` | `node src/migrate.ts down --to NNNN`.
// `--to NNNN`: sürümü NNNN'den BÜYÜK olan uygulanmış migration'lar geri alınır; `--to 0000` hepsini.
//
// Güvenlik (G-09): URL ve parola hiçbir çıktıya/hata mesajına yazılmaz.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Uygulama rolü adı; koşturucu bu rolle çalışmayı reddeder (I-03). */
export const APP_ROLE_NAME = "wms_app";

/**
 * Bilinen uygulama rolleri (ad listesi): koşturucu bunlardan biriyle bağlanmayı reddeder (I-03).
 * Yeni bir uygulama rolü eklendiğinde bu liste güncellenir.
 */
export const APP_ROLE_NAMES: readonly string[] = [APP_ROLE_NAME, "wms_auth", "wms_identity_probe"];

/**
 * Rol-bağımsız (veritabanı/küme düzeyi) `ALTER DATABASE ... SET` ayarlarından izinli olanlar. Boş: her yeni
 * bağlantıya (uygulama rolleri dahil) sızan her ayar ret (`session_replication_role`, `search_path`,
 * `default_transaction_read_only`, `role`, `app.*` …). Zararsız bir ayar gerekirse gerekçesiyle eklenir.
 */
export const ALLOWED_DB_LEVEL_SETTINGS: readonly string[] = [];

/** Sahiplik denetimi kapsamı: probe rolü (ADR-016) meşru işlev sahibidir, bu yüzden dışarıda. */
export const OWNERSHIP_ROLE_NAMES: readonly string[] = [APP_ROLE_NAME, "wms_auth"];

/** Migration oturumunda boş kalması gereken bilinen `app.*` ayarları (G-02: tenant bağlamı). */
export const KNOWN_APP_SETTINGS: readonly string[] = ["app.current_tenant_id"];

/**
 * Kilit bekleme üst sınırı (ADR-015 §3): eşzamanlı koşucu veya uzun süren bir oturum migration'ı
 * sonsuza dek bekletmesin; aşılırsa `SET LOCAL lock_timeout` PostgreSQL hatasıyla transaction geri alınır.
 */
export const LOCK_TIMEOUT = "60s";

/** Koşu kilidi: `pg_advisory_xact_lock` anahtarı (tek yerde tanımlı; testler aynı ifadeyi kullanır). */
export const LOCK_KEY_SQL = "hashtextextended('wms:migrate', 0)";

/** `down` yalnızca bu `WMS_ENV` değerlerinde çalışır. */
export const ROLLBACK_ENVS: readonly string[] = ["local", "ci", "staging"];
/** Veri kaybettiren down'a izin ayarı yalnızca bu ortamlarda açılır (ADR-015 §9). */
export const DESTRUCTIVE_DOWN_ENVS: readonly string[] = ["local", "ci"];

export type MigrationErrorCode =
  | "MIGRATION_BAD_FILENAME"
  | "MIGRATION_UNPAIRED_FILE"
  | "MIGRATION_DUPLICATE_VERSION"
  | "MIGRATION_VERSION_GAP"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_UNKNOWN_APPLIED"
  | "MIGRATION_LEDGER_GAP"
  | "MIGRATION_WRONG_ROLE"
  | "MIGRATION_POOLER_URL"
  | "MIGRATION_SESSION_STATE"
  | "MIGRATION_APP_OWNERSHIP"
  | "MIGRATION_NO_URL"
  | "MIGRATION_ENV_FORBIDDEN"
  | "MIGRATION_BAD_ARGS"
  | "MIGRATION_BAD_TARGET";

export class MigrationError extends Error {
  override name = "MigrationError";
  readonly code: MigrationErrorCode;
  constructor(code: MigrationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface Migration {
  /** Dört haneli sürüm, ör. "0001". */
  readonly version: string;
  readonly name: string;
  readonly up: Buffer;
  readonly down: Buffer;
  /** sha256(up || 0x00 || down), onaltılık. */
  readonly checksum: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.(up|down)\.sql$/;

export interface MigrationFilePair {
  readonly version: string;
  readonly name: string;
  readonly upFile: string;
  readonly downFile: string;
}

/**
 * Dosya adlarını up/down çiftlerine eşler ve numara kurallarını denetler: çiftsiz dosya, aynı
 * numarada farklı ad, numara boşluğu (0001'den başlayıp ardışık olmalı), geçersiz ad → hata.
 * Nokta ile başlayan gizli dosyalar yok sayılır.
 */
export function matchMigrationFiles(fileNames: readonly string[]): MigrationFilePair[] {
  const byVersion = new Map<string, { name: string; up?: string; down?: string }>();
  for (const file of fileNames) {
    if (file.startsWith(".")) continue;
    const m = FILE_RE.exec(file);
    if (m === null) {
      throw new MigrationError("MIGRATION_BAD_FILENAME", `"${file}" NNNN_<snake_ad>.up.sql / .down.sql biçiminde değil`);
    }
    const version = m[1] as string;
    const name = m[2] as string;
    const kind = m[3] as "up" | "down";
    const entry = byVersion.get(version);
    if (entry === undefined) {
      byVersion.set(version, { name, [kind]: file });
      continue;
    }
    if (entry.name !== name) {
      throw new MigrationError("MIGRATION_DUPLICATE_VERSION", `sürüm ${version} birden çok adla var ("${entry.name}", "${name}")`);
    }
    if (entry[kind] !== undefined) {
      throw new MigrationError("MIGRATION_DUPLICATE_VERSION", `sürüm ${version} için ${kind} dosyası yinelenmiş`);
    }
    entry[kind] = file;
  }
  const versions = [...byVersion.keys()].sort();
  const pairs: MigrationFilePair[] = [];
  versions.forEach((version, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (version !== expected) {
      throw new MigrationError("MIGRATION_VERSION_GAP", `beklenen sürüm ${expected}, bulunan ${version} (numara boşluğu)`);
    }
    const e = byVersion.get(version) as { name: string; up?: string; down?: string };
    if (e.up === undefined || e.down === undefined) {
      throw new MigrationError("MIGRATION_UNPAIRED_FILE", `sürüm ${version} (${e.name}) için ${e.up === undefined ? "up" : "down"} dosyası yok`);
    }
    pairs.push({ version, name: e.name, upFile: e.up, downFile: e.down });
  });
  return pairs;
}

/** Özet: `.up.sql` ve `.down.sql` birlikte (ADR-015 §2). Ayırıcı bayt belirsizliği önler. */
export function computeChecksum(up: Uint8Array, down: Uint8Array): string {
  return createHash("sha256").update(up).update(Uint8Array.of(0)).update(down).digest("hex");
}

/** Dizindeki migration çiftlerini okur ve doğrular. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const pairs = matchMigrationFiles(readdirSync(dir));
  return pairs.map((p) => {
    const up = readFileSync(path.join(dir, p.upFile));
    const down = readFileSync(path.join(dir, p.downFile));
    return { version: p.version, name: p.name, up, down, checksum: computeChecksum(up, down) };
  });
}

// ---------------------------------------------------------------------------------------------
// Koşu
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  /** Doğrudan bağlantı URL'si (migration rolü). Asla yazdırılmaz. */
  readonly url: string;
  readonly dir?: string;
  /** `WMS_ENV`; yalnızca `down` için zorunlu. */
  readonly wmsEnv?: string | undefined;
}

export interface UpResult {
  readonly applied: readonly string[];
  /** Koşunun sonunda uygulanmış toplam migration sayısı. */
  readonly totalApplied: number;
}

export interface DownResult {
  readonly reverted: readonly string[];
}

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
interface LedgerRow {
  version: string;
  name: string;
  checksum_sha256: string;
}

export interface ConnectionTarget {
  /** Sürücünün gerçekten bağlanacağı her host:port çifti. Loopback adları tek biçime indirgenir. */
  readonly hosts: readonly { host: string; port: string }[];
  readonly user: string;
  readonly db: string;
  /** URL sorgusunda izin listesi dışı parametre var (`user`, `database`, `options`, `host`, `port`, bilinmeyen …): StartupMessage/hedef ezilebilir. */
  readonly hasUnsafeQuery: boolean;
}

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];
/** Sürücünün çözdüğü host yalnızca bu karakterlerden oluşabilir (IPv6 `[::1]` sürücüde `[` olarak bozulur → ret). */
/** Bağlantı URL sorgusunda kabul edilen anahtarlar: `sslmode`, `ssl*` ve `application_name`. */
const SAFE_QUERY_KEY_RE = /^(?:ssl[a-z_]*|application_name)$/;
const HOST_NAME_RE = /^[a-z0-9._-]+$/;

/**
 * Bağlantı hedefi — SÜRÜCÜNÜN çözdüğü değerlerle (postgres.js 3.4.9 `options`; bağlantı açılmaz, kullanıcı/
 * veritabanı/`PGHOST`/`PGPORT`/`PGUSER`/`PGUSERNAME` geri düşüşleri sürücüyle birebir aynı). Ayrıştırıcı
 * farkını (sürücü yetkiyi İLK `@`'ten, `#`'i host'a dahil sayar) kapatmak için önce katı ön denetim:
 * yetki bölümünde birden fazla `@` veya herhangi bir `#`, postgres(ql) dışı şema, sürücünün
 * ayrıştıramadığı URL, host adı olmayan/IPv6/unix soket hedefi ya da geçersiz port → `undefined` (çağıran ret).
 */
export function parseTarget(url: string): ConnectionTarget | undefined {
  const trimmed = url.trim();
  const m = /^postgres(?:ql)?:\/\/([^/?]*)(?:[/?]|$)/i.exec(trimmed);
  if (m === null || trimmed.includes("#")) return undefined;
  if (((m[1] ?? "").match(/@/g) ?? []).length > 1) return undefined;
  let o: postgres.ParsedOptions;
  try {
    // Bağlantı kurulmaz (sürücü tembeldir); soket/zamanlayıcı oluşmaz.
    o = postgres(trimmed).options;
  } catch {
    return undefined;
  }
  const sockPath: unknown = o.path;
  if (sockPath !== false && sockPath !== undefined && sockPath !== "") return undefined;
  if (o.host.length === 0 || o.host.length !== o.port.length) return undefined;
  const hosts: { host: string; port: string }[] = [];
  for (let i = 0; i < o.host.length; i++) {
    let host = String(o.host[i]).toLowerCase();
    const port = o.port[i] as number;
    if (!HOST_NAME_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    if (LOOPBACK_HOSTS.includes(host)) host = "loopback";
    hosts.push({ host, port: String(port) });
  }
  const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : "";
  // İzin listesi (sürücü sorgu parametrelerini options.connection'a taşır ve `user`/`database`/`options`
  // gibi anahtarlar StartupMessage'ı ezer): yalnızca TLS ve application_name. Anahtar çözülmüş haliyle,
  // büyük/küçük harf duyarlı karşılaştırılır (`%75ser`, `User` da ret).
  const hasUnsafeQuery = [...new URLSearchParams(query).keys()].some((k) => !SAFE_QUERY_KEY_RE.test(k));
  return { hosts, user: String(o.user), db: String(o.database), hasUnsafeQuery };
}

/**
 * İki URL aynı sunucu+kullanıcı+veritabanına işaret edebilir mi? Fail-closed: ayrıştırılamayan,
 * izin listesi dışı sorgu parametreli veya host listeleri kesişen çiftte `true` (ret). `localhost`/`127.0.0.1` eşdeğer.
 */
export function sameConnectionTarget(a: string, b: string): boolean {
  const ta = parseTarget(a);
  const tb = parseTarget(b);
  if (ta === undefined || tb === undefined || ta.hasUnsafeQuery || tb.hasUnsafeQuery) return true;
  if (ta.user !== tb.user || ta.db !== tb.db) return false;
  return ta.hosts.some((x) => tb.hosts.some((y) => x.host === y.host && x.port === y.port));
}

/**
 * Pooler'sız TEK host'lu doğrudan bağlantı zorunlu: Neon `-pooler` host'u, yerel PgBouncer 6432,
 * çok host'lu veya ayrıştırılamayan/belirsiz URL → ret (fail-closed; advisory lock/oturum durumu).
 */
function assertDirectUrl(url: string): void {
  const t = parseTarget(url);
  if (t === undefined || t.hasUnsafeQuery || t.hosts.length !== 1) {
    throw new MigrationError(
      "MIGRATION_POOLER_URL",
      "DATABASE_URL_DIRECT ayrıştırılamadı, çok host'lu veya izin listesi dışı sorgu parametresi içeriyor (yalnızca sslmode/ssl*/application_name); tek host'lu doğrudan bağlantı gerekir",
    );
  }
  const only = t.hosts[0] as { host: string; port: string };
  if (only.port === "6432" || only.host.includes("-pooler")) {
    throw new MigrationError(
      "MIGRATION_POOLER_URL",
      "DATABASE_URL_DIRECT pooler'a işaret ediyor; migration yalnızca doğrudan bağlantıyla çalışır (advisory lock/oturum durumu)",
    );
  }
}

function connect(url: string): Sql {
  if (typeof url !== "string" || url.trim() === "") {
    throw new MigrationError("MIGRATION_NO_URL", "DATABASE_URL_DIRECT tanımlı değil");
  }
  assertDirectUrl(url);
  return postgres(url, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connection: { application_name: "wms-migrate" },
  });
}

/** Bağlantı rolü bilinen bir uygulama rolü değilse oturum kullanıcı adını döndürür; aksi halde ret. */
async function assertMigrationRole(sql: Sql): Promise<string> {
  const rows = await sql<{ current_user: string; session_user: string }[]>`
    SELECT current_user::text AS current_user, session_user::text AS session_user`;
  const r = rows[0];
  if (
    r === undefined ||
    r.current_user !== r.session_user ||
    APP_ROLE_NAMES.includes(r.current_user) ||
    APP_ROLE_NAMES.includes(r.session_user)
  ) {
    throw new MigrationError(
      "MIGRATION_WRONG_ROLE",
      `migration uygulama rolüyle (${APP_ROLE_NAMES.join("|")}) çalıştırılamaz; DATABASE_URL_DIRECT migration rolüne işaret etmeli`,
    );
  }
  return r.session_user;
}

type Phase = "başlangıç" | "transaction içi" | "commit sonrası";

function stateViolation(version: string, phase: Phase, what: string): MigrationError {
  const tail =
    phase === "commit sonrası"
      ? "migration commit edildi ve defter yazıldı, koşu durduruldu, bağlantı atıldı: değişikliği gözden geçirin"
      : phase === "başlangıç"
        ? "hiçbir şey uygulanmadı"
        : "geri alındı";
  return new MigrationError("MIGRATION_SESSION_STATE", `migration ${version} oturum durumu: ${what} [${phase}]; ${tail}`);
}

/** Oturum düzeyi ayarların MUTLAK beklenen değerleri (taban çizgisi yok: başlangıçtaki sapma da ret). */
export const EXPECTED_SESSION_SETTINGS = {
  search_path: '"$user", public',
  replication_role: "origin",
  read_only: "off",
} as const;

/**
 * Transaction İÇİNDE, defter yazımından ÖNCE (fail-closed; ihlalde transaction geri alınır): rol /
 * oturum kullanıcısı ve bilinen `app.*` ayarları. `SET LOCAL` ile maskelenmiş OTURUM düzeyi değer
 * burada görünmez; onu `assertSessionStateClean` yakalar.
 */
async function assertSessionClean(tx: Tx, expectedUser: string, version: string): Promise<void> {
  const rows = await tx<{ cu: string; su: string; role: string; leaked: string[] }[]>`
    SELECT current_user::text AS cu, session_user::text AS su, current_setting('role') AS role,
           coalesce((SELECT array_agg(DISTINCT n ORDER BY n) FROM (
                       SELECT unnest(${KNOWN_APP_SETTINGS as string[]}::text[]) AS n
                       UNION SELECT name FROM pg_catalog.pg_settings WHERE name LIKE 'app.%') AS k
                      WHERE coalesce(current_setting(n, true), '') <> ''), '{}') AS leaked`;
  const r = rows[0];
  if (r === undefined || r.cu !== expectedUser || r.su !== expectedUser || r.role !== "none" || r.leaked.length > 0) {
    throw stateViolation(version, "transaction içi", "migration rol/oturum kullanıcısı veya app.* ayarını değiştirdi");
  }
}

interface SessionState {
  cu: string;
  su: string;
  role: string;
  search_path: string;
  replication_role: string;
  read_only: string;
  leaked: string[];
  temp_relations: number;
  prepared: number;
  listening: number;
  advisory: number;
}

/** Oturum düzeyi durum (transaction DIŞINDA okunur: yalnızca commit'ten sağ çıkan değerler görünür). */
async function readSessionState(sql: Sql): Promise<SessionState> {
  const rows = await sql<SessionState[]>`
    SELECT current_user::text AS cu, session_user::text AS su, current_setting('role') AS role,
           current_setting('search_path') AS search_path,
           current_setting('session_replication_role') AS replication_role,
           current_setting('default_transaction_read_only') AS read_only,
           coalesce((SELECT array_agg(DISTINCT n ORDER BY n) FROM (
                       SELECT unnest(${KNOWN_APP_SETTINGS as string[]}::text[]) AS n
                       UNION SELECT name FROM pg_catalog.pg_settings WHERE name LIKE 'app.%') AS k
                      WHERE coalesce(current_setting(n, true), '') <> ''), '{}') AS leaked,
           (SELECT count(*) FROM pg_catalog.pg_class
             WHERE relnamespace = pg_catalog.pg_my_temp_schema() AND relkind IN ('r','p','v','m','S','f'))::int AS temp_relations,
           (SELECT count(*) FROM pg_catalog.pg_prepared_statements)::int AS prepared,
           (SELECT count(*) FROM pg_catalog.pg_listening_channels())::int AS listening,
           (SELECT count(*) FROM pg_catalog.pg_locks
             WHERE pid = pg_catalog.pg_backend_pid() AND locktype = 'advisory' AND granted)::int AS advisory`;
  return rows[0] as SessionState;
}

/**
 * Oturum durumu MUTLAK olarak temiz olmalı: başlangıçta (`phase="başlangıç"`, sapma = ret) ve migration
 * COMMIT edildikten sonra aynı bağlantıda (`set_config(...,false)` / `SET ROLE` gibi oturum düzeyi
 * değişiklikler `SET LOCAL` ile maskelense de burada görünür).
 */
function assertSessionStateClean(state: SessionState, expectedUser: string, version: string, phase: Phase): void {
  const problems: string[] = [];
  if (state.cu !== expectedUser || state.su !== expectedUser) problems.push("rol/oturum kullanıcısı");
  if (state.role !== "none") problems.push("SET ROLE");
  if (state.leaked.length > 0) problems.push("app.* ayarı");
  if (state.search_path !== EXPECTED_SESSION_SETTINGS.search_path) problems.push("search_path");
  if (state.replication_role !== EXPECTED_SESSION_SETTINGS.replication_role) problems.push("session_replication_role");
  if (state.read_only !== EXPECTED_SESSION_SETTINGS.read_only) problems.push("default_transaction_read_only");
  if (state.temp_relations !== 0) problems.push("geçici tablo");
  if (state.prepared !== 0) problems.push("PREPARE");
  if (state.listening !== 0) problems.push("LISTEN");
  if (state.advisory !== 0) problems.push("oturum advisory kilidi");
  if (problems.length > 0) throw stateViolation(version, phase, problems.join(", "));
}

const OWNED_CATALOGS_SQL = `
  WITH app_roles AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[]))
  SELECT cat FROM (
    SELECT 'pg_class' AS cat, count(*) AS n FROM pg_catalog.pg_class WHERE relowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_namespace', count(*) FROM pg_catalog.pg_namespace WHERE nspowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_proc', count(*) FROM pg_catalog.pg_proc WHERE proowner IN (SELECT oid FROM app_roles)
    -- Tablo satır tipleri (ilgili pg_class sayılıyor) ve dizi tipleri hariç; dizi tabanlı DOMAIN'ler
    -- (typtype='d') ve aralık/çoklu aralık tipleri dahil.
    UNION ALL SELECT 'pg_type', count(*) FROM pg_catalog.pg_type
      WHERE typowner IN (SELECT oid FROM app_roles) AND typrelid = 0 AND NOT (typtype = 'b' AND typelem <> 0)
    UNION ALL SELECT 'pg_database', count(*) FROM pg_catalog.pg_database WHERE datdba IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_operator', count(*) FROM pg_catalog.pg_operator WHERE oprowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_opclass', count(*) FROM pg_catalog.pg_opclass WHERE opcowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_opfamily', count(*) FROM pg_catalog.pg_opfamily WHERE opfowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_collation', count(*) FROM pg_catalog.pg_collation WHERE collowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_conversion', count(*) FROM pg_catalog.pg_conversion WHERE conowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_ts_config', count(*) FROM pg_catalog.pg_ts_config WHERE cfgowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_ts_dict', count(*) FROM pg_catalog.pg_ts_dict WHERE dictowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_extension', count(*) FROM pg_catalog.pg_extension WHERE extowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_event_trigger', count(*) FROM pg_catalog.pg_event_trigger WHERE evtowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_publication', count(*) FROM pg_catalog.pg_publication WHERE pubowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_subscription', count(*) FROM pg_catalog.pg_subscription WHERE subowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_largeobject_metadata', count(*) FROM pg_catalog.pg_largeobject_metadata WHERE lomowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_foreign_data_wrapper', count(*) FROM pg_catalog.pg_foreign_data_wrapper WHERE fdwowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_foreign_server', count(*) FROM pg_catalog.pg_foreign_server WHERE srvowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_statistic_ext', count(*) FROM pg_catalog.pg_statistic_ext WHERE stxowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_language', count(*) FROM pg_catalog.pg_language WHERE lanowner IN (SELECT oid FROM app_roles)
    UNION ALL SELECT 'pg_default_acl', count(*) FROM pg_catalog.pg_default_acl WHERE defaclrole IN (SELECT oid FROM app_roles)
  ) c WHERE n > 0 ORDER BY cat`;

/**
 * Koşturucu sonrası sahiplik denetimi (T-101d, MINOR 7; ADR-015 §4 "hiçbir nesnenin sahibi değildir"):
 * her up migration'dan sonra, defter yazımından ÖNCE, uygulama rollerinin (`wms_app`, `wms_auth`;
 * probe rolü meşru işlev sahibidir) hiçbir katalogda sahip olmadığını doğrular. 0001'in kendi
 * denetimi uygulanmış özet olduğundan değiştirilmez; boşlukları (dizi tabanlı domain, pg_operator,
 * pg_collation, pg_ts_*, pg_extension, pg_event_trigger, pg_publication, pg_largeobject_metadata …)
 * bu denetim kapatır ve gelecekteki her migration'ı da kapsar. İhlalde transaction geri alınır.
 */
async function assertNoAppOwnership(tx: Tx, version: string): Promise<void> {
  const problems: string[] = [];
  const rows = await tx.unsafe<{ cat: string }[]>(OWNED_CATALOGS_SQL, [OWNERSHIP_ROLE_NAMES as string[]]);
  if (rows.length > 0) problems.push(`nesne sahibi: ${rows.map((x) => x.cat).join(", ")}`);

  // Rol nitelikleri/üyelikler her migration sonrası yeniden denetlenir (migration bunları gevşetmiş olabilir):
  // sahiplik istisnası yalnızca probe için; nitelik/üyelik üç uygulama rolünün hepsinde denetlenir. Rol henüz
  // yaratılmamışsa satır dönmez (denetlenecek nitelik yok), hata da verilmez.
  const attrs = await tx<{ rolname: string; why: string }[]>`
    SELECT r.rolname::text AS rolname,
           concat_ws(',',
             CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
             CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END,
             CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
             CASE WHEN r.rolcreatedb THEN 'CREATEDB' END,
             CASE WHEN r.rolreplication THEN 'REPLICATION' END,
             CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) THEN 'ROL ÜYELİĞİ' END) AS why
      FROM pg_catalog.pg_roles r WHERE r.rolname = ANY (${APP_ROLE_NAMES as string[]}::text[])`;
  for (const a of attrs) if (a.why !== "") problems.push(`${a.rolname}: ${a.why}`);

  // Rol/veritabanı düzeyinde ayarlar (ALTER ROLE/DATABASE ... SET): uygulama rollerinde HİÇBİRİ olamaz;
  // rol-bağımsız (veritabanı/küme düzeyi, setrole=0) ayarlarda yalnızca ALLOWED_DB_LEVEL_SETTINGS izinlidir.
  const settings = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_catalog.pg_db_role_setting s
     WHERE s.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
       AND (s.setrole IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY (${APP_ROLE_NAMES as string[]}::text[]))
            OR (s.setrole = 0
                AND EXISTS (SELECT 1 FROM unnest(s.setconfig) c
                             WHERE split_part(c, '=', 1) <> ALL (${ALLOWED_DB_LEVEL_SETTINGS as string[]}::text[]))))`;
  if ((settings[0]?.n ?? 0) > 0) problems.push("pg_db_role_setting (uygulama rolü ayarı veya izinsiz veritabanı/küme düzeyi ayar)");

  if (problems.length > 0) {
    throw new MigrationError(
      "MIGRATION_APP_OWNERSHIP",
      `migration ${version} sonrası uygulama rolü/ayar denetimi başarısız (${OWNERSHIP_ROLE_NAMES.join("|")}): ${problems.join("; ")}; geri alındı (I-03)`,
    );
  }
}

/** Kilit alındıktan SONRA defteri (yoksa oluşturarak) okur ve özetleri/sırayı doğrular. */
async function lockAndReadLedger(tx: Tx, migrations: readonly Migration[]): Promise<LedgerRow[]> {
  await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  await tx.unsafe(`SELECT pg_advisory_xact_lock(${LOCK_KEY_SQL})`);
  await tx.unsafe(`
    CREATE SCHEMA IF NOT EXISTS wms_meta;
    CREATE TABLE IF NOT EXISTS wms_meta.schema_migrations (
      version         text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
      name            text NOT NULL,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      applied_at      timestamptz NOT NULL DEFAULT now(),
      applied_by      text NOT NULL DEFAULT session_user
    )`);
  const rows = await tx<LedgerRow[]>`
    SELECT version, name, checksum_sha256 FROM wms_meta.schema_migrations ORDER BY version`;
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  rows.forEach((row, index) => {
    const file = byVersion.get(row.version);
    if (file === undefined) {
      throw new MigrationError("MIGRATION_UNKNOWN_APPLIED", `uygulanmış sürüm ${row.version} için dosya yok`);
    }
    if (file.checksum !== row.checksum_sha256 || file.name !== row.name) {
      throw new MigrationError(
        "MIGRATION_CHECKSUM_MISMATCH",
        `uygulanmış sürüm ${row.version} (${row.name}) dosyası değişmiş; hiçbir şey uygulanmadı`,
      );
    }
    const expected = String(index + 1).padStart(4, "0");
    if (row.version !== expected) {
      throw new MigrationError("MIGRATION_LEDGER_GAP", `defterde beklenen sürüm ${expected}, bulunan ${row.version}`);
    }
  });
  return rows;
}

/**
 * Her migration AYRI bağlantıda koşar (oturum durumu bir sonrakine taşınamaz); transaction içi ve
 * commit sonrası oturum denetimleri aynı bağlantıda yapılır.
 */
async function runOne<T>(
  url: string,
  body: (tx: Tx, expectedUser: string) => Promise<{ value: T; version: string } | undefined>,
): Promise<T | undefined> {
  const sql = connect(url);
  try {
    const expectedUser = await assertMigrationRole(sql);
    assertSessionStateClean(await readSessionState(sql), expectedUser, "(başlangıç)", "başlangıç");
    const result = await sql.begin((tx) => body(tx, expectedUser));
    if (result === undefined) return undefined;
    assertSessionStateClean(await readSessionState(sql), expectedUser, result.version, "commit sonrası");
    return result.value;
  } finally {
    await sql.end();
  }
}

/** Bekleyen migration'ları sırayla uygular; her biri tek transaction ve ayrı bağlantıdır. */
export async function migrateUp(options: RunOptions): Promise<UpResult> {
  const migrations = loadMigrations(options.dir);
  const applied: string[] = [];
  let totalApplied = 0;
  for (;;) {
    const next = await runOne(options.url, async (tx, expectedUser) => {
      const ledger = await lockAndReadLedger(tx, migrations);
      totalApplied = ledger.length;
      const pending = migrations[ledger.length];
      if (pending === undefined) return undefined;
      await tx.unsafe(pending.up.toString("utf8"));
      await assertSessionClean(tx, expectedUser, pending.version);
      await assertNoAppOwnership(tx, pending.version);
      await tx`
        INSERT INTO wms_meta.schema_migrations (version, name, checksum_sha256)
        VALUES (${pending.version}, ${pending.name}, ${pending.checksum})`;
      return { value: pending.version, version: pending.version };
    });
    if (next === undefined) break;
    applied.push(next);
    totalApplied += 1;
  }
  return { applied, totalApplied };
}

/** Sürümü `to`'dan büyük olan uygulanmış migration'ları sondan başa geri alır. */
export async function migrateDown(options: RunOptions & { readonly to: string }): Promise<DownResult> {
  const env = options.wmsEnv;
  if (env === undefined || !ROLLBACK_ENVS.includes(env)) {
    throw new MigrationError("MIGRATION_ENV_FORBIDDEN", `geri alma yalnızca WMS_ENV ∈ ${ROLLBACK_ENVS.join("|")} iken çalışır`);
  }
  if (!/^\d{4}$/.test(options.to)) {
    throw new MigrationError("MIGRATION_BAD_TARGET", "--to dört haneli sürüm olmalı (0000 = hepsi)");
  }
  const migrations = loadMigrations(options.dir);
  if (options.to !== "0000" && !migrations.some((m) => m.version === options.to)) {
    throw new MigrationError("MIGRATION_BAD_TARGET", `--to ${options.to} bilinen bir sürüm değil`);
  }
  const allowDestructive = DESTRUCTIVE_DOWN_ENVS.includes(env);
  const reverted: string[] = [];
  for (;;) {
    const done = await runOne(options.url, async (tx, expectedUser) => {
      const ledger = await lockAndReadLedger(tx, migrations);
      const last = ledger[ledger.length - 1];
      if (last === undefined || last.version <= options.to) return undefined;
      const target = migrations.find((m) => m.version === last.version) as Migration;
      // Ayar yalnızca local|ci'da ve transaction-local açılır; diğerlerinde açıkça kapalı.
      await tx`SELECT set_config('wms_meta.allow_destructive_down', ${allowDestructive ? "on" : "off"}, true)`;
      await tx.unsafe(target.down.toString("utf8"));
      await assertSessionClean(tx, expectedUser, target.version);
      await assertNoAppOwnership(tx, target.version);
      await tx`DELETE FROM wms_meta.schema_migrations WHERE version = ${target.version}`;
      return { value: target.version, version: target.version };
    });
    if (done === undefined) break;
    reverted.push(done);
  }
  return { reverted };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export type CliEnv = Readonly<Record<string, string | undefined>>;

export type CliCommand = { kind: "up" } | { kind: "down"; to: string };

/** `up` | `down --to NNNN`. Paket yöneticisinin ilettiği tek başına `--` yok sayılır. */
export function parseArgs(argv: readonly string[]): CliCommand {
  const args = argv.filter((a) => a !== "--");
  const [cmd, ...rest] = args;
  if (cmd === "up" && rest.length === 0) return { kind: "up" };
  if (cmd === "down") {
    if (rest.length === 2 && rest[0] === "--to" && rest[1] !== undefined) return { kind: "down", to: rest[1] };
    if (rest.length === 1 && rest[0] !== undefined && rest[0].startsWith("--to=")) return { kind: "down", to: rest[0].slice(5) };
  }
  throw new MigrationError("MIGRATION_BAD_ARGS", "kullanım: migrate.ts up | migrate.ts down --to NNNN");
}

/** Bozuk % kaçışında hata atmaz; ham değeri döndürür. */
function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Mesajdaki her postgres(ql):// URL'si (sürücünün yeniden kurduğu dahil). */
const ANY_PG_URL_RE = /postgres(?:ql)?:\/\/[^\s"'`<>]+/gi;
const ERROR_CHAIN_MAX_DEPTH = 5;
const ERROR_CHAIN_MAX_LENGTH = 500;

/** Metinde `needle`'ın kelime sınırlı tüm geçişlerini maskeler (kısa ad başka sözcüğü bozmasın). */
function maskWord(text: string, needle: string): string {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, "g"), "[gizli]");
}

/**
 * URL'nin hassas parçalarını (tam URL, kullanıcı adı, parola, host) maskeler (G-09). SIRA ÖNEMLİ:
 * önce tam URL ve genel postgres(ql):// deseni (kısa bir kullanıcı adı `postgres` gibi "postgresql://"
 * önekini bozup deseni kıramasın), sonra parola (alt dize), sonra kullanıcı/host (kelime sınırlı).
 * URL ayrıştırılamıyorsa fail-closed: kimlik bölümü elle ayıklanır.
 */
export function redact(text: string, url: string | undefined): string {
  let out = text;
  if (url !== undefined && url !== "") out = out.split(url).join("[url]");
  out = out.replace(ANY_PG_URL_RE, "[url]");
  if (url === undefined || url === "") return out;

  const passwords: string[] = [];
  const names: string[] = [];
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim());
  const authority = m?.[1] ?? "";
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    const pass = colon === -1 ? "" : userinfo.slice(colon + 1);
    passwords.push(pass, decoded(pass));
    names.push(user, decoded(user));
  }
  for (const raw of (at === -1 ? authority : authority.slice(at + 1)).split(",")) {
    const hm = /^(?:\[([0-9a-f:.]+)\]|([^:[\]]*))(?::\d*)?$/i.exec(raw);
    names.push(hm?.[1] ?? hm?.[2] ?? raw);
  }
  try {
    const u = new URL(url);
    passwords.push(u.password, decoded(u.password));
    names.push(u.username, decoded(u.username), u.hostname);
  } catch {
    // Elle ayıklanan değerler yukarıda eklendi.
  }
  // Uzun olan önce: kısa parça uzun olanı yarım bırakmasın.
  const uniq = (xs: string[]): string[] => [...new Set(xs.filter((x) => x !== ""))].sort((x, y) => y.length - x.length);
  for (const secret of uniq(passwords)) out = out.split(secret).join("[gizli]");
  for (const name of uniq(names)) out = maskWord(out, name);
  return out;
}

/** `cause` zincirini (en çok 5 halka) birleştirip önce maskeler, sonra 500 karaktere kırpar. */
export function redactErrorChain(e: unknown, url: string | undefined): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < ERROR_CHAIN_MAX_DEPTH && cur !== null && cur !== undefined; depth++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return redact(parts.join(" <- "), url).slice(0, ERROR_CHAIN_MAX_LENGTH);
}

/** CLI gövdesi; çıkış kodunu döndürür. Çıktı yalnızca `log`/`logError` ile. */
export async function main(
  argv: readonly string[],
  env: CliEnv,
  io: { log: (s: string) => void; logError: (s: string) => void } = { log: console.log, logError: console.error },
): Promise<number> {
  const url = env.DATABASE_URL_DIRECT;
  try {
    const cmd = parseArgs(argv);
    if (url === undefined || url.trim() === "") {
      throw new MigrationError("MIGRATION_NO_URL", "DATABASE_URL_DIRECT tanımlı değil (yalnızca doğrudan migration bağlantısı kabul edilir)");
    }
    if (env.DATABASE_URL !== undefined && env.DATABASE_URL.trim() !== "" && sameConnectionTarget(env.DATABASE_URL, url)) {
      throw new MigrationError("MIGRATION_WRONG_ROLE", "DATABASE_URL_DIRECT uygulama bağlantısıyla (DATABASE_URL) aynı (veya karşılaştırılamayan) host/port/kullanıcı/veritabanına işaret edemez");
    }
    if (cmd.kind === "up") {
      const r = await migrateUp({ url });
      io.log(
        r.applied.length === 0
          ? `migrate: 0 bekleyen migration (uygulanmış toplam: ${r.totalApplied})`
          : `migrate: ${r.applied.length} migration uygulandı (${r.applied.join(", ")}); uygulanmış toplam: ${r.totalApplied}`,
      );
    } else {
      const r = await migrateDown({ url, to: cmd.to, wmsEnv: env.WMS_ENV });
      io.log(`rollback: ${r.reverted.length} migration geri alındı${r.reverted.length > 0 ? ` (${r.reverted.join(", ")})` : ""}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof MigrationError) {
      io.logError(redactErrorChain(e, url));
    } else {
      const err = e as { name?: unknown; code?: unknown };
      const code = typeof err.code === "string" ? ` [${err.code}]` : "";
      const name = typeof err.name === "string" ? err.name : "Error";
      io.logError(`migrate: ${name}${code}: ${redactErrorChain(e, url)}`);
    }
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
