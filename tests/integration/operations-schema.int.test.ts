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

// ---------------------------------------------------------------------------------------------------------------------------------
// T-302 (ADR-021 §3 §5-§7, migration 0017): görev, sayım oturumu, min-maks politikası, uyarı, COUNT_ADJUSTMENT, count_abandon_hours.
// ---------------------------------------------------------------------------------------------------------------------------------
const NEW_TABLES_302 = ["warehouse_tasks", "count_sessions", "count_session_lines", "item_stock_policies", "stock_alerts"] as const;

const insTask = "INSERT INTO public.warehouse_tasks (tenant_id, id, warehouse_id, kind, location_id, item_id, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)";
const insSession = "INSERT INTO public.count_sessions (tenant_id, id, warehouse_id, blind, started_by) VALUES ($1, $2, $3, $4, $5)";
const insSessionLine =
  "INSERT INTO public.count_session_lines (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)";
const insPolicy = "INSERT INTO public.item_stock_policies (tenant_id, id, warehouse_id, item_id, min_quantity, max_quantity) VALUES ($1, $2, $3, $4, $5, $6)";
const insAlert = "INSERT INTO public.stock_alerts (tenant_id, id, kind, warehouse_id, item_id, observed_quantity, threshold) VALUES ($1, $2, $3, $4, $5, $6, $7)";

async function mkSession(q: Q, w: TenantWorld, warehouseId: string = w.warehouseId): Promise<string> {
  const id = randomUUID();
  await q(insSession, [w.tenantId, id, warehouseId, false, w.ownerMembershipId]);
  return id;
}
/** Aynı tenant'ta ikinci depo + o depoda kök lokasyon (aynı-depo FK denemeleri için). */
async function mkSecondWarehouse(q: Q, w: TenantWorld): Promise<{ warehouseId: string; locationId: string }> {
  const warehouseId = randomUUID();
  const locationId = randomUUID();
  await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, $3, 'Ikinci')", [w.tenantId, warehouseId, `W-${rnd()}`]);
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, NULL, 'X1', 'x', 0, 'STORAGE')", [
    w.tenantId, locationId, warehouseId,
  ]);
  return { warehouseId, locationId };
}
const lockSql =
  "UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE tenant_id = $1 AND location_id = $4";

