#!/usr/bin/env node
// Bekçi giriş noktası (T-008a): `node scripts/guards/cli.mjs <ad> [argümanlar]`.
// `<ad>` → `scripts/guards/<ad>.mjs` modülünün `run(ctx)` işlevi. Modül dosyası henüz yoksa
// `FAIL NOT_IMPLEMENTED` + çıkış 1 (sahte OK yok, G-07). Böylece T-008b–f yalnızca kendi
// modül dosyasını ekler; kök `package.json`'a ve bu dosyaya dokunmaz.
// `all` (T-008g): beş bekçiyi + belge denetimini sırayla koşar (`all.mjs`).
// `--root <dizin>` (T-008g; ADR-012 rev. önyükleme): denetlenen depo kökü. Verilmezse bu betiğin
// bulunduğu depo. CI tabanın bekçisini PR dizinine karşı koşturur:
// `node base/scripts/guards/cli.mjs all --root pr/` (PR'ın betikleri/yapılandırması yüklenmez).
// Çıkış: 0 = OK, 1 = FAIL, 2 = kullanım hatası.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAll } from "./all.mjs";
import { createReporter, NO_FILE, UsageError } from "./lib/output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

/** PROTOCOL §3b bekçileri + `pilot` (T-008f). */
export const GUARDS = /** @type {const} */ (["scope", "tests", "ac-ratchet", "protected", "assertions", "pilot"]);

const USAGE = `kullanım: node scripts/guards/cli.mjs <all|${GUARDS.join("|")}> [--root <dizin>] [argümanlar]`;

/**
 * @typedef {import("./lib/output.mjs").Reporter} Reporter
 * @typedef {{ root: string, argv: string[], out: Reporter }} GuardContext
 * @typedef {{ run: (ctx: GuardContext) => void | Promise<void> }} GuardModule
 */

/**
 * @param {string} name
 * @returns {name is (typeof GUARDS)[number]}
 */
export function isGuardName(name) {
  return /** @type {readonly string[]} */ (GUARDS).includes(name);
}

/**
 * `--root <dizin>` / `--root=<dizin>` argümanını ayıklar (konumdan bağımsız; bekçinin kendi
 * argümanlarına geçmez). Dizin yoksa veya birden fazla verildiyse `UsageError`.
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {{ root: string | null, rest: string[] }}
 */
export function extractRoot(argv, cwd = process.cwd()) {
  /** @type {string | null} */
  let root = null;
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const m = /^--root(?:=(.*))?$/.exec(a);
    if (m === null) {
      rest.push(a);
      continue;
    }
    const v = m[1] ?? argv[++i];
    if (v === undefined || v === "") throw new UsageError("--root bir dizin ister");
    if (root !== null) throw new UsageError("--root birden fazla verildi");
    const abs = path.resolve(cwd, v);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new UsageError(`--root dizini yok: ${v}`);
    root = abs;
  }
  return { root, rest };
}

/**
 * @param {string[]} argv `<ad> [--root <dizin>] [argümanlar]`
 * @param {{ root?: string, guardsDir?: string, log?: (line: string) => void }} [opts]
 * @returns {Promise<number>} çıkış kodu
 */
export async function main(argv, opts = {}) {
  const guardsDir = opts.guardsDir ?? HERE;
  const log = opts.log ?? ((l) => console.log(l));
  /** @type {{ root: string | null, rest: string[] }} */
  let parsed;
  try {
    parsed = extractRoot(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    log(`check HATA: ${e.message}`);
    log(USAGE);
    return 2;
  }
  const root = parsed.root ?? opts.root ?? REPO_ROOT;
  const [name, ...rest] = parsed.rest;

  if (name === "all") {
    try {
      return await runAll({ root, argv: rest, log, runGuard: (g, args) => main([g, ...args], { root, guardsDir, log }) });
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      log(`check:all HATA: ${e.message}`);
      log(USAGE);
      return 2;
    }
  }
  if (name === undefined || !isGuardName(name)) {
    log(`check HATA: bilinmeyen bekçi "${name ?? ""}"`);
    log(USAGE);
    return 2;
  }
  const out = createReporter(name, { root, log });
  const file = path.join(guardsDir, `${name}.mjs`);
  if (!existsSync(file)) {
    out.fail("NOT_IMPLEMENTED", NO_FILE, `check:${name} henüz yazılmadı (${path.relative(root, file)} yok)`);
    return out.finish();
  }
  /** @type {Partial<GuardModule>} */
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.run !== "function") {
    out.fail("GUARD_INVALID", path.relative(root, file), "modül `run(ctx)` dışa aktarmıyor");
    return out.finish();
  }
  try {
    await mod.run({ root, argv: rest, out });
  } catch (e) {
    if (e instanceof UsageError) {
      log(`check:${name} HATA: ${e.message}`);
      log(USAGE);
      return 2;
    }
    throw e;
  }
  return out.finish();
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
