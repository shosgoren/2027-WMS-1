// T-105e: 0003 ön denetimi A-67 ile hizalı (Neon: dal sahibi NOSUPERUSER + CREATEROLE + BYPASSRLS, probe'u kendisi
// yaratır → kaldırılamayan örtük ADMIN). Gevşetme YALNIZCA migration rolü süper kullanıcı değil VE rolbypassrls VE
// rolcreaterole iken NOTICE'tır; BYPASSRLS'siz aynı rolde RAISE aynen sürer (G-11).
//
// Ayrı Testcontainers örneği: probe adı sabit ve küme geneli olduğundan migrations-nonsuper.int.test.ts örneğiyle
// çakışmamak için bu dosyanın kendi kümesi vardır. Süper kullanıcı yalnızca rolleri/veritabanını kurmak için kullanılır;
// probe'u ve migration'ları migration rolü koşturur. G-11: örnek açılamazsa test KIRMIZI olur.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../../packages/db/src/migrate.ts";
import { redactErrorChain } from "../harness/env.ts";

const IMAGE = "postgres:18.6-trixie";
const MIGRATOR = "wms_a67_migrator";
const PROBE = "wms_identity_probe";

let container: StartedTestContainer | undefined;
let superUrl = "";
let migratorPassword = "";
const tempDirs: string[] = [];

const secret = (): string => randomBytes(16).toString("hex");

function url(user: string, password: string, db: string): string {
  const c = container as StartedTestContainer;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${c.getHost()}:${c.getMappedPort(5432)}/${encodeURIComponent(db)}`;
}

async function withClient<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [connectionString])}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const asSuper = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(superUrl, fn);

function copyMigrations(upTo: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wms-a67-migrations-"));
  tempDirs.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true, filter: (src) => !/[\\/]\d{4}_/.test(src) || (/[\\/](\d{4})_[^\\/]*$/.exec(src)?.[1] ?? "9999") <= upTo });
  return dir;
}

/** 0003'ün ön denetim DO bloğu (satır içi $pre$ … $pre$) — NOTICE'ı gözlemlemek için doğrudan koşturulur. */
function preCheckBlock(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, "0003_tenancy.up.sql"), "utf8");
  const start = sql.indexOf("DO $pre$");
  const endMarker = "$pre$;";
  const end = sql.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("0003 ön denetim bloğu bulunamadı");
  return sql.slice(start, end + endMarker.length);
}

let dbCounter = 0;
async function freshDatabase(): Promise<string> {
  const name = `wms_a67_${randomBytes(5).toString("hex")}_${dbCounter++}`;
  await asSuper((c) => c.query(`CREATE DATABASE ${name} OWNER ${MIGRATOR}`));
  return url(MIGRATOR, migratorPassword, name);
}

async function setMigratorBypass(bypass: boolean): Promise<void> {
  await asSuper((c) => c.query(`ALTER ROLE ${MIGRATOR} ${bypass ? "BYPASSRLS" : "NOBYPASSRLS"}`));
}

beforeAll(async () => {
  const password = secret();
  migratorPassword = secret();
  try {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: password, POSTGRES_DB: "postgres" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(240_000)
      .start();
  } catch (e) {
    throw new Error(`BLOCKED: A-67 Testcontainers PostgreSQL örneği açılamadı: ${redactErrorChain(e, [])}`);
  }
  superUrl = url("postgres", password, "postgres");
  await asSuper(async (c) => {
    await c.query("CREATE ROLE wms_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION");
    await c.query("CREATE ROLE wms_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION");
    // Neon dal sahibi eşdeğeri: süper kullanıcı değil; CREATEROLE + BYPASSRLS.
    await c.query(`CREATE ROLE ${MIGRATOR} LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB CREATEROLE NOREPLICATION PASSWORD '${migratorPassword}'`);
  });
  // Probe'u migration rolü yaratır (PG16+: yaratana örtük ADMIN verilir), ardından kendine SET TRUE, INHERIT FALSE ekler.
  const bootstrapDb = await freshDatabase();
  await withClient(bootstrapDb, async (c) => {
    await c.query(`CREATE ROLE ${PROBE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await c.query(`GRANT ${PROBE} TO ${MIGRATOR} WITH SET TRUE, INHERIT FALSE`);
  });
}, 300_000);

