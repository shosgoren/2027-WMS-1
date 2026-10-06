#!/usr/bin/env node
// Dağıtım sonrası duman testi (T-010 / ADR-013). `deploy-staging.yml` dağıtımdan sonra koşar:
//   node scripts/deploy-smoke.mjs --url https://etkin-wms-staging.fly.dev/api/health \
//     --status-file "$RUNNER_TEMP/fly-status.json" --before-file "$RUNNER_TEMP/fly-status-before.json" \
//     --recheck-file "$RUNNER_TEMP/fly-status-recheck.json"   (iki bayrak ZORUNLU: kararlılık denetimi atlanamaz)
// 1) web: URL → HTTP 200 ve gövde `{"status":"ok"}` (varsa `db` alanı da `ok`, T-106); yeniden deneme + istek başına zaman aşımı
//    (web makinesi `auto_stop_machines` ile durmuş olabilir; ilk istek onu başlatır).
// 2) worker: `flyctl status --json` çıktısında (dosya) `worker` süreç grubunda en az bir makine
//    var ve hepsi `started`. Süreç grubu `config.metadata.fly_process_group` alanındadır
//    (eski ad `process_group`; fly-go v0.11.2 `MachineConfig.ProcessGroup`).
// Bu betik FLY_API_TOKEN görmez: status dosyasını dağıtım adımı yazar.
// Teşhis (T-106c): worker FAIL olursa iş akışı AYRI adımda (FLY_API_TOKEN'lı) makine loglarını bu betiğe borulayarak
// izin listesiyle (ham log yok) yazar: `node scripts/deploy-smoke.mjs worker-ids --status-file F` (başlamamış worker
// makine kimlikleri + olay özeti) ve `... mask-logs [--max-lines 200]` (stdin → izin listeli stdout). Bu alt komutlar
// FLY_API_TOKEN GÖRMEZ (yalnız flyctl çağrısının ortamında); ham log yazılmaz, izin listesi uygulanır.
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

