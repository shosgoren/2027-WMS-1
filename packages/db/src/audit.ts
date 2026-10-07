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
  "warehouse.created",
  "warehouse.updated",
  "warehouse.archived",
  "warehouse.code_changed",
  "location.created",
  "location.updated",
  "location.archived",
  "location.code_changed",
  "warehouse_scope.changed",
  "unit.created",
  "unit.updated",
  "item.created",
  "item.updated",
  "item.archived",
  "item.code_changed",
  "item_barcode.added",
  "item_barcode.removed",
  "unit_conversion.set",
  "lot.created",
  "serial.registered",
  "handling_unit.created",
  "handling_unit.changed",
  "stock_document.created",
  "stock_document.updated",
  "stock_document.approved",
  "stock_document.posted",
  "stock_document.cancelled",
  "stock_document.reversed",
  "reservation.created",
  "reservation.released",
  "external_ref.linked",
  "warehouse_task.created",
  "warehouse_task.assigned",
  "warehouse_task.claimed",
  "warehouse_task.cancelled",
  "warehouse_task.completed",
  // T-305: beklenen teslim (kabul belgesi) yaşam döngüsü ve fiziksel kabul; stok etkisi ayrıca `stock_document.posted` ile denetlenir.
  "inbound_receipt.created",
  "inbound_receipt.opened",
  "inbound_receipt.cancelled",
  "inbound_receipt.received",
  // T-306: müşteri siparişi yaşam döngüsü; sipariş tahsisi `reservation.created`, serbest bırakma `reservation.released` ile ayrıca denetlenir.
  "sales_order.created",
  "sales_order.updated",
  "sales_order.cancelled",
  "sales_order.line_cancelled",
  // T-307: toplama görevlendirmesi (stok etkisi yok; görevler ayrıca `warehouse_task.created`) ve "ürün bulunamadı" bildirimi
  // (lokasyon `pick_blocked` olur, sayım görevi açılır; stok etkisi varsa ayrıca `stock_document.posted`).
  "pick_assignment.created",
  "pick.not_found",
  // T-309: kilitli sayım yaşam döngüsü (stok etkisi varsa fark fişi ayrıca `stock_document.posted`; kilit açma `count.posted`/`count.cancelled` ile aynı transaction'da).
  "count.started",
  "count.recorded",
  "count.submitted",
  "count.approved",
  "count.posted",
  "count.cancelled",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** `change_summary` en çok bu kadar bayt (JSON, maskelemeden sonra). */
export const CHANGE_SUMMARY_MAX_BYTES = 8192;
export const REDACTED = "[REDACTED]";

