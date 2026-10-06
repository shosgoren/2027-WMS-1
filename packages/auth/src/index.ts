// `@wms/auth` — Better Auth 1.7.7 kimlik katmanı (T-112, ADR-014).
//
// - Yalnızca platform kimlik tablolarına (`users`, `sessions`, `accounts`, `verifications`, `two_factors`,
//   `auth_rate_limits`) ve `wms_auth` rolüyle yazar (ADR-014 §10): `client` = `AUTH_DATABASE_URL`.
//   `security_events` kimlik olayları (login_*, logout, password_*, two_factor_*, reauth.*) da `wms_auth` ile yazılır
//   (T-112c, migration 0005: `wms_app` bu sınıfı yazamaz); `wms_auth`'ın SELECT yetkisi yoktur → `returning: false`.
// - Better Auth nesnesi paket dışına çıkmaz; yalnızca `handler` (route) ve dar yüzey: `getPrincipal`,
//   `requireRecentAuth`, `reauthenticate`, `revokeUserSessions`.
// - Ortam doğrulaması tembeldir (ilk kullanımda): `next build` bu değişkenler olmadan geçer (G-07: eksikse
//   çalışma anında açık hata, değer asla yazılmaz — G-09).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx, isAPIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { sql } from "drizzle-orm";
import { DB_CLIENT_SETTINGS, createDbClient, rawDb } from "@wms/db/internal";
import type { DbClient } from "@wms/db/internal";
import * as schema from "@wms/db/internal/schema";
import { recordSecurityEvent } from "@wms/db";
import { hashPassword, verifyPassword } from "./password.ts";
import {
  DEMO_FORBIDDEN_PATHS,
  DISABLED_PATHS,
  EMAIL_RATE_RULES,
  InvitedAccountError,
  SESSION_ADDITIONAL_FIELDS,
  USER_ADDITIONAL_FIELDS,
  createInvitedAccountWith,
  emailRateKey,
  isDemoEmail,
  parseDemoDomain,
  resolveClientIp,
  sessionAbsoluteExpired,
  signupAllowed,
} from "./policy.ts";
import type { CreateInvitedAccountInput } from "./policy.ts";

export { ARGON2_PARAMS, hashPassword, verifyPassword } from "./password.ts";
export { InvitedAccountError } from "./policy.ts";
export type { CreateInvitedAccountInput } from "./policy.ts";

// ---------------------------------------------------------------------------------------------
// Hatalar
// ---------------------------------------------------------------------------------------------

/** Eksik/bozuk ortam yapılandırması. Mesaj yalnızca değişken ADLARINI içerir (G-09). */
export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

/** Parola sıfırlama e-postası bu kartta bağlı değildir (A-42; T-116/T-117'ye kadar). */
export class MailDeliveryDisabledError extends Error {
  override name = "MailDeliveryDisabledError";
  readonly code = "MAIL_DELIVERY_DISABLED";
  constructor() {
    super("MAIL_DELIVERY_DISABLED");
  }
}

/** `requireRecentAuth` reddi. Kod, docs/spec/15-engineering.md listesindendir. */
export class AuthError extends Error {
  override name = "AuthError";
  readonly code: "UNAUTHENTICATED";
  readonly reason: "REAUTH_REQUIRED";
  constructor(reason: "REAUTH_REQUIRED") {
    super(`UNAUTHENTICATED: ${reason}`);
    this.code = "UNAUTHENTICATED";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------------------
// Ortam
// ---------------------------------------------------------------------------------------------

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface AuthEnv {
  readonly secret: string;
  readonly baseUrl: string;
  /** `wms_app` (DATABASE_URL): yalnızca yapılandırma doğrulaması (rol ayrımı); bu pakette bağlantı açılmaz (T-112c). */
  readonly databaseUrl: string;
  /** `wms_auth` (AUTH_DATABASE_URL): Better Auth tabloları. */
  readonly authDatabaseUrl: string;
  /** `NODE_ENV=production` veya `WMS_ENV` staging/production: istemci IP başlığı ve https zorunlu. */
  readonly production: boolean;
  readonly socialEnabled: boolean;
  readonly requireEmailVerification: boolean;
  /** `SIGNUP_ENABLED=true` ve `WMS_ENV` local|ci (A-50). */
  readonly signupEnabled: boolean;
  /** `DEMO_EMAIL_DOMAIN` (A-43); tanımsızsa `null` (demo kısıtı yok). */
  readonly demoEmailDomain: string | null;
  /** `AUTH_EMAIL_RECOVERY_ENABLED` (A-55, ADR-014 4. tur MINOR-5): yalnızca tam `"true"` iken açık; varsayılan KAPALI. */
  readonly emailRecoveryEnabled: boolean;
  readonly google: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly microsoft: { readonly clientId: string; readonly clientSecret: string } | null;
}

/** Better Auth gizi için asgari uzunluk (kütüphane de 32 altını uyarır). */
export const MIN_SECRET_LENGTH = 32;

function nonEmpty(env: EnvSource, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v;
}

/** Bayrak yalnızca tam `"true"` iken açıktır; tanımsız/başka her değer kapalı (A-37, A-50). */
function flag(env: EnvSource, name: string): boolean {
  return env[name] === "true";
}

const KNOWN_WMS_ENV: readonly string[] = ["local", "ci", "staging", "production"];

export function readAuthEnv(env: EnvSource): AuthEnv {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = nonEmpty(env, name);
    if (v === undefined) missing.push(name);
    return v ?? "";
  };
  const secret = need("BETTER_AUTH_SECRET");
  const baseUrl = need("BETTER_AUTH_URL");
  const databaseUrl = need("DATABASE_URL");
  const authDatabaseUrl = need("AUTH_DATABASE_URL");
  const socialEnabled = flag(env, "AUTH_SOCIAL_ENABLED");
  const google = socialEnabled ? provider(env, "GOOGLE", missing) : null;
  const microsoft = socialEnabled ? provider(env, "MICROSOFT", missing) : null;
  if (missing.length > 0) {
    throw new AuthConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new AuthConfigError("BETTER_AUTH_URL is not a valid URL");
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new AuthConfigError("BETTER_AUTH_URL must use http or https");
  }
  if (env.WMS_ENV !== undefined && !KNOWN_WMS_ENV.includes(env.WMS_ENV)) {
    throw new AuthConfigError(`WMS_ENV must be one of: ${KNOWN_WMS_ENV.join(", ")}`);
  }
  const production =
    env.NODE_ENV === "production" || env.WMS_ENV === "staging" || env.WMS_ENV === "production";
  if (production && protocol !== "https:") {
    throw new AuthConfigError("BETTER_AUTH_URL must use https in production or staging");
  }
  // ADR-014 §8: yalnızca uygulamanın kendi kökeni güvenilir; ortamdan ek köken kabul edilmez.
  if (nonEmpty(env, "BETTER_AUTH_TRUSTED_ORIGINS") !== undefined) {
    throw new AuthConfigError("BETTER_AUTH_TRUSTED_ORIGINS is not allowed (ADR-014 section 8)");
  }
  // Better Auth `isTest()` (core env-impl.mjs:36) NODE_ENV=test veya TEST (boş/"false" dışı) ile açılır;
  // üretim/staging'de bu sinyaller kabul edilmez (köken denetimi ayrıca açıkça zorlanır).
  const testSignal = env.NODE_ENV === "test" || (nonEmpty(env, "TEST") !== undefined && env.TEST !== "false");
  if (production && testSignal) {
    throw new AuthConfigError("NODE_ENV=test / TEST is not allowed in production or staging");
  }
  if (dbUser(databaseUrl) === dbUser(authDatabaseUrl)) {
    throw new AuthConfigError("DATABASE_URL and AUTH_DATABASE_URL must use different database roles (ADR-014 section 10)");
  }
  // A-50: self-servis kayıt yalnızca local/ci'da açılabilir; başka ortamda bayrak = yapılandırma hatası.
  if (flag(env, "SIGNUP_ENABLED") && !signupAllowed(env.WMS_ENV, env.SIGNUP_ENABLED)) {
    throw new AuthConfigError("SIGNUP_ENABLED=true is only allowed when WMS_ENV is local or ci (A-50)");
  }
  const demoRaw = nonEmpty(env, "DEMO_EMAIL_DOMAIN");
  const demoEmailDomain = parseDemoDomain(demoRaw);
  if (demoRaw !== undefined && demoEmailDomain === null) {
    throw new AuthConfigError("DEMO_EMAIL_DOMAIN is not a valid domain name");
  }
  return {
    secret,
    baseUrl,
    databaseUrl,
    authDatabaseUrl,
    production,
    socialEnabled,
    requireEmailVerification: flag(env, "AUTH_REQUIRE_EMAIL_VERIFICATION"),
    signupEnabled: signupAllowed(env.WMS_ENV, env.SIGNUP_ENABLED),
    demoEmailDomain,
    emailRecoveryEnabled: flag(env, "AUTH_EMAIL_RECOVERY_ENABLED"),
    google,
    microsoft,
  };
}

function dbUser(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    throw new AuthConfigError("DATABASE_URL / AUTH_DATABASE_URL is not a valid URL");
  }
}

