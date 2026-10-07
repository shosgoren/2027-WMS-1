// Worker heartbeat (T-282): süreç canlıyken ve kuyruk sayaçları hesaplanabiliyorken `wms_health.worker_heartbeats` satırını periyodik günceller.
// `/api/health` bu satırın yaşına ve sayaçlarına bakar; worker durur ya da DB'ye yazamazsa satır bayatlar ve uptime kırmızı olur.
// Sayaç/yazma hatası YUTULMAZ ve sahte atış YAPILMAZ: hata loglanır, satır güncellenmez (bayatlama = alarm). Bağlantı `DATABASE_URL_WORKER` (wms_worker).
// Mesajlar sabit dizelerdir (`deploy-smoke` ALLOWED_MSGS).
import { WORKER_HEARTBEAT_INTERVAL_MS, recordWorkerHeartbeat, type DbClient } from "@wms/db";
import type { Logger } from "@wms/shared/log";

export interface WorkerHeartbeatDeps {
  /** `DATABASE_URL_WORKER` (wms_worker) istemcisi. */
  readonly workerDb: DbClient;
  readonly logger: Logger;
  /** Bu worker'ın tükettiği iş türleri (tüketicisiz ertelenmiş türler kuyruk ilerleme sayacına girmez). */
  readonly jobNames: readonly string[];
  readonly instanceId: string;
  readonly version: string;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  /** Test: zamanlayıcı enjeksiyonu. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (t: unknown) => void;
  /** Test: DB yazımı enjeksiyonu. */
  readonly record?: typeof recordWorkerHeartbeat;
}

/** Fly makine kimliği (yoksa ana makine adı + süreç no); `worker_heartbeats_instance_chk` biçimine indirgenir. */
export function workerInstanceId(env: NodeJS.ProcessEnv, hostname: string, pid: number): string {
  const raw = env.FLY_MACHINE_ID?.trim() || `${hostname}-${pid}`;
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 64);
  return cleaned === "" ? "worker" : cleaned;
}

/** `FLY_IMAGE_REF` (`...:git-<sha>`) etiketinden sürüm; biçim dışı → `unknown` (web ile aynı kural). */
export function workerVersion(env: NodeJS.ProcessEnv): string {
  for (const c of [env.APP_VERSION, env.FLY_IMAGE_REF?.split("@")[0]?.split(":").pop()]) {
    if (c !== undefined && /^git-[0-9a-f]{7,40}$/.test(c)) return c;
  }
  return "unknown";
}

/** Tek atış. Asla fırlatmaz; sonuç `true` = satır güncellendi. */
export async function beatOnce(deps: Pick<WorkerHeartbeatDeps, "workerDb" | "logger" | "jobNames" | "instanceId" | "version" | "record">, startedAt: Date): Promise<boolean> {
  const record = deps.record ?? recordWorkerHeartbeat;
  try {
    await record(deps.workerDb, { instanceId: deps.instanceId, version: deps.version, startedAt, jobNames: deps.jobNames });
    return true;
  } catch (err) {
    deps.logger.error("worker.heartbeat.failed", { error: err instanceof Error ? err.name : "unknown" });
    return false;
  }
}

/** Açılışta hemen bir atış, sonra her `intervalMs`'de bir; üst üste binmez. `stop` yalnızca zamanlayıcıyı durdurur. */
export function startWorkerHeartbeat(deps: WorkerHeartbeatDeps): { stop(): void; beats(): number } {
  const intervalMs = deps.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearInterval(t as NodeJS.Timeout));
  const startedAt = (deps.now ?? (() => new Date()))();
  let running = false;
  let beats = 0;
  const tick = (): void => {
    if (running) return;
    running = true;
    void beatOnce(deps, startedAt)
      .then((ok) => {
        if (ok) beats += 1;
      })
      .finally(() => {
        running = false;
      });
  };
  deps.logger.info("worker.heartbeat.started", { intervalMs, instanceId: deps.instanceId });
  tick();
  const timer = setTimer(tick, intervalMs);
  return {
    stop: () => clearTimer(timer),
    beats: () => beats,
  };
}
