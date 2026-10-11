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

// docker-compose.yml ile aynı imaj (PostgreSQL 18.6 — Neon ile aynı ana sürüm, T-005e).
const IMAGE = "postgres:18.6-trixie";
const MIGRATOR = "wms_ns_migrator";
const INFRA = "wms_ns_infra";
const PROBE = "wms_identity_probe";
const OPS = "wms_ops";

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

/** 0001..0003 kopyası (önbellekli): sonraki migration'lar (0004+) bu testlerin beklentilerini değiştirmesin. */
let thru3Dir: string | undefined;
function thru3(): string {
  thru3Dir ??= copyMigrations("0003");
  return thru3Dir;
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
    // wms_ops: 0009 önkoşulu (01-roles.sh / staging ile aynı: NOLOGIN, parolasız, üyelik yok; A-80).
    await c.query(`CREATE ROLE ${OPS} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    // wms_worker: 0014 önkoşulu (01-roles.sh / provision-staging.mjs ile aynı: LOGIN + kısıtlı nitelikler, üyelik yok; parolasız: bu test onunla bağlanmaz).
    await c.query("CREATE ROLE wms_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION");
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

    const up1 = await migrateUp({ url: u, dir: thru3() });
    expect(up1.applied).toEqual(["0001", "0002", "0003"]);
    expectCatalog(await catalog(u));

    const down = await migrateDown({ url: u, dir: thru3(), to: "0000", wmsEnv: "ci" });
    expect(down.reverted).toEqual(["0003", "0002", "0001"]);
    // Geri sonrası yalnızca public ve defter şeması kalır; wms_probe kaldırılmış (ADR-015 §8, m3).
    expect((await catalog(u).catch(() => undefined))?.schemas ?? ["public", "wms_meta"]).toEqual(["public", "wms_meta"]);
    await withClient(u, async (c) => {
      const r = await c.query<{ n: string }>(`SELECT nspname AS n FROM pg_namespace WHERE nspname = 'wms_probe'`);
      expect(r.rows).toEqual([]);
      const f = await c.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
      expect(f.rows).toEqual([]);
    });

    const up2 = await migrateUp({ url: u, dir: thru3() });
    expect(up2.applied).toEqual(["0001", "0002", "0003"]);
    expectCatalog(await catalog(u));

    // Yalnızca 0003: geri → ileri.
    expect((await migrateDown({ url: u, dir: thru3(), to: "0002", wmsEnv: "ci" })).reverted).toEqual(["0003"]);
    expect((await migrateUp({ url: u, dir: thru3() })).applied).toEqual(["0003"]);
    expectCatalog(await catalog(u));
  });

  // BLOKER-1: tablolar FORCE RLS altındadır; süper kullanıcı OLMAYAN sahip tenant bağlamı olmadan satır göremez. Down
  // bekçisi RLS'ten bağımsız saymalıdır (NO FORCE ile) — aksi halde dolu tablolar bayraksız düşerdi.
  it("BLOKER-1: dolu tenants ile staging geri alma RAISE eder, veri ve FORCE RLS korunur; ci bayrağıyla geri alma çalışır", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru3() })).applied).toEqual(["0001", "0002", "0003"]);

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

    await expect(migrateDown({ url: u, dir: thru3(), to: "0002", wmsEnv: "staging" })).rejects.toThrow(/0003_tenancy down:.*satır var/);

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
    expect((await migrateDown({ url: u, dir: thru3(), to: "0002", wmsEnv: "ci" })).reverted).toEqual(["0003"]);
    expect((await migrateUp({ url: u, dir: thru3() })).applied).toEqual(["0003"]);
    expectCatalog(await catalog(u));
  });

  it("migration rolü dışında yalnızca ADMIN seçenekli üye (probe'u oluşturan altyapı rolü) kabul edilir", async () => {
    await setProbeMemberships(STANDARD_GRANT, `GRANT ${PROBE} TO ${INFRA} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru3() })).applied).toEqual(["0001", "0002", "0003"]);
    expectCatalog(await catalog(u));
  });

  // 0001/0002 önce (üyelik ihlali yokken) uygulanır; ihlal 0003 öncesinde kurulur ve 0003 RAISE etmelidir.
  async function expectRaises(grants: string[], message: RegExp): Promise<void> {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    const early = copyMigrations("0002");
    expect((await migrateUp({ url: u, dir: early })).applied).toEqual(["0001", "0002"]);
    await setProbeMemberships(...grants);
    await expect(migrateUp({ url: u, dir: thru3() })).rejects.toThrow(message);
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

// 0004_audit (T-107; security-reviewer @79b2011 MAJOR-2): yukarıdaki testler 0001–0003 kopyasında kalır; 0004 ayrı kopyada.
describe("0004_audit down bekçisi — süper kullanıcı olmayan sahip", () => {
  let thru4Dir: string | undefined;
  const thru4 = (): string => (thru4Dir ??= copyMigrations("0004"));

  it("dolu audit_logs ile staging geri alma RAISE eder; veri ve FORCE RLS korunur; ci bayrağıyla geri alma ve yeniden ileri çalışır", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru4() })).applied).toEqual(["0001", "0002", "0003", "0004"]);

    const tenantId = randomUUID();
    await withClient(u, async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'NS Audit')", [tenantId, `ns-${randomBytes(4).toString("hex")}`]);
      await c.query("INSERT INTO public.audit_logs (action, entity_id) VALUES ('tenant.created', 'ns-keep')");
      await c.query("COMMIT");
      // Önkoşul (testin anlamı): FORCE RLS altında, bağlamsız sahip audit satırını GÖRMEZ.
      const blind = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.audit_logs");
      expect(blind.rows[0]?.n, "bağlamsız FORCE RLS sahibi satır görmemeli").toBe("0");
    });

    await expect(migrateDown({ url: u, dir: thru4(), to: "0003", wmsEnv: "staging" })).rejects.toThrow(/0004_audit down:.*satır var/);

    await withClient(u, async (c) => {
      const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
      expect(ledger.rows.map((r) => r.version)).toEqual(["0001", "0002", "0003", "0004"]);
      const force = await c.query<{ relname: string; relforcerowsecurity: boolean; relrowsecurity: boolean }>(
        "SELECT relname, relforcerowsecurity, relrowsecurity FROM pg_class WHERE oid = 'public.audit_logs'::regclass",
      );
      expect(force.rows).toEqual([{ relname: "audit_logs", relforcerowsecurity: true, relrowsecurity: true }]);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const kept = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.audit_logs WHERE entity_id = 'ns-keep'");
      await c.query("ROLLBACK");
      expect(kept.rows[0]?.n).toBe("1");
    });

    expect((await migrateDown({ url: u, dir: thru4(), to: "0003", wmsEnv: "ci" })).reverted).toEqual(["0004"]);
    expect((await migrateUp({ url: u, dir: thru4() })).applied).toEqual(["0004"]);
  });
});

// 0006_invitation_accept (T-117; inceleme @99286d6 MINOR-4): yukarıdaki testler eski kopyalarında kalır; 0001–0006 ayrı kopyada.
describe("0006_invitation_accept — süper kullanıcı olmayan migrator", () => {
  let thru6Dir: string | undefined;
  const thru6 = (): string => (thru6Dir ??= copyMigrations("0006"));
  const FN = "wms_probe.invitation_tenant_for_token(text)";

  async function expectFunction(u: string): Promise<void> {
    await withClient(u, async (c) => {
      const f = await c.query<{ owner: string; secdef: boolean; config: string[] | null; acl: string[] | null; probe_create: boolean; app: boolean; auth: boolean; probe_write: boolean }>(
        `SELECT p.proowner::regrole::text AS owner, p.prosecdef AS secdef, p.proconfig AS config, p.proacl::text[] AS acl,
                has_schema_privilege('${PROBE}', 'wms_probe', 'CREATE') AS probe_create,
                has_function_privilege('wms_app', '${FN}', 'EXECUTE') AS app,
                has_function_privilege('wms_auth', '${FN}', 'EXECUTE') AS auth,
                (has_table_privilege('${PROBE}', 'public.invitations', 'INSERT, UPDATE, DELETE')
                 OR has_table_privilege('${PROBE}', 'public.tenant_memberships', 'INSERT, UPDATE, DELETE')
                 OR has_table_privilege('${PROBE}', 'public.membership_roles', 'INSERT, UPDATE, DELETE')) AS probe_write
           FROM pg_proc p WHERE p.oid = '${FN}'::regprocedure`,
      );
      const r = f.rows[0];
      expect(r).toMatchObject({ owner: PROBE, secdef: true, config: ["search_path=pg_catalog, pg_temp"], probe_create: false, app: true, auth: false, probe_write: false });
      expect(r?.acl).not.toBeNull();
      expect((r?.acl ?? []).filter((a) => a.startsWith("="))).toEqual([]); // PUBLIC girdisi yok
    });
  }

  it("ileri (0001–0006) → 0006 geri → ileri hatasız; işlev probe sahipli SECURITY DEFINER, yalnızca wms_app EXECUTE, probe salt okunur", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru6() })).applied).toEqual(["0001", "0002", "0003", "0004", "0005", "0006"]);
    await expectFunction(u);

    expect((await migrateDown({ url: u, dir: thru6(), to: "0005", wmsEnv: "ci" })).reverted).toEqual(["0006"]);
    await withClient(u, async (c) => {
      const gone = await c.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wms_probe' AND p.proname = 'invitation_tenant_for_token'`);
      expect(gone.rows).toEqual([]);
    });
    expect((await migrateUp({ url: u, dir: thru6() })).applied).toEqual(["0006"]);
    await expectFunction(u);
  });
});