function provider(env: EnvSource, prefix: string, missing: string[]): { clientId: string; clientSecret: string } | null {
  const idName = `${prefix}_CLIENT_ID`;
  const secretName = `${prefix}_CLIENT_SECRET`;
  const clientId = nonEmpty(env, idName);
  const clientSecret = nonEmpty(env, secretName);
  if (clientId === undefined) missing.push(idName);
  if (clientSecret === undefined) missing.push(secretName);
  return clientId !== undefined && clientSecret !== undefined ? { clientId, clientSecret } : null;
}

// ---------------------------------------------------------------------------------------------
// Sabitler (A-39, A-41)
// ---------------------------------------------------------------------------------------------

export const SESSION_EXPIRES_IN_SEC = 12 * 60 * 60; // A-39: kayan süre 12 saat
export const SESSION_UPDATE_AGE_SEC = 15 * 60; // A-39: yenileme aralığı 15 dakika
export const PASSWORD_MIN_LENGTH = 12; // A-41
export const PASSWORD_MAX_LENGTH = 128; // A-41
export const REAUTH_WINDOW_SEC = 10 * 60; // A-39: hassas işlem yeniden doğrulama penceresi

/** Hız sınırı kuralları (A-41); anahtar = IP + yol. E-posta başına kurallar `EMAIL_RATE_RULES` (policy.ts). */
export const RATE_LIMIT_RULES = Object.freeze({
  general: { window: 60, max: 300 },
  signIn: { window: 10 * 60, max: 10 },
  passwordReset: { window: 60 * 60, max: 5 },
  twoFactor: { window: 10 * 60, max: 10 },
});

/** 2FA: A-41 — 5 hatalı kod → 15 dk kilit (Better Auth `accountLockout`, kullanıcı başına). */
export const TWO_FACTOR_LOCKOUT = Object.freeze({ enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 });

let dummyHash: Promise<string> | undefined;
/** Sabit maliyetli sahte doğrulama için süreç başına bir kez üretilen geçerli Argon2id özeti (rastgele parola; saklanmaz). */
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("hex"));
  return dummyHash;
}

/** Yönetici kaynaklı sıfırlama bağlantısı geçerliliği (A-42: 30 dakika, tek kullanımlık). */
export const ADMIN_RESET_TTL_SEC = 30 * 60;
/**
 * Yönetici belirteci işareti (ADR-016 3. tur m1): belirteç `adm_<ihraç eden tenant (32 hex)>_<rastgele>`. Better Auth'un
 * kendi (self-servis) belirteci `generateId(24)` alfanümeriktir, `_` içermez → bu önek taklit edilemez. İşaret
 * `/reset-password` akışını bozmaz (kimlik = `reset-password:<belirteç>`; password.mjs:152-155).
 */
const ADMIN_TOKEN_RE = /^adm_[0-9a-f]{32}_/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `verification.storeIdentifier.hash` (init-options.d.mts:23-25): varsayılan "hashed" ile AYNI (SHA-256, base64url;
 * verification-token-storage.mjs:4-7) — yalnızca yönetici belirteçlerinin kimliği `reset-password:` önekini korur
 * (`wms_probe.consume_admin_reset_grant` kayıt kimliğinin bu önekle başladığını denetler, 0003). Düz belirteç DB'de yok;
 * self-servis kayıtlar önekli DEĞİLDİR (böylece hiçbir zaman grant ile eşleşemez).
 */
export function hashVerificationIdentifier(identifier: string): string {
  const digest = createHash("sha256").update(identifier, "utf8").digest("base64url");
  return identifier.startsWith("reset-password:") && ADMIN_TOKEN_RE.test(identifier.slice("reset-password:".length))
    ? `reset-password:${digest}`
    : digest;
}

/** Yeniden doğrulama olayları (T-112c); yazımı DB'de yalnızca wms_auth'a açık sınıf (`reauth.`). */
const REAUTH_EVENT = Object.freeze({ succeeded: "reauth.succeeded", failed: "reauth.failed" });

const SECURITY_EVENT = Object.freeze({
  loginSucceeded: "login_succeeded",
  loginFailed: "login_failed",
  loginMfaPending: "login_mfa_pending",
  logout: "logout",
  passwordChanged: "password_changed",
  passwordReset: "password_reset",
  twoFactorEnabled: "two_factor_enabled",
  twoFactorDisabled: "two_factor_disabled",
  twoFactorFailed: "two_factor_failed",
});

// ---------------------------------------------------------------------------------------------
// Dar yüzey
// ---------------------------------------------------------------------------------------------

export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  /** Oturum oluşturma zamanı (son kimlik doğrulama; yeniden doğrulama kaydı T-112c). */
  readonly authenticatedAt: Date;
  /** Oturum düzeyi MFA: `sessions.mfa_verified_at IS NOT NULL` (ADR-014 §12). */
  readonly mfaVerified: boolean;
}

export interface CreateInvitedAccountResult {
  readonly userId: string;
  /** Aynı `claimId` ile daha önce açılmış hesap yeniden kullanıldı. */
  readonly reused: boolean;
}

/** Self-servis sıfırlama e-postası bağdaştırıcısı (T-117b; A-42). Kuyruk/mühür `packages/domain` tarafındadır. */
export interface ResetMailPort {
  canDeliver(recipient: string): boolean;
  /** `email.send` işini `enqueuePlatform` ile yazar; belirteç/bağlantı yalnızca mühürlü yükte yaşar. */
  sendResetLink(input: { readonly to: string; readonly link: string; readonly locale: "tr" | "en" }): Promise<void>;
}

export interface AdminResetToken {
  /** Düz belirteç: yalnızca bellekte; yalnızca yöneticiye döner. */
  readonly token: string;
  readonly verificationId: string;
  readonly expiresAt: Date;
}

export interface AuthService {
  /** Route handler girişi (`/api/auth/*`). */
  handler(request: Request): Promise<Response>;
  /** Çerezli istekten kimlik; oturum yok/iptal/süresi dolmuş → `null`. Her çağrıda DB'den doğrulanır. */
  getPrincipal(headers: Headers): Promise<Principal | null>;
  /** Kimlik doğrulaması `maxAgeSec` içinde değilse `AuthError` (UNAUTHENTICATED). Zaman DB `now()` ile. */
  requireRecentAuth(principal: Principal, maxAgeSec: number): Promise<void>;
  /**
   * Çerezli istekte kimlik doğrulaması `REAUTH_WINDOW_SEC` (A-39) içinde değilse `AuthError` (`REAUTH_REQUIRED`); oturum
   * yoksa da aynı (yeniden giriş gerekir). Web eylemleri `requireRecentAuth` yerine bunu çağırır (T-117b).
   */
  ensureRecentAuth(headers: Headers): Promise<void>;
  /**
   * Yeniden doğrulama (T-112c): oturumun sahibi parolayı yeniden kanıtlar. Başarıda `reauth.succeeded` olayı `wms_auth`
   * ile yazılır (DB tetikleyicisi yalnızca wms_auth'a izin verir); başarısızlıkta `reauth.failed` yazılır ve e-posta
   * başına başarısız giriş sayacı artar (A-41; kilitliyse parola denenmez). Her başarısızlık (yanlış parola, kilit, geçersiz
   * oturum, parolasız hesap) tekdüze `AuthError("REAUTH_REQUIRED")` olur (parola oracle'ı yok). HTTP ucu YOK
   * (`/verify-password` kapalı); çağıran sunucu kodudur. `requireRecentAuth` bu olaya BAĞLI DEĞİLDİR (sonraki kart).
   */
  reauthenticate(principal: Principal, password: string, headers?: Headers): Promise<void>;
  /** Kullanıcının tüm oturumlarını siler. */
  revokeUserSessions(userId: string): Promise<void>;
  /**
   * Yönetici kaynaklı sıfırlama belirteci (B1, ADR-016 §9 / 3. tur m1): YÖNETİCİ İŞARETLİ doğrulama kaydı yazar
   * (30 dk). Yetki/üretim denetimi ÇAĞIRANIN işidir (`issuePasswordResetLink`); grant yoksa kullanılamaz (fail-closed).
   */
  createPasswordResetToken(userId: string, issuingTenantId: string): Promise<AdminResetToken>;
  /** Grant'siz kalan/yarım üretilmiş belirteç kaydını siler (grant varsa FK CASCADE ile gider). */
  discardPasswordResetToken(verificationId: string): Promise<void>;
  /** Üretim olayı `password_reset_link.issued_by_admin` (kimlik sınıfı: yalnızca wms_auth yazabilir, 0005). */
  recordPasswordResetLinkIssued(input: {
    readonly targetUserId: string;
    readonly issuingTenantId: string;
    readonly adminUserId: string;
    readonly issuingMembershipId: string;
  }): Promise<void>;
  /** Davetle hesap açar (T-117 çağırır). E-posta/doğrulama durumu parametre değildir; bkz. policy.ts. */
  createInvitedAccount(input: CreateInvitedAccountInput): Promise<CreateInvitedAccountResult>;
}

