// `@wms/auth` — Better Auth 1.7.7 kimlik katmanı (T-112, ADR-014).
//
// - Yalnızca platform kimlik tablolarına (`users`, `sessions`, `accounts`, `verifications`, `two_factors`,
//   `auth_rate_limits`) ve `wms_auth` rolüyle yazar (ADR-014 §10): `client` = `AUTH_DATABASE_URL`.
//   `security_events` yazımı ayrı `eventClient` (DATABASE_URL, wms_app) ile `recordSecurityEvent` üzerinden
//   yapılır (wms_auth `security_events` üzerinde SELECT taşımaz, `INSERT ... RETURNING` çalışmaz; bulgu).
// - Better Auth nesnesi paket dışına çıkmaz; yalnızca `handler` (route) ve dar yüzey: `getPrincipal`,
//   `requireRecentAuth`, `revokeUserSessions`.
// - Ortam doğrulaması tembeldir (ilk kullanımda): `next build` bu değişkenler olmadan geçer (G-07: eksikse
//   çalışma anında açık hata, değer asla yazılmaz — G-09).
import { createHash } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx } from "better-auth/api";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { sql } from "drizzle-orm";
import { DB_CLIENT_SETTINGS, createDbClient, rawDb } from "@wms/db/internal";
import type { DbClient } from "@wms/db/internal";
import * as schema from "@wms/db/internal/schema";
import { recordSecurityEvent } from "@wms/db";
import { hashPassword, verifyPassword } from "./password.ts";

export { ARGON2_PARAMS, hashPassword, verifyPassword } from "./password.ts";

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
  /** `wms_app` (DATABASE_URL): yalnızca `recordSecurityEvent` için. */
  readonly databaseUrl: string;
  /** `wms_auth` (AUTH_DATABASE_URL): Better Auth tabloları. */
  readonly authDatabaseUrl: string;
  readonly socialEnabled: boolean;
  readonly requireEmailVerification: boolean;
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
  return {
    secret,
    baseUrl,
    databaseUrl,
    authDatabaseUrl,
    socialEnabled,
    requireEmailVerification: flag(env, "AUTH_REQUIRE_EMAIL_VERIFICATION"),
    google,
    microsoft,
  };
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

/** Hız sınırı kuralları (A-41); anahtar = IP + yol. E-posta başına ve 2FA kilidi T-112b'dir. */
export const RATE_LIMIT_RULES = Object.freeze({
  general: { window: 60, max: 300 },
  signIn: { window: 10 * 60, max: 10 },
  passwordReset: { window: 60 * 60, max: 5 },
  twoFactor: { window: 10 * 60, max: 10 },
});

/** 2FA: A-41 — 5 hatalı kod → 15 dk kilit (Better Auth `accountLockout`, kullanıcı başına). */
export const TWO_FACTOR_LOCKOUT = Object.freeze({ enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 });

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
  /** Oturum oluşturma zamanı (son kimlik doğrulama; yeniden doğrulama kaydı T-112b). */
  readonly authenticatedAt: Date;
  /** Oturum düzeyi MFA: `sessions.mfa_verified_at IS NOT NULL` (ADR-014 §12). */
  readonly mfaVerified: boolean;
}

export interface AuthService {
  /** Route handler girişi (`/api/auth/*`). */
  handler(request: Request): Promise<Response>;
  /** Çerezli istekten kimlik; oturum yok/iptal/süresi dolmuş → `null`. Her çağrıda DB'den doğrulanır. */
  getPrincipal(headers: Headers): Promise<Principal | null>;
  /** Kimlik doğrulaması `maxAgeSec` içinde değilse `AuthError` (UNAUTHENTICATED). Zaman DB `now()` ile. */
  requireRecentAuth(principal: Principal, maxAgeSec: number): Promise<void>;
  /** Kullanıcının tüm oturumlarını siler. */
  revokeUserSessions(userId: string): Promise<void>;
}

