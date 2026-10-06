import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_MSGS, checkWorkerStability, evaluateWorker, classifyHidden, checkHealth, checkProcessGroup, allowLine, describeStoppedMachines, evaluateHealth, maskLogs, parseArgs, summaryLine } from "./deploy-smoke.mjs";

const URL_OK = "https://etkin-wms-staging.fly.dev/api/health";

/**
 * Sıralı yanıt/hata veren sahte fetch; çağrıları kaydeder.
 * @param {Array<{ status: number, body: string } | Error>} script
 */
function fakeFetch(script) {
  /** @type {string[]} */
  const calls = [];
  /** @type {AbortSignal[]} */
  const signals = [];
  /**
   * @param {string} url
   * @param {{ signal: AbortSignal }} init
   */
  const impl = async (url, init) => {
    calls.push(url);
    signals.push(init.signal);
    const next = script[calls.length - 1];
    if (next === undefined) throw new Error("beklenmeyen ek çağrı");
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => next.body };
  };
  return { impl, calls, signals };
}

/**
 * @param {Array<{ id: string, state: string, group?: string, legacyGroup?: string }>} machines
 */
function statusJson(machines) {
  return JSON.stringify({
    Name: "etkin-wms-staging",
    Machines: machines.map((m) => ({
      id: m.id,
      state: m.state,
      config: {
        metadata: {
          ...(m.group === undefined ? {} : { fly_process_group: m.group }),
          ...(m.legacyGroup === undefined ? {} : { process_group: m.legacyGroup }),
        },
      },
    })),
  });
}

describe("evaluateHealth", () => {
  it("200 ve {status:'ok'} → OK", () => {
    expect(evaluateHealth(200, '{"status":"ok"}').ok).toBe(true);
  });

  it("200 dışı durum → FAIL", () => {
    expect(evaluateHealth(503, '{"status":"ok"}')).toEqual({ ok: false, reason: "HTTP 503" });
  });

  it("JSON olmayan gövde → FAIL", () => {
    expect(evaluateHealth(200, "<html>")).toEqual({ ok: false, reason: "gövde JSON değil" });
  });

  it("status alanı ok değil → FAIL", () => {
    const r = evaluateHealth(200, '{"status":"degraded"}');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("beklenmeyen gövde");
  });

  it("null gövde → FAIL", () => {
    expect(evaluateHealth(200, "null").ok).toBe(false);
  });

  it("db alanı yok → mevcut davranış (OK, db beklenmez)", () => {
    expect(evaluateHealth(200, '{"status":"ok"}')).toEqual({ ok: true, reason: 'HTTP 200 {status:"ok"}' });
  });

  it("db alanı 'ok' veya {status:'ok'} → OK", () => {
    expect(evaluateHealth(200, '{"status":"ok","db":"ok"}').ok).toBe(true);
    expect(evaluateHealth(200, '{"status":"ok","db":{"status":"ok"}}').ok).toBe(true);
  });

  it("db alanı ok değil → FAIL (sahte başarı yok)", () => {
    for (const body of [
      '{"status":"ok","db":"down"}',
      '{"status":"ok","db":{"status":"error"}}',
      '{"status":"ok","db":null}',
      '{"status":"ok","db":{}}',
      '{"status":"ok","db":true}',
    ]) {
      const r = evaluateHealth(200, body);
      expect(r.ok, body).toBe(false);
      expect(r.reason).toContain("db alanı ok değil");
    }
  });
});

