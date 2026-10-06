import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { checkHealth, checkProcessGroup, allowLine, describeStoppedMachines, evaluateHealth, maskLogs, parseArgs, summaryLine } from "./deploy-smoke.mjs";

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

  it("msg içinde rakamlı uzun sözcük (kimlik/anahtar benzeri) gizlenir", () => {
    const k = rnd(8);
    const o = JSON.parse(allowLine(JSON.stringify({ level: "error", msg: `auth failed for ${k}` })) ?? "{}");
    expect(o.msg).toBe("[msg gizlendi]");
    expect(JSON.parse(allowLine(JSON.stringify({ level: "info", msg: "queue started 3 jobs" })) ?? "{}").msg).toBe("queue started 3 jobs");
  });

  it("JSON satırı: yalnızca izinli alanlar; fazlalık ve uygunsuz msg elenir", () => {
    const secret = rnd();
    const out = allowLine(
      JSON.stringify({ ts: "2026-10-06T11:32:00.000Z", level: "error", msg: "invalid configuration", service: "worker", requestId: secret, code: "E_X1", error: "TypeError", url: secret }),
    );
    expect(out).not.toBeNull();
    expect(JSON.parse(out ?? "{}")).toEqual({ time: "2026-10-06T11:32:00.000Z", level: "error", msg: "invalid configuration", code: "E_X1", error: "TypeError" });
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
    const text = Array.from({ length: 250 }, (_, i) => (i % 2 === 0 ? `rastgele ${i}` : `{"level":"info","msg":"satir ${i}"}`)).join("\n") + "\n";
    const r = maskLogs(text, { maxLines: 200 });
    expect(r.total).toBe(250);
    expect(r.lines.length + r.hidden).toBe(200);
    expect(r.lines.at(-1)).toBe('worker| {"level":"info","msg":"satir 249"}');
  });

  it("boş log → sıfır satır", () => {
    expect(maskLogs("")).toEqual({ lines: [], total: 0, hidden: 0 });
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
