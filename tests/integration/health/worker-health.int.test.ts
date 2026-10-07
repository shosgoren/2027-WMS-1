// T-282 (dış inceleme bulgu 2): worker durunca / iş tüketilmeyince / kuyruk ilerlemeyince `/api/health` yoklaması KIRMIZI olur. Gerçek roller:
// worker heartbeat'i `wms_worker` ile yazar, sağlık yoklaması `wms_app` (PgBouncer) ile okur; kuyruk satırları migration rolüyle fikstürlenir (sentetik, G-09).
// İzolasyon: dosyalar sıralı koşar; bu dosya `demo.reseed` kuyruğunun mevcut satırlarını geçici tabloya alır (adm oturumu), kendi fikstürlerini koyar ve sonda geri yükler.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WORKER_HEALTH_THRESHOLDS as T, createDbClient, createHealthProbe, recordWorkerHeartbeat, type HealthProbe } from "../../../packages/db/src/index.ts";
import type { DbClient } from "../../../packages/db/src/client.ts";
import { installQueueSchema } from "../../../packages/queue-adapter/src/index.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const QUEUE = "demo.reseed"; // JOB_TYPES'ta; kuyruk satırı installQueueSchema ile var
const INSTANCE = `t282-${randomUUID().slice(0, 8)}`;

let adm: pg.Client;
let workerDb: DbClient;
let appProbe: HealthProbe;

const q = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> => (await adm.query<R>(text, params)).rows;
const beat = (names: readonly string[] = [QUEUE]) => recordWorkerHeartbeat(workerDb, { instanceId: INSTANCE, version: "git-0123abc", startedAt: new Date(), jobNames: names });
const snap = () => appProbe.check();
async function addJob(state: string, cols: { startAgo?: string; startedAgo?: string; completedAgo?: string; expire?: number }): Promise<void> {
  await q(
    `INSERT INTO pgboss.job (id, name, data, state, start_after, started_on, completed_on, expire_seconds)
     VALUES ($1, $2, $3::jsonb, $4::pgboss.job_state, now() - $5::interval, CASE WHEN $6::text IS NULL THEN NULL ELSE now() - $6::text::interval END, CASE WHEN $7::text IS NULL THEN NULL ELSE now() - $7::text::interval END, $8::int)`,
    [randomUUID(), QUEUE, JSON.stringify({ v: 1, tenantId: null, payload: {} }), state, cols.startAgo ?? "0 seconds", cols.startedAgo ?? null, cols.completedAgo ?? null, cols.expire ?? 1800],
  );
}

beforeAll(async () => {
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  await installQueueSchema({ url: env.databaseUrlDirect });
  workerDb = createDbClient({ url: workerUrl, poolMax: 1, prepare: false });
  appProbe = createHealthProbe({ url: env.databaseUrl, timeoutMs: 3000, cacheMs: 0 });
  await q("CREATE TEMP TABLE t282_stash AS SELECT * FROM pgboss.job WHERE name = $1", [QUEUE]);
  await q("DELETE FROM pgboss.job WHERE name = $1", [QUEUE]);
  await q("DELETE FROM wms_health.worker_heartbeats");
}, 120_000);

afterAll(async () => {
  await q("DELETE FROM pgboss.job WHERE name = $1", [QUEUE]).catch(() => undefined);
  await q("INSERT INTO pgboss.job SELECT * FROM t282_stash").catch(() => undefined);
  await q("DELETE FROM wms_health.worker_heartbeats").catch(() => undefined);
  await appProbe?.close().catch(() => undefined);
  await workerDb?.close().catch(() => undefined);
  await adm?.end().catch(() => undefined);
});

beforeEach(async () => {
  await q("DELETE FROM pgboss.job WHERE name = $1", [QUEUE]);
  await q("DELETE FROM wms_health.worker_heartbeats");
});

