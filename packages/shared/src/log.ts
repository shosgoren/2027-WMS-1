// Yapılandırılmış log (T-129, A-44): tek JSON satırı `{ ts, level, msg, service?, requestId?, tenantId?, userId?, ...alanlar }`.
// Web (`proxy.ts`, route'lar, kuyruk istemcisi) ve worker (`createJsonLogger`) bu modülü paylaşır. G-09: loga sır/kişisel
// veri girmez; bu modül SAVUNMA DERİNLİĞİdir (çağıran yine de sır göndermemelidir). Maskeleme her dize ve alan değerinde:
//  - anahtar adında `password|token|secret|key|code|otp` (+ `authorization`, `cookie`, `set-cookie`, `email`) → değer `***`;
//  - URL içindeki kimlik bilgisi (`scheme://user:pass@host`), `Bearer/Basic` değerleri, e-posta adresleri;
//  - sorgu parametresi adı aynı kümedeyse değer; davet / yönetici sıfırlama belirteci yolda (`/invite/<t>`,
//    `/api/auth/reset-password/<t>`) ve başka bir parametrenin içinde (`next=%2Finvite%2F<t>`, çift kodlu dahil).
// Sınırlar (ReDoS/şişme): her dize `MAX_LOG_STRING` (2048) karakterde kesilir (`…[truncated]`); maskeleme tarayıcıları DOĞRUSALDIR
// (düzenli ifade geri izlemesi yok: sınırlı geriye bakışlı elle tarama). Nesne anahtarı/dizi öğesi sayısı `MAX_ENTRIES` (50),
// derinlik 6. `Error` yalnızca `name` + maskeli `message` olarak yazılır (`stack`/`cause` YAZILMAZ; çağıran gerekirse maskeli
// dize olarak kendi `stack` alanını verir, o da kesilir). Log çağrısı ASLA fırlatmaz (BigInt/getter/toJSON hataları yer tutucuya düşer).
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

export const MAX_LOG_STRING = 2048;
export const MAX_ENTRIES = 50;
const TRUNCATED = "…[truncated]";

const SENSITIVE_WORDS = new Set([
  "password", "passwd", "pass", "pwd", "token", "secret", "key", "code", "otp", "authorization", "cookie", "cookies",
  "credentials", "email", "session", "sid", "jwt", "dsn", "signature",
]);
const SENSITIVE_COMPACT = /password|passwd|secret|token|apikey|setcookie|authorization/;
/** Hassas sözcük içerse de kimlik/durum bilgisi olan, bilinen güvenli alan adları (sıkı eşleşme; küçük harf, ayraçsız). */
const SAFE_KEYS = new Set(["errorcode", "statuscode", "sqlstate", "exitcode", "keycount", "sessioncount"]);

/** `camelCase`/`snake_case`/`kebab-case`/`a.b` adlarını sözcüklere böler; herhangi biri hassas kümedeyse true. */
export function isSensitiveKey(key: string): boolean {
  const k = key.length > 128 ? key.slice(0, 128) : key;
  const words = k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  if (SAFE_KEYS.has(words.join(""))) return false;
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  return SENSITIVE_COMPACT.test(words.join(""));
}

// --- dize maskeleme (doğrusal tarayıcılar) -----------------------------------------------------------------------

const NAME_CHAR = /[\w.-]/;
const NAME_MAX = 64;
const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

/** `scheme://user:pass@host` → `scheme://***@host`. Parola `#`/`@` içerebilir: yetki bölümü boşluk/tırnak/`/`/`?`'a kadar, SON `@`'e kadar maskelenir. */
function maskUrlCredentials(s: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = s.indexOf("://", i);
    if (at < 0) break;
    // Şema: geriye en çok 32 karakter [a-z0-9+.-], ilki harf.
    let st = at;
    while (st > i && at - st < 32 && /[A-Za-z0-9+.-]/.test(s.charAt(st - 1))) st--;
    while (st < at && !/[A-Za-z]/.test(s.charAt(st))) st++;
    const authStart = at + 3;
    let j = authStart;
    let lastAt = -1;
    while (j < s.length) {
      const c = s.charAt(j);
      if (isWs(c) || c === "/" || c === "?" || c === '"' || c === "'" || c === "<" || c === ">") break;
      if (c === "@") lastAt = j;
      j++;
    }
    if (st < at && lastAt >= 0) {
      out += s.slice(i, authStart) + MASK + "@";
      i = lastAt + 1;
    } else {
      out += s.slice(i, authStart);
      i = authStart;
    }
  }
  return out + s.slice(i);
}

const BEARER = /\b(Bearer|Basic)[ \t]{1,8}[A-Za-z0-9._~+/=-]{1,2048}/g;
// `/` ya da kodlu biçimi (`%2F`, çift kodlu `%252F`) ile ayrılmış hassas yol parçası + belirteç. Tek sabit önek: geri izleme yok.
const SEP = "(?:\\/|%2F|%252F)";
const TOKEN_PATH = new RegExp(`(${SEP}(?:invite|reset-password)${SEP})[^\\s/?#&"'%\\\\]{1,2048}`, "gi");

