// Eşik üstü belge işleme: worker tarafı (T-222; ADR-018 §6, ADR-019 §1-§3, 05 §Senkron işlem sınırları, AC-36).
//
// `runAsyncPosting`: `stock.document.post` işini istek sahibinin (zarf `actorUserId`) GÜNCEL yetkisiyle, aynı `executeStockCommand` yolunda
// (`resume`: istek transaction'ında yazılmış `IN_PROGRESS` idempotency satırı sürdürülür) TEK transaction'da işler. `processed_events` aynı
// transaction'dadır (`consumeOnce` DI ile verilir: domain kuyruk adaptörüne bağımlı olmaz).
//
// Sonuç sınıfları:
// - Başarı: belge POSTED, idempotency COMPLETED, `posting_job_id` NULL (numara adımı), audit aktörü = istek sahibi.
// - Etkisiz bitiş (belge artık `APPROVED ∧ posting_job_id = ctx.jobId` değil, kayıt zaten sonlanmış, olay zaten işlenmiş): yalnız log + `processed_events`.
// - Kalıcı hata (iş kuralı reddi, yetki kaybı, tenant kapanması …): ana transaction geri alınır; AYRI transaction'da idempotency FAILED + `error_code`,
//   belge `posting_job_id` NULL (APPROVED kalır) ve `processed_events` birlikte yazılır; iş kalıcı başarısız (`permanent`).
// - Geçici hata (`VERSION_CONFLICT`, `INTERNAL`, tanınmayan): ayrı yazım YOK; hata olduğu gibi yayılır, pg-boss yeniden dener.
//
// A-222-2: durum geçmişi satırı yalnızca durum DEĞİŞİMİNDE DB tetikleyicisiyle yazılır (doğrudan INSERT yasak, 0012); FAILED'da durum değişmez
//   (APPROVED kalır) → durum geçmişi satırı oluşmaz. FAILED için audit eylemi (`AUDIT_ACTIONS`) tanımlı değil (packages/db kapsam dışı) → audit yazılmaz;
//   kayıt idempotency `FAILED` + `error_code` + log + `processed_events`tir (rapor Bulgusu).
// A-222-3: worker principal'ı `mfaVerified: false` (T-113 MINOR-4): TENANT_ADMIN istek sahibinin işi worker'da `FORBIDDEN/MFA_REQUIRED` ile kalıcı başarısız olur
//   (rapor Bulgusu; yetkili rol PICKER/WAREHOUSE_MANAGER için etkisiz).
import { currentTenantId } from "@wms/db";
import { AppError, type ErrorCode } from "@wms/shared/errors";
import type { Logger } from "@wms/shared/log";
import type { JobContext } from "@wms/shared/queue";
import { sql } from "drizzle-orm";
import type { AccessDbClient, AccessTx } from "../identity/access.ts";
import { STOCK_TIMEOUTS, executeStockCommand, type StockCommandApplied } from "./command.ts";
import { encodeErrorCode, StoredRejectionError, type StockCommandResult } from "./idempotency.ts";
import { buildPostCommand } from "./posting.ts";

/** `processed_events.consumer` adı. */
export const POST_CONSUMER = "stock.document.post";

