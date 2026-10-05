// `docs/ACCEPTANCE.md` ayrıştırıcısı (T-007). İki tablo tanınır:
//   ana tablo      `ID | Senaryo | Beklenen | Faz`
//   koşullu tablo  `ID | Koşul | Senaryo | Beklenen | Faz`
// Fail-closed: tanınmayan tablo/satır/faz, yinelenen ID = hata (sessiz atlama yok).
import { readFileSync } from "node:fs";
import path from "node:path";
import { findMarkdownTables, isSeparatorRow, MarkdownTableError, splitMarkdownRow } from "../lib/pilot.mjs";

export const ACCEPTANCE_PATH = "docs/ACCEPTANCE.md";

/** Geçerli faz değerleri (dize; `docs/PHASES.md`). */
export const PHASES = /** @type {const} */ (["0", "1", "2", "3A", "3B", "4P", "4S", "5", "6", "7"]);

const MAIN_HEADER = ["ID", "Senaryo", "Beklenen", "Faz"];
const COND_HEADER = ["ID", "Koşul", "Senaryo", "Beklenen", "Faz"];

/**
 * @typedef {{
 *   id: string,
 *   num: number,
 *   phase: string,
 *   fallbackPhase?: string,
 *   conditional: boolean,
 *   condition?: string,
 *   line: number,
 * }} AcceptanceCriterion
 */

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isPhase(value) {
  return /** @type {readonly string[]} */ (PHASES).includes(value);
}

/**
 * `Faz` hücresini çözer: `3A` veya `3A (koşul yoksa 3B)`. Geçersizse `null`.
 * @param {string} cell
 * @returns {{ phase: string, fallbackPhase?: string } | null}
 */
export function parsePhaseCell(cell) {
  const m = /^(\S+)(?: \(koşul yoksa (\S+)\))?$/.exec(cell.trim());
  if (!m) return null;
  const [, phase = "", fallback] = m;
  if (!isPhase(phase)) return null;
  if (fallback === undefined) return { phase };
  if (!isPhase(fallback) || fallback === phase) return null;
  return { phase, fallbackPhase: fallback };
}

/**
 * ACCEPTANCE.md metnini ayrıştırır; `MarkdownTableError` atar.
 * @param {string} text
 * @param {string} [file]
 * @returns {AcceptanceCriterion[]}
 */
export function parseAcceptance(text, file = ACCEPTANCE_PATH) {
  const tables = findMarkdownTables(text);
  /** @type {AcceptanceCriterion[]} */
  const acs = [];
  const seen = new Set();
  let mainCount = 0;
  let condCount = 0;
  for (const table of tables) {
    const [headerRow, sepRow, ...dataRows] = table.rows;
    const header = headerRow ? splitMarkdownRow(headerRow.raw) : null;
    const key = header?.join("|");
    const conditional = key === COND_HEADER.join("|");
    if (!header || (!conditional && key !== MAIN_HEADER.join("|"))) {
      throw new MarkdownTableError(file, table.startLine, "tanınmayan tablo başlığı (beklenen: `ID | Senaryo | Beklenen | Faz` veya `ID | Koşul | Senaryo | Beklenen | Faz`)");
    }
    if (conditional) condCount++;
    else mainCount++;
    const sep = sepRow ? splitMarkdownRow(sepRow.raw) : null;
    if (!sepRow || !sep || sep.length !== header.length || !isSeparatorRow(sep)) {
      throw new MarkdownTableError(file, sepRow?.line ?? table.startLine + 1, "başlıktan sonra ayırıcı satır bekleniyordu");
    }
    for (const { line, raw } of dataRows) {
      const cells = splitMarkdownRow(raw);
      if (!cells || cells.length !== header.length) {
        throw new MarkdownTableError(file, line, `satır ${header.length} hücre içermeli (bulunan: ${cells?.length ?? 0})`);
      }
      const id = cells[0] ?? "";
      const idMatch = /^AC-(\d{2,})$/.exec(id);
      if (!idMatch) throw new MarkdownTableError(file, line, `geçersiz ID "${id}" (beklenen AC-NN)`);
      if (seen.has(id)) throw new MarkdownTableError(file, line, `yinelenen ID ${id}`);
      seen.add(id);
      const phaseCell = cells[cells.length - 1] ?? "";
      const parsed = parsePhaseCell(phaseCell);
      if (!parsed) throw new MarkdownTableError(file, line, `${id}: tanınmayan faz "${phaseCell}" (geçerli: ${PHASES.join(", ")}; koşullu: "3A (koşul yoksa 3B)")`);
      if (!conditional && parsed.fallbackPhase !== undefined) {
        throw new MarkdownTableError(file, line, `${id}: "koşul yoksa" yalnızca koşullu tabloda geçerli`);
      }
      /** @type {AcceptanceCriterion} */
      const ac = { id, num: Number(idMatch[1]), phase: parsed.phase, conditional, line };
      if (parsed.fallbackPhase !== undefined) ac.fallbackPhase = parsed.fallbackPhase;
      if (conditional) {
        const condition = cells[1] ?? "";
        if (condition === "") throw new MarkdownTableError(file, line, `${id}: Koşul hücresi boş`);
        ac.condition = condition;
      }
      acs.push(ac);
    }
  }
  if (mainCount !== 1) throw new MarkdownTableError(file, 1, `tam bir ana AC tablosu olmalı (bulunan: ${mainCount})`);
  if (condCount > 1) throw new MarkdownTableError(file, 1, `en fazla bir koşullu AC tablosu olmalı (bulunan: ${condCount})`);
  return acs;
}

/**
 * @param {string} root
 * @returns {AcceptanceCriterion[]}
 */
export function loadAcceptance(root) {
  return parseAcceptance(readFileSync(path.join(root, ACCEPTANCE_PATH), "utf8"), ACCEPTANCE_PATH);
}
