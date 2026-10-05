// Korunan yollar ve içerik kuralları — tek kaynak (T-008c; PROTOCOL §3b `check:protected`,
// §Onay kaynağı, I-17). `check:ac-ratchet` (T-008d) taban düşüş kuralını buradan kullanır.
//
// Üç tür kural:
//   1. Yol kuralı      — eşleşen yolda her değişiklik (ekleme, değişiklik, silme, ad değişikliği) korunur.
//   2. Taban kuralı    — dosya tabanda vardıysa korunur (birleşmiş migration'lar; yeni migration serbest).
//   3. İçerik kuralı   — yalnızca belirli alan/satır değişirse korunur (tüm `package.json`'larda `scripts`,
//                        `pnpm`, paket yöneticisi anahtarları ve korunan paketlerin sürümleri; `pnpm-lock.yaml`'da
//                        korunan paketlerin bağımlılık kapanışı, takma adlar ve tarball/git çözümlemeleri
//                        (T-008i M6); pooler imajı, AC tabanı düşüşü, ADR'nin "kabul"e geçmesi).
// Belirsizlikte (ayrıştırılamayan dosya) korunan sayılır (fail-closed).
// Glob eşlemesi nokta ile başlayan adları da kapsar (`dot: true` eşdeğeri; T-008h M7): Node'un
// `path.matchesGlob`'u `**`/`*` ile `.x` adlarını eşlemediği için kendi (yalnızca `*`, `**`) eşleyicimiz var.
// Repoda henüz olmayan yollar (`packages/db/…`, `scripts/check-docs.mjs`, `.githooks/`, `tests/…`)
// desen olarak durur (G-05); dosya oluştuğu anda kural işler.
/**
 * @typedef {import("./lib/git.mjs").Change} Change
 * @typedef {{ path: string, rule: string, reason: string }} ProtectedHit
 * @typedef {(file: string) => string | null} ReadFile
 */

/** Yol kuralları: her değişiklik korunur. */
export const PROTECTED_GLOBS = Object.freeze([
  // Şartname/kurallar
  "docs/INVARIANTS.md",
  "docs/ACCEPTANCE.md",
  "docs/ACCEPTANCE.conditions.json",
  "docs/spec/16-stock-effects.md",
  // Kilit sırası (PROTOCOL `locking.ts`, T-008c kartı `locking.mjs`: ikisi de)
  "packages/db/src/locking.*",
  // CI tanımları
  ".github/**",
  // lint / tsconfig / test yapılandırması
  "eslint.config.*",
  "**/eslint.config.*",
  "**/tsconfig*.json",
  "**/vitest.config.*",
  "**/vitest.*.config.*",
  "**/vitest.workspace.*",
  "**/playwright.config.*",
  // Bekçiler, doğrulama ve AC koşturucu
  "scripts/verify.mjs",
  "scripts/check-docs.mjs",
  "scripts/guards/**",
  "scripts/test-ac/**",
  "scripts/lib/**",
  ".githooks/**",
  // Gizli bilgi taraması muafiyet listesi (T-017): parmak izi eklemek taramayı susturur
  ".gitleaksignore",
  "**/.gitleaksignore",
  // Karantina kaydı
  "tests/QUARANTINE.md",
  // pnpm kancaları (kurulumda kod çalıştırır; T-003 security-reviewer MAJOR)
  ".pnpmfile.*",
  "**/.pnpmfile.*",
  // Paket yöneticisi yapılandırması, dosyanın tamamı (T-008h B1/M5/M6): node-options/nodeOptions,
  // script-shell, registry, ignore-scripts, enable-pre-post-scripts, catalog*, patchedDependencies,
  // onlyBuiltDependencies, packageExtensions … her anahtar.
  ".npmrc",
  "**/.npmrc",
  "pnpm-workspace.yaml",
  "**/pnpm-workspace.yaml",
  // Bağımlılık yamaları (patchedDependencies hedefleri; T-008h M6)
  "patches/**",
  "**/patches/**",
  "**/*.patch",
  "**/*.diff",
  // AC faz değişikliği (pilot koşulları; T-008h m8)
  "docs/PILOT.md",
]);

/**
 * Tüm `package.json`'larda üst düzeyde değişmesi korunan anahtarlar (T-003 security-reviewer MAJOR,
 * T-008h B1/B2/M6). `scripts` ve `pnpm` alanlarının **tamamı** (yaşam döngüsü, pre/post betikleri,
 * `pnpm.patchedDependencies`/`onlyBuiltDependencies`/`packageExtensions` …); `resolutions` pnpm'de
 * `overrides` eşdeğeri; `pnpmfile` `.pnpmfile.*` yol kuralını başka dosyaya yönlendirebilir;
 * `packageManager`/`devEngines` araç zincirini, `dependenciesMeta` kurulum davranışını değiştirir.
 */
export const PM_CONFIG_KEYS = Object.freeze([
  "scripts",
  "pnpm",
  "auditConfig",
  "overrides",
  "resolutions",
  "configDependencies",
  "pnpmfile",
  "packageManager",
  "devEngines",
  "dependenciesMeta",
]);

/** Taban kuralı: tabanda var olan (birleşmiş) migration dosyaları. Yeni migration korunmaz. */
export const MIGRATION_GLOBS = Object.freeze(["**/migrations/**", "**/drizzle/**"]);

export const AC_BASELINE = "tests/.ac-baseline.json";
export const DECISIONS = "docs/DECISIONS.md";
export const ADR_GLOB = "docs/adr/ADR-*.md";
export const LOCKFILE_GLOBS = Object.freeze(["pnpm-lock.yaml", "**/pnpm-lock.yaml"]);
export const PACKAGE_JSON_GLOBS = Object.freeze(["package.json", "**/package.json"]);
export const COMPOSE_GLOBS = Object.freeze([
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/compose.yml",
  "**/compose.yaml",
]);

/** Tüm `package.json`'larda sürüm alanı korunan ORM / sürücü / pooler paketleri (ADR-003, ADR-004). */
export const DB_PACKAGES = Object.freeze([
  "drizzle-orm",
  "drizzle-kit",
  "pg",
  "pg-native",
  "pg-pool",
  "postgres",
  "@neondatabase/serverless",
  "prisma",
  "@prisma/client",
]);