/** Çıktıya yazılan makine kimliği/durumu: dar desene uymazsa `?` (iş akışı komutu `::` enjeksiyonunu önler). */
const RE_MACHINE_ID = /^[a-z0-9]{8,20}$/;
/** @param {unknown} v */
function safeId(v) {
  return typeof v === "string" && RE_MACHINE_ID.test(v) ? v : "?";
}
/** @param {unknown} v */
function safeState(v) {
  return typeof v === "string" && /^[a-z_-]{1,20}$/.test(v) ? v : "?";
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
    return { id: safeId(s.id), state: safeState(s.state) };
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
const HIDDEN_MSG = "[msg gizlendi]";
// İZİN LİSTESİ (allowlist) — kalıp tabanlı maskeleme tamamlanamaz (kaçışlı JSON, boşluklu/kısa/URL-kodlu değerler,
// runner'da bulunmayan Fly uygulama sırları). Bu yüzden ham log ASLA yazılmaz; yalnızca aşağıdaki alanlar/sabit
// ifadeler yeniden üretilir, kalan her satır sayılır ve yazılmaz.
// Gerçek ISO-8601 (tarih T saat[.kesir] Z|±hh:mm); serbest rakam dizisi (telefon vb.) geçmez.
const RE_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RE_LEVEL = /^[a-z]{3,10}$/;
/** Makine durumu/olay sözcükleri (worker-ids özeti). */
const RE_STATE_WORD = /^[a-z_-]{1,20}$/;
// Hata kodu: ≤32 karakter ve YALNIZCA (a) SQLSTATE (5 karakter [0-9A-Z]) ya da (b) harfle başlayan, rakamsız büyük harf
// adı: ya tek sözcük ≤12 karakter (ECONNREFUSED) ya da alt çizgiyle ayrılmış sözcükler (QUEUE_SCHEMA_MISSING). Rakam
// içeren uzun büyük harf/rakam dizileri (base32 TOTP sırrı, kart no) ve uzun tek sözcükler reddedilir.
const RE_CODE = /^(?=.{1,32}$)(?:[A-Z][A-Z_]{2,11}|[A-Z]+(?:_[A-Z]+)+|[0-9A-Z]{5})$/;
// msg: serbest metin YOK; yalnızca worker/kuyruk kodunun yazdığı sabit iletiler (tam eşleşme).
export const ALLOWED_MSGS = new Set([
  "started", "queue started", "queue start failed", "queue error", "invalid configuration", "mail configured",
  "job types without handler", "demo disabled", "demo.reseed done", "demo.reseed failed", "demo.reseed enqueued",
  "demo.reseed enqueue failed", "email sent", "email.send failed", "invitation email sent", "invitation.deliver failed",
  "invitation.deliver skipped", "job handler failed (permanent)", "job handler failed (transient; will retry)", "shutdown started", "shutdown complete",
  "shutdown completed with errors", "shutdown hook failed", "shutdown timed out", "forced exit", "uncaught exception", "unhandled rejection",
  // Sabit iletiler (parantez/büyük harf içerir; tam eşleşme):
  "BETTER_AUTH_URL not set (warning); invitation.deliver jobs will fail until configured",
  "demo disabled: account adapter configuration missing (AUTH_DATABASE_URL); demo.reseed not registered",
  "demo disabled: account adapter configuration missing (DEMO_EMAIL_DOMAIN); demo.reseed not registered",
]);
const RE_ERRCLASS = /^[A-Za-z]{1,40}(?:Error|Exception)$/;
// Worker açılış hatası: yalnızca ortam DEĞİŞKENİ ADI + sabit ifade (değer içermez; main.ts requireEnv).
const RE_MISSING_ENV = /^[A-Z][A-Z0-9_]{2,60} tanımlı değil$/;
const RE_ERR_LINE = /^([A-Za-z]{1,40}(?:Error|Exception))(?:\s\[([^\]\s]{1,40})\])?/;
/** Fly/sistem satırları: [desen, yazılacak sabit metin (grup 1 = sayısal kod ise eklenir)]. */
const SYSTEM_PATTERNS = /** @type {const} */ ([
  [/Main child exited normally with code: (\d{1,3})\b/, "Main child exited normally with code: "],
  [/Main child exited with signal \(with signal '(SIG[A-Z0-9]{2,10})'/, "Main child exited with signal "],
  [/\bexited with code (\d{1,3})\b/, "exited with code "],
  [/Process appears to have been OOM killed/, "Process appears to have been OOM killed"],
  [/Out of memory/, "Out of memory"],
  [/\boom\b/i, "oom"],
  [/Starting init/, "Starting init"],
  [/Preparing to run/, "Preparing to run"],
  [/Virtual machine exited abruptly/, "Virtual machine exited abruptly"],
]);

// flyctl 0.4.111 `logs` (internal/render/logs.go, HideAllocID+HideRegion): başta boşluk, sonra
// `<RFC3339 zaman> <sağlayıcı>[<makine>] <bölge> [<düzey>] <alanlar><mesaj>`. ANSI renkleri önce silinir.
const RE_FLY_PREFIX =
  /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})) ([a-z]{2,12})\[([a-z0-9]{8,20})\] ([a-z]{3}) \[(debug|info|warn|warning|error)\] ?(.*)$/;

/**
 * Tek log satırını izin listesiyle işler. Dönüş: yazılacak güvenli metin ya da `null` (gizlenecek).
 * Fly öneki sıkı regex'le ayrılır (zaman, makine kimliği, düzey sabit alan olarak yazılır); gövdeye izin listesi
 * uygulanır. Önek eşleşmezse gövde = satırın tamamı.
 * @param {string} rawLine
 * @returns {string | null}
 */
