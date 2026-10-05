// Süper kullanıcı OLMAYAN migrator ile migration testi (T-103; ADR-015 4. tur eki MINOR-3 madde 6, 5. tur eki
// MINOR-2/MINOR-6; Supervisor m1).
//
// Neden ayrı örnek: yerel/CI paylaşılan kümede migration rolü bootstrap SÜPER KULLANICISIDIR; süper kullanıcı sahiplik,
// EXECUTE, SET ROLE ve CREATE yetki denetimlerini atlar → Neon'daki (süper kullanıcı olmayan sahip rolü) hata sınıfı
// görünmez. Burada Testcontainers ile İKİNCİ, yalnızca bu dosyaya ait bir PostgreSQL örneği açılır (paylaşılan kümeye
// ek rol/üyelik eklenmez; T-108'in "tek üye" denetimi bozulmaz). Süper kullanıcı yalnızca ALTYAPI ADIMINI
// (01-roles.sh eşdeğeri: roller, veritabanı sahipliği, probe üyeliği) kurmak için kullanılır; migration'ları koşturan
// rol NOSUPERUSER NOBYPASSRLS ve veritabanı sahibidir.
//
// G-11: bu örnek açılamazsa test KIRMIZI olur (atlanmaz, süper kullanıcıyla koşturulmaz).
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateDown, migrateUp } from "../../packages/db/src/migrate.ts";
import { redactErrorChain } from "./harness/env.ts";

// docker-compose.yml ile aynı imaj (yerel PostgreSQL 17.11).
const IMAGE = "postgres:17.11-trixie";
const MIGRATOR = "wms_ns_migrator";
const INFRA = "wms_ns_infra";
const PROBE = "wms_identity_probe";

let container: StartedTestContainer | undefined;
let superUrl = "";
let migratorPassword = "";
const tempDirs: string[] = [];
const scratchDbs: string[] = [];

function secret(): string {
  return randomBytes(16).toString("hex");
}

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

/** Migrator'ın veritabanı sahibi olduğu boş veritabanı; migrator URL'si döner. */
async function freshDatabase(): Promise<string> {
  const name = `wms_ns_${randomBytes(5).toString("hex")}`;
  await asSuper((c) => c.query(`CREATE DATABASE ${name} OWNER ${MIGRATOR}`));
  scratchDbs.push(name);
  return url(MIGRATOR, migratorPassword, name);
}

/** İlk `count` migration'ın (0001..000N) geçici kopyası. */
function copyMigrations(upTo: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wms-ns-migrations-"));
  tempDirs.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true, filter: (src) => !/[\\/]\d{4}_/.test(src) || (/[\\/](\d{4})_[^\\/]*$/.exec(src)?.[1] ?? "9999") <= upTo });
  return dir;
}

/** Altyapı adımı eşdeğeri: probe üyeliklerini sıfırlar ve verilen GRANT'ları uygular (süper kullanıcıyla). */
async function setProbeMemberships(...grants: string[]): Promise<void> {
  await asSuper(async (c) => {
    for (const member of [MIGRATOR, INFRA, "wms_app", "wms_auth"]) await c.query(`REVOKE ${PROBE} FROM ${member}`);
    await c.query(`REVOKE ${INFRA} FROM ${MIGRATOR}`);
    for (const g of grants) await c.query(g);
  });
}

const STANDARD_GRANT = `GRANT ${PROBE} TO ${MIGRATOR} WITH ADMIN FALSE, SET TRUE, INHERIT FALSE`;

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
    throw new Error(`BLOCKED: ikinci Testcontainers PostgreSQL örneği açılamadı: ${redactErrorChain(e, [])}`);
  }
  superUrl = url("postgres", password, "postgres");
  await asSuper(async (c) => {
    // wms_app/wms_auth/probe: 01-roles.sh eşdeğeri (parolasız: bu test onlarla bağlanmaz).
    await c.query("CREATE ROLE wms_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION");
    await c.query("CREATE ROLE wms_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION");
    await c.query(`CREATE ROLE ${PROBE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await c.query(`CREATE ROLE ${INFRA} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await c.query(`CREATE ROLE ${MIGRATOR} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${migratorPassword}'`);
  });
}, 300_000);

afterAll(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  if (container !== undefined) await container.stop({ remove: true, removeVolumes: true });
}, 120_000);

