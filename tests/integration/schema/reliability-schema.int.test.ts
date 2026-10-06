// Kuyruk güvenilirliği şeması (T-211, ADR-019 §1-§2, §8-§10; I-14). GERÇEK rollerle: wms_app (DATABASE_URL, pooler), wms_worker
// (DATABASE_URL_WORKER, pooler), migration rolü yalnızca fikstür/katalog/sayım için. Sentetik veri (G-09).
// Platform (tenant_id NULL) satırları ve sinyaller YALNIZCA geri alınan transaction'larda yazılır: AC-04'ün "bağlamsız 0 satır"
// taraması hiçbir kalıcı platform satırı görmemeli ve stock_consistency_signals append-only olduğundan silinemez.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { MIGRATIONS_DIR } from "../../../packages/db/src/migrate.ts";
import { PROBE_ROLE, readAuthDatabaseUrl, readIntEnv, readWorkerDatabaseUrl, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const workerUrl = readWorkerDatabaseUrl(process.env);
const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const INVALID_PARAMETER = "22023";
const REASON = "queue.stock.consistency.check";
const ZERO = "00000000-0000-0000-0000-000000000000";
const PROBE_FN = "wms_probe.active_tenant_ids";

const reg = newRegistry();
const clients: pg.Client[] = [];
let admin: pg.Client;
let app: pg.Client;
let worker: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let S: TenantWorld;

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [url])}`);
  }
  clients.push(c);
  return c;
}

type Q = (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;
type Attempt = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string | undefined; message: string };

/**
 * Tek transaction, HER ZAMAN ROLLBACK. tenant: bağlam (null = ayar yok); reason: app.system_reason. `work` içinde hata atan bir ifade
 * transaction'ı aborte eder; bu yüzden beklenen hata denemeleri `sp()` ile SAVEPOINT içine alınır.
 */
async function rolled(client: pg.Client, ctx: { tenant?: string | null; reason?: string }, work: (q: Q, sp: (sql: string, p?: unknown[]) => Promise<Attempt>) => Promise<unknown>): Promise<Attempt> {
  await client.query("BEGIN");
  try {
    if (ctx.tenant !== undefined && ctx.tenant !== null) await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [ctx.tenant]);
    if (ctx.reason !== undefined) await client.query("SELECT set_config('app.system_reason', $1, true)", [ctx.reason]);
    let last: pg.QueryResult | undefined;
    const q: Q = async (sql, p) => {
      last = await client.query(sql, p);
      return last;
    };
    let n = 0;
    const sp = async (sql: string, p?: unknown[]): Promise<Attempt> => {
      const name = `sp${n++}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const r = await client.query(sql, p);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        const err = e as { code?: string; message?: string };
        return { ok: false, code: err.code, message: String(err.message) };
      }
    };
    await work(q, sp);
    return { ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

function expectCode(r: Attempt, code: string, label: string): void {
  expect(r.ok, `${label}: beklenen ret (${code}) ama kabul edildi`).toBe(false);
  if (!r.ok) expect(r.code, `${label}: ${r.message}`).toBe(code);
}

const insEvent = "INSERT INTO public.processed_events (tenant_id, consumer, event_id) VALUES ($1, $2, $3)";
const insRun = `INSERT INTO public.stock_consistency_runs (tenant_id, job_id, started_at, finished_at, status, checked_dimensions, mismatch_count)
   VALUES ($1, $2, now(), now(), $3, 5, $4)`;
const insSignal = "INSERT INTO public.stock_consistency_signals (status, mismatch_count) VALUES ($1, $2)";

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  worker = await connect(workerUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
  S = await seedWorld(admin, reg, "S", { status: "SUSPENDED" });
}, 60_000);

