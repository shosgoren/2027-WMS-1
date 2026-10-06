// Operasyon rolü wms_ops testi (T-105c, Q-32 (c), I-03, G-01, G-02). GERÇEK rolle (wms_ops, NOBYPASSRLS) doğrudan
// bağlantı; süper kullanıcı ile değil. Migration rolü yalnızca fikstür kurulumu/doğrulaması içindir.
// Her test geçici bir veritabanında koşar (tam migration kümesi); rol küme düzeyindedir, parola teste özgü rastgele
// değerdir ve sonunda silinir. Kalıcı veri bırakılmaz.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateDown, migrateUp } from "../../../packages/db/src/migrate.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const OPS = "wms_ops";
const INSUFFICIENT_PRIVILEGE = "42501";

// 0009 ve sonrası: to:0008 geri almada ters, yeniden uygulamada düz sırayla beklenir (migration dizininden türetilir;
// yeni migration eklenince test kırılmaz, assertion tam eşitliktir).
const EXPECTED_UP = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.+\.up\.sql$/.test(f))
  .map((f) => f.slice(0, 4))
  .filter((v) => v >= "0009")
  .sort();
const EXPECTED_DOWN = [...EXPECTED_UP].reverse();

const opsPassword = randomBytes(24).toString("hex");
const dbName = `wms_ops_${randomBytes(5).toString("hex")}`;
let adminUrl = "";
let scratchUrl = "";
let opsUrl = "";
const clients: pg.Client[] = [];

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [adminUrl, scratchUrl, opsUrl, opsPassword])}`);
  }
  clients.push(c);
  return c;
}

function urlFor(db: string, user?: string, password?: string): string {
  const u = new URL(env.databaseUrlDirect);
  u.pathname = `/${db}`;
  if (user !== undefined) {
    u.username = user;
    u.password = password ?? "";
  }
  return u.toString();
}

type Attempt = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string | undefined; message: string };

/** Her ifade kendi transaction'ında; daima ROLLBACK. `prelude` aynı transaction'da önce çalışır. */
async function attempt(c: pg.Client, sql: string, prelude: string[] = []): Promise<Attempt> {
  await c.query("BEGIN");
  try {
    for (const p of prelude) await c.query(p);
    const r = await c.query(sql);
    return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await c.query("ROLLBACK");
  }
}

const openSql = (tenant: string, operator = "op-test", reason = "T-105c destek testi"): string =>
  `SELECT public.ops_open_session('${tenant}'::uuid, '${operator}', '${reason}')`;

const tenantA = randomUUID();
const tenantB = randomUUID();
let admin: pg.Client;
let ops: pg.Client;

beforeAll(async () => {
  adminUrl = urlFor("postgres");
  const a0 = await connect(adminUrl);
  await a0.query(`CREATE DATABASE ${dbName}`);
  scratchUrl = urlFor(dbName);
  await migrateUp({ url: scratchUrl });
  admin = await connect(scratchUrl);
  await admin.query(`ALTER ROLE ${OPS} LOGIN PASSWORD '${opsPassword}'`); // varsayılan NOLOGIN (A-80); test süresince geçici LOGIN
  opsUrl = urlFor(dbName, OPS, opsPassword);
  for (const [id, slug] of [[tenantA, "ops-a"], [tenantB, "ops-b"]] as const) {
    await admin.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, $3)", [id, `${slug}-${id.slice(0, 8)}`, slug]);
  }
  await admin.query(
    `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'tr', 'Europe/Istanbul', 'DONE')`,
    [tenantA],
  );
  ops = await connect(opsUrl);
});

afterAll(async () => {
  try {
    const a = await connect(adminUrl);
    await a.query(`ALTER ROLE ${OPS} NOLOGIN PASSWORD NULL`);
  } catch {
    /* kurulum başarısızsa bağlantı olmayabilir */
  }
  for (const c of clients) await c.end().catch(() => undefined);
  const a = new pg.Client({ connectionString: adminUrl });
  a.on("error", () => undefined);
  try {
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } finally {
    await a.end().catch(() => undefined);
  }
});

describe(`wms_ops rol nitelikleri (target=${env.target})`, () => {
  it("LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION; üyelik yok; sahip olduğu nesne yok", async () => {
    const r = await admin.query<Record<string, unknown>>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication,
              (SELECT count(*) FROM pg_auth_members WHERE member = r.oid OR roleid = r.oid)::int AS memberships,
              (SELECT count(*) FROM pg_class WHERE relowner = r.oid)::int AS owned
         FROM pg_roles r WHERE rolname = $1`,
      [OPS],
    );
    expect(r.rows[0]).toEqual({
      rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
      rolreplication: false, memberships: 0, owned: 0,
    });
    const who = await ops.query<{ u: string; bypass: string }>("SELECT current_user AS u, current_setting('is_superuser') AS bypass");
    expect(who.rows[0]).toEqual({ u: OPS, bypass: "off" });
  });
});

