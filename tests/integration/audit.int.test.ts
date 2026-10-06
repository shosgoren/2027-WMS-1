// audit_logs + request_rate_limits + recordSecurityEvent entegrasyon testi (T-107; ADR-016 §7, §10; I-12, I-16).
//
// Roller GERÇEK bağlantılarla sınanır: uygulama tarafı YALNIZCA DATABASE_URL (wms_app, pooler) ve AUTH_DATABASE_URL
// (wms_auth); superuser ile değil. Migration rolü (DATABASE_URL_DIRECT) yalnızca fikstür kurulumu, "migration rolü
// dahil değiştirilemez" ve katalog doğrulaması içindir. Değiştirilemezlik AC testleri T-108'in işidir (bağımsız yazar).
//
// Fikstür notu: audit_logs satırı SİLİNEMEZ (I-12) ve tenants'a FK ile bağlıdır; bu yüzden audit satırı taşıyan
// fikstür tenant'ları temizlenmez (tek kullanımlık Testcontainers örneği; rastgele slug/UUID, sentetik veri, G-09).
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuditError,
  appendAudit,
  createDbClient,
  recordSecurityEvent,
  withMembership,
  withSystemTenant,
} from "../../packages/db/src/index.ts";
import { MIGRATIONS_DIR, migrateDown, migrateUp } from "../../packages/db/src/migrate.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../packages/db/src/client.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "./harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";

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

const open: pg.Client[] = [];
async function openClient(url: string): Promise<pg.Client> {
  const c = await connect(url);
  open.push(c);
  return c;
}

type Attempt = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string | undefined; message: string };