export interface CreateAuthParams {
  /** `wms_auth` bağlantısı (AUTH_DATABASE_URL). */
  readonly client: DbClient;
  readonly env: AuthEnv;
  /** Verilmezse self-servis sıfırlama kapalıdır (`MAIL_DELIVERY_DISABLED`, A-42). */
  readonly resetMail?: ResetMailPort;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EVENT_UA_MAX = 512;

// ---------------------------------------------------------------------------------------------
// Maskeli günlükleme (G-09, I-12): parametre/belirteç/özet/e-posta/IP loga gitmez.
// DrizzleQueryError mesajı sorgu parametrelerini içerir → hata için yalnızca sınıf + SQLSTATE + sabit metin.
// ---------------------------------------------------------------------------------------------

function sqlState(error: unknown): string {
  let e: unknown = error;
  for (let i = 0; i < 5 && typeof e === "object" && e !== null; i += 1) {
    const code = (e as { sqlstate?: unknown }).sqlstate ?? (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return "-";
}

/** Hata için güvenli özet: sınıf adı + SQLSTATE; mesaj/parametre/neden zinciri yazılmaz. */
export function describeError(error: unknown): string {
  let name: string = typeof error;
  if (error instanceof AuthStoreError) name = error.errorName;
  else if (error instanceof Error) name = error.name !== "Error" ? error.name : (error.constructor?.name ?? "Error");
  return `${name.slice(0, 64)} sqlstate=${sqlState(error)}`;
}

/** Serbest metin günlüğü: sorgu/parametre izi varsa sabit metin; e-posta, IP, uzun belirteç/özet maskelenir. */
export function maskLogText(text: string): string {
  if (/failed query|\bparams\b/i.test(text)) return "database query failed";
  return text
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]")
    .replace(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi, "[ip]")
    .replace(/[A-Za-z0-9_\-+/=.$,]{24,}/g, "[redacted]")
    .slice(0, 300);
}

function logMasked(level: "error" | "warn" | "info", message: string, error?: unknown): void {
  const line = `[auth] ${maskLogText(message)}${error === undefined ? "" : ` (${describeError(error)})`}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

type Headerish = Request | Headers | undefined;

function headersOf(source: Headerish): Headers | undefined {
  if (source === undefined) return undefined;
  return source instanceof Headers ? source : source.headers;
}

/**
 * Hız sınırı depolaması: anahtarlar SHA-256 özetiyle saklanır (ADR-014 §13; düz IP/e-posta tabloda yok).
 * Kurulu sürümün yerleşik "database" depolaması anahtarı düz yazar (rate-limiter/index.mjs:89-105) → özel
 * `customStorage.consume` (init-options.d.mts:226). Pencere mantığı yerleşikle aynı (kayan: izinli her istek
 * `last_request`'i yeniler); kontrol + artırma tek atomik `INSERT … ON CONFLICT DO UPDATE … WHERE`.
 */
function createRateLimitStorage(client: DbClient) {
  const db = maskedDb(rawDb(client));
  const PRUNE_PROBABILITY = 0.01;
  const PRUNE_AFTER_MS = 2 * 60 * 60 * 1000; // en uzun kural penceresinin (1 saat) iki katı
  return {
    async consume(key: string, rule: { window: number; max: number }): Promise<{ allowed: boolean; retryAfter: number | null }> {
      const keyHash = sha256Hex(key);
      const now = Date.now();
      const windowMs = rule.window * 1000;
      const rows = await db.execute<{ count: number }>(
        sql`INSERT INTO public.auth_rate_limits (key_hash, count, last_request)
            VALUES (${keyHash}, 1, ${now})
            ON CONFLICT (key_hash) DO UPDATE
              SET count = CASE WHEN ${now} - auth_rate_limits.last_request >= ${windowMs} THEN 1
                               ELSE auth_rate_limits.count + 1 END,
                  last_request = ${now}
              WHERE ${now} - auth_rate_limits.last_request >= ${windowMs}
                 OR auth_rate_limits.count < ${rule.max}
            RETURNING count`,
      );
      if (rows.length > 0) {
        // Süresi dolmuş satırların temizliği: her istekte değil, olasılıksal (~%1; `last_request` indeksi yok,
        // migration kapsam dışı). Yerleşik depolama pencere yenilemede siler (rate-limiter:103-108).
        if (Math.random() < PRUNE_PROBABILITY) {
          await db.execute(sql`DELETE FROM public.auth_rate_limits WHERE last_request < ${now - PRUNE_AFTER_MS}`);
        }
        return { allowed: true, retryAfter: null };
      }
      const current = await db.execute<{ last_request: string | number }>(
        sql`SELECT last_request FROM public.auth_rate_limits WHERE key_hash = ${keyHash}`,
      );
      const last = Number(current[0]?.last_request ?? now);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((last + windowMs - now) / 1000)) };
    },
    /**
     * Rezervasyonu geri alır (başarılı giriş): sayaç 1 azalır (0'ın altına inmez). SIFIRLAMAZ: önceki başarısızlıklar
     * (rezerve edilmiş, geri alınmamış) pencerede kalır → A-41 "5 BAŞARISIZ deneme" anlamı korunur.
     */
    async refund(key: string): Promise<void> {
      await db.execute(
        sql`UPDATE public.auth_rate_limits SET count = GREATEST(count - 1, 0) WHERE key_hash = ${sha256Hex(key)}`,
      );
    },
  };
}

/** A-37: bayrak kapalıyken `undefined` — `socialProviders` anahtarı yapılandırmaya hiç eklenmez. */
export function socialProvidersFor(env: AuthEnv):
  | { google: SocialProviderConfig; microsoft: SocialProviderConfig }
  | undefined {
  if (!env.socialEnabled || env.google === null || env.microsoft === null) return undefined;
  // MAJOR-2: örtük kayıt kapalı. `disableImplicitSignUp` tek başına YETMEZ: istemci `requestSignUp: true` göndererek
  // aşar (api/routes/sign-in.mjs:197, callback.mjs:181: `disableImplicitSignUp && !requestSignUp`). `disableSignUp`
  // (oauth-provider.d.mts:232/333; link-account.mjs:256) istemciden aşılamaz → kayıt kapısı (SIGNUP_ENABLED) ile aynı.
  const gate = { disableImplicitSignUp: true, disableSignUp: !env.signupEnabled } as const;
  return { google: { ...env.google, ...gate }, microsoft: { ...env.microsoft, ...gate } };
}

interface SocialProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly disableImplicitSignUp: true;
  readonly disableSignUp: boolean;
}

// Sızıntıyı KAYNAĞINDA kesme: drizzle-orm 0.45.3 her sorgu hatasını `DrizzleQueryError` (mesaj: "Failed query:
// <sql>\nparams: <değerler>", errors.js:9-20; pg-core/session.js `queryWithCache` içinde) olarak sarar. Parametreler
// e-posta/özet/UUID/IP taşır ve hata Better Auth'un birçok yoluna (router `console.error("# SERVER_ERROR")`
// better-call router.mjs:93, adaptör fabrikası fallback join `console.error(error)` factory.mjs:392) girer. Bu
// yüzden Better Auth'a verilen Drizzle istemcisi sarılır: sorgu hatası → `AuthStoreError` (sınıf + SQLSTATE,
// cause/params YOK). Drizzle `logger` seçeneği yalnızca sorgu günlüğüdür, hata yolunu etkilemez.
// Sarma noktası: PostgresJsSession'ın tx için yeni oturum üretmesi nedeniyle (postgres-js/session.js:108-139)
// oturum katmanı değil, `db`/`tx` yüzeyi (builder zinciri + `then`/`catch`/`finally`) proxy'lenir.

/**
 * `APIError` (Better Auth iş hataları; transaction geri alımı için aynen geçer) dışındaki HER hata
 * `AuthStoreError`'a çevrilir: sınıf adı korunur, mesaj/cause/params atılır.
 */
function toStoreError(error: unknown, boundary = false): unknown {
  if (error instanceof AuthStoreError || (!boundary && isAPIError(error))) return error;
  const sqlstate = sqlState(error);
  const name = (
    error instanceof Error ? (error.name !== "Error" ? error.name : (error.constructor?.name ?? "Error")) : typeof error
  ).slice(0, 64);
  return new AuthStoreError(`auth store failure (${name} sqlstate=${sqlstate})`, sqlstate, name);
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}

function maskedPromise(target: PromiseLike<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    target.then(resolve, (e: unknown) => {
      reject(toStoreError(e));
    });
  });
}

function wrapThenable<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "then") return (f?: never, r?: never) => maskedPromise(t as PromiseLike<unknown>).then(f, r);
      if (prop === "catch") return (r?: never) => maskedPromise(t as PromiseLike<unknown>).catch(r);
      if (prop === "finally") return (f?: never) => maskedPromise(t as PromiseLike<unknown>).finally(f);
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function" || prop === "constructor") return value;
      return (...args: unknown[]): unknown => wrapResult((value as (...a: unknown[]) => unknown).apply(t, args), false);
    },
  });
}

function wrapResult(result: unknown, root: boolean): unknown {
  if (isThenable(result)) return wrapThenable(result);
  // `.prepare()` sonucu gibi `execute()` taşıyan nesneler de sarılır (thenable değildir).
  if (typeof result === "object" && result !== null && typeof (result as { execute?: unknown }).execute === "function") {
    return wrapBuilder(result);
  }
  // Kök yüzeyde `db.select()` / `db.insert(t)` gibi thenable olmayan oluşturucular da sarılır.
  if (root && typeof result === "object" && result !== null && !Array.isArray(result)) return wrapBuilder(result);
  return result;
}

function wrapBuilder<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function" || prop === "constructor") return value;
      // thenable olmayan oluşturucunun (`db.select()`, `db.with()`) çocukları da kök kuralıyla sarılır.
      return (...args: unknown[]): unknown => wrapResult((value as (...a: unknown[]) => unknown).apply(t, args), true);
    },
  });
}

/**
 * Better Auth ve bu paketin kendi sorguları için maskeleyen Drizzle yüzeyi.
 *
 * Desteklenen yüzey (kurulu `@better-auth/drizzle-adapter` 1.7.7 `dist/index.mjs`: select/insert/update/delete
 * zinciri `:62-575`, `execute`, `transaction`): `db.select|insert|update|delete|execute|transaction|with` ve
 * zincirin `then/catch/finally/execute/prepare` sonuçları maskelidir. YASAK (fail-closed, erişimde fırlatır):
 * `db.query` (yalnızca `joins` açıkken `index.mjs:281-401`; kapalı: `database.joins` varsayılan false),
 * `db.$client` (ham sürücü maskeyi atlar) ve `db._` (`index.mjs:53,60,290`: yalnızca `schema` verilmediğinde
 * kullanılır; biz her zaman veririz).
 */
export function maskedDb<T extends object>(db: T): T {
  return new Proxy(db, {
    get(t, prop) {
      if (prop === "query" || prop === "$client" || prop === "_") {
        throw new AuthStoreError(`auth store: db.${String(prop)} is not available on the masked client`);
      }
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function" || prop === "constructor") return value;
      if (prop === "transaction") {
        return (callback: (tx: object) => unknown, ...rest: unknown[]): unknown =>
          wrapResult(
            (value as (...a: unknown[]) => unknown).call(t, (tx: object) => callback(maskedDb(tx)), ...rest),
            false,
          );
      }
      return (...args: unknown[]): unknown => wrapResult((value as (...a: unknown[]) => unknown).apply(t, args), true);
    },
  });
}

/** Hata sınıfı + SQLSTATE dışında bilgi taşımayan hata (Drizzle `params` sızıntısını önler). */
export class AuthStoreError extends Error {
  override name = "AuthStoreError";
  /** Yalnızca `describeError` çıktısı (sınıf + SQLSTATE) taşır; `cause` bilerek yok. */
  readonly sqlstate: string;
  /** Özgün hatanın sınıf adı (ör. `DrizzleQueryError`); mesaj/cause taşınmaz. */
  readonly errorName: string;
  constructor(message: string, sqlstate = "-", errorName = "AuthStoreError") {
    super(message);
    this.sqlstate = sqlstate;
    this.errorName = errorName;
  }
}

async function masked<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AuthError || error instanceof AuthConfigError || error instanceof InvitedAccountError) throw error;
    // Servis sınırında APIError dahil her hata tekdüze, parametresiz AuthStoreError olur.
    throw toStoreError(error, true);
  }
}

const authOptionsByService = new WeakMap<AuthService, BetterAuthOptions>();

/** `inspectAuthOptions` anlık görüntüsü: gizsiz, derin dondurulmuş; canlı yapılandırmayla bağı yoktur. */
export interface AuthOptionsSnapshot {
  readonly session?: { readonly additionalFields?: Readonly<Record<string, { readonly input?: boolean }>> };
  readonly user?: { readonly additionalFields?: Readonly<Record<string, { readonly input?: boolean }>> };
  readonly disabledPaths?: readonly string[];
  readonly account?: { readonly accountLinking?: { readonly enabled?: boolean } };
  readonly advanced?: {
    readonly disableOriginCheck?: boolean;
    readonly disableCSRFCheck?: boolean;
    readonly ipAddress?: { readonly ipAddressHeaders?: readonly string[] };
  };
  readonly rateLimit?: { readonly enabled?: boolean };
  readonly emailAndPassword?: { readonly disableSignUp?: boolean; readonly revokeSessionsOnPasswordReset?: boolean };
  readonly socialProviders?: Readonly<Record<string, { readonly disableSignUp?: boolean; readonly disableImplicitSignUp?: boolean }>>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * YALNIZCA test/inceleme: etkin Better Auth seçeneklerinin (`auth.options`) politika alanlarının ANLIK GÖRÜNTÜSÜ.
 * Canlı nesne dışarı çıkmaz: seçilen alanlar açıkça kopyalanır (secret, clientId/clientSecret, adaptör, depolama,
 * kancalar yok), `structuredClone` ile ayrıştırılır ve derin dondurulur → çağıran canlı yapılandırmayı değiştiremez.
 */
export function inspectAuthOptions(service: AuthService): AuthOptionsSnapshot {
  const live = authOptionsByService.get(service);
  if (live === undefined) throw new AuthConfigError("inspectAuthOptions: service was not created by createAuth");
  const fieldInputs = (fields: unknown): Record<string, { input?: boolean }> | undefined => {
    if (typeof fields !== "object" || fields === null) return undefined;
    return Object.fromEntries(
      Object.entries(fields as Record<string, { input?: boolean }>).map(([k, v]) => [k, { input: v.input }]),
    );
  };
  const social: Record<string, { disableSignUp?: boolean; disableImplicitSignUp?: boolean }> = {};
  for (const [name, cfg] of Object.entries(live.socialProviders ?? {})) {
    const c = cfg as { disableSignUp?: boolean; disableImplicitSignUp?: boolean };
    social[name] = { disableSignUp: c.disableSignUp, disableImplicitSignUp: c.disableImplicitSignUp };
  }
  const picked = {
    session: { additionalFields: fieldInputs(live.session?.additionalFields) },
    user: { additionalFields: fieldInputs(live.user?.additionalFields) },
    disabledPaths: [...(live.disabledPaths ?? [])],
    account: { accountLinking: { enabled: live.account?.accountLinking?.enabled } },
    advanced: {
      disableOriginCheck: live.advanced?.disableOriginCheck,
      disableCSRFCheck: live.advanced?.disableCSRFCheck,
      ipAddress: { ipAddressHeaders: [...(live.advanced?.ipAddress?.ipAddressHeaders ?? [])] },
    },
    rateLimit: { enabled: live.rateLimit?.enabled },
    emailAndPassword: {
      disableSignUp: live.emailAndPassword?.disableSignUp,
      revokeSessionsOnPasswordReset: live.emailAndPassword?.revokeSessionsOnPasswordReset,
    },
    ...(live.socialProviders === undefined ? {} : { socialProviders: social }),
  };
  return deepFreeze(structuredClone(picked)) as AuthOptionsSnapshot;
}

/** Better Auth yapılandırmasını kurar ve dar yüzeyi döndürür. */
export function createAuth(params: CreateAuthParams): AuthService {
  const { client, env, resetMail } = params;
  const baseOrigin = new URL(env.baseUrl).origin;
  const authDb = maskedDb(rawDb(client));
  const rateStore = createRateLimitStorage(client);

  async function emit(
    type: string,
    userId: string | null,
    source: Headerish,
    options: Parameters<typeof getIP>[1],
    detail: Record<string, unknown> = {},
    failOpen = false,
    suppressNetworkMeta = false,
  ): Promise<void> {
    await write(
      type,
      userId,
      () => {
        const headers = headersOf(source);
        return { ip: headers === undefined ? null : getIP(headers, options), ua: headers?.get("user-agent") ?? null };
      },
      detail,
      failOpen,
      suppressNetworkMeta,
    );
  }

  async function write(
    type: string,
    userId: string | null,
    meta: () => { ip: string | null; ua: string | null },
    detail: Record<string, unknown>,
    failOpen: boolean,
    suppressNetworkMeta: boolean,
  ): Promise<void> {
    try {
      const { ip, ua } = meta();
      // `wms_auth` bağlantısı (maskeli değil: `recordSecurityEvent` kendi sarmalıyla `rawDb` kullanır; hata `toStoreError`'dan
      // geçer). RETURNING yok: wms_auth'ın SELECT yetkisi yoktur.
      await recordSecurityEvent(
        client,
        {
          eventType: type,
          userId,
          ip,
          userAgent: ua === null || ua === "" ? null : ua.slice(0, EVENT_UA_MAX),
          detail,
          suppressNetworkMeta,
        },
        { returning: false },
      );
    } catch (error) {
      // Hata maskeli günlüğe (parametre/e-posta/IP yok). Varsayılan fail-closed: istek 500 olur.
      // Kaynakta kes: yeniden fırlatılan hata parametresiz (cause/params yok).
      const safe = toStoreError(error);
      if (!failOpen) throw safe;
      logMasked("error", `security event write failed: ${type}`, safe);
    }
  }

  let warnedNoIp = false;

  /**
   * Oturum politikası yazımı (mfa_verified_at); başarısızsa oturum iptal edilir ve istek hata verir (fail-closed,
   * ADR-014 3. tur m6). Yazım istemci girdisi yolundan değil, `wms_auth` bağlantısıyla sunucuda yapılır.
   */
  async function sessionWriteOrRevoke(token: string, write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      logMasked("error", "session policy write failed; session revoked", error);
      try {
        await authDb.execute(sql`DELETE FROM public.sessions WHERE token = ${token}`);
      } catch (inner) {
        logMasked("error", "session revoke after failed policy write failed", inner);
      }
      throw new APIError("INTERNAL_SERVER_ERROR", { message: "SESSION_POLICY_FAILED", code: "SESSION_POLICY_FAILED" });
    }
  }

  /** `keepToken` dışındaki tüm oturumlar iptal (`null`: kullanıcının tüm oturumları). */
  async function revokeOtherSessions(userId: string, keepToken: string | null): Promise<void> {
    await authDb.execute(
      keepToken === null
        ? sql`DELETE FROM public.sessions WHERE user_id = ${userId}::uuid`
        : sql`DELETE FROM public.sessions WHERE user_id = ${userId}::uuid AND token <> ${keepToken}`,
    );
  }

  /**
   * Fail-closed iptal (MINOR-1/2): `keepToken` dışındaki oturumlar silinemezse sırayla (2) kullanıcının TÜM oturumları
   * (mevcut dahil; yeniden giriş gerekir), (3) mevcut/yeni oturum belirteçleri silinir ve istek HATA ile biter.
   * Eski `mfa_verified_at`'lı oturum sağ kalmasın diye başarı yanıtı asla dönmez.
   */
  async function revokeFailClosed(userId: string, keepToken: string | null, selfTokens: readonly (string | undefined)[]): Promise<void> {
    try {
      await revokeOtherSessions(userId, keepToken);
      return;
    } catch (error) {
      logMasked("error", "revoke other sessions failed; failing closed", error);
    }
    if (keepToken !== null) {
      try {
        await revokeOtherSessions(userId, null);
      } catch (error) {
        logMasked("error", "revoke all sessions failed; deleting current session only", error);
        for (const token of selfTokens) {
          if (token === undefined) continue;
          try {
            await authDb.execute(sql`DELETE FROM public.sessions WHERE token = ${token}`);
          } catch (inner) {
            logMasked("error", "current session delete failed", inner);
          }
        }
      }
    } else {
      for (const token of selfTokens) {
        if (token === undefined) continue;
        try {
          await authDb.execute(sql`DELETE FROM public.sessions WHERE token = ${token}`);
        } catch (inner) {
          logMasked("error", "current session delete failed", inner);
        }
      }
    }
    throw new APIError("INTERNAL_SERVER_ERROR", { message: "SESSION_POLICY_FAILED", code: "SESSION_POLICY_FAILED" });
  }

  /** İsteği yapan oturumun belirteci (kancalarda `ctx.context.session` yoksa çerezden). */
  async function currentTokenOf(ctx: Parameters<typeof getSessionFromCtx>[0]): Promise<string | undefined> {
    try {
      return (ctx.context.session ?? (await getSessionFromCtx(ctx)))?.session.token;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // /reset-password kancaları (T-117b; ADR-016 §9, 3.-5. tur ekleri; ADR-014 4. tur MINOR-5, A-55)
  // Kurulu Better Auth 1.7.7 `/reset-password` işleyicisi (api/routes/password.mjs:148-171) `before` kancasıyla parola
  // güncellemesini ORTAK transaction'da çalıştırmaz → kalan pencere: ADR-016 bilinen risk (1.7.7). Kanca grant'i kendi
  // `wms_auth` transaction'ında tüketir ve commit eder; hedefin `users` satırına FOR UPDATE uygulanmaz.
  // ---------------------------------------------------------------------------------------------
  interface PendingReset {
    readonly userId: string;
    readonly marked: boolean;
    readonly at: number;
  }
  const pendingResets = new Map<string, PendingReset>();
  const PENDING_RESET_TTL_MS = 10 * 60 * 1000;

  function pendingResetKey(token: string): string {
    return sha256Hex(token);
  }

  function resetTokenOf(ctx: { body?: unknown; query?: unknown }): string | undefined {
    const body = ctx.body as { token?: unknown } | undefined;
    const query = ctx.query as { token?: unknown } | undefined;
    // Better Auth ile aynı öncelik: `ctx.body.token || ctx.query?.token` (password.mjs:149).
    if (typeof body?.token === "string" && body.token !== "") return body.token;
    if (typeof query?.token === "string" && query.token !== "") return query.token;
    return undefined;
  }

  const resetRejected = (): APIError =>
    new APIError("FORBIDDEN", { message: "RESET_LINK_REJECTED", code: "RESET_LINK_REJECTED" });

  async function guardResetPassword(ctx: Parameters<typeof getSessionFromCtx>[0]): Promise<void> {
    const token = resetTokenOf(ctx as { body?: unknown; query?: unknown });
    if (token === undefined) return; // Better Auth INVALID_TOKEN ile reddeder
    const source = ctx.request ?? ctx.headers;
    const options = ctx.context.options;
    const marked = ADMIN_TOKEN_RE.test(token);
    let record: { id: string; value: string } | null;
    let verdict: string;
    try {
      const found = await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`);
      record = found === null || found === undefined ? null : { id: found.id, value: found.value };
      // Her belirteç için BİR kez; kendi (otomatik) transaction'ı = commit (ret yolunda geri alma grant'i diriltmez).
      verdict =
        record === null
          ? "absent"
          : String(
              (
                await authDb.execute<{ r: string }>(sql`SELECT wms_probe.consume_admin_reset_grant(${record.id}::uuid) AS r`)
              )[0]?.r,
            );
    } catch (error) {
      // Deadlock/serileştirme dahil her hata RED (fail-closed); hata yutulup devam edilmez.
      logMasked("error", "password link check failed; rejecting", error);
      throw resetRejected();
    }
    const userId = record !== null && UUID_RE.test(record.value) ? record.value : null;
    if (marked) {
      if (verdict === "consumed" && record !== null && userId !== null) {
        pruneAndRemember(token, { userId, marked: true, at: Date.now() });
        return;
      }
      // işaretli + 'invalid' / 'absent' (veya tanınmayan dönüş) → nötr RED
      await emit("password_reset_link.rejected", userId, source, options, { verdict: verdict === "invalid" ? "invalid" : "absent" }, true);
      throw resetRejected();
    }
    if (verdict === "absent") {
      if (record !== null && userId !== null) pruneAndRemember(token, { userId, marked: false, at: Date.now() });
      return; // self-servis akışı
    }
    if (verdict === "consumed" || verdict === "invalid") {
      await emit("password_reset_link.inconsistent", userId, source, options, { verdict }, true);
    } else {
      logMasked("error", "password link check returned an unrecognised verdict; rejecting");
    }
    throw resetRejected();
  }

  function pruneAndRemember(token: string, entry: PendingReset): void {
    const now = Date.now();
    for (const [k, v] of pendingResets) if (now - v.at > PENDING_RESET_TTL_MS) pendingResets.delete(k);
    pendingResets.set(pendingResetKey(token), entry);
  }

  async function afterResetPassword(
    ctx: Parameters<typeof getSessionFromCtx>[0],
    failed: boolean,
    returnedValue: unknown,
    source: Headerish,
    options: Parameters<typeof getIP>[1],
  ): Promise<void> {
    const token = resetTokenOf(ctx as { body?: unknown; query?: unknown });
    if (token === undefined) return;
    const key = pendingResetKey(token);
    const pending = pendingResets.get(key);
    pendingResets.delete(key);
    if (pending === undefined || failed) return;
    // Başarı göstergesi: işleyici `ctx.json({ status: true })` döndürür (password.mjs:170); hata `APIError` olarak gelir.
    const returned = returnedValue as { status?: unknown } | undefined;
    if (returned === undefined || returned === null || typeof returned !== "object" || returned.status !== true) return;
    if (pending.marked) {
      await emit("password_reset_link.consumed", pending.userId, source, options, {}, true);
      return;
    }
    if (!env.emailRecoveryEnabled) return; // A-55: bayrak kapalıyken kurtarma etkisi yok
    try {
      await recoverAccountViaEmail(pending.userId, source, options);
    } catch (error) {
      logMasked("error", "account recovery failed", error);
      await emit("account.recovery_failed", pending.userId, source, options, {}, true);
      throw new APIError("INTERNAL_SERVER_ERROR", { message: "RECOVERY_FAILED", code: "RECOVERY_FAILED" });
    }
  }

  /**
   * A-55 kurtarma: yalnızca ekran davetiyle açılmış (`invitation_claim_id IS NOT NULL`) ve doğrulanmamış hesapta; tüm
   * etkiler TEK `wms_auth` transaction'ında (biri başarısızsa hiçbiri).
   */
  async function recoverAccountViaEmail(userId: string, source: Headerish, options: Parameters<typeof getIP>[1]): Promise<void> {
    const headers = headersOf(source);
    const ip = headers === undefined ? null : getIP(headers, options);
    const uaRaw = headers?.get("user-agent") ?? null;
    const ua = uaRaw === null || uaRaw === "" ? null : uaRaw.slice(0, EVENT_UA_MAX);
    try {
      await rawDb(client).transaction(async (tx) => {
        const updated = await tx.execute<{ id: string }>(
          sql`UPDATE public.users
                 SET email_verified = true, two_factor_enabled = false, updated_at = now()
               WHERE id = ${userId}::uuid AND invitation_claim_id IS NOT NULL AND email_verified = false
           RETURNING id`,
        );
        if (updated.length === 0) return; // koşullar sağlanmıyor: etki yok
        await tx.execute(sql`DELETE FROM public.sessions WHERE user_id = ${userId}::uuid`);
        await tx.execute(sql`DELETE FROM public.two_factors WHERE user_id = ${userId}::uuid`);
        await tx.execute(
          sql`INSERT INTO public.security_events (user_id, event_type, ip, user_agent, detail)
              VALUES (${userId}::uuid, 'account.recovered_via_email', ${ip}, ${ua}, '{}'::jsonb)`,
        );
      });
    } catch (error) {
      throw toStoreError(error, true);
    }
  }

  const auth = betterAuth({
    appName: "Etkin WMS",
    baseURL: env.baseUrl,
    secret: env.secret,
    trustedOrigins: [baseOrigin],
    // B1 (G-09): Better Auth günlükleri ve API hataları maskeli yazılır (parametre/belirteç/e-posta/IP yok).
    logger: {
      level: "warn",
      log: (level, message) => {
        logMasked(level === "error" ? "error" : level === "warn" ? "warn" : "info", String(message));
      },
    },
    // Router hataları (better-call router.mjs:81-90) `throw: true` ile handler sarmalayıcısına iletilir ve
    // orada TEK yerde maskeli loglanır; better-call'ın `console.error("# SERVER_ERROR")` yolu hiç çalışmaz.
    // `APIError`'lar (4xx) router'da yanıta çevrilir (router.mjs:84 `isAPIError`).
    onAPIError: { throw: true },
    database: drizzleAdapter(authDb, {
      provider: "pg",
      schema,
      usePlural: true,
      // ADR-014 §5/M1 ve 5. tur MINOR-3: çok adımlı yazımlar (`runWithTransaction`) tek DB transaction'ında.
      transaction: true,
    }),
    advanced: {
      database: { generateId: "uuid" },
      // ADR-014 §13: istemci IP'si yalnız Fly'ın koyduğu başlıktan (X-Forwarded-For yok sayılır).
      ipAddress: { ipAddressHeaders: ["fly-client-ip"] },
      useSecureCookies: new URL(env.baseUrl).protocol === "https:",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      // M1: Better Auth `skipOriginCheck` varsayılanı `isTest()` iken true olur (create-context.mjs:211);
      // her ortamda (vitest dahil) köken ve CSRF denetimi açıkça açık (init-options.d.mts:295, 310).
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    emailAndPassword: {
      enabled: true,
      // A-50: kayıt yalnızca SIGNUP_ENABLED=true ve WMS_ENV local|ci iken açık (readAuthEnv zorlar); aksi halde
      // hesaplar yalnızca `createInvitedAccount` ile (davet) açılır.
      disableSignUp: !env.signupEnabled,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      requireEmailVerification: env.requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
      // A-42: bağlantı talep edene ASLA dönmez; yalnızca mühürlü `email.send` işiyle (T-116). Port yoksa kapalı
      // (sahte başarı yok). Kullanıcı var/yok ayrımı sızmaması için kuyruk hatası yanıtı değiştirmez: maskeli
      // loglanır (yutulmaz), istemciye her durumda aynı genel yanıt döner.
      sendResetPassword: async ({ user, url }) => {
        if (resetMail === undefined) throw new MailDeliveryDisabledError();
        try {
          if (!resetMail.canDeliver(user.email)) return;
          await resetMail.sendResetLink({ to: user.email, link: url, locale: "tr" });
        } catch (error) {
          logMasked("error", "password reset e-mail enqueue failed", error);
        }
      },
      onPasswordReset: async ({ user }, request) => {
        await emit(SECURITY_EVENT.passwordReset, user.id, request, {});
      },
    },
    ...(env.requireEmailVerification
      ? { emailVerification: { sendVerificationEmail: () => Promise.reject(new MailDeliveryDisabledError()) } }
      : {}),
    // A-37: Google/Microsoft yalnızca AUTH_SOCIAL_ENABLED=true iken eklenir (yoksa anahtar hiç yok).
    ...(socialProvidersFor(env) === undefined ? {} : { socialProviders: socialProvidersFor(env) }),
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SEC,
      updateAge: SESSION_UPDATE_AGE_SEC,
      // ADR-014 §2: çerez önbelleği kapalı → her istekte DB doğrulaması (çıkış/iptal anında etkili).
      cookieCache: { enabled: false },
      // ADR-014 §12 / 4. tur BLOCKER-1: istemci yazamaz (`input: false`: db/schema.mjs:63-75) ve
      // `/update-session` kapalı (`disabledPaths`). Yalnızca sunucu `after` kancaları yazar.
      additionalFields: { ...SESSION_ADDITIONAL_FIELDS },
    },
    user: {
      // ADR-016 4. tur MAJOR-1: istemci yazamaz; yalnızca iç adaptörle (`createInvitedAccount`).
      additionalFields: { ...USER_ADDITIONAL_FIELDS },
    },
    // Doğrulama belirteçlerinin DB'de özetle saklanması (verification-token-storage.mjs; init-options.d.mts:1210).
    // `hash` biçimi: init-options.d.mts:23-25. Varsayılan "hashed" ile aynı; yalnızca yönetici belirteçleri önek korur.
    verification: { storeIdentifier: { hash: (identifier: string) => Promise.resolve(hashVerificationIdentifier(identifier)) } },
    rateLimit: {
      enabled: true,
      ...RATE_LIMIT_RULES.general,
      // Yerleşik "database" modelinin yerine (anahtar özeti için) özel depolama; tablo adı yine eşlenir.
      modelName: "authRateLimit",
      fields: { key: "keyHash" },
      customStorage: { consume: rateStore.consume },
      customRules: {
        "/sign-in/email": RATE_LIMIT_RULES.signIn,
        "/request-password-reset": RATE_LIMIT_RULES.passwordReset,
        "/two-factor/*": RATE_LIMIT_RULES.twoFactor,
      },
    },
    // ADR-014 4. tur BLOCKER-1 (b): `/update-session` ucu kapalı (api/index.mjs:166-168 → 404).
    // M3: `/verify-password` HTTP'den kapalı (parola doğrulama oracle'ı); sunucu tarafı `auth.api` ile sürer.
    disabledPaths: [...DISABLED_PATHS],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // MINOR-2: üretimde güvenilir istemci IP'si (Fly-Client-IP) yoksa istek reddedilir; yerelde
        // Better Auth ortak yerel kovayı kullanır (ilk seferde açık uyarı).
        // Başlık doğrudan okunur (Better Auth test/dev ortamında yerel adrese düşer; getIP bunu gizlerdi).
        if (ctx.request !== undefined && resolveClientIp(ctx.request.headers) === null) {
          if (env.production) {
            throw new APIError("BAD_REQUEST", { message: "CLIENT_IP_REQUIRED", code: "CLIENT_IP_REQUIRED" });
          }
          if (!warnedNoIp) {
            warnedNoIp = true;
            logMasked("warn", "Fly-Client-IP header missing: using the shared local rate-limit bucket (non-production only)");
          }
        }
        // M4 (ADR-014 §12): "trust device" kapalı — 2FA doğrulama gövdesinde reddedilir.
        if (
          (ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code" || ctx.path === "/two-factor/verify-otp") &&
          (ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice
        ) {
          throw new APIError("BAD_REQUEST", { message: "TRUST_DEVICE_DISABLED", code: "TRUST_DEVICE_DISABLED" });
        }
        // M9 (A-43): demo kullanıcısı için hesap/oturum yönetimi uçları kapalı; olayda IP/UA saklanmaz.
        if (env.demoEmailDomain !== null && DEMO_FORBIDDEN_PATHS.includes(ctx.path)) {
          const current = await getSessionFromCtx(ctx);
          if (current !== null && isDemoEmail(current.user.email, env.demoEmailDomain)) {
            await emit("demo.action_forbidden", current.user.id, ctx.request ?? ctx.headers, ctx.context.options, { path: ctx.path }, true, true);
            throw new APIError("FORBIDDEN", { message: "DEMO_FORBIDDEN", code: "DEMO_FORBIDDEN" });
          }
        }
        // A-41 / MAJOR-1: e-posta başına başarısız giriş kilidi, IP'den bağımsız. Denetim ve ayırma TEK atomik adım
        // (kütüphanenin kendi sınırlayıcısı gibi: rate-limiter/index.mjs:281-297 tek ifade): her deneme Argon2'den ÖNCE
        // rezerve edilir (sayaç artar; eşik aşıldıysa 429). Böylece paralel istekler denetim–artırma arasındaki
        // boşluktan geçemez (eşik+1'den fazlası parola doğrulamasına ulaşamaz). Başarılı girişte rezerv geri alınır
        // (after: sayaç -1, sıfırlama değil) → yalnızca BAŞARISIZ denemeler pencerede kalır. Bayrak gerekmez: after
        // yalnızca before geçildiyse çalışır.
        if (ctx.path === "/sign-in/email" && typeof ctx.body?.email === "string") {
          const verdict = await rateStore.consume(emailRateKey("signin-fail", ctx.body.email), EMAIL_RATE_RULES.failedSignIn);
          if (!verdict.allowed) throw new APIError("TOO_MANY_REQUESTS", { message: "RATE_LIMITED", code: "RATE_LIMITED" });
        }
        if (ctx.path === "/request-password-reset") {
          // A-41: e-posta başına sıfırlama talebi sınırı (kullanıcı var/yok ayrımı yok: her e-posta aynı kurala tabi).
          if (typeof ctx.body?.email === "string") {
            const verdict = await rateStore.consume(emailRateKey("pwd-reset", ctx.body.email), EMAIL_RATE_RULES.passwordReset);
            if (!verdict.allowed) throw new APIError("TOO_MANY_REQUESTS", { message: "RATE_LIMITED", code: "RATE_LIMITED" });
          }
          // Teslim edilemeyen alıcı/kapalı port: kullanıcı var/yok ayrımı sızmaması için arama yapılmadan, her istek
          // aynı yanıtla reddedilir (UI "yöneticinden iste" der). Teslim edilebilirse Better Auth akışı sürer (A-42).
          const to = ctx.body?.email;
          let deliverable = false;
          try {
            deliverable = resetMail !== undefined && typeof to === "string" && resetMail.canDeliver(to.trim().toLowerCase());
          } catch (error) {
            logMasked("error", "password mail canDeliver failed", error);
          }
          if (!deliverable) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message: "MAIL_DELIVERY_DISABLED",
              code: "MAIL_DELIVERY_DISABLED",
            });
          }
        }
        if (ctx.path === "/reset-password") await guardResetPassword(ctx);
        if (ctx.path === "/sign-out") {
          const current = await getSessionFromCtx(ctx);
          // M2: fail-open YALNIZCA çıkış için — denetim yazımı başarısızsa oturum yine silinir (kullanıcı çıkış
          // yapabilmeli; kalan oturum güvenlik riski, eksik çıkış olayı değil). Hata maskeli loglanır.
          await emit(SECURITY_EVENT.logout, current?.user.id ?? null, ctx.request ?? ctx.headers, ctx.context.options, {}, true);
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // better-call doğrulama (zod) hataları dahil her API hatası (MINOR-4).
        const failed = isAPIError(ctx.context.returned);
        const source = ctx.request ?? ctx.headers;
        const options = ctx.context.options;
        switch (ctx.path) {
          case "/sign-in/email": {
            if (failed) {
              const email = typeof ctx.body?.email === "string" ? ctx.body.email : undefined;
              const known = email === undefined ? null : await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase());
              await emit(SECURITY_EVENT.loginFailed, known?.user.id ?? null, source, options, {
                reason: (ctx.context.returned as APIError).body?.code ?? "UNKNOWN",
              });
              return;
            }
            // Başarılı giriş: rezervasyon geri alınır (başarısız denemeler sayılmaya devam eder).
            if (typeof ctx.body?.email === "string") await rateStore.refund(emailRateKey("signin-fail", ctx.body.email));
            const created = ctx.context.newSession;
            if (!created) return;
            // 2FA'lı kullanıcıda oturum, eklentinin kancasında (bu kancadan sonra) silinir; giriş tamamlanmadı.
            await emit(
              created.user.twoFactorEnabled === true ? SECURITY_EVENT.loginMfaPending : SECURITY_EVENT.loginSucceeded,
              created.user.id,
              source,
              options,
            );
            return;
          }
          case "/two-factor/verify-totp":
          case "/two-factor/verify-backup-code": {
            if (failed) {
              await emit(SECURITY_EVENT.twoFactorFailed, null, source, options, {
                reason: (ctx.context.returned as APIError).body?.code ?? "UNKNOWN",
              });
              return;
            }
            const created = ctx.context.newSession;
            if (created) {
              // M5/m7: oturum düzeyi MFA yalnızca burada (başarılı TOTP/yedek kod) ve yalnızca bu oturuma yazılır.
              await sessionWriteOrRevoke(created.session.token, () =>
                authDb.execute(sql`UPDATE public.sessions SET mfa_verified_at = now() WHERE token = ${created.session.token}`),
              );
              await emit(SECURITY_EVENT.loginSucceeded, created.user.id, source, options, { mfa: true });
            }
            return;
          }
          case "/two-factor/disable": {
            if (failed) return;
            // m6: eklenti yeni oturumu eskisinin alanlarıyla açar (internal-adapter.mjs:254 `...rest`) → eski
            // `mfa_verified_at` taşınır; kapatmada NULL'lanır (türetilmiş formül seçilmedi: ADR-014 3. tur).
            const created = ctx.context.newSession;
            if (created) {
              await sessionWriteOrRevoke(created.session.token, () =>
                authDb.execute(sql`UPDATE public.sessions SET mfa_verified_at = NULL WHERE token = ${created.session.token}`),
              );
            }
            return;
          }
          case "/reset-password": {
            await afterResetPassword(ctx, failed, ctx.context.returned, source, options);
            return;
          }
          case "/change-password": {
            if (failed) return;
            // M5: parola değişiminde diğer tüm oturumlar iptal (istemci `revokeOtherSessions` göndermese de).
            const fresh = ctx.context.newSession;
            const current = fresh ?? (await getSessionFromCtx(ctx));
            if (current !== null && current !== undefined) {
              await revokeFailClosed(current.user.id, current.session.token, [current.session.token, fresh?.session.token]);
            }
            await emit(SECURITY_EVENT.passwordChanged, current?.user.id ?? null, source, options);
            return;
          }
          default:
            return;
        }
      }),
    },
    databaseHooks: {
      user: {
        update: {
          // 2FA aç/kapa: eklenti `internalAdapter.updateUser(id, { twoFactorEnabled })` çağırır
          // (plugins/two-factor/totp/index.mjs:208, index.mjs:217). Yalnızca bu uçlarda olay yazılır.
          after: async (user, ctx) => {
            if (ctx === null) return;
            const enabling = ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/enable";
            if (enabling && user.twoFactorEnabled === true) {
              // M5: 2FA etkinleştirmede tüm eski oturumlar iptal; eklenti hemen ardından yeni oturum açar.
              await revokeFailClosed(user.id, null, [await currentTokenOf(ctx)]);
              await emit(SECURITY_EVENT.twoFactorEnabled, user.id, ctx.request ?? ctx.headers, ctx.context.options);
            } else if (ctx.path === "/two-factor/disable" && user.twoFactorEnabled === false) {
              // M5: devre dışı bırakmada tüm eski oturumlar iptal; yeni oturum eklentinin ardından açılır.
              await revokeFailClosed(user.id, null, [await currentTokenOf(ctx)]);
              await emit(SECURITY_EVENT.twoFactorDisabled, user.id, ctx.request ?? ctx.headers, ctx.context.options);
            }
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: "Etkin WMS",
        // TOTP gizi her durumda şifreli (totp/index.mjs → symmetricEncrypt); yedek kodlar da şifreli saklanır.
        backupCodeOptions: { storeBackupCodes: "encrypted" },
        accountLockout: TWO_FACTOR_LOCKOUT,
      }),
      // Her zaman SON eklenti (cookie-plugin-guard.mjs uyarısı).
      nextCookies(),
    ],
  });

  async function recentAuthWithin(principal: Principal, maxAgeSec: number): Promise<void> {
    if (!Number.isFinite(maxAgeSec) || maxAgeSec < 0) {
      throw new AuthConfigError("requireRecentAuth: maxAgeSec must be a non-negative number");
    }
    // Zaman istemciden değil DB saatinden (ADR-014 §14).
    const rows = await masked(() =>
      authDb.execute<{ age: string | number }>(
        sql`SELECT EXTRACT(EPOCH FROM (now() - ${principal.authenticatedAt.toISOString()}::timestamptz)) AS age`,
      ),
    );
    const age = Number(rows[0]?.age);
    if (!Number.isFinite(age) || age > maxAgeSec) throw new AuthError("REAUTH_REQUIRED");
  }

  const service: AuthService = {
    async handler(request) {
      try {
        return await auth.handler(request);
      } catch (error) {
        logMasked("error", "auth handler failed", error);
        return Response.json({ code: "INTERNAL_ERROR" }, { status: 500 });
      }
    },

    async getPrincipal(headers) {
      const result = await masked(() => auth.api.getSession({ headers }));
      if (result === null || result === undefined) return null;
      const { session } = result;
      // A-39: mutlak 7 gün sınırı (oturum oluşturmadan itibaren); aşıldıysa oturum iptal edilir.
      if (sessionAbsoluteExpired(new Date(session.createdAt))) {
        await masked(() => authDb.execute(sql`DELETE FROM public.sessions WHERE id = ${session.id}::uuid`));
        return null;
      }
      return {
        userId: session.userId,
        sessionId: session.id,
        authenticatedAt: new Date(session.createdAt),
        mfaVerified: session.mfaVerifiedAt !== null && session.mfaVerifiedAt !== undefined,
      };
    },

    // M5 kapısı: bu kontrol `security_events` olaylarına (`reauth.succeeded`) DAYANMAZ; yalnızca oturum `createdAt`
    // ve DB `now()` kullanır. `reauth.*` yazımı artık DB'de yalnızca `wms_auth`'a açıktır (0005, T-112c) ve
    // `reauthenticate` olayı yazar; `requireRecentAuth`'u bu olaya bağlamak AYRI bir sonraki değişikliktir.
    async requireRecentAuth(principal, maxAgeSec) {
      await recentAuthWithin(principal, maxAgeSec);
    },

    async ensureRecentAuth(headers) {
      const principal = await service.getPrincipal(headers);
      if (principal === null) throw new AuthError("REAUTH_REQUIRED");
      await recentAuthWithin(principal, REAUTH_WINDOW_SEC);
    },

    async reauthenticate(principal, password, headers) {
      const fail = (): never => {
        throw new AuthError("REAUTH_REQUIRED");
      };
      if (typeof password !== "string" || password === "" || password.length > PASSWORD_MAX_LENGTH) return fail();
      // Oturum hâlâ geçerli ve principal'e ait olmalı; hesap parolası aynı sorguda okunur.
      const rows = await masked(() =>
        authDb.execute<{ email: string; password: string | null }>(
          sql`SELECT u.email, a.password
                FROM public.sessions s
                JOIN public.users u ON u.id = s.user_id
                LEFT JOIN public.accounts a ON a.user_id = u.id AND a.provider_id = 'credential'
               WHERE s.id = ${principal.sessionId}::uuid AND s.user_id = ${principal.userId}::uuid AND s.expires_at > now()
               LIMIT 1`,
        ),
      );
      const row = rows[0];
      if (row === undefined) return fail();
      // IP yalnızca `Fly-Client-IP` (A-41); demo kullanıcıda ip/user_agent yazılmaz (ADR-016 §10).
      const ip = resolveClientIp(headers);
      const uaRaw = headers?.get("user-agent") ?? null;
      const ua = uaRaw === null || uaRaw === "" ? null : uaRaw;
      const demo = isDemoEmail(row.email, env.demoEmailDomain);
      const failKey = emailRateKey("signin-fail", row.email);
      // A-41 atomik rezervasyon (giriş ucuyla aynı anahtar/tasarım): deneme Argon2'den ÖNCE rezerve edilir (consume;
      // eşik aşıldıysa kilitli → parola denenmez); başarıda rezerv geri alınır (refund), başarısızlıkta kalır.
      const verdict = await masked(() => rateStore.consume(failKey, EMAIL_RATE_RULES.failedSignIn));
      const locked = !verdict.allowed;
      // Zamanlama eşitliği: kilitli ya da parolasız hesapta da aynı maliyetli Argon2 doğrulaması çalışır (sonuç yok sayılır).
      const hash = locked || row.password === null ? await dummyPasswordHash() : row.password;
      const verified = await verifyPassword({ hash, password });
      const ok = !locked && row.password !== null && verified;
      if (!ok) {
        await write(REAUTH_EVENT.failed, principal.userId, () => ({ ip, ua }), { locked }, true, demo);
        return fail();
      }
      await masked(() => rateStore.refund(failKey));
      await write(REAUTH_EVENT.succeeded, principal.userId, () => ({ ip, ua }), { sref: sha256Hex(principal.sessionId) }, false, demo);
    },

    async createInvitedAccount(input) {
      return masked(async () => {
        const context = await auth.$context;
        return createInvitedAccountWith(
          {
            db: authDb,
            passwordMinLength: PASSWORD_MIN_LENGTH,
            passwordMaxLength: PASSWORD_MAX_LENGTH,
            hashPassword,
            newId: randomUUID,
            // Kurulu 1.7.7 `internalAdapter.createOAuthUser` kullanıcı + hesap yazımını `runWithTransaction` ile tek
            // transaction'da yapar (db/internal-adapter.mjs:119-139); `runWithTransaction` paketin genel
            // yüzeyinde (better-auth export'ları) yoktur. `id` ve `forceAllowId` (with-hooks.mjs:26-30).
            createUserWithPassword: async (d) => {
              const user = {
                id: d.id,
                name: d.name,
                email: d.email,
                emailVerified: d.emailVerified,
                image: null,
                invitationClaimId: d.invitationClaimId,
              };
              await context.internalAdapter.createOAuthUser(user, {
                accountId: d.id,
                providerId: "credential",
                password: d.passwordHash,
              });
            },
          },
          input,
        );
      });
    },

    async createPasswordResetToken(userId, issuingTenantId) {
      if (!UUID_RE.test(userId) || !UUID_RE.test(issuingTenantId)) throw new AuthConfigError("createPasswordResetToken: ids must be UUIDs");
      return masked(async () => {
        const context = await auth.$context;
        const token = `adm_${issuingTenantId.toLowerCase().replaceAll("-", "")}_${randomBytes(32).toString("base64url")}`;
        const expiresAt = new Date(Date.now() + ADMIN_RESET_TTL_SEC * 1000);
        // Kimlik/değer biçimi Better Auth ile aynıdır (`reset-password:<belirteç>` / değer = kullanıcı kimliği;
        // password.mjs:81-85, 152-155); kimlik `verification.storeIdentifier.hash` ile saklanır.
        const record = await context.internalAdapter.createVerificationValue({
          identifier: `reset-password:${token}`,
          value: userId,
          expiresAt,
        });
        return { token, verificationId: record.id, expiresAt };
      });
    },

    async discardPasswordResetToken(verificationId) {
      if (!UUID_RE.test(verificationId)) throw new AuthConfigError("discardPasswordResetToken: id must be a UUID");
      await masked(() => authDb.execute(sql`DELETE FROM public.verifications WHERE id = ${verificationId}::uuid`));
    },

    async recordPasswordResetLinkIssued(input) {
      await write(
        "password_reset_link.issued_by_admin",
        input.targetUserId,
        () => ({ ip: null, ua: null }),
        { tenant_id: input.issuingTenantId, admin_user_id: input.adminUserId, membership_id: input.issuingMembershipId },
        false,
        true,
      );
    },

    async revokeUserSessions(userId) {
      await masked(async () => {
        const context = await auth.$context;
        await context.internalAdapter.deleteUserSessions(userId);
      });
    },
  };
  authOptionsByService.set(service, auth.options);
  return service;
}

