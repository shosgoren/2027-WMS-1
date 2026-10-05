// `pnpm check:pilot` (T-008f): `docs/PILOT.md` tamlık ve tutarlılık bekçisi.
// Kaynak kural: `docs/PHASES.md §Pilot tanımı` tamlık kuralı; anahtar/enum sözleşmesi
// `docs/tasks/T-006.md`. Tablo ayrıştırma `scripts/lib/pilot.mjs` (fail-closed).
//
// Argüman: `--phase <0|3A>` (varsayılan 0). `3A`: hiçbir satırda `A-xx` kalmamalı.
//
// Neden kodları (dosya alanı `docs/PILOT.md[:satır]`, açıklama anahtarla başlar):
//   PILOT_MISSING                  dosya yok (fail-closed)
//   PILOT_READ_ERROR               dosya okunamadı (ENOENT dışı G/Ç hatası)
//   PILOT_PARSE_ERROR              tablo sözleşmeye uymuyor (başlık, hücre sayısı, yinelenen
//                                  key, birden fazla tablo …; ayrıntı `scripts/lib/pilot.mjs`)
//   PILOT_INCOMPLETE               T-006 anahtarı eksik; Değer boş; Değer'de `…`, `...`, `TBD`,
//                                  `?` veya `/` (seçilmemiş seçenek listesi sayılır — tek değer
//                                  seçilir, ayırıcı gerekiyorsa `,` ya da `>`); Varsayım boş;
//                                  tablo dışındaki metinde `…`, `...`, `TBD`
//   PILOT_INVALID_VALUE            enum dışı Değer; Varsayım `A-\d+`/`DOĞRULANDI`/`SABİT` değil;
//                                  `SABİT` yalnızca warehouse_count=1 ve erp_integration=NONE;
//                                  expiry_tracking=NO ⇒ expiry_fefo/min_shelf_life_days =
//                                  NOT_APPLICABLE; expiry_tracking=YES ⇒ expiry_fefo YES|NO ve
//                                  min_shelf_life_days negatif olmayan tam sayı
//   PILOT_UNKNOWN_KEY              T-006 listesinde olmayan key (yazım hatası sessiz geçmez)
//   PILOT_ASSUMPTION_UNREGISTERED  `A-xx`, `docs/OPEN_QUESTIONS.md`'de `A-xx | …` satırı olarak yok
//   PILOT_EXPIRY_WITHOUT_LOT       expiry_tracking=YES ama hiçbir tracking_mode.* LOT/LOT_AND_SERIAL değil
//   PILOT_ADR011_NOT_ACCEPTED      handling_unit_mode TRACKED/MIXED ama DECISIONS'ta ADR-011 "kabul" değil
//   PILOT_UNVERIFIED_ASSUMPTION    `--phase 3A` ve satırda hâlâ `A-xx` var
import { readFileSync } from "node:fs";
import path from "node:path";
import { findMarkdownTables, MarkdownTableError, parsePilotTable, PILOT_PATH, pilotEnumFor, pilotRowsFor, splitMarkdownRow } from "../lib/pilot.mjs";
import { UsageError } from "./lib/output.mjs";
import { acceptedDecisionIds, DECISIONS } from "./protected-paths.mjs";

/** @typedef {import("../lib/pilot.mjs").PilotRow} PilotRow */
/** @typedef {import("./cli.mjs").GuardContext} GuardContext */
/** @typedef {import("./lib/output.mjs").Reporter} Reporter */

export const OPEN_QUESTIONS = "docs/OPEN_QUESTIONS.md";

/** T-006 Yapılacaklar 1: sabit anahtar listesi (`tracking_mode.*` grup başına bir satır, en az bir). */
export const PILOT_KEYS = Object.freeze([
  "sector",
  "customer_code",
  "warehouse_count",
  "location_count",
  "location_depth",
  "active_sku_count",
  "tracking_mode.*",
  "expiry_tracking",
  "expiry_fefo",
  "min_shelf_life_days",
  "handling_unit_mode",
  "partial_case_opening",
  "stock_owner",
  "current_system",
  "opening_stock_source",
  "daily_receipt_lines",
  "daily_order_lines",
  "daily_shipment_lines",
  "users_by_role",
  "devices",
  "label_printer",
  "offline_required",
  "erp_integration",
  "base_units",
  "quantity_decimals",
  "success.unexplained_count_diff_max",
  "success.unassisted_tasks_per_week_max",
]);

/** `SABİT` Varsayımına izin verilen anahtar → zorunlu değer (PHASES'in sabitledikleri). */
export const FIXED_VALUES = Object.freeze(/** @type {Record<string, string>} */ ({ warehouse_count: "1", erp_integration: "NONE" }));

export const PHASES = /** @type {const} */ (["0", "3A"]);

const NA = "NOT_APPLICABLE";
const ASSUMPTION_RE = /^A-\d+$/;
const VERIFIED = "DOĞRULANDI";
const FIXED = "SABİT";
const GROUP_KEY_RE = /^tracking_mode\.[A-Za-z0-9_]+$/;

/**
 * @param {string[]} argv
 * @returns {{ phase: (typeof PHASES)[number] }}
 */
