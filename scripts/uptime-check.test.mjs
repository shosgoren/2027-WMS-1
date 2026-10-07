import { describe, expect, it } from "vitest";
import { DEFAULTS, evaluateHealth, evaluateLogin, parseArgs, runCheck, summaryLine } from "./uptime-check.mjs";

const HEALTH_OK = JSON.stringify({ status: "ok", db: "ok", queue: "ok", worker: "ok", version: "git-abc1234" });

/**
 * Sıralı yanıt/hata veren sahte fetch + sahte saat (gövde okunurken/hata anında `ticks` kadar ilerler).
 * @param {Array<{ status: number, body: string } | Error>} script
 * @param {number[]} [ticks]
 */
function harness(script, ticks = [100, 100]) {
  /** @type {Array<{ url: string, redirect: string }>} */
  const calls = [];
  /** @type {AbortSignal[]} */
  const signals = [];
  /** @type {number[]} */
  const sleeps = [];
  let clock = 0;
  const tickQueue = [...ticks];
  /** @param {string} url @param {{ signal: AbortSignal, redirect: "manual" }} init */
  const fetchImpl = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    signals.push(init.signal);
    const next = script[calls.length - 1];
    if (next === undefined) throw new Error("beklenmeyen ek çağrı");
    if (next instanceof Error) {
      clock += tickQueue.shift() ?? 0;
      throw next;
    }
    return {
      status: next.status,
      text: async () => {
        clock += tickQueue.shift() ?? 0;
        return next.body;
      },
    };
  };
  return { fetchImpl, calls, signals, sleeps, now: () => clock, sleep: async (/** @type {number} */ ms) => void sleeps.push(ms) };
}

describe("evaluateHealth", () => {
  it("worker heartbeat bayat (worker fail) → FAIL; çıktıda yalnız alan adı", () => {
    const body = JSON.stringify({ status: "degraded", db: "ok", queue: "ok", worker: "fail", metrics: { workerAgeSeconds: 99999 } });
    const v = evaluateHealth({ status: 200, body });
    expect(v).toEqual({ ok: false, reason: "status ok değil" });
    const onlyWorker = evaluateHealth({ status: 200, body: JSON.stringify({ status: "ok", db: "ok", queue: "ok", worker: "fail", metrics: { workerAgeSeconds: 99999 } }) });
    expect(onlyWorker).toEqual({ ok: false, reason: "worker ok değil" });
    expect(onlyWorker.reason).not.toContain("99999");
  });
  it("worker alanı hiç yoksa (eski sürüm/eksik yanıt) FAIL: sessiz yeşil yok", () => {
    expect(evaluateHealth({ status: 200, body: JSON.stringify({ status: "ok", db: "ok", queue: "ok" }) })).toEqual({ ok: false, reason: "worker ok değil" });
  });
  it("kuyruk ilerleme kırmızısı (queue fail, worker ok) → FAIL", () => {
    expect(evaluateHealth({ status: 200, body: JSON.stringify({ status: "degraded", db: "ok", queue: "fail", worker: "ok" }) }).ok).toBe(false);
  });
  it("200 + status/db/queue/worker ok → OK", () => expect(evaluateHealth({ status: 200, body: HEALTH_OK }).ok).toBe(true));
  it.each([
    [{ status: 503, body: HEALTH_OK }, "HTTP 503"],
    [{ status: 200, body: "<html>" }, "gövde JSON değil"],
    [{ status: 200, body: "null" }, "gövde nesne değil"],
    [{ status: 200, body: JSON.stringify({ status: "ok" }) }, "db ok değil"],
    [{ status: 200, body: JSON.stringify({ status: "ok", db: "ok", queue: "fail" }) }, "queue ok değil"],
    [{ status: 200, body: JSON.stringify({ status: "degraded", db: "ok", queue: "ok" }) }, "status ok değil"],
    [{ status: 200, body: JSON.stringify({ status: "ok", db: "fail", queue: "ok" }) }, "db ok değil"],
  ])("başarısız: %#", (reply, reason) => {
    const v = evaluateHealth(reply);
    expect(v).toEqual({ ok: false, reason });
  });
  it("gövde metni sonuca girmez", () => {
    expect(evaluateHealth({ status: 200, body: "SECRET-TOKEN-xyz" }).reason).not.toContain("SECRET");
  });
});

describe("evaluateLogin", () => {
  it("200 ve beklenen metin", () => {
    expect(evaluateLogin({ status: 200, body: "<p>Demo ortamı — x</p>" }, "Demo ortamı").ok).toBe(true);
    expect(evaluateLogin({ status: 200, body: "<p>giriş</p>" }, "Demo ortamı")).toEqual({ ok: false, reason: "beklenen metin yok" });
    expect(evaluateLogin({ status: 200, body: "x" }, undefined).ok).toBe(true);
    expect(evaluateLogin({ status: 302, body: "" }, undefined)).toEqual({ ok: false, reason: "HTTP 302" });
  });
});

