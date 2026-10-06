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
import postgres from "postgres";

export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: "timeout" | "error"; readonly errorName?: string };
export interface HealthSnapshot {
  readonly db: ProbeResult;
  readonly queue: ProbeResult;
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
  readonly queries?: { readonly db?: string; readonly queue?: string };
}

const QUEUE_SQL = "SELECT version FROM pgboss.version LIMIT 1";

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
  const queries = { db: options.queries?.db ?? "SELECT 1", queue: options.queries?.queue ?? QUEUE_SQL };

  async function probeOne(query: string | null): Promise<ProbeResult> {
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
          await tx.unsafe(query ?? queries.db);
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
          const value = { db, queue };
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
