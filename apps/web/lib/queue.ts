// Web sürecinin iş kuyruğu istemcisi (T-117 MAJOR-2): YALNIZCA GÖNDEREN pg-boss istemcisi. Bu süreçte `work()` çağrılmaz
// (tüketici yok), `supervise`/örnek kaydı/zamanlayıcı kapalıdır (queue-adapter varsayılanı) ve kuyruk şeması KURULMAZ
// (`migrate: false`; `start()` yalnızca şemanın kurulu olduğunu doğrular). Tüketim `apps/worker`'dadır.
// `enqueue` işi çağıranın tenant transaction'ında yazar; istemci transaction DIŞINDA önceden başlatılmalıdır.
import { createJobQueue, type PgBossJobQueue } from "@wms/queue-adapter";

const logError = (msg: string, fields?: Record<string, unknown>): void => {
  console.error(JSON.stringify({ level: "error", msg, ...fields }));
};

let queue: PgBossJobQueue | undefined;

/**
 * Başlatılmış gönderen kuyruk; `DATABASE_URL` yoksa veya başlatma başarısızsa `undefined` (çağıran A-42 ekran geri
 * dönüşünü kullanır). Hata maskeli loglanır: yalnızca sınıf adı (bağlantı bilgisi/URL sızmaz, G-09). Başarısız
 * başlatma önbelleğe alınmaz (sonraki istek yeniden dener).
 */
export async function getSenderQueue(): Promise<PgBossJobQueue | undefined> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    logError("web queue unavailable", { reason: "DATABASE_URL not configured" });
    return undefined;
  }
  try {
    queue ??= createJobQueue({ connectionString: url, max: 2, logger: { error: logError } });
    await queue.start();
    return queue;
  } catch (err) {
    queue = undefined;
    logError("web queue start failed", { error: err instanceof Error ? err.name : "unknown" });
    return undefined;
  }
}
