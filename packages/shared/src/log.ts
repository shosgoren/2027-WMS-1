// Yapılandırılmış log (T-129, A-44): tek JSON satırı `{ ts, level, msg, service?, requestId?, tenantId?, userId?, ...alanlar }`.
// Web (`proxy.ts`, route'lar, kuyruk istemcisi) ve worker (`createJsonLogger`) bu modülü paylaşır. G-09: loga sır/kişisel
// veri girmez; bu modül SAVUNMA DERİNLİĞİdir (çağıran yine de sır göndermemelidir). Maskeleme her dize ve alan değerinde:
//  - anahtar adında `password|token|secret|key|code|otp` (+ `authorization`, `cookie`, `set-cookie`, `email`) → değer `***`;
//  - URL içindeki kimlik bilgisi (`scheme://user:pass@host`), `Bearer/Basic` değerleri, e-posta adresleri;
//  - sorgu parametresi adı aynı kümedeyse değer; davet / yönetici sıfırlama belirteci yolda (`/invite/<t>`,
//    `/api/auth/reset-password/<t>`) ve başka bir parametrenin içinde (`next=%2Finvite%2F<t>`, çift kodlu dahil).
// Kimlik alanları (`requestId`, `tenantId`, `userId`) yalnızca UUID olabilir; değilse `invalid-id` yazılır (kişisel veri yok).

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LogBindings {
  readonly service?: string;
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly userId?: string;
}

export interface JsonLogger extends Logger {
  warn(msg: string, fields?: Record<string, unknown>): void;
  /** Ek bağlam (ör. `requestId`) taşıyan alt logger; üst bağlamı korur. */
  child(bindings: LogBindings): JsonLogger;
}

export const MASK = "***";
export const INVALID_ID = "invalid-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPTH = 6;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Başlıktaki `x-request-id` yalnızca UUID biçimindeyse (küçük harfe çevrilmiş) döner; aksi halde `undefined`. */
export function requestIdFrom(headers: { get(name: string): string | null }): string | undefined {
  const raw = headers.get("x-request-id");
  return raw !== null && UUID.test(raw.trim()) ? raw.trim().toLowerCase() : undefined;
}

// --- anahtar adı maskeleme ---------------------------------------------------------------------------------------

const SENSITIVE_WORDS = new Set([
  "password", "passwd", "pwd", "token", "secret", "key", "code", "otp", "authorization", "cookie", "cookies", "credentials", "email",
]);
const SENSITIVE_COMPACT = /password|passwd|secret|token|apikey|setcookie|authorization/;

/** `camelCase`/`snake_case`/`kebab-case`/`a.b` adlarını sözcüklere böler; herhangi biri hassas kümedeyse true. */
export function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  return SENSITIVE_COMPACT.test(words.join(""));
}

// --- dize maskeleme ----------------------------------------------------------------------------------------------

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// `/` ya da kodlu biçimi (`%2F`, çift kodlu `%252F`) ile ayrılmış hassas yol parçası + belirteç.
const SEP = "(?:\\/|%2F|%252F)";
const TOKEN_PATH = new RegExp(`(${SEP}(?:invite|reset-password)${SEP})[^\\s/?#&"'%\\\\]+`, "gi");
// Ayraç/eşitlik kodlu biçimleri de kapsar (`next=%2Freset-password%3Ftoken%3D<t>`; `%3F`=`?`, `%26`=`&`, `%3D`=`=`).
const SENSITIVE_PARAM = /(^|[?&;\s]|%3F|%26|%253F|%2526)([\w.-]*(?:password|passwd|token|secret|key|code|otp|signature)[\w.-]*)(=|%3D|%253D)([^&#;\s"'%]*)/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** URL/yol/sorgu/başlık metnindeki sırları maskeler (günlük değeri, erişim günlüğü yolu). */
export function maskString(value: string): string {
  return value
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(BEARER, `$1 ${MASK}`)
    .replace(TOKEN_PATH, `$1${MASK}`)
    .replace(SENSITIVE_PARAM, `$1$2$3${MASK}`)
    .replace(EMAIL, `${MASK}@${MASK}`);
}

function maskValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return maskString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (value instanceof Error) return { name: value.name, message: maskString(value.message) };
  if (Array.isArray(value)) return value.map((v) => maskValue(v, depth + 1));
  if (value instanceof Headers) return maskObject(Object.fromEntries(value.entries()), depth);
  return maskObject(value as Record<string, unknown>, depth);
}

function maskObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = isSensitiveKey(k) ? MASK : maskValue(v, depth + 1);
  return out;
}

/** Alan nesnesini (iç içe dahil) maskeler; girdiyi değiştirmez. */
export function maskFields(fields: Record<string, unknown>): Record<string, unknown> {
  return maskObject(fields, 0);
}

// --- logger ------------------------------------------------------------------------------------------------------

function idField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return isUuid(value) ? value.toLowerCase() : INVALID_ID;
}

function bindingFields(b: LogBindings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.service !== undefined) out.service = maskString(b.service);
  const requestId = idField(b.requestId);
  const tenantId = idField(b.tenantId);
  const userId = idField(b.userId);
  if (requestId !== undefined) out.requestId = requestId;
  if (tenantId !== undefined) out.tenantId = tenantId;
  if (userId !== undefined) out.userId = userId;
  return out;
}

/**
 * Her kaydı tek JSON satırı olarak yazar. `ts`, `level`, `msg` ayrılmıştır (alanlar bunları ezemez); kimlik alanları
 * (`requestId|tenantId|userId`) çağrı alanlarında verilirse de UUID doğrulanır.
 */
export function createJsonLogger(
  write: (line: string) => void = (line) => {
    process.stdout.write(line + "\n");
  },
  now: () => Date = () => new Date(),
  base: LogBindings = {},
): JsonLogger {
  const build = (bindings: LogBindings): JsonLogger => {
    const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
      const { requestId, tenantId, userId, ...rest } = fields ?? {};
      const asId = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === "string" ? v : INVALID_ID);
      const merged: LogBindings = {
        ...bindings,
        ...(requestId === undefined ? {} : { requestId: asId(requestId) }),
        ...(tenantId === undefined ? {} : { tenantId: asId(tenantId) }),
        ...(userId === undefined ? {} : { userId: asId(userId) }),
      };
      const ts = now().toISOString();
      const text = maskString(msg);
      const line: Record<string, unknown> = { ts, level, msg: text, ...bindingFields(merged), ...maskFields(rest) };
      // Ayrılmış alanlar son: çağrı alanları ezemez (konum korunur).
      line.ts = ts;
      line.level = level;
      line.msg = text;
      write(JSON.stringify(line));
    };
    return {
      info: (msg, fields) => emit("info", msg, fields),
      warn: (msg, fields) => emit("warn", msg, fields),
      error: (msg, fields) => emit("error", msg, fields),
      child: (extra) => build({ ...bindings, ...extra }),
    };
  };
  return build(base);
}

/** Web süreci: satır `console.log` ile stdout'a (Fly log toplayıcısı). */
export function createConsoleLogger(service: string): JsonLogger {
  return createJsonLogger((line) => {
    console.log(line);
  }, undefined, { service });
}
