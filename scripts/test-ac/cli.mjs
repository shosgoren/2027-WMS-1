#!/usr/bin/env node
// `pnpm test:ac` — faz kapısı koşturucusu (T-007).
//   pnpm test:ac --phase <N>   kapı modu: fazın tüm AC'leri; etiketli testi olmayan AC = hata
//   pnpm test:ac -- AC-05 …    yalnızca verilen AC'ler (koşuldan bağımsız koşar)
//   pnpm test:ac --ci          PR modu: mevcut her @AC testi koşar ve geçmeli; NO_TEST yalnızca
//                              `passedGates` fazlarında hata, diğerlerinde bilgi
//   pnpm test:ac               = --phase <currentGatePhase>
//   --root <dizin>             denetlenen depo kökü (T-008g; CI: tabanın koşturucusu PR dizinine
//                              karşı, `node base/scripts/test-ac/cli.mjs --ci --root pr/`). Vitest
//                              ikilisi bu kökün `node_modules/.bin/vitest`'idir (testler oradaki
//                              `vitest`'i içe aktarır; iki kopya karışmasın).
//   --out <dizin>              JSON raporu + vitest çıktıları buraya (T-008g; CI: `$RUNNER_TEMP/test-ac`,
//                              PR ağacının içi değil). Varsayılan `<kök>/.artifacts/test-ac`.
// --ci ek denetimi (T-008g; bekciler-1 3. inceleme MINOR 1): çalışma anı atlama denetimi. Birim
// test takımının tamamı (`-t` süzgeci olmadan, kökün vitest yapılandırmasıyla) JSON raporuyla
// koşar; `skipped`/`todo`/`pending` durumlu her test HATA `RUNTIME_SKIP` (statik `check:tests`'in
// kaçırdığı `Reflect.get(it, "skip")`, `ctx.skip()`, dinamik `.only` biçimleri). Karantinalı test
// atlanmaz, koşar (PROTOCOL §Karantina kuralı) — bu yüzden atlama sayımında karantina istisnası
// yoktur; karantinalı testin başarısızlığı bu denetimde zaten sayılmaz (yalnızca atlama sayılır).
// Konsol: AC başına tek satır + özet. Ayrıntı: `<out>/<faz|ci|ids>.json`.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPhase, loadAcceptance, PHASES } from "./acceptance.mjs";
import { collectTags, groupById } from "./collect.mjs";
import { loadConditions } from "./conditions.mjs";
import { execute, formatResult, parseVitestReport, plan, reportMismatch, spawnIsolated, summarizeResults } from "./run.mjs";
import { loadPilot } from "../lib/pilot.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = "kullanım: pnpm test:ac [--phase <N> | --ci | -- AC-xx [AC-yy …]] [--root <dizin>] [--out <dizin>]";

/**
 * @typedef {import("./run.mjs").Mode} Mode
 * @typedef {{ phase: string | null, ci: boolean, ids: string[], root?: string, out?: string }} Args
 */

export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {Args} */
  const args = { phase: null, ci: false, ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") continue;
    if (a === "--ci") {
      args.ci = true;
    } else if (a === "--phase" || a.startsWith("--phase=")) {
      const v = a === "--phase" ? argv[++i] : a.slice("--phase=".length);
      if (v === undefined || v === "") throw new UsageError("--phase bir faz değeri ister");
      if (!isPhase(v)) throw new UsageError(`bilinmeyen faz "${v}" (geçerli: ${PHASES.join(", ")})`);
      if (args.phase !== null) throw new UsageError("--phase birden fazla verildi");
      args.phase = v;
    } else if (/^--(root|out)(?:=|$)/.test(a)) {
      const key = /** @type {"root" | "out"} */ (a.startsWith("--root") ? "root" : "out");
      const eq = a.indexOf("=");
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === "") throw new UsageError(`--${key} bir dizin ister`);
      if (args[key] !== undefined) throw new UsageError(`--${key} birden fazla verildi`);
      args[key] = path.resolve(v);
    } else if (/^AC-\d+$/.test(a)) {
      if (!args.ids.includes(a)) args.ids.push(a);
    } else {
      throw new UsageError(`bilinmeyen argüman "${a}"`);
    }
  }
  const modes = [args.phase !== null, args.ci, args.ids.length > 0].filter(Boolean).length;
  if (modes > 1) throw new UsageError("--phase, --ci ve AC listesi birlikte kullanılamaz");
  return args;
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, log?: (line: string) => void, env?: NodeJS.ProcessEnv, vitestBin?: string }} [opts]
 * @returns {number} çıkış kodu (0 = tüm AC'ler PASS/SKIPPED veya --ci'da engelleyici olmayan)
 */