export function allowLine(rawLine) {
  const line = rawLine.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const pm = RE_FLY_PREFIX.exec(line);
  if (pm === null) return allowBody(line.trim());
  const body = allowBody((pm[6] ?? "").trim());
  return body === null ? null : `${pm[1]} ${pm[3]} [${pm[5]}] ${body}`;
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function allowBody(line) {
  if (line === "") return null;
  if (line.startsWith("{")) {
    /** @type {unknown} */
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
    const r = /** @type {Record<string, unknown>} */ (o);
    /** @type {Record<string, string>} */
    const out = {};
    const str = (/** @type {unknown} */ v, /** @type {RegExp} */ re) => (typeof v === "string" && re.test(v) ? v : undefined);
    const ts = str(r["time"], RE_TS) ?? str(r["ts"], RE_TS);
    if (ts !== undefined) out["time"] = ts;
    const level = str(r["level"], RE_LEVEL);
    if (level !== undefined) out["level"] = level;
    out["msg"] = typeof r["msg"] === "string" && ALLOWED_MSGS.has(r["msg"]) ? r["msg"] : HIDDEN_MSG;
    const err = typeof r["err"] === "object" && r["err"] !== null ? /** @type {Record<string, unknown>} */ (r["err"]) : {};
    const code = str(r["code"], RE_CODE) ?? str(r["errorCode"], RE_CODE) ?? str(err["code"], RE_CODE);
    if (code !== undefined) out["code"] = code;
    // `error`: düz sınıf adı (dize) ya da lifecycle `describeError` nesnesi {name,message,stack} → yalnızca `.name`.
    const errObj = typeof r["error"] === "object" && r["error"] !== null ? /** @type {Record<string, unknown>} */ (r["error"]) : {};
    const errName = str(err["name"], RE_ERRCLASS) ?? str(r["error"], RE_ERRCLASS) ?? str(errObj["name"], RE_ERRCLASS);
    if (errName !== undefined) out["error"] = errName;
    else {
      const missing = str(r["error"], RE_MISSING_ENV);
      if (missing !== undefined) out["error"] = missing;
    }
    return JSON.stringify(out);
  }
  const m = RE_ERR_LINE.exec(line);
  if (m !== null) return m[2] !== undefined && RE_CODE.test(m[2]) ? `${m[1]} [${m[2]}]` : `${m[1]}`;
  for (const [re, fixed] of SYSTEM_PATTERNS) {
    const x = re.exec(line);
    if (x !== null) return x[1] !== undefined ? `${fixed}${x[1]}` : fixed;
  }
  return null;
}

/**
 * Log metnini son `maxLines` satırla sınırlar; izinli satırlar `worker| ` önekiyle döner, kalanlar yalnızca sayılır.
 * Çıktı `worker| ` ile başlar → `::`/`##[`/`#` ile başlayan satır oluşamaz.
 * @param {string} text
 * @param {{ maxLines?: number }} [opts]
 * @returns {{ lines: string[], total: number, hidden: number, categories: Record<string, number> }}
 */
export function maskLogs(text, opts = {}) {
  const max = opts.maxLines ?? DIAG_MAX_LINES;
  const all = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const tail = all.slice(-max);
  /** @type {string[]} */
  const lines = [];
  let hidden = 0;
  /** @type {Record<string, number>} */
  const categories = {};
  for (const l of tail) {
    const a = allowLine(l);
    if (a === null) {
      hidden++;
      const c = classifyHidden(l);
      categories[c] = (categories[c] ?? 0) + 1;
    } else lines.push(`worker| ${a}`);
  }
  return { lines, total: all.length, hidden, categories };
}

/**
 * Gizlenen satırın TÜRÜ (içerik yazılmaz): `empty` (önek sonrası gövde boş), `fly-system` (Fly öneki var, sağlayıcı
 * `app` değil), `app-json` (gövde geçerli JSON nesnesi ama izin listesinden geçmedi — bu durumda ise izinli alanları
 * olmayan satır), `json-invalid` (`{` ile başlar, JSON değil), `app-text` (Fly öneki, sağlayıcı `app`, düz metin),
 * `unparsed` (Fly öneki yok, JSON değil).
 * @param {string} rawLine
 * @returns {"empty" | "fly-system" | "app-json" | "json-invalid" | "app-text" | "unparsed"}
 */
export function classifyHidden(rawLine) {
  const line = rawLine.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const pm = RE_FLY_PREFIX.exec(line);
  const body = (pm === null ? line : (pm[6] ?? "")).trim();
  if (body === "") return "empty";
  if (body.startsWith("{")) {
    try {
      const o = JSON.parse(body);
      if (typeof o === "object" && o !== null && !Array.isArray(o)) return "app-json";
    } catch {
      /* geçersiz JSON */
    }
    return "json-invalid";
  }
  if (pm === null) return "unparsed";
  return pm[2] === "app" ? "app-text" : "fly-system";
}

/**
 * Başlamamış süreç grubu makineleri: kimlik + durum + son olaylar (yalnızca beyaz listeli alanlar; yapılandırma/env
 * ASLA yazılmaz). Olay alanları (`events[].request.exit_event`) Fly Machines API şemasındandır; yoksa atlanır.
 * @param {string} statusJson
 * @param {string} [group]
 * @param {readonly string[]} [onlyStates] verilirse yalnızca bu durumdaki makineler (ör. ["stopped"])
 * @param {boolean} [includeStarted] true ise `started` makineler de (çökme döngüsü teşhisi)
 * @returns {{ id: string, summary: string[] }[]}
 */
export function describeStoppedMachines(statusJson, group = DEFAULTS.group, onlyStates, includeStarted = false) {
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
    if (mm["state"] === "started" && !includeStarted) continue;
    if (onlyStates !== undefined && !onlyStates.includes(mm["state"])) continue;
    const id = typeof mm["id"] === "string" ? mm["id"] : "";
    if (!/^[a-z0-9]{8,20}$/.test(id)) continue;
    const word = (/** @type {unknown} */ v) => (typeof v === "string" && RE_STATE_WORD.test(v) ? v : "?");
    const summary = [`state=${word(mm["state"])}`];
    const restart = mm["config"]?.restart?.policy;
    if (typeof restart === "string") summary.push(`restart_policy=${word(restart)}`);
    const guest = mm["config"]?.guest;
    if (guest && typeof guest.memory_mb === "number") summary.push(`memory_mb=${guest.memory_mb}`);
    const events = Array.isArray(mm["events"]) ? /** @type {any[]} */ (mm["events"]).slice(0, 8) : [];
    for (const e of events) {
      const x = e?.request?.exit_event;
      const parts = [`event=${word(e?.type)}`, `status=${word(e?.status)}`];
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
 * @param {unknown} machine
 * @returns {{ type: string, status: string, timestamp: number }[]}  (geçersiz/pozitif olmayan zaman damgası → 0)
 */
function eventsOf(machine) {
  const ev = /** @type {{ events?: unknown } | null} */ (machine)?.events;
  if (!Array.isArray(ev)) return [];
  return ev.map((e) => {
    const x = /** @type {{ type?: unknown, status?: unknown, timestamp?: unknown }} */ (e ?? {});
    return { type: String(x.type), status: String(x.status), timestamp: typeof x.timestamp === "number" && Number.isFinite(x.timestamp) && x.timestamp > 0 ? x.timestamp : 0 };
  });
}

/**
 * `later` içinde `earlier`'da bulunmayan olaylar (çoklu küme farkı). Zamana DAYANMAZ: Machines olayında kimlik yok;
 * `Timestamp` ms epoch'tur (fly-go v0.11.2 machine_types.go:294-304) ama saat karşılaştırması yerine anahtar
 * `tür+durum+zaman damgası` ile fark alınır (runner/Fly saat farkından bağımsız).
 * @param {{ type: string, status: string, timestamp: number }[]} later
 * @param {{ type: string, status: string, timestamp: number }[]} earlier
 */
function newEvents(later, earlier) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  const key = (/** @type {{ type: string, status: string, timestamp: number }} */ e) => `${e.type}|${e.status}|${e.timestamp}`;
  // Zaman damgası geçersiz/pozitif değilse (0) olay HER ZAMAN yeni sayılır (güvenli taraf).
  for (const e of earlier) if (e.timestamp > 0) seen.set(key(e), (seen.get(key(e)) ?? 0) + 1);
  return later.filter((e) => {
    if (e.timestamp <= 0) return true;
    const n = seen.get(key(e)) ?? 0;
    if (n > 0) {
      seen.set(key(e), n - 1);
      return false;
    }
    return true;
  });
}

/**
 * Worker kararlılığı (T-106c): yanlış yeşili önler. Üç örnek: `before` (başlatma adımından önce), `after` (başlatma +
 * bekleme sonrası), `recheck` (kısa aralıkla ikinci örnek). Her worker makinesi için: `recheck`'te de `started`;
 * `before`'dan beri `exit`/`restart` olayı YOK; `start` olayı en çok 1 (bizim başlattığımız; 2+ = çökme döngüsü);
 * `after` ile `recheck` arasında yeni start/exit/restart olayı YOK.
 * @param {string} beforeJson
 * @param {string} afterJson
 * @param {string} recheckJson
 * @param {string} [group]
 * @returns {CheckResult}
 */
export function checkWorkerStability(beforeJson, afterJson, recheckJson, group = DEFAULTS.group) {
  /** @param {string} j */
  const load = (j) => {
    try {
      const ms = /** @type {{ Machines?: unknown } | null} */ (JSON.parse(j))?.Machines;
      if (!Array.isArray(ms)) return null;
      return ms.filter((m) => processGroupOf(m) === group);
    } catch {
      return null;
    }
  };
  const before = load(beforeJson);
  const after = load(afterJson);
  const recheck = load(recheckJson);
  if (before === null || after === null || recheck === null) return { ok: false, reason: "kararlılık denetimi: durum dosyası okunamadı" };
  /** @param {unknown[]} ms @param {string} id */
  const find = (ms, id) => ms.find((m) => /** @type {{ id?: unknown }} */ (m).id === id);
  /** @type {string[]} */
  const problems = [];
  const idsOf = (/** @type {unknown[]} */ ms) => ms.map((m) => String(/** @type {{ id?: unknown }} */ (m).id)).sort();
  const afterIds = idsOf(after);
  const recheckIds = idsOf(recheck);
  if (afterIds.length === 0) problems.push("worker makinesi yok");
  if (afterIds.join(",") !== recheckIds.join(",")) {
    problems.push(`makine kümesi örnekler arasında farklı (${afterIds.map(safeId).join(",")} ≠ ${recheckIds.map(safeId).join(",")})`);
  }
  // Hem after hem recheck makineleri taranır (küme farkı varsa da her biri denetlenir).
  for (const r of recheck) {
    const rawId = String(/** @type {{ id?: unknown }} */ (r).id);
    const id = safeId(rawId);
    const m = find(after, rawId);
    if (/** @type {{ state?: unknown }} */ (r).state !== "started") {
      problems.push(`${id}: ikinci örnekte started değil`);
      continue;
    }
    if (m === undefined) continue; // küme farkı yukarıda raporlandı
    if (!Array.isArray(/** @type {{ events?: unknown }} */ (m).events) || !Array.isArray(/** @type {{ events?: unknown }} */ (r).events)) {
      problems.push(`${id}: olay listesi (events) yok`);
      continue;
    }
    const prior = find(before, rawId);
    const sinceBefore = newEvents(eventsOf(r), eventsOf(prior));
    // `start` olayı iki aşamalıdır: status `starting` (ara aşama, sayılmaz) ve `started` (tamamlanan başlatma, sayılır).
    // Olay status değerleri kaynakta sabit listeli DEĞİL (fly-go v0.11.2 machine_types.go:296 serbest `Status string`;
    // flyctl machine/status.go:166-171 ham yazar); değerler deploy #28 gözleminden. Bilinmeyen start status'u fail-closed.
    const bad =
      sinceBefore.filter((e) => e.type === "exit" || e.type === "restart").length +
      sinceBefore.filter((e) => e.type === "start" && e.status !== "starting" && e.status !== "started").length;
    const starts = sinceBefore.filter((e) => e.type === "start" && e.status === "started").length;
    const startings = sinceBefore.filter((e) => e.type === "start" && e.status === "starting").length;
    const between = newEvents(eventsOf(r), eventsOf(m)).filter((e) => ["start", "exit", "restart"].includes(e.type)).length;
    if (bad > 0) problems.push(`${id}: başlatmadan sonra ${bad} exit/restart/bilinmeyen-start olayı`);
    if (starts > 1) problems.push(`${id}: ${starts} start/started olayı (çökme döngüsü)`);
    if (startings > 1) problems.push(`${id}: ${startings} start/starting olayı (yeniden başlatma denemesi; çökme döngüsü)`);
    // before'da yok (yeni makine) ya da started değildi → şimdi started: en az bir yeni start olayı ŞART.
    if ((prior === undefined || /** @type {{ state?: unknown }} */ (prior).state !== "started") && /** @type {{ state?: unknown }} */ (m).state === "started" && starts < 1) {
      problems.push(`${id}: önce durmuş, sonra started ama yeni start olayı yok`);
    }
    if (between > 0) problems.push(`${id}: örnekler arasında ${between} yeni start/exit/restart olayı`);
  }
  if (problems.length > 0) return { ok: false, reason: `"${group}" kararsız: ${problems.join("; ")}` };
  return { ok: true, reason: `"${group}" kararlı (exit/restart yok, start ≤ 1, iki örnekte started)` };
}

/**
 * @param {string[]} argv
 * @returns {{ url: string, statusFile: string, group: string, beforeFile: string, recheckFile: string }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const m = /^--(url|status-file|group|before-file|recheck-file)(?:=(.*))?$/.exec(a);
    if (m === null) throw new Error(`bilinmeyen argüman "${a}"`);
    const key = m[1] ?? "";
    const v = m[2] ?? argv[++i];
    if (v === undefined || v === "") throw new Error(`--${key} bir değer ister`);
    out[key] = v;
  }
  const url = out["url"];
  const statusFile = out["status-file"];
  if (url === undefined || statusFile === undefined) {
    throw new Error("kullanım: deploy-smoke.mjs --url <health-url> --status-file <flyctl-status.json> --before-file <json> --recheck-file <json> [--group worker]");
  }
  if (!/^https:\/\//.test(url)) throw new Error(`--url https olmalı: ${url}`);
  const before = out["before-file"];
  const recheck = out["recheck-file"];
  if (before === undefined || recheck === undefined) {
    throw new Error("--before-file ve --recheck-file zorunlu (kararlılık denetimi atlanamaz)");
  }
  return {
    url,
    statusFile,
    group: out["group"] ?? DEFAULTS.group,
    beforeFile: before,
    recheckFile: recheck,
  };
}

/**
 * @param {CheckResult} web
 * @param {CheckResult} worker
 * @returns {string}
 */
export function summaryLine(web, worker) {
  return `deploy-smoke: web ${web.ok ? "OK" : "FAIL"} · worker ${worker.ok ? "OK" : "FAIL"}`;
}

/**
 * Worker denetimi: süreç grubu `started` + (önce/sonra dosyaları verilmişse) kararlılık. Dosya okunamazsa FAIL.
 * @param {{ statusFile: string, group: string, beforeFile?: string, recheckFile?: string }} args
 * @returns {CheckResult}
 */
export function evaluateWorker(args) {
  try {
    const worker = checkProcessGroup(readFileSync(args.statusFile, "utf8"), args.group);
    if (!worker.ok) return worker;
    if (args.beforeFile === undefined || args.recheckFile === undefined) {
      return { ok: false, reason: "kararlılık denetimi için --before-file/--recheck-file verilmedi (atlanamaz)" };
    }
    const stable = checkWorkerStability(
      readFileSync(args.beforeFile, "utf8"),
      readFileSync(args.statusFile, "utf8"),
      readFileSync(args.recheckFile, "utf8"),
      args.group,
    );
    return stable.ok ? { ok: true, reason: `${worker.reason}; ${stable.reason}` } : stable;
  } catch (err) {
    return { ok: false, reason: `status dosyası okunamadı: ${err instanceof Error ? err.message : String(err)}` };
  }
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
    for (const m of describeStoppedMachines(readFileSync(file, "utf8"), DEFAULTS.group, undefined, rest.includes("--all"))) {
      for (const l of m.summary) console.error(`worker| ${m.id} ${l}`);
      console.log(m.id);
    }
    return 0;
  }
  if (cmd === "worker-stopped-ids") {
    // `flyctl machine start` için: YALNIZCA `stopped` worker makineleri; kimlik deseni describeStoppedMachines'te doğrulanır.
    const i = rest.indexOf("--status-file");
    const file = i >= 0 ? rest[i + 1] : undefined;
    if (file === undefined) {
      console.error("kullanım: deploy-smoke.mjs worker-stopped-ids --status-file <json>");
      return 2;
    }
    for (const m of describeStoppedMachines(readFileSync(file, "utf8"), DEFAULTS.group, ["stopped"])) console.log(m.id);
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
    const { lines, total, hidden, categories } = maskLogs(Buffer.concat(chunks).toString("utf8"), { maxLines: max });
    for (const l of lines) console.log(l);
    console.log(`worker-diag: ${lines.length} satır yazıldı (toplam ${total}; gizlenen satır: ${hidden}${hidden > 0 ? ` [${Object.entries(categories).sort().map(([k, v]) => `${k}=${v}`).join(", ")}]` : ""}; izin listesi)`);
    return 0;
  }
  console.error(`deploy-smoke: bilinmeyen alt komut "${cmd}"`);
  return 2;
}

async function main() {
  const first = process.argv[2];
  if (first === "worker-ids" || first === "worker-stopped-ids" || first === "mask-logs") return diagCommand(process.argv.slice(2));
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`deploy-smoke: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const web = await checkHealth(args.url, { log: (l) => console.log(l) });
  console.log(`web: ${web.ok ? "OK" : "FAIL"} — ${web.reason} (${web.attempts} deneme)`);
  const worker = evaluateWorker(args);
  console.log(`worker: ${worker.ok ? "OK" : "FAIL"} — ${worker.reason}`);
  console.log(summaryLine(web, worker));
  return web.ok && worker.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
