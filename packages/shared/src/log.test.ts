import { describe, expect, it, vi } from "vitest";
import { MASK, MAX_ENTRIES, MAX_LOG_STRING, MAX_NODES, createConsoleLogger, createJsonLogger, isSensitiveKey, maskAccessPath, maskFields, maskString, requestIdFrom } from "./log.ts";

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
    // `authorization` anahtarının TÜM değeri maskelenir (şema sözcüğü dahil: daha sıkı); yalın Bearer değeri şema korunarak.
    expect(maskString("Authorization: Bearer abc.def-ghi_jkl=")).toBe(`Authorization: ${MASK}`);
    expect(maskString("sent Bearer abc.def-ghi_jkl= ok")).toBe(`sent Bearer ${MASK} ok`);
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

describe("ReDoS: doğrusal tarayıcılar ve sabit uzunluk sınırı (BLOCKER)", () => {
  const BIG = 100_000;
  const patho: Record<string, string> = {
    email: "/" + "a.".repeat(BIG / 2),
    emailAt: "a@".repeat(BIG / 2),
    emailLocal: "a".repeat(BIG),
    urlScheme: "a.".repeat(BIG / 2),
    urlSlashes: "a://".repeat(BIG / 4),
    urlAuthority: "http://" + "@".repeat(BIG),
    param: "a=".repeat(BIG / 2),
    paramName: "x".repeat(BIG) + "token",
    paramColon: ":".repeat(BIG),
    paramEncoded: "%3D".repeat(BIG / 3),
    bearer: "Bearer" + " ".repeat(BIG),
    tokenPath: "/invite/".repeat(BIG / 8),
    spaces: " ".repeat(BIG),
    quotes: 'password":"' + "\\".repeat(BIG),
  };
  it.each(Object.entries(patho))("%s: 100 KB girdi < 50 ms ve çıktı sınırlı", (_n, input) => {
    const t0 = performance.now();
    const out = maskString(input);
    const ms = performance.now() - t0;
    expect(out.length).toBeLessThanOrEqual(MAX_LOG_STRING + 64);
    expect(ms).toBeLessThan(50);
  });

  it("uzunluk sınırı doğrudan: sınırı aşan girdi kesilir ve işaretlenir; sınırdaki girdi aynen", () => {
    const exact = "a".repeat(MAX_LOG_STRING);
    expect(maskString(exact)).toBe(exact);
    const out = maskString(exact + "b");
    expect(out).toBe(exact + "…[truncated]");
    expect(out).not.toContain("b");
  });

  it("kesilen kuyruktaki sır loga girmez (sınırdan sonra gelen belirteç)", () => {
    const out = maskString("x".repeat(MAX_LOG_STRING + 10) + " password=hunter2");
    expect(out).not.toContain("hunter2");
  });

  it("proxy yolu: erişim günlüğü yolu/sorgusu da sınırlı", () => {
    const t0 = performance.now();
    const r = maskAccessPath("/" + "a.".repeat(50_000), "?" + "a=1&".repeat(50_000));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.path.length).toBeLessThan(1200);
    expect(r.droppedParams).toBeGreaterThan(0);
  });
});