interface Catalog {
  funcs: { name: string; owner: string; secdef: boolean; config: string[] | null; acl: string[] | null }[];
  guard: { owner: string; secdef: boolean; config: string[] | null }[];
  probeInherit: boolean[];
  probeCanCreate: boolean;
  triggerExecute: { app: boolean; auth: boolean; migrator: boolean };
  migratorSuper: boolean;
  migratorBypassRls: boolean;
  indirectAdmin: boolean;
  currentIsSession: boolean;
  schemas: string[];
}

async function catalog(migratorUrl: string): Promise<Catalog> {
  return withClient(migratorUrl, async (c) => {
    const funcs = await c.query<Catalog["funcs"][number]>(
      `SELECT p.proname AS name, p.proowner::regrole::text AS owner, p.prosecdef AS secdef, p.proconfig AS config,
              p.proacl::text[] AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'wms_probe' ORDER BY 1`,
    );
    const guard = await c.query<Catalog["guard"][number]>(
      `SELECT p.proowner::regrole::text AS owner, p.prosecdef AS secdef, p.proconfig AS config
         FROM pg_proc p WHERE p.oid = 'public.tenancy_guard_system_reason()'::regprocedure`,
    );
    const inh = await c.query<{ inherit_option: boolean }>(
      `SELECT inherit_option FROM pg_auth_members WHERE roleid = '${PROBE}'::regrole AND member = current_user::regrole`,
    );
    const misc = await c.query<{
      can_create: boolean; app: boolean; auth: boolean; mig: boolean; su: boolean; byp: boolean; indirect: boolean; same: boolean;
    }>(
      `SELECT has_schema_privilege('${PROBE}', 'wms_probe', 'CREATE') AS can_create,
              has_function_privilege('wms_app',  'wms_probe.admin_reset_cleanup_on_membership()', 'EXECUTE') AS app,
              has_function_privilege('wms_auth', 'wms_probe.admin_reset_cleanup_on_membership()', 'EXECUTE') AS auth,
              has_function_privilege(current_user, 'wms_probe.admin_reset_cleanup_on_membership()', 'EXECUTE') AS mig,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS byp,
              pg_has_role(current_user, '${PROBE}', 'MEMBER WITH ADMIN OPTION') AS indirect,
              current_user = session_user AS same`,
    );
    const sch = await c.query<{ n: string }>(
      `SELECT nspname AS n FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`,
    );
    const m = misc.rows[0] as (typeof misc.rows)[number];
    return {
      funcs: funcs.rows,
      guard: guard.rows,
      probeInherit: inh.rows.map((r) => r.inherit_option),
      probeCanCreate: m.can_create,
      triggerExecute: { app: m.app, auth: m.auth, migrator: m.mig },
      migratorSuper: m.su,
      migratorBypassRls: m.byp,
      indirectAdmin: m.indirect,
      currentIsSession: m.same,
      schemas: sch.rows.map((r) => r.n),
    };
  });
}

function expectCatalog(cat: Catalog): void {
  // Önkoşul: migrator gerçekten süper kullanıcı DEĞİL (testin anlamı).
  expect(cat.migratorSuper).toBe(false);
  expect(cat.migratorBypassRls).toBe(false);
  expect(cat.currentIsSession).toBe(true);
  // Dört işlev, hepsinin sahibi probe; SECURITY DEFINER; search_path sabit; ACL NULL değil, PUBLIC girdisi yok.
  expect(cat.funcs.map((f) => f.name)).toEqual([
    "admin_reset_cleanup_on_membership",
    "consume_admin_reset_grant",
    "identity_exclusive_to_tenant",
    "invitation_for_account_creation",
  ]);
  for (const f of cat.funcs) {
    expect(f.owner, f.name).toBe(PROBE);
    expect(f.secdef, f.name).toBe(true);
    expect(f.config, f.name).toEqual(["search_path=pg_catalog, pg_temp"]);
    expect(f.acl, `${f.name}: proacl NULL (= PUBLIC'e EXECUTE dahil) olamaz`).not.toBeNull();
    // aclitem metni "grantee=privs/grantor"; PUBLIC için grantee boştur ("=X/owner").
    expect((f.acl ?? []).filter((a) => a.startsWith("=")), `${f.name}: PUBLIC girdisi`).toEqual([]);
  }
  // Tetikleyici işlevi: wms_app/wms_auth EXECUTE yok; migration rolü var (CREATE TRIGGER önkoşulu).
  expect(cat.triggerExecute).toEqual({ app: false, auth: false, migrator: true });
  // Demo bekçi işlevi: sahibi migration rolü, SECURITY DEFINER değil.
  expect(cat.guard).toEqual([{ owner: MIGRATOR, secdef: false, config: ["search_path=pg_catalog, pg_temp"] }]);
  // Probe üyeliği: INHERIT yok; wms_probe'ta CREATE kalıcı değil; Supervisor m1: dolaylı ADMIN da yok.
  expect(cat.probeInherit).not.toHaveLength(0);
  expect(cat.probeInherit.every((x) => x === false)).toBe(true);
  expect(cat.probeCanCreate).toBe(false);
  expect(cat.indirectAdmin).toBe(false);
}

