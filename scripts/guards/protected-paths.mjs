// Korunan yollar ve içerik kuralları — tek kaynak (T-008c; PROTOCOL §3b `check:protected`,
// §Onay kaynağı, I-17). `check:ac-ratchet` (T-008d) taban düşüş kuralını buradan kullanır.
//
// Üç tür kural:
//   1. Yol kuralı      — eşleşen yolda her değişiklik (ekleme, değişiklik, silme, ad değişikliği) korunur.
//   2. Taban kuralı    — dosya tabanda vardıysa korunur (birleşmiş migration'lar; yeni migration serbest).
//   3. İçerik kuralı   — yalnızca belirli alan/satır değişirse korunur (sürüm alanları, auditConfig/overrides/configDependencies,
//                        pooler imajı, AC tabanı düşüşü, ADR'nin "kabul"e geçmesi).
// Belirsizlikte (ayrıştırılamayan dosya) korunan sayılır (fail-closed).
// Repoda henüz olmayan yollar (`packages/db/…`, `scripts/check-docs.mjs`, `.githooks/`, `tests/…`)
// desen olarak durur (G-05); dosya oluştuğu anda kural işler.
import path from "node:path";

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
  // Karantina kaydı
  "tests/QUARANTINE.md",
  // pnpm kancaları (kurulumda kod çalıştırır; T-003 security-reviewer MAJOR)
  ".pnpmfile.*",
  "**/.pnpmfile.*",
]);

/**
 * Paket yöneticisi güvenlik yapılandırması (T-003 security-reviewer MAJOR): `pnpm-workspace.yaml`,
 * `.npmrc` ve tüm `package.json`'larda bu anahtarların değişmesi korunur. `resolutions` pnpm'de
 * `overrides` eşdeğeridir; `pnpmfile` ayarı `.pnpmfile.*` yol kuralını başka dosyaya yönlendirebilir.
 */
export const PM_CONFIG_KEYS = Object.freeze(["auditConfig", "overrides", "resolutions", "configDependencies", "pnpmfile"]);

/** Taban kuralı: tabanda var olan (birleşmiş) migration dosyaları. Yeni migration korunmaz. */
export const MIGRATION_GLOBS = Object.freeze(["**/migrations/**", "**/drizzle/**"]);

export const AC_BASELINE = "tests/.ac-baseline.json";
export const DECISIONS = "docs/DECISIONS.md";
export const ADR_GLOB = "docs/adr/ADR-*.md";
export const ROOT_PACKAGE = "package.json";
export const WORKSPACE_YAML = "pnpm-workspace.yaml";
export const NPMRC_GLOBS = Object.freeze([".npmrc", "**/.npmrc"]);
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

/** Kök `package.json`'da sürüm alanı korunan ORM / sürücü paketleri (ADR-003, ADR-004). */
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

/** Sürüm taşıyan `package.json` bölümleri (`overrides`/`resolutions` tüm dosyalarda `PM_CONFIG_KEYS` ile). */
const VERSION_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * Kök `package.json`'da bekçi/doğrulama giriş noktaları: betik gövdesini değiştirmek bekçiyi
 * atlatmanın en kısa yoludur (`"check:protected": "true"`). PROTOCOL §3b "bekçi betikleri".
 */
const GUARD_SCRIPT_RE = /^(?:verify|check:.+|test:ac)$/;

/**
 * @param {string} file
 * @param {readonly string[]} globs
 * @returns {boolean}
 */
export function matchesAny(file, globs) {
  return globs.some((g) => path.posix.matchesGlob(file, g));
}

/**
 * Yol kuralı veya taban kuralı (içerikten bağımsız) için korunanlık nedeni.
 * @param {string} file
 * @returns {string | null}
 */
