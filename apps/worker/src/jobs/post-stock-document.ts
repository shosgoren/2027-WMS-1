// `stock.document.post` işi (T-222; ADR-018 §6, ADR-019 §1-§3): eşik üstü belgeyi istek sahibi adına tek transaction'da işler.
// Handler yalnızca bağlar: iş kuralı `@wms/domain/stock/jobs`'tadır (UI ve worker aynı domain komutunu çağırır).
//
// Pg-boss bakım eşdeğeri (T-222 ZORUNLU notu): adaptör `supervise: false` çalıştığından süresi dolan `active` işi `retry`'a çeviren
// zamanlayıcı burada kurulur (`startPostingJobRecovery`); `wms_worker` bağlantısında (pgboss.job UPDATE yetkisi) çalışır.
import { withSystemTenant, withUser, type DbClient } from "@wms/db";
import { type AsyncPostingContext, type ConsumeOnceFn, runAsyncPosting, sweepExpiredPostingJobs } from "@wms/domain/stock/jobs";
import type { AccessDbClient } from "@wms/domain/identity/access";
import type { Logger } from "@wms/shared/log";
import { PLATFORM_NO_USER_ID, type JobHandler } from "@wms/shared/queue";

export interface PostStockDocumentDeps {
  readonly db: AccessDbClient;
  readonly consumeOnce: ConsumeOnceFn;
  readonly logger: Logger;
}

/** Kuyruk işi → domain. Hata sınıflandırması (kalıcı/geçici) domain'dedir; kalıcı hata `permanent: true` taşır. */
export function createPostStockDocumentHandler(deps: PostStockDocumentDeps): JobHandler<"stock.document.post"> {
  return (ctx) => runAsyncPosting(deps, ctx as unknown as AsyncPostingContext);
}

/** Süresi dolan iş tarama aralığı (ms). Varsayılan işin son kullanma süresi 15 dk; tarama bir dakikada bir yeterlidir. */
export const POSTING_RECOVERY_INTERVAL_MS = 60_000;

export interface PostingJobRecoveryDeps {
  /** `DATABASE_URL_WORKER` (wms_worker) istemcisi. */
  readonly workerDb: DbClient;
  /** `DATABASE_URL` (wms_app) istemcisi: başarısız işlerin belgelerini serbest bırakır. */
  readonly db: DbClient;
  readonly logger: Logger;
  readonly intervalMs?: number;
  /** Test: zamanlayıcı enjeksiyonu. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (t: unknown) => void;
}

/**
 * Tek tarama (günlük ve hata işleme domain'dedir). `wms_worker` yalnızca `pgboss.job` görür (`withUser` yalnızca transaction-local kullanıcı ayarı
 * kurar); belge/idempotency yazımı `wms_app` + `withSystemTenant` ile yapılır (kiracı ACTIVE denetimli).
 */
export function sweepExpiredPostingJobsOnWorker(deps: Pick<PostingJobRecoveryDeps, "workerDb" | "db" | "logger">): Promise<void> {
  return sweepExpiredPostingJobs({
    runOnWorker: (fn) => withUser(deps.workerDb, PLATFORM_NO_USER_ID, (tx) => fn(tx as never)),
    runInTenant: (tenantId, fn) => withSystemTenant(deps.db, tenantId, "queue.stock.document.post", (tx) => fn(tx as never)),
    logger: deps.logger,
  });
}

/** Zamanlayıcıyı başlatır; dönen işlev durdurur. Açılışta bir tarama yapılır (çöken önceki sürecin işleri için). */
export function startPostingJobRecovery(deps: PostingJobRecoveryDeps): { stop(): void } {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearInterval(t as NodeJS.Timeout));
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void sweepExpiredPostingJobsOnWorker(deps).finally(() => {
      running = false;
    });
  };
  tick();
  const handle = setTimer(tick, deps.intervalMs ?? POSTING_RECOVERY_INTERVAL_MS);
  return { stop: () => clearTimer(handle) };
}