/** Sürüm alanı korunan bekçi araçları (T-008h M5): sürüm değişimi = bekçi davranışı değişimi. */
export const GUARD_TOOL_PACKAGES = Object.freeze(["typescript", "vitest", "eslint", "typescript-eslint"]);
/** Aynı araçların kapsamlı paketleri (`@vitest/runner`, `@typescript-eslint/parser` …). */
const GUARD_TOOL_SCOPES = Object.freeze(["@vitest/", "@typescript-eslint/"]);

/**
 * Sürümü/kilit girdisi korunan paket mi.
 * @param {string} name
 * @returns {boolean}
 */
export function isGuardedPackage(name) {
  return DB_PACKAGES.includes(name) || GUARD_TOOL_PACKAGES.includes(name) || GUARD_TOOL_SCOPES.some((s) => name.startsWith(s));
}

/** Sürüm taşıyan `package.json` bölümleri (`overrides`/`resolutions` tüm dosyalarda `PM_CONFIG_KEYS` ile). */
const VERSION_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** @type {Map<string, RegExp>} */
const globCache = new Map();

/**
 * Glob → düzenli ifade. Yalnızca `*` (bölüm içi, `/` hariç her şey — nokta ile başlayan adlar dahil),
 * `**` (tam bölüm: sıfır veya daha çok dizin) ve düz karakterler. Başka glob sözdizimi hata
 * (sessizce yanlış eşleme yerine).
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const cached = globCache.get(glob);
  if (cached !== undefined) return cached;
  if (/[?[\]{}!\\]/.test(glob)) throw new Error(`desteklenmeyen glob sözdizimi: ${glob}`);
  const parts = glob.split("/");
  let re = "";
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === "**") {
      re += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    if (part.includes("**")) throw new Error(`"**" yalnızca tam bölüm olabilir: ${glob}`);
    re += part
      .split("*")
      .map((x) => x.replace(/[.+^$()|]/g, "\\$&"))
      .join("[^/]*");
    if (!last) re += "/";
  });
  const out = new RegExp(`^${re}$`);
  globCache.set(glob, out);
  return out;
}

/**
 * @param {string} file
 * @param {string} glob
 * @returns {boolean}
 */
export function matchesGlob(file, glob) {
  return globToRegExp(glob).test(file);
}

/**
 * @param {string} file
 * @param {readonly string[]} globs
 * @returns {boolean}
 */
export function matchesAny(file, globs) {
  return globs.some((g) => matchesGlob(file, g));
}

/**
 * Yol kuralı veya taban kuralı (içerikten bağımsız) için korunanlık nedeni.
 * @param {string} file
 * @returns {string | null}
 */
export function staticRule(file) {
  for (const g of PROTECTED_GLOBS) if (matchesGlob(file, g)) return g;
  return null;
}

// ---------- içerik kuralları ----------

/**
 * JSON'daki sayısal yaprakları `a.b.c → n` olarak düzleştirir.
 * @param {unknown} v
 * @param {string} prefix
 * @param {Map<string, number>} out
 */
function numericLeaves(v, prefix, out) {
  if (typeof v === "number") {
    out.set(prefix, v);
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) numericLeaves(x, prefix === "" ? k : `${prefix}.${k}`, out);
  }
}

/** Taşıma istisnasının uygulandığı taban bölümü (dosya yolu → assertion sayısı; T-008d). */
const MOVE_SECTION = "acFileAssertions";

/**
 * AC tabanı düşüşü: tabandaki bir sayısal değer azaldı veya kaldırıldı. Artış/ekleme serbest.
 * Biçim T-008d'de belirlenir; kural biçimden bağımsızdır (tüm sayısal yapraklar).
 * Taşıma istisnası (T-008e; T-008d bulgu 1): yalnızca `acFileAssertions` (dosya yolu → sayı)
 * bölümünde, kaldırılan yol önceden olmayan yeni bir yolda **aynı sayıyla** varsa düşüş sayılmaz
 * (`check:ac-ratchet --update` dosya taşımasında yolu günceller). Her yeni yol tek bir kaldırılan
 * yolu karşılar; farklı sayı veya başka bölüm (ör. `acTests` AC kimliği değişimi) yine düşüştür.
 * Ayrıştırılamayan taraf = düşüş sayılır (fail-closed). Taban yoksa (ilk oluşturma) düşüş yok.
 * @param {string | null} before
 * @param {string | null} after
 * @returns {string | null} düşüş açıklaması veya `null`
 */
export function baselineLowered(before, after) {
  if (before === null) return null;
  if (after === null) return "AC tabanı silindi";
  /** @type {unknown} */
  let b;
  /** @type {unknown} */
  let a;
  try {
    b = JSON.parse(before);
  } catch {
    return "tabandaki AC tabanı JSON olarak ayrıştırılamadı";
  }
  try {
    a = JSON.parse(after);
  } catch {
    return "AC tabanı JSON olarak ayrıştırılamadı";
  }
  const bm = new Map();
  const am = new Map();
  numericLeaves(b, "", bm);
  numericLeaves(a, "", am);
  /**
   * `acFileAssertions` altındaki dosya yolu (düzleştirilmiş anahtar `acFileAssertions.<yol>`);
   * değilse `null`. Yol, nesnede gerçekten o anahtar olarak bulunmalı.
   * @param {unknown} root
   * @param {string} flat
   * @returns {string | null}
   */
  const fileKey = (root, flat) => {
    if (!flat.startsWith(`${MOVE_SECTION}.`) || root === null || typeof root !== "object") return null;
    const sec = /** @type {Record<string, unknown>} */ (root)[MOVE_SECTION];
    const rel = flat.slice(MOVE_SECTION.length + 1);
    return sec !== null && typeof sec === "object" && Object.hasOwn(sec, rel) && typeof (/** @type {Record<string, unknown>} */ (sec)[rel]) === "number" ? rel : null;
  };
  /** Taşıma adayları: tabanda olmayan yeni dosya anahtarları (her biri tek kullanımlık). */
  const fresh = new Set([...am.keys()].filter((k) => !bm.has(k) && fileKey(a, k) !== null));
  /** @type {string[]} */
  const lowered = [];
  for (const [k, n] of bm) {
    const m = am.get(k);
    if (m === undefined) {
      const target = fileKey(b, k) === null ? undefined : [...fresh].find((f) => am.get(f) === n);
      if (target !== undefined) {
        fresh.delete(target);
        continue;
      }
      lowered.push(`${k}: ${n} → yok`);
    } else if (m < n) lowered.push(`${k}: ${n} → ${m}`);
  }
  return lowered.length === 0 ? null : `AC tabanı düştü (${lowered.join(", ")})`;
}

