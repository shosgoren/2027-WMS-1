// T-108 — rol sertleştirme katalog denetimi (qa-verifier; ADR-015 §4, ADR-016 §9; security-reviewer M7, M-B, m4, MINOR-2/3/4/6).
//
// YALNIZCA katalog okur (pg_roles, pg_auth_members, pg_class/pg_proc/pg_namespace, has_*_privilege). Katalog sorguları migration
// rolü bağlantısıyla (DATABASE_URL_DIRECT) çalışır; ayrıca wms_app/wms_auth bağlantıları gerçek rolle kendi yetkilerini sınar.
// Katalog sütunları PostgreSQL 17 (pg_auth_members: inherit_option, set_option, admin_option, grantor).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLE, AUTH_ROLE, PROBE_ROLE, readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];
const open: pg.Client[] = [];

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
  open.push(c);
  return c;
}

let adm: pg.Client;
let migrationRole: string;

beforeAll(async () => {
  adm = await connect(env.databaseUrlDirect);
  migrationRole = ((await adm.query<{ u: string }>("SELECT current_user::text AS u")).rows[0] as { u: string }).u;
});
afterAll(async () => {
  await Promise.all(open.map((c) => c.end().catch(() => undefined)));
});

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolcanlogin: boolean;
}
async function roleRow(name: string): Promise<RoleRow> {
  const r = await adm.query<RoleRow>(
    `SELECT rolname::text, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [name],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error(`rol yok: ${name}`);
  return row;
}

describe.each([APP_ROLE, AUTH_ROLE])("T-108 M7 — %s sertleştirme", (role) => {
  it("rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication hepsi false; oturum kullanıcısı bu rol", async () => {
    const r = await roleRow(role);
    expect({ super: r.rolsuper, bypass: r.rolbypassrls, createrole: r.rolcreaterole, createdb: r.rolcreatedb, repl: r.rolreplication }).toEqual({
      super: false,
      bypass: false,
      createrole: false,
      createdb: false,
      repl: false,
    });
    // Gerçek bağlantıda da (katalog yalanı değil): oturum süper kullanıcı değil.
    const c = await connect(role === APP_ROLE ? env.databaseUrl : authUrl);
    const me = await c.query<{ u: string; s: string }>("SELECT current_user::text AS u, current_setting('is_superuser') AS s");
    expect(me.rows[0]).toEqual({ u: role, s: "off" });
  });

  it("pg_auth_members'ta hiçbir satırı yok (üye, rol ya da yetki veren olarak)", async () => {
    const r = await adm.query<{ roleid: string; member: string; grantor: string }>(
      `SELECT roleid::regrole::text AS roleid, member::regrole::text AS member, grantor::regrole::text AS grantor
         FROM pg_catalog.pg_auth_members
        WHERE member = $1::regrole OR roleid = $1::regrole OR grantor = $1::regrole`,
      [role],
    );
    expect(r.rows).toEqual([]);
  });

  it("sahibi olduğu pg_class / pg_proc / pg_namespace (ve pg_type, pg_database) nesnesi 0", async () => {
    const r = await adm.query<{ cls: string; proc: string; ns: string; typ: string; db: string }>(
      `SELECT (SELECT count(*) FROM pg_catalog.pg_class     WHERE relowner = $1::regrole)::text AS cls,
              (SELECT count(*) FROM pg_catalog.pg_proc      WHERE proowner = $1::regrole)::text AS proc,
              (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspowner = $1::regrole)::text AS ns,
              (SELECT count(*) FROM pg_catalog.pg_type      WHERE typowner = $1::regrole)::text AS typ,
              (SELECT count(*) FROM pg_catalog.pg_database  WHERE datdba   = $1::regrole)::text AS db`,
      [role],
    );
    expect(r.rows[0]).toEqual({ cls: "0", proc: "0", ns: "0", typ: "0", db: "0" });
  });

  it("wms_identity_probe rolüne üye değil: pg_has_role USAGE ve SET false", async () => {
    const r = await adm.query<{ usage: boolean; setr: boolean; member: boolean }>(
      `SELECT pg_catalog.pg_has_role($1, $2, 'USAGE') AS usage, pg_catalog.pg_has_role($1, $2, 'SET') AS setr,
              pg_catalog.pg_has_role($1, $2, 'MEMBER') AS member`,
      [role, PROBE_ROLE],
    );
    expect(r.rows[0]).toEqual({ usage: false, setr: false, member: false });
  });

  it("wms_probe: yalnızca USAGE (CREATE yok); wms_meta'da hiçbir yetki", async () => {
    const r = await adm.query<Record<string, boolean>>(
      `SELECT has_schema_privilege($1, 'wms_probe', 'USAGE') AS probe_usage,
              has_schema_privilege($1, 'wms_probe', 'CREATE') AS probe_create,
              has_schema_privilege($1, 'wms_meta', 'USAGE') AS meta_usage,
              has_schema_privilege($1, 'wms_meta', 'CREATE') AS meta_create`,
      [role],
    );
    expect(r.rows[0]).toEqual({ probe_usage: true, probe_create: false, meta_usage: false, meta_create: false });
  });

  it("probe sahipli tetikleyici işlevinde EXECUTE yok (has_function_privilege false)", async () => {
    const r = await adm.query<{ fn: string; ok: boolean }>(
      `SELECT p.oid::regprocedure::text AS fn, has_function_privilege($1, p.oid, 'EXECUTE') AS ok
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'wms_probe' AND p.prorettype = 'pg_catalog.trigger'::regtype`,
      [role],
    );
    expect(r.rows.length, "wms_probe'da tetikleyici işlevi bulunamadı (tarama boş)").toBeGreaterThanOrEqual(1);
    expect(r.rows.filter((x) => x.ok)).toEqual([]);
  });
});

describe("T-108 M7 — wms_auth hiçbir tenant tablosuna erişemez", () => {
  it("tenant_id sütunlu her tablo ve tenants: tablo/sütun yetkisi yok (SELECT, INSERT, UPDATE, REFERENCES, DELETE, TRUNCATE, TRIGGER)", async () => {
    const tabs = await adm.query<{ t: string }>(
      `SELECT DISTINCT c.table_name::text AS t FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'`,
    );
    const names = [...new Set([...tabs.rows.map((r) => r.t), "tenants"])].sort();
    expect(names, "tarama sessizce boşalamaz").toEqual(expect.arrayContaining(["audit_logs", "tenant_memberships", "tenants"]));
    const bad: string[] = [];
    for (const n of names) {
      const r = await adm.query<{ any_col: boolean; tbl: boolean }>(
        `SELECT has_any_column_privilege($1, ('public.' || quote_ident($2))::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') AS any_col,
                has_table_privilege($1, ('public.' || quote_ident($2))::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS tbl`,
        [AUTH_ROLE, n],
      );
      if (r.rows[0]?.any_col || r.rows[0]?.tbl) bad.push(n);
    }
    expect(bad).toEqual([]);
  });

  it("gerçek wms_auth bağlantısı: tenant tablolarında SELECT yetki hatası (42501)", async () => {
    const c = await connect(authUrl);
    for (const t of ["tenants", "tenant_memberships", "audit_logs"]) {
      await c.query("BEGIN");
      let code: string | undefined;
      try {
        await c.query(`SELECT 1 FROM public.${t} LIMIT 1`);
      } catch (e) {
        code = (e as { code?: string }).code;
      } finally {
        await c.query("ROLLBACK");
      }
      expect(code, `${t}: wms_auth SELECT reddedilmeli`).toBe("42501");
    }
  });
});