export interface CreateAuthParams {
  /** `wms_auth` bağlantısı (AUTH_DATABASE_URL). */
  readonly client: DbClient;
  /** `security_events` için bağlantı (DATABASE_URL). */
  readonly eventClient: DbClient;
  readonly env: AuthEnv;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EVENT_UA_MAX = 512;

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
  const db = rawDb(client);
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
        // Süresi dolmuş satırların temizliği (yerleşik depolama da izinli istekte siler; rate-limiter:103-108).
        await db.execute(sql`DELETE FROM public.auth_rate_limits WHERE last_request < ${now - PRUNE_AFTER_MS}`);
        return { allowed: true, retryAfter: null };
      }
      const current = await db.execute<{ last_request: string | number }>(
        sql`SELECT last_request FROM public.auth_rate_limits WHERE key_hash = ${keyHash}`,
      );
      const last = Number(current[0]?.last_request ?? now);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((last + windowMs - now) / 1000)) };
    },
  };
}

/** A-37: bayrak kapalıyken `undefined` — `socialProviders` anahtarı yapılandırmaya hiç eklenmez. */
export function socialProvidersFor(
  env: AuthEnv,
): { google: { clientId: string; clientSecret: string }; microsoft: { clientId: string; clientSecret: string } } | undefined {
  if (!env.socialEnabled || env.google === null || env.microsoft === null) return undefined;
  return { google: { ...env.google }, microsoft: { ...env.microsoft } };
}