const JOB_TYPE = "stock.document.post";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `@wms/queue-adapter` `consumeOnce` ile aynı sözleşme (DI; adaptör domain'e bağımlı olmasın). */
export type ConsumeOnceFn = <R>(
  tx: AccessTx,
  consumer: string,
  eventId: string,
  fn: (tx: AccessTx) => Promise<R>,
) => Promise<{ readonly applied: true; readonly result: R } | { readonly applied: false }>;

export interface AsyncPostingDeps {
  readonly db: AccessDbClient;
  readonly consumeOnce: ConsumeOnceFn;
  readonly logger: Logger;
}

export type AsyncPostingContext = JobContext<"stock.document.post", AccessTx>;

/** pg-boss adaptörü `permanent: true` taşıyan hatayı yeniden denemeden `failed` yapar (`isPermanentFailure`). */
export class PermanentPostingError extends Error {
  override name = "PermanentPostingError";
  readonly permanent = true as const;
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Dahili: işin etkisiz bitmesi (apply geri alınır). */
class PostingSkipped extends Error {
  override name = "PostingSkipped";
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** Dahili: belge/kayıt başka bir isteğe ait (aktör ya da idempotency kaydı uyuşmazlığı, ADR-018 §6); işlenmez, iş kalıcı hata. */
class PostingContextMismatch extends Error {
  override name = "PostingContextMismatch";
}

/** `executeStockCommand` bilinmeyen hataları `INTERNAL`'a sarar (kök neden `cause`): zincirde sınıfı ara. */
function findInChain<T extends Error>(e: unknown, ctor: new (...a: never[]) => T): T | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur !== undefined && cur !== null; i++) {
    if (cur instanceof ctor) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Geçici: yeniden denemek sonucu değiştirebilir (`VERSION_CONFLICT`, `INTERNAL`, tanınmayan hata). Diğer her `AppError` kalıcıdır. */
const TRANSIENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["VERSION_CONFLICT", "INTERNAL"]);

export function classifyPostingError(e: unknown): "PERMANENT" | "TRANSIENT" {
  if (e instanceof AppError && !TRANSIENT_CODES.has(e.code)) return "PERMANENT";
  return "TRANSIENT";
}

type DocLockRow = {
  status: string;
  posting_job_id: string | null;
  posting_requested_by: string | null;
  posting_idempotency_record_id: string | null;
};

/**
 * MFA penceresi (sn): pg-boss son kullanma süresi (varsayılan 900 sn) × (`retryLimit` 5 + 1 deneme); `QUEUE_DEFAULTS` (queue-adapter) ile birlikte
 * değişir. İsteğin MFA damgası bu pencereden eskiyse worker MFA'yı tanımaz (sınırlı vekâlet).
 */
export const POSTING_MFA_WINDOW_SECONDS = 900 * (5 + 1);

/**
 * Worker'ın istek sahibi adına verdiği MFA kararı (T-222 inceleme MAJOR-1). `mfaVerified: true` YALNIZCA şunların hepsi doğruysa: işleme kilidi bu işe
 * ait (`posting_job_id`), istek sahibi = zarf aktörü, kayıt kimliği = yük kimliği, istek anında MFA damgası var (sunucu tarafında yazıldı, 0023),
 * damga pencere içinde ve damgadan sonra kullanıcının MFA faktörü/parolası sıfırlanmadı (`security_events`: `two_factor_disabled|enabled`,
 * `password_reset|changed`). Oturum iptali için ayrı bir olay türü YOKTUR (`session.*` öneki ayrılmış ama üretilmiyor; rapor Bulgusu): bu yüzden
 * yalnızca bu olaylar sinyaldir. Kilit dışı okuma güvenlidir: değerler yalnızca istek transaction'ında yazılır ve kilit boyunca değişmez.
 */
async function mayVouchMfa(ctx: AsyncPostingContext, tenantId: string, documentId: string, recordId: string, actor: string): Promise<boolean> {
  const rows = await ctx.inTenant((tx) =>
    tx.execute<{
      posting_job_id: string | null;
      posting_requested_by: string | null;
      posting_idempotency_record_id: string | null;
      stamped: boolean;
      fresh: boolean;
      reset: boolean;
    }>(
      sql`SELECT d.posting_job_id, d.posting_requested_by, d.posting_idempotency_record_id,
                 d.posting_mfa_verified_at IS NOT NULL AS stamped,
                 COALESCE(pg_catalog.now() - d.posting_mfa_verified_at <= pg_catalog.make_interval(secs => ${POSTING_MFA_WINDOW_SECONDS}), false) AS fresh,
                 EXISTS (SELECT 1 FROM public.security_events e
                          WHERE e.user_id = d.posting_requested_by AND e.occurred_at > d.posting_mfa_verified_at
                            AND e.event_type IN ('two_factor_disabled', 'two_factor_enabled', 'password_reset', 'password_changed')) AS reset
            FROM public.documents d WHERE d.tenant_id = ${tenantId}::uuid AND d.id = ${documentId}::uuid`,
    ),
  );
  const d = rows[0];
  if (d === undefined) return false;
  const same = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();
  return same(d.posting_job_id, ctx.jobId) && same(d.posting_requested_by, actor) && same(d.posting_idempotency_record_id, recordId) && d.stamped && d.fresh && !d.reset;
}

/** Son deneme mi (pg-boss `fail` yolunda `retry_count >= retry_limit` ise iş kalıcı `failed` olur). Okunamazsa `false` (asıl hata yayılır). */
async function isFinalAttempt(ctx: AsyncPostingContext): Promise<boolean> {
  try {
    const rows = await ctx.inTenant((tx) =>
      tx.execute<{ retry_count: number | string; retry_limit: number | string }>(sql`SELECT retry_count, retry_limit FROM pgboss.job WHERE id = ${ctx.jobId}::uuid`),
    );
    const r = rows[0];
    return r !== undefined && Number(r.retry_count) >= Number(r.retry_limit);
  } catch {
    return false;
  }
}

/** İş kimliği/aktör doğrulaması ve işleme: bkz. dosya başı. */
export async function runAsyncPosting(deps: AsyncPostingDeps, ctx: AsyncPostingContext): Promise<void> {
  const { db, logger } = deps;
  const documentId = ctx.payload.documentId.toLowerCase();
  const recordId = ctx.payload.idempotencyRecordId.toLowerCase();
  // Kiracı çözümü: askıya alınmış/kapanan kiracıda burada hata fırlar (geçici sayılır; son denemede iş `failed` olur ve bakım taraması belgeyi serbest bırakır).
  const tenantId = await ctx.inTenant((tx) => currentTenantId(tx));
  if (tenantId === undefined) throw new AppError("INTERNAL");

  /** Kalıcı hata: belge ve kayıt sonlandırılır (AYRI transaction), iş kalıcı başarısız. Yazım başarısızsa hata yayılır (geçici). */
  const failPermanent = async (err: AppError): Promise<never> => {
    await recordFailure(deps, ctx, { documentId, recordId, err });
    logger.error("stock.async_post.failed", { jobId: ctx.jobId, code: err.code, ...(err.detail === undefined ? {} : { detail: err.detail }) });
    throw new PermanentPostingError(err.code);
  };

  const actor = ctx.actorUserId;
  if (actor === null || !UUID_RE.test(actor)) {
    logger.error("stock.async_post.actor_missing", { jobId: ctx.jobId });
    return failPermanent(new AppError("VALIDATION_FAILED"));
  }

  try {
    const mfaVerified = await mayVouchMfa(ctx, tenantId, documentId, recordId, actor);
    const cmd = buildPostCommand({ documentId, expectedVersion: null, moves: undefined, requestId: null, worker: true });
    const guardedApply = async (tx: AccessTx, locked: Parameters<typeof cmd.apply>[1], c: Parameters<typeof cmd.apply>[2]): Promise<StockCommandApplied> => {
      // Belge kilitli (acquireStockLocks). İşleme kilidi + istek sahibi + idempotency kaydı doğrulanır (ADR-018 §6, MINOR-1).
      const rows = await tx.execute<DocLockRow>(
        sql`SELECT status, posting_job_id, posting_requested_by, posting_idempotency_record_id FROM public.documents
             WHERE tenant_id = ${c.tenantId}::uuid AND id = ${documentId}::uuid`,
      );
      const d = rows[0];
      if (d === undefined) throw new AppError("NOT_FOUND");
      if (d.status !== "APPROVED" || d.posting_job_id === null || d.posting_job_id.toLowerCase() !== ctx.jobId.toLowerCase()) {
        throw new PostingSkipped("DOCUMENT_STATE");
      }
      if (d.posting_requested_by === null || d.posting_requested_by.toLowerCase() !== actor.toLowerCase()) throw new PostingContextMismatch("posting_requested_by");
      if (d.posting_idempotency_record_id === null || d.posting_idempotency_record_id.toLowerCase() !== recordId) throw new PostingContextMismatch("posting_idempotency_record_id");
      const once = await deps.consumeOnce(tx, POST_CONSUMER, ctx.jobId, () => cmd.apply(tx, locked, c));
      if (!once.applied) throw new PostingSkipped("ALREADY_PROCESSED");
      return once.result;
    };
    const outcome = await executeStockCommand<{ readonly documentId: string }, StockCommandResult>({
      db,
      principal: { userId: actor, mfaVerified },
      tenantId,
      clientKey: undefined,
      commandType: "stock.document.post",
      permission: "stock.post",
      input: { documentId },
      resume: { recordId },
      timeouts: STOCK_TIMEOUTS.worker,
      logger,
      plan: cmd.plan,
      apply: guardedApply as never,
    });
    logger.info("stock.async_post.done", { jobId: ctx.jobId, outcome: outcome.status, replayed: outcome.status === "COMPLETED" ? outcome.replayed : false });
    return;
  } catch (e) {
    if (e instanceof PermanentPostingError) throw e;
    if (findInChain(e, PostingContextMismatch) !== undefined) {
      logger.error("stock.async_post.context_mismatch", { jobId: ctx.jobId });
      return failPermanent(new AppError("IDEMPOTENCY_MISMATCH"));
    }
    const skipped = findInChain(e, PostingSkipped);
    if (skipped !== undefined) {
      await ctx.inTenant((tx) => deps.consumeOnce(tx, POST_CONSUMER, ctx.jobId, async () => undefined));
      logger.info("stock.async_post.skipped", { jobId: ctx.jobId, reason: skipped.reason });
      return;
    }
    if (e instanceof StoredRejectionError) {
      // Kayıt zaten sonlanmış (önceki teslim FAILED yazdı ya da REJECTED): etkisiz bitiş.
      await ctx.inTenant((tx) => deps.consumeOnce(tx, POST_CONSUMER, ctx.jobId, async () => undefined));
      logger.info("stock.async_post.skipped", { jobId: ctx.jobId, reason: "RECORD_FINAL" });
      return;
    }
    if (classifyPostingError(e) === "TRANSIENT") {
      logger.error("stock.async_post.transient", { jobId: ctx.jobId, code: e instanceof AppError ? e.code : "UNKNOWN" });
      // SON DENEME (MAJOR-2): pg-boss işi bir sonraki başarısızlıkta kalıcı `failed` yapar; belge `PROCESSING`'te takılmasın diye geçici hata da kalıcı sayılır.
      if (await isFinalAttempt(ctx)) {
        const err = e instanceof AppError ? e : new AppError("INTERNAL");
        try {
          await recordFailure(deps, ctx, { documentId, recordId, err });
        } catch {
          throw e; // yazılamadı (ör. kiracı askıda): asıl hata yayılır; bakım taraması (`sweepExpiredPostingJobs`) belgeyi serbest bırakır
        }
        logger.error("stock.async_post.failed", { jobId: ctx.jobId, code: err.code, final: true });
        throw new PermanentPostingError(err.code);
      }
      throw e;
    }
    return failPermanent(e as AppError);
  }
}

/**
 * Belgeyi ve idempotency kaydını `FAILED` olarak sonlandırır (kilit bu işe aitse): belge `posting_job_id` + bağlam NULL (APPROVED kalır),
 * kayıt FAILED + `error_code`. Kilit bu işe ait değilse (zaten sonlanmış / başka iş) hiçbir şey yazılmaz. `true`: sonlandırıldı.
 * Çağıran tenant bağlamlı bir transaction verir (istek sahibinin üyeliği kalkmış olabilir: `withMembership` kullanılmaz).
 */
export async function failPostingInTx(
  tx: AccessTx,
  f: { readonly tenantId: string; readonly jobId: string; readonly documentId: string; readonly recordId: string; readonly err: AppError },
): Promise<boolean> {
  const locked = await tx.execute<{ id: string }>(
    sql`SELECT id FROM public.documents
         WHERE tenant_id = ${f.tenantId}::uuid AND id = ${f.documentId}::uuid AND status = 'APPROVED' AND posting_job_id = ${f.jobId}::uuid FOR UPDATE`,
  );
  if (locked[0] === undefined) return false;
  await tx.execute(
    sql`UPDATE public.documents
           SET posting_job_id = NULL, posting_requested_by = NULL, posting_mfa_verified_at = NULL, posting_idempotency_record_id = NULL
         WHERE tenant_id = ${f.tenantId}::uuid AND id = ${f.documentId}::uuid`,
  );
  await tx.execute(
    sql`UPDATE public.idempotency_records
           SET status = 'FAILED', error_code = ${encodeErrorCode(f.err.code, f.err.detail)}, http_status = ${f.err.httpStatus},
               result = ${JSON.stringify({ documentId: f.documentId })}::jsonb, completed_at = now()
         WHERE tenant_id = ${f.tenantId}::uuid AND id = ${f.recordId}::uuid AND command_type = 'stock.document.post' AND status = 'IN_PROGRESS'`,
  );
  return true;
}

/**
 * Kalıcı hata kaydı (AYRI transaction, `ctx.inTenant`): `failPostingInTx` + `processed_events` birlikte. Yazım başarısızsa hata yayılır
 * (yeniden teslimde aynı ret yeniden üretilir ve yazım yeniden denenir).
 */
async function recordFailure(
  deps: AsyncPostingDeps,
  ctx: AsyncPostingContext,
  f: { readonly documentId: string; readonly recordId: string; readonly err: AppError },
): Promise<void> {
  await ctx.inTenant(async (tx) => {
    const tenant = await currentTenantId(tx);
    if (tenant === undefined) throw new AppError("INTERNAL");
    await deps.consumeOnce(tx, POST_CONSUMER, ctx.jobId, async () => {
      await failPostingInTx(tx, { tenantId: tenant, jobId: ctx.jobId, documentId: f.documentId, recordId: f.recordId, err: f.err });
    });
    // applied:false ⇒ önceki teslim zaten yazdı (aynı transaction'da birlikte)
  });
}

/**
 * pg-boss bakım eşdeğeri (T-222 ZORUNLU notu, ADR-019 §7): adaptör `supervise: false` çalışır; süresi dolan `active` iş kendiliğinden `retry`'a dönmez.
 * Bu işlev `wms_worker` bağlantısında (pgboss.job UPDATE yetkisi) periyodik çağrılır: `started_on + expire_seconds` geçmiş `stock.document.post` işini
 * deneme hakkı varsa hemen `retry`'a (sonraki alımda `retry_count` artar; eski sahibin geç tamamlaması `state='active'` koşuluyla etkisizdir),
 * yoksa `failed`'a çevirir. `failed` işlerin belgeleri `finalizeFailedPostingJobs` ile serbest bırakılır (MAJOR-2).
 */
export async function requeueExpiredPostingJobs(tx: Pick<AccessTx, "execute">): Promise<{ readonly requeued: string[]; readonly exhausted: string[] }> {
  const rows = await tx.execute<{ id: string; state: string }>(
    sql`UPDATE pgboss.job
           SET state = (CASE WHEN retry_count < retry_limit THEN 'retry' ELSE 'failed' END)::pgboss.job_state,
               start_after = CASE WHEN retry_count < retry_limit THEN pgboss.job_now() ELSE start_after END,
               completed_on = CASE WHEN retry_count < retry_limit THEN NULL ELSE pgboss.job_now() END,
               heartbeat_on = NULL,
               output = '{ "value": { "message": "job timed out" } }'::jsonb
         WHERE name = ${JOB_TYPE} AND state = 'active' AND (started_on + expire_seconds * interval '1 second') < pgboss.job_now()
        RETURNING id, state::text AS state`,
  );
  return {
    requeued: rows.filter((r) => r.state === "retry").map((r) => r.id),
    exhausted: rows.filter((r) => r.state === "failed").map((r) => r.id),
  };
}

type FailedJobRow = { id: string; tenant_id: string | null; document_id: string | null; record_id: string | null };

/** Belgesi henüz serbest bırakılmamış `failed` işler (`output.finalized` işareti yok); en eskiden `limit` kadar. `wms_worker` bağlantısı. */
export async function listUnfinalizedFailedPostingJobs(tx: Pick<AccessTx, "execute">, limit = 50): Promise<readonly FailedJobRow[]> {
  return tx.execute<FailedJobRow>(
    sql`SELECT id, data->>'tenantId' AS tenant_id, data->'payload'->>'documentId' AS document_id, data->'payload'->>'idempotencyRecordId' AS record_id
          FROM pgboss.job
         WHERE name = ${JOB_TYPE} AND state = 'failed' AND (output IS NULL OR jsonb_typeof(output) <> 'object' OR output->>'finalized' IS NULL)
         ORDER BY completed_on NULLS FIRST, created_on LIMIT ${limit}`,
  );
}

/** Serbest bırakma işaretini (`output.finalized`) yazar; sonraki turlar işi atlar. `wms_worker` bağlantısı. */
export async function markPostingJobFinalized(tx: Pick<AccessTx, "execute">, jobId: string): Promise<void> {
  await tx.execute(
    sql`UPDATE pgboss.job
           SET output = pg_catalog.jsonb_build_object('finalized', true) || CASE WHEN jsonb_typeof(output) = 'object' THEN output ELSE '{}'::jsonb END
         WHERE id = ${jobId}::uuid AND name = ${JOB_TYPE} AND state = 'failed'`,
  );
}

export interface PostingSweepDeps {
  /** `wms_worker` transaction'ı (yalnızca pgboss.job). */
  readonly runOnWorker: <R>(fn: (tx: Pick<AccessTx, "execute">) => Promise<R>) => Promise<R>;
  /** `wms_app` + `withSystemTenant` transaction'ı (belge/idempotency yazımı; kiracı ACTIVE değilse hata fırlatır). */
  readonly runInTenant: <R>(tenantId: string, fn: (tx: AccessTx) => Promise<R>) => Promise<R>;
  readonly logger: Logger;
}

/**
 * `failed` işlerin belgelerini serbest bırakır (T-222 inceleme MAJOR-2): iş deneme hakkını tüketip (ya da süresi dolup) kalıcı `failed` olduysa belge
 * `posting_job_id` ile `PROCESSING`'te takılı kalmasın → belge APPROVED + kayıt FAILED (`INTERNAL`). İş bu işin kendi kalıcı hata yazımıyla zaten
 * sonlandırdıysa yazım olmaz, yalnızca işaret konur. Kiracı askıdaysa yazım başarısız olur ve iş işaretlenmez (kiracı açılınca sonraki turda sonlanır).
 */
export async function finalizeFailedPostingJobs(deps: PostingSweepDeps): Promise<{ readonly finalized: number; readonly deferred: number }> {
  const pending = await deps.runOnWorker((tx) => listUnfinalizedFailedPostingJobs(tx));
  let finalized = 0;
  let deferred = 0;
  for (const j of pending) {
    if (j.tenant_id === null || j.document_id === null || j.record_id === null || !UUID_RE.test(j.tenant_id)) {
      await deps.runOnWorker((tx) => markPostingJobFinalized(tx, j.id)); // biçimsiz zarf: yazılacak belge yok
      continue;
    }
    const tenantId = j.tenant_id;
    const documentId = j.document_id.toLowerCase();
    const recordId = j.record_id.toLowerCase();
    try {
      await deps.runInTenant(tenantId, (tx) =>
        failPostingInTx(tx, { tenantId, jobId: j.id, documentId, recordId, err: new AppError("INTERNAL") }),
      );
      await deps.runOnWorker((tx) => markPostingJobFinalized(tx, j.id));
      finalized += 1;
    } catch (err) {
      deferred += 1;
      deps.logger.error("stock.async_post.finalize_deferred", { error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return { finalized, deferred };
}

/**
 * Tek bakım turu: süresi dolan işleri `retry`/`failed` yapar, sonra `failed` işlerin belgelerini serbest bırakır. Hata yutulmaz, loglanır
 * (sonraki turda yeniden denenir). Mesajlar domain'dedir (worker günlük süzgeci `deploy-smoke` ALLOWED_MSGS'a eklenene dek `HIDDEN` görünür).
 */
export async function sweepExpiredPostingJobs(deps: PostingSweepDeps): Promise<void> {
  try {
    const r = await deps.runOnWorker((tx) => requeueExpiredPostingJobs(tx));
    if (r.requeued.length > 0) deps.logger.info("stock.async_post.requeued_expired", { count: r.requeued.length });
    if (r.exhausted.length > 0) deps.logger.error("stock.async_post.expired_exhausted", { count: r.exhausted.length });
    const f = await finalizeFailedPostingJobs(deps);
    if (f.finalized > 0) deps.logger.info("stock.async_post.finalized", { count: f.finalized });
  } catch (err) {
    deps.logger.error("stock.async_post.recovery_failed", { error: err instanceof Error ? err.name : "unknown" });
  }
}