describe("anahtar/değer biçimleri dize içinde (MAJOR-2)", () => {
  it.each([
    ['{"password":"hunter2","a":1}', `{"password":"${MASK}","a":1}`],
    ["{'password': 'hunter2'}", `{'password': '${MASK}'}`],
    ['body {"apiKey" : "k-123", "ok": true}', `body {"apiKey" : "${MASK}", "ok": true}`],
    ["x-api-key: abc123DEF", `x-api-key: ${MASK}`],
    ["X-API-Key=abc123DEF&b=1", `X-API-Key=${MASK}&b=1`],
    ["password: hunter2", `password: ${MASK}`],
    ["Cookie: a=b; session=SESSVAL", `Cookie: ${MASK}`],
    ['{"token":"a\\"b-still-secret"}', `{"token":"${MASK}"}`],
    ["DSN=https://x@sentry.example/1 next", `DSN=${MASK}`],
    ["jwt=eyJ.a.b sid=abc", `jwt=${MASK}`],
  ])("%s", (input, expected) => expect(maskString(input)).toBe(expected));

  it("stack dizesi içindeki gömülü JSON/başlık maskelenir (worker describeError stack alanı)", () => {
    const { logger, lines } = capture();
    logger.error("shutdown hook failed", { error: { name: "E", message: "m", stack: 'Error: bad\n    at x\n  body={"password":"hunter2"} authorization: Bearer abc' } });
    expect(lines[0]).not.toMatch(/hunter2|abc"/);
    expect(JSON.parse(lines[0] ?? "{}").error.stack).toContain(MASK);
  });

  it("zararsız `ad: değer` metni değişmez", () => {
    for (const s of ["status: ok", "GET /x HTTP/1.1", "monkey=1&keyboard=2", "https://example.com:8080/a"]) expect(maskString(s)).toBe(s);
  });
});

describe("ek sertleştirme (MINOR)", () => {
  it.each(["pass", "userPass", "session", "sessionId", "sid", "jwt", "dsn", "x-signature"])("%s hassas", (k) => expect(isSensitiveKey(k)).toBe(true));
  it.each(["errorCode", "statusCode", "sqlstate", "passenger", "dsnCount_"])("%s güvenli/hassas değil", (k) => expect(isSensitiveKey(k)).toBe(k === "dsnCount_"));

  it("URL kimlik bilgisi: parola `#`/`@`/`:` içerse de tam maskelenir", () => {
    expect(maskString("postgres://u:p#a@ss:w@host:5432/db")).toBe(`postgres://${MASK}@host:5432/db`);
    expect(maskString("conn failed redis://:p@ss@h:6379 end")).toBe(`conn failed redis://${MASK}@h:6379 end`);
    expect(maskString("https://example.com/a@b#c")).toBe("https://example.com/a@b#c");
  });

  it("yüzde kodlu e-posta ve parametre adı (kod çözülmüş biçim, en çok 2 tur)", () => {
    expect(maskString("to=ayse%40example.com")).not.toMatch(/ayse|example/);
    expect(maskString("/x?%74oken=SECRETVAL")).not.toContain("SECRETVAL");
    expect(maskString("/x?api%5Fkey=SECRETVAL")).not.toContain("SECRETVAL");
    expect(maskString("mail ayse%2540example.com")).not.toMatch(/ayse/);
    expect(maskString("100%25 ok %zz")).toBe("100%25 ok %zz");
  });

  it("log çağrısı asla fırlatmaz: BigInt, fırlatan getter, toJSON, Symbol, döngü", () => {
    const { logger, lines } = capture();
    const evil = {
      get boom(): string {
        throw new Error("getter");
      },
      toJSON() {
        throw new Error("toJSON");
      },
    };
    expect(() => logger.info("a", { n: 10n, s: Symbol("x"), f: () => 1 })).not.toThrow();
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ n: "[bigint]", s: "[symbol]", f: "[function]" });
    expect(() => logger.info("b", { evil })).not.toThrow();
    expect(lines).toHaveLength(2);
    const throwingWrite = createJsonLogger(() => {
      throw new Error("sink");
    });
    expect(() => throwingWrite.error("x", { a: 1 })).not.toThrow();
  });

  it("genişlik sınırı: çok anahtar/dizi öğesi kısaltılır", () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const out = maskFields({ wide, arr: Array.from({ length: 500 }, (_, i) => i) }) as { wide: Record<string, unknown>; arr: unknown[] };
    expect(Object.keys(out.wide).length).toBeLessThanOrEqual(MAX_ENTRIES + 1);
    expect(out.arr).toHaveLength(MAX_ENTRIES + 1);
    expect(out.arr.at(-1)).toBe("[+450 more]");
  });

  it("Error: yalnızca ad + maskeli ileti (stack/cause yazılmaz)", () => {
    const err = new Error("outer", { cause: new Error("password=hunter2") });
    expect(maskFields({ err })).toEqual({ err: { name: "Error", message: "outer" } });
  });

  it("erişim günlüğü sorgusu: yalnızca izinli anahtarlar (değer maskeli), diğerleri düşer ve sayılır", () => {
    expect(maskAccessPath("/login", "?next=%2Finvite%2FTOK123&q=ayse%40example.com&token=abc")).toEqual({ path: "/login?next=%2Finvite%2F***", droppedParams: 2 });
    expect(maskAccessPath("/api/health", "")).toEqual({ path: "/api/health", droppedParams: 0 });
    expect(maskAccessPath("/invite/TOK123", "?utm=1")).toEqual({ path: "/invite/***", droppedParams: 1 });
    expect(maskAccessPath("/reset-password", "?token=R3s3t")).toEqual({ path: "/reset-password", droppedParams: 1 });
  });
});

