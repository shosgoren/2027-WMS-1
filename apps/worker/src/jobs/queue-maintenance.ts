// Kuyruk bakımı (T-281; pg-boss `supervise` eşdeğeri). Adaptör `supervise: false` çalışır (wms_app/wms_worker pgboss yönetim tablolarına yazamaz,
// I-03); bu yüzden worker çökerse (SIGKILL) `active` kalan iş kendiliğinden geri dönmez. Bu modül TÜM iş türleri için tek mekanizmadır:
//   1. Süresi dolan `active` işler deneme hakkı varsa `retry`'a, yoksa `failed`'a çevrilir (`requeueExpiredJobs`, `wms_worker` bağlantısı).
//   2. `failed` `stock.document.post` işlerinin belgeleri serbest bırakılır (domain `finalizeFailedPostingJobs`; belge/idempotency yazımı `wms_app`).
// Tükenen (kalıcı `failed`) iş alarm düzeyinde (`error`) loglanır; yeniden kuyruğa alınanlar `info`. Günlük metrikleri: tur sayısı ve toplamlar.
import { withSystemTenant, withUser, type DbClient } from "@wms/db";
import { finalizeFailedPostingJobs } from "@wms/domain/stock/jobs";
import { requeueExpiredJobs } from "@wms/queue-adapter";
import type { Logger } from "@wms/shared/log";
import { PLATFORM_NO_USER_ID } from "@wms/shared/queue";

/** Tarama aralığı (ms). En kısa `expireInSeconds` 300 sn; bir dakikada bir tarama, çöken işin en geç ~süre+1 dk sonra geri dönmesini sağlar. */
export const QUEUE_MAINTENANCE_INTERVAL_MS = 60_000;

export interface QueueMaintenanceDeps {
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

export interface QueueMaintenanceTotals {
  readonly runs: number;
  readonly requeued: number;
  readonly exhausted: number;
}

const countByType = (items: readonly { readonly type: string }[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[i.type] = (out[i.type] ?? 0) + 1;
  return out;
};

/**
 * Tek bakım turu. Hata yutulmaz: loglanır ve sonraki turda yeniden denenir (çağıran asla fırlatma görmez; zamanlayıcı ölmez). Dönen değer tur sayıları.
 * Mesajlar sabit dizelerdir (`deploy-smoke` günlük süzgeci izinli listesine eklenene dek `[msg gizlendi]` görünür).
 */
export async function runQueueMaintenance(
  deps: Pick<QueueMaintenanceDeps, "workerDb" | "db" | "logger">,
): Promise<{ readonly requeued: number; readonly exhausted: number }> {
  const onWorker = <R>(fn: (tx: never) => Promise<R>): Promise<R> => withUser(deps.workerDb, PLATFORM_NO_USER_ID, (tx) => fn(tx as never));
  let requeued = 0;
  let exhausted = 0;
  try {
    const r = await onWorker((tx) => requeueExpiredJobs(tx));
    requeued = r.requeued.length;
    exhausted = r.exhausted.length;
    if (requeued > 0) deps.logger.info("queue.maintenance.requeued_expired", { count: requeued, byType: countByType(r.requeued), jobIds: r.requeued.map((j) => j.id) });
    // ALARM: deneme hakkı bitmiş iş kalıcı `failed` oldu (iş etkisi gerçekleşmedi); operatör müdahalesi gerekir (RUNBOOK-ops §Kuyruk bakımı).
    if (exhausted > 0) deps.logger.error("queue.maintenance.expired_exhausted", { count: exhausted, byType: countByType(r.exhausted), jobIds: r.exhausted.map((j) => j.id) });
    const f = await finalizeFailedPostingJobs({
      runOnWorker: (fn) => onWorker((tx) => fn(tx)),
      runInTenant: (tenantId, fn) => withSystemTenant(deps.db, tenantId, "queue.stock.document.post", (tx) => fn(tx as never)),
      logger: deps.logger,
    });
    if (f.finalized > 0) deps.logger.info("stock.async_post.finalized", { count: f.finalized });
  } catch (err) {
    deps.logger.error("queue.maintenance.failed", { error: err instanceof Error ? err.name : "unknown" });
  }
  return { requeued, exhausted };
}

/** Zamanlayıcıyı başlatır. Açılışta bir tur yapılır (çöken önceki sürecin işleri için). `stop` yalnızca zamanlayıcıyı durdurur. */
export function startQueueMaintenance(deps: QueueMaintenanceDeps): { stop(): void; totals(): QueueMaintenanceTotals } {
  const intervalMs = deps.intervalMs ?? QUEUE_MAINTENANCE_INTERVAL_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearInterval(t as NodeJS.Timeout));
  let running = false;
  let runs = 0;
  let requeued = 0;
  let exhausted = 0;
  const tick = (): void => {
    if (running) return;
    running = true;
    void runQueueMaintenance(deps)
      .then((r) => {
        runs += 1;
        requeued += r.requeued;
        exhausted += r.exhausted;
        if (r.requeued > 0 || r.exhausted > 0) {
          deps.logger.info("queue.maintenance.totals", { runs, requeued, exhausted });
        }
      })
      .finally(() => {
        running = false;
      });
  };
  deps.logger.info("queue.maintenance.started", { intervalMs });
  tick();
  const handle = setTimer(tick, intervalMs);
  return { stop: () => clearTimer(handle), totals: () => ({ runs, requeued, exhausted }) };
}
