#!/usr/bin/env node
// Zamanlanmış uptime denetimi (T-129, A-44). `.github/workflows/uptime.yml` 15 dakikada bir koşar:
//   node scripts/uptime-check.mjs --base-url https://etkin-wms-staging.fly.dev --expect-text "Demo ortamı"
// 1) `/api/health`: HTTP 200, JSON `status:"ok"`, `db:"ok"`, `queue:"ok"` (kuyruk erişimi + ilerleme), `worker:"ok"` (heartbeat taze; T-282).
//    Bu sunucu tarafı eşiklerin kırmızısı burada FAIL olur; `/api/health/live` (Fly makine kontrolü) DB'ye dokunmaz ve buradan çağrılmaz.
// 2) `/login`: HTTP 200 ve (verildiyse) `--expect-text` metni (staging demo bandı).
// Her istek için TEK ölçüm yanıt süresi eşiği (`--max-ms`, varsayılan 3000). Fly `auto_stop_machines` yüzünden ilk istek makineyi
// başlatır (soğuk başlatma): başarısız/yavaş ilk deneme sayılmaz, 1 yeniden deneme yapılır; karar SON denemeden verilir
// ve soğuk başlatma süresi (ilk denemenin süresi) çıktıya yazılır. Herhangi bir kontrol FAIL → çıkış kodu 1 (iş kırmızı).
// Sır görmez; yanıt gövdesi/başlıkları çıktıya yazılmaz (yalnızca durum kodu, alan adları ve süre).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULTS = Object.freeze({
  maxMs: 3000,
  timeoutMs: 20000,
  retryDelayMs: 5000,
});

/**
 * @typedef {{ ok: boolean, reason: string }} Verdict
 * @typedef {{ status: number, body: string }} Reply
 * @typedef {(url: string, init: { signal: AbortSignal, redirect: "manual" }) => Promise<{ status: number, text(): Promise<string> }>} FetchLike
 * @typedef {{
 *   fetchImpl?: FetchLike, now?: () => number, sleep?: (ms: number) => Promise<unknown>,
 *   maxMs?: number, timeoutMs?: number, retryDelayMs?: number, log?: (line: string) => void,
 * }} Options
 * @typedef {{ name: string, ok: boolean, reason: string, attempts: number, ms: number, coldStartMs: number | undefined }} CheckOutcome
 */

/** FAIL koşulu olan sağlık alanları; çıktıya yalnızca alan adı + durum girer (sayı/gövde yazılmaz). */
export const HEALTH_FIELDS = Object.freeze(["status", "db", "queue", "worker"]);

/**
 * `/api/health` gövdesini değerlendirir. Gövde metni sonuca girmez (yalnızca alan adı).
 * @param {Reply} reply
 * @returns {Verdict}
 */
export function evaluateHealth(reply) {
  if (reply.status !== 200) return { ok: false, reason: `HTTP ${reply.status}` };
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(reply.body);
  } catch {
    return { ok: false, reason: "gövde JSON değil" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "gövde nesne değil" };
  const o = /** @type {Record<string, unknown>} */ (parsed);
  for (const field of HEALTH_FIELDS) {
    if (o[field] !== "ok") return { ok: false, reason: `${field} ok değil` };
  }
  return { ok: true, reason: `HTTP 200 ${HEALTH_FIELDS.join("/")} ok` };
}

/**
 * `/login` yanıtını değerlendirir.
 * @param {Reply} reply
 * @param {string | undefined} expectText
 * @returns {Verdict}
 */
export function evaluateLogin(reply, expectText) {
  if (reply.status !== 200) return { ok: false, reason: `HTTP ${reply.status}` };
  if (expectText !== undefined && expectText !== "" && !reply.body.includes(expectText)) {
    return { ok: false, reason: "beklenen metin yok" };
  }
  return { ok: true, reason: expectText ? "HTTP 200 + beklenen metin" : "HTTP 200" };
}

