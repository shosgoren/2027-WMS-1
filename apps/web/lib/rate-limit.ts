// Genel hız sınırı (T-127; 03 §Uygulama güvenliği; A-41). Sabit pencere sayaçları PLATFORM tablosu
// `request_rate_limits` içindedir (T-107): Fly'da çok süreç/makine aynı sayacı paylaşır (süreç belleği yetmez).
// Tek ifadeli `INSERT … ON CONFLICT DO UPDATE … RETURNING count` atomiktir (okuma-sonra-yazma yarışı yok).
// Anahtar = HMAC-SHA-256(sır, kapsam|değer): düşük entropili IP'nin sözlükle geri çevrilmesini önler (0004 notu).
// İstemci IP'si YALNIZCA `Fly-Client-IP`'den (M6); `X-Forwarded-For` istemci tarafından sahtelenebilir, yok sayılır.
// Better Auth'un kendi uç nokta sınırları ayrıdır ve burada değiştirilmez.
import { createHmac } from "node:crypto";
import { consumeRateLimit, getAppDb, type DbClient } from "@wms/db";
import { AppError } from "@wms/shared/errors";

export const WINDOW_SECONDS = 60;

/** A-41 varsayılanları (dakikada): IP 300 (her istek), kullanıcı 120 yazma, tenant 600 yazma. */
export const RATE_LIMITS = {
  ip: { scope: "web.ip", limit: 300 },
  user: { scope: "web.user", limit: 120 },
  tenant: { scope: "web.tenant", limit: 600 },
} as const;
export type RateLimitKind = keyof typeof RATE_LIMITS;

/** Aşımda fırlatılır; `retryAfterSeconds` yanıttaki `Retry-After` başlığına gider. */
export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED", { retryable: true });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitHit {
  readonly allowed: boolean;
  readonly count: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimitStore {
  /** Pencere sayacını bir artırır (atomik) ve sonucu döndürür. */
  hit(scope: string, keyHash: string, opts: { limit: number; windowSeconds: number; now: Date }): Promise<RateLimitHit>;
}

/** Üretim deposu: `@wms/db` `consumeRateLimit` (uygulama rolü, tek ifadeli UPSERT; DB yalnızca HMAC özetini görür). */
export function createDbRateLimitStore(client: DbClient): RateLimitStore {
  return {
    hit: (scope, keyHash, o) =>
      consumeRateLimit(client, { scope, keyHash, limit: o.limit, windowSeconds: o.windowSeconds, now: o.now }),
  };
}

/** İstemci IP'si: yalnızca `Fly-Client-IP` (yerelde çağıranın verdiği soket adresi); `X-Forwarded-For` yok sayılır. */
export function clientIp(headers: Headers, socketIp?: string): string {
  const fly = headers.get("fly-client-ip")?.trim();
  if (fly !== undefined && fly !== "") return fly;
  return socketIp !== undefined && socketIp !== "" ? socketIp : "unknown";
}

export function hashKey(secret: string, scope: string, value: string): string {
  return createHmac("sha256", secret).update(`${scope}|${value}`).digest("hex");
}

export interface RateLimiterDeps {
  readonly store: RateLimitStore;
  /** HMAC sırrı (üretimde `BETTER_AUTH_SECRET`; boşsa kurucu hata verir, fail-closed). */
  readonly secret: string;
  readonly now?: () => Date;
  readonly limits?: Partial<Record<RateLimitKind, number>>;
}

export interface RateLimiter {
  check(kind: RateLimitKind, subject: string): Promise<void>;
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  if (deps.secret.trim() === "") throw new Error("rate limit: secret is required");
  const now = deps.now ?? (() => new Date());
  return {
    async check(kind, subject) {
      const { scope, limit: dflt } = RATE_LIMITS[kind];
      const limit = deps.limits?.[kind] ?? dflt;
      const r = await deps.store.hit(scope, hashKey(deps.secret, scope, subject), { limit, windowSeconds: WINDOW_SECONDS, now: now() });
      if (!r.allowed) throw new RateLimitedError(r.retryAfterSeconds);
    },
  };
}

/**
 * Üretim sınırlayıcısı: DB havuzu ve HMAC sırrı (`BETTER_AUTH_SECRET`) her çağrıda tembel okunur (derleme anında değil).
 * Sır/DB yoksa hata fırlar → eylem `INTERNAL` ile reddedilir (fail-closed; sınır sessizce atlanmaz).
 */
export function createProductionLimiter(): RateLimiter {
  return {
    check: (kind, subject) =>
      createRateLimiter({ store: createDbRateLimitStore(getAppDb()), secret: process.env.BETTER_AUTH_SECRET ?? "" }).check(kind, subject),
  };
}