describe("worker heartbeat + kuyruk ilerleme sağlığı (wms_worker yazar, wms_app okur)", () => {
  it("temizken YEŞİL: worker ve ilerleme ok, sayılar sıfır", async () => {
    await beat();
    const s = await snap();
    expect(s).toMatchObject({ db: { ok: true }, queue: { ok: true }, worker: { ok: true }, progress: { ok: true } });
    expect(s.metrics).toMatchObject({ oldestWaitingSeconds: 0, expiredActive: 0, failedRecent: 0 });
    expect(s.metrics?.workerAgeSeconds).toBeLessThan(T.workerMaxAgeSeconds);
  });

  it("heartbeat HİÇ yok (worker hiç başlamadı) → worker ve ilerleme KIRMIZI (missing)", async () => {
    const s = await snap();
    expect(s.worker).toEqual({ ok: false, reason: "missing" });
    expect(s.progress).toEqual({ ok: false, reason: "missing" });
  });

  it("heartbeat DURUNCA kırmızı (stale); yeniden atış yeşile döndürür", async () => {
    await beat();
    await q("UPDATE wms_health.worker_heartbeats SET last_seen_at = now() - make_interval(secs => $1)", [T.workerMaxAgeSeconds + 60]);
    const stale = await snap();
    expect(stale.worker).toEqual({ ok: false, reason: "stale" });
    expect(stale.progress).toEqual({ ok: true }); // yalnız worker kırmızı: nedeni ayırt edilebilir
    expect(stale.metrics?.workerAgeSeconds).toBeGreaterThan(T.workerMaxAgeSeconds);
    await beat();
    expect((await snap()).worker).toEqual({ ok: true });
  });

  it("eşik içindeki heartbeat (eşikten 30 sn önce) yeşil kalır", async () => {
    await beat();
    await q("UPDATE wms_health.worker_heartbeats SET last_seen_at = now() - make_interval(secs => $1)", [T.workerMaxAgeSeconds - 30]);
    expect((await snap()).worker).toEqual({ ok: true });
  });

  it("ESKİ bekleyen iş varken kırmızı; taze, geleceğe ertelenmiş ve tüketicisiz tür yeşil", async () => {
    await addJob("created", { startAgo: `${T.oldestWaitingMaxSeconds + 120} seconds` });
    await beat();
    const red = await snap();
    expect(red.progress).toEqual({ ok: false, reason: "threshold" });
    expect(red.metrics?.oldestWaitingSeconds).toBeGreaterThan(T.oldestWaitingMaxSeconds);
    expect(red.worker).toEqual({ ok: true });
    // tüketicisi olmayan tür (jobNames dışı): sayılmaz
    await beat([]);
    expect((await snap()).progress).toEqual({ ok: true });
    // taze iş + geleceğe ertelenmiş (start_after > now) iş
    await q("DELETE FROM pgboss.job WHERE name = $1", [QUEUE]);
    await addJob("created", { startAgo: "10 seconds" });
    await addJob("created", { startAgo: "-1 hour" });
    await beat();
    expect((await snap()).progress).toEqual({ ok: true });
  });

  it("eski `retry` işi de bekleyen sayılır", async () => {
    await addJob("retry", { startAgo: `${T.oldestWaitingMaxSeconds + 120} seconds` });
    await beat();
    expect((await snap()).progress).toEqual({ ok: false, reason: "threshold" });
  });

  it("SÜRESİ DOLMUŞ aktif iş varken kırmızı; tolerans içindeki ve süresi dolmamış aktif iş yeşil", async () => {
    await addJob("active", { startedAgo: "2 hours", expire: 60 });
    await beat();
    const red = await snap();
    expect(red.progress).toEqual({ ok: false, reason: "threshold" });
    expect(red.metrics?.expiredActive).toBe(1);
    await q("DELETE FROM pgboss.job WHERE name = $1", [QUEUE]);
    await addJob("active", { startedAgo: `${60 + T.expiredActiveGraceSeconds - 40} seconds`, expire: 60 }); // süresi dolalı < tolerans
    await addJob("active", { startedAgo: "10 seconds", expire: 900 }); // canlı
    await beat();
    const green = await snap();
    expect(green.progress).toEqual({ ok: true });
    expect(green.metrics?.expiredActive).toBe(0);
  });

  it("SON `failed` iş varken kırmızı; pencere dışındaki yeşil", async () => {
    await addJob("failed", { completedAgo: "1 minute" });
    await beat();
    const red = await snap();
    expect(red.progress).toEqual({ ok: false, reason: "threshold" });
    expect(red.metrics?.failedRecent).toBe(1);
    await q("DELETE FROM pgboss.job WHERE name = $1", [QUEUE]);
    await addJob("failed", { completedAgo: `${T.failedWindowSeconds + 600} seconds` });
    await beat();
    expect((await snap()).progress).toEqual({ ok: true });
  });

  it("örnek yeniden atışta satır güncellenir (tek satır); started_at ve instance_id değişmez", async () => {
    await beat();
    const first = (await q<{ started_at: Date }>("SELECT started_at FROM wms_health.worker_heartbeats"))[0];
    await beat();
    const rows = await q<{ instance_id: string; started_at: Date; version: string }>("SELECT instance_id, started_at, version FROM wms_health.worker_heartbeats");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instance_id: INSTANCE, version: "git-0123abc" });
    expect(first).toBeDefined();
  });

  it("1 günden eski başka örnek satırı atışta temizlenir; taze başka örnek kalır", async () => {
    await q("INSERT INTO wms_health.worker_heartbeats (instance_id, version, started_at, last_seen_at) VALUES ('old-x', 'unknown', now(), now() - interval '2 days'), ('new-x', 'unknown', now(), now())");
    await beat();
    expect((await q<{ instance_id: string }>("SELECT instance_id FROM wms_health.worker_heartbeats ORDER BY 1")).map((r) => r.instance_id)).toEqual(["new-x", INSTANCE].sort());
  });

  it("sayaç sorgusu başarısızsa atış FIRLATIR ve satır güncellenmez (sahte yeşil yok)", async () => {
    await beat();
    await q("UPDATE wms_health.worker_heartbeats SET last_seen_at = now() - interval '10 minutes'");
    const before = (await q<{ last_seen_at: Date }>("SELECT last_seen_at FROM wms_health.worker_heartbeats"))[0]?.last_seen_at.getTime();
    const broken = createDbClient({ url: env.databaseUrl, poolMax: 1, prepare: false }); // wms_app: pgboss.job'a SELECT'i tenant RLS'li ve tablo yazımı yok → INSERT reddedilir
    try {
      await expect(recordWorkerHeartbeat(broken, { instanceId: INSTANCE, version: "unknown", startedAt: new Date(), jobNames: [QUEUE] })).rejects.toThrow();
    } finally {
      await broken.close();
    }
    const after = (await q<{ last_seen_at: Date }>("SELECT last_seen_at FROM wms_health.worker_heartbeats"))[0]?.last_seen_at.getTime();
    expect(after).toBe(before);
    expect((await snap()).worker).toEqual({ ok: false, reason: "stale" });
  });
});