/**
 * Tek denetim: ölçüm + eşik; başarısızsa 1 yeniden deneme (soğuk başlatma). Karar son denemeden.
 * @param {string} name
 * @param {string} url
 * @param {(reply: Reply) => Verdict} evaluate
 * @param {Options} [opts]
 * @returns {Promise<CheckOutcome>}
 */
export async function runCheck(name, url, evaluate, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? /** @type {FetchLike} */ (fetch);
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? delay;
  const maxMs = opts.maxMs ?? DEFAULTS.maxMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULTS.retryDelayMs;
  const log = opts.log ?? (() => {});
  const attempts = 2;
  /** @type {Verdict} */
  let verdict = { ok: false, reason: "deneme yapılmadı" };
  let ms = 0;
  /** @type {number | undefined} */
  let coldStartMs;
  for (let i = 1; i <= attempts; i++) {
    const started = now();
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
      const body = await res.text();
      ms = Math.round(now() - started);
      verdict = evaluate({ status: res.status, body });
      if (verdict.ok && ms > maxMs) verdict = { ok: false, reason: `yanıt süresi ${ms} ms > ${maxMs} ms` };
    } catch (err) {
      ms = Math.round(now() - started);
      verdict = { ok: false, reason: `istek hatası: ${err instanceof Error ? err.name : "bilinmeyen"}` };
    }
    if (i === 1) coldStartMs = ms;
    if (verdict.ok) return { name, ...verdict, attempts: i, ms, coldStartMs };
    log(`${name}: deneme ${i}/${attempts} başarısız (${verdict.reason}, ${ms} ms)`);
    if (i < attempts) await sleep(retryDelayMs);
  }
  return { name, ...verdict, attempts, ms, coldStartMs };
}

/**
 * @param {string[]} argv
 * @returns {{ baseUrl: string, expectText: string | undefined, maxMs: number }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) throw new Error(`geçersiz argüman: ${key ?? ""}`);
    out[key.slice(2)] = value;
  }
  const baseUrl = out["base-url"];
  if (baseUrl === undefined) throw new Error("kullanım: uptime-check.mjs --base-url <https://host> [--expect-text <metin>] [--max-ms 3000]");
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("--base-url geçerli bir URL olmalı");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("--base-url https olmalı (yalnızca localhost http olabilir)");
  if (url.username !== "" || url.password !== "") throw new Error("--base-url kimlik bilgisi içeremez");
  const maxMs = out["max-ms"] === undefined ? DEFAULTS.maxMs : Number(out["max-ms"]);
  if (!Number.isInteger(maxMs) || maxMs <= 0) throw new Error("--max-ms pozitif tam sayı olmalı");
  return { baseUrl: url.origin, expectText: out["expect-text"], maxMs };
}

/**
 * @param {CheckOutcome[]} outcomes
 * @returns {string}
 */
export function summaryLine(outcomes) {
  return `uptime-check: ${outcomes.map((o) => `${o.name} ${o.ok ? "OK" : "FAIL"}`).join(" · ")}`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`uptime-check: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const log = (/** @type {string} */ l) => console.log(l);
  // Sıra önemli: health ilk istektir ve durmuş makineyi başlatır; /login ısınmış makineye gider.
  const outcomes = [
    await runCheck("health", `${args.baseUrl}/api/health`, evaluateHealth, { maxMs: args.maxMs, log }),
    await runCheck("login", `${args.baseUrl}/login`, (r) => evaluateLogin(r, args.expectText), { maxMs: args.maxMs, log }),
  ];
  for (const o of outcomes) {
    const cold = o.attempts > 1 && o.coldStartMs !== undefined ? `, ilk deneme ${o.coldStartMs} ms (soğuk başlatma olabilir)` : "";
    console.log(`${o.name}: ${o.ok ? "OK" : "FAIL"} — ${o.reason} (${o.ms} ms, ${o.attempts} deneme${cold})`);
  }
  console.log(summaryLine(outcomes));
  return outcomes.every((o) => o.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
