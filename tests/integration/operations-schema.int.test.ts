// Saha belgeleri şeması (T-301, ADR-021 §1-§4, migration 0016; I-09). GERÇEK rollerle: uygulama rolü wms_app (DATABASE_URL, pooler);
// migration rolü (DATABASE_URL_DIRECT) yalnızca fikstür kurulumu ve sahip düzeyi denemeleri içindir. Sentetik veri (G-09).
// Her deneme tek transaction'da ve ROLLBACK'lidir (kalıcı satır bırakmaz); reservations denemeleri `SET CONSTRAINTS ALL IMMEDIATE`
// ile ertelenmiş stok denetimini de çalıştırır.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "./fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "./harness/env.ts";

const env = readIntEnv(process.env);
const INSUFFICIENT_PRIVILEGE = "42501";
const FK_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const rnd = (): string => randomBytes(4).toString("hex");

const NEW_TABLES = ["inbound_receipts", "inbound_receipt_lines", "sales_orders", "sales_order_lines", "customer_returns", "customer_return_lines"] as const;

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

type Attempt = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string | undefined; message: string };
type Q = (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;

/** Tenant bağlamı transaction-local (G-02). Her zaman ROLLBACK; check: önce SET CONSTRAINTS ALL IMMEDIATE (ertelenmiş denetimler çalışır). */
async function run(client: pg.Client, tenantId: string, work: (q: Q) => Promise<unknown>, check = false): Promise<Attempt> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await client.query(sql, p);
      return last;
    });
    if (check) await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("ROLLBACK");
    return { ok: true, rows: last?.rows ?? [] };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    await client.query("ROLLBACK").catch(() => undefined);
    return { ok: false, code: err.code, message: String(err.message) };
  }
}
const asApp = (tenantId: string, work: (q: Q) => Promise<unknown>, check = false): Promise<Attempt> => run(app, tenantId, work, check);
const asAdmin = (tenantId: string, work: (q: Q) => Promise<unknown>, check = false): Promise<Attempt> => run(admin, tenantId, work, check);

function expectFail(r: Attempt, code: string, label = ""): void {
  expect(r.ok, `${label} beklenen ret (${code}) ama kabul edildi`).toBe(false);
  if (!r.ok) expect(r.code, `${label} ${r.message}`).toBe(code);
}
function expectOk(r: Attempt, label = ""): void {
  expect(r.ok, `${label} ${JSON.stringify(r)}`).toBe(true);
}

const insReceipt = "INSERT INTO public.inbound_receipts (tenant_id, id, warehouse_id, number, supplier_ref, created_by) VALUES ($1, $2, $3, $4, $5, $6)";
const insReceiptLine =
  "INSERT INTO public.inbound_receipt_lines (tenant_id, id, receipt_id, line_no, item_id, unit_id, conversion_factor, expected_quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)";
const insOrder = "INSERT INTO public.sales_orders (tenant_id, id, number, customer_ref, created_by) VALUES ($1, $2, $3, $4, $5)";
const insOrderLine = "INSERT INTO public.sales_order_lines (tenant_id, id, order_id, line_no, item_id, requested_quantity) VALUES ($1, $2, $3, $4, $5, $6)";
const insReturn = "INSERT INTO public.customer_returns (tenant_id, id, warehouse_id, number, created_by) VALUES ($1, $2, $3, $4, $5)";
const insReturnLine =
  "INSERT INTO public.customer_return_lines (tenant_id, id, return_id, line_no, sales_order_line_id, item_id, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)";