const KABUL_RE = /(?<![\p{L}\p{N}])kabul(?![\p{L}\p{N}])/iu;

/**
 * ADR dosyasının durum satırı "kabul" içeriyor mu (`**Tarih / Durum:** … · **kabul**`).
 * @param {string | null} text
 * @returns {boolean}
 */
export function adrAccepted(text) {
  if (text === null) return false;
  const line = text.split(/\r?\n/).find((l) => /\*\*Tarih\s*\/\s*Durum:?\*\*/.test(l) || /^\s*\*\*Durum:?\*\*/.test(l));
  return line !== undefined && KABUL_RE.test(line);
}

/**
 * DECISIONS.md'de durum sütunu "kabul" olan ADR kimlikleri (`ADR-xxx | tarih | karar | durum`).
 * @param {string | null} text
 * @returns {Set<string>}
 */
export function acceptedDecisionIds(text) {
  /** @type {Set<string>} */
  const out = new Set();
  if (text === null) return out;
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*\|?\s*(ADR-\d+)\s*\|/.exec(l);
    if (m === null) continue;
    const cols = l.split("|").map((c) => c.trim()).filter((c) => c !== "");
    const status = cols[cols.length - 1] ?? "";
    if (KABUL_RE.test(status)) out.add(/** @type {string} */ (m[1]));
  }
  return out;
}

/**
 * @param {string | null} text
 * @returns {{ ok: true, value: Record<string, unknown> | null } | { ok: false }}
 */
function parsePackage(text) {
  if (text === null) return { ok: true, value: null };
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false };
    return { ok: true, value: /** @type {Record<string, unknown>} */ (v) };
  } catch {
    return { ok: false };
  }
}

/**
 * @param {unknown} v
 * @returns {Record<string, unknown>}
 */
function obj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
}

/**
 * Her `package.json`'da korunan alanlar: `PM_CONFIG_KEYS` (üst düzey, `scripts` ve `pnpm` dahil
 * tamamı) ve korunan paketlerin (`isGuardedPackage`) sürüm alanları.
 * @param {Record<string, unknown> | null} b
 * @param {Record<string, unknown> | null} a
 * @returns {string[]}
 */
function packageChanges(b, a) {
  /** @type {string[]} */
  const out = [];
  for (const k of PM_CONFIG_KEYS) {
    if (JSON.stringify(b?.[k]) === JSON.stringify(a?.[k])) continue;
    const bo = obj(b?.[k]);
    const ao = obj(a?.[k]);
    const keys = [...new Set([...Object.keys(bo), ...Object.keys(ao)])].filter((x) => JSON.stringify(bo[x]) !== JSON.stringify(ao[x]));
    if (keys.length === 0) out.push(k);
    else for (const x of keys.sort()) out.push(`${k}.${x}`);
  }
  for (const s of VERSION_SECTIONS) {
    const bs = obj(b?.[s]);
    const as = obj(a?.[s]);
    for (const k of new Set([...Object.keys(bs), ...Object.keys(as)])) {
      if (isGuardedPackage(k) && JSON.stringify(bs[k]) !== JSON.stringify(as[k])) out.push(`${s}.${k}`);
    }
  }
  return out;
}

/**
 * `pnpm-lock.yaml` girdi anahtarından paket adı (`'@scope/a@1.0.0(peer@2)'` → `@scope/a`).
 * @param {string} key
 * @returns {string}
 */
function lockKeyName(key) {
  const k = key.replace(/^['"]|['"]$/g, "");
  const at = k.indexOf("@", 1);
  return at === -1 ? k : k.slice(0, at);
}

// ---------- pnpm-lock.yaml (v9) dar ayrıştırıcısı (T-008i M6) ----------
//
// Yeni bağımlılık yok: YAML'ın yalnızca pnpm'in v9 kilit dosyasında yazdığı alt kümesi kabul edilir,
// geri kalan her biçim `LockfileError` (→ korunan değişiklik, fail-closed):
//   - girinti yalnızca boşluk, her düzey tam 2; sekme yok;
//   - satır: `anahtar:` (blok açar), `anahtar: değer`, `- değer` (yalnızca skaler dizi öğesi);
//   - anahtar: düz, '…' ('' kaçışlı) veya "…" (ters bölü yok); `?`, `<<`, `&`, `*`, `!`, `|`, `>`,
//     `%`, `@`, `` ` ``, `-`, `[`, `{`, `#` ile başlayan düz anahtar yok;
//   - değer: düz skaler, tırnaklı skaler, tek satırlık akış (`{…}`, `[…]`; düğüm başında gösterge,
//     tırnak dışında `&`/`!`/` #` yok — bkz. `parseFlow`); çapa/takma ad/etiket/blok skaler (`|`,
//     `>`), satır sonu yorumu, belge imleri yok;
//   - aynı eşlemede yinelenen anahtar yok (tırnaklı/tırnaksız aynı ad dahil); boş blok yok;
//   - yalnızca tam satır yorum (`# …`) ve boş satır atlanır; `lockfileVersion` 9.x olmalı.

export class LockfileError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "LockfileError";
  }
}

/**
 * @typedef {{ kind: "scalar", value: string }
 *   | { kind: "map", entries: Map<string, LockNode> }
 *   | { kind: "seq", items: string[] }} LockNode
 * @typedef {{ kind: "map" | "seq" | null, entries: Map<string, LockNode>, items: string[] }} OpenBlock
 */

