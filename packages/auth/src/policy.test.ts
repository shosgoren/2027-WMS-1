// @wms/auth politika birim testleri (T-112b): IP çözümleyici, demo tanıma, mutlak ömür, kural tablosu,
// ek alan/kapalı uç yapılandırması, davetle hesap açma (sahte bağımlılıklarla). Bağlantı gerektirmez.
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DB_CLIENT_SETTINGS, createDbClient } from "@wms/db/internal";
import { AuthConfigError, createAuth, inspectAuthOptions, readAuthEnv } from "./index.ts";
import type { AuthOptionsSnapshot, AuthService } from "./index.ts";
import {
  DEMO_FORBIDDEN_PATHS,
  EMAIL_RATE_RULES,
  InvitedAccountError,
  SESSION_ABSOLUTE_MAX_SEC,
  createInvitedAccountWith,
  emailRateKey,
  isDemoEmail,
  parseDemoDomain,
  resolveClientIp,
  sessionAbsoluteExpired,
  signupAllowed,
} from "./policy.ts";
import type { InvitedAccountDeps } from "./policy.ts";
import { principalIdentityFlags } from "./index.ts";

const rnd = (): string => randomBytes(18).toString("hex");
const dbUrl = (user: string): string => ["postgresql://", user, ":", rnd(), "@localhost:6432/wms"].join("");
const BASE_ENV = {
  BETTER_AUTH_SECRET: rnd(),
  BETTER_AUTH_URL: "http://localhost:3000",
  DATABASE_URL: dbUrl("wms_app"),
  AUTH_DATABASE_URL: dbUrl("wms_auth"),
} as const;

describe("resolveClientIp", () => {
  it("yalnızca Fly-Client-IP; sahte X-Forwarded-For / X-Real-IP yok sayılır", () => {
    const h = new Headers({ "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.10" });
    expect(resolveClientIp(h)).toBeNull();
    h.set("fly-client-ip", "203.0.113.5");
    expect(resolveClientIp(h)).toBe("203.0.113.5");
    expect(resolveClientIp(new Headers({ "fly-client-ip": "2001:db8::1" }))).toBe("2001:db8::1");
  });
  it("geçersiz değer / başlıksız → null", () => {
    expect(resolveClientIp(new Headers({ "fly-client-ip": "not-an-ip" }))).toBeNull();
    expect(resolveClientIp(undefined)).toBeNull();
  });
});

describe("kayıt kapısı", () => {
  it("yalnızca SIGNUP_ENABLED=true ve WMS_ENV local|ci", () => {
    expect(signupAllowed("local", "true")).toBe(true);
    expect(signupAllowed("ci", "true")).toBe(true);
    expect(signupAllowed("staging", "true")).toBe(false);
    expect(signupAllowed("production", "true")).toBe(false);
    expect(signupAllowed(undefined, "true")).toBe(false);
    expect(signupAllowed("local", "1")).toBe(false);
    expect(signupAllowed("local", undefined)).toBe(false);
  });
  it("readAuthEnv: staging'de SIGNUP_ENABLED=true yapılandırma hatası; local'de açık", () => {
    expect(() => readAuthEnv({ ...BASE_ENV, WMS_ENV: "staging", SIGNUP_ENABLED: "true" })).toThrow(AuthConfigError);
    expect(readAuthEnv({ ...BASE_ENV, WMS_ENV: "local", SIGNUP_ENABLED: "true" }).signupEnabled).toBe(true);
    expect(readAuthEnv({ ...BASE_ENV }).signupEnabled).toBe(false);
  });
});

