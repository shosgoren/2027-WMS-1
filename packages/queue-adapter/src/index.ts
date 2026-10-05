// `JobQueue` için pg-boss bağdaştırıcısı (ADR-005 eki, ADR-016 §12, T-115). pg-boss'un TEK import noktası.
//
// - `enqueue(tx, job)`: iş, çağıranın tenant transaction'ında (`fromDrizzle(tx, sql)`) yazılır; transaction
//   geri alınırsa iş hiç oluşmaz. Tenant kimliği parametre değildir: `tx` içindeki
//   `current_setting('app.current_tenant_id')` değerinden türetilir (boş/geçersiz → FORBIDDEN).
// - Uygulama ve worker `migrate: false` ile bağlanır; şemayı ve kuyrukları yalnızca migration rolü kurar
//   (`installQueueSchema`, `pnpm db:migrate` sonunda). `wms_app` tablo oluşturamaz.
// - Pooler uyumu: pg-boss'un varsayılan yolu yalnızca transaction kapsamlı kilit (`pg_advisory_xact_lock`) ve
//   `SET LOCAL` kullanır; LISTEN yalnızca `useListenNotify` ile açılır (burada kapalı). Bkz. T-115 raporu.
import { currentTenantId, type withTenant } from "@wms/db";
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
  /** Yalnızca tüketen süreç (worker) bakım/süpervizyon çalıştırır. */
  readonly supervise?: boolean;
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
  const { connectionString, max = 4, stopTimeoutMs = 10_000, supervise = false, pollingIntervalSeconds = 2, logger } = options;
  const boss = new PgBoss({
    connectionString,
    schema: QUEUE_SCHEMA,
    application_name: "wms-queue",
    max,
    migrate: false,
    createSchema: false,
    supervise,
    schedule: false,
    // REINDEX ... CONCURRENTLY tablo sahibi ister; wms_app sahip değildir.
    reindex: false,
    useListenNotify: false,
  });
  boss.on("error", (err) => {
    logger?.error("queue error", { error: err instanceof Error ? err.message : String(err) });
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
    const envelope = envelopeOf(job, tenantId);
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
    async work<T extends JobType>(type: T, handler: JobHandler<T>) {
      if (!isJobType(type)) {
        throw new QueueError("VALIDATION_FAILED", "job type is not registered");
      }
      await start();
      await boss.work<unknown>(type, { batchSize: 1, pollingIntervalSeconds }, async (jobs: BossJob<unknown>[]) => {
        for (const bossJob of jobs) {
          const envelope = EnvelopeSchema.parse(bossJob.data);
          const payload = JOB_PAYLOAD_SCHEMAS[type].parse(envelope.payload);
          await handler({
            jobId: bossJob.id,
            type,
            tenantId: envelope.tenantId,
            actorUserId: envelope.actorUserId,
            payload,
          } as Parameters<JobHandler<T>>[0]);
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

/**
 * pg-boss şemasını kurar/yükseltir ve kayıtlı iş türlerinin kuyruklarını oluşturur. YALNIZCA migration
 * rolüyle çağrılır (`migrate.ts`); idempotenttir. `wms_app` yetkileri çağıranda (migrate.ts) verilir.
 */
export async function installQueueSchema(options: InstallQueueSchemaOptions): Promise<void> {
  const boss = new PgBoss({
    connectionString: options.url,
    schema: QUEUE_SCHEMA,
    application_name: "wms-migrate-queue",
    max: 2,
    migrate: true,
    supervise: false,
    schedule: false,
    useListenNotify: false,
  });
  boss.on("error", () => undefined);
  try {
    await boss.start();
    for (const type of JOB_TYPES) {
      await boss.createQueue(type, { policy: "standard", ...QUEUE_DEFAULTS });
    }
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}

/** `wms_app`'e verilecek yetkiler (en az yetki: şemada kullanım + veri DML + işlev çalıştırma; DDL yok). */
export const QUEUE_APP_GRANTS_SQL = `
  GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO wms_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${QUEUE_SCHEMA} TO wms_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${QUEUE_SCHEMA} TO wms_app;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${QUEUE_SCHEMA} TO wms_app`;
