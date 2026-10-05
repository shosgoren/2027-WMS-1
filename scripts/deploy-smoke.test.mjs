import { describe, expect, it } from "vitest";
import { checkHealth, checkProcessGroup, evaluateHealth, parseArgs, summaryLine } from "./deploy-smoke.mjs";

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