/** Düz (tırnaksız) skaler/anahtarın başında olamayacak YAML göstergeleri. */
const PLAIN_FORBIDDEN_START = /^[?&*!|>%@`\-[\]{},#'"<]/;

/**
 * Tek tırnaklı dizgenin kapanış konumu (`''` kaçış). Yoksa -1.
 * @param {string} s `'` ile başlar
 * @returns {number}
 */
function singleQuoteEnd(s) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== "'") continue;
    if (s[i + 1] === "'") {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Tırnaklı dizgeyi açar; tırnak sonrası `rest` döner. Belirsizlikte hata.
 * @param {string} s `'` veya `"` ile başlar
 * @param {number} ln
 * @returns {{ value: string, rest: string }}
 */
function unquote(s, ln) {
  if (s[0] === "'") {
    const end = singleQuoteEnd(s);
    if (end === -1) throw new LockfileError(`satır ${ln}: kapanmayan tek tırnak`);
    return { value: s.slice(1, end).replace(/''/g, "'"), rest: s.slice(end + 1) };
  }
  const end = s.indexOf('"', 1);
  if (end === -1) throw new LockfileError(`satır ${ln}: kapanmayan çift tırnak`);
  const inner = s.slice(1, end);
  if (inner.includes("\\")) throw new LockfileError(`satır ${ln}: çift tırnakta kaçış dizisi desteklenmez`);
  return { value: inner, rest: s.slice(end + 1) };
}

/**
 * @typedef {string | null | FlowSeq | FlowMap} FlowValue
 * Ayrıştırılmış akış düğümü: skaler (tırnaktan arındırılmış), değersiz anahtarın değeri (`null`),
 * dizi veya eşleme (anahtarlar tırnaktan arındırılmış, `''` kaçışı açılmış; T-016).
 */

/**
 * Ayrıştırılmış akış eşlemesi / dizisi. JSDoc tür takma adı `Map<…>`/`[]` ile kendine başvuramadığından
 * (TS2456) sınıf olarak tanımlanır; davranış `Map`/`Array` ile aynıdır.
 * @extends {Map<string, FlowValue>}
 */
export class FlowMap extends Map {}
/** @extends {Array<FlowValue>} */
export class FlowSeq extends Array {}

/**
 * @param {readonly FlowValue[]} xs
 * @returns {FlowSeq}
 */
export function flowSeq(xs) {
  const out = new FlowSeq();
  out.push(...xs);
  return out;
}

/**
 * Tek satırlık akış koleksiyonunu ayrıştırır (T-015 düğüm konumlu denetim; T-016 yapı üretir).
 * YAML'da çapa/takma ad/etiket/blok göstergeleri (`&`, `*`, `!`, `|`, `>` …) yalnızca bir düğümün
 * **başında** gösterge sayılır; düz skalerin içindeki `*`, `>`, `|`, `^`, `~`, boşluk sıradan
 * karakterdir (pnpm `engines`: `{node: 6.* || 8.* || >= 10.*}`). Kabul edilen dil:
 *   - dengeli `{…}` / `[…]`; en dıştaki kapanıştan sonra metin yok;
 *   - düğüm: tırnaklı skaler, iç içe akış koleksiyonu veya `PLAIN_FORBIDDEN_START` / `:` ile
 *     başlamayan düz skaler; boş düğüm (`{a: }`, `[,]`) yok;
 *   - `anahtar: değer` ayırıcısı (`: `) yalnızca `{…}` içinde ve girdi başına bir kez;
 *   - tırnaklı skaler/kapanmış koleksiyondan sonra yalnızca boşluk, `,`, `: ` veya kapanış;
 *   - düz skaler içinde `&`, `!`, tırnak, `` ` `` ve satır sonu yorumu (` #`) yok;
 *   - (T-016) eşleme anahtarı skalerdir (koleksiyon anahtarı yok) ve normalize edilmiş biçimiyle
 *     eşleme içinde tekildir (`{a: 1, 'a': 2}` yok).
 * Geri kalan her biçim `LockfileError` (fail-closed). Çağıranlar ham metni regex'le değil bu
 * çıktının anahtar–değer çiftleriyle değerlendirir (T-016: `"tarball":` tırnaklı anahtar açığı).
 * @param {string} raw `{` veya `[` ile başlar
 * @param {number} ln
 * @returns {FlowValue}
 */
export function parseFlow(raw, ln) {
  /**
   * @type {Array<{ close: "}" | "]", hasKey: boolean, map: FlowMap | null,
   *   seq: FlowSeq | null, key: string | undefined, value: FlowValue | undefined }>}
   */
  const stack = [];
  /** "node": düğüm başı bekleniyor · "plain": düz skalerin içi · "after": düğüm bitti. */
  let phase = /** @type {"node" | "plain" | "after"} */ ("node");
  /** Son belirteç `: ` ayırıcısı mı (değer zorunlu)? */
  let needValue = false;
  /** Süren düz skalerin başlangıç konumu. */
  let plainStart = -1;
  /** @type {FlowValue | undefined} */
  let root;
  /** @type {(why: string) => never} */
  const fail = (why) => {
    throw new LockfileError(`satır ${ln}: ${why}`);
  };
  /** Tamamlanan düğümü üst koleksiyona yerleştirir. @param {FlowValue} v */
  const emit = (v) => {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      root = v;
      return;
    }
    if (top.seq !== null) {
      top.seq.push(v);
      return;
    }
    if (top.hasKey) {
      top.value = v;
      return;
    }
    if (typeof v !== "string") fail("akış eşlemesinde koleksiyon anahtarı desteklenmez");
    top.key = v;
  };
  /** Eşlemede bekleyen `anahtar[: değer]` girdisini işler. */
  const commit = () => {
    const top = stack[stack.length - 1];
    if (top === undefined || top.map === null) return;
    if (top.key !== undefined) {
      if (top.map.has(top.key)) fail(`akış eşlemesinde yinelenen anahtar "${top.key}"`);
      top.map.set(top.key, top.hasKey ? (top.value ?? null) : null);
    }
    top.key = undefined;
    top.value = undefined;
    top.hasKey = false;
  };
  /** Süren düz skaleri bitirir. @param {number} i */
  const endPlain = (i) => {
    if (phase !== "plain") return;
    emit(raw.slice(plainStart, i).trim());
    phase = "after";
  };
  /** @param {number} i @param {string} ch */
  const close = (i, ch) => {
    if (needValue) fail("akış koleksiyonunda boş değer");
    commit();
    const frame = stack.pop();
    if (frame?.close !== ch) fail("dengesiz akış koleksiyonu");
    if (stack.length === 0 && i !== raw.length - 1) fail("akış koleksiyonundan sonra metin");
    emit(/** @type {FlowValue} */ (frame.map ?? frame.seq));
    phase = "after";
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? "";
    if (phase === "node") {
      if (ch === " ") continue;
      if (ch === "'" || ch === '"') {
        const q = unquote(raw.slice(i), ln);
        i = raw.length - q.rest.length - 1;
        if (stack.length === 0) fail("akış koleksiyonu dışında skaler");
        emit(q.value);
        phase = "after";
        needValue = false;
        continue;
      }
      if (ch === "{" || ch === "[") {
        stack.push({
          close: ch === "{" ? "}" : "]",
          hasKey: false,
          map: ch === "{" ? new FlowMap() : null,
          seq: ch === "[" ? new FlowSeq() : null,
          key: undefined,
          value: undefined,
        });
        needValue = false;
        continue;
      }
      if (ch === "}" || ch === "]") {
        close(i, ch);
        continue;
      }
      if (ch === "," || ch === ":") fail(`akış koleksiyonunda boş düğüm ("${ch}")`);
      // Düğüm başında çapa, takma ad, etiket, blok skaler, ayrılmış göstergeler: desteklenmez.
      if (PLAIN_FORBIDDEN_START.test(ch)) fail(`akış koleksiyonunda desteklenmeyen gösterge "${ch}"`);
      if (stack.length === 0) fail("akış koleksiyonu dışında skaler");
      phase = "plain";
      plainStart = i;
      needValue = false;
      continue;
    }
    // phase: "plain" | "after"
    if (ch === ",") {
      endPlain(i);
      commit();
      phase = "node";
      continue;
    }
    if (ch === "}" || ch === "]") {
      endPlain(i);
      close(i, ch);
      continue;
    }
    if (ch === ":" && (raw[i + 1] === " " || phase === "after")) {
      const top = stack[stack.length - 1];
      if (top === undefined || top.close !== "}" || top.hasKey) fail("akış koleksiyonunda desteklenmeyen eşleme biçimi");
      if (raw[i + 1] !== " ") fail('akışta ":" sonrası boşluk yok');
      endPlain(i);
      top.hasKey = true;
      phase = "node";
      needValue = true;
      continue;
    }
    if (phase === "after") {
      if (ch === " ") continue;
      fail("akış öğesinden sonra beklenmeyen metin");
    }
    if (ch === "#" && raw[i - 1] === " ") fail("satır sonu yorumu desteklenmez");
    // `b:}` / `b:,` YAML'da örtük anahtar olur (belirsiz) → desteklenmez.
    if (ch === ":" && /^[,}\]]?$/.test(raw[i + 1] ?? "")) fail('akışta değersiz ":" desteklenmez');
    if (ch === "&" || ch === "!" || ch === "'" || ch === '"' || ch === "`") {
      fail(`akış koleksiyonunda desteklenmeyen gösterge "${ch}"`);
    }
  }
  if (stack.length !== 0 || root === undefined) fail("kapanmayan akış koleksiyonu");
  return root;
}

