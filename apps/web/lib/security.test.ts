// T-127 birim testleri: CSP dizesi, origin eşleşmesi (Origin'siz ret), hata maskeleme, hız sınırı mantığı, IP kaynağı.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@wms/shared/errors";
import { buildCsp } from "../proxy.ts";
import { createActionGuard, createRouteGuard, limitVerifiedTenant, type GuardDeps } from "./action-guard.ts";
import { RATE_LIMITS, RateLimitedError, clientIp, createRateLimiter, deriveKey, hashKey, isProductionEnv, normalizeIp, type RateLimitStore } from "./rate-limit.ts";
import { z } from "zod";

// Eylem düzeyi testler için bağımlılık taklitleri (iş kuralı `@wms/domain` ve DB gerçek ortamda int testlerde sınanır).
const h = vi.hoisted(() => ({
  headers: new Headers(),
  principal: null as { userId: string; mfaVerified: boolean } | null,
  runTenantQuery: vi.fn(),
  inviteMember: vi.fn(),
  revokeInvitation: vi.fn(),
  counts: new Map<string, number>(),
}));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery: h.runTenantQuery }));
vi.mock("@wms/domain/identity/invitations", () => ({ inviteMember: h.inviteMember, revokeInvitation: h.revokeInvitation }));
vi.mock("@wms/db", () => ({
  getAppDb: () => ({}),
  consumeRateLimit: (_c: unknown, p: { scope: string; keyHash: string; limit: number }) => {
    const k = `${p.scope}|${p.keyHash}`;
    const n = (h.counts.get(k) ?? 0) + 1;
    h.counts.set(k, n);
    return Promise.resolve({ allowed: n <= p.limit, count: n, retryAfterSeconds: 30 });
  },
}));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(h.headers) }));
vi.mock("./queue.ts", () => ({ getSenderQueue: () => Promise.resolve(undefined) }));
vi.mock("@wms/auth", () => ({ getAuthService: () => ({ getPrincipal: () => Promise.resolve(h.principal) }) }));

const APP = "https://app.example.test";
const logs: Record<string, unknown>[] = [];
function deps(over: Partial<GuardDeps> = {}): GuardDeps {
  return {
    getHeaders: () => Promise.resolve(new Headers({ origin: APP })),
    resolvePrincipal: () => Promise.resolve({ userId: "u1", mfaVerified: true }),
    appUrl: APP,
    log: (e) => void logs.push(e),
    newRequestId: () => "req-1",
    ...over,
  };
}
function memStore(): RateLimitStore {
  const counts = new Map<string, number>();
  return {
    hit(scope, key, o) {
      const ms = o.windowSeconds * 1000;
      const start = Math.floor(o.now.getTime() / ms) * ms;
      const k = `${scope}|${key}|${start}`;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return Promise.resolve({ allowed: n <= o.limit, count: n, retryAfterSeconds: Math.max(1, Math.ceil((start + ms - o.now.getTime()) / 1000)) });
    },
  };
}

describe("buildCsp", () => {
  it("istenen yönergeleri nonce ile üretir, betikte unsafe-inline/eval yok (üretim)", () => {
    const csp = buildCsp("abc123");
    expect(csp).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc123' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    expect(csp.match(/script-src[^;]*/)?.[0]).not.toMatch(/unsafe-/);
  });
  it("unsafe-eval yalnızca geliştirmede", () => {
    expect(buildCsp("n", true)).toContain("'unsafe-eval'");
  });
});