describe("demo e-posta tanıma", () => {
  const domain = parseDemoDomain("Example.Invalid");
  it("alan adı normalize edilir; geçersiz → null", () => {
    expect(domain).toBe("example.invalid");
    expect(parseDemoDomain("not a domain")).toBeNull();
    expect(parseDemoDomain(undefined)).toBeNull();
  });
  it("tam alan adı eşleşmesi, büyük/küçük harf duyarsız; alt dize/son ek yanıltması yok", () => {
    expect(isDemoEmail("a@example.invalid", domain)).toBe(true);
    expect(isDemoEmail("A@EXAMPLE.INVALID", domain)).toBe(true);
    expect(isDemoEmail("a@evil-example.invalid", domain)).toBe(false);
    expect(isDemoEmail("a@example.invalid.evil.com", domain)).toBe(false);
    expect(isDemoEmail("example.invalid", domain)).toBe(false);
    expect(isDemoEmail("a@example.invalid", null)).toBe(false);
    expect(isDemoEmail(null, domain)).toBe(false);
  });
  it("kapalı uç listesi kart maddesindeki uçları içerir", () => {
    for (const p of ["/list-sessions", "/revoke-session", "/revoke-sessions", "/update-user", "/change-email", "/change-password", "/two-factor/enable", "/two-factor/disable", "/delete-user"]) {
      expect(DEMO_FORBIDDEN_PATHS).toContain(p);
    }
  });
});

describe("mutlak oturum ömrü (A-39)", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  it("7 gün içinde geçerli, sınırı aşınca süresi dolmuş", () => {
    expect(SESSION_ABSOLUTE_MAX_SEC).toBe(604800);
    expect(sessionAbsoluteExpired(new Date(now.getTime() - 6 * 86400_000), now)).toBe(false);
    expect(sessionAbsoluteExpired(new Date(now.getTime() - 604800_000), now)).toBe(false);
    expect(sessionAbsoluteExpired(new Date(now.getTime() - 604801_000), now)).toBe(true);
  });
  it("bozuk zaman damgası fail-closed", () => {
    expect(sessionAbsoluteExpired(new Date("invalid"), now)).toBe(true);
  });
});

describe("kural tablosu (A-41)", () => {
  it("e-posta başına: 5 başarısız / 15 dk; sıfırlama 5 / saat", () => {
    expect(EMAIL_RATE_RULES.failedSignIn).toEqual({ window: 900, max: 5 });
    expect(EMAIL_RATE_RULES.passwordReset).toEqual({ window: 3600, max: 5 });
  });
  it("anahtar e-postayı normalize eder (büyük harf aynı kovaya düşer)", () => {
    expect(emailRateKey("signin-fail", " A@B.Invalid ")).toBe(emailRateKey("signin-fail", "a@b.invalid"));
    expect(emailRateKey("signin-fail", "a@b.invalid")).not.toBe(emailRateKey("pwd-reset", "a@b.invalid"));
  });
});

