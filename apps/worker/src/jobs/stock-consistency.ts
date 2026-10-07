// Stok tutarlılık denetimi: zamanlayıcı + tenant işi bağı (T-225; ADR-019 §1, §5, §8-§10, A-74).
// Zamanlayıcı iş değil worker içi döngüdür (`demo-schedule` deseni): saatte bir + açılışta bir, tüm ACTIVE tenant'ları keyset sayfalarla
// listeler (`wms_worker` → `wms_probe.active_tenant_ids`), her biri için `singletonKey = stock-consistency/<tenantId>` ile bir
// `stock.consistency.check` işi yazar. Denetimin kendisi `@wms/domain/stock/jobs` `runConsistencyCheck`'tedir (UI/worker aynı domain).
// Sessiz OK yok: her koşu listelenen/kuyruğa yazılan sayıyı loglar; listeleme/kuyruklama hatası `level=error` (OK yazılmaz).
import { runConsistencyCheck, type ConsistencyCheckContext, type ConsumeOnceFn } from "@wms/domain/stock/jobs";
import type { Logger } from "@wms/shared/log";
import type { JobHandler } from "@wms/shared/queue";

/** A-74: saatte bir (varsayım; Q-41/Q-21). */
export const CONSISTENCY_SCHEDULE_INTERVAL_MS = 3_600_000;
const FIRST_PAGE = "00000000-0000-0000-0000-000000000000";
const PAGE_SIZE = 500;

export const consistencySingletonKey = (tenantId: string): string => `stock-consistency/${tenantId}`;

export interface StockConsistencyHandlerDeps {
  readonly consumeOnce: ConsumeOnceFn;
  readonly logger: Logger;
}

/** Kuyruk işi → domain. */
export function createStockConsistencyHandler(deps: StockConsistencyHandlerDeps): JobHandler<"stock.consistency.check"> {
  return async (ctx) => {
    await runConsistencyCheck(deps, ctx as unknown as ConsistencyCheckContext);
  };
}

export interface ConsistencyScheduleDeps {
  /** `queue.listActiveTenantIds` (wms_worker bağlantısı). */
  readonly listActiveTenantIds: (after: string, limit: number) => Promise<readonly string[]>;
  /** `withSystemTenant(db, id, "stock.consistency.schedule", tx => queue.enqueue(tx, { …, singletonKey }))`. `jobId: null` → aynı anahtarlı iş zaten kuyrukta. */
  readonly enqueueFor: (tenantId: string) => Promise<{ readonly jobId: string | null }>;
  readonly logger: Logger;
}

export interface ConsistencyScheduleResult {
  readonly listed: number;
  readonly enqueued: number;
  /** Aynı anahtarlı bir iş zaten bekliyordu (tekilleştirildi). */
  readonly deduplicated: number;
  /** Listeleme ile kuyruklama arasında ACTIVE olmaktan çıkan tenant (askı/kapanış) — hata değil. */
  readonly inactive: number;
  readonly failed: number;
  readonly listFailed: boolean;
}

const INACTIVE_CODES: ReadonlySet<string> = new Set(["TENANT_SUSPENDED", "TENANT_CLOSING", "FORBIDDEN"]);
const errName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/** Tek zamanlayıcı koşusu. Hiçbir yolda sessiz OK yok: sonuç sayıları loglanır, hata `level=error`. */
export async function runConsistencySchedule(deps: ConsistencyScheduleDeps): Promise<ConsistencyScheduleResult> {
  const { logger } = deps;
  let listed = 0;
  let enqueued = 0;
  let deduplicated = 0;
  let inactive = 0;
  let failed = 0;
  let listFailed = false;
  let after = FIRST_PAGE;
  try {
    for (;;) {
      const ids = await deps.listActiveTenantIds(after, PAGE_SIZE);
      listed += ids.length;
      for (const id of ids) {
        try {
          const r = await deps.enqueueFor(id);
          if (r.jobId === null) deduplicated += 1;
          else enqueued += 1;
        } catch (e) {
          const code = (e as { code?: unknown } | null)?.code;
          if (typeof code === "string" && INACTIVE_CODES.has(code)) {
            inactive += 1;
          } else {
            failed += 1;
            logger.error("stock.consistency.schedule_enqueue_failed", { tenantId: id, reason: errName(e) });
          }
        }
      }
      if (ids.length < PAGE_SIZE) break;
      after = ids[ids.length - 1] as string;
    }
  } catch (e) {
    listFailed = true;
    logger.error("stock.consistency.schedule_list_failed", { listed, enqueued, reason: errName(e) });
  }
  const result: ConsistencyScheduleResult = { listed, enqueued, deduplicated, inactive, failed, listFailed };
  if (listFailed || failed > 0) {
    logger.error("stock.consistency.schedule_incomplete", { listed, enqueued, deduplicated, inactive, failed, listFailed });
  } else {
    logger.info("stock.consistency.scheduled", { listed, enqueued, deduplicated, inactive });
  }
  return result;
}

export interface ConsistencyScheduleOptions extends ConsistencyScheduleDeps {
  readonly intervalMs?: number;
  /** Test: zamanlayıcı enjeksiyonu. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (t: unknown) => void;
}

/** Açılışta bir kez + her `intervalMs`'de koşar; üst üste binen koşu atlanır. Dönen `stop` zamanlayıcıyı durdurur (kapanış, `lifecycle.register`). */
export function startConsistencySchedule(options: ConsistencyScheduleOptions): { stop(): void } {
  const setTimer =
    options.setTimer ??
    ((fn, ms) => {
      const h = setInterval(fn, ms);
      h.unref();
      return h;
    });
  const clearTimer = options.clearTimer ?? ((t) => clearInterval(t as NodeJS.Timeout));
  let running = false;
  let stopped = false;
  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    runConsistencySchedule(options)
      .catch((e: unknown) => options.logger.error("stock.consistency.schedule_failed", { reason: errName(e) }))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const handle = setTimer(tick, options.intervalMs ?? CONSISTENCY_SCHEDULE_INTERVAL_MS);
  return {
    stop(): void {
      stopped = true;
      clearTimer(handle);
    },
  };
}
