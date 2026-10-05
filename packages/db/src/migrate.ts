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
import { QUEUE_APP_GRANTS_SQL, installQueueSchema } from "../../queue-adapter/src/index.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Uygulama rolü adı; koşturucu bu rolle çalışmayı reddeder (I-03). */
export const APP_ROLE_NAME = "wms_app";

/**
 * Bilinen uygulama rolleri (ad listesi): koşturucu bunlardan biriyle bağlanmayı reddeder (I-03).
 * Yeni bir uygulama rolü eklendiğinde bu liste güncellenir.
 */
export const APP_ROLE_NAMES: readonly string[] = [APP_ROLE_NAME, "wms_auth", "wms_identity_probe"];

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
  /**
   * `up` sonunda pg-boss kuyruk şemasını migration rolüyle kurar/yükseltir ve `wms_app`'e yalnızca gereken
   * yetkileri verir (T-115, ADR-015: uygulama `migrate: false` ile bağlanır). Varsayılan: yalnızca varsayılan
   * migration dizini kullanılıyorsa (`dir` verilmemişse) açık; özel `dir` ile koşan sınama koşuları kapalıdır.
   */
  readonly queueSchema?: boolean;
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

/** Bağlantı hedefi (host+port+kullanıcı+veritabanı); ayrıştırılamazsa `undefined`. */
function parseTarget(url: string): { host: string; port: string; user: string; db: string } | undefined {
  try {
    const u = new URL(url);
    const dec = (v: string): string => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    return {
      host: u.hostname.toLowerCase(),
      port: u.port === "" ? "5432" : u.port,
      user: dec(u.username),
      db: dec(u.pathname.replace(/^\//, "")),
    };
  } catch {
    return undefined;
  }
}

/** İki URL aynı host+port+kullanıcı+veritabanına mı işaret ediyor? Ayrıştırılamayan çiftte ham eşitlik. */
export function sameConnectionTarget(a: string, b: string): boolean {
  const ta = parseTarget(a);
  const tb = parseTarget(b);
  if (ta === undefined || tb === undefined) return a === b;
  return ta.host === tb.host && ta.port === tb.port && ta.user === tb.user && ta.db === tb.db;
}

/** Pooler'sız doğrudan bağlantı zorunlu: Neon `-pooler` host'u veya yerel PgBouncer 6432 → ret. */
function assertDirectUrl(url: string): void {
  const t = parseTarget(url);
  if (t !== undefined && (t.port === "6432" || t.host.includes("-pooler"))) {
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

/**
 * Migration dosyası koşturulduktan sonra, defter yazımından ÖNCE: oturum durumu sızmamış olmalı
 * (SET ROLE / SET SESSION AUTHORIZATION / app.* ayarı). Fail-closed: ihlalde hata → transaction geri alınır.
 */
async function assertSessionClean(tx: Tx, expectedUser: string, version: string): Promise<void> {
  const rows = await tx<{ cu: string; su: string; role: string; leaked: string[] }[]>`
    SELECT current_user::text AS cu, session_user::text AS su, current_setting('role') AS role,
           coalesce((SELECT array_agg(n ORDER BY n) FROM unnest(${KNOWN_APP_SETTINGS as string[]}::text[]) AS n
                      WHERE coalesce(current_setting(n, true), '') <> ''), '{}') AS leaked`;
  const r = rows[0];
  if (r === undefined || r.cu !== expectedUser || r.su !== expectedUser || r.role !== "none" || r.leaked.length > 0) {
    throw new MigrationError(
      "MIGRATION_SESSION_STATE",
      `migration ${version} oturum durumunu değiştirdi (rol/oturum kullanıcısı veya app.* ayarı); geri alındı`,
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

/** Bekleyen migration'ları sırayla uygular; her biri tek transaction'dır. */
export async function migrateUp(options: RunOptions): Promise<UpResult> {
  const migrations = loadMigrations(options.dir);
  const sql = connect(options.url);
  try {
    const expectedUser = await assertMigrationRole(sql);
    const applied: string[] = [];
    let totalApplied = 0;
    for (;;) {
      const next = await sql.begin(async (tx) => {
        const ledger = await lockAndReadLedger(tx, migrations);
        totalApplied = ledger.length;
        const pending = migrations[ledger.length];
        if (pending === undefined) return undefined;
        await tx.unsafe(pending.up.toString("utf8"));
        await assertSessionClean(tx, expectedUser, pending.version);
        await tx`
          INSERT INTO wms_meta.schema_migrations (version, name, checksum_sha256)
          VALUES (${pending.version}, ${pending.name}, ${pending.checksum})`;
        return pending.version;
      });
      if (next === undefined) break;
      applied.push(next);
      totalApplied += 1;
    }
    if (options.queueSchema ?? options.dir === undefined) {
      await installQueueSchema({ url: options.url });
      await sql.unsafe(QUEUE_APP_GRANTS_SQL);
    }
    return { applied, totalApplied };
  } finally {
    await sql.end();
  }
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
  const sql = connect(options.url);
  try {
    const expectedUser = await assertMigrationRole(sql);
    const reverted: string[] = [];
    for (;;) {
      const done = await sql.begin(async (tx) => {
        const ledger = await lockAndReadLedger(tx, migrations);
        const last = ledger[ledger.length - 1];
        if (last === undefined || last.version <= options.to) return undefined;
        const target = migrations.find((m) => m.version === last.version) as Migration;
        // Ayar yalnızca local|ci'da ve transaction-local açılır; diğerlerinde açıkça kapalı.
        await tx`SELECT set_config('wms_meta.allow_destructive_down', ${allowDestructive ? "on" : "off"}, true)`;
        await tx.unsafe(target.down.toString("utf8"));
        await assertSessionClean(tx, expectedUser, target.version);
        await tx`DELETE FROM wms_meta.schema_migrations WHERE version = ${target.version}`;
        return target.version;
      });
      if (done === undefined) break;
      reverted.push(done);
    }
    return { reverted };
  } finally {
    await sql.end();
  }
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

/**
 * URL'nin hassas parçalarını (tam URL, kullanıcı adı, parola, host) maskeler (G-09). URL
 * ayrıştırılamıyorsa fail-closed: kimlik bölümü elle ayıklanıp maskelenir ve mesajdaki tüm
 * postgres URL'leri maskelenir. Ardından kalan her postgres(ql):// URL'si maskelenir.
 */
export function redact(text: string, url: string | undefined): string {
  let out = text;
  if (url !== undefined && url !== "") {
    out = out.split(url).join("[url]");
    const secrets: string[] = [];
    let host = "";
    try {
      const u = new URL(url);
      secrets.push(u.password, decoded(u.password), u.username, decoded(u.username));
      host = u.hostname;
    } catch {
      const m = /^[a-z][a-z0-9+.-]*:\/\/([^@/?#]*)@/i.exec(url);
      if (m !== null && m[1] !== undefined) secrets.push(...m[1].split(":").flatMap((p) => [p, decoded(p)]));
    }
    // Uzun olan önce: kısa parça uzun olanı yarım bırakmasın.
    for (const secret of secrets.filter((x) => x !== "").sort((x, y) => y.length - x.length)) {
      out = out.split(secret).join("[gizli]");
    }
    if (host !== "") out = out.split(host).join("[host]");
  }
  return out.replace(ANY_PG_URL_RE, "[url]");
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
      throw new MigrationError("MIGRATION_WRONG_ROLE", "DATABASE_URL_DIRECT uygulama bağlantısıyla (DATABASE_URL) aynı host/port/kullanıcı/veritabanına işaret edemez");
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
