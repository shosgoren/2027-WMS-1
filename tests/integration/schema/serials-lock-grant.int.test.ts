// katman: db — 0015 serials satır kilidi yetkisi (T-237, Q-56). wms_app (DATABASE_URL) ile gerçek rol/RLS; sahip/superuser yalnızca fikstür ve
// "sahip da değiştiremez" denemeleri içindir. Sentetik veri (G-09).
// G-04 kanıtı: PG, SELECT ... FOR UPDATE/NO KEY UPDATE/SHARE/KEY SHARE için tabloda >=1 sütunda UPDATE yetkisi ister (aşağıdaki "yetkisiz rol"
// testi bunu kurulu sürümde gösterir); satır kilidi sorguları UPDATE tetikleyicisini çalıştırmaz (kilit sonrası created_at değişmemiş + tetikleyici
// reddi yalnızca gerçek UPDATE'te).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const clients: pg.Client[] = [];
let admin: pg.Client;
let app: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

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

type Attempt = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string | undefined; message: string };
async function tx(client: pg.Client, tenantId: string | null, work: (q: (sql: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<unknown>): Promise<Attempt> {
  await client.query("BEGIN");
  try {
    if (tenantId !== null) await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await client.query(sql, p);
      return last;
    });
    await client.query("ROLLBACK");
    return { ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    await client.query("ROLLBACK").catch(() => undefined);
    return { ok: false, code: err.code, message: String(err.message) };
  }
}
const asApp = (t: string | null, w: Parameters<typeof tx>[2]): Promise<Attempt> => tx(app, t, w);
const asAdmin = (t: string | null, w: Parameters<typeof tx>[2]): Promise<Attempt> => tx(admin, t, w);

function expectFail(r: Attempt, code: string, label: string, msg?: string): void {
  expect(r.ok, `${label}: ret (${code}) beklenirdi`).toBe(false);
  if (!r.ok) {
    expect(r.code, `${label}: ${r.message}`).toBe(code);
    if (msg !== undefined) expect(r.message, label).toContain(msg);
  }
}
function expectOk(r: Attempt, label: string): void {
  expect(r.ok, `${label}: ${JSON.stringify(r)}`).toBe(true);
}

const LOCK_MODES = ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"] as const;

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
}, 60_000);

