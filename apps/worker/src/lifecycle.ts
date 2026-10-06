// Worker yaşam döngüsü: başlatma, sıralı kapanış kancaları, sinyal ve ölümcül hata işleme.
// Kuyruk tüketimi burada yoktur (T-002c kapsamı); ileride kuyruk/DB havuzu kapanışı
// `register` ile kanca olarak eklenir.
import { createJsonLogger as createSharedJsonLogger, type JsonLogger, type Logger } from "@wms/shared/log";

/** Kapanış zaman aşımı varsayılanı (ms); `WORKER_SHUTDOWN_TIMEOUT_MS` ile değiştirilir. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Kapanış sırasında ikinci sinyal veya ölümcül hata ile çıkış kodu. */
export const EXIT_FAILURE = 1;

export type { LogLevel, Logger } from "@wms/shared/log";

/**
 * Worker logger'ı: her kaydı tek JSON satırı (`ts`, `level`, `msg`, `service:"worker"` + maskelenmiş ek alanlar) olarak
 * yazar. Biçim ve maskeleme `@wms/shared/log` içindedir (T-129); burada yalnızca `service` varsayılanı verilir.
 */
export function createJsonLogger(write?: (line: string) => void, now?: () => Date): JsonLogger {
  return createSharedJsonLogger(write, now, { service: "worker" });
}

/**
 * `WORKER_SHUTDOWN_TIMEOUT_MS` değerini çözer. Tanımsız/boş → varsayılan.
 * Geçersiz değer sessizce varsayılana düşmez; yapılandırma hatası olarak fırlatılır.
 */
export function parseShutdownTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`WORKER_SHUTDOWN_TIMEOUT_MS pozitif tam sayı (ms) olmalı, alınan: ${JSON.stringify(raw)}`);
  }
  return value;
}

export interface ShutdownHook {
  name: string;
  run: () => Promise<void> | void;
}

/** `process` ile test sahtesinin ortak yüzeyi. */
export interface ProcessEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface LifecycleOptions {
  timeoutMs: number;
  logger: Logger;
  exit: (code: number) => void;
}

export interface Lifecycle {
  /** Kapanış kancası ekler; kancalar kayıt sırasıyla çağrılır. */
  register(hook: ShutdownHook): void;
  /** "started" log'unu basar ve süreci açık tutar (iş tüketmez). */
  start(): void;
  /**
   * Kancaları sırayla, toplam `timeoutMs` içinde çalıştırır ve çıkış kodunu döndürür
   * (0 = temiz). Tekrarlanan çağrılar aynı sonucu döndürür, kancaları yeniden çağırmaz.
   */
  stop(reason: string): Promise<number>;
  /** SIGTERM/SIGINT ve yakalanmamış hata/red işleyicilerini kurar. */
  installProcessHandlers(proc: ProcessEvents): void;
}

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { error: { name: err.name, message: err.message, stack: err.stack } };
  }
  return { error: { value: String(err) } };
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const { timeoutMs, logger, exit } = options;
  const hooks: ShutdownHook[] = [];
  let keepAlive: NodeJS.Timeout | undefined;
  let stopping: Promise<number> | undefined;

  const runHooks = async (state: { current: string | undefined }): Promise<number> => {
    let code = 0;
    for (const hook of hooks) {
      state.current = hook.name;
      try {
        await hook.run();
      } catch (err) {
        code = EXIT_FAILURE;
        logger.error("shutdown hook failed", { hook: hook.name, ...describeError(err) });
      }
    }
    state.current = undefined;
    return code;
  };

  const doStop = async (reason: string): Promise<number> => {
    logger.info("shutdown started", { reason, timeoutMs, hooks: hooks.length });
    if (keepAlive !== undefined) {
      clearInterval(keepAlive);
      keepAlive = undefined;
    }
    const state: { current: string | undefined } = { current: undefined };
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const result = await Promise.race([runHooks(state), timedOut]);
      if (result === "timeout") {
        logger.error("shutdown timed out", { reason, timeoutMs, pendingHook: state.current });
        return EXIT_FAILURE;
      }
      if (result === 0) {
        logger.info("shutdown complete", { reason });
      } else {
        logger.error("shutdown completed with errors", { reason });
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  const stop = (reason: string): Promise<number> => {
    stopping ??= doStop(reason);
    return stopping;
  };

  const onSignal = (signal: string): void => {
    if (stopping !== undefined) {
      logger.error("forced exit", { signal, reason: "second signal during shutdown" });
      exit(EXIT_FAILURE);
      return;
    }
    void stop(signal).then(exit);
  };

  const onFatal = (kind: string, err: unknown): void => {
    // Süreç durumu belirsiz: kancalar çalıştırılmaz, hata loglanıp hemen çıkılır.
    logger.error(kind, describeError(err));
    exit(EXIT_FAILURE);
  };

  return {
    register(hook) {
      if (stopping !== undefined) {
        throw new Error(`kapanış başladıktan sonra kanca eklenemez: ${hook.name}`);
      }
      hooks.push(hook);
    },
    start() {
      // Kuyruk tüketicisi yok; event loop'u açık tutan zamanlayıcı süreci bekletir.
      keepAlive ??= setInterval(() => {}, 1 << 30);
      logger.info("started", { pid: process.pid, shutdownTimeoutMs: timeoutMs });
    },
    stop,
    installProcessHandlers(proc) {
      for (const signal of SHUTDOWN_SIGNALS) {
        proc.on(signal, () => onSignal(signal));
      }
      proc.on("uncaughtException", (err) => onFatal("uncaught exception", err));
      proc.on("unhandledRejection", (reason) => onFatal("unhandled rejection", reason));
    },
  };
}
