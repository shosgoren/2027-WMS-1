// `demo.reseed` işi (T-123; A-43): demo tenant'ın kullanıcı/üyelik/ayar onarımı. YALNIZCA local/staging + DEMO_MODE=1.
//
// - İş yükü tenant kimliği taşımaz (`{}` strict); tenant `DEMO_TENANT_ID` sabitidir (packages/db). Handler tenant verisine
//   `ctx.inTenant` ile DEĞİL, domain komutlarıyla (`reseedDemo`: withSystemTenant 'demo.bootstrap' + demo sahibi
//   withMembership) wms_app havuzundan erişir (T-115c modeli: kuyruk wms_worker, tenant verisi wms_app).
// - Zamanlama: pg-boss `schedule` kapalıdır (adaptör `schedule: false`); açılışta bir kez + günlük 03:00 UTC işi
//   `singletonKey` ile kuyruğa yazan süreç içi zamanlayıcı. Eşzamanlı iki örnekte tek iş oluşur (singleton).
import { loadDemoSeedConfig, nextDailyRunUtc, reseedDemo, type DemoAccountPort } from "@wms/domain/demo/seed";
import type { createDbClient } from "@wms/db";
import type { AccessDbClient } from "@wms/domain/identity/access";
import type { EnqueueResult, JobHandler } from "@wms/shared/queue";
import type { Logger } from "../lifecycle.js";

export const DEMO_RESEED_SINGLETON_KEY = "demo.reseed";
export const DEMO_RESEED_HOUR_UTC = 3;

type DbClient = ReturnType<typeof createDbClient>;
type DemoAdapterModule = Pick<typeof import("@wms/auth/demo-accounts"), "createDemoAccountPort" | "parseDemoDomain">;

export interface DemoRegistrationOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly db: AccessDbClient;
  readonly logger: Logger;
  /** `wms_auth` havuzu açar; YALNIZCA demo açık ve `AUTH_DATABASE_URL` varken çağrılır (A-63). */
  readonly openAuthDb: (url: string) => DbClient;
  /** Varsayılan: dinamik `import("@wms/auth/demo-accounts")` (prod yolu bu modüle ve argon2'ye hiç dokunmaz). */
  readonly loadAdapter?: () => Promise<DemoAdapterModule>;
  readonly setTimer?: DemoReseedScheduleOptions["setTimer"];
  readonly clearTimer?: DemoReseedScheduleOptions["clearTimer"];
  readonly now?: () => Date;
}

export interface DemoRegistration {
  readonly handler: JobHandler<"demo.reseed"> | undefined;
  /** Demo kapalıysa `undefined` döner ve zamanlayıcı BAŞLATILMAZ. */
  startSchedule(enqueue: () => Promise<EnqueueResult>): { stop(): void } | undefined;
  close(): Promise<void>;
}

/**
 * Demo kaydı (T-123 + T-123a, A-63). Fail-closed: `WMS_ENV` ∉ local|staging, `DEMO_MODE`≠1 veya parola geçersizse hiçbir
 * şey kurulmaz (`wms_auth` havuzu açılmaz, bağdaştırıcı yüklenmez, iş kaydedilmez, zamanlayıcı başlamaz). Açıkken
 * yapılandırma eksikse (`AUTH_DATABASE_URL`/`DEMO_EMAIL_DOMAIN`) iş kaydedilmez ve açıkça loglanır (G-07). Rol doğrulaması
 * (`current_user = 'wms_auth'`) ve ortam hataları FIRLATILIR (çağıran açılışı düşürür).
 */
export async function registerDemoReseed(options: DemoRegistrationOptions): Promise<DemoRegistration> {
  const { env, db, logger } = options;
  const none: DemoRegistration = { handler: undefined, startSchedule: () => undefined, close: async () => undefined };
  const demo = loadDemoSeedConfig(env);
  if (!demo.enabled) {
    logger.info("demo disabled", { reason: demo.reason });
    return none;
  }
  const authUrl = env.AUTH_DATABASE_URL?.trim();
  if (authUrl === undefined || authUrl === "") {
    logger.error("demo disabled: account adapter configuration missing (AUTH_DATABASE_URL); demo.reseed not registered");
    return none;
  }
  const adapter = await (options.loadAdapter ?? (() => import("@wms/auth/demo-accounts")))();
  if (adapter.parseDemoDomain(env.DEMO_EMAIL_DOMAIN) === null) {
    logger.error("demo disabled: account adapter configuration missing (DEMO_EMAIL_DOMAIN); demo.reseed not registered");
    return none;
  }
  const authDb = options.openAuthDb(authUrl);
  try {
    const accounts = adapter.createDemoAccountPort({ authDb, env });
    await accounts.verifyRole();
    const handler = createDemoReseedHandler({ db, accounts, password: demo.password, logger });
    return {
      handler,
      startSchedule: (enqueue) =>
        startDemoReseedSchedule({
          logger,
          enqueue,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
          ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
        }),
      close: () => authDb.close(),
    };
  } catch (error) {
    await authDb.close().catch(() => undefined);
    throw error;
  }
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
