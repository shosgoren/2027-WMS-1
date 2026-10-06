// Kuyrukta kiracı izolasyonu (T-115c): `wms_app` yalnızca gönderir ve yalnızca kendi tenant'ının işini görür;
// `wms_worker` tüm tenant'ların işini tüketir (fetch/complete/fail/retry) ve başka hiçbir şeye erişemez.
// Gerçek roller, PgBouncer (DATABASE_URL / DATABASE_URL_WORKER); migration rolü (DATABASE_URL_DIRECT) yalnızca kurulum,
// sentetik iş yazma ve doğrulama okumaları içindir (superuser RLS'i aşar). Veriler sentetik UUID'lerdir (G-09).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, currentTenantId, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { QUEUE_SCHEMA, createJobQueue, installQueueSchema, workerPrincipal, type PgBossJobQueue } from "../../../packages/queue-adapter/src/index.ts";
import type { Job } from "../../../packages/shared/src/queue.ts";
import { readIntEnv, readWorkerDatabaseUrl } from "../harness/env.ts";

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const denied = { code: "42501" };
/** Ana tablo ve kuyrukların gerçek tablosu (bölüm): RLS ve yetkiler ikisinde de sınanır. */
const TABLES = ["job", "job_common"] as const;

let admin: pg.Client;
let client: DbClient;
const queues: PgBossJobQueue[] = [];
const createdTenants: string[] = [];

const reseed = (): Job => ({ type: "demo.reseed", payload: {} });
const newTenant = (): string => {
  const id = randomUUID();
  createdTenants.push(id);
  return id;
};

function queueFor(url: string, onError?: (fields: Record<string, unknown> | undefined) => void): PgBossJobQueue {
  const q = createJobQueue({
    connectionString: url,
    max: 3,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 5000,
    runInTenant: (tenantId, _reason, fn) => withTenant(createTenantContext(client, tenantId), fn),
    ...(onError === undefined ? {} : { logger: { error: (_msg: string, fields?: Record<string, unknown>) => onError(fields) } }),
  });
  queues.push(q);
  return q;
}

