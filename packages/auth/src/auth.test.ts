// @wms/auth birim testleri (T-112): Argon2id parametreleri, ortam doğrulaması, sosyal sağlayıcı bayrağı.
// Bağlantı gerektirmez (createDbClient tembeldir; Better Auth nesnesi bu testte kurulmaz).
import { randomBytes } from "node:crypto";
import { parseOptions } from "@node-rs/argon2";
import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  AuthConfigError,
  AuthStoreError,
  getAuthService,
  hashPassword,
  readAuthEnv,
  socialProvidersFor,
  maskLogText,
  maskedDb,
  describeError,
  shouldSuppressNetworkMeta,
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
    const staging = { ...VALID, WMS_ENV: "staging", BETTER_AUTH_URL: "https://wms-staging.example" };
    expect(readAuthEnv(staging).production).toBe(true);
    expect(() => readAuthEnv({ ...staging, TEST: "true" })).toThrow(/NODE_ENV=test \/ TEST/);
    expect(() => readAuthEnv({ ...staging, NODE_ENV: "test" })).toThrow(/NODE_ENV=test \/ TEST/);
    expect(() => readAuthEnv({ ...VALID, WMS_ENV: "staging" })).toThrow(/https/);
    expect(() => readAuthEnv({ ...VALID, AUTH_DATABASE_URL: VALID.DATABASE_URL })).toThrow(/different database roles/);
    expect(() => readAuthEnv({ ...VALID, WMS_ENV: "prod" })).toThrow(/WMS_ENV must be one of/);
    expect(readAuthEnv({ ...VALID, WMS_ENV: "ci" }).production).toBe(false);
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
    const out = maskLogText(`user a@b.example from 203.0.113.9 and 2001:db8::7334 token ${rnd()}`);
    expect(out).not.toMatch(/@b\.example|203\.0\.113|2001:db8|[0-9a-f]{24}/);
  });

  it("hata özeti yalnızca sınıf + SQLSTATE içerir", () => {
    const cause = Object.assign(new Error(`secret ${rnd()}`), { code: "42501" });
    const e = new Error(`Failed query params: ${rnd()}`, { cause });
    e.name = "DrizzleQueryError";
    expect(describeError(e)).toBe("DrizzleQueryError sqlstate=42501");
  });
});