describe("runCheck", () => {
  const url = "https://etkin-wms-staging.fly.dev/api/health";
  it("ilk denemede başarı: yeniden deneme yok, yönlendirme izlenmez, zaman aşımı sinyali var", async () => {
    const h = harness([{ status: 200, body: HEALTH_OK }], [250]);
    const r = await runCheck("health", url, evaluateHealth, h);
    expect(r).toMatchObject({ ok: true, attempts: 1, ms: 250, coldStartMs: 250 });
    expect(h.calls).toEqual([{ url, redirect: "manual" }]);
    expect(h.signals[0]).toBeInstanceOf(AbortSignal);
    expect(h.sleeps).toEqual([]);
  });

  it("soğuk başlatma: ilk deneme zaman aşımı → 1 yeniden deneme → başarı; soğuk başlatma süresi kayıtlı", async () => {
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const h = harness([timeout, { status: 200, body: HEALTH_OK }], [12000, 300]);
    /** @type {string[]} */
    const logs = [];
    const r = await runCheck("health", url, evaluateHealth, { ...h, log: (l) => logs.push(l) });
    expect(r).toMatchObject({ ok: true, attempts: 2, ms: 300, coldStartMs: 12000 });
    expect(h.sleeps).toEqual([DEFAULTS.retryDelayMs]);
    expect(logs).toEqual(["health: deneme 1/2 başarısız (istek hatası: TimeoutError, 12000 ms)"]);
  });

  it("yavaş ilk yanıt (> eşik) yeniden denenir; ikinci hızlı yanıt geçer", async () => {
    const h = harness([{ status: 200, body: HEALTH_OK }, { status: 200, body: HEALTH_OK }], [9000, 400]);
    const r = await runCheck("health", url, evaluateHealth, h);
    expect(r).toMatchObject({ ok: true, attempts: 2, ms: 400, coldStartMs: 9000 });
  });

  it("iki deneme de eşiği aşarsa FAIL (süre nedeni)", async () => {
    const h = harness([{ status: 200, body: HEALTH_OK }, { status: 200, body: HEALTH_OK }], [4000, 3500]);
    const r = await runCheck("health", url, evaluateHealth, h);
    expect(r).toMatchObject({ ok: false, attempts: 2, reason: "yanıt süresi 3500 ms > 3000 ms" });
  });

  it("eşik sınırı: tam eşik geçer", async () => {
    const h = harness([{ status: 200, body: HEALTH_OK }], [3000]);
    expect((await runCheck("health", url, evaluateHealth, h)).ok).toBe(true);
  });

  it("db fail iki kez → FAIL (yalnızca 1 yeniden deneme)", async () => {
    const bad = { status: 503, body: JSON.stringify({ status: "degraded", db: "fail", queue: "ok" }) };
    const h = harness([bad, bad], [50, 50]);
    const r = await runCheck("health", url, evaluateHealth, h);
    expect(r).toMatchObject({ ok: false, attempts: 2, reason: "HTTP 503" });
    expect(h.calls).toHaveLength(2);
  });

  it("ağ hatası iki kez → FAIL; hata iletisi (URL/ayrıntı) sonuca girmez", async () => {
    const err = new Error("connect ECONNREFUSED https://user:pw@x");
    const h = harness([err, err], [5, 5]);
    const r = await runCheck("health", url, evaluateHealth, h);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("istek hatası: Error");
  });
});

describe("parseArgs / summaryLine", () => {
  it("base-url zorunlu; https zorunlu (yalnızca localhost http); kimlik bilgisi yasak", () => {
    expect(parseArgs(["--base-url", "https://etkin-wms-staging.fly.dev/x?y", "--expect-text", "Demo ortamı"])).toEqual({
      baseUrl: "https://etkin-wms-staging.fly.dev",
      expectText: "Demo ortamı",
      maxMs: 3000,
    });
    expect(parseArgs(["--base-url", "http://localhost:3000", "--max-ms", "1500"])).toMatchObject({ baseUrl: "http://localhost:3000", maxMs: 1500 });
    expect(() => parseArgs([])).toThrow(/kullanım/);
    expect(() => parseArgs(["--base-url", "http://example.com"])).toThrow(/https/);
    expect(() => parseArgs(["--base-url", "https://u:p@example.com"])).toThrow(/kimlik/);
    expect(() => parseArgs(["--base-url", "nope"])).toThrow(/URL/);
    expect(() => parseArgs(["--base-url", "https://a.b", "--max-ms", "0"])).toThrow(/max-ms/);
    expect(() => parseArgs(["--base-url"])).toThrow(/geçersiz/);
  });
  it("özet satırı", () => {
    const o = { reason: "", attempts: 1, ms: 1, coldStartMs: 1 };
    expect(summaryLine([{ name: "health", ok: true, ...o }, { name: "login", ok: false, ...o }])).toBe("uptime-check: health OK · login FAIL");
  });
});
