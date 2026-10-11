// Derin sağlık uç noktası (T-129, A-44; T-282): `{ status, db, queue, worker, metrics, version }`. `db`: `wms_app` ile `SELECT 1`; `queue`: pg-boss şeması
// erişimi (`pgboss.version`) VE kuyruk ilerlemesi eşik içinde (en eski bekleyen iş, süresi dolmuş `active`, son `failed`; sayaçları worker yazar);
// `worker`: son heartbeat yaşı ≤ eşik. `metrics` yalnızca sayılardır (iş yükü/tenant yok, G-09). Biri başarısızsa HTTP 503 + `status:"degraded"`; gövdede hata metni YOK
// (ayrıntı yalnızca log'da, G-09). Yoklama ayrı tek bağlantıyla, 2 sn sunucu tarafı iptaliyle ve 5 sn önbellek/tek-uçuşla yapılır
// (uygulama havuzunu tüketmez; bkz. packages/db/src/health.ts). Fly makine denetimi bu uca BAĞLANMAZ: sığ `/api/health/live`. Route Handler ince giriş katmanıdır (ADR-001).
import { getHealthProbe, type HealthSnapshot, type ProbeResult } from "@wms/db";
import { createConsoleLogger, requestIdFrom } from "@wms/shared/log";

// Derleme zamanında statik üretilmemeli: her istekte gerçek yoklama.
export const dynamic = "force-dynamic";

const logger = createConsoleLogger("web");

/** Fly, imaj etiketini `FLY_IMAGE_REF` (`registry.fly.io/<uygulama>:git-<sha>`) ile verir; `APP_VERSION` ikincil. Biçim dışı → `unknown`. */
function versionOf(env: NodeJS.ProcessEnv): string {
  const candidates = [env.APP_VERSION, env.FLY_IMAGE_REF?.split("@")[0]?.split(":").pop()];
  for (const c of candidates) if (c !== undefined && /^git-[0-9a-f]{7,40}$/.test(c)) return c;
  return "unknown";
}

function report(name: "db" | "queue" | "worker" | "queue-progress", requestId: string | undefined, result: ProbeResult): "ok" | "fail" {
  if (result.ok) return "ok";
  logger.error("health check failed", { check: name, reason: result.reason, errorName: result.errorName, requestId });
  return "fail";
}

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request.headers);
  let snapshot: HealthSnapshot;
  try {
    snapshot = await getHealthProbe().check();
  } catch (err) {
    // Yapılandırma hatası (DATABASE_URL yok) vb.: yalnızca sınıf adı.
    const failed: ProbeResult = { ok: false, reason: "error", errorName: err instanceof Error ? err.name : "unknown" };
    snapshot = { db: failed, queue: failed, worker: failed, progress: failed };
  }
  const db = report("db", requestId, snapshot.db);
  const schema = report("queue", requestId, snapshot.queue);
  const progress = report("queue-progress", requestId, snapshot.progress);
  const worker = report("worker", requestId, snapshot.worker);
  const queue = schema === "ok" && progress === "ok" ? "ok" : "fail";
  const healthy = db === "ok" && queue === "ok" && worker === "ok";
  return Response.json(
    { status: healthy ? "ok" : "degraded", db, queue, worker, ...(snapshot.metrics === undefined ? {} : { metrics: snapshot.metrics }), version: versionOf(process.env) },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
