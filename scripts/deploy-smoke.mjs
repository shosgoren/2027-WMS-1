#!/usr/bin/env node
// Dağıtım sonrası duman testi (T-010 / ADR-013). `deploy-staging.yml` dağıtımdan sonra koşar:
//   node scripts/deploy-smoke.mjs --url https://etkin-wms-staging.fly.dev/api/health \
//     --status-file "$RUNNER_TEMP/fly-status.json"
// 1) web: URL → HTTP 200 ve gövde `{"status":"ok"}` (varsa `db` alanı da `ok`, T-106); yeniden deneme + istek başına zaman aşımı
//    (web makinesi `auto_stop_machines` ile durmuş olabilir; ilk istek onu başlatır).
// 2) worker: `flyctl status --json` çıktısında (dosya) `worker` süreç grubunda en az bir makine
//    var ve hepsi `started`. Süreç grubu `config.metadata.fly_process_group` alanındadır
//    (eski ad `process_group`; fly-go v0.11.2 `MachineConfig.ProcessGroup`).
// Bu betik FLY_API_TOKEN görmez: status dosyasını dağıtım adımı yazar.
// Teşhis (T-106c): worker FAIL olursa iş akışı AYRI adımda (FLY_API_TOKEN'lı) makine loglarını bu betiğe borulayarak
// satır bazında maskeleyip yazar: `node scripts/deploy-smoke.mjs worker-ids --status-file F` (başlamamış worker
// makine kimlikleri + olay özeti) ve `... mask-logs [--max-lines 200]` (stdin → maskeli stdout). Bu adımlar yalnızca
// kendi ortamlarındaki FLY_API_TOKEN değerini maskeleme için okur; ağ erişimi yoktur.
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
  // T-106: `db` alanı (T-129 sonrası) VARSA "ok" olmalı (metin "ok" ya da {status:"ok"}); alan yoksa
  // mevcut davranış (geriye uyumlu). Alan uydurulmaz/beklenmez: yalnızca var olan denetlenir.
  const rec = /** @type {Record<string, unknown>} */ (parsed);
  if (Object.prototype.hasOwnProperty.call(rec, "db")) {
    const db = rec["db"];
    const dbStatus = typeof db === "object" && db !== null ? /** @type {{ status?: unknown }} */ (db).status : db;
    if (dbStatus !== "ok") {
      return { ok: false, reason: `db alanı ok değil: ${JSON.stringify(dbStatus ?? null).slice(0, 100)}` };
    }
    return { ok: true, reason: 'HTTP 200 {status:"ok", db:"ok"}' };
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


// ---- T-106c: worker makine teşhisi (maskeli) -------------------------------------------------------------------
export const DIAG_MAX_LINES = 200;
const MASK = "[MASKED]";
/** Sır adı içeren `ad=değer` / `"ad":"değer"` kalıpları (ad kökü: SECRET/KEY/TOKEN/PASSWORD/PASS/PWD/CREDENTIAL). */
const SECRET_ASSIGN = /([A-Za-z0-9_.-]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;
/**
 * Tek log satırını maskeler (G-09): bağlantı URI'leri, sır adlı atamalar, Bearer/Fly/Resend belirteçleri, uzun
 * rastgele dizgiler ve (verilirse) bilinen sır değerleri. Her satır `worker| ` önekiyle yazılır → satır başındaki
 * `::` iş akışı komutu olarak yorumlanamaz.
 * @param {string} line
 * @param {readonly string[]} [knownSecrets]
 * @returns {string}
 */
export function maskLine(line, knownSecrets = []) {
  let out = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  for (const k of knownSecrets) {
    if (typeof k === "string" && k.length >= 8) out = out.split(k).join(MASK);
  }
  out = out
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi, (m) => (/^https?:\/\/[^@\s]*$/i.test(m) ? m : MASK))
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(/\b(?:FlyV1|fm1[ar]?_|fm2_|re_)[A-Za-z0-9._~+/=,-]{8,}/g, MASK)
    .replace(SECRET_ASSIGN, (_m, pre) => `${pre}${MASK}`)
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, MASK);
  return `worker| ${out}`;
}

/**
 * Log metnini son `maxLines` satırla sınırlar ve maskeler; yazılan satır sayısı son satırda.
 * @param {string} text
 * @param {{ maxLines?: number, knownSecrets?: readonly string[] }} [opts]
 * @returns {{ lines: string[], total: number }}
 */