/** Dünyada bir kabul belgesi + satır. */
async function mkReceipt(q: Q, w: TenantWorld): Promise<{ receiptId: string; lineId: string }> {
  const receiptId = randomUUID();
  const lineId = randomUUID();
  await q(insReceipt, [w.tenantId, receiptId, w.warehouseId, `GR-${rnd()}`, "ref-sentetik", randomUUID()]);
  await q(insReceiptLine, [w.tenantId, lineId, receiptId, 1, w.itemNoneId, w.unitId, "1", "10"]);
  return { receiptId, lineId };
}
/** Dünyada bir sipariş + satır (verilen ürün, istenen miktar). */
async function mkOrder(q: Q, w: TenantWorld, item: string, requested = "5"): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await q(insOrder, [w.tenantId, orderId, `SO-${rnd()}`, "musteri-sentetik", randomUUID()]);
  await q(insOrderLine, [w.tenantId, lineId, orderId, 1, item, requested]);
  return { orderId, lineId };
}
const setCtx = (q: Q, tenantId: string): Promise<pg.QueryResult> => q("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

const insRes = "INSERT INTO public.reservations (tenant_id, id, stock_dimension_id, document_line_id, order_line_id, quantity) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5)";
/** Ertelenmiş stok denetimi için bakiyedeki rezerve miktarı verilen kadar artırır. */
const bumpReserved = (q: Q, w: TenantWorld, by: string): Promise<pg.QueryResult> =>
  q("UPDATE public.stock_balances SET reserved_quantity = reserved_quantity + $3 WHERE tenant_id = $1 AND stock_dimension_id = $2", [w.tenantId, w.dimensionId, by]);

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

describe("T-301 RLS, yetkiler, sütun bazlı INSERT (yeni tablolar)", () => {
  it("altı tabloda ENABLE + FORCE RLS ve USING + WITH CHECK tenant politikası (PERMISSIVE)", async () => {
    const t = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY 1",
      [[...NEW_TABLES]],
    );
    expect(t.rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity])).toEqual([...NEW_TABLES].sort().map((n) => [n, true, true]));
    const p = await admin.query<{ tablename: string; permissive: string; cmd: string; qual: string | null; with_check: string | null }>(
      "SELECT tablename, permissive, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY 1",
      [[...NEW_TABLES]],
    );
    expect(p.rows.map((r) => r.tablename)).toEqual([...NEW_TABLES].sort());
    for (const r of p.rows) {
      expect(r.permissive, r.tablename).toBe("PERMISSIVE");
      expect(r.cmd, r.tablename).toBe("ALL");
      expect(r.qual, r.tablename).toContain("app.current_tenant_id");
      expect(r.with_check, r.tablename).toContain("app.current_tenant_id");
    }
  });

  it("tenant_id NOT NULL; her tabloda UNIQUE (tenant_id, id); tüm FK'ler tenant_id ile başlayan bileşik anahtardır", async () => {
    const nn = await admin.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' AND is_nullable = 'NO' AND table_name = ANY($1::text[])",
      [[...NEW_TABLES]],
    );
    expect(nn.rows.map((r) => r.table_name).sort()).toEqual([...NEW_TABLES].sort());
    const uq = await admin.query<{ conrelid: string }>(
      `SELECT conrelid::regclass::text AS conrelid FROM pg_constraint
        WHERE contype = 'u' AND conname = ANY($1::text[])`,
      [NEW_TABLES.map((t) => `${t}_tenant_id_id_key`)],
    );
    expect(uq.rows.map((r) => r.conrelid).sort()).toEqual([...NEW_TABLES].sort());
    const fks = await admin.query<{ conrelid: string; conname: string; first_col: string }>(
      `SELECT conrelid::regclass::text AS conrelid, conname,
              (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) AS first_col
         FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ANY($1::text[])`,
      [[...NEW_TABLES]],
    );
    expect(fks.rows.length).toBeGreaterThanOrEqual(12);
    for (const f of fks.rows) expect(f.first_col, f.conname).toBe("tenant_id");
    // reservations'a eklenen iki FK da bileşiktir.
    const rf = await admin.query<{ conname: string; def: string }>(
      "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.reservations'::regclass AND conname LIKE 'reservations_order_line%' ORDER BY 1",
    );
    expect(rf.rows.map((r) => r.def)).toEqual([
      "FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines(tenant_id, id)",
      "FOREIGN KEY (tenant_id, order_line_id, item_id) REFERENCES sales_order_lines(tenant_id, id, item_id)",
    ]);
  });

  it("wms_app: DELETE/TRUNCATE yok; PUBLIC ve wms_ops hiçbir yetkiye sahip değil", async () => {
    const r = await admin.query<{ t: string; app_delete: boolean; app_trunc: boolean; ops_any: boolean; auth_any: boolean; public_any: boolean }>(
      `SELECT t, has_table_privilege('wms_app', 'public.' || t, 'DELETE') AS app_delete,
              has_table_privilege('wms_app', 'public.' || t, 'TRUNCATE') AS app_trunc,
              has_any_column_privilege('wms_ops', 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES') AS ops_any,
              has_any_column_privilege('wms_auth', 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES') AS auth_any,
              coalesce((SELECT bool_or(x.grantee = 0) FROM pg_class c, aclexplode(c.relacl) x WHERE c.oid = ('public.' || t)::regclass), false) AS public_any
         FROM unnest($1::text[]) AS t`,
      [[...NEW_TABLES]],
    );
    expect(r.rows).toHaveLength(NEW_TABLES.length);
    for (const row of r.rows) {
      expect(row, row.t).toMatchObject({ app_delete: false, app_trunc: false, ops_any: false, auth_any: false, public_any: false });
    }
  });

  it("türetilen/sunucu sütunlarında wms_app INSERT yetkisi yok; kimlik sütunlarında UPDATE yetkisi yok", async () => {
    const noInsert: [string, string][] = [
      ["inbound_receipts", "status"], ["inbound_receipts", "version"], ["inbound_receipts", "created_at"],
      ["inbound_receipt_lines", "received_quantity"], ["inbound_receipt_lines", "damaged_quantity"],
      ["sales_orders", "status"], ["sales_orders", "version"],
      ["sales_order_lines", "shipped_quantity"], ["sales_order_lines", "returned_quantity"], ["sales_order_lines", "cancelled_quantity"],
      ["customer_returns", "status"], ["customer_returns", "version"],
    ];
    const noUpdate: [string, string][] = [
      ["inbound_receipts", "version"], ["inbound_receipts", "number"], ["inbound_receipts", "warehouse_id"], ["inbound_receipts", "tenant_id"],
      ["inbound_receipt_lines", "item_id"], ["inbound_receipt_lines", "conversion_factor"], ["inbound_receipt_lines", "receipt_id"],
      ["sales_orders", "version"], ["sales_orders", "number"], ["sales_order_lines", "item_id"], ["sales_order_lines", "order_id"],
      ["customer_returns", "version"], ["customer_return_lines", "sales_order_line_id"], ["customer_return_lines", "item_id"],
    ];
    for (const [t, c] of noInsert) {
      const r = await admin.query<{ p: boolean }>("SELECT has_column_privilege('wms_app', $1, $2, 'INSERT') AS p", [`public.${t}`, c]);
      expect(r.rows[0]?.p, `${t}.${c} INSERT`).toBe(false);
    }
    for (const [t, c] of noUpdate) {
      const r = await admin.query<{ p: boolean }>("SELECT has_column_privilege('wms_app', $1, $2, 'UPDATE') AS p", [`public.${t}`, c]);
      expect(r.rows[0]?.p, `${t}.${c} UPDATE`).toBe(false);
    }
    // Genişletmeler yalnızca INSERT: kaynak bağlantısı sonradan değişmez.
    for (const [t, c] of [["documents", "source_kind"], ["documents", "source_id"], ["document_lines", "source_line_id"], ["reservations", "order_line_id"]]) {
      const ins = await admin.query<{ p: boolean }>("SELECT has_column_privilege('wms_app', $1, $2, 'INSERT') AS p", [`public.${t}`, c]);
      const upd = await admin.query<{ p: boolean }>("SELECT has_column_privilege('wms_app', $1, $2, 'UPDATE') AS p", [`public.${t}`, c]);
      expect([t, c, ins.rows[0]?.p, upd.rows[0]?.p], `${t}.${c}`).toEqual([t, c, true, false]);
    }
  });

  it("kimlik sütunu için doğrudan INSERT (version) 42501; status INSERT'te 42501", async () => {
    expectFail(
      await asApp(A.tenantId, (q) => q("INSERT INTO public.sales_orders (tenant_id, id, number, created_by, version) VALUES ($1, $2, $3, $4, 9)", [A.tenantId, randomUUID(), `SO-${rnd()}`, randomUUID()])),
      INSUFFICIENT_PRIVILEGE,
      "version",
    );
    expectFail(
      await asApp(A.tenantId, (q) => q("INSERT INTO public.sales_orders (tenant_id, id, number, created_by, status) VALUES ($1, $2, $3, $4, 'CLOSED')", [A.tenantId, randomUUID(), `SO-${rnd()}`, randomUUID()])),
      INSUFFICIENT_PRIVILEGE,
      "status",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { orderId } = await mkOrder(q, A, A.itemNoneId);
        await q("INSERT INTO public.sales_order_lines (tenant_id, id, order_id, line_no, item_id, requested_quantity, shipped_quantity) VALUES ($1, $2, $3, 2, $4, 5, 1)", [A.tenantId, randomUUID(), orderId, A.itemNoneId]);
      }),
      INSUFFICIENT_PRIVILEGE,
      "shipped",
    );
  });
});

