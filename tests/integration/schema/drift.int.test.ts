// Şema sapma testi (T-102, Yapılacaklar 5): migration'lar uygulanmış gerçek veritabanında
// `information_schema.columns` ↔ Drizzle `getTableConfig` (ad, tip, NULL'luk) birebir olmalı.
// Sonraki şema kartları bu testi genişletir (yeni şema modülünü SCHEMA_MODULES'e ekler).
// Okuma, tablo sahibi migration rolüyle yapılır: `information_schema.columns` yalnızca çağıranın
// yetkili olduğu sütunları gösterir (wms_app ile eksik görünürdü).
//
// Better Auth 1.7.7 referans alan listeleri (kaynak: `@better-auth/core` dist/db/get-tables.mjs ve
// `better-auth` dist/plugins/two-factor/schema.mjs, npm tarball'ı) aşağıdadır; Drizzle şemasındaki
// bu listede olmayan sütunlar YALNIZCA bilinçli eklerdir (BILINCLI_EKLER).
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import * as audit from "../../../packages/db/src/schema/audit.ts";
import * as catalog from "../../../packages/db/src/schema/catalog.ts";
import * as documents from "../../../packages/db/src/schema/documents.ts";
import * as identity from "../../../packages/db/src/schema/identity.ts";
import * as tenancy from "../../../packages/db/src/schema/tenancy.ts";
import * as warehouse from "../../../packages/db/src/schema/warehouse.ts";
import { readIntEnv, redactErrorChain, secretUrls } from "../harness/env.ts";

const env = readIntEnv(process.env);

// `drizzle-orm` yalnızca packages/db'nin bağımlılığıdır; kökten çözülemez → o paketin çözümleyicisi.
const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/db/package.json"));
const pgCore = (await import(pathToFileURL(dbRequire.resolve("drizzle-orm/pg-core")).href)) as typeof import("../../../packages/db/node_modules/drizzle-orm/pg-core/index.js");

type PgTableAny = Parameters<typeof pgCore.getTableConfig>[0];
const SCHEMA_MODULES: Record<string, unknown>[] = [identity, tenancy, audit, warehouse, catalog, documents];

function allTables(): PgTableAny[] {
  const out: PgTableAny[] = [];
  for (const mod of SCHEMA_MODULES) {
    for (const value of Object.values(mod)) {
      if (typeof value === "object" && value !== null && (value as { [k: symbol]: unknown })[Symbol.for("drizzle:IsDrizzleTable")] === true) {
        out.push(value as PgTableAny);
      }
    }
  }
  return out;
}

/** information_schema.data_type değerleri ile Drizzle `getSQLType()` eşlemesi (yalnızca farklılar). */
const TYPE_ALIAS: Record<string, string> = {};

interface Col {
  type: string;
  nullable: boolean;
}

async function dbColumns(): Promise<Map<string, Map<string, Col>>> {
  const client = new pg.Client({ connectionString: env.databaseUrlDirect });
  try {
    await client.connect();
    const r = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public'`,
    );
    const out = new Map<string, Map<string, Col>>();
    for (const row of r.rows) {
      const cols = out.get(row.table_name) ?? new Map<string, Col>();
      cols.set(row.column_name, { type: row.data_type, nullable: row.is_nullable === "YES" });
      out.set(row.table_name, cols);
    }
    return out;
  } catch (e) {
    throw new Error(redactErrorChain(e, secretUrls(env)));
  } finally {
    await client.end();
  }
}

const snake = (s: string): string => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** Better Auth 1.7.7 alanları (camelCase; `id` örtük). `rateLimit.key` → `key_hash` (ADR-014 §13, m9). */
const BETTER_AUTH_FIELDS: Record<string, string[]> = {
  users: ["name", "email", "emailVerified", "image", "createdAt", "updatedAt", "twoFactorEnabled"],
  sessions: ["expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"],
  accounts: [
    "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
    "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt",
  ],
  verifications: ["identifier", "value", "expiresAt", "createdAt", "updatedAt"],
  two_factors: ["secret", "backupCodes", "userId", "verified", "failedVerificationCount", "lockedUntil"],
  auth_rate_limits: ["keyHash", "count", "lastRequest"],
};

/** Better Auth çekirdek şemasına BİLİNÇLİ ekler (ADR-014 §12; ADR-016 3. tur m7). */
const BILINCLI_EKLER: Record<string, string[]> = {
  users: ["invitation_claim_id"],
  sessions: ["mfa_verified_at"],
};

