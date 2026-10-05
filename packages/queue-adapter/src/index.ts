// `JobQueue` için pg-boss bağdaştırıcısı (ADR-005 eki, ADR-016 §12, T-115). pg-boss'un TEK import noktası.
//
// - `enqueue(tx, job)`: iş, çağıranın tenant transaction'ında (`fromDrizzle(tx, sql)`) yazılır; transaction
//   geri alınırsa iş hiç oluşmaz. Tenant kimliği parametre değildir: `tx` içindeki
//   `current_setting('app.current_tenant_id')` değerinden türetilir (boş/geçersiz → FORBIDDEN).
// - Uygulama ve worker `migrate: false` ile bağlanır; şemayı ve kuyrukları yalnızca migration rolü kurar
//   (`installQueueSchema`; `pnpm db:migrate` sonunda `install-cli.ts` çağrılır). `wms_app` tablo oluşturamaz.
// - Pooler uyumu: pg-boss'un varsayılan yolu yalnızca transaction kapsamlı kilit (`pg_advisory_xact_lock`) ve
//   `SET LOCAL` kullanır; LISTEN yalnızca `useListenNotify` ile açılır (burada kapalı). Bkz. T-115 raporu.
import { currentTenantId, currentUserId, type withTenant } from "@wms/db";
import {
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPES,
  QueueError,
  isJobType,
  parseJob,
  type EnqueueResult,
  type Job,
  type JobHandler,
  type JobQueue,
  type JobType,
} from "@wms/shared/queue";
import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle, type Job as BossJob } from "pg-boss";
import { z } from "zod";

/** Tenant transaction'ı: `@wms/db` genel yüzeyindeki `withTenant` callback'inin `tx` tipi. */
export type TenantTx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** pg-boss şema adı (varsayılan); migration rolü kurar, `wms_app` yalnızca kullanır. */
export const QUEUE_SCHEMA = "pgboss";

/** Kuyruk başına varsayılanlar: yan etki işleri için yeniden deneme + geri çekilme. */
const QUEUE_DEFAULTS = { retryLimit: 5, retryDelay: 30, retryBackoff: true } as const;

/** İş zarfı: tenant kimliği yükten AYRI saklanır; yalnızca `enqueue` yazar. */
const EnvelopeSchema = z
  .object({
    v: z.literal(1),
    tenantId: z.uuid().nullable(),
    actorUserId: z.uuid().nullable(),
    payload: z.unknown(),
  })
  .strict();
type Envelope = z.infer<typeof EnvelopeSchema>;

/** Hata olayı günlüğü: yalnızca ad + SQLSTATE (mesaj bağlantı bilgisi/parola içerebilir, G-09). */
function safeErrorFields(err: unknown): Record<string, unknown> {
  const code = (err as { code?: unknown } | null)?.code;
  return {
    name: err instanceof Error ? err.name : "unknown",
    ...(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { sqlstate: code } : {}),
  };
}

export interface QueueLogger {
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface JobQueueOptions {
  /** Uygulama rolü bağlantısı (`DATABASE_URL`, wms_app). Asla loglanmaz (G-09). */
  readonly connectionString: string;
  /** pg-boss havuzu azami bağlantı sayısı. */
  readonly max?: number;
  /** Zarif kapanışta çalışan işleri bekleme üst sınırı (ms); pg-boss en az 1000 ister. */
  readonly stopTimeoutMs?: number;
  /** Tüketici yoklama aralığı (sn); varsayılan 2. */
  readonly pollingIntervalSeconds?: number;
  /**
   * Tüketen süreç bunu verir: tenant bağlamını kurup `fn`'i çalıştırır (örn. `withSystemTenant`). `reason` iş
   * türüdür. Verilmezse handler'larda `inTenant` hata verir.
   */
  readonly runInTenant?: <R>(tenantId: string, reason: string, fn: (tx: TenantTx) => Promise<R>) => Promise<R>;
  readonly logger?: QueueLogger;
}

export interface PgBossJobQueue extends JobQueue<TenantTx> {
  /** Bağlanır ve şemanın kurulu olduğunu doğrular (`migrate: false`). Tekrar çağrı aynı sözü döndürür. */
  start(): Promise<void>;
}

type Rows = readonly Record<string, unknown>[];

function rowsOf(result: unknown): Rows {
  if (Array.isArray(result)) return result as Rows;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Rows) : [];
}

