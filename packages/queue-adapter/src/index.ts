// `JobQueue` için pg-boss bağdaştırıcısı (ADR-005 eki, ADR-016 §12, T-115). pg-boss'un TEK import noktası.
//
// - `enqueue(tx, job)`: iş, çağıranın tenant transaction'ında (`fromDrizzle(tx, sql)`) yazılır; transaction
//   geri alınırsa iş hiç oluşmaz. Tenant kimliği parametre değildir: `tx` içindeki
//   `current_setting('app.current_tenant_id')` değerinden türetilir (boş/geçersiz → FORBIDDEN).
// - Roller (T-115c): web `wms_app` ile YALNIZCA gönderir (kendi tenant'ının işini yazar/okur; RLS); tüketici ayrı
//   `wms_worker` rolüyle bağlanır (fetch/complete/fail/retry için gereken en dar DML; tüm tenant'ların işleri).
//   Worker principal kuralı (T-113 MINOR-4): bkz. `workerPrincipal`.
// - Uygulama ve worker `migrate: false` ile bağlanır; şemayı ve kuyrukları yalnızca migration rolü kurar
//   (`installQueueSchema`; `pnpm db:migrate` sonunda `install-cli.ts` çağrılır). `wms_app` tablo oluşturamaz.
// - Pooler uyumu: pg-boss'un varsayılan yolu yalnızca transaction kapsamlı kilit (`pg_advisory_xact_lock`) ve
//   `SET LOCAL` kullanır; LISTEN yalnızca `useListenNotify` ile açılır (burada kapalı). Bkz. T-115 raporu.
import { readFileSync } from "node:fs";
import { currentTenantId, currentUserId, type withTenant } from "@wms/db";
import {
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPES,
  PLATFORM_NO_USER_ID,
  QueueError,
  isJobType,
  isActorMandatory,
  parseJob,
  type EnqueueResult,
  type Job,
  type JobHandler,
  type JobQueue,
  type JobType,
} from "@wms/shared/queue";
import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle, getMigrationPlans, type Job as BossJob, type JobResult } from "pg-boss";
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
/** Hata adı yalnızca tanımlayıcı biçimliyse taşınır; dinamik/veri taşıyan ad (e-posta, boşluk, uzun metin) `Error` olur. */
function safeErrorName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : "Error";
}

function safeErrorFields(err: unknown): Record<string, unknown> {
  const code = (err as { code?: unknown } | null)?.code;
  return {
    name: safeErrorName(err),
    ...(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { sqlstate: code } : {}),
  };
}

/**
 * Kalıcı hata: yeniden denemek sonucu değiştirmez. Handler `permanent: true` taşıyan bir hata fırlatırsa iş
 * yeniden denenmeden sonlandırılır (pg-boss `perJobResults` `deadletter` durumu: kalan deneme hakkını atlar, işi
 * `failed` bırakır; kuyrukta ölü mektup kuyruğu tanımlı değilse yalnızca `failed`). Başarı sayılmaz (G-07).
 * Sınıf bağımlılığı yoktur: yalnızca alan okunur (`MailError`, `SealOpenError`, `MailPayloadError`).
 */
export function isPermanentFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { permanent?: unknown }).permanent === true;
}

/**
 * Worker principal kuralı (T-113 MINOR-4): GENEL kural — bir iş, iş yükünden/zarftan okunan MFA iddiasıyla ÇALIŞMAZ. `mfaVerified` ne iş yükünden
 * ne zarftan okunur (zarf `strict`: bilinmeyen alan işi `failed` yapar; yük şemaları `strict`) ve `wms_worker`
 * iş satırını değiştirse bile kazanç sağlamaz: bu işlev her zaman `mfaVerified: false` üretir.
 * Sonuç: TENANT_ADMIN MFA'sı gerektiren komutlar (`enforceMfa`) bu işlevle kurulan principal'la `MFA_REQUIRED` ile reddedilir.
 * TEK İSTİSNA `stock.document.post` (T-222, `packages/domain/src/stock/jobs.ts`): principal'ı bu işlevle KURMAZ; MFA kararı istek anında sunucu
 * tarafında belge satırına yazılmış damgadan (0023; yazımı 0024 tetikleyicisiyle tek yere kilitli) koşullu türetilir (`mayVouchMfa`), damga yoksa `false`.
 * Worker handler'ları ById komutlarına principal'ı YALNIZCA bu işlevle kurar. `actorUserId` kimlik iddiasıdır;
 * yetki yine üyelik denetimiyle (withMembership) doğrulanır.
 */
