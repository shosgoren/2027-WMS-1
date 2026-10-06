#!/usr/bin/env node
// T-106 — staging dağıtımında migration adımı (ADR-015 §7; `deploy-staging.yml` "Migrate" adımı).
// Uygulama dağıtımından ÖNCE, doğrudan (pooler'sız) bağlantıyla ve migration (Neon sahip) rolüyle
// `pnpm db:migrate` koşar. Başarısızlık → çıkış kodu ≠ 0 → Deploy adımı koşmaz (fail-closed).
//
// URI kaynağı (m7 / A-54):
//   1) `STAGING_DATABASE_URL_DIRECT` repo sırrı (yalnızca staging veritabanı kapsamı) → yol `direct-secret`.
//   2) Yoksa ayrı, koşullu iş akışı adımı `--resolve-only --out <dosya>` ile `NEON_API_KEY` + `NEON_PROJECT_ID`
//      kullanarak `scripts/neon-api.mjs` üzerinden sahip rolün doğrudan URI'sini maskeler ve 0600 dosyaya yazar
//      (bağımlılık kurulmadan ÖNCE); `Migrate` adımı `--uri-file <dosya>` ile okur ve siler → yol `neon-api`;
//      özete `fallback: neon-api` yazılır. `Migrate` adımı NEON_API_KEY'i hiç görmez. Yol 2026-11-15'ten sonra kırmızıdır.
// Sır (G-09, I-03): URI/parola ilk elde edildiği anda `::add-mask::` ile maskelenir ve hiçbir yere yazılmaz.
// `pnpm db:migrate` alt süreci DARALTILMIŞ ortam alır (RUNNER_TEMP/NODE_OPTIONS dahil değil): izinli değişkenler +
// `DATABASE_URL_DIRECT`, `WMS_ENV=staging`, `DEMO_MODE=1`; `NEON_API_KEY`, `FLY_API_TOKEN` ve `DATABASE_URL`
// alt sürece GEÇMEZ. `DATABASE_URL_DIRECT` Fly'a yazılmaz (yalnızca bu adımın süreç ortamında yaşar).
// `DEMO_MODE=1` ile migration rolü demo tenant adımını (T-123) aynı koşuda yürütür.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLineFilter, createRedactor, maskSecret } from "./neon-spike.mjs";
import { createNeonProjectApi, parsePgUri, readNeonEnv } from "./neon-api.mjs";

export const WMS_ENV = "staging";
/** Yedek (`neon-api`) yolunun son geçerli günü (A-54); ertesi gün 00:00 UTC'den itibaren hata. */
export const FALLBACK_LAST_DAY = "2026-11-15";
const FALLBACK_CUTOFF_MS = Date.parse(`${FALLBACK_LAST_DAY}T00:00:00Z`) + 24 * 3600 * 1000;
/** Alt sürece geçen ortam değişkenleri (izin listesi; sır taşımaz). */
export const CHILD_ENV_ALLOW = Object.freeze([
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "GITHUB_ACTIONS", "PNPM_HOME",
  "npm_config_ignore_pnpmfile", "COREPACK_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
]);

export class DeployMigrateError extends Error {
  name = "DeployMigrateError";
}

/**
 * Yedek yolun tarih denetimi (UTC). `now` 2026-11-16T00:00Z veya sonrası → hata.
 * @param {Date} now
 */
export function assertFallbackAllowed(now) {
  if (now.getTime() >= FALLBACK_CUTOFF_MS) {
    throw new DeployMigrateError(
      `yedek yol (NEON_API_KEY ile URI alma) ${FALLBACK_LAST_DAY} sonrası kapalı (A-54): STAGING_DATABASE_URL_DIRECT repo sırrını ekleyin`,
    );
  }
}

/**
 * Doğrudan bağlantı URI'sinin kabul edilebilirliği: postgres şeması, pooler olmayan host. Değer hata iletisine girmez.
 * @param {string} uri
 */
