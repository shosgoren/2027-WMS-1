import { describe, expect, it, vi } from "vitest";
import { MASK, createConsoleLogger, createJsonLogger, isSensitiveKey, maskFields, maskString, requestIdFrom } from "./log.ts";

const U1 = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const U2 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const U3 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = new Date("2026-10-06T10:00:00.000Z");

function capture(base = {}) {
  const lines: string[] = [];
  const logger = createJsonLogger((l) => lines.push(l), () => NOW, base);
  const last = (): Record<string, unknown> => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  return { logger, lines, last };
}

describe("createJsonLogger biçimi", () => {
  it("tek JSON satırı: ts, level, msg, service, kimlikler önce; ek alanlar sonra", () => {
    const { logger, lines, last } = capture({ service: "web" });
    logger.info("hello", { requestId: U1, tenantId: U2, userId: U3, extra: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(Object.keys(last())).toEqual(["ts", "level", "msg", "service", "requestId", "tenantId", "userId", "extra"]);
    expect(last()).toEqual({ ts: NOW.toISOString(), level: "info", msg: "hello", service: "web", requestId: U1, tenantId: U2, userId: U3, extra: 1 });
  });

  it("tenantId/userId isteğe bağlıdır; verilmezse alan yok", () => {
    const { logger, last } = capture();
    logger.error("boom");
    expect(last()).toEqual({ ts: NOW.toISOString(), level: "error", msg: "boom" });
  });

  it("warn düzeyi ve child bağlamı (üst bağlam korunur)", () => {
    const { logger, last } = capture({ service: "web" });
    logger.child({ requestId: U1 }).child({ userId: U3 }).warn("w", { a: 1 });
    expect(last()).toMatchObject({ level: "warn", service: "web", requestId: U1, userId: U3, a: 1 });
  });

  it("ts/level/msg ayrılmıştır: alanlar ezemez", () => {
    const { logger, last } = capture();
    logger.info("real", { level: "error", msg: "fake", ts: "x" });
    expect(last()).toMatchObject({ level: "info", msg: "real", ts: NOW.toISOString() });
  });

  it("UUID olmayan kimlikler loga girmez (kişisel veri yok)", () => {
    const { logger, last } = capture({ userId: "ayse@example.com" });
    logger.info("x", { requestId: "evil\nline", tenantId: "acme-corp" });
    expect(last()).toMatchObject({ requestId: "invalid-id", tenantId: "invalid-id", userId: "invalid-id" });
    expect(JSON.stringify(last())).not.toMatch(/ayse|acme|evil/);
  });

  it("girdi alan nesnesi değişmez", () => {
    const { logger } = capture();
    const fields = { password: "p", nested: { token: "t" } };
    logger.info("x", fields);
    expect(fields).toEqual({ password: "p", nested: { token: "t" } });
  });

  it("varsayılan yazıcı stdout'a satır + \\n yazar; createConsoleLogger service ekler", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    createJsonLogger().info("std");
    expect(String(out.mock.calls[0]?.[0])).toMatch(/^\{"ts":".+","level":"info","msg":"std"\}\n$/);
    out.mockRestore();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    createConsoleLogger("web").info("c");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ service: "web", msg: "c" });
    log.mockRestore();
  });
});

describe("maskeleme: anahtar adları (G-09)", () => {
  it.each(["password", "newPassword", "access_token", "resetToken", "client-secret", "apiKey", "api_key", "key", "code", "otpCode", "Authorization", "authorization", "Cookie", "cookie", "set-cookie", "Set-Cookie", "email"])(
    "%s hassas",
    (k) => expect(isSensitiveKey(k)).toBe(true),
  );
  it.each(["requestId", "tenantId", "msg", "status", "path", "method", "reason", "errorName", "monkey", "keyboard"])("%s hassas değil", (k) => expect(isSensitiveKey(k)).toBe(false));

  it("e-posta, parola, belirteç, çerez, authorization alan değerleri maskelenir (iç içe/dizi dahil)", () => {
    const { logger, lines } = capture();
    logger.info("login", {
      email: "ayse@example.com",
      password: "hunter2-ÇOK-GİZLİ",
      body: { token: "tok-123", nested: { client_secret: "sec-456" } },
      headers: { authorization: "Bearer abc.def.ghi", cookie: "better-auth.session_token=SESSION", "x-ok": "1" },
      list: [{ otpCode: "123456" }, "plain"],
      code: "000111",
    });
    const line = lines[0] ?? "";
    for (const secret of ["ayse@example.com", "hunter2", "tok-123", "sec-456", "abc.def.ghi", "SESSION", "123456", "000111"]) expect(line).not.toContain(secret);
    const parsed = JSON.parse(line) as { headers: Record<string, string>; list: unknown[] };
    expect(parsed.headers).toEqual({ authorization: MASK, cookie: MASK, "x-ok": "1" });
    expect(parsed.list).toEqual([{ otpCode: MASK }, "plain"]);
  });

  it("Headers nesnesi maskelenir", () => {
    const out = maskFields({ h: new Headers({ Authorization: "Bearer zzz", Cookie: "a=b", Accept: "text/html" }) });
    expect(out.h).toEqual({ authorization: MASK, cookie: MASK, accept: "text/html" });
  });

  it("Error nesnesi: ad + maskeli ileti (yığın/ek alan yok)", () => {
    const err = Object.assign(new Error("connect postgres://wms_app:s3cret@db:5432/wms failed"), { password: "x" });
    const out = maskFields({ err }) as { err: Record<string, unknown> };
    expect(out.err).toEqual({ name: "Error", message: `connect postgres://${MASK}@db:5432/wms failed` });
  });

  it("döngüsel/çok derin nesne sonsuz döngüye girmez", () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    const { logger, lines } = capture();
    expect(() => logger.info("c", a)).not.toThrow();
    expect(lines[0]).toContain("[truncated]");
  });
});

