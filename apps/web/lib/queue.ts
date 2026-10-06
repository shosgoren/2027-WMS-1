// Web sürecinin iş kuyruğu istemcisi (T-117 MAJOR-2): YALNIZCA GÖNDEREN pg-boss istemcisi. Bu süreçte `work()` çağrılmaz
// (tüketici yok), `supervise`/örnek kaydı/zamanlayıcı kapalıdır (queue-adapter varsayılanı) ve kuyruk şeması KURULMAZ
// (`migrate: false`; `start()` yalnızca şemanın kurulu olduğunu doğrular). Tüketim `apps/worker`'dadır.
// `enqueue` işi çağıranın tenant transaction'ında yazar; istemci transaction DIŞINDA önceden başlatılmalıdır.
import { createJobQueue, type PgBossJobQueue } from "@wms/queue-adapter";
import { createConsoleLogger } from "@wms/shared/log";

// Yapılandırılmış, maskeli JSON log (T-129): `ts, level, msg, service` + alanlar.
const logger = createConsoleLogger("web");
const logError = (msg: string, fields?: Record<string, unknown>): void => {
  logger.error(msg, fields);
};

/** Süreç başına tek başlatma sözü: eşzamanlı istekler aynı örneği/aynı başlatmayı paylaşır. Başarısızlık önbelleğe alınmaz. */
let pending: Promise<PgBossJobQueue | undefined> | undefined;

async function startSender(): Promise<PgBossJobQueue | undefined> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    logError("web queue unavailable", { reason: "DATABASE_URL not configured" });
    return undefined;
  }
  const queue = createJobQueue({ connectionString: url, max: 2, logger: { error: logError } });
  try {
    await queue.start();
    return queue;
  } catch (err) {
    // Hata maskeli loglanır: yalnızca sınıf adı (bağlantı bilgisi/URL sızmaz, G-09).
    logError("web queue start failed", { error: err instanceof Error ? err.name : "unknown" });
    // Başarısız başlatma havuzu açık bırakmaz (pgbouncer bağlantı tükenmesi): örnek kapatılır.
    try {
      await queue.stop();
    } catch (stopErr) {
      logError("web queue cleanup failed", { error: stopErr instanceof Error ? stopErr.name : "unknown" });
    }
    return undefined;
  }
}

/**
 * Başlatılmış gönderen kuyruk; `DATABASE_URL` yoksa veya başlatma başarısızsa `undefined` (çağıran A-42 ekran geri
 * dönüşünü kullanır). Başarısız başlatma sonraki istekte yeniden denenir.
 */
export function getSenderQueue(): Promise<PgBossJobQueue | undefined> {
  const attempt = (pending ??= startSender());
  void attempt.then((q) => {
    if (q === undefined && pending === attempt) pending = undefined;
  });
  return attempt;
}

/** Süreç kapanışı/testler: başlatılmış istemciyi kapatır ve önbelleği sıfırlar. */
export async function closeSenderQueue(): Promise<void> {
  const attempt = pending;
  pending = undefined;
  const queue = await attempt;
  await queue?.stop();
}
