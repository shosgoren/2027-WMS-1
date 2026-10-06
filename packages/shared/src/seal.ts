// Kuyruk yükü mührü (ADR-016 §12, T-116 M2): AES-256-GCM, `node:crypto`. Alıcı adresi ve bağlantı kuyruğa
// yalnızca bu mühürle girer. Mühür `{ v, kid, iv, tag, ct }`; AAD = iş türü + şablon adı, bu yüzden başka işe
// veya şablona taşınan mühür açılmaz. Anahtar: `QUEUE_SEAL_KEY` (32 bayt; 64 hex karakter veya base64).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** `.env.example` yer tutucusu. Bu değerle (veya eksik/kısa anahtarla) çalışılmaz, yerel dahil. */
export const QUEUE_SEAL_KEY_PLACEHOLDER = "0".repeat(64);

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Anahtar yapılandırma hatası (boş, kısa/uzun, yer tutucu). Değer mesaja girmez (G-09). */
export class SealConfigError extends Error {
  override name = "SealConfigError";
}

/** Mühür açılamadı (yanlış anahtar, kurcalanmış veri, farklı AAD, bozuk biçim). Ayrıntı sızdırmaz. */
export class SealOpenError extends Error {
  override name = "SealOpenError";
}

export interface SealedBox {
  readonly v: 1;
  readonly kid: string;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

/** AAD bileşenleri: `email.send` işi için iş türü + şablon adı. */
export interface SealContext {
  readonly jobType: string;
  readonly template: string;
}

export interface Sealer {
  seal(plaintext: Readonly<Record<string, string>>, context: SealContext): SealedBox;
  open(sealed: unknown, context: SealContext): Record<string, string>;
}

function decodeKey(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === KEY_BYTES) return buf;
  }
  throw new SealConfigError(`QUEUE_SEAL_KEY ${KEY_BYTES} bayt olmalı (64 hex karakter veya base64)`);
}

/** Anahtarı doğrular; `kid` anahtarın SHA-256'sının ilk 8 hex karakteridir (anahtar döndürme için ayırt edici). */
export function createSealer(rawKey: string | undefined): Sealer {
  const trimmed = rawKey?.trim() ?? "";
  if (trimmed === "") throw new SealConfigError("QUEUE_SEAL_KEY tanımlı değil");
  if (trimmed === QUEUE_SEAL_KEY_PLACEHOLDER) {
    throw new SealConfigError("QUEUE_SEAL_KEY yer tutucu değerde; gerçek rastgele anahtar gerekir (openssl rand -hex 32)");
  }
  const key = decodeKey(trimmed);
  // Yer tutucu ham metne göre değil çözülmüş bayta göre reddedilir: tüm baytları aynı olan anahtar
  // (sıfır dahil; hex veya base64 yazımı fark etmez) kabul edilmez.
  if (key.every((b) => b === key[0])) {
    throw new SealConfigError("QUEUE_SEAL_KEY tek bayt tekrarından oluşuyor; gerçek rastgele anahtar gerekir (openssl rand -hex 32)");
  }
  const kid = createHash("sha256").update(key).digest("hex").slice(0, 8);
  const aadOf = (c: SealContext): Buffer => Buffer.from(`${c.jobType}\u0000${c.template}`, "utf8");

  return {
    seal(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadOf(context));
      const ct = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
      return {
        v: 1,
        kid,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ct.toString("base64"),
      };
    },
    open(sealed, context) {
      if (typeof sealed !== "object" || sealed === null) throw new SealOpenError("sealed box is malformed");
      const box = sealed as Record<string, unknown>;
      if (box.v !== 1 || box.kid !== kid) throw new SealOpenError("sealed box version or key id mismatch");
      if (typeof box.iv !== "string" || typeof box.tag !== "string" || typeof box.ct !== "string") {
        throw new SealOpenError("sealed box is malformed");
      }
      try {
        const iv = Buffer.from(box.iv, "base64");
        const tag = Buffer.from(box.tag, "base64");
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SealOpenError("sealed box is malformed");
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aadOf(context));
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
        const parsed: unknown = JSON.parse(pt.toString("utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new SealOpenError("sealed plaintext is malformed");
        }
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v !== "string") throw new SealOpenError("sealed plaintext is malformed");
          out[k] = v;
        }
        return out;
      } catch (err) {
        if (err instanceof SealOpenError) throw err;
        throw new SealOpenError("sealed box could not be opened");
      }
    },
  };
}