afterAll(async () => {
  try {
    if (admin !== undefined) await cleanupRegistry(admin, reg);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
}, 60_000);

describe("T-211 katalog: RLS, yetkiler, sütun bazlı INSERT", () => {
  it("üç tabloda ENABLE + FORCE RLS; sahibi wms_app değil; tenant tablolarında tenant_id (processed_events NULL olabilir)", async () => {
    const r = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner)::text AS owner FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('processed_events', 'stock_consistency_runs', 'stock_consistency_signals') ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual(["processed_events", "stock_consistency_runs", "stock_consistency_signals"]);
    for (const x of r.rows) {
      expect([x.relname, x.relrowsecurity, x.relforcerowsecurity]).toEqual([x.relname, true, true]);
      expect(x.owner, x.relname).not.toBe("wms_app");
    }
    const cols = await admin.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name IN ('processed_events', 'stock_consistency_runs') ORDER BY 1`,
    );
    expect(cols.rows.map((x) => [x.table_name, x.is_nullable])).toEqual([
      ["processed_events", "YES"],
      ["stock_consistency_runs", "NO"],
    ]);
    const sig = await admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_consistency_signals' AND column_name ILIKE '%tenant%'");
    expect(sig.rowCount, "signals tenant kimliği taşımaz (M-7)").toBe(0);
  });

  it("tablo yetkileri: wms_app yalnızca SELECT/INSERT (signals'ta yalnızca INSERT); created_xid/occurred_at INSERT listesinde yok; wms_ops yalnızca signals SELECT", async () => {
    const priv = async (role: string, table: string, p: string): Promise<boolean> =>
      ((await admin.query<{ v: boolean }>("SELECT has_table_privilege($1, $2, $3) AS v", [role, `public.${table}`, p])).rows[0] as { v: boolean }).v;
    for (const t of ["processed_events", "stock_consistency_runs", "stock_consistency_signals"]) {
      for (const p of ["UPDATE", "DELETE", "TRUNCATE"]) expect(await priv("wms_app", t, p), `wms_app ${t} ${p}`).toBe(false);
      expect(await priv("wms_ops", t, "SELECT"), `wms_ops ${t} SELECT`).toBe(t === "stock_consistency_signals");
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect(await priv("wms_ops", t, p), `wms_ops ${t} ${p}`).toBe(false);
      expect(await priv("wms_worker", t, "SELECT"), `wms_worker ${t}`).toBe(false);
    }
    expect(await priv("wms_app", "stock_consistency_signals", "SELECT")).toBe(false);
    const colPriv = async (table: string, col: string): Promise<boolean> =>
      ((await admin.query<{ v: boolean }>("SELECT has_column_privilege('wms_app', $1, $2, 'INSERT') AS v", [`public.${table}`, col])).rows[0] as { v: boolean }).v;
    expect(await colPriv("stock_consistency_runs", "created_xid")).toBe(false);
    expect(await colPriv("stock_consistency_runs", "job_id")).toBe(true);
    expect(await colPriv("stock_consistency_signals", "created_xid")).toBe(false);
    expect(await colPriv("stock_consistency_signals", "occurred_at")).toBe(false);
    expect(await colPriv("processed_events", "processed_at")).toBe(false);
  });

  it("politikalar: tek PERMISSIVE tenant politikası USING + WITH CHECK; runs WITH CHECK system_reason taşır; signals INSERT (wms_app) ve SELECT (wms_ops) politikaları", async () => {
    const r = await admin.query<{ tablename: string; policyname: string; permissive: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, permissive, cmd, roles::text[] AS roles, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('processed_events', 'stock_consistency_runs', 'stock_consistency_signals') ORDER BY 1, 2`,
    );
    const pe = r.rows.filter((p) => p.tablename === "processed_events");
    expect(pe.map((p) => [p.policyname, p.permissive, p.cmd])).toEqual([["processed_events_isolation", "PERMISSIVE", "ALL"]]);
    expect(pe[0]?.qual).toContain("app.current_tenant_id");
    expect(pe[0]?.with_check).toContain("app.current_tenant_id");
    const runs = r.rows.filter((p) => p.tablename === "stock_consistency_runs");
    expect(runs.map((p) => [p.policyname, p.permissive, p.cmd])).toEqual([["stock_consistency_runs_isolation", "PERMISSIVE", "ALL"]]);
    expect(runs[0]?.qual).toContain("app.current_tenant_id");
    expect(runs[0]?.with_check).toContain("app.current_tenant_id");
    expect(runs[0]?.with_check).toContain(REASON);
    const sig = r.rows.filter((p) => p.tablename === "stock_consistency_signals");
    expect(sig.map((p) => [p.policyname, p.permissive, p.cmd, p.roles])).toEqual([
      ["ops_session_required", "RESTRICTIVE", "ALL", ["wms_ops"]],
      ["stock_consistency_signals_insert", "PERMISSIVE", "INSERT", ["wms_app"]],
      ["stock_consistency_signals_ops_select", "PERMISSIVE", "SELECT", ["wms_ops"]],
    ]);
    expect(sig[0]?.qual).toContain("ops_session_audited");
    expect(sig[0]?.with_check).toContain("ops_session_audited");
    expect(sig[1]?.with_check).toContain(REASON);
  });

  it("kısıtlar: UNIQUE NULLS NOT DISTINCT (tenant_id, consumer, event_id); UNIQUE (tenant_id, job_id); UNIQUE (tenant_id, id); FK'ler NO ACTION; durum CHECK'leri; RUNNING yok", async () => {
    const r = await admin.query<{ relname: string; conname: string; def: string; confdeltype: string }>(
      `SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def, k.confdeltype FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('processed_events', 'stock_consistency_runs', 'stock_consistency_signals')`,
    );
    const defs = r.rows.map((x) => `${x.relname}: ${x.def}`);
    expect(defs).toContain("processed_events: UNIQUE NULLS NOT DISTINCT (tenant_id, consumer, event_id)");
    expect(defs).toContain("stock_consistency_runs: UNIQUE (tenant_id, job_id)");
    expect(defs).toContain("stock_consistency_runs: UNIQUE (tenant_id, id)");
    expect(defs).toContain("stock_consistency_runs: FOREIGN KEY (tenant_id) REFERENCES tenants(id)");
    for (const x of r.rows.filter((k) => k.def.startsWith("FOREIGN KEY"))) expect(x.confdeltype, x.conname).toBe("a");
    const runStatus = r.rows.find((x) => x.conname === "stock_consistency_runs_status_chk");
    expect(runStatus?.def).not.toContain("RUNNING");
    expect(runStatus?.def).not.toContain("FAILED");
    expect(r.rows.find((x) => x.conname === "stock_consistency_signals_status_chk")?.def).toContain("FAILED");
  });
});

