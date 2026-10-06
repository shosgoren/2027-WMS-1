// Stok komutu yeniden deneme (T-213; ADR-018 §4, A-75; 05 §Kilit sözleşmesi).
//
// - Yalnızca geçici veritabanı hataları denenir: `40P01` (deadlock), `40001` (serileştirme), `55P03` (lock_timeout).
//   Sınıflandırma SQLSTATE'e göre ve `cause` zincirinde yapılır: `mapAccessError` ham hatayı `AppError`'a sarsa da kök neden
//   `cause`'da kalır. İş kuralı `AppError`'ı (kökünde geçici SQLSTATE yok) ASLA denenmez.
// - A-75: en çok 3 DENEME (ilk çalıştırma dahil), denemeler arası 50–400 ms tam jitter. Tükenince `VERSION_CONFLICT` + `retryable`.
// - Deneme sayısı ve toplam bekleme yapılandırılmış log alanıdır (`attempts`, `totalWaitMs`, `sqlstate`); değer/kişisel veri yok.
import { AppError } from "@wms/shared/errors";

export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001", "55P03"]);
/** A-75: ilk çalıştırma dahil en çok 3 deneme. */
export const MAX_ATTEMPTS = 3;
export const MIN_DELAY_MS = 50;
export const MAX_DELAY_MS = 400;

/** `cause` zincirindeki ilk 5 karakterli SQLSTATE (sürücü/Drizzle sarmalayıcıları dahil). */
export function sqlstateOf(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur !== undefined && cur !== null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Hata geçici bir veritabanı çakışması mı (yeniden denenebilir)? */
export function isRetryableDbError(e: unknown): boolean {
  const state = sqlstateOf(e);
  return state !== undefined && RETRYABLE_SQLSTATES.has(state);
}

export interface RetryReport {
  /** Çalıştırılan deneme sayısı (ilk dahil). */
  readonly attempts: number;
  /** Denemeler arası uyunan toplam süre (ms). */
  readonly totalWaitMs: number;
  /** Son geçici hatanın SQLSTATE'i (yoksa tanımsız). */
  readonly sqlstate: string | undefined;
  readonly outcome: "OK" | "FAILED" | "EXHAUSTED";
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Test için: uyku ve rastgelelik enjekte edilir. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Her çağrının sonunda (başarı, kalıcı hata, tükenme) bir kez çağrılır; yalnızca sayısal/kod alanları taşır. */
  readonly onDone?: (report: RetryReport) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `[min, max]` aralığında tam jitter (uçlar dahil). */
export function jitterDelay(random: () => number, min: number = MIN_DELAY_MS, max: number = MAX_DELAY_MS): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * `fn`'i geçici hatada en çok `maxAttempts` kez çalıştırır. İş kuralı hatası ve tanınmayan hata aynen fırlatılır.
 * Tükenince `AppError("VERSION_CONFLICT", { retryable: true })` (`cause` = son hata).
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let totalWaitMs = 0;
  let lastState: string | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await fn(attempt);
      options.onDone?.({ attempts: attempt, totalWaitMs, sqlstate: lastState, outcome: "OK" });
      return value;
    } catch (e) {
      if (!isRetryableDbError(e)) {
        options.onDone?.({ attempts: attempt, totalWaitMs, sqlstate: lastState, outcome: "FAILED" });
        throw e;
      }
      lastState = sqlstateOf(e);
      if (attempt >= maxAttempts) {
        options.onDone?.({ attempts: attempt, totalWaitMs, sqlstate: lastState, outcome: "EXHAUSTED" });
        const err = new AppError("VERSION_CONFLICT", { retryable: true });
        err.cause = e;
        throw err;
      }
      const delay = jitterDelay(random, options.minDelayMs, options.maxDelayMs);
      totalWaitMs += delay;
      await sleep(delay);
    }
  }
}