describe("etkin Better Auth yapılandırması (auth.options; ADR-014 4. tur, MAJOR-2)", () => {
  const social = {
    GOOGLE_CLIENT_ID: rnd(),
    GOOGLE_CLIENT_SECRET: rnd(),
    MICROSOFT_CLIENT_ID: rnd(),
    MICROSOFT_CLIENT_SECRET: rnd(),
    AUTH_SOCIAL_ENABLED: "true",
  };
  const make = (extra: Record<string, string> = {}): AuthService => {
    const e = readAuthEnv({ ...BASE_ENV, ...extra });
    const mk = (url: string) => createDbClient({ url, ...DB_CLIENT_SETTINGS });
    return createAuth({ client: mk(e.authDatabaseUrl), env: e });
  };
  const build = (extra: Record<string, string> = {}): AuthOptionsSnapshot => inspectAuthOptions(make(extra));

  it("mfaVerifiedAt / invitationClaimId input:false; /update-session ve /verify-password kapalı", () => {
    const o = build();
    expect(o.session?.additionalFields?.mfaVerifiedAt?.input).toBe(false);
    expect(o.user?.additionalFields?.invitationClaimId?.input).toBe(false);
    expect(o.disabledPaths).toContain("/update-session");
    expect(o.disabledPaths).toContain("/verify-password");
  });
  it("hesap bağlama kapalı, köken/CSRF denetimi açık, hız sınırı açık, kayıt varsayılan kapalı", () => {
    const o = build();
    expect(o.account?.accountLinking?.enabled).toBe(false);
    expect(o.advanced?.disableOriginCheck).toBe(false);
    expect(o.advanced?.disableCSRFCheck).toBe(false);
    expect(o.rateLimit?.enabled).toBe(true);
    expect(o.emailAndPassword?.disableSignUp).toBe(true);
    expect(o.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    expect(o.advanced?.ipAddress?.ipAddressHeaders).toEqual(["fly-client-ip"]);
    expect(build({ WMS_ENV: "local", SIGNUP_ENABLED: "true" }).emailAndPassword?.disableSignUp).toBe(false);
  });
  const gate = (o: AuthOptionsSnapshot, name: "google" | "microsoft") => o.socialProviders?.[name];
  it("anlık görüntü: gizsiz, dondurulmuş ve canlı yapılandırmadan ayrık (mutasyon denemesi etkisiz)", () => {
    const svc = make(social);
    const snap = inspectAuthOptions(svc);
    const text = JSON.stringify(snap);
    for (const v of [social.GOOGLE_CLIENT_ID, social.GOOGLE_CLIENT_SECRET, social.MICROSOFT_CLIENT_ID, social.MICROSOFT_CLIENT_SECRET, BASE_ENV.BETTER_AUTH_SECRET]) expect(text).not.toContain(v);
    expect(Object.keys(snap)).not.toContain("secret");
    expect(Object.keys(snap)).not.toContain("database");
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.disabledPaths)).toBe(true);
    expect(Object.isFrozen(snap.session?.additionalFields?.mfaVerifiedAt)).toBe(true);
    // Mutasyon denemesi (dondurulmuş nesne → katı modda TypeError) canlı yapılandırmayı etkilemez.
    expect(() => {
      (snap.disabledPaths as string[]).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (snap.session?.additionalFields?.mfaVerifiedAt as { input?: boolean }).input = true;
    }).toThrow(TypeError);
    const again = inspectAuthOptions(svc);
    expect(again).not.toBe(snap);
    expect(again.disabledPaths).toContain("/update-session");
    expect(again.session?.additionalFields?.mfaVerifiedAt?.input).toBe(false);
  });
  it("sosyal sağlayıcılar: kayıt kapısı kapalıyken disableSignUp (istemci requestSignUp ile aşılamaz) + disableImplicitSignUp", () => {
    const o = build(social);
    for (const name of ["google", "microsoft"] as const) {
      const p = gate(o, name);
      expect(p?.disableSignUp).toBe(true);
      expect(p?.disableImplicitSignUp).toBe(true);
    }
    const open = build({ ...social, WMS_ENV: "local", SIGNUP_ENABLED: "true" });
    expect(gate(open, "google")?.disableSignUp).toBe(false);
    expect(gate(open, "google")?.disableImplicitSignUp).toBe(true);
    expect(build().socialProviders).toBeUndefined();
  });
});

