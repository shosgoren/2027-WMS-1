// Worker heartbeat birimi (T-282): hata yutulmaz/sahte atış yok, zamanlayıcı yaşam döngüsü, kimlik/sürüm kuralları. DB'siz.
import { describe, expect, it, vi } from "vitest";

vi.mock("@wms/db", () => ({ WORKER_HEARTBEAT_INTERVAL_MS: 30_000, recordWorkerHeartbeat: vi.fn() }));

const { beatOnce, startWorkerHeartbeat, workerInstanceId, workerVersion } = await import("./worker-heartbeat.js");

const mkLogger = () => {
  const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) => void logs.push({ level, msg, ...(fields === undefined ? {} : { fields }) });
  return { logs, logger: { info: mk("info"), error: mk("error") } as never };
};
const base = { workerDb: {} as never, jobNames: ["email.send"], instanceId: "m-1", version: "git-0123abc" };
const flush = () => new Promise((r) => setImmediate(r));

describe("beatOnce", () => {
  it("başarıda true; yazıma kimlik, sürüm, tür listesi geçer", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const { logger } = mkLogger();
    expect(await beatOnce({ ...base, logger, record }, new Date(0))).toBe(true);
    expect(record).toHaveBeenCalledWith(base.workerDb, { instanceId: "m-1", version: "git-0123abc", startedAt: new Date(0), jobNames: ["email.send"] });
  });

  it("hata fırlatmaz, error loglar (yalnız sınıf adı), false döner", async () => {
    const record = vi.fn().mockRejectedValue(Object.assign(new Error("postgres://u:secret@h/db"), { name: "PostgresError" }));
    const { logger, logs } = mkLogger();
    expect(await beatOnce({ ...base, logger, record }, new Date(0))).toBe(false);
    expect(logs).toEqual([{ level: "error", msg: "worker.heartbeat.failed", fields: { error: "PostgresError" } }]);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });
});

describe("startWorkerHeartbeat", () => {
  it("açılışta hemen atar, zamanlayıcı kurar; stop zamanlayıcıyı temizler", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const { logger, logs } = mkLogger();
    let fn: (() => void) | undefined;
    const clearTimer = vi.fn();
    const hb = startWorkerHeartbeat({ ...base, logger, record, intervalMs: 10, setTimer: (f) => ((fn = f), "T"), clearTimer });
    await flush();
    expect(record).toHaveBeenCalledTimes(1);
    expect(hb.beats()).toBe(1);
    fn?.();
    await flush();
    expect(record).toHaveBeenCalledTimes(2);
    hb.stop();
    expect(clearTimer).toHaveBeenCalledWith("T");
    expect(logs[0]).toMatchObject({ level: "info", msg: "worker.heartbeat.started" });
  });

  it("önceki atış sürerken yeni atış başlamaz; hata sonrası zamanlayıcı ölmez", async () => {
    let release: (() => void) | undefined;
    const record = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue(undefined);
    const { logger } = mkLogger();
    let fn: (() => void) | undefined;
    const hb = startWorkerHeartbeat({ ...base, logger, record, setTimer: (f) => ((fn = f), 1), clearTimer: () => undefined });
    fn?.();
    expect(record).toHaveBeenCalledTimes(1); // ilk atış hâlâ sürüyor
    release?.();
    await flush();
    fn?.(); // reddedilen atış
    await flush();
    fn?.(); // ölmemiş: yeniden dener
    await flush();
    expect(record).toHaveBeenCalledTimes(3);
    expect(hb.beats()).toBe(2);
  });
});

describe("workerInstanceId / workerVersion", () => {
  it("FLY_MACHINE_ID önceliklidir; geçersiz karakter temizlenir; 64'e kısaltılır", () => {
    expect(workerInstanceId({ FLY_MACHINE_ID: "148e2" } as never, "h", 1)).toBe("148e2");
    expect(workerInstanceId({} as never, "host name", 7)).toBe("host-name-7");
    expect(workerInstanceId({ FLY_MACHINE_ID: "a".repeat(100) } as never, "h", 1)).toHaveLength(64);
  });
  it("sürüm git-<sha> biçiminde; aksi unknown", () => {
    expect(workerVersion({ FLY_IMAGE_REF: "registry.fly.io/x:git-92a1080aa6bc" } as never)).toBe("git-92a1080aa6bc");
    expect(workerVersion({ FLY_IMAGE_REF: "registry.fly.io/x:latest" } as never)).toBe("unknown");
  });
});