describe("maskedDb (drizzle istemci maskeleyici)", () => {
  // DrizzleQueryError biçimi: errors.js:9-20 — mesajda sorgu + params, `params`/`query` alanları, cause.
  class DrizzleQueryError extends Error {
    readonly query: string;
    readonly params: unknown[];
    constructor(query: string, params: unknown[], cause: Error) {
      super(`Failed query: ${query}\nparams: ${params.join(",")}`);
      this.query = query;
      this.params = params;
      this.cause = cause;
    }
  }
  const secret = rnd();
  const pgError = Object.assign(new Error("permission denied"), { code: "42501" });
  const boom = (): DrizzleQueryError => new DrizzleQueryError("select 1", [secret], pgError);
  interface Chain extends PromiseLike<unknown> {
    where(): Chain;
    prepare(): { execute(): Promise<unknown> };
  }
  const thenable = (fail: boolean): Chain => ({
    then: ((f, r) => (fail ? Promise.reject(boom()) : Promise.resolve([1])).then(f, r)) as PromiseLike<unknown>["then"],
    where: () => thenable(fail),
    prepare: () => ({ execute: () => (fail ? Promise.reject(boom()) : Promise.resolve([1])) }),
  });
  const fakeTx = { execute: () => Promise.reject(boom()) };
  const fake = {
    select: () => ({ from: () => thenable(true) }),
    with: () => ({ select: () => ({ from: () => thenable(true) }) }),
    execute: () => Promise.reject(boom()),
    transaction: (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx),
    query: {},
    $client: {},
    _: {},
  };

  async function captured(p: () => Promise<unknown>): Promise<unknown> {
    try {
      await p();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  function expectMasked(e: unknown): void {
    expect(e).toBeInstanceOf(AuthStoreError);
    const err = e as AuthStoreError;
    expect(err.name).toBe("AuthStoreError");
    expect(err.errorName).toBe("DrizzleQueryError");
    expect(err.sqlstate).toBe("42501");
    expect(err.cause).toBeUndefined();
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain("Failed query");
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(Object.keys(err)).not.toContain("params");
    expect(Object.keys(err)).not.toContain("query");
  }

  it("execute, builder zinciri, prepare().execute() ve with() hataları parametresiz AuthStoreError olur", async () => {
    const db = maskedDb(fake);
    expectMasked(await captured(() => Promise.resolve(db.execute())));
    expectMasked(await captured(() => Promise.resolve(db.select().from())));
    expectMasked(await captured(async () => db.select().from().where()));
    expectMasked(await captured(() => db.select().from().where().prepare().execute()));
    expectMasked(await captured(async () => db.with().select().from()));
    // catch/finally yolu (QueryPromise.catch then'i hedef üzerinden çağırır)
    const viaCatch = await Promise.resolve(db.select().from()).catch((e: unknown) => e);
    expectMasked(viaCatch);
  });

  it("transaction: tx sorgu hatası maskeli; APIError aynen geçer (geri alım için)", async () => {
    const db = maskedDb(fake);
    expectMasked(await captured(() => Promise.resolve(db.transaction((tx) => tx.execute()))));
    const api = new APIError("BAD_REQUEST", { message: "x", code: "X" });
    const e = await captured(() => Promise.resolve(db.transaction(() => Promise.reject(api))));
    expect(e).toBe(api);
    // Sürücü dışı sıradan hata da sınıf adıyla AuthStoreError olur, mesajı atılır.
    const plain = await captured(() => Promise.resolve(db.transaction(() => Promise.reject(new TypeError(`leak ${secret}`)))));
    expect(plain).toBeInstanceOf(AuthStoreError);
    expect((plain as AuthStoreError).errorName).toBe("TypeError");
    expect((plain as Error).message).not.toContain(secret);
  });

  it("query, $client ve _ erişimi fail-closed", () => {
    const db = maskedDb(fake);
    expect(() => db.query).toThrow(AuthStoreError);
    expect(() => db.$client).toThrow(AuthStoreError);
    expect(() => db._).toThrow(AuthStoreError);
  });
});

describe("shouldSuppressNetworkMeta (A-43/ADR-016 §10, T-112e)", () => {
  const DOMAIN = "demo.example.test";
  const demoId = "11111111-1111-4111-8111-111111111111";
  const realId = "22222222-2222-4222-8222-222222222222";
  const lookup = (id: string): Promise<string | null> =>
    Promise.resolve(id === demoId ? `picker@${DOMAIN}` : id === realId ? "kisi@example.org" : null);
  const decide = (userId: string | null, requestEmail?: string, domain: string | null = DOMAIN, explicit?: boolean) =>
    shouldSuppressNetworkMeta(domain, { userId, requestEmail, lookupEmail: lookup, explicit });

  it("başarılı giriş / çıkış (oturum kullanıcısı): demo bastırılır, demo olmayan korunur", async () => {
    expect(await decide(demoId)).toBe(true);
    expect(await decide(realId)).toBe(false);
  });

  it("başarısız giriş: bilinen demo kullanıcısı ve var olmayan demo adresi bastırılır; diğerleri korunur", async () => {
    expect(await decide(demoId, `picker@${DOMAIN}`)).toBe(true);
    expect(await decide(null, `yok-${rnd().slice(0, 6)}@${DOMAIN.toUpperCase()}`)).toBe(true);
    expect(await decide(realId, "kisi@example.org")).toBe(false);
    expect(await decide(null, "yok@example.org")).toBe(false);
    expect(await decide(null)).toBe(false);
  });

  it("açık bayrak her zaman bastırır; demo alanı tanımsızsa davranış değişmez", async () => {
    expect(await decide(realId, undefined, DOMAIN, true)).toBe(true);
    expect(await decide(demoId, `picker@${DOMAIN}`, null)).toBe(false);
  });

  it("kullanıcı araması başarısızsa gizlilik lehine bastırır", async () => {
    const seen: unknown[] = [];
    const r = await shouldSuppressNetworkMeta(DOMAIN, {
      userId: realId,
      lookupEmail: () => Promise.reject(new Error("db")),
      onLookupError: (e) => seen.push(e),
    });
    expect(r).toBe(true);
    expect(seen).toHaveLength(1); // sessiz yutulmaz (G-07)
  });
});
