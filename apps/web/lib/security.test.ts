// T-127 birim testleri: CSP dizesi, origin eşleşmesi (Origin'siz ret), hata maskeleme, hız sınırı mantığı, IP kaynağı.
import { describe, expect, it } from "vitest";
import { buildCsp } from "../proxy.ts";
import { createActionGuard, createRouteGuard, type GuardDeps } from "./action-guard.ts";
import { RATE_LIMITS, RateLimitedError, clientIp, createRateLimiter, hashKey, type RateLimitStore } from "./rate-limit.ts";
import { z } from "zod";

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
function memStore(): RateLimitStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    hit(scope, key, w) {
      const k = `${scope}|${key}|${w.toISOString()}`;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return Promise.resolve(n);
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
    expect(await g({})).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryable: true } });
  });
  it("tenantKey ile tenant sayacı ayrı işler", async () => {
    const limiter = createRateLimiter({ store: memStore(), secret: "s", limits: { tenant: 1 } });
    const g = createActionGuard(deps({ limiter }))({ schema: z.object({ t: z.string() }), tenantKey: (i) => i.t }, () => Promise.resolve(1));
    expect(await g({ t: "a" })).toMatchObject({ ok: true });
    expect(await g({ t: "b" })).toMatchObject({ ok: true });
    expect(await g({ t: "a" })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
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
  it("clientIp yalnızca Fly-Client-IP; X-Forwarded-For yok sayılır", () => {
    expect(clientIp(new Headers({ "fly-client-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9" }), "10.0.0.1")).toBe("10.0.0.1");
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9" }))).toBe("unknown");
  });
  it("anahtar 64 hex, sırra bağlı, kapsama göre ayrışır", () => {
    const a = hashKey("s1", "web.ip", "1.2.3.4");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey("s2", "web.ip", "1.2.3.4")).not.toBe(a);
    expect(hashKey("s1", "web.user", "1.2.3.4")).not.toBe(a);
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
