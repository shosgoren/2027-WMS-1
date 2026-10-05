// Bekçilerin ortak çıktı biçimi (T-008a). Tek biçim:
//   [check:<ad>] FAIL <NEDEN_KODU> <dosya> — <açıklama>
//   [check:<ad>] WARN <NEDEN_KODU> <dosya> — <açıklama>   (çıkış kodunu etkilemez)
//   check:<ad> OK | check:<ad> FAIL (n)                    (son satır, özet)
// Ayrıntı: `.artifacts/guards/<ad>.json`.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Bekçi argümanı hatalı: CLI kullanım mesajı basar, çıkış 2. */
export class UsageError extends Error {}

/** Bir dosyaya bağlanamayan bulgularda dosya alanı. */
export const NO_FILE = "-";

/**
 * @typedef {{ level: "FAIL" | "WARN", code: string, file: string, message: string }} Finding
 * @typedef {{ guard: string, ok: boolean, failures: Finding[], warnings: Finding[], details: Record<string, unknown> }} GuardReport
 */

/**
 * @param {string} guard
 * @param {Finding} f
 * @returns {string}
 */
export function formatFinding(guard, f) {
  const file = f.file === "" ? NO_FILE : f.file;
  return `[check:${guard}] ${f.level} ${f.code} ${file} — ${f.message}`;
}

/**
 * @param {string} guard
 * @param {number} failCount
 * @returns {string}
 */
export function formatSummary(guard, failCount) {
  return failCount === 0 ? `check:${guard} OK` : `check:${guard} FAIL (${failCount})`;
}

/**
 * Bekçi raporlayıcısı: bulguları toplar, `finish` ile konsola + JSON'a yazar.
 * @param {string} guard bekçi adı (`scope`, `tests`, …)
 * @param {{ root: string, log?: (line: string) => void }} opts
 */
export function createReporter(guard, opts) {
  if (!/^[a-z][a-z0-9-]*$/.test(guard)) throw new Error(`geçersiz bekçi adı: ${guard}`);
  const log = opts.log ?? ((/** @type {string} */ l) => console.log(l));
  /** @type {Finding[]} */
  const failures = [];
  /** @type {Finding[]} */
  const warnings = [];
  /** @type {Record<string, unknown>} */
  const details = {};
  let finished = false;

  return {
    guard,
    /**
     * @param {string} code BÜYÜK_HARF neden kodu
     * @param {string} file
     * @param {string} message
     */
    fail(code, file, message) {
      failures.push({ level: "FAIL", code, file, message });
    },
    /**
     * @param {string} code
     * @param {string} file
     * @param {string} message
     */
    warn(code, file, message) {
      warnings.push({ level: "WARN", code, file, message });
    },
    /**
     * JSON ayrıntısına ek alan.
     * @param {string} key
     * @param {unknown} value
     */
    detail(key, value) {
      details[key] = value;
    },
    get failCount() {
      return failures.length;
    },
    /**
     * Bulguları basar, `.artifacts/guards/<ad>.json` yazar, çıkış kodunu döner (0 | 1).
     * @returns {number}
     */
    finish() {
      if (finished) throw new Error(`check:${guard} raporu iki kez bitirildi`);
      finished = true;
      for (const f of failures) log(formatFinding(guard, f));
      for (const w of warnings) log(formatFinding(guard, w));
      /** @type {GuardReport} */
      const report = { guard, ok: failures.length === 0, failures, warnings, details };
      const dir = path.join(opts.root, ".artifacts", "guards");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${guard}.json`), JSON.stringify(report, null, 2) + "\n");
      log(formatSummary(guard, failures.length));
      return report.ok ? 0 : 1;
    },
  };
}

/** @typedef {ReturnType<typeof createReporter>} Reporter */
