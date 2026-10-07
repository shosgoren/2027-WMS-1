import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCsp, proxy } from "./proxy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIVEN = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const req = (path: string, headers: Record<string, string> = {}): NextRequest => new NextRequest(`http://localhost:3000${path}`, { headers });

describe("proxy: x-request-id, erişim günlüğü (T-129)", () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
  });
  afterEach(() => vi.restoreAllMocks());

  it("UUID biçimli gelen x-request-id korunur: yanıta ve sunucu bağlamına (istek başlığı) iletilir", () => {
    const res = proxy(req("/login", { "x-request-id": GIVEN.toUpperCase() }));
    expect(res.headers.get("x-request-id")).toBe(GIVEN);
    expect(res.headers.get("x-middleware-request-x-request-id")).toBe(GIVEN);
  });

  it.each(["abc", "../../etc/passwd", `${GIVEN}-extra`, "<script>alert(1)</script>"])("UUID olmayan %s yerine yenisi üretilir", (bad) => {
    const res = proxy(req("/login", { "x-request-id": bad }));
    const id = res.headers.get("x-request-id") ?? "";
    expect(id).toMatch(UUID);
    expect(id).not.toBe(bad);
    expect(res.headers.get("x-middleware-request-x-request-id")).toBe(id);
  });

  it("başlık yoksa yeni UUID; her istekte farklı", () => {
    const a = proxy(req("/login")).headers.get("x-request-id");
    const b = proxy(req("/login")).headers.get("x-request-id");
    expect(a).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it("oturumsuz korunan yol yönlendirmesi de aynı kimliği taşır; CSP korunur", () => {
    const res = proxy(req("/t/acme/members", { "x-request-id": GIVEN }));
    expect(res.status).toBe(307);
    expect(res.headers.get("x-request-id")).toBe(GIVEN);
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  });

  it("nonce'lu CSP normal yanıtta da vardır", () => {
    const res = proxy(req("/login"));
    expect(res.headers.get("content-security-policy")).toContain("nonce-");
    expect(res.headers.get("x-middleware-request-x-nonce")).not.toBeNull();
  });

  it("erişim günlüğü: tek JSON satırı, requestId ile; davet belirteci yolda maskeli", () => {
    proxy(req("/invite/SuperSecretInviteToken123", { "x-request-id": GIVEN, cookie: "better-auth.session_token=SESS", authorization: "Bearer zzz" }));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ level: "info", msg: "request", service: "web", requestId: GIVEN, method: "GET", path: "/invite/***" });
    expect(lines[0]).not.toMatch(/SuperSecret|SESS|zzz/);
  });

  it.each([
    ["/login?next=%2Finvite%2FSuperSecretInviteToken123", "/login?next=%2Finvite%2F***"],
    ["/mfa?next=%2Finvite%2FSuperSecretInviteToken123", "/mfa?next=%2Finvite%2F***"],
    ["/api/auth/reset-password/SuperSecretResetToken123", "/api/auth/reset-password/***"],
    ["/reset-password?token=SuperSecretResetToken123", "/reset-password"],
  ])("erişim günlüğü %s → maskeli; Referrer-Policy no-referrer", (path, masked) => {
    const res = proxy(req(path));
    const entry = JSON.parse(lines[0] ?? "{}") as { path: string };
    expect(entry.path).toBe(masked);
    expect(lines[0]).not.toContain("SuperSecret");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("erişim günlüğü: izinli olmayan sorgu anahtarları düşer (serbest metin/e-posta yazılmaz), sayısı droppedParams", () => {
    proxy(req("/login?q=ayse%40example.com&utm_source=x&next=%2Ft%2Facme"));
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ path: "/login?next=%2Ft%2Facme", droppedParams: 2 });
    expect(lines[0]).not.toMatch(/ayse|example|utm/);
  });

  it("çok uzun yol/sorgu: günlük satırı sınırlı", () => {
    proxy(req(`/${"a.".repeat(20_000)}?${"a=1&".repeat(5_000)}`));
    expect((lines[0] ?? "").length).toBeLessThan(1500);
  });

  it("belirteç içermeyen yolda Referrer-Policy eklenmez", () => {
    expect(proxy(req("/login?next=%2Ft%2Facme")).headers.get("referrer-policy")).toBeNull();
  });

  it("belirteçli korunan yönlendirmede (next içinde davet) Referrer-Policy ve maskeli günlük", () => {
    const res = proxy(req("/mfa?next=%2Finvite%2FSuperSecretInviteToken123"));
    expect(res.status).toBe(307);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(lines[0]).not.toContain("SuperSecret");
  });
});

describe("CSP: uygulama içi barkod çözücü (T-286)", () => {
  it("script-src yalnızca WASM derlemesine izin verir; JS eval ve üçüncü taraf kaynak açılmaz", () => {
    const csp = buildCsp("N0nce");
    expect(csp).toMatch(/script-src 'self' 'nonce-N0nce' 'strict-dynamic' 'wasm-unsafe-eval'(;|$)/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/https?:/);
  });
});