describe(`identity schema drift (target=${env.target})`, () => {
  it("public tablolari tam olarak Drizzle tablolarinin kumesidir (ek/eksik tablo yok)", async () => {
    const db = await dbColumns();
    const declared = allTables().map((t) => pgCore.getTableConfig(t).name).sort();
    expect([...db.keys()].sort()).toEqual(declared);
  });

  it("her tablo icin sutun adi, tip ve NULL'luk birebir esler", async () => {
    const db = await dbColumns();
    for (const table of allTables()) {
      const cfg = pgCore.getTableConfig(table);
      const dbCols = db.get(cfg.name);
      expect(dbCols, `tablo yok: ${cfg.name}`).toBeDefined();
      const declared = new Map<string, Col>(
        cfg.columns.map((c) => [c.name, { type: TYPE_ALIAS[c.getSQLType()] ?? c.getSQLType(), nullable: !c.notNull }]),
      );
      expect(Object.fromEntries([...(dbCols ?? [])].sort()), cfg.name).toEqual(Object.fromEntries([...declared].sort()));
    }
  });

  it("Better Auth alanlari + yalnizca bilincli ekler: baska sutun yok (mfa_verified_at, invitation_claim_id istisnasi)", () => {
    const byName = new Map(allTables().map((t) => [pgCore.getTableConfig(t).name, pgCore.getTableConfig(t)]));
    for (const [table, fields] of Object.entries(BETTER_AUTH_FIELDS)) {
      const cfg = byName.get(table);
      expect(cfg, `tablo yok: ${table}`).toBeDefined();
      const expected = ["id", ...fields.map(snake), ...(BILINCLI_EKLER[table] ?? [])].sort();
      expect((cfg?.columns ?? []).map((c) => c.name).sort(), table).toEqual(expected);
    }
    // Bilinçli eklerin toplamı tam olarak iki sütundur.
    expect(Object.values(BILINCLI_EKLER).flat().sort()).toEqual(["invitation_claim_id", "mfa_verified_at"]);
  });

  it("kimlikler uuid ve users.email kucuk harfe normalize + UNIQUE", async () => {
    const client = new pg.Client({ connectionString: env.databaseUrlDirect });
    try {
      await client.connect();
      const ids = await client.query<{ table_name: string; data_type: string; column_default: string }>(
        `SELECT table_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'id'`,
      );
      // `id` sütunu olan her Drizzle tablosu (tenant_settings'in PK'si tenant_id'dir, request_rate_limits'in bilesik PK'si vardir; `id` yoktur).
      const withId = allTables().filter((t) => pgCore.getTableConfig(t).columns.some((c) => c.name === "id"));
      expect(ids.rows.length).toBe(withId.length);
      expect(withId.length).toBe(28); // T-202: + warehouses, locations; T-204: + units, items, unit_conversions, item_barcodes, inventory_owners, lots, serials, handling_units; T-206: + document_type_versions, documents, document_lines, document_status_history, idempotency_records
      for (const r of ids.rows) {
        expect(r.data_type, r.table_name).toBe("uuid");
        expect(r.column_default, r.table_name).toBe("gen_random_uuid()");
      }
      const cons = await client.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'public.users'::regclass AND conname IN ('users_email_key', 'users_email_lowercase_chk')`,
      );
      expect(cons.rows.map((r) => r.conname).sort()).toEqual(["users_email_key", "users_email_lowercase_chk"]);
    } finally {
      await client.end();
    }
  });
});

describe(`tenancy schema (T-103, target=${env.target})`, () => {
  const RLS_TABLES = ["tenants", "tenant_memberships", "membership_roles", "invitations", "tenant_settings"];
  // tenant_id sütunu olan tenant tabloları (tenants'ta id tenant kimliğidir).
  const TENANT_ID_TABLES = ["tenant_memberships", "membership_roles", "invitations", "tenant_settings"];
  const WITH_ID_TABLES = ["tenant_memberships", "membership_roles", "invitations"];

  async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: env.databaseUrlDirect });
    try {
      await client.connect();
      return (await client.query<T>(sql, params)).rows;
    } catch (e) {
      throw new Error(redactErrorChain(e, secretUrls(env)));
    } finally {
      await client.end();
    }
  }

  it("RLS tablolarinda ENABLE + FORCE; admin_reset_grants platform tablosu (RLS yok)", async () => {
    const rows = await query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY 1`,
      [[...RLS_TABLES, "admin_reset_grants"]],
    );
    expect(rows.map((r) => r.relname)).toEqual([...RLS_TABLES, "admin_reset_grants"].sort());
    for (const r of rows) {
      const expected = r.relname !== "admin_reset_grants";
      expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, expected, expected]);
    }
  });

  it("her tenant tablosunda tenant_id NOT NULL; (tenant_id, id) benzersiz", async () => {
    const cols = await query<{ table_name: string; is_nullable: string; data_type: string }>(
      `SELECT table_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name = ANY($1::text[]) ORDER BY 1`,
      [TENANT_ID_TABLES],
    );
    expect(cols.map((c) => c.table_name)).toEqual([...TENANT_ID_TABLES].sort());
    for (const c of cols) expect([c.table_name, c.is_nullable, c.data_type]).toEqual([c.table_name, "NO", "uuid"]);

    const uniques = await query<{ relname: string; def: string }>(
      `SELECT c.relname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        WHERE k.contype IN ('u', 'p') AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`,
      [WITH_ID_TABLES],
    );
    for (const t of WITH_ID_TABLES) {
      expect(uniques.filter((u) => u.relname === t).map((u) => u.def), t).toContain("UNIQUE (tenant_id, id)");
    }
  });

  it("tenant tablolarinda ON DELETE CASCADE yok (15 §DB sozlesmesi); bilesik FK'ler (tenant_id, ...) uzerinden", async () => {
    const fks = await query<{ relname: string; conname: string; confdeltype: string; def: string }>(
      `SELECT c.relname, k.conname, k.confdeltype, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
        WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`,
      [RLS_TABLES],
    );
    expect(fks.length).toBeGreaterThan(0);
    for (const f of fks) expect([f.conname, f.confdeltype], f.def).toEqual([f.conname, "a"]);
    const defs = fks.map((f) => f.def);
    expect(defs).toContain("FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id)");
    expect(defs).toContain("FOREIGN KEY (tenant_id, invited_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)");
  });

  it("izolasyon politikalari USING + WITH CHECK; kullanici kimligine dayali SELECT politikalari tenant baglami bos kosulu tasir (m1)", async () => {
    const pols = await query<{ tablename: string; policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, cmd, roles::text[] AS roles, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY 1, 2`,
      [RLS_TABLES],
    );
    for (const t of RLS_TABLES) {
      const iso = pols.find((p) => p.tablename === t && p.policyname === `${t}_isolation`);
      expect(iso, `${t}_isolation`).toBeDefined();
      expect(iso?.cmd).toBe("ALL");
      expect(iso?.qual).toContain("app.current_tenant_id");
      expect(iso?.with_check).toContain("app.current_tenant_id");
    }
    const userBased = pols.filter((p) => (p.qual ?? "").includes("app.current_user_id"));
    expect(userBased.map((p) => `${p.tablename}.${p.policyname}`).sort()).toEqual([
      "tenant_memberships.tenant_memberships_select_own",
      "tenants.tenants_select_own_memberships",
    ]);
    for (const p of userBased) {
      expect(p.cmd, p.policyname).toBe("SELECT");
      expect(p.qual, p.policyname).toMatch(/app\.current_tenant_id.*IS NULL/s);
    }
    // wms_identity_probe politikalari yalnizca o role ve yalnizca SELECT USING (true) (MINOR-1: kilit politikalari kaldirildi).
    const probe = pols.filter((p) => p.roles.includes("wms_identity_probe"));
    expect(probe.map((p) => `${p.tablename}.${p.policyname}.${p.cmd}`).sort()).toEqual([
      "invitations.probe_select.SELECT",
      "membership_roles.probe_select.SELECT",
      "tenant_memberships.probe_select.SELECT",
      "tenants.probe_select.SELECT",
    ]);
    for (const p of probe) {
      expect(p.roles, p.policyname).toEqual(["wms_identity_probe"]);
      expect(p.qual, p.policyname).toBe("true");
    }
  });

  it("CHECK kisitlari: rol/durum/teslim listeleri ve invitations.token_hash yalnizca SHA-256 ozeti", async () => {
    const rows = await query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE contype = 'c' AND conrelid = ANY(ARRAY['public.tenants'::regclass, 'public.tenant_memberships'::regclass,
              'public.membership_roles'::regclass, 'public.invitations'::regclass])`,
    );
    const byName = new Map(rows.map((r) => [r.conname, r.def]));
    for (const role of ["TENANT_ADMIN", "WAREHOUSE_MANAGER", "PICKER", "COUNTER", "READ_ONLY"]) {
      expect(byName.get("membership_roles_role_key_chk"), role).toContain(`'${role}'`);
      expect(byName.get("invitations_role_key_chk"), role).toContain(`'${role}'`);
    }
    expect(byName.get("invitations_delivered_via_chk")).toMatch(/EMAIL.*SCREEN/s);
    expect(byName.get("tenants_status_chk")).toMatch(/ACTIVE.*SUSPENDED.*CLOSING/s);
    expect(byName.get("tenant_memberships_status_chk")).toMatch(/ACTIVE.*REMOVED/s);
    expect(byName.get("invitations_token_hash_chk")).toContain("[0-9a-f]{64}");
    // MINOR-8: slug bicimi ve 'demo' yalnizca is_demo iken.
    expect(byName.get("tenants_slug_chk")).toContain("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?");
    expect(byName.get("tenants_slug_chk")).toMatch(/demo.*is_demo/s);
  });

  it("invitations: UNIQUE (token_hash) ve aktif davet icin (tenant_id, email_normalized) kismi benzersiz indeks", async () => {
    const idx = await query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'invitations'`,
    );
    const byName = new Map(idx.map((i) => [i.indexname, i.indexdef]));
    expect(byName.get("invitations_token_hash_key")).toContain("UNIQUE INDEX");
    expect(byName.get("invitations_active_email_key")).toMatch(/UNIQUE.*\(tenant_id, email_normalized\) WHERE .*accepted_at IS NULL.*revoked_at IS NULL/s);
  });
});

describe(`audit schema (T-107, target=${env.target})`, () => {
  async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: env.databaseUrlDirect });
    try {
      await client.connect();
      return (await client.query<T>(sql, params)).rows;
    } catch (e) {
      throw new Error(redactErrorChain(e, secretUrls(env)));
    } finally {
      await client.end();
    }
  }

  it("audit_logs: RLS ENABLE+FORCE, tenant_id NOT NULL uuid, (tenant_id, id) benzersiz; request_rate_limits platform tablosu (RLS yok)", async () => {
    const cls = await query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname IN ('audit_logs', 'request_rate_limits') ORDER BY 1`,
    );
    expect(cls).toEqual([
      { relname: "audit_logs", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "request_rate_limits", relrowsecurity: false, relforcerowsecurity: false },
    ]);
    const col = await query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'tenant_id'`,
    );
    expect(col).toEqual([{ is_nullable: "NO", data_type: "uuid" }]);
    const uq = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.audit_logs'::regclass AND contype = 'u'`,
    );
    expect(uq.map((r) => r.def)).toContain("UNIQUE (tenant_id, id)");
  });

  it("audit_logs.created_xid xid8 NOT NULL DEFAULT pg_current_xact_id() (I-16); izolasyon politikasi USING + WITH CHECK", async () => {
    const col = await query<{ udt_name: string; is_nullable: string; column_default: string }>(
      `SELECT udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'created_xid'`,
    );
    expect(col).toEqual([{ udt_name: "xid8", is_nullable: "NO", column_default: "pg_current_xact_id()" }]);
    const pol = await query<{ qual: string; with_check: string }>(
      `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_isolation'`,
    );
    expect(pol).toHaveLength(1);
    expect(pol[0]?.qual).toContain("app.current_tenant_id");
    expect(pol[0]?.with_check).toContain("app.current_tenant_id");
  });

  it("request_rate_limits: birincil anahtar (scope, key_hash, window_start); key_hash yalnizca SHA-256 ozeti CHECK'i", async () => {
    const pk = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.request_rate_limits'::regclass AND contype = 'p'`,
    );
    expect(pk).toEqual([{ def: "PRIMARY KEY (scope, key_hash, window_start)" }]);
    const chk = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'request_rate_limits_key_hash_chk'`,
    );
    expect(chk[0]?.def).toContain("[0-9a-f]{64}");
  });

  it("security_events: kimlik olayi yazar tetikleyicisi BEFORE INSERT ROW, ENABLE ALWAYS, SECURITY INVOKER (0005, T-112c)", async () => {
    const trg = await query<{ tgenabled: string; tgtype: number; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT t.tgenabled, t.tgtype, p.prosecdef, p.proconfig
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'public.security_events'::regclass AND t.tgname = 'security_events_identity_writers'`,
    );
    expect(trg).toHaveLength(1);
    expect(trg[0]?.tgenabled).toBe("A");
    expect(trg[0]?.tgtype).toBe(1 | 2 | 4); // tgtype bitleri: ROW=1, BEFORE=2, INSERT=4 (başka olay yok)
    expect(trg[0]?.prosecdef).toBe(false);
    expect(trg[0]?.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
  });
});