describe(`tenant bağlamı ve RLS (target=${env.target})`, () => {
  it("bağlamsız SELECT 0 satır (veri mevcutken)", async () => {
    const seen = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM public.tenant_settings");
    expect(seen.rows[0]?.n).toBe(1);
    for (const t of ["tenants", "tenant_settings", "tenant_memberships", "membership_roles", "invitations", "audit_logs"]) {
      const r = await attempt(ops, `SELECT 1 FROM public.${t}`);
      expect(r.ok, t).toBe(true);
      if (r.ok) expect(r.rowCount, t).toBe(0);
    }
  });

  it("tenant bağlamı elle kurulsa bile denetim satırı olmadan satır görünmez/yazılamaz", async () => {
    const ctx = [`SELECT set_config('app.current_tenant_id', '${tenantA}', true)`];
    const sel = await attempt(ops, "SELECT 1 FROM public.tenant_settings", ctx);
    expect(sel.ok && sel.rowCount).toBe(0);
    const upd = await attempt(ops, "UPDATE public.tenant_settings SET locale = 'en'", ctx);
    expect(upd.ok && upd.rowCount).toBe(0);
    const ins = await attempt(ops, `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ('${tenantA}', 'x', 'UTC', 'X')`, ctx);
    expect(ins.ok).toBe(false);
    if (!ins.ok) expect(ins.code).toBe(INSUFFICIENT_PRIVILEGE);
    const after = await admin.query<{ locale: string }>("SELECT locale FROM public.tenant_settings WHERE tenant_id = $1", [tenantA]);
    expect(after.rows[0]?.locale).toBe("tr");
  });

  it("ops_open_session: gerekçe/operatör boşsa, sistem gerekçesi varsa, başka tenant bağlamı varsa reddedilir", async () => {
    for (const sql of [openSql(tenantA, "op", "  "), openSql(tenantA, "", "gerekce")]) {
      const r = await attempt(ops, sql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("22023");
    }
    const sys = await attempt(ops, openSql(tenantA), [`SELECT set_config('app.system_reason', 'demo.bootstrap', true)`]);
    expect(sys.ok).toBe(false);
    if (!sys.ok) expect(sys.code).toBe(INSUFFICIENT_PRIVILEGE);
    const other = await attempt(ops, openSql(tenantA), [`SELECT set_config('app.current_tenant_id', '${tenantB}', true)`]);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("denetim yazılamazsa (var olmayan tenant -> FK) işlem geri alınır, hiçbir satır kalmaz", async () => {
    const r = await attempt(ops, "SELECT 1", [openSql(randomUUID())]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("23503");
    const n = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM public.audit_logs WHERE action = 'ops.session_opened'");
    expect(n.rows[0]?.n).toBe(0);
  });

  it("oturum açılınca: yalnızca o tenant görünür; denetim satırı kim/gerekçe/tenant taşır; başka tenant'a yazma RLS ile reddedilir", async () => {
    await ops.query("BEGIN");
    try {
      await ops.query(openSql(tenantA, "op-alice", "destek-4711"));
      const seen = await ops.query<{ tenant_id: string }>("SELECT tenant_id FROM public.tenant_settings");
      expect(seen.rows.map((r) => r.tenant_id)).toEqual([tenantA]);
      const tenants = await ops.query<{ id: string }>("SELECT id FROM public.tenants");
      expect(tenants.rows.map((r) => r.id)).toEqual([tenantA]);

      const upd = await ops.query("UPDATE public.tenant_settings SET locale = 'en' WHERE tenant_id = $1", [tenantA]);
      expect(upd.rowCount).toBe(1);
      const cross = await ops.query("UPDATE public.tenant_settings SET locale = 'zz' WHERE tenant_id = $1", [tenantB]);
      expect(cross.rowCount).toBe(0);

      await ops.query("SAVEPOINT s");
      await expect(
        ops.query(`INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'tr', 'UTC', 'X')`, [tenantB]),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await ops.query("ROLLBACK TO s");

      await ops.query("SAVEPOINT s2");
      await expect(ops.query("UPDATE public.tenants SET slug = 'x' WHERE id = $1", [tenantA])).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await ops.query("ROLLBACK TO s2");
      const st = await ops.query("UPDATE public.tenants SET status = 'SUSPENDED' WHERE id = $1", [tenantA]);
      expect(st.rowCount).toBe(1);

      await ops.query("COMMIT");
    } catch (e) {
      await ops.query("ROLLBACK");
      throw e;
    }
    const a = await admin.query<{ action: string; reason: string; operator: string; tenant_id: string; entity_id: string }>(
      `SELECT action, reason, change_summary->>'operator' AS operator, tenant_id, entity_id FROM public.audit_logs WHERE action LIKE 'ops.%'`,
    );
    expect(a.rows).toEqual([{ action: "ops.session_opened", reason: "destek-4711", operator: "op-alice", tenant_id: tenantA, entity_id: tenantA }]);
    const t = await admin.query<{ status: string }>("SELECT status FROM public.tenants WHERE id = $1", [tenantA]);
    expect(t.rows[0]?.status).toBe("SUSPENDED");
    const b = await admin.query<{ locale: string }>("SELECT locale FROM public.tenant_settings WHERE tenant_id = $1", [tenantA]);
    expect(b.rows[0]?.locale).toBe("en");
  });

  it("audit_logs (B-1, I-12): oturumsuz çapraz tenant okuma 0 satır, sahte satır reddi; açık oturumda ops.* dışı/kullanıcı adına sahte kayıt reddi", async () => {
    // Önceki testte tenantA için ops.session_opened satırı kaldı (admin görür).
    const seen = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1", [tenantA]);
    expect(seen.rows[0]?.n).toBeGreaterThan(0);
    for (const t of [tenantA, tenantB]) {
      const ctx = [`SELECT set_config('app.current_tenant_id', '${t}', true)`];
      const sel = await attempt(ops, "SELECT 1 FROM public.audit_logs", ctx);
      expect(sel.ok && sel.rowCount, `okuma ${t}`).toBe(0);
      const ins = await attempt(ops, "INSERT INTO public.audit_logs (action, reason) VALUES ('ops.sahte', 'x')", ctx);
      expect(ins.ok, "oturumsuz ops.sahte").toBe(false);
      if (!ins.ok) expect(ins.code).toBe(INSUFFICIENT_PRIVILEGE);
      const blank = await attempt(ops, "INSERT INTO public.audit_logs (action, reason, change_summary) VALUES ('ops.session_opened', ' ', '{\"operator\":\"x\"}')", ctx);
      expect(blank.ok, "boş gerekçeli oturum satırı").toBe(false);
      const noop = await attempt(ops, "INSERT INTO public.audit_logs (action, reason) VALUES ('ops.session_opened', 'r')", ctx);
      expect(noop.ok, "operatörsüz oturum satırı").toBe(false);
    }
    // Açık oturumda: kendi tenant'ının denetim kayıtları okunur; ops.* kayıt eklenebilir; sahte olanlar reddedilir.
    const open = [openSql(tenantA, "op-eve", "audit-test")];
    const own = await attempt(ops, "SELECT 1 FROM public.audit_logs", open);
    expect(own.ok && own.rowCount).toBeGreaterThan(0);
    const okIns = await attempt(ops, "INSERT INTO public.audit_logs (action, reason) VALUES ('ops.duzeltme', 'r')", open);
    expect(okIns.ok && okIns.rowCount).toBe(1);
    for (const sql of [
      "INSERT INTO public.audit_logs (action) VALUES ('auth.login')",
      "INSERT INTO public.audit_logs (action, actor_user_id) VALUES ('ops.duzeltme', gen_random_uuid())",
      "INSERT INTO public.audit_logs (action, on_behalf_of_user_id) VALUES ('ops.duzeltme', gen_random_uuid())",
    ]) {
      const r = await attempt(ops, sql, open);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.code, `${sql}: ${r.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // Başka tenant'ın kayıtları açık oturumda da görünmez (B oturum açmadan A bağlamında B kaydı yok).
    const crossRead = await attempt(ops, "SELECT 1 FROM public.audit_logs WHERE tenant_id = $$" + tenantB + "$$::uuid", open);
    expect(crossRead.ok && crossRead.rowCount).toBe(0);
  });

  it("denetim satırı başka tenant içinse o transaction'da hedef tenant satırı yazılamaz", async () => {
    const r = await attempt(ops, "UPDATE public.tenant_settings SET locale = 'q'", [
      openSql(tenantB),
      `SELECT set_config('app.current_tenant_id', '${tenantA}', true)`,
    ]);
    expect(r.ok && r.rowCount).toBe(0);
  });
});

describe(`yetki sınırı: defter, DDL, kimlik (target=${env.target})`, () => {
  it("audit_logs: UPDATE/DELETE/TRUNCATE ve tenant_id sütununa INSERT 42501", async () => {
    const pre = [openSql(tenantA)];
    for (const sql of [
      "UPDATE public.audit_logs SET reason = 'x'",
      "DELETE FROM public.audit_logs",
      "TRUNCATE public.audit_logs",
      `INSERT INTO public.audit_logs (tenant_id, action) VALUES ('${tenantB}', 'ops.sahte')`,
    ]) {
      const r = await attempt(ops, sql, pre);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.code, `${sql}: ${r.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("stok defteri benzeri tablo (sonradan eklenen) için doğrudan INSERT/SELECT 42501; izin listesi dışında hiçbir tabloda yetki yok", async () => {
    await admin.query("CREATE TABLE public.stock_ledger_probe (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), qty numeric NOT NULL)");
    try {
      for (const sql of [
        `INSERT INTO public.stock_ledger_probe (tenant_id, qty) VALUES ('${tenantA}', 1)`,
        "SELECT * FROM public.stock_ledger_probe",
        "UPDATE public.stock_ledger_probe SET qty = 0",
      ]) {
        const r = await attempt(ops, sql, [openSql(tenantA)]);
        expect(r.ok, sql).toBe(false);
        if (!r.ok) expect(r.code, r.message).toBe(INSUFFICIENT_PRIVILEGE);
      }
    } finally {
      await admin.query("DROP TABLE public.stock_ledger_probe");
    }
    const priv = await admin.query<{ n: string }>(
      `SELECT c.relname AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               OR has_any_column_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
        ORDER BY 1`,
      [OPS],
    );
    expect(priv.rows.map((r) => r.n)).toEqual(["audit_logs", "invitations", "membership_roles", "tenant_memberships", "tenant_settings", "tenants"]);
  });

  it("DDL 42501 (CREATE TABLE, CREATE SCHEMA, ALTER/DROP TABLE, CREATE FUNCTION)", async () => {
    for (const sql of [
      "CREATE TABLE public.ops_ddl_probe (a int)",
      "CREATE SCHEMA ops_ddl_probe",
      "ALTER TABLE public.tenants ADD COLUMN ops_probe int",
      "DROP TABLE public.tenant_settings",
      "ALTER TABLE public.tenants DISABLE ROW LEVEL SECURITY",
      "CREATE FUNCTION public.ops_ddl_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE POLICY ops_ddl_probe ON public.tenants USING (true)",
    ]) {
      const r = await attempt(ops, sql);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.code, `${sql}: ${r.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("kimlik/platform tablolarında yetki yok; RLS'i kapatamaz (SET ROLE/BYPASSRLS yok)", async () => {
    for (const t of ["users", "sessions", "accounts", "verifications", "security_events", "request_rate_limits", "admin_reset_grants"]) {
      const r = await attempt(ops, `SELECT 1 FROM public.${t}`);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.code, t).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const sr = await attempt(ops, "SET ROLE wms_app");
    expect(sr.ok).toBe(false);
    const sg = await attempt(ops, "SET session_replication_role = replica");
    expect(sg.ok).toBe(false);
    if (!sg.ok) expect(sg.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("denetim politikaları yalnızca wms_ops için ve RESTRICTIVE (diğer roller etkilenmez)", async () => {
    const r = await admin.query<{ polname: string; roles: string[]; permissive: boolean }>(
      `SELECT polname, ARRAY(SELECT rolname::text FROM pg_roles WHERE oid = ANY(polroles)) AS roles, polpermissive AS permissive
         FROM pg_policy WHERE polname = 'ops_session_required' ORDER BY polrelid::regclass::text`,
    );
    expect(r.rows).toHaveLength(5);
    for (const row of r.rows) expect(row).toMatchObject({ roles: [OPS], permissive: false });
  });
});

describe(`0009 ileri/geri/ileri (target=${env.target})`, () => {
  const shape = async (): Promise<{ fns: string[]; pols: number; ops: number }> => {
    const f = await admin.query<{ n: string }>(
      "SELECT proname AS n FROM pg_proc WHERE proname IN ('ops_open_session','ops_session_audited') ORDER BY 1",
    );
    const p = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policy WHERE polname = 'ops_session_required'");
    const g = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c WHERE c.relname IN ('tenants','audit_logs','tenant_settings') AND has_any_column_privilege($1, c.oid, 'SELECT')`,
      [OPS],
    );
    return { fns: f.rows.map((x) => x.n), pols: p.rows[0]?.n ?? -1, ops: g.rows[0]?.n ?? -1 };
  };

  it("geri alınca işlev/politika/yetki yok; yeniden ileri aynı durumu kurar ve oturum çalışır", async () => {
    expect(await shape()).toEqual({ fns: ["ops_open_session", "ops_session_audited"], pols: 5, ops: 3 });
    await admin.end();
    clients.splice(clients.indexOf(admin), 1);
    await ops.end();
    clients.splice(clients.indexOf(ops), 1);

    const down = await migrateDown({ url: scratchUrl, to: "0008", wmsEnv: "ci" });
    expect(down.reverted).toEqual(EXPECTED_DOWN);
    admin = await connect(scratchUrl);
    expect(await shape()).toEqual({ fns: [], pols: 0, ops: 0 });
    const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [OPS]);
    expect(role.rowCount).toBe(1);

    const up = await migrateUp({ url: scratchUrl });
    expect(up.applied).toEqual(EXPECTED_UP);
    expect(await shape()).toEqual({ fns: ["ops_open_session", "ops_session_audited"], pols: 5, ops: 3 });
    expect((await migrateUp({ url: scratchUrl })).applied).toEqual([]);

    ops = await connect(opsUrl);
    await ops.query("BEGIN");
    try {
      await ops.query(openSql(tenantB, "op-bob", "yeniden-ileri"));
      const r = await ops.query("SELECT id FROM public.tenants");
      expect(r.rows).toHaveLength(1);
    } finally {
      await ops.query("ROLLBACK");
    }
  });

  it("üyelik ön denetimi (M-2): wms_ops'a yalnızca-ADMIN üye kabul; SET/INHERIT seçenekli üye migration'ı reddettirir", async () => {
    const tmp = `ops_tmp_${randomBytes(4).toString("hex")}`;
    await admin.end();
    clients.splice(clients.indexOf(admin), 1);
    await ops.end();
    clients.splice(clients.indexOf(ops), 1);
    const down = await migrateDown({ url: scratchUrl, to: "0008", wmsEnv: "ci" });
    expect(down.reverted).toEqual(EXPECTED_DOWN);
    const a = await connect(adminUrl);
    try {
      await a.query(`CREATE ROLE ${tmp} NOLOGIN`);
      await a.query(`GRANT ${OPS} TO ${tmp} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
      await a.query(`GRANT ${OPS} TO ${tmp} WITH ADMIN TRUE, SET TRUE, INHERIT FALSE`);
      await expect(migrateUp({ url: scratchUrl })).rejects.toThrow(/SET\/INHERIT/);
      await a.query(`REVOKE ${OPS} FROM ${tmp}`);
      await a.query(`GRANT ${OPS} TO ${tmp} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
      const up = await migrateUp({ url: scratchUrl });
      expect(up.applied).toEqual(EXPECTED_UP);
    } finally {
      await a.query(`DROP ROLE IF EXISTS ${tmp}`).catch(() => undefined);
    }
    admin = await connect(scratchUrl);
    ops = await connect(opsUrl);
  });

  it("migration koşturucusu wms_ops ile bağlanmayı reddeder (APP_ROLE_NAMES)", async () => {
    await expect(migrateUp({ url: opsUrl })).rejects.toMatchObject({ code: "MIGRATION_WRONG_ROLE" });
  });

  it("MIGRATIONS_DIR 0009 çiftini içerir (up + down)", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("0009_"));
    expect(files.sort()).toEqual(["0009_ops_role.down.sql", "0009_ops_role.up.sql"]);
  });
});