describe("migrations — süper kullanıcı olmayan migrator (ikinci Testcontainers örneği)", () => {
  it("ileri → geri → ileri hatasız; sahiplik/ACL/üyelik katalog denetimi; geri sonrası wms_probe yok", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();

    const up1 = await migrateUp({ url: u });
    expect(up1.applied).toEqual(["0001", "0002", "0003"]);
    expectCatalog(await catalog(u));

    const down = await migrateDown({ url: u, to: "0000", wmsEnv: "ci" });
    expect(down.reverted).toEqual(["0003", "0002", "0001"]);
    // Geri sonrası yalnızca public ve defter şeması kalır; wms_probe kaldırılmış (ADR-015 §8, m3).
    expect((await catalog(u).catch(() => undefined))?.schemas ?? ["public", "wms_meta"]).toEqual(["public", "wms_meta"]);
    await withClient(u, async (c) => {
      const r = await c.query<{ n: string }>(`SELECT nspname AS n FROM pg_namespace WHERE nspname = 'wms_probe'`);
      expect(r.rows).toEqual([]);
      const f = await c.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
      expect(f.rows).toEqual([]);
    });

    const up2 = await migrateUp({ url: u });
    expect(up2.applied).toEqual(["0001", "0002", "0003"]);
    expectCatalog(await catalog(u));

    // Yalnızca 0003: geri → ileri.
    expect((await migrateDown({ url: u, to: "0002", wmsEnv: "ci" })).reverted).toEqual(["0003"]);
    expect((await migrateUp({ url: u })).applied).toEqual(["0003"]);
    expectCatalog(await catalog(u));
  });

  // BLOKER-1: tablolar FORCE RLS altındadır; süper kullanıcı OLMAYAN sahip tenant bağlamı olmadan satır göremez. Down
  // bekçisi RLS'ten bağımsız saymalıdır (NO FORCE ile) — aksi halde dolu tablolar bayraksız düşerdi.
  it("BLOKER-1: dolu tenants ile staging geri alma RAISE eder, veri ve FORCE RLS korunur; ci bayrağıyla geri alma çalışır", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u })).applied).toEqual(["0001", "0002", "0003"]);

    const tenantId = randomUUID();
    await withClient(u, async (c) => {
      // Önkoşul: FORCE RLS altında, bağlamsız sahip gerçekten satır GÖRMEZ (testin anlamı).
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const user = await c.query<{ id: string }>("INSERT INTO public.users (name, email) VALUES ('T103 ns', $1) RETURNING id", [
        `ns-${randomBytes(4).toString("hex")}@example.test`,
      ]);
      await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'NS Tenant')", [tenantId, `ns-${randomBytes(4).toString("hex")}`]);
      await c.query("INSERT INTO public.tenant_memberships (tenant_id, user_id, is_owner) VALUES ($1, $2, true)", [
        tenantId,
        (user.rows[0] as { id: string }).id,
      ]);
      await c.query("COMMIT");
      const blind = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.tenants");
      expect(blind.rows[0]?.n, "bağlamsız FORCE RLS sahibi satır görmemeli").toBe("0");
    });

    await expect(migrateDown({ url: u, to: "0002", wmsEnv: "staging" })).rejects.toThrow(/0003_tenancy down:.*satır var/);

    await withClient(u, async (c) => {
      // Geri alma transaction'ı iptal oldu: 0003 duruyor, FORCE RLS geri geldi, satırlar yerinde.
      const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
      expect(ledger.rows.map((r) => r.version)).toEqual(["0001", "0002", "0003"]);
      const force = await c.query<{ relname: string; relforcerowsecurity: boolean; relrowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity, relrowsecurity FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname`,
        [["invitations", "membership_roles", "tenant_memberships", "tenant_settings", "tenants"]],
      );
      expect(force.rows).toHaveLength(5);
      for (const r of force.rows) expect(r, r.relname).toMatchObject({ relforcerowsecurity: true, relrowsecurity: true });
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const kept = await c.query<{ t: string; m: string }>(
        `SELECT (SELECT count(*) FROM public.tenants)::text AS t, (SELECT count(*) FROM public.tenant_memberships)::text AS m`,
      );
      await c.query("ROLLBACK");
      expect(kept.rows[0]).toEqual({ t: "1", m: "1" });
    });

    // Bayraklı ortam (ci): aynı dolu veritabanında geri alma çalışır.
    expect((await migrateDown({ url: u, to: "0002", wmsEnv: "ci" })).reverted).toEqual(["0003"]);
    expect((await migrateUp({ url: u })).applied).toEqual(["0003"]);
    expectCatalog(await catalog(u));
  });

  it("migration rolü dışında yalnızca ADMIN seçenekli üye (probe'u oluşturan altyapı rolü) kabul edilir", async () => {
    await setProbeMemberships(STANDARD_GRANT, `GRANT ${PROBE} TO ${INFRA} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u })).applied).toEqual(["0001", "0002", "0003"]);
    expectCatalog(await catalog(u));
  });

  // 0001/0002 önce (üyelik ihlali yokken) uygulanır; ihlal 0003 öncesinde kurulur ve 0003 RAISE etmelidir.
  async function expectRaises(grants: string[], message: RegExp): Promise<void> {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    const early = copyMigrations("0002");
    expect((await migrateUp({ url: u, dir: early })).applied).toEqual(["0001", "0002"]);
    await setProbeMemberships(...grants);
    await expect(migrateUp({ url: u })).rejects.toThrow(message);
    // Hiçbir şey uygulanmadı: wms_probe şeması ve tablolar yok.
    await withClient(u, async (c) => {
      const r = await c.query<{ n: string }>(`SELECT nspname AS n FROM pg_namespace WHERE nspname = 'wms_probe'`);
      expect(r.rows).toEqual([]);
      const l = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
      expect(l.rows.map((x) => x.version)).toEqual(["0001", "0002"]);
    });
  }

  it("probe üyeliği INHERIT TRUE ile kurulduğunda 0003 RAISE eder", async () => {
    await expectRaises([`GRANT ${PROBE} TO ${MIGRATOR} WITH ADMIN FALSE, SET TRUE, INHERIT TRUE`], /0003_tenancy:.*INHERIT/);
  });

  it("probe üyeliği WITH ADMIN TRUE, SET TRUE, INHERIT FALSE kurulduğunda 0003 RAISE eder", async () => {
    await expectRaises([`GRANT ${PROBE} TO ${MIGRATOR} WITH ADMIN TRUE, SET TRUE, INHERIT FALSE`], /0003_tenancy:.*ADMIN OPTION/);
  });

  it("probe üyeliği yokken 0003 RAISE eder", async () => {
    await expectRaises([], /0003_tenancy:.*üyesi değil/);
  });

  it("probe üyeliğinde SET seçeneği yokken 0003 RAISE eder", async () => {
    await expectRaises([`GRANT ${PROBE} TO ${MIGRATOR} WITH ADMIN FALSE, SET FALSE, INHERIT FALSE`], /0003_tenancy:.*SET seçeneği/);
  });

  it("başka bir rolün (wms_app) probe üyeliği SET TRUE ile varken 0003 RAISE eder", async () => {
    await expectRaises([STANDARD_GRANT, `GRANT ${PROBE} TO wms_app WITH ADMIN FALSE, SET TRUE, INHERIT FALSE`], /0003_tenancy:.*(SET\/INHERIT|wms_app)/);
  });

  it("wms_app/wms_auth probe üyesi (yalnızca ADMIN bile olsa) olamaz: 0003 RAISE eder", async () => {
    await expectRaises([STANDARD_GRANT, `GRANT ${PROBE} TO wms_auth WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`], /0003_tenancy:.*wms_auth/);
  });

  it("Supervisor m1: migration rolünün DOLAYLI ADMIN üyeliği (INHERIT'li başka rol üzerinden) 0003'ü RAISE ettirir", async () => {
    await expectRaises(
      [
        STANDARD_GRANT,
        `GRANT ${PROBE} TO ${INFRA} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`,
        `GRANT ${INFRA} TO ${MIGRATOR} WITH ADMIN FALSE, SET FALSE, INHERIT TRUE`,
      ],
      /0003_tenancy:.*dolaylı/,
    );
  });
});