describe(`T-108 M-B / m4 / MINOR-2,3,4,6 — ${PROBE_ROLE} (target=${env.target})`, () => {
  it("rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication false", async () => {
    const r = await roleRow(PROBE_ROLE);
    expect({ login: r.rolcanlogin, super: r.rolsuper, bypass: r.rolbypassrls, createrole: r.rolcreaterole, createdb: r.rolcreatedb, repl: r.rolreplication }).toEqual({
      login: false,
      super: false,
      bypass: false,
      createrole: false,
      createdb: false,
      repl: false,
    });
  });

  it("hiçbir role üye değil (member = probe satırı yok)", async () => {
    const r = await adm.query<{ roleid: string }>(`SELECT roleid::regrole::text AS roleid FROM pg_catalog.pg_auth_members WHERE member = $1::regrole`, [PROBE_ROLE]);
    expect(r.rows).toEqual([]);
  });

  interface Membership {
    member: string;
    inherit_option: boolean;
    set_option: boolean;
    admin_option: boolean;
  }
  async function probeMemberships(): Promise<Membership[]> {
    const r = await adm.query<Membership>(
      `SELECT member::regrole::text AS member, inherit_option, set_option, admin_option
         FROM pg_catalog.pg_auth_members WHERE roleid = $1::regrole ORDER BY 1`,
      [PROBE_ROLE],
    );
    return r.rows;
  }

  it("MINOR-6: migration rolü satırları: >=1, hiçbirinde inherit/admin, en az birinde set_option", async () => {
    const m = (await probeMemberships()).filter((x) => x.member === migrationRole);
    expect(m.length, `migration rolü (${migrationRole}) probe üyesi değil`).toBeGreaterThanOrEqual(1);
    expect(m.filter((x) => x.inherit_option), "migration rolü probe yetkilerini devralmamalı (INHERIT)").toEqual([]);
    expect(m.filter((x) => x.admin_option), "migration rolünde ADMIN OPTION olamaz").toEqual([]);
    expect(m.some((x) => x.set_option), "migration rolünde SET seçeneği olmalı").toBe(true);
  });

  it("MINOR-6: migration rolü dışı satırlarda set/inherit yok; üye wms_app/wms_auth değil", async () => {
    const others = (await probeMemberships()).filter((x) => x.member !== migrationRole);
    expect(others.filter((x) => x.set_option || x.inherit_option)).toEqual([]);
    expect(others.filter((x) => x.member === APP_ROLE || x.member === AUTH_ROLE)).toEqual([]);
  });

  it("MINOR-6 / Supervisor m2: beklenmeyen (migration rolü dışı) üyelik satırı — yerel/CI'da (compose) FAIL, Neon'da yalnızca bilgi", async () => {
    const others = (await probeMemberships()).filter((x) => x.member !== migrationRole);
    const summary = others.map((x) => `${x.member}(admin=${x.admin_option},set=${x.set_option},inherit=${x.inherit_option})`);
    // Neon: probe'u oluşturan altyapı rolünün ADMIN OPTION'lı satırı olabilir (bilgi; test başarısız olmaz). Diğer hedeflerde fail-closed.
    const unexpected = env.target === "neon" ? [] : summary;
    console.info(`[T-108 roles] ${env.target}: ${PROBE_ROLE} migration rolü dışı üyelik satırları: ${summary.join(", ") || "(yok)"}`);
    expect(unexpected, `${env.target}: ${PROBE_ROLE} için migration rolü dışı üyelik satırı beklenmez (fail-closed; admin dahil)`).toEqual([]);
  });

  it("m4: wms_app/wms_auth probe'a pg_has_role USAGE ve SET ile üye değil; pg_auth_members'ta hiçbir satırı yok", async () => {
    for (const role of [APP_ROLE, AUTH_ROLE]) {
      const r = await adm.query<{ u: boolean; s: boolean }>(
        `SELECT pg_has_role($1, $2, 'USAGE') AS u, pg_has_role($1, $2, 'SET') AS s`,
        [role, PROBE_ROLE],
      );
      expect(r.rows[0], role).toEqual({ u: false, s: false });
      const m = await adm.query(`SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = $1::regrole OR roleid = $1::regrole OR grantor = $1::regrole`, [role]);
      expect(m.rows, role).toEqual([]);
    }
  });

  it("m4 / MINOR-4: wms_probe şemasında probe yalnızca USAGE (CREATE yok); wms_meta'da üçünün de yetkisi yok", async () => {
    const r = await adm.query<Record<string, boolean>>(
      `SELECT has_schema_privilege($1, 'wms_probe', 'USAGE') AS usage, has_schema_privilege($1, 'wms_probe', 'CREATE') AS create_,
              has_schema_privilege($1, 'wms_meta', 'USAGE') AS meta_usage, has_schema_privilege($1, 'wms_meta', 'CREATE') AS meta_create`,
      [PROBE_ROLE],
    );
    expect(r.rows[0]).toEqual({ usage: true, create_: false, meta_usage: false, meta_create: false });
  });

  it("MINOR-4: wms_probe'daki her işlevin sahibi wms_identity_probe (en az bir işlev)", async () => {
    const r = await adm.query<{ fn: string; owner: string }>(
      `SELECT p.oid::regprocedure::text AS fn, p.proowner::regrole::text AS owner
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wms_probe'`,
    );
    expect(r.rows.length, "wms_probe boş (tarama sessizce boşalamaz)").toBeGreaterThanOrEqual(1);
    expect(r.rows.filter((x) => x.owner !== PROBE_ROLE)).toEqual([]);
  });

  it("MINOR-2: probe sahipli tetikleyici işlevinin proacl'i NULL değil, PUBLIC girdisi yok, sahip dışında yalnızca migration rolü; wms_app/wms_auth EXECUTE yok", async () => {
    const fns = await adm.query<{ fn: string; acl: string[] | null; oid: string }>(
      `SELECT p.oid::regprocedure::text AS fn, p.proacl::text[] AS acl, p.oid::text AS oid
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'wms_probe' AND p.prorettype = 'pg_catalog.trigger'::regtype`,
    );
    expect(fns.rows.length, "wms_probe tetikleyici işlevi yok (tarama boş)").toBeGreaterThanOrEqual(1);
    for (const f of fns.rows) {
      expect(f.acl, `${f.fn}: proacl NULL (varsayılan PUBLIC EXECUTE)`).not.toBeNull();
      const grantees = await adm.query<{ grantee: string; priv: string }>(
        `SELECT a.grantee::text AS grantee, a.privilege_type AS priv FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid = $1::oid`,
        [f.oid],
      );
      expect(grantees.rows.filter((g) => g.grantee === "0"), `${f.fn}: PUBLIC girdisi`).toEqual([]);
      const named = await adm.query<{ g: string }>(
        `SELECT DISTINCT a.grantee::regrole::text AS g FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a
          WHERE p.oid = $1::oid AND a.grantee <> p.proowner AND a.grantee <> 0`,
        [f.oid],
      );
      expect(named.rows.map((x) => x.g), `${f.fn}: sahip dışı girdiler`).toEqual([migrationRole]);
      for (const role of [APP_ROLE, AUTH_ROLE]) {
        const x = await adm.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`, [role, f.oid]);
        expect(x.rows[0]?.ok, `${f.fn}: ${role} EXECUTE`).toBe(false);
      }
    }
  });
});
