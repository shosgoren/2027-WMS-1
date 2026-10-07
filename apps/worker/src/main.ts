// Worker giriş noktası: `node dist/main.js`. Web'den bağımsız, uzun ömürlü süreç (ADR-001).
import { DEMO_TENANT_ID, createDbClient, withSystemTenant, withUser } from "@wms/db";
import { consumeOnce, createJobQueue } from "@wms/queue-adapter";
import { findAbandonedCounts } from "@wms/domain/operations";
import type { ConsumeOnceFn } from "@wms/domain/stock/jobs";
import { assertMailModeAllowed, loadMailConfig } from "@wms/shared/mailer";
import { createSealer } from "@wms/shared/seal";
import { JOB_TYPES, PLATFORM_NO_USER_ID, type JobHandler, type JobType } from "@wms/shared/queue";
import { createDeliverInvitationHandler } from "./jobs/deliver-invitation.js";
import { startCountAbandonSchedule } from "./jobs/count-abandon.js";
import { DEMO_RESEED_SINGLETON_KEY, registerDemoReseed } from "./jobs/demo-reseed.js";
import { createPostStockDocumentHandler } from "./jobs/post-stock-document.js";
import { startQueueMaintenance } from "./jobs/queue-maintenance.js";
import { consistencySingletonKey, createStockConsistencyHandler, startConsistencySchedule } from "./jobs/stock-consistency.js";
import { createMailer, createSendEmailHandler } from "./jobs/send-email.js";
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
// Koşullu/henüz yazılmamış türler açıkça listelenir: `demo.reseed` yalnızca demo açıkken (T-123: WMS_ENV local|staging +
// DEMO_MODE=1 + DEMO_PASSWORD) kaydedilir; aksi halde bu türden işler tüketici gelene kadar kuyrukta bekler (kaybolmaz,
// sahte başarıyla tamamlanmaz). Registry'ye yeni tür eklenirse burada karar verilmeden açılış düşer.
// `stock.document.post` (T-222) ve `stock.consistency.check` (T-225) kaydedildi (ADR-019 §5).
const DEFERRED_JOB_TYPES: readonly JobType[] = ["demo.reseed"];

// Platform işleri (`enqueuePlatform`) için tenant bağlamı BOŞ `wms_app` transaction'ı (processed_events `tenant_id NULL`,
// ADR-019 §2). `@wms/db` genel yüzeyinde bağlamsız transaction yoktur; `withUser` yalnızca `app.current_user_id` kurar
// (tenant bağlamı boş kalır). Sıfır UUID (`PLATFORM_NO_USER_ID`) hiçbir kullanıcıya karşılık gelmez; kuyruk actor olarak reddeder (kart eki önerisi: özel `withPlatformTx`).

// İki ayrı bağlantı (T-115c): kuyruk tüketimi `DATABASE_URL_WORKER` (wms_worker: yalnızca pgboss iş tablosu, tüm
// tenant'ların işleri) ile; tenant verisine erişim `DATABASE_URL` (wms_app, RLS + withSystemTenant) ile. wms_app
// pg-boss `fail` yolu için gereken DELETE yetkisine sahip değildir; wms_worker tenant verisine hiç erişemez.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    logger.error("invalid configuration", { error: `${name} tanımlı değil` });
    process.exit(EXIT_FAILURE);
  }
  return value;
}
const databaseUrl = requireEnv("DATABASE_URL");
const workerDatabaseUrl = requireEnv("DATABASE_URL_WORKER");

// E-posta (T-116): geçersiz MAIL_MODE veya boş/kısa/yer tutucu QUEUE_SEAL_KEY açılışta hata verir (yerel dahil).
// Hata mesajları değer içermez (G-09).
try {
  const mailConfig = loadMailConfig(process.env);
  // mailpit kipi yalnızca WMS_ENV local|ci (T-117 inceleme MINOR-3): staging/production'da açılış reddedilir.
  assertMailModeAllowed(mailConfig, process.env.WMS_ENV?.trim());
  HANDLERS["email.send"] = createSendEmailHandler({
    sealer: createSealer(process.env.QUEUE_SEAL_KEY),
    config: mailConfig,
    mailer: createMailer(mailConfig),
    logger,
  });
  const appBaseUrl = process.env.BETTER_AUTH_URL?.trim() || undefined;
  if (appBaseUrl === undefined) logger.info("BETTER_AUTH_URL not set (warning); invitation.deliver jobs will fail until configured");
  HANDLERS["invitation.deliver"] = createDeliverInvitationHandler({
    config: mailConfig,
    mailer: createMailer(mailConfig),
    logger,
    appBaseUrl,
  });
  logger.info("mail configured", { mode: mailConfig.mode });
} catch (err) {
  logger.error("invalid configuration", { error: err instanceof Error ? err.message : String(err) });
  process.exit(EXIT_FAILURE);
}

// Handler'lar tenant verisine yalnızca `ctx.inTenant` ile erişir; bu, withSystemTenant ile (tenant ACTIVE
// denetimli, transaction-local bağlam) kurulur (ADR-016 §6). Havuz ayarları `DB_CLIENT_SETTINGS` ile aynıdır.
const db = createDbClient({ url: databaseUrl, poolMax: 10, prepare: false });