export function workerPrincipal(actorUserId: string | null): { readonly userId: string; readonly mfaVerified: false } | null {
  if (actorUserId === PLATFORM_NO_USER_ID) {
    throw new QueueError("VALIDATION_FAILED", "actorUserId is the platform no-user sentinel; not a principal");
  }
  return actorUserId === null ? null : { userId: actorUserId, mfaVerified: false };
}

/** Ayrıştırma hatası: `VALIDATION_FAILED`, kalıcı. Zod mesajı yük değeri içerebilir; taşınmaz (G-09). */
class JobParseError extends QueueError implements PermanentMarker {
  readonly permanent = true as const;
}
interface PermanentMarker {
  readonly permanent: true;
}

function parseEnvelope(data: unknown): Envelope {
  const r = EnvelopeSchema.safeParse(data);
  if (!r.success) throw new JobParseError("VALIDATION_FAILED", "job envelope is malformed");
  return r.data;
}

function parsePayload<T extends JobType>(type: T, payload: unknown): ReturnType<(typeof JOB_PAYLOAD_SCHEMAS)[T]["parse"]> {
  const r = JOB_PAYLOAD_SCHEMAS[type].safeParse(payload);
  if (!r.success) throw new JobParseError("VALIDATION_FAILED", "job payload is malformed");
  return r.data as ReturnType<(typeof JOB_PAYLOAD_SCHEMAS)[T]["parse"]>;
}

/** `failed` işin çıktısına yalnızca hata adı ve kodu yazılır (mesaj adres/bağlantı taşıyabilir, G-09). */
function failureOutput(err: unknown): Record<string, unknown> {
  const code = (err as { code?: unknown } | null)?.code;
  return {
    permanent: true,
    name: safeErrorName(err),
    ...(typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? { code } : {}),
  };
}

/**
 * Geçici hata sarmalayıcısı: pg-boss `fail()` fırlatılan hatanın mesajını + stack'ini + numaralandırılabilir alanlarını
 * `pgboss.job.output`'a yazar (e-posta adresi/bağlantı bilgisi/iç yol sızabilir, G-09). Bu yüzden yeniden fırlatılan
 * hata yalnızca `{name, code}` taşır; mesaj yalnızca ad, stack tek satırdır. Orijinal hata yalnızca ad/SQLSTATE ile loga gider.
 */
class SanitizedJobError extends Error {
  readonly code?: string;
  constructor(name: string, code: string | undefined) {
    super(name);
    this.name = name;
    this.stack = name;
    if (code !== undefined) this.code = code;
  }
}

function sanitizedFailure(err: unknown): SanitizedJobError {
  const code = (err as { code?: unknown } | null)?.code;
  return new SanitizedJobError(
    safeErrorName(err),
    typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : undefined,
  );
}

