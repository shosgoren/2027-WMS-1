// Sağlık yoklamaları (T-129): `pingDatabase` / `pingQueueSchema` gerçek rollerle (wms_app, PgBouncer) ve hata durumlarında.
// Veriler yok: yalnızca `SELECT 1` ve pgboss şema sürümü sütunu okunur.
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, pingDatabase, pingQueueSchema, type DbClient } from "../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS } from "../../packages/db/src/client.ts";
import { installQueueSchema } from "../../packages/queue-adapter/src/index.ts";
import { readAuthDatabaseUrl, readIntEnv } from "./harness/env.ts";

const env = readIntEnv(process.env);
const clients: DbClient[] = [];
const open = (url: string): DbClient => {
  const c = createDbClient({ url, ...DB_CLIENT_SETTINGS });
  clients.push(c);
  return c;
};

beforeAll(async () => {
  await installQueueSchema({ url: env.databaseUrlDirect });
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
});

describe("health probes (wms_app, gerçek DB)", () => {
  it("DB ve kuyruk şeması erişilebilir → ok", async () => {
    const app = open(env.databaseUrl);
    expect(await pingDatabase(app, 2000)).toEqual({ ok: true });
    expect(await pingQueueSchema(app, 2000)).toEqual({ ok: true });
  });

  it("ulaşılamayan DB → ok:false/error (ayrıntı yok: yalnızca sınıf adı)", async () => {
    const dead = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const client = open(`postgresql://wms_app:x@127.0.0.1:${dead}/wms`);
    const r = await pingDatabase(client, 2000);
    expect(r).toMatchObject({ ok: false, reason: "error" });
    expect(JSON.stringify(r)).not.toMatch(/127\.0\.0\.1|wms_app/);
  });

  it("yanıt vermeyen sunucu → 2 sn sınırı (burada 300 ms) içinde timeout", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => void sockets.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const client = open(`postgresql://wms_app:x@127.0.0.1:${port}/wms`);
      const started = Date.now();
      expect(await pingDatabase(client, 300)).toEqual({ ok: false, reason: "timeout" });
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      sockets.forEach((s) => s.destroy());
      server.close();
    }
  });

  it("pgboss şemasına yetkisi olmayan rol (wms_auth) → kuyruk ok:false, DB ok", async () => {
    const auth = open(readAuthDatabaseUrl(process.env));
    expect(await pingDatabase(auth, 2000)).toEqual({ ok: true });
    expect(await pingQueueSchema(auth, 2000)).toMatchObject({ ok: false, reason: "error" });
  });
});