// Eşik üstü belge işleme (T-222): istek sahibi adına tek transaction; `processed_events` aynı transaction'da (ADR-019 §2).
HANDLERS["stock.document.post"] = createPostStockDocumentHandler({ db, consumeOnce: consumeOnce as unknown as ConsumeOnceFn, logger });

// Tutarlılık denetimi (T-225): salt okur + alarm; `processed_events` aynı transaction'da (ADR-019 §2, §8).
HANDLERS["stock.consistency.check"] = createStockConsistencyHandler({ consumeOnce: consumeOnce as unknown as ConsumeOnceFn, logger });

const undecided = JOB_TYPES.filter((t) => HANDLERS[t] === undefined && !DEFERRED_JOB_TYPES.includes(t));
if (undecided.length > 0) {
  logger.error("job types without handler", { types: undecided });
  process.exit(EXIT_FAILURE);
}

// Demo (T-123/T-123a, A-63): fail-closed; ayrıntı registerDemoReseed'de. Kapalıyken `wms_auth` havuzu açılmaz, bağdaştırıcı
// (ve argon2 yerel ikilisi) yüklenmez. Rol/ortam hataları açılışı düşürür.
let demo: Awaited<ReturnType<typeof registerDemoReseed>>;
try {
  demo = await registerDemoReseed({
    env: process.env,
    db,
    logger,
    openAuthDb: (url) => createDbClient({ url, poolMax: 2, prepare: false }),
  });
} catch (err) {
  const code = (err as { code?: unknown } | null)?.code;
  logger.error("invalid configuration", { error: err instanceof Error ? err.name : "unknown", ...(typeof code === "string" ? { code } : {}) });
  process.exit(EXIT_FAILURE);
}
if (demo.handler !== undefined) HANDLERS["demo.reseed"] = demo.handler;

const queue = createJobQueue({
  connectionString: workerDatabaseUrl,
  runInTenant: (tenantId, reason, fn) => withSystemTenant(db, tenantId, `queue.${reason}`, fn),
  runPlatform: (fn) => withUser(db, PLATFORM_NO_USER_ID, fn),
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
  deferred: DEFERRED_JOB_TYPES.filter((t) => HANDLERS[t] === undefined),
});

// pg-boss bakım eşdeğeri (T-281; T-222 taramasını genelleştirir): adaptör `supervise: false`; süresi dolan `active` iş (her tür) `wms_worker`
// bağlantısında `retry`/`failed` yapılır ve `failed` belge işlerinin belgeleri serbest bırakılır (çöken worker'ın işi yeniden teslim edilir; AC-16).
const workerDb = createDbClient({ url: workerDatabaseUrl, poolMax: 1, prepare: false });
const queueMaintenance = startQueueMaintenance({ workerDb, db, logger });

// Demo yeniden tohumlama zamanlaması: açılışta bir kez + günlük 03:00 UTC; `singletonKey` ile tek iş.
const demoSchedule = demo.startSchedule(() =>
  // Tenant kimliği sabittir (iş yükünde yok); bağlam withSystemTenant ile kurulur (gerekçe üyelik/rol yazmaz).
  withSystemTenant(db, DEMO_TENANT_ID, "demo.schedule", (tx) =>
    queue.enqueue(tx, { type: "demo.reseed", payload: {}, singletonKey: DEMO_RESEED_SINGLETON_KEY }),
  ),
);

// Tutarlılık zamanlayıcısı (T-225, A-74): açılışta bir kez + saatte bir; tenant listesi `wms_worker` + dar işlev, kuyruklama tenant başına `withSystemTenant`.
const consistencySchedule = startConsistencySchedule({
  listActiveTenantIds: (after, limit) => queue.listActiveTenantIds(after, limit),
  enqueueFor: (tenantId) =>
    withSystemTenant(db, tenantId, "stock.consistency.schedule", (tx) =>
      queue.enqueue(tx, { type: "stock.consistency.check", payload: {}, singletonKey: consistencySingletonKey(tenantId) }),
    ),
  logger,
});

// Terk edilmiş sayım alarmı (T-309, A-136): açılışta bir kez + saatte bir; salt okuma, kilidi açmaz (yalnızca yetkili iptal/onay kapatır).
const countAbandonSchedule = startCountAbandonSchedule({
  listActiveTenantIds: (after, limit) => queue.listActiveTenantIds(after, limit),
  checkFor: (tenantId) => withSystemTenant(db, tenantId, "stock.count.abandon.check", (tx) => findAbandonedCounts(tx, tenantId)),
  logger,
});

// Kapanış sırası: önce zamanlayıcı, sonra kuyruk (çalışan işler biter), sonra DB havuzu.
lifecycle.register({ name: "demo-schedule", run: () => demoSchedule?.stop() });
lifecycle.register({ name: "queue-maintenance", run: () => queueMaintenance.stop() });
lifecycle.register({ name: "consistency-schedule", run: () => consistencySchedule.stop() });
lifecycle.register({ name: "count-abandon-schedule", run: () => countAbandonSchedule.stop() });
lifecycle.register({ name: "job-queue", run: () => queue.stop() });
lifecycle.register({ name: "db", run: () => db.close() });
lifecycle.register({ name: "worker-db", run: () => workerDb.close() });
lifecycle.register({ name: "demo-auth-db", run: () => demo.close() });

lifecycle.installProcessHandlers(process);
lifecycle.start();
