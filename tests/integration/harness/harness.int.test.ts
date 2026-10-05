// Düzenek duman testi (T-005a): pooler URL'si gerçekten RLS'e tabi uygulama rolüne gider ve
// session'da tenant bağlamı yoktur. Her iki hedefte (compose, neon) koşar; compose hedefinde
// ek olarak PgBouncer yönetim konsolundan pool_mode = transaction doğrulanır.
//
// Uygulama rolü bağlantısı YALNIZCA DATABASE_URL'den kurulur; DATABASE_URL_DIRECT (migration rolü)
// bu dosyada kullanılmaz (T-002d güvenlik notu).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLE, PGBOUNCER_ADMIN_URL_VAR, parsePoolSize, readIntEnv, redactUrl } from "./env.ts";

const env = readIntEnv(process.env);

/** Bağlanır; sürücü hatasındaki URL/parola/host maskelenir (G-09). */
async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  // Bağlantı sonrası soket hataları da maskelensin ve süreç çökmesin; sorgu hatası ayrıca fırlar.
  client.on("error", (e) => console.error(`[harness] connection error: ${redactUrl(e.message, url)}`));
  try {
    await client.connect();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`connect failed: ${redactUrl(message, url)}`);
  }
  return client;
}

describe(`harness (target=${env.target}) — app role via pooler`, () => {
  let app: pg.Client;

  beforeAll(async () => {
    app = await connect(env.databaseUrl);
  });

  afterAll(async () => {
    await app?.end();
  });

  it(`connects as the application role ${APP_ROLE}`, async () => {
    const r = await app.query<{ current_user: string }>("SELECT current_user");
    expect(r.rows).toEqual([{ current_user: APP_ROLE }]);
  });

  it("application role is not superuser and cannot bypass RLS", async () => {
    const r = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user",
    );
    expect(r.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("application role is a member of no other role (inherits no owner privileges, I-03)", async () => {
    const r = await app.query<{ granted: string }>(
      `SELECT g.rolname AS granted
         FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles mem ON mem.oid = m.member
         JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
        WHERE mem.rolname = current_user
        ORDER BY 1`,
    );
    expect(r.rows).toEqual([]);
  });

  it("has no tenant context outside a transaction", async () => {
    const r = await app.query<{ tenant: string | null }>(
      "SELECT current_setting('app.current_tenant_id', true) AS tenant",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.tenant ?? "").toBe("");
  });
});

// PgBouncer yönetim konsolu yalnızca compose hedefinde vardır (Neon pooler'ı sağlayıcı yönetir,
// Q-02 / T-005d). Bu blok neon hedefinde KAYDEDİLMEZ (atlanmış test olarak da görünmez); compose
// hedefinde yönetim URL'si yoksa test atlanmaz, düşer.
if (env.target === "compose") {
  describe("harness (target=compose) — PgBouncer admin console", () => {
    let admin: pg.Client;

    beforeAll(async () => {
      const adminUrl = process.env[PGBOUNCER_ADMIN_URL_VAR];
      if (adminUrl === undefined || adminUrl === "") {
        throw new Error(`${PGBOUNCER_ADMIN_URL_VAR} missing — compose target must be started by global-setup`);
      }
      admin = await connect(adminUrl);
    });

    afterAll(async () => {
      await admin?.end();
    });

    async function config(): Promise<Map<string, string>> {
      const r = await admin.query<{ key: string; value: string }>("SHOW CONFIG");
      return new Map(r.rows.map((row) => [row.key, row.value]));
    }

    it("pool_mode = transaction", async () => {
      expect((await config()).get("pool_mode")).toBe("transaction");
    });

    it("default_pool_size = INT_PGBOUNCER_POOL_SIZE (default 2)", async () => {
      expect((await config()).get("default_pool_size")).toBe(String(parsePoolSize(process.env)));
    });

    it(`DATABASE_URL goes through PgBouncer (pool for ${APP_ROLE} exists)`, async () => {
      const r = await admin.query<{ database: string; user: string }>("SHOW POOLS");
      expect(r.rows.map((row) => row.user)).toContain(APP_ROLE);
    });
  });
}
