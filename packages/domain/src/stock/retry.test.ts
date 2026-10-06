// T-213 retry.ts birim testleri: sınıflandırma, deneme sınırı, jitter aralığı, tükenme (ADR-018 §4, A-75).
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { MAX_ATTEMPTS, isRetryableDbError, jitterDelay, sqlstateOf, withRetry, type RetryReport } from "./retry.ts";

const pgError = (code: string): Error => Object.assign(new Error("pg"), { code });
/** Drizzle gibi sarmalayıcı: kök PG hatası `cause`'da. */
const wrapped = (code: string): Error => Object.assign(new Error("Failed query"), { cause: pgError(code) });

describe("retry sınıflandırması", () => {
  it.each(["40P01", "40001", "55P03"])("%s geçicidir (doğrudan ve cause zincirinde)", (code) => {
    expect(isRetryableDbError(pgError(code))).toBe(true);
    expect(isRetryableDbError(wrapped(code))).toBe(true);
  });
  it.each(["23505", "23514", "23503", "42501", "57014", "08006"])("%s denenmez", (code) => {
    expect(isRetryableDbError(pgError(code))).toBe(false);
    expect(isRetryableDbError(wrapped(code))).toBe(false);
  });
  it("iş kuralı AppError'ı ve SQLSTATE'siz hata denenmez", () => {
    expect(isRetryableDbError(new AppError("INSUFFICIENT_STOCK"))).toBe(false);
    expect(isRetryableDbError(new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" }))).toBe(false);
    expect(isRetryableDbError(new Error("boom"))).toBe(false);
    expect(isRetryableDbError(undefined)).toBe(false);
  });
  it("mapAccessError biçimli sarmalı hata (AppError + cause=40P01/55P03) geçicidir", () => {
    const a = new AppError("VERSION_CONFLICT", { retryable: true });
    a.cause = pgError("40P01");
    const b = new AppError("INTERNAL");
    b.cause = wrapped("55P03");
    expect(isRetryableDbError(a)).toBe(true);
    expect(isRetryableDbError(b)).toBe(true);
    expect(sqlstateOf(b)).toBe("55P03");
  });
  it("beş karakterli olmayan code SQLSTATE sayılmaz (ECONNRESET vb.)", () => {
    expect(sqlstateOf(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeUndefined();
  });
});

describe("withRetry", () => {
  const noSleep = { sleep: async () => undefined };

  it("ilk denemede başarı: 1 deneme, bekleme 0", async () => {
    const reports: RetryReport[] = [];
    await expect(withRetry(async () => 7, { ...noSleep, onDone: (r) => reports.push(r) })).resolves.toBe(7);
    expect(reports).toEqual([{ attempts: 1, totalWaitMs: 0, sqlstate: undefined, outcome: "OK" }]);
  });

  it("geçici hata sonrası başarı: deneme sayısı ve toplam bekleme raporlanır", async () => {
    const reports: RetryReport[] = [];
    const waits: number[] = [];
    let n = 0;
    const result = await withRetry(
      async () => {
        n++;
        if (n < 3) throw wrapped("40P01");
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms), random: () => 0, onDone: (r) => reports.push(r) },
    );
    expect(result).toBe("ok");
    expect(n).toBe(3);
    expect(waits).toEqual([50, 50]);
    expect(reports[0]).toMatchObject({ attempts: 3, totalWaitMs: 100, sqlstate: "40P01", outcome: "OK" });
  });

  it("en çok 3 deneme; tükenince VERSION_CONFLICT + retryable (cause korunur)", async () => {
    let n = 0;
    const reports: RetryReport[] = [];
    const err = await withRetry(
      async () => {
        n++;
        throw pgError("55P03");
      },
      { ...noSleep, onDone: (r) => reports.push(r) },
    ).catch((e: unknown) => e);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(n).toBe(3);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VERSION_CONFLICT");
    expect((err as AppError).retryable).toBe(true);
    expect(sqlstateOf(err)).toBe("55P03");
    expect(reports[0]).toMatchObject({ attempts: 3, outcome: "EXHAUSTED" });
  });

  it("iş kuralı AppError'ı denenmez ve aynen fırlatılır", async () => {
    let n = 0;
    const biz = new AppError("INSUFFICIENT_STOCK");
    const err = await withRetry(async () => {
      n++;
      throw biz;
    }, noSleep).catch((e: unknown) => e);
    expect(n).toBe(1);
    expect(err).toBe(biz);
  });

  it("geçici olmayan SQLSTATE (23514) denenmez", async () => {
    let n = 0;
    await withRetry(async () => {
      n++;
      throw pgError("23514");
    }, noSleep).catch(() => undefined);
    expect(n).toBe(1);
  });

  it("jitter 50-400 ms aralığında ve uçlar dahil", () => {
    expect(jitterDelay(() => 0)).toBe(50);
    expect(jitterDelay(() => 0.999999999)).toBe(400);
    for (let i = 0; i < 500; i++) {
      const d = jitterDelay(Math.random);
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(400);
    }
  });
});
