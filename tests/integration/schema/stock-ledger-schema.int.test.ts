// Stok çekirdeği şeması (T-232, ADR-017 §1-§7; I-04, I-05, I-09, I-16; G-01 ikinci savunma). GERÇEK rollerle: uygulama rolü wms_app
// (DATABASE_URL, pooler); migration rolü yalnızca fikstür kurulumu/temizliği ve sahip düzeyi denemeleri içindir.
// Sentetik veri: rastgele UUID/kodlar (G-09). Reddedilmesi beklenen yazımlar COMMIT ile denenir (ertelenmiş denetim commit'te çalışır);
// kabul beklenen denemeler ya ROLLBACK'li `SET CONSTRAINTS ALL IMMEDIATE` ile ya da gerçek COMMIT ile (e) doğrulanır.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const INSUFFICIENT_PRIVILEGE = "42501";
const FK_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const TABLES = ["stock_dimensions", "stock_balances", "stock_ledger", "reservations"] as const;
const MISMATCH = "STOCK_BALANCE_LEDGER_MISMATCH";
const CTX_MISMATCH = "STOCK_TENANT_CONTEXT_MISMATCH";
const rnd = (): string => randomBytes(4).toString("hex");

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

type Attempt = { ok: true; rows: Record<string, unknown>[]; ms: number } | { ok: false; code: string | undefined; message: string };
type Q = (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;
type Mode = "commit" | "check" | "rollback";

/**
 * Tenant bağlamı transaction-local (G-02). commit: gerçek COMMIT (ertelenmiş denetim burada çalışır); check: SET CONSTRAINTS ALL
 * IMMEDIATE (bekleyen denetimler çalışır) sonra ROLLBACK; rollback: yalnızca ifade düzeyi denemeler.
 */
async function run(client: pg.Client, tenantId: string, work: (q: Q) => Promise<unknown>, mode: Mode = "rollback"): Promise<Attempt> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await client.query(sql, p);
      return last;
    });
    let ms = 0;
    if (mode === "commit") {
      const t0 = performance.now();
      await client.query("COMMIT");
      ms = performance.now() - t0;
    } else {
      if (mode === "check") await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("ROLLBACK");
    }
    return { ok: true, rows: last?.rows ?? [], ms };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    await client.query("ROLLBACK").catch(() => undefined);
    return { ok: false, code: err.code, message: String(err.message) };
  }
}
const asApp = (tenantId: string, work: (q: Q) => Promise<unknown>, mode: Mode = "rollback"): Promise<Attempt> => run(app, tenantId, work, mode);
const asAdmin = (tenantId: string, work: (q: Q) => Promise<unknown>, mode: Mode = "rollback"): Promise<Attempt> => run(admin, tenantId, work, mode);

function expectFail(r: Attempt, code: string, label = "", msg?: string): void {
  expect(r.ok, `${label} beklenen ret (${code}) ama kabul edildi`).toBe(false);
  if (!r.ok) {
    expect(r.code, `${label} ${r.message}`).toBe(code);
    if (msg !== undefined) expect(r.message, label).toContain(msg);
  }
}
function expectOk(r: Attempt, label = ""): void {
  expect(r.ok, `${label} ${JSON.stringify(r)}`).toBe(true);
}

const insDim = "INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id, serial_id, stock_status) VALUES ($1, $2, $3, $4, $5, $6, $7)";
const insLedger = `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date)
   VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 't232', '2026-02-01')`;
const insBal = "INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, reserved_quantity) VALUES ($1, $2, $3, $4)";
const insRes = "INSERT INTO public.reservations (tenant_id, id, stock_dimension_id, document_line_id, quantity) VALUES ($1, gen_random_uuid(), $2, $3, $4)";

/** Yeni (itemTwo, kök lokasyon) boyutu; durum ile benzersizleştirilir. */
async function newDim(q: Q, w: TenantWorld, status = "AVAILABLE"): Promise<string> {
  const id = randomUUID();
  await q(insDim, [w.tenantId, id, w.itemTwoId, w.rootLocationId, null, null, status]);
  return id;
}
const ledger = (q: Q, w: TenantWorld, dim: string, qty: number): Promise<pg.QueryResult> => q(insLedger, [w.tenantId, w.documentId, w.documentLineId, dim, qty]);

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