/**
 * Değer skaleri. Akış koleksiyonu ham metniyle döner (parmak izinde ham karşılaştırılır).
 * @param {string} raw kırpılmış, boş değil
 * @param {number} ln
 * @returns {string}
 */
function parseScalar(raw, ln) {
  if (raw[0] === "'" || raw[0] === '"') {
    const q = unquote(raw, ln);
    if (q.rest.trim() !== "") throw new LockfileError(`satır ${ln}: tırnaktan sonra metin`);
    return q.value;
  }
  if (raw[0] === "{" || raw[0] === "[") {
    parseFlow(raw, ln);
    return raw;
  }
  if (PLAIN_FORBIDDEN_START.test(raw)) throw new LockfileError(`satır ${ln}: desteklenmeyen değer biçimi "${raw}"`);
  if (/\s#/.test(raw)) throw new LockfileError(`satır ${ln}: satır sonu yorumu desteklenmez`);
  if (/:(?:\s|$)/.test(raw)) throw new LockfileError(`satır ${ln}: değerde ": " (iç içe eşleme) desteklenmez`);
  return raw;
}

/**
 * Bir satırı ayrıştırır: dizi öğesi veya anahtar (+ isteğe bağlı değer).
 * @param {string} c girintisiz içerik
 * @param {number} ln
 * @returns {{ item: string } | { key: string, value: string | null }}
 */
function parseLine(c, ln) {
  if (c === "-" || c.startsWith("- ")) {
    const v = c.slice(1).trim();
    if (v === "") throw new LockfileError(`satır ${ln}: boş dizi öğesi`);
    if (/^[^'"{[].*:$/.test(v)) throw new LockfileError(`satır ${ln}: dizi içinde eşleme desteklenmez`);
    return { item: parseScalar(v, ln) };
  }
  /** @type {string} */
  let key;
  /** @type {string} */
  let rest;
  if (c[0] === "'" || c[0] === '"') {
    const q = unquote(c, ln);
    key = q.value;
    rest = q.rest;
    if (!rest.startsWith(":")) throw new LockfileError(`satır ${ln}: tırnaklı anahtardan sonra ":" yok`);
    rest = rest.slice(1);
    if (rest !== "" && !/^\s/.test(rest)) throw new LockfileError(`satır ${ln}: ":" sonrası boşluk yok`);
  } else {
    if (PLAIN_FORBIDDEN_START.test(c)) throw new LockfileError(`satır ${ln}: desteklenmeyen anahtar biçimi "${c}"`);
    const m = /:(?:\s|$)/.exec(c);
    if (m === null) throw new LockfileError(`satır ${ln}: anahtar/değer satırı değil "${c}"`);
    key = c.slice(0, m.index);
    rest = c.slice(m.index + 1);
    if (/\s#/.test(key) || key.trim() !== key || key === "") throw new LockfileError(`satır ${ln}: geçersiz anahtar "${key}"`);
  }
  if (key === "<<") throw new LockfileError(`satır ${ln}: birleştirme anahtarı desteklenmez`);
  const v = rest.trim();
  return { key, value: v === "" ? null : parseScalar(v, ln) };
}

/**
 * @param {OpenBlock} b
 * @param {number} ln
 * @returns {LockNode}
 */
function closeBlock(b, ln) {
  if (b.kind === null) throw new LockfileError(`satır ${ln}: boş blok (değersiz anahtar) desteklenmez`);
  return b.kind === "map" ? { kind: "map", entries: b.entries } : { kind: "seq", items: b.items };
}

/**
 * pnpm-lock v9 alt kümesini ağaca ayrıştırır (bkz. bölüm başı). Belirsizlik = `LockfileError`.
 * @param {string} text
 * @returns {Map<string, LockNode>} üst düzey eşleme
 */
export function parseLockYaml(text) {
  /** @type {OpenBlock} */
  const root = { kind: "map", entries: new Map(), items: [] };
  /** @type {Array<{ block: OpenBlock, indent: number, set: (n: LockNode) => void }>} */
  const stack = [{ block: root, indent: 0, set: () => {} }];
  const lines = text.split(/\r?\n/);
  let ln = 0;
  for (const rawLine of lines) {
    ln++;
    const line = rawLine.replace(/ +$/, "");
    if (line === "") continue;
    if (line.includes("\t")) throw new LockfileError(`satır ${ln}: sekme karakteri desteklenmez`);
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const c = line.slice(indent);
    if (c.startsWith("#")) continue;
    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? 0) > indent) {
      const top = /** @type {{ block: OpenBlock, set: (n: LockNode) => void }} */ (stack.pop());
      top.set(closeBlock(top.block, ln));
    }
    const top = /** @type {{ block: OpenBlock, indent: number }} */ (stack[stack.length - 1]);
    if (top.indent !== indent) throw new LockfileError(`satır ${ln}: beklenmeyen girinti (${indent}, beklenen ${top.indent})`);
    const p = parseLine(c, ln);
    const b = top.block;
    if ("item" in p) {
      if (b.kind === "map") throw new LockfileError(`satır ${ln}: eşleme içinde dizi öğesi`);
      b.kind = "seq";
      b.items.push(p.item);
      continue;
    }
    if (b.kind === "seq") throw new LockfileError(`satır ${ln}: dizi içinde anahtar`);
    b.kind = "map";
    if (b.entries.has(p.key)) throw new LockfileError(`satır ${ln}: yinelenen anahtar "${p.key}"`);
    if (p.value !== null) {
      b.entries.set(p.key, { kind: "scalar", value: p.value });
      continue;
    }
    /** @type {OpenBlock} */
    const child = { kind: null, entries: new Map(), items: [] };
    const key = p.key;
    const parent = b.entries;
    parent.set(key, { kind: "scalar", value: "" }); // yer tutucu: yineleme denetimi için
    stack.push({ block: child, indent: indent + 2, set: (n) => parent.set(key, n) });
  }
  while (stack.length > 1) {
    const top = /** @type {{ block: OpenBlock, set: (n: LockNode) => void }} */ (stack.pop());
    top.set(closeBlock(top.block, ln));
  }
  return root.entries;
}

/**
 * Düğümün kararlı metin biçimi (parmak izi için).
 * @param {LockNode | undefined} n
 * @returns {string}
 */
function canon(n) {
  if (n === undefined) return "<yok>";
  /** @param {LockNode} x @returns {unknown} */
  const plain = (x) =>
    x.kind === "scalar" ? x.value : x.kind === "seq" ? x.items : Object.fromEntries([...x.entries].map(([k, v]) => [k, plain(v)]));
  return JSON.stringify(plain(n));
}

/**
 * Eşleme düğümü (veya `{}` skaleri) → girdiler. Başka biçim = hata.
 * @param {LockNode | undefined} n
 * @param {string} what
 * @returns {Map<string, LockNode>}
 */
function lockMap(n, what) {
  if (n === undefined) return new Map();
  if (n.kind === "map") return n.entries;
  if (n.kind === "scalar" && n.value === "{}") return new Map();
  throw new LockfileError(`${what}: eşleme bekleniyordu`);
}

/**
 * Bağımlılık eşlemesi: ad → skaler değer (blok biçim; `{}` boş). Başka biçim = hata.
 * @param {LockNode | undefined} n
 * @param {string} what
 * @returns {Map<string, string>}
 */
function depMap(n, what) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [k, v] of lockMap(n, what)) {
    if (v.kind !== "scalar" || v.value.startsWith("{") || v.value.startsWith("[")) {
      throw new LockfileError(`${what}.${k}: skaler sürüm bekleniyordu`);
    }
    out.set(k, v.value);
  }
  return out;
}

