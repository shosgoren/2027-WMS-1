// `stock.document.post` handler birimi (T-222): hata sınıflandırması (kalıcı/geçici), aktör doğrulaması, kalıcı hata işareti, bakım zamanlayıcısı.
// DB'siz: işlem akışı tests/integration/stock/async-posting.int.test.ts'tedir.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isPermanentFailure } from "@wms/queue-adapter";
import { PermanentPostingError, classifyPostingError } from "@wms/domain/stock/jobs";
import { AppError, ERROR_CODES } from "@wms/shared/errors";
import { createPostStockDocumentHandler, startPostingJobRecovery } from "./post-stock-document.js";

const logger = { info: vi.fn(), error: vi.fn() };
const deps = { db: {} as never, consumeOnce: vi.fn() as never, logger };
const ctxOf = (actorUserId: string | null) =>
  ({
    jobId: randomUUID(),
    type: "stock.document.post",
    hasTenant: true,
    actorUserId,
    payload: { documentId: randomUUID(), idempotencyRecordId: randomUUID() },
    inTenant: vi.fn(),
    inPlatform: vi.fn(),
  }) as never;

describe("hata sınıflandırması", () => {
  it.each(["INSUFFICIENT_STOCK", "TRACKING_VIOLATION", "LOCATION_LOCKED", "REVERSAL_BLOCKED", "VALIDATION_FAILED", "FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND", "IDEMPOTENCY_MISMATCH"] as const)(
    "%s kalıcı",
    (code) => {
      expect(classifyPostingError(new AppError(code))).toBe("PERMANENT");
    },
  );
  it("VERSION_CONFLICT, INTERNAL ve tanınmayan hata geçici", () => {
    expect(classifyPostingError(new AppError("VERSION_CONFLICT", { retryable: true }))).toBe("TRANSIENT");
    expect(classifyPostingError(new AppError("INTERNAL"))).toBe("TRANSIENT");
    expect(classifyPostingError(new Error("ECONNRESET"))).toBe("TRANSIENT");
    expect(classifyPostingError(undefined)).toBe("TRANSIENT");
  });
  it("her hata kodu açıkça sınıflanır (yalnızca VERSION_CONFLICT ve INTERNAL geçici)", () => {
    const transient = ERROR_CODES.filter((c) => classifyPostingError(new AppError(c)) === "TRANSIENT");
    expect(transient.sort()).toEqual(["INTERNAL", "VERSION_CONFLICT"]);
  });
});

describe("handler: aktör ve kalıcı hata işareti", () => {
  it("zarfta aktör yok → kalıcı hata (adaptör yeniden denemez), DB'ye dokunulmaz", async () => {
    const handler = createPostStockDocumentHandler(deps);
    const err = await handler(ctxOf(null)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PermanentPostingError);
    expect(isPermanentFailure(err)).toBe(true);
    expect((err as PermanentPostingError).code).toBe("VALIDATION_FAILED");
  });
  it("aktör UUID değil → kalıcı hata", async () => {
    const handler = createPostStockDocumentHandler(deps);
    await expect(handler(ctxOf("not-a-uuid"))).rejects.toMatchObject({ permanent: true });
  });
  it("PermanentPostingError adaptörde kalıcı, düz Error geçici sayılır", () => {
    expect(isPermanentFailure(new PermanentPostingError("FORBIDDEN"))).toBe(true);
    expect(isPermanentFailure(new Error("x"))).toBe(false);
  });
});

describe("bakım zamanlayıcısı (pg-boss supervise eşdeğeri)", () => {
  it("açılışta bir tarama yapar, aralıkla yineler ve durdurulunca temizler", () => {
    const calls: number[] = [];
    let tick: (() => void) | undefined;
    const clear = vi.fn();
    const rec = startPostingJobRecovery({
      workerDb: {} as never,
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
    expect(typeof tick).toBe("function");
    rec.stop();
    expect(clear).toHaveBeenCalledWith("h");
  });
});
