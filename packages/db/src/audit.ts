// Audit yardımcıları (T-107, ADR-016 §7, §10; I-12): `appendAudit` (tenant audit'i, çağıranın transaction'ında) ve
// `recordSecurityEvent` (platform olayı, kendi kısa transaction'ında).
//
// - `appendAudit(tx, entry)`: `tx` `withMembership`/`withSystemTenant`/`withNewTenant`'tan gelir (tip: `TenantTx`).
//   `tenant_id` PARAMETRE DEĞİLDİR: sütunun DEFAULT'u `app.current_tenant_id`'dir ve `wms_app`'in bu sütunda INSERT
//   yetkisi yoktur → başka tenant'a audit yazılamaz. Satır, çağıranın transaction'ının parçasıdır: geri alınırsa
//   audit satırı da yoktur. `occurred_at`/`created_xid` ve demo tenant'ta `ip`/`user_agent` = NULL (M9) tetikleyicide
//   zorlanır (çağıran atlatamaz).
// - Maskeleme: anahtar adı SEGMENT eşleşmesiyle ve değer desenleriyle (kurallar `SENSITIVE_SEGMENTS` yorumunda) →
//   `"[REDACTED]"`; derin nesne/dizi dahil. Boyut sınırı maskelemeden SONRA, özyineleme sırasında bütçeyle ölçülür; aşım
//   = `VALIDATION_FAILED` (sessiz kırpma yok).
// - Eylem listesi koddadır (`AUDIT_ACTIONS`); T-117/T-121/T-126 listeyi genişletir (DB'de yalnızca biçim CHECK'i var).
import { sql } from "drizzle-orm";
import { isUuid, rawDb, type DbClient, type TenantTx } from "./client.ts";

