// Karantina kaydı ve geçerlilik kuralları (T-008e; PROTOCOL §Karantina kuralı, AC-44).
// `check:tests` (etiket + kayıt denetimi) ve `pnpm test:ac` (`scripts/test-ac/run.mjs`: karantinalı
// testin sonucu raporlanır, kırmızısı yalnızca kayıt geçerliyse kapıyı kırmaz) paylaşır.
// Karantina atlama değildir: test her koşuda normal koşturulur (T-008b kural 5).
//
// Etiket: test (veya describe) başlığında `@quarantine Q-xx`. Yorumdaki etiket sayılmaz.
// Kayıt: `tests/QUARANTINE.md` tablosu
//   | Q | Test adı | Dosya | Neden | Sahip kart | Eklendiği tarih | Bitiş tarihi |
// Geçerlilik (hepsi):
//   (a) etiketin kaydı var ve kayıttaki dosya testin dosyası  → aksi QUARANTINE_UNREGISTERED
//   (b) kayıt satırı `main`'de (varsayılan `origin/main`) birebir aynı → aksi QUARANTINE_NOT_APPROVED
//       (karantinayı ekleyen PR birleşmiş; PR'da eklenen/değişen kayıt korunan dosya değişikliğidir,
//       onayı `check:protected` denetler — §Onay kaynağı)
//   (c) test, kapısı değerlendirilen fazın (`currentGatePhase`) `@AC` testi değil → aksi QUARANTINE_GATE_AC
//   (d) bitiş ≤ eklendiği tarih + 14 gün → aksi QUARANTINE_TOO_LONG; bugün (UTC) ≤ bitiş →
//       aksi QUARANTINE_EXPIRED; eklendiği tarih ≤ bugün (UTC) → aksi QUARANTINE_FUTURE_DATE (T-008j:
//       ileri tarihli "eklendi" 14 gün sınırını öteler). Bu üçü kayıt satırı için etiketten bağımsız da hatadır.
// Kayıt dosyası ayrıştırılamazsa QUARANTINE_REGISTRY_INVALID (fail-closed).
import { readFileSync } from "node:fs";
import path from "node:path";
import { findMarkdownTables, isSeparatorRow, splitMarkdownRow } from "../../lib/pilot.mjs";
import { DEFAULT_TARGET, fileAtRef, GitError } from "./git.mjs";

export const QUARANTINE_FILE = "tests/QUARANTINE.md";
/** En uzun karantina süresi (gün). */
export const MAX_DAYS = 14;
export const QUARANTINE_HEADER = /** @type {const} */ (["Q", "Test adı", "Dosya", "Neden", "Sahip kart", "Eklendiği tarih", "Bitiş tarihi"]);

export const CODES = Object.freeze({
  UNREGISTERED: "QUARANTINE_UNREGISTERED",
  NOT_APPROVED: "QUARANTINE_NOT_APPROVED",
  GATE_AC: "QUARANTINE_GATE_AC",
  EXPIRED: "QUARANTINE_EXPIRED",
  TOO_LONG: "QUARANTINE_TOO_LONG",
  FUTURE_DATE: "QUARANTINE_FUTURE_DATE",
  REGISTRY_INVALID: "QUARANTINE_REGISTRY_INVALID",
});

const QID_RE = /^Q-\d+$/;
const CARD_RE = /^T-\d{3}[a-z]?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AC_TAG_RE = /@(AC-\d+)(?!\d)/g;

/**
 * @typedef {{ id: string, test: string, file: string, reason: string, card: string, added: string, end: string, line: number }} QuarantineEntry
 * @typedef {{ line: number, message: string }} RegistryError
 * @typedef {{ entries: Map<string, QuarantineEntry>, errors: RegistryError[] }} Registry
 * @typedef {{ code: string, message: string }} QuarantineFinding
 * @typedef {{
 *   registry: Registry | null,
 *   main: Registry | null,
 *   mainRef: string,
 *   mainError: string | null,
 *   today: string,
 * }} QuarantineState
 */

/**
 * Başlıktaki karantina etiketleri. `bare`: kimliksiz (`@quarantine` tek başına veya bozuk kimlik).
 * @param {string} title
 * @returns {{ ids: string[], bare: boolean }}
 */
export function quarantineTags(title) {
  /** @type {string[]} */
  const ids = [];
  let bare = false;
  for (const m of title.matchAll(/@quarantine(?![\p{L}\p{N}_])(?:\s+(Q-\d+)(?!\d))?/gu)) {
    const id = m[1];
    if (id === undefined) bare = true;
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, bare };
}

/**
 * Metindeki `@AC-xx` etiketleri.
 * @param {string} text
 * @returns {string[]}
 */
export function acTagsOf(text) {
  return [...new Set([...text.matchAll(AC_TAG_RE)].map((m) => m[1] ?? ""))].filter((x) => x !== "");
}

/**
 * Geçerli takvim tarihi mi (`YYYY-MM-DD`).
 * @param {string} s
 * @returns {boolean}
 */
function isDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * İki tarih arasındaki gün farkı (`b - a`).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * CI saatinden bugünün UTC tarihi.
 * @param {Date} [now]
 * @returns {string}
 */
export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * `tests/QUARANTINE.md` metnini ayrıştırır. Tek tablo, başlık birebir; boş tablo geçerlidir.
 * @param {string} text
 * @returns {Registry}
 */
export function parseRegistry(text) {
  /** @type {Map<string, QuarantineEntry>} */
  const entries = new Map();
  /** @type {RegistryError[]} */
  const errors = [];
  const tables = findMarkdownTables(text);
  if (tables.length !== 1) {
    errors.push({ line: tables[1]?.startLine ?? 1, message: `tam bir karantina tablosu olmalı (bulunan: ${tables.length})` });
    return { entries, errors };
  }
  const table = /** @type {(typeof tables)[number]} */ (tables[0]);
  const [header, sep, ...rows] = table.rows;
  const headerCells = header === undefined ? null : splitMarkdownRow(header.raw);
  if (headerCells === null || headerCells.join("|") !== QUARANTINE_HEADER.join("|")) {
    errors.push({ line: table.startLine, message: `başlık "${QUARANTINE_HEADER.join(" | ")}" olmalı` });
    return { entries, errors };
  }
  const sepCells = sep === undefined ? null : splitMarkdownRow(sep.raw);
  if (sep === undefined || sepCells === null || !isSeparatorRow(sepCells) || sepCells.length !== QUARANTINE_HEADER.length) {
    errors.push({ line: sep?.line ?? table.startLine, message: "başlıktan sonra ayırıcı satır olmalı" });
    return { entries, errors };
  }
  for (const row of rows) {
    const cells = splitMarkdownRow(row.raw);
    if (cells === null || cells.length !== QUARANTINE_HEADER.length) {
      errors.push({ line: row.line, message: `${QUARANTINE_HEADER.length} hücre olmalı` });
      continue;
    }
    const [id = "", test = "", rawFile = "", reason = "", card = "", added = "", end = ""] = cells;
    const file = rawFile.replace(/^`(.*)`$/, "$1");
    /** @type {string[]} */
    const bad = [];
    if (!QID_RE.test(id)) bad.push(`kimlik "${id}" Q-xx biçiminde değil`);
    else if (entries.has(id)) bad.push(`${id} yinelenmiş`);
    if (test === "") bad.push("test adı boş");
    if (file === "" || file.startsWith("/") || file.split("/").includes("..")) bad.push(`dosya "${rawFile}" depo-göreli yol değil`);
    if (reason === "") bad.push("neden boş");
    if (!CARD_RE.test(card)) bad.push(`sahip kart "${card}" T-xxx biçiminde değil`);
    if (!isDate(added)) bad.push(`eklendiği tarih "${added}" YYYY-MM-DD değil`);
    if (!isDate(end)) bad.push(`bitiş tarihi "${end}" YYYY-MM-DD değil`);
    if (isDate(added) && isDate(end) && end < added) bad.push("bitiş tarihi eklendiği tarihten önce");
    if (bad.length > 0) {
      errors.push({ line: row.line, message: bad.join("; ") });
      continue;
    }
    entries.set(id, { id, test, file, reason, card, added, end, line: row.line });
  }
  return { entries, errors };
}

/**
 * Çalışma ağacındaki ve `main`'deki kayıt. Çalışma ağacında dosya yoksa `registry: null`.
 * `main` okunamazsa (`mainRef` yok, git deposu değil) `main: null` + `mainError` (fail-closed:
 * hiçbir kayıt onaylı sayılmaz).
 * @param {string} root
 * @param {{ mainRef?: string, now?: Date }} [opts]
 * @returns {QuarantineState}
 */
