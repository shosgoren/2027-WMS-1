// Derin sağlık uç noktası (T-129, A-44): `{ status, db, queue, version }`. `db`: `wms_app` ile `SELECT 1`; `queue`: pg-boss şeması
// erişimi (`pgboss.version`; iş satırı okunmaz). Biri başarısızsa HTTP 503 + `status:"degraded"`; gövdede hata metni YOK
// (ayrıntı yalnızca log'da, G-09). Her yoklama 2 sn ile sınırlıdır. Route Handler ince giriş katmanıdır (ADR-001).
import { getAppDb, pingDatabase, pingQueueSchema, type ProbeResult } from "@wms/db";
import { createConsoleLogger, requestIdFrom } from "@wms/shared/log";

// Derleme zamanında statik üretilmemeli: her istekte gerçek yoklama.
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 2_000;
const logger = createConsoleLogger("web");

/** Fly, imaj etiketini `FLY_IMAGE_REF` (`registry.fly.io/<uygulama>:git-<sha>`) ile verir; `APP_VERSION` ikincil. Biçim dışı → `unknown`. */
function versionOf(env: NodeJS.ProcessEnv): string {
  const candidates = [env.APP_VERSION, env.FLY_IMAGE_REF?.split("@")[0]?.split(":").pop()];
  for (const c of candidates) if (c !== undefined && /^git-[0-9a-f]{7,40}$/.test(c)) return c;
  return "unknown";
}

async function check(name: "db" | "queue", requestId: string | undefined, run: () => Promise<ProbeResult>): Promise<"ok" | "fail"> {
  let result: ProbeResult;
  try {
    result = await run();
  } catch (err) {
    // `getAppDb()` yapılandırma hatası (DATABASE_URL yok) vb.: yalnızca sınıf adı.
    result = { ok: false, reason: "error", errorName: err instanceof Error ? err.name : "unknown" };
  }
  if (result.ok) return "ok";
  logger.error("health check failed", { check: name, reason: result.reason, errorName: result.errorName, requestId });
  return "fail";
}

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request.headers);
  const [db, queue] = await Promise.all([
    check("db", requestId, () => pingDatabase(getAppDb(), PROBE_TIMEOUT_MS)),
    check("queue", requestId, () => pingQueueSchema(getAppDb(), PROBE_TIMEOUT_MS)),
  ]);
  const healthy = db === "ok" && queue === "ok";
  return Response.json(
    { status: healthy ? "ok" : "degraded", db, queue, version: versionOf(process.env) },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
