// Terk edilmiş sayım alarmı: zamanlayıcı + tenant denetimi (T-309; 06 §Sayım kilidi yaşam döngüsü "Terk edilmiş sayım", A-136).
// `stock-consistency.ts` zamanlayıcı desenidir (worker içi döngü: açılışta bir + saatte bir, ACTIVE tenant'lar keyset sayfalarla): her tenant için domain
// `findAbandonedCounts` (SALT OKUMA) çalışır ve süresi (`tenant_settings.count_abandon_hours`, varsayılan 8) aşan `COUNTING` kilidi olan oturum başına
// `level=error` alarm loglar. Alarm kilidi AÇMAZ ve oturumu değiştirmez: yalnızca yetkili iptal (`cancelCount`) ya da onay + fark fişi kapatır.
// Sessiz OK yok: her koşu sayıları loglar; listeleme/denetim hatası `level=error`. Tenant bağlamı `withSystemTenant` (tenant ACTIVE denetimli) ile kurulur.
// Kuyruk işi DEĞİLDİR (yeni iş türü/`processed_events` yok): denetim yazmaz, bu yüzden `consumeOnce` gerekmez; yinelenen alarm (her koşuda, kapanana dek) kasıtlıdır.
// Log alanları yalnızca kimlik ve sayıdır (kişisel veri yok; G-09).
import type { AbandonedCount } from "@wms/domain/operations";
import type { Logger } from "@wms/shared/log";

/** Saatte bir (A-74 ile aynı ritim; terk süresi saat birimlidir). */
export const COUNT_ABANDON_INTERVAL_MS = 3_600_000;
const FIRST_PAGE = "00000000-0000-0000-0000-000000000000";
const PAGE_SIZE = 500;

export interface CountAbandonDeps {
  /** `queue.listActiveTenantIds` (wms_worker bağlantısı). */
  readonly listActiveTenantIds: (after: string, limit: number) => Promise<readonly string[]>;
  /** `withSystemTenant(db, id, "stock.count.abandon.check", tx => findAbandonedCounts(tx, id))`. */
  readonly checkFor: (tenantId: string) => Promise<readonly AbandonedCount[]>;
  readonly logger: Logger;
}

export interface CountAbandonResult {
  readonly listed: number;
  /** Alarm üretilen oturum sayısı. */
  readonly alarms: number;
  /** Listeleme ile denetim arasında ACTIVE olmaktan çıkan tenant (askı/kapanış) — hata değil. */
  readonly inactive: number;
  readonly failed: number;
  readonly listFailed: boolean;
}

const INACTIVE_CODES: ReadonlySet<string> = new Set(["TENANT_SUSPENDED", "TENANT_CLOSING", "FORBIDDEN"]);
const errName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/** Tek koşu. Hiçbir yolda sessiz OK yok. */
export async function runCountAbandonCheck(deps: CountAbandonDeps): Promise<CountAbandonResult> {
  const { logger } = deps;
  let listed = 0;
  let alarms = 0;
  let inactive = 0;
  let failed = 0;
  let listFailed = false;
  let after = FIRST_PAGE;
  try {
    for (;;) {
      const ids = await deps.listActiveTenantIds(after, PAGE_SIZE);
      listed += ids.length;
      for (const tenantId of ids) {
        try {
          for (const a of await deps.checkFor(tenantId)) {
            alarms += 1;
            logger.error("stock.count.abandoned", {
              tenantId,
              sessionId: a.sessionId,
              warehouseId: a.warehouseId,
              sessionStatus: a.sessionStatus,
              lockedLocations: a.lockedLocations,
              openHours: a.openHours,
              thresholdHours: a.thresholdHours,
            });
          }
        } catch (e) {
          const code = (e as { code?: unknown } | null)?.code;
          if (typeof code === "string" && INACTIVE_CODES.has(code)) {
            inactive += 1;
          } else {
            failed += 1;
            logger.error("stock.count.abandon_check_failed", { tenantId, reason: errName(e) });
          }
        }
      }
      if (ids.length < PAGE_SIZE) break;
      after = ids[ids.length - 1] as string;
    }
  } catch (e) {
    listFailed = true;
    logger.error("stock.count.abandon_list_failed", { listed, alarms, reason: errName(e) });
  }
  const result: CountAbandonResult = { listed, alarms, inactive, failed, listFailed };
  if (listFailed || failed > 0) logger.error("stock.count.abandon_incomplete", { ...result });
  else logger.info("stock.count.abandon_checked", { listed, alarms, inactive });
  return result;
}

export interface CountAbandonScheduleOptions extends CountAbandonDeps {
  readonly intervalMs?: number;
  /** Test: zamanlayıcı enjeksiyonu. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (t: unknown) => void;
}

/** Açılışta bir kez + her `intervalMs`'de koşar; üst üste binen koşu atlanır. Dönen `stop` zamanlayıcıyı durdurur (kapanış, `lifecycle.register`). */
export function startCountAbandonSchedule(options: CountAbandonScheduleOptions): { stop(): void } {
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
    runCountAbandonCheck(options)
      .catch((e: unknown) => options.logger.error("stock.count.abandon_failed", { reason: errName(e) }))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const handle = setTimer(tick, options.intervalMs ?? COUNT_ABANDON_INTERVAL_MS);
  return {
    stop(): void {
      stopped = true;
      clearTimer(handle);
    },
  };
}
