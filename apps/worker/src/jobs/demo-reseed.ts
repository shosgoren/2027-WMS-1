// `demo.reseed` işi (T-123; A-43): demo tenant'ın kullanıcı/üyelik/ayar onarımı. YALNIZCA local/staging + DEMO_MODE=1.
//
// - İş yükü tenant kimliği taşımaz (`{}` strict); tenant `DEMO_TENANT_ID` sabitidir (packages/db). Handler tenant verisine
//   `ctx.inTenant` ile DEĞİL, domain komutlarıyla (`reseedDemo`: withSystemTenant 'demo.bootstrap' + demo sahibi
//   withMembership) wms_app havuzundan erişir (T-115c modeli: kuyruk wms_worker, tenant verisi wms_app).
// - Zamanlama: pg-boss `schedule` kapalıdır (adaptör `schedule: false`); açılışta bir kez + günlük 03:00 UTC işi
//   `singletonKey` ile kuyruğa yazan süreç içi zamanlayıcı. Eşzamanlı iki örnekte tek iş oluşur (singleton).
import { nextDailyRunUtc, reseedDemo, type DemoAccountPort } from "@wms/domain/demo/seed";
import type { AccessDbClient } from "@wms/domain/identity/access";
import type { EnqueueResult, JobHandler } from "@wms/shared/queue";
import type { Logger } from "../lifecycle.js";

export const DEMO_RESEED_SINGLETON_KEY = "demo.reseed";
export const DEMO_RESEED_HOUR_UTC = 3;

/**
 * Gerçek kimlik hesabı bağdaştırıcısı (Better Auth / `wms_auth`) `packages/auth` kapsamındadır ve bu kartın dosya
 * listesinde yoktur (T-123 raporu Bulgu-1): users/accounts yalnızca `wms_auth` ile yazılabilir ve `packages/auth`
 * demo hesabı açma/parola eşitleme yüzeyi sunmaz. Bağdaştırıcı bağlanana kadar `undefined` döner; çağıran demo işini
 * KAYDETMEZ ve açıkça loglar (sahte başarı yok, G-07).
 */
export function resolveDemoAccountPort(): DemoAccountPort | undefined {
  return undefined;
}

export interface DemoReseedDeps {
  readonly db: AccessDbClient;
  readonly accounts: DemoAccountPort;
  /** Yalnızca `loadDemoSeedConfig` sonucundan; loglanmaz. */
  readonly password: string;
  readonly logger: Logger;
}

export function createDemoReseedHandler(deps: DemoReseedDeps): JobHandler<"demo.reseed"> {
  return async (ctx) => {
    try {
      const r = await reseedDemo({ db: deps.db, accounts: deps.accounts, password: deps.password });
      deps.logger.info("demo.reseed done", {
        jobId: ctx.jobId,
        accountsCreated: r.accountsCreated,
        passwordsUpdated: r.passwordsUpdated,
        bootstrapped: r.bootstrapped,
        membershipsCreated: r.memberships.created,
        membershipsReactivated: r.memberships.reactivated,
        rolesFixed: r.memberships.rolesFixed,
        membershipsRemoved: r.memberships.removed,
        ownershipChanged: r.memberships.ownershipChanged,
        settingsChanged: r.settings.nameOrLocaleChanged || r.settings.templateChanged,
      });
    } catch (err) {
      // Ayrıntı (SQL/parametre) loglanmaz: yalnızca hata adı/kodu (G-09). Hata yutulmaz → pg-boss yeniden dener.
      const code = (err as { code?: unknown } | null)?.code;
      deps.logger.error("demo.reseed failed", { jobId: ctx.jobId, error: err instanceof Error ? err.name : "unknown", ...(typeof code === "string" ? { code } : {}) });
      throw err;
    }
  };
}

export interface DemoReseedScheduleOptions {
  /** İşi `singletonKey: DEMO_RESEED_SINGLETON_KEY` ile kuyruğa yazar (tenant bağlamı çağıranda kurulur). */
  readonly enqueue: () => Promise<EnqueueResult>;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Açılışta bir kez, sonra her gün 03:00 UTC'de `enqueue` çağırır. Hata loglanır, sonraki tur yine denenir. */
export function startDemoReseedSchedule(options: DemoReseedScheduleOptions): { stop(): void } {
  const { enqueue, logger } = options;
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  });
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  let stopped = false;
  let handle: unknown;

  const fire = async (reason: "boot" | "daily"): Promise<void> => {
    try {
      const r = await enqueue();
      logger.info("demo.reseed enqueued", { reason, queued: r.jobId !== null });
    } catch (err) {
      logger.error("demo.reseed enqueue failed", { reason, error: err instanceof Error ? err.name : "unknown" });
    }
  };
  const arm = (): void => {
    if (stopped) return;
    const delay = nextDailyRunUtc(now(), DEMO_RESEED_HOUR_UTC).getTime() - now().getTime();
    handle = setTimer(() => {
      void fire("daily").finally(arm);
    }, Math.max(1000, delay));
  };

  void fire("boot");
  arm();
  return {
    stop(): void {
      stopped = true;
      if (handle !== undefined) clearTimer(handle);
    },
  };
}
