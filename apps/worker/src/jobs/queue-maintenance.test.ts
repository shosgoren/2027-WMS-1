// Kuyruk bakımı birimi (T-281): tür bağımsız kurtarma turu, alarm/metrik logları, zamanlayıcı yaşam döngüsü. DB'siz; gerçek davranış
// tests/integration/queue/crash-recovery.int.test.ts'tedir (SIGKILL).
import { beforeEach, describe, expect, it, vi } from "vitest";

const requeueExpiredJobs = vi.fn();
const finalizeFailedPostingJobs = vi.fn();
vi.mock("@wms/queue-adapter", () => ({ requeueExpiredJobs: (tx: unknown) => requeueExpiredJobs(tx) }));
vi.mock("@wms/domain/stock/jobs", () => ({ finalizeFailedPostingJobs: (d: unknown) => finalizeFailedPostingJobs(d) }));
vi.mock("@wms/db", () => ({
  withUser: (_db: unknown, _user: string, fn: (tx: unknown) => Promise<unknown>) => fn({ tag: "worker-tx" }),
  withSystemTenant: (_db: unknown, _t: string, _r: string, fn: (tx: unknown) => Promise<unknown>) => fn({ tag: "tenant-tx" }),
}));

const { QUEUE_MAINTENANCE_INTERVAL_MS, runQueueMaintenance, startQueueMaintenance } = await import("./queue-maintenance.js");

interface Rec {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}
const mkLogger = () => {
  const logs: Rec[] = [];
  return {
    logs,
    logger: {
      info: (msg: string, fields?: Record<string, unknown>) => void logs.push({ level: "info", msg, ...(fields === undefined ? {} : { fields }) }),
      error: (msg: string, fields?: Record<string, unknown>) => void logs.push({ level: "error", msg, ...(fields === undefined ? {} : { fields }) }),
    },
  };
};
const base = { workerDb: {} as never, db: {} as never };

beforeEach(() => {
  requeueExpiredJobs.mockReset();
  finalizeFailedPostingJobs.mockReset();
  finalizeFailedPostingJobs.mockResolvedValue({ finalized: 0, deferred: 0 });
});

describe("runQueueMaintenance", () => {
  it("yeniden kuyruğa alınanları info, tükenenleri error (alarm) olarak türe göre loglar", async () => {
    requeueExpiredJobs.mockResolvedValue({
      requeued: [{ id: "j1", type: "email.send" }, { id: "j2", type: "email.send" }, { id: "j3", type: "stock.document.post" }],
      exhausted: [{ id: "j4", type: "invitation.deliver" }],
    });
    const { logs, logger } = mkLogger();
    const r = await runQueueMaintenance({ ...base, logger });
    expect(r).toEqual({ requeued: 3, exhausted: 1 });
    expect(logs.find((l) => l.msg === "queue.maintenance.requeued_expired")).toMatchObject({
      level: "info",
      fields: { count: 3, byType: { "email.send": 2, "stock.document.post": 1 } },
    });
    expect(logs.find((l) => l.msg === "queue.maintenance.expired_exhausted")).toMatchObject({
      level: "error",
      fields: { count: 1, byType: { "invitation.deliver": 1 }, jobIds: ["j4"] },
    });
    expect(finalizeFailedPostingJobs).toHaveBeenCalledTimes(1);
  });

  it("süresi dolan iş yoksa log yazmaz", async () => {
    requeueExpiredJobs.mockResolvedValue({ requeued: [], exhausted: [] });
    const { logs, logger } = mkLogger();
    expect(await runQueueMaintenance({ ...base, logger })).toEqual({ requeued: 0, exhausted: 0 });
    expect(logs).toEqual([]);
  });

  it("hata yutulmaz ama fırlatılmaz: queue.maintenance.failed (yalnızca hata adı) loglanır", async () => {
    requeueExpiredJobs.mockRejectedValue(new TypeError("secret-connection-string"));
    const { logs, logger } = mkLogger();
    await expect(runQueueMaintenance({ ...base, logger })).resolves.toEqual({ requeued: 0, exhausted: 0 });
    expect(logs).toEqual([{ level: "error", msg: "queue.maintenance.failed", fields: { error: "TypeError" } }]);
  });

  it("belge sonlandırma sonucu loglanır", async () => {
    requeueExpiredJobs.mockResolvedValue({ requeued: [], exhausted: [] });
    finalizeFailedPostingJobs.mockResolvedValue({ finalized: 2, deferred: 0 });
    const { logs, logger } = mkLogger();
    await runQueueMaintenance({ ...base, logger });
    expect(logs).toEqual([{ level: "info", msg: "stock.async_post.finalized", fields: { count: 2 } }]);
  });
});

describe("startQueueMaintenance", () => {
  it("açılışta bir tur yapar, aralıkla yineler, toplamları tutar ve durdurulunca zamanlayıcıyı temizler", async () => {
    requeueExpiredJobs.mockResolvedValue({ requeued: [{ id: "j1", type: "demo.reseed" }], exhausted: [] });
    const { logs, logger } = mkLogger();
    const calls: number[] = [];
    let tick: (() => void) | undefined;
    const clear = vi.fn();
    const m = startQueueMaintenance({
      ...base,
      logger,
      intervalMs: 1234,
      setTimer: (fn, ms) => {
        calls.push(ms);
        tick = fn;
        return "h";
      },
      clearTimer: clear,
    });
    expect(calls).toEqual([1234]);
    expect(logs[0]).toMatchObject({ msg: "queue.maintenance.started", fields: { intervalMs: 1234 } });
    await vi.waitFor(() => expect(m.totals()).toEqual({ runs: 1, requeued: 1, exhausted: 0 }));
    tick?.();
    await vi.waitFor(() => expect(m.totals()).toEqual({ runs: 2, requeued: 2, exhausted: 0 }));
    m.stop();
    expect(clear).toHaveBeenCalledWith("h");
  });

  it("önceki tur sürerken yeni tur başlamaz", async () => {
    let release: (() => void) | undefined;
    requeueExpiredJobs.mockImplementation(() => new Promise((res) => (release = () => res({ requeued: [], exhausted: [] }))));
    const { logger } = mkLogger();
    let tick: (() => void) | undefined;
    startQueueMaintenance({ ...base, logger, setTimer: (fn) => ((tick = fn), "h"), clearTimer: () => undefined });
    await vi.waitFor(() => expect(requeueExpiredJobs).toHaveBeenCalledTimes(1));
    tick?.();
    expect(requeueExpiredJobs).toHaveBeenCalledTimes(1);
    release?.();
  });

  it("varsayılan aralık 60 sn", () => {
    expect(QUEUE_MAINTENANCE_INTERVAL_MS).toBe(60_000);
  });
});