/** İfadeyi (isteğe bağlı GUC önkoşullarıyla) kendi transaction'ında çalıştırır ve DAİMA ROLLBACK yapar. */
async function attempt(client: pg.Client, sqlText: string, params: unknown[] = [], tenantId?: string): Promise<Attempt> {
  await client.query("BEGIN");
  try {
    if (tenantId !== undefined) await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const r = await client.query(sqlText, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectCode(r: Attempt, code: string, what: string): Promise<void> {
  expect(r.ok, `${what}: hata bekleniyordu`).toBe(false);
  if (!r.ok) expect(r.code, `${what}: ${r.message}`).toBe(code);
}

/** Migration rolüyle tenant bağlamında sayım (FORCE RLS sahibi için de geçerli). */
async function countAudit(tenantId: string, where = "true", params: unknown[] = []): Promise<number> {
  const c = await openClient(env.databaseUrlDirect);
  await c.query("BEGIN");
  try {
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.audit_logs WHERE ${where}`, params);
    return Number(r.rows[0]?.n);
  } finally {
    await c.query("ROLLBACK");
  }
}

async function mkTenant(isDemo = false): Promise<string> {
  const c = await openClient(env.databaseUrlDirect);
  const id = randomUUID();
  await c.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T107 Tenant', $3)", [
    id,
    `t107-${randomBytes(6).toString("hex")}`,
    isDemo,
  ]);
  return id;
}

let app: DbClient;
let appRaw: pg.Client;
let authRaw: pg.Client;
let admRaw: pg.Client;
let tA: string;
let tB: string;
let tDemo: string;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  appRaw = await openClient(env.databaseUrl);
  authRaw = await openClient(authUrl);
  admRaw = await openClient(env.databaseUrlDirect);
  tA = await mkTenant();
  tB = await mkTenant();
  tDemo = await mkTenant(true);
});

afterAll(async () => {
  await app.close();
  for (const c of open) await c.end().catch(() => undefined);
}, 60_000);

describe(`audit_logs yazma (target=${env.target})`, () => {
  it("withSystemTenant içinde commit: satır görünür; tenant_id bağlamdan, created_xid ve occurred_at sunucudan", async () => {
    const actor = randomUUID();
    const r = await withSystemTenant(app, tA, "t107.test", async (tx) =>
      appendAudit(tx, { action: "tenant.created", actorUserId: actor, entityType: "tenant", entityId: tA, reason: "ilk", ip: "203.0.113.5", userAgent: "UA/1" }),
    );
    expect(r.createdXid).toMatch(/^\d+$/);
    const rows = await withSystemTenant(app, tA, "t107.read", async (tx) =>
      tx.execute<{ tenant_id: string; action: string; actor_user_id: string; created_xid: string | null; ip: string; user_agent: string; delta: number }>(
        `SELECT tenant_id, action, actor_user_id, created_xid::text AS created_xid, ip, user_agent,
                abs(extract(epoch FROM (now() - occurred_at)))::float8 AS delta
           FROM public.audit_logs WHERE id = '${r.id}'`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: tA, action: "tenant.created", actor_user_id: actor, created_xid: r.createdXid, ip: "203.0.113.5", user_agent: "UA/1" });
    expect(rows[0]?.created_xid).not.toBeNull();
    expect(Number(rows[0]?.delta)).toBeLessThan(30);
  });

  it("aynı transaction geri alınırsa audit satırı da yoktur", async () => {
    const marker = `rollback-${randomBytes(4).toString("hex")}`;
    const boom = new Error("iş hatası");
    await expect(
      withSystemTenant(app, tA, "t107.test", async (tx) => {
        await appendAudit(tx, { action: "tenant.settings_changed", entityId: marker });
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await countAudit(tA, "entity_id = $1", [marker])).toBe(0);
  });

  it("withMembership yolu: aktör ve maskelenmiş change_summary kalıcı; sır değeri veritabanında yok", async () => {
    const userId = randomUUID();
    await admRaw.query("INSERT INTO public.users (id, name, email) VALUES ($1, 'T107 fixture', $2)", [userId, `t107-${randomBytes(6).toString("hex")}@example.test`]);
    await admRaw.query("BEGIN");
    await admRaw.query("SELECT set_config('app.current_tenant_id', $1, true)", [tA]);
    const m = await admRaw.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, is_owner) VALUES ($1, $2, true) RETURNING id", [tA, userId]);
    await admRaw.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'TENANT_ADMIN')", [tA, (m.rows[0] as { id: string }).id]);
    await admRaw.query("COMMIT");
    const marker = `masked-${randomBytes(4).toString("hex")}`;
    const sentinel = `sentinel-${randomBytes(4).toString("hex")}`;
    await withMembership({ client: app, userId, tenantId: tA }, async (tx, mem) => {
      await appendAudit(tx, {
        action: "member.invited",
        actorUserId: mem.userId,
        entityId: marker,
        changeSummary: { email: "x@example.test", inviteToken: sentinel, nested: { Password: sentinel, ok: 1 } },
      });
    });
    const rows = await withSystemTenant(app, tA, "t107.read", async (tx) =>
      tx.execute<{ change_summary: Record<string, unknown>; actor_user_id: string }>(
        `SELECT change_summary, actor_user_id FROM public.audit_logs WHERE entity_id = '${marker}'`,
      ),
    );
    expect(rows[0]?.actor_user_id).toBe(userId);
    expect(rows[0]?.change_summary).toEqual({ email: "x@example.test", inviteToken: "[REDACTED]", nested: { Password: "[REDACTED]", ok: 1 } });
    expect(await countAudit(tA, "change_summary::text LIKE $1", [`%${sentinel}%`])).toBe(0);
  });

  it("boyut sınırı aşılırsa VALIDATION_FAILED ve satır yazılmaz", async () => {
    const marker = `big-${randomBytes(4).toString("hex")}`;
    const err = await withSystemTenant(app, tA, "t107.test", async (tx) =>
      appendAudit(tx, { action: "tenant.settings_changed", entityId: marker, changeSummary: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, "a".repeat(1000)])) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).code).toBe("VALIDATION_FAILED");
    expect(await countAudit(tA, "entity_id = $1", [marker])).toBe(0);
  });

  it("demo tenant'ta ip ve user_agent NULL; demo olmayanda yazılır (M9)", async () => {
    const m1 = `demo-${randomBytes(4).toString("hex")}`;
    const m2 = `real-${randomBytes(4).toString("hex")}`;
    await withSystemTenant(app, tDemo, "t107.test", async (tx) => {
      await appendAudit(tx, { action: "tenant.created", entityId: m1, ip: "203.0.113.7", userAgent: "UA-demo" });
    });
    await withSystemTenant(app, tB, "t107.test", async (tx) => {
      await appendAudit(tx, { action: "tenant.created", entityId: m2, ip: "203.0.113.8", userAgent: "UA-real" });
    });
    expect(await countAudit(tDemo, "entity_id = $1 AND ip IS NULL AND user_agent IS NULL", [m1])).toBe(1);
    expect(await countAudit(tB, "entity_id = $1 AND ip = '203.0.113.8' AND user_agent = 'UA-real'", [m2])).toBe(1);
  });
});

describe("audit_logs izolasyon ve yetkiler (wms_app, süper kullanıcı değil)", () => {
  it("tenant B bağlamı tenant A satırlarını görmez; bağlamsız okuma boş", async () => {
    const marker = `iso-${randomBytes(4).toString("hex")}`;
    await withSystemTenant(app, tA, "t107.test", async (tx) => {
      await appendAudit(tx, { action: "tenant.created", entityId: marker });
    });
    const q = "SELECT count(*)::text AS n FROM public.audit_logs WHERE entity_id = $1";
    const asB = await attempt(appRaw, q, [marker], tB);
    expect(asB.ok && asB.rows[0]).toMatchObject({ n: "0" });
    const asA = await attempt(appRaw, q, [marker], tA);
    expect(asA.ok && asA.rows[0]).toMatchObject({ n: "1" });
    const none = await attempt(appRaw, q, [marker]);
    expect(none.ok && none.rows[0]).toMatchObject({ n: "0" });
  });

  it("başka tenant'a yazma ve tenant_id/occurred_at/created_xid/id açıkça verme reddedilir", async () => {
    await expectCode(
      await attempt(appRaw, "INSERT INTO public.audit_logs (tenant_id, action) VALUES ($1, 'tenant.created')", [tB], tA),
      INSUFFICIENT_PRIVILEGE,
      "tenant_id açık",
    );
    await expectCode(
      await attempt(appRaw, "INSERT INTO public.audit_logs (action, occurred_at) VALUES ('tenant.created', now() - interval '1 year')", [], tA),
      INSUFFICIENT_PRIVILEGE,
      "occurred_at açık",
    );
    await expectCode(await attempt(appRaw, "INSERT INTO public.audit_logs (action, created_xid) VALUES ('tenant.created', '1')", [], tA), INSUFFICIENT_PRIVILEGE, "created_xid açık");
    await expectCode(await attempt(appRaw, "INSERT INTO public.audit_logs (action, id) VALUES ('tenant.created', gen_random_uuid())", [], tA), INSUFFICIENT_PRIVILEGE, "id açık");
    // Bağlamsız ekleme: tenant_id NULL → NOT NULL ihlali (RLS/kısıt; satır oluşmaz).
    const noCtx = await attempt(appRaw, "INSERT INTO public.audit_logs (action) VALUES ('tenant.created')");
    expect(noCtx.ok).toBe(false);
  });

  it("wms_app: UPDATE, DELETE, TRUNCATE yetki hatası", async () => {
    await expectCode(await attempt(appRaw, "UPDATE public.audit_logs SET reason = 'x'", [], tA), INSUFFICIENT_PRIVILEGE, "UPDATE");
    await expectCode(await attempt(appRaw, "DELETE FROM public.audit_logs", [], tA), INSUFFICIENT_PRIVILEGE, "DELETE");
    await expectCode(await attempt(appRaw, "TRUNCATE public.audit_logs"), INSUFFICIENT_PRIVILEGE, "TRUNCATE");
  });

  it("wms_auth audit_logs ve request_rate_limits üzerinde yetkisiz", async () => {
    await expectCode(await attempt(authRaw, "SELECT 1 FROM public.audit_logs"), INSUFFICIENT_PRIVILEGE, "auth select audit");
    await expectCode(await attempt(authRaw, "INSERT INTO public.audit_logs (action) VALUES ('tenant.created')"), INSUFFICIENT_PRIVILEGE, "auth insert audit");
    await expectCode(await attempt(authRaw, "SELECT 1 FROM public.request_rate_limits"), INSUFFICIENT_PRIVILEGE, "auth select rl");
    await expectCode(
      await attempt(authRaw, "INSERT INTO public.request_rate_limits (scope, key_hash, window_start) VALUES ('s', repeat('a', 64), now())"),
      INSUFFICIENT_PRIVILEGE,
      "auth insert rl",
    );
  });

  it("migration rolü dahil UPDATE/DELETE/TRUNCATE tetikleyiciyle reddedilir (satır varken)", async () => {
    const marker = `imm-${randomBytes(4).toString("hex")}`;
    await withSystemTenant(app, tA, "t107.test", async (tx) => {
      await appendAudit(tx, { action: "tenant.created", entityId: marker });
    });
    await expectCode(await attempt(admRaw, "UPDATE public.audit_logs SET reason = 'x' WHERE entity_id = $1", [marker], tA), INSUFFICIENT_PRIVILEGE, "migration UPDATE");
    await expectCode(await attempt(admRaw, "DELETE FROM public.audit_logs WHERE entity_id = $1", [marker], tA), INSUFFICIENT_PRIVILEGE, "migration DELETE");
    await expectCode(await attempt(admRaw, "TRUNCATE public.audit_logs"), INSUFFICIENT_PRIVILEGE, "migration TRUNCATE");
    expect(await countAudit(tA, "entity_id = $1", [marker])).toBe(1);
  });

  it("katalog: RLS ENABLE+FORCE, (tenant_id,id) benzersiz, tenant_id NOT NULL, anahtar sırası indeksi, tetikleyiciler ENABLE ALWAYS", async () => {
    const cls = await admRaw.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.audit_logs'::regclass",
    );
    expect(cls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await admRaw.query<{ cmd: string; qual: string; with_check: string }>("SELECT cmd, qual, with_check FROM pg_policies WHERE tablename = 'audit_logs'");
    expect(pol.rows).toHaveLength(1);
    expect(pol.rows[0]?.cmd).toBe("ALL");
    expect(pol.rows[0]?.qual).toContain("app.current_tenant_id");
    expect(pol.rows[0]?.with_check).toContain("app.current_tenant_id");
    const uq = await admRaw.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.audit_logs'::regclass AND contype = 'u'");
    expect(uq.rows.map((r) => r.def)).toContain("UNIQUE (tenant_id, id)");
    const idx = await admRaw.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_logs' AND indexname = 'audit_logs_tenant_occurred_idx'");
    expect(idx.rows[0]?.indexdef).toContain("(tenant_id, occurred_at DESC, id)");
    const trg = await admRaw.query<{ tgname: string; tgenabled: string }>(
      "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND NOT tgisinternal ORDER BY 1",
    );
    expect(trg.rows).toEqual([
      { tgname: "audit_logs_no_truncate", tgenabled: "A" },
      { tgname: "audit_logs_no_update_delete", tgenabled: "A" },
      { tgname: "audit_logs_server_fields", tgenabled: "A" },
    ]);
  });
});

describe("request_rate_limits (platform tablosu)", () => {
  const hash = () => randomBytes(32).toString("hex");

  it("wms_app SELECT/INSERT/UPDATE/DELETE yapabilir; (scope, key_hash, window_start) birincil anahtar", async () => {
    const h = hash();
    await appRaw.query("BEGIN");
    try {
      await appRaw.query("INSERT INTO public.request_rate_limits (scope, key_hash, window_start, count) VALUES ('login', $1, '2026-01-01T00:00:00Z', 1)", [h]);
      await appRaw.query("UPDATE public.request_rate_limits SET count = count + 1 WHERE scope = 'login' AND key_hash = $1", [h]);
      const r = await appRaw.query<{ count: number }>("SELECT count FROM public.request_rate_limits WHERE key_hash = $1", [h]);
      expect(r.rows[0]?.count).toBe(2);
      await appRaw.query("SAVEPOINT s");
      await expect(
        appRaw.query("INSERT INTO public.request_rate_limits (scope, key_hash, window_start) VALUES ('login', $1, '2026-01-01T00:00:00Z')", [h]),
      ).rejects.toMatchObject({ code: "23505" });
      await appRaw.query("ROLLBACK TO SAVEPOINT s");
      await appRaw.query("INSERT INTO public.request_rate_limits (scope, key_hash, window_start) VALUES ('login', $1, '2026-01-01T00:01:00Z')", [h]);
      await appRaw.query("DELETE FROM public.request_rate_limits WHERE key_hash = $1", [h]);
    } finally {
      await appRaw.query("ROLLBACK");
    }
  });

  it("düz IP/kimlik anahtarı (SHA-256 olmayan) CHECK ile reddedilir; TRUNCATE yetkisiz", async () => {
    for (const bad of ["203.0.113.5", "user@example.test", "A".repeat(64), "a".repeat(63)]) {
      const r = await attempt(appRaw, "INSERT INTO public.request_rate_limits (scope, key_hash, window_start) VALUES ('login', $1, now())", [bad]);
      await expectCode(r, CHECK_VIOLATION, `key_hash ${bad}`);
    }
    await expectCode(await attempt(appRaw, "TRUNCATE public.request_rate_limits"), INSUFFICIENT_PRIVILEGE, "TRUNCATE");
    for (const scope of ["", "Login", "1login", "a b", "a".repeat(65)]) {
      const r = await attempt(appRaw, "INSERT INTO public.request_rate_limits (scope, key_hash, window_start) VALUES ($1, repeat('c', 64), now())", [scope]);
      await expectCode(r, CHECK_VIOLATION, `scope ${JSON.stringify(scope)}`);
    }
    const okScope = await attempt(appRaw, "INSERT INTO public.request_rate_limits (scope, key_hash, window_start) VALUES ('auth.login:ip-1', repeat('c', 64), now())");
    expect(okScope.ok).toBe(true);
    await expectCode(
      await attempt(appRaw, "INSERT INTO public.request_rate_limits (scope, key_hash, window_start, count) VALUES ('login', repeat('b', 64), now(), -1)"),
      CHECK_VIOLATION,
      "negatif sayaç",
    );
  });
});

describe("recordSecurityEvent (kendi transaction'ı, tenant bağlamsız)", () => {
  async function eventRow(id: string) {
    const r = await admRaw.query<{ ip: string | null; user_agent: string | null; detail: Record<string, unknown>; event_type: string; user_id: string | null }>(
      "SELECT ip, user_agent, detail, event_type, user_id FROM public.security_events WHERE id = $1",
      [id],
    );
    return r.rows[0];
  }

  it("olay yazılır, detail maskelenir; ip/user_agent bayrak yokken kalır", async () => {
    const userId = randomUUID();
    const id = await recordSecurityEvent(app, {
      eventType: "app.check_failed",
      userId,
      ip: "203.0.113.20",
      userAgent: "UA-sec",
      detail: { reason: "bad_password", password: "sentinel-pw", otpCode: "000000" },
    });
    expect(await eventRow(id)).toEqual({
      ip: "203.0.113.20",
      user_agent: "UA-sec",
      detail: { reason: "bad_password", password: "[REDACTED]", otpCode: "[REDACTED]" },
      event_type: "app.check_failed",
      user_id: userId,
    });
  });

  it("suppressNetworkMeta=true → ip ve user_agent NULL (demo kullanıcıları)", async () => {
    const id = await recordSecurityEvent(app, { eventType: "app.check_demo", ip: "203.0.113.21", userAgent: "UA-demo", suppressNetworkMeta: true });
    expect(await eventRow(id)).toMatchObject({ ip: null, user_agent: null });
  });

  it("geçersiz olay türü ve boyut aşımı VALIDATION_FAILED", async () => {
    await expect(recordSecurityEvent(app, { eventType: "Bad Type" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(recordSecurityEvent(app, { eventType: "x", detail: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, "a".repeat(1000)])) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe(`0004_audit ileri/geri/ileri (target=${env.target})`, () => {
  const scratch: string[] = [];
  // 0001..0004 geçici kopyası (T-112c): sonraki migration'lar (0005+) bu testin "applied/reverted" beklentilerini değiştirmesin.
  let thru4Dir: string | undefined;
  const thru4 = (): string => {
    if (thru4Dir === undefined) {
      thru4Dir = mkdtempSync(path.join(tmpdir(), "wms-audit-migrations-"));
      cpSync(MIGRATIONS_DIR, thru4Dir, {
        recursive: true,
        filter: (src) => !/[\\/]\d{4}_/.test(src) || (/[\\/](\d{4})_[^\\/]*$/.exec(src)?.[1] ?? "9999") <= "0004",
      });
    }
    return thru4Dir;
  };
  afterAll(async () => {
    if (thru4Dir !== undefined) rmSync(thru4Dir, { recursive: true, force: true });
    const c = await connect(env.databaseUrlDirect);
    try {
      for (const name of scratch) await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  }, 60_000);

  async function freshUrl(): Promise<string> {
    const name = `wms_audit_${randomBytes(5).toString("hex")}`;
    const c = await connect(env.databaseUrlDirect);
    try {
      await c.query(`CREATE DATABASE ${name}`);
      scratch.push(name);
    } finally {
      await c.end();
    }
    const u = new URL(env.databaseUrlDirect);
    u.pathname = `/${name}`;
    return u.toString();
  }

  async function tables(url: string): Promise<string[]> {
    const c = await connect(url);
    try {
      const r = await c.query<{ n: string }>(
        `SELECT relname AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('audit_logs', 'request_rate_limits') ORDER BY 1`,
      );
      return r.rows.map((x) => x.n);
    } finally {
      await c.end();
    }
  }

  it("geri alma audit tablolarini ve islevleri kaldirir; yeniden ileri basarili", async () => {
    const url = await freshUrl();
    expect((await migrateUp({ url, dir: thru4() })).applied).toContain("0004");
    expect(await tables(url)).toEqual(["audit_logs", "request_rate_limits"]);
    expect((await migrateDown({ url, dir: thru4(), to: "0003", wmsEnv: "ci" })).reverted).toEqual(["0004"]);
    expect(await tables(url)).toEqual([]);
    const c = await connect(url);
    try {
      const f = await c.query(`SELECT 1 FROM pg_proc WHERE proname LIKE 'audit_logs_%' AND pronamespace = 'public'::regnamespace`);
      expect(f.rows).toEqual([]);
    } finally {
      await c.end();
    }
    expect((await migrateUp({ url, dir: thru4() })).applied).toEqual(["0004"]);
    expect(await tables(url)).toEqual(["audit_logs", "request_rate_limits"]);
  });

  it("MINOR-4: tenant satiri gorunmezse (kisitlayici politika) tetikleyici fail-closed ip/user_agent'i NULL yazar; gorunurken yazar", async () => {
    const url = await freshUrl();
    await migrateUp({ url, dir: thru4() });
    const tenantId = randomUUID();
    const c = await connect(url);
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'T107 vis')", [tenantId, `t107-${randomBytes(4).toString("hex")}`]);
      await c.query("COMMIT");

      const run = async (hide: boolean): Promise<{ ip: string | null; user_agent: string | null }> => {
        await c.query("BEGIN");
        try {
          if (hide) await c.query("CREATE POLICY t107_hide ON public.tenants AS RESTRICTIVE FOR SELECT TO wms_app USING (false)");
          await c.query("SET LOCAL ROLE wms_app");
          await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          const seen = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.tenants");
          expect(seen.rows[0]?.n, "tenant gorunurlugu").toBe(hide ? "0" : "1");
          const r = await c.query<{ ip: string | null; user_agent: string | null }>(
            "INSERT INTO public.audit_logs (action, ip, user_agent) VALUES ('tenant.created', '203.0.113.9', 'UA') RETURNING ip, user_agent",
          );
          return r.rows[0] as { ip: string | null; user_agent: string | null };
        } finally {
          await c.query("ROLLBACK");
        }
      };
      expect(await run(true)).toEqual({ ip: null, user_agent: null });
      expect(await run(false)).toEqual({ ip: "203.0.113.9", user_agent: "UA" });
    } finally {
      await c.end();
    }
  });

  it("audit satiri varken staging geri alma RAISE eder ve veri korunur; ci bayragiyla calisir", async () => {
    const url = await freshUrl();
    await migrateUp({ url, dir: thru4() });
    const tenantId = randomUUID();
    const c = await connect(url);
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'T107 down')", [tenantId, `t107-${randomBytes(4).toString("hex")}`]);
      await c.query("INSERT INTO public.audit_logs (action) VALUES ('tenant.created')");
      await c.query("COMMIT");
    } finally {
      await c.end();
    }
    await expect(migrateDown({ url, dir: thru4(), to: "0003", wmsEnv: "staging" })).rejects.toThrow(/0004_audit down:.*satır var/);
    expect(await tables(url)).toEqual(["audit_logs", "request_rate_limits"]);
    const k = await connect(url);
    try {
      const f = await k.query<{ relforcerowsecurity: boolean }>("SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.audit_logs'::regclass");
      expect(f.rows[0]?.relforcerowsecurity).toBe(true);
    } finally {
      await k.end();
    }
    expect((await migrateDown({ url, dir: thru4(), to: "0003", wmsEnv: "ci" })).reverted).toEqual(["0004"]);
    expect(await tables(url)).toEqual([]);
  });
});