/** Peer soneki olmadan anahtar (`a@1.0.0(b@2)` → `a@1.0.0`); `packages:` anahtarı. */
const stripPeers = (/** @type {string} */ k) => (k.includes("(") ? k.slice(0, k.indexOf("(")) : k);

/**
 * Bağımlılık değeri takma ad mı (`other@1.0.0`, `@s/other@1.0.0(p@1)`, `npm:…`).
 * @param {string} value
 * @returns {boolean}
 */
export function isLockAlias(value) {
  return value.startsWith("npm:") || stripPeers(value).indexOf("@", 1) !== -1;
}

/**
 * Bağımlılık adı + değeri → snapshot anahtarı (`link:` → `null`, düğüm değil).
 * @param {string} name
 * @param {string} value
 * @returns {string | null}
 */
function depKey(name, value) {
  if (value.startsWith("link:")) return null;
  return isLockAlias(value) ? value.replace(/^npm:/, "") : `${name}@${value}`;
}

const SNAPSHOT_DEP_SECTIONS = ["dependencies", "optionalDependencies"];
const IMPORTER_DEP_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

/**
 * `packages:` girdisinin `resolution` alanını ayrıştırılmış anahtar–değer çiftleriyle değerlendirir
 * (T-016). Tek kabul edilen biçim yalnızca `integrity` anahtarlı ve skaler değerli eşlemedir (blok
 * veya akış; anahtar tırnaklı/tırnaksız fark etmez). Başka her biçim — `tarball`, `directory`,
 * `repo`, `commit`, `type`, `path`, bilinmeyen anahtar, eşleme olmayan değer, boş eşleme — için
 * normalize edilmiş kararlı metin döner (parmak izine girer, fail-closed); integrity-yalnız ise `null`.
 * @param {LockNode} res
 * @param {string} where hata iletisi için
 * @returns {string | null}
 */
function nonIntegrityResolution(res, where) {
  /** @type {FlowValue} */
  let v;
  if (res.kind === "map") {
    v = new FlowMap([...res.entries].map(([k, n]) => [k, lockNodeFlow(n, where)]));
  } else if (res.kind === "scalar") {
    v = lockScalarFlow(res.value, where);
  } else {
    v = flowSeq(res.items.map((x) => lockScalarFlow(x, where)));
  }
  if (v instanceof FlowMap && v.size === 1 && typeof v.get("integrity") === "string") return null;
  return JSON.stringify(flowPlain(v));
}

/**
 * Blok düğümünü akış değerine çevirir (skalerdeki akış metni ayrıştırılır).
 * @param {LockNode} n
 * @param {string} where
 * @returns {FlowValue}
 */