describe("T-129 yeniden inceleme: maskeleme boşlukları", () => {
  it("(1) kesme sırrın ortasına düşmez: kesik URL/e-posta/`ad=değer` kuyruğu atılır", () => {
    const pad = "x ".repeat(MAX_LOG_STRING / 2 - 10);
    const cases: Array<[string, RegExp]> = [
      ["postgres://user:supersecretpassword@host/db", /supers|user:/],
      ["john.doe@example.com", /john|doe|exam/],
      ["token=abcdefghijkl", /abcd/],
    ];
    for (const [secret, leak] of cases) {
      for (let cutAt = 1; cutAt < secret.length; cutAt += 1) {
        const input = pad.padEnd(MAX_LOG_STRING - cutAt, "x").replace(/x$/, " ") + secret;
        const out = maskString(input);
        expect(out).toContain("…[truncated]");
        expect(out).not.toMatch(leak);
      }
    }
  });

  it("(1) harf/rakam kuyruğu korunur; kesik kuyruk ayrıştırıcı bir yapı taşıyorsa atılır", () => {
    expect(maskString("a ".repeat(1000) + "b".repeat(100))).toMatch(/b{10}…\[truncated\]$/);
    const cut = maskString("w ".repeat(1020) + "postgres://user:supersecretpass@h/db");
    expect(cut.endsWith("…[truncated]")).toBe(true);
    expect(cut).not.toMatch(/user|supers/);
  });

  it("(2) URL parolasında kodlanmamış / ? # @ : — son @'e kadar maskelenir", () => {
    expect(maskString("postgres://user:ab/cd@host:5432/db")).toBe(`postgres://${MASK}@host:5432/db`);
    expect(maskString("postgres://user:ab?cd@host/db")).toBe(`postgres://${MASK}@host/db`);
    expect(maskString("postgres://user:a/b?c#d@e@host/db x")).toBe(`postgres://${MASK}@host/db x`);
    expect(maskString("https://user:ab/cd@example.com/x")).toBe(`https://${MASK}@example.com/x`);
    expect(maskString("https://user@example.com/x")).toBe(`https://${MASK}@example.com/x`);
    // Yol/sorgudaki `@` ve bağlantı noktası kimlik bilgisi değildir.
    expect(maskString("https://example.com:8080/a@b")).toBe("https://example.com:8080/a@b");
    expect(maskString("https://example.com/p?x=1@2")).toBe("https://example.com/p?x=1@2");
  });

  it("(3) Cookie / Set-Cookie başlığında tüm çerez değerleri maskelenir", () => {
    expect(maskString("Cookie: a=1; better-auth.session_token=ST; theme=dark\nnext line")).toBe(`Cookie: ${MASK}\nnext line`);
    expect(maskString("Set-Cookie: sid=ABC; Path=/; HttpOnly; Secure")).toBe(`Set-Cookie: ${MASK}`);
    expect(maskString("Authorization: Basic dXNlcjpwYXNz, extra")).toBe(`Authorization: ${MASK}`);
  });

  it("(3) boşluklu değer ve %-kodlu belirteç", () => {
    expect(maskString("password=abc def&next=1")).toBe(`password=${MASK}&next=1`);
    expect(maskString("login failed password=abc def ghi")).toBe(`login failed password=${MASK}`);
    expect(maskString("Bearer abc%2Bxyz%3D ok")).toBe(`Bearer ${MASK} ok`);
    expect(maskString("token=ab%2Bcd&x=1")).toBe(`token=${MASK}&x=1`);
    expect(maskString("/login?next=%2Freset-password%3Ftoken%3Dabc%26x%3D1")).not.toContain("abc");
  });

  it("(4) düğüm bütçesi: 50 öğeli kendine-referans dizi < 50 ms ve çıktı sınırlı", () => {
    const a: unknown[] = [];
    for (let i = 0; i < 50; i++) a.push(a);
    const t0 = performance.now();
    const out = maskFields({ a, b: { a } });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
    expect(JSON.stringify(out)).toContain("…[truncated]");
    let nodes = 0;
    const count = (v: unknown): void => {
      nodes++;
      if (Array.isArray(v)) v.forEach(count);
      else if (v !== null && typeof v === "object") Object.values(v).forEach(count);
    };
    count(out);
    expect(nodes).toBeLessThanOrEqual(MAX_NODES + 60);
  });

  it("(4) nesne ANAHTARLARI da maskelenir", () => {
    const out = maskFields({ "ayse@example.com": 1, "/invite/TOK12345": 2, ok: 3 });
    expect(JSON.stringify(out)).not.toMatch(/ayse|TOK12345/);
    expect(out.ok).toBe(3);
  });
});