// 0007–0012 (T-234; T-209 QA MINOR): 0001–0012 ileri → 0012..0010 geri → ileri; dolu tablo down bekçileri.
describe("0007–0012 — süper kullanıcı olmayan migrator", () => {
  let thru12Dir: string | undefined;
  const thru12 = (): string => (thru12Dir ??= copyMigrations("0012"));
  const ALL = ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012"];

  /** Şema parmak izi: sütun, RLS bayrağı, politika, kısıt, dizin, işlev (sahip + ACL) özetleri (migrator katalogundan). */
  async function schemaDigest(u: string): Promise<Record<string, string>> {
    return withClient(u, async (c) => {
      const q = async (sql: string): Promise<string> => (await c.query<{ d: string }>(sql)).rows[0]?.d ?? "";
      const nsp = `n.nspname IN ('public', 'wms_probe', 'wms_meta')`;
      return {
        columns: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', table_schema, table_name, column_name, ordinal_position, data_type, is_nullable, coalesce(column_default, '')), E'\\n' ORDER BY table_schema, table_name, ordinal_position), '')) AS d
             FROM information_schema.columns WHERE table_schema IN ('public', 'wms_probe', 'wms_meta')`,
        ),
        rls: await q(
          `SELECT md5(coalesce(string_agg(format('%I.%I:%s:%s', n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity), ',' ORDER BY n.nspname, c.relname), '')) AS d
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND ${nsp}`,
        ),
        policies: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check), ',' ORDER BY schemaname, tablename, policyname), '')) AS d FROM pg_policies`,
        ),
        constraints: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, cl.relname, co.conname, pg_get_constraintdef(co.oid)), ',' ORDER BY n.nspname, cl.relname, co.conname), '')) AS d
             FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE ${nsp}`,
        ),
        indexes: await q(`SELECT md5(coalesce(string_agg(indexdef, ',' ORDER BY indexname), '')) AS d FROM pg_indexes WHERE schemaname IN ('public', 'wms_probe')`),
        functions: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, p.oid::regprocedure::text, p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text, md5(p.prosrc)), ',' ORDER BY n.nspname, p.oid::regprocedure::text), '')) AS d
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'wms_probe')`,
        ),
        triggers: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', t.tgrelid::regclass::text, t.tgname, t.tgenabled, t.tgfoid::regprocedure::text), ',' ORDER BY t.tgrelid::regclass::text, t.tgname), '')) AS d
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND ${nsp}`,
        ),
        columnAcl: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, c.relname, a.attname, x.grantee::regrole::text, x.privilege_type, x.is_grantable), ',' ORDER BY n.nspname, c.relname, a.attname, x.grantee::regrole::text, x.privilege_type), '')) AS d
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attacl IS NOT NULL AND NOT a.attisdropped AND ${nsp}`,
        ),
        tableAcl: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, c.relname, c.relowner::regrole::text, c.relacl::text), ',' ORDER BY n.nspname, c.relname), '')) AS d
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND ${nsp}`,
        ),
      };
    });
  }

  it("ileri (0001–0012) → 0012..0010 geri (to 0009) → ileri; şema parmak izi ilk ileri koşuyla eşit; süper kullanıcı yok", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru12() })).applied).toEqual(ALL);
    const before = await schemaDigest(u);
    expect(Object.values(before).every((d) => d.length === 32)).toBe(true);
    await withClient(u, async (c) => {
      const r = await c.query<{ su: boolean; byp: boolean }>(
        "SELECT rolsuper AS su, rolbypassrls AS byp FROM pg_roles WHERE rolname = current_user",
      );
      expect(r.rows).toEqual([{ su: false, byp: false }]);
    });

    expect((await migrateDown({ url: u, dir: thru12(), to: "0009", wmsEnv: "ci" })).reverted).toEqual(["0012", "0011", "0010"]);
    const mid = await schemaDigest(u);
    expect(mid).not.toEqual(before);
    await withClient(u, async (c) => {
      const gone = await c.query(`SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('warehouses', 'items', 'documents')`);
      expect(gone.rows).toEqual([]);
    });

    expect((await migrateUp({ url: u, dir: thru12() })).applied).toEqual(["0010", "0011", "0012"]);
    expect(await schemaDigest(u)).toEqual(before);
  });

  it("negatif kontrol: tek tetikleyici ALWAYS yerine ENABLE yapılırsa parmak izi değişir; geri alınca eşitlenir", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru12() })).applied).toEqual(ALL);
    const base = await schemaDigest(u);
    const trg = async (): Promise<string[]> =>
      withClient(u, async (c) => (await c.query<{ e: string }>(
        `SELECT tgenabled AS e FROM pg_trigger WHERE tgname = 'document_type_versions_immutable' AND tgrelid = 'public.document_type_versions'::regclass`,
      )).rows.map((r) => r.e));
    expect(await trg()).toEqual(["A"]);
    await withClient(u, (c) => c.query("ALTER TABLE public.document_type_versions ENABLE TRIGGER document_type_versions_immutable"));
    expect(await trg()).toEqual(["O"]);
    const changed = await schemaDigest(u);
    expect(changed.triggers).not.toBe(base.triggers);
    expect({ ...changed, triggers: base.triggers }).toEqual(base);
    await withClient(u, (c) => c.query("ALTER TABLE public.document_type_versions ENABLE ALWAYS TRIGGER document_type_versions_immutable"));
    expect(await schemaDigest(u)).toEqual(base);
  });

  it("sütun ACL parmak izi gerçek veri taşır; tek sütun yetkisi REVOKE edilirse yalnızca columnAcl değişir; GRANT ile eşitlenir", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru12() })).applied).toEqual(ALL);
    const base = await schemaDigest(u);
    await withClient(u, async (c) => {
      // Boş-küme md5'i değil; 0010/0011/0012'nin sütun GRANT'ları katalogda gerçekten var.
      const empty = await c.query<{ d: string }>("SELECT md5('') AS d");
      expect(base.columnAcl).not.toBe(empty.rows[0]?.d);
      const n = await c.query<{ n: string; hist: string }>(
        `SELECT count(*)::text AS n,
                count(*) FILTER (WHERE c.relname = 'document_status_history' AND a.attname = 'reason' AND x.grantee = 'wms_app'::regrole AND x.privilege_type = 'INSERT')::text AS hist
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
           CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attacl IS NOT NULL AND NOT a.attisdropped AND ns.nspname = 'public'`,
      );
      expect(Number(n.rows[0]?.n)).toBeGreaterThan(20);
      expect(n.rows[0]?.hist).toBe("1");
      await c.query("REVOKE INSERT (reason) ON public.document_status_history FROM wms_app");
    });
    const changed = await schemaDigest(u);
    expect(changed.columnAcl).not.toBe(base.columnAcl);
    expect({ ...changed, columnAcl: base.columnAcl }).toEqual(base);
    await withClient(u, (c) => c.query("GRANT INSERT (reason) ON public.document_status_history TO wms_app"));
    expect(await schemaDigest(u)).toEqual(base);
  });

  it("0010 (T-235): FORCE RLS altındaki sahip A bağlamında B anahtarlı locations INSERT eder: row_security_active true, 42501 'row-level security policy'", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru12() })).applied).toEqual(ALL);
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await withClient(u, async (c) => {
      for (const t of [tenantA, tenantB]) {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [t]);
        await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'NS Loc')", [t, `ns-${randomBytes(4).toString("hex")}`]);
        await c.query("INSERT INTO public.warehouses (tenant_id, code, name) VALUES ($1, 'NS-W', 'NS Depo')", [t]);
        await c.query("COMMIT");
      }
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      const active = await c.query<{ a: boolean }>("SELECT row_security_active('public.locations') AS a");
      expect(active.rows).toEqual([{ a: true }]);
      const wh = await c.query<{ id: string }>("SELECT id FROM public.warehouses");
      expect(wh.rows).toHaveLength(1);
      let err: (Error & { code?: string }) | undefined;
      try {
        await c.query(
          "INSERT INTO public.locations (tenant_id, warehouse_id, code, name, depth, kind) VALUES ($1, $2, 'NS-L', 'NS Konum', 0, 'STORAGE')",
          [tenantB, (wh.rows[0] as { id: string }).id],
        );
      } catch (e) {
        err = e as Error & { code?: string };
      }
      await c.query("ROLLBACK");
      expect(err?.code).toBe("42501");
      expect(err?.message).toContain("row-level security policy");
    });
  });

  // Her bekçi testi: tenant bağlamında tek kalıcı satır; staging down RAISE eder, satır yerinde kalır; ci down geçer.
  async function guardCase(opts: { target: string; fail: string; down: RegExp; table: string; insert: string; keep: string }): Promise<void> {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru12() })).applied).toEqual(ALL);
    const tenantId = randomUUID();
    await withClient(u, async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'NS Guard')", [tenantId, `ns-${randomBytes(4).toString("hex")}`]);
      await c.query(opts.insert, [tenantId]);
      await c.query("COMMIT");
      // Önkoşul: FORCE RLS altında bağlamsız sahip satırı GÖRMEZ (testin anlamı).
      const blind = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${opts.table}`);
      expect(blind.rows[0]?.n, "bağlamsız FORCE RLS sahibi satır görmemeli").toBe("0");
    });
    const before = await schemaDigest(u);

    await expect(migrateDown({ url: u, dir: thru12(), to: opts.target, wmsEnv: "staging" })).rejects.toThrow(opts.down);

    await withClient(u, async (c) => {
      // Bekçi RAISE etti: koşturucu migration başına transaction açar; bekçili migration (ve altındakiler) defterde durur.
      const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
      expect(ledger.rows.map((r) => r.version).filter((v) => v <= opts.fail)).toEqual(ALL.filter((v) => v <= opts.fail));
      // Tablo, FORCE RLS ve satır yerinde.
      const force = await c.query<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>(
        `SELECT relforcerowsecurity, relrowsecurity FROM pg_class WHERE oid = 'public.${opts.table}'::regclass`,
      );
      expect(force.rows).toEqual([{ relforcerowsecurity: true, relrowsecurity: true }]);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const kept = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${opts.table} WHERE ${opts.keep}`);
      await c.query("ROLLBACK");
      expect(kept.rows[0]?.n).toBe("1");
    });

    // Bayraklı ortam (ci): aynı dolu veritabanında geri alma çalışır; tekrar ileri hatasız.
    const down = await migrateDown({ url: u, dir: thru12(), to: opts.target, wmsEnv: "ci" });
    expect(down.reverted.length).toBeGreaterThan(0);
    expect((await migrateUp({ url: u, dir: thru12() })).applied).toEqual(ALL.filter((v) => v > opts.target));
    expect(await schemaDigest(u)).toEqual(before);
  }

  it("0010: dolu warehouses ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer", async () => {
    await guardCase({
      target: "0009",
      fail: "0010",
      down: /0010_warehouses_locations down:.*warehouses.*satır var/,
      table: "warehouses",
      insert: "INSERT INTO public.warehouses (tenant_id, code, name) VALUES ($1, 'NS-W1', 'NS Depo')",
      keep: "code = 'NS-W1'",
    });
  });

  it("0011: dolu units ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer", async () => {
    await guardCase({
      target: "0010",
      fail: "0011",
      down: /0011_catalog_traceability down:.*units.*satır var/,
      table: "units",
      insert: "INSERT INTO public.units (tenant_id, code, name) VALUES ($1, 'NS-U1', 'NS Birim')",
      keep: "code = 'NS-U1'",
    });
  });

  it("0012: dolu number_sequences ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer", async () => {
    await guardCase({
      target: "0011",
      fail: "0012",
      down: /0012_stock_documents down:.*number_sequences.*satır var/,
      table: "number_sequences",
      insert: "INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'STOCK_IN', 'NS-2026')",
      keep: "period = 'NS-2026'",
    });
  });
});

// 0013–0014 (T-236; T-211 security-reviewer MINOR-1): 0001–0014 ileri → 0014, 0013 geri → ileri; dolu tablo down bekçileri;
// wms_probe.active_tenant_ids (SET ROLE kalıbı) süper kullanıcı olmayan migrator ile.
describe("0013–0014 — süper kullanıcı olmayan migrator", () => {
  let thru14Dir: string | undefined;
  const thru14 = (): string => (thru14Dir ??= copyMigrations("0014"));
  const ALL14 = ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014"];
  const FN = "wms_probe.active_tenant_ids(uuid, integer)";

  /** thru12 describe'ındaki ile aynı kapsamlı şema parmak izi (tetikleyici durumu, sütun ACL, işlev gövdesi dahil). */
  async function schemaDigest(u: string): Promise<Record<string, string>> {
    return withClient(u, async (c) => {
      const q = async (sql: string): Promise<string> => (await c.query<{ d: string }>(sql)).rows[0]?.d ?? "";
      const nsp = `n.nspname IN ('public', 'wms_probe', 'wms_meta')`;
      return {
        columns: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', table_schema, table_name, column_name, ordinal_position, data_type, is_nullable, coalesce(column_default, '')), E'\\n' ORDER BY table_schema, table_name, ordinal_position), '')) AS d
             FROM information_schema.columns WHERE table_schema IN ('public', 'wms_probe', 'wms_meta')`,
        ),
        rls: await q(
          `SELECT md5(coalesce(string_agg(format('%I.%I:%s:%s', n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity), ',' ORDER BY n.nspname, c.relname), '')) AS d
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND ${nsp}`,
        ),
        policies: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check), ',' ORDER BY schemaname, tablename, policyname), '')) AS d FROM pg_policies`,
        ),
        constraints: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, cl.relname, co.conname, pg_get_constraintdef(co.oid)), ',' ORDER BY n.nspname, cl.relname, co.conname), '')) AS d
             FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE ${nsp}`,
        ),
        indexes: await q(`SELECT md5(coalesce(string_agg(indexdef, ',' ORDER BY indexname), '')) AS d FROM pg_indexes WHERE schemaname IN ('public', 'wms_probe')`),
        functions: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, p.oid::regprocedure::text, p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text, md5(p.prosrc)), ',' ORDER BY n.nspname, p.oid::regprocedure::text), '')) AS d
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'wms_probe')`,
        ),
        triggers: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', t.tgrelid::regclass::text, t.tgname, t.tgenabled, t.tgfoid::regprocedure::text), ',' ORDER BY t.tgrelid::regclass::text, t.tgname), '')) AS d
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND ${nsp}`,
        ),
        columnAcl: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, c.relname, a.attname, x.grantee::regrole::text, x.privilege_type, x.is_grantable), ',' ORDER BY n.nspname, c.relname, a.attname, x.grantee::regrole::text, x.privilege_type), '')) AS d
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attacl IS NOT NULL AND NOT a.attisdropped AND ${nsp}`,
        ),
        tableAcl: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, c.relname, c.relowner::regrole::text, c.relacl::text), ',' ORDER BY n.nspname, c.relname), '')) AS d
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND ${nsp}`,
        ),
        schemaAcl: await q(
          `SELECT md5(coalesce(string_agg(concat_ws('|', n.nspname, n.nspowner::regrole::text, n.nspacl::text), ',' ORDER BY n.nspname), '')) AS d
             FROM pg_namespace n WHERE ${nsp}`,
        ),
      };
    });
  }

  /** active_tenant_ids sahipliği/ACL'i (migrator kataloğundan): birebir karşılaştırma için düz nesne. */
  async function probeFunction(u: string): Promise<Record<string, unknown>> {
    return withClient(u, async (c) => {
      const r = await c.query<Record<string, unknown>>(
        `SELECT p.proowner::regrole::text AS owner, p.prosecdef AS secdef, p.proconfig AS config, p.proacl::text[] AS acl, p.provolatile AS volatility,
                has_function_privilege('wms_worker', '${FN}', 'EXECUTE') AS worker_exec,
                has_function_privilege('wms_app', '${FN}', 'EXECUTE') AS app_exec,
                has_function_privilege('wms_auth', '${FN}', 'EXECUTE') AS auth_exec,
                has_function_privilege('wms_ops', '${FN}', 'EXECUTE') AS ops_exec,
                has_schema_privilege('wms_worker', 'wms_probe', 'USAGE') AS worker_usage,
                has_schema_privilege('${PROBE}', 'wms_probe', 'CREATE') AS probe_create,
                has_table_privilege('wms_worker', 'public.tenants', 'SELECT') AS worker_tenants_select,
                (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'wms_probe') AS schema_acl,
                current_user = session_user AS same
           FROM pg_proc p WHERE p.oid = '${FN}'::regprocedure`,
      );
      return r.rows[0] as Record<string, unknown>;
    });
  }

  function expectProbeFunction(f: Record<string, unknown>): void {
    expect(f).toMatchObject({
      owner: PROBE, secdef: true, config: ["search_path=pg_catalog, pg_temp"], volatility: "s",
      worker_exec: true, app_exec: false, auth_exec: false, ops_exec: false,
      worker_usage: true, probe_create: false, worker_tenants_select: false, same: true,
    });
    expect(f.acl).not.toBeNull();
    expect(((f.acl as string[]) ?? []).filter((a) => a.startsWith("="))).toEqual([]); // PUBLIC girdisi yok
  }

  /** Süper kullanıcı bağlantısı (yalnızca ROL DENEMESİ için: SET ROLE ile wms_worker/wms_app olarak çağırır). */
  function superUrlFor(migratorUrl: string): string {
    const u = new URL(superUrl);
    u.pathname = `/${decodeURIComponent(new URL(migratorUrl).pathname.slice(1))}`;
    return u.toString();
  }

  it("ileri (0001–0014) → 0014, 0013 geri (to 0012) → ileri; parmak izi ve active_tenant_ids sahip/ACL ilk ileri koşuyla birebir; süper kullanıcı yok", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru14() })).applied).toEqual(ALL14);
    const before = await schemaDigest(u);
    const fnBefore = await probeFunction(u);
    expect(Object.values(before).every((d) => d.length === 32)).toBe(true);
    expectProbeFunction(fnBefore);
    await withClient(u, async (c) => {
      const r = await c.query<{ su: boolean; byp: boolean }>("SELECT rolsuper AS su, rolbypassrls AS byp FROM pg_roles WHERE rolname = current_user");
      expect(r.rows).toEqual([{ su: false, byp: false }]);
    });

    expect((await migrateDown({ url: u, dir: thru14(), to: "0012", wmsEnv: "ci" })).reverted).toEqual(["0014", "0013"]);
    const mid = await schemaDigest(u);
    expect(mid).not.toEqual(before);
    await withClient(u, async (c) => {
      const gone = await c.query(
        `SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('stock_dimensions', 'stock_ledger', 'processed_events', 'stock_consistency_runs', 'stock_consistency_signals')
         UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wms_probe' AND p.proname = 'active_tenant_ids'`,
      );
      expect(gone.rows).toEqual([]);
      // 0014 down: wms_worker'ın şema USAGE'ı geri alınmış.
      const usage = await c.query<{ u: boolean }>("SELECT has_schema_privilege('wms_worker', 'wms_probe', 'USAGE') AS u");
      expect(usage.rows).toEqual([{ u: false }]);
    });

    expect((await migrateUp({ url: u, dir: thru14() })).applied).toEqual(["0013", "0014"]);
    expect(await schemaDigest(u)).toEqual(before);
    const fnAfter = await probeFunction(u);
    expect(fnAfter).toEqual(fnBefore);
    expectProbeFunction(fnAfter);
  });

  it("wms_worker rolü yoksa 0014 ön kontrolü RAISE eder (önkoşul testin anlamlı olduğunu kanıtlar); rol geri gelince ileri geçer", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: copyMigrations("0013") })).applied).toEqual(ALL14.filter((v) => v <= "0013"));
    // Rol küme geneli: yalnızca bu satırlık pencerede kaldırılır; başka dosya bu örneği paylaşmaz (ayrı container).
    await asSuper((c) => c.query("ALTER ROLE wms_worker RENAME TO wms_worker_tmp"));
    try {
      await expect(migrateUp({ url: u, dir: thru14() })).rejects.toThrow(/0014_reliability: wms_worker rolü yok/);
    } finally {
      await asSuper((c) => c.query("ALTER ROLE wms_worker_tmp RENAME TO wms_worker"));
    }
    expect((await migrateUp({ url: u, dir: thru14() })).applied).toEqual(["0014"]);
  });

  it("active_tenant_ids SET ROLE kalıbı gerçekten çalıştı: wms_worker yalnızca ACTIVE tenant kimliklerini sayfalı alır; wms_app/tenants SELECT reddedilir", async () => {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru14() })).applied).toEqual(ALL14);
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    await withClient(u, async (c) => {
      for (const t of ids) {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [t]);
        await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'NS Probe')", [t, `ns-${randomBytes(4).toString("hex")}`]);
        await c.query("COMMIT");
      }
    });
    const zero = "00000000-0000-0000-0000-000000000000";
    await withClient(superUrlFor(u), async (c) => {
      await c.query("SET ROLE wms_worker");
      const all = await c.query<{ id: string }>(`SELECT * FROM wms_probe.active_tenant_ids($1, 10) AS id`, [zero]);
      expect(all.rows.map((r) => Object.values(r)[0])).toEqual(ids);
      const page = await c.query(`SELECT * FROM wms_probe.active_tenant_ids($1, 1)`, [ids[0]]);
      expect(page.rows.map((r) => Object.values(r)[0])).toEqual([ids[1]]);
      // wms_worker tenants'a doğrudan erişemez.
      await expect(c.query("SELECT count(*) FROM public.tenants")).rejects.toMatchObject({ code: "42501" });
      await c.query("RESET ROLE");
      // Başka roller işlevi çağıramaz.
      for (const role of ["wms_app", "wms_auth", "wms_ops"]) {
        await c.query(`SET ROLE ${role}`);
        await expect(c.query(`SELECT * FROM wms_probe.active_tenant_ids($1, 1)`, [zero]), role).rejects.toMatchObject({ code: "42501" });
        await c.query("RESET ROLE");
      }
    });
  });

  // Her bekçi testi: tenant bağlamında tek kalıcı satır; staging down RAISE eder, satır yerinde kalır; ci down geçer.
  async function guardCase(opts: { target: string; fail: string; down: RegExp; table: string; insert: (c: pg.Client, tenantId: string) => Promise<void>; keep: string }): Promise<void> {
    await setProbeMemberships(STANDARD_GRANT);
    const u = await freshDatabase();
    expect((await migrateUp({ url: u, dir: thru14() })).applied).toEqual(ALL14);
    const tenantId = randomUUID();
    await withClient(u, async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'NS Guard')", [tenantId, `ns-${randomBytes(4).toString("hex")}`]);
      await opts.insert(c, tenantId);
      await c.query("COMMIT");
      const blind = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${opts.table}`);
      expect(blind.rows[0]?.n, "bağlamsız FORCE RLS sahibi satır görmemeli").toBe("0");
    });
    const before = await schemaDigest(u);

    await expect(migrateDown({ url: u, dir: thru14(), to: opts.target, wmsEnv: "staging" })).rejects.toThrow(opts.down);

    await withClient(u, async (c) => {
      const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
      expect(ledger.rows.map((r) => r.version).filter((v) => v <= opts.fail)).toEqual(ALL14.filter((v) => v <= opts.fail));
      const force = await c.query<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>(
        `SELECT relforcerowsecurity, relrowsecurity FROM pg_class WHERE oid = 'public.${opts.table}'::regclass`,
      );
      expect(force.rows).toEqual([{ relforcerowsecurity: true, relrowsecurity: true }]);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const kept = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${opts.table} WHERE ${opts.keep}`);
      await c.query("ROLLBACK");
      expect(kept.rows[0]?.n).toBe("1");
    });

    const down = await migrateDown({ url: u, dir: thru14(), to: opts.target, wmsEnv: "ci" });
    expect(down.reverted.length).toBeGreaterThan(0);
    expect((await migrateUp({ url: u, dir: thru14() })).applied).toEqual(ALL14.filter((v) => v > opts.target));
    expect(await schemaDigest(u)).toEqual(before);
    expectProbeFunction(await probeFunction(u));
  }

  it("0013: dolu stock_dimensions ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer", async () => {
    await guardCase({
      target: "0012",
      fail: "0013",
      down: /0013_stock_ledger down:.*stock_dimensions.*satır var/,
      table: "stock_dimensions",
      insert: async (c, t) => {
        await c.query("INSERT INTO public.units (tenant_id, code, name) VALUES ($1, 'NS-U', 'NS Birim')", [t]);
        await c.query("INSERT INTO public.warehouses (tenant_id, code, name) VALUES ($1, 'NS-W', 'NS Depo')", [t]);
        await c.query(
          `INSERT INTO public.items (tenant_id, code, name, base_unit_id)
           SELECT $1, 'NS-I', 'NS Kalem', id FROM public.units WHERE code = 'NS-U'`,
          [t],
        );
        await c.query(
          `INSERT INTO public.locations (tenant_id, warehouse_id, code, name, depth, kind)
           SELECT $1, id, 'NS-L', 'NS Konum', 0, 'STORAGE' FROM public.warehouses WHERE code = 'NS-W'`,
          [t],
        );
        await c.query(
          `INSERT INTO public.stock_dimensions (tenant_id, item_id, location_id)
           SELECT $1, i.id, l.id FROM public.items i, public.locations l WHERE i.code = 'NS-I' AND l.code = 'NS-L'`,
          [t],
        );
      },
      keep: "stock_status = 'AVAILABLE'",
    });
  });

  it("0014: dolu processed_events ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer", async () => {
    await guardCase({
      target: "0013",
      fail: "0014",
      down: /0014_reliability down:.*processed_events.*satır var/,
      table: "processed_events",
      insert: async (c, t) => {
        await c.query("INSERT INTO public.processed_events (tenant_id, consumer, event_id) VALUES ($1, 'ns.consumer', $2)", [t, randomUUID()]);
      },
      keep: "consumer = 'ns.consumer'",
    });
  });

  it("0014: dolu stock_consistency_runs ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer", async () => {
    await guardCase({
      target: "0013",
      fail: "0014",
      down: /0014_reliability down:.*stock_consistency_runs.*satır var/,
      table: "stock_consistency_runs",
      insert: async (c, t) => {
        await c.query("SELECT set_config('app.system_reason', 'queue.stock.consistency.check', true)");
        await c.query(
          `INSERT INTO public.stock_consistency_runs (tenant_id, job_id, started_at, finished_at, status, checked_dimensions, mismatch_count)
           VALUES ($1, $2, now(), now(), 'OK', 0, 0)`,
          [t, randomUUID()],
        );
      },
      keep: "status = 'OK'",
    });
  });

  // ---- 0016 (T-301): saha belgeleri; genişlet–taşı–daralt; süper kullanıcı olmayan migrator ----
  describe("0016 field_documents", () => {
    let thru16Dir: string | undefined;
    const thru16 = (): string => (thru16Dir ??= copyMigrations("0016"));
    const ALL16 = [...ALL14, "0015", "0016"];
    const NEW16 = ["inbound_receipts", "inbound_receipt_lines", "sales_orders", "sales_order_lines", "customer_returns", "customer_return_lines"];

    /**
     * Parmak izi (schemaDigest) — ORDINAL HARİÇ sütun özeti. ALTER TABLE ... DROP COLUMN sonrası yeniden eklenen sütun, PostgreSQL'de yeni
     * (daha büyük) attnum alır (atılan numara boşluk olarak kalır); bu yüzden genişletme migration'ında information_schema ordinal_position
     * ileri → geri → ileri sonrası değişir. Sütunların göreli sırası, adı, tipi, NULL'luğu ve varsayılanı korunmalıdır: ordinal yerine
     * tablo içi sıra numarası kullanılır. Diğer tüm parmak izi anahtarları schemaDigest ile birebir karşılaştırılır.
     */
    async function digest16(u: string): Promise<Record<string, string>> {
      const d = await schemaDigest(u);
      const cols = await withClient(u, async (c) => {
        const r = await c.query<{ d: string }>(
          `SELECT md5(coalesce(string_agg(concat_ws('|', table_schema, table_name, column_name, rn, data_type, is_nullable, coalesce(column_default, '')), E'\n' ORDER BY table_schema, table_name, rn), '')) AS d
             FROM (SELECT *, row_number() OVER (PARTITION BY table_schema, table_name ORDER BY ordinal_position) AS rn
                     FROM information_schema.columns WHERE table_schema IN ('public', 'wms_probe', 'wms_meta')) x`,
        );
        return r.rows[0]?.d ?? "";
      });
      return { ...d, columns: cols };
    }

    /** Tek tenant + depo/lokasyon/ürün/birim tohumu (migrator = tablo sahibi; FORCE RLS için tenant bağlamı transaction-local). */
    async function seedBase(c: pg.Client, t: string): Promise<void> {
      await c.query("INSERT INTO public.units (tenant_id, code, name) VALUES ($1, 'NS-U', 'NS Birim')", [t]);
      await c.query("INSERT INTO public.warehouses (tenant_id, code, name) VALUES ($1, 'NS-W', 'NS Depo')", [t]);
      await c.query(
        `INSERT INTO public.items (tenant_id, code, name, base_unit_id)
         SELECT $1, 'NS-I', 'NS Kalem', id FROM public.units WHERE code = 'NS-U'`,
        [t],
      );
      await c.query(
        `INSERT INTO public.locations (tenant_id, warehouse_id, code, name, depth, kind)
         SELECT $1, id, 'NS-L', 'NS Konum', 0, 'STORAGE' FROM public.warehouses WHERE code = 'NS-W'`,
        [t],
      );
    }

    async function freshTenant(u: string, work: (c: pg.Client, t: string) => Promise<void>): Promise<string> {
      const tenantId = randomUUID();
      await withClient(u, async (c) => {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
        await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'NS 0016')", [tenantId, `ns-${randomBytes(4).toString("hex")}`]);
        await work(c, tenantId);
        await c.query("COMMIT");
      });
      return tenantId;
    }

    it("ileri (0001–0016) → 0016 geri (to 0015) → ileri: parmak izi birebir; yeni tablolar/sütunlar down'da yok, reservations.document_line_id NOT NULL geri gelir", async () => {
      await setProbeMemberships(STANDARD_GRANT);
      const u = await freshDatabase();
      expect((await migrateUp({ url: u, dir: thru16() })).applied).toEqual(ALL16);
      const before = await digest16(u);
      expectProbeFunction(await probeFunction(u));
      await withClient(u, async (c) => {
        const r = await c.query<{ su: boolean; byp: boolean }>("SELECT rolsuper AS su, rolbypassrls AS byp FROM pg_roles WHERE rolname = current_user");
        expect(r.rows).toEqual([{ su: false, byp: false }]);
        const f = await c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY 1",
          [NEW16],
        );
        expect(f.rows.map((x) => [x.relname, x.relrowsecurity, x.relforcerowsecurity])).toEqual([...NEW16].sort().map((n) => [n, true, true]));
      });

      expect((await migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "ci" })).reverted).toEqual(["0016"]);
      expect(await digest16(u)).not.toEqual(before);
      await withClient(u, async (c) => {
        const gone = await c.query(
          `SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])
           UNION ALL SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND (table_name, column_name) IN (('documents', 'source_kind'), ('documents', 'source_id'), ('document_lines', 'source_line_id'), ('document_lines', 'target_stock_status'),
                                                ('reservations', 'order_line_id'), ('tenant_settings', 'receiving_qc_enabled'))
           UNION ALL SELECT 1 FROM pg_proc WHERE proname IN ('field_docs_bump_version', 'field_docs_guard_keys', 'field_docs_lines_guard_closed')`,
          [NEW16],
        );
        expect(gone.rows).toEqual([]);
        const nn = await c.query<{ is_nullable: string }>("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'reservations' AND column_name = 'document_line_id'");
        expect(nn.rows).toEqual([{ is_nullable: "NO" }]);
        const force = await c.query<{ relname: string; f: boolean }>(
          "SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('documents', 'document_lines', 'reservations', 'tenant_settings') ORDER BY 1",
        );
        expect(force.rows.every((x) => x.f), "down sonrası FORCE RLS geri açık olmalı").toBe(true);
      });

      expect((await migrateUp({ url: u, dir: thru16() })).applied).toEqual(["0016"]);
      expect(await digest16(u)).toEqual(before);
      expectProbeFunction(await probeFunction(u));
    });

    it("dolu inbound_receipts ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer; yeniden ileri parmak izi birebir", async () => {
      await setProbeMemberships(STANDARD_GRANT);
      const u = await freshDatabase();
      expect((await migrateUp({ url: u, dir: thru16() })).applied).toEqual(ALL16);
      const tenantId = await freshTenant(u, async (c, t) => {
        await seedBase(c, t);
        await c.query(
          `INSERT INTO public.inbound_receipts (tenant_id, warehouse_id, number, created_by)
           SELECT $1, id, 'NS-GR-1', $2 FROM public.warehouses WHERE code = 'NS-W'`,
          [t, randomUUID()],
        );
      });
      const before = await digest16(u);
      await expect(migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "staging" })).rejects.toThrow(/0016_field_documents down:.*inbound_receipts.*satır var/);
      await withClient(u, async (c) => {
        const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
        expect(ledger.rows.map((r) => r.version)).toEqual(ALL16);
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
        const kept = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.inbound_receipts WHERE number = 'NS-GR-1'");
        await c.query("ROLLBACK");
        expect(kept.rows[0]?.n).toBe("1");
        const force = await c.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'public.inbound_receipts'::regclass");
        expect(force.rows).toEqual([{ f: true }]);
      });
      expect((await migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "ci" })).reverted).toEqual(["0016"]);
      expect((await migrateUp({ url: u, dir: thru16() })).applied).toEqual(["0016"]);
      expect(await digest16(u)).toEqual(before);
    });

    it("kaynak bağlantılı belge / receiving_qc_enabled=false ile staging geri alma RAISE eder; ci bayrağıyla geçer", async () => {
      await setProbeMemberships(STANDARD_GRANT);
      const u = await freshDatabase();
      expect((await migrateUp({ url: u, dir: thru16() })).applied).toEqual(ALL16);
      await freshTenant(u, async (c, t) => {
        await seedBase(c, t);
        await c.query(
          `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status, receiving_qc_enabled) VALUES ($1, 'tr-TR', 'Europe/Istanbul', 'PENDING', false)`,
          [t],
        );
      });
      await expect(migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "staging" })).rejects.toThrow(/0016_field_documents down:.*tenant_settings.*receiving_qc_enabled = false/);
      expect((await migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "ci" })).reverted).toEqual(["0016"]);
      expect((await migrateUp({ url: u, dir: thru16() })).applied).toEqual(["0016"]);

      await freshTenant(u, async (c, t) => {
        await seedBase(c, t);
        await c.query(
          `INSERT INTO public.documents (tenant_id, kind, type_version_id, warehouse_id, business_date, created_by, source_kind, source_id)
           SELECT $1, 'STOCK_IN', v.id, w.id, '2026-02-01', $2, 'TASK', $3
             FROM public.document_type_versions v, public.warehouses w WHERE v.tenant_id IS NULL AND v.key = 'STOCK_IN' AND w.code = 'NS-W'`,
          [t, randomUUID(), randomUUID()],
        );
      });
      await expect(migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "staging" })).rejects.toThrow(/0016_field_documents down:.*documents.*kaynak bağlantılı satır var/);
      expect((await migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "ci" })).reverted).toEqual(["0016"]);
    });

    it("sipariş satırına bağlı ACTIVE rezervasyon varken geri alma ci bayrağıyla bile RAISE eder (rezerve toplamı sessizce bozulmaz); serbest bırakılınca geçer", async () => {
      await setProbeMemberships(STANDARD_GRANT);
      const u = await freshDatabase();
      expect((await migrateUp({ url: u, dir: thru16() })).applied).toEqual(ALL16);
      const tenantId = await freshTenant(u, async (c, t) => {
        await seedBase(c, t);
        await c.query(
          `INSERT INTO public.documents (id, tenant_id, kind, type_version_id, warehouse_id, business_date, created_by)
           SELECT '00000000-0000-4000-8000-0000000000d1', $1, 'STOCK_IN', v.id, w.id, '2026-02-01', $2
             FROM public.document_type_versions v, public.warehouses w WHERE v.tenant_id IS NULL AND v.key = 'STOCK_IN' AND w.code = 'NS-W'`,
          [t, randomUUID()],
        );
        await c.query(
          `INSERT INTO public.document_lines (id, tenant_id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id)
           SELECT '00000000-0000-4000-8000-0000000000e1', $1, '00000000-0000-4000-8000-0000000000d1', 1, i.id, i.base_unit_id, 5, 1, 5, l.id
             FROM public.items i, public.locations l WHERE i.code = 'NS-I' AND l.code = 'NS-L'`,
          [t],
        );
        await c.query(
          `INSERT INTO public.stock_dimensions (id, tenant_id, item_id, location_id)
           SELECT '00000000-0000-4000-8000-0000000000f1', $1, i.id, l.id FROM public.items i, public.locations l WHERE i.code = 'NS-I' AND l.code = 'NS-L'`,
          [t],
        );
        await c.query(
          `INSERT INTO public.stock_ledger (tenant_id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date)
           VALUES ($1, '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000f1', 5, 'ns', '2026-02-01')`,
          [t],
        );
        await c.query("INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, reserved_quantity) VALUES ($1, '00000000-0000-4000-8000-0000000000f1', 5, 2)", [t]);
        await c.query(
          `INSERT INTO public.sales_orders (id, tenant_id, number, created_by) VALUES ('00000000-0000-4000-8000-0000000000a1', $1, 'NS-SO-1', $2)`,
          [t, randomUUID()],
        );
        await c.query(
          `INSERT INTO public.sales_order_lines (id, tenant_id, order_id, line_no, item_id, requested_quantity)
           SELECT '00000000-0000-4000-8000-0000000000b1', $1, '00000000-0000-4000-8000-0000000000a1', 1, id, 5 FROM public.items WHERE code = 'NS-I'`,
          [t],
        );
        await c.query(
          `INSERT INTO public.reservations (id, tenant_id, stock_dimension_id, order_line_id, quantity)
           VALUES ('00000000-0000-4000-8000-0000000000c1', $1, '00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000b1', 2)`,
          [t],
        );
      });
      await expect(migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "ci" })).rejects.toThrow(/0016_field_documents down:.*ACTIVE rezervasyon var/);
      await withClient(u, async (c) => {
        const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
        expect(ledger.rows.map((r) => r.version)).toEqual(ALL16);
        const f = await c.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'public.reservations'::regclass");
        expect(f.rows).toEqual([{ f: true }]);
        // Serbest bırak (ACTIVE → RELEASED) ve bakiyedeki rezerve miktarı sıfırla (aynı transaction'da ertelenmiş denetim tutarlı).
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
        await c.query("UPDATE public.reservations SET status = 'RELEASED' WHERE id = '00000000-0000-4000-8000-0000000000c1'");
        await c.query("UPDATE public.stock_balances SET reserved_quantity = 0 WHERE stock_dimension_id = '00000000-0000-4000-8000-0000000000f1'");
        await c.query("COMMIT");
      });
      await expect(migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "staging" })).rejects.toThrow(/0016_field_documents down:.*satır var/);
      expect((await migrateDown({ url: u, dir: thru16(), to: "0015", wmsEnv: "ci" })).reverted).toEqual(["0016"]);
      await withClient(u, async (c) => {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
        const n = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.reservations");
        await c.query("ROLLBACK");
        expect(n.rows[0]?.n).toBe("0");
      });
    });

    // ---- 0017 (T-302): görev/sayım/min-maks/COUNT_ADJUSTMENT; süper kullanıcı olmayan migrator (0016 yardımcılarını kullanır) ----
    describe("0017 tasks_counts_alerts", () => {
      let thru17Dir: string | undefined;
      const thru17 = (): string => (thru17Dir ??= copyMigrations("0017"));
      const ALL17 = [...ALL16, "0017"];
      const NEW17 = ["warehouse_tasks", "count_sessions", "count_session_lines", "item_stock_policies", "stock_alerts"];
      const FUNCS17 = ["warehouse_tasks_guard_state", "count_sessions_guard_state", "count_session_lines_guard_state", "count_session_lines_guard_closed", "stock_alerts_guard_state"];

      it("ileri (0001–0017) → 0017 geri (to 0016) → ileri: parmak izi birebir; tablolar/işlevler/sütun/FK/COUNT_ADJUSTMENT down'da yok; eski CHECK'ler ve FORCE RLS geri gelir", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru17() })).applied).toEqual(ALL17);
        const before = await digest16(u);
        expectProbeFunction(await probeFunction(u));
        await withClient(u, async (c) => {
          const r = await c.query<{ su: boolean; byp: boolean }>("SELECT rolsuper AS su, rolbypassrls AS byp FROM pg_roles WHERE rolname = current_user");
          expect(r.rows).toEqual([{ su: false, byp: false }]);
          const f = await c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY 1",
            [NEW17],
          );
          expect(f.rows.map((x) => [x.relname, x.relrowsecurity, x.relforcerowsecurity])).toEqual([...NEW17].sort().map((n) => [n, true, true]));
          const sys = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM public.document_type_versions WHERE tenant_id IS NULL AND key = 'COUNT_ADJUSTMENT' AND version = 1");
          expect(sys.rows[0]?.n).toBe(1);
        });

        expect((await migrateDown({ url: u, dir: thru17(), to: "0016", wmsEnv: "ci" })).reverted).toEqual(["0017"]);
        expect(await digest16(u)).not.toEqual(before);
        await withClient(u, async (c) => {
          const gone = await c.query(
            `SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])
             UNION ALL SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenant_settings' AND column_name = 'count_abandon_hours'
             UNION ALL SELECT 1 FROM pg_proc WHERE proname = ANY($2::text[])
             UNION ALL SELECT 1 FROM pg_constraint WHERE conname = 'location_count_locks_session_fkey'
             UNION ALL SELECT 1 FROM pg_class WHERE relname = 'location_count_locks_tenant_session_idx'
             UNION ALL SELECT 1 FROM public.document_type_versions WHERE key = 'COUNT_ADJUSTMENT'`,
            [NEW17, FUNCS17],
          );
          expect(gone.rows).toEqual([]);
          const chk = await c.query<{ conname: string; def: string }>(
            "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('documents_kind_chk', 'number_sequences_kind_chk') ORDER BY 1",
          );
          for (const x of chk.rows) {
            expect(x.def, x.conname).not.toContain("COUNT_ADJUSTMENT");
            expect(x.def, x.conname).toContain("REVERSAL");
          }
          expect(chk.rows).toHaveLength(2);
          const trg = await c.query<{ tgenabled: string }>("SELECT tgenabled FROM pg_trigger WHERE tgname = 'document_type_versions_immutable'");
          expect(trg.rows).toEqual([{ tgenabled: "A" }]);
          const force = await c.query<{ relname: string; f: boolean }>(
            "SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('documents', 'number_sequences', 'tenant_settings', 'document_type_versions', 'location_count_locks') ORDER BY 1",
          );
          expect(force.rows).toHaveLength(5);
          expect(force.rows.every((x) => x.f), "down sonrası FORCE RLS geri açık olmalı").toBe(true);
          const a85 = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'location_count_locks_state_chk'");
          expect(a85.rows[0]?.n).toBe(1);
        });

        expect((await migrateUp({ url: u, dir: thru17() })).applied).toEqual(["0017"]);
        expect(await digest16(u)).toEqual(before);
        expectProbeFunction(await probeFunction(u));
      });

      it("dolu warehouse_tasks ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer; yeniden ileri parmak izi birebir", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru17() })).applied).toEqual(ALL17);
        const tenantId = await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          await c.query("INSERT INTO public.warehouse_tasks (tenant_id, warehouse_id, kind) SELECT $1, id, 'PICK' FROM public.warehouses WHERE code = 'NS-W'", [t]);
        });
        const before = await digest16(u);
        await expect(migrateDown({ url: u, dir: thru17(), to: "0016", wmsEnv: "staging" })).rejects.toThrow(/0017_tasks_counts_alerts down:.*warehouse_tasks.*satır var/);
        await withClient(u, async (c) => {
          const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
          expect(ledger.rows.map((r) => r.version)).toEqual(ALL17);
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          const kept = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.warehouse_tasks");
          await c.query("ROLLBACK");
          expect(kept.rows[0]?.n).toBe("1");
          const force = await c.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'public.warehouse_tasks'::regclass");
          expect(force.rows).toEqual([{ f: true }]);
        });
        expect((await migrateDown({ url: u, dir: thru17(), to: "0016", wmsEnv: "ci" })).reverted).toEqual(["0017"]);
        expect((await migrateUp({ url: u, dir: thru17() })).applied).toEqual(["0017"]);
        expect(await digest16(u)).toEqual(before);
      });

      it("count_abandon_hours <> 8 / COUNT_ADJUSTMENT sayacı ile staging geri alma RAISE eder; ci bayrağıyla geçer", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru17() })).applied).toEqual(ALL17);
        await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          await c.query(`INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status, count_abandon_hours) VALUES ($1, 'tr-TR', 'Europe/Istanbul', 'PENDING', 12)`, [t]);
          await c.query("INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'COUNT_ADJUSTMENT', '2026')", [t]);
        });
        await expect(migrateDown({ url: u, dir: thru17(), to: "0016", wmsEnv: "staging" })).rejects.toThrow(/0017_tasks_counts_alerts down:.*(number_sequences.*COUNT_ADJUSTMENT|tenant_settings.*count_abandon_hours)/);
        expect((await migrateDown({ url: u, dir: thru17(), to: "0016", wmsEnv: "ci" })).reverted).toEqual(["0017"]);
        expect((await migrateUp({ url: u, dir: thru17() })).applied).toEqual(["0017"]);
      });

      it("COUNT_ADJUSTMENT belgesi varken geri alma ci bayrağıyla bile RAISE eder (işlenmiş belge silinemez); ledger/izler yerinde kalır", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru17() })).applied).toEqual(ALL17);
        await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          await c.query(
            `INSERT INTO public.documents (tenant_id, kind, type_version_id, warehouse_id, business_date, created_by)
             SELECT $1, 'COUNT_ADJUSTMENT', v.id, w.id, '2026-02-01', $2
               FROM public.document_type_versions v, public.warehouses w WHERE v.tenant_id IS NULL AND v.key = 'COUNT_ADJUSTMENT' AND w.code = 'NS-W'`,
            [t, randomUUID()],
          );
        });
        await expect(migrateDown({ url: u, dir: thru17(), to: "0016", wmsEnv: "ci" })).rejects.toThrow(/0017_tasks_counts_alerts down:.*COUNT_ADJUSTMENT belgesi var/);
        await withClient(u, async (c) => {
          const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
          expect(ledger.rows.map((r) => r.version)).toEqual(ALL17);
          const force = await c.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'public.documents'::regclass");
          expect(force.rows).toEqual([{ f: true }]);
          const sys = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM public.document_type_versions WHERE key = 'COUNT_ADJUSTMENT'");
          expect(sys.rows[0]?.n).toBe(1);
        });
      });

      it("0016 durumunda COUNTING kilit satırı (yetim count_session_id) varken 0017 ileri açık hata ile durur, hiçbir şey uygulanmaz; satır yerinde", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru16() })).applied).toEqual(ALL16);
        const tenantId = await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          const user = await c.query<{ id: string }>("INSERT INTO public.users (name, email) VALUES ('NS', $1) RETURNING id", [`ns-${randomBytes(4).toString("hex")}@example.test`]);
          const m = await c.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', true) RETURNING id", [t, user.rows[0]?.id]);
          await c.query(
            "UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE tenant_id = $1",
            [t, randomUUID(), m.rows[0]?.id],
          );
        });
        await expect(migrateUp({ url: u, dir: thru17() })).rejects.toThrow(/0017_tasks_counts_alerts: 1 kilit satırı count_session_id taşıyor/);
        await withClient(u, async (c) => {
          const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
          expect(ledger.rows.map((r) => r.version)).toEqual(ALL16);
          const t = await c.query("SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'count_sessions'");
          expect(t.rows).toEqual([]);
          const force = await c.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'public.location_count_locks'::regclass");
          expect(force.rows).toEqual([{ f: true }]);
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          const kept = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.location_count_locks WHERE status = 'COUNTING'");
          await c.query("ROLLBACK");
          expect(kept.rows[0]?.n).toBe("1");
        });
      });
    });

    // ---- 0018 (T-251): code_history + kod UPDATE yetkisi; süper kullanıcı olmayan migrator ----
    describe("0018 code_history", () => {
      let thru18Dir: string | undefined;
      const thru18 = (): string => (thru18Dir ??= copyMigrations("0018"));
      const ALL18 = [...ALL16, "0017", "0018"];
      const priv = async (u: string): Promise<Record<string, boolean>> =>
        withClient(u, async (c) => {
          const r = await c.query<Record<string, boolean>>(
            `SELECT has_column_privilege('wms_app', 'public.items', 'code', 'UPDATE') AS items_code,
                    has_column_privilege('wms_app', 'public.warehouses', 'code', 'UPDATE') AS wh_code,
                    has_column_privilege('wms_app', 'public.locations', 'code', 'UPDATE') AS loc_code`,
          );
          return r.rows[0] ?? {};
        });

      it("ileri (0001–0018) → 0018 geri (to 0017) → ileri: parmak izi birebir; tablo ve kod UPDATE yetkisi down'da yok; RLS FORCE; wms_app yalnızca SELECT/INSERT", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru18() })).applied).toEqual(ALL18);
        const before = await digest16(u);
        expect(await priv(u)).toEqual({ items_code: true, wh_code: true, loc_code: true });
        await withClient(u, async (c) => {
          const f = await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.code_history'::regclass",
          );
          expect(f.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
          const g = await c.query<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; fks: number }>(
            `SELECT has_table_privilege('wms_app', 'public.code_history', 'SELECT') AS sel,
                    has_any_column_privilege('wms_app', 'public.code_history', 'INSERT') AS ins,
                    has_any_column_privilege('wms_app', 'public.code_history', 'UPDATE') AS upd,
                    has_table_privilege('wms_app', 'public.code_history', 'DELETE') AS del,
                    (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.code_history'::regclass AND contype = 'f') AS fks`,
          );
          expect(g.rows).toEqual([{ sel: true, ins: true, upd: false, del: false, fks: 1 }]); // yalnızca tenants FK'si (polimorfik: bileşik FK yok)
        });

        expect((await migrateDown({ url: u, dir: thru18(), to: "0017", wmsEnv: "ci" })).reverted).toEqual(["0018"]);
        expect(await digest16(u)).not.toEqual(before);
        expect(await priv(u)).toEqual({ items_code: false, wh_code: false, loc_code: false });
        await withClient(u, async (c) => {
          const gone = await c.query("SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'code_history'");
          expect(gone.rows).toEqual([]);
        });
        expect((await migrateUp({ url: u, dir: thru18() })).applied).toEqual(["0018"]);
        expect(await digest16(u)).toEqual(before);
      });

      it("dolu code_history ile staging geri alma RAISE eder, veri yerinde; ci bayrağıyla geçer; yeniden ileri parmak izi birebir", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru18() })).applied).toEqual(ALL18);
        const tenantId = await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          await c.query(
            `INSERT INTO public.code_history (tenant_id, entity_type, entity_id, old_code, new_code, changed_by)
             SELECT $1, 'item', id, 'OLD', code, $2 FROM public.items WHERE code = 'NS-I'`,
            [t, randomUUID()],
          );
        });
        const before = await digest16(u);
        await expect(migrateDown({ url: u, dir: thru18(), to: "0017", wmsEnv: "staging" })).rejects.toThrow(/0018_code_history down:.*code_history.*satır var/);
        await withClient(u, async (c) => {
          const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
          expect(ledger.rows.map((r) => r.version)).toEqual(ALL18);
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          const kept = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.code_history");
          await c.query("ROLLBACK");
          expect(kept.rows[0]?.n).toBe("1");
          const force = await c.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'public.code_history'::regclass");
          expect(force.rows).toEqual([{ f: true }]);
        });
        expect((await migrateDown({ url: u, dir: thru18(), to: "0017", wmsEnv: "ci" })).reverted).toEqual(["0018"]);
        expect((await migrateUp({ url: u, dir: thru18() })).applied).toEqual(["0018"]);
        expect(await digest16(u)).toEqual(before);
      });
    });

    // ---- 0019 (T-252): external_refs + sync_cursors; süper kullanıcı olmayan migrator ----
    describe("0019 external_refs", () => {
      let thru19Dir: string | undefined;
      const thru19 = (): string => (thru19Dir ??= copyMigrations("0019"));
      const ALL19 = [...ALL16, "0017", "0018", "0019"];

      it("ileri (0001–0019) → 0019 geri (to 0018) → ileri: parmak izi birebir; RLS FORCE; wms_app en az yetki; tablolar/işlevler down'da yok", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru19() })).applied).toEqual(ALL19);
        const before = await digest16(u);
        await withClient(u, async (c) => {
          const f = await c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('public.external_refs'::regclass, 'public.sync_cursors'::regclass) ORDER BY relname",
          );
          expect(f.rows).toEqual([
            { relname: "external_refs", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "sync_cursors", relrowsecurity: true, relforcerowsecurity: true },
          ]);
          const g = await c.query<Record<string, boolean | number>>(
            `SELECT has_table_privilege('wms_app', 'public.external_refs', 'SELECT') AS er_sel,
                    has_table_privilege('wms_app', 'public.external_refs', 'DELETE') AS er_del,
                    has_column_privilege('wms_app', 'public.external_refs', 'external_code', 'UPDATE') AS er_upd_code,
                    has_column_privilege('wms_app', 'public.external_refs', 'external_id', 'UPDATE') AS er_upd_ext,
                    has_column_privilege('wms_app', 'public.external_refs', 'version', 'INSERT') AS er_ins_version,
                    has_table_privilege('wms_app', 'public.sync_cursors', 'DELETE') AS sc_del,
                    has_column_privilege('wms_app', 'public.sync_cursors', 'cursor_xid', 'UPDATE') AS sc_upd_cur,
                    has_column_privilege('wms_app', 'public.sync_cursors', 'updated_at', 'UPDATE') AS sc_upd_at,
                    has_any_column_privilege('wms_ops', 'public.external_refs', 'SELECT') AS ops_er,
                    has_any_column_privilege('wms_ops', 'public.sync_cursors', 'SELECT') AS ops_sc,
                    (SELECT count(*)::int FROM pg_constraint WHERE conrelid IN ('public.external_refs'::regclass, 'public.sync_cursors'::regclass) AND contype = 'f') AS fks`,
          );
          expect(g.rows).toEqual([
            { er_sel: true, er_del: false, er_upd_code: true, er_upd_ext: false, er_ins_version: false, sc_del: false, sc_upd_cur: true, sc_upd_at: false, ops_er: false, ops_sc: false, fks: 2 },
          ]);
        });

        expect((await migrateDown({ url: u, dir: thru19(), to: "0018", wmsEnv: "ci" })).reverted).toEqual(["0019"]);
        expect(await digest16(u)).not.toEqual(before);
        await withClient(u, async (c) => {
          const gone = await c.query("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('external_refs', 'sync_cursors')");
          expect(gone.rows).toEqual([]);
          const fn = await c.query("SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('external_refs_on_update', 'sync_cursors_guard')");
          expect(fn.rows).toEqual([]);
        });
        expect((await migrateUp({ url: u, dir: thru19() })).applied).toEqual(["0019"]);
        expect(await digest16(u)).toEqual(before);
      });

      it("dolu tablolarla staging geri alma RAISE eder, veri yerinde ve FORCE açık; ci bayrağıyla geçer; yeniden ileri parmak izi birebir", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru19() })).applied).toEqual(ALL19);
        const tenantId = await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          await c.query(
            `INSERT INTO public.external_refs (tenant_id, system, entity_type, entity_id, external_id)
             SELECT $1, 'LOGO', 'ITEM', id, 'X-1' FROM public.items WHERE code = 'NS-I'`,
            [t],
          );
          await c.query("INSERT INTO public.sync_cursors (tenant_id, system, stream) VALUES ($1, 'LOGO', 'LEDGER')", [t]);
        });
        const before = await digest16(u);
        await expect(migrateDown({ url: u, dir: thru19(), to: "0018", wmsEnv: "staging" })).rejects.toThrow(/0019_external_refs down:.*(external_refs|sync_cursors).*satır var/);
        await withClient(u, async (c) => {
          const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
          expect(ledger.rows.map((r) => r.version)).toEqual(ALL19);
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          const kept = await c.query<{ a: string; b: string }>("SELECT (SELECT count(*) FROM public.external_refs)::text AS a, (SELECT count(*) FROM public.sync_cursors)::text AS b");
          await c.query("ROLLBACK");
          expect(kept.rows[0]).toEqual({ a: "1", b: "1" });
          const force = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE oid IN ('public.external_refs'::regclass, 'public.sync_cursors'::regclass) AND relforcerowsecurity");
          expect(force.rows).toEqual([{ n: 2 }]);
        });
        expect((await migrateDown({ url: u, dir: thru19(), to: "0018", wmsEnv: "ci" })).reverted).toEqual(["0019"]);
        expect((await migrateUp({ url: u, dir: thru19() })).applied).toEqual(["0019"]);
        expect(await digest16(u)).toEqual(before);
      });
    });

    // ---- 0020 (T-258): hedef durum bekçisi (tetikleyici); süper kullanıcı olmayan migrator ----
    describe("0020 target_status_guard", () => {
      let thru20Dir: string | undefined;
      let thru19Dir: string | undefined;
      const thru20 = (): string => (thru20Dir ??= copyMigrations("0020"));
      const thru19 = (): string => (thru19Dir ??= copyMigrations("0019"));
      const ALL19 = [...ALL16, "0017", "0018", "0019"];
      const ALL20 = [...ALL19, "0020"];
      const hasTrigger = async (u: string): Promise<boolean> =>
        withClient(u, async (c) => {
          const r = await c.query("SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.document_lines'::regclass AND tgname = 'stock_move_target_status_guard'");
          return r.rows.length === 1;
        });
      /** STOCK_IN belgesi + hedef durumlu satır (migrator = tablo sahibi; yalnızca tenant bağlamı transaction-local). */
      async function seedStockIn(u: string, target: string | null): Promise<string> {
        const DOC = randomUUID();
        return freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          await c.query(
            `INSERT INTO public.documents (id, tenant_id, kind, type_version_id, warehouse_id, business_date, created_by)
             SELECT $3, $1, 'STOCK_IN', v.id, w.id, '2026-02-01', $2
               FROM public.document_type_versions v, public.warehouses w WHERE v.tenant_id IS NULL AND v.key = 'STOCK_IN' AND w.code = 'NS-W'`,
            [t, randomUUID(), DOC],
          );
          await c.query(
            `INSERT INTO public.document_lines (tenant_id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, stock_status, target_stock_status)
             SELECT $1, $2, 1, i.id, i.base_unit_id, 1, 1, 1, l.id, 'QUARANTINE', $3
               FROM public.items i, public.locations l WHERE i.code = 'NS-I' AND l.code = 'NS-L'`,
            [t, DOC, target],
          );
        });
      }

      it("ileri → 0020 geri (to 0019) → ileri: parmak izi birebir; tetikleyici down'da yok; ileri durumda STOCK_IN satırına hedef durum 23514, down'da kabul", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru20() })).applied).toEqual(ALL20);
        const before = await digest16(u);
        expect(await hasTrigger(u)).toBe(true);
        await expect(seedStockIn(u, "AVAILABLE")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("TARGET_STATUS_KIND") });
        await seedStockIn(u, null); // NULL hedef her zaman geçer

        expect((await migrateDown({ url: u, dir: thru20(), to: "0019", wmsEnv: "ci" })).reverted).toEqual(["0020"]);
        expect(await digest16(u)).not.toEqual(before);
        expect(await hasTrigger(u)).toBe(false);
        await withClient(u, async (c) => {
          const fn = await c.query("SELECT 1 FROM pg_proc WHERE proname = 'stock_move_target_status_guard'");
          expect(fn.rows).toEqual([]);
        });
        await seedStockIn(u, "AVAILABLE"); // bekçi yok → kabul (down kuralı gerçekten kaldırır)

        const u2 = await freshDatabase();
        expect((await migrateUp({ url: u2, dir: thru20() })).applied).toEqual(ALL20);
        expect((await migrateDown({ url: u2, dir: thru20(), to: "0019", wmsEnv: "ci" })).reverted).toEqual(["0020"]);
        expect((await migrateUp({ url: u2, dir: thru20() })).applied).toEqual(["0020"]);
        expect(await digest16(u2)).toEqual(before);
      });

      it("kuralı ihlal eden mevcut satır varken 0020 yüksek sesle başarısız olur ve deftere yazılmaz; düzeltilince uygulanır", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru19() })).applied).toEqual(ALL19);
        const tenantId = await seedStockIn(u, "AVAILABLE");
        await expect(migrateUp({ url: u, dir: thru20() })).rejects.toThrow(/0020_target_status_guard:.*ihlal eden/);
        await withClient(u, async (c) => {
          const ledger = await c.query<{ version: string }>("SELECT version FROM wms_meta.schema_migrations ORDER BY version");
          expect(ledger.rows.map((r) => r.version)).toEqual(ALL19);
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          await c.query("UPDATE public.document_lines SET target_stock_status = NULL");
          await c.query("COMMIT");
        });
        expect((await migrateUp({ url: u, dir: thru20() })).applied).toEqual(["0020"]);
      });
    });
    // ---- 0022 (T-305): kabul belgesi numara türü (number_sequences_kind_chk genişlemesi); süper kullanıcı olmayan migrator ----
    describe("0022 inbound_receipt_numbering", () => {
      let thru22Dir: string | undefined;
      const thru22 = (): string => (thru22Dir ??= copyMigrations("0022"));
      const ALL22 = [...ALL16, "0017", "0018", "0019", "0020", "0021", "0022"];
      const kindDef = async (u: string): Promise<string> =>
        withClient(u, async (c) => {
          const r = await c.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'number_sequences_kind_chk'");
          expect(r.rows).toHaveLength(1);
          return (r.rows[0] as { def: string }).def;
        });
      async function seedReceiptSequence(u: string): Promise<void> {
        await freshTenant(u, async (c, t) => {
          await c.query("INSERT INTO public.number_sequences (tenant_id, document_kind, period, next_value) VALUES ($1, 'INBOUND_RECEIPT', '2026', 2)", [t]);
        });
      }

      it("ileri (0001–0022) → 0022 geri (to 0021) → ileri: parmak izi birebir; CHECK genişler/daralır; INBOUND_RECEIPT yalnızca ileri durumda yazılabilir", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru22() })).applied).toEqual(ALL22);
        const before = await digest16(u);
        expect(await kindDef(u)).toContain("INBOUND_RECEIPT");
        expect(await kindDef(u)).toContain("COUNT_ADJUSTMENT"); // 0017 değerleri korunur
        await seedReceiptSequence(u);

        // Satır varken staging geri alma reddedilir ve hiçbir şey değişmez.
        await expect(migrateDown({ url: u, dir: thru22(), to: "0021", wmsEnv: "staging" })).rejects.toThrow(/0022_inbound_receipt_numbering down:.*INBOUND_RECEIPT/);
        expect(await kindDef(u)).toContain("INBOUND_RECEIPT");

        expect((await migrateDown({ url: u, dir: thru22(), to: "0021", wmsEnv: "ci" })).reverted).toEqual(["0022"]);
        const down = await kindDef(u);
        expect(down).not.toContain("INBOUND_RECEIPT");
        expect(down).toContain("COUNT_ADJUSTMENT");
        await expect(seedReceiptSequence(u)).rejects.toMatchObject({ code: "23514" }); // down'da tür kabul edilmez

        expect((await migrateUp({ url: u, dir: thru22() })).applied).toEqual(["0022"]);
        expect(await digest16(u)).toEqual(before);
        await seedReceiptSequence(u); // ileri durumda yeniden yazılabilir
      });
    });
    // ---- 0023 (T-222 inceleme MAJOR-1/MINOR-1): işleme isteği bağlamı (MFA damgası, idempotency kaydı); süper kullanıcı olmayan migrator ----
    describe("0023 posting_request_context", () => {
      let thru23Dir: string | undefined;
      const thru23 = (): string => (thru23Dir ??= copyMigrations("0023"));
      const ALL23 = [...ALL16, "0017", "0018", "0019", "0020", "0021", "0022", "0023"];
      const hasColumns = async (u: string): Promise<boolean> =>
        withClient(u, async (c) => {
          const r = await c.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name IN ('posting_mfa_verified_at', 'posting_idempotency_record_id')",
          );
          return r.rows[0]?.n === "2";
        });
      /** APPROVED belge + işleme bağlamı (migrator = tablo sahibi; tenant bağlamı transaction-local). `withJob=false`: bağlam var ama kilit yok (CHECK ihlali). */
      async function seedContextDoc(u: string, withJob: boolean): Promise<void> {
        await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          await c.query(
            `INSERT INTO public.documents (id, tenant_id, kind, type_version_id, warehouse_id, business_date, created_by, status, posting_job_id, posting_requested_by, posting_mfa_verified_at, posting_idempotency_record_id)
             SELECT $3, $1, 'STOCK_IN', v.id, w.id, '2026-02-01', $2, 'APPROVED', $4, $5, now(), $6
               FROM public.document_type_versions v, public.warehouses w WHERE v.tenant_id IS NULL AND v.key = 'STOCK_IN' AND w.code = 'NS-W'`,
            [t, randomUUID(), randomUUID(), withJob ? randomUUID() : null, withJob ? randomUUID() : null, randomUUID()],
          );
        });
      }

      it("ileri (0001–0023) → 0023 geri (to 0022) → ileri: parmak izi birebir; sütunlar down'da yok; bağlam yalnızca kilit varken yazılabilir (CHECK)", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru23() })).applied).toEqual(ALL23);
        const before = await digest16(u);
        expect(await hasColumns(u)).toBe(true);
        await expect(seedContextDoc(u, false)).rejects.toMatchObject({ code: "23514" }); // kilitsiz bağlam reddedilir
        await seedContextDoc(u, true);

        // Dolu bağlam varken staging geri alma reddedilir ve hiçbir şey değişmez.
        await expect(migrateDown({ url: u, dir: thru23(), to: "0022", wmsEnv: "staging" })).rejects.toThrow(/0023_posting_request_context down:.*işleme bağlamı/);
        expect(await hasColumns(u)).toBe(true);

        expect((await migrateDown({ url: u, dir: thru23(), to: "0022", wmsEnv: "ci" })).reverted).toEqual(["0023"]);
        expect(await hasColumns(u)).toBe(false);

        expect((await migrateUp({ url: u, dir: thru23() })).applied).toEqual(["0023"]);
        expect(await digest16(u)).toEqual(before);
        expect(await hasColumns(u)).toBe(true);
      });
    });
    // ---- 0024 (T-275): işleme bağlamı damga bekçisi (tetikleyici) + 0022 down→up sayaç yeniden kurulumu; süper kullanıcı olmayan migrator ----
    describe("0024 posting_stamp_guard_and_kbl_counter", () => {
      let thru24Dir: string | undefined;
      const thru24 = (): string => (thru24Dir ??= copyMigrations("0024"));
      const ALL24 = [...ALL16, "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024"];
      const hasGuard = async (u: string): Promise<boolean> =>
        withClient(u, async (c) => {
          const t = await c.query("SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.documents'::regclass AND tgname = 'posting_context_stamp_guard'");
          const f = await c.query("SELECT 1 FROM pg_proc WHERE proname = 'posting_context_stamp_guard'");
          expect(t.rows.length).toBe(f.rows.length); // tetikleyici ve işlev birlikte var/yok
          return t.rows.length === 1;
        });
      /** Tenant + APPROVED STOCK_IN belgesi (kilitsiz) üzerinde `work`; tek transaction (migrator = tablo sahibi: tetikleyici onu da bağlar). */
      async function withDoc(u: string, work: (c: pg.Client, docId: string) => Promise<void>): Promise<void> {
        await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          const docId = randomUUID();
          await c.query(
            `INSERT INTO public.documents (id, tenant_id, kind, type_version_id, warehouse_id, business_date, created_by, status)
             SELECT $3, $1, 'STOCK_IN', v.id, w.id, '2026-02-01', $2, 'APPROVED'
               FROM public.document_type_versions v, public.warehouses w WHERE v.tenant_id IS NULL AND v.key = 'STOCK_IN' AND w.code = 'NS-W'`,
            [t, randomUUID(), docId],
          );
          await work(c, docId);
        });
      }
      const stmt = async (c: pg.Client, text: string, params: unknown[]): Promise<"ok" | string> => {
        await c.query("SAVEPOINT s");
        try {
          await c.query(text, params);
          await c.query("RELEASE SAVEPOINT s");
          return "ok";
        } catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT s");
          return (e as { code?: string; message?: string }).code === "23514" && /POSTING_STAMP_GUARD/.test((e as Error).message) ? "guard" : `other:${(e as Error).message}`;
        }
      };

      it("ileri (0001–0024) → 0024 geri (to 0023) → ileri: parmak izi birebir; damga yalnızca NULL→dolu geçişte yazılır, temizleme serbest", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru24() })).applied).toEqual(ALL24);
        const before = await digest16(u);
        expect(await hasGuard(u)).toBe(true);

        await withDoc(u, async (c, id) => {
          const job = randomUUID();
          const rec = randomUUID();
          // (1) kilit yokken damga yazımı: reddedilir (tetikleyici; CHECK'ten önce).
          expect(await stmt(c, "UPDATE public.documents SET posting_mfa_verified_at = now() WHERE id = $1", [id])).toBe("guard");
          expect(await stmt(c, "UPDATE public.documents SET posting_idempotency_record_id = $2 WHERE id = $1", [id, rec])).toBe("guard");
          // (2) kilitle AYNI ifadede damga: izinli (deferToWorker biçimi).
          expect(
            await stmt(c, "UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3, posting_mfa_verified_at = now(), posting_idempotency_record_id = $4 WHERE id = $1", [id, job, randomUUID(), rec]),
          ).toBe("ok");
          // (3) kilit doluyken damgayı yeniden yazma/değiştirme: reddedilir.
          expect(await stmt(c, "UPDATE public.documents SET posting_mfa_verified_at = now() + interval '1 second' WHERE id = $1", [id])).toBe("guard");
          expect(await stmt(c, "UPDATE public.documents SET posting_idempotency_record_id = $2 WHERE id = $1", [id, randomUUID()])).toBe("guard");
          // (4) değeri değiştirmeyen yazım: no-op, izinli.
          expect(await stmt(c, "UPDATE public.documents SET posting_mfa_verified_at = posting_mfa_verified_at, posting_idempotency_record_id = posting_idempotency_record_id WHERE id = $1", [id])).toBe("ok");
          // (5) kilidi başka işe devrederken damga yazma: reddedilir.
          expect(await stmt(c, "UPDATE public.documents SET posting_job_id = $2, posting_mfa_verified_at = now() + interval '2 seconds' WHERE id = $1", [id, randomUUID()])).toBe("guard");
          // (6) temizleme (failPostingInTx biçimi: APPROVED kalır): izinli.
          expect(await stmt(c, "UPDATE public.documents SET posting_job_id = NULL, posting_requested_by = NULL, posting_mfa_verified_at = NULL, posting_idempotency_record_id = NULL WHERE id = $1", [id])).toBe("ok");
          // (6b) GELECEK (ya da geçmiş) damga iki adımlı yoldan (temizle → kilitle) bile yazılamaz: yalnızca işlemin now() değeri kabul edilir (MAJOR).
          expect(
            await stmt(c, "UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3, posting_mfa_verified_at = now() + interval '1 hour', posting_idempotency_record_id = $4 WHERE id = $1", [id, job, randomUUID(), rec]),
          ).toBe("guard");
          expect(
            await stmt(c, "UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3, posting_mfa_verified_at = now() - interval '4 hours', posting_idempotency_record_id = $4 WHERE id = $1", [id, job, randomUUID(), rec]),
          ).toBe("guard");
          // (6c) damga işine bağlıdır (MINOR-1): kilit doluyken istek sahibi/iş, damga temizlenmeden değiştirilemez; temizlenerek devredilebilir.
          const by = randomUUID();
          expect(
            await stmt(c, "UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3, posting_mfa_verified_at = now(), posting_idempotency_record_id = $4 WHERE id = $1", [id, job, by, rec]),
          ).toBe("ok");
          expect(await stmt(c, "UPDATE public.documents SET posting_requested_by = $2 WHERE id = $1", [id, randomUUID()])).toBe("guard"); // yalnız istek sahibi
          expect(await stmt(c, "UPDATE public.documents SET posting_job_id = $2 WHERE id = $1", [id, randomUUID()])).toBe("guard"); // yalnız iş
          expect(await stmt(c, "UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3, posting_mfa_verified_at = NULL, posting_idempotency_record_id = NULL WHERE id = $1", [id, randomUUID(), randomUUID()])).toBe("ok"); // temizleyerek devir
          expect(await stmt(c, "UPDATE public.documents SET posting_job_id = NULL, posting_requested_by = NULL WHERE id = $1", [id])).toBe("ok");
          // (7) damgasız kilit (MFA'sız istek) sonradan damgalanamaz.
          expect(await stmt(c, "UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3, posting_mfa_verified_at = NULL, posting_idempotency_record_id = $4 WHERE id = $1", [id, job, randomUUID(), rec])).toBe("ok");
          expect(await stmt(c, "UPDATE public.documents SET posting_mfa_verified_at = now() WHERE id = $1", [id])).toBe("guard");
          // (8) temizleme + POSTED (assignNumber biçimi): izinli.
          expect(
            await stmt(c, "UPDATE public.documents SET number = $2, status = 'POSTED', posting_job_id = NULL, posting_requested_by = NULL, posting_mfa_verified_at = NULL, posting_idempotency_record_id = NULL WHERE id = $1", [id, `N-${randomBytes(3).toString("hex")}`]),
          ).toBe("ok");
        });

        expect((await migrateDown({ url: u, dir: thru24(), to: "0023", wmsEnv: "staging" })).reverted).toEqual(["0024"]); // veri kaybettirmez: staging'de de çalışır
        expect(await hasGuard(u)).toBe(false);
        expect((await migrateUp({ url: u, dir: thru24() })).applied).toEqual(["0024"]);
        expect(await digest16(u)).toEqual(before);
        expect(await hasGuard(u)).toBe(true);
      });

      it("0022 down → up: numaralı KBL kabulü varken sayaç max + 1'den yeniden kurulur (UNIQUE çakışması yok); dönem başına ayrı", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru24() })).applied).toEqual(ALL24);
        let tenant = "";
        tenant = await freshTenant(u, async (c, t) => {
          await seedBase(c, t);
          for (const no of ["KBL-2026-000001", "KBL-2026-000002", "KBL-2025-000007"]) {
            await c.query(
              `INSERT INTO public.inbound_receipts (tenant_id, warehouse_id, number, created_by) SELECT $1, id, $2, $3 FROM public.warehouses WHERE code = 'NS-W'`,
              [t, no, randomUUID()],
            );
          }
          await c.query("INSERT INTO public.number_sequences (tenant_id, document_kind, period, next_value) VALUES ($1, 'INBOUND_RECEIPT', '2026', 3), ($1, 'INBOUND_RECEIPT', '2025', 8)", [t]);
        });
        const seqs = async (): Promise<Record<string, string>> =>
          withClient(u, async (c) => {
            await c.query("BEGIN");
            await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
            const r = await c.query<{ period: string; next_value: string }>("SELECT period, next_value::text FROM public.number_sequences WHERE document_kind = 'INBOUND_RECEIPT' ORDER BY period");
            await c.query("COMMIT");
            return Object.fromEntries(r.rows.map((x) => [x.period, x.next_value]));
          });
        expect(await seqs()).toEqual({ "2025": "8", "2026": "3" });

        expect((await migrateDown({ url: u, dir: thru24(), to: "0021", wmsEnv: "ci" })).reverted).toEqual(["0024", "0023", "0022"]);
        expect(await seqs()).toEqual({}); // down sayaçları sildi
        expect((await migrateUp({ url: u, dir: thru24() })).applied).toEqual(["0022", "0023", "0024"]);
        expect(await seqs()).toEqual({ "2025": "8", "2026": "3" }); // max + 1; çakışan bir sonraki numara KBL-2026-000003 olur

        // Sayaç yeniden kurulmasaydı ilk numara KBL-2026-000001 (UNIQUE çakışması) olurdu: sonraki numara gerçekten boş.
        await withClient(u, async (c) => {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
          await c.query(
            `INSERT INTO public.inbound_receipts (tenant_id, warehouse_id, number, created_by) SELECT $1, id, 'KBL-2026-000003', $2 FROM public.warehouses WHERE code = 'NS-W'`,
            [tenant, randomUUID()],
          );
          await c.query("COMMIT");
        });
      });
    });
    // ---- 0025 (T-282): worker heartbeat tablosu (tenant'sız işletim tablosu, en dar GRANT); süper kullanıcı olmayan migrator ----
    describe("0025 worker_heartbeats", () => {
      let thru25Dir: string | undefined;
      const thru25 = (): string => (thru25Dir ??= copyMigrations("0025"));
      const ALL25 = [...ALL16, "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025"];
      const exists = async (u: string): Promise<boolean> => withClient(u, async (c) => (await c.query("SELECT to_regclass('wms_health.worker_heartbeats') IS NOT NULL AS t")).rows[0]?.t === true);

      it("ileri (0001–0025) → 0025 geri (to 0024; veri kaybettirmez, staging'de de çalışır) → ileri: parmak izi birebir; yetkiler en dar", async () => {
        await setProbeMemberships(STANDARD_GRANT);
        const u = await freshDatabase();
        expect((await migrateUp({ url: u, dir: thru25() })).applied).toEqual(ALL25);
        const before = await digest16(u);
        expect(await exists(u)).toBe(true);
        await withClient(u, async (c) => {
          const g = await c.query<{ grantee: string; priv: string }>(
            `SELECT grantee::text, privilege_type AS priv FROM information_schema.role_table_grants WHERE table_schema = 'wms_health' AND table_name = 'worker_heartbeats' AND grantee <> current_user ORDER BY 1, 2`,
          );
          expect(g.rows.map((r) => `${r.grantee}:${r.priv}`)).toEqual(["wms_app:SELECT", "wms_worker:DELETE", "wms_worker:INSERT", "wms_worker:SELECT"]);
          const cols = await c.query<{ grantee: string; column_name: string }>(
            `SELECT grantee::text, column_name::text FROM information_schema.column_privileges WHERE table_schema = 'wms_health' AND table_name = 'worker_heartbeats' AND privilege_type = 'UPDATE' AND grantee = 'wms_worker' ORDER BY 2`,
          );
          expect(cols.rows.map((r) => r.column_name)).toEqual(["expired_active", "failed_recent", "last_seen_at", "oldest_waiting_age_s", "version"]);
          const rls = await c.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'wms_health.worker_heartbeats'::regclass");
          expect(rls.rows[0]?.relrowsecurity).toBe(false); // tenant verisi yok; koruma yetkiyle (migration başlık notu)
          await c.query("INSERT INTO wms_health.worker_heartbeats (instance_id, version, started_at) VALUES ('m-1', 'unknown', now())");
        });
        expect((await migrateDown({ url: u, dir: thru25(), to: "0024", wmsEnv: "staging" })).reverted).toEqual(["0025"]);
        expect(await exists(u)).toBe(false);
        expect((await migrateUp({ url: u, dir: thru25() })).applied).toEqual(["0025"]);
        expect(await digest16(u)).toEqual(before);
        expect(await exists(u)).toBe(true);
      });
    });
  });
});
