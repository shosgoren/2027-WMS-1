// Sağlık denetimi (T-129): `/api/health` için YALNIZCA salt-okunur, tenant'sız yoklamalar. Web rolü (`wms_app`) ile çalışır;
// satır içeriği okunmaz (yalnızca `SELECT 1` ve pgboss şema sürümü sütunu, `wms_app` için `GRANT SELECT (version)` var).
// Hata ayrıntısı DÖNMEZ (bağlantı bilgisi/SQL sızmasın, G-09): çağıran yalnızca ok/fail görür, sınıf adı log'a gider.
//
// Havuz tükenmesine karşı (güvenlik incelemesi MAJOR-1): yoklama uygulama havuzunu KULLANMAZ; ayrı, `max: 1` bağlantıyla çalışır.
// Sorgu tx içinde `SET LOCAL statement_timeout` ile sunucu tarafında İPTAL edilir (transaction-mode PgBouncer ile uyumlu; başlangıç
// parametresi yok; yalnızca SORGU çalışırken geçerlidir), bağlanma `connect_timeout` ile sınırlıdır. PgBouncer'ın sunucu-bağlantısı
// KUYRUĞUNDA bekleyen (henüz sorgusu başlamamış) ya da hiç yanıt gelmeyen yoklamada sunucu tarafı zaman aşımı devreye GİRMEZ: bu durumda
// istemci zaman aşımı (`timeoutMs + 250`) bağlantıyı KAPATIR ve istemciyi yeniden kurar; sonraki yoklama takılı bağlantının arkasında birikmez. Aynı anda yalnızca BİR yoklama koşar (uçuştaki söz paylaşılır) ve
// sonuç kısa süre (`cacheMs`, varsayılan 5 sn) önbellekten döner: eşzamanlı çok sayıda istek DB'ye en fazla 1 bağlantı/2 sorgu yükler.
//
// Worker/kuyruk ilerlemesi (T-282, dış inceleme bulgu 2): `queue` yalnız pgboss şemasının okunabildiğini gösterir; worker durursa YEŞİL kalırdı.
// Bu yüzden worker her `WORKER_HEARTBEAT_INTERVAL_MS`'de `wms_health.worker_heartbeats` satırını (0025) günceller ve kuyruk sayaçlarını
// (en eski bekleyen iş yaşı, süresi dolmuş `active` sayısı, son penceredeki `failed` sayısı) kendi `wms_worker` görünümünden yazar
// (wms_app tenant RLS'i yüzünden `pgboss.job` satırlarını göremez). Sağlık ucu yalnız bu tek satırı (yaş + 3 sayı) okur; iş yükü/tenant okunmaz.
// Sapma kaynağı yoktur: yaş veritabanı saatiyle hesaplanır. Yalnız durum ve sayılar döner (G-09).
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { rawDb, type DbClient } from "./client.ts";

/**
 * Eşikler (A-282-1…A-282-4; gerekçe docs/OPEN_QUESTIONS.md). Değiştirmek bilinçli bir karardır: testler bu sabitlere bağlıdır.
 */
export const WORKER_HEALTH_THRESHOLDS = Object.freeze({
  /** Heartbeat en fazla bu kadar eski olabilir (30 sn aralığın 4 katı: bir-iki kaçan atış ve kısa DB takılması yanlış alarm vermez). */
  workerMaxAgeSeconds: 120,
  /** Hazır (`created`/`retry`, `start_after` geçmiş) en eski iş bu kadardan eski olamaz (en kısa iş süresi 300 sn; sağlıklı kuyruk saniyeler içinde tüketir). */
  oldestWaitingMaxSeconds: 300,
  /** `expire_seconds` geçtikten sonra bu tolerans içinde bakım turu (60 sn) işi kurtarmış olmalıdır; sonrası hâlâ `active` ise bakım çalışmıyordur. */
  expiredActiveGraceSeconds: 120,
  /** İzin verilen süresi dolmuş `active` sayısı (tolerans sonrası). */
  expiredActiveMax: 0,
  /** `failed` (deneme hakkı tükenmiş kalıcı hata) sayımının penceresi: uptime aralığının (15 dk) iki katı, böylece her koşu görür. */
  failedWindowSeconds: 1800,
  /** Pencerede izin verilen `failed` sayısı: kalıcı başarısız iş her zaman operatör eylemidir (RUNBOOK-ops §Kuyruk bakımı). */
  failedRecentMax: 0,
});

/** Worker'ın heartbeat atış aralığı (ms); `workerMaxAgeSeconds` bunun 4 katıdır. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

export type ProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "timeout" | "error" | "missing" | "stale" | "threshold"; readonly errorName?: string };
/** Sağlık yanıtına giren sayılar (iş yükü/tenant yok). */
export interface WorkerMetrics {
  readonly workerAgeSeconds: number;
  readonly oldestWaitingSeconds: number;
  readonly expiredActive: number;
  readonly failedRecent: number;
}
export interface HealthSnapshot {
  readonly db: ProbeResult;
  readonly queue: ProbeResult;
  /** Worker heartbeat'i taze mi (≤ eşik)? Kayıt yoksa `missing`. */
  readonly worker: ProbeResult;
  /** Kuyruk ilerlemesi eşik içinde mi (en eski bekleyen, süresi dolmuş aktif, son `failed`)? */
  readonly progress: ProbeResult;
  readonly metrics?: WorkerMetrics;
}