/** `tx` içindeki tenant bağlamı; kurulmamışsa/UUID değilse FORBIDDEN (ADR-016 §12). */
async function tenantOf(tx: TenantTx): Promise<string> {
  const tenantId = await currentTenantId(tx);
  if (tenantId === undefined) {
    throw new QueueError("FORBIDDEN", "enqueue requires a transaction with a tenant context");
  }
  return tenantId;
}

function envelopeOf(job: Job, tenantId: string | null): Envelope {
  return { v: 1, tenantId, actorUserId: job.actorUserId ?? null, payload: job.payload };
}

/** Tenant'a ve türe kapsamlı anahtar: bir tenant başkasının işini anahtar tahminiyle engelleyemez. */
function scopedKey(tenantId: string | null, key: string): string {
  return `${tenantId ?? "platform"}/${key}`;
}

export function createJobQueue(options: JobQueueOptions): PgBossJobQueue {
  const { connectionString, max = 4, stopTimeoutMs = 10_000, pollingIntervalSeconds = 2, runInTenant, logger } = options;
  const boss = new PgBoss({
    connectionString,
    schema: QUEUE_SCHEMA,
    application_name: "wms-queue",
    max,
    migrate: false,
    createSchema: false,
    // wms_app yönetim tablolarına (queue/version/bam/instance/...) yazamaz: bakım/süpervizyon ve örnek kaydı
    // kapalı. Süresi dolan/tamamlanan işlerin bakımı wms_worker rolüyle T-115c'dedir.
    supervise: false,
    registerInstance: false,
    schedule: false,
    // REINDEX ... CONCURRENTLY tablo sahibi ister; wms_app sahip değildir.
    reindex: false,
    useListenNotify: false,
  });
  boss.on("error", (err) => {
    logger?.error("queue error", safeErrorFields(err));
  });

  let starting: Promise<void> | undefined;
  let ready = false;
  const start = (): Promise<void> => {
    starting ??= boss.start().then(() => {
      ready = true;
    });
    return starting;
  };

  const write = async (job: Job, tenantId: string | null, tx: TenantTx | undefined): Promise<EnqueueResult> => {
    // Bağlantı kurulumu transaction İÇİNDE yapılmaz (küçük havuzlu pooler arkasında açlık/kilitlenme riski):
    // süreç açılışında `await queue.start()` zorunludur.
    if (!ready) throw new Error("job queue is not started; call start() at process boot before enqueue");
    let actor = job.actorUserId ?? null;
    if (tx !== undefined) {
      // İşlemde kimlik bağlamı kuruluysa çağıranın verdiği actor onunla çelişemez; yoksa bağlamdan türetilir.
      const ctxUser = await currentUserId(tx);
      if (ctxUser !== undefined) {
        if (actor !== null && actor.toLowerCase() !== ctxUser.toLowerCase()) {
          throw new QueueError("VALIDATION_FAILED", "actorUserId conflicts with the transaction user context");
        }
        actor = ctxUser;
      }
    }
    const envelope = envelopeOf({ ...job, actorUserId: actor ?? undefined } as Job, tenantId);
    const key = job.singletonKey === undefined ? undefined : scopedKey(tenantId, job.singletonKey);
    if (key !== undefined && tx !== undefined) {
      // Aynı anahtarı eşzamanlı yazan iki transaction sıraya girer (transaction kapsamlı kilit; pooler güvenli);
      // ikincisi birincinin commit'ini görür ve yeni iş yazmaz.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${job.type}|${key}`}, 0))`);
      const existing = rowsOf(
        await tx.execute(
          sql`SELECT 1 AS one FROM ${sql.identifier(QUEUE_SCHEMA)}.job
              WHERE name = ${job.type} AND singleton_key = ${key} AND state IN ('created', 'retry', 'active') LIMIT 1`,
        ),
      );
      if (existing.length > 0) return { jobId: null };
    }
    const jobId = await boss.send(job.type, envelope, {
      ...(key === undefined ? {} : { singletonKey: key }),
      ...(tx === undefined ? {} : { db: fromDrizzle(tx, sql) }),
    });
    return { jobId };
  };

  return {
    start,
    async enqueue(tx, job) {
      const parsed = parseJob(job);
      return write(parsed, await tenantOf(tx), tx);
    },
    async enqueuePlatform(job) {
      // Tek `send` ifadesi kendi (otomatik) transaction'ıdır. Tenant'sız anahtar yarışı sağlayıcının
      // yazımında çözülmez: platform işleri `singletonKey` kullanmamalı.
      const parsed = parseJob(job);
      if (parsed.singletonKey !== undefined) {
        throw new QueueError("VALIDATION_FAILED", "platform jobs do not support singletonKey");
      }
      return write(parsed, null, undefined);
    },
    async work<T extends JobType>(type: T, handler: JobHandler<T, TenantTx>) {
      if (!isJobType(type)) {
        throw new QueueError("VALIDATION_FAILED", "job type is not registered");
      }
      await start();
      await boss.work<unknown>(type, { batchSize: 1, pollingIntervalSeconds }, async (jobs: BossJob<unknown>[]) => {
        for (const bossJob of jobs) {
          const envelope = EnvelopeSchema.parse(bossJob.data);
          const payload = JOB_PAYLOAD_SCHEMAS[type].parse(envelope.payload);
          const { tenantId } = envelope;
          await handler({
            jobId: bossJob.id,
            type,
            hasTenant: tenantId !== null,
            actorUserId: envelope.actorUserId,
            payload,
            inTenant: async (fn) => {
              if (tenantId === null) throw new QueueError("FORBIDDEN", "platform job has no tenant context");
              if (runInTenant === undefined) throw new QueueError("FORBIDDEN", "no tenant runner configured");
              return runInTenant(tenantId, type, fn);
            },
          } as Parameters<JobHandler<T, TenantTx>>[0]);
        }
      });
    },
    async stop() {
      if (starting === undefined) return;
      await boss.stop({ graceful: true, close: true, timeout: Math.max(stopTimeoutMs, 1000) });
    },
  };
}

