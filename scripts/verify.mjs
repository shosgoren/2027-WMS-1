#!/usr/bin/env node
// `pnpm verify`: lint → typecheck → unit sırayla koşar.
// Tam çıktı `.artifacts/verify/<adım>.log`; konsola yalnızca ilk 10 hata + tek özet satırı.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Konsola basılacak azami hata sayısı. */
export const MAX_ERRORS = 10;

/**
 * @typedef {{ file: string, line: number | null, message: string }} VerifyError
 * @typedef {"lint" | "typecheck" | "unit"} StepName
 * @typedef {{ step: StepName, ok: boolean, errors: VerifyError[], testCount?: number }} StepResult
 * @typedef {{ filePath?: unknown, messages?: Array<{ severity?: unknown, line?: unknown, message?: unknown, ruleId?: unknown }> }} EslintFileResult
 * @typedef {{ status?: unknown, fullName?: unknown, failureMessages?: unknown[] | null, location?: { line?: unknown } | null }} VitestAssertion
 * @typedef {{ name?: unknown, status?: unknown, message?: unknown, assertionResults?: VitestAssertion[] }} VitestFileResult
 * @typedef {{ numTotalTests?: unknown, success?: unknown, testResults?: VitestFileResult[] }} VitestReport
 */

/**
 * @param {VerifyError} e
 * @returns {string}
 */
export function formatError(e) {
  const loc = e.line === null ? e.file : `${e.file}:${e.line}`;
  return `${loc} ${e.message}`;
}

/**
 * Adım sonuçlarını konsol çıktısına çevirir: ilk `max` hata (dosya:satır + mesaj),
 * kesilen hata sayısı ve tek özet satırı.
 * @param {StepResult[]} results
 * @param {number} [max]
 * @returns {{ lines: string[], summary: string, ok: boolean }}
 */
export function summarize(results, max = MAX_ERRORS) {
  /** @type {string[]} */
  const lines = [];
  const all = results.flatMap((r) => r.errors.map((e) => `[${r.step}] ${formatError(e)}`));
  lines.push(...all.slice(0, max));
  if (all.length > max) {
    lines.push(`… ${all.length - max} hata daha (bkz. .artifacts/verify/*.log)`);
  }
  const parts = results.map((r) => {
    const status = r.ok ? "OK" : "FAIL";
    return r.step === "unit" ? `unit ${status} (${r.testCount ?? 0} test)` : `${r.step} ${status}`;
  });
  const summary = `verify: ${parts.join(" · ")}`;
  lines.push(summary);
  return { lines, summary, ok: results.length > 0 && results.every((r) => r.ok) };
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function rel(root, file) {
  return path.isAbsolute(file) ? path.relative(root, file) : file;
}

/**
 * ESLint `-f json` çıktısını hatalara çevirir (`--max-warnings=0` olduğundan uyarılar da
 * adımı düşürür ve listelenir). Çözümlenemezse `null`.
 * @param {string} json
 * @param {string} root
 * @returns {VerifyError[] | null}
 */
export function parseEslintJson(json, root) {
  /** @type {EslintFileResult[]} */
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  /** @type {VerifyError[]} */
  const errors = [];
  for (const result of data) {
    for (const m of result.messages ?? []) {
      if (m.severity !== 1 && m.severity !== 2) continue;
      const text = m.ruleId ? `${String(m.message)} (${String(m.ruleId)})` : String(m.message);
      errors.push({
        file: rel(root, String(result.filePath)),
        line: typeof m.line === "number" ? m.line : null,
        message: m.severity === 1 ? `uyarı: ${text}` : text,
      });
    }
  }
  return errors;
}

/**
 * `tsc --pretty false` ve `pnpm -r run typecheck` çıktısındaki
 * `dosya(satır,sütun): error TSxxxx: mesaj` satırlarını hatalara çevirir.
 * @param {string} text
 * @param {string} root
 * @returns {VerifyError[]}
 */
export function parseTscOutput(text, root) {
  /** @type {VerifyError[]} */
  const errors = [];
  const re = /^(?:\S+ typecheck: )?(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    const [, file = "", line = "", code = "", message = ""] = m;
    errors.push({ file: rel(root, file), line: Number(line), message: `${code}: ${message}` });
  }
  return errors;
}

/**
 * Vitest JSON raporunu hatalara ve test sayısına çevirir. Çözümlenemezse `null`.
 * @param {string} json
 * @param {string} root
 * @returns {{ errors: VerifyError[], testCount: number, success: boolean } | null}
 */
export function parseVitestJson(json, root) {
  /** @type {VitestReport | null} */
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || typeof data.numTotalTests !== "number") return null;
  /** @type {VerifyError[]} */
  const errors = [];
  for (const file of Array.isArray(data.testResults) ? data.testResults : []) {
    const name = rel(root, String(file.name));
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    const failed = assertions.filter((a) => a.status === "failed");
    for (const a of failed) {
      const first = String((a.failureMessages ?? [])[0] ?? "").split("\n")[0] ?? "";
      errors.push({
        file: name,
        line: typeof a.location?.line === "number" ? a.location.line : null,
        message: `${a.fullName}: ${first}`,
      });
    }
    if (file.status === "failed" && failed.length === 0) {
      const msg = String(file.message || "test dosyası başarısız").split("\n")[0] ?? "";
      errors.push({ file: name, line: null, message: msg });
    }
  }
  return { errors, testCount: data.numTotalTests, success: data.success === true };
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ command: string, status: number, stdout: string, stderr: string }}
 */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const spawnError = r.error ? `\n[spawn hatası] ${r.error.message}` : "";
  return {
    command: [cmd, ...args].join(" "),
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: (r.stderr ?? "") + spawnError,
  };
}