export function staticRule(file) {
  for (const g of PROTECTED_GLOBS) if (path.posix.matchesGlob(file, g)) return g;
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

/**
 * AC tabanı düşüşü: tabandaki bir sayısal değer azaldı veya kaldırıldı. Artış/ekleme serbest.
 * Biçim T-008d'de belirlenir; kural biçimden bağımsızdır (tüm sayısal yapraklar).
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
  /** @type {string[]} */
  const lowered = [];
  for (const [k, n] of bm) {
    const m = am.get(k);
    if (m === undefined) lowered.push(`${k}: ${n} → yok`);
    else if (m < n) lowered.push(`${k}: ${n} → ${m}`);
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
 * Kök `package.json`'da korunan alanların değişmesi: ORM/sürücü sürüm alanları ve bekçi betikleri.
 * @param {Record<string, unknown> | null} b
 * @param {Record<string, unknown> | null} a
 * @returns {string[]}
 */
function rootPackageChanges(b, a) {
  /** @type {string[]} */
  const out = [];
  for (const s of VERSION_SECTIONS) {
    const bs = obj(b?.[s]);
    const as = obj(a?.[s]);
    for (const k of new Set([...Object.keys(bs), ...Object.keys(as)])) {
      if (DB_PACKAGES.includes(k) && JSON.stringify(bs[k]) !== JSON.stringify(as[k])) out.push(`${s}.${k}`);
    }
  }
  const bScripts = obj(b?.["scripts"]);
  const aScripts = obj(a?.["scripts"]);
  for (const k of new Set([...Object.keys(bScripts), ...Object.keys(aScripts)])) {
    if (GUARD_SCRIPT_RE.test(k) && bScripts[k] !== aScripts[k]) out.push(`scripts.${k}`);
  }
  return out;
}

/**
 * Her `package.json`'da paket yöneticisi yapılandırması (`PM_CONFIG_KEYS`): üst düzey ve `pnpm.` altında.
 * @param {Record<string, unknown> | null} b
 * @param {Record<string, unknown> | null} a
 * @returns {string[]}
 */
function pmConfigChanges(b, a) {
  /** @type {string[]} */
  const out = [];
  for (const k of PM_CONFIG_KEYS) {
    if (JSON.stringify(b?.[k]) !== JSON.stringify(a?.[k])) out.push(k);
    if (JSON.stringify(obj(b?.["pnpm"])[k]) !== JSON.stringify(obj(a?.["pnpm"])[k])) out.push(`pnpm.${k}`);
  }
  return out;
}

/** Alt dize, büyük/küçük harf duyarsız (`globalPnpmfile`, `global-pnpmfile` dahil); fazla eşleşme korunur. */
const PM_KEY_RE = new RegExp(PM_CONFIG_KEYS.join("|"), "i");

/**
 * YAML'da `PM_CONFIG_KEYS` anahtarlarından biri geçen satır(lar) ve onların daha girintili alt
 * blokları. Ayrıştırıcı yok (bağımlılık eklenmez); metin düzeyinde, yorumlar dahil karşılaştırılır.
 * @param {string | null} text
 * @returns {string}
 */
export function yamlConfigBlock(text) {
  if (text === null) return "";
  const lines = text.split(/\r?\n/);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (!PM_KEY_RE.test(l)) continue;
    const indent = /^\s*/.exec(l)?.[0].length ?? 0;
    out.push(l.trimEnd());
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j] ?? "";
      if (n.trim() === "") continue;
      if ((/^\s*/.exec(n)?.[0].length ?? 0) <= indent) break;
      out.push(n.trimEnd());
      i = j;
    }
  }
  return out.join("\n");
}

/**
 * `.npmrc`'de anahtarı audit / pnpmfile / override / resolution / config-dependencies içeren
 * ayarlar (yorumlar hariç), sıralı.
 * @param {string | null} text
 * @returns {string}
 */
export function npmrcConfigLines(text) {
  if (text === null) return "";
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l !== "" &&
        !l.startsWith("#") &&
        !l.startsWith(";") &&
        /audit|pnpmfile|override|resolution|config-?dependencies/i.test(l.split("=")[0] ?? ""),
    )
    .map((l) => l.replace(/\s*=\s*/, "="))
    .sort()
    .join("\n");
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
  if (path.posix.matchesGlob(file, ADR_GLOB) && adrAccepted(after) && !adrAccepted(before)) {
    hits.push({ path: file, rule: "adr-accepted", reason: 'ADR durumu "kabul"e geçti' });
  }
  if (matchesAny(file, PACKAGE_JSON_GLOBS)) {
    const b = parsePackage(before);
    const a = parsePackage(after);
    if (!b.ok || !a.ok) {
      hits.push({ path: file, rule: "package-json", reason: "package.json ayrıştırılamadı (korunan alanlar denetlenemedi)" });
    } else {
      const fields = [...pmConfigChanges(b.value, a.value), ...(file === ROOT_PACKAGE ? rootPackageChanges(b.value, a.value) : [])];
      if (fields.length > 0) hits.push({ path: file, rule: "package-json", reason: `korunan alan değişti: ${fields.join(", ")}` });
    }
  }
  if (file === WORKSPACE_YAML && yamlConfigBlock(before) !== yamlConfigBlock(after)) {
    hits.push({ path: file, rule: "pm-config", reason: `paket yöneticisi yapılandırması değişti (${PM_CONFIG_KEYS.join("/")})` });
  }
  if (matchesAny(file, NPMRC_GLOBS) && npmrcConfigLines(before) !== npmrcConfigLines(after)) {
    hits.push({ path: file, rule: "pm-config", reason: "audit/pnpmfile/override ayarı değişti" });
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