describe("maskeleme: dizeler (URL, yol, sorgu)", () => {
  it("URL kimlik bilgisi", () => {
    expect(maskString("postgresql://wms_app:p%40ss@host:6432/wms?sslmode=require")).toBe(`postgresql://${MASK}@host:6432/wms?sslmode=require`);
    expect(maskString("https://user:pw@example.com/x")).toBe(`https://${MASK}@example.com/x`);
    expect(maskString("https://example.com/a@b")).toBe("https://example.com/a@b");
  });

  it("davet belirteci: yolda ve next= sorgusunda (tek/çift kodlu)", () => {
    expect(maskString("/invite/AbC_123-xyz")).toBe(`/invite/${MASK}`);
    expect(maskString("/invite/AbC_123-xyz?utm=1")).toBe(`/invite/${MASK}?utm=1`);
    expect(maskString("/login?next=%2Finvite%2FAbC_123-xyz")).toBe(`/login?next=%2Finvite%2F${MASK}`);
    expect(maskString("/mfa?next=%2Finvite%2FAbC_123-xyz&x=1")).toBe(`/mfa?next=%2Finvite%2F${MASK}&x=1`);
    expect(maskString("/login?next=/invite/AbC_123-xyz")).toBe(`/login?next=/invite/${MASK}`);
    expect(maskString("/login?next=%252Finvite%252FAbC_123-xyz")).toBe(`/login?next=%252Finvite%252F${MASK}`);
    expect(maskString("/login?next=%2FINVITE%2FAbC123")).toBe(`/login?next=%2FINVITE%2F${MASK}`);
    expect(maskString("/invite")).toBe("/invite");
  });

  it("yönetici sıfırlama belirteci: API yolu ve /reset-password?token= sorgusu (T-117b MINOR-4)", () => {
    expect(maskString("/api/auth/reset-password/R3s3t_T0k-en")).toBe(`/api/auth/reset-password/${MASK}`);
    expect(maskString("/reset-password?token=R3s3t_T0k-en")).toBe(`/reset-password?token=${MASK}`);
    expect(maskString("/reset-password?token=R3s3t&next=%2Ft%2Facme")).toBe(`/reset-password?token=${MASK}&next=%2Ft%2Facme`);
    expect(maskString("/login?next=%2Freset-password%3Ftoken%3DR3s3t")).not.toContain("R3s3t");
    expect(maskString("/login?next=%2Fapi%2Fauth%2Freset-password%2FR3s3t")).toBe(`/login?next=%2Fapi%2Fauth%2Freset-password%2F${MASK}`);
  });

  it("hassas sorgu parametreleri: token, code, key, secret, password, signature", () => {
    expect(maskString("/cb?code=abc&state=ok&access_token=zzz&apiKey=k1&X-Amz-Signature=s&password=p")).toBe(
      `/cb?code=${MASK}&state=ok&access_token=${MASK}&apiKey=${MASK}&X-Amz-Signature=${MASK}&password=${MASK}`,
    );
  });

  it("Bearer/Basic ve çerez benzeri dize", () => {
    expect(maskString("Authorization: Bearer abc.def-ghi_jkl=")).toBe(`Authorization: Bearer ${MASK}`);
    expect(maskString("Basic dXNlcjpwYXNz")).toBe(`Basic ${MASK}`);
    expect(maskString("a=1; better-auth.session_token=SESS; b=2")).toBe(`a=1; better-auth.session_token=${MASK}; b=2`);
  });

  it("dize içindeki e-posta adresi", () => {
    expect(maskString("invited ayse.k+x@sub.example.com today")).toBe(`invited ${MASK}@${MASK} today`);
  });

  it("zararsız dize aynen kalır", () => {
    for (const s of ["/t/acme/members", "/login?next=%2Ft%2Facme", "started", "GET /api/health 200"]) expect(maskString(s)).toBe(s);
  });

  it("msg ve service de maskelenir", () => {
    const { logger, last } = capture({ service: "web" });
    logger.error("fail https://u:p@h/invite/TOK");
    expect(last().msg).toBe(`fail https://${MASK}@h/invite/${MASK}`);
  });
});

describe("requestIdFrom", () => {
  it("yalnızca UUID biçimi (küçük harfe çevrilir); aksi undefined", () => {
    expect(requestIdFrom(new Headers({ "x-request-id": U1.toUpperCase() }))).toBe(U1);
    expect(requestIdFrom(new Headers({ "x-request-id": ` ${U1} ` }))).toBe(U1);
    expect(requestIdFrom(new Headers({ "x-request-id": "abc" }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ "x-request-id": `${U1}-x` }))).toBeUndefined();
    expect(requestIdFrom(new Headers())).toBeUndefined();
  });
});
