// T-116d: web gönderen kuyruğu — başlatma süre sınırı ve başarısızlıktan sonra yeniden başlatma.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => ({ list: [] as { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[], hang: true }));
vi.mock("@wms/queue-adapter", () => ({
  createJobQueue: () => {
    const hang = created.hang;
    const q = {
      start: vi.fn(() => (hang ? new Promise<void>(() => undefined) : Promise.resolve())),
      stop: vi.fn(() => Promise.resolve()),
    };
    created.list.push(q);
    return q;
  },
}));

import { QUEUE_START_TIMEOUT_MS, closeSenderQueue, getSenderQueue } from "./queue.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.env.DATABASE_URL = "postgres://u:p@localhost:1/db";
  created.list.length = 0;
  created.hang = true;
});
afterEach(async () => {
  created.hang = false;
  vi.useRealTimers();
  await closeSenderQueue();
  vi.restoreAllMocks();
});

describe("getSenderQueue", () => {
  it("asılı başlatma süre sınırında iptal edilir (örnek kapatılır, söz çözülür); sonraki çağrı yeniden başlatır", async () => {
    const first = getSenderQueue();
    await vi.advanceTimersByTimeAsync(QUEUE_START_TIMEOUT_MS);
    expect(await first).toBeUndefined();
    expect(created.list[0]?.stop).toHaveBeenCalledTimes(1);
    created.hang = false;
    const second = await getSenderQueue();
    expect(second).toBeDefined();
    expect(created.list).toHaveLength(2);
  });
});