export function loadQuarantine(root, opts = {}) {
  const mainRef = opts.mainRef ?? DEFAULT_TARGET;
  /** @type {Registry | null} */
  let registry = null;
  try {
    registry = parseRegistry(readFileSync(path.join(root, QUARANTINE_FILE), "utf8"));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
  /** @type {Registry | null} */
  let main = null;
  /** @type {string | null} */
  let mainError = null;
  try {
    const text = fileAtRef(root, mainRef, QUARANTINE_FILE);
    if (text === null) mainError = `${mainRef}:${QUARANTINE_FILE} yok`;
    else main = parseRegistry(text);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    mainError = `${mainRef} okunamadı (${e.message})`;
  }
  return { registry, main, mainRef, mainError, today: todayUtc(opts.now) };
}

/**
 * Kayıt satırının etiketten bağımsız süre bulguları (TOO_LONG, EXPIRED, FUTURE_DATE).
 * @param {QuarantineEntry} entry
 * @param {string} today
 * @returns {QuarantineFinding[]}
 */
export function entryDateFindings(entry, today) {
  /** @type {QuarantineFinding[]} */
  const out = [];
  const days = daysBetween(entry.added, entry.end);
  if (days > MAX_DAYS) {
    out.push({ code: CODES.TOO_LONG, message: `${entry.id}: ${entry.added} → ${entry.end} = ${days} gün (en fazla ${MAX_DAYS})` });
  }
  if (entry.added > today) {
    out.push({ code: CODES.FUTURE_DATE, message: `${entry.id}: eklendiği tarih ${entry.added} bugünden (${today} UTC) ileri; karantina eklendiği gün tarihlenir` });
  }
  if (today > entry.end) {
    out.push({ code: CODES.EXPIRED, message: `${entry.id}: bitiş ${entry.end} geçti (bugün ${today} UTC); test düzeltilir ya da kayıt yeniden onaylanır` });
  }
  return out;
}

/**
 * Kayıt satırı `main`'de birebir var mı; değilse açıklama.
 * @param {QuarantineEntry} entry
 * @param {QuarantineState} state
 * @returns {string | null}
 */
export function approvalProblem(entry, state) {
  if (state.main === null) return `${entry.id}: ${state.mainError ?? `${state.mainRef} okunamadı`}; onaylı (birleşmiş) kayıt doğrulanamadı`;
  const m = state.main.entries.get(entry.id);
  if (m === undefined) return `${entry.id}: kayıt ${state.mainRef}'de yok — karantinayı ekleyen PR birleşmemiş (§Onay kaynağı)`;
  const same = m.test === entry.test && m.file === entry.file && m.reason === entry.reason && m.card === entry.card && m.added === entry.added && m.end === entry.end;
  return same ? null : `${entry.id}: kayıt ${state.mainRef}'dekinden farklı — değişiklik birleşmemiş (§Onay kaynağı)`;
}

/**
 * Kapısı değerlendirilen fazların AC kimlikleri (koşullu AC'nin `fallbackPhase`'i dahil; ihtiyatlı).
 * @param {Array<{ id: string, phase: string, fallbackPhase?: string }>} acs
 * @param {Iterable<string>} phases
 * @returns {Set<string>}
 */
export function gateAcIds(acs, phases) {
  const ps = new Set(phases);
  return new Set(acs.filter((a) => ps.has(a.phase) || (a.fallbackPhase !== undefined && ps.has(a.fallbackPhase))).map((a) => a.id));
}

/**
 * Etiketli bir testin (veya describe'ın) bulguları. Süre bulguları (TOO_LONG/EXPIRED) yalnızca
 * `withDates` ise eklenir (`check:tests` onları kayıt satırında bir kez raporlar).
 * @param {{ file: string, title: string, acIds: string[] }} site `acIds`: tam ad + alt testlerdeki AC'ler
 * @param {QuarantineState} state
 * @param {{ gateAcs: Set<string> | null, gateError?: string | null, withDates?: boolean }} gate
 * @returns {QuarantineFinding[]}
 */
export function evaluateSite(site, state, gate) {
  /** @type {QuarantineFinding[]} */
  const out = [];
  const { ids, bare } = quarantineTags(site.title);
  if (bare) out.push({ code: CODES.UNREGISTERED, message: `"${site.title}": kimliksiz @quarantine (biçim: @quarantine Q-xx)` });
  for (const id of ids) {
    const entry = state.registry?.entries.get(id);
    if (entry === undefined) {
      const why = state.registry === null ? `${QUARANTINE_FILE} yok` : `${QUARANTINE_FILE}'de kaydı yok`;
      out.push({ code: CODES.UNREGISTERED, message: `${id}: ${why}` });
      continue;
    }
    if (entry.file !== site.file) {
      out.push({ code: CODES.UNREGISTERED, message: `${id}: kayıt başka dosya için (${entry.file})` });
      continue;
    }
    const approval = approvalProblem(entry, state);
    if (approval !== null) out.push({ code: CODES.NOT_APPROVED, message: approval });
    if (gate.withDates === true) out.push(...entryDateFindings(entry, state.today));
  }
  if (ids.length > 0 || bare) {
    if (gate.gateAcs === null) {
      out.push({ code: CODES.GATE_AC, message: `kapı fazı belirlenemedi (${gate.gateError ?? "bilinmeyen hata"}); kapı AC'si olmadığı doğrulanamadı` });
    } else {
      const hit = site.acIds.filter((id) => gate.gateAcs?.has(id));
      if (hit.length > 0) out.push({ code: CODES.GATE_AC, message: `kapı AC testi karantinaya alınamaz (${hit.join(", ")})` });
    }
  }
  return out;
}

/**
 * Rapor satırı (REPORT_TEMPLATE): `MEVCUT KARANTİNA: n (süresi dolmuş: m)`.
 * @param {QuarantineState} state
 * @returns {{ count: number, expired: number, line: string }}
 */
export function quarantineSummary(state) {
  const entries = [...(state.registry?.entries.values() ?? [])];
  const count = entries.length;
  const expired = entries.filter((e) => state.today > e.end).length;
  const list = entries.map((e) => `${e.id} bitiş ${e.end}`).join(", ");
  return { count, expired, line: `MEVCUT KARANTİNA: ${count} (süresi dolmuş: ${expired})${list === "" ? "" : ` — ${list}`}` };
}