const VALUE_STOP_PARAM = new Set(["&", "#", ";", '"', "'", "%", " ", "\t", "\n", "\r"]);
const VALUE_STOP_COLON = new Set(["\n", "\r", ",", '"', "'", "}", "]", "&", "#", ";"]);

/**
 * `ad=değer`, `ad%3Ddeğer`, `ad: değer`, `"ad":"değer"`, `x-api-key: değer` biçimlerinde ad hassassa değeri maskeler.
 * Her ayırıcı için geriye en çok `NAME_MAX` karakter bakılır; değer ilerlerken tüketilir → toplam iş doğrusal.
 */
function maskKeyValues(s: string): string {
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    let sepLen = 0;
    let colon = false;
    if (c === "=") sepLen = 1;
    else if (c === ":") {
      sepLen = 1;
      colon = true;
    } else if (c === "%" && /^%(?:25)?3D/i.test(s.slice(i, i + 6))) sepLen = /^%253D/i.test(s.slice(i, i + 6)) ? 6 : 3;
    if (sepLen === 0) {
      i++;
      continue;
    }
    // Ad: ayırıcıdan geriye (kapanış tırnağı/boşluk atlanır; yalnızca ':' biçiminde).
    let e = i;
    if (colon) {
      while (e > copied && (s.charAt(e - 1) === '"' || s.charAt(e - 1) === "'" || s.charAt(e - 1) === " ")) e--;
    }
    let st = e;
    while (st > copied && e - st < NAME_MAX && NAME_CHAR.test(s.charAt(st - 1))) st--;
    const name = s.slice(st, e);
    if (name === "" || !isSensitiveKey(name)) {
      i += sepLen;
      continue;
    }
    // Değer.
    let v = i + sepLen;
    if (colon) while (v < s.length && (s.charAt(v) === " " || s.charAt(v) === "\t")) v++;
    let end = v;
    const q = s.charAt(v);
    if (colon && (q === '"' || q === "'")) {
      end = v + 1;
      while (end < s.length && s.charAt(end) !== q) end += s.charAt(end) === "\\" ? 2 : 1;
      end = Math.min(end, s.length);
      out += s.slice(copied, v + 1) + MASK;
      copied = end;
      i = Math.min(end + 1, s.length);
      continue;
    }
    const stop = colon ? VALUE_STOP_COLON : VALUE_STOP_PARAM;
    while (end < s.length && !stop.has(s.charAt(end))) end++;
    if (end === v) {
      i += sepLen;
      continue;
    }
    out += s.slice(copied, v) + MASK;
    copied = end;
    i = end;
  }
  return out + s.slice(copied);
}

const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
/** E-posta adresleri → `***@***`. '@' başına sınırlı geriye (64) ve ileriye (255) tarama. */
function maskEmails(s: string): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const at = s.indexOf("@", from);
    if (at < 0) break;
    from = at + 1;
    let st = at;
    while (st > copied && at - st < 64 && LOCAL_CHAR.test(s.charAt(st - 1))) st--;
    let en = at + 1;
    while (en < s.length && en - at < 256 && DOMAIN_CHAR.test(s.charAt(en))) en++;
    // Alan adı: sondaki ayraçlar atılır; en az bir nokta ve ≥2 harfli TLD.
    let dom = s.slice(at + 1, en);
    while (dom.endsWith(".") || dom.endsWith("-")) dom = dom.slice(0, -1);
    if (st === at || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(dom)) continue;
    out += s.slice(copied, st) + `${MASK}@${MASK}`;
    copied = at + 1 + dom.length;
    from = copied;
  }
  return out + s.slice(copied);
}

function passes(v: string): string {
  return maskEmails(maskKeyValues(maskUrlCredentials(v).replace(BEARER, `$1 ${MASK}`).replace(TOKEN_PATH, `$1${MASK}`)));
}