/** Saf değerlendirme (birim test): satır yoksa (`undefined`) ikisi de `missing`. */
export function evaluateWorkerMetrics(m: WorkerMetrics | undefined): { worker: ProbeResult; progress: ProbeResult } {
  if (m === undefined) return { worker: { ok: false, reason: "missing" }, progress: { ok: false, reason: "missing" } };
  const t = WORKER_HEALTH_THRESHOLDS;
  const worker: ProbeResult = m.workerAgeSeconds <= t.workerMaxAgeSeconds ? { ok: true } : { ok: false, reason: "stale" };
  const progressOk = m.oldestWaitingSeconds <= t.oldestWaitingMaxSeconds && m.expiredActive <= t.expiredActiveMax && m.failedRecent <= t.failedRecentMax;
  return { worker, progress: progressOk ? { ok: true } : { ok: false, reason: "threshold" } };
}
export interface HealthProbe {
  /** Önbellekteki (≤ `cacheMs`) ya da uçuştaki yoklamayı döndürür; yoksa yenisini başlatır. Asla fırlatmaz. */
  check(): Promise<HealthSnapshot>;
  close(): Promise<void>;
}
export interface HealthProbeOptions {
  readonly url: string;
  /** Her yoklama için üst sınır (ms); varsayılan 2000. */
  readonly timeoutMs?: number;
  /** Sonuç önbellek süresi (ms); varsayılan 5000. */
  readonly cacheMs?: number;
  readonly now?: () => number;
  /** YALNIZCA testler: yoklama sorgularını değiştirir (ör. `pg_sleep` ile sunucu tarafı iptali). Üretimde verilmez. */
  readonly queries?: { readonly db?: string; readonly queue?: string; readonly worker?: string };
}

const QUEUE_SQL = "SELECT version FROM pgboss.version LIMIT 1";
// Yaş veritabanı saatiyle (`now()`); en taze örnek (çok örnekli worker'da biri yaşıyorsa yeterli). Yalnız sayılar okunur.
const WORKER_SQL = `SELECT floor(extract(epoch FROM (now() - last_seen_at)))::int AS age_s, oldest_waiting_age_s, expired_active, failed_recent
  FROM wms_health.worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1`;

export function createHealthProbe(options: HealthProbeOptions): HealthProbe {
  const timeoutMs = options.timeoutMs ?? 2000;
  const cacheMs = options.cacheMs ?? 5000;
  const now = options.now ?? Date.now;
  const make = (): postgres.Sql =>
    postgres(options.url, {
      max: 1,
      prepare: false,
      connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
      idle_timeout: 30,
      onnotice: () => undefined,
    });
  let sql = make();
  const queries = { db: options.queries?.db ?? "SELECT 1", queue: options.queries?.queue ?? QUEUE_SQL, worker: options.queries?.worker ?? WORKER_SQL };

  async function probeOne(query: string | null, read?: (rows: readonly Record<string, unknown>[]) => void): Promise<ProbeResult> {
    let timer: NodeJS.Timeout | undefined;
    const client = sql;
    const guard = new Promise<"timeout">((resolve) => {
      // Sunucu iptali (statement_timeout) birincil; bu yalnızca bağlanma/ağ takılmasına karşı son çare.
      timer = setTimeout(() => resolve("timeout"), timeoutMs + 250);
    });
    try {
      const run = client
        .begin(async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(timeoutMs))}ms'`);
          const rows = await tx.unsafe(query ?? queries.db);
          read?.(rows as unknown as readonly Record<string, unknown>[]);
        })
        .then(() => "ok" as const);
      // Race kaybedilirse `run` sonradan reddedilebilir: yutulur (tek bağlantı sorgu iptaliyle serbest kalır).
      run.catch(() => undefined);
      const outcome = await Promise.race([run, guard]);
      if (outcome === "ok") return { ok: true };
      // İstemci zaman aşımı: takılı bağlantıyı kapat, yeni istemciyle devam et (eski olanı arka planda sonlandır).
      if (sql === client) sql = make();
      void client.end({ timeout: 0 }).catch(() => undefined);
      return { ok: false, reason: "timeout" };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      return { ok: false, reason: code === "57014" ? "timeout" : "error", errorName: err instanceof Error ? err.name : "unknown" };
    } finally {
      clearTimeout(timer);
    }
  }

  let cached: { at: number; value: HealthSnapshot } | undefined;
  let inflight: Promise<HealthSnapshot> | undefined;

  return {
    check() {
      if (cached !== undefined && now() - cached.at < cacheMs) return Promise.resolve(cached.value);
      inflight ??= (async () => {
        try {
          // Aynı tek bağlantıda sırayla: önce db; db yanıt vermiyorsa kuyruk denenmez (aynı nedenle başarısız sayılır: 2. bekleme yok).
          const db = await probeOne(null);
          const queue: ProbeResult = db.ok ? await probeOne(queries.queue) : { ok: false, reason: db.reason, ...(db.errorName === undefined ? {} : { errorName: db.errorName }) };
          // Worker/ilerleme yoklaması yalnız kuyruk şeması okunabildiyse (aynı bağlantı sağlıklı) denenir; hata durumunda ikisi de aynı nedenle başarısız.
          const failedWith = (r: ProbeResult): ProbeResult => (r.ok ? { ok: false, reason: "error" } : r);
          let worker: ProbeResult = failedWith(queue);
          let progress: ProbeResult = worker;
          let metrics: WorkerMetrics | undefined;
          if (queue.ok) {
            let row: Record<string, unknown> | undefined;
            const read = await probeOne(queries.worker, (rows) => void (row = rows[0]));
            if (!read.ok) {
              worker = read;
              progress = read;
            } else {
              const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v));
              metrics =
                row === undefined
                  ? undefined
                  : { workerAgeSeconds: num(row["age_s"]), oldestWaitingSeconds: num(row["oldest_waiting_age_s"]), expiredActive: num(row["expired_active"]), failedRecent: num(row["failed_recent"]) };
              ({ worker, progress } = evaluateWorkerMetrics(metrics));
            }
          }
          const value: HealthSnapshot = { db, queue, worker, progress, ...(metrics === undefined ? {} : { metrics }) };
          cached = { at: now(), value };
          return value;
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    },
    async close() {
      await sql.end({ timeout: 1 });
    },
  };
}