export interface InstallQueueSchemaOptions {
  /** Migration rolü, doğrudan bağlantı (`DATABASE_URL_DIRECT`). */
  readonly url: string;
}

/** Kurulum hatası: yalnızca ad + SQLSTATE taşır (bağlantı bilgisi sızmaz, G-09). */
export class QueueInstallError extends Error {
  override name = "QueueInstallError";
  readonly sqlstate: string | undefined;
  constructor(message: string, sqlstate?: string) {
    super(message);
    this.sqlstate = sqlstate;
  }
}

const APP_ROLES: readonly string[] = ["wms_app", "wms_auth", "wms_identity_probe"];

/**
 * `wms_app`'e verilen EN DAR yetkiler (kurulu pg-boss 12.36.0 kaynağından: send=`insertJobs` → `job`/`job_common` (ortak bölüm) INSERT;
 * fetch/complete/fail → `job` UPDATE ve SELECT; sürüm denetimi `check()` → `version.version`; kuyruk önbelleği
 * `getQueues` → `queue` SELECT). `bam`, `schedule`, `subscription`, `instance`, `queue_stats`, `warning`,
 * `job_dependency` ve `version`/`queue` YAZMA: hiçbir yetki yok. `bam` komutları migration rolüyle çalıştırılır;
 * bu yüzden `wms_app` oraya yazabilseydi rol ayrımı (I-03) aşılırdı. Önceki geniş yetkiler önce geri alınır.
 */
export const QUEUE_APP_GRANTS_SQL = `
  REVOKE ALL ON ALL TABLES IN SCHEMA ${QUEUE_SCHEMA} FROM wms_app;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${QUEUE_SCHEMA} FROM wms_app;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${QUEUE_SCHEMA} FROM wms_app;
  GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO wms_app;
  GRANT SELECT, INSERT, UPDATE ON ${QUEUE_SCHEMA}.job, ${QUEUE_SCHEMA}.job_common TO wms_app;
  GRANT SELECT ON ${QUEUE_SCHEMA}.queue TO wms_app;
  GRANT SELECT (version) ON ${QUEUE_SCHEMA}.version TO wms_app`;

