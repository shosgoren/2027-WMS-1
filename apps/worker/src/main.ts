// Worker giriş noktası: `node dist/main.js`. Web'den bağımsız, uzun ömürlü süreç (ADR-001).
import { DEMO_TENANT_ID, createDbClient, withSystemTenant } from "@wms/db";
import { createJobQueue } from "@wms/queue-adapter";
import { assertMailModeAllowed, loadMailConfig } from "@wms/shared/mailer";
import { createSealer } from "@wms/shared/seal";
import { JOB_TYPES, type JobHandler, type JobType } from "@wms/shared/queue";
import { createDeliverInvitationHandler } from "./jobs/deliver-invitation.js";
import { DEMO_RESEED_SINGLETON_KEY, registerDemoReseed } from "./jobs/demo-reseed.js";
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
const DEFERRED_JOB_TYPES: readonly JobType[] = ["demo.reseed"];

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

const undecided = JOB_TYPES.filter((t) => HANDLERS[t] === undefined && !DEFERRED_JOB_TYPES.includes(t));
if (undecided.length > 0) {
  logger.error("job types without handler", { types: undecided });
  process.exit(EXIT_FAILURE);
}

// Handler'lar tenant verisine yalnızca `ctx.inTenant` ile erişir; bu, withSystemTenant ile (tenant ACTIVE
// denetimli, transaction-local bağlam) kurulur (ADR-016 §6). Havuz ayarları `DB_CLIENT_SETTINGS` ile aynıdır.
const db = createDbClient({ url: databaseUrl, poolMax: 10, prepare: false });

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

// Demo yeniden tohumlama zamanlaması: açılışta bir kez + günlük 03:00 UTC; `singletonKey` ile tek iş.
const demoSchedule = demo.startSchedule(() =>
  // Tenant kimliği sabittir (iş yükünde yok); bağlam withSystemTenant ile kurulur (gerekçe üyelik/rol yazmaz).
  withSystemTenant(db, DEMO_TENANT_ID, "demo.schedule", (tx) =>
    queue.enqueue(tx, { type: "demo.reseed", payload: {}, singletonKey: DEMO_RESEED_SINGLETON_KEY }),
  ),
);

// Kapanış sırası: önce zamanlayıcı, sonra kuyruk (çalışan işler biter), sonra DB havuzu.
lifecycle.register({ name: "demo-schedule", run: () => demoSchedule?.stop() });
lifecycle.register({ name: "job-queue", run: () => queue.stop() });
lifecycle.register({ name: "db", run: () => db.close() });
lifecycle.register({ name: "demo-auth-db", run: () => demo.close() });

lifecycle.installProcessHandlers(process);
lifecycle.start();