afterAll(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  if (container !== undefined) await container.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe("0003 ön denetimi — A-67 (örtük ADMIN, süper kullanıcı olmayan CREATEROLE rolü)", () => {
  it("önkoşul: probe üyeliğinde örtük ADMIN var, rol süper kullanıcı değil, CREATEROLE + BYPASSRLS", async () => {
    await setMigratorBypass(true);
    await withClient(url(MIGRATOR, migratorPassword, "postgres"), async (c) => {
      const r = await c.query<{ admin: boolean; su: boolean; byp: boolean; cr: boolean; inh: boolean[] }>(
        `SELECT pg_has_role(current_user, '${PROBE}', 'MEMBER WITH ADMIN OPTION') AS admin,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS byp,
                (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS cr,
                (SELECT array_agg(inherit_option) FROM pg_auth_members WHERE roleid = '${PROBE}'::regrole AND member = current_user::regrole) AS inh`,
      );
      const row = r.rows[0] as (typeof r.rows)[number];
      // Örtük ADMIN satırı + SET satırı: ikisinde de INHERIT yok.
      expect(row).toMatchObject({ admin: true, su: false, byp: true, cr: true });
      expect(row.inh.length).toBeGreaterThan(0);
      expect(row.inh.every((x) => x === false)).toBe(true);
    });
  });

  it("(a) BYPASSRLS + CREATEROLE: 0001-0003 geçer ve ön denetim A-67 NOTICE üretir", async () => {
    await setMigratorBypass(true);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: copyMigrations("0002") })).applied).toEqual(["0001", "0002"]);

    const notices: string[] = [];
    await withClient(u, async (c) => {
      c.on("notice", (n) => notices.push(n.message ?? ""));
      await c.query(preCheckBlock());
    });
    expect(notices.filter((m) => /0003_tenancy: A-67/.test(m))).not.toHaveLength(0);

    expect((await migrateUp({ url: u, dir: copyMigrations("0003") })).applied).toEqual(["0003"]);
  });

  it("(b) aynı rol BYPASSRLS taşımıyorsa 0003 RAISE eder (ADMIN OPTION)", async () => {
    await setMigratorBypass(false);
    try {
      const u = await freshDatabase();
      expect((await migrateUp({ url: u, dir: copyMigrations("0002") })).applied).toEqual(["0001", "0002"]);
      await expect(migrateUp({ url: u, dir: copyMigrations("0003") })).rejects.toThrow(/0003_tenancy:.*ADMIN OPTION/);
      await withClient(u, async (c) => {
        const r = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
        expect(r.rows.map((x) => x.version)).toEqual(["0001", "0002"]);
      });
    } finally {
      await setMigratorBypass(true);
    }
  });

  it("(b2) BYPASSRLS var ama CREATEROLE yoksa 0003 RAISE eder", async () => {
    await asSuper((c) => c.query(`ALTER ROLE ${MIGRATOR} NOCREATEROLE`));
    try {
      const u = await freshDatabase();
      expect((await migrateUp({ url: u, dir: copyMigrations("0002") })).applied).toEqual(["0001", "0002"]);
      await expect(migrateUp({ url: u, dir: copyMigrations("0003") })).rejects.toThrow(/0003_tenancy:.*ADMIN OPTION/);
    } finally {
      await asSuper((c) => c.query(`ALTER ROLE ${MIGRATOR} CREATEROLE`));
    }
  });

  it("A-67 gevşetmesi başka denetimleri gevşetmez: wms_auth probe üyesiyse (BYPASSRLS + CREATEROLE rolde bile) RAISE", async () => {
    await setMigratorBypass(true);
    try {
      const u = await freshDatabase();
      expect((await migrateUp({ url: u, dir: copyMigrations("0002") })).applied).toEqual(["0001", "0002"]);
      // 0001/0002 sonrası (uygulama rolü üyelik denetimi onlarda da koşar), 0003 öncesi.
      await asSuper((c) => c.query(`GRANT ${PROBE} TO wms_auth WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`));
      await expect(migrateUp({ url: u, dir: copyMigrations("0003") })).rejects.toThrow(/0003_tenancy:.*wms_auth/);
    } finally {
      await asSuper((c) => c.query(`REVOKE ${PROBE} FROM wms_auth`));
    }
  });
});
