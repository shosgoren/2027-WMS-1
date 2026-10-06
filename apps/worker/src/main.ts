// Worker giriş noktası: `node dist/main.js`. Web'den bağımsız, uzun ömürlü süreç (ADR-001).
import { createDbClient, withSystemTenant } from "@wms/db";
import { createJobQueue } from "@wms/queue-adapter";
import { JOB_TYPES, type JobHandler, type JobType } from "@wms/shared/queue";
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

// İş türü başına tüketici. T-116 (`email.send`) ve T-123 (`demo.reseed`) kendi handler'larını buraya ekler;
// handler'lar bağlamı `withSystemTenant`/`withMembership` ile kurar (ADR-016 §6).
const HANDLERS: { [T in JobType]?: JobHandler<T> } = {};
// Handler'ı henüz yazılmamış türler açıkça listelenir: bu türden işler tüketici gelene kadar kuyrukta bekler
// (kaybolmaz, sahte başarıyla tamamlanmaz). Registry'ye yeni tür eklenirse burada karar verilmeden açılış düşer.
const DEFERRED_JOB_TYPES: readonly JobType[] = ["email.send", "demo.reseed"];

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  logger.error("invalid configuration", { error: "DATABASE_URL tanımlı değil" });
  process.exit(EXIT_FAILURE);
}

const undecided = JOB_TYPES.filter((t) => HANDLERS[t] === undefined && !DEFERRED_JOB_TYPES.includes(t));
if (undecided.length > 0) {
  logger.error("job types without handler", { types: undecided });
  process.exit(EXIT_FAILURE);
}

// Handler'lar tenant verisine yalnızca `ctx.inTenant` ile erişir; bu, withSystemTenant ile (tenant ACTIVE
// denetimli, transaction-local bağlam) kurulur (ADR-016 §6). Havuz ayarları `DB_CLIENT_SETTINGS` ile aynıdır.
const db = createDbClient({ url: databaseUrl, poolMax: 10, prepare: false });

const queue = createJobQueue({
  connectionString: databaseUrl,
  runInTenant: (tenantId, reason, fn) => withSystemTenant(db, tenantId, `queue.${reason}`, fn),
  stopTimeoutMs: Math.max(1000, timeoutMs - 1000),
  logger,
});

try {
  await queue.start();
  for (const type of JOB_TYPES) {
    const handler = HANDLERS[type] as JobHandler<typeof type> | undefined;
    if (handler !== undefined) await queue.work(type, handler);
  }
} catch (err) {
  // Bağlantı hatası URL içerebilir: yalnızca hata türü ve ad loglanır (G-09).
  logger.error("queue start failed", { error: err instanceof Error ? err.name : "unknown" });
  process.exit(EXIT_FAILURE);
}
logger.info("queue started", {
  registered: JOB_TYPES.filter((t) => HANDLERS[t] !== undefined),
  deferred: DEFERRED_JOB_TYPES,
});

// Kapanış sırası: önce kuyruk (çalışan işler biter), sonra DB havuzu.
lifecycle.register({ name: "job-queue", run: () => queue.stop() });
lifecycle.register({ name: "db", run: () => db.close() });

lifecycle.installProcessHandlers(process);
lifecycle.start();
