// Kimlik tabloları yetki ve geri alma testi (T-102; ADR-014 §10, ADR-016 §1).
//
// Roller GERÇEK bağlantılarla sınanır: wms_app (DATABASE_URL, pooler) ve wms_auth
// (AUTH_DATABASE_URL, pooler); superuser ile değil. Her ifade kendi transaction'ında çalışır ve
// HER ZAMAN geri alınır (kalıcı veri bırakmaz). Migration rolü (DATABASE_URL_DIRECT) yalnızca
// tetikleyici ve geri alma doğrulaması içindir.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../../../packages/db/src/migrate.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain, secretUrls } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [...secretUrls(env), authUrl];

const INSUFFICIENT_PRIVILEGE = "42501";

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
  return client;
}

/** İfadeyi kendi transaction'ında çalıştırır; sonucu/hatayı döndürür ve daima ROLLBACK yapar. */
async function attempt(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<{ ok: true; rows: unknown[] } | { ok: false; code: string | undefined; message: string }> {
  await client.query("BEGIN");
  try {
    const r = await client.query(sql, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectDenied(client: pg.Client, sql: string, params: unknown[] = []): Promise<void> {
  const r = await attempt(client, sql, params);
  expect(r.ok, `beklenen yetki hatasi: ${sql}`).toBe(false);
  if (!r.ok) expect(r.code, r.message).toBe(INSUFFICIENT_PRIVILEGE);
}

async function expectAllowed(client: pg.Client, sql: string, params: unknown[] = []): Promise<void> {
  const r = await attempt(client, sql, params);
  expect(r.ok, `beklenen basari: ${sql} -> ${r.ok ? "" : r.message}`).toBe(true);
}

const clients: pg.Client[] = [];
async function open(url: string): Promise<pg.Client> {
  const c = await connect(url);
  clients.push(c);
  return c;
}
const scratchDbs: string[] = [];

afterAll(async () => {
  for (const c of clients) await c.end().catch(() => undefined);
  if (scratchDbs.length > 0) {
    const admin = await connect(env.databaseUrlDirect);
    try {
      for (const name of scratchDbs) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});

const AUTH_ONLY_TABLES = ["sessions", "accounts", "verifications", "two_factors", "auth_rate_limits"] as const;

describe(`identity grants (target=${env.target})`, () => {
  it("wms_app: Better Auth tablolarinda SELECT dahil hicbir yetki yok", async () => {
    const app = await open(env.databaseUrl);
    for (const t of AUTH_ONLY_TABLES) {
      await expectDenied(app, `SELECT * FROM public.${t}`);
      await expectDenied(app, `DELETE FROM public.${t}`);
    }
    await expectDenied(app, "SELECT id FROM public.sessions");
  });

  it("wms_app: users'ta yalniz id, name, email, email_verified okunur; digerleri ve tablo duzeyi okuma yetki hatasi", async () => {
    const app = await open(env.databaseUrl);
    await expectAllowed(app, "SELECT email FROM public.users");
    await expectAllowed(app, "SELECT id, name, email, email_verified FROM public.users");
    await expectDenied(app, "SELECT * FROM public.users");
    await expectDenied(app, "SELECT invitation_claim_id FROM public.users");
    await expectDenied(app, "SELECT two_factor_enabled FROM public.users");
    await expectDenied(app, "SELECT image FROM public.users");
    await expectDenied(app, "SELECT created_at FROM public.users");
    await expectDenied(app, "UPDATE public.users SET name = 'x'");
    await expectDenied(app, "DELETE FROM public.users");
    await expectDenied(app, `INSERT INTO public.users (name, email) VALUES ('a', 'a@example.invalid')`);
  });

  it("wms_app: security_events yalniz INSERT+SELECT; UPDATE/DELETE/TRUNCATE yetki hatasi", async () => {
    const app = await open(env.databaseUrl);
    await expectAllowed(app, `INSERT INTO public.security_events (event_type) VALUES ('t102.test')`);
    await expectAllowed(app, "SELECT id, occurred_at, created_xid FROM public.security_events");
    await expectDenied(app, `UPDATE public.security_events SET event_type = 'x'`);
    await expectDenied(app, "DELETE FROM public.security_events");
    await expectDenied(app, "TRUNCATE public.security_events");
  });

  it("wms_auth: Better Auth tablolarinda SELECT/INSERT/UPDATE/DELETE; TRUNCATE yok", async () => {
    const auth = await open(authUrl);
    for (const t of AUTH_ONLY_TABLES) {
      await expectAllowed(auth, `SELECT * FROM public.${t}`);
      await expectAllowed(auth, `DELETE FROM public.${t}`);
      await expectDenied(auth, `TRUNCATE public.${t}`);
    }
    // Zincir: kullanici + oturum + hesap + 2FA + hiz siniri yazimi (tek transaction, geri alinir).
    const email = `t102-${randomBytes(4).toString("hex")}@example.invalid`;
    await auth.query("BEGIN");
    try {
      const u = await auth.query<{ id: string }>(`INSERT INTO public.users (name, email) VALUES ('T', $1) RETURNING id`, [email]);
      const id = u.rows[0]?.id;
      expect(id).toBeDefined();
      await auth.query(`INSERT INTO public.sessions (expires_at, token, user_id) VALUES (now(), $1, $2)`, [randomBytes(8).toString("hex"), id]);
      await auth.query(`INSERT INTO public.accounts (account_id, provider_id, user_id) VALUES ('a', 'credential', $1)`, [id]);
      await auth.query(`INSERT INTO public.two_factors (secret, backup_codes, user_id) VALUES ('s', 'b', $1)`, [id]);
      await auth.query(`INSERT INTO public.verifications (identifier, value, expires_at) VALUES ('i', 'v', now())`);
      await auth.query(`INSERT INTO public.auth_rate_limits (key_hash, count, last_request) VALUES ($1, 1, 1)`, [randomBytes(32).toString("hex")]);
      await auth.query(`UPDATE public.sessions SET mfa_verified_at = now() WHERE user_id = $1`, [id]);
    } finally {
      await auth.query("ROLLBACK");
    }
  });

  it("wms_auth users: INSERT (invitation_claim_id dahil) ve sutun bazli UPDATE izinli; id/invitation_claim_id UPDATE yetki hatasi", async () => {
    const auth = await open(authUrl);
    const email = `t102-${randomBytes(4).toString("hex")}@example.invalid`;
    const claim = "6f1c2f6e-0000-4000-8000-000000000001";
    await expectAllowed(
      auth,
      `INSERT INTO public.users (name, email, invitation_claim_id) VALUES ('T', $1, $2)`,
      [email, claim],
    );
    // UPDATE yalnızca var olan satırda yetki yoklamasından geçer; satırı aynı transaction'da yaz.
    const run = async (update: string): Promise<{ ok: boolean; code?: string | undefined; message?: string }> => {
      await auth.query("BEGIN");
      try {
        await auth.query(`INSERT INTO public.users (name, email, invitation_claim_id) VALUES ('T', $1, $2)`, [email, claim]);
        await auth.query(update, [email]);
        return { ok: true };
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return { ok: false, code: err.code, message: err.message };
      } finally {
        await auth.query("ROLLBACK");
      }
    };
    for (const col of ["name = 'N'", "image = 'i'", "email = 'b@example.invalid'", "email_verified = true", "updated_at = now()", "two_factor_enabled = true"]) {
      const r = await run(`UPDATE public.users SET ${col} WHERE email = (SELECT email FROM public.users WHERE email = $1)`);
      expect(r.ok, `${col}: ${r.message ?? ""}`).toBe(true);
    }
    const bad1 = await run(`UPDATE public.users SET invitation_claim_id = gen_random_uuid() WHERE email = $1`);
    expect(bad1.ok).toBe(false);
    expect(bad1.code, bad1.message).toBe(INSUFFICIENT_PRIVILEGE);
    const bad2 = await run(`UPDATE public.users SET id = gen_random_uuid() WHERE email = $1`);
    expect(bad2.ok).toBe(false);
    expect(bad2.code, bad2.message).toBe(INSUFFICIENT_PRIVILEGE);
    const bad3 = await run(`UPDATE public.users SET invitation_claim_id = NULL WHERE email = $1`);
    expect(bad3.code, bad3.message).toBe(INSUFFICIENT_PRIVILEGE);
    await expectDenied(auth, "TRUNCATE public.users");
  });

  it("wms_auth: security_events yalniz INSERT (SELECT/UPDATE/DELETE yetki hatasi)", async () => {
    const auth = await open(authUrl);
    await expectAllowed(auth, `INSERT INTO public.security_events (event_type, detail) VALUES ('t102.auth', '{"a":1}')`);
    await expectDenied(auth, "SELECT * FROM public.security_events");
    await expectDenied(auth, `UPDATE public.security_events SET event_type = 'x'`);
    await expectDenied(auth, "DELETE FROM public.security_events");
  });

  it("wms_auth: hicbir tenant (kimlik disi) tabloda yetki yok; wms_app yalniz izinli tablolarda", async () => {
    const admin = await open(env.databaseUrlDirect);
    const identityTables = ["users", "sessions", "accounts", "verifications", "two_factors", "auth_rate_limits", "security_events"];
    const r = await admin.query<{ relname: string; auth_any: boolean; app_any: boolean }>(
      `SELECT c.relname,
              has_any_column_privilege('wms_auth', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
                OR has_table_privilege('wms_auth', c.oid, 'DELETE, TRUNCATE, TRIGGER') AS auth_any,
              has_any_column_privilege('wms_app', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
                OR has_table_privilege('wms_app', c.oid, 'DELETE, TRUNCATE, TRIGGER') AS app_any
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    );
    const others = r.rows.filter((x) => !identityTables.includes(x.relname));
    for (const o of others) {
      expect(o.auth_any, `wms_auth ${o.relname} uzerinde yetki tasiyor`).toBe(false);
    }
    expect(r.rows.filter((x) => x.auth_any && !identityTables.includes(x.relname))).toEqual([]);
    // Tenant tabloları (varsa) için wms_auth yetkisiz; wms_meta kapalı (her iki rol).
    const meta = await admin.query<{ app: boolean; auth: boolean; app_t: boolean; auth_t: boolean }>(
      `SELECT has_schema_privilege('wms_app', 'wms_meta', 'USAGE, CREATE') AS app,
              has_schema_privilege('wms_auth', 'wms_meta', 'USAGE, CREATE') AS auth,
              has_table_privilege('wms_app', 'wms_meta.schema_migrations', 'SELECT, INSERT, UPDATE, DELETE') AS app_t,
              has_table_privilege('wms_auth', 'wms_meta.schema_migrations', 'SELECT, INSERT, UPDATE, DELETE') AS auth_t`,
    );
    expect(meta.rows[0]).toEqual({ app: false, auth: false, app_t: false, auth_t: false });
  });

  it("wms_meta.schema_migrations: wms_app ve wms_auth ile erisim yetki hatasi", async () => {
    const app = await open(env.databaseUrl);
    const auth = await open(authUrl);
    for (const c of [app, auth]) {
      await expectDenied(c, "SELECT * FROM wms_meta.schema_migrations");
      await expectDenied(c, "DELETE FROM wms_meta.schema_migrations");
    }
  });

  it("wms_app ve wms_auth hicbir kimlik tablosunun sahibi degil", async () => {
    const admin = await open(env.databaseUrlDirect);
    const r = await admin.query<{ relname: string; owner: string }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(7);
    for (const row of r.rows) expect(["wms_app", "wms_auth"], row.relname).not.toContain(row.owner);
  });

  it("security_events: wms_app ve wms_auth id/occurred_at/created_xid veremez (ileri tarihli olay ret)", async () => {
    const app = await open(env.databaseUrl);
    const auth = await open(authUrl);
    for (const client of [app, auth]) {
      for (const col of ["occurred_at", "id", "created_xid"]) {
        const value = col === "occurred_at" ? "now() + interval '1 day'" : col === "id" ? "gen_random_uuid()" : "pg_current_xact_id()";
        await expectDenied(client, `INSERT INTO public.security_events (event_type, ${col}) VALUES ('reauth.succeeded', ${value})`);
      }
    }
    // Varsayilanlar calisir; occurred_at sunucu zamani.
    const owner = await open(env.databaseUrlDirect);
    await owner.query("BEGIN");
    try {
      await owner.query(`INSERT INTO public.security_events (event_type, occurred_at) VALUES ('t102.force', now() + interval '1 day')`);
      const r = await owner.query<{ forced: boolean }>(
        `SELECT occurred_at = now() AS forced FROM public.security_events WHERE event_type = 't102.force'`,
      );
      expect(r.rows[0]?.forced).toBe(true);
    } finally {
      await owner.query("ROLLBACK");
    }
  });

  it("security_events: session_replication_role=replica tetikleyiciyi atlatamaz", async () => {
    const owner = await open(env.databaseUrlDirect);
    await owner.query("BEGIN");
    try {
      await owner.query(`INSERT INTO public.security_events (event_type) VALUES ('t102.replica')`);
      await owner.query("SET LOCAL session_replication_role = replica");
      let err: { message?: string } | undefined;
      try {
        await owner.query("DELETE FROM public.security_events");
      } catch (e) {
        err = e as { message?: string };
      }
      expect(err?.message).toContain("append-only");
    } finally {
      await owner.query("ROLLBACK");
    }
  });

  it("auth_rate_limits.key_hash yalniz 64 hane kucuk harf hex (duz IP/e-posta ret)", async () => {
    const auth = await open(authUrl);
    const hex = "a".repeat(64);
    await expectAllowed(auth, `INSERT INTO public.auth_rate_limits (key_hash, count, last_request) VALUES ('${hex}', 1, 1)`);
    for (const bad of ["10.0.0.1", "user@example.com", "A".repeat(64), "a".repeat(63)]) {
      const r = await attempt(auth, `INSERT INTO public.auth_rate_limits (key_hash, count, last_request) VALUES ($1, 1, 1)`, [bad]);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.code, r.message).toBe("23514");
    }
  });

  it("wms_auth: public sema CREATE ve veritabani CREATE/TEMP yetkisi yok", async () => {
    const admin = await open(env.databaseUrlDirect);
    const r = await admin.query<{ s: boolean; d: boolean }>(
      `SELECT has_schema_privilege('wms_auth', 'public', 'CREATE') AS s,
              has_database_privilege('wms_auth', current_database(), 'CREATE, TEMPORARY') AS d`,
    );
    expect(r.rows[0]).toEqual({ s: false, d: false });
  });

  it("security_events tetikleyicisi migration rolunde de UPDATE/DELETE/TRUNCATE'i reddeder", async () => {
    const owner = await open(env.databaseUrlDirect);
    for (const stmt of [
      `UPDATE public.security_events SET event_type = 'x'`,
      "DELETE FROM public.security_events",
      "TRUNCATE public.security_events",
    ]) {
      await owner.query("BEGIN");
      try {
        await owner.query(`INSERT INTO public.security_events (event_type) VALUES ('t102.trg')`);
        let err: { code?: string; message?: string } | undefined;
        try {
          await owner.query(stmt);
        } catch (e) {
          err = e as { code?: string; message?: string };
        }
        expect(err, stmt).toBeDefined();
        expect(err?.message, stmt).toContain("append-only");
      } finally {
        await owner.query("ROLLBACK");
      }
    }
  });
});

describe(`0002_identity ileri/geri/ileri (target=${env.target})`, () => {
  it("geri aldiktan sonra kimlik tablolari ve islev yok; yeniden ileri basarili", async () => {
    const name = `wms_ident_${randomBytes(5).toString("hex")}`;
    const admin = await connect(env.databaseUrlDirect);
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      scratchDbs.push(name);
    } finally {
      await admin.end();
    }
    const u = new URL(env.databaseUrlDirect);
    u.pathname = `/${name}`;
    const url = u.toString();

    const first = await migrateUp({ url });
    expect(first.applied).toContain("0002");

    const shape = async (): Promise<{ tables: string[]; funcs: string[] }> => {
      const c = await connect(url);
      try {
        const t = await c.query<{ n: string }>(
          `SELECT relname AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY 1`,
        );
        const f = await c.query<{ n: string }>(
          `SELECT proname AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
            WHERE s.nspname = 'public' ORDER BY 1`,
        );
        return { tables: t.rows.map((x) => x.n), funcs: f.rows.map((x) => x.n) };
      } finally {
        await c.end();
      }
    };

    expect((await shape()).tables).toContain("security_events");
    const down = await migrateDown({ url, to: "0001", wmsEnv: "ci" });
    expect(down.reverted).toEqual(["0002"]);
    expect(await shape()).toEqual({ tables: [], funcs: [] });

    const again = await migrateUp({ url });
    expect(again.applied).toEqual(["0002"]);
    expect((await shape()).tables).toContain("users");
    expect((await migrateUp({ url })).applied).toEqual([]);
  });

  it("satir varsa ve ortam yikici geri almaya kapaliysa down RAISE eder", async () => {
    const name = `wms_ident_${randomBytes(5).toString("hex")}`;
    const admin = await connect(env.databaseUrlDirect);
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      scratchDbs.push(name);
    } finally {
      await admin.end();
    }
    const u = new URL(env.databaseUrlDirect);
    u.pathname = `/${name}`;
    const url = u.toString();
    await migrateUp({ url });
    const c = await connect(url);
    try {
      await c.query(`INSERT INTO public.security_events (event_type) VALUES ('t102.keep')`);
    } finally {
      await c.end();
    }
    await expect(migrateDown({ url, to: "0001", wmsEnv: "staging" })).rejects.toThrow(/veri kaybettiren geri alma/);
    const check = await connect(url);
    try {
      const r = await check.query<{ n: string }>("SELECT count(*)::text AS n FROM public.security_events");
      expect(r.rows[0]?.n).toBe("1");
    } finally {
      await check.end();
    }
  });
});
