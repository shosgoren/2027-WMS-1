// T-127: web sertleştirme entegrasyonu. Gerçek wms_app bağlantısı + gerçek `request_rate_limits` tablosu (çok bağlantı
// = çok süreç benzetimi). Fikstürler sentetik (G-09).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionGuard, type GuardDeps } from "../../../apps/web/lib/action-guard.ts";
import { createPgRateLimitStore, createRateLimiter, hashKey } from "../../../apps/web/lib/rate-limit.ts";
import { JOB_PAYLOAD_SCHEMAS } from "../../../packages/shared/src/queue.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const APP = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const RUN = randomBytes(6).toString("hex");
let a: pg.Client;
let b: pg.Client;
let adm: pg.Client;

const exec = (c: pg.Client) => async (text: string, params: readonly unknown[]) => {
  const r = await c.query<{ count: number }>(text, [...params]);
  return { rows: r.rows };
};

beforeAll(async () => {
  a = new pg.Client({ connectionString: env.databaseUrl });
  b = new pg.Client({ connectionString: env.databaseUrl });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  for (const c of [a, b, adm]) c.on("error", () => undefined);
  try {
    await Promise.all([a.connect(), b.connect(), adm.connect()]);
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
});
afterAll(async () => {
  await Promise.all([a, b, adm].map((c) => c.end().catch(() => undefined)));
});

function guardDeps(headers: Record<string, string>, limiter = createRateLimiter({ store: createPgRateLimitStore(exec(a)), secret: SECRET })): GuardDeps {
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
const action = (d: GuardDeps, tenantKey?: (i: { invitationId: string }) => string) =>
  createActionGuard(d)({ schema, ...(tenantKey === undefined ? {} : { tenantKey }) }, () => Promise.resolve("ok"));

describe("web hardening (AC)", () => {
  it("eşik + 1 -> RATE_LIMITED; sayaç iki bağlantı arasında paylaşılır", async () => {
    const l1 = createRateLimiter({ store: createPgRateLimitStore(exec(a)), secret: SECRET, limits: { tenant: 3 } });
    const l2 = createRateLimiter({ store: createPgRateLimitStore(exec(b)), secret: SECRET, limits: { tenant: 3 } });
    const k = `tenant-share-${RUN}`;
    await l1.check("tenant", k);
    await l2.check("tenant", k);
    await l1.check("tenant", k);
    await expect(l2.check("tenant", k)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("paralel istekler tek ifadeli UPSERT ile kaybolmadan sayılır", async () => {
    const store = createPgRateLimitStore(exec(a));
    const w = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const key = hashKey(SECRET, "web.ip", `par-${RUN}`);
    const counts = await Promise.all([store.hit("web.ip", key, w), createPgRateLimitStore(exec(b)).hit("web.ip", key, w)]);
    expect(counts.sort()).toEqual([1, 2]);
  });

  it("farklı tenant sayaçları bağımsız", async () => {
    const lim = createRateLimiter({ store: createPgRateLimitStore(exec(a)), secret: SECRET, limits: { tenant: 1 } });
    const g = action(guardDeps({ origin: APP }, lim), (i) => i.invitationId);
    expect(await g({ invitationId: id(1) })).toMatchObject({ ok: true });
    expect(await g({ invitationId: id(2) })).toMatchObject({ ok: true });
    expect(await g({ invitationId: id(1) })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(await g({ invitationId: id(2) })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
  });

  it("yabancı Origin ve Origin'siz eylem -> FORBIDDEN (sayaç tüketmeden)", async () => {
    expect(await action(guardDeps({ origin: "https://evil.example" }))({ invitationId: id(3) })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await action(guardDeps({}))({ invitationId: id(3) })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("sahte X-Forwarded-For ile IP sınırı aşılmaz (aynı Fly-Client-IP aynı sayaç)", async () => {
    const lim = createRateLimiter({ store: createPgRateLimitStore(exec(a)), secret: SECRET, limits: { ip: 2, user: 1000 } });
    const ip = `203.0.113.${(parseInt(RUN.slice(0, 2), 16) % 250) + 1}`;
    const mk = (xff: string) => action(guardDeps({ origin: APP, "fly-client-ip": ip, "x-forwarded-for": xff }, lim));
    expect(await mk("1.1.1.1")({ invitationId: id(4) })).toMatchObject({ ok: true });
    expect(await mk("2.2.2.2")({ invitationId: id(4) })).toMatchObject({ ok: true });
    expect(await mk("3.3.3.3")({ invitationId: id(4) })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
  });

  it("anahtar yalnızca HMAC özeti: tabloda ham IP/kullanıcı yok", async () => {
    const r = await adm.query<{ n: string }>("SELECT count(*)::text AS n FROM public.request_rate_limits WHERE key_hash LIKE '%.%' OR key_hash LIKE $1", [`%${RUN}%`]);
    expect(r.rows[0]?.n).toBe("0");
  });
});
