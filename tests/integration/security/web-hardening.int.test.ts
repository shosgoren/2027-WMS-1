// T-127: web sertleştirme entegrasyonu. Gerçek wms_app bağlantısı + gerçek `request_rate_limits` tablosu (çok bağlantı
// = çok süreç benzetimi). Fikstürler sentetik (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createDbClient, type DbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS } from "../../../packages/db/src/client.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionGuard, createProductionGuard, limitVerifiedTenant, type GuardDeps } from "../../../apps/web/lib/action-guard.ts";
import { createDbRateLimitStore, createRateLimiter, deriveKey, hashKey } from "../../../apps/web/lib/rate-limit.ts";
import { JOB_PAYLOAD_SCHEMAS } from "../../../packages/shared/src/queue.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const APP = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const RUN = randomBytes(6).toString("hex");
let a: DbClient;
let b: DbClient;
let adm: pg.Client;
const ENV_KEYS = ["DATABASE_URL", "AUTH_DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const APP_DB_KEY = Symbol.for("@wms/db/app-db");

beforeAll(async () => {
  const opts = { url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare };
  a = createDbClient(opts);
  b = createDbClient(opts); // ikinci havuz = ikinci süreç benzetimi
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
});
afterAll(async () => {
  // Süreç ortamını ve `getAppDb` havuzunu geri al (MINOR-9).
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const g = globalThis as { [APP_DB_KEY]?: DbClient };
  if (g[APP_DB_KEY] !== undefined) {
    await g[APP_DB_KEY].close().catch(() => undefined);
    delete g[APP_DB_KEY];
  }
  await Promise.all([a.close(), b.close(), adm.end()].map((p) => p.catch(() => undefined)));
});

function guardDeps(headers: Record<string, string>, limiter = createRateLimiter({ store: createDbRateLimitStore(a), secret: SECRET })): GuardDeps {
  return {
    getHeaders: () => Promise.resolve(new Headers(headers)),
    resolvePrincipal: () => Promise.resolve({ userId: `user-${RUN}`, mfaVerified: true }),
    appUrl: APP,
    log: () => undefined,
    newRequestId: () => "req-int",
    limiter,
  };
}
// Şema yalnızca biçim taşıyıcı: `invitationId` alanı tenant sayaç anahtarı olarak kullanılır (gerçek eylem şeması gerekmez).
const schema = JOB_PAYLOAD_SCHEMAS["invitation.deliver"];
const id = (n: number): string => `00000000-0000-4000-8000-${RUN.padStart(12, "0")}`.slice(0, 33) + String(n).padStart(3, "0").slice(-3);
const action = (d: GuardDeps) => createActionGuard(d)({ schema }, () => Promise.resolve("ok"));
/** Sayaç satırı sayısı (anahtar özeti = HMAC(HKDF(SECRET))). */
async function counterOf(scope: string, subject: string): Promise<number> {
  const r = await adm.query<{ c: number | null }>(
    "SELECT sum(count)::int AS c FROM public.request_rate_limits WHERE scope = $1 AND key_hash = $2",
    [scope, hashKey(deriveKey(SECRET), scope, subject)],
  );
  return r.rows[0]?.c ?? 0;
}
const uniqueIp = (n: number): string => `192.0.2.${((parseInt(RUN.slice(0, 2), 16) + n) % 250) + 1}`;
async function mkUser(): Promise<string> {
  const r = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T127 fixture', $1, true) RETURNING id", [
    `t127-${randomBytes(6).toString("hex")}@example.test`,
  ]);
  return (r.rows[0] as { id: string }).id;
}
async function mkTenantWithAdmin(): Promise<{ tenantId: string; slug: string; admin: string }> {
  const tenantId = randomUUID();
  const slug = `t127-${randomBytes(6).toString("hex")}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T127', false)", [tenantId, slug]);
  const admin = await mkUser();
  const m = await adm.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false) RETURNING id", [tenantId, admin]);
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'TENANT_ADMIN')", [tenantId, (m.rows[0] as { id: string }).id]);
  return { tenantId, slug, admin };
}

describe("web hardening (AC)", () => {
  it("eşik + 1 -> RATE_LIMITED; sayaç iki bağlantı arasında paylaşılır", async () => {
    const l1 = createRateLimiter({ store: createDbRateLimitStore(a), secret: SECRET, limits: { tenant: 3 } });
    const l2 = createRateLimiter({ store: createDbRateLimitStore(b), secret: SECRET, limits: { tenant: 3 } });
    const k = `tenant-share-${RUN}`;
    await l1.check("tenant", k);
    await l2.check("tenant", k);
    await l1.check("tenant", k);
    await expect(l2.check("tenant", k)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("paralel istekler tek ifadeli UPSERT ile kaybolmadan sayılır", async () => {
    const store = createDbRateLimitStore(a);
    const o = { limit: 10, windowSeconds: 60, now: new Date() };
    const key = hashKey(deriveKey(SECRET), "web.ip", `par-${RUN}`);
    const hits = await Promise.all([store.hit("web.ip", key, o), createDbRateLimitStore(b).hit("web.ip", key, o)]);
    expect(hits.map((h) => h.count).sort()).toEqual([1, 2]);
  });

  it("farklı tenant sayaçları bağımsız (ctx.limitTenant, doğrulanmış kimlik)", async () => {
    const lim = createRateLimiter({ store: createDbRateLimitStore(a), secret: SECRET, limits: { tenant: 1 } });
    const g = createActionGuard(guardDeps({ origin: APP, "fly-client-ip": uniqueIp(1) }, lim))({ schema }, (i, ctx) => ctx.limitTenant(i.invitationId).then(() => "ok"));
    expect(await g({ invitationId: id(1) })).toMatchObject({ ok: true });
    expect(await g({ invitationId: id(2) })).toMatchObject({ ok: true });
    expect(await g({ invitationId: id(1) })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(await g({ invitationId: id(2) })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
  });

  it("MAJOR-1: üye olmayan 601 istek kurban tenant kovasını tüketmez; kurban üyesinin eylemi geçer", async () => {
    const victim = await mkTenantWithAdmin();
    const attacker = await mkUser();
    const lim = createRateLimiter({ store: createDbRateLimitStore(a), secret: SECRET });
    const ctx = { limitTenant: (t: string) => lim.check("tenant", t) };
    const access = (userId: string) => ({ db: a, principal: { userId, mfaVerified: true }, tenantSlug: victim.slug, permission: "users.manage" as const });
    for (let i = 0; i < 601; i++) await expect(limitVerifiedTenant(access(attacker), ctx)).rejects.toMatchObject({ name: "AppError" });
    expect(await counterOf("web.tenant", victim.tenantId)).toBe(0);
    await expect(limitVerifiedTenant(access(victim.admin), ctx)).resolves.toBeUndefined();
    expect(await counterOf("web.tenant", victim.tenantId)).toBe(1);
    // İstemci slug'ı sayaç anahtarı değildir.
    expect(await counterOf("web.tenant", victim.slug)).toBe(0);
  }, 120_000);

  it("yabancı Origin ve Origin'siz eylem -> FORBIDDEN; hiçbir sayaç tüketilmez", async () => {
    const ip = uniqueIp(2);
    const userBase = await counterOf("web.user", `user-${RUN}`);
    expect(await action(guardDeps({ origin: "https://evil.example", "fly-client-ip": ip }))({ invitationId: id(3) })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await action(guardDeps({ "fly-client-ip": ip }))({ invitationId: id(3) })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await counterOf("web.ip", ip)).toBe(0);
    expect(await counterOf("web.user", `user-${RUN}`)).toBe(userBase);
    // Kontrol: geçerli istek sayacı artırır (assertion anlamlı).
    expect(await action(guardDeps({ origin: APP, "fly-client-ip": ip }))({ invitationId: id(3) })).toMatchObject({ ok: true });
    expect(await counterOf("web.ip", ip)).toBe(1);
  });

  it("sahte X-Forwarded-For ile IP sınırı aşılmaz (aynı Fly-Client-IP aynı sayaç)", async () => {
    const lim = createRateLimiter({ store: createDbRateLimitStore(a), secret: SECRET, limits: { ip: 2, user: 1000 } });
    const ip = uniqueIp(3);
    const mk = (xff: string) => action(guardDeps({ origin: APP, "fly-client-ip": ip, "x-forwarded-for": xff }, lim));
    expect(await mk("1.1.1.1")({ invitationId: id(4) })).toMatchObject({ ok: true });
    expect(await mk("2.2.2.2")({ invitationId: id(4) })).toMatchObject({ ok: true });
    expect(await mk("3.3.3.3")({ invitationId: id(4) })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
  });

  it("anahtar yalnızca HMAC özeti: tabloda ham IP/kullanıcı yok", async () => {
    const r = await adm.query<{ n: string }>("SELECT count(*)::text AS n FROM public.request_rate_limits WHERE key_hash LIKE '%.%' OR key_hash LIKE $1", [`%${RUN}%`]);
    expect(r.rows[0]?.n).toBe("0");
  });
  it("üretim guard'ı (createProductionGuard, gerçek DB): IP eşiği+1'de RATE_LIMITED + retryAfterSeconds", async () => {
    Object.assign(process.env, { DATABASE_URL: env.databaseUrl, AUTH_DATABASE_URL: authUrl, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: APP });
    const ip = uniqueIp(4);
    const guard = createProductionGuard(() => Promise.resolve(new Headers({ origin: APP, "fly-client-ip": ip })));
    const act = guard({ schema, requireAuth: false }, () => Promise.resolve("ok"));
    const arg = { invitationId: id(9) };
    for (let i = 0; i < 300; i++) expect(await act(arg)).toMatchObject({ ok: true });
    const r = await act(arg);
    expect(r).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryable: true } });
    expect((r as { error: { retryAfterSeconds: number } }).error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