/**
 * Maskeleme kuralları (kart madde 3; security-reviewer @1f60d5b BLOCKER/MAJOR; Supervisor kararı).
 *  - ANAHTAR adı: büyük/küçük harf duyarsız ALT DİZE eşleşmesi `password|token|secret|totp|code|hash|otp|key` (kart
 *    ölçütü) ve genişletilmiş liste `cookie|authorization|session|credential|bearer|jwt|passphrase|pwd|pass|signature|
 *    private|auth|pin|salt|digest`; ayrıca `sid` yalnızca ayrı SEGMENT olarak (alt dize `inside`, `side` gibi sözcükleri
 *    gereksiz yakalardı). FAZLA MASKELEME KABUL EDİLİR (güvenli yön): `barcode`, `postal_code`, `shipping` da maskelenir.
 *  - 256 karakterden uzun anahtar/ad → maskelenir (fail-closed, ReDoS yok); alt dize taraması doğrusaldır.
 *  - DEĞER taraması (anahtardan bağımsız; desenler sınırlı niceleyicili/doğrusal): JWT deseni (`eyJ…`.`…`), dize içinde
 *    herhangi bir yerde `Authorization:` / `Bearer ` / `Basic ` / `Token ` (+ yeni satır dahil boşluk) + belirteç,
 *    kullanıcı bilgili URL (`şema://[kullanıcı][:parola]@`, `/` içerebilir), ve GENEL desen: dize içinde herhangi bir
 *    yerde `<ad>["']?\s*[:=]` ve ad duyarlıysa (`x-api-key: …`, `"password":"…"`, `?token=`, `#access_token=`, `sid=`,
 *    `auth[token]=`, yüzde kodlu ad çözülür, 128'den uzun ad fail-closed) TÜM değer maskelenir.
 *  - 4096 karakterden uzun dize değeri FAIL-CLOSED: tamamı `[REDACTED]` (kısmi tarama sınır kesen belirteci kaçırırdı;
 *    uzun düz metin kaybı kabul edilir). `{`/`[` ile başlayan ≤4096 dize JSON.parse edilir; ağaçta duyarlı anahtar/değer
 *    varsa TÜM dize `[REDACTED]`, yoksa ORİJİNAL dize aynen (yeniden serileştirme yok); ayrıştırma bütçesi (derinlik/
 *    düğüm) aşılırsa tüm dize maskelenir (kayıt reddedilmez). Ayrıştırılamazsa yukarıdaki dize kuralları uygulanır
 *    (kaçışlı `{\"password\":…}`, `\uXXXX` kaçışlı ad, NBSP/`：` ayraç/boşluk dahil).
 *  - Nesne ANAHTARLARINA da değer taraması uygulanır: duyarlı görünen anahtarın değeri maskelenir ve anahtar
 *    `[REDACTED_KEY_n]` ile değiştirilir.
 *  - Bilinen sınır: kural tabanlı maskeleme heuristiktir; ad taşımayan, desene uymayan çıplak sır (ör. rastgele
 *    hex) yalnızca anahtar adı duyarlıysa maskelenir. Çağıranlar sırları değer olarak `changeSummary`'e koymamalıdır.
 *  - Ad/değer çiftleri: `{ name|key|header|field: <duyarlı>, value|val|content|data: … }`, `[["Authorization","…"]]` ve
 *    düz başlık dizisi `[k1, v1, k2, v2]` (çift sıradaki eleman adı duyarlıysa sonraki maskelenir).
 */
const KEY_SUBSTRINGS = [
  "password", "token", "secret", "totp", "code", "hash", "otp", "key",
  "cookie", "authorization", "session", "credential", "bearer", "jwt", "passphrase", "pwd", "pass", "signature",
  "private", "auth", "pin", "salt", "digest",
];
const MAX_NAME_LENGTH = 256;
const VALUE_SCAN_LIMIT = 4096;

/** `sid` ayrı segmenti için doğrusal (regex'siz) parçalayıcı: camel/snake/kebab sınırları. */
function hasSegment(name: string, segment: string): boolean {
  const n = name.length;
  const isUpper = (c: string) => c >= "A" && c <= "Z";
  const isLower = (c: string) => c >= "a" && c <= "z";
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isAlnum = (c: string) => isUpper(c) || isLower(c) || isDigit(c);
  let start = -1;
  const hit = (end: number): boolean => name.slice(start, end).toLowerCase() === segment;
  for (let i = 0; i < n; i++) {
    const c = name[i] as string;
    if (!isAlnum(c)) {
      if (start >= 0 && hit(i)) return true;
      start = -1;
      continue;
    }
    if (start < 0) {
      start = i;
      continue;
    }
    const p = name[i - 1] as string;
    const split =
      (isUpper(c) && (isLower(p) || isDigit(p))) || (isUpper(c) && isUpper(p) && i + 1 < n && isLower(name[i + 1] as string));
    if (split) {
      if (hit(i)) return true;
      start = i;
    }
  }
  return start >= 0 && hit(n);
}

/** Anahtar/ad duyarlı mı (alt dize listesi + `sid` segmenti; çok uzun ad → fail-closed). */
export function isSensitiveKey(key: string): boolean {
  if (key.length > MAX_NAME_LENGTH) return true;
  const lower = key.toLowerCase();
  for (const sub of KEY_SUBSTRINGS) if (lower.includes(sub)) return true;
  return hasSegment(key, "sid");
}

