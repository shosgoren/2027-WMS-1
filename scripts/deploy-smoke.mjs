#!/usr/bin/env node
// Dağıtım sonrası duman testi (T-010 / ADR-013). `deploy-staging.yml` dağıtımdan sonra koşar:
//   node scripts/deploy-smoke.mjs --url https://etkin-wms-staging.fly.dev/api/health \
//     --status-file "$RUNNER_TEMP/fly-status.json"
// 1) web: URL → HTTP 200 ve gövde `{"status":"ok"}`; yeniden deneme + istek başına zaman aşımı
//    (web makinesi `auto_stop_machines` ile durmuş olabilir; ilk istek onu başlatır).
// 2) worker: `flyctl status --json` çıktısında (dosya) `worker` süreç grubunda en az bir makine
//    var ve hepsi `started`. Süreç grubu `config.metadata.fly_process_group` alanındadır
//    (eski ad `process_group`; fly-go v0.11.2 `MachineConfig.ProcessGroup`).
// Bu betik FLY_API_TOKEN görmez: status dosyasını dağıtım adımı yazar.
// Çıktı: başarısız kontrolün nedeni + tek özet satırı. Herhangi bir FAIL → çıkış kodu 1.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULTS = Object.freeze({
  attempts: 12,
  delayMs: 5000,
  timeoutMs: 10000,
  group: "worker",
});

/**
 * @typedef {{ ok: boolean, reason: string }} CheckResult
 * @typedef {(url: string, init: { signal: AbortSignal }) => Promise<{ status: number, text(): Promise<string> }>} FetchLike
 * @typedef {{
 *   fetchImpl?: FetchLike,
 *   attempts?: number,
 *   delayMs?: number,
 *   timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   log?: (line: string) => void,
 * }} HealthOptions
 */

/**
 * Tek yanıtı değerlendirir: 200 ve JSON gövdede `status === "ok"`.
 * @param {number} status
 * @param {string} body
 * @returns {CheckResult}
 */
export function evaluateHealth(status, body) {
  if (status !== 200) {
    return { ok: false, reason: `HTTP ${status}` };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "gövde JSON değil" };
  }
  if (typeof parsed !== "object" || parsed === null || /** @type {{ status?: unknown }} */ (parsed).status !== "ok") {
    return { ok: false, reason: `beklenmeyen gövde: ${body.slice(0, 200)}` };
  }
  return { ok: true, reason: "HTTP 200 {status:\"ok\"}" };
}

/**
 * Sağlık uç noktasını yeniden denemeyle yoklar; ilk başarıda döner.
 * @param {string} url
 * @param {HealthOptions} [opts]
 * @returns {Promise<CheckResult & { attempts: number }>}
 */
export async function checkHealth(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? /** @type {FetchLike} */ (fetch);
  const attempts = opts.attempts ?? DEFAULTS.attempts;
  const delayMs = opts.delayMs ?? DEFAULTS.delayMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const sleep = opts.sleep ?? delay;
  const log = opts.log ?? (() => {});
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts pozitif tam sayı olmalı: ${attempts}`);
  }
  /** @type {CheckResult} */
  let last = { ok: false, reason: "deneme yapılmadı" };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      last = evaluateHealth(res.status, await res.text());
    } catch (err) {
      last = { ok: false, reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
    if (last.ok) {
      return { ...last, attempts: i };
    }
    log(`health: deneme ${i}/${attempts} başarısız (${last.reason})`);
    if (i < attempts) {
      await sleep(delayMs);
    }
  }
  return { ...last, attempts };
}

/**
 * @param {unknown} machine
 * @returns {string}
 */
function processGroupOf(machine) {
  const m = /** @type {{ config?: { metadata?: Record<string, unknown> } } | null} */ (machine);
  const meta = m?.config?.metadata ?? {};
  const group = meta["fly_process_group"] ?? meta["process_group"];
  return typeof group === "string" ? group : "";
}

/**
 * `flyctl status --json` çıktısında süreç grubunun tüm makineleri `started` mı.
 * @param {string} statusJson
 * @param {string} [group]
 * @returns {CheckResult}
 */
export function checkProcessGroup(statusJson, group = DEFAULTS.group) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    return { ok: false, reason: "flyctl status çıktısı JSON değil" };
  }
  const machines = /** @type {{ Machines?: unknown } | null} */ (parsed)?.Machines;
  if (!Array.isArray(machines)) {
    return { ok: false, reason: "flyctl status çıktısında Machines dizisi yok" };
  }
  const inGroup = machines.filter((m) => processGroupOf(m) === group);
  if (inGroup.length === 0) {
    return { ok: false, reason: `"${group}" süreç grubunda makine yok` };
  }
  const states = inGroup.map((m) => {
    const s = /** @type {{ state?: unknown, id?: unknown }} */ (m);
    return { id: typeof s.id === "string" ? s.id : "?", state: typeof s.state === "string" ? s.state : "?" };
  });
  const notStarted = states.filter((s) => s.state !== "started");
  if (notStarted.length > 0) {
    return {
      ok: false,
      reason: `"${group}" başlamamış makine: ${notStarted.map((s) => `${s.id}=${s.state}`).join(", ")}`,
    };
  }
  return { ok: true, reason: `"${group}" ${states.length} makine started` };
}

/**
 * @param {string[]} argv
 * @returns {{ url: string, statusFile: string, group: string }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const m = /^--(url|status-file|group)(?:=(.*))?$/.exec(a);
    if (m === null) throw new Error(`bilinmeyen argüman "${a}"`);
    const key = m[1] ?? "";
    const v = m[2] ?? argv[++i];
    if (v === undefined || v === "") throw new Error(`--${key} bir değer ister`);
    out[key] = v;
  }
  const url = out["url"];
  const statusFile = out["status-file"];
  if (url === undefined || statusFile === undefined) {
    throw new Error("kullanım: deploy-smoke.mjs --url <health-url> --status-file <flyctl-status.json> [--group worker]");
  }
  if (!/^https:\/\//.test(url)) throw new Error(`--url https olmalı: ${url}`);
  return { url, statusFile, group: out["group"] ?? DEFAULTS.group };
}

/**
 * @param {CheckResult} web
 * @param {CheckResult} worker
 * @returns {string}
 */
export function summaryLine(web, worker) {
  return `deploy-smoke: web ${web.ok ? "OK" : "FAIL"} · worker ${worker.ok ? "OK" : "FAIL"}`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`deploy-smoke: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const web = await checkHealth(args.url, { log: (l) => console.log(l) });
  console.log(`web: ${web.ok ? "OK" : "FAIL"} — ${web.reason} (${web.attempts} deneme)`);
  /** @type {CheckResult} */
  let worker;
  try {
    worker = checkProcessGroup(readFileSync(args.statusFile, "utf8"), args.group);
  } catch (err) {
    worker = { ok: false, reason: `status dosyası okunamadı: ${err instanceof Error ? err.message : String(err)}` };
  }
  console.log(`worker: ${worker.ok ? "OK" : "FAIL"} — ${worker.reason}`);
  console.log(summaryLine(web, worker));
  return web.ok && worker.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
