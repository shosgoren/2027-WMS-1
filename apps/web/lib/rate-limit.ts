// Genel hız sınırı (T-127; 03 §Uygulama güvenliği; A-41). Sabit pencere sayaçları PLATFORM tablosu
// `request_rate_limits` içindedir (T-107): Fly'da çok süreç/makine aynı sayacı paylaşır (süreç belleği yetmez).
// Tek ifadeli `INSERT … ON CONFLICT DO UPDATE … RETURNING count` atomiktir (okuma-sonra-yazma yarışı yok).
// Anahtar = HMAC-SHA-256(HKDF(sır, "wms/rate-limit/v1"), kapsam|değer): düşük entropili IP'nin sözlükle geri çevrilmesini önler (0004 notu).
// İstemci IP'si YALNIZCA `Fly-Client-IP`'den (M6); `X-Forwarded-For` istemci tarafından sahtelenebilir, yok sayılır.
// GÜVEN VARSAYIMI: `Fly-Client-IP`'yi Fly edge proxy'si üzerine yazar (istemcinin gönderdiği değer korunmaz). Bu yalnızca
// trafik Fly edge'inden geçtiğinde doğrudur: uygulamaya 6PN (özel ağ) veya flycast ile edge ATLANARAK erişilirse başlık
// istemci denetimindedir ve sınır atlatılabilir. Bu yüzden uygulama genel kullanıma yalnızca edge üzerinden açılır;
// edge'i atlayan bir erişim yolu eklenirse bu varsayım yeniden değerlendirilmelidir (ADR notu T-105'te).
// Better Auth'un kendi uç nokta sınırları ayrıdır ve burada değiştirilmez.
import { createHmac, hkdfSync } from "node:crypto";
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

/**
 * Üretim tespiti `packages/auth` (`readAuthEnv`, index.ts) ile aynı kural: `NODE_ENV=production` VEYA `WMS_ENV` staging/production.
 * (Ortak yardımcı yok; auth paketi tüm ortamı doğrulayan `readAuthEnv`'i dışa aktarır, burada yalnızca bu kural gerekir.)
 */
export function isProductionEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.NODE_ENV === "production" || env.WMS_ENV === "staging" || env.WMS_ENV === "production";
}

export interface ClientIpOptions {
  /** Yerelde/yedek olarak soket adresi (Next Server Action'da yoktur; çağıran sağlarsa kullanılır). */
  readonly socketIp?: string | undefined;
  /** Varsayılan: `isProductionEnv()`. */
  readonly production?: boolean;
}

/**
 * IPv6 adresini /64 önekine indirger (bir kullanıcının tüm /64'ü tek kova: adres döndürerek sınır aşılamaz, MINOR-2);
 * IPv4 ve IPv4-eşlemeli IPv6 (`::ffff:a.b.c.d`) IPv4 olarak kalır. Tanınmayan biçim olduğu gibi döner.
 */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase().split("%")[0] ?? "";
  if (!ip.includes(":")) return ip;
  const mapped = /^(?:0{0,4}:){2,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  const halves = ip.split("::");
  if (halves.length > 2) return ip;
  const head = (halves[0] ?? "") === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 ? ((halves[1] ?? "") === "" ? [] : (halves[1] ?? "").split(":")) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * İstemci IP'si: YALNIZCA `Fly-Client-IP` (M6; `X-Forwarded-For` yok sayılır), yoksa soket adresi. İkisi de yoksa:
 * üretimde FAIL-CLOSED (ortak "bilinmeyen" kovası, tek istemcinin herkesi kilitlemesine yol açar; `FORBIDDEN`);
 * yalnızca geliştirmede `local-dev` kovası.
 */
export function clientIp(headers: Headers, opts: ClientIpOptions = {}): string {
  const fly = headers.get("fly-client-ip")?.trim();
  if (fly !== undefined && fly !== "") return normalizeIp(fly);
  const sock = opts.socketIp?.trim();
  if (sock !== undefined && sock !== "") return normalizeIp(sock);
  if (opts.production ?? isProductionEnv()) throw new AppError("FORBIDDEN");
  return "local-dev";
}

/** HKDF ile `BETTER_AUTH_SECRET`'ten amaca özel HMAC anahtarı (ham sır doğrudan HMAC'e girmez). */
export function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", "wms/rate-limit/v1", 32));
}

export function hashKey(key: Uint8Array, scope: string, value: string): string {
  return createHmac("sha256", key).update(`${scope}|${value}`).digest("hex");
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
  const key = deriveKey(deps.secret);
  const now = deps.now ?? (() => new Date());
  return {
    async check(kind, subject) {
      const { scope, limit: dflt } = RATE_LIMITS[kind];
      const limit = deps.limits?.[kind] ?? dflt;
      const r = await deps.store.hit(scope, hashKey(key, scope, subject), { limit, windowSeconds: WINDOW_SECONDS, now: now() });
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