describe(`invitation_tenant_for_token (0006, T-117; target=${env.target})`, () => {
  async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: env.databaseUrlDirect });
    try {
      await client.connect();
      return (await client.query<T>(sql, params)).rows;
    } catch (e) {
      throw new Error(redactErrorChain(e, secretUrls(env)));
    } finally {
      await client.end();
    }
  }
  const FN = "wms_probe.invitation_tenant_for_token(text)";

  it("sahibi wms_identity_probe, SECURITY DEFINER, sabit search_path, proacl NULL degil ve PUBLIC girdisi yok; yalnizca uuid doner", async () => {
    const r = await query<{ owner: string; prosecdef: boolean; proconfig: string[] | null; acl_null: boolean; public_acl: boolean; ret: string }>(
      `SELECT p.proowner::regrole::text AS owner, p.prosecdef, p.proconfig, p.proacl IS NULL AS acl_null,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_acl,
              p.prorettype::regtype::text AS ret
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      owner: "wms_identity_probe",
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, pg_temp"],
      acl_null: false,
      public_acl: false,
      ret: "uuid",
    });
  });

  it("EXECUTE yalnizca wms_app; wms_auth ve PUBLIC yok", async () => {
    const r = await query<{ app: boolean; auth: boolean }>(
      `SELECT has_function_privilege('wms_app', $1, 'EXECUTE') AS app, has_function_privilege('wms_auth', $1, 'EXECUTE') AS auth`,
      [FN],
    );
    expect(r[0]).toEqual({ app: true, auth: false });
    const grantees = await query<{ grantee: string }>(
      `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
         FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure ORDER BY 1`,
      [FN],
    );
    expect(grantees.map((g) => g.grantee).filter((g) => g !== "wms_identity_probe")).toEqual(["wms_app"]);
  });

  it("probe salt okunur kalir: tenant tablolarinda yazma yetkisi ve yazma politikasi yok", async () => {
    const r = await query<{ w: boolean }>(
      `SELECT bool_or(has_table_privilege('wms_identity_probe', t, 'INSERT, UPDATE, DELETE, TRUNCATE')
                      OR has_any_column_privilege('wms_identity_probe', t, 'UPDATE')) AS w
         FROM unnest(ARRAY['public.invitations', 'public.tenant_memberships', 'public.membership_roles', 'public.tenants']) AS t`,
    );
    expect(r[0]?.w).toBe(false);
    const writes = await query<{ polname: string }>(
      `SELECT polname FROM pg_policy p WHERE p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'wms_identity_probe')] AND p.polcmd <> 'r'`,
    );
    expect(writes).toEqual([]);
  });
});

describe(`invitation_preview_for_token (0008, T-117d; target=${env.target})`, () => {
  async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: env.databaseUrlDirect });
    try {
      await client.connect();
      return (await client.query<T>(sql, params)).rows;
    } catch (e) {
      throw new Error(redactErrorChain(e, secretUrls(env)));
    } finally {
      await client.end();
    }
  }
  const FN = "wms_probe.invitation_preview_for_token(text)";

  it("sahibi wms_identity_probe, SECURITY DEFINER, STABLE, sabit search_path, proacl NULL degil, PUBLIC girdisi yok; yalnizca (tenant_name, role_key, expires_at) doner", async () => {
    const r = await query<{ owner: string; prosecdef: boolean; provolatile: string; proconfig: string[] | null; acl_null: boolean; public_acl: boolean; retset: boolean; cols: string[] | null; modes: string[] | null }>(
      `SELECT p.proowner::regrole::text AS owner, p.prosecdef, p.provolatile, p.proconfig, p.proacl IS NULL AS acl_null,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_acl, p.proretset AS retset,
              p.proargnames AS cols, p.proargmodes::text[] AS modes
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      owner: "wms_identity_probe",
      prosecdef: true,
      provolatile: "s",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      acl_null: false,
      public_acl: false,
      retset: true,
      cols: ["token_hash", "tenant_name", "role_key", "expires_at"],
      modes: ["i", "t", "t", "t"],
    });
  });

  it("EXECUTE yalnizca wms_app; wms_auth ve PUBLIC yok", async () => {
    const r = await query<{ app: boolean; auth: boolean }>(
      `SELECT has_function_privilege('wms_app', $1, 'EXECUTE') AS app, has_function_privilege('wms_auth', $1, 'EXECUTE') AS auth`,
      [FN],
    );
    expect(r[0]).toEqual({ app: true, auth: false });
    const grantees = await query<{ grantee: string }>(
      `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
         FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure ORDER BY 1`,
      [FN],
    );
    expect(grantees.map((g) => g.grantee).filter((g) => g !== "wms_identity_probe")).toEqual(["wms_app"]);
  });
});
