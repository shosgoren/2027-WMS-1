// `ObjectStorage` arayüzü + anahtar/bağlam kuralları (T-125, ADR-006; 02 §Tenant bağlamı).
// Sağlayıcı SDK'sı burada YOKTUR: yalnızca `packages/storage` import eder. Bu dosya ağ çağrısı yapmaz;
// anahtar normalizasyonu ve tenant önek denetimi saf işlevlerdir (ağsız unit test edilir).
//
// Anahtar = `tenants/<tenantId>/<relativeKey>`. Tenant kimliği ASLA çağıran dizgisinden alınmaz:
// `StorageContext` markalıdır ve yalnızca doğrulanmış üyelikten (`withMembership` → `Membership`)
// `storageContextFromMembership` ile üretilir; çalışma anında da WeakSet ile denetlenir.
import { AppError } from "./errors.ts";

declare const storageContextBrand: unique symbol;

/** Doğrulanmış tenant kimliği. Nesne literaliyle/dizgiyle oluşturulamaz. */
export interface StorageContext {
  readonly [storageContextBrand]: true;
  readonly tenantId: string;
}

/** `withMembership`'in verdiği `Membership`'ten yalnızca gereken alanlar (db paketine bağımlılık yok). */
export interface MembershipLike {
  readonly membershipId: string;
  readonly tenantId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const issued = new WeakSet<object>();

/** Doğrulanmış üyelikten depolama bağlamı. Üyelik biçimi/UUID geçersizse `FORBIDDEN`. */
export function storageContextFromMembership(membership: MembershipLike): StorageContext {
  const m: unknown = membership;
  const tenantId = typeof m === "object" && m !== null ? (m as { tenantId?: unknown }).tenantId : undefined;
  const membershipId = typeof m === "object" && m !== null ? (m as { membershipId?: unknown }).membershipId : undefined;
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId) || typeof membershipId !== "string" || membershipId === "") {
    throw new AppError("FORBIDDEN");
  }
  const ctx = Object.freeze({ tenantId: tenantId.toLowerCase() }) as unknown as StorageContext;
  issued.add(ctx);
  return ctx;
}

/** `storageContextFromMembership` ürünü mü (çalışma anı marka denetimi). */
export function isIssuedStorageContext(ctx: unknown): ctx is StorageContext {
  return typeof ctx === "object" && ctx !== null && issued.has(ctx);
}

export interface PutMeta {
  readonly contentType: string;
}

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string | undefined;
}

export interface ObjectStorage {
  /** Anahtarı `tenants/<ctx.tenantId>/<relativeKey>` olarak yazar; TAM anahtarı döndürür. */
  put(ctx: StorageContext, relativeKey: string, body: Uint8Array, meta: PutMeta): Promise<string>;
  /** `key` tam anahtardır; öneki `ctx` tenant'ı değilse ağ çağrısı yapmadan `FORBIDDEN`. Yoksa `NOT_FOUND`. */
  get(ctx: StorageContext, key: string): Promise<StoredObject>;
  delete(ctx: StorageContext, key: string): Promise<void>;
  /** Kısa ömürlü, yalnızca GET ve yalnızca bu anahtar için imzalı URL. */
  signedGetUrl(ctx: StorageContext, key: string, ttlSec: number): Promise<string>;
}

export const MAX_KEY_BYTES = 900;
export const MAX_SIGNED_URL_TTL_SEC = 3600;

// C0/C1 denetim karakterleri, bidi/sıfır genişlik biçimlendirme karakterleri ve U+FFFD.
const FORBIDDEN_CHARS_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁯﻿�]/u;

const LONE_SURROGATE_RE = /\p{Surrogate}/u;

function reject(): never {
  throw new AppError("VALIDATION_FAILED");
}

/**
 * `relativeKey`'i doğrular ve NFC'ye normalleştirir. Reddedilenler (`VALIDATION_FAILED`): boş, `/` ile başlayan
 * (mutlak), `\` içeren, boş bölüm (`//`, sondaki `/`), `.`/`..` bölümü, denetim karakteri, geçersiz Unicode,
 * NFKC altında `/`, `\`, `.`/`..` üreten benzer karakterler (ör. tam genişlikli nokta/eğik çizgi), aşırı uzunluk.
 */
export function normalizeRelativeKey(relativeKey: unknown): string {
  if (typeof relativeKey !== "string" || relativeKey === "") return reject();
  if (LONE_SURROGATE_RE.test(relativeKey)) return reject();
  const nfc = relativeKey.normalize("NFC");
  if (nfc.startsWith("/") || nfc.includes("\\") || FORBIDDEN_CHARS_RE.test(nfc)) return reject();
  const nfkc = nfc.normalize("NFKC");
  if (nfkc.includes("\\") || nfkc.startsWith("/") || FORBIDDEN_CHARS_RE.test(nfkc)) return reject();
  for (const form of [nfc, nfkc]) {
    for (const segment of form.split("/")) {
      if (segment === "" || segment === "." || segment === "..") return reject();
      // Sondaki nokta/boşluk bazı dosya sistemlerinde ve sağlayıcılarda sessizce kırpılır → `..` eşdeğeri.
      if (/^[. ]+$/.test(segment)) return reject();
    }
  }
  if (new TextEncoder().encode(nfc).length > MAX_KEY_BYTES) return reject();
  return nfc;
}

/** Tenant önekinin tek kaynağı. */
export function tenantKeyPrefix(ctx: StorageContext): string {
  if (!isIssuedStorageContext(ctx)) throw new AppError("FORBIDDEN");
  return `tenants/${ctx.tenantId}/`;
}

/** `put` anahtarı: önek + normalize edilmiş göreli anahtar. */
export function buildTenantKey(ctx: StorageContext, relativeKey: string): string {
  const prefix = tenantKeyPrefix(ctx);
  return prefix + normalizeRelativeKey(relativeKey);
}

/**
 * `get/delete/signedGetUrl` için tam anahtar denetimi (ağsız): önek `ctx` tenant'ı değilse `FORBIDDEN`
 * (başka tenant, öneksiz, büyük/küçük harf farkı dahil — birebir karşılaştırma); önek doğruysa kalan kısım
 * `normalizeRelativeKey`'den geçer (`tenants/<A>/../<B>/x` → `VALIDATION_FAILED`). Normalleştirilmiş tam anahtarı döndürür.
 */
export function assertOwnedKey(ctx: StorageContext, key: unknown): string {
  const prefix = tenantKeyPrefix(ctx);
  if (typeof key !== "string" || !key.startsWith(prefix)) throw new AppError("FORBIDDEN");
  const rest = normalizeRelativeKey(key.slice(prefix.length));
  const full = prefix + rest;
  // NFC dışı bir anahtar başka bir nesneye çözülebilir; yazılan anahtar yalnızca normalize biçimdir.
  if (full !== key) throw new AppError("VALIDATION_FAILED");
  return full;
}

export function assertSignedUrlTtl(ttlSec: unknown): number {
  if (typeof ttlSec !== "number" || !Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_SIGNED_URL_TTL_SEC) return reject();
  return ttlSec;
}
