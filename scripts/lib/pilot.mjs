// `docs/PILOT.md` tablo ayrıştırıcısı (T-007; `check:pilot` / T-008f yeniden kullanır).
// Sözleşme: `docs/tasks/T-006.md` — sütunlar `key | Alan | Değer | Varsayım`, dosyada tek tablo.
// Fail-closed: bozuk satır, yinelenen anahtar, bilinmeyen tablo = hata (sessiz atlama yok).
import { readFileSync } from "node:fs";
import path from "node:path";

/** PILOT.md'nin depo köküne göre yolu. */
export const PILOT_PATH = "docs/PILOT.md";

/** PILOT tablosunun beklenen başlığı. */
export const PILOT_HEADER = /** @type {const} */ (["key", "Alan", "Değer", "Varsayım"]);

/**
 * T-006 enum alanları. Anahtar, `tracking_mode.*` gibi önek desenini de kabul eder.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const PILOT_ENUMS = Object.freeze({
  "tracking_mode.*": ["NONE", "LOT", "SERIAL", "LOT_AND_SERIAL"],
  handling_unit_mode: ["UNIT_ONLY", "TRACKED", "MIXED"],
  expiry_tracking: ["YES", "NO"],
  partial_case_opening: ["YES", "NO"],
  offline_required: ["YES", "NO"],
  expiry_fefo: ["YES", "NO", "NOT_APPLICABLE"],
  stock_owner: ["SINGLE", "ON_BEHALF"],
  erp_integration: ["NONE"],
});

/**
 * @typedef {{ key: string, field: string, value: string, assumption: string, line: number }} PilotRow
 */

export class MarkdownTableError extends Error {
  /**
   * @param {string} file
   * @param {number} line
   * @param {string} message
   */
  constructor(file, line, message) {
    super(`${file}:${line} ${message}`);
    this.name = "MarkdownTableError";
    this.file = file;
    this.line = line;
  }
}

/**
 * Markdown tablo satırını hücrelere böler. Kaçışlı `\|` hücre ayırıcı sayılmaz.
 * Satır `|` ile başlamıyor veya bitmiyorsa `null`.
 * @param {string} raw
 * @returns {string[] | null}
 */
export function splitMarkdownRow(raw) {
  const line = raw.trim();
  if (!line.startsWith("|") || !line.endsWith("|") || line.length < 2) return null;
  const inner = line.slice(1, -1);
  /** @type {string[]} */
  const cells = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * `|---|:--:|` biçimindeki ayırıcı satır mı?
 * @param {string[]} cells
 * @returns {boolean}
 */
export function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * Metindeki ardışık `|` satırlarını tablolara gruplar.
 * @param {string} text
 * @returns {Array<{ startLine: number, rows: Array<{ line: number, raw: string }> }>}
 */
export function findMarkdownTables(text) {
  /** @type {Array<{ startLine: number, rows: Array<{ line: number, raw: string }> }>} */
  const tables = [];
  /** @type {{ startLine: number, rows: Array<{ line: number, raw: string }> } | null} */
  let current = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trimStart().startsWith("|")) {
      if (!current) {
        current = { startLine: i + 1, rows: [] };
        tables.push(current);
      }
      current.rows.push({ line: i + 1, raw });
    } else {
      current = null;
    }
  }
  return tables;
}

/**
 * PILOT.md metnini ayrıştırır. Hata durumunda `MarkdownTableError` atar.
 * @param {string} text
 * @param {string} [file]
 * @returns {Map<string, PilotRow>}
 */
export function parsePilotTable(text, file = PILOT_PATH) {
  const tables = findMarkdownTables(text);
  if (tables.length === 0) throw new MarkdownTableError(file, 1, "PILOT tablosu bulunamadı");
  if (tables.length > 1) {
    const extra = tables[1];
    throw new MarkdownTableError(file, extra?.startLine ?? 1, "PILOT.md'de birden fazla tablo var (sözleşme: tek tablo)");
  }
  const table = /** @type {(typeof tables)[number]} */ (tables[0]);
  const [headerRow, sepRow, ...dataRows] = table.rows;
  const header = headerRow ? splitMarkdownRow(headerRow.raw) : null;
  if (!headerRow || !header || header.join("|") !== PILOT_HEADER.join("|")) {
    throw new MarkdownTableError(file, table.startLine, `tablo başlığı "${PILOT_HEADER.join(" | ")}" olmalı`);
  }
  const sep = sepRow ? splitMarkdownRow(sepRow.raw) : null;
  if (!sepRow || !sep || sep.length !== header.length || !isSeparatorRow(sep)) {
    throw new MarkdownTableError(file, sepRow?.line ?? headerRow.line + 1, "başlıktan sonra ayırıcı satır bekleniyordu");
  }
  /** @type {Map<string, PilotRow>} */
  const rows = new Map();
  for (const { line, raw } of dataRows) {
    const cells = splitMarkdownRow(raw);
    if (!cells || cells.length !== header.length) {
      throw new MarkdownTableError(file, line, `satır ${header.length} hücre içermeli`);
    }
    const [key = "", field = "", value = "", assumption = ""] = cells;
    if (!/^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(key)) {
      throw new MarkdownTableError(file, line, `geçersiz key "${key}"`);
    }
    if (value === "") throw new MarkdownTableError(file, line, `"${key}" için Değer boş`);
    if (rows.has(key)) throw new MarkdownTableError(file, line, `yinelenen key "${key}"`);
    rows.set(key, { key, field, value, assumption, line });
  }
  if (rows.size === 0) throw new MarkdownTableError(file, table.startLine, "PILOT tablosunda satır yok");
  return rows;
}

/**
 * `tracking_mode.*` gibi desenle eşleşen satırları döndürür; düz anahtar için tek satır.
 * @param {Map<string, PilotRow>} rows
 * @param {string} keyPattern
 * @returns {PilotRow[]}
 */
export function pilotRowsFor(rows, keyPattern) {
  if (keyPattern.endsWith(".*")) {
    const prefix = keyPattern.slice(0, -1);
    return [...rows.values()].filter((r) => r.key.startsWith(prefix) && r.key.length > prefix.length);
  }
  const row = rows.get(keyPattern);
  return row ? [row] : [];
}

/**
 * Anahtar için T-006 enum listesini döndürür (yoksa `null`).
 * @param {string} key
 * @returns {readonly string[] | null}
 */
export function pilotEnumFor(key) {
  if (Object.hasOwn(PILOT_ENUMS, key)) return PILOT_ENUMS[key] ?? null;
  const dot = key.indexOf(".");
  if (dot > 0) {
    const pattern = `${key.slice(0, dot)}.*`;
    if (Object.hasOwn(PILOT_ENUMS, pattern)) return PILOT_ENUMS[pattern] ?? null;
  }
  return null;
}

/**
 * Kökteki PILOT.md'yi okur. Dosya yoksa `null`; ayrıştırma hatası atılır.
 * @param {string} root
 * @returns {Map<string, PilotRow> | null}
 */
export function loadPilot(root) {
  let text;
  try {
    text = readFileSync(path.join(root, PILOT_PATH), "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
  return parsePilotTable(text, PILOT_PATH);
}