/** Ad/parametre adı (sorgu, çerez, JSON/başlık anahtarı): anahtar kuralı + tam `sig`; yüzde kodlu ad çözülür. */
function isSensitiveParamName(name: string): boolean {
  if (name.length > MAX_PARAM_NAME_LENGTH) return true; // fail-closed
  let n = name;
  if (n.includes("%")) {
    try {
      n = decodeURIComponent(n);
    } catch {
      /* geçersiz kodlama: ham ad denenir */
    }
  }
  return isSensitiveKey(n) || n.toLowerCase() === "sig";
}

// Bütün desenler doğrusal ya da sınırlı niceleyicilidir; girdi zaten en çok 4096 karakterdir.
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{0,4096}/;
const AUTH_TOKEN_RE = /(?:Bearer|Basic|Token)\s{1,16}\S{8,}/i;
// `şema://[kullanıcı][:parola]@` — boş kullanıcı, kaçışsız `/` ve `:` içeren userinfo dahil (sınır 256).
const USERINFO_URL_RE = /[A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/[^@\s]{0,256}@/;
const MAX_PARAM_NAME_LENGTH = 128;

function isNameChar(c: string): boolean {
  return (
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "." || c === "-" ||
    c === "%" || c === "[" || c === "]"
  );
}

/** Ad ile ayraç arasında atlanan boşluklar (NBSP, Unicode boşlukları dahil). */
function isSpaceChar(c: string): boolean {
  return (
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\u00a0" || c === "\u3000" || c === "\u2028" ||
    c === "\u2029" || c === "\ufeff" || c === "\u202f" || c === "\u205f" || (c >= "\u2000" && c <= "\u200b")
  );
}

/** Ad/değer ayracı: `:`, `=`, tam genişlikli `：` (U+FF1A) ve `＝` (U+FF1D). */
function isSeparator(c: string): boolean {
  return c === ":" || c === "=" || c === "\uff1a" || c === "\uff1d" || c === "\u2236" || c === "\ufe55";
}

/** `\uXXXX` kaçışlarını çözer (ayrıştırılamayan dizelerde ad koşusu `\u0070assword` gibi gizlenemesin). */
function decodeUnicodeEscapes(v: string): string {
  return v.includes("\\u") ? v.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) : v;
}

/**
 * Genel `<ad>[\\]*["']?\s*[:=]` deseni (regex'siz, tek geçiş, doğrusal): dize içinde herhangi bir yerde, adı duyarlı
 * olan bir ad/değer ayracı (`x-api-key: …`, `password: …`, `"password":"…"`, kaçışlı `{\"password\":…}`, `?token=…`,
 * `#access_token=…`, `sid=…`, `auth[token]=…`). Ad = ayraçtan önceki ad karakterleri koşusu (köşeli parantez içi
 * dahil); 128'den uzun ad → true. Ad ile ayraç arasında ters bölü, tırnak ve (sınırsız) boşluk atlanır.
 */
function hasSensitiveKeyedPair(v: string): boolean {
  const n = v.length;
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? (v[i] as string) : "";
    if (c !== "" && isNameChar(c)) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const run = v.slice(runStart, i);
      // Yüzde kodlu ayraç (`password%3Dx`, `%22password%22%3A…`): ayraçtan önceki ad duyarlı mı.
      const enc = run.search(/%3[adAD]/);
      if (enc > 0 && isSensitiveParamName(run.slice(0, enc))) return true;
      // Ad ile ayraç arasında boşluk, tırnak, kaçış dizileri (`\"`, `\t`, `\n`) ve HTML tırnak varlıkları atlanır.
      let j = i;
      while (j < n) {
        const d = v[j] as string;
        if (isSpaceChar(d) || d === '"' || d === "'") {
          j++;
        } else if (d === "\\" && j + 1 < n && '\\"\'/tnrfv'.includes(v[j + 1] as string)) {
          j += 2;
        } else if (d === "\\") {
          j++;
        } else if (d === "&") {
          const ent = ["&quot;", "&#34;", "&#x22;", "&apos;", "&#39;", "&#x27;"].find((e) => v.startsWith(e, j));
          if (ent === undefined) break;
          j += ent.length;
        } else {
          break;
        }
      }
      if (j < n && isSeparator(v[j] as string) && isSensitiveParamName(run)) return true;
      runStart = -1;
    }
  }
  return false;
}