/** Better Auth yapılandırmasını kurar ve dar yüzeyi döndürür. */
export function createAuth(params: CreateAuthParams): AuthService {
  const { client, eventClient, env } = params;
  const baseOrigin = new URL(env.baseUrl).origin;
  const authDb = rawDb(client);

  async function emit(
    type: string,
    userId: string | null,
    source: Headerish,
    options: Parameters<typeof getIP>[1],
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const headers = headersOf(source);
    const ip = headers === undefined ? null : getIP(headers, options);
    const ua = headers?.get("user-agent") ?? null;
    await recordSecurityEvent(eventClient, {
      eventType: type,
      userId,
      ip,
      userAgent: ua === null || ua === "" ? null : ua.slice(0, EVENT_UA_MAX),
      detail,
    });
  }

  const auth = betterAuth({
    appName: "Etkin WMS",
    baseURL: env.baseUrl,
    secret: env.secret,
    trustedOrigins: [baseOrigin],
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
    },
    emailAndPassword: {
      enabled: true,
      // Güvenli varsayılan: kayıt kapalı; T-112b koşullu açar (A-50). Test kullanıcıları fikstürle açılır.
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      requireEmailVerification: env.requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
      // A-42: e-posta gönderimi T-116/T-117'ye kadar bağlı değil; sahte başarı yok.
      sendResetPassword: () => Promise.reject(new MailDeliveryDisabledError()),
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
      additionalFields: {
        // ADR-014 §12 / 4. tur BLOCKER-1: istemci yazamaz (`input: false`: db/schema.mjs:63-70) ve
        // `/update-session` kapalı (`disabledPaths`). Yalnızca sunucu kancaları yazar (T-112b).
        mfaVerifiedAt: { type: "date", required: false, input: false },
      },
    },
    user: {
      additionalFields: {
        // ADR-016 4. tur MAJOR-1: istemci yazamaz; yalnızca iç adaptörle (T-112b `createInvitedAccount`).
        invitationClaimId: { type: "string", required: false, input: false },
      },
    },
    // Doğrulama belirteçlerinin DB'de özetle saklanması (verification-token-storage.mjs; init-options.d.mts:1210).
    verification: { storeIdentifier: "hashed" },
    rateLimit: {
      enabled: true,
      ...RATE_LIMIT_RULES.general,
      // Yerleşik "database" modelinin yerine (anahtar özeti için) özel depolama; tablo adı yine eşlenir.
      modelName: "authRateLimit",
      fields: { key: "keyHash" },
      customStorage: createRateLimitStorage(client),
      customRules: {
        "/sign-in/email": RATE_LIMIT_RULES.signIn,
        "/request-password-reset": RATE_LIMIT_RULES.passwordReset,
        "/two-factor/*": RATE_LIMIT_RULES.twoFactor,
      },
    },
    // ADR-014 4. tur BLOCKER-1 (b): `/update-session` ucu kapalı (api/index.mjs:166-168 → 404).
    disabledPaths: ["/update-session"],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/request-password-reset") {
          // Kullanıcı var/yok ayrımı sızmaması için arama yapılmadan, her istek aynı yanıtla reddedilir.
          throw new APIError("SERVICE_UNAVAILABLE", {
            message: "MAIL_DELIVERY_DISABLED",
            code: "MAIL_DELIVERY_DISABLED",
          });
        }
        if (ctx.path === "/sign-out") {
          const current = await getSessionFromCtx(ctx);
          await emit(SECURITY_EVENT.logout, current?.user.id ?? null, ctx.request ?? ctx.headers, ctx.context.options);
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const failed = ctx.context.returned instanceof APIError;
        const source = ctx.request ?? ctx.headers;
        const options = ctx.context.options;
        switch (ctx.path) {
          case "/sign-in/email": {
            if (failed) {
              const email = typeof ctx.body?.email === "string" ? ctx.body.email : undefined;
              const known = email === undefined ? null : await ctx.context.internalAdapter.findUserByEmail(email);
              await emit(SECURITY_EVENT.loginFailed, known?.user.id ?? null, source, options, {
                reason: (ctx.context.returned as APIError).body?.code ?? "UNKNOWN",
              });
              return;
            }
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
            if (created) await emit(SECURITY_EVENT.loginSucceeded, created.user.id, source, options, { mfa: true });
            return;
          }
          case "/change-password": {
            if (failed) return;
            const current = await getSessionFromCtx(ctx);
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
              await emit(SECURITY_EVENT.twoFactorEnabled, user.id, ctx.request ?? ctx.headers, ctx.context.options);
            } else if (ctx.path === "/two-factor/disable" && user.twoFactorEnabled === false) {
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

  return {
    handler: (request) => auth.handler(request),

    async getPrincipal(headers) {
      const result = await auth.api.getSession({ headers });
      if (result === null || result === undefined) return null;
      const { session } = result;
      return {
        userId: session.userId,
        sessionId: session.id,
        authenticatedAt: new Date(session.createdAt),
        mfaVerified: session.mfaVerifiedAt !== null && session.mfaVerifiedAt !== undefined,
      };
    },

    async requireRecentAuth(principal, maxAgeSec) {
      if (!Number.isFinite(maxAgeSec) || maxAgeSec < 0) {
        throw new AuthConfigError("requireRecentAuth: maxAgeSec must be a non-negative number");
      }
      // Zaman istemciden değil DB saatinden (ADR-014 §14).
      const rows = await authDb.execute<{ age: string | number }>(
        sql`SELECT EXTRACT(EPOCH FROM (now() - ${principal.authenticatedAt.toISOString()}::timestamptz)) AS age`,
      );
      const age = Number(rows[0]?.age);
      if (!Number.isFinite(age) || age > maxAgeSec) throw new AuthError("REAUTH_REQUIRED");
    },

    async revokeUserSessions(userId) {
      const context = await auth.$context;
      await context.internalAdapter.deleteUserSessions(userId);
    },
  };
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
      eventClient: createDbClient({ url: parsed.databaseUrl, ...DB_CLIENT_SETTINGS }),
      env: parsed,
    });
  }
  return instance;
}

/** `apps/web/app/api/auth/[...all]/route.ts` için: ilk istekte örneği kurar. */
export const authRouteHandlers = Object.freeze({
  GET: (request: Request): Promise<Response> => getAuthService().handler(request),
  POST: (request: Request): Promise<Response> => getAuthService().handler(request),
});
