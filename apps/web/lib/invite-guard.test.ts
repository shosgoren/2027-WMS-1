import { describe, expect, it } from "vitest";
import { guardInvitePreview } from "./invite-guard.ts";
import { RateLimitedError, type RateLimiter } from "./rate-limit.ts";

const ok: RateLimiter = { check: async () => undefined };
const limited: RateLimiter = {
  check: async () => {
    throw new RateLimitedError(30);
  },
};
const broken: RateLimiter = {
  check: async () => {
    throw new Error("db down");
  },
};

describe("guardInvitePreview (T-117d)", () => {
  it("IP var ve sınır aşılmadı → ok", async () => {
    expect(await guardInvitePreview(new Headers({ "fly-client-ip": "203.0.113.7" }), ok)).toBe("ok");
  });
  it("IP çözülemedi (üretimde başlık yok → FORBIDDEN) → unavailable; sınırlayıcı çağrılmaz", async () => {
    const prevEnv = process.env.WMS_ENV;
    process.env.WMS_ENV = "production";
    try {
      let called = false;
      const spy: RateLimiter = { check: async () => void (called = true) };
      expect(await guardInvitePreview(new Headers(), spy)).toBe("unavailable");
      expect(called).toBe(false);
    } finally {
      if (prevEnv === undefined) delete process.env.WMS_ENV;
      else process.env.WMS_ENV = prevEnv;
    }
  });
  it("hız sınırı aşımı → rate_limited", async () => {
    expect(await guardInvitePreview(new Headers({ "fly-client-ip": "203.0.113.7" }), limited)).toBe("rate_limited");
  });
  it("beklenmeyen sınırlayıcı hatası yutulmaz (fail-closed)", async () => {
    await expect(guardInvitePreview(new Headers({ "fly-client-ip": "203.0.113.7" }), broken)).rejects.toThrow("db down");
  });
});