export function parsePilotArgs(argv) {
  /** @type {string | null} */
  let phase = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") continue;
    const m = /^--phase(?:=(.*))?$/.exec(a);
    if (m === null) throw new UsageError(`bilinmeyen argüman "${a}"`);
    const v = m[1] ?? argv[++i];
    if (v === undefined || v === "") throw new UsageError("--phase bir değer ister");
    if (phase !== null) throw new UsageError("--phase birden fazla verildi");
    phase = v;
  }
  if (phase === null) return { phase: "0" };
  if (!(/** @type {readonly string[]} */ (PHASES).includes(phase))) {
    throw new UsageError(`--phase "${phase}" desteklenmiyor (${PHASES.join(" | ")})`);
  }
  return { phase: /** @type {(typeof PHASES)[number]} */ (phase) };
}

/**
 * Değerde tamamlanmamışlık işareti (yoksa `null`).
 * @param {string} value
 * @returns {string | null}
 */
export function placeholderIn(value) {
  if (value.trim() === "") return "boş";
  if (value.includes("…")) return "`…` içeriyor";
  if (value.includes("...")) return "`...` içeriyor";
  if (/(?<![\p{L}\p{N}])TBD(?![\p{L}\p{N}])/iu.test(value)) return "`TBD` içeriyor";
  if (value.includes("?")) return "`?` içeriyor";
  if (value.includes("/")) return "`/` ile ayrılmış seçilmemiş seçenek listesi (tek değer seçin; ayırıcı için `,` veya `>`)";
  return null;
}

/**
 * Anahtar T-006 listesinde mi?
 * @param {string} key
 * @returns {boolean}
 */
export function isKnownKey(key) {
  return GROUP_KEY_RE.test(key) || (PILOT_KEYS.includes(key) && !key.endsWith(".*"));
}

/**
 * OPEN_QUESTIONS.md'de tanımlı varsayım kimlikleri (`A-xx | varsayım | …` satırları).
 * @param {string | null} text
 * @returns {Set<string>}
 */
export function registeredAssumptions(text) {
  /** @type {Set<string>} */
  const ids = new Set();
  if (text === null) return ids;
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*\|?\s*(A-\d+)\s*\|/.exec(l);
    if (m) ids.add(/** @type {string} */ (m[1]));
  }
  return ids;
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string | null} dosya yoksa `null`
 */