describe("checkHealth", () => {
  it("ilk denemede başarı → bekleme yok", async () => {
    const f = fakeFetch([{ status: 200, body: '{"status":"ok"}' }]);
    /** @type {number[]} */
    const sleeps = [];
    const r = await checkHealth(URL_OK, {
      fetchImpl: f.impl,
      sleep: async (ms) => sleeps.push(ms),
    });
    expect(r).toEqual({ ok: true, reason: 'HTTP 200 {status:"ok"}', attempts: 1 });
    expect(f.calls).toEqual([URL_OK]);
    expect(sleeps).toEqual([]);
  });

  it("hata ve 503 sonrası 200 → üçüncü denemede OK, aralarda bekler", async () => {
    const f = fakeFetch([
      new Error("ECONNREFUSED"),
      { status: 503, body: "" },
      { status: 200, body: '{"status":"ok"}' },
    ]);
    /** @type {number[]} */
    const sleeps = [];
    /** @type {string[]} */
    const logs = [];
    const r = await checkHealth(URL_OK, {
      fetchImpl: f.impl,
      attempts: 5,
      delayMs: 7,
      sleep: async (ms) => sleeps.push(ms),
      log: (l) => logs.push(l),
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(sleeps).toEqual([7, 7]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("ECONNREFUSED");
    expect(logs[1]).toContain("HTTP 503");
  });

  it("tüm denemeler başarısız → FAIL, son neden, son denemeden sonra bekleme yok", async () => {
    const f = fakeFetch([
      { status: 502, body: "" },
      { status: 502, body: "" },
      { status: 500, body: "" },
    ]);
    /** @type {number[]} */
    const sleeps = [];
    const r = await checkHealth(URL_OK, {
      fetchImpl: f.impl,
      attempts: 3,
      delayMs: 1,
      sleep: async (ms) => sleeps.push(ms),
    });
    expect(r).toEqual({ ok: false, reason: "HTTP 500", attempts: 3 });
    expect(f.calls).toHaveLength(3);
    expect(sleeps).toEqual([1, 1]);
  });

  it("zaman aşımı hatası FAIL nedenine yazılır ve her isteğe sinyal verilir", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const f = fakeFetch([timeout]);
    const r = await checkHealth(URL_OK, { fetchImpl: f.impl, attempts: 1, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("TimeoutError: The operation was aborted due to timeout");
    expect(f.signals).toHaveLength(1);
    expect(f.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("geçersiz deneme sayısı → RangeError", async () => {
    await expect(checkHealth(URL_OK, { attempts: 0 })).rejects.toThrow(RangeError);
  });
});

describe("checkProcessGroup", () => {
  it("worker makineleri started → OK", () => {
    const json = statusJson([
      { id: "w1", state: "started", group: "worker" },
      { id: "a1", state: "stopped", group: "web" },
    ]);
    expect(checkProcessGroup(json)).toEqual({ ok: true, reason: '"worker" 1 makine started' });
  });

  it("eski process_group anahtarı da tanınır", () => {
    const json = statusJson([{ id: "w1", state: "started", legacyGroup: "worker" }]);
    expect(checkProcessGroup(json).ok).toBe(true);
  });

  it("worker makinesi started değil → FAIL, makine ve durum nedende", () => {
    const json = statusJson([
      { id: "w1", state: "started", group: "worker" },
      { id: "w2", state: "stopped", group: "worker" },
    ]);
    expect(checkProcessGroup(json)).toEqual({ ok: false, reason: '"worker" başlamamış makine: w2=stopped' });
  });

  it("worker grubunda makine yok → FAIL", () => {
    const json = statusJson([{ id: "a1", state: "started", group: "web" }]);
    expect(checkProcessGroup(json)).toEqual({ ok: false, reason: '"worker" süreç grubunda makine yok' });
  });

  it("Machines alanı yok → FAIL", () => {
    expect(checkProcessGroup('{"Name":"x"}')).toEqual({
      ok: false,
      reason: "flyctl status çıktısında Machines dizisi yok",
    });
  });

  it("JSON olmayan çıktı → FAIL", () => {
    expect(checkProcessGroup("Error: unauthorized")).toEqual({
      ok: false,
      reason: "flyctl status çıktısı JSON değil",
    });
  });

  it("grup adı parametreyle seçilir", () => {
    const json = statusJson([{ id: "a1", state: "started", group: "web" }]);
    expect(checkProcessGroup(json, "web").ok).toBe(true);
  });
});

describe("parseArgs", () => {
  it("zorunlu argümanlar ve varsayılan grup", () => {
    expect(parseArgs(["--url", URL_OK, "--status-file=/tmp/s.json"])).toEqual({
      url: URL_OK,
      statusFile: "/tmp/s.json",
      group: "worker",
    });
  });

  it("eksik --status-file → hata", () => {
    expect(() => parseArgs(["--url", URL_OK])).toThrow(/kullanım/);
  });

  it("https olmayan URL → hata", () => {
    expect(() => parseArgs(["--url", "http://x/api/health", "--status-file", "s"])).toThrow(/https/);
  });

  it("bilinmeyen argüman → hata", () => {
    expect(() => parseArgs(["--token", "x"])).toThrow(/bilinmeyen/);
  });
});

describe("summaryLine", () => {
  it("iki sonucu tek satırda özetler", () => {
    expect(summaryLine({ ok: true, reason: "" }, { ok: false, reason: "" })).toBe("deploy-smoke: web OK · worker FAIL");
  });
});

describe("worker teşhisi (T-106c) — izin listesi", () => {
  // Sahte değerler çalışma anında üretilir (literal sır yok).
  const rnd = (/** @type {number} */ n = 12) => randomBytes(n).toString("hex");
  const run = (/** @type {string[]} */ lines) => maskLogs(lines.join("\n"));

  it("incelemedeki kaçak örnekleri çıktıda görünmez", () => {
    const pw = rnd(4); // kısa (<32) düz parola
    const long = rnd(20);
    const spaced = `${rnd(3)} ${rnd(3)}`;
    const enc = encodeURIComponent(`p@ss/${rnd(3)}`);
    const lines = [
      JSON.stringify({ msg: "queue start failed", detail: JSON.stringify({ password: pw }) }), // kaçışlı JSON içinde parola
      `{"msg":"boom \\"x","password":"${pw}\\" ${long}"}`, // \" erken bitiş
      `PASSWORD=${spaced} trailing`, // boşluklu değer
      `auth=${pw}`, // liste dışı anahtar
      `postgresql://u:${enc}@h/d`, // URL-encode
      `connect failed ${pw}`, // kısa düz parola
      `##[add-mask]${pw}`,
      `::add-mask::${pw}`,
      `# ${long}`,
    ];
    const r = run(lines);
    const out = r.lines.join("\n");
    for (const secret of [pw, long, spaced, enc, ...spaced.split(" ")]) expect(out).not.toContain(secret);
    for (const l of r.lines) expect(l.startsWith("worker| ")).toBe(true);
    expect(r.lines.some((l) => /^worker\| [#:]/.test(l))).toBe(false);
    expect(r.hidden).toBeGreaterThanOrEqual(7);
  });

  it("gerçek flyctl önekiyle (0.4.111 biçimi) aynı kaçaklar yine gizli kalır", () => {
    const pw = rnd(4);
    const long = rnd(20);
    const spaced = `${rnd(3)} ${rnd(3)}`;
    const enc = encodeURIComponent(`p@ss/${rnd(3)}`);
    const pre = " 2026-10-06T11:32:00Z app[80e32da6490958] fra [error] ";
    const bodies = [
      JSON.stringify({ msg: "queue start failed", detail: JSON.stringify({ password: pw }) }),
      `{"msg":"boom \\"x","password":"${pw}\\" ${long}"}`,
      `PASSWORD=${spaced} trailing`,
      `auth=${pw}`,
      `postgresql://u:${enc}@h/d`,
      `connect failed ${pw}`,
      `##[add-mask]${pw}`,
      `::add-mask::${pw}`,
      `# ${long}`,
    ];
    const r = run(bodies.map((b) => pre + b));
    const out = r.lines.join("\n");
    for (const secret of [pw, long, spaced, enc, ...spaced.split(" ")]) expect(out).not.toContain(secret);
    for (const l of r.lines) expect(l.startsWith("worker| ")).toBe(true);
    expect(r.hidden).toBeGreaterThanOrEqual(7);
  });

  it("önekli eksik env satırı ve önekli sistem satırı görünür", () => {
    const pre = " 2026-10-06T11:32:00Z app[80e32da6490958] fra [error] ";
    const a = allowLine(`${pre}{"ts":"2026-10-06T11:32:00.000Z","level":"error","msg":"invalid configuration","service":"worker","error":"DATABASE_URL_WORKER tanımlı değil"}`) ?? "";
    expect(a.startsWith("2026-10-06T11:32:00Z 80e32da6490958 [error] {")).toBe(true);
    expect(JSON.parse(a.slice(a.indexOf("{")))).toMatchObject({ msg: "invalid configuration", error: "DATABASE_URL_WORKER tanımlı değil" });
    expect(allowLine("\u001b[2m2026-10-06T11:32:01Z\u001b[0m runner[80e32da6490958] fra [info] Main child exited normally with code: 1")).toBe(
      "2026-10-06T11:32:01Z 80e32da6490958 [info] Main child exited normally with code: 1",
    );
    expect(allowLine(`${pre}QueueInstallError [QUEUE_SCHEMA_MISSING]: x`)).toBe("2026-10-06T11:32:00Z 80e32da6490958 [error] QueueInstallError [QUEUE_SCHEMA_MISSING]");
    // önek biçimi bozuksa (makine kimliği geçersiz) önek gövdenin parçası olur ve satır gizlenir
    expect(allowLine('2026-10-06T11:32:00Z app[x;rm] fra [error] {"msg":"a"}')).toBeNull();
  });

  it("msg yalnızca sabit ileti kümesinden; serbest metin gizlenir", () => {
    const k = rnd(8);
    const msgOf = (/** @type {string} */ m) => JSON.parse(allowLine(JSON.stringify({ level: "error", msg: m })) ?? "{}").msg;
    expect(msgOf(`auth failed for ${k}`)).toBe("[msg gizlendi]");
    expect(msgOf("login failed user admin password hunter from 8.8.8.8")).toBe("[msg gizlendi]");
    expect(msgOf(`queue started ${k}`)).toBe("[msg gizlendi]");
    expect(msgOf("queue started")).toBe("queue started");
    expect(msgOf("invalid configuration")).toBe("invalid configuration");
  });

  it("code: rakamlı uzun büyük harf/rakam dizileri (base32 sır, kart no) ve uzun tek sözcük reddedilir", () => {
    const b32 = Array.from(randomBytes(16), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[b % 32]).join("") + "7";
    const card = String(4000000000000000 + (randomBytes(4).readUInt32BE() % 999999999));
    const long = Array.from(randomBytes(20), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[b % 26]).join("");
    const codeOf = (/** @type {string} */ c) => JSON.parse(allowLine(JSON.stringify({ msg: "x", code: c })) ?? "{}").code;
    for (const bad of [b32, card, long, `A${card}`, "E_X1", "ABC1234567890123"]) expect(codeOf(bad)).toBeUndefined();
    for (const good of ["QUEUE_SCHEMA_MISSING", "ECONNREFUSED", "42501", "ENV_NOT_ALLOWED"]) expect(codeOf(good)).toBe(good);
  });

  it("ts: yalnızca gerçek ISO-8601; telefon/serbest rakam dizisi atılır", () => {
    const phone = `+90${String(5000000000 + (randomBytes(4).readUInt32BE() % 99999999))}`;
    const tsOf = (/** @type {string} */ v) => JSON.parse(allowLine(JSON.stringify({ msg: "x", ts: v })) ?? "{}").time;
    expect(tsOf(phone)).toBeUndefined();
    expect(tsOf("0000000000+00")).toBeUndefined();
    expect(tsOf("2026-10-06T11:32:00.123Z")).toBe("2026-10-06T11:32:00.123Z");
  });

  it("JSON olmayan hata satırı: rakam/alt çizgili sınıf adı ve rakamlı köşeli kod reddedilir", () => {
    const tok = rnd(5);
    expect(allowLine(`s3cr3tT0k3n_${tok}Error: x`)).toBeNull();
    expect(allowLine(`s3${tok}Error`)).toBeNull();
    const digits = String(10000000000 + (randomBytes(4).readUInt32BE() % 80000000000));
    expect(allowLine(`PostgresError [${digits}]: x`)).toBe("PostgresError");
    expect(allowLine("PostgresError [QUEUE_SCHEMA_MISSING]")).toBe("PostgresError [QUEUE_SCHEMA_MISSING]");
  });

  it("OSC ve kontrol karakterleri, gövde içinde sahte ikinci önek", () => {
    const secret = rnd();
    const out = maskLogs(`\u001b]0;${secret}\u0007{"msg":"started"}\n\u0000\u0008${secret}\n`).lines.join("\n");
    expect(out).not.toContain(secret);
    expect(out).not.toMatch(/[\u0000-\u0008\u001b]/);
    const pre = "2026-10-06T11:32:00Z app[80e32da6490958] fra [info] ";
    const fake = allowLine(`${pre}{"msg":"queue started"} ${pre}{"msg":"${secret}"}`);
    expect(fake).toBeNull();
    const nested = allowLine(`${pre}${pre}{"msg":"queue started","password":"${secret}"}`);
    expect(nested ?? "").not.toContain(secret);
    expect(nested).toBeNull();
  });

  it("JSON satırı: yalnızca izinli alanlar; fazlalık ve uygunsuz msg elenir", () => {
    const secret = rnd();
    const out = allowLine(
      JSON.stringify({ ts: "2026-10-06T11:32:00.000Z", level: "error", msg: "invalid configuration", service: "worker", requestId: secret, code: "ENV_MISSING", error: "TypeError", url: secret }),
    );
    expect(out).not.toBeNull();
    expect(JSON.parse(out ?? "{}")).toEqual({ time: "2026-10-06T11:32:00.000Z", level: "error", msg: "invalid configuration", code: "ENV_MISSING", error: "TypeError" });
    expect(out).not.toContain(secret);
    expect(JSON.parse(allowLine(JSON.stringify({ level: "info", msg: `Bearer ${secret}` })) ?? "{}").msg).toBe("[msg gizlendi]");
    expect(JSON.parse(allowLine(JSON.stringify({ msg: "x", err: { name: "PostgresError", code: "42501", message: secret } })) ?? "{}")).toMatchObject({ error: "PostgresError" });
    expect(JSON.parse(allowLine(JSON.stringify({ msg: "x", error: "not a class name with spaces" })) ?? "{}").error).toBeUndefined();
  });

  it("eksik ortam değişkeni adı (değer içermez) görünür", () => {
    const o = JSON.parse(allowLine('{"level":"error","msg":"invalid configuration","error":"DATABASE_URL_WORKER tanımlı değil"}') ?? "{}");
    expect(o.error).toBe("DATABASE_URL_WORKER tanımlı değil");
  });

  it("JSON olmayan: hata sınıfı + kod; Fly sistem satırları yalnız sabit kısım + sayı", () => {
    const secret = rnd();
    expect(allowLine(`QueueInstallError [QUEUE_SCHEMA_MISSING]: ${secret}`)).toBe("QueueInstallError [QUEUE_SCHEMA_MISSING]");
    expect(allowLine(`TypeError: ${secret}`)).toBe("TypeError");
    expect(allowLine(`2026-10-06T11:00:00Z app[80e32da6490958] fra [info] Main child exited normally with code: 1 ${secret}`)).toBe(
      "2026-10-06T11:00:00Z 80e32da6490958 [info] Main child exited normally with code: 1",
    );
    expect(allowLine("Process appears to have been OOM killed!")).toBe("Process appears to have been OOM killed");
    expect(allowLine("Out of memory: Killed process 513 (node)")).toBe("Out of memory");
    expect(allowLine("Starting init (commit: abc)")).toBe("Starting init");
    expect(allowLine(`rastgele satır ${secret}`)).toBeNull();
  });

  it("yalnızca son N satır işlenir; özet sayıları doğru", () => {
    const text = Array.from({ length: 250 }, (_, i) => (i % 2 === 0 ? `rastgele ${i}` : `{"level":"info","msg":"queue started"}`)).join("\n") + "\n";
    const r = maskLogs(text, { maxLines: 200 });
    expect(r.total).toBe(250);
    expect(r.lines.length + r.hidden).toBe(200);
    expect(r.lines.at(-1)).toBe('worker| {"level":"info","msg":"queue started"}');
  });

  it("boş log → sıfır satır", () => {
    expect(maskLogs("")).toEqual({ lines: [], total: 0, hidden: 0, categories: {} });
  });
});

describe("describeStoppedMachines (T-106c)", () => {
  const status = JSON.stringify({
    Machines: [
      { id: "80e32da6490958", state: "stopped", config: { metadata: { fly_process_group: "worker" }, guest: { memory_mb: 256 }, env: { X: "gizli" } },
        events: [{ type: "exit", status: "stopped", request: { exit_event: { exit_code: 1, oom_killed: false, requested_stop: false } } }] },
      { id: "148e1234abcdef", state: "stopped", config: { metadata: { fly_process_group: "web" } } },
      { id: "aaaa1111bbbb22", state: "started", config: { metadata: { fly_process_group: "worker" } } },
    ],
  });

  it("yalnızca başlamamış worker makineleri; olay özeti, env yok", () => {
    const r = describeStoppedMachines(status);
    expect(r.map((m) => m.id)).toEqual(["80e32da6490958"]);
    const text = r[0]?.summary.join("\n") ?? "";
    expect(text).toContain("exit_code=1");
    expect(text).toContain("oom_killed=false");
    expect(text).toContain("memory_mb=256");
    expect(text).not.toContain("gizli");
  });

  it("durum/politika/olay sözcükleri izin listesine bağlı", () => {
    const secret = randomBytes(12).toString("hex");
    const st = JSON.stringify({ Machines: [{ id: "80e32da6490958", state: `x ${secret}`, config: { metadata: { fly_process_group: "worker" }, restart: { policy: `on-failure ${secret}` } },
      events: [{ type: `exit ${secret}`, status: "stopped" }] }] });
    const text = (describeStoppedMachines(st)[0]?.summary ?? []).join("\n");
    expect(text).not.toContain(secret);
    expect(text).toContain("state=?");
    expect(text).toContain("status=stopped");
  });

  it("bozuk JSON → boş; güvensiz kimlik atlanır", () => {
    expect(describeStoppedMachines("{")).toEqual([]);
    const bad = JSON.stringify({ Machines: [{ id: "x; rm -rf", state: "stopped", config: { metadata: { fly_process_group: "worker" } } }] });
    expect(describeStoppedMachines(bad)).toEqual([]);
  });
});

describe("diagCommand CLI (T-106c)", () => {
  const script = fileURLToPath(new URL("./deploy-smoke.mjs", import.meta.url));
  const node = (/** @type {string[]} */ args, /** @type {string} */ input = "") =>
    spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });

  it("worker-ids: kimlikler stdout'a, özet stderr'e; yalnızca başlamamış worker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
    const file = path.join(dir, "s.json");
    writeFileSync(file, JSON.stringify({ Machines: [
      { id: "80e32da6490958", state: "stopped", config: { metadata: { fly_process_group: "worker" }, restart: { policy: "on-failure" } },
        events: [{ type: "exit", status: "stopped", request: { exit_event: { exit_code: 1, oom_killed: false } } }] },
      { id: "aaaa1111bbbb22", state: "started", config: { metadata: { fly_process_group: "worker" } } },
    ] }));
    const r = node(["worker-ids", "--status-file", file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("80e32da6490958\n");
    expect(r.stderr).toContain("worker| 80e32da6490958 state=stopped");
    expect(r.stderr).toContain("restart_policy=on-failure");
    expect(r.stderr).toContain("exit_code=1");
    expect(node(["worker-ids"]).status).toBe(2);
  });

  it("mask-logs: özet satırı ve --max-lines doğrulaması", () => {
    const secret = rnd2();
    const input = `{"level":"info","msg":"queue started"}\nrastgele ${secret}\n`;
    const r = node(["mask-logs", "--max-lines", "5"], input);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(secret);
    expect(r.stdout).toContain('worker| {"level":"info","msg":"queue started"}');
    expect(r.stdout).toContain("worker-diag: 1 satır yazıldı (toplam 2; gizlenen satır: 1 [unparsed=1]; izin listesi)");
    for (const bad of ["0", "abc", "-1", "1.5"]) expect(node(["mask-logs", "--max-lines", bad], input).status).toBe(2);
    expect(node(["bilinmeyen"]).status).not.toBe(0);
  });
});

function rnd2() {
  return randomBytes(12).toString("hex");
}

describe("ALLOWED_MSGS kaynak senkron bekçisi (T-106c)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    readdirSync(dir).flatMap((n) => {
      const f = path.join(dir, n);
      if (n === "node_modules" || n === "dist") return [];
      return statSync(f).isDirectory() ? walk(f) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [f] : [];
    });

  it("kaynaktaki sabit logger iletileri ile ALLOWED_MSGS birebir aynı", () => {
    const found = new Set();
    for (const dir of ["apps/worker/src", "packages/queue-adapter/src"]) {
      for (const f of walk(path.join(root, dir))) {
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(/\blogger\??\.(?:info|warn|error|debug)\(\s*"([^"\\]+)"/g)) found.add(m[1]);
      }
    }
    expect(found.size).toBeGreaterThan(10); // tarama gerçekten çalıştı
    // lifecycle.ts `logger.error(kind, …)` ile `uncaught exception` / `unhandled rejection` yazar (onFatal çağrıları).
    const dynamic = new Set(["uncaught exception", "unhandled rejection"]);
    const lifecycle = readFileSync(path.join(root, "apps/worker/src/lifecycle.ts"), "utf8");
    for (const d of dynamic) expect(lifecycle).toContain(`onFatal("${d}"`);
    const expected = new Set([...found, ...dynamic]);
    expect([...expected].filter((m) => !ALLOWED_MSGS.has(m)).sort()).toEqual([]);
    expect([...ALLOWED_MSGS].filter((m) => !expected.has(m)).sort()).toEqual([]);
  });

  it("lifecycle describeError nesnesi: yalnızca error.name yazılır; message/stack asla", () => {
    const secret = randomBytes(12).toString("hex");
    const line = JSON.stringify({ level: "error", msg: "uncaught exception", error: { name: "TypeError", message: secret, stack: secret } });
    const out = allowLine(line) ?? "";
    expect(JSON.parse(out)).toEqual({ level: "error", msg: "uncaught exception", error: "TypeError" });
    expect(out).not.toContain(secret);
    const bad = allowLine(JSON.stringify({ msg: "unhandled rejection", error: { name: `x ${secret}`, value: secret } })) ?? "";
    expect(bad).not.toContain(secret);
    expect(JSON.parse(bad).error).toBeUndefined();
  });
});

describe("gizlenen satır kategorileri (T-106c faz 2)", () => {
  const secret = randomBytes(12).toString("hex");
  const pre = (/** @type {string} */ provider) => `2026-10-06T11:32:00Z ${provider}[80e32da6490958] fra [info] `;

  it("her tür doğru sınıflanır (içerik kullanılmaz)", () => {
    expect(classifyHidden(`${pre("app")}   `)).toBe("empty");
    expect(classifyHidden(`${pre("runner")}Pulling container image ${secret}`)).toBe("fly-system");
    expect(classifyHidden(`${pre("app")}{"msg":"${secret}"}`)).toBe("app-json");
    expect(classifyHidden(`${pre("app")}{"msg":`)).toBe("json-invalid");
    expect(classifyHidden(`${pre("app")}plain text ${secret}`)).toBe("app-text");
    expect(classifyHidden(`plain text ${secret}`)).toBe("unparsed");
    expect(classifyHidden(`{"msg":"${secret}"}`)).toBe("app-json");
  });

  it("maskLogs sayıları ve özet satırı; çıktıda içerik yok", () => {
    const text = [
      `${pre("runner")}a ${secret}`,
      `${pre("runner")}b ${secret}`,
      `${pre("app")}{"msg":"${secret}"}`,
      `${pre("app")}text ${secret}`,
      `raw ${secret}`,
      `${pre("app")}{"msg":"started"}`,
    ].join("\n");
    const r = maskLogs(text);
    // JSON nesnesi satırları izin listesiyle (msg gizlenerek) yazılır → gizli sayılmaz.
    expect(r.hidden).toBe(4);
    expect(r.categories).toEqual({ "fly-system": 2, "app-text": 1, unparsed: 1 });
    expect(r.lines).toHaveLength(2);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./deploy-smoke.mjs", import.meta.url)), "mask-logs"], { input: text, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(cli.stdout).toContain("gizlenen satır: 4 [app-text=1, fly-system=2, unparsed=1]; izin listesi)");
    expect(cli.stdout).not.toContain(secret);
  });
});

describe("worker-stopped-ids (T-106c faz 2)", () => {
  it("yalnızca stopped worker makineleri; created/started/web ve geçersiz kimlik yok", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
    const file = path.join(dir, "s.json");
    const m = (/** @type {string} */ id, /** @type {string} */ state, /** @type {string} */ group) => ({ id, state, config: { metadata: { fly_process_group: group } } });
    writeFileSync(file, JSON.stringify({ Machines: [
      m("8d96110c222578", "stopped", "worker"), m("aaaa1111bbbb22", "started", "worker"), m("bbbb1111cccc22", "created", "worker"),
      m("cccc1111dddd22", "stopped", "web"), m("x; rm -rf", "stopped", "worker"),
    ] }));
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("./deploy-smoke.mjs", import.meta.url)), "worker-stopped-ids", "--status-file", file], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("8d96110c222578\n");
  });
});

describe("checkWorkerStability (T-106c yanlış yeşil önleme)", () => {
  const ev = (/** @type {string} */ type, /** @type {number} */ ts, status = "x") => ({ type, status, timestamp: ts });
  const snap = (/** @type {string} */ state, /** @type {any[]} */ events) =>
    JSON.stringify({ Machines: [{ id: "8d96110c222578", state, config: { metadata: { fly_process_group: "worker" } }, events }] });
  const old = [ev("launch", 1000, "created"), ev("update", 2000, "stopped")];
  const before = snap("stopped", old);
  const withStart = [ev("start", 3000, "started"), ...old];

  it("tek start, exit yok, iki örnekte started → OK", () => {
    expect(checkWorkerStability(before, snap("started", withStart), snap("started", withStart)).ok).toBe(true);
  });

  it("başlatmadan sonra exit olayı → FAIL (recheck'te started görünse bile)", () => {
    const crashed = [ev("exit", 3500, "stopped"), ...withStart];
    const r = checkWorkerStability(before, snap("started", withStart), snap("started", crashed));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exit\/restart/);
  });

  it("iki start (çökme döngüsü) → FAIL", () => {
    const loop = [ev("start", 4000, "started"), ev("exit", 3500, "stopped"), ...withStart];
    const r = checkWorkerStability(before, snap("started", loop), snap("started", loop));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/2 start|çökme döngüsü/);
  });

  it("started ama örnekler arasında yeni start/restart → FAIL", () => {
    const again = [ev("start", 5000, "started"), ...withStart];
    const r = checkWorkerStability(before, snap("started", withStart), snap("started", [ev("restart", 4500), ...again]));
    expect(r.ok).toBe(false);
  });

  it("ikinci örnekte durmuş → FAIL; okunamayan dosya → FAIL", () => {
    expect(checkWorkerStability(before, snap("started", withStart), snap("stopped", withStart)).ok).toBe(false);
    expect(checkWorkerStability(before, "{", snap("started", withStart)).ok).toBe(false);
  });

  it("parseArgs + evaluateWorker: kararsız worker FAIL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
    const f = (/** @type {string} */ n, /** @type {string} */ c) => {
      writeFileSync(path.join(dir, n), c);
      return path.join(dir, n);
    };
    expect(parseArgs(["--url", URL_OK, "--status-file", "s", "--before-file", "b", "--recheck-file", "r"])).toMatchObject({ beforeFile: "b", recheckFile: "r" });
    expect(() => parseArgs(["--url", URL_OK, "--status-file", "s", "--before-file", "b"])).toThrow(/birlikte/);
    const crashed = [ev("exit", 3500, "stopped"), ...withStart];
    const sFile = f("s.json", snap("started", withStart));
    const ok = { statusFile: sFile, group: "worker", beforeFile: f("b.json", before), recheckFile: f("r.json", snap("started", withStart)) };
    expect(evaluateWorker(ok).ok).toBe(true);
    expect(evaluateWorker({ ...ok, recheckFile: f("r2.json", snap("started", crashed)) })).toMatchObject({ ok: false, reason: expect.stringContaining('"worker" kararsız') });
    expect(evaluateWorker({ ...ok, recheckFile: path.join(dir, "yok.json") }).ok).toBe(false);
    expect(evaluateWorker({ statusFile: sFile, group: "worker" }).ok).toBe(true); // geriye uyumlu: dosyalar yoksa yalnız started
  });
});

describe("worker-ids --all (T-106c)", () => {
  it("started makineleri de listeler (çökme döngüsü logları için)", () => {
    const st = JSON.stringify({ Machines: [{ id: "aaaa1111bbbb22", state: "started", config: { metadata: { fly_process_group: "worker" } } }] });
    expect(describeStoppedMachines(st)).toEqual([]);
    expect(describeStoppedMachines(st, "worker", undefined, true).map((m) => m.id)).toEqual(["aaaa1111bbbb22"]);
  });
});