/**
 * Değerde sır deseni var mı (anahtardan bağımsız). 4096 karakterden uzun dizeler FAIL-CLOSED duyarlı sayılır (tamamı
 * maskelenir; kısmi tarama sınırı kesen belirteci kaçırırdı). JSON dizeleri `maskString` içinde yapısal işlenir.
 */
export function looksSensitiveValue(raw: string): boolean {
  if (raw.length > VALUE_SCAN_LIMIT) return true;
  if (raw.length < 8) return false;
  const v = decodeUnicodeEscapes(raw);
  if (v.toLowerCase().includes("authorization:")) return true;
  if (JWT_RE.test(v) || AUTH_TOKEN_RE.test(v) || USERINFO_URL_RE.test(v)) return true;
  return hasSensitiveKeyedPair(v);
}

/** Ad/değer çiftlerinin ad ve değer alanları. */
const PAIR_NAME_FIELDS = ["name", "key", "header", "field"] as const;
const PAIR_VALUE_FIELDS = new Set(["value", "values", "val", "content", "data"]);

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

/**
 * Dize içi JSON (`{`/`[` ile başlar, ≤ 4096) ayrıştırılır ve ağaç AYNI maskeleme kurallarıyla (bağımsız bütçe) gezilir:
 * maskelenecek bir şey bulunursa TÜM dize `[REDACTED]`; bulunmazsa ORİJİNAL dize aynen kalır (yeniden serileştirme
 * yok: sayı/kaçış/`__proto__` biçimleri bozulmaz). Ayrıştırma bütçesi (derinlik/düğüm) aşılırsa da tüm dize
 * maskelenir (kayıt reddedilmez; `VALIDATION_FAILED` yalnızca üst düzey yapı bütçesi içindir).
 */
function jsonStringHasSecret(v: string, parsed: unknown): boolean {
  try {
    const masked = mask(parsed, 0, new Set(), { nodes: 0, bytes: 0, maxBytes: 1 << 20 });
    return JSON.stringify(masked) !== JSON.stringify(parsed);
  } catch (e) {
    if (e instanceof AuditError) return true;
    throw e;
  }
}