describe("T-302 RLS, yetkiler, sütun bazlı INSERT/UPDATE (yeni tablolar)", () => {
  it("beş tabloda ENABLE + FORCE RLS ve USING + WITH CHECK tenant politikası (PERMISSIVE, ALL)", async () => {
    const t = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY 1",
      [[...NEW_TABLES_302]],
    );
    expect(t.rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity])).toEqual([...NEW_TABLES_302].sort().map((n) => [n, true, true]));
    const p = await admin.query<{ tablename: string; permissive: string; cmd: string; qual: string | null; with_check: string | null }>(
      "SELECT tablename, permissive, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY 1",
      [[...NEW_TABLES_302]],
    );
    expect(p.rows.map((r) => r.tablename)).toEqual([...NEW_TABLES_302].sort());
    for (const r of p.rows) {
      expect(r.permissive, r.tablename).toBe("PERMISSIVE");
      expect(r.cmd, r.tablename).toBe("ALL");
      expect(r.qual, r.tablename).toContain("app.current_tenant_id");
      expect(r.with_check, r.tablename).toContain("app.current_tenant_id");
    }
  });

  it("tenant_id NOT NULL; her tabloda UNIQUE (tenant_id, id); tüm FK'ler tenant_id ile başlayan bileşik anahtardır (tenants FK'si hariç tek sütun yok)", async () => {
    const nn = await admin.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' AND is_nullable = 'NO' AND table_name = ANY($1::text[])",
      [[...NEW_TABLES_302]],
    );
    expect(nn.rows.map((r) => r.table_name).sort()).toEqual([...NEW_TABLES_302].sort());
    const uq = await admin.query<{ conrelid: string }>("SELECT conrelid::regclass::text AS conrelid FROM pg_constraint WHERE contype = 'u' AND conname = ANY($1::text[])", [
      NEW_TABLES_302.map((t) => `${t}_tenant_id_id_key`),
    ]);
    expect(uq.rows.map((r) => r.conrelid).sort()).toEqual([...NEW_TABLES_302].sort());
    const fks = await admin.query<{ conname: string; first_col: string; ncols: number }>(
      `SELECT conname, (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) AS first_col, array_length(conkey, 1) AS ncols
         FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ANY($1::text[])`,
      [[...NEW_TABLES_302]],
    );
    expect(fks.rows.length).toBeGreaterThanOrEqual(17);
    for (const f of fks.rows) {
      expect(f.first_col, f.conname).toBe("tenant_id");
      if (!f.conname.endsWith("_tenant_id_fkey")) expect(f.ncols, f.conname).toBeGreaterThanOrEqual(2);
    }
    // location_count_locks → count_sessions (A-84): bileşik, doğrulanmış.
    const lk = await admin.query<{ def: string; convalidated: boolean }>(
      "SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conrelid = 'public.location_count_locks'::regclass AND conname = 'location_count_locks_session_fkey'",
    );
    expect(lk.rows).toEqual([{ def: "FOREIGN KEY (tenant_id, count_session_id) REFERENCES count_sessions(tenant_id, id)", convalidated: true }]);
    // A-85 CHECK'i korunur.
    const a85 = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.location_count_locks'::regclass AND conname = 'location_count_locks_state_chk'");
    expect(a85.rows[0]?.n).toBe(1);
  });

  it("wms_app: DELETE/TRUNCATE yok; PUBLIC, wms_ops ve wms_auth hiçbir yetkiye sahip değil", async () => {
    const r = await admin.query<{ t: string; app_delete: boolean; app_trunc: boolean; ops_any: boolean; auth_any: boolean; public_any: boolean }>(
      `SELECT t, has_table_privilege('wms_app', 'public.' || t, 'DELETE') AS app_delete,
              has_table_privilege('wms_app', 'public.' || t, 'TRUNCATE') AS app_trunc,
              has_any_column_privilege('wms_ops', 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES') AS ops_any,
              has_any_column_privilege('wms_auth', 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES') AS auth_any,
              coalesce((SELECT bool_or(x.grantee = 0) FROM pg_class c, aclexplode(c.relacl) x WHERE c.oid = ('public.' || t)::regclass), false) AS public_any
         FROM unnest($1::text[]) AS t`,
      [[...NEW_TABLES_302]],
    );
    expect(r.rows).toHaveLength(NEW_TABLES_302.length);
    for (const row of r.rows) expect(row, row.t).toMatchObject({ app_delete: false, app_trunc: false, ops_any: false, auth_any: false, public_any: false });
  });

  it("sunucu sütunlarında wms_app INSERT yetkisi yok; anahtar/türetilen sütunlarda UPDATE yetkisi yok; yazılabilir sütunlarda var", async () => {
    const noInsert: [string, string][] = [
      ["warehouse_tasks", "status"], ["warehouse_tasks", "version"], ["warehouse_tasks", "completed_at"], ["warehouse_tasks", "assigned_membership_id"],
      ["count_sessions", "status"], ["count_sessions", "approved_by"], ["count_sessions", "approved_at"], ["count_sessions", "started_at"], ["count_sessions", "cancel_reason"],
      ["count_session_lines", "counted_quantity"], ["count_session_lines", "counted_by"], ["count_session_lines", "counted_at"],
      ["item_stock_policies", "version"],
      ["stock_alerts", "status"], ["stock_alerts", "opened_at"], ["stock_alerts", "resolved_at"],
    ];
    const noUpdate: [string, string][] = [
      ["warehouse_tasks", "version"], ["warehouse_tasks", "completed_at"], ["warehouse_tasks", "kind"], ["warehouse_tasks", "warehouse_id"], ["warehouse_tasks", "item_id"],
      ["warehouse_tasks", "quantity"], ["warehouse_tasks", "source_id"], ["warehouse_tasks", "tenant_id"],
      ["count_sessions", "approved_at"], ["count_sessions", "started_by"], ["count_sessions", "blind"], ["count_sessions", "warehouse_id"], ["count_sessions", "started_at"],
      ["count_session_lines", "reference_quantity"], ["count_session_lines", "counted_at"], ["count_session_lines", "location_id"], ["count_session_lines", "stock_dimension_id"],
      ["count_session_lines", "session_id"], ["count_session_lines", "item_id"],
      ["item_stock_policies", "version"], ["item_stock_policies", "warehouse_id"], ["item_stock_policies", "item_id"],
      ["stock_alerts", "resolved_at"], ["stock_alerts", "opened_at"], ["stock_alerts", "kind"], ["stock_alerts", "warehouse_id"], ["stock_alerts", "item_id"],
    ];
    const yesUpdate: [string, string][] = [
      ["warehouse_tasks", "status"], ["warehouse_tasks", "assigned_membership_id"], ["count_sessions", "status"], ["count_sessions", "approved_by"],
      ["count_sessions", "cancel_reason"], ["count_session_lines", "counted_quantity"], ["count_session_lines", "counted_by"],
      ["item_stock_policies", "min_quantity"], ["item_stock_policies", "max_quantity"], ["stock_alerts", "status"], ["tenant_settings", "count_abandon_hours"],
    ];
    for (const [t, c] of noInsert) {
      const r = await admin.query<{ p: boolean }>("SELECT has_column_privilege('wms_app', $1, $2, 'INSERT') AS p", [`public.${t}`, c]);
      expect(r.rows[0]?.p, `${t}.${c} INSERT`).toBe(false);
    }
    for (const [t, c] of noUpdate) {
      const r = await admin.query<{ p: boolean }>("SELECT has_column_privilege('wms_app', $1, $2, 'UPDATE') AS p", [`public.${t}`, c]);
      expect(r.rows[0]?.p, `${t}.${c} UPDATE`).toBe(false);
    }
    for (const [t, c] of yesUpdate) {
      const r = await admin.query<{ p: boolean }>("SELECT has_column_privilege('wms_app', $1, $2, 'UPDATE') AS p", [`public.${t}`, c]);
      expect(r.rows[0]?.p, `${t}.${c} UPDATE`).toBe(true);
    }
  });

  it("status/versiyon/onay alanı için doğrudan INSERT 42501 (görev status, oturum status/approved_by, uyarı status)", async () => {
    expectFail(await asApp(A.tenantId, (q) => q("INSERT INTO public.warehouse_tasks (tenant_id, warehouse_id, kind, status) VALUES ($1, $2, 'PICK', 'DONE')", [A.tenantId, A.warehouseId])), INSUFFICIENT_PRIVILEGE, "task status");
    expectFail(await asApp(A.tenantId, (q) => q("INSERT INTO public.count_sessions (tenant_id, warehouse_id, started_by, status) VALUES ($1, $2, $3, 'APPROVED')", [A.tenantId, A.warehouseId, A.ownerMembershipId])), INSUFFICIENT_PRIVILEGE, "session status");
    expectFail(await asApp(A.tenantId, (q) => q("INSERT INTO public.count_sessions (tenant_id, warehouse_id, started_by, approved_by) VALUES ($1, $2, $3, $3)", [A.tenantId, A.warehouseId, A.ownerMembershipId])), INSUFFICIENT_PRIVILEGE, "session approved_by");
    expectFail(await asApp(A.tenantId, (q) => q("INSERT INTO public.stock_alerts (tenant_id, kind, warehouse_id, item_id, observed_quantity, threshold, status) VALUES ($1, 'MIN_MAX', $2, $3, 1, 2, 'RESOLVED')", [A.tenantId, A.warehouseId, A.itemId])), INSUFFICIENT_PRIVILEGE, "alert status");
  });
});

