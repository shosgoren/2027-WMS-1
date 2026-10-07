// Worker/kuyruk sağlık değerlendirmesi (T-282): saf eşik mantığı. Gerçek DB davranışı tests/integration/health/worker-health.int.test.ts'tedir.
import { describe, expect, it } from "vitest";
import { WORKER_HEALTH_THRESHOLDS as T, WORKER_HEARTBEAT_INTERVAL_MS, evaluateWorkerMetrics } from "./health.ts";

const clean = { workerAgeSeconds: 5, oldestWaitingSeconds: 0, expiredActive: 0, failedRecent: 0 };

describe("evaluateWorkerMetrics", () => {
  it("temizken worker ve ilerleme ok", () => {
    expect(evaluateWorkerMetrics(clean)).toEqual({ worker: { ok: true }, progress: { ok: true } });
  });

  it("heartbeat yaşı eşiği AŞINCA stale; eşikte hâlâ ok", () => {
    expect(evaluateWorkerMetrics({ ...clean, workerAgeSeconds: T.workerMaxAgeSeconds }).worker).toEqual({ ok: true });
    expect(evaluateWorkerMetrics({ ...clean, workerAgeSeconds: T.workerMaxAgeSeconds + 1 }).worker).toEqual({ ok: false, reason: "stale" });
  });

  it("en eski bekleyen iş eşiği aşınca ilerleme threshold", () => {
    expect(evaluateWorkerMetrics({ ...clean, oldestWaitingSeconds: T.oldestWaitingMaxSeconds }).progress).toEqual({ ok: true });
    expect(evaluateWorkerMetrics({ ...clean, oldestWaitingSeconds: T.oldestWaitingMaxSeconds + 1 }).progress).toEqual({ ok: false, reason: "threshold" });
  });

  it("süresi dolmuş aktif iş ve son başarısız iş (eşik 0) ilerlemeyi kırar; worker etkilenmez", () => {
    expect(evaluateWorkerMetrics({ ...clean, expiredActive: T.expiredActiveMax + 1 })).toEqual({ worker: { ok: true }, progress: { ok: false, reason: "threshold" } });
    expect(evaluateWorkerMetrics({ ...clean, failedRecent: T.failedRecentMax + 1 })).toEqual({ worker: { ok: true }, progress: { ok: false, reason: "threshold" } });
  });

  it("kayıt yoksa ikisi de missing (worker hiç başlamadı)", () => {
    expect(evaluateWorkerMetrics(undefined)).toEqual({ worker: { ok: false, reason: "missing" }, progress: { ok: false, reason: "missing" } });
  });

  it("eşik, atış aralığının en az 3 katıdır (tek kaçan atış yanlış alarm vermez)", () => {
    expect(T.workerMaxAgeSeconds * 1000).toBeGreaterThanOrEqual(3 * WORKER_HEARTBEAT_INTERVAL_MS);
  });
});