describe("action guard", () => {
  const act = (d: GuardDeps) => createActionGuard(d)({ schema: z.object({}).strict() }, () => Promise.resolve("ok"));
  it("eşleşen Origin kabul", async () => {
    expect(await act(deps())({})).toEqual({ ok: true, data: "ok" });
  });
  it("Origin YOK -> FORBIDDEN", async () => {
    const r = await act(deps({ getHeaders: () => Promise.resolve(new Headers()) }))({});
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
  it("yabancı Origin ve appUrl tanımsız -> FORBIDDEN", async () => {
    const evil = deps({ getHeaders: () => Promise.resolve(new Headers({ origin: "https://evil.example" })) });
    expect(await act(evil)({})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await act(deps({ appUrl: undefined }))({})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
  it("beklenmeyen hata maskelenir: iç ayrıntı yanıta girmez", async () => {
    const g = createActionGuard(deps())({ schema: z.object({}) }, () => Promise.reject(new Error("SELECT secret FROM x password=hunter2")));
    const r = await g({});
    expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL", requestId: "req-1" } });
    expect(JSON.stringify(r)).not.toMatch(/SELECT|hunter2/);
  });
  it("IP sınırı aşımı RATE_LIMITED", async () => {
    const limiter = createRateLimiter({ store: memStore(), secret: "s", limits: { ip: 2 } });
    const g = act(deps({ limiter }));
    expect(await g({})).toMatchObject({ ok: true });
    expect(await g({})).toMatchObject({ ok: true });
    expect(await g({})).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryable: true, retryAfterSeconds: expect.any(Number) as unknown } });
  });
  it("limitVerifiedTenant: doğrulanmış tenant kimliğine göre ayrı sayar; reddedilen üyelik sayaç tüketmez", async () => {
    const limiter = createRateLimiter({ store: memStore(), secret: "s", limits: { tenant: 1 } });
    h.runTenantQuery.mockImplementation((a: { tenantSlug: string }, fn: (tx: unknown, m: { tenantId: string }) => Promise<unknown>) =>
      a.tenantSlug === "nope" ? Promise.reject(new AppError("NOT_FOUND")) : fn({}, { tenantId: `tenant-of-${a.tenantSlug}` }),
    );
    const g = createActionGuard(deps({ limiter }))({ schema: z.object({ t: z.string() }) }, (i, ctx) =>
      limitVerifiedTenant({ db: {} as never, principal: null, tenantSlug: i.t, permission: "users.manage" }, ctx).then(() => 1),
    );
    expect(await g({ t: "a" })).toMatchObject({ ok: true });
    expect(await g({ t: "b" })).toMatchObject({ ok: true });
    expect(await g({ t: "a" })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    for (let i = 0; i < 5; i++) expect(await g({ t: "nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
  it("üretimde IP kaynağı yoksa fail-closed (FORBIDDEN), ortak kova yok", async () => {
    const limiter = createRateLimiter({ store: memStore(), secret: "s" });
    const log: Record<string, unknown>[] = [];
    const r = await act(deps({ limiter, production: true, log: (e) => void log.push(e) }))({});
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    // Yapılandırılmış günlük: yalnızca neden; IP/başlık değeri yok.
    expect(log).toEqual([{ level: "error", msg: "request rejected", reason: "client-ip-unresolved", code: "FORBIDDEN" }]);
  });
  it("üretim tespiti packages/auth ile tutarlı: NODE_ENV=production veya WMS_ENV staging/production", () => {
    expect(isProductionEnv({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionEnv({ WMS_ENV: "staging" })).toBe(true);
    expect(isProductionEnv({ WMS_ENV: "production" })).toBe(true);
    expect(isProductionEnv({ WMS_ENV: "ci", NODE_ENV: "test" })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });
});

describe("route guard", () => {
  const route = (d: GuardDeps) => createRouteGuard(d)({}, () => Promise.resolve(new Response("ok")));
  it("Origin'siz POST -> 403; Origin'li POST ve GET -> 200", async () => {
    const r = route(deps());
    expect((await r(new Request("https://x.test/api/t/a", { method: "POST" }))).status).toBe(403);
    expect((await r(new Request("https://x.test/api/t/a", { method: "POST", headers: { origin: APP } }))).status).toBe(200);
    expect((await r(new Request("https://x.test/api/t/a"))).status).toBe(200);
  });
  it("aşımda 429 + Retry-After", async () => {
    const limiter = createRateLimiter({ store: memStore(), secret: "s", limits: { ip: 1 } });
    const r = route(deps({ limiter }));
    await r(new Request("https://x.test/api/t/a"));
    const res = await r(new Request("https://x.test/api/t/a"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await res.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});

describe("rate-limit", () => {
  it("clientIp yalnızca Fly-Client-IP; X-Forwarded-For yok sayılır; yoksa soket; üretimde ikisi de yoksa fail-closed", () => {
    expect(clientIp(new Headers({ "fly-client-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }), { production: true })).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9" }), { socketIp: "10.0.0.1", production: true })).toBe("10.0.0.1");
    expect(() => clientIp(new Headers({ "x-forwarded-for": "9.9.9.9" }), { production: true })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }) as Error);
    expect(clientIp(new Headers(), { production: false })).toBe("local-dev");
  });
  it("IPv6 /64 önekine indirgenir; IPv4 ve IPv4-eşlemeli aynen", () => {
    const a = normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:0db8:0001:0002::1")).toBe(a);
    expect(normalizeIp("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(a);
    expect(normalizeIp("2001:db8:1:3::1")).not.toBe(a);
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("1.2.3.4")).toBe("1.2.3.4");
  });
  it("HKDF anahtarı sırdan türer, ham sırdan farklıdır, sır değişince değişir", () => {
    const k = deriveKey("s1");
    expect(k).toHaveLength(32);
    expect(deriveKey("s1").equals(k)).toBe(true);
    expect(deriveKey("s2").equals(k)).toBe(false);
    expect(hashKey(k, "web.ip", "x")).not.toBe(hashKey(Buffer.from("s1"), "web.ip", "x"));
  });
  it("anahtar 64 hex, sırra bağlı, kapsama göre ayrışır", () => {
    const a = hashKey(deriveKey("s1"), "web.ip", "1.2.3.4");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(deriveKey("s2"), "web.ip", "1.2.3.4")).not.toBe(a);
    expect(hashKey(deriveKey("s1"), "web.user", "1.2.3.4")).not.toBe(a);
  });
  it("pencere değişince sayaç sıfırlanır; varsayılanlar A-41", async () => {
    expect([RATE_LIMITS.ip.limit, RATE_LIMITS.user.limit, RATE_LIMITS.tenant.limit]).toEqual([300, 120, 600]);
    let t = Date.parse("2026-01-01T00:00:10Z");
    const l = createRateLimiter({ store: memStore(), secret: "s", limits: { ip: 1 }, now: () => new Date(t) });
    await l.check("ip", "x");
    await expect(l.check("ip", "x")).rejects.toMatchObject({ retryAfterSeconds: 50 });
    await expect(l.check("ip", "x")).rejects.toBeInstanceOf(RateLimitedError);
    t += 60_000;
    await expect(l.check("ip", "x")).resolves.toBeUndefined();
  });
  it("boş sır reddedilir", () => {
    expect(() => createRateLimiter({ store: memStore(), secret: " " })).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Eylem düzeyi: inviteMemberAction / revokeInvitationAction (gerçek guard + gerçek limiter, taklit domain/DB)
// ---------------------------------------------------------------------------------------------
describe("members actions: tenant sayacı üyelik çözüldükten sonra", () => {
  const SLUG = "victim";
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const tenantKeyHash = (): string => hashKey(deriveKey("test-secret"), "web.tenant", TENANT);
  const tenantCount = (): number => h.counts.get(`web.tenant|${tenantKeyHash()}`) ?? 0;
  const inviteArg = { slug: SLUG, email: "a@example.test", roleKey: "PICKER" };
  const revokeArg = { slug: SLUG, invitationId: "22222222-2222-4222-8222-222222222222" };

  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", APP);
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
    h.counts.clear();
    h.headers = new Headers({ origin: APP, "fly-client-ip": "203.0.113.7" });
    h.principal = { userId: "u-1", mfaVerified: true };
    h.inviteMember.mockReset().mockResolvedValue({ invitationId: "i", expiresAt: new Date(0), delivery: "SCREEN" });
    h.revokeInvitation.mockReset().mockResolvedValue(undefined);
    h.runTenantQuery.mockReset().mockImplementation((_a: unknown, fn: (tx: unknown, m: { tenantId: string }) => Promise<unknown>) => fn({}, { tenantId: TENANT }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("yetkili üye: sayaç doğrulanmış tenant kimliğiyle tüketilir ve komut çalışır", async () => {
    const { inviteMemberAction, revokeInvitationAction } = await import("../app/t/[slug]/members/actions.ts");
    expect(await inviteMemberAction(inviteArg)).toMatchObject({ ok: true });
    expect(await revokeInvitationAction(revokeArg)).toMatchObject({ ok: true });
    expect(tenantCount()).toBe(2);
    expect([...h.counts.keys()].some((k) => k.includes(SLUG))).toBe(false); // slug anahtar değil (özet zaten ham değer içermez)
    expect(h.inviteMember).toHaveBeenCalledTimes(1);
    expect(h.revokeInvitation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["üye olmayan", "NOT_FOUND"],
    ["izni olmayan üye", "FORBIDDEN"],
  ] as const)("%s: komut ve tenant sayacı çalışmaz (%s)", async (_label, code) => {
    h.runTenantQuery.mockReset().mockRejectedValue(new AppError(code));
    const { inviteMemberAction, revokeInvitationAction } = await import("../app/t/[slug]/members/actions.ts");
    for (let i = 0; i < 5; i++) {
      expect(await inviteMemberAction(inviteArg)).toMatchObject({ ok: false, error: { code } });
      expect(await revokeInvitationAction(revokeArg)).toMatchObject({ ok: false, error: { code } });
    }
    expect(tenantCount()).toBe(0);
    expect([...h.counts.keys()].some((k) => k.startsWith("web.tenant|"))).toBe(false);
    expect(h.inviteMember).not.toHaveBeenCalled();
    expect(h.revokeInvitation).not.toHaveBeenCalled();
  });

  it("tenant eşiği + 1: RATE_LIMITED + retryAfterSeconds, komut çalışmaz", async () => {
    h.counts.set(`web.tenant|${tenantKeyHash()}`, RATE_LIMITS.tenant.limit);
    const { inviteMemberAction } = await import("../app/t/[slug]/members/actions.ts");
    const r = await inviteMemberAction(inviteArg);
    expect(r).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 30 } });
    expect(h.inviteMember).not.toHaveBeenCalled();
  });
});
