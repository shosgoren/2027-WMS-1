// demoSignInAction (T-122; A-43, güvenlik incelemesi M10): bayraklar, rol izin listesi, Origin, oturum, hata eşlemesi ve
// parolanın sonuçta/logda bulunmaması. vi.mock yolları gerçek import yollarıyla aynıdır.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPrincipal = vi.hoisted(() => vi.fn());
const handler = vi.hoisted(() => vi.fn());
const cookieSet = vi.hoisted(() => vi.fn());
const hdrs = vi.hoisted(() => ({ value: new Headers() }));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(hdrs.value),
  cookies: () => Promise.resolve({ set: cookieSet }),
}));
vi.mock("@wms/auth", () => ({ getAuthService: () => ({ getPrincipal, handler }) }));
vi.mock("../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));

import { DEMO_ROLES } from "@wms/domain/demo/seed";
import { demoLoginStatus, demoSignInAction } from "./demo-actions.ts";

const PASSWORD = "unit-test-demo-password-9f3";
const ORIGIN = "https://app.example.test";
const ENV_KEYS = ["WMS_ENV", "DEMO_MODE", "DEMO_PASSWORD", "DEMO_EMAIL_DOMAIN", "BETTER_AUTH_URL"] as const;
const saved: Record<string, string | undefined> = {};
const SESSION = "__Secure-better-auth.session_token=abc%3D; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Lax";

function ok(setCookie: string[] = [SESSION], body: unknown = { token: "t" }): Response {
  const h = new Headers();
  for (const c of setCookie) h.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status: 200, headers: h });
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { WMS_ENV: "staging", DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD, DEMO_EMAIL_DOMAIN: "example.invalid", BETTER_AUTH_URL: ORIGIN });
  hdrs.value = new Headers({ origin: ORIGIN, "fly-client-ip": "203.0.113.7", "user-agent": "vitest" });
  getPrincipal.mockResolvedValue(null);
  handler.mockResolvedValue(ok());
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("demoSignInAction", () => {
  it("bayraklar kapalıyken FORBIDDEN; auth çağrılmaz", async () => {
    for (const patch of [{ DEMO_MODE: "0" }, { DEMO_MODE: undefined }, { WMS_ENV: "local" }, { WMS_ENV: "production" }, { WMS_ENV: undefined }] as const) {
      Object.assign(process.env, { WMS_ENV: "staging", DEMO_MODE: "1" });
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const res = await demoSignInAction({ role: "READ_ONLY" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("DEMO_EMAIL_DOMAIN example.invalid değilse ya da parola eksik/kısaysa FORBIDDEN ve durum misconfigured", async () => {
    for (const patch of [{ DEMO_EMAIL_DOMAIN: "corp.example" }, { DEMO_EMAIL_DOMAIN: undefined }, { DEMO_PASSWORD: undefined }, { DEMO_PASSWORD: "short" }] as const) {
      Object.assign(process.env, { DEMO_PASSWORD: PASSWORD, DEMO_EMAIL_DOMAIN: "example.invalid" });
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      expect(await demoLoginStatus()).toBe("misconfigured");
      const res = await demoSignInAction({ role: "READ_ONLY" });
      expect(res.ok === false && res.error.code).toBe("FORBIDDEN");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("durum: bayrak yok disabled, tam yapılandırma ready (parola dönmez)", async () => {
    expect(await demoLoginStatus()).toBe("ready");
    process.env.DEMO_MODE = "0";
    expect(await demoLoginStatus()).toBe("disabled");
  });

  it("rol izin listesi: bilinmeyen rol ve e-posta/parola alanları VALIDATION_FAILED", async () => {
    for (const raw of [{ role: "SUPERUSER" }, { role: "READ_ONLY", email: "x@y.z" }, { role: "READ_ONLY", password: "p" }, {}, "READ_ONLY"]) {
      const res = await demoSignInAction(raw);
      expect(res.ok === false && res.error.code).toBe("VALIDATION_FAILED");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("Origin yok ya da eşleşmiyorsa FORBIDDEN", async () => {
    for (const origin of [undefined, "https://evil.example"]) {
      hdrs.value = new Headers({ "fly-client-ip": "203.0.113.7", ...(origin === undefined ? {} : { origin }) });
      const res = await demoSignInAction({ role: "READ_ONLY" });
      expect(res.ok === false && res.error.code).toBe("FORBIDDEN");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("oturumu açık kullanıcı reddedilir (FORBIDDEN); giriş denenmez, çerez yazılmaz", async () => {
    getPrincipal.mockResolvedValue({ userId: "u1", mfaVerified: false });
    const res = await demoSignInAction({ role: "READ_ONLY" });
    expect(res.ok === false && res.error.code).toBe("FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("başarı: yalnızca sabit demo e-postası ve sunucu parolasıyla /sign-in/email; çerez kurulur; sonuçta parola yok", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await demoSignInAction({ role: "READ_ONLY" });
    expect(res).toMatchObject({ ok: true, data: { redirectTo: "/" } });
    expect(handler).toHaveBeenCalledTimes(1);
    const req = handler.mock.calls[0]?.[0] as Request;
    expect(new URL(req.url).pathname).toBe("/api/auth/sign-in/email");
    expect(req.method).toBe("POST");
    expect(req.headers.get("origin")).toBe(ORIGIN);
    expect(JSON.parse(await req.text())).toEqual({ email: DEMO_ROLES.READ_ONLY, password: PASSWORD });
    expect(cookieSet).toHaveBeenCalledWith("__Secure-better-auth.session_token", "abc=", expect.objectContaining({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 43200 }));
    expect(JSON.stringify(res)).not.toContain(PASSWORD);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(PASSWORD);
  });

  const failures: [string, () => Response, string][] = [
    ["429", () => new Response("{}", { status: 429 }), "RATE_LIMITED"],
    ["500", () => new Response("{}", { status: 500 }), "INTERNAL"],
    ["503", () => new Response("{}", { status: 503 }), "INTERNAL"],
    ["401", () => new Response("{}", { status: 401 }), "UNAUTHENTICATED"],
    ["2FA istendi", () => ok([SESSION], { twoFactorRedirect: true }), "UNAUTHENTICATED"],
    ["gövde yok", () => new Response("not json", { status: 200, headers: { "set-cookie": SESSION } }), "UNAUTHENTICATED"],
    ["session_token yok", () => ok(["other=1; Path=/"]), "INTERNAL"],
    ["Set-Cookie yok", () => ok([]), "INTERNAL"],
  ];
  for (const [name, make, code] of failures) {
    it(`hata eşlemesi: ${name} -> ${code}; parola sonuçta ve logda yok`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      handler.mockResolvedValue(make());
      const res = await demoSignInAction({ role: "TENANT_ADMIN" });
      expect(res.ok === false && res.error.code).toBe(code);
      expect(JSON.stringify(res)).not.toContain(PASSWORD);
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(PASSWORD);
    });
  }

  it("auth işleyicisi fırlatırsa genel INTERNAL (ayrıntı/parola sızmaz)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handler.mockRejectedValue(new Error(`boom ${PASSWORD}`));
    const res = await demoSignInAction({ role: "READ_ONLY" });
    expect(res.ok === false && res.error.code).toBe("INTERNAL");
    expect(JSON.stringify(res)).not.toContain(PASSWORD);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(PASSWORD);
  });
});
