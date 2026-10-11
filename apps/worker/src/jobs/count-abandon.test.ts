// T-309 terk edilmiş sayım alarmı zamanlayıcısı birimi: alarm logu, sayfalama, hata yolunda OK yazılmaması, askıdaki tenant, durdurma. DB'siz.
// Kilit açmanın OLMADIĞI (alarm yalnız log) DB davranışı tests/integration/operations/counting.int.test.ts'tedir.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AbandonedCount } from "@wms/domain/operations";
import { runCountAbandonCheck, startCountAbandonSchedule } from "./count-abandon.js";

const logger = () => ({ info: vi.fn(), error: vi.fn() });
const ZERO = "00000000-0000-0000-0000-000000000000";
const ids = (n: number) => Array.from({ length: n }, () => randomUUID()).sort();
const abandoned = (over: Partial<AbandonedCount> = {}): AbandonedCount => ({
  sessionId: randomUUID(),
  warehouseId: randomUUID(),
  sessionStatus: "COUNTING",
  lockedLocations: 2,
  openHours: 9.5,
  thresholdHours: 8,
  ...over,
});

describe("runCountAbandonCheck", () => {
  it("tüm sayfaları (keyset) dolaşır; terk edilmiş oturum başına error alarmı (yalnız kimlik ve sayı), özet info", async () => {
    const all = ids(501);
    const hit = abandoned();
    const list = vi.fn(async (after: string, limit: number) => all.filter((i) => i > after).slice(0, limit));
    const checkFor = vi.fn(async (t: string) => (t === all[3] ? [hit] : []));
    const log = logger();
    const r = await runCountAbandonCheck({ listActiveTenantIds: list, checkFor, logger: log });
    expect(r).toEqual({ listed: 501, alarms: 1, inactive: 0, failed: 0, listFailed: false });
    expect(list.mock.calls.map((c) => c[0])).toEqual([ZERO, all[499]]);
    expect(checkFor).toHaveBeenCalledTimes(501);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("stock.count.abandoned", {
      tenantId: all[3], sessionId: hit.sessionId, warehouseId: hit.warehouseId, sessionStatus: "COUNTING", lockedLocations: 2, openHours: 9.5, thresholdHours: 8,
    });
    expect(log.info).toHaveBeenCalledWith("stock.count.abandon_checked", { listed: 501, alarms: 1, inactive: 0 });
  });

  it("alarm yoksa yalnızca info; error yok", async () => {
    const [a] = ids(1) as [string];
    const log = logger();
    const r = await runCountAbandonCheck({ listActiveTenantIds: async (after) => (after === ZERO ? [a] : []), checkFor: async () => [], logger: log });
    expect(r).toMatchObject({ listed: 1, alarms: 0 });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("listeleme hatası → error, 'checked' (OK) logu YOK", async () => {
    const log = logger();
    const r = await runCountAbandonCheck({
      listActiveTenantIds: async () => {
        throw new Error("db down");
      },
      checkFor: vi.fn(),
      logger: log,
    });
    expect(r.listFailed).toBe(true);
    expect(log.error).toHaveBeenCalledWith("stock.count.abandon_list_failed", expect.objectContaining({ listed: 0 }));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("denetim hatası sayılır ve loglanır, diğer tenant'lar yine denetlenir; askıdaki tenant hata değildir", async () => {
    const [a, b, c] = ids(3) as [string, string, string];
    const log = logger();
    const checkFor = vi.fn(async (id: string) => {
      if (id === a) throw new Error("x");
      if (id === b) throw Object.assign(new Error("s"), { code: "TENANT_SUSPENDED" });
      return [abandoned()];
    });
    const r = await runCountAbandonCheck({ listActiveTenantIds: async (after) => (after === ZERO ? [a, b, c] : []), checkFor, logger: log });
    expect(r).toEqual({ listed: 3, alarms: 1, inactive: 1, failed: 1, listFailed: false });
    expect(log.error).toHaveBeenCalledWith("stock.count.abandon_check_failed", { tenantId: a, reason: "Error" });
    expect(log.error).toHaveBeenCalledWith("stock.count.abandon_incomplete", expect.objectContaining({ failed: 1 }));
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("startCountAbandonSchedule", () => {
  it("açılışta bir koşu + saatlik zamanlayıcı; stop zamanlayıcıyı temizler ve sonraki tikler koşmaz", async () => {
    let tick: (() => void) | undefined;
    const clear = vi.fn();
    const list = vi.fn(async () => [] as string[]);
    const s = startCountAbandonSchedule({
      listActiveTenantIds: list,
      checkFor: vi.fn(),
      logger: logger(),
      setTimer: (fn, ms) => {
        expect(ms).toBe(3_600_000);
        tick = fn;
        return "h";
      },
      clearTimer: clear,
    });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    s.stop();
    expect(clear).toHaveBeenCalledWith("h");
    tick?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(list).toHaveBeenCalledTimes(1);
  });
});