/** Yalnızca ASCII `%XX` kaçışlarını çözer (geçersiz UTF-8 hatası yok, doğrusal). */
function decodeAscii(v: string): string {
  return v.replace(/%([0-7][0-9a-fA-F])/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * URL/yol/sorgu/başlık metnindeki sırları maskeler (günlük değeri, erişim günlüğü yolu). Girdi önce `MAX_LOG_STRING`'e
 * kesilir. Yüzde kodlu biçimler (`%40`, `%3D`, `%2F`) için en çok 2 tur çözülmüş biçim de taranır; çözülmüş biçimde bir şey
 * maskelendiyse sonuç çözülmüş-maskeli biçim olur (güvenli taraf).
 */
export function maskString(value: string): string {
  let s = value;
  let truncated = false;
  if (s.length > MAX_LOG_STRING) {
    s = s.slice(0, MAX_LOG_STRING);
    truncated = true;
  }
  s = passes(s);
  let cur = s;
  for (let round = 0; round < 2 && cur.includes("%"); round++) {
    const dec = decodeAscii(cur);
    if (dec === cur) break;
    const masked = passes(dec);
    if (masked !== dec) {
      s = masked;
      break;
    }
    cur = dec;
  }
  return truncated ? s + TRUNCATED : s;
}

const ACCESS_QUERY_ALLOW = new Set(["next", "locale", "lang", "page", "tab", "error"]);
const ACCESS_QUERY_MAX_PARAMS = 20;

/**
 * Erişim günlüğü yolu: yol maskeli; sorgu dizgisinde YALNIZCA izinli anahtar adları (`next`, `locale`, …) yazılır (değerleri
 * maskeli ve kısaltılmış); diğer parametreler düşürülür ve sayısı `droppedParams` olarak döner (serbest metin/kişisel veri yazılmaz).
 */
export function maskAccessPath(pathname: string, search: string): { path: string; droppedParams: number } {
  const path = maskString(pathname.length > 512 ? pathname.slice(0, 512) : pathname);
  if (search === "" || search === "?") return { path, droppedParams: 0 };
  const parts = search.replace(/^\?/, "").split("&", ACCESS_QUERY_MAX_PARAMS + 1);
  const kept: string[] = [];
  let dropped = 0;
  for (const [idx, part] of parts.entries()) {
    if (idx >= ACCESS_QUERY_MAX_PARAMS) {
      dropped++;
      continue;
    }
    const eq = part.indexOf("=");
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const val = eq < 0 ? "" : part.slice(eq + 1);
    if (ACCESS_QUERY_ALLOW.has(rawName)) kept.push(`${rawName}=${maskString(val.length > 256 ? val.slice(0, 256) : val)}`);
    else dropped++;
  }
  return { path: kept.length > 0 ? `${path}?${kept.join("&")}` : path, droppedParams: dropped };
}

function maskValue(value: unknown, depth: number): unknown {
  switch (typeof value) {
    case "string":
      return maskString(value);
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "bigint":
      return "[bigint]";
    case "symbol":
    case "function":
      return `[${typeof value}]`;
    default:
      break;
  }
  if (value === null) return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  try {
    if (value instanceof Error) return { name: maskString(String(value.name)), message: maskString(String(value.message)) };
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ENTRIES).map((v) => maskValue(v, depth + 1));
      if (value.length > MAX_ENTRIES) items.push(`[+${value.length - MAX_ENTRIES} more]`);
      return items;
    }
    if (value instanceof Headers) return maskObject(Object.fromEntries(value.entries()), depth);
    return maskObject(value as Record<string, unknown>, depth);
  } catch {
    return "[unserializable]";
  }
}

function maskObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (n++ >= MAX_ENTRIES) {
      out["[truncated]"] = `+${Object.keys(obj).length - MAX_ENTRIES} more`;
      break;
    }
    const key = k.length > 128 ? k.slice(0, 128) : k;
    if (isSensitiveKey(key)) {
      out[key] = MASK;
      continue;
    }
    try {
      out[key] = maskValue(obj[k], depth + 1);
    } catch {
      out[key] = "[unreadable]";
    }
  }
  return out;
}

/** Alan nesnesini (iç içe dahil) maskeler; girdiyi değiştirmez; asla fırlatmaz. */
export function maskFields(fields: Record<string, unknown>): Record<string, unknown> {
  try {
    return maskObject(fields, 0);
  } catch {
    return { logFields: "[unserializable]" };
  }
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
      // Log çağrısı çağıranın akışını ASLA bozmaz: serileştirme/yazma hatası yer tutucu satıra (yazma da başarısızsa sessizce) düşer.
      try {
        const { requestId, tenantId, userId, ...rest } = fields ?? {};
        const asId = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === "string" ? v : INVALID_ID);
        const merged: LogBindings = {
          ...bindings,
          ...(requestId === undefined ? {} : { requestId: asId(requestId) }),
          ...(tenantId === undefined ? {} : { tenantId: asId(tenantId) }),
          ...(userId === undefined ? {} : { userId: asId(userId) }),
        };
        const ts = now().toISOString();
        const text = maskString(String(msg));
        const line: Record<string, unknown> = { ts, level, msg: text, ...bindingFields(merged), ...maskFields(rest) };
        // Ayrılmış alanlar son: çağrı alanları ezemez (konum korunur).
        line.ts = ts;
        line.level = level;
        line.msg = text;
        write(JSON.stringify(line));
      } catch {
        try {
          write(JSON.stringify({ ts: new Date().toISOString(), level, msg: "log-serialization-failed" }));
        } catch {
          /* günlük yazılamıyor: çağıranı etkileme */
        }
      }
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
