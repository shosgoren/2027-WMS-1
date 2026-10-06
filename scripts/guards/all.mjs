// `pnpm check:all` (T-008g; PROTOCOL §3b): beş bekçiyi sırayla, ilk hatada durmadan koşar ve
// ardından belge denetimini (`scripts/check-docs.mjs`, T-004) ekler. Tek özet satırı:
//   check:all → scope OK | tests OK | ac-ratchet OK | protected OK | assertions OK | docs OK
// Biri FAIL ise çıkış 1. `check:pilot` buraya girmez (T-006 kullanıcı eylemi beklerken her PR'ı
// kilitlemesin); CI'da ayrı iş olarak koşar.
//   --local   yalnızca `check:protected`'a geçer (commit öncesi kanca: API yok, korunan değişiklik
//             uyarıdır). Diğer bekçiler her kipte aynıdır.
// Denetlenen kök `cli.mjs --root` ile verilir; belge denetimi de aynı köke karşı koşar.
//
// Tabanda bulunmayan bekçi (Supervisor kararı, T-008g bulgu 1–2): CI bekçiyi TABANIN kodundan
// koşar. Tabanda modül dosyası yoksa (ör. bekçiyi tanıtan paket henüz main'e girmemiş) bekçi
// FAIL değil `SKIPPED_NOT_IN_BASE` olarak raporlanır (özet: `<ad> SKIPPED(base)`) ve PR'ın
// kopyasından ASLA koşturulmaz. Gerekçe: yeni bekçi dosyası korunan yoldur; onu tanıtan PR,
// tabandan koşan `check:protected` onayından geçer ve ilk birleşmeden sonra tabandan koşar.
// İstisna yok: güven kökü bekçileri (`scope`, `tests`, `protected`) tabanda yoksa FAIL
// (`GUARD_NOT_IN_BASE`); onlarsız onay ve kapsam denetlenemez.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkMap, checkStack, checkStackCoverage, summaryLine } from "../check-docs.mjs";
import { UsageError } from "./lib/output.mjs";

/** Sıra PROTOCOL §3b ve REPORT_TEMPLATE özet satırıyla aynıdır. */
export const ALL_GUARDS = /** @type {const} */ (["scope", "tests", "ac-ratchet", "protected", "assertions"]);

/** Tabanda yoksa atlanamayan bekçiler (güven kökü). */
export const TRUST_ROOT_GUARDS = /** @type {const} */ (["scope", "tests", "protected"]);

/**
 * @typedef {{ name: string, ok: boolean, skipped?: boolean, exitCode: number | null, error?: string }} StepResult
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
  // T-008k: `check-docs.mjs main()` ile aynı: sürüm denetimi + doğrudan bağımlılık kapsamı (kilit dosyası yoksa FAIL).
  const versions = stackMd === null ? { ok: false, count: 0, failures: ["stack: docs/STACK.md okunamadı"] } : checkStack(stackMd, readFile);
  const coverage = stackMd === null ? { ok: false, count: 0, failures: [] } : checkStackCoverage(stackMd, readFile);
  const stack = {
    ok: versions.ok && coverage.ok,
    count: versions.count,
    failures: [...versions.failures, ...coverage.failures],
  };
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
  return `check:all → ${steps.map((s) => `${s.name} ${s.skipped ? "SKIPPED(base)" : s.ok ? "OK" : "FAIL"}`).join(" | ")}`;
}

/**
 * @param {{ root: string, argv: string[], log: (line: string) => void, runGuard: RunGuard, hasGuard: (guard: string) => boolean, docs?: (root: string, log: (line: string) => void) => boolean }} opts
 * @returns {Promise<number>} 0 = hepsi OK, 1 = en az biri FAIL
 */
export async function runAll(opts) {
  const { root, log, runGuard } = opts;
  const docs = opts.docs ?? checkDocs;
  const { local } = parseAllArgs(opts.argv);
  /** @type {StepResult[]} */
  const steps = [];
  for (const g of ALL_GUARDS) {
    if (!opts.hasGuard(g)) {
      if (/** @type {readonly string[]} */ (TRUST_ROOT_GUARDS).includes(g)) {
        log(`[check:${g}] FAIL GUARD_NOT_IN_BASE - — çalıştırılan bekçi kopyasında ${g}.mjs yok; güven kökü bekçisi atlanamaz`);
        steps.push({ name: g, ok: false, exitCode: null, error: "GUARD_NOT_IN_BASE" });
      } else {
        log(`[check:${g}] SKIPPED_NOT_IN_BASE ${g} — çalıştırılan (taban) bekçi kopyasında ${g}.mjs yok; PR'ın kopyası koşturulmaz, ilk birleşmeden sonra tabandan koşar`);
        steps.push({ name: g, ok: true, skipped: true, exitCode: null });
      }
      continue;
    }
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
