// T-225 zamanlayıcı birimi: sayaç logu, sayfalama, hata yolunda OK yazılmaması, tenant başına anahtar, durdurma. DB'siz.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { consistencySingletonKey, runConsistencySchedule, startConsistencySchedule } from "./stock-consistency.js";

const logger = () => ({ info: vi.fn(), error: vi.fn() });
const ZERO = "00000000-0000-0000-0000-000000000000";
const ids = (n: number) => Array.from({ length: n }, () => randomUUID()).sort();

describe("runConsistencySchedule", () => {
  it("tüm sayfaları listeler (keyset), her tenant için bir iş yazar, sayıları info loglar", async () => {
    const all = ids(501);
    const list = vi.fn(async (after: string, limit: number) => all.filter((i) => i > after).slice(0, limit));
    const enqueueFor = vi.fn(async () => ({ jobId: randomUUID() }));
    const log = logger();
    const r = await runConsistencySchedule({ listActiveTenantIds: list, enqueueFor, logger: log });
    expect(r).toMatchObject({ listed: 501, enqueued: 501, failed: 0, listFailed: false });
    expect(list.mock.calls.map((c) => c[0])).toEqual([ZERO, all[499]]);
    expect(list.mock.calls.every((c) => c[1] === 500)).toBe(true);
    expect(enqueueFor).toHaveBeenCalledTimes(501);
    expect(log.info).toHaveBeenCalledWith("stock.consistency.scheduled", { listed: 501, enqueued: 501, deduplicated: 0, inactive: 0 });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("listeleme hatası → level=error, 'scheduled' (OK) logu YOK", async () => {
    const log = logger();
    const r = await runConsistencySchedule({
      listActiveTenantIds: async () => {
        throw new Error("db down");
      },
      enqueueFor: vi.fn(),
      logger: log,
    });
    expect(r.listFailed).toBe(true);
    expect(log.error).toHaveBeenCalledWith("stock.consistency.schedule_list_failed", expect.objectContaining({ listed: 0 }));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("kuyruklama hatası sayılır ve error loglanır, diğer tenant'lar yine yazılır; tekilleştirme ve askıdaki tenant ayrı sayılır", async () => {
    const [a, b, c, d] = ids(4) as [string, string, string, string];
    const log = logger();
    const r = await runConsistencySchedule({
      listActiveTenantIds: async (after) => (after === ZERO ? [a, b, c, d] : []),
      enqueueFor: async (id) => {
        if (id === a) throw new Error("x");
        if (id === b) return { jobId: null };
        if (id === c) throw Object.assign(new Error("s"), { code: "TENANT_SUSPENDED" });
        return { jobId: randomUUID() };
      },
      logger: log,
    });
    expect(r).toMatchObject({ listed: 4, enqueued: 1, deduplicated: 1, inactive: 1, failed: 1, listFailed: false });
    expect(log.error).toHaveBeenCalledWith("stock.consistency.schedule_enqueue_failed", { tenantId: a, reason: "Error" });
    expect(log.error).toHaveBeenCalledWith("stock.consistency.schedule_incomplete", expect.objectContaining({ failed: 1 }));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("anahtar tenant kimliğini içerir (SINGLETON_KEY_RE uyumlu, ':' yok)", () => {
    const t = randomUUID();
    expect(consistencySingletonKey(t)).toBe(`stock-consistency/${t}`);
    expect(consistencySingletonKey(t)).toMatch(/^[\w.\-/]+$/);
  });
});

describe("startConsistencySchedule", () => {
  it("açılışta bir koşu + saatlik zamanlayıcı; stop zamanlayıcıyı temizler ve sonraki tikler koşmaz", async () => {
    let tick: (() => void) | undefined;
    const clear = vi.fn();
    const list = vi.fn(async () => [] as string[]);
    const s = startConsistencySchedule({
      listActiveTenantIds: list,
      enqueueFor: vi.fn(),
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
