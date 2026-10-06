// Görev kartı yardımcıları (T-008a): dal adından kart, kartın "Dokunulacak dosyalar" listesi,
// `int/*` dalında birleştirilmiş kartlar. Belirsizlikte hata (fail-closed).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** `feat|fix/T-xxx[a-z]?-…` */
const WORK_BRANCH = /^(?:feat|fix)\/(T-\d{3}[a-z]?)-[^\s]+$/;
/** Birleştirme commit konusunda geçen çalışma dalı (`origin/feat/…`, `owner/feat/…`, `'feat/…'`). */
const MERGED_BRANCH = /(?:^|[\s'"/])((?:feat|fix)\/T-\d{3}[a-z]?-[^\s'"]+)/g;
const INT_BRANCH = /^int\/[^\s]+$/;

export const TASKS_DIR = "docs/tasks";

export class CardError extends Error {
  /**
   * @param {string} code neden kodu (`CARD_NOT_FOUND`, `CARD_INVALID`)
   * @param {string} file ilgili yol veya `-`
   * @param {string} message
   */
  constructor(code, file, message) {
    super(message);
    this.name = "CardError";
    this.code = code;
    this.file = file;
  }
}

/**
 * @param {string} id `T-008a`
 * @returns {string} depo köküne göre kart yolu
 */
export function cardPath(id) {
  return `${TASKS_DIR}/${id}.md`;
}

/**
 * Çalışma dalından kart kimliği. Kalıba uymazsa `null`.
 * @param {string} branch
 * @returns {string | null}
 */
export function cardIdFromBranch(branch) {
  const m = WORK_BRANCH.exec(branch);
  return m?.[1] ?? null;
}

/**
 * @param {string} branch
 * @returns {boolean}
 */
export function isIntBranch(branch) {
  return INT_BRANCH.test(branch);
}

/**
 * Birleştirme commit konularından birleştirilmiş çalışma dalları (tekil, ilk görülme sırası).
 * @param {string[]} subjects
 * @returns {string[]}
 */
export function mergedWorkBranches(subjects) {
  /** @type {string[]} */
  const out = [];
  for (const s of subjects) {
    for (const m of s.matchAll(MERGED_BRANCH)) {
      const b = m[1];
      if (b !== undefined && !out.includes(b)) out.push(b);
    }
  }
  return out;
}

/**
 * Bir satırdaki backtick içi parçalar; parantez içindekiler (iç içe dahil) yok sayılır.
 * Backtick içindeki parantezler derinliği etkilemez.
 * @param {string} line
 * @returns {string[]}
 */
export function backtickSegmentsOutsideParens(line) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let inTick = false;
  let buf = "";
  for (const ch of line) {
    if (inTick) {
      if (ch === "`") {
        inTick = false;
        if (depth === 0) out.push(buf);
        buf = "";
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "`") inTick = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
  }
  if (inTick) throw new CardError("CARD_INVALID", "-", "kapanmamış backtick");
  return out;
}

/**
 * Kart metninden "Dokunulacak dosyalar" globları. Satır yoksa veya hiç yol yoksa hata.
 * Sonu `/` olan giriş dizin anlamına gelir → `<dizin>/**`.
 * @param {string} text kart içeriği
 * @param {string} file hata mesajı için kart yolu
 * @returns {string[]}
 */
export function parseCardFiles(text, file) {
  const lines = text.split(/\r?\n/).filter((l) => /^\s*\*\*Dokunulacak dosyalar\b/.test(l));
  if (lines.length === 0) throw new CardError("CARD_INVALID", file, '"Dokunulacak dosyalar" satırı yok');
  if (lines.length > 1) throw new CardError("CARD_INVALID", file, '"Dokunulacak dosyalar" satırı birden fazla');
  const line = /** @type {string} */ (lines[0]);
  const colon = line.indexOf(":**");
  if (colon === -1) throw new CardError("CARD_INVALID", file, '"Dokunulacak dosyalar" satırı `**…:**` biçiminde değil');
  let segs;
  try {
    segs = backtickSegmentsOutsideParens(line.slice(colon + 3));
  } catch (e) {
    if (e instanceof CardError) throw new CardError(e.code, file, `"Dokunulacak dosyalar": ${e.message}`);
    throw e;
  }
  /** @type {string[]} */
  const globs = [];
  for (const raw of segs) {
    let g = raw.trim();
    if (g === "" || /\s/.test(g)) throw new CardError("CARD_INVALID", file, `geçersiz yol girdisi: "${raw}"`);
    if (g.startsWith("./")) g = g.slice(2);
    if (g.startsWith("/") || g.split("/").includes("..")) {
      throw new CardError("CARD_INVALID", file, `depo dışını gösteren yol: "${raw}"`);
    }
    if (g.endsWith("/")) g += "**";
    if (!globs.includes(g)) globs.push(g);
  }
  if (globs.length === 0) throw new CardError("CARD_INVALID", file, '"Dokunulacak dosyalar" listesinde yol yok');
  return globs;
}

/**
 * @typedef {{ id: string, path: string, globs: string[], intTarget: string | null }} Card
 */

/**
 * Kartı çalışma ağacından okur.
 * @param {string} root depo kökü
 * @param {string} id
 * @returns {Card}
 */
export function loadCard(root, id) {
  const rel = cardPath(id);
  const abs = path.join(root, rel);
  if (!existsSync(abs)) throw new CardError("CARD_NOT_FOUND", rel, `${id} kartı yok`);
  const text = readFileSync(abs, "utf8");
  return { id, path: rel, globs: parseCardFiles(text, rel), intTarget: cardIntTarget(text) };
}

/**
 * Kartın `**Dal:**` satırındaki `→ \`int/…\`` hedefi; yoksa `null`.
 * @param {string} text
 * @returns {string | null}
 */
export function cardIntTarget(text) {
  const line = text.split(/\r?\n/).find((l) => l.includes("**Dal:**"));
  if (line === undefined) return null;
  const m = /\*\*Dal:\*\*[^·]*?→\s*`(int\/[^`\s]+)`/.exec(line);
  return m?.[1] ?? null;
}

/**
 * Dal için kapsam kartları. Çalışma dalı → tek kart; `int/*` → birleştirilmiş çalışma
 * dallarının kartları. Diğer her dal adı = `CARD_NOT_FOUND` (fail-closed).
 * @param {string} root
 * @param {string} branch
 * @param {() => string[]} mergedSubjects `int/*` için birleştirme konuları (tembel)
 * @returns {{ kind: "work" | "int", cards: Card[] }}
 */
export function resolveCards(root, branch, mergedSubjects) {
  const id = cardIdFromBranch(branch);
  if (id !== null) return { kind: "work", cards: [loadCard(root, id)] };
  if (isIntBranch(branch)) {
    /** @type {Card[]} */
    const cards = [];
    for (const b of mergedWorkBranches(mergedSubjects())) {
      const cid = /** @type {string} */ (cardIdFromBranch(b));
      if (!cards.some((c) => c.id === cid)) cards.push(loadCard(root, cid));
    }
    cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { kind: "int", cards };
  }
  throw new CardError(
    "CARD_NOT_FOUND",
    "-",
    `dal adı "${branch}" kart kalıbına uymuyor (feat|fix/T-xxx[a-z]?-… veya int/…)`,
  );
}