export function assertDirectUri(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    throw new DeployMigrateError("doğrudan bağlantı URI'si ayrıştırılamadı");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new DeployMigrateError("doğrudan bağlantı URI'si postgres şemasında değil");
  }
  if (u.hostname.includes("-pooler")) {
    throw new DeployMigrateError("URI pooler host'una işaret ediyor; migration yalnızca doğrudan bağlantıyla koşar (ADR-015 §3)");
  }
  parsePgUri(uri); // host/kullanıcı/parola/veritabanı boş olamaz
}

/**
 * Alt süreç ortamı (daraltılmış). `uri` yalnızca `DATABASE_URL_DIRECT` olarak girer.
 * @param {Record<string, string | undefined>} base
 * @param {string} uri
 * @returns {Record<string, string>}
 */
export function buildChildEnv(base, uri) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of CHILD_ENV_ALLOW) {
    const v = base[k];
    if (typeof v === "string") out[k] = v;
  }
  out["DATABASE_URL_DIRECT"] = uri;
  out["WMS_ENV"] = WMS_ENV;
  out["DEMO_MODE"] = "1";
  return out;
}

/**
 * Yedek yol: Neon API'sinden sahip rolün doğrudan URI'si (A-54 tarih denetimiyle); hepsi maskelenir.
 * @param {{
 *   env: Record<string, string | undefined>, now: Date, redactor: ReturnType<typeof createRedactor>,
 *   write?: (s: string) => void, apiFactory?: typeof createNeonProjectApi,
 * }} o
 * @returns {Promise<string>}
 */
export async function resolveViaNeonApi(o) {
  const mask = (/** @type {string} */ v) => maskSecret(o.redactor, v, { env: o.env, ...(o.write ? { write: o.write } : {}) });
  assertFallbackAllowed(o.now);
  const { apiKey, projectId } = readNeonEnv(o.env);
  const api = (o.apiFactory ?? createNeonProjectApi)({
    apiKey,
    projectId,
    redactor: o.redactor,
    env: o.env,
    ...(o.write ? { write: o.write } : {}),
  });
  const branch = await api.findMainBranch();
  await api.getReadWriteEndpoint(branch.id); // host maskelenir
  const db = await api.getDatabase(branch.id);
  const uri = await api.getConnectionUri({ branchId: branch.id, databaseName: db.name, roleName: db.ownerName, pooled: false });
  mask(uri);
  assertDirectUri(uri);
  mask(parsePgUri(uri).password);
  return uri;
}

/**
 * `--uri-file`: resolve adımının yazdığı 0600 dosya okunur ve silinir (yalnızca sahibi okuyabilmeli).
 * @param {string} file
 * @returns {string}
 */
export function readUriFile(file) {
  let mode;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new DeployMigrateError("URI dosyası okunamadı (yedek yol adımı koşmadı mı?)");
  }
  if ((mode & 0o077) !== 0) throw new DeployMigrateError("URI dosyası yalnızca sahibine açık olmalı (0600)");
  const uri = readFileSync(file, "utf8").trim();
  unlinkSync(file);
  return uri;
}

/**
 * Migrate adımının URI'si: `STAGING_DATABASE_URL_DIRECT` sırrı, yoksa resolve adımının dosyası. Bu işlev
 * NEON_API_KEY KULLANMAZ (Migrate adımının ortamında yoktur).
 * @param {{
 *   env: Record<string, string | undefined>, now: Date, redactor: ReturnType<typeof createRedactor>,
 *   write?: (s: string) => void, uriFile?: string,
 * }} o
 * @returns {{ path: "direct-secret" | "neon-api", uri: string }}
 */
