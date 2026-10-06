// Sağlık yoklaması (T-129): `createHealthProbe` gerçek rollerle (wms_app, PgBouncer) ve hata durumlarında.
// Veriler yok: yalnızca `SELECT 1` ve pgboss şema sürümü sütunu okunur.
import net from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHealthProbe, type HealthProbe } from "../../packages/db/src/index.ts";
import { installQueueSchema } from "../../packages/queue-adapter/src/index.ts";
import { readAuthDatabaseUrl, readIntEnv } from "./harness/env.ts";

const env = readIntEnv(process.env);
const probes: HealthProbe[] = [];
const open = (url: string, timeoutMs = 2000, cacheMs = 0, queries?: { db?: string; queue?: string }): HealthProbe => {
  const p = createHealthProbe({ url, timeoutMs, cacheMs, ...(queries === undefined ? {} : { queries }) });
  probes.push(p);
  return p;
};

beforeAll(async () => {
  await installQueueSchema({ url: env.databaseUrlDirect });
});
afterAll(async () => {
  await Promise.all(probes.map((p) => p.close().catch(() => undefined)));
});

async function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe("health probe (wms_app, gerçek DB)", () => {
  it("DB ve kuyruk şeması erişilebilir → ok", async () => {
    expect(await open(env.databaseUrl).check()).toEqual({ db: { ok: true }, queue: { ok: true } });
  });

  it("ulaşılamayan DB → ok:false/error (ayrıntı yok: yalnızca sınıf adı)", async () => {
    const r = await open(`postgresql://wms_app:x@127.0.0.1:${await freePort()}/wms`).check();
    expect(r.db).toMatchObject({ ok: false, reason: "error" });
    expect(JSON.stringify(r)).not.toMatch(/127\.0\.0\.1|wms_app/);
  });

  it("yavaş sorgu sunucu tarafında İPTAL edilir (statement_timeout) → timeout, bağlantı serbest kalır", async () => {
    const probe = open(env.databaseUrl, 1000);
    // Sınanan mekanizma (tx içinde SET LOCAL statement_timeout) PgBouncer arkasında gerçekten sorguyu iptal eder.
    const c = new pg.Client({ connectionString: env.databaseUrl });
    c.on("error", () => undefined);
    await c.connect();
    try {
      const t0 = Date.now();
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout = '300ms'");
      await expect(c.query("SELECT pg_sleep(5)")).rejects.toMatchObject({ code: "57014" });
      await c.query("ROLLBACK");
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      await c.end();
    }
    expect((await probe.check()).db).toEqual({ ok: true });
  });

  it("yanıt vermeyen DB: 50 eşzamanlı istek TEK bağlantı denemesi yapar, havuzu tüketmez, hepsi zaman aşımında biter", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => void sockets.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const probe = open(`postgresql://wms_app:x@127.0.0.1:${port}/wms`, 300, 5000);
      const t0 = Date.now();
      const results = await Promise.all(Array.from({ length: 50 }, () => probe.check()));
      expect(Date.now() - t0).toBeLessThan(3000);
      for (const r of results) expect(r.db).toMatchObject({ ok: false, reason: "timeout" });
      // Tek uçuş + tek bağlantı: sunucu en fazla 1 bağlantı gördü.
      expect(sockets.length).toBeLessThanOrEqual(1);
      // Önbellek: sonraki istek yeni bağlantı açmaz.
      await probe.check();
      expect(sockets.length).toBeLessThanOrEqual(1);
    } finally {
      sockets.forEach((s) => s.destroy());
      server.close();
    }
  });

  it("yoklamanın KENDİ SET LOCAL statement_timeout yolu: yavaş sorgu sunucuda iptal → timeout (gerçek DB, PgBouncer)", async () => {
    const admin = new pg.Client({ connectionString: env.databaseUrlDirect });
    admin.on("error", () => undefined);
    await admin.connect();
    try {
      const probe = open(env.databaseUrl, 300, 0, { db: "SELECT pg_sleep(30) /* t129-probe-sleep */" });
      const t0 = Date.now();
      const r = await probe.check();
      // statement_timeout (300 ms) istemci zaman aşımından (550 ms) önce sorguyu iptal eder: 57014 → timeout, ad PostgresError.
      expect(r.db).toMatchObject({ ok: false, reason: "timeout", errorName: "PostgresError" });
      expect(r.queue).toMatchObject({ ok: false, reason: "timeout" });
      expect(Date.now() - t0).toBeLessThan(2000);
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE '%t129-probe-sleep%' AND state = 'active' AND pid <> pg_backend_pid()");
      expect(rows[0].n).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it("yanıt vermeyen sunucuda ardışık 3 yoklama birikmeden zaman aşımına düşer; takılı bağlantılar kapatılır", async () => {
    const sockets: net.Socket[] = [];
    const closed: Promise<void>[] = [];
    const server = net.createServer((s) => {
      sockets.push(s);
      s.resume(); // gelen veriyi tüket (yanıt vermez); istemci kapatınca 'end'/'close' görülebilsin
      closed.push(new Promise((r) => s.once("close", () => r())));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const probe = open(`postgresql://wms_app:x@127.0.0.1:${port}/wms`, 300, 0);
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        expect((await probe.check()).db).toMatchObject({ ok: false, reason: "timeout" });
        // Her yoklama KENDİ süresinde biter (takılı önceki bağlantının arkasında beklemez).
        expect(Date.now() - t0).toBeLessThan(1200);
      }
      expect(sockets).toHaveLength(3);
      // Takılı bağlantılar istemci tarafından kapatıldı (sunucu 'close' görür).
      await Promise.race([Promise.all(closed), new Promise((_r, rej) => setTimeout(() => rej(new Error("takılı bağlantılar kapatılmadı")), 3000))]);
    } finally {
      sockets.forEach((s) => s.destroy());
      server.close();
    }
  });

  it("pgboss şemasına yetkisi olmayan rol (wms_auth) → kuyruk ok:false, DB ok", async () => {
    const r = await open(readAuthDatabaseUrl(process.env)).check();
    expect(r.db).toEqual({ ok: true });
    expect(r.queue).toMatchObject({ ok: false, reason: "error" });
  });
});