export interface WorkerHeartbeatInput {
  readonly instanceId: string;
  readonly version: string;
  readonly startedAt: Date;
  /** Bu worker'ın tükettiği iş türleri: tüketicisi olmayan (ertelenmiş) türün bekleyen işleri "kuyruk ilerlemiyor" sayılmaz. */
  readonly jobNames: readonly string[];
}

/**
 * Worker heartbeat'ini yazar (`wms_worker` istemcisi): kuyruk sayaçlarını hesaplar ve kendi satırını upsert eder; 1 günden eski örnek satırlarını siler.
 * Sayaç sorgusu başarısız olursa FIRLATIR ve satır GÜNCELLENMEZ: heartbeat bayatlar ve sağlık kırmızı olur (sahte yeşil yok, G-07).
 * `failed` penceresi `completed_on`'a bakar; süresi dolmuş `active` tespiti `requeueExpiredJobs` ile aynı ifadedir (+ tolerans).
 */
export async function recordWorkerHeartbeat(db: DbClient, input: WorkerHeartbeatInput): Promise<void> {
  const t = WORKER_HEALTH_THRESHOLDS;
  await rawDb(db).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    await tx.execute(sql`
      WITH m AS (
        SELECT
          coalesce(floor(extract(epoch FROM (pgboss.job_now() - min(start_after) FILTER (WHERE state IN ('created', 'retry') AND start_after <= pgboss.job_now()))))::int, 0) AS oldest,
          (count(*) FILTER (WHERE state = 'active' AND (started_on + expire_seconds * interval '1 second') < pgboss.job_now() - make_interval(secs => ${t.expiredActiveGraceSeconds}::int)))::int AS expired,
          (count(*) FILTER (WHERE state = 'failed' AND completed_on > pgboss.job_now() - make_interval(secs => ${t.failedWindowSeconds}::int)))::int AS failed
          FROM pgboss.job
         WHERE name::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(input.jobNames)}::jsonb))
      )
      INSERT INTO wms_health.worker_heartbeats (instance_id, version, started_at, last_seen_at, oldest_waiting_age_s, expired_active, failed_recent)
      SELECT ${input.instanceId}, ${input.version}, ${input.startedAt.toISOString()}::timestamptz, now(), m.oldest, m.expired, m.failed FROM m
      ON CONFLICT (instance_id) DO UPDATE
        SET version = EXCLUDED.version, last_seen_at = EXCLUDED.last_seen_at,
            oldest_waiting_age_s = EXCLUDED.oldest_waiting_age_s, expired_active = EXCLUDED.expired_active, failed_recent = EXCLUDED.failed_recent`);
    await tx.execute(sql`DELETE FROM wms_health.worker_heartbeats WHERE last_seen_at < now() - interval '1 day' AND instance_id <> ${input.instanceId}`);
  });
}

const PROBE_KEY = Symbol.for("@wms/db/health-probe");

/** Süreç başına tek yoklayıcı (`DATABASE_URL`, rol `wms_app`). `DATABASE_URL` yoksa hata (URL mesaja girmez). */
export function getHealthProbe(): HealthProbe {
  const g = globalThis as { [PROBE_KEY]?: HealthProbe };
  const existing = g[PROBE_KEY];
  if (existing !== undefined) return existing;
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === "") throw new Error("getHealthProbe: DATABASE_URL is not configured");
  const probe = createHealthProbe({ url });
  g[PROBE_KEY] = probe;
  return probe;
}