describe("T-211 processed_events (ADR-019 §2)", () => {
  it("aynı (tenant, consumer, event_id) ikinci INSERT 23505; farklı tenant aynı (consumer, event_id) iki ayrı satır", async () => {
    const ev = randomUUID();
    const dup = await rolled(app, { tenant: A.tenantId }, async (q, sp) => {
      await q(insEvent, [A.tenantId, "t211.consumer", ev]);
      expectCode(await sp(insEvent, [A.tenantId, "t211.consumer", ev]), UNIQUE_VIOLATION, "ikinci INSERT");
    });
    expect(dup.ok, JSON.stringify(dup)).toBe(true);
    // Farklı tenant: ayrı transaction'lar (her biri kendi bağlamında) → aynı (consumer, event_id) iki satır; ikisi de commit edilip sayılır.
    for (const w of [A, B]) {
      await app.query("BEGIN");
      try {
        await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [w.tenantId]);
        await app.query(insEvent, [w.tenantId, "t211.cross", ev]);
        await app.query("COMMIT");
      } catch (e) {
        await app.query("ROLLBACK");
        throw e;
      }
    }
    const n = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM public.processed_events WHERE consumer = 't211.cross' AND event_id = $1", [ev]);
    expect(n.rows[0]?.n).toBe("2");
  });

  it("platform satırı (tenant_id NULL): bağlam boşken yazılır ve tekildir; NULL de tekilliğe girer (NULLS NOT DISTINCT)", async () => {
    const ev = randomUUID();
    const r = await rolled(app, {}, async (q, sp) => {
      await q(insEvent, [null, "t211.platform", ev]);
      expectCode(await sp(insEvent, [null, "t211.platform", ev]), UNIQUE_VIOLATION, "platform tekrarı");
      const seen = await q("SELECT count(*)::int AS n FROM public.processed_events WHERE consumer = 't211.platform' AND event_id = $1", [ev]);
      expect(seen.rows[0]).toEqual({ n: 1 });
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("A bağlamında B satırı görünmez; tenant bağlamındayken platform satırı görünmez ve yazılamaz; B anahtarı yazılamaz", async () => {
    const ev = randomUUID();
    // Platform satırı tenant bağlamında görünmezliği: aynı transaction içinde bağlamı değiştirerek.
    const vis = await rolled(app, {}, async (q) => {
      await q(insEvent, [null, "t211.platform2", ev]);
      const empty = await q("SELECT count(*)::int AS n FROM public.processed_events WHERE consumer = 't211.platform2'");
      expect(empty.rows[0]).toEqual({ n: 1 });
      await q("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      const inTenant = await q("SELECT count(*)::int AS n FROM public.processed_events WHERE consumer = 't211.platform2'");
      expect(inTenant.rows[0], "tenant bağlamında platform satırı görünmez").toEqual({ n: 0 });
    });
    expect(vis.ok, JSON.stringify(vis)).toBe(true);
    const cross = await rolled(app, { tenant: A.tenantId }, async (q, sp) => {
      const own = await q("SELECT count(*)::int AS n FROM public.processed_events WHERE tenant_id = $1", [B.tenantId]);
      expect(own.rows[0], "A bağlamında B satırı görünmez").toEqual({ n: 0 });
      const mine = await q("SELECT count(*)::int AS n FROM public.processed_events WHERE event_id = $1", [A.processedEventId]);
      expect(mine.rows[0], "A kendi satırını görür").toEqual({ n: 1 });
      expectCode(await sp(insEvent, [B.tenantId, "t211.x", randomUUID()]), INSUFFICIENT_PRIVILEGE, "B anahtarlı INSERT");
      expectCode(await sp(insEvent, [null, "t211.x", randomUUID()]), INSUFFICIENT_PRIVILEGE, "tenant bağlamında platform INSERT");
      expectCode(await sp("INSERT INTO public.processed_events (consumer, event_id) VALUES ('t211.x', $1)", [randomUUID()]), INSUFFICIENT_PRIVILEGE, "tenant_id'siz INSERT (NULL)");
    });
    expect(cross.ok, JSON.stringify(cross)).toBe(true);
  });

  it("wms_app UPDATE/DELETE/TRUNCATE yetkisiz (42501); processed_at yazılamaz", async () => {
    const r = await rolled(app, { tenant: A.tenantId }, async (q, sp) => {
      expectCode(await sp("UPDATE public.processed_events SET consumer = consumer"), INSUFFICIENT_PRIVILEGE, "UPDATE");
      expectCode(await sp("DELETE FROM public.processed_events"), INSUFFICIENT_PRIVILEGE, "DELETE");
      expectCode(await sp("TRUNCATE public.processed_events"), INSUFFICIENT_PRIVILEGE, "TRUNCATE");
      expectCode(await sp("INSERT INTO public.processed_events (tenant_id, consumer, event_id, processed_at) VALUES ($1, 'x', $2, now())", [A.tenantId, randomUUID()]), INSUFFICIENT_PRIVILEGE, "processed_at");
      await q("SELECT 1");
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("T-211 stock_consistency_runs (ADR-019 §8-§9)", () => {
  it("app.system_reason olmadan INSERT RLS reddi (42501); yanlış gerekçe de red; doğru gerekçe + doğru tenant kabul, created_xid sunucu değeri", async () => {
    const none = await rolled(app, { tenant: A.tenantId }, async (_q, sp) => {
      const a = await sp(insRun, [A.tenantId, randomUUID(), "OK", 0]);
      expectCode(a, INSUFFICIENT_PRIVILEGE, "gerekçesiz");
      if (!a.ok) expect(a.message).toMatch(/row-level security/i);
    });
    expect(none.ok, JSON.stringify(none)).toBe(true);
    const wrong = await rolled(app, { tenant: A.tenantId, reason: "demo.bootstrap" }, async (_q, sp) => {
      expectCode(await sp(insRun, [A.tenantId, randomUUID(), "OK", 0]), INSUFFICIENT_PRIVILEGE, "yanlış gerekçe");
    });
    expect(wrong.ok, JSON.stringify(wrong)).toBe(true);
    const good = await rolled(app, { tenant: A.tenantId, reason: REASON }, async (q, sp) => {
      const ins = await q(`${insRun} RETURNING created_xid::text AS cx, pg_current_xact_id()::text AS xid`, [A.tenantId, randomUUID(), "MISMATCH", 2]);
      const row = ins.rows[0] as { cx: string; xid: string };
      expect(row.cx, "created_xid sunucu değeri").toBe(row.xid);
      expectCode(await sp(insRun, [B.tenantId, randomUUID(), "OK", 0]), INSUFFICIENT_PRIVILEGE, "B anahtarı doğru gerekçeyle bile red");
    });
    expect(good.ok, JSON.stringify(good)).toBe(true);
  });

  it("aynı job_id ikinci koşu satırı 23505; farklı tenant aynı job_id serbest; RUNNING/FAILED durumu ve tutarsız sayaç CHECK reddi", async () => {
    const job = randomUUID();
    const r = await rolled(app, { tenant: A.tenantId, reason: REASON }, async (q, sp) => {
      await q(insRun, [A.tenantId, job, "OK", 0]);
      expectCode(await sp(insRun, [A.tenantId, job, "OK", 0]), UNIQUE_VIOLATION, "aynı job_id");
      expectCode(await sp(insRun, [A.tenantId, randomUUID(), "RUNNING", 0]), CHECK_VIOLATION, "RUNNING");
      expectCode(await sp(insRun, [A.tenantId, randomUUID(), "FAILED", 1]), CHECK_VIOLATION, "FAILED");
      expectCode(await sp(insRun, [A.tenantId, randomUUID(), "OK", 3]), CHECK_VIOLATION, "OK ama mismatch_count > 0");
      expectCode(await sp(insRun, [A.tenantId, randomUUID(), "MISMATCH", 0]), CHECK_VIOLATION, "MISMATCH ama mismatch_count = 0");
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const other = await rolled(app, { tenant: B.tenantId, reason: REASON }, async (q) => {
      await q(insRun, [B.tenantId, job, "OK", 0]);
    });
    expect(other.ok, JSON.stringify(other)).toBe(true);
  });

  it("created_xid wms_app tarafından yazılamaz (42501); UPDATE/DELETE yetkisiz; A bağlamında B koşusu görünmez", async () => {
    const r = await rolled(app, { tenant: A.tenantId, reason: REASON }, async (q, sp) => {
      expectCode(
        await sp(`INSERT INTO public.stock_consistency_runs (tenant_id, job_id, started_at, finished_at, status, checked_dimensions, mismatch_count, created_xid)
                  VALUES ($1, $2, now(), now(), 'OK', 0, 0, '1'::xid8)`, [A.tenantId, randomUUID()]),
        INSUFFICIENT_PRIVILEGE,
        "created_xid",
      );
      expectCode(await sp("UPDATE public.stock_consistency_runs SET status = status"), INSUFFICIENT_PRIVILEGE, "UPDATE");
      expectCode(await sp("DELETE FROM public.stock_consistency_runs"), INSUFFICIENT_PRIVILEGE, "DELETE");
      const foreign = await q("SELECT count(*)::int AS n FROM public.stock_consistency_runs WHERE tenant_id = $1", [B.tenantId]);
      expect(foreign.rows[0]).toEqual({ n: 0 });
      const own = await q("SELECT count(*)::int AS n FROM public.stock_consistency_runs WHERE id = $1", [A.consistencyRunId]);
      expect(own.rows[0]).toEqual({ n: 1 });
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("tablo sahibi sahte created_xid verse bile tetikleyici sunucu değerine zorlar (ENABLE ALWAYS)", async () => {
    const r = await rolled(admin, { tenant: A.tenantId }, async (q) => {
      const ins = await q(
        `INSERT INTO public.stock_consistency_runs (tenant_id, job_id, started_at, finished_at, status, checked_dimensions, mismatch_count, created_xid)
         VALUES ($1, $2, now(), now(), 'OK', 0, 0, '1'::xid8) RETURNING created_xid::text AS cx, pg_current_xact_id()::text AS xid`,
        [A.tenantId, randomUUID()],
      );
      const row = ins.rows[0] as { cx: string; xid: string };
      expect(row.cx).toBe(row.xid);
      const en = await q(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'stock_consistency_runs_server_fields' AND tgrelid = 'public.stock_consistency_runs'::regclass`);
      expect(en.rows[0]).toEqual({ tgenabled: "A" });
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("T-211 stock_consistency_signals (ADR-019 §10, M-7)", () => {
  it("app.system_reason olmadan INSERT RLS reddi; gerekçeyle kabul (RETURNING yok); sunucu alanları zorlanır", async () => {
    const none = await rolled(app, {}, async (_q, sp) => {
      expectCode(await sp(insSignal, ["OK", 0]), INSUFFICIENT_PRIVILEGE, "gerekçesiz");
    });
    expect(none.ok, JSON.stringify(none)).toBe(true);
    const good = await rolled(app, { reason: REASON }, async (q, sp) => {
      await q(insSignal, ["FAILED", 0]);
      expectCode(await sp("INSERT INTO public.stock_consistency_signals (status, occurred_at) VALUES ('OK', '2000-01-01')"), INSUFFICIENT_PRIVILEGE, "occurred_at");
      expectCode(await sp("INSERT INTO public.stock_consistency_signals (status, created_xid) VALUES ('OK', '1'::xid8)"), INSUFFICIENT_PRIVILEGE, "created_xid");
      expectCode(await sp(insSignal, ["RUNNING", 0]), CHECK_VIOLATION, "durum CHECK");
    });
    expect(good.ok, JSON.stringify(good)).toBe(true);
    const owner = await rolled(admin, {}, async (q) => {
      const ins = await q(
        "INSERT INTO public.stock_consistency_signals (status, mismatch_count, occurred_at, created_xid) VALUES ('MISMATCH', 1, '2000-01-01', '1'::xid8) RETURNING occurred_at = now() AS ts, created_xid::text AS cx, pg_current_xact_id()::text AS xid",
      );
      const row = ins.rows[0] as { ts: boolean; cx: string; xid: string };
      expect(row.ts).toBe(true);
      expect(row.cx).toBe(row.xid);
    });
    expect(owner.ok, JSON.stringify(owner)).toBe(true);
  });

  it("wms_app signals SELECT 42501 (yetki); UPDATE/DELETE/TRUNCATE yetkisiz", async () => {
    const r = await rolled(app, { reason: REASON }, async (_q, sp) => {
      expectCode(await sp("SELECT count(*) FROM public.stock_consistency_signals"), INSUFFICIENT_PRIVILEGE, "SELECT");
      expectCode(await sp("UPDATE public.stock_consistency_signals SET status = status"), INSUFFICIENT_PRIVILEGE, "UPDATE");
      expectCode(await sp("DELETE FROM public.stock_consistency_signals"), INSUFFICIENT_PRIVILEGE, "DELETE");
      expectCode(await sp("TRUNCATE public.stock_consistency_signals"), INSUFFICIENT_PRIVILEGE, "TRUNCATE");
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("wms_ops okuması denetim zorunlu (0009 RESTRICTIVE): ops_open_session olmadan 0 satır, oturum açılınca satırlar görünür", async () => {
    const r = await rolled(admin, {}, async (q, sp) => {
      await q("INSERT INTO public.stock_consistency_signals (status, mismatch_count) VALUES ('OK', 0)");
      await q("SET LOCAL ROLE wms_ops");
      const blind = await q("SELECT count(*)::int AS n FROM public.stock_consistency_signals");
      expect(blind.rows[0], "denetimsiz ops oturumu satır görmez").toEqual({ n: 0 });
      expectCode(await sp("INSERT INTO public.stock_consistency_signals (status) VALUES ('OK')"), INSUFFICIENT_PRIVILEGE, "wms_ops INSERT");
      await q("SELECT public.ops_open_session($1::uuid, 'op-t211', 'T-211 sinyal okuma testi')", [A.tenantId]);
      const seen = await q("SELECT count(*)::int AS n FROM public.stock_consistency_signals");
      expect((seen.rows[0] as { n: number }).n, "denetlenmiş oturumda görünür").toBeGreaterThanOrEqual(1);
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("append-only: tablo sahibi bile UPDATE/DELETE/TRUNCATE yapamaz (tetikleyici, ENABLE ALWAYS — replica modunda da)", async () => {
    const r = await rolled(admin, {}, async (q, sp) => {
      await q("INSERT INTO public.stock_consistency_signals (status, mismatch_count) VALUES ('OK', 0)");
      for (const stmt of ["UPDATE public.stock_consistency_signals SET status = 'FAILED'", "DELETE FROM public.stock_consistency_signals", "TRUNCATE public.stock_consistency_signals"]) {
        const a = await sp(stmt);
        expectCode(a, INSUFFICIENT_PRIVILEGE, stmt);
        if (!a.ok) expect(a.message).toContain("append-only");
      }
      const tg = await q(
        `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.stock_consistency_signals'::regclass AND NOT tgisinternal ORDER BY tgname`,
      );
      expect(tg.rows).toEqual([
        { tgname: "stock_consistency_signals_append_only", tgenabled: "A" },
        { tgname: "stock_consistency_signals_no_truncate", tgenabled: "A" },
        { tgname: "stock_consistency_signals_server_fields", tgenabled: "A" },
      ]);
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("T-211 wms_probe.active_tenant_ids (ADR-019 §1)", () => {
  const call = (c: pg.Client, after: unknown, lim: unknown): Promise<Attempt> => rolled(c, {}, async (q) => q(`SELECT id::text AS id FROM ${PROBE_FN}($1::uuid, $2::int) AS id`, [after, lim]));
  const ids = (r: Attempt): string[] => (r.ok ? r.rows.map((x) => (x as { id: string }).id) : []);

  it("wms_worker sıfır-UUID + 500: yalnızca ACTIVE tenant'lar (SUSPENDED hariç), sayı migration rolüyle sayılana eşit, sıralı", async () => {
    const r = await call(worker, ZERO, 500);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const got = ids(r);
    const truth = await admin.query<{ id: string }>("SELECT id::text AS id FROM public.tenants WHERE status = 'ACTIVE' ORDER BY id");
    expect(got.length).toBe(truth.rowCount);
    expect(got).toEqual(truth.rows.map((x) => x.id));
    expect(got).toContain(A.tenantId);
    expect(got).toContain(B.tenantId);
    expect(got, "SUSPENDED tenant listelenmez").not.toContain(S.tenantId);
    const probeCols = await admin.query("SELECT 1 FROM pg_proc WHERE oid = 'wms_probe.active_tenant_ids(uuid, integer)'::regprocedure AND prorettype = 'uuid'::regtype AND proretset");
    expect(probeCols.rowCount, "dönüş tipi SETOF uuid (ad/slug yok)").toBe(1);
  });

  it("sayfalar arası tekrar/eksik yok: lim=1 ile keyset yürüyüşü tüm ACTIVE kümeyi birebir verir", async () => {
    const truth = (await admin.query<{ id: string }>("SELECT id::text AS id FROM public.tenants WHERE status = 'ACTIVE' ORDER BY id")).rows.map((x) => x.id);
    const walked: string[] = [];
    let after = ZERO;
    for (let i = 0; i < truth.length + 2; i++) {
      const page = ids(await call(worker, after, 1));
      if (page.length === 0) break;
      walked.push(...page);
      after = page[page.length - 1] as string;
    }
    expect(walked).toEqual(truth);
    expect(new Set(walked).size).toBe(walked.length);
    expect(ids(await call(worker, truth[truth.length - 1] as string, 500))).toEqual([]);
  });

  it("parametre denetimi: after NULL, lim 0 / 501 / NULL / negatif → 22023", async () => {
    expectCode(await call(worker, null, 10), INVALID_PARAMETER, "after NULL");
    for (const lim of [0, 501, null, -1]) expectCode(await call(worker, ZERO, lim), INVALID_PARAMETER, `lim=${String(lim)}`);
    expect((await call(worker, ZERO, 1)).ok).toBe(true);
    expect((await call(worker, ZERO, 500)).ok).toBe(true);
  });

  it("wms_app ve wms_auth ile çağrı 42501; wms_worker ile tenants SELECT 42501; wms_worker tenant tablolarında yetkisiz", async () => {
    expectCode(await call(app, ZERO, 10), INSUFFICIENT_PRIVILEGE, "wms_app");
    const auth = await connect(readAuthDatabaseUrl(process.env));
    expectCode(await call(auth, ZERO, 10), INSUFFICIENT_PRIVILEGE, "wms_auth");
    const sel = await rolled(worker, {}, async (_q, sp) => {
      expectCode(await sp("SELECT id FROM public.tenants"), INSUFFICIENT_PRIVILEGE, "wms_worker tenants SELECT");
      expectCode(await sp("SELECT 1 FROM public.processed_events"), INSUFFICIENT_PRIVILEGE, "wms_worker processed_events");
    });
    expect(sel.ok, JSON.stringify(sel)).toBe(true);
    const grants = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.role_table_grants WHERE grantee = 'wms_worker' AND table_schema = 'public'`,
    );
    expect(grants.rows[0]?.n, "wms_worker public şemasında hiçbir tablo yetkisi taşımaz").toBe("0");
  });

  it("katalog: SECURITY DEFINER, sahibi wms_identity_probe, search_path sabit, PUBLIC EXECUTE yok, EXECUTE yalnızca wms_worker; probe CREATE taşımaz", async () => {
    const r = await admin.query<{ prosecdef: boolean; owner: string; proconfig: string[]; provolatile: string; grantees: string[]; public_exec: boolean }>(
      `SELECT p.prosecdef, pg_get_userbyid(p.proowner)::text AS owner, p.proconfig, p.provolatile,
              (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 0) AS grantees,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
         FROM pg_proc p WHERE p.oid = 'wms_probe.active_tenant_ids(uuid, integer)'::regprocedure`,
    );
    const f = r.rows[0] as { prosecdef: boolean; owner: string; proconfig: string[]; provolatile: string; grantees: string[]; public_exec: boolean };
    expect(f.prosecdef).toBe(true);
    expect(f.owner).toBe(PROBE_ROLE);
    expect(f.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
    expect(f.public_exec).toBe(false);
    expect([...f.grantees].sort()).toEqual([PROBE_ROLE, "wms_worker"].sort());
    const usage = await admin.query<{ v: boolean }>("SELECT has_schema_privilege('wms_worker', 'wms_probe', 'USAGE') AS v");
    expect(usage.rows[0]?.v).toBe(true);
    const create = await admin.query<{ v: boolean }>("SELECT has_schema_privilege($1, 'wms_probe', 'CREATE') AS v", [PROBE_ROLE]);
    expect(create.rows[0]?.v).toBe(false);
    const probeWrite = await admin.query<{ v: boolean }>(
      "SELECT has_table_privilege($1, 'public.tenants', 'INSERT, UPDATE, DELETE, TRUNCATE') AS v",
      [PROBE_ROLE],
    );
    expect(probeWrite.rows[0]?.v, "probe salt okunur kalır").toBe(false);
  });
});

describe("T-211 down migration (ADR-015 §9; dolu tablo bekçisi)", () => {
  // Down SQL'i paylaşılan veritabanında YIKMADAN sınamak için: dosya tek BEGIN ... ROLLBACK içinde, tablo sahibi bağlantıyla çalıştırılır
  // (DDL transaction'lıdır; koşturucunun tek-transaction davranışıyla aynı). Fikstür A/B processed_events satırları tabloyu doludur.
  const downSql = (): string => readFileSync(path.join(MIGRATIONS_DIR, "0014_reliability.down.sql"), "utf8");
  const exists = async (q: Q): Promise<{ tables: number; fn: number }> => {
    const t = await q("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('processed_events', 'stock_consistency_runs', 'stock_consistency_signals')");
    const f = await q("SELECT count(*)::int AS n FROM pg_proc WHERE oid = to_regprocedure('wms_probe.active_tenant_ids(uuid, integer)')");
    return { tables: (t.rows[0] as { n: number }).n, fn: (f.rows[0] as { n: number }).n };
  };

  it("dolu tablolarla bayraksız down RAISE eder (satır var); veri ve işlev yerinde kalır", async () => {
    const r = await rolled(admin, {}, async (q, sp) => {
      const a = await sp(downSql());
      expect(a.ok, "bayraksız down reddedilmeli").toBe(false);
      if (!a.ok) expect(a.message).toMatch(/0014_reliability down: public\.\w+ tablosunda satır var/);
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await exists((s, p) => admin.query(s, p))).toEqual({ tables: 3, fn: 1 });
    const kept = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM public.processed_events WHERE consumer = 't211.fixture' AND tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]);
    expect(kept.rows[0]?.n).toBe("2");
    const force = await admin.query<{ relforcerowsecurity: boolean }>("SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.processed_events'::regclass");
    expect(force.rows[0]?.relforcerowsecurity, "bekçi sayımı geri alındı: FORCE RLS yerinde").toBe(true);
  });

  it("wms_meta.allow_destructive_down = on ile down her şeyi kaldırır (işlev, tablolar, tetikleyici işlevleri, şema USAGE); ROLLBACK ile geri gelir", async () => {
    const r = await rolled(admin, {}, async (q) => {
      await q("SELECT set_config('wms_meta.allow_destructive_down', 'on', true)");
      await q(downSql());
      expect(await exists(q)).toEqual({ tables: 0, fn: 0 });
      const left = await q(
        `SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('reliability_reject_change', 'stock_consistency_runs_force_server_fields', 'stock_consistency_signals_force_server_fields')`,
      );
      expect(left.rows[0]).toEqual({ n: 0 });
      const usage = await q("SELECT has_schema_privilege('wms_worker', 'wms_probe', 'USAGE') AS v");
      expect(usage.rows[0]).toEqual({ v: false });
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await exists((s, p) => admin.query(s, p))).toEqual({ tables: 3, fn: 1 });
  });
});