function lockNodeFlow(n, where) {
  if (n.kind === "scalar") return lockScalarFlow(n.value, where);
  if (n.kind === "seq") return flowSeq(n.items.map((x) => lockScalarFlow(x, where)));
  return new FlowMap([...n.entries].map(([k, c]) => [k, lockNodeFlow(c, where)]));
}

/**
 * `parseScalar` çıktısı: `{`/`[` ile başlıyorsa akış koleksiyonudur (ham metin) → ayrıştırılır.
 * @param {string} value
 * @param {string} where
 * @returns {FlowValue}
 */
function lockScalarFlow(value, where) {
  if (value[0] !== "{" && value[0] !== "[") return value;
  try {
    return parseFlow(value, 0);
  } catch (e) {
    if (e instanceof LockfileError) throw new LockfileError(`${where}: ${e.message}`);
    throw e;
  }
}

/**
 * Akış değerinin JSON'a uygun biçimi (eşlemeler nesne dizisi olarak, anahtar sırası korunur).
 * @param {FlowValue} v
 * @returns {unknown}
 */
function flowPlain(v) {
  if (v instanceof FlowMap) return { map: [...v].map(([k, x]) => [k, flowPlain(x)]) };
  if (v instanceof FlowSeq) return [...v].map(flowPlain);
  return v;
}

/**
 * `pnpm-lock.yaml`'ın korunan parmak izi (T-008h M6, T-008i M6). Sıralı satırlar:
 *   - `importers`/`packages`/`snapshots` dışındaki tüm üst düzey bloklar (ayarlar, overrides,
 *     patchedDependencies, sağlama toplamları, catalogs, bilinmeyenler) tamamen;
 *   - importer'larda korunan paket girdileri (`specifier` + `version`) ve bağımlılık dışı alanlar;
 *   - korunan paketlerin (`isGuardedPackage`) **bağımlılık kapanışı**: kökler (importer'daki korunan
 *     paketler + adı korunan tüm snapshot/package girdileri) ve `snapshots:` `dependencies`/
 *     `optionalDependencies` üzerinden geçişli her düğümün snapshot ve `packages:` girdisi tamamen
 *     (sürüm, peer çözümü, `resolution`/integrity, engines …). Eksik düğüm `<yok>` olarak yazılır;
 *   - herhangi bir yerdeki takma ad değeri (`x: other@ver`, `npm:` önekli specifier/sürüm);
 *   - herhangi bir paketin integrity dışı çözümlemesi: `resolution` ayrıştırılmış anahtarlarıyla
 *     yalnızca `{integrity: <skaler>}` değilse (tırnaklı `"tarball"` dahil; T-016, `nonIntegrityResolution`).
 * Desteklenmeyen biçim `LockfileError` fırlatır (çağıran korunan sayar).
 * @param {string | null} text
 * @returns {string}
 */
export function lockfileGuarded(text) {
  if (text === null) return "";
  const top = parseLockYaml(text);
  const lv = top.get("lockfileVersion");
  if (lv === undefined || lv.kind !== "scalar" || !/^9\.\d+$/.test(lv.value)) {
    throw new LockfileError(`lockfileVersion 9.x değil (${canon(lv)}); bu ayrıştırıcı yalnızca v9 içindir`);
  }
  /** @type {string[]} */
  const out = [];
  for (const [k, v] of top) {
    if (k !== "importers" && k !== "packages" && k !== "snapshots") out.push(`top ${k} ${canon(v)}`);
  }
  const importers = lockMap(top.get("importers"), "importers");
  const packages = lockMap(top.get("packages"), "packages");
  const snapshots = lockMap(top.get("snapshots"), "snapshots");

  /** @type {string[]} */
  const roots = [];
  for (const [imp, node] of importers) {
    for (const [section, sv] of lockMap(node, `importers.${imp}`)) {
      if (!IMPORTER_DEP_SECTIONS.has(section)) {
        out.push(`importer ${imp} ${section} ${canon(sv)}`);
        continue;
      }
      for (const [name, entry] of lockMap(sv, `importers.${imp}.${section}`)) {
        const e = lockMap(entry, `importers.${imp}.${section}.${name}`);
        const spec = e.get("specifier");
        const ver = e.get("version");
        if (spec?.kind !== "scalar" || ver?.kind !== "scalar" || e.size !== 2) {
          throw new LockfileError(`importers.${imp}.${section}.${name}: yalnızca specifier + version bekleniyordu`);
        }
        if (spec.value.startsWith("npm:") || isLockAlias(ver.value)) out.push(`alias importer ${imp} ${section} ${name} ${spec.value} ${ver.value}`);
        if (isGuardedPackage(name)) {
          out.push(`importer ${imp} ${section} ${name} ${spec.value} ${ver.value}`);
          const k = depKey(name, ver.value);
          if (k !== null) roots.push(k);
        }
      }
    }
  }

  /** @type {Map<string, Map<string, string>>} snapshot anahtarı → bağımlılık adı → değer */
  const snapDeps = new Map();
  for (const [key, node] of snapshots) {
    const fields = lockMap(node, `snapshots.${key}`);
    /** @type {Map<string, string>} */
    const deps = new Map();
    for (const s of SNAPSHOT_DEP_SECTIONS) {
      for (const [name, value] of depMap(fields.get(s), `snapshots.${key}.${s}`)) {
        if (isLockAlias(value)) out.push(`alias snapshot ${key} ${s} ${name} ${value}`);
        deps.set(`${s}:${name}`, value);
      }
    }
    snapDeps.set(key, deps);
    if (isGuardedPackage(lockKeyName(key))) roots.push(key);
  }
  for (const [key, node] of packages) {
    lockMap(node, `packages.${key}`);
    if (isGuardedPackage(lockKeyName(key))) out.push(`package ${key} ${canon(node)}`);
    const res = node.kind === "map" ? node.entries.get("resolution") : undefined;
    const nonIntegrity = res === undefined ? null : nonIntegrityResolution(res, `packages.${key}.resolution`);
    if (nonIntegrity !== null) out.push(`resolution ${key} ${nonIntegrity}`);
  }

  // Bağımlılık kapanışı (geçişli).
  /** @type {Set<string>} */
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const key = /** @type {string} */ (queue.shift());
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`closure ${key} snapshot=${canon(snapshots.get(key))} package=${canon(packages.get(stripPeers(key)))}`);
    for (const [sn, value] of snapDeps.get(key) ?? []) {
      const name = sn.slice(sn.indexOf(":") + 1);
      const child = depKey(name, value);
      if (child === null) out.push(`closure-link ${key} ${name} ${value}`);
      else queue.push(child);
    }
  }
  return out.sort().join("\n");
}