export function resolveDirectUri(o) {
  const mask = (/** @type {string} */ v) => maskSecret(o.redactor, v, { env: o.env, ...(o.write ? { write: o.write } : {}) });
  const direct = (o.env["STAGING_DATABASE_URL_DIRECT"] ?? "").trim();
  if (direct !== "") {
    mask(direct);
    assertDirectUri(direct);
    mask(parsePgUri(direct).password);
    return { path: "direct-secret", uri: direct };
  }
  if (o.uriFile === undefined) {
    throw new DeployMigrateError("URI kaynağı yok: STAGING_DATABASE_URL_DIRECT boş ve --uri-file verilmedi");
  }
  assertFallbackAllowed(o.now);
  const uri = readUriFile(o.uriFile);
  mask(uri);
  assertDirectUri(uri);
  mask(parsePgUri(uri).password);
  return { path: "neon-api", uri };
}

/**
 * @param {string[]} argv
 * @returns {{ resolveOnly: boolean, out?: string, uriFile?: string }}
 */
export function parseArgs(argv) {
  /** @type {{ resolveOnly: boolean, out?: string, uriFile?: string }} */
  const r = { resolveOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resolve-only") r.resolveOnly = true;
    else if (a === "--out" || a === "--uri-file") {
      const v = argv[++i];
      if (v === undefined || v === "") throw new DeployMigrateError(`${a} bir değer ister`);
      if (a === "--out") r.out = v;
      else r.uriFile = v;
    } else throw new DeployMigrateError(`bilinmeyen argüman "${a}"`);
  }
  if (r.resolveOnly && r.out === undefined) throw new DeployMigrateError("--resolve-only için --out gerekli");
  if (r.resolveOnly && r.uriFile !== undefined) throw new DeployMigrateError("--resolve-only ile --uri-file birlikte kullanılamaz");
  return r;
}

/**
 * `pnpm db:migrate` çıktısından sürüm özeti (URL içermez; `migrate:` / `queue install:` / `rollback:` satırları).
 * @param {string} stdout
 * @returns {{ applied: string[], lines: string[], nothingPending: boolean }}
 */
export function summarizeMigrateOutput(stdout) {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(migrate|queue install):/.test(l));
  /** @type {string[]} */
  let applied = [];
  let nothingPending = false;
  for (const l of lines) {
    const m = /^migrate: \d+ migration uygulandı \(([^)]*)\)/.exec(l);
    if (m) applied = (m[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (/^migrate: 0 bekleyen migration/.test(l)) nothingPending = true;
  }
  return { applied, lines, nothingPending };
}

/**
 * @param {{ path: string, applied: string[], nothingPending: boolean, ok: boolean, lines: string[] }} s
 */
export function renderSummaryMd(s) {
  const out = [
    "### deploy-staging · Migrate",
    "",
    `- sonuç: ${s.ok ? "OK" : "FAIL"}`,
    `- yol: \`${s.path}\``,
    ...(s.path === "neon-api" ? ["- fallback: neon-api (A-54: 2026-11-15 sonrası kırmızı; STAGING_DATABASE_URL_DIRECT ekleyin)"] : []),
    `- uygulanan: ${s.nothingPending ? "0 bekleyen" : s.applied.length > 0 ? s.applied.join(", ") : "bilinmiyor"}`,
    ...s.lines.map((l) => `- \`${l}\``),
    "",
  ];
  return out.join("\n");
}

/**
 * Alt süreci çalıştırır; stdout/stderr satır satır maskelenerek `write`'a ve toplama arabelleğine gider.
 * @param {{ env: Record<string, string>, redactor: ReturnType<typeof createRedactor>, write: (s: string) => void, cwd?: string,
 *   command?: string, args?: string[] }} o
 * @returns {Promise<{ code: number, stdout: string, leaked: boolean }>}
 */
