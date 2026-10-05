// `@AC-xx` etiket toplayıcı (T-007; `check:ac-ratchet` / T-008d yeniden kullanır).
// Statik tarama: test dosyalarında `it|test|describe|suite(...)` başlık dizesindeki `@AC-\d+`.
// Yalnızca başlıklar sayılır; yorumdaki veya başka dizelerdeki etiket sayılmaz.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Taranan kök dizinler (depo köküne göre). */
export const SCAN_ROOTS = /** @type {const} */ (["tests", "packages", "apps", "scripts"]);

/** Taranmayan dizin adları (her derinlikte). */
export const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".artifacts", ".git", "coverage", ".turbo"]);

/** Test dosyası adı deseni. */
export const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Entegrasyon test dosyası (T-005a `vitest.int.config.ts` yalnızca bunları içerir). */
export const INT_TEST_FILE_RE = /\.int\.test\.[cm]?[jt]sx?$/;

/** Başlıktaki etiket. `@AC-5` ile `@AC-05` farklıdır; ID'ler ACCEPTANCE.md'dekiyle birebir eşleşmeli. */
export const TAG_RE = /@(AC-\d+)(?!\d)/g;

const TITLE_RE = /\b(x?it|x?test|x?describe|suite)\b((?:\s*\.\s*\w+(?:\([^)]*\))?)*)\s*\(\s*(["'`])((?:\\[\s\S]|(?!\3)[^\\])*)\3/g;
const STATIC_SKIP_RE = /\.\s*(skip|todo|skipIf|runIf)\b/;
const PLAYWRIGHT_RE = /(?:from\s*|require\(\s*|import\(\s*)["']@playwright\/test["']/;

/**
 * @typedef {"unit" | "int" | "playwright"} TestKind
 * @typedef {{
 *   id: string,
 *   file: string,
 *   line: number,
 *   title: string,
 *   kind: TestKind,
 *   staticSkip: boolean,
 * }} TaggedTest
 */

/**
 * Bir test dosyası metnindeki etiketli başlıkları çıkarır.
 * @param {string} text
 * @param {string} file depo köküne göre yol
 * @returns {TaggedTest[]}
 */
export function extractTags(text, file) {
  /** @type {TestKind} */
  const kind = PLAYWRIGHT_RE.test(text) ? "playwright" : INT_TEST_FILE_RE.test(file) ? "int" : "unit";
  /** @type {TaggedTest[]} */
  const out = [];
  for (const m of text.matchAll(TITLE_RE)) {
    const [, fn = "", modifiers = "", , title = ""] = m;
    const ids = [...title.matchAll(TAG_RE)].map((t) => t[1] ?? "");
    if (ids.length === 0) continue;
    const line = text.slice(0, m.index).split("\n").length;
    const staticSkip = fn.startsWith("x") || STATIC_SKIP_RE.test(modifiers);
    for (const id of new Set(ids)) out.push({ id, file, line, title, kind, staticSkip });
  }
  return out;
}

/**
 * Kök altındaki test dosyalarını (göreli, `/` ayraçlı, sıralı) listeler.
 * @param {string} root
 * @param {readonly string[]} [roots]
 * @returns {string[]}
 */
export function listTestFiles(root, roots = SCAN_ROOTS) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} rel */
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return;
      throw e;
    }
    for (const ent of entries) {
      const child = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(child);
      } else if (ent.isFile() && TEST_FILE_RE.test(ent.name)) {
        files.push(child);
      }
    }
  };
  for (const r of roots) walk(r);
  return files.sort();
}

/**
 * Tüm etiketli testleri toplar.
 * @param {string} root
 * @param {readonly string[]} [roots]
 * @returns {TaggedTest[]}
 */
export function collectTags(root, roots = SCAN_ROOTS) {
  return listTestFiles(root, roots).flatMap((f) => extractTags(readFileSync(path.join(root, f), "utf8"), f));
}

/**
 * Etiketli testleri AC ID'sine göre gruplar.
 * @param {TaggedTest[]} tags
 * @returns {Map<string, TaggedTest[]>}
 */
export function groupById(tags) {
  /** @type {Map<string, TaggedTest[]>} */
  const map = new Map();
  for (const t of tags) {
    const list = map.get(t.id) ?? [];
    list.push(t);
    map.set(t.id, list);
  }
  return map;
}