describe("T-129 son tur: doğrusal URL taraması ve e-posta kuyruğu", () => {
  // Yük altında kırılganlığı azaltmak için 7 grubun EN KÜÇÜK ortalaması (tek çağrı başına ms).
  const perCall = (fn: () => void, n = 10): number => {
    let best = Infinity;
    for (let r = 0; r < 7; r++) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      best = Math.min(best, (performance.now() - t0) / n);
    }
    return best;
  };
  it("kimlik bilgisi içermeyen çok sayıda `://`: dize başına < 2 ms (en iyi grup; boştaki ölçüm ~0,5 ms)", () => {
    for (const input of ["a://".repeat(512), "http://x:y/".repeat(200), "http://x:y/ ".repeat(200), "a://b".repeat(400)]) {
      expect(perCall(() => maskString(input))).toBeLessThan(2);
    }
  });
  it("500 düğüm doldurulmuş maskFields < 50 ms", () => {
    const fields: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) fields[`k${i}`] = Array.from({ length: 50 }, (_v, n) => (n % 2 === 0 ? "x ".repeat(1024) : "a=b&".repeat(512)));
    const t0 = performance.now();
    maskFields(fields);
    expect(performance.now() - t0).toBeLessThan(50);
  });
  it("iç içe URL: yönlendirme parametresindeki kimlik bilgisi yine maskelenir", () => {
    expect(maskString("https://example.com/r?u=postgres://u:p@h/db")).not.toMatch(/u:p@/);
    expect(maskString("a://b a://u:p@h")).toBe(`a://b a://${MASK}@h`);
  });
  it("kesilen düz harf kuyruğu ham metinde `@` ile devam ediyorsa atılır (her kesme noktası)", () => {
    const email = "john.doe@example.com";
    for (let cutAt = 1; cutAt < email.length; cutAt++) {
      const out = maskString(("x ".repeat(2048)).slice(0, MAX_LOG_STRING - cutAt) + email);
      expect(out).not.toMatch(/john|doe|exam/);
    }
    // `@` içermeyen düz kuyruk korunur.
    expect(maskString("a ".repeat(1000) + "b".repeat(100))).toMatch(/b{10}…\[truncated\]$/);
  });
});