function readOptional(root, rel) {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * @param {number} line
 * @returns {string}
 */
function at(line) {
  return `${PILOT_PATH}:${line}`;
}

/**
 * Ayrıştırılmış PILOT tablosunu ve metni denetler; bulguları `out`'a yazar.
 * @param {{ text: string, rows: Map<string, PilotRow>, phase: (typeof PHASES)[number], openQuestions: string | null, decisions: string | null, out: Reporter }} input
 */
export function checkPilot({ text, rows, phase, openQuestions, decisions, out }) {
  // Tablo dışı metin: `…`, `...`, `TBD` (PHASES tamlık kuralı dosyanın tamamı için).
  const tableLines = new Set(findMarkdownTables(text).flatMap((t) => t.rows.map((r) => r.line)));
  text.split(/\r?\n/).forEach((l, i) => {
    if (tableLines.has(i + 1)) return;
    if (l.includes("…") || l.includes("...") || /(?<![\p{L}\p{N}])TBD(?![\p{L}\p{N}])/iu.test(l)) {
      out.fail("PILOT_INCOMPLETE", at(i + 1), "tablo dışı metin: `…`, `...` veya `TBD` kalmış");
    }
  });

  // Anahtar varlığı ve bilinmeyen anahtar.
  for (const key of PILOT_KEYS) {
    if (pilotRowsFor(rows, key).length === 0) out.fail("PILOT_INCOMPLETE", PILOT_PATH, `${key}: T-006 anahtarı eksik`);
  }
  for (const r of rows.values()) {
    if (!isKnownKey(r.key)) out.fail("PILOT_UNKNOWN_KEY", at(r.line), `${r.key}: T-006 listesinde yok (yazım hatası?)`);
  }

  // Satır bazında: değer tamlığı, enum, Varsayım sütunu.
  const registered = registeredAssumptions(openQuestions);
  for (const r of rows.values()) {
    const ph = placeholderIn(r.value);
    if (ph !== null) {
      out.fail("PILOT_INCOMPLETE", at(r.line), `${r.key}: Değer ${ph}`);
    } else {
      const allowed = pilotEnumFor(r.key);
      if (allowed !== null && !allowed.includes(r.value)) {
        out.fail("PILOT_INVALID_VALUE", at(r.line), `${r.key}: "${r.value}" geçersiz (${allowed.join(" | ")})`);
      }
    }

    const a = r.assumption;
    if (a === "") {
      out.fail("PILOT_INCOMPLETE", at(r.line), `${r.key}: Varsayım boş (A-xx, ${VERIFIED} veya ${FIXED})`);
    } else if (ASSUMPTION_RE.test(a)) {
      if (!registered.has(a)) {
        out.fail("PILOT_ASSUMPTION_UNREGISTERED", at(r.line), `${r.key}: ${a} ${OPEN_QUESTIONS}'de tanımlı değil`);
      }
      if (phase === "3A") {
        out.fail("PILOT_UNVERIFIED_ASSUMPTION", at(r.line), `${r.key}: ${a} doğrulanmamış; Faz 3A kapısı doğrulanmamış A-xx ile kapanmaz`);
      }
    } else if (a === FIXED) {
      const fixed = Object.hasOwn(FIXED_VALUES, r.key) ? FIXED_VALUES[r.key] : undefined;
      if (fixed === undefined) {
        out.fail("PILOT_INVALID_VALUE", at(r.line), `${r.key}: ${FIXED} yalnızca ${Object.keys(FIXED_VALUES).join(", ")} için`);
      } else if (r.value !== fixed) {
        out.fail("PILOT_INVALID_VALUE", at(r.line), `${r.key}: ${FIXED} değer "${fixed}" olmalı, "${r.value}" bulundu`);
      }
    } else if (a !== VERIFIED) {
      out.fail("PILOT_INVALID_VALUE", at(r.line), `${r.key}: Varsayım "${a}" geçersiz (A-\\d+, ${VERIFIED} veya ${FIXED})`);
    }
  }

  // Tutarlılık.
  const value = (/** @type {string} */ key) => rows.get(key)?.value;
  const expiry = rows.get("expiry_tracking");
  if (expiry?.value === "YES") {
    const lot = pilotRowsFor(rows, "tracking_mode.*").some((r) => r.value === "LOT" || r.value === "LOT_AND_SERIAL");
    if (!lot) {
      out.fail("PILOT_EXPIRY_WITHOUT_LOT", at(expiry.line), "expiry_tracking: YES ama hiçbir tracking_mode.* LOT/LOT_AND_SERIAL değil (SKT lotta tutulur)");
    }
    const fefo = rows.get("expiry_fefo");
    if (fefo && fefo.value === NA) {
      out.fail("PILOT_INVALID_VALUE", at(fefo.line), `expiry_fefo: expiry_tracking=YES iken ${NA} olamaz (YES | NO)`);
    }
    const shelf = rows.get("min_shelf_life_days");
    if (shelf && placeholderIn(shelf.value) === null && !/^\d+$/.test(shelf.value)) {
      out.fail("PILOT_INVALID_VALUE", at(shelf.line), `min_shelf_life_days: expiry_tracking=YES iken negatif olmayan tam sayı (gün) olmalı, "${shelf.value}" bulundu`);
    }
  } else if (expiry?.value === "NO") {
    for (const key of ["expiry_fefo", "min_shelf_life_days"]) {
      const r = rows.get(key);
      if (r && r.value !== NA && placeholderIn(r.value) === null) {
        out.fail("PILOT_INVALID_VALUE", at(r.line), `${key}: expiry_tracking=NO iken ${NA} olmalı, "${r.value}" bulundu`);
      }
    }
  }
  const hu = value("handling_unit_mode");
  if (hu === "TRACKED" || hu === "MIXED") {
    const accepted = acceptedDecisionIds(decisions).has("ADR-011");
    out.detail("adr011Accepted", accepted);
    if (!accepted) {
      const line = rows.get("handling_unit_mode")?.line ?? 1;
      out.fail("PILOT_ADR011_NOT_ACCEPTED", at(line), `handling_unit_mode: ${hu} için ${DECISIONS}'de ADR-011 durumu "kabul" olmalı`);
    }
  }
}

/**
 * @param {GuardContext} ctx
 */
export function run(ctx) {
  const { out } = ctx;
  const { phase } = parsePilotArgs(ctx.argv);
  out.detail("phase", phase);

  /** @type {string | null} */
  let text;
  try {
    text = readOptional(ctx.root, PILOT_PATH);
  } catch (e) {
    out.fail("PILOT_READ_ERROR", PILOT_PATH, `okunamadı: ${/** @type {Error} */ (e).message}`);
    return;
  }
  if (text === null) {
    out.fail("PILOT_MISSING", PILOT_PATH, "dosya yok (T-006; PHASES §Pilot tanımı tamlık kuralı)");
    return;
  }

  /** @type {Map<string, PilotRow>} */
  let rows;
  try {
    rows = parsePilotTable(text, PILOT_PATH);
  } catch (e) {
    if (!(e instanceof MarkdownTableError)) throw e;
    // Ayrıştırıcı boş Değer'i de reddeder; o durum tamlık bulgusudur.
    const cells = splitMarkdownRow(text.split(/\r?\n/)[e.line - 1] ?? "");
    if (cells !== null && cells.length === 4 && cells[2] === "") {
      out.fail("PILOT_INCOMPLETE", at(e.line), `${cells[0]}: Değer boş`);
    } else {
      out.fail("PILOT_PARSE_ERROR", at(e.line), e.message);
    }
    return;
  }
  out.detail("keys", [...rows.keys()]);

  checkPilot({
    text,
    rows,
    phase,
    openQuestions: readOptional(ctx.root, OPEN_QUESTIONS),
    decisions: readOptional(ctx.root, DECISIONS),
    out,
  });
}