describe("worker_heartbeats yetkileri (0025; en dar GRANT)", () => {
  const asRole = async (url: string, fn: (c: pg.Client) => Promise<void>): Promise<void> => {
    const c = new pg.Client({ connectionString: url });
    c.on("error", () => undefined);
    await c.connect();
    try {
      await fn(c);
    } finally {
      await c.end();
    }
  };

  it("wms_app yalnız okuyabilir: INSERT/UPDATE/DELETE reddedilir", async () => {
    await beat();
    await asRole(env.databaseUrl, async (c) => {
      expect((await c.query("SELECT instance_id FROM wms_health.worker_heartbeats")).rowCount).toBe(1);
      for (const stmt of [
        "INSERT INTO wms_health.worker_heartbeats (instance_id, version, started_at) VALUES ('x', 'unknown', now())",
        "UPDATE wms_health.worker_heartbeats SET version = 'unknown'",
        "DELETE FROM wms_health.worker_heartbeats",
      ]) {
        await expect(c.query(stmt)).rejects.toMatchObject({ code: "42501" });
      }
    });
  });

  it("wms_worker instance_id/started_at güncelleyemez; kimlik/sürüm biçimi CHECK ile sınırlı", async () => {
    await beat();
    await asRole(workerUrl, async (c) => {
      await expect(c.query("UPDATE wms_health.worker_heartbeats SET instance_id = 'z'")).rejects.toMatchObject({ code: "42501" });
      await expect(c.query("UPDATE wms_health.worker_heartbeats SET started_at = now()")).rejects.toMatchObject({ code: "42501" });
      await expect(c.query("INSERT INTO wms_health.worker_heartbeats (instance_id, version, started_at) VALUES ('bad id!', 'unknown', now())")).rejects.toMatchObject({ code: "23514" });
      await expect(c.query("INSERT INTO wms_health.worker_heartbeats (instance_id, version, started_at) VALUES ('ok-id', 'postgres://u:p@h/db', now())")).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("wms_health şemasında YALNIZCA bu tablo var; wms_worker'ın public şeması tablo yetkisi hâlâ sıfır (AC-02 değişmezi)", async () => {
    const tables = await q<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'wms_health' ORDER BY 1");
    expect(tables.map((t) => t.table_name)).toEqual(["worker_heartbeats"]);
    const g = await q<{ n: string }>("SELECT count(*)::text AS n FROM information_schema.role_table_grants WHERE grantee = 'wms_worker' AND table_schema = 'public'");
    expect(g[0]?.n).toBe("0");
  });

  it("diğer roller (wms_auth) tabloya erişemez", async () => {
    const authUrl = process.env.AUTH_DATABASE_URL;
    expect(authUrl).toBeDefined();
    await asRole(authUrl as string, async (c) => {
      await expect(c.query("SELECT 1 FROM wms_health.worker_heartbeats")).rejects.toMatchObject({ code: "42501" });
    });
  });
});