function maskString(v: string, b: Budget): string {
  if (v.length <= VALUE_SCAN_LIMIT && (v.startsWith("{") || v.startsWith("["))) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(v);
      ok = typeof parsed === "object" && parsed !== null;
    } catch {
      ok = false;
    }
    if (ok) {
      // JSON.parse yinelenen anahtarda yalnızca sonuncuyu tutar: temiz sayılan ağaçta bile HAM dizeye dize kuralları
      // (anahtar:değer, Bearer, userinfo URL, JWT …) ayrıca uygulanır; eşleşirse tüm dize maskelenir (fail-closed).
      if (jsonStringHasSecret(v, parsed) || looksSensitiveValue(v)) {
        spend(b, REDACTED.length + 2);
        return REDACTED;
      }
      spend(b, Buffer.byteLength(JSON.stringify(v), "utf8"));
      return v;
    }
  }
  if (looksSensitiveValue(v)) {
    spend(b, REDACTED.length + 2);
    return REDACTED;
  }
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
      // Ad/değer dizileri: `[["Authorization","…"]]` (ilk eleman ad) ve düz `[k1, v1, k2, v2]` (çift sırada ad).
      const nested = value.length >= 2 && typeof value[0] === "string" && isSensitiveParamName(value[0]);
      return value.map((item, i) => {
        const afterName = i > 0 && typeof value[i - 1] === "string" && (i - 1) % 2 === 0 && isSensitiveParamName(value[i - 1] as string);
        if ((nested && i > 0) || afterName) {
          spend(b, REDACTED.length + 3);
          return REDACTED;
        }
        spend(b, 1);
        return mask(item, depth + 1, seen, b) ?? null;
      });
    }
    if (!isPlainObject(value)) throw new AuditError("change_summary contains a non-plain object");
    spend(b, 2);
    // MINOR-5: anahtar sayısı bütçeyi aşıyorsa girdiler gezilmeden reddedilir.
    const keys = Object.keys(value);
    if (keys.length > MAX_NODES) throw new AuditError("change_summary has too many elements");
    // `{ name: "password", value: "x" }` biçimi.
    const namedSensitive = PAIR_NAME_FIELDS.some((f) => {
      const n = value[f];
      return typeof n === "string" && isSensitiveParamName(n);
    });
    // Null-prototip: `__proto__` gibi anahtarlar sıradan özellik olarak kalır.
    const out = Object.create(null) as Record<string, JsonValue>;
    const original = new Set(keys);
    let redactedKeys = 0;
    for (const k of keys) {
      const v = value[k];
      if (k.length > b.maxBytes) throw new AuditError(`change_summary exceeds ${b.maxBytes} bytes`);
      let outKey = k;
      let hide = isSensitiveKey(k) || (namedSensitive && PAIR_VALUE_FIELDS.has(k.toLowerCase()));
      // MINOR-3: anahtar dizesi de değer desenlerine bakılır (ör. `Bearer …` anahtarı): değer maskelenir, anahtar
      // çakışmasız `[REDACTED_KEY_n]` ile değiştirilir (sır anahtar adı olarak da saklanmaz).
      if (looksSensitiveValue(k)) {
        hide = true;
        do {
          outKey = `[REDACTED_KEY_${redactedKeys++}]`;
        } while (original.has(outKey) || Object.hasOwn(out, outKey));
      }
      spend(b, Buffer.byteLength(JSON.stringify(outKey), "utf8") + 1);
      if (hide) {
        if (v !== undefined) {
          spend(b, REDACTED.length + 3);
          out[outKey] = REDACTED;
        }
        continue;
      }
      const m = mask(v, depth + 1, seen, b);
      if (m !== undefined) out[outKey] = m;
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

export interface RecordSecurityEventOptions {
  /**
   * `false`: `RETURNING id` kullanılmaz (T-112c). `wms_auth`'ın `security_events` üzerinde SELECT yetkisi yoktur
   * (0002; append-only okuma sızıntısı yok) → `INSERT ... RETURNING` 42501 verir. İstemci UUID'si seçilmedi: `id`
   * sütununda INSERT yetkisi bilinçli verilmemiştir (0002), olay kimliği sunucu varsayılanıdır.
   */
  readonly returning?: boolean;
}

/**
 * Platform olayını (tenant bağlamı olmadan) KENDİ kısa transaction'ında `security_events`'e yazar; `detail` aynı
 * maskelemeye ve boyut sınırına tabidir. Varsayılan: olay kimliği döner (SELECT yetkisi gerekir: `wms_app`);
 * `{ returning: false }`: kimlik dönmez (`wms_auth`). Kimlik sınıfı olaylar (`login_*`, `reauth.*`, …) DB'de
 * yalnızca `wms_auth` ile yazılabilir (0005 tetikleyicisi, 42501).
 */
export async function recordSecurityEvent(client: DbClient, event: SecurityEventInput): Promise<string>;
export async function recordSecurityEvent(
  client: DbClient,
  event: SecurityEventInput,
  options: RecordSecurityEventOptions & { readonly returning: false },
): Promise<void>;
export async function recordSecurityEvent(
  client: DbClient,
  event: SecurityEventInput,
  options?: RecordSecurityEventOptions,
): Promise<string | void> {
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
  if (options?.returning === false) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO public.security_events (user_id, event_type, ip, user_agent, request_id, detail)
            VALUES (${userId}::uuid, ${event.eventType}, ${ip}, ${userAgent}, ${requestId}, ${json}::jsonb)`,
      );
    });
    return;
  }
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