describe("T-302 tenant yalıtımı (AC-04 DB katmanı, yeni tablolar)", () => {
  it("B tenant'ının görev/oturum/satır/politika/uyarı satırları A bağlamında görünmez; A bağlamında B tenant_id'li satır yazılamaz (42501)", async () => {
    const r = await asApp(B.tenantId, async (q) => {
      await q(insTask, [B.tenantId, randomUUID(), B.warehouseId, "PUTAWAY", B.rootLocationId, B.itemNoneId, "1"]);
      const sid = await mkSession(q, B);
      await q(insSessionLine, [B.tenantId, randomUUID(), sid, B.warehouseId, B.rootLocationId, B.dimensionId, B.itemNoneId, "10"]);
      await q(insPolicy, [B.tenantId, randomUUID(), B.warehouseId, B.itemId, "1", "5"]);
      await q(insAlert, [B.tenantId, randomUUID(), "MIN_MAX", B.warehouseId, B.itemId, "0", "1"]);
      await setCtx(q, A.tenantId);
      for (const t of NEW_TABLES_302) {
        const c = await q(`SELECT count(*)::int AS n FROM public.${t} WHERE tenant_id = $1`, [B.tenantId]);
        expect(c.rows[0]?.n, `${t} A bağlamında B satırı görünür`).toBe(0);
        const own = await q(`SELECT count(*)::int AS n FROM public.${t}`);
        expect(own.rows[0]?.n, `${t} A kendi satırlarını görmeli`).toBeGreaterThanOrEqual(1);
      }
    });
    expectOk(r, "B satırları A'dan görünmez");

    const w: [string, string, unknown[]][] = [
      ["warehouse_tasks", insTask, [B.tenantId, randomUUID(), A.warehouseId, "PUTAWAY", null, null, null]],
      ["count_sessions", insSession, [B.tenantId, randomUUID(), A.warehouseId, false, A.ownerMembershipId]],
      ["item_stock_policies", insPolicy, [B.tenantId, randomUUID(), A.warehouseId, A.itemId, "1", "5"]],
      ["stock_alerts", insAlert, [B.tenantId, randomUUID(), "MIN_MAX", A.warehouseId, A.itemId, "0", "1"]],
    ];
    for (const [t, sql, p] of w) expectFail(await asApp(A.tenantId, (q) => q(sql, p)), INSUFFICIENT_PRIVILEGE, `${t} B satırı A bağlamında`);
    // Bağlamsız (tenant ayarı yok) bağlantı satır görmez.
    await app.query("BEGIN");
    try {
      for (const t of NEW_TABLES_302) {
        const c = await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t}`);
        expect(c.rows[0]?.n, `${t} bağlamsız`).toBe(0);
      }
    } finally {
      await app.query("ROLLBACK");
    }
  });

  it("başka tenant'ın üyeliği/oturumu/ürünü/lokasyonu A satırına bağlanamaz (23503)", async () => {
    expectFail(await asApp(A.tenantId, (q) => q(insSession, [A.tenantId, randomUUID(), A.warehouseId, false, B.ownerMembershipId])), FK_VIOLATION, "oturum started_by = B üyeliği");
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const t = randomUUID();
        await q(insTask, [A.tenantId, t, A.warehouseId, "PICK", null, null, null]);
        await q("UPDATE public.warehouse_tasks SET status = 'ASSIGNED', assigned_membership_id = $2 WHERE id = $1", [t, B.memberMembershipId]);
      }),
      FK_VIOLATION,
      "görev atanan = B üyeliği",
    );
    expectFail(await asApp(A.tenantId, (q) => q(insTask, [A.tenantId, randomUUID(), A.warehouseId, "PUTAWAY", B.rootLocationId, null, null])), FK_VIOLATION, "görev lokasyonu = B");
    expectFail(await asApp(A.tenantId, (q) => q(insPolicy, [A.tenantId, randomUUID(), A.warehouseId, B.itemId, "1", "2"])), FK_VIOLATION, "politika ürünü = B");
    expectFail(await asApp(A.tenantId, (q) => q(insAlert, [A.tenantId, randomUUID(), "MIN_MAX", B.warehouseId, A.itemId, "0", "1"])), FK_VIOLATION, "uyarı deposu = B");
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, A.rootLocationId, B.dimensionId, A.itemNoneId, "1"]);
      }),
      FK_VIOLATION,
      "satır boyutu = B",
    );
  });
});

describe("T-302 sayım kilidi → oturum FK'si (A-84) ve A-85 CHECK'i", () => {
  it("COUNTING satırı var olmayan oturuma 23503; var olan oturuma kabul; A-85 CHECK (COUNTING ama oturum boş) 23514 korunur", async () => {
    expectFail(await asApp(A.tenantId, (q) => q(lockSql, [A.tenantId, randomUUID(), A.ownerMembershipId, A.rootLocationId])), FK_VIOLATION, "var olmayan oturum");
    expectFail(await asApp(A.tenantId, (q) => q(lockSql, [A.tenantId, B.countSessionId, A.ownerMembershipId, A.rootLocationId])), FK_VIOLATION, "B'nin oturumu (RLS'e göre görünmez)");
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        await q(lockSql, [A.tenantId, sid, A.ownerMembershipId, A.rootLocationId]);
        const r = await q("SELECT status, count_session_id FROM public.location_count_locks WHERE location_id = $1", [A.rootLocationId]);
        expect(r.rows).toEqual([{ status: "COUNTING", count_session_id: sid }]);
      }),
      "gerçek oturum",
    );
    expectFail(
      await asApp(A.tenantId, (q) => q("UPDATE public.location_count_locks SET status = 'COUNTING' WHERE tenant_id = $1 AND location_id = $2", [A.tenantId, A.rootLocationId])),
      CHECK_VIOLATION,
      "A-85: COUNTING ama oturum boş",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        await q("UPDATE public.location_count_locks SET status = 'IDLE', count_session_id = $2 WHERE tenant_id = $1 AND location_id = $3", [A.tenantId, sid, A.rootLocationId]);
      }),
      CHECK_VIOLATION,
      "A-85: IDLE ama oturum dolu",
    );
  });

  it("kilide bağlı oturum silinemez/başka tenant'a taşınamaz: sahip düzeyinde de oturum satırı kilit varken silmek 23503", async () => {
    const r = await asAdmin(A.tenantId, async (q) => {
      const sid = await mkSession(q, A);
      await q(lockSql, [A.tenantId, sid, A.ownerMembershipId, A.rootLocationId]);
      await q("DELETE FROM public.count_sessions WHERE id = $1", [sid]);
    }, true);
    expectFail(r, FK_VIOLATION, "kilitli oturum silme");
  });
});

describe("T-302 görevler (warehouse_tasks)", () => {
  it("ASSIGNED ⇒ atanan dolu (23514); atanınca kabul; DONE'a geçişte completed_at sunucuda yazılır, version +1; terminal görev değişmez", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const t = randomUUID();
        await q(insTask, [A.tenantId, t, A.warehouseId, "PICK", null, null, null]);
        await q("UPDATE public.warehouse_tasks SET status = 'ASSIGNED' WHERE id = $1", [t]);
      }),
      CHECK_VIOLATION,
      "ASSIGNED atanansız",
    );
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const t = randomUUID();
        await q(insTask, [A.tenantId, t, A.warehouseId, "PUTAWAY", A.rootLocationId, A.itemNoneId, "3.5"]);
        const o = await q("SELECT status, version, completed_at FROM public.warehouse_tasks WHERE id = $1", [t]);
        expect(o.rows).toEqual([{ status: "OPEN", version: 1, completed_at: null }]);
        await q("UPDATE public.warehouse_tasks SET status = 'ASSIGNED', assigned_membership_id = $2 WHERE id = $1", [t, A.memberMembershipId]);
        await q("UPDATE public.warehouse_tasks SET status = 'DONE' WHERE id = $1", [t]);
        const d = await q("SELECT status, version, completed_at IS NOT NULL AS done, assigned_membership_id FROM public.warehouse_tasks WHERE id = $1", [t]);
        expect(d.rows).toEqual([{ status: "DONE", version: 3, done: true, assigned_membership_id: A.memberMembershipId }]);
        await q("UPDATE public.warehouse_tasks SET status = 'DONE' WHERE id = $1", [t]); // değişmeyen UPDATE geçer
      }),
      "atama + tamamlama",
    );
    for (const terminal of ["DONE", "CANCELLED"]) {
      expectFail(
        await asApp(A.tenantId, async (q) => {
          const t = randomUUID();
          await q(insTask, [A.tenantId, t, A.warehouseId, "PICK", null, null, null]);
          await q("UPDATE public.warehouse_tasks SET status = $2 WHERE id = $1", [t, terminal]);
          await q("UPDATE public.warehouse_tasks SET status = 'OPEN' WHERE id = $1", [t]);
        }),
        CHECK_VIOLATION,
        `${terminal} terminal`,
      );
    }
  });

  it("CHECK'ler: kind/status/source beyaz listesi, kaynak çifti, miktar>0 ve ürün gerekir; lokasyon görevin deposunda olmalı (23503)", async () => {
    const bad: [string, string, unknown[]][] = [
      ["kind", insTask, [A.tenantId, randomUUID(), A.warehouseId, "SHIP", null, null, null]],
      ["miktar 0", insTask, [A.tenantId, randomUUID(), A.warehouseId, "PICK", null, A.itemNoneId, "0"]],
      ["miktar ürünsüz", insTask, [A.tenantId, randomUUID(), A.warehouseId, "PICK", null, null, "1"]],
      ["source_kind tek başına", "INSERT INTO public.warehouse_tasks (tenant_id, warehouse_id, kind, source_kind) VALUES ($1, $2, 'PICK', 'SALES_ORDER')", [A.tenantId, A.warehouseId]],
      ["source_kind beyaz liste", "INSERT INTO public.warehouse_tasks (tenant_id, warehouse_id, kind, source_kind, source_id) VALUES ($1, $2, 'PICK', 'TASK', gen_random_uuid())", [A.tenantId, A.warehouseId]],
      ["source_line kaynaksız", "INSERT INTO public.warehouse_tasks (tenant_id, warehouse_id, kind, source_line_id) VALUES ($1, $2, 'PICK', gen_random_uuid())", [A.tenantId, A.warehouseId]],
    ];
    for (const [label, sql, p] of bad) expectFail(await asApp(A.tenantId, (q) => q(sql, p)), CHECK_VIOLATION, label);
    expectOk(
      await asApp(A.tenantId, (q) => q("INSERT INTO public.warehouse_tasks (tenant_id, warehouse_id, kind, source_kind, source_id, source_line_id, group_id) VALUES ($1, $2, 'PICK', 'SALES_ORDER', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [A.tenantId, A.warehouseId])),
      "geçerli kaynak bağlantılı görev",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const w2 = await mkSecondWarehouse(q, A);
        await q(insTask, [A.tenantId, randomUUID(), A.warehouseId, "PUTAWAY", w2.locationId, null, null]);
      }),
      FK_VIOLATION,
      "başka depodaki lokasyon",
    );
  });

  it("anahtar sütunlar tablo sahibi dahil değişmez (23514)", async () => {
    for (const set of ["kind = 'PICK'", "quantity = 9", "created_at = now() + interval '1 day'"]) {
      expectFail(
        await asAdmin(A.tenantId, (q) => q(`UPDATE public.warehouse_tasks SET ${set} WHERE tenant_id = $1 AND kind = 'PUTAWAY'`, [A.tenantId])),
        CHECK_VIOLATION,
        set,
      );
    }
  });
});

describe("T-302 sayım oturumu ve satırları", () => {
  it("oturum COUNTING doğar; onay APPROVED'a geçerken approved_by zorunlu (23514) ve approved_at sunucuda yazılır; geri gitmez; CANCELLED gerekçe ister", async () => {
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        const o = await q("SELECT status, blind, approved_by, approved_at, cancel_reason, started_at IS NOT NULL AS has_start FROM public.count_sessions WHERE id = $1", [sid]);
        expect(o.rows).toEqual([{ status: "COUNTING", blind: false, approved_by: null, approved_at: null, cancel_reason: null, has_start: true }]);
        await q("UPDATE public.count_sessions SET status = 'SUBMITTED' WHERE id = $1", [sid]);
        await q("UPDATE public.count_sessions SET status = 'APPROVED', approved_by = $2 WHERE id = $1", [sid, A.ownerMembershipId]);
        const a = await q("SELECT status, approved_by, approved_at IS NOT NULL AS has_at FROM public.count_sessions WHERE id = $1", [sid]);
        expect(a.rows).toEqual([{ status: "APPROVED", approved_by: A.ownerMembershipId, has_at: true }]);
        await q("UPDATE public.count_sessions SET status = 'POSTED' WHERE id = $1", [sid]);
      }),
      "tam yaşam döngüsü",
    );
    const fails: [string, (q: Q) => Promise<unknown>][] = [
      ["onaysız APPROVED", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET status = 'APPROVED' WHERE id = $1", [s]); }],
      ["COUNTING iken approved_by", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET approved_by = $2 WHERE id = $1", [s, A.ownerMembershipId]); }],
      ["gerekçesiz CANCELLED", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET status = 'CANCELLED' WHERE id = $1", [s]); }],
      ["boş gerekçe", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET status = 'CANCELLED', cancel_reason = '  ' WHERE id = $1", [s]); }],
      ["gerekçe CANCELLED olmadan", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET cancel_reason = 'x' WHERE id = $1", [s]); }],
      ["SUBMITTED → COUNTING", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET status = 'SUBMITTED' WHERE id = $1", [s]); await q("UPDATE public.count_sessions SET status = 'COUNTING' WHERE id = $1", [s]); }],
      ["CANCELLED sonrası geri", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET status = 'CANCELLED', cancel_reason = 'x' WHERE id = $1", [s]); await q("UPDATE public.count_sessions SET status = 'COUNTING', cancel_reason = NULL WHERE id = $1", [s]); }],
      ["POSTED sonrası iptal", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET status = 'APPROVED', approved_by = $2 WHERE id = $1", [s, A.ownerMembershipId]); await q("UPDATE public.count_sessions SET status = 'POSTED' WHERE id = $1", [s]); await q("UPDATE public.count_sessions SET status = 'CANCELLED', cancel_reason = 'x' WHERE id = $1", [s]); }],
      ["durum beyaz liste", async (q) => { const s = await mkSession(q, A); await q("UPDATE public.count_sessions SET status = 'DONE' WHERE id = $1", [s]); }],
    ];
    for (const [label, work] of fails) expectFail(await asApp(A.tenantId, work), CHECK_VIOLATION, label);
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.count_sessions SET blind = NOT blind WHERE tenant_id = $1", [A.tenantId])), CHECK_VIOLATION, "blind değişmez (sahip)");
  });

  it("satır: boyutsuz satırın referansı 0; boyut-ürün uyumu ve oturum-depo/lokasyon-depo uyumu bileşik FK ile (23503); mükerrer satır 23505", async () => {
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, A.rootLocationId, null, A.itemId, "1"]);
      }),
      CHECK_VIOLATION,
      "boyutsuz satır referans > 0",
    );
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, A.rootLocationId, null, A.itemId, "0"]);
      }),
      "sistemde olmayan sayılan ürün (boyutsuz, referans 0)",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, A.rootLocationId, A.dimensionId, A.itemId, "1"]); // boyut itemNone'a ait
      }),
      FK_VIOLATION,
      "boyut-ürün uyuşmazlığı",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const w2 = await mkSecondWarehouse(q, A);
        const sid = await mkSession(q, A);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, w2.locationId, null, A.itemId, "0"]);
      }),
      FK_VIOLATION,
      "lokasyon başka depoda",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const w2 = await mkSecondWarehouse(q, A);
        const sid = await mkSession(q, A);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, w2.warehouseId, w2.locationId, null, A.itemId, "0"]);
      }),
      FK_VIOLATION,
      "satır deposu oturum deposundan farklı",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, A.rootLocationId, A.dimensionId, A.itemNoneId, "10"]);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, A.rootLocationId, A.dimensionId, A.itemNoneId, "10"]);
      }),
      UNIQUE_VIOLATION,
      "aynı boyut iki satır",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, A.rootLocationId, null, A.itemId, "0"]);
        await q(insSessionLine, [A.tenantId, randomUUID(), sid, A.warehouseId, A.rootLocationId, null, A.itemId, "0"]);
      }),
      UNIQUE_VIOLATION,
      "aynı lokasyon×ürün boyutsuz iki satır",
    );
  });

  it("sayım değeri: counted_quantity/counted_by birlikte; counted_at sunucuda; referans bakiye UPDATE edilemez (42501, sahip düzeyinde 23514)", async () => {
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const sid = await mkSession(q, A);
        const lid = randomUUID();
        await q(insSessionLine, [A.tenantId, lid, sid, A.warehouseId, A.rootLocationId, A.dimensionId, A.itemNoneId, "10"]);
        await q("UPDATE public.count_session_lines SET counted_quantity = 9.5, counted_by = $2 WHERE id = $1", [lid, A.ownerMembershipId]);
        const r = await q("SELECT reference_quantity::text AS ref, counted_quantity::text AS c, counted_at IS NOT NULL AS has_at FROM public.count_session_lines WHERE id = $1", [lid]);
        expect(r.rows).toEqual([{ ref: "10.000000", c: "9.500000", has_at: true }]);
        await q("UPDATE public.count_session_lines SET counted_quantity = NULL, counted_by = NULL WHERE id = $1", [lid]);
        const z = await q("SELECT counted_at FROM public.count_session_lines WHERE id = $1", [lid]);
        expect(z.rows).toEqual([{ counted_at: null }]);
      }),
      "sayım yazımı",
    );
    const mk = async (q: Q): Promise<string> => {
      const sid = await mkSession(q, A);
      const lid = randomUUID();
      await q(insSessionLine, [A.tenantId, lid, sid, A.warehouseId, A.rootLocationId, A.dimensionId, A.itemNoneId, "10"]);
      return lid;
    };
    expectFail(await asApp(A.tenantId, async (q) => { const l = await mk(q); await q("UPDATE public.count_session_lines SET counted_quantity = 1 WHERE id = $1", [l]); }), CHECK_VIOLATION, "sayan olmadan değer");
    expectFail(await asApp(A.tenantId, async (q) => { const l = await mk(q); await q("UPDATE public.count_session_lines SET counted_quantity = -1, counted_by = $2 WHERE id = $1", [l, A.ownerMembershipId]); }), CHECK_VIOLATION, "negatif sayım");
    expectFail(await asApp(A.tenantId, async (q) => { const l = await mk(q); await q("UPDATE public.count_session_lines SET reference_quantity = 0 WHERE id = $1", [l]); }), INSUFFICIENT_PRIVILEGE, "referans (wms_app)");
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.count_session_lines SET reference_quantity = reference_quantity + 1 WHERE tenant_id = $1", [A.tenantId])), CHECK_VIOLATION, "referans (sahip)");
  });
});

describe("T-302 min-maks politikası ve uyarılar", () => {
  it("CHECK 0 ≤ min ≤ max (23514); depo × ürün tek politika (23505, A-131); değerler güncellenebilir", async () => {
    for (const [label, mn, mx] of [["min > max", "5", "4"], ["min < 0", "-1", "4"]] as const) {
      expectFail(await asApp(A.tenantId, (q) => q(insPolicy, [A.tenantId, randomUUID(), A.warehouseId, A.itemId, mn, mx])), CHECK_VIOLATION, label);
    }
    expectFail(await asApp(A.tenantId, (q) => q(insPolicy, [A.tenantId, randomUUID(), A.warehouseId, A.itemNoneId, "1", "2"])), UNIQUE_VIOLATION, "ikinci politika (fikstürde var)");
    expectOk(
      await asApp(A.tenantId, async (q) => {
        await q(insPolicy, [A.tenantId, randomUUID(), A.warehouseId, A.itemId, "0", "0"]);
        await q("UPDATE public.item_stock_policies SET min_quantity = 1, max_quantity = 7.5 WHERE tenant_id = $1 AND item_id = $2", [A.tenantId, A.itemId]);
        const r = await q("SELECT version, max_quantity::text AS mx FROM public.item_stock_policies WHERE item_id = $1", [A.itemId]);
        expect(r.rows).toEqual([{ version: 2, mx: "7.500000" }]);
      }),
      "min = max = 0 ve güncelleme",
    );
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.item_stock_policies SET min_quantity = 99 WHERE tenant_id = $1", [A.tenantId])), CHECK_VIOLATION, "güncellemede min > max");
  });

  it("aynı depo × ürün için ikinci OPEN uyarı 23505; kapatılınca yenisi açılabilir; RESOLVED terminal ve resolved_at sunucuda", async () => {
    expectFail(await asApp(A.tenantId, (q) => q(insAlert, [A.tenantId, randomUUID(), "MIN_MAX", A.warehouseId, A.itemNoneId, "0", "2"])), UNIQUE_VIOLATION, "ikinci OPEN (fikstürde var)");
    expectOk(
      await asApp(A.tenantId, async (q) => {
        await q("UPDATE public.stock_alerts SET status = 'RESOLVED' WHERE tenant_id = $1 AND item_id = $2", [A.tenantId, A.itemNoneId]);
        const r = await q("SELECT status, resolved_at IS NOT NULL AS has_at FROM public.stock_alerts WHERE tenant_id = $1 AND item_id = $2", [A.tenantId, A.itemNoneId]);
        expect(r.rows).toEqual([{ status: "RESOLVED", has_at: true }]);
        await q(insAlert, [A.tenantId, randomUUID(), "MIN_MAX", A.warehouseId, A.itemNoneId, "0", "2"]);
        const n = await q("SELECT count(*)::int AS n FROM public.stock_alerts WHERE tenant_id = $1 AND item_id = $2", [A.tenantId, A.itemNoneId]);
        expect(n.rows[0]?.n).toBe(2);
      }),
      "kapat ve yeniden aç",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        await q("UPDATE public.stock_alerts SET status = 'RESOLVED' WHERE tenant_id = $1 AND item_id = $2", [A.tenantId, A.itemNoneId]);
        await q("UPDATE public.stock_alerts SET status = 'OPEN' WHERE tenant_id = $1 AND item_id = $2", [A.tenantId, A.itemNoneId]);
      }),
      CHECK_VIOLATION,
      "RESOLVED yeniden açılamaz",
    );
    expectFail(await asApp(A.tenantId, (q) => q(insAlert, [A.tenantId, randomUUID(), "STOCKOUT", A.warehouseId, A.itemId, "0", "1"])), CHECK_VIOLATION, "kind beyaz liste");
    expectFail(await asApp(A.tenantId, (q) => q(insAlert, [A.tenantId, randomUUID(), "MIN_MAX", A.warehouseId, A.itemId, "-1", "1"])), CHECK_VIOLATION, "negatif gözlem");
  });

  it("uyarı yazımı stok tablolarına dokunmaz: wms_app uyarı yazarken stock_ledger/stock_balances satır sayısı değişmez (AC-20 DB önkoşulu)", async () => {
    const count = async (): Promise<[string, string]> => {
      const l = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_ledger WHERE tenant_id = $1", [A.tenantId]);
      const b = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_balances WHERE tenant_id = $1", [A.tenantId]);
      return [l.rows[0]?.n ?? "", b.rows[0]?.n ?? ""];
    };
    const before = await count();
    expectOk(await asApp(A.tenantId, (q) => q(insAlert, [A.tenantId, randomUUID(), "MIN_MAX", A.warehouseId, A.itemId, "0", "1"])), "uyarı yazımı");
    expect(await count()).toEqual(before);
  });
});

describe("T-302 COUNT_ADJUSTMENT belge türü ve count_abandon_hours", () => {
  const insDoc =
    "INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by) VALUES ($1, $2, $3, $4, $5, '2026-02-01', $6)";
  const typeVersion = async (q: Q, key: string): Promise<string> => {
    const r = await q("SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = $1 AND version = 1", [key]);
    return (r.rows[0] as { id: string }).id;
  };

  it("sistem v1 satırı vardır; COUNT_ADJUSTMENT belgesi sistem sürümüyle açılır, STOCK_IN sürümüyle 23503; beyaz liste dışı tür 23514; sayaç anahtarı kabul", async () => {
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const tv = await q("SELECT version, definition FROM public.document_type_versions WHERE tenant_id IS NULL AND key = 'COUNT_ADJUSTMENT'");
        expect(tv.rows).toEqual([{ version: 1, definition: { schemaVersion: 1, kind: "COUNT_ADJUSTMENT" } }]);
        await q(insDoc, [A.tenantId, randomUUID(), "COUNT_ADJUSTMENT", await typeVersion(q, "COUNT_ADJUSTMENT"), A.warehouseId, A.ownerUserId]);
        await q("INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'COUNT_ADJUSTMENT', '2026')", [A.tenantId]);
      }),
      "COUNT_ADJUSTMENT belgesi",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => q(insDoc, [A.tenantId, randomUUID(), "COUNT_ADJUSTMENT", await typeVersion(q, "STOCK_IN"), A.warehouseId, A.ownerUserId])),
      FK_VIOLATION,
      "tür/sürüm uyuşmazlığı",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => q(insDoc, [A.tenantId, randomUUID(), "COUNT_DIFF", await typeVersion(q, "COUNT_ADJUSTMENT"), A.warehouseId, A.ownerUserId])),
      CHECK_VIOLATION,
      "kind beyaz liste",
    );
    expectFail(await asApp(A.tenantId, (q) => q("INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'COUNT_DIFF', '2026')", [A.tenantId])), CHECK_VIOLATION, "sayaç beyaz liste");
    // Sistem satırı wms_app için değişmez (I-11).
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.document_type_versions SET definition = '{}'::jsonb WHERE key = 'COUNT_ADJUSTMENT'")), INSUFFICIENT_PRIVILEGE, "wms_app UPDATE");
    expectFail(await asAdmin(A.tenantId, (q) => q("DELETE FROM public.document_type_versions WHERE key = 'COUNT_ADJUSTMENT'")), INSUFFICIENT_PRIVILEGE, "sahip DELETE (tetikleyici)");
  });

  it("tenant_settings.count_abandon_hours: varsayılan 8 (A-136); wms_app 1–168 arası günceller; dışı 23514", async () => {
    const d = await admin.query<{ column_default: string; data_type: string; is_nullable: string }>(
      "SELECT column_default, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenant_settings' AND column_name = 'count_abandon_hours'",
    );
    expect(d.rows).toEqual([{ column_default: "8", data_type: "smallint", is_nullable: "NO" }]);
    const cur = await admin.query<{ v: number }>("SELECT count_abandon_hours AS v FROM public.tenant_settings WHERE tenant_id = $1", [A.tenantId]);
    expect(cur.rows[0]?.v).toBe(8);
    expectOk(
      await asApp(A.tenantId, async (q) => {
        const u = await q("UPDATE public.tenant_settings SET count_abandon_hours = 12 WHERE tenant_id = $1 RETURNING count_abandon_hours", [A.tenantId]);
        expect(u.rows).toEqual([{ count_abandon_hours: 12 }]);
      }),
      "12 saat",
    );
    for (const v of [0, 169]) {
      expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.tenant_settings SET count_abandon_hours = $2 WHERE tenant_id = $1", [A.tenantId, v])), CHECK_VIOLATION, `${v} saat`);
    }
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.tenant_settings SET tenant_id = tenant_id WHERE tenant_id = $1", [A.tenantId])), INSUFFICIENT_PRIVILEGE, "tenant_id yine yazılamaz (yetki genişlemedi)");
  });
});
