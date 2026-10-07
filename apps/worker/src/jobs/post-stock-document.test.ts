// `stock.document.post` handler birimi (T-222): hata sınıflandırması (kalıcı/geçici), aktör doğrulaması, kalıcı hata işareti, bakım zamanlayıcısı.
// DB'siz: işlem akışı tests/integration/stock/async-posting.int.test.ts'tedir.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isPermanentFailure } from "@wms/queue-adapter";
import {
  POSTING_QUEUE_WAIT_ALLOWANCE_SECONDS,
  PermanentPostingError,
  classifyPostingError,
  finalizeFailedPostingJobs,
  postingMfaWindowSeconds,
} from "@wms/domain/stock/jobs";
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
  /** inTenant: 1. çağrı kiracı çözümü, 2. çağrı kalıcı hata yazımı (burada bilerek düşer: yazımın denendiği ve yutulmadığı kanıtlanır). */
  const ctxWithTenant = (actor: string | null) => {
    const inTenant = vi.fn().mockResolvedValueOnce(randomUUID()).mockRejectedValue(new Error("failure write reached"));
    return { ctx: { ...(ctxOf(actor) as object), inTenant } as never, inTenant };
  };
  it("zarfta aktör yok → kalıcı hata yazımı denenir (belge serbest bırakılır), yazım hatası yutulmaz", async () => {
    const { ctx, inTenant } = ctxWithTenant(null);
    await expect(createPostStockDocumentHandler(deps)(ctx)).rejects.toThrow("failure write reached");
    expect(inTenant).toHaveBeenCalledTimes(2);
  });
  it("aktör UUID değil → aynı yol", async () => {
    const { ctx, inTenant } = ctxWithTenant("not-a-uuid");
    await expect(createPostStockDocumentHandler(deps)(ctx)).rejects.toThrow("failure write reached");
    expect(inTenant).toHaveBeenCalledTimes(2);
  });
  it("kiracı çözülemezse (askıda) hata geçici olarak yayılır; kalıcı işaretlenmez", async () => {
    const ctx = { ...(ctxOf(randomUUID()) as object), inTenant: vi.fn().mockRejectedValue(new Error("TENANT_SUSPENDED")) } as never;
    const err = await createPostStockDocumentHandler(deps)(ctx).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isPermanentFailure(err)).toBe(false);
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
      db: {} as never,
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

describe("başarısız işlerin belge sonlandırması (MAJOR-2, bakım taraması)", () => {
  const tenant = randomUUID();
  const job = { id: randomUUID(), tenant_id: tenant, document_id: randomUUID(), record_id: randomUUID(), attempts: null };
  /** `runOnWorker` çağrıları sırayla verilen yanıtları döndürür: [liste, işaretleme, liste(boş)]. */
  const mkDeps = (runInTenant: (t: string) => Promise<unknown>, responses: unknown[][]) => {
    let calls = 0;
    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const deps = {
      runOnWorker: async (fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<unknown>) => fn({ execute: async () => responses[calls++] ?? [] }),
      runInTenant: ((t: string) => runInTenant(t)) as never,
      logger: { info: () => undefined, error: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, ...(fields === undefined ? {} : { fields }) }) },
    };
    return { deps: deps as never, calls: () => calls, logs };
  };
  it("kiracı askıdayken yazım başarısız olur: iş ertelenir (geri çekilme işaretlenir), tek log jobId+tenantId taşır", async () => {
    const { deps, logs } = mkDeps(async () => {
      throw Object.assign(new Error("x"), { code: "TENANT_SUSPENDED" });
    }, [[job], [{ attempts: 1 }], []]);
    expect(await finalizeFailedPostingJobs(deps)).toEqual({ finalized: 0, deferred: 1 });
    expect(logs).toEqual([{ msg: "stock.async_post.finalize_deferred", fields: { jobId: job.id, tenantId: tenant, attempts: 1, reason: "TENANT_SUSPENDED" } }]);
  });
  it("kiracı yoksa (FORBIDDEN) kalıcı atlanır: bir log, ertelenmez", async () => {
    const { deps, logs } = mkDeps(async () => {
      throw Object.assign(new Error("x"), { code: "FORBIDDEN" });
    }, [[job], [], []]);
    expect(await finalizeFailedPostingJobs(deps)).toEqual({ finalized: 0, deferred: 0 });
    expect(logs.map((l) => l.msg)).toEqual(["stock.async_post.finalize_skipped"]);
  });
  it("kapanan kiracı (TENANT_CLOSING) geri alınabilir: kalıcı atlanmaz, geri çekilmeyle ertelenir", async () => {
    const { deps, logs } = mkDeps(async () => {
      throw Object.assign(new Error("x"), { code: "TENANT_CLOSING" });
    }, [[job], [{ attempts: 1 }], []]);
    expect(await finalizeFailedPostingJobs(deps)).toEqual({ finalized: 0, deferred: 1 });
    expect(logs.map((l) => l.msg)).toEqual(["stock.async_post.finalize_deferred"]);
  });
  it("yazım başarılıysa iş sonlandırılır", async () => {
    const { deps, logs } = mkDeps(async () => true, [[job], [], []]);
    expect(await finalizeFailedPostingJobs(deps)).toEqual({ finalized: 1, deferred: 0 });
    expect(logs).toEqual([]);
  });
});

describe("MFA penceresi formülü (MINOR-3): işin kuyruk ayarlarından türetilir", () => {
  const defaults = { expireSeconds: 900, retryLimit: 5, retryDelay: 30, retryBackoff: true } as const;
  it("varsayılan ayarlar: 900×6 + 30×(2+4+8+16+32) + 600 pay", () => {
    expect(postingMfaWindowSeconds(defaults)).toBe(900 * 6 + 30 * 62 + POSTING_QUEUE_WAIT_ALLOWANCE_SECONDS);
  });
  it("geri çekilme kapalı: delay × retryLimit; pay verilebilir", () => {
    expect(postingMfaWindowSeconds({ ...defaults, retryBackoff: false, queueWaitSeconds: 0 })).toBe(900 * 6 + 30 * 5);
  });
  it("deneme yok (retryLimit 0): yalnızca bir deneme süresi + pay", () => {
    expect(postingMfaWindowSeconds({ ...defaults, retryLimit: 0 })).toBe(900 + POSTING_QUEUE_WAIT_ALLOWANCE_SECONDS);
  });
  it("her ayar pencereyi tekdüze büyütür", () => {
    const base = postingMfaWindowSeconds(defaults);
    expect(postingMfaWindowSeconds({ ...defaults, expireSeconds: 901 })).toBeGreaterThan(base);
    expect(postingMfaWindowSeconds({ ...defaults, retryLimit: 6 })).toBeGreaterThan(base);
    expect(postingMfaWindowSeconds({ ...defaults, retryDelay: 31 })).toBeGreaterThan(base);
  });
});
