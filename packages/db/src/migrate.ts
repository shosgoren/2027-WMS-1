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
  /** Her host:port çifti (çok host'lu URL'de birden çok). Loopback adları tek biçime indirgenir. */
  readonly hosts: readonly { host: string; port: string }[];
  readonly user: string;
  readonly db: string;
  /** URL sorgusunda `host`/`hostaddr`/`port` var: hedef belirsiz (sürücü bunları öncelikli sayar). */
  readonly hasHostOverride: boolean;
}

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"];

function decodeSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Bağlantı URL'sini sürücüden bağımsız ayrıştırır (`new URL` çok host'lu `h1:5432,h2:5432` biçiminde
 * hata verir; ayrıştırılamayan = fail-closed çağıranda ret). Port yoksa `PGPORT`, kullanıcı/veritabanı
 * yoksa `PGUSER`/`PGDATABASE` (sürücüyle aynı geri düşüş). Ayrıştırılamazsa `undefined`.
 */
export function parseTarget(url: string, env: CliEnv = process.env): ConnectionTarget | undefined {
  const m = /^postgres(?:ql)?:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#.*)?$/i.exec(url.trim());
  if (m === null) return undefined;
  const authority = m[1] ?? "";
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority.slice(0, at);
  const hostPart = at === -1 ? authority : authority.slice(at + 1);
  const defaultPort = env.PGPORT !== undefined && env.PGPORT !== "" ? env.PGPORT : "5432";
  if (!/^\d{1,5}$/.test(defaultPort)) return undefined;
  const hosts: { host: string; port: string }[] = [];
  for (const raw of hostPart.split(",")) {
    const hm = /^(?:\[([0-9a-f:.]+)\]|([^:[\]]*))(?::(\d*))?$/i.exec(raw);
    if (hm === null) return undefined;
    let host = decodeSafe((hm[1] ?? hm[2] ?? "").toLowerCase());
    const port = hm[3] === undefined || hm[3] === "" ? defaultPort : hm[3];
    if (host === "" || !/^\d{1,5}$/.test(port)) return undefined;
    if (LOOPBACK_HOSTS.includes(host)) host = "loopback";
    hosts.push({ host, port: String(Number(port)) });
  }
  const colon = userinfo.indexOf(":");
  const userRaw = colon === -1 ? userinfo : userinfo.slice(0, colon);
  const user = userRaw === "" ? (env.PGUSER ?? env.PGUSERNAME ?? "") : decodeSafe(userRaw);
  const dbRaw = decodeSafe(m[2] ?? "");
  const db = dbRaw === "" ? (env.PGDATABASE ?? user) : dbRaw;
  const hasHostOverride = (m[3] ?? "").split("&").some((kv) => /^(host|hostaddr|port)(=|$)/i.test(kv));
  return { hosts, user, db, hasHostOverride };
}

/**
 * İki URL aynı sunucu+kullanıcı+veritabanına işaret edebilir mi? Fail-closed: ayrıştırılamayan,
 * belirsiz (`?host=`) veya host listeleri kesişen çiftte `true` (ret). `localhost`/`127.0.0.1`/`::1` eşdeğer.
 */
export function sameConnectionTarget(a: string, b: string, env: CliEnv = process.env): boolean {
  const ta = parseTarget(a, env);
  const tb = parseTarget(b, env);
  if (ta === undefined || tb === undefined || ta.hasHostOverride || tb.hasHostOverride) return true;
  if (ta.user !== tb.user || ta.db !== tb.db) return false;
  return ta.hosts.some((x) => tb.hosts.some((y) => x.host === y.host && x.port === y.port));
}

/**
 * Pooler'sız TEK host'lu doğrudan bağlantı zorunlu: Neon `-pooler` host'u, yerel PgBouncer 6432,
 * çok host'lu veya ayrıştırılamayan/belirsiz URL → ret (fail-closed; advisory lock/oturum durumu).
 */
function assertDirectUrl(url: string): void {
  const t = parseTarget(url);
  if (t === undefined || t.hasHostOverride || t.hosts.length !== 1) {
    throw new MigrationError(
      "MIGRATION_POOLER_URL",
      "DATABASE_URL_DIRECT ayrıştırılamadı, çok host'lu veya host/port sorgu parametresi içeriyor; tek host'lu doğrudan bağlantı gerekir",
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

function stateViolation(version: string, phase: string, what: string): MigrationError {
  return new MigrationError(
    "MIGRATION_SESSION_STATE",
    `migration ${version} oturum durumunu değiştirdi (${what}) [${phase}]${
      phase === "commit sonrası"
        ? "; migration commit edildi ve defter yazıldı, koşu durduruldu, bağlantı atıldı: değişikliği gözden geçirin"
        : "; geri alındı"
    }`,
  );
}

/**
 * Transaction İÇİNDE, defter yazımından ÖNCE (fail-closed; ihlalde transaction geri alınır): rol /
 * oturum kullanıcısı ve bilinen `app.*` ayarları. `SET LOCAL` ile maskelenmiş OTURUM düzeyi değer
 * burada görünmez; onu `assertSessionCleanAfterCommit` yakalar.
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
    throw stateViolation(version, "transaction içi", "rol/oturum kullanıcısı veya app.* ayarı");
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
 * Migration COMMIT edildikten sonra aynı bağlantıda: `set_config(...,false)` / `SET ROLE` gibi OTURUM
 * düzeyi değişiklikler `SET LOCAL` ile maskelense de burada görünür. `before` migration öncesi
 * temiz taban çizgisidir (search_path vb. için sabit varsayılan yok).
 */
function assertSessionCleanAfterCommit(before: SessionState, after: SessionState, expectedUser: string, version: string): void {
  const problems: string[] = [];
  if (after.cu !== expectedUser || after.su !== expectedUser) problems.push("rol/oturum kullanıcısı");
  if (after.role !== "none") problems.push("SET ROLE");
  if (after.leaked.length > 0) problems.push("app.* ayarı");
  if (after.search_path !== before.search_path) problems.push("search_path");
  if (after.replication_role !== before.replication_role) problems.push("session_replication_role");
  if (after.read_only !== before.read_only) problems.push("default_transaction_read_only");
  if (after.temp_relations !== 0) problems.push("geçici tablo");
  if (after.prepared !== 0) problems.push("PREPARE");
  if (after.listening !== 0) problems.push("LISTEN");
  if (after.advisory !== 0) problems.push("oturum advisory kilidi");
  if (problems.length > 0) throw stateViolation(version, "commit sonrası", problems.join(", "));
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
  const rows = await tx.unsafe<{ cat: string }[]>(OWNED_CATALOGS_SQL, [OWNERSHIP_ROLE_NAMES as string[]]);
  if (rows.length > 0) {
    throw new MigrationError(
      "MIGRATION_APP_OWNERSHIP",
      `migration ${version} sonrası uygulama rolü (${OWNERSHIP_ROLE_NAMES.join("|")}) nesne sahibi: ${rows.map((x) => x.cat).join(", ")}; geri alındı (I-03)`,
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
    const before = await readSessionState(sql);
    assertSessionCleanAfterCommit(before, before, expectedUser, "(başlangıç)");
    const result = await sql.begin((tx) => body(tx, expectedUser));
    if (result === undefined) return undefined;
    assertSessionCleanAfterCommit(before, await readSessionState(sql), expectedUser, result.version);
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
