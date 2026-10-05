#!/usr/bin/env node
// `pnpm test:ac` — faz kapısı koşturucusu (T-007).
//   pnpm test:ac --phase <N>   kapı modu: fazın tüm AC'leri; etiketli testi olmayan AC = hata
//   pnpm test:ac -- AC-05 …    yalnızca verilen AC'ler (koşuldan bağımsız koşar)
//   pnpm test:ac --ci          PR modu: mevcut her @AC testi koşar ve geçmeli; NO_TEST yalnızca
//                              `passedGates` fazlarında hata, diğerlerinde bilgi
//   pnpm test:ac               = --phase <currentGatePhase>
// Konsol: AC başına tek satır + özet. Ayrıntı: `.artifacts/test-ac/<faz|ci|ids>.json`.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPhase, loadAcceptance, PHASES } from "./acceptance.mjs";
import { collectTags, groupById } from "./collect.mjs";
import { loadConditions } from "./conditions.mjs";
import { execute, formatResult, plan, summarizeResults } from "./run.mjs";
import { loadPilot } from "../lib/pilot.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = "kullanım: pnpm test:ac [--phase <N> | --ci | -- AC-xx [AC-yy …]]";

/**
 * @typedef {import("./run.mjs").Mode} Mode
 * @typedef {{ phase: string | null, ci: boolean, ids: string[] }} Args
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
  const root = opts.root ?? REPO_ROOT;
  const log = opts.log ?? ((l) => console.log(l));
  const vitestBin = opts.vitestBin ?? path.join(REPO_ROOT, "node_modules/.bin/vitest");

  /** @type {Args} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    log(`test:ac HATA: ${e.message}`);
    log(USAGE);
    return 2;
  }

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
  const artifactDir = path.join(root, ".artifacts", "test-ac");
  mkdirSync(artifactDir, { recursive: true });

  const entries = plan(acs, conds, mode, { pilot, pilotError }).sort((a, b) => a.ac.num - b.ac.num);
  const { results, runs } = execute(entries, groupById(tags), { root, artifactDir, name, vitestBin, env: opts.env, mode });

  for (const r of results) log(formatResult(r));
  for (const err of errors) log(`HATA: ${err}`);
  const { ok, summary } = summarizeResults(results, errors);
  const artifact = path.join(artifactDir, `${name}.json`);
  writeFileSync(
    artifact,
    `${JSON.stringify({ mode, label, ok, summary, passedGates: conds.passedGates, currentGatePhase: conds.currentGatePhase, results, errors, runs: runs.map(({ outcomes, ...r }) => ({ ...r, testCount: outcomes.length })) }, null, 2)}\n`,
  );
  log(`test:ac ${label}: ${summary} · ayrıntı ${path.relative(root, artifact).split(path.sep).join("/")}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
