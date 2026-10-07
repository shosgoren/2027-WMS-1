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

/** Dahili: belge/kayıt başka bir isteğe ait (aktör uyuşmazlığı); belgeye DOKUNULMAZ, iş kalıcı hata. */
class PostingActorMismatch extends Error {
  override name = "PostingActorMismatch";
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

type DocLockRow = { status: string; posting_job_id: string | null; posting_requested_by: string | null };

/** İş kimliği/aktör doğrulaması ve işleme: bkz. dosya başı. */
export async function runAsyncPosting(deps: AsyncPostingDeps, ctx: AsyncPostingContext): Promise<void> {
  const { db, logger } = deps;
  const actor = ctx.actorUserId;
  if (actor === null || !UUID_RE.test(actor)) {
    logger.error("stock.async_post.actor_missing", { jobId: ctx.jobId });
    throw new PermanentPostingError("VALIDATION_FAILED");
  }
  const documentId = ctx.payload.documentId.toLowerCase();
  const recordId = ctx.payload.idempotencyRecordId.toLowerCase();
  const tenantId = await ctx.inTenant((tx) => currentTenantId(tx));
  if (tenantId === undefined) throw new PermanentPostingError("FORBIDDEN");

  const cmd = buildPostCommand({ documentId, expectedVersion: null, moves: undefined, requestId: null, worker: true });
  const guardedApply = async (tx: AccessTx, locked: Parameters<typeof cmd.apply>[1], c: Parameters<typeof cmd.apply>[2]): Promise<StockCommandApplied> => {
    // Belge kilitli (acquireStockLocks). İşleme kilidi + istek sahibi doğrulanır (ADR-018 §6).
    const rows = await tx.execute<DocLockRow>(
      sql`SELECT status, posting_job_id, posting_requested_by FROM public.documents WHERE tenant_id = ${c.tenantId}::uuid AND id = ${documentId}::uuid`,
    );
    const d = rows[0];
    if (d === undefined) throw new AppError("NOT_FOUND");
    if (d.status !== "APPROVED" || d.posting_job_id === null || d.posting_job_id.toLowerCase() !== ctx.jobId.toLowerCase()) {
      throw new PostingSkipped("DOCUMENT_STATE");
    }
    if (d.posting_requested_by === null || d.posting_requested_by.toLowerCase() !== actor.toLowerCase()) throw new PostingActorMismatch("posting_requested_by");
    const once = await deps.consumeOnce(tx, POST_CONSUMER, ctx.jobId, () => cmd.apply(tx, locked, c));
    if (!once.applied) throw new PostingSkipped("ALREADY_PROCESSED");
    return once.result;
  };

  try {
    const outcome = await executeStockCommand<{ readonly documentId: string }, StockCommandResult>({
      db,
      principal: { userId: actor, mfaVerified: false },
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
    if (findInChain(e, PostingActorMismatch) !== undefined) {
      logger.error("stock.async_post.actor_mismatch", { jobId: ctx.jobId });
      throw new PermanentPostingError("IDEMPOTENCY_MISMATCH");
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
      throw e;
    }
    const err = e as AppError;
    await recordFailure(deps, ctx, { documentId, recordId, actor, err });
    logger.error("stock.async_post.failed", { jobId: ctx.jobId, code: err.code, ...(err.detail === undefined ? {} : { detail: err.detail }) });
    throw new PermanentPostingError(err.code);
  }
}

/**
 * Kalıcı hata kaydı (AYRI transaction, `ctx.inTenant`): idempotency FAILED + `error_code`, belge `posting_job_id` NULL, `processed_events`.
 * İstek sahibinin üyeliği kalkmış olabileceğinden `withMembership` KULLANILMAZ; tenant bağlamı sistem bağlamıdır. Yazım başarısızsa hata yayılır
 * (geçici sayılır: yeniden teslimde aynı ret yeniden üretilir ve yazım yeniden denenir).
 */
async function recordFailure(
  deps: AsyncPostingDeps,
  ctx: AsyncPostingContext,
  f: { readonly documentId: string; readonly recordId: string; readonly actor: string; readonly err: AppError },
): Promise<void> {
  await ctx.inTenant(async (tx) => {
    const tenant = await currentTenantId(tx);
    if (tenant === undefined) throw new AppError("INTERNAL");
    const once = await deps.consumeOnce(tx, POST_CONSUMER, ctx.jobId, async () => {
      await tx.execute(
        sql`UPDATE public.idempotency_records
               SET status = 'FAILED', error_code = ${encodeErrorCode(f.err.code, f.err.detail)}, http_status = ${f.err.httpStatus},
                   result = ${JSON.stringify({ documentId: f.documentId })}::jsonb, completed_at = now()
             WHERE tenant_id = ${tenant}::uuid AND id = ${f.recordId}::uuid AND actor_user_id = ${f.actor}::uuid AND status = 'IN_PROGRESS'`,
      );
      await tx.execute(
        sql`UPDATE public.documents SET posting_job_id = NULL, posting_requested_by = NULL
             WHERE tenant_id = ${tenant}::uuid AND id = ${f.documentId}::uuid AND status = 'APPROVED'
               AND posting_job_id = ${ctx.jobId}::uuid AND posting_requested_by = ${f.actor}::uuid`,
      );
    });
    void once; // applied:false ⇒ önceki teslim zaten yazdı (aynı transaction'da üçü birlikte)
  });
}

/**
 * pg-boss bakım eşdeğeri (T-222 ZORUNLU notu, ADR-019 §7): adaptör `supervise: false` çalışır; süresi dolan `active` iş kendiliğinden `retry`'a dönmez.
 * Bu işlev `wms_worker` bağlantısında (pgboss.job UPDATE yetkisi) periyodik çağrılır: `started_on + expire_seconds` geçmiş `stock.document.post` işini
 * deneme hakkı varsa hemen `retry`'a (sonraki alımda `retry_count` artar; eski sahibin geç tamamlaması `state='active'` koşuluyla etkisizdir),
 * yoksa `failed`'a çevirir. Dönen `exhausted` kimlikleri: belge `posting_job_id` ile takılı kalır (rapor Bulgusu → T-225 tutarlılık/kurtarma işi).
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

/**
 * Tek bakım turu: `run` bir `wms_worker` transaction'ı açar (worker `withUser` ile verir). Hata yutulmaz, loglanır (sonraki turda yeniden denenir).
 * Mesajlar domain'dedir (worker günlük süzgeci `deploy-smoke` ALLOWED_MSGS'a eklenene dek `HIDDEN` görünür; rapor Bulgusu).
 */
export async function sweepExpiredPostingJobs(
  run: <R>(fn: (tx: Pick<AccessTx, "execute">) => Promise<R>) => Promise<R>,
  logger: Logger,
): Promise<void> {
  try {
    const r = await run((tx) => requeueExpiredPostingJobs(tx));
    if (r.requeued.length > 0) logger.info("stock.async_post.requeued_expired", { count: r.requeued.length });
    if (r.exhausted.length > 0) logger.error("stock.async_post.expired_exhausted", { count: r.exhausted.length });
  } catch (err) {
    logger.error("stock.async_post.recovery_failed", { error: err instanceof Error ? err.name : "unknown" });
  }
}
