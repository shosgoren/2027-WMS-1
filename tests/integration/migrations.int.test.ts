// Migration altyapısı entegrasyon testi (T-101, ADR-015 §8; I-03).
//
// Ana veritabanı yalnızca "ikinci `migrate up` = 0 bekleyen" ve uygulama rolü denetimleri için
// kullanılır; ileri/geri/ileri, özet, eşzamanlılık ve üyelik senaryoları her test için açılan
// GEÇİCİ veritabanlarında koşar (diğer test dosyalarının şemasına dokunmaz). Geçici veritabanı
// migration rolüyle açılıp kapatılır (CREATE DATABASE yetkisi gerekir; Neon farkı rapora yazılır).
// Uygulama rolü bağlantıları YALNIZCA DATABASE_URL'den (wms_app, pooler) kurulur.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, LOCK_KEY_SQL, LOCK_TIMEOUT, main, migrateDown, migrateUp } from "../../packages/db/src/migrate.ts";
import { APP_ROLE, readIntEnv, redactUrl } from "./harness/env.ts";

const env = readIntEnv(process.env);

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  client.on("error", (e) => console.error(`[migrations] connection error: ${redactUrl(e.message, url)}`));
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactUrl(e instanceof Error ? e.message : String(e), url)}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(db)}`;
  return u.toString();
}

const scratchDbs: string[] = [];
const tempDirs: string[] = [];

/** Boş, geçici veritabanı; migration rolüyle açılır. URL'si döner. */
async function freshDatabase(): Promise<string> {
  const name = `wms_mig_${randomBytes(5).toString("hex")}`;
  await withClient(env.databaseUrlDirect, (c) => c.query(`CREATE DATABASE ${name}`));
  scratchDbs.push(name);
  return withDatabase(env.databaseUrlDirect, name);
}

/**
 * Repodaki migration dizininin YALNIZCA 0001 içeren geçici kopyası: bu dosya baseline/koşturucu
 * davranışını sınar; sonraki gerçek migration'lar (0002+) sahte fikstürlerle çakışmaz ve
 * "applied/ledger = [0001]" beklentileri gerçek dizinden bağımsız kalır.
 */
function copyMigrations(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wms-migrations-"));
  tempDirs.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true, filter: (src) => !/[\\/]\d{4}_/.test(src) || /[\\/]0001_[^\\/]*$/.test(src) });
  return dir;
}

let sharedBaseDir: string | undefined;
/** Değiştirilmemiş, yalnızca 0001 içeren paylaşılan dizin (salt okunur kullanım). */
function baseDir(): string {
  sharedBaseDir ??= copyMigrations();
  return sharedBaseDir;
}

afterAll(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const name of scratchDbs) {
    await withClient(env.databaseUrlDirect, (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  }
});

async function ledger(url: string): Promise<string[]> {
  return withClient(url, async (c) => {
    const r = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
    return r.rows.map((x) => x.version);
  });
}

/** `public` ve kullanıcı şemaları: uygulama nesnesi kalmadığını denetler. */
async function catalogShape(url: string): Promise<{ relations: string[]; schemas: string[] }> {
  return withClient(url, async (c) => {
    const rel = await c.query<{ n: string }>(
      `SELECT c.relname AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY 1`,
    );
    const sch = await c.query<{ n: string }>(
      `SELECT nspname AS n FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`,
    );
    return { relations: rel.rows.map((x) => x.n), schemas: sch.rows.map((x) => x.n) };
  });
}

const EXTRA_UP = "CREATE TABLE public.t_extra (id integer PRIMARY KEY);\n";
const EXTRA_DOWN = "DROP TABLE public.t_extra;\n";
const DESTRUCTIVE_DOWN = `DO $d$
BEGIN
  IF coalesce(current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'destructive down not allowed in this environment';
  END IF;
END
$d$;
DROP TABLE public.t_extra;
`;

function addExtraMigration(dir: string, down: string = EXTRA_DOWN): void {
  writeFileSync(path.join(dir, "0002_extra.up.sql"), EXTRA_UP);
  writeFileSync(path.join(dir, "0002_extra.down.sql"), down);
}

describe(`migrations (target=${env.target})`, () => {
  it("global setup already applied every migration; a second run reports 0 pending", async () => {
    const r = await migrateUp({ url: env.databaseUrlDirect });
    expect(r.applied).toEqual([]);
    expect(r.totalApplied).toBeGreaterThanOrEqual(1);
    expect(await ledger(env.databaseUrlDirect)).toContain("0001");
  });

  it("forward -> fully back -> forward succeeds; after rollback no application object remains", async () => {
    const url = await freshDatabase();
    const first = await migrateUp({ url, dir: baseDir() });
    expect(first.applied).toEqual(["0001"]);

    const down = await migrateDown({ url, dir: baseDir(), to: "0000", wmsEnv: "ci" });
    expect(down.reverted).toEqual(["0001"]);
    expect(await ledger(url)).toEqual([]);
    // Geri sonrası yalnızca public (boş) ve defter şeması wms_meta kalır (ADR-015 §8).
    expect(await catalogShape(url)).toEqual({ relations: [], schemas: ["public", "wms_meta"] });

    const again = await migrateUp({ url, dir: baseDir() });
    expect(again.applied).toEqual(["0001"]);
    expect(await ledger(url)).toEqual(["0001"]);
    expect((await migrateUp({ url, dir: baseDir() })).applied).toEqual([]);
  });

  it("0001 grants wms_app only USAGE on public and takes CREATE/TEMP away from PUBLIC; down does not give them back", async () => {
    const url = await freshDatabase();
    await migrateUp({ url, dir: baseDir() });
    const probe = (c: pg.Client) =>
      c.query<{ usage: boolean; create: boolean; temp: boolean; public_create: boolean; public_temp: boolean }>(
        // `usage`: wms_app'e DOĞRUDAN verilmiş USAGE (PUBLIC'ten gelen yetki ayrı sayılır).
        `SELECT EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a
                         WHERE n.nspname = 'public' AND a.privilege_type = 'USAGE'
                           AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS usage,
                has_schema_privilege($1, 'public', 'CREATE') AS "create",
                has_database_privilege($1, current_database(), 'TEMP') AS temp,
                has_schema_privilege('public', 'public', 'CREATE') AS public_create,
                has_database_privilege('public', current_database(), 'TEMP') AS public_temp`,
        [APP_ROLE],
      );
    expect((await withClient(url, probe)).rows[0]).toEqual({
      usage: true,
      create: false,
      temp: false,
      public_create: false,
      public_temp: false,
    });
    await migrateDown({ url, dir: baseDir(), to: "0000", wmsEnv: "ci" });
    expect((await withClient(url, probe)).rows[0]).toEqual({
      usage: false,
      create: false,
      temp: false,
      public_create: false,
      public_temp: false,
    });
  });

  it("rejects a modified .up.sql of an applied migration: MIGRATION_CHECKSUM_MISMATCH, nothing applied", async () => {
    const url = await freshDatabase();
    await migrateUp({ url, dir: baseDir() });
    const dir = copyMigrations();
    addExtraMigration(dir);
    const upFile = path.join(dir, "0001_baseline.up.sql");
    writeFileSync(upFile, `${readFileSync(upFile, "utf8")}\n-- tampered\n`);
    await expect(migrateUp({ url, dir })).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });
    expect(await ledger(url)).toEqual(["0001"]);
    expect((await catalogShape(url)).relations).toEqual([]);
  });

  it("rejects a modified .down.sql of an applied migration: MIGRATION_CHECKSUM_MISMATCH (also for rollback)", async () => {
    const url = await freshDatabase();
    await migrateUp({ url, dir: baseDir() });
    const dir = copyMigrations();
    const downFile = path.join(dir, "0001_baseline.down.sql");
    writeFileSync(downFile, `${readFileSync(downFile, "utf8")}\n-- tampered\n`);
    await expect(migrateUp({ url, dir })).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });
    await expect(migrateDown({ url, dir, to: "0000", wmsEnv: "ci" })).rejects.toMatchObject({
      code: "MIGRATION_CHECKSUM_MISMATCH",
    });
    expect(await ledger(url)).toEqual(["0001"]);
  });

  it("two concurrent runners: exactly one applies, the other applies nothing", async () => {
    const url = await freshDatabase();
    const results = await Promise.all([migrateUp({ url, dir: baseDir() }), migrateUp({ url, dir: baseDir() })]);
    expect(results.map((r) => r.applied.length).sort()).toEqual([0, 1]);
    expect(await ledger(url)).toEqual(["0001"]);
  });

  it("a runner waits for the advisory lock and re-reads the ledger afterwards", async () => {
    const url = await freshDatabase();
    await withClient(url, async (holder) => {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY_SQL})`);
      let settled = false;
      const run = migrateUp({ url, dir: baseDir() }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      const r = await run;
      expect(r.applied).toEqual(["0001"]);
    });
  });

  it("stops at 0001 when wms_app is a member of another role (and applies nothing)", async () => {
    const url = await freshDatabase();
    await withClient(env.databaseUrlDirect, (c) => c.query(`GRANT pg_monitor TO ${APP_ROLE}`));
    try {
      await expect(migrateUp({ url, dir: baseDir() })).rejects.toThrow(/0001_baseline: wms_app hiçbir role üye olamaz/);
      const shape = await catalogShape(url);
      expect(shape.schemas).toEqual(["public"]);
    } finally {
      await withClient(env.databaseUrlDirect, (c) => c.query(`REVOKE pg_monitor FROM ${APP_ROLE}`));
    }
    expect((await migrateUp({ url, dir: baseDir() })).applied).toEqual(["0001"]);
  });

  /** Doğrudan (pooler'sız) host/port/veritabanı + uygulama rolü kimlik bilgisi. */
  function appRoleDirectUrl(): string {
    const u = new URL(env.databaseUrlDirect);
    const app = new URL(env.databaseUrl);
    u.username = app.username;
    u.password = app.password;
    return u.toString();
  }

  it("runs as the application role (direct host) are rejected with MIGRATION_WRONG_ROLE", async () => {
    const appDirect = appRoleDirectUrl();
    await expect(migrateUp({ url: appDirect })).rejects.toMatchObject({ code: "MIGRATION_WRONG_ROLE" });
    const lines: string[] = [];
    const io = { log: (s: string) => lines.push(s), logError: (s: string) => lines.push(s) };
    const code = await main(["up"], { DATABASE_URL_DIRECT: appDirect }, io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("MIGRATION_WRONG_ROLE");
    expect(lines.join("\n")).not.toContain(new URL(env.databaseUrl).password);
    // Yalnızca DATABASE_URL tanımlı: ret.
    expect(await main(["up"], { DATABASE_URL: env.databaseUrl }, io)).toBe(1);
    expect(lines.join("\n")).toContain("MIGRATION_NO_URL");
  });

  it("refuses a pooler URL as the migration connection (CLI and runner)", async () => {
    const pooled = new URL(env.databaseUrlDirect);
    pooled.port = "6432";
    await expect(migrateUp({ url: pooled.toString() })).rejects.toMatchObject({ code: "MIGRATION_POOLER_URL" });
    const lines: string[] = [];
    const code = await main(["up"], { DATABASE_URL_DIRECT: pooled.toString() }, { log: (x) => lines.push(x), logError: (x) => lines.push(x) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("MIGRATION_POOLER_URL");
    expect(lines.join("\n")).not.toContain(pooled.password);
  });

  it("CLI refuses DATABASE_URL_DIRECT that points at the same host/port/user/db as DATABASE_URL, despite a different string", async () => {
    const lines: string[] = [];
    const io = { log: (s: string) => lines.push(s), logError: (s: string) => lines.push(s) };
    const direct = new URL(env.databaseUrlDirect);
    direct.searchParams.set("application_name", "x");
    const code = await main(["up"], { DATABASE_URL: env.databaseUrlDirect, DATABASE_URL_DIRECT: direct.toString() }, io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("MIGRATION_WRONG_ROLE");
  });

  it("a migration that changes session state (SET ROLE / app.* setting) is rejected and rolled back", async () => {
    for (const [tag, body] of [
      ["role", `SET ROLE ${APP_ROLE};`],
      ["role-local", `SET LOCAL ROLE ${APP_ROLE};`],
      ["session-auth", `SET SESSION AUTHORIZATION ${APP_ROLE};`],
      ["app-setting", "SELECT set_config('app.current_tenant_id', 'leak', false);"],
    ] as const) {
      const url = await freshDatabase();
      const dir = copyMigrations();
      writeFileSync(path.join(dir, "0002_leak.up.sql"), `CREATE TABLE public.t_${tag.replace("-", "_")} (id integer);\n${body}\n`);
      writeFileSync(path.join(dir, "0002_leak.down.sql"), "SELECT 1;\n");
      await expect(migrateUp({ url, dir }), `variant ${tag}`).rejects.toMatchObject({ code: "MIGRATION_SESSION_STATE" });
      expect(await ledger(url)).toEqual(["0001"]);
      expect((await catalogShape(url)).relations).toEqual([]);
    }
  });

  it("session state hidden from the in-transaction check is caught after COMMIT and names the version (MINOR 1, 2)", async () => {
    // `SET LOCAL` maskeler: transaction İÇİNDE temiz görünür, COMMIT'ten sonra oturum değeri kalır.
    const cases: readonly (readonly [string, string])[] = [
      ["session-config-masked", "SELECT set_config('app.current_tenant_id', 'leak', false);\nSET LOCAL app.current_tenant_id = '';"],
      ["session-role-masked", `SET ROLE ${APP_ROLE};\nSET LOCAL ROLE NONE;`],
      ["search-path", "SET search_path = pg_catalog;"],
      ["search-path-config", "SELECT set_config('search_path', 'pg_catalog', false);"],
      ["replication-role", "SET session_replication_role = replica;"],
      ["read-only-default", "SET default_transaction_read_only = on;"],
      ["temp-table", "CREATE TEMP TABLE t_leak (id integer);"],
      ["prepare", "PREPARE leak_stmt AS SELECT 1;"],
      ["listen", "LISTEN leak_channel;"],
      ["advisory-lock", "SELECT pg_advisory_lock(42);"],
    ];
    for (const [tag, body] of cases) {
      const url = await freshDatabase();
      const dir = copyMigrations();
      writeFileSync(path.join(dir, "0002_leak.up.sql"), `${body}\n`);
      writeFileSync(path.join(dir, "0002_leak.down.sql"), "SELECT 1;\n");
      const err = await migrateUp({ url, dir }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, `variant ${tag}`).toMatchObject({ code: "MIGRATION_SESSION_STATE" });
      expect((err as Error).message, `variant ${tag}`).toMatch(/migration 0002 .*commit sonrası/);
      // Maskelenen değişiklik transaction içinde görünmediği için migration commit edilmiştir; koşu durur,
      // sızıntı bağlantıyla birlikte atılır: yeni bağlantı temizdir ve sonraki koşu başka bir şey uygulamaz.
      expect(await ledger(url), `variant ${tag}`).toEqual(["0001", "0002"]);
      expect((await migrateUp({ url, dir })).applied, `variant ${tag}`).toEqual([]);
    }
  });

  it("a migration's leaked session value cannot reach the next migration (each runs on its own connection)", async () => {
    const url = await freshDatabase();
    const dir = copyMigrations();
    writeFileSync(path.join(dir, "0002_leak.up.sql"), "SET search_path = pg_catalog;\n");
    writeFileSync(path.join(dir, "0002_leak.down.sql"), "SELECT 1;\n");
    writeFileSync(path.join(dir, "0003_probe.up.sql"), "CREATE TABLE public.t_sp AS SELECT current_setting('search_path') AS v;\n");
    writeFileSync(path.join(dir, "0003_probe.down.sql"), "DROP TABLE public.t_sp;\n");
    await expect(migrateUp({ url, dir })).rejects.toMatchObject({ code: "MIGRATION_SESSION_STATE" });
    expect(await ledger(url)).toEqual(["0001", "0002"]);
    await migrateUp({ url, dir });
    const v = await withClient(url, (c) => c.query<{ v: string }>("SELECT v FROM public.t_sp"));
    expect(v.rows[0]?.v).not.toContain("pg_catalog,");
    expect(v.rows[0]?.v).toContain("public");
  });

  it("a transaction-local change that does not outlive the migration (SET LOCAL search_path) is allowed", async () => {
    const url = await freshDatabase();
    const dir = copyMigrations();
    writeFileSync(path.join(dir, "0002_local.up.sql"), "SET LOCAL search_path = pg_catalog, public;\nCREATE TABLE public.t_local (id integer);\n");
    writeFileSync(path.join(dir, "0002_local.down.sql"), "DROP TABLE public.t_local;\n");
    expect((await migrateUp({ url, dir })).applied).toEqual(["0001", "0002"]);
  });

  it("post-run ownership audit: wms_app owning an object 0001 does not scan is rejected and rolled back (MINOR 7)", async () => {
    const owned: readonly (readonly [string, readonly string[], string])[] = [
      ["pg_type", ["CREATE DOMAIN public.d_arr AS integer[]", `ALTER DOMAIN public.d_arr OWNER TO ${APP_ROLE}`], "pg_type"],
      ["pg_collation", ["CREATE COLLATION public.c_probe (provider = libc, locale = 'C')", `ALTER COLLATION public.c_probe OWNER TO ${APP_ROLE}`], "pg_collation"],
      [
        "pg_operator",
        [
          "CREATE OPERATOR public.=== (LEFTARG = int4, RIGHTARG = int4, FUNCTION = int4eq)",
          `ALTER OPERATOR public.=== (int4, int4) OWNER TO ${APP_ROLE}`,
        ],
        "pg_operator",
      ],
      [
        "pg_ts_config",
        ["CREATE TEXT SEARCH CONFIGURATION public.ts_probe (COPY = simple)", `ALTER TEXT SEARCH CONFIGURATION public.ts_probe OWNER TO ${APP_ROLE}`],
        "pg_ts_config",
      ],
      [
        "pg_largeobject_metadata",
        ["SELECT lo_create(424242)", `ALTER LARGE OBJECT 424242 OWNER TO ${APP_ROLE}`],
        "pg_largeobject_metadata",
      ],
    ];
    for (const [tag, statements, catalog] of owned) {
      const url = await freshDatabase();
      await withClient(url, async (c) => {
        for (const st of statements) await c.query(st);
      });
      const err = await migrateUp({ url, dir: baseDir() }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, tag).toMatchObject({ code: "MIGRATION_APP_OWNERSHIP" });
      expect((err as Error).message, tag).toContain(catalog);
      expect(await withClient(url, (c) => c.query("SELECT to_regclass('wms_meta.schema_migrations') AS r")), tag).toMatchObject({
        rows: [{ r: null }],
      });
    }
  });

  it("a deviating session baseline at connect time (database-level search_path / read-only / replication role) is refused", async () => {
    for (const [tag, setting] of [
      ["search_path", "search_path = pg_catalog"],
      ["read-only", "default_transaction_read_only = on"],
      ["replication-role", "session_replication_role = replica"],
    ] as const) {
      const url = await freshDatabase();
      const db = new URL(url).pathname.slice(1);
      await withClient(env.databaseUrlDirect, (c) => c.query(`ALTER DATABASE ${db} SET ${setting}`));
      await expect(migrateUp({ url, dir: baseDir() }), tag).rejects.toMatchObject({ code: "MIGRATION_SESSION_STATE" });
      await expect(migrateUp({ url, dir: baseDir() }), tag).rejects.toThrow(/\[başlangıç\]/);
    }
  });

  it("post-run audit: role-level settings, attribute changes and memberships of wms_app are rejected and rolled back", async () => {
    // Veritabanına özgü rol ayarı: veritabanı silinince ayar da gider (kümeyi kirletmez).
    const url = await freshDatabase();
    const db = new URL(url).pathname.slice(1);
    await withClient(env.databaseUrlDirect, (c) => c.query(`ALTER ROLE ${APP_ROLE} IN DATABASE ${db} SET work_mem = '8MB'`));
    await expect(migrateUp({ url, dir: baseDir() })).rejects.toMatchObject({ code: "MIGRATION_APP_OWNERSHIP" });
    expect(await withClient(url, (c) => c.query("SELECT to_regclass('wms_meta.schema_migrations') AS r"))).toMatchObject({ rows: [{ r: null }] });

    // Rol DDL'i transactional: ihlal eden migration geri alınınca küme durumu değişmez.
    for (const [tag, body] of [
      ["createdb", `ALTER ROLE ${APP_ROLE} CREATEDB;`],
      ["membership", `GRANT pg_monitor TO ${APP_ROLE};`],
    ] as const) {
      const fresh = await freshDatabase();
      const dir = copyMigrations();
      writeFileSync(path.join(dir, "0002_role.up.sql"), `${body}\n`);
      writeFileSync(path.join(dir, "0002_role.down.sql"), "SELECT 1;\n");
      await expect(migrateUp({ url: fresh, dir }), tag).rejects.toMatchObject({ code: "MIGRATION_APP_OWNERSHIP" });
      expect(await ledger(fresh), tag).toEqual(["0001"]);
    }
    const attrs = await withClient(env.databaseUrlDirect, (c) =>
      c.query<{ rolcreatedb: boolean; n: string }>(
        `SELECT rolcreatedb, (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::text AS n FROM pg_roles r WHERE rolname = $1`,
        [APP_ROLE],
      ),
    );
    expect(attrs.rows[0]).toEqual({ rolcreatedb: false, n: "0" });
  });

  it("post-run audit: attributes of the probe role and database-level (role-independent) settings are rejected", async () => {
    // Probe rolü altyapı adımıdır (T-101b/T-105); bu dalda yoksa test süresince yaratılır ve silinir.
    const existed = (await withClient(env.databaseUrlDirect, (c) => c.query("SELECT 1 FROM pg_roles WHERE rolname = 'wms_identity_probe'"))).rowCount === 1;
    if (!existed) {
      await withClient(env.databaseUrlDirect, (c) => c.query("CREATE ROLE wms_identity_probe NOLOGIN NOSUPERUSER NOBYPASSRLS"));
    }
    try {
      const url = await freshDatabase();
      const dir = copyMigrations();
      writeFileSync(path.join(dir, "0002_probe.up.sql"), "ALTER ROLE wms_identity_probe BYPASSRLS;\n");
      writeFileSync(path.join(dir, "0002_probe.down.sql"), "SELECT 1;\n");
      await expect(migrateUp({ url, dir })).rejects.toMatchObject({ code: "MIGRATION_APP_OWNERSHIP" });
      expect(await ledger(url)).toEqual(["0001"]);
      const flag = await withClient(env.databaseUrlDirect, (c) => c.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wms_identity_probe'"));
      expect(flag.rows[0]).toEqual({ rolbypassrls: false });
    } finally {
      if (!existed) await withClient(env.databaseUrlDirect, (c) => c.query("DROP ROLE IF EXISTS wms_identity_probe"));
    }
    // Rol-bağımsız veritabanı ayarı (izin listesi boş): her ayar ret; her biri ayrı veritabanında.
    for (const setting of ["work_mem = '8MB'", "statement_timeout = '5min'", "session_replication_role = origin"]) {
      const url = await freshDatabase();
      const db = new URL(url).pathname.slice(1);
      await withClient(env.databaseUrlDirect, (c) => c.query(`ALTER DATABASE ${db} SET ${setting}`));
      const err = await migrateUp({ url, dir: baseDir() }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, setting).toBeDefined();
      expect(["MIGRATION_APP_OWNERSHIP", "MIGRATION_SESSION_STATE"], setting).toContain((err as { code: string }).code);
    }
  });

  it("refuses URL query parameters outside the allowlist (user/database/options override the startup message)", async () => {
    for (const q of ["user=wms_app", "database=postgres", "options=-c%20role%3Dwms_app", "unknown=1"]) {
      const u = new URL(env.databaseUrlDirect);
      u.search = q;
      await expect(migrateUp({ url: u.toString() }), q).rejects.toMatchObject({ code: "MIGRATION_POOLER_URL" });
    }
  });

  it("the ownership audit also runs on the down path: a down that leaves wms_app owning an object is rejected", async () => {
    const url = await freshDatabase();
    const dir = copyMigrations();
    writeFileSync(path.join(dir, "0002_own.up.sql"), "SELECT 1;\n");
    writeFileSync(path.join(dir, "0002_own.down.sql"), `CREATE TABLE public.t_own (id integer);\nALTER TABLE public.t_own OWNER TO ${APP_ROLE};\n`);
    expect((await migrateUp({ url, dir })).applied).toEqual(["0001", "0002"]);
    await expect(migrateDown({ url, dir, to: "0001", wmsEnv: "ci" })).rejects.toMatchObject({ code: "MIGRATION_APP_OWNERSHIP" });
    expect(await ledger(url)).toEqual(["0001", "0002"]);
    expect((await catalogShape(url)).relations).toEqual([]);
  });

  it("refuses the parser-differential URLs from the CLI without connecting (no password in output)", async () => {
    const lines: string[] = [];
    const io = { log: (x: string) => lines.push(x), logError: (x: string) => lines.push(x) };
    for (const url of ["postgres://u:pw-diff-secret@pooler-host:6432,a@direct:5432/db", "postgres://u:pw-diff-secret@direct:5432#,pooler:6432/db"]) {
      expect(await main(["up"], { DATABASE_URL_DIRECT: url }, io)).toBe(1);
    }
    const text = lines.join("\n");
    expect(text).toContain("MIGRATION_POOLER_URL");
    expect(text).not.toContain("pw-diff-secret");
  });

  it("a rollback whose down changes session state is rejected and rolled back", async () => {
    const url = await freshDatabase();
    const dir = copyMigrations();
    addExtraMigration(dir, `DROP TABLE public.t_extra;\nSET ROLE ${APP_ROLE};\n`);
    expect((await migrateUp({ url, dir })).applied).toEqual(["0001", "0002"]);
    await expect(migrateDown({ url, dir, to: "0001", wmsEnv: "ci" })).rejects.toMatchObject({ code: "MIGRATION_SESSION_STATE" });
    expect(await ledger(url)).toEqual(["0001", "0002"]);
    expect((await catalogShape(url)).relations).toEqual(["t_extra"]);
  });

  it("lock waits are bounded by lock_timeout (set transaction-locally)", async () => {
    const url = await freshDatabase();
    const dir = copyMigrations();
    writeFileSync(path.join(dir, "0002_show.up.sql"), "CREATE TABLE public.t_show AS SELECT current_setting('lock_timeout') AS v;\n");
    writeFileSync(path.join(dir, "0002_show.down.sql"), "DROP TABLE public.t_show;\n");
    await migrateUp({ url, dir });
    const v = await withClient(url, (c) => c.query<{ v: string }>("SELECT v FROM public.t_show"));
    expect(LOCK_TIMEOUT).toBe("60s");
    expect(v.rows[0]?.v).toBe("1min"); // PostgreSQL 60s'yi "1min" olarak gösterir
    // Yeni oturumda ayar sızmamıştır (transaction-local).
    const fresh = await withClient(url, (c) => c.query<{ v: string }>("SELECT current_setting('lock_timeout') AS v"));
    expect(fresh.rows[0]?.v).not.toBe("1min");
  });

  it("0001 rejects wms_app that can CREATE in the database, owns a user type or owns a database", async () => {
    const attempts: { setup: (url: string, db: string) => Promise<void>; cleanup?: () => Promise<void>; msg: RegExp }[] = [
      {
        setup: async (_url, db) => {
          await withClient(env.databaseUrlDirect, (c) => c.query(`GRANT CREATE ON DATABASE ${db} TO ${APP_ROLE}`));
        },
        msg: /veritabanında CREATE yetkisi/,
      },
      {
        setup: async (url) => {
          await withClient(url, async (c) => {
            await c.query("CREATE TYPE public.t_enum AS ENUM ('a')");
            await c.query(`ALTER TYPE public.t_enum OWNER TO ${APP_ROLE}`);
          });
        },
        msg: /hiçbir nesnenin sahibi olamaz/,
      },
    ];
    for (const a of attempts) {
      const url = await freshDatabase();
      const db = new URL(url).pathname.slice(1);
      await a.setup(url, db);
      await expect(migrateUp({ url, dir: baseDir() })).rejects.toThrow(a.msg);
      expect(await withClient(url, (c) => c.query("SELECT to_regclass('wms_meta.schema_migrations') AS r"))).toMatchObject({
        rows: [{ r: null }],
      });
    }
    // Veritabanı sahipliği: wms_app'e ait ayrı veritabanı.
    const name = `wms_mig_${randomBytes(5).toString("hex")}`;
    await withClient(env.databaseUrlDirect, (c) => c.query(`CREATE DATABASE ${name} OWNER ${APP_ROLE}`));
    // pg_database kümeye geneldir: sahiplik yalnızca bu denemenin süresince var olmalı (diğer testleri bozmasın).
    try {
      await expect(migrateUp({ url: withDatabase(env.databaseUrlDirect, name), dir: baseDir() })).rejects.toThrow(/hiçbir nesnenin sahibi olamaz/);
    } finally {
      await withClient(env.databaseUrlDirect, (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    }
  });

  it("0001 rejects a REPLICATION wms_app (role attribute restored afterwards)", async () => {
    const url = await freshDatabase();
    await withClient(env.databaseUrlDirect, (c) => c.query(`ALTER ROLE ${APP_ROLE} REPLICATION`));
    try {
      await expect(migrateUp({ url, dir: baseDir() })).rejects.toThrow(/wms_app REPLICATION olamaz/);
    } finally {
      await withClient(env.databaseUrlDirect, (c) => c.query(`ALTER ROLE ${APP_ROLE} NOREPLICATION`));
    }
    expect((await migrateUp({ url, dir: baseDir() })).applied).toEqual(["0001"]);
  });

  it("rollback: a destructive down is refused under WMS_ENV=staging and allowed under ci; production is refused", async () => {
    const url = await freshDatabase();
    const dir = copyMigrations();
    addExtraMigration(dir, DESTRUCTIVE_DOWN);
    expect((await migrateUp({ url, dir })).applied).toEqual(["0001", "0002"]);

    await expect(migrateDown({ url, dir, to: "0001", wmsEnv: "production" })).rejects.toMatchObject({
      code: "MIGRATION_ENV_FORBIDDEN",
    });
    await expect(migrateDown({ url, dir, to: "0001", wmsEnv: "staging" })).rejects.toThrow(/destructive down not allowed/);
    expect(await ledger(url)).toEqual(["0001", "0002"]);

    const r = await migrateDown({ url, dir, to: "0001", wmsEnv: "ci" });
    expect(r.reverted).toEqual(["0002"]);
    expect(await ledger(url)).toEqual(["0001"]);
    expect((await catalogShape(url)).relations).toEqual([]);
  });

  it("application role is blocked from the ledger, from CREATE in public and from CREATE TEMP TABLE", async () => {
    const attempt = async (sql: string): Promise<string | undefined> =>
      withClient(env.databaseUrl, async (c) => {
        try {
          await c.query(sql);
          return undefined;
        } catch (e) {
          return (e as { code?: string }).code;
        }
      });
    expect(await attempt("SELECT * FROM wms_meta.schema_migrations")).toBe("42501");
    expect(await attempt("CREATE TABLE public.wms_app_should_not_exist (id integer)")).toBe("42501");
    expect(await attempt("CREATE TEMP TABLE wms_app_temp_probe (id integer)")).toBe("42501");
  });
});