/** pg-boss'un kendi sürüm migration'larının ürettiği `bam` komutları: yalnızca pg-boss şemasında indeks işi. */
const BAM_COMMAND_RE = new RegExp(
  String.raw`^\s*(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+${QUEUE_SCHEMA}\.\w+|DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?${QUEUE_SCHEMA}\.\w+|ALTER\s+TABLE\s+${QUEUE_SCHEMA}\.\w+\s)`,
  "i",
);

/** İşlenmemiş bir `bam` komutu beklenen biçimde değilse reddeder (fail-closed). Çalıştırma pg-boss'tadır. */
export function assertBamCommandsExpected(commands: readonly string[]): void {
  for (const command of commands) {
    if (!BAM_COMMAND_RE.test(command) || command.replace(/;\s*$/, "").includes(";")) {
      throw new QueueInstallError("unexpected pending pg-boss bam command; refusing to run it with the migration role");
    }
  }
}

function describeFailure(err: unknown): QueueInstallError {
  if (err instanceof QueueInstallError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const sqlstate = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  return new QueueInstallError(`queue schema install failed (${err instanceof Error ? err.name : "unknown"})`, sqlstate);
}

/**
 * pg-boss şemasını kurar/yükseltir, kayıtlı iş türlerinin kuyruklarını oluşturur ve `wms_app`'e en dar yetkileri
 * verir. YALNIZCA migration rolüyle çağrılır (`install-cli.ts`); idempotenttir. Herhangi bir hata kurulumu
 * başarısız sayar (yutulmaz); hata yalnızca ad + SQLSTATE taşır.
 */
export async function installQueueSchema(options: InstallQueueSchemaOptions): Promise<void> {
  const base = {
    connectionString: options.url,
    schema: QUEUE_SCHEMA,
    application_name: "wms-migrate-queue",
    max: 2,
    supervise: false,
    registerInstance: false,
    schedule: false,
    useListenNotify: false,
  } as const;
  const errors: unknown[] = [];

  // Aşama 1 (yalnızca okuma): rol denetimi ve bekleyen `bam` komutlarının doğrulanması, migration'dan ÖNCE.
  // `migrate:false` başlatma şema yoksa/eskiyse fırlatır ama havuzu açar; bu yüzden hata beklenir.
  const probe = new PgBoss({ ...base, migrate: false });
  probe.on("error", (e) => errors.push(e));
  try {
    await probe.start().catch(() => undefined);
    const db = probe.getDb();
    const who = await db.executeSql("SELECT current_user::text AS u, session_user::text AS s");
    const row = who.rows[0] as { u: string; s: string } | undefined;
    if (row === undefined || APP_ROLES.includes(row.u) || APP_ROLES.includes(row.s)) {
      throw new QueueInstallError("queue schema install must run with the migration role, not an application role");
    }
    const exists = await db.executeSql(`SELECT to_regclass('${QUEUE_SCHEMA}.bam') IS NOT NULL AS present`);
    if ((exists.rows[0] as { present?: boolean } | undefined)?.present === true) {
      const pending = await db.executeSql(`SELECT command FROM ${QUEUE_SCHEMA}.bam WHERE status <> 'completed'`);
      assertBamCommandsExpected(pending.rows.map((r: { command: string }) => r.command));
    }
  } catch (err) {
    throw describeFailure(err);
  } finally {
    await probe.stop({ graceful: false, close: true }).catch(() => undefined);
  }

  // Aşama 2: kurulum/yükseltme + kuyruklar + yetkiler.
  const boss = new PgBoss({ ...base, migrate: true });
  boss.on("error", (e) => errors.push(e));
  try {
    await boss.start();
    for (const type of JOB_TYPES) {
      await boss.createQueue(type, { policy: "standard", ...QUEUE_DEFAULTS });
    }
    await boss.getDb().executeSql(QUEUE_APP_GRANTS_SQL);
  } catch (err) {
    throw describeFailure(err);
  } finally {
    await boss.stop({ graceful: false, close: true }).catch(() => undefined);
  }
  if (errors.length > 0) throw describeFailure(errors[0]);
}