export function maskLogs(text, opts = {}) {
  const max = opts.maxLines ?? DIAG_MAX_LINES;
  const all = text.split(/\r?\n/).filter((l) => l !== "");
  const tail = all.slice(-max);
  return { lines: tail.map((l) => maskLine(l, opts.knownSecrets ?? [])), total: all.length };
}

/**
 * Başlamamış süreç grubu makineleri: kimlik + durum + son olaylar (yalnızca beyaz listeli alanlar; yapılandırma/env
 * ASLA yazılmaz). Olay alanları (`events[].request.exit_event`) Fly Machines API şemasındandır; yoksa atlanır.
 * @param {string} statusJson
 * @param {string} [group]
 * @returns {{ id: string, summary: string[] }[]}
 */
export function describeStoppedMachines(statusJson, group = DEFAULTS.group) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    return [];
  }
  const machines = /** @type {{ Machines?: unknown } | null} */ (parsed)?.Machines;
  if (!Array.isArray(machines)) return [];
  /** @type {{ id: string, summary: string[] }[]} */
  const out = [];
  for (const m of machines) {
    if (processGroupOf(m) !== group) continue;
    const mm = /** @type {Record<string, any>} */ (m);
    if (mm["state"] === "started") continue;
    const id = typeof mm["id"] === "string" ? mm["id"] : "";
    if (!/^[a-z0-9]{8,20}$/.test(id)) continue;
    const summary = [`state=${String(mm["state"])}`];
    const restart = mm["config"]?.restart?.policy;
    if (typeof restart === "string") summary.push(`restart_policy=${restart}`);
    const guest = mm["config"]?.guest;
    if (guest && typeof guest.memory_mb === "number") summary.push(`memory_mb=${guest.memory_mb}`);
    const events = Array.isArray(mm["events"]) ? /** @type {any[]} */ (mm["events"]).slice(0, 8) : [];
    for (const e of events) {
      const x = e?.request?.exit_event;
      const parts = [`event=${String(e?.type)}`, `status=${String(e?.status)}`];
      if (x && typeof x === "object") {
        if (typeof x.exit_code === "number") parts.push(`exit_code=${x.exit_code}`);
        if (typeof x.oom_killed === "boolean") parts.push(`oom_killed=${x.oom_killed}`);
        if (typeof x.signal === "number") parts.push(`signal=${x.signal}`);
        if (typeof x.requested_stop === "boolean") parts.push(`requested_stop=${x.requested_stop}`);
      }
      summary.push(parts.join(" ").replace(/[^\x20-\x7e]/g, "?").slice(0, 160));
    }
    out.push({ id, summary });
  }
  return out;
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

/** T-106c alt komutları (teşhis; sağlık/durum denetimini DEĞİŞTİRMEZ). */
async function diagCommand(/** @type {string[]} */ argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "worker-ids") {
    const i = rest.indexOf("--status-file");
    const file = i >= 0 ? rest[i + 1] : undefined;
    if (file === undefined) {
      console.error("kullanım: deploy-smoke.mjs worker-ids --status-file <json>");
      return 2;
    }
    for (const m of describeStoppedMachines(readFileSync(file, "utf8"))) {
      for (const l of m.summary) console.error(maskLine(`${m.id} ${l}`));
      console.log(m.id);
    }
    return 0;
  }
  if (cmd === "mask-logs") {
    const i = rest.indexOf("--max-lines");
    const max = i >= 0 ? Number(rest[i + 1]) : DIAG_MAX_LINES;
    if (!Number.isInteger(max) || max < 1) {
      console.error("--max-lines pozitif tam sayı olmalı");
      return 2;
    }
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const token = process.env["FLY_API_TOKEN"];
    const { lines, total } = maskLogs(Buffer.concat(chunks).toString("utf8"), { maxLines: max, knownSecrets: token ? [token] : [] });
    for (const l of lines) console.log(l);
    console.log(`worker-diag: ${lines.length} satır yazıldı (toplam ${total}; maskeli)`);
    return 0;
  }
  console.error(`deploy-smoke: bilinmeyen alt komut "${cmd}"`);
  return 2;
}

async function main() {
  const first = process.argv[2];
  if (first === "worker-ids" || first === "mask-logs") return diagCommand(process.argv.slice(2));
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