/**
 * @param {string} logDir
 * @param {StepName} step
 * @param {Array<ReturnType<typeof run>>} runs
 * @param {VerifyError[]} errors
 */
function writeLog(logDir, step, runs, errors) {
  const body = [
    ...runs.map((r) => `$ ${r.command}\n[çıkış ${r.status}]\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`),
    `--- ${errors.length} hata ---`,
    ...errors.map(formatError),
    "",
  ].join("\n");
  writeFileSync(path.join(logDir, `${step}.log`), body);
}

/**
 * @param {string} root
 * @param {string} logDir
 * @returns {StepResult}
 */
function lint(root, logDir) {
  const r = run(path.join(root, "node_modules/.bin/eslint"), ["--max-warnings=0", "-f", "json", "."], root);
  const parsed = parseEslintJson(r.stdout, root);
  const errors = parsed ?? [{ file: "eslint", line: null, message: `çıktı çözümlenemedi (çıkış ${r.status}), bkz. .artifacts/verify/lint.log` }];
  if (r.status !== 0 && errors.length === 0) {
    errors.push({ file: "eslint", line: null, message: `çıkış ${r.status}, bkz. .artifacts/verify/lint.log` });
  }
  writeLog(logDir, "lint", [r], errors);
  return { step: "lint", ok: r.status === 0 && errors.length === 0, errors };
}

/**
 * @param {string} root
 * @param {string} logDir
 * @returns {StepResult}
 */
function typecheck(root, logDir) {
  const tsc = run(path.join(root, "node_modules/.bin/tsc"), ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"], root);
  const ws = run("pnpm", ["-r", "--if-present", "run", "typecheck"], root);
  const errors = [...parseTscOutput(tsc.stdout + tsc.stderr, root), ...parseTscOutput(ws.stdout + ws.stderr, root)];
  if (errors.length === 0) {
    for (const [label, r] of /** @type {const} */ ([["tsc", tsc], ["pnpm -r typecheck", ws]])) {
      if (r.status !== 0) {
        errors.push({ file: label, line: null, message: `çıkış ${r.status}, bkz. .artifacts/verify/typecheck.log` });
      }
    }
  }
  writeLog(logDir, "typecheck", [tsc, ws], errors);
  return { step: "typecheck", ok: tsc.status === 0 && ws.status === 0 && errors.length === 0, errors };
}

/**
 * @param {string} root
 * @param {string} logDir
 * @returns {StepResult}
 */
function unit(root, logDir) {
  const jsonFile = path.join(logDir, "unit.json");
  rmSync(jsonFile, { force: true });
  const r = run(
    path.join(root, "node_modules/.bin/vitest"),
    ["run", "--reporter=default", "--reporter=json", `--outputFile.json=${jsonFile}`],
    root,
  );
  let json = "";
  try {
    json = readFileSync(jsonFile, "utf8");
  } catch {
    // Rapor dosyası yoksa `parseVitestJson` null döner ve adım FAIL olur.
  }
  const parsed = parseVitestJson(json, root);
  const errors = parsed?.errors ?? [];
  if (!parsed) {
    errors.push({ file: "vitest", line: null, message: `JSON raporu okunamadı (çıkış ${r.status}), bkz. .artifacts/verify/unit.log` });
  } else if (r.status !== 0 && errors.length === 0) {
    errors.push({ file: "vitest", line: null, message: `çıkış ${r.status}, bkz. .artifacts/verify/unit.log` });
  }
  const testCount = parsed?.testCount ?? 0;
  const ok = r.status === 0 && parsed !== null && parsed.success && errors.length === 0 && testCount > 0;
  if (!ok && errors.length === 0) {
    const message = testCount === 0 ? "hiç unit test bulunamadı" : "vitest başarısız raporladı, bkz. .artifacts/verify/unit.log";
    errors.push({ file: "vitest", line: null, message });
  }
  writeLog(logDir, "unit", [r], errors);
  return { step: "unit", ok, errors, testCount };
}

/** @returns {number} çıkış kodu */
export function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const logDir = path.join(root, ".artifacts", "verify");
  mkdirSync(logDir, { recursive: true });
  const results = [lint(root, logDir), typecheck(root, logDir), unit(root, logDir)];
  const { lines, ok } = summarize(results);
  for (const l of lines) console.log(l);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