describe("T-232 RLS, yetkiler, sütun bazlı INSERT", () => {
  it("dört tabloda ENABLE + FORCE RLS ve USING + WITH CHECK politikası (PERMISSIVE)", async () => {
    const t = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY 1",
      [[...TABLES]],
    );
    expect(t.rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity])).toEqual([...TABLES].sort().map((n) => [n, true, true]));
    const p = await admin.query<{ tablename: string; permissive: string; qual: string | null; with_check: string | null }>(
      "SELECT tablename, permissive, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
      [[...TABLES]],
    );
    expect(p.rows.map((r) => r.tablename).sort()).toEqual([...TABLES].sort());
    for (const r of p.rows) expect([r.tablename, r.permissive, r.qual !== null, r.with_check !== null]).toEqual([r.tablename, "PERMISSIVE", true, true]);
  });

  it("tenant izolasyonu: A yalnızca kendi satırlarını görür; bağlamsız oturum hiçbir şey görmez", async () => {
    for (const t of TABLES) {
      const a = await asApp(A.tenantId, (q) => q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE tenant_id <> $1)::int AS other FROM public.${t}`, [A.tenantId]));
      expectOk(a, t);
      if (a.ok) expect(a.rows[0]).toEqual({ n: expect.any(Number), other: 0 });
      if (a.ok) expect((a.rows[0] as { n: number }).n).toBeGreaterThan(0);
    }
    await app.query("BEGIN");
    try {
      const r = await app.query("SELECT count(*)::int AS n FROM public.stock_ledger");
      expect((r.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await app.query("ROLLBACK");
    }
  });

  it("wms_app: DELETE/TRUNCATE hiçbir stok tablosunda yok; defter ve boyut UPDATE yok; bakiye/rezervasyon yalnızca listelenen sütunlar", async () => {
    const priv = async (sql: string): Promise<boolean> => (await admin.query<{ v: boolean }>(sql)).rows[0]?.v ?? true;
    for (const t of TABLES) {
      expect(await priv(`SELECT has_table_privilege('wms_app', 'public.${t}', 'DELETE, TRUNCATE, REFERENCES, TRIGGER') AS v`), t).toBe(false);
      expect(await priv(`SELECT has_table_privilege('wms_app', 'public.${t}', 'SELECT') AS v`), t).toBe(true);
    }
    for (const t of ["stock_ledger", "stock_dimensions"]) {
      expect(await priv(`SELECT has_any_column_privilege('wms_app', 'public.${t}', 'UPDATE') AS v`), t).toBe(false);
    }
    const col = (t: string, c: string, p: string): Promise<boolean> => priv(`SELECT has_column_privilege('wms_app', 'public.${t}', '${c}', '${p}') AS v`);
    expect(await col("stock_balances", "quantity", "UPDATE")).toBe(true);
    expect(await col("stock_balances", "reserved_quantity", "UPDATE")).toBe(true);
    expect(await col("stock_balances", "version", "UPDATE")).toBe(true);
    expect(await col("stock_balances", "stock_dimension_id", "UPDATE")).toBe(false);
    expect(await col("stock_balances", "tenant_id", "UPDATE")).toBe(false);
    expect(await col("stock_balances", "serial_key", "UPDATE")).toBe(false);
    expect(await col("stock_balances", "serial_key", "INSERT")).toBe(false);
    for (const c of ["stock_dimension_id", "quantity", "status", "closed_at"]) expect(await col("reservations", c, "UPDATE"), c).toBe(true);
    for (const c of ["tenant_id", "id", "document_line_id", "created_at", "expires_at"]) expect(await col("reservations", c, "UPDATE"), c).toBe(false);
    expect(await col("reservations", "closed_at", "INSERT")).toBe(false);
    expect(await col("stock_ledger", "created_xid", "INSERT")).toBe(false);
    expect(await col("stock_ledger", "occurred_at", "INSERT")).toBe(false);
    expect(await col("stock_ledger", "quantity", "INSERT")).toBe(true);
  });

  it("wms_ops ve PUBLIC: hiçbir stok tablosunda yetki yok (0010-0012 deseni)", async () => {
    for (const t of TABLES) {
      const r = await admin.query<{ ops: boolean; pub: boolean }>(
        `SELECT has_any_column_privilege('wms_ops', 'public.${t}', 'SELECT, INSERT, UPDATE') OR has_table_privilege('wms_ops', 'public.${t}', 'DELETE, TRUNCATE') AS ops,
                EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_name = '${t}') AS pub`,
      );
      expect(r.rows[0], t).toEqual({ ops: false, pub: false });
    }
  });
});

describe("T-232 şema kısıtları", () => {
  it("boyut: doğal anahtar NULLS NOT DISTINCT; durum CHECK; UPDATE/DELETE ret (sahip dahil)", async () => {
    const dupe = await asApp(A.tenantId, async (q) => {
      await q(insDim, [A.tenantId, randomUUID(), A.itemId, A.rootLocationId, null, null, "AVAILABLE"]);
    });
    expectFail(dupe, UNIQUE_VIOLATION, "NULL'lu boyut kopyası");
    expectFail(await asApp(A.tenantId, (q) => newDim(q, A, "FOO")), CHECK_VIOLATION, "durum");
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.stock_dimensions SET stock_status = 'BLOCKED'")), INSUFFICIENT_PRIVILEGE, "app UPDATE");
    expectFail(await asApp(A.tenantId, (q) => q("DELETE FROM public.stock_dimensions")), INSUFFICIENT_PRIVILEGE, "app DELETE");
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.stock_dimensions SET created_at = now()")), INSUFFICIENT_PRIVILEGE, "sahip UPDATE");
    expectFail(await asAdmin(A.tenantId, (q) => q("DELETE FROM public.stock_dimensions WHERE tenant_id = $1", [A.tenantId])), INSUFFICIENT_PRIVILEGE, "sahip DELETE");
  });

  it("M-3: başka ürünün lotu/serisiyle boyut → FK reddi; B'nin ürünü/lokasyonuyla A boyutu → FK reddi", async () => {
    // lotId A.itemId'nin lotu; boyut itemTwo ile → (tenant_id, item_id, lot_id) FK'si.
    expectFail(await asApp(A.tenantId, (q) => q(insDim, [A.tenantId, randomUUID(), A.itemTwoId, A.rootLocationId, A.lotId, null, "AVAILABLE"])), FK_VIOLATION, "başka ürünün lotu");
    expectFail(await asApp(A.tenantId, (q) => q(insDim, [A.tenantId, randomUUID(), A.itemTwoId, A.rootLocationId, null, A.serialId, "AVAILABLE"])), FK_VIOLATION, "başka ürünün serisi");
    expectFail(await asApp(A.tenantId, (q) => q(insDim, [A.tenantId, randomUUID(), B.itemId, A.rootLocationId, null, null, "AVAILABLE"])), FK_VIOLATION, "B ürünü");
    expectFail(await asApp(A.tenantId, (q) => q(insDim, [A.tenantId, randomUUID(), A.itemTwoId, B.rootLocationId, null, null, "AVAILABLE"])), FK_VIOLATION, "B lokasyonu");
    expectFail(await asApp(A.tenantId, (q) => q(insDim, [A.tenantId, randomUUID(), A.itemTwoId, A.rootLocationId, null, null, "AVAILABLE"]).then(() => q("UPDATE public.stock_dimensions SET handling_unit_id = $1", [B.handlingUnitId]))), INSUFFICIENT_PRIVILEGE, "UPDATE yok");
  });

  it("(f) A'nın bakiye/defter/rezervasyonu B'nin boyut kimliğine → FK reddi; B'nin belge satırına → FK reddi", async () => {
    expectFail(await asApp(A.tenantId, (q) => q(insBal, [A.tenantId, B.dimensionId, 0, 0])), FK_VIOLATION, "bakiye");
    expectFail(await asApp(A.tenantId, (q) => ledger(q, A, B.dimensionId, 1)), FK_VIOLATION, "defter");
    expectFail(await asApp(A.tenantId, (q) => q(insRes, [A.tenantId, B.dimensionId, A.documentLineId, 1])), FK_VIOLATION, "rezervasyon");
    expectFail(await asApp(A.tenantId, (q) => q(insLedger, [A.tenantId, B.documentId, B.documentLineId, A.dimensionId, 1])), FK_VIOLATION, "B belge satırı (defter)");
    expectFail(await asApp(A.tenantId, (q) => q(insRes, [A.tenantId, A.dimensionId, B.documentLineId, 1])), FK_VIOLATION, "B belge satırı (rezervasyon)");
    // Satır kendi tenant'ında olsa bile başka belgenin satırıyla eşleşmeyen document_id → bileşik FK.
    expectFail(await asApp(A.tenantId, (q) => q(insLedger, [A.tenantId, randomUUID(), A.documentLineId, A.dimensionId, 1])), FK_VIOLATION, "yanlış document_id");
    // RLS WITH CHECK: A bağlamında B tenant_id'li satır.
    expectFail(await asApp(A.tenantId, (q) => q(insLedger, [B.tenantId, B.documentId, B.documentLineId, B.dimensionId, 1])), INSUFFICIENT_PRIVILEGE, "WITH CHECK");
  });

  it("I-05: negatif miktar, rezerve > miktar, sıfır defter satırı, boş gerekçe reddi", async () => {
    expectFail(await asApp(A.tenantId, async (q) => q(insBal, [A.tenantId, await newDim(q, A), -1, 0])), CHECK_VIOLATION, "negatif");
    expectFail(await asApp(A.tenantId, async (q) => q(insBal, [A.tenantId, await newDim(q, A), 1, 2])), CHECK_VIOLATION, "rezerve>miktar");
    expectFail(await asApp(A.tenantId, async (q) => ledger(q, A, await newDim(q, A), 0)), CHECK_VIOLATION, "sıfır defter");
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.stock_balances SET quantity = quantity - 11 WHERE stock_dimension_id = $1", [A.dimensionId])), CHECK_VIOLATION, "bakiye eksiye");
    expectFail(
      await asApp(A.tenantId, (q) => q(insLedger.replace("'t232'", "'  '"), [A.tenantId, A.documentId, A.documentLineId, A.dimensionId, 1])),
      CHECK_VIOLATION,
      "boş gerekçe",
    );
  });

  it("(g) seri: miktar 2 reddedilir; aynı seri iki boyutta pozitif reddedilir", async () => {
    const dimSerial = async (q: Q, status: string): Promise<string> => {
      const id = randomUUID();
      await q(insDim, [A.tenantId, id, A.itemId, A.rootLocationId, A.lotId, A.serialId, status]);
      return id;
    };
    expectFail(await asApp(A.tenantId, async (q) => q(insBal, [A.tenantId, await dimSerial(q, "BLOCKED"), 2, 0])), CHECK_VIOLATION, "seri miktar 2");
    // Fikstürde seri zaten serialDimensionId'de pozitif (1): ikinci pozitif boyut kısmi tekil indekse takılır.
    expectFail(await asApp(A.tenantId, async (q) => q(insBal, [A.tenantId, await dimSerial(q, "BLOCKED"), 1, 0])), UNIQUE_VIOLATION, "aynı seri iki boyutta");
    // Sıfır miktarlı ikinci boyut serbest (hareket sırası: önce kaynak azalır, sonra hedef artar).
    expectOk(await asApp(A.tenantId, async (q) => q(insBal, [A.tenantId, await dimSerial(q, "BLOCKED"), 0, 0])), "sıfır bakiye");
  });

  it("serial_key sunucu tarafından boyuttan türetilir; istemci değeri INSERT yetkisi dışında", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) => q("INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, serial_key) VALUES ($1, $2, $3)", [A.tenantId, await newDim(q, A), randomUUID()])),
      INSUFFICIENT_PRIVILEGE,
      "serial_key INSERT",
    );
    const r = await asApp(A.tenantId, (q) => q("SELECT serial_key FROM public.stock_balances WHERE stock_dimension_id = $1", [A.serialDimensionId]));
    expectOk(r);
    if (r.ok) expect((r.rows[0] as { serial_key: string }).serial_key).toBe(A.serialId);
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.stock_balances SET stock_dimension_id = $1", [A.dimensionId])), INSUFFICIENT_PRIVILEGE, "kimlik UPDATE");
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.stock_balances SET serial_key = gen_random_uuid()")), CHECK_VIOLATION, "sahip serial_key UPDATE");
  });
});

describe("T-232 defter değişmezliği (I-04)", () => {
  it("wms_app: UPDATE/DELETE/TRUNCATE yetkisi yok; sahip: tetikleyici 42501; replica modunda da", async () => {
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.stock_ledger SET reason = 'x'")), INSUFFICIENT_PRIVILEGE, "app UPDATE");
    expectFail(await asApp(A.tenantId, (q) => q("DELETE FROM public.stock_ledger")), INSUFFICIENT_PRIVILEGE, "app DELETE");
    expectFail(await asApp(A.tenantId, (q) => q("TRUNCATE public.stock_ledger")), INSUFFICIENT_PRIVILEGE, "app TRUNCATE");
    for (const sql of ["UPDATE public.stock_ledger SET reason = 'x'", "DELETE FROM public.stock_ledger", "TRUNCATE public.stock_ledger"]) {
      expectFail(await asAdmin(A.tenantId, (q) => q(sql)), INSUFFICIENT_PRIVILEGE, `sahip: ${sql}`);
      expectFail(
        await asAdmin(A.tenantId, async (q) => {
          await q("SET LOCAL session_replication_role = replica");
          await q(sql);
        }),
        INSUFFICIENT_PRIVILEGE,
        `sahip+replica: ${sql}`,
      );
    }
    const t = await admin.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.stock_ledger'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(t.rows).toEqual([
      { tgname: "stock_ledger_append_only", tgenabled: "A" },
      { tgname: "stock_ledger_assert", tgenabled: "A" },
      { tgname: "stock_ledger_no_truncate", tgenabled: "A" },
      { tgname: "stock_ledger_server_fields", tgenabled: "A" },
    ]);
  });

  it("replica modu wms_app'e atlatma yolu açmaz: SET reddedilir, DISABLE TRIGGER sahip değil, denetim tetikleyicileri ENABLE ALWAYS", async () => {
    expectFail(await asApp(A.tenantId, (q) => q("SET LOCAL session_replication_role = replica")), INSUFFICIENT_PRIVILEGE, "SET LOCAL replica");
    expectFail(await asApp(A.tenantId, (q) => q("SELECT set_config('session_replication_role', 'replica', true)")), INSUFFICIENT_PRIVILEGE, "set_config replica");
    expectFail(await asApp(A.tenantId, (q) => q("ALTER TABLE public.stock_ledger DISABLE TRIGGER stock_ledger_append_only")), INSUFFICIENT_PRIVILEGE, "DISABLE TRIGGER");
    expectFail(await asApp(A.tenantId, (q) => q("ALTER TABLE public.stock_ledger DISABLE TRIGGER ALL")), INSUFFICIENT_PRIVILEGE, "DISABLE TRIGGER ALL");
    // Replica modu ayarlanamadığı için DELETE yine yetkiyle reddedilir (tetikleyiciden önce yetki).
    const t = await admin.query<{ tgrelid: string; tgname: string; tgenabled: string }>(
      `SELECT tgrelid::regclass::text AS tgrelid, tgname, tgenabled FROM pg_trigger
        WHERE tgname IN ('stock_balances_assert', 'stock_ledger_assert', 'reservations_assert', 'stock_balances_fill_serial_key') ORDER BY tgname`,
    );
    expect(t.rows.map((r) => r.tgenabled)).toEqual(["A", "A", "A", "A"]);
    // Sahip replica modunda bile ledger'sız bakiye commit'te reddedilir (denetim ENABLE ALWAYS).
    const r = await asAdmin(
      A.tenantId,
      async (q) => {
        await q("SET LOCAL session_replication_role = replica");
        const dim = await newDim(q, A);
        await q(insBal, [A.tenantId, dim, 5, 0]);
      },
      "commit",
    );
    expectFail(r, CHECK_VIOLATION, "replica altında defter'siz bakiye", MISMATCH);
  });

  it("(h) created_xid ve occurred_at sunucu değerine zorlanır; wms_app bu sütunları veremez", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) =>
        q(
          `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, created_xid)
           VALUES ($1, gen_random_uuid(), $2, $3, $4, 1, 'x', '2026-02-01', '1'::xid8)`,
          [A.tenantId, A.documentId, A.documentLineId, A.dimensionId],
        ),
      ),
      INSUFFICIENT_PRIVILEGE,
      "wms_app created_xid",
    );
    expectFail(
      await asApp(A.tenantId, (q) =>
        q(
          `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, occurred_at)
           VALUES ($1, gen_random_uuid(), $2, $3, $4, 1, 'x', '2026-02-01', '2000-01-01')`,
          [A.tenantId, A.documentId, A.documentLineId, A.dimensionId],
        ),
      ),
      INSUFFICIENT_PRIVILEGE,
      "wms_app occurred_at",
    );
    // Sahip istemci değeri verse bile tetikleyici ezer.
    const r = await asAdmin(
      A.tenantId,
      async (q) => {
        const dim = await newDim(q, A, "QUARANTINE");
        await q(insBal, [A.tenantId, dim, 3, 0]);
        return q(
          `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, created_xid, occurred_at)
           VALUES ($1, gen_random_uuid(), $2, $3, $4, 3, 'x', '2026-02-01', '1'::xid8, '2000-01-01') RETURNING (created_xid = pg_current_xact_id()) AS xid_ok, (occurred_at > '2020-01-01') AS ts_ok`,
          [A.tenantId, A.documentId, A.documentLineId, dim],
        );
      },
      "check",
    );
    expectOk(r);
    if (r.ok) expect(r.rows[0]).toEqual({ xid_ok: true, ts_ok: true });
  });
});

describe("T-232 mutlak defter–bakiye denetimi (ADR-017 §6)", () => {
  it("(a) defter +5 ile aynı bakiye satırına iki kez +5 UPDATE → commit'te ret (B-1 senaryo 1)", async () => {
    const r = await asApp(
      A.tenantId,
      async (q) => {
        await ledger(q, A, A.dimensionId, 5);
        await q("UPDATE public.stock_balances SET quantity = quantity + 5 WHERE stock_dimension_id = $1", [A.dimensionId]);
        await q("UPDATE public.stock_balances SET quantity = quantity + 5 WHERE stock_dimension_id = $1", [A.dimensionId]);
      },
      "commit",
    );
    expectFail(r, CHECK_VIOLATION, "çift UPDATE", MISMATCH);
    // Karşı deney: tek UPDATE tutarlıdır (olay sayısından bağımsız mutlak eşitlik).
    expectOk(
      await asApp(
        A.tenantId,
        async (q) => {
          await ledger(q, A, A.dimensionId, 5);
          await q("UPDATE public.stock_balances SET quantity = quantity + 5 WHERE stock_dimension_id = $1", [A.dimensionId]);
        },
        "check",
      ),
      "tek UPDATE",
    );
  });

  it("(b) defter satırı olmadan quantity=100 bakiye INSERT → ret (B-1 senaryo 2)", async () => {
    expectFail(await asApp(A.tenantId, async (q) => q(insBal, [A.tenantId, await newDim(q, A), 100, 0]), "commit"), CHECK_VIOLATION, "INSERT 100", MISMATCH);
  });

  it("(c) bakiye güncellenmeden yalnız defter INSERT → ret; bakiye satırı hiç yokken de ret", async () => {
    expectFail(await asApp(A.tenantId, (q) => ledger(q, A, A.dimensionId, 3), "commit"), CHECK_VIOLATION, "yalnız defter", MISMATCH);
    expectFail(await asApp(A.tenantId, async (q) => ledger(q, A, await newDim(q, A), 3), "commit"), CHECK_VIOLATION, "bakiye satırı yok", MISMATCH);
    // Bakiye satırı yoksa Σ defter = 0 olmalı: +3 ve -3 birlikte bakiyesiz kabul edilir (Σ = 0).
    expectOk(
      await asApp(
        A.tenantId,
        async (q) => {
          const d = await newDim(q, A);
          await ledger(q, A, d, 3);
          await ledger(q, A, d, -3);
        },
        "check",
      ),
      "Σ=0 bakiyesiz",
    );
  });

  it("(d) yalnız ACTIVE rezervasyon INSERT (reserved_quantity güncellenmeden) → ret (M-2); rezerve güncellenirse kabul", async () => {
    expectFail(await asApp(A.tenantId, (q) => q(insRes, [A.tenantId, A.dimensionId, A.documentLineId, 2]), "commit"), CHECK_VIOLATION, "yalnız rezervasyon", MISMATCH);
    expectOk(
      await asApp(
        A.tenantId,
        async (q) => {
          await q(insRes, [A.tenantId, A.dimensionId, A.documentLineId, 2]);
          await q("UPDATE public.stock_balances SET reserved_quantity = reserved_quantity + 2 WHERE stock_dimension_id = $1", [A.dimensionId]);
        },
        "check",
      ),
      "rezerve güncel",
    );
    // Yalnız bakiye rezervesi artırılırsa (rezervasyon satırı olmadan) da ret.
    expectFail(
      await asApp(A.tenantId, (q) => q("UPDATE public.stock_balances SET reserved_quantity = reserved_quantity + 1 WHERE stock_dimension_id = $1", [A.dimensionId]), "commit"),
      CHECK_VIOLATION,
      "yalnız rezerve",
      MISMATCH,
    );
  });

  it("(d2) rezervasyon boyut değişimi: eski ve yeni boyut ikisi de denetlenir; sonlanan rezervasyon değişmez", async () => {
    const move = (fixOld: boolean) => async (q: Q): Promise<void> => {
      const d2 = await newDim(q, A, "DAMAGED");
      await ledger(q, A, d2, 10);
      await q(insBal, [A.tenantId, d2, 10, 4]);
      await q("UPDATE public.reservations SET stock_dimension_id = $2 WHERE id = $1", [A.reservationId, d2]);
      if (fixOld) await q("UPDATE public.stock_balances SET reserved_quantity = 0 WHERE stock_dimension_id = $1", [A.dimensionId]);
    };
    expectFail(await asApp(A.tenantId, move(false), "commit"), CHECK_VIOLATION, "eski boyut denetimi", MISMATCH);
    expectOk(await asApp(A.tenantId, move(true), "check"), "eski+yeni tutarlı");
    expectOk(
      await asApp(
        A.tenantId,
        async (q) => {
          await q("UPDATE public.reservations SET status = 'CONSUMED', closed_at = now() WHERE id = $1", [A.reservationId]);
          await q("UPDATE public.stock_balances SET reserved_quantity = 0 WHERE stock_dimension_id = $1", [A.dimensionId]);
        },
        "check",
      ),
      "tüketim",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        await q("UPDATE public.reservations SET status = 'RELEASED', closed_at = now() WHERE id = $1", [A.reservationId]);
        await q("UPDATE public.reservations SET quantity = 1 WHERE id = $1", [A.reservationId]);
      }),
      CHECK_VIOLATION,
      "sonlanmış rezervasyon",
    );
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.reservations SET document_line_id = $2 WHERE id = $1", [A.reservationId, A.documentLineId])), INSUFFICIENT_PRIVILEGE, "document_line_id UPDATE");
    expectFail(await asApp(A.tenantId, (q) => q("INSERT INTO public.reservations (tenant_id, id, stock_dimension_id, document_line_id, quantity, status) VALUES ($1, gen_random_uuid(), $2, $3, 1, 'CONSUMED')", [A.tenantId, A.dimensionId, A.documentLineId])), CHECK_VIOLATION, "CONSUMED INSERT");
  });

  it("(e) uyumlu defter + bakiye + rezervasyon → gerçek COMMIT ile kabul; sonradan bozmak reddedilir", async () => {
    let dim = "";
    const r = await asApp(
      A.tenantId,
      async (q) => {
        dim = await newDim(q, A, "BLOCKED");
        await ledger(q, A, dim, 7);
        await q(insBal, [A.tenantId, dim, 7, 2]);
        await q(insRes, [A.tenantId, dim, A.documentLineId, 2]);
      },
      "commit",
    );
    expectOk(r, "uyumlu commit");
    const seen = await asApp(A.tenantId, (q) =>
      q(
        `SELECT b.quantity::text AS q, b.reserved_quantity::text AS r,
                (SELECT sum(quantity)::text FROM public.stock_ledger WHERE stock_dimension_id = b.stock_dimension_id) AS l
           FROM public.stock_balances b WHERE b.stock_dimension_id = $1`,
        [dim],
      ),
    );
    expectOk(seen);
    if (seen.ok) expect(seen.rows[0]).toEqual({ q: "7.000000", r: "2.000000", l: "7.000000" });
    // Kalıcı satırlar üzerinde sonraki bozucu yazım yine reddedilir.
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.stock_balances SET quantity = quantity + 1 WHERE stock_dimension_id = $1", [dim]), "commit"), CHECK_VIOLATION, "sonradan bozma", MISMATCH);
  });

  it("(j) önceden herhangi bir GUC kurmak denetimi atlatmaz (tekilleştirme yok)", async () => {
    for (const guc of ["wms.stock_checked", "app.stock_checked", "stock.checked", "wms.skip_stock_check"]) {
      const r = await asApp(
        A.tenantId,
        async (q) => {
          const dim = await newDim(q, A);
          await q("SELECT set_config($1, $2, true)", [guc, dim]);
          await q("SELECT set_config($1, 'on', true)", [guc]);
          await q(insBal, [A.tenantId, dim, 100, 0]);
        },
        "commit",
      );
      expectFail(r, CHECK_VIOLATION, guc, MISMATCH);
    }
  });

  it("(k) A bağlamında yazıp commit'ten önce bağlamı B'ye (ya da boşa) çevirmek → STOCK_TENANT_CONTEXT_MISMATCH", async () => {
    for (const ctx of [B.tenantId, ""]) {
      const r = await asApp(
        A.tenantId,
        async (q) => {
          await q(insBal, [A.tenantId, await newDim(q, A), 5, 0]);
          await q("SELECT set_config('app.current_tenant_id', $1, true)", [ctx]);
        },
        "commit",
      );
      expectFail(r, CHECK_VIOLATION, `bağlam='${ctx}'`, CTX_MISMATCH);
    }
    // Doğrudan çağrı: bağlam ≠ geçen tenant.
    expectFail(await asApp(A.tenantId, (q) => q("SELECT public.stock_assert_dimension($1, $2)", [B.tenantId, B.dimensionId])), CHECK_VIOLATION, "doğrudan çağrı", CTX_MISMATCH);
    // Bağlam yoksa (boş) ret; tutarlı satır ve eşleşen bağlamda çağrı sessizce geçer.
    await app.query("BEGIN");
    try {
      await expect(app.query("SELECT public.stock_assert_dimension($1, $2)", [A.tenantId, A.dimensionId])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    } finally {
      await app.query("ROLLBACK");
    }
    expectOk(await asApp(A.tenantId, (q) => q("SELECT public.stock_assert_dimension($1, $2)", [A.tenantId, A.dimensionId])), "eşleşen bağlam");
    // Migration rolü de bağlam ister.
    await admin.query("BEGIN");
    try {
      await expect(admin.query("SELECT public.stock_assert_dimension($1, $2)", [A.tenantId, A.dimensionId])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("(l) SET CONSTRAINTS ALL IMMEDIATE denetimi kapatmaz: tutarlı yazım sonrası defter'siz ek yazım → ret", async () => {
    const r = await asApp(
      A.tenantId,
      async (q) => {
        await ledger(q, A, A.dimensionId, 1);
        await q("UPDATE public.stock_balances SET quantity = quantity + 1 WHERE stock_dimension_id = $1", [A.dimensionId]);
        await q("SET CONSTRAINTS ALL IMMEDIATE");
        await q("UPDATE public.stock_balances SET quantity = quantity + 5 WHERE stock_dimension_id = $1", [A.dimensionId]);
      },
      "commit",
    );
    expectFail(r, CHECK_VIOLATION, "IMMEDIATE sonrası ek yazım", MISMATCH);
    // Aynı dizi ama IMMEDIATE'ten sonra DEFERRED'a dönülse de commit reddeder.
    const r2 = await asApp(
      A.tenantId,
      async (q) => {
        await q("SET CONSTRAINTS ALL IMMEDIATE");
        await q("SET CONSTRAINTS ALL DEFERRED");
        await q(insBal, [A.tenantId, await newDim(q, A), 9, 0]);
      },
      "commit",
    );
    expectFail(r2, CHECK_VIOLATION, "DEFERRED'a dönüş", MISMATCH);
  });
});

describe("T-232 (i) 100 satırlık belge eşdeğeri commit süresi (ölçüm)", () => {
  it("tek transaction: 100 boyut + 100 defter + 100 bakiye; commit süresi raporlanır", async () => {
    const C = await seedWorld(admin, reg, "C");
    const tag = rnd();
    // 100 benzersiz lot (itemTwo) migration rolüyle kurulur (fikstür); ölçüm wms_app ile.
    await admin.query(
      "INSERT INTO public.lots (tenant_id, id, item_id, lot_code) SELECT $1, gen_random_uuid(), $2, $3 || '-' || g FROM generate_series(1, 100) g",
      [C.tenantId, C.itemTwoId, tag],
    );
    const r = await asApp(
      C.tenantId,
      async (q) => {
        await q(
          `INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id)
           SELECT $1, gen_random_uuid(), $2, $3, l.id FROM public.lots l WHERE l.tenant_id = $1 AND l.item_id = $2 AND l.lot_code LIKE $4`,
          [C.tenantId, C.itemTwoId, C.rootLocationId, `${tag}-%`],
        );
        await q(
          `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date)
           SELECT $1, gen_random_uuid(), $2, $3, d.id, 10, 't232', '2026-02-01' FROM public.stock_dimensions d WHERE d.tenant_id = $1 AND d.item_id = $4 AND d.lot_id IS NOT NULL`,
          [C.tenantId, C.documentId, C.documentLineId, C.itemTwoId],
        );
        await q(
          `INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, reserved_quantity)
           SELECT $1, d.id, 10, 0 FROM public.stock_dimensions d WHERE d.tenant_id = $1 AND d.item_id = $2 AND d.lot_id IS NOT NULL`,
          [C.tenantId, C.itemTwoId],
        );
      },
      "commit",
    );
    expectOk(r, "100 satır commit");
    const n = await asApp(C.tenantId, (q) => q("SELECT count(*)::int AS n FROM public.stock_ledger l JOIN public.stock_dimensions d ON d.tenant_id = l.tenant_id AND d.id = l.stock_dimension_id WHERE l.tenant_id = $1 AND d.item_id = $2", [C.tenantId, C.itemTwoId]));
    if (n.ok) expect((n.rows[0] as { n: number }).n).toBe(100);
    if (r.ok) {
      console.info(`T232_COMMIT_100_LINES_MS=${r.ms.toFixed(1)}`);
      // Mutlak üst sınır değil, gevşek bir akıl sağlığı eşiği (ADR-017: stok kesinleştirme p95 hedefi 1 sn).
      expect(r.ms).toBeLessThan(5000);
    }
  }, 60_000);
});
