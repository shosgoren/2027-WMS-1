#!/usr/bin/env node
// Bekçi giriş noktası (T-008a): `node scripts/guards/cli.mjs <ad> [argümanlar]`.
// `<ad>` → `scripts/guards/<ad>.mjs` modülünün `run(ctx)` işlevi. Modül dosyası henüz yoksa
// `FAIL NOT_IMPLEMENTED` + çıkış 1 (sahte OK yok, G-07). Böylece T-008b–f yalnızca kendi
// modül dosyasını ekler; kök `package.json`'a ve bu dosyaya dokunmaz.
// Çıkış: 0 = OK, 1 = FAIL, 2 = kullanım hatası.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createReporter, NO_FILE, UsageError } from "./lib/output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

/** PROTOCOL §3b bekçileri + `pilot` (T-008f). */
export const GUARDS = /** @type {const} */ (["scope", "tests", "ac-ratchet", "protected", "assertions", "pilot"]);

const USAGE = `kullanım: node scripts/guards/cli.mjs <${GUARDS.join("|")}> [argümanlar]`;

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
 * @param {string[]} argv `<ad> [argümanlar]`
 * @param {{ root?: string, guardsDir?: string, log?: (line: string) => void }} [opts]
 * @returns {Promise<number>} çıkış kodu
 */
export async function main(argv, opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const guardsDir = opts.guardsDir ?? HERE;
  const log = opts.log ?? ((l) => console.log(l));
  const [name, ...rest] = argv;

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
  // `name` yukarıda sabit GUARDS listesine karşı doğrulandı; `guardsDir` yalnızca testlerde değişir.
  // Bu `import(<ifade>)` eslint.config.mjs'teki tek dosyalık muafiyettir (GUARD_LOADER_FILE, T-015).
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