/** Kayıtlı audit eylemleri (T-107; genişletme: T-117, T-121, T-126). */
export const AUDIT_ACTIONS = [
  "member.invited",
  "member.removed",
  "member.role_changed",
  "member.left",
  "ownership.transferred",
  "invitation.revoked",
  "invitation.accepted",
  "tenant.created",
  "tenant.settings_changed",
  "onboarding.step_completed",
  "password_reset_link.issued",
  "audit.exported",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** `change_summary` en çok bu kadar bayt (JSON, maskelemeden sonra). */
export const CHANGE_SUMMARY_MAX_BYTES = 8192;
export const REDACTED = "[REDACTED]";

/**
 * Maskeleme kuralları (security-reviewer @79b2011 MAJOR-1, MINOR-1). Anahtar adı camelCase/snake_case/kebab-case
 * SEGMENTLERİNE bölünür ve segment eşleşmesi aranır (alt dize DEĞİL): `passwordHash`, `X-API-Key`, `set_cookie`
 * maskelenir; `barcode`, `postal_code`, `sku_code`, `monkey`, `hashtag` maskelenmez.
 *  - Tek başına duyarlı segmentler: aşağıdaki `SENSITIVE_SEGMENTS`.
 *  - `key` yalnızca önceki segment anahtar türünü belirtiyorsa duyarlıdır (`api_key`, `access_key`, `signing_key` …);
 *    çıplak `key` (stok/ürün anahtarı vb.) maskelenmez; `apikey` tek segmenttir ve listededir.
 *  - `code`/`codes`: doğrulama kodu olabilir. Anahtarın TAMAMI `code`/`codes` ise veya önceki segment
 *    otp/totp/verification/reset/auth/backup/recovery/mfa/sms/login/confirmation ise maskelenir; `postal_code`,
 *    `sku_code`, `country_code`, `barcode` değil. Gerekçe: hatalı pozitif (kayıp denetim bilgisi) hatalı negatiften
 *    (sızan tek kullanımlık kod) daha ucuzdur, ama iş alanı kodlarını (posta/ürün) gereksiz silmeyiz.
 *  - DEĞER taraması (anahtardan bağımsız): `Bearer <belirteç>`, base64 `Basic user:pass`, JWT deseni, URL'de duyarlı
 *    sorgu parametresi (`token=`, `password=`, `secret=`, `key=`, `sig=` …) → tüm değer maskelenir.
 *  - Ad/değer çiftleri: `{ name: "password", value: "x" }` ve `[["Authorization", "…"]]` → değer maskelenir.
 */
const SENSITIVE_SEGMENTS = new Set([
  "cookie", "authorization", "session", "sid", "credential", "credentials", "bearer", "jwt", "passphrase", "pwd",
  "pass", "signature", "sig", "private", "secret", "secrets", "token", "tokens", "password", "passwords", "passwd",
  "otp", "totp", "hash", "hashes", "apikey",
]);
const KEY_QUALIFIERS = new Set(["api", "access", "signing", "encryption", "auth", "master", "client", "secret", "private"]);
const CODE_QUALIFIERS = new Set(["otp", "totp", "verification", "reset", "auth", "backup", "recovery", "mfa", "sms", "login", "confirmation"]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((x) => x !== "")
    .map((x) => x.toLowerCase());
}

/** Anahtar adı duyarlı mı (segment eşleşmesi; yukarıdaki kurallar). */
export function isSensitiveKey(key: string): boolean {
  const seg = keySegments(key);
  for (let i = 0; i < seg.length; i++) {
    const w = seg[i] as string;
    const prev = i > 0 ? (seg[i - 1] as string) : undefined;
    if (SENSITIVE_SEGMENTS.has(w)) return true;
    if (w === "key" && prev !== undefined && KEY_QUALIFIERS.has(prev)) return true;
    if (w === "code" || w === "codes") {
      if (seg.length === 1) return true;
      if (prev !== undefined && CODE_QUALIFIERS.has(prev)) return true;
    }
  }
  return false;
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const BASIC_RE = /^\s*Basic\s+([A-Za-z0-9+/]{8,}={0,2})\s*$/i;
const QUERY_PARAM_RE = /[?&;]([^=&#;\s]+)=/g;

function isSensitiveParamName(name: string): boolean {
  const n = decodeURIComponentSafe(name);
  return isSensitiveKey(n) || /^(key|sig|auth|access_token|id_token|refresh_token)$/i.test(n);
}

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Değerde sır deseni var mı (anahtardan bağımsız). */
export function looksSensitiveValue(v: string): boolean {
  if (v.length < 8) return false;
  if (JWT_RE.test(v) || BEARER_RE.test(v)) return true;
  const basic = BASIC_RE.exec(v);
  if (basic !== null && Buffer.from(basic[1] as string, "base64").toString("utf8").includes(":")) return true;
  if (v.includes("=")) {
    for (const m of v.matchAll(QUERY_PARAM_RE)) {
      if (isSensitiveParamName(m[1] as string)) return true;
    }
  }
  return false;
}

/** Ad/değer çiftlerinin ad alanları (`{ name: "password", value: "x" }`). */
const PAIR_NAME_FIELDS = ["name", "key", "header", "field", "param", "parameter"] as const;

const MAX_DEPTH = 12;
/** Özyineleme bütçesi (MINOR-3): düğüm sayısı ve ÇIKTI bayt sayısı aşılınca erken ret (tam ağaç gezilmez). */
const MAX_NODES = 2000;

/** 15 §Hata kodları: audit girdisi geçersiz. */
export class AuditError extends Error {
  override name = "AuditError";
  readonly code = "VALIDATION_FAILED";
  constructor(message: string) {
    super(message);
  }
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface AuditEntry {
  /** Kayıtlı eylem (`AUDIT_ACTIONS`). */
  readonly action: AuditAction;
  /** Gerçek aktör; sistem işlemlerinde `null`/yok. */
  readonly actorUserId?: string | null;
  /** Adına işlem yapılan kullanıcı (destek erişimi vb.). */
  readonly onBehalfOfUserId?: string | null;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly reason?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
  /** Düz nesne; sır alanları maskelenir, boyut sınırı aşılırsa ret. */
  readonly changeSummary?: Readonly<Record<string, unknown>>;
}

export interface AppendedAudit {
  readonly id: string;
  /** `created_xid` (xid8, metin). */
  readonly createdXid: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

interface Budget {
  nodes: number;
  bytes: number;
  readonly maxBytes: number;
}

function spend(b: Budget, bytes: number): void {
  b.bytes += bytes;
  if (b.bytes > b.maxBytes) throw new AuditError(`change_summary exceeds ${b.maxBytes} bytes`);
}

function maskString(v: string, b: Budget): string {
  if (looksSensitiveValue(v)) {
    spend(b, REDACTED.length + 2);
    return REDACTED;
  }
  // Çıktı en az UTF-16 uzunluğu kadar bayt tutar: büyük dize tamamı kodlanmadan reddedilir.
  if (v.length > b.maxBytes) throw new AuditError(`change_summary exceeds ${b.maxBytes} bytes`);
  spend(b, Buffer.byteLength(JSON.stringify(v), "utf8"));
  return v;
}

function mask(value: unknown, depth: number, seen: Set<object>, b: Budget): JsonValue | undefined {
  if (depth > MAX_DEPTH) throw new AuditError("change_summary is nested too deeply");
  if (value === undefined) return undefined;
  if (++b.nodes > MAX_NODES) throw new AuditError("change_summary has too many elements");
  if (value === null) {
    spend(b, 4);
    return null;
  }
  if (typeof value === "boolean") {
    spend(b, 5);
    return value;
  }
  if (typeof value === "string") return maskString(value, b);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuditError("change_summary contains a non-finite number");
    spend(b, String(value).length);
    return value;
  }
  if (typeof value === "bigint") return maskString(value.toString(), b);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AuditError("change_summary contains an invalid date");
    return maskString(value.toISOString(), b);
  }
  if (typeof value !== "object") throw new AuditError("change_summary contains a non-JSON value");
  if (seen.has(value)) throw new AuditError("change_summary contains a circular reference");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      spend(b, 2);
      // `[["Authorization", "…"]]` biçimi: ilk eleman duyarlı bir ad ise geri kalan elemanlar maskelenir.
      const pair = value.length >= 2 && typeof value[0] === "string" && (isSensitiveKey(value[0]) || isSensitiveParamName(value[0]));
      return value.map((item, i) => {
        if (pair && i > 0) {
          spend(b, REDACTED.length + 3);
          return REDACTED;
        }
        spend(b, 1);
        return mask(item, depth + 1, seen, b) ?? null;
      });
    }
    if (!isPlainObject(value)) throw new AuditError("change_summary contains a non-plain object");
    spend(b, 2);
    // `{ name: "password", value: "x" }` biçimi.
    const namedSensitive = PAIR_NAME_FIELDS.some((f) => {
      const n = value[f];
      return typeof n === "string" && (isSensitiveKey(n) || isSensitiveParamName(n));
    });
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.length > b.maxBytes) throw new AuditError(`change_summary exceeds ${b.maxBytes} bytes`);
      spend(b, Buffer.byteLength(JSON.stringify(k), "utf8") + 1);
      if (isSensitiveKey(k) || (namedSensitive && k === "value")) {
        if (v !== undefined) {
          spend(b, REDACTED.length + 3);
          out[k] = REDACTED;
        }
        continue;
      }
      const m = mask(v, depth + 1, seen, b);
      if (m !== undefined) out[k] = m;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * `change_summary`/`detail` için maskeleme + boyut sınırı. Çıktı JSON metnidir. Nesne değilse veya sınır aşılırsa
 * `AuditError` (`VALIDATION_FAILED`).
 */
export function maskChangeSummary(summary: unknown, maxBytes: number = CHANGE_SUMMARY_MAX_BYTES): { json: string; value: JsonValue } {
  if (!isPlainObject(summary)) throw new AuditError("change_summary must be a plain object");
  const value = mask(summary, 0, new Set(), { nodes: 0, bytes: 0, maxBytes }) ?? {};
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new AuditError(`change_summary exceeds ${maxBytes} bytes`);
  }
  return { json, value };
}

function optUuid(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) throw new AuditError(`${what} is not a UUID`);
  return value;
}

function optText(value: unknown, what: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "" || value.length > max || value.includes("\u0000")) {
    throw new AuditError(`${what} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

/**
 * Audit satırını çağıranın transaction'ında yazar (I-12). Doğrulama hataları sorgu gönderilmeden fırlatılır.
 * `tx` tenant bağlamı kurulmuş transaction olmalıdır (aksi halde `tenant_id` NULL olur ve ekleme reddedilir).
 */
export async function appendAudit(tx: TenantTx, entry: AuditEntry): Promise<AppendedAudit> {
  if (typeof entry !== "object" || entry === null) throw new AuditError("audit entry is required");
  if (!(AUDIT_ACTIONS as readonly unknown[]).includes(entry.action)) {
    throw new AuditError("audit action is not registered");
  }
  const actor = optUuid(entry.actorUserId, "actorUserId");
  const onBehalf = optUuid(entry.onBehalfOfUserId, "onBehalfOfUserId");
  const entityType = optText(entry.entityType, "entityType", 64);
  const entityId = optText(entry.entityId, "entityId", 200);
  const reason = optText(entry.reason, "reason", 500);
  const ip = optText(entry.ip, "ip", 64);
  const userAgent = optText(entry.userAgent, "userAgent", 512);
  const requestId = optText(entry.requestId, "requestId", 128);
  const { json } = maskChangeSummary(entry.changeSummary ?? {});
  const rows = await tx.execute<{ id: string; created_xid: string }>(
    sql`INSERT INTO public.audit_logs
          (actor_user_id, on_behalf_of_user_id, action, entity_type, entity_id, reason, ip, user_agent, request_id, change_summary)
        VALUES (${actor}::uuid, ${onBehalf}::uuid, ${entry.action}, ${entityType}, ${entityId}, ${reason}, ${ip},
                ${userAgent}, ${requestId}, ${json}::jsonb)
        RETURNING id, created_xid::text AS created_xid`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("appendAudit: insert returned no row");
  return { id: row.id, createdXid: row.created_xid };
}

export interface SecurityEventInput {
  /** `security_events.event_type` (örn. `login_failed`); küçük harf, rakam, `_`, `.`. */
  readonly eventType: string;
  readonly userId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Demo kullanıcıları için (ADR-016 §10): `ip` ve `user_agent` yazılmaz. */
  readonly suppressNetworkMeta?: boolean;
}

const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * Platform olayını (tenant bağlamı olmadan) KENDİ kısa transaction'ında `security_events`'e yazar; `detail` aynı
 * maskelemeye ve boyut sınırına tabidir. Dönen değer olay kimliğidir.
 */
export async function recordSecurityEvent(client: DbClient, event: SecurityEventInput): Promise<string> {
  if (typeof event !== "object" || event === null) throw new AuditError("security event is required");
  if (typeof event.eventType !== "string" || !EVENT_TYPE.test(event.eventType)) {
    throw new AuditError("eventType is not a valid event type");
  }
  const userId = optUuid(event.userId, "userId");
  const suppress = event.suppressNetworkMeta === true;
  const ip = suppress ? null : optText(event.ip, "ip", 64);
  const userAgent = suppress ? null : optText(event.userAgent, "userAgent", 512);
  const requestId = optText(event.requestId, "requestId", 128);
  const { json } = maskChangeSummary(event.detail ?? {});
  const db = rawDb(client);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.security_events (user_id, event_type, ip, user_agent, request_id, detail)
          VALUES (${userId}::uuid, ${event.eventType}, ${ip}, ${userAgent}, ${requestId}, ${json}::jsonb)
          RETURNING id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("recordSecurityEvent: insert returned no row");
    return row.id;
  });
}
