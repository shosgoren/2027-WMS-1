// Worker giriş noktası: `node dist/main.js`. Web'den bağımsız, uzun ömürlü süreç (ADR-001).
import { createJsonLogger, createLifecycle, EXIT_FAILURE, parseShutdownTimeoutMs } from "./lifecycle.js";

const logger = createJsonLogger();

let timeoutMs: number;
try {
  timeoutMs = parseShutdownTimeoutMs(process.env.WORKER_SHUTDOWN_TIMEOUT_MS);
} catch (err) {
  logger.error("invalid configuration", { error: err instanceof Error ? err.message : String(err) });
  process.exit(EXIT_FAILURE);
}

const lifecycle = createLifecycle({
  timeoutMs,
  logger,
  exit: (code) => process.exit(code),
});

lifecycle.installProcessHandlers(process);
lifecycle.start();
export const t003LintProbe = 1 as any; // T-003 negatif kanıt: tek satır lint hatası (birleştirilmez)
