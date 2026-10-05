// @wms/auth birim testleri (T-112): Argon2id parametreleri, ortam doğrulaması, sosyal sağlayıcı bayrağı.
// Bağlantı gerektirmez (createDbClient tembeldir; Better Auth nesnesi bu testte kurulmaz).
import { randomBytes } from "node:crypto";
import { parseOptions } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  AuthConfigError,
  getAuthService,
  hashPassword,
  readAuthEnv,
  socialProvidersFor,
  maskLogText,
  describeError,
  verifyPassword,
} from "./index.ts";

// Sentetik değerler çalışma anında üretilir/birleştirilir (kaynakta sabit sır benzeri dize yok; gitleaks).
const rnd = (): string => randomBytes(18).toString("hex");
const dbUrl = (user: string): string => ["postgresql://", user, ":", rnd(), "@localhost:6432/wms"].join("");
const VALID = {
  BETTER_AUTH_SECRET: rnd(),
  BETTER_AUTH_URL: "http://localhost:3000",
  DATABASE_URL: dbUrl("wms_app"),
  AUTH_DATABASE_URL: dbUrl("wms_auth"),
} as const;

describe("password (Argon2id)", () => {
  it("Argon2id, v19 ve belgelenen maliyet parametreleriyle özetler", async () => {
    const h = await hashPassword(rnd());
    expect(h.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    const p = parseOptions(h);
    expect(p.algorithm).toBe(2); // Argon2id
    expect(p.memoryCost).toBe(ARGON2_PARAMS.memoryCost);
    expect(p.timeCost).toBe(ARGON2_PARAMS.timeCost);
    expect(p.parallelism).toBe(ARGON2_PARAMS.parallelism);
    expect(p.outputLen).toBe(ARGON2_PARAMS.outputLen);
  });

  it("doğru parolayı kabul, yanlışı reddeder; her özet farklı tuz kullanır", async () => {
    const pw = rnd();
    const h1 = await hashPassword(pw);
    const h2 = await hashPassword(pw);
    expect(h1).not.toBe(h2);
    expect(await verifyPassword({ hash: h1, password: pw })).toBe(true);
    expect(await verifyPassword({ hash: h1, password: `${pw}x` })).toBe(false);
  });

  it("bozuk özet ve Argon2id olmayan özet doğrulanmaz", async () => {
    expect(await verifyPassword({ hash: "not-a-hash", password: "x" })).toBe(false);
    // Argon2i ($argon2i$) özeti Argon2id değildir → kabul edilmez (v=19, m=19456,t=2,p=1; sabit tuz/özet).
    const argon2i = ["", "argon2i", "v=19", "m=19456,t=2,p=1", "c29tZXNhbHRzb21lc2FsdA", "A".repeat(43)].join("$");
    expect(await verifyPassword({ hash: argon2i, password: "x" })).toBe(false);
  });
});

describe("readAuthEnv", () => {
  it("geçerli ortamı çözer; bayraklar varsayılan kapalı", () => {
    const e = readAuthEnv(VALID);
    expect(e.baseUrl).toBe(VALID.BETTER_AUTH_URL);
    expect(e.socialEnabled).toBe(false);
    expect(e.requireEmailVerification).toBe(false);
  });

  it("eksik zorunlu değişkenleri ADLARIYLA bildirir, değerleri yazmaz", () => {
    for (const name of Object.keys(VALID)) {
      const env: Record<string, string | undefined> = { ...VALID, [name]: undefined };
      let message = "";
      try {
        readAuthEnv(env);
      } catch (e) {
        expect(e).toBeInstanceOf(AuthConfigError);
        message = (e as Error).message;
      }
      expect(message).toContain(name);
      for (const v of Object.values(VALID)) expect(message).not.toContain(v);
    }
  });

  it("kısa gizi ve geçersiz URL'yi reddeder", () => {
    expect(() => readAuthEnv({ ...VALID, BETTER_AUTH_SECRET: "short" })).toThrow(AuthConfigError);
    expect(() => readAuthEnv({ ...VALID, BETTER_AUTH_URL: "not a url" })).toThrow(AuthConfigError);
    expect(() => readAuthEnv({ ...VALID, BETTER_AUTH_URL: "ftp://x.example" })).toThrow(AuthConfigError);
  });

  it("bayraklar yalnızca tam 'true' ile açılır", () => {
    expect(readAuthEnv({ ...VALID, AUTH_REQUIRE_EMAIL_VERIFICATION: "1" }).requireEmailVerification).toBe(false);
    expect(readAuthEnv({ ...VALID, AUTH_REQUIRE_EMAIL_VERIFICATION: "true" }).requireEmailVerification).toBe(true);
  });

  it("ek güvenilir köken env'i, üretimde http, test sinyali, aynı DB rolü reddedilir", () => {
    expect(() => readAuthEnv({ ...VALID, BETTER_AUTH_TRUSTED_ORIGINS: "https://x.example" })).toThrow(/TRUSTED_ORIGINS/);
    expect(() => readAuthEnv({ ...VALID, NODE_ENV: "production" })).toThrow(/https/);
    const prod = { ...VALID, NODE_ENV: "production", BETTER_AUTH_URL: "https://wms.example" };
    expect(readAuthEnv(prod).production).toBe(true);
    expect(() => readAuthEnv({ ...prod, TEST: "1" })).toThrow(/NODE_ENV=test \/ TEST/);
    expect(() => readAuthEnv({ ...VALID, WMS_ENV: "staging", TEST: "true" })).toThrow(/NODE_ENV=test \/ TEST/);
    expect(() => readAuthEnv({ ...VALID, WMS_ENV: "staging", NODE_ENV: "test" })).toThrow(/NODE_ENV=test \/ TEST/);
    expect(() => readAuthEnv({ ...VALID, AUTH_DATABASE_URL: VALID.DATABASE_URL })).toThrow(/different database roles/);
  });

  it("getAuthService eksik ortamda ilk kullanımda açık hata verir (içe aktarma sırasında değil)", () => {
    expect(() => getAuthService({})).toThrow(AuthConfigError);
  });
});

describe("sosyal sağlayıcılar (A-37)", () => {
  it("bayrak kapalıyken sağlayıcı yok (kimlikler verilse bile)", () => {
    const env = readAuthEnv({ ...VALID, GOOGLE_CLIENT_ID: rnd(), GOOGLE_CLIENT_SECRET: rnd(), MICROSOFT_CLIENT_ID: rnd(), MICROSOFT_CLIENT_SECRET: rnd() });
    expect(socialProvidersFor(env)).toBeUndefined();
  });

  it("bayrak açıkken kimlik eksikse ADLARLA hata", () => {
    expect(() => readAuthEnv({ ...VALID, AUTH_SOCIAL_ENABLED: "true" })).toThrow(/GOOGLE_CLIENT_ID.*MICROSOFT_CLIENT_SECRET/s);
  });

  it("bayrak açık ve kimlikler tam ise iki sağlayıcı eklenir", () => {
    const env = readAuthEnv({
      ...VALID,
      AUTH_SOCIAL_ENABLED: "true",
      GOOGLE_CLIENT_ID: rnd(),
      GOOGLE_CLIENT_SECRET: rnd(),
      MICROSOFT_CLIENT_ID: rnd(),
      MICROSOFT_CLIENT_SECRET: rnd(),
    });
    expect(Object.keys(socialProvidersFor(env) ?? {})).toEqual(["google", "microsoft"]);
  });
});

describe("maskeli günlükleme (G-09)", () => {
  it("sorgu/parametre izi, e-posta, IP ve uzun belirteçler maskelenir", () => {
    expect(maskLogText(`Failed query: select ... params: a@b.example,${rnd()}`)).toBe("database query failed");
    const out = maskLogText(`user a@b.example from 203.0.113.9 token ${rnd()}`);
    expect(out).not.toMatch(/@b\.example|203\.0\.113|[0-9a-f]{24}/);
  });

  it("hata özeti yalnızca sınıf + SQLSTATE içerir", () => {
    const cause = Object.assign(new Error(`secret ${rnd()}`), { code: "42501" });
    const e = new Error(`Failed query params: ${rnd()}`, { cause });
    e.name = "DrizzleQueryError";
    expect(describeError(e)).toBe("DrizzleQueryError sqlstate=42501");
  });
});
