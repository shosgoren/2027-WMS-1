// T-108 — bağımsız doğrulama (qa-verifier): audit_logs / security_events değiştirilemezliği, tenant izolasyonu ve sır maskeleme.
// I-12: "işlenmiş audit uygulama kullanıcısınca değiştirilemez; sır/parola loglanmaz". ADR-016 §7.
//
// Uygulama tarafı YALNIZCA DATABASE_URL (wms_app, pooler) ve AUTH_DATABASE_URL (wms_auth) ile sınanır. Migration rolü
// (DATABASE_URL_DIRECT) yalnızca fikstür kurulumu, tetikleyici denemesi ve ham veri okuma içindir. Her deneme kendi
// transaction'ında çalışır ve DAİMA ROLLBACK edilir. audit_logs satırı silinemediği için fikstür tenant'ları temizlenmez
// (tek kullanımlık Testcontainers; rastgele slug/UUID, sentetik veri, G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAudit, createDbClient, recordSecurityEvent, withSystemTenant } from "../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../packages/db/src/client.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "./harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];
const INSUFFICIENT_PRIVILEGE = "42501";

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

type Attempt = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string | undefined; message: string };

async function attempt(c: pg.Client, text: string, params: unknown[] = [], tenantId?: string): Promise<Attempt> {
  await c.query("BEGIN");
  try {
    if (tenantId !== undefined) await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const r = await c.query(text, params);
    return { ok: true, rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await c.query("ROLLBACK");
  }
}

function describeAttempt(r: Attempt): string {
  return r.ok ? `ok rows=${r.rowCount}` : `error ${r.code ?? "?"}: ${r.message}`;
}

function expectDenied(r: Attempt, what: string, messagePart?: RegExp): void {
  expect(r.ok, `${what}: hata bekleniyordu, gelen ${describeAttempt(r)}`).toBe(false);
  if (!r.ok) {
    expect(r.code, `${what}: ${r.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    if (messagePart !== undefined) expect(r.message, what).toMatch(messagePart);
  }
}

let app: DbClient;
let appRaw: pg.Client;
let authRaw: pg.Client;
let adm: pg.Client;
let tA: string;
let tB: string;
let tDemo: string;

async function mkTenant(isDemo = false): Promise<string> {
  const id = randomUUID();
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T108 Tenant', $3)", [
    id,
    `t108-${randomBytes(6).toString("hex")}`,
    isDemo,
  ]);
  return id;
}

/** Migration rolüyle tenant bağlamında ham satır(lar) (FORCE RLS sahibi için de geçerli). */
async function rowsAs(tenantId: string, where: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await attempt(adm, `SELECT * FROM public.audit_logs WHERE ${where}`, params, tenantId);
  if (!r.ok) throw new Error(`rowsAs: ${describeAttempt(r)}`);
  return r.rows;
}

const marker = (p: string): string => `${p}-${randomBytes(5).toString("hex")}`;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  appRaw = await connect(env.databaseUrl);
  authRaw = await connect(authUrl);
  adm = await connect(env.databaseUrlDirect);
  tA = await mkTenant();
  tB = await mkTenant();
  tDemo = await mkTenant(true);
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all(open.map((c) => c.end().catch(() => undefined)));
}, 60_000);

describe(`T-108 madde 1 — değiştirilemezlik (target=${env.target})`, () => {
  let seededAudit: string;
  let seededEvent: string;

  beforeAll(async () => {
    seededAudit = marker("imm");
    await withSystemTenant(app, tA, "t108.seed", async (tx) => {
      await appendAudit(tx, { action: "tenant.created", entityId: seededAudit, reason: "orijinal" });
    });
    const ev = await appRaw.query<{ id: string }>("INSERT INTO public.security_events (event_type) VALUES ('t108.seed') RETURNING id");
    seededEvent = (ev.rows[0] as { id: string }).id;
  });

  it("wms_app: audit_logs UPDATE, DELETE, TRUNCATE yetki hatası (42501); satır değişmez", async () => {
    expectDenied(await attempt(appRaw, "UPDATE public.audit_logs SET reason = 'x' WHERE entity_id = $1", [seededAudit], tA), "UPDATE reason", /permission denied/i);
    expectDenied(await attempt(appRaw, "UPDATE public.audit_logs SET change_summary = '{}'::jsonb WHERE entity_id = $1", [seededAudit], tA), "UPDATE change_summary");
    expectDenied(await attempt(appRaw, "UPDATE public.audit_logs SET action = 'a.b' WHERE entity_id = $1", [seededAudit], tA), "UPDATE action");
    expectDenied(await attempt(appRaw, "DELETE FROM public.audit_logs WHERE entity_id = $1", [seededAudit], tA), "DELETE", /permission denied/i);
    expectDenied(await attempt(appRaw, "TRUNCATE public.audit_logs"), "TRUNCATE", /permission denied/i);
    const rows = await rowsAs(tA, "entity_id = $1", [seededAudit]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "orijinal", action: "tenant.created" });
  });

  it("wms_app: security_events UPDATE, DELETE, TRUNCATE yetki hatası (42501); satır değişmez", async () => {
    expectDenied(await attempt(appRaw, "UPDATE public.security_events SET event_type = 'x' WHERE id = $1", [seededEvent]), "UPDATE", /permission denied/i);
    expectDenied(await attempt(appRaw, "DELETE FROM public.security_events WHERE id = $1", [seededEvent]), "DELETE", /permission denied/i);
    expectDenied(await attempt(appRaw, "TRUNCATE public.security_events"), "TRUNCATE", /permission denied/i);
    const r = await attempt(adm, "SELECT event_type FROM public.security_events WHERE id = $1", [seededEvent]);
    expect(r.ok && r.rows[0]).toMatchObject({ event_type: "t108.seed" });
  });

  it("migration rolü: audit_logs UPDATE/DELETE/TRUNCATE tetikleyici hatası (42501, 'append-only'); satır varken", async () => {
    expectDenied(await attempt(adm, "UPDATE public.audit_logs SET reason = 'x' WHERE entity_id = $1", [seededAudit], tA), "migration UPDATE", /append-only/);
    expectDenied(await attempt(adm, "DELETE FROM public.audit_logs WHERE entity_id = $1", [seededAudit], tA), "migration DELETE", /append-only/);
    expectDenied(await attempt(adm, "TRUNCATE public.audit_logs"), "migration TRUNCATE", /append-only/);
    expect(await rowsAs(tA, "entity_id = $1", [seededAudit])).toHaveLength(1);
  });

  it("migration rolü: security_events UPDATE/DELETE/TRUNCATE tetikleyici hatası (42501, 'append-only')", async () => {
    expectDenied(await attempt(adm, "UPDATE public.security_events SET event_type = 'x' WHERE id = $1", [seededEvent]), "migration UPDATE", /append-only/);
    expectDenied(await attempt(adm, "DELETE FROM public.security_events WHERE id = $1", [seededEvent]), "migration DELETE", /append-only/);
    expectDenied(await attempt(adm, "TRUNCATE public.security_events"), "migration TRUNCATE", /append-only/);
  });

  it("migration rolü session_replication_role=replica ile de tetikleyiciyi atlatamaz (ENABLE ALWAYS) — yetki yoksa 42501 de kabul", async () => {
    // Süper kullanıcı olmayan migration rolü (Neon) bu GUC'yi ayarlayamaz (42501); süper kullanıcı ayarlar ama tetikleyici ALWAYS'tir.
    for (const [stmt, params, tenant] of [
      ["UPDATE public.audit_logs SET reason = 'x' WHERE entity_id = $1", [seededAudit], tA],
      ["DELETE FROM public.audit_logs WHERE entity_id = $1", [seededAudit], tA],
    ] as const) {
      await adm.query("BEGIN");
      try {
        let setOk = true;
        try {
          await adm.query("SET LOCAL session_replication_role = replica");
        } catch (e) {
          setOk = false;
          expect((e as { code?: string }).code).toBe(INSUFFICIENT_PRIVILEGE);
          await adm.query("ROLLBACK");
          await adm.query("BEGIN");
        }
        await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
        let code: string | undefined;
        try {
          await adm.query(stmt, [...params]);
        } catch (e) {
          code = (e as { code?: string }).code;
        }
        expect(code, `session_replication_role=replica (ayarlandı=${setOk}) altında '${stmt}' reddedilmeli`).toBe(INSUFFICIENT_PRIVILEGE);
      } finally {
        await adm.query("ROLLBACK");
      }
    }
    expect(await rowsAs(tA, "entity_id = $1", [seededAudit])).toHaveLength(1);
  });

  it("wms_auth: audit_logs'a hiçbir erişim; wms_app UPDATE/DELETE sütun yetkisi katalogda yok", async () => {
    expectDenied(await attempt(authRaw, "SELECT 1 FROM public.audit_logs"), "auth SELECT");
    expectDenied(await attempt(authRaw, "INSERT INTO public.audit_logs (action) VALUES ('tenant.created')"), "auth INSERT");
    expectDenied(await attempt(authRaw, "UPDATE public.audit_logs SET reason = 'x'"), "auth UPDATE");
    expectDenied(await attempt(authRaw, "DELETE FROM public.audit_logs"), "auth DELETE");
    const r = await attempt(
      adm,
      `SELECT has_any_column_privilege('wms_app', 'public.audit_logs', 'UPDATE') AS app_upd,
              has_table_privilege('wms_app', 'public.audit_logs', 'DELETE, TRUNCATE, TRIGGER, REFERENCES') AS app_other,
              has_table_privilege('wms_app', 'public.security_events', 'UPDATE, DELETE, TRUNCATE, TRIGGER') AS app_se,
              has_any_column_privilege('wms_app', 'public.security_events', 'UPDATE') AS app_se_upd`,
    );
    expect(r.ok && r.rows[0]).toEqual({ app_upd: false, app_other: false, app_se: false, app_se_upd: false });
  });
});

describe("T-108 madde 2 — tenant izolasyonu", () => {
  it("@AC-04 A bağlamında appendAudit: satır tenant_id = A (sunucu varsayılanı); B bağlamı/bağlamsız görmez", async () => {
    const m = marker("iso");
    const r = await withSystemTenant(app, tA, "t108.iso", async (tx) => appendAudit(tx, { action: "tenant.created", entityId: m, reason: "a" }));
    const rows = await rowsAs(tA, "id = $1", [r.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: tA, entity_id: m });
    // B bağlamı (wms_app) A'nın satırını görmez; aynı filtre A bağlamında görür (kontrol).
    const q = "SELECT count(*)::int AS n FROM public.audit_logs WHERE entity_id = $1";
    const asB = await attempt(appRaw, q, [m], tB);
    expect(asB.ok && asB.rows[0]).toEqual({ n: 0 });
    const asA = await attempt(appRaw, q, [m], tA);
    expect(asA.ok && asA.rows[0]).toEqual({ n: 1 });
    const none = await attempt(appRaw, q, [m]);
    expect(none.ok && none.rows[0]).toEqual({ n: 0 });
    // B bağlamında toplam görünürlük yalnızca B'ye ait satırlardır (id ile de bulunamaz).
    const byId = await attempt(appRaw, "SELECT count(*)::int AS n FROM public.audit_logs WHERE id = $1 OR tenant_id = $2", [r.id, tA], tB);
    expect(byId.ok && byId.rows[0]).toEqual({ n: 0 });
    const foreignTotal = await attempt(appRaw, "SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id <> $1", [tB], tB);
    expect(foreignTotal.ok && foreignTotal.rows[0]).toEqual({ n: 0 });
  });

  it("@AC-04 elle B tenant_id'li INSERT (A bağlamı) reddedilir: sütun yetkisi 42501; RLS WITH CHECK yolu ayrıca doğrulanır", async () => {
    const m = marker("xt");
    expectDenied(
      await attempt(appRaw, "INSERT INTO public.audit_logs (tenant_id, action, entity_id) VALUES ($1, 'tenant.created', $2)", [tB, m], tA),
      "tenant_id=B açık INSERT (A bağlamı)",
      /permission denied/i,
    );
    expectDenied(
      await attempt(appRaw, "INSERT INTO public.audit_logs (tenant_id, action, entity_id) VALUES ($1, 'tenant.created', $2)", [tA, m], tA),
      "tenant_id=A açık INSERT (A bağlamı) da sütun yetkisi gerektirir",
      /permission denied/i,
    );
    // Bağlamsız INSERT: tenant_id NULL → NOT NULL ya da RLS ihlali; satır oluşmaz.
    const noCtx = await attempt(appRaw, "INSERT INTO public.audit_logs (action, entity_id) VALUES ('tenant.created', $1)", [m]);
    expect(noCtx.ok, `bağlamsız INSERT: ${describeAttempt(noCtx)}`).toBe(false);
    // RLS WITH CHECK katmanı (yetkiden bağımsız ikinci savunma): süper kullanıcı migration rolü RLS'i aşar (yerel), bu yüzden
    // davranış yerine katalog: politika var, USING + WITH CHECK ikisi de tenant bağlamına bağlı, FORCE RLS açık.
    const pol = await attempt(
      adm,
      `SELECT p.polcmd::text AS cmd, pg_get_expr(p.polqual, p.polrelid) AS using_expr, pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr,
              c.relrowsecurity AS en, c.relforcerowsecurity AS fo
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.polrelid = 'public.audit_logs'::regclass`,
    );
    expect(pol.ok && pol.rows.length).toBe(1);
    if (pol.ok) {
      const row = pol.rows[0] as { cmd: string; using_expr: string; check_expr: string | null; en: boolean; fo: boolean };
      expect(row).toMatchObject({ cmd: "*", en: true, fo: true });
      expect(row.check_expr, "WITH CHECK ifadesi tenant bağlamına bağlı olmalı").toMatch(/app\.current_tenant_id/);
      expect(row.using_expr).toMatch(/app\.current_tenant_id/);
    }
    expect(await rowsAs(tB, "entity_id = $1", [m])).toHaveLength(0);
    expect(await rowsAs(tA, "entity_id = $1", [m])).toHaveLength(0);
  });

  it("@AC-04 demo olmayan tenant: ip/user_agent saklanır; demo tenant: ip ve user_agent NULL (M9)", async () => {
    const m1 = marker("demo");
    const m2 = marker("real");
    await withSystemTenant(app, tDemo, "t108.demo", async (tx) => {
      await appendAudit(tx, { action: "tenant.created", entityId: m1, ip: "203.0.113.31", userAgent: "UA-demo" });
    });
    await withSystemTenant(app, tB, "t108.real", async (tx) => {
      await appendAudit(tx, { action: "tenant.created", entityId: m2, ip: "203.0.113.32", userAgent: "UA-real" });
    });
    expect((await rowsAs(tDemo, "entity_id = $1", [m1]))[0]).toMatchObject({ ip: null, user_agent: null });
    expect((await rowsAs(tB, "entity_id = $1", [m2]))[0]).toMatchObject({ ip: "203.0.113.32", user_agent: "UA-real" });
  });

  it("@AC-04 istemci occurred_at/created_xid/id veremez; sunucu değerleri yazılır", async () => {
    expectDenied(await attempt(appRaw, "INSERT INTO public.audit_logs (action, occurred_at) VALUES ('tenant.created', now() - interval '1 year')", [], tA), "occurred_at");
    expectDenied(await attempt(appRaw, "INSERT INTO public.audit_logs (action, created_xid) VALUES ('tenant.created', '1')", [], tA), "created_xid");
    expectDenied(await attempt(appRaw, "INSERT INTO public.audit_logs (action, id) VALUES ('tenant.created', gen_random_uuid())", [], tA), "id");
    const m = marker("srv");
    const r = await withSystemTenant(app, tA, "t108.srv", async (tx) => appendAudit(tx, { action: "tenant.created", entityId: m }));
    const row = (await rowsAs(tA, "id = $1", [r.id]))[0] as { created_xid: string; occurred_at: Date };
    expect(String(row.created_xid)).toBe(r.createdXid);
    expect(Math.abs(Date.now() - new Date(row.occurred_at).getTime())).toBeLessThan(60_000);
  });
});

describe("T-108 madde 3 — sır maskeleme (veritabanında ham değer yok)", () => {
  it("password, Token, nested.secret, totpCode → '[REDACTED]'; ham değer tablonun hiçbir sütununda yok", async () => {
    const m = marker("mask");
    const s = (n: string): string => `SENTINEL-${n}-${randomBytes(6).toString("hex")}`;
    const sentinels = { pw: s("pw"), tok: s("tok"), nested: s("nested"), totp: s("totp"), bearer: s("bearer"), arr: s("arr") };
    const r = await withSystemTenant(app, tA, "t108.mask", async (tx) =>
      appendAudit(tx, {
        action: "tenant.settings_changed",
        entityId: m,
        changeSummary: {
          field: "ok-visible",
          password: sentinels.pw,
          Token: sentinels.tok,
          nested: { secret: sentinels.nested, keep: "kept-visible" },
          totpCode: sentinels.totp,
          note: `Bearer ${sentinels.bearer}`,
          list: [{ name: "Authorization", value: sentinels.arr }],
        },
      }),
    );
    const row = (await rowsAs(tA, "id = $1", [r.id]))[0] as { change_summary: Record<string, unknown> };
    const cs = row.change_summary;
    expect(cs.field).toBe("ok-visible");
    expect(cs.password).toBe("[REDACTED]");
    expect(cs.Token).toBe("[REDACTED]");
    expect((cs.nested as Record<string, unknown>).secret).toBe("[REDACTED]");
    expect((cs.nested as Record<string, unknown>).keep).toBe("kept-visible");
    expect(cs.totpCode).toBe("[REDACTED]");
    expect(cs.note).toBe("[REDACTED]");
    // Ham değer taraması: satırın tamamı ve tablonun bu tenant'taki tüm satırları (tüm sütunlar, metin gösterimi).
    for (const [name, value] of Object.entries(sentinels)) {
      const hit = await attempt(adm, "SELECT count(*)::int AS n FROM public.audit_logs a WHERE a::text LIKE $1", [`%${value}%`], tA);
      expect(hit.ok && hit.rows[0], `ham değer (${name}) audit_logs satırında bulundu`).toEqual({ n: 0 });
      const hitSeq = await attempt(adm, "SELECT count(*)::int AS n FROM public.audit_logs WHERE change_summary::text LIKE $1", [`%${value}%`], tA);
      expect(hitSeq.ok && hitSeq.rows[0]).toEqual({ n: 0 });
    }
  });

  it("ham değer başka sütuna (reason/entity_id hariç) sızmaz: maskelenen alanlar için yalnızca change_summary taşır", async () => {
    const m = marker("mask2");
    const secret = `SENTINEL-X-${randomBytes(6).toString("hex")}`;
    const r = await withSystemTenant(app, tA, "t108.mask2", async (tx) =>
      appendAudit(tx, { action: "tenant.settings_changed", entityId: m, changeSummary: { apiKey: secret, cookie: secret, nested: { deep: { clientSecret: secret } } } }),
    );
    const row = (await rowsAs(tA, "id = $1", [r.id]))[0] as { change_summary: Record<string, unknown> };
    expect(JSON.stringify(row.change_summary)).not.toContain(secret);
    expect(row.change_summary.apiKey).toBe("[REDACTED]");
    expect(row.change_summary.cookie).toBe("[REDACTED]");
    expect(((row.change_summary.nested as { deep: Record<string, unknown> }).deep).clientSecret).toBe("[REDACTED]");
  });

  it("security_events.detail da maskelenir (recordSecurityEvent yolu): ham değer yok", async () => {
    const secret = `SENTINEL-SE-${randomBytes(6).toString("hex")}`;
    const id = await recordSecurityEvent(app, { eventType: "t108.mask", detail: { password: secret, nested: { token: secret } } });
    const r = await attempt(adm, "SELECT detail, (se::text LIKE $2) AS leaked FROM public.security_events se WHERE id = $1", [id, `%${secret}%`]);
    expect(r.ok && r.rows[0]).toEqual({ detail: { password: "[REDACTED]", nested: { token: "[REDACTED]" } }, leaked: false });
  });
});