/** Bağlantı açar; `tenantId` verilirse transaction-local tenant bağlamıyla tek transaction'da çalıştırır ve geri alır. */
async function asRole<T>(url: string, tenantId: string | undefined, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  await c.connect();
  try {
    await c.query("BEGIN");
    if (tenantId !== undefined) await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

const envelope = (tenantId: string | null, extra: Record<string, unknown> = {}) => ({ v: 1, tenantId, actorUserId: null, payload: {}, ...extra });

async function adminInsertJob(data: unknown): Promise<string> {
  const r = await admin.query(`INSERT INTO ${QUEUE_SCHEMA}.job (name, data) VALUES ('demo.reseed', $1::jsonb) RETURNING id`, [JSON.stringify(data)]);
  return r.rows[0].id as string;
}

const stateOf = async (id: string) => {
  const r = await admin.query(`SELECT state, retry_count, retry_limit, output FROM ${QUEUE_SCHEMA}.job WHERE id = $1`, [id]);
  return r.rows[0] as { state: string; retry_count: number; retry_limit: number; output: Record<string, unknown> | null } | undefined;
};

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

beforeAll(async () => {
  client = createDbClient({ url: env.databaseUrl, ...DB_CLIENT_SETTINGS });
  admin = new pg.Client({ connectionString: env.databaseUrlDirect });
  admin.on("error", () => undefined);
  await admin.connect();
  await installQueueSchema({ url: env.databaseUrlDirect });
});

afterEach(async () => {
  while (queues.length > 0) await queues.pop()?.stop();
});

afterAll(async () => {
  if (createdTenants.length > 0) {
    await admin.query(`DELETE FROM ${QUEUE_SCHEMA}.job WHERE data->>'tenantId' = ANY($1::text[])`, [createdTenants]);
  }
  await admin.query(`DELETE FROM ${QUEUE_SCHEMA}.job WHERE jsonb_typeof(data->'tenantId') = 'null' AND state IN ('created', 'completed', 'failed', 'retry')`);
  await admin.end();
  await client.close();
});

describe("wms_worker rolü ve yetki matrisi", () => {
  it("LOGIN, NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; hiçbir role üye değil; hiçbir nesnenin sahibi değil", async () => {
    const r = await admin.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = 'wms_worker'`,
    );
    expect(r.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false });
    const member = await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = 'wms_worker'::regrole`);
    expect(member.rows).toEqual([]);
    const owned = await admin.query(`SELECT 1 FROM pg_class WHERE relowner = 'wms_worker'::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = 'wms_worker'::regrole`);
    expect(owned.rows).toEqual([]);
  });

  it("tablo yetkileri (rol × tablo × işlem) beklenen en dar kümedir", async () => {
    const tables = (await admin.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`, [QUEUE_SCHEMA])).rows.map(
      (x: { relname: string }) => x.relname,
    );
    expect(tables).toEqual(expect.arrayContaining(["job", "job_common", "queue", "version", "bam", "schedule", "subscription"]));
    const expected: Record<string, Record<string, string[]>> = {
      wms_app: { job: ["SELECT", "INSERT"], job_common: ["SELECT", "INSERT"], queue: ["SELECT"] },
      wms_worker: { job: ["SELECT", "INSERT", "UPDATE", "DELETE"], job_common: ["SELECT", "INSERT", "UPDATE", "DELETE"], queue: ["SELECT"] },
    };
    for (const role of ["wms_app", "wms_worker"]) {
      for (const table of tables) {
        const granted: string[] = [];
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const r = await admin.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, `${QUEUE_SCHEMA}.${table}`, priv]);
          if (r.rows[0].ok === true) granted.push(priv);
        }
        expect(granted, `${role} ${table}`).toEqual(expected[role]?.[table] ?? []);
      }
      // version: yalnızca `version` sütunu okunur.
      const col = await admin.query(`SELECT has_column_privilege($1, $2, 'version', 'SELECT') AS ok`, [role, `${QUEUE_SCHEMA}.version`]);
      expect(col.rows[0].ok).toBe(true);
      const other = await admin.query(`SELECT has_column_privilege($1, $2, 'bam_on', 'SELECT') AS ok`, [role, `${QUEUE_SCHEMA}.version`]);
      expect(other.rows[0].ok).toBe(false);
    }
  });

  it("job ve job_common (kuyrukların gerçek tablosu) üzerinde RLS ENABLE + FORCE; politikalar beklenen rol/komutlara bağlı", async () => {
    const real = await admin.query(`SELECT DISTINCT table_name FROM ${QUEUE_SCHEMA}.queue`);
    expect(real.rows.map((r: { table_name: string }) => r.table_name)).toEqual(["job_common"]);
    for (const table of TABLES) {
      const rls = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${QUEUE_SCHEMA}.${table}'::regclass`);
      expect(rls.rows[0], table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = await admin.query(`SELECT policyname, cmd, roles::text FROM pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY policyname`, [QUEUE_SCHEMA, table]);
      expect(pol.rows, table).toEqual([
        { policyname: "job_app_insert", cmd: "INSERT", roles: "{wms_app}" },
        { policyname: "job_app_select", cmd: "SELECT", roles: "{wms_app}" },
        { policyname: "job_worker_all", cmd: "ALL", roles: "{wms_worker}" },
      ]);
    }
  });

  it("wms_worker yönetim tablolarına ve DDL'e erişemez; tenant verisine (public şema) erişemez", async () => {
    await asRole(workerUrl, undefined, async (c) => {
      for (const t of ["bam", "schedule", "subscription", "instance", "job_dependency", "queue_stats", "warning"]) {
        await expect(c.query(`SELECT 1 FROM ${QUEUE_SCHEMA}.${t}`), t).rejects.toMatchObject(denied);
        await c.query("ROLLBACK");
        await c.query("BEGIN");
      }
      const attempts = [
        `INSERT INTO ${QUEUE_SCHEMA}.queue (name, policy, table_name) VALUES ('evil', 'standard', 'job')`,
        `UPDATE ${QUEUE_SCHEMA}.queue SET retry_limit = 99`,
        `UPDATE ${QUEUE_SCHEMA}.version SET bam_on = NULL`,
        `CREATE TABLE ${QUEUE_SCHEMA}.t115c_probe (x int)`,
        `SELECT ${QUEUE_SCHEMA}.create_queue('x', '{}'::jsonb)`,
      ];
      for (const q of attempts) {
        await expect(c.query(q), q).rejects.toMatchObject(denied);
        await c.query("ROLLBACK");
        await c.query("BEGIN");
      }
    });
    const tenantTable = await admin.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name LIMIT 1`,
    );
    expect(tenantTable.rows.length).toBe(1);
    await asRole(workerUrl, undefined, async (c) => {
      await expect(c.query(`SELECT 1 FROM public."${tenantTable.rows[0].table_name}"`)).rejects.toMatchObject(denied);
    });
  });
});

describe("wms_app: yalnızca gönderen, kendi tenant'ı (RLS)", () => {
  it.each(TABLES)("%s: kendi tenant'ına iş ekler; başka tenant'a (zarf tenantId sahteciliği) ve tenantId'siz zarfa ekleyemez", async (table) => {
    const a = newTenant();
    const b = newTenant();
    await asRole(env.databaseUrl, a, async (c) => {
      const ins = (data: unknown) => c.query(`INSERT INTO ${QUEUE_SCHEMA}.${table} (name, data) VALUES ('demo.reseed', $1::jsonb)`, [JSON.stringify(data)]);
      await expect(ins(envelope(a))).resolves.toBeDefined();
      await c.query("SAVEPOINT s1");
      await expect(ins(envelope(b))).rejects.toMatchObject(denied);
      await c.query("ROLLBACK TO s1");
      await expect(ins({ v: 1, payload: {} })).rejects.toMatchObject(denied);
      await c.query("ROLLBACK TO s1");
      await expect(ins(null)).rejects.toMatchObject(denied);
    });
    // Tenant bağlamı olmadan tenant'lı iş yazılamaz.
    await asRole(env.databaseUrl, undefined, async (c) => {
      await expect(c.query(`INSERT INTO ${QUEUE_SCHEMA}.${table} (name, data) VALUES ('demo.reseed', $1::jsonb)`, [JSON.stringify(envelope(a))])).rejects.toMatchObject(denied);
    });
  });

  it.each(TABLES)("%s: başka tenant'ın işini okuyamaz; yalnızca kendi tenant'ı (ve tenant'sız platform işleri) görünür", async (table) => {
    const a = newTenant();
    const b = newTenant();
    const idA = await adminInsertJob(envelope(a));
    const idB = await adminInsertJob(envelope(b));
    await asRole(env.databaseUrl, a, async (c) => {
      const ids = (await c.query(`SELECT id FROM ${QUEUE_SCHEMA}.${table} WHERE data->>'tenantId' = ANY($1::text[])`, [[a, b]])).rows;
      expect(ids.map((r: { id: string }) => r.id)).toEqual([idA]);
      const byId = await c.query(`SELECT 1 FROM ${QUEUE_SCHEMA}.${table} WHERE id = $1`, [idB]);
      expect(byId.rows).toEqual([]);
      // Görünen her satır kendi tenant'ına ya da platforma ait.
      const all = (await c.query(`SELECT data FROM ${QUEUE_SCHEMA}.${table}`)).rows as { data: { tenantId: string | null } }[];
      for (const row of all) expect([a, null]).toContain(row.data.tenantId);
    });
    // Bağlamsız oturum hiçbir tenant işini görmez.
    await asRole(env.databaseUrl, undefined, async (c) => {
      const all = (await c.query(`SELECT data FROM ${QUEUE_SCHEMA}.${table}`)).rows as { data: { tenantId: string | null } }[];
      for (const row of all) expect(row.data.tenantId).toBeNull();
    });
  });

  it.each(TABLES)("%s: başka tenant'ın (ve kendi) işini iptal/değiştir/sil yapamaz; tüketemez (UPDATE/DELETE yetkisi yok)", async (table) => {
    const a = newTenant();
    const b = newTenant();
    const idB = await adminInsertJob(envelope(b));
    const attempts: [string, unknown[]][] = [
      [`UPDATE ${QUEUE_SCHEMA}.${table} SET state = 'cancelled' WHERE id = $1`, [idB]],
      [`UPDATE ${QUEUE_SCHEMA}.${table} SET state = 'active', started_on = now() WHERE id = $1`, [idB]],
      [`DELETE FROM ${QUEUE_SCHEMA}.${table} WHERE id = $1`, [idB]],
      [`UPDATE ${QUEUE_SCHEMA}.${table} SET data = '{}'::jsonb WHERE data->>'tenantId' = $1`, [b]],
    ];
    for (const [q, params] of attempts) {
      await asRole(env.databaseUrl, a, async (c) => {
        await expect(c.query(q, params), q).rejects.toMatchObject(denied);
      });
    }
    expect((await stateOf(idB))?.state).toBe("created");
  });

  it.each(TABLES)("%s: wms_worker tüm tenant'ların satırlarını görür (RLS filtresiz)", async (table) => {
    const a = newTenant();
    const b = newTenant();
    await adminInsertJob(envelope(a));
    await adminInsertJob(envelope(b));
    await asRole(workerUrl, undefined, async (c) => {
      const r = await c.query(`SELECT DISTINCT data->>'tenantId' AS t FROM ${QUEUE_SCHEMA}.${table} WHERE data->>'tenantId' = ANY($1::text[])`, [[a, b]]);
      expect(r.rows.map((x: { t: string }) => x.t).sort()).toEqual([a, b].sort());
    });
  });

  it("wms_app ile bağlanan pg-boss tüketicisi iş alamaz: iş created kalır, hata SQLSTATE 42501 olarak raporlanır", async () => {
    const a = newTenant();
    const idA = await adminInsertJob(envelope(a));
    const errors: Record<string, unknown>[] = [];
    let called = 0;
    const consumer = queueFor(env.databaseUrl, (f) => errors.push(f ?? {}));
    await consumer.work("demo.reseed", async () => {
      called += 1;
    });
    await waitFor(() => errors.some((e) => e.sqlstate === "42501"), "fetch reddi (42501)");
    await new Promise((r) => setTimeout(r, 1500));
    expect(called).toBe(0);
    expect((await stateOf(idA))?.state).toBe("created");
  });

  it("üretici (wms_app) kendi tenant'ına pg-boss API'siyle yazar; iş yalnızca o tenant'a aittir", async () => {
    const a = newTenant();
    const producer = queueFor(env.databaseUrl);
    await producer.start();
    const res = await withTenant(createTenantContext(client, a), (tx) => producer.enqueue(tx, reseed()));
    expect(res.jobId).toEqual(expect.any(String));
    const row = (await admin.query(`SELECT data FROM ${QUEUE_SCHEMA}.job WHERE id = $1`, [res.jobId])).rows[0];
    expect(row.data).toMatchObject({ tenantId: a });
  });
});

describe("wms_worker: tüm tenant'ların işini tüketir (fetch/complete/fail/retry)", () => {
  it("iki farklı tenant'ın işi wms_worker ile tamamlanır", async () => {
    const a = newTenant();
    const b = newTenant();
    const idA = await adminInsertJob(envelope(a));
    const idB = await adminInsertJob(envelope(b));
    const worker = queueFor(workerUrl);
    await worker.work("demo.reseed", async () => undefined);
    await waitFor(async () => (await stateOf(idA))?.state === "completed" && (await stateOf(idB))?.state === "completed", "iki tenant işi tamamlandı");
  });

  it("kalıcı hata yeniden denenmeden failed olur; geçici hata retry'a gider (DELETE + INSERT yolu wms_worker ile çalışır)", async () => {
    const permTenant = newTenant();
    const tempTenant = newTenant();
    const permId = await adminInsertJob(envelope(permTenant));
    const tempId = await adminInsertJob(envelope(tempTenant));
    const calls: Record<string, number> = {};
    const worker = queueFor(workerUrl);
    await worker.work("demo.reseed", async (ctx) => {
      const t = ctx.hasTenant ? await ctx.inTenant((tx) => currentTenantId(tx)) : undefined;
      calls[t ?? "?"] = (calls[t ?? "?"] ?? 0) + 1;
      if (t === permTenant) throw Object.assign(new Error("boom"), { name: "MailError", code: "MAIL_DELIVERY_DISABLED", permanent: true });
      if (t === tempTenant) throw Object.assign(new Error("transient"), { permanent: false });
    });
    await waitFor(async () => (await stateOf(permId))?.state === "failed", "kalıcı hata -> failed");
    await waitFor(async () => (await stateOf(tempId))?.state === "retry", "geçici hata -> retry");
    const perm = await stateOf(permId);
    expect(perm?.retry_count).toBe(0);
    expect(perm?.output).toMatchObject({ permanent: true, name: "MailError", code: "MAIL_DELIVERY_DISABLED" });
    const temp = await stateOf(tempId);
    expect(temp?.retry_count).toBeLessThan(temp?.retry_limit ?? 0);
    expect(calls[permTenant]).toBe(1);
    expect(calls[tempTenant]).toBe(1);
  });
});

describe("worker principal kuralı (T-113 MINOR-4)", () => {
  it("workerPrincipal her zaman mfaVerified=false üretir; kimlik yoksa null", () => {
    const user = randomUUID();
    expect(workerPrincipal(user)).toEqual({ userId: user, mfaVerified: false });
    expect(workerPrincipal(null)).toBeNull();
    // İş yükü/zarf mfaVerified taşıyamaz: tek parametre actorUserId'dir.
    expect(workerPrincipal.length).toBe(1);
  });

  it("zarfa/yüke gömülmüş mfaVerified işi VALIDATION_FAILED ile failed yapar; handler çağrılmaz", async () => {
    const t1 = newTenant();
    const t2 = newTenant();
    const envId = await adminInsertJob(envelope(t1, { mfaVerified: true }));
    const payloadId = await adminInsertJob({ v: 1, tenantId: t2, actorUserId: null, payload: { mfaVerified: true } });
    let called = 0;
    const worker = queueFor(workerUrl);
    await worker.work("demo.reseed", async (ctx) => {
      // Yalnızca bu testin sahte işleri sayılır (kuyrukta başka testlerin geçerli işleri olabilir).
      const t = ctx.hasTenant ? await ctx.inTenant((tx) => currentTenantId(tx)) : undefined;
      if (t === t1 || t === t2) called += 1;
    });
    await waitFor(async () => (await stateOf(envId))?.state === "failed" && (await stateOf(payloadId))?.state === "failed", "forged jobs failed");
    expect(called).toBe(0);
    expect((await stateOf(envId))?.output).toMatchObject({ permanent: true, code: "VALIDATION_FAILED" });
    expect((await stateOf(payloadId))?.output).toMatchObject({ permanent: true, code: "VALIDATION_FAILED" });
  });
});