// ---------------------------------------------------------------------------------------------
// Süreç düzeyinde tembel örnek (route handler için)
// ---------------------------------------------------------------------------------------------

let instance: AuthService | undefined;

/** İlk kullanımda `process.env`'den kurar; eksik ortam → `AuthConfigError` (derleme anında değil). */
export function getAuthService(env: EnvSource = process.env): AuthService {
  if (instance === undefined) {
    const parsed = readAuthEnv(env);
    instance = createAuth({
      client: createDbClient({ url: parsed.authDatabaseUrl, ...DB_CLIENT_SETTINGS }),
      env: parsed,
    });
  }
  return instance;
}

/** Davetle hesap açma (T-117): bkz. `AuthService.createInvitedAccount`. */
export function createInvitedAccount(input: CreateInvitedAccountInput): Promise<CreateInvitedAccountResult> {
  return getAuthService().createInvitedAccount(input);
}

/** Web eylemleri için (T-117b): bkz. `AuthService.ensureRecentAuth`. */
export function ensureRecentAuth(headers: Headers): Promise<void> {
  return getAuthService().ensureRecentAuth(headers);
}

/** Yönetici kaynaklı sıfırlama (T-117b): bkz. `AuthService.createPasswordResetToken` ve komşuları. */
export function createPasswordResetToken(userId: string, issuingTenantId: string): Promise<AdminResetToken> {
  return getAuthService().createPasswordResetToken(userId, issuingTenantId);
}
export function discardPasswordResetToken(verificationId: string): Promise<void> {
  return getAuthService().discardPasswordResetToken(verificationId);
}
export function recordPasswordResetLinkIssued(input: Parameters<AuthService["recordPasswordResetLinkIssued"]>[0]): Promise<void> {
  return getAuthService().recordPasswordResetLinkIssued(input);
}

/** `apps/web/app/api/auth/[...all]/route.ts` için: ilk istekte örneği kurar. */
export const authRouteHandlers = Object.freeze({
  GET: (request: Request): Promise<Response> => getAuthService().handler(request),
  POST: (request: Request): Promise<Response> => getAuthService().handler(request),
});