export function main(argv, opts = {}) {
  const log = opts.log ?? ((l) => console.log(l));

  /** @type {Args} */
  let args;
  try {
    args = parseArgs(argv);
    if (args.root !== undefined && !(existsSync(args.root) && statSync(args.root).isDirectory())) {
      throw new UsageError(`--root dizini yok: ${args.root}`);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    log(`test:ac HATA: ${e.message}`);
    log(USAGE);
    return 2;
  }
  const root = args.root ?? opts.root ?? REPO_ROOT;
  const vitestBin = opts.vitestBin ?? path.join(root, "node_modules/.bin/vitest");

  let acs, conds;
  try {
    acs = loadAcceptance(root);
    conds = loadConditions(root, acs);
  } catch (e) {
    log(`test:ac HATA: ${/** @type {Error} */ (e).message}`);
    return 1;
  }

  /** @type {Mode} */
  let mode;
  if (args.ci) mode = { type: "ci" };
  else if (args.ids.length > 0) mode = { type: "ids", ids: args.ids };
  else mode = { type: "phase", phase: args.phase ?? conds.currentGatePhase };

  /** @type {string[]} */
  const errors = [];
  if (mode.type === "ids") {
    const known = new Set(acs.map((a) => a.id));
    for (const id of mode.ids) if (!known.has(id)) errors.push(`${id} ACCEPTANCE.md'de yok`);
  }

  /** @type {Map<string, import("../lib/pilot.mjs").PilotRow> | null} */
  let pilot = null;
  /** @type {string | null} */
  let pilotError = null;
  try {
    pilot = loadPilot(root);
  } catch (e) {
    pilotError = /** @type {Error} */ (e).message;
  }

  const tags = collectTags(root);
  const known = new Set(acs.map((a) => a.id));
  for (const t of tags) {
    if (!known.has(t.id)) errors.push(`bilinmeyen etiket @${t.id} (${t.file}:${t.line}); ID ACCEPTANCE.md'dekiyle birebir olmalı`);
  }

  const name = mode.type === "phase" ? mode.phase : mode.type;
  const label = mode.type === "phase" ? `faz ${mode.phase}` : mode.type === "ci" ? `--ci (passedGates: [${conds.passedGates.join(", ")}])` : mode.ids.join(", ");
  const artifactDir = args.out ?? path.join(root, ".artifacts", "test-ac");
  mkdirSync(artifactDir, { recursive: true });

  const entries = plan(acs, conds, mode, { pilot, pilotError }).sort((a, b) => a.ac.num - b.ac.num);
  const { results, runs } = execute(entries, groupById(tags), { root, artifactDir, name, vitestBin, env: opts.env, mode });

  /** @type {RuntimeSkipAudit | null} */
  let audit = null;
  if (mode.type === "ci") {
    audit = runtimeSkipAudit({ root, artifactDir, vitestBin, env: opts.env });
    errors.push(...audit.errors);
  }

  for (const r of results) log(formatResult(r));
  for (const err of errors) log(`HATA: ${err}`);
  const { ok, summary } = summarizeResults(results, errors);
  const artifact = path.join(artifactDir, `${name}.json`);
  writeFileSync(
    artifact,
    `${JSON.stringify({ mode, label, ok, summary, passedGates: conds.passedGates, currentGatePhase: conds.currentGatePhase, results, errors, runs: runs.map(({ outcomes, ...r }) => ({ ...r, testCount: outcomes.length })), runtimeSkipAudit: audit }, null, 2)}\n`,
  );
  log(`test:ac ${label}: ${summary} · ayrıntı ${displayPath(root, artifact)}`);
  return ok ? 0 : 1;
}

/**
 * Kökün altındaysa göreli, değilse mutlak yol (`--out` kök dışında olabilir).
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function displayPath(root, file) {
  const rel = path.relative(root, file);
  return rel.startsWith("..") || path.isAbsolute(rel) ? file : rel.split(path.sep).join("/");
}

/**
 * @typedef {{ jsonFile: string, log: string, exitCode: number | null, total: number, skipped: Array<{ file: string, fullName: string, status: string }>, errors: string[] }} RuntimeSkipAudit
 */

/**
 * Çalışma anı atlama denetimi (yalnızca --ci): birim takımının tamamı, `-t` süzgeci olmadan.
 * Fail-closed: rapor okunamazsa veya çıkış ≠ 0 iken raporda başarısız test yoksa HATA.
 * @param {{ root: string, artifactDir: string, vitestBin: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {RuntimeSkipAudit}
 */
export function runtimeSkipAudit({ root, artifactDir, vitestBin, env }) {
  const jsonFile = path.join(artifactDir, "ci.all.vitest.json");
  const logFile = path.join(artifactDir, "ci.all.log");
  rmSync(jsonFile, { force: true });
  // T-008k: `default` reporter da açık (stdout'taki tek `Tests` özet satırı JSON raporuyla karşılaştırılır);
  // vitest süreç grubunda koşar ve bitince grup SIGKILL ile sonlandırılır (`spawnIsolated`, T-008j).
  const args = ["run", "--root", root, "--reporter=json", `--outputFile.json=${jsonFile}`, "--reporter=default"];
  const r = spawnIsolated(vitestBin, args, { cwd: root, env: env ?? process.env });
  const spawnError = r.error ? `\n[spawn hatası] ${r.error.message}` : "";
  writeFileSync(logFile, `$ ${[vitestBin, ...args].join(" ")}\n[çıkış ${r.status}]\n--- stdout ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}${spawnError}\n`);
  const shownLog = displayPath(root, logFile);
  /** @type {RuntimeSkipAudit} */
  const audit = { jsonFile: displayPath(root, jsonFile), log: shownLog, exitCode: r.status, total: 0, skipped: [], errors: [] };
  let json = "";
  try {
    json = readFileSync(jsonFile, "utf8");
  } catch {
    // Rapor yoksa aşağıda HATA.
  }
  const outcomes = parseVitestReport(json, root);
  if (outcomes === null) {
    audit.errors.push(`RUNTIME_SKIP_UNVERIFIABLE çalışma anı atlama denetimi: vitest JSON raporu okunamadı (çıkış ${r.status}), bkz. ${shownLog}`);
    return audit;
  }
  const mismatch = reportMismatch(outcomes, r.stdout ?? "");
  if (mismatch !== null) {
    audit.errors.push(`REPORT_MISMATCH çalışma anı atlama denetimi: ${mismatch}, bkz. ${shownLog}`);
    return audit;
  }
  audit.total = outcomes.length;
  if (r.status !== 0 && !outcomes.some((o) => o.status === "failed")) {
    audit.errors.push(`RUNTIME_SKIP_UNVERIFIABLE çalışma anı atlama denetimi: vitest çıkış ${r.status} (başarısız test yok; yakalanmamış hata?), bkz. ${shownLog}`);
  }
  for (const o of outcomes) {
    if (o.status === "passed" || o.status === "failed") continue;
    audit.skipped.push({ file: o.file, fullName: o.fullName, status: o.status });
    audit.errors.push(`RUNTIME_SKIP ${o.file} › ${o.fullName} (${o.status}) — çalışma anında atlanan/koşmayan test kabul edilmez`);
  }
  return audit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
