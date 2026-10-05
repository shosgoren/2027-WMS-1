// `node scripts/guards/app-settings.mjs [--root <dizin>]` (T-101d, MINOR 3): migration/RLS SQL'indeki
// `app.*` oturum ayarı kullanımları `KNOWN_APP_SETTINGS` listesinde (packages/db/src/migrate.ts) olmalı.
// Neden: PostgreSQL `pg_settings` placeholder (özel) ayarları güvenilir göstermez; koşturucunun oturum
// sızıntı denetimi yalnızca bildiği adları görebilir. Listede olmayan bir `app.*` adı ya da değişken
// (`current_setting(<ifade>)`) kullanımı = FAIL (fail-closed).
// Taranan: `packages/db/migrations/**/*.sql` ve `packages/db/src/**/*.ts` (RLS ifadeleri/ayar çağrıları).
// Çıkış: 0 OK, 1 ihlal, 2 kullanım hatası.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAME_RE = /(?:current_setting|set_config)\s*\(\s*'(app\.[^']*)'/gi;
/** `SET [LOCAL|SESSION] app.x ...` */
const SET_RE = /\bSET\s+(?:LOCAL\s+|SESSION\s+)?(app\.[A-Za-z0-9_.]+)\s*(?:=|TO\b)/gi;
/** `current_setting(` / `set_config(` ardından dize sabiti OLMAYAN argüman (yalnızca SQL dosyalarında). */
const DYNAMIC_RE = /(?:current_setting|set_config)\s*\(\s*(?!')[^)\s]/gi;

/**
 * @param {string} text
 * @param {string} file
 * @param {readonly string[]} known
 * @param {{ dynamic: boolean }} opts
 * @returns {{ file: string, line: number, message: string }[]}
 */
export function scanText(text, file, known, opts) {
  /** @type {{ file: string, line: number, message: string }[]} */
  const out = [];
  /** @param {number} index */
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  for (const re of [NAME_RE, SET_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const name = /** @type {string} */ (m[1]);
      if (!known.includes(name)) {
        out.push({ file, line: lineOf(m.index), message: `"${name}" KNOWN_APP_SETTINGS listesinde yok (packages/db/src/migrate.ts)` });
      }
    }
  }
  if (opts.dynamic) {
    DYNAMIC_RE.lastIndex = 0;
    for (let m = DYNAMIC_RE.exec(text); m !== null; m = DYNAMIC_RE.exec(text)) {
      out.push({ file, line: lineOf(m.index), message: "ayar okuma/yazma işlevinin argümanı sabit değil; app.* adı denetlenemez" });
    }
  }
  return out;
}

/**
 * @param {string} dir
 * @param {(name: string) => boolean} match
 * @returns {string[]}
 */
function walk(dir, match) {
  /** @type {string[]} */
  const files = [];
  /** @type {import("node:fs").Dirent[]} */
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) files.push(...walk(full, match));
    } else if (match(e.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * @param {string} root
 * @param {readonly string[]} known
 * @returns {{ file: string, line: number, message: string }[]}
 */
export function scanRepo(root, known) {
  /** @type {{ file: string, line: number, message: string }[]} */
  const findings = [];
  const sqlFiles = walk(path.join(root, "packages/db/migrations"), (n) => n.endsWith(".sql"));
  const tsFiles = walk(path.join(root, "packages/db/src"), (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
  for (const f of [...sqlFiles, ...tsFiles]) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    findings.push(...scanText(readFileSync(f, "utf8"), rel, known, { dynamic: f.endsWith(".sql") }));
  }
  return findings;
}

/**
 * `KNOWN_APP_SETTINGS` dizisini migrate.ts kaynağından okur (modülü yüklemeden; sürücü import edilmez).
 * @param {string} root
 * @returns {string[] | undefined}
 */
export function readKnownSettings(root) {
  let src = "";
  try {
    src = readFileSync(path.join(root, "packages/db/src/migrate.ts"), "utf8");
  } catch {
    return undefined;
  }
  const m = /export const KNOWN_APP_SETTINGS[^=]*=\s*\[([^\]]*)\]/.exec(src);
  if (m === null) return undefined;
  const names = [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => /** @type {string} */ (x[1]));
  return names.length > 0 ? names : undefined;
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} log
 * @returns {Promise<number>}
 */
export async function main(argv, log) {
  const args = argv.filter((a) => a !== "--");
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (args.length === 2 && args[0] === "--root" && args[1] !== undefined) root = path.resolve(args[1]);
  else if (args.length > 0) {
    log("kullanım: app-settings.mjs [--root <dizin>]");
    return 2;
  }
  const known = readKnownSettings(root);
  if (known === undefined) {
    log("[check:app-settings] FAIL KNOWN_LIST_UNREADABLE packages/db/src/migrate.ts — KNOWN_APP_SETTINGS dizisi okunamadı");
    return 1;
  }
  const findings = scanRepo(root, known);
  for (const f of findings) log(`[check:app-settings] FAIL APP_SETTING_UNKNOWN ${f.file}:${f.line} — ${f.message}`);
  log(findings.length === 0 ? "check:app-settings OK" : `check:app-settings FAIL (${findings.length})`);
  return findings.length === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2), console.log);
}