describe("createInvitedAccountWith", () => {
  const claimId = randomUUID();
  const password = `P${rnd()}`;
  type Row = Record<string, unknown>;
  function deps(opts: { invite?: Row[]; users?: Row[]; failCreate?: boolean }): { d: InvitedAccountDeps; created: Row[] } {
    const created: Row[] = [];
    const users = [...(opts.users ?? [])];
    let call = 0;
    const d: InvitedAccountDeps = {
      db: {
        execute: (() => {
          call += 1;
          // 1. çağrı: davet işlevi; sonrakiler: users araması.
          return Promise.resolve(call === 1 ? (opts.invite ?? []) : users);
        }) as unknown as InvitedAccountDeps["db"]["execute"],
      },
      passwordMinLength: 12,
      passwordMaxLength: 128,
      hashPassword: (p) => Promise.resolve(`hash:${p.length}`),
      newId: () => "11111111-1111-4111-8111-111111111111",
      createUserWithPassword: (data) => {
        if (opts.failCreate === true) return Promise.reject(new Error("boom"));
        created.push({ ...data });
        return Promise.resolve();
      },
    };
    return { d, created };
  }
  const input = { invitationTokenHash: "h", claimId, name: "Ad", password };

  it("işlev satır döndürmezse NOT_FOUND ve hesap açılmaz", async () => {
    const { d, created } = deps({ invite: [] });
    await expect(createInvitedAccountWith(d, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(created).toHaveLength(0);
  });
  it("e-posta ve doğrulama işlevden gelir: EMAIL → verified, SCREEN → değil", async () => {
    const a = deps({ invite: [{ email_normalized: "x@example.invalid", delivered_via: "EMAIL" }] });
    await createInvitedAccountWith(a.d, input);
    expect(a.created[0]).toMatchObject({ email: "x@example.invalid", emailVerified: true, invitationClaimId: claimId });
    const b = deps({ invite: [{ email_normalized: "x@example.invalid", delivered_via: "SCREEN" }] });
    await createInvitedAccountWith(b.d, input);
    expect(b.created[0]).toMatchObject({ emailVerified: false });
  });
  it("aynı claim → yeniden kullanım; farklı claim → FORBIDDEN", async () => {
    const invite = [{ email_normalized: "x@example.invalid", delivered_via: "EMAIL" }];
    const same = deps({ invite, users: [{ id: "u1", invitation_claim_id: claimId }] });
    await expect(createInvitedAccountWith(same.d, input)).resolves.toEqual({ userId: "u1", reused: true });
    const other = deps({ invite, users: [{ id: "u2", invitation_claim_id: randomUUID() }] });
    await expect(createInvitedAccountWith(other.d, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const none = deps({ invite, users: [{ id: "u3", invitation_claim_id: null }] });
    await expect(createInvitedAccountWith(none.d, input)).rejects.toBeInstanceOf(InvitedAccountError);
  });
  it("girdi doğrulaması: kısa parola, bozuk claimId → VALIDATION_FAILED", async () => {
    const { d } = deps({});
    await expect(createInvitedAccountWith(d, { ...input, password: "short" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createInvitedAccountWith(d, { ...input, claimId: "x" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("yazım hatası yayılır (telafi/silme kodu yok)", async () => {
    const { d } = deps({ invite: [{ email_normalized: "x@example.invalid", delivered_via: "EMAIL" }], failCreate: true });
    await expect(createInvitedAccountWith(d, input)).rejects.toThrow("boom");
  });
});

describe("Principal alanları (T-118: isDemo, twoFactorEnabled)", () => {
  const domain = "example.invalid";
  it("isDemo isDemoEmail ile aynı kuralı kullanır", () => {
    expect(principalIdentityFlags({ email: "A@EXAMPLE.INVALID", twoFactorEnabled: false }, domain).isDemo).toBe(true);
    expect(principalIdentityFlags({ email: "a@evil-example.invalid" }, domain).isDemo).toBe(false);
    expect(principalIdentityFlags({ email: "a@example.invalid" }, null).isDemo).toBe(false);
  });
  it("twoFactorEnabled yalnızca tam true iken true", () => {
    expect(principalIdentityFlags({ email: "a@x.com", twoFactorEnabled: true }, null).twoFactorEnabled).toBe(true);
    expect(principalIdentityFlags({ email: "a@x.com", twoFactorEnabled: false }, null).twoFactorEnabled).toBe(false);
    expect(principalIdentityFlags({ email: "a@x.com", twoFactorEnabled: null }, null).twoFactorEnabled).toBe(false);
    expect(principalIdentityFlags({ email: "a@x.com" }, null).twoFactorEnabled).toBe(false);
  });
});