describe("T-301 tenant yalıtımı (AC-04 DB katmanı, yeni tablolar)", () => {
  it("B tenant'ının satırları A bağlamında görünmez; A bağlamında B tenant_id'li satır yazılamaz (42501)", async () => {
    const r = await asApp(B.tenantId, async (q) => {
      await mkReceipt(q, B);
      const { lineId } = await mkOrder(q, B, B.itemNoneId);
      await q(insReturn, [B.tenantId, randomUUID(), B.warehouseId, `RT-${rnd()}`, randomUUID()]);
      await setCtx(q, A.tenantId);
      for (const t of NEW_TABLES) {
        const c = await q(`SELECT count(*)::int AS n FROM public.${t} WHERE tenant_id = $1`, [B.tenantId]);
        expect(c.rows[0]?.n, `${t} A bağlamında B satırı görünür`).toBe(0);
      }
      const inLine = await q("SELECT count(*)::int AS n FROM public.sales_order_lines WHERE id = $1", [lineId]);
      expect(inLine.rows[0]?.n).toBe(0);
    });
    expectOk(r, "B satırları A'dan görünmez");

    const w: [string, string, unknown[]][] = [
      ["inbound_receipts", insReceipt, [B.tenantId, randomUUID(), A.warehouseId, `GR-${rnd()}`, null, randomUUID()]],
      ["sales_orders", insOrder, [B.tenantId, randomUUID(), `SO-${rnd()}`, null, randomUUID()]],
      ["customer_returns", insReturn, [B.tenantId, randomUUID(), A.warehouseId, `RT-${rnd()}`, randomUUID()]],
    ];
    for (const [t, sql, p] of w) expectFail(await asApp(A.tenantId, (q) => q(sql, p)), INSUFFICIENT_PRIVILEGE, `${t} B satırı A bağlamında`);
    // Bağlamsız (tenant ayarı yok) bağlantı satır görmez ve yazamaz.
    await app.query("BEGIN");
    try {
      for (const t of NEW_TABLES) {
        const c = await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t}`);
        expect(c.rows[0]?.n, `${t} bağlamsız`).toBe(0);
      }
    } finally {
      await app.query("ROLLBACK");
    }
  });

  it("A'nın satırı B'nin ürünü/deposu/siparişi ile bağlanamaz (bileşik FK, 23503)", async () => {
    expectFail(await asApp(A.tenantId, (q) => q(insReceipt, [A.tenantId, randomUUID(), B.warehouseId, `GR-${rnd()}`, null, randomUUID()])), FK_VIOLATION, "B deposu");
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const rec = randomUUID();
        await q(insReceipt, [A.tenantId, rec, A.warehouseId, `GR-${rnd()}`, null, randomUUID()]);
        await q(insReceiptLine, [A.tenantId, randomUUID(), rec, 1, B.itemNoneId, A.unitId, "1", "1"]);
      }),
      FK_VIOLATION,
      "B ürünü kabul satırı",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const rec = randomUUID();
        await q(insReceipt, [A.tenantId, rec, A.warehouseId, `GR-${rnd()}`, null, randomUUID()]);
        await q(insReceiptLine, [A.tenantId, randomUUID(), rec, 1, A.itemNoneId, B.unitId, "1", "1"]);
      }),
      FK_VIOLATION,
      "B birimi kabul satırı",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const o = randomUUID();
        await q(insOrder, [A.tenantId, o, `SO-${rnd()}`, null, randomUUID()]);
        await q(insOrderLine, [A.tenantId, randomUUID(), o, 1, B.itemNoneId, "1"]);
      }),
      FK_VIOLATION,
      "B ürünü sipariş satırı",
    );
    // B'de gerçekten var olan sipariş satırına A iade satırı: kimlik B'de var, A'da yok → bileşik FK.
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const bOrder = randomUUID();
        const bOrderLine = randomUUID();
        await setCtx(q, B.tenantId);
        await q(insOrder, [B.tenantId, bOrder, `SO-${rnd()}`, null, randomUUID()]);
        await q(insOrderLine, [B.tenantId, bOrderLine, bOrder, 1, B.itemNoneId, "3"]);
        await setCtx(q, A.tenantId);
        const ret = randomUUID();
        await q(insReturn, [A.tenantId, ret, A.warehouseId, `RT-${rnd()}`, randomUUID()]);
        await q(insReturnLine, [A.tenantId, randomUUID(), ret, 1, bOrderLine, A.itemNoneId, "1"]);
      }),
      FK_VIOLATION,
      "A iade satırı B sipariş satırına",
    );
  });
});

describe("T-301 CHECK ve tutarlılık kuralları", () => {
  it("sipariş satırı: shipped + cancelled > requested → 23514 (açık miktar sütunu yok; returned sınırı etkilemez)", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId, "5");
        await q("UPDATE public.sales_order_lines SET shipped_quantity = 4, cancelled_quantity = 2 WHERE tenant_id = $1 AND id = $2", [A.tenantId, lineId]);
      }),
      CHECK_VIOLATION,
      "shipped+cancelled>requested",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId, "5");
        await q("UPDATE public.sales_order_lines SET shipped_quantity = 5.000001 WHERE tenant_id = $1 AND id = $2", [A.tenantId, lineId]);
      }),
      CHECK_VIOLATION,
      "shipped>requested (ondalık)",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId, "5");
        await q("UPDATE public.sales_order_lines SET returned_quantity = -1 WHERE tenant_id = $1 AND id = $2", [A.tenantId, lineId]);
      }),
      CHECK_VIOLATION,
      "returned<0",
    );
    // Sınırda geçer: tam sevk, iade açık miktarı değiştirmez ve returned > shipped DB'de yasak değil (iade sınırı açık kural, A-150).
    const ok = await asApp(A.tenantId, async (q) => {
      const { lineId } = await mkOrder(q, A, A.itemNoneId, "5");
      await q("UPDATE public.sales_order_lines SET shipped_quantity = 3, cancelled_quantity = 2, returned_quantity = 1 WHERE tenant_id = $1 AND id = $2", [A.tenantId, lineId]);
      const c = await q(
        "SELECT (requested_quantity - shipped_quantity - cancelled_quantity)::text AS open_qty FROM public.sales_order_lines WHERE tenant_id = $1 AND id = $2",
        [A.tenantId, lineId],
      );
      expect(c.rows[0]?.open_qty).toBe("0.000000");
    });
    expectOk(ok, "sınır");
    const cols = await admin.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_order_lines' AND column_name ~ 'open'");
    expect(cols.rowCount).toBe(0);
  });

  it("kabul satırı: damaged > received, negatif miktar, katsayı <= 0 → 23514; tekrar eden (receipt, line_no) 23505", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkReceipt(q, A);
        await q("UPDATE public.inbound_receipt_lines SET received_quantity = 3, damaged_quantity = 4 WHERE tenant_id = $1 AND id = $2", [A.tenantId, lineId]);
      }),
      CHECK_VIOLATION,
      "damaged>received",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkReceipt(q, A);
        await q("UPDATE public.inbound_receipt_lines SET expected_quantity = -1 WHERE tenant_id = $1 AND id = $2", [A.tenantId, lineId]);
      }),
      CHECK_VIOLATION,
      "expected<0",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const rec = randomUUID();
        await q(insReceipt, [A.tenantId, rec, A.warehouseId, `GR-${rnd()}`, null, randomUUID()]);
        await q(insReceiptLine, [A.tenantId, randomUUID(), rec, 1, A.itemNoneId, A.unitId, "0", "1"]);
      }),
      CHECK_VIOLATION,
      "katsayı 0",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { receiptId } = await mkReceipt(q, A);
        await q(insReceiptLine, [A.tenantId, randomUUID(), receiptId, 1, A.itemNoneId, A.unitId, "1", "1"]);
      }),
      UNIQUE_VIOLATION,
      "line_no",
    );
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkReceipt(q, A);
        await q("UPDATE public.inbound_receipt_lines SET received_quantity = 18, damaged_quantity = 1.5 WHERE tenant_id = $1 AND id = $2", [A.tenantId, lineId]);
      }),
      "kısmi + hasarlı",
    );
  });

  it("başlık: serbest referans > 100 karakter / boş, geçersiz durum, yinelenen numara → ret; version her UPDATE'te +1", async () => {
    expectFail(await asApp(A.tenantId, (q) => q(insReceipt, [A.tenantId, randomUUID(), A.warehouseId, `GR-${rnd()}`, "x".repeat(101), randomUUID()])), CHECK_VIOLATION, "supplier_ref 101");
    expectFail(await asApp(A.tenantId, (q) => q(insOrder, [A.tenantId, randomUUID(), `SO-${rnd()}`, "   ", randomUUID()])), CHECK_VIOLATION, "customer_ref boş");
    expectOk(await asApp(A.tenantId, (q) => q(insOrder, [A.tenantId, randomUUID(), `SO-${rnd()}`, "x".repeat(100), randomUUID()])), "customer_ref 100");
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { orderId } = await mkOrder(q, A, A.itemNoneId);
        await q("UPDATE public.sales_orders SET status = 'POSTED' WHERE tenant_id = $1 AND id = $2", [A.tenantId, orderId]);
      }),
      CHECK_VIOLATION,
      "durum",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const no = `SO-${rnd()}`;
        await q(insOrder, [A.tenantId, randomUUID(), no, null, randomUUID()]);
        await q(insOrder, [A.tenantId, randomUUID(), no, null, randomUUID()]);
      }),
      UNIQUE_VIOLATION,
      "numara",
    );
    const v = await asApp(A.tenantId, async (q) => {
      const { receiptId } = await mkReceipt(q, A);
      const first = await q("SELECT version FROM public.inbound_receipts WHERE tenant_id = $1 AND id = $2", [A.tenantId, receiptId]);
      expect(first.rows[0]?.version).toBe(1);
      await q("UPDATE public.inbound_receipts SET status = 'OPEN' WHERE tenant_id = $1 AND id = $2", [A.tenantId, receiptId]);
      await q("UPDATE public.inbound_receipts SET status = 'CLOSED' WHERE tenant_id = $1 AND id = $2", [A.tenantId, receiptId]);
      const r = await q("SELECT version, status FROM public.inbound_receipts WHERE tenant_id = $1 AND id = $2", [A.tenantId, receiptId]);
      expect(r.rows[0]).toEqual({ version: 3, status: "CLOSED" });
    });
    expectOk(v, "version");
  });

  it("anahtar sütunlar tablo sahibi için de değişmez (23514); wms_app'in yetkisiz sütunu 42501", async () => {
    expectFail(
      await asAdmin(A.tenantId, async (q) => {
        const { receiptId } = await mkReceipt(q, A);
        await q("UPDATE public.inbound_receipts SET number = 'X' WHERE tenant_id = $1 AND id = $2", [A.tenantId, receiptId]);
      }),
      CHECK_VIOLATION,
      "sahip: number",
    );
    expectFail(
      await asAdmin(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId);
        await q("UPDATE public.sales_order_lines SET item_id = $3 WHERE tenant_id = $1 AND id = $2", [A.tenantId, lineId, A.itemTwoId]);
      }),
      CHECK_VIOLATION,
      "sahip: item_id",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { orderId } = await mkOrder(q, A, A.itemNoneId);
        await q("UPDATE public.sales_orders SET version = 50 WHERE tenant_id = $1 AND id = $2", [A.tenantId, orderId]);
      }),
      INSUFFICIENT_PRIVILEGE,
      "app: version",
    );
  });

  it("iade satırı: miktar > 0; ürün sevk satırının ürünüyle eşleşmeli (bileşik FK, 23503)", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId);
        const ret = randomUUID();
        await q(insReturn, [A.tenantId, ret, A.warehouseId, `RT-${rnd()}`, randomUUID()]);
        await q(insReturnLine, [A.tenantId, randomUUID(), ret, 1, lineId, A.itemNoneId, "0"]);
      }),
      CHECK_VIOLATION,
      "quantity 0",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId);
        const ret = randomUUID();
        await q(insReturn, [A.tenantId, ret, A.warehouseId, `RT-${rnd()}`, randomUUID()]);
        await q(insReturnLine, [A.tenantId, randomUUID(), ret, 1, lineId, A.itemTwoId, "1"]);
      }),
      FK_VIOLATION,
      "başka ürün",
    );
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId);
        const ret = randomUUID();
        await q(insReturn, [A.tenantId, ret, A.warehouseId, `RT-${rnd()}`, randomUUID()]);
        await q(insReturnLine, [A.tenantId, randomUUID(), ret, 1, lineId, A.itemNoneId, "1"]);
      }),
      "geçerli iade satırı",
    );
  });
});

describe("T-301 reservations.order_line_id (ADR-017 §7, ADR-021 §4)", () => {
  it("mevcut (Faz 2) rezervasyon geçerli kalır: document_line_id dolu, order_line_id boş", async () => {
    const r = await admin.query<{ document_line_id: string | null; order_line_id: string | null }>(
      "SELECT document_line_id, order_line_id FROM public.reservations WHERE tenant_id = $1 AND id = $2",
      [A.tenantId, A.reservationId],
    );
    expect(r.rows).toEqual([{ document_line_id: A.documentLineNoneId, order_line_id: null }]);
    const col = await admin.query<{ is_nullable: string }>("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'reservations' AND column_name = 'document_line_id'");
    expect(col.rows).toEqual([{ is_nullable: "YES" }]);
  });

  it("sipariş satırına rezervasyon kabul edilir (document_line_id NULL; item_id sipariş satırının ürünüyle eşleşir; ertelenmiş denetim geçer)", async () => {
    const r = await asApp(
      A.tenantId,
      async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId, "5");
        await bumpReserved(q, A, "1");
        await q(insRes, [A.tenantId, A.dimensionId, null, lineId, "1"]);
        const c = await q("SELECT document_line_id, order_line_id, item_id FROM public.reservations WHERE tenant_id = $1 AND order_line_id = $2", [A.tenantId, lineId]);
        expect(c.rows).toEqual([{ document_line_id: null, order_line_id: lineId, item_id: A.itemNoneId }]);
      },
      true,
    );
    expectOk(r, "sipariş satırı rezervasyonu");
  });

  it("ikisi dolu / ikisi boş → 23514 (reservations_source_xor_chk)", async () => {
    const both = await asApp(A.tenantId, async (q) => {
      const { lineId } = await mkOrder(q, A, A.itemNoneId);
      await bumpReserved(q, A, "1");
      await q(insRes, [A.tenantId, A.dimensionId, A.documentLineNoneId, lineId, "1"]);
    });
    expectFail(both, CHECK_VIOLATION, "ikisi dolu");
    if (!both.ok) expect(both.message).toContain("reservations_source_xor_chk");
    const none = await asApp(A.tenantId, async (q) => {
      await bumpReserved(q, A, "1");
      await q(insRes, [A.tenantId, A.dimensionId, null, null, "1"]);
    });
    expectFail(none, CHECK_VIOLATION, "ikisi boş");
    if (!none.ok) expect(none.message).toContain("reservations_source_xor_chk");
  });

  it("B tenant'ının sipariş satırına rezervasyon → FK (23503); B tenant_id'si ile → RLS (42501)", async () => {
    // A bağlamı, A'nın boyutu, B'de var olan sipariş satırı kimliği: (A, bLine, item) yok → bileşik FK.
    const fk = await asApp(A.tenantId, async (q) => {
      const o = randomUUID();
      const l = randomUUID();
      await setCtx(q, B.tenantId);
      await q(insOrder, [B.tenantId, o, `SO-${rnd()}`, null, randomUUID()]);
      await q(insOrderLine, [B.tenantId, l, o, 1, B.itemNoneId, "3"]);
      await setCtx(q, A.tenantId);
      await bumpReserved(q, A, "1");
      await q(insRes, [A.tenantId, A.dimensionId, null, l, "1"]);
    });
    expectFail(fk, FK_VIOLATION, "A rezervasyonu B sipariş satırına");
    // B tenant_id'li rezervasyon A bağlamında yazılamaz (WITH CHECK).
    const rls = await asApp(A.tenantId, async (q) => {
      const { lineId } = await mkOrder(q, A, A.itemNoneId);
      await q(insRes, [B.tenantId, A.dimensionId, null, lineId, "1"]);
    });
    expectFail(rls, INSUFFICIENT_PRIVILEGE, "B tenant_id'li rezervasyon");
  });

  it("sipariş satırının ürünü boyutun ürününden farklıysa → 23503 (ürün uyumu); order_line_id sonradan değişmez (app 42501, sahip 23514)", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemTwoId, "5");
        await bumpReserved(q, A, "1");
        await q(insRes, [A.tenantId, A.dimensionId, null, lineId, "1"]);
      }),
      FK_VIOLATION,
      "farklı ürün",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId);
        const { lineId: other } = await mkOrder(q, A, A.itemNoneId);
        await bumpReserved(q, A, "1");
        await q(insRes, [A.tenantId, A.dimensionId, null, lineId, "1"]);
        await q("UPDATE public.reservations SET order_line_id = $3 WHERE tenant_id = $1 AND order_line_id = $2", [A.tenantId, lineId, other]);
      }),
      INSUFFICIENT_PRIVILEGE,
      "app UPDATE order_line_id",
    );
    expectFail(
      await asAdmin(A.tenantId, async (q) => {
        const { lineId } = await mkOrder(q, A, A.itemNoneId);
        const { lineId: other } = await mkOrder(q, A, A.itemNoneId);
        await bumpReserved(q, A, "1");
        await q(insRes, [A.tenantId, A.dimensionId, null, lineId, "1"]);
        await q("UPDATE public.reservations SET order_line_id = $3 WHERE tenant_id = $1 AND order_line_id = $2", [A.tenantId, lineId, other]);
      }),
      CHECK_VIOLATION,
      "sahip UPDATE order_line_id",
    );
  });
});

describe("T-301 belge kaynak bağlantısı ve tenant_settings.receiving_qc_enabled", () => {
  const insDoc =
    "INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by, source_kind, source_id) " +
    "SELECT $1, $2, 'STOCK_IN', v.id, $3, '2026-02-01', $4, $5, $6 FROM public.document_type_versions v WHERE v.tenant_id IS NULL AND v.key = 'STOCK_IN' AND v.version = 1";
  const insDocLine =
    "INSERT INTO public.document_lines (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, source_line_id) " +
    "VALUES ($1, $2, $3, 1, $4, $5, 1, 1, 1, $6, $7)";

  it("kaynak bağlantılı belge + satır kabul edilir; yalnızca biri dolu / geçersiz tür → 23514", async () => {
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const { receiptId, lineId } = await mkReceipt(q, A);
        const d = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), "INBOUND_RECEIPT", receiptId]);
        await q(insDocLine, [A.tenantId, randomUUID(), d, A.itemNoneId, A.unitId, A.childLocationId, lineId]);
        const r = await q("SELECT source_kind, source_id FROM public.documents WHERE tenant_id = $1 AND id = $2", [A.tenantId, d]);
        expect(r.rows).toEqual([{ source_kind: "INBOUND_RECEIPT", source_id: receiptId }]);
      }),
      "kaynaklı belge",
    );
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const d = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), null, null]);
        await q(insDocLine, [A.tenantId, randomUUID(), d, A.itemNoneId, A.unitId, A.childLocationId, null]);
      }),
      "kaynaksız (mevcut) belge",
    );
    expectFail(await asApp(A.tenantId, (q) => q(insDoc, [A.tenantId, randomUUID(), A.warehouseId, randomUUID(), "SALES_ORDER", null])), CHECK_VIOLATION, "tür var kimlik yok");
    expectFail(await asApp(A.tenantId, (q) => q(insDoc, [A.tenantId, randomUUID(), A.warehouseId, randomUUID(), null, randomUUID()])), CHECK_VIOLATION, "kimlik var tür yok");
    expectFail(await asApp(A.tenantId, (q) => q(insDoc, [A.tenantId, randomUUID(), A.warehouseId, randomUUID(), "PURCHASE", randomUUID()])), CHECK_VIOLATION, "geçersiz tür");
    for (const kind of ["INBOUND_RECEIPT", "SALES_ORDER", "CUSTOMER_RETURN", "COUNT_SESSION", "TASK"]) {
      expectOk(await asApp(A.tenantId, (q) => q(insDoc, [A.tenantId, randomUUID(), A.warehouseId, randomUUID(), kind, randomUUID()])), kind);
    }
  });

  it("kaynak bağlantısı sonradan değişmez: wms_app UPDATE 42501; tablo sahibi 23514 (DRAFT belgede de)", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const d = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), "TASK", randomUUID()]);
        await q("UPDATE public.documents SET source_id = $3 WHERE tenant_id = $1 AND id = $2", [A.tenantId, d, randomUUID()]);
      }),
      INSUFFICIENT_PRIVILEGE,
      "app source_id",
    );
    expectFail(
      await asAdmin(A.tenantId, async (q) => {
        const d = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), "TASK", randomUUID()]);
        await q("UPDATE public.documents SET source_kind = 'SALES_ORDER' WHERE tenant_id = $1 AND id = $2", [A.tenantId, d]);
      }),
      CHECK_VIOLATION,
      "sahip source_kind",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const d = randomUUID();
        const l = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), null, null]);
        await q(insDocLine, [A.tenantId, l, d, A.itemNoneId, A.unitId, A.childLocationId, null]);
        await q("UPDATE public.document_lines SET source_line_id = $3 WHERE tenant_id = $1 AND id = $2", [A.tenantId, l, randomUUID()]);
      }),
      INSUFFICIENT_PRIVILEGE,
      "app source_line_id",
    );
  });

  it("document_lines.target_stock_status: NULL ve geçerli değerler kabul; geçersiz değer 23514; DRAFT'ta app UPDATE geçer", async () => {
    const withStatus = (v: string | null): string => insDocLine.replace("source_line_id)", "source_line_id, target_stock_status)").replace("$7)", `$7, ${v === null ? "NULL" : `'${v}'`})`);
    for (const v of [null, "AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"]) {
      expectOk(
        await asApp(A.tenantId, async (q) => {
          const d = randomUUID();
          await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), null, null]);
          await q(withStatus(v), [A.tenantId, randomUUID(), d, A.itemNoneId, A.unitId, A.childLocationId, null]);
        }),
        `değer ${String(v)}`,
      );
    }
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const d = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), null, null]);
        await q(withStatus("RESERVED"), [A.tenantId, randomUUID(), d, A.itemNoneId, A.unitId, A.childLocationId, null]);
      }),
      CHECK_VIOLATION,
      "geçersiz değer",
    );
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const d = randomUUID();
        const l = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), null, null]);
        await q(insDocLine, [A.tenantId, l, d, A.itemNoneId, A.unitId, A.childLocationId, null]);
        await q("UPDATE public.document_lines SET target_stock_status = 'QUARANTINE' WHERE tenant_id = $1 AND id = $2", [A.tenantId, l]);
        await q("UPDATE public.document_lines SET target_stock_status = NULL WHERE tenant_id = $1 AND id = $2", [A.tenantId, l]);
      }),
      "UPDATE",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const d = randomUUID();
        const l = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), null, null]);
        await q(insDocLine, [A.tenantId, l, d, A.itemNoneId, A.unitId, A.childLocationId, null]);
        await q("UPDATE public.document_lines SET target_stock_status = 'BOGUS' WHERE tenant_id = $1 AND id = $2", [A.tenantId, l]);
      }),
      CHECK_VIOLATION,
      "UPDATE geçersiz",
    );
  });

  it("POSTED değişmezliği bozulmaz: POSTED belge satırında source_line_id değişimi 23514, belge başlığı değişimi 23514", async () => {
    // Fikstürdeki belgeler DRAFT; sahip bağlantısıyla (tek transaction, ROLLBACK) POSTED'a alınıp denenir.
    expectFail(
      await asAdmin(A.tenantId, async (q) => {
        const d = randomUUID();
        const l = randomUUID();
        await q(insDoc, [A.tenantId, d, A.warehouseId, randomUUID(), "TASK", randomUUID()]);
        await q(insDocLine, [A.tenantId, l, d, A.itemNoneId, A.unitId, A.childLocationId, randomUUID()]);
        await q("UPDATE public.documents SET number = $3, status = 'POSTED' WHERE tenant_id = $1 AND id = $2", [A.tenantId, d, `P-${rnd()}`]);
        await q("UPDATE public.document_lines SET source_line_id = $3 WHERE tenant_id = $1 AND id = $2", [A.tenantId, l, randomUUID()]);
      }),
      CHECK_VIOLATION,
      "POSTED satır source_line_id",
    );
  });

  it("receiving_qc_enabled: NOT NULL, varsayılan true (mevcut ayar satırı true); wms_app kendi tenant'ında günceller, B'ninkini göremez", async () => {
    const col = await admin.query<{ is_nullable: string; column_default: string; data_type: string }>(
      "SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_name = 'tenant_settings' AND column_name = 'receiving_qc_enabled'",
    );
    expect(col.rows).toEqual([{ is_nullable: "NO", column_default: "true", data_type: "boolean" }]);
    const cur = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM public.tenant_settings WHERE tenant_id = ANY($1::uuid[]) AND receiving_qc_enabled", [[A.tenantId, B.tenantId]]);
    expect(cur.rows[0]?.n).toBe(2);
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const u = await q("UPDATE public.tenant_settings SET receiving_qc_enabled = false WHERE tenant_id = $1 RETURNING receiving_qc_enabled", [A.tenantId]);
        expect(u.rows).toEqual([{ receiving_qc_enabled: false }]);
      }),
      "kendi tenant'ı",
    );
    const cross = await asApp(A.tenantId, async (q) => {
      const u = await q("UPDATE public.tenant_settings SET receiving_qc_enabled = false WHERE tenant_id = $1 RETURNING tenant_id", [B.tenantId]);
      expect(u.rowCount).toBe(0);
    });
    expectOk(cross, "B ayarı A bağlamında güncellenemez");
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.tenant_settings SET receiving_qc_enabled = NULL WHERE tenant_id = $1", [A.tenantId])), "23502", "NULL");
  });
});