export function runMigrateProcess(o) {
  return new Promise((resolve) => {
    let stdout = "";
    let leaked = false;
    const sink = (/** @type {string} */ line) => {
      stdout += line;
      o.write(line);
    };
    const onLeak = () => {
      leaked = true;
    };
    const out = createLineFilter(o.redactor, sink, onLeak);
    const err = createLineFilter(o.redactor, (l) => o.write(l), onLeak);
    const child = spawn(o.command ?? "pnpm", o.args ?? ["db:migrate"], {
      env: o.env,
      ...(o.cwd ? { cwd: o.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (/** @type {Buffer} */ d) => out.push(d.toString("utf8")));
    child.stderr.on("data", (/** @type {Buffer} */ d) => err.push(d.toString("utf8")));
    child.on("error", () => {
      out.end();
      err.end();
      o.write("deploy-migrate: alt süreç başlatılamadı\n");
      resolve({ code: 127, stdout, leaked });
    });
    child.on("close", (code) => {
      out.end();
      err.end();
      resolve({ code: code ?? 1, stdout, leaked });
    });
  });
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>, now?: Date, write?: (s: string) => void,
 *   runner?: typeof runMigrateProcess, apiFactory?: typeof createNeonProjectApi, summaryFile?: string,
 *   argv?: string[],
 * }} [o]
 * @returns {Promise<number>}
 */
export async function main(o = {}) {
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  const rawWrite = o.write ?? ((/** @type {string} */ s) => void process.stdout.write(s));
  const redactor = createRedactor();
  const write = (/** @type {string} */ s) => rawWrite(redactor.redact(s));
  const summaryFile = o.summaryFile ?? env["GITHUB_STEP_SUMMARY"];
  /** @param {Parameters<typeof renderSummaryMd>[0]} s */
  const summarize = (s) => {
    if (summaryFile) appendFileSync(summaryFile, renderSummaryMd(s));
  };
  /** @type {ReturnType<typeof parseArgs>} */
  let args;
  try {
    args = parseArgs(o.argv ?? process.argv.slice(2));
  } catch (e) {
    write(`::error::deploy-migrate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (args.resolveOnly) {
    try {
      const uri = await resolveViaNeonApi({ env, now, redactor, write: rawWrite, ...(o.apiFactory ? { apiFactory: o.apiFactory } : {}) });
      // 0600, yalnızca yeni dosya (`wx`): var olan dosya/symlink üzerine yazılmaz.
      writeFileSync(/** @type {string} */ (args.out), `${uri}\n`, { mode: 0o600, flag: "wx" });
      write("deploy-migrate: yedek yol URI'si alındı (fallback: neon-api; A-54); dosyaya yazıldı\n");
      return 0;
    } catch (e) {
      write(`::error::deploy-migrate: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  /** @type {ReturnType<typeof resolveDirectUri>} */
  let resolved;
  try {
    resolved = resolveDirectUri({ env, now, redactor, write: rawWrite, ...(args.uriFile ? { uriFile: args.uriFile } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    write(`::error::deploy-migrate: ${msg}\n`);
    summarize({ path: "bilinmiyor", applied: [], nothingPending: false, ok: false, lines: [] });
    return 1;
  }
  write(`deploy-migrate: yol=${resolved.path}${resolved.path === "neon-api" ? " (fallback: neon-api; A-54)" : ""}\n`);
  const run = o.runner ?? runMigrateProcess;
  const r = await run({ env: buildChildEnv(env, resolved.uri), redactor, write: rawWrite });
  const sum = summarizeMigrateOutput(r.stdout);
  const ok = r.code === 0 && !r.leaked;
  summarize({ path: resolved.path, applied: sum.applied, nothingPending: sum.nothingPending, ok, lines: sum.lines });
  if (r.leaked) write("::error::deploy-migrate: çıktıda sızıntı belirtisi (maskelenmiş); iş başarısız sayıldı\n");
  if (r.code !== 0) write(`::error::deploy-migrate: pnpm db:migrate çıkış kodu ${r.code}; dağıtım durduruldu\n`);
  else if (ok) write(`deploy-migrate: OK — ${sum.nothingPending ? "0 bekleyen" : sum.applied.length > 0 ? `${sum.applied.join(", ")} applied` : "tamamlandı"}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
