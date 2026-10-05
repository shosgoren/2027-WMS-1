// `pnpm check:all` (T-008g; PROTOCOL §3b): beş bekçiyi sırayla, ilk hatada durmadan koşar ve
// ardından belge denetimini (`scripts/check-docs.mjs`, T-004) ekler. Tek özet satırı:
//   check:all → scope OK | tests OK | ac-ratchet OK | protected OK | assertions OK | docs OK
// Biri FAIL ise çıkış 1. `check:pilot` buraya girmez (T-006 kullanıcı eylemi beklerken her PR'ı
// kilitlemesin); CI'da ayrı iş olarak koşar.
//   --local   yalnızca `check:protected`'a geçer (commit öncesi kanca: API yok, korunan değişiklik
//             uyarıdır). Diğer bekçiler her kipte aynıdır.
// Denetlenen kök `cli.mjs --root` ile verilir; belge denetimi de aynı köke karşı koşar.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkMap, checkStack, summaryLine } from "../check-docs.mjs";
import { UsageError } from "./lib/output.mjs";

/** Sıra PROTOCOL §3b ve REPORT_TEMPLATE özet satırıyla aynıdır. */
export const ALL_GUARDS = /** @type {const} */ (["scope", "tests", "ac-ratchet", "protected", "assertions"]);

/**
 * @typedef {{ name: string, ok: boolean, exitCode: number | null, error?: string }} StepResult
 * @typedef {(guard: string, args: string[]) => Promise<number>} RunGuard
 */

/**
 * @param {string[]} argv
 * @returns {{ local: boolean }}
 */
export function parseAllArgs(argv) {
  let local = false;
  for (const a of argv) {
    if (a === "--") continue;
    if (a === "--local") {
      if (local) throw new UsageError("--local birden fazla verildi");
      local = true;
      continue;
    }
    throw new UsageError(`bilinmeyen argüman "${a}" (yalnızca --local)`);
  }
  return { local };
}

/**
 * `check-docs.mjs` `main()` mantığı, verilen köke karşı (onun kökü betiğin konumuna sabittir).
 * @param {string} root
 * @param {(line: string) => void} log
 * @returns {boolean}
 */
export function checkDocs(root, log) {
  /** @param {string} rel @returns {string | null} */
  const readFile = (rel) => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const stackMd = readFile("docs/STACK.md");
  const mapMd = readFile("docs/MAP.md");
  const stack = stackMd === null ? { ok: false, count: 0, failures: ["stack: docs/STACK.md okunamadı"] } : checkStack(stackMd, readFile);
  const map =
    mapMd === null
      ? { ok: false, count: 0, failures: ["map: docs/MAP.md okunamadı"] }
      : checkMap(mapMd, (rel) => existsSync(path.join(root, rel)));
  for (const f of [...stack.failures, ...map.failures]) log(f);
  log(summaryLine(stack, map));
  return stack.ok && map.ok;
}

/**
 * @param {StepResult[]} steps
 * @returns {string}
 */
export function formatAllSummary(steps) {
  return `check:all → ${steps.map((s) => `${s.name} ${s.ok ? "OK" : "FAIL"}`).join(" | ")}`;
}

/**
 * @param {{ root: string, argv: string[], log: (line: string) => void, runGuard: RunGuard, docs?: (root: string, log: (line: string) => void) => boolean }} opts
 * @returns {Promise<number>} 0 = hepsi OK, 1 = en az biri FAIL
 */
export async function runAll(opts) {
  const { root, log, runGuard } = opts;
  const docs = opts.docs ?? checkDocs;
  const { local } = parseAllArgs(opts.argv);
  /** @type {StepResult[]} */
  const steps = [];
  for (const g of ALL_GUARDS) {
    const args = g === "protected" && local ? ["--local"] : [];
    try {
      const code = await runGuard(g, args);
      steps.push({ name: g, ok: code === 0, exitCode: code });
    } catch (e) {
      // Bir bekçinin çökmesi diğerlerini durdurmaz; çöken bekçi FAIL sayılır (fail-closed).
      const msg = e instanceof Error ? e.message : String(e);
      log(`[check:${g}] FAIL GUARD_CRASHED - — ${msg}`);
      steps.push({ name: g, ok: false, exitCode: null, error: msg });
    }
  }
  try {
    steps.push({ name: "docs", ok: docs(root, log), exitCode: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`check-docs: FAIL (${msg})`);
    steps.push({ name: "docs", ok: false, exitCode: null, error: msg });
  }
  const ok = steps.every((s) => s.ok);
  const dir = path.join(root, ".artifacts", "guards");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "all.json"), `${JSON.stringify({ guard: "all", ok, local, steps }, null, 2)}\n`);
  log(formatAllSummary(steps));
  return ok ? 0 : 1;
}