/**
 * Kilit dosyasında korunan değişiklik açıklaması; yoksa `null`. Ayrıştırılamayan taraf = korunan.
 * @param {string | null} before
 * @param {string | null} after
 * @returns {string | null}
 */
export function lockfileChange(before, after) {
  /** @type {string[]} */
  const fp = [];
  for (const [side, text] of /** @type {Array<[string, string | null]>} */ ([
    ["taban", before],
    ["dal", after],
  ])) {
    try {
      fp.push(lockfileGuarded(text));
    } catch (e) {
      if (!(e instanceof LockfileError)) throw e;
      return `pnpm-lock.yaml (${side}) ayrıştırılamadı, korunan sayıldı (fail-closed): ${e.message}`;
    }
  }
  if (fp[0] === fp[1]) return null;
  return "korunan paketlerin bağımlılık kapanışı, takma ad, tarball/git çözümlemesi veya kilit ayarı değişti";
}

/**
 * Compose dosyasında pooler (PgBouncer) imaj referansları, sıralı. Servis adı veya imaj adı
 * `pgbouncer` içeren servislerin `image:` satırları.
 * @param {string | null} text
 * @returns {string}
 */
export function poolerImages(text) {
  if (text === null) return "";
  const lines = text.split(/\r?\n/);
  /** @type {string[]} */
  const images = [];
  let service = "";
  let serviceIndent = -1;
  let inServices = false;
  for (const l of lines) {
    if (l.trim() === "" || l.trim().startsWith("#")) continue;
    const indent = /^\s*/.exec(l)?.[0].length ?? 0;
    if (indent === 0) {
      inServices = /^services\s*:/.test(l);
      service = "";
      serviceIndent = -1;
      continue;
    }
    if (inServices) {
      const key = /^(\s*)["']?([\w.-]+)["']?\s*:\s*(?:#.*)?$/.exec(l);
      if (key !== null && (serviceIndent === -1 || indent <= serviceIndent)) {
        serviceIndent = indent;
        service = key[2] ?? "";
        continue;
      }
    }
    const img = /^\s*image\s*:\s*["']?([^"'\s#]+)/.exec(l);
    if (img !== null) {
      const ref = img[1] ?? "";
      if (/pgbouncer/i.test(ref) || /pgbouncer/i.test(service)) images.push(`${service}=${ref}`);
    }
  }
  return images.sort().join("\n");
}

/**
 * Bir dosyanın içerik kurallarına göre korunan değişiklikleri.
 * @param {string} file
 * @param {string | null} before tabandaki içerik (yoksa `null`)
 * @param {string | null} after dalın içeriği (silindiyse `null`)
 * @returns {ProtectedHit[]}
 */
export function contentRules(file, before, after) {
  /** @type {ProtectedHit[]} */
  const hits = [];
  if (file === AC_BASELINE) {
    const r = baselineLowered(before, after);
    if (r !== null) hits.push({ path: file, rule: "ac-baseline-lowered", reason: r });
  }
  if (file === DECISIONS) {
    const prev = acceptedDecisionIds(before);
    const next = [...acceptedDecisionIds(after)].filter((id) => !prev.has(id));
    if (next.length > 0) hits.push({ path: file, rule: "adr-accepted", reason: `durumu "kabul"e geçen: ${next.join(", ")}` });
  }
  if (matchesGlob(file, ADR_GLOB) && adrAccepted(after) && !adrAccepted(before)) {
    hits.push({ path: file, rule: "adr-accepted", reason: 'ADR durumu "kabul"e geçti' });
  }
  if (matchesAny(file, PACKAGE_JSON_GLOBS)) {
    const b = parsePackage(before);
    const a = parsePackage(after);
    if (!b.ok || !a.ok) {
      hits.push({ path: file, rule: "package-json", reason: "package.json ayrıştırılamadı (korunan alanlar denetlenemedi)" });
    } else {
      const fields = packageChanges(b.value, a.value);
      if (fields.length > 0) hits.push({ path: file, rule: "package-json", reason: `korunan alan değişti: ${fields.join(", ")}` });
    }
  }
  if (matchesAny(file, LOCKFILE_GLOBS)) {
    const r = lockfileChange(before, after);
    if (r !== null) hits.push({ path: file, rule: "lockfile", reason: r });
  }
  if (matchesAny(file, COMPOSE_GLOBS) && poolerImages(before) !== poolerImages(after)) {
    hits.push({ path: file, rule: "pooler-image", reason: "pooler imaj etiketi değişti" });
  }
  return hits;
}

/**
 * Değişiklik listesinden korunan değişiklikler (yol başına tek kayıt; ilk neden).
 * @param {Change[]} changes
 * @param {{ before: ReadFile, after: ReadFile }} read tabandaki ve daldaki içerik
 * @returns {ProtectedHit[]}
 */
export function classifyChanges(changes, read) {
  /** @type {Map<string, ProtectedHit>} */
  const hits = new Map();
  /** @param {ProtectedHit} h */
  const add = (h) => {
    if (!hits.has(h.path)) hits.set(h.path, h);
  };
  for (const c of changes) {
    const paths = c.oldPath === undefined ? [c.path] : [c.oldPath, c.path];
    for (const p of paths) {
      const g = staticRule(p);
      if (g !== null) {
        add({ path: p, rule: g, reason: `korunan yol (${g})` });
        continue;
      }
      // Tabanda var olan migration: değişiklik, silme, ad değişikliği korunur; yeni migration serbest.
      if (matchesAny(p, MIGRATION_GLOBS)) {
        const prev = read.before(p);
        if (prev !== null && (p === c.oldPath || read.after(p) !== prev)) {
          add({ path: p, rule: "migration", reason: "birleşmiş migration değişti/silindi" });
        }
      }
    }
    // İçerik kuralları: ad değişikliğinde eski içerik → yeni içerik.
    const beforeText = read.before(c.oldPath ?? c.path);
    const afterText = read.after(c.path);
    for (const h of contentRules(c.path, beforeText, afterText)) add(h);
    if (c.oldPath !== undefined && c.oldPath !== c.path) {
      for (const h of contentRules(c.oldPath, read.before(c.oldPath), null)) add(h);
    }
  }
  return [...hits.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