export interface QueueLogger {
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface JobQueueOptions {
  /**
   * Gönderen (web) için `DATABASE_URL` (wms_app); tüketen worker için `DATABASE_URL_WORKER` (wms_worker, T-115c).
   * Asla loglanmaz (G-09).
   */
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
  /**
   * Platform işleri (`enqueuePlatform`) için: tenant bağlamı BOŞ bir `wms_app` transaction'ı açıp `fn`'i çalıştırır
   * (`processed_events` `tenant_id NULL`, ADR-019 §2). Verilmezse platform işlerinde `inPlatform` hata verir.
   */
  readonly runPlatform?: <R>(fn: (tx: TenantTx) => Promise<R>) => Promise<R>;
  readonly logger?: QueueLogger;
}

export { consumeOnce, deliverExternalOnce } from "./consume.ts";
export type { ConsumeOnceResult, ExternalOnceContext } from "./consume.ts";

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
  const { connectionString, max = 4, stopTimeoutMs = 10_000, pollingIntervalSeconds = 2, runInTenant, runPlatform, logger } = options;
  const boss = new PgBoss({
    connectionString,
    schema: QUEUE_SCHEMA,
    application_name: "wms-queue",
    max,
    migrate: false,
    createSchema: false,
    // wms_app ve wms_worker yönetim tablolarına (queue/version/bam/instance/...) yazamaz: bakım/süpervizyon ve örnek
    // kaydı kapalı (süresi dolan işlerin bakımı bu kartın kapsamı dışında; ayrı iş). Job tablosunda RLS ve rol ayrımı
    // `installQueueSchema` içindedir (T-115c).
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
      if (ctxUser === PLATFORM_NO_USER_ID) {
        // Platform işlemi (kimlik yerine sıfır UUID): bu bir kullanıcı değildir, sessizce actor olarak damgalanmaz (MINOR-8).
        // Açık ve geçerli actor (parseJob sıfır UUID'yi reddeder) kullanılır; yoksa iş reddedilir.
        if (actor === null) {
          throw new QueueError("VALIDATION_FAILED", "platform transaction has no user; an explicit actorUserId is required");
        }
      } else if (ctxUser !== undefined) {
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
      // `perJobResults`: handler sonucu iş başına bildirilir. Geçici hata fırlatılırsa pg-boss işi yeniden dener
      // (batchSize 1: tek iş); kalıcı hata `deadletter` durumuyla yeniden denenmeden `failed` olur.
      await boss.work<unknown>(type, { batchSize: 1, pollingIntervalSeconds, perJobResults: true }, async (jobs: BossJob<unknown>[]) => {
        const results: JobResult[] = [];
        for (const bossJob of jobs) {
          try {
            // Zarf/yük ayrıştırma hataları da kalıcıdır: aynı veri yeniden denemede değişmez (ZodError).
            const envelope = parseEnvelope(bossJob.data);
            const payload = parsePayload(type, envelope.payload);
            const { tenantId } = envelope;
            if (envelope.actorUserId === PLATFORM_NO_USER_ID) {
              throw new JobParseError("VALIDATION_FAILED", "job envelope actorUserId is the platform no-user sentinel");
            }
            if (isActorMandatory(type) && envelope.actorUserId === null) {
              throw new JobParseError("VALIDATION_FAILED", "job envelope requires actorUserId");
            }
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
              inPlatform: async (fn) => {
                if (tenantId !== null) throw new QueueError("FORBIDDEN", "tenant job must use inTenant");
                if (runPlatform === undefined) throw new QueueError("FORBIDDEN", "no platform runner configured");
                return runPlatform(fn);
              },
            } as Parameters<JobHandler<T, TenantTx>>[0]);
            results.push({ id: bossJob.id, status: "completed" });
          } catch (err) {
            if (!isPermanentFailure(err)) {
              logger?.error("job handler failed (transient; will retry)", { jobId: bossJob.id, type, ...safeErrorFields(err) });
              throw sanitizedFailure(err);
            }
            logger?.error("job handler failed (permanent)", { jobId: bossJob.id, type, ...safeErrorFields(err) });
            results.push({ id: bossJob.id, status: "deadletter", output: failureOutput(err) });
          }
        }
        return results;
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

/** Kurulumu çalıştıramayacak roller (uygulama/kimlik/yoklama/tüketici). */
const APP_ROLES: readonly string[] = ["wms_app", "wms_auth", "wms_identity_probe", "wms_worker"];

/** Gönderen (web) ve tüketici (worker) rolleri: yetkileri her kurulumda sıfırlanıp yeniden verilir. */
const QUEUE_ROLES = ["wms_app", "wms_worker"] as const;

/**
 * Önceki yetkileri geri alır: gönderen/tüketici rollerinin tablo/sıra/işlev yetkileri ve işlevlerde PUBLIC EXECUTE.
 * (pg-boss işlevleri PUBLIC EXECUTE ile doğar; çalıştırma yetkisi yalnızca gerekene verilir: her iki rol yalnızca
 * `job_now()` çağırır.)
 */
function revokeSql(schema: string): string {
  const roles = QUEUE_ROLES.join(", ");
  return `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${roles};
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${roles};
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${roles};
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`;
}

/**
 * Rol başına EN DAR yetkiler (kurulu pg-boss 12.36.0 `dist/plans.js` kaynağından; her satırın gerekçesi):
 *
 * Ortak (iki rol):
 * - `USAGE` şema: nesne çözümleme.
 * - `job_now()` EXECUTE: `insertJobs`, `fetchNextJob`, `failJobsBody`, `completeJobs*` zaman damgası için çağırır.
 * - `queue` SELECT: `insertJobs` (`JOIN queue q`), `failJobsBody` dead-letter (`JOIN queue q`), `getQueues` önbelleği.
 * - `version(version)` SELECT: `start()` sürüm denetimi (`check`); başka sütun yok.
 *
 * wms_app (yalnızca GÖNDEREN): `job_common` INSERT (`insertJobs` doğrudan bölüme yazar; ana tabloya INSERT yetkisi YOK)
 * + `job`/`job_common` SELECT (INSERT ... RETURNING id satır görünürlüğü ve
 * tekilleştirme sorgusu; RLS yalnızca kendi tenant'ı + tenant'sız platform işleri). UPDATE/DELETE YOK: başka
 * tenant'ın (hatta kendi) işini iptal/değiştir/sil yapamaz.
 *
 * wms_worker (yalnızca TÜKETİCİ; tüm tenant'ların işleri, RLS'te filtresiz):
 * - `job` SELECT: fetch (`FOR UPDATE ... SKIP LOCKED`), `failJobsBody` `RETURNING *`.
 * - `job` UPDATE: `fetchNextJob` (active), `completeJobs*` (completed), `touchJobs`, `cancelJobs`.
 * - `job` INSERT: `failJobsBody` retry/failed yeniden yazımı ve dead-letter kopyası.
 * - `job` DELETE: `failJobsBody` (`deleted_jobs`: fail = DELETE + INSERT). Bu yetki olmadan fail/retry çalışmaz.
 *
 * `job_common` (varsayılan bölüm): pg-boss kuyrukların gerçek tablosu olarak onu kullanır (`queue.table_name` =
 * 'job_common'; send/fetch/complete/fail doğrudan ona gider; deneyle doğrulandı). `job` ile aynı yetkiler ve aynı RLS.
 *
 * Hiçbir rolde: `bam`, `schedule`,
 * `subscription`, `instance`, `queue_stats`, `warning`, `job_dependency`, `version`/`queue` YAZMA. `bam` komutları
 * migration rolüyle çalıştırılır; bu rollerin oraya yazması rol ayrımını (I-03) aşardı.
 */
export const QUEUE_GRANTS_SQL = `
  ${revokeSql(QUEUE_SCHEMA)};
  GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO wms_app, wms_worker;
  GRANT SELECT, INSERT ON ${QUEUE_SCHEMA}.job_common TO wms_app;
  GRANT SELECT ON ${QUEUE_SCHEMA}.job TO wms_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ${QUEUE_SCHEMA}.job, ${QUEUE_SCHEMA}.job_common TO wms_worker;
  GRANT SELECT ON ${QUEUE_SCHEMA}.queue TO wms_app, wms_worker;
  GRANT SELECT (version) ON ${QUEUE_SCHEMA}.version TO wms_app, wms_worker;
  GRANT EXECUTE ON FUNCTION ${QUEUE_SCHEMA}.job_now() TO wms_app, wms_worker`;

/**
 * Job RLS politikaları (`job-rls.sql`; idempotent DDL). Ayrı dosya: tenant ayarı yalnızca SQL tarafında anılır.
 * Tembel okunur: web/worker paketleri bu modülü yalnızca üretici/tüketici olarak yükler; dosya yalnızca kurulumda gerekir.
 */
function jobRlsSql(): string {
  return readFileSync(new URL("./job-rls.sql", import.meta.url), "utf8");
}

/**
 * Job tabloları RLS'i: `job-rls.sql` (ana tablo + tüm bölümler; ENABLE + FORCE, wms_app INSERT/SELECT yalnızca kendi
 * tenant'ı + platform işi, wms_worker tümü). pg-boss işleri doğrudan bölüme (`job_common`) yazdığı için politikalar
 * bölümde de bulunmalıdır.
 */
export function queueRlsSql(): string {
  return jobRlsSql();
}

// pg-boss 12.36.0'ın `bam` kuyruğuna gerçekten yazdığı komutların biçimi (dist/migrationStore.js `async:` girdileri,
// `job_table_format` sonrası): yalnızca indeks oluşturma/silme. Sütun listesi yalnızca tanımlayıcılar (+ASC/DESC);
// parantezli ifade ve işlev çağrısı YOK; WHERE yalnızca sütun karşılaştırmaları (sabit: yalnızca sözcük karakterli
// dize). `ALTER TABLE` dalı yoktur.
const IDENT = String.raw`[a-z_][a-z0-9_]*`;
const LITERAL = String.raw`'\w*'`;
const COL = String.raw`${IDENT}(?:\s+(?:ASC|DESC))?`;
const COMPARE = String.raw`(?:NOT\s+)?${IDENT}|${IDENT}\s+(?:=|<>|<=|>=|<|>)\s+${LITERAL}|${IDENT}\s+IS\s+(?:NOT\s+)?NULL|${IDENT}\s+IN\s+\(${LITERAL}(?:,\s*${LITERAL})*\)`;
const BAM_CREATE_RE = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+ON\s+${QUEUE_SCHEMA}\.${IDENT}\s+\(${COL}(?:,\s*${COL})*\)(?:\s+INCLUDE\s+\(${IDENT}(?:,\s*${IDENT})*\))?(?:\s+WHERE\s+(?:${COMPARE})(?:\s+AND\s+(?:${COMPARE}))*)?$`,
  "i",
);
const BAM_DROP_RE = new RegExp(String.raw`^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?${QUEUE_SCHEMA}\.${IDENT}$`, "i");

/** Komut beklenen pg-boss `bam` biçiminde mi (tek ifade, yukarıdaki dar dilbilgisi). */
export function isExpectedBamCommand(command: string): boolean {
  const text = command.trim().replace(/;$/, "").trim();
  return !text.includes(";") && (BAM_CREATE_RE.test(text) || BAM_DROP_RE.test(text));
}

/** İşlenmemiş bir `bam` komutu beklenen biçimde değilse reddeder (fail-closed). Çalıştırma pg-boss'tadır. */
export function assertBamCommandsExpected(commands: readonly string[]): void {
  for (const command of commands) {
    if (!isExpectedBamCommand(command)) {
      throw new QueueInstallError("unexpected pending pg-boss bam command; refusing to run it with the migration role");
    }
  }
}

/**
 * Kurulu pg-boss'un sürüm migration'larının `job_table_run_async` ile `bam`'a yazacağı gerçek komutlar (doğrulama
 * testi için): `getMigrationPlans` çıktısındaki satır içi biçimden, `job_common` tablosu için.
 */
export function pgBossAsyncCommandsForVerification(): string[] {
  const plan = getMigrationPlans(QUEUE_SCHEMA, 25);
  const lines = plan.split("\n").map((l) => l.trim());
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith("-- inlined from") && line.includes("job_table_run_async")) {
      const next = lines[i + 1];
      if (next !== undefined) out.push(next.replace(/;$/, ""));
    }
  });
  return out;
}

/** Kurulum hatasını yalnızca (temizlenmiş) ad + SQLSTATE ile sarar; install-cli stderr'e basar. */
export function describeFailure(err: unknown): QueueInstallError {
  if (err instanceof QueueInstallError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const sqlstate = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  return new QueueInstallError(`queue schema install failed (${safeErrorName(err)})`, sqlstate);
}

/**
 * pg-boss şemasını kurar/yükseltir, kayıtlı iş türlerinin kuyruklarını oluşturur ve `wms_app`/`wms_worker`'a en dar yetkileri
 * verir (gönderen wms_app, tüketici wms_worker; job RLS). YALNIZCA migration rolüyle çağrılır (`install-cli.ts`); idempotenttir. Herhangi bir hata kurulumu
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
    if (row === undefined || APP_ROLES.includes(row.u) || APP_ROLES.includes(row.s) || row.u !== row.s) {
      throw new QueueInstallError("queue schema install must run with the migration role, not an application role");
    }
    // Olumlu doğrulama: rol MİGRASYON rolü olmalı (`wms_meta.schema_migrations` sahibi = current_user; tablo yalnızca
    // `pnpm db:migrate` tarafından, migration rolüyle yaratılır). "Veritabanında CREATE yetkisi" tek başına yetmez:
    // CREATE yetkili başka bir operasyon rolü pgboss şemasını sahiplenemez. Şema varsa ayrıca onun sahibi olmalı.
    const authority = await db.executeSql(
      `SELECT (SELECT pg_get_userbyid(c.relowner) = current_user FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'wms_meta' AND c.relname = 'schema_migrations') AS owns_migrations,
              (SELECT pg_get_userbyid(nspowner) = current_user FROM pg_namespace WHERE nspname = '${QUEUE_SCHEMA}') AS owns_schema,
              (SELECT true FROM pg_namespace WHERE nspname = '${QUEUE_SCHEMA}') AS schema_exists,
              has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
              (SELECT count(*) FROM pg_roles WHERE rolname IN ('wms_app', 'wms_worker')) = 2 AS roles_exist`,
    );
    const auth = authority.rows[0] as
      | { owns_migrations: boolean | null; owns_schema: boolean | null; schema_exists: boolean | null; can_create: boolean; roles_exist: boolean }
      | undefined;
    const authorised =
      auth?.owns_migrations === true && (auth.schema_exists === true ? auth.owns_schema === true : auth.can_create === true);
    if (!authorised) {
      throw new QueueInstallError("queue schema install role must be the migration role (owner of wms_meta.schema_migrations) and own or create the pgboss schema");
    }
    if (auth?.roles_exist !== true) {
      throw new QueueInstallError("roles wms_app and wms_worker must exist (infra/postgres/init/01-roles.sh; Neon: T-105)");
    }
    // Önce yetkileri geri al (bam denetiminden ÖNCE): şema varsa wms_app'in eski geniş yetkileri ve PUBLIC EXECUTE kalkar.
    if (auth?.schema_exists === true) {
      await db.executeSql(revokeSql(QUEUE_SCHEMA));
      const exists = await db.executeSql(`SELECT to_regclass('${QUEUE_SCHEMA}.bam') IS NOT NULL AS present`);
      if ((exists.rows[0] as { present?: boolean } | undefined)?.present === true) {
        const pending = await db.executeSql(`SELECT command FROM ${QUEUE_SCHEMA}.bam WHERE status <> 'completed'`);
        assertBamCommandsExpected(pending.rows.map((r: { command: string }) => r.command));
      }
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
    const db = boss.getDb();
    // Tek çok-ifadeli sorgu = tek örtük transaction (hata olursa hiçbiri uygulanmaz); RLS önce, yetkiler sonra:
    // yetki verildiği an politikalar yürürlüktedir.
    await db.executeSql(`${queueRlsSql()};\n${QUEUE_GRANTS_SQL}`);
  } catch (err) {
    throw describeFailure(err);
  } finally {
    await boss.stop({ graceful: false, close: true }).catch(() => undefined);
  }
  if (errors.length > 0) throw describeFailure(errors[0]);
}