afterAll(async () => {
  try {
    if (admin !== undefined) await cleanupRegistry(admin, reg);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
}, 60_000);

describe("T-237 serials satır kilidi yetkisi (0015)", () => {
  it("G-04: UPDATE yetkisiz rol satır kilidi alamaz (42501); wms_app'in yalnız created_at UPDATE yetkisi var", async () => {
    for (const mode of LOCK_MODES) {
      const r = await asAdmin(null, async (q) => {
        await q("CREATE ROLE t237_noupd NOLOGIN");
        await q("GRANT USAGE ON SCHEMA public TO t237_noupd");
        await q("GRANT SELECT ON public.serials TO t237_noupd");
        await q("SET LOCAL ROLE t237_noupd");
        await q(`SELECT id FROM public.serials ${mode}`);
      });
      expectFail(r, "42501", `yetkisiz ${mode}`);
    }
    const cols = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'serials' AND grantee = 'wms_app' AND privilege_type = 'UPDATE' ORDER BY column_name`,
    );
    expect(cols.rows.map((x) => x.column_name)).toEqual(["created_at"]);
  });

  for (const mode of LOCK_MODES) {
    it(`wms_app: SELECT ... ${mode} serials satırında başarılı, veri değişmez`, async () => {
      const before = await admin.query("SELECT * FROM public.serials WHERE id = $1", [A.serialId]);
      const r = await asApp(A.tenantId, (q) => q(`SELECT id FROM public.serials WHERE tenant_id = $1 AND id = $2 ${mode}`, [A.tenantId, A.serialId]));
      expectOk(r, mode);
      if (r.ok) expect(r.rowCount).toBe(1);
      const after = await admin.query("SELECT * FROM public.serials WHERE id = $1", [A.serialId]);
      expect(after.rows).toEqual(before.rows);
    });
  }

  it("wms_app: created_at değerini değiştiren UPDATE 23514 SERIAL_IMMUTABLE; aynı değeri yazan UPDATE veriyi değiştirmez", async () => {
    expectFail(
      await asApp(A.tenantId, (q) => q("UPDATE public.serials SET created_at = now() + interval '1 day' WHERE id = $1", [A.serialId])),
      "23514",
      "created_at değişimi",
      "SERIAL_IMMUTABLE",
    );
    const before = await admin.query("SELECT * FROM public.serials WHERE id = $1", [A.serialId]);
    const r = await asApp(A.tenantId, (q) => q("UPDATE public.serials SET created_at = created_at WHERE id = $1", [A.serialId]));
    expectOk(r, "no-op UPDATE");
    if (r.ok) expect(r.rowCount).toBe(1);
    const after = await admin.query("SELECT * FROM public.serials WHERE id = $1", [A.serialId]);
    expect(after.rows).toEqual(before.rows);
  });

  it("wms_app: kimlik sütunlarını değiştiren UPDATE 42501 (sütun yetkisi yok)", async () => {
    for (const col of ["serial_no = 'X'", "lot_id = NULL", "item_id = item_id", "tenant_id = tenant_id", "id = id"]) {
      expectFail(await asApp(A.tenantId, (q) => q(`UPDATE public.serials SET ${col} WHERE id = $1`, [A.serialId])), "42501", col);
    }
  });

  it("sahip: kimlik değişimi reddedilir; replica modunda da (ENABLE ALWAYS); aynı değerli UPDATE geçer", async () => {
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.serials SET serial_no = 'X' WHERE id = $1", [A.serialId])), "23514", "sahip serial_no", "SERIAL_IMMUTABLE");
    expectFail(
      await asAdmin(A.tenantId, async (q) => {
        await q("SET LOCAL session_replication_role = replica");
        await q("UPDATE public.serials SET serial_no = 'X' WHERE id = $1", [A.serialId]);
      }),
      "23514",
      "sahip+replica serial_no",
      "SERIAL_IMMUTABLE",
    );
    expectFail(
      await app.query("SET LOCAL session_replication_role = replica").then(
        () => ({ ok: true as const, rows: [], rowCount: 0 }),
        (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code, message: String(e.message) }),
      ),
      "42501",
      "wms_app replica ayarı",
    );
    expectOk(await asAdmin(A.tenantId, (q) => q("UPDATE public.serials SET created_at = created_at WHERE id = $1", [A.serialId])), "sahip no-op");
  });

  it("sonradan eklenen sütun da değişmezlik kapsamında (tüm satır karşılaştırması, lot_id hariç; MINOR-2)", async () => {
    expectFail(
      await asAdmin(A.tenantId, async (q) => {
        await q("ALTER TABLE public.serials ADD COLUMN t237_probe text");
        await q("UPDATE public.serials SET t237_probe = 'x' WHERE id = $1", [A.serialId]);
      }),
      "23514",
      "sahip yeni sütun",
      "SERIAL_IMMUTABLE",
    );
    const cols = await admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'serials' AND column_name = 't237_probe'");
    expect(cols.rowCount).toBe(0);
  });

  it("wms_app replica ayarı yapamaz; sahip lot_id değişimi 0013 kuralıyla (kullanılan seri reddi, kullanılmayan geçer)", async () => {
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.serials SET lot_id = NULL WHERE id = $1", [A.serialId])), "23514", "kullanılan seri", "TRACKING_VIOLATION");
    const fresh = randomUUID();
    await admin.query("INSERT INTO public.serials (tenant_id, id, item_id, serial_no) VALUES ($1, $2, $3, 'SN-T237')", [A.tenantId, fresh, A.itemId]);
    expectOk(
      await asAdmin(A.tenantId, (q) => q("UPDATE public.serials SET lot_id = $2 WHERE id = $1", [fresh, A.lotId])),
      "kullanılmayan serinin lot_id değişimi",
    );
  });

  it("tetikleyici ENABLE ALWAYS, işlev INVOKER + sabit search_path + PUBLIC EXECUTE yok", async () => {
    const t = await admin.query<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.serials'::regclass AND tgname = 'serials_reject_update'",
    );
    expect(t.rows).toEqual([{ tgenabled: "A" }]);
    const f = await admin.query<{ prosecdef: boolean; proconfig: string[]; public_acl: boolean }>(
      `SELECT prosecdef, proconfig, EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0) AS public_acl
         FROM pg_proc WHERE oid = 'public.serials_reject_update()'::regprocedure`,
    );
    expect(f.rows).toEqual([{ prosecdef: false, proconfig: ["search_path=pg_catalog, pg_temp"], public_acl: false }]);
  });

  it("RLS: başka tenant'ın seri satırı kilitlenemez (0 satır) ve UPDATE 0 satır", async () => {
    for (const mode of LOCK_MODES) {
      const r = await asApp(B.tenantId, (q) => q(`SELECT id FROM public.serials WHERE id = $1 ${mode}`, [A.serialId]));
      expectOk(r, `B bağlamı ${mode}`);
      if (r.ok) expect(r.rowCount).toBe(0);
    }
    const u = await asApp(B.tenantId, (q) => q("UPDATE public.serials SET created_at = created_at WHERE id = $1", [A.serialId]));
    expectOk(u, "B bağlamı UPDATE");
    if (u.ok) expect(u.rowCount).toBe(0);
  });
});
