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
