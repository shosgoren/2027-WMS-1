// Katalog ve izlenebilirlik şeması (T-204, I-03, ADR-017 §1-§2, A-69, A-72, ADR-011). GERÇEK rollerle: uygulama rolü wms_app
// (DATABASE_URL, pooler); migration rolü yalnızca fikstür kurulumu/temizliği ve katalog okuması içindir.
// Sentetik veri: rastgele UUID/kodlar (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../../../packages/db/src/migrate.ts";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const INSUFFICIENT_PRIVILEGE = "42501";
const FK_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const DEADLOCK = "40P01";
const OPS = "wms_ops";
const NEW_TABLES = ["units", "items", "unit_conversions", "item_barcodes", "inventory_owners", "lots", "serials", "handling_units"] as const;
const rnd = (): string => randomBytes(4).toString("hex");

const reg = newRegistry();
const clients: pg.Client[] = [];
let admin: pg.Client;
let app: pg.Client;
let app2: pg.Client;
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
type Q = (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;

/** wms_app, tenant bağlamı transaction-local (G-02); daima ROLLBACK (kalıcı değişiklik yok). */
async function inTenant(tenantId: string, work: (q: Q) => Promise<unknown>): Promise<Attempt> {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await app.query(sql, p);
      return last;
    });
    return { ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await app.query("ROLLBACK");
  }
}

async function one(tenantId: string, sql: string, p: unknown[] = []): Promise<Attempt> {
  return inTenant(tenantId, async (q) => q(sql, p));
}

function expectFail(r: Attempt, code: string, label?: string): void {
  expect(r.ok, label ?? JSON.stringify(r)).toBe(false);
  if (!r.ok) expect(r.code, `${label ?? ""} ${r.message}`).toBe(code);
}

const insItem = (t: string, id: string, unit: string, code = `I-${rnd()}`): [string, unknown[]] => [
  "INSERT INTO public.items (tenant_id, id, code, name, base_unit_id) VALUES ($1, $2, $3, 'x', $4)",
  [t, id, code, unit],
];

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  app2 = await connect(env.databaseUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
}, 60_000);

afterAll(async () => {
  try {
    if (admin !== undefined) {
      await cleanupRegistry(admin, reg);
    }
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
}, 60_000);

describe("T-204 ürün ve birim", () => {
  it("quantity_scale 0..6, tracking_mode ve pick_policy değer kümeleri, tekil kod", async () => {
    for (const [col, val] of [["quantity_scale", "7"], ["quantity_scale", "-1"], ["tracking_mode", "'BOGUS'"], ["pick_policy", "'LIFO'"]] as const) {
      const r = await one(
        A.tenantId,
        `INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, ${col}) VALUES ($1, $2, $3, 'x', $4, ${val})`,
        [A.tenantId, randomUUID(), `I-${rnd()}`, A.unitId],
      );
      expectFail(r, CHECK_VIOLATION, `${col}=${val}`);
    }
    const ok = await one(
      A.tenantId,
      "INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale, pick_policy) VALUES ($1, $2, $3, 'x', $4, 'LOT_AND_SERIAL', 6, 'FEFO')",
      [A.tenantId, randomUUID(), `I-${rnd()}`, A.unitId],
    );
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expectFail(await one(A.tenantId, ...insItem(A.tenantId, randomUUID(), A.unitId, "U1")), UNIQUE_VIOLATION, "aynı ürün kodu");
    expectFail(await one(A.tenantId, "INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1, $2, 'ADET', 'x')", [A.tenantId, randomUUID()]), UNIQUE_VIOLATION, "aynı birim kodu");
  });

  it("temel birim başka tenant'ın birimi: bileşik FK reddi", async () => {
    expectFail(await one(A.tenantId, ...insItem(A.tenantId, randomUUID(), B.unitId)), FK_VIOLATION);
  });

  it("dönüşüm katsayısı 0 ve negatif reddedilir; tekrar eden (ürün, birim) reddedilir; temel birim için satır yok", async () => {
    for (const f of ["0", "-1", "-0.000001"]) {
      expectFail(
        await one(A.tenantId, "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, $4)", [A.tenantId, A.itemTwoId, A.boxUnitId, f]),
        CHECK_VIOLATION,
        `factor ${f}`,
      );
    }
    const okIns = await one(A.tenantId, "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 12.5)", [A.tenantId, A.itemTwoId, A.boxUnitId]);
    expect(okIns.ok, JSON.stringify(okIns)).toBe(true);
    expectFail(
      await one(A.tenantId, "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 2)", [A.tenantId, A.itemId, A.boxUnitId]),
      UNIQUE_VIOLATION,
      "fikstürde zaten var",
    );
    const base = await one(A.tenantId, "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 1)", [A.tenantId, A.itemTwoId, A.unitId]);
    expectFail(base, CHECK_VIOLATION, "temel birim");
    if (!base.ok) expect(base.message).toMatch(/temel birim/);
  });

  it("katsayı numeric(20,6) kesinliğiyle saklanır (float yok)", async () => {
    const r = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 0.000001)", [A.tenantId, A.itemTwoId, A.boxUnitId]);
      const v = await q("SELECT to_base_factor::text AS f FROM public.unit_conversions WHERE item_id = $1", [A.itemTwoId]);
      expect(v.rows).toEqual([{ f: "0.000001" }]);
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("dönüşüm: başka tenant'ın ürünü/birimi bileşik FK ile reddedilir", async () => {
    expectFail(
      await one(A.tenantId, "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 2)", [A.tenantId, B.itemId, A.boxUnitId]),
      FK_VIOLATION,
    );
    expectFail(
      await one(A.tenantId, "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 2)", [A.tenantId, A.itemTwoId, B.boxUnitId]),
      FK_VIOLATION,
    );
  });
});

describe("T-204 barkod (NULL-safe tekillik, A-69)", () => {
  it("NULL birimli iki aynı (ürün, barkod) satırı reddedilir; kısıt NULLS NOT DISTINCT", async () => {
    const code = `BC-${rnd()}`;
    const r = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3)", [A.tenantId, A.itemTwoId, code]);
      await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3)", [A.tenantId, A.itemTwoId, code]);
    });
    expectFail(r, UNIQUE_VIOLATION);
    const def = await admin.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.item_barcodes'::regclass AND contype = 'u' AND conname = 'item_barcodes_tenant_item_unit_barcode_key'",
    );
    expect(def.rows[0]?.def).toContain("NULLS NOT DISTINCT");
  });

  it("dolu birimli aynı üçlü reddedilir; aynı ürün+barkod farklı birimle kabul", async () => {
    const code = `BC-${rnd()}`;
    const dup = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode, quantity) VALUES ($1, $2, $3, $4, 12)", [A.tenantId, A.itemTwoId, A.boxUnitId, code]);
      await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode, quantity) VALUES ($1, $2, $3, $4, 12)", [A.tenantId, A.itemTwoId, A.boxUnitId, code]);
    });
    expectFail(dup, UNIQUE_VIOLATION);
    const ok = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, $3, $4)", [A.tenantId, A.itemTwoId, A.boxUnitId, code]);
      await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3)", [A.tenantId, A.itemTwoId, code]);
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("aynı barkod iki ürüne bağlanabilir (A-69); (tenant_id, barcode) indeksi benzersiz DEĞİL", async () => {
    const code = `BC-${rnd()}`;
    const r = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3)", [A.tenantId, A.itemId, code]);
      await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3)", [A.tenantId, A.itemTwoId, code]);
      const n = await q("SELECT count(*)::int AS n FROM public.item_barcodes WHERE barcode = $1", [code]);
      expect(n.rows[0]?.n).toBe(2);
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const idx = await admin.query<{ indisunique: boolean; cols: string }>(
      `SELECT i.indisunique, (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'item_barcodes_tenant_barcode_idx'`,
    );
    expect(idx.rows).toEqual([{ indisunique: false, cols: "tenant_id,barcode" }]);
  });

  it("miktar > 0; başka tenant'ın ürünü/birimi FK ile reddedilir; boş barkod reddedilir", async () => {
    expectFail(await one(A.tenantId, "INSERT INTO public.item_barcodes (tenant_id, item_id, barcode, quantity) VALUES ($1, $2, 'q', 0)", [A.tenantId, A.itemId]), CHECK_VIOLATION);
    expectFail(await one(A.tenantId, "INSERT INTO public.item_barcodes (tenant_id, item_id, barcode) VALUES ($1, $2, '  ')", [A.tenantId, A.itemId]), CHECK_VIOLATION);
    expectFail(await one(A.tenantId, "INSERT INTO public.item_barcodes (tenant_id, item_id, barcode) VALUES ($1, $2, 'x')", [A.tenantId, B.itemId]), FK_VIOLATION);
    expectFail(await one(A.tenantId, "INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, $3, 'x')", [A.tenantId, A.itemId, B.unitId]), FK_VIOLATION);
  });
});

describe("T-204 lot ve seri (ürüne bağlı bileşik FK, A-72)", () => {
  it("lot: ürün içinde tekil kod, farklı üründe aynı kod kabul; SKT >= üretim tarihi", async () => {
    expectFail(await one(A.tenantId, "INSERT INTO public.lots (tenant_id, item_id, lot_code) VALUES ($1, $2, 'L1')", [A.tenantId, A.itemId]), UNIQUE_VIOLATION);
    const ok = await one(A.tenantId, "INSERT INTO public.lots (tenant_id, item_id, lot_code, production_date, expiry_date, supplier_lot) VALUES ($1, $2, 'L2', '2026-01-01', '2026-12-31', 'T-9')", [A.tenantId, A.itemId]);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expectFail(
      await one(A.tenantId, "INSERT INTO public.lots (tenant_id, item_id, lot_code, production_date, expiry_date) VALUES ($1, $2, 'L3', '2026-02-01', '2026-01-01')", [A.tenantId, A.itemId]),
      CHECK_VIOLATION,
    );
    expectFail(await one(A.tenantId, "INSERT INTO public.lots (tenant_id, item_id, lot_code) VALUES ($1, $2, 'L9')", [A.tenantId, B.itemId]), FK_VIOLATION, "başka tenant ürünü");
  });

  it("aynı ürün içinde seri tekrarı reddedilir; farklı üründe aynı seri kabul (A-72)", async () => {
    expectFail(await one(A.tenantId, "INSERT INTO public.serials (tenant_id, item_id, serial_no) VALUES ($1, $2, 'SN1')", [A.tenantId, A.itemId]), UNIQUE_VIOLATION);
    const ok = await one(A.tenantId, "INSERT INTO public.serials (tenant_id, item_id, serial_no) VALUES ($1, $2, 'SN1')", [A.tenantId, A.itemTwoId]);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("seri → lot: aynı tenant'ta BAŞKA ürünün lotu reddedilir; başka tenant'ın lotu reddedilir; kendi ürününün lotu/NULL lot kabul", async () => {
    expectFail(
      await one(A.tenantId, "INSERT INTO public.serials (tenant_id, item_id, serial_no, lot_id) VALUES ($1, $2, 'SN-X', $3)", [A.tenantId, A.itemId, A.lotTwoId]),
      FK_VIOLATION,
      "başka ürünün lotu",
    );
    expectFail(
      await one(A.tenantId, "INSERT INTO public.serials (tenant_id, item_id, serial_no, lot_id) VALUES ($1, $2, 'SN-Y', $3)", [A.tenantId, A.itemId, B.lotId]),
      FK_VIOLATION,
      "başka tenant lotu",
    );
    const ok = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.serials (tenant_id, item_id, serial_no, lot_id) VALUES ($1, $2, 'SN-OK', $3)", [A.tenantId, A.itemId, A.lotId]);
      await q("INSERT INTO public.serials (tenant_id, item_id, serial_no, lot_id) VALUES ($1, $2, 'SN-NOLOT', NULL)", [A.tenantId, A.itemId]);
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("bileşik FK hedefleri: lots/serials UNIQUE (tenant_id, item_id, id) ve UNIQUE (tenant_id, id)", async () => {
    const r = await admin.query<{ relname: string; def: string }>(
      `SELECT c.relname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        WHERE k.contype = 'u' AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`,
      [["lots", "serials"]],
    );
    for (const t of ["lots", "serials"]) {
      const defs = r.rows.filter((x) => x.relname === t).map((x) => x.def);
      expect(defs, t).toContain("UNIQUE (tenant_id, item_id, id)");
      expect(defs, t).toContain("UNIQUE (tenant_id, id)");
    }
  });
});

describe("T-204 taşıma birimi hiyerarşisi", () => {
  const mkHu = async (t: string, code: string, parent: string | null = null): Promise<string> => {
    const id = randomUUID();
    await admin.query("INSERT INTO public.handling_units (tenant_id, id, kind, code, parent_id) VALUES ($1, $2, 'KOLI', $3, $4)", [t, id, code, parent]);
    return id;
  };

  it("A→B→A döngüsü reddedilir (HANDLING_UNIT_CYCLE, 23514); self-parent ve uzun zincir döngüsü de", async () => {
    const hu1 = randomUUID();
    const hu2 = randomUUID();
    const hu3 = randomUUID();
    const r = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.handling_units (tenant_id, id, kind, code) VALUES ($1, $2, 'PALET', $3)", [A.tenantId, hu1, `H-${rnd()}`]);
      await q("INSERT INTO public.handling_units (tenant_id, id, kind, code, parent_id) VALUES ($1, $2, 'KOLI', $3, $4)", [A.tenantId, hu2, `H-${rnd()}`, hu1]);
      await q("INSERT INTO public.handling_units (tenant_id, id, kind, code, parent_id) VALUES ($1, $2, 'KOLI', $3, $4)", [A.tenantId, hu3, `H-${rnd()}`, hu2]);
      await q("UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [hu1, hu3]); // hu1 → hu3 → hu2 → hu1
    });
    expectFail(r, CHECK_VIOLATION);
    if (!r.ok) expect(r.message).toMatch(/HANDLING_UNIT_CYCLE/);
    const two = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.handling_units (tenant_id, id, kind, code) VALUES ($1, $2, 'PALET', $3)", [A.tenantId, hu1, `H-${rnd()}`]);
      await q("INSERT INTO public.handling_units (tenant_id, id, kind, code, parent_id) VALUES ($1, $2, 'KOLI', $3, $4)", [A.tenantId, hu2, `H-${rnd()}`, hu1]);
      await q("UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [hu1, hu2]); // A→B→A
    });
    expectFail(two, CHECK_VIOLATION);
    if (!two.ok) expect(two.message).toMatch(/HANDLING_UNIT_CYCLE/);
    const self = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.handling_units (tenant_id, id, kind, code) VALUES ($1, $2, 'PALET', $3)", [A.tenantId, hu1, `H-${rnd()}`]);
      await q("UPDATE public.handling_units SET parent_id = id WHERE id = $1", [hu1]);
    });
    expectFail(self, CHECK_VIOLATION);
    // CHECK'in kendisi (tetikleyiciden bağımsız ad): migration rolüyle INSERT kendi kendine ebeveyn.
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      const id = randomUUID();
      await expect(
        admin.query("INSERT INTO public.handling_units (tenant_id, id, kind, code, parent_id) VALUES ($1, $2, 'KOLI', 'SELF', $2)", [A.tenantId, id]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("geçerli iç içe koyma (koli → palet), yeniden ebeveynleme ve ebeveynden ayırma kabul edilir", async () => {
    const pal = randomUUID();
    const koli = randomUUID();
    const r = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.handling_units (tenant_id, id, kind, code, location_id) VALUES ($1, $2, 'PALET', $3, $4)", [A.tenantId, pal, `H-${rnd()}`, A.rootLocationId]);
      await q("INSERT INTO public.handling_units (tenant_id, id, kind, code) VALUES ($1, $2, 'KOLI', $3)", [A.tenantId, koli, `H-${rnd()}`]);
      await q("UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [koli, pal]);
      await q("UPDATE public.handling_units SET parent_id = NULL, status = 'CLOSED' WHERE id = $1", [koli]);
      await q("UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [koli, A.handlingUnitId]);
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("başka tenant'ın üst taşıma birimi / lokasyonu bileşik FK ile reddedilir; tür ve durum kümeleri CHECK'li", async () => {
    expectFail(
      await one(A.tenantId, "INSERT INTO public.handling_units (tenant_id, id, kind, code, parent_id) VALUES ($1, $2, 'KOLI', $3, $4)", [A.tenantId, randomUUID(), `H-${rnd()}`, B.handlingUnitId]),
      FK_VIOLATION,
    );
    expectFail(
      await one(A.tenantId, "INSERT INTO public.handling_units (tenant_id, id, kind, code, location_id) VALUES ($1, $2, 'KOLI', $3, $4)", [A.tenantId, randomUUID(), `H-${rnd()}`, B.rootLocationId]),
      FK_VIOLATION,
    );
    expectFail(await one(A.tenantId, "INSERT INTO public.handling_units (tenant_id, id, kind, code) VALUES ($1, $2, 'SEPET', $3)", [A.tenantId, randomUUID(), `H-${rnd()}`]), CHECK_VIOLATION);
    expectFail(
      await one(A.tenantId, "INSERT INTO public.handling_units (tenant_id, id, kind, code, status) VALUES ($1, $2, 'KOLI', $3, 'LOST')", [A.tenantId, randomUUID(), `H-${rnd()}`]),
      CHECK_VIOLATION,
    );
    expectFail(await one(A.tenantId, "INSERT INTO public.handling_units (tenant_id, id, kind, code) VALUES ($1, $2, 'KOLI', 'P1')", [A.tenantId, randomUUID()]), UNIQUE_VIOLATION);
  });

  it("eşzamanlı iki çapraz iç içe koyma: en çok biri commit olur, döngü kalıcılaşmaz (kilitli ata taraması)", async () => {
    const x = await mkHu(A.tenantId, `CC-${rnd()}`);
    const y = await mkHu(A.tenantId, `CC-${rnd()}`);
    const nest = async (c: pg.Client, child: string, parent: string): Promise<{ ok: boolean; code?: string }> => {
      await c.query("BEGIN");
      try {
        await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
        await c.query("UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [child, parent]);
        await c.query("COMMIT");
        return { ok: true };
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        return { ok: false, code: (e as { code?: string }).code };
      }
    };
    for (let i = 0; i < 8; i++) {
      await admin.query("BEGIN");
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      await admin.query("UPDATE public.handling_units SET parent_id = NULL WHERE id = ANY($1::uuid[])", [[x, y]]);
      await admin.query("COMMIT");
      const [r1, r2] = await Promise.all([nest(app, x, y), nest(app2, y, x)]);
      expect([r1, r2].filter((r) => r.ok), JSON.stringify([r1, r2])).toHaveLength(1);
      for (const r of [r1, r2]) if (!r.ok) expect([CHECK_VIOLATION, DEADLOCK]).toContain(r.code);
      await admin.query("BEGIN");
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      const rows = await admin.query<{ id: string; parent_id: string | null }>("SELECT id, parent_id FROM public.handling_units WHERE id = ANY($1::uuid[])", [[x, y]]);
      await admin.query("COMMIT");
      const px = rows.rows.find((r) => r.id === x)?.parent_id;
      const py = rows.rows.find((r) => r.id === y)?.parent_id;
      expect(px === y && py === x, "döngü kalıcılaştı").toBe(false);
      expect((px === y ? 1 : 0) + (py === x ? 1 : 0)).toBe(1);
    }
  }, 60_000);
});

describe("T-204 silme yasağı, yetkiler ve RLS", () => {
  it("wms_app DELETE: item_barcodes dışındaki tüm yeni tablolarda yetki hatası; item_barcodes silinebilir", async () => {
    for (const t of NEW_TABLES.filter((x) => x !== "item_barcodes")) {
      expectFail(await one(A.tenantId, `DELETE FROM public.${t}`), INSUFFICIENT_PRIVILEGE, t);
    }
    const del = await inTenant(A.tenantId, async (q) => {
      const d = await q("DELETE FROM public.item_barcodes");
      expect(d.rowCount).toBeGreaterThan(0);
    });
    expect(del.ok, JSON.stringify(del)).toBe(true);
  });

  it("değişmez alanlar: items.base_unit_id/tracking_mode/quantity_scale, lot/seri kimliği, taşıma birimi kodu UPDATE yetkisi yok", async () => {
    for (const [t, set, where] of [
      ["items", "base_unit_id = base_unit_id", `id = '${A.itemId}'`],
      ["items", "tracking_mode = 'NONE'", `id = '${A.itemId}'`],
      ["items", "quantity_scale = 3", `id = '${A.itemId}'`],
      ["lots", "lot_code = 'ZZ'", `id = '${A.lotId}'`],
      ["serials", "serial_no = 'ZZ'", `id = '${A.serialId}'`],
      ["handling_units", "code = 'ZZ'", `id = '${A.handlingUnitId}'`],
      ["units", "code = 'ZZ'", `id = '${A.unitId}'`],
    ] as const) {
      expectFail(await one(A.tenantId, `UPDATE public.${t} SET ${set} WHERE ${where}`), INSUFFICIENT_PRIVILEGE, `${t}.${set}`);
    }
  });

  it("arşiv: status ARCHIVED ⇔ archived_at dolu (units, items)", async () => {
    expectFail(await one(A.tenantId, "UPDATE public.items SET status = 'ARCHIVED' WHERE id = $1", [A.itemId]), CHECK_VIOLATION);
    const good = await one(A.tenantId, "UPDATE public.items SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [A.itemId]);
    expect(good.ok, JSON.stringify(good)).toBe(true);
    const unit = await one(A.tenantId, "UPDATE public.units SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [A.boxUnitId]);
    expect(unit.ok, JSON.stringify(unit)).toBe(true);
  });

  it("wms_ops yeni tablolarda hiçbir yetki taşımaz", async () => {
    const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [OPS]);
    if (role.rowCount === 0) return;
    for (const t of NEW_TABLES) {
      const r = await admin.query<{ p: boolean }>("SELECT has_any_column_privilege($1, ('public.' || $2)::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') AS p", [OPS, t]);
      expect(r.rows[0]?.p, t).toBe(false);
      const d = await admin.query<{ p: boolean }>("SELECT has_table_privilege($1, ('public.' || $2)::regclass, 'DELETE, TRUNCATE') AS p", [OPS, t]);
      expect(d.rows[0]?.p, t).toBe(false);
    }
  });

  it("sekiz tabloda ENABLE + FORCE RLS, tenant politikası USING + WITH CHECK, PUBLIC yetkisi yok, tenant_id NOT NULL, (tenant_id, id) benzersiz", async () => {
    for (const t of NEW_TABLES) {
      const c = await admin.query(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS pol,
                (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid LIMIT 1) AS qual,
                (SELECT pg_get_expr(p.polwithcheck, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid LIMIT 1) AS chk,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0) AS pub,
                (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id') AS nullable,
                EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'u' AND pg_get_constraintdef(k.oid) = 'UNIQUE (tenant_id, id)') AS uq
           FROM pg_class c WHERE c.oid = ('public.' || $1)::regclass`,
        [t],
      );
      const row = c.rows[0] as { rls: boolean; forced: boolean; pol: string; qual: string | null; chk: string | null; pub: boolean; nullable: string; uq: boolean };
      expect(row.pub, t).toBe(false);
      expect(row.rls, t).toBe(true);
      expect(row.forced, t).toBe(true);
      expect(row.pol, t).toBe("1");
      expect(row.qual, t).toContain("app.current_tenant_id");
      expect(row.chk, t).toContain("app.current_tenant_id");
      expect(row.nullable, t).toBe("NO");
      expect(row.uq, t).toBe(true);
    }
  });

  it("tüm FK'ler NO ACTION ve (tenant_id, …) bileşik (tenants'a tekil FK hariç)", async () => {
    const r = await admin.query<{ relname: string; conname: string; confdeltype: string; def: string }>(
      `SELECT c.relname, k.conname, k.confdeltype, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`,
      [[...NEW_TABLES]],
    );
    expect(r.rows.length).toBeGreaterThan(NEW_TABLES.length);
    for (const f of r.rows) {
      expect(f.confdeltype, f.conname).toBe("a");
      if (!f.def.includes("REFERENCES tenants(id)")) expect(f.def, f.conname).toMatch(/^FOREIGN KEY \(tenant_id, /);
    }
  });

  it("çapraz tenant: A bağlamı B'nin katalog satırlarını görmez, yazamaz; bağlamsız 0 satır", async () => {
    for (const t of NEW_TABLES) {
      const seen = await one(A.tenantId, `SELECT count(*)::int AS n FROM public.${t} WHERE tenant_id = $1`, [B.tenantId]);
      expect(seen.ok && seen.rows[0]?.n, t).toBe(0);
      const none = await app.query(`SELECT count(*)::int AS n FROM public.${t}`);
      expect(none.rows[0]?.n, t).toBe(0);
    }
    const w = await one(A.tenantId, "INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1, $2, 'ZZ', 'zz')", [B.tenantId, randomUUID()]);
    expectFail(w, INSUFFICIENT_PRIVILEGE);
    if (!w.ok) expect(w.message).toMatch(/row-level security/);
    const upd = await one(A.tenantId, "UPDATE public.items SET name = 'hack' WHERE tenant_id = $1", [B.tenantId]);
    expect(upd.ok && upd.rowCount).toBe(0);
  });
});

describe("T-204 migration 0011 ileri/geri/ileri (geçici veritabanı)", () => {
  const dbName = `wms_cat_${randomBytes(5).toString("hex")}`;
  const urlFor = (db: string): string => {
    const u = new URL(env.databaseUrlDirect);
    u.pathname = `/${db}`;
    return u.toString();
  };
  let scratchUrl = "";
  let adminUrl = "";

  beforeAll(async () => {
    adminUrl = urlFor("postgres");
    const a = await connect(adminUrl);
    await a.query(`CREATE DATABASE ${dbName}`);
    scratchUrl = urlFor(dbName);
    await migrateUp({ url: scratchUrl });
  }, 120_000);

  afterAll(async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    a.on("error", () => undefined);
    try {
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } catch {
      /* temizlik en iyi çaba; veritabanı adı rastgele */
    } finally {
      await a.end().catch(() => undefined);
    }
  }, 60_000);

  const present = async (c: pg.Client): Promise<string[]> => {
    const r = await c.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY 1", [[...NEW_TABLES]]);
    return r.rows.map((x) => x.t);
  };
  const fnCount = async (c: pg.Client): Promise<number> =>
    (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('handling_units_reject_cycle', 'unit_conversions_reject_base_unit')")).rows[0]?.n ?? -1;

  it("veri varken ci dışı ortamda geri alma reddedilir; ci'da geri alınır, tekrar ileri aynı şekli kurar", async () => {
    const c = new pg.Client({ connectionString: scratchUrl });
    c.on("error", () => undefined);
    await c.connect();
    try {
      expect(await present(c)).toEqual([...NEW_TABLES].sort());
      expect(await fnCount(c)).toBe(2);
      const t = randomUUID();
      await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'cat')", [t, `cat-${rnd()}`]);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [t]);
      await c.query("INSERT INTO public.units (tenant_id, code, name) VALUES ($1, 'ADET', 'Adet')", [t]);
      await c.query("COMMIT");
      await c.end();

      await expect(migrateDown({ url: scratchUrl, to: "0010", wmsEnv: "staging" })).rejects.toThrow(/veri kaybettiren geri alma/);
      const down = await migrateDown({ url: scratchUrl, to: "0010", wmsEnv: "ci" });
      expect(down.reverted).toContain("0011");
      const c2 = new pg.Client({ connectionString: scratchUrl });
      c2.on("error", () => undefined);
      await c2.connect();
      try {
        expect(await present(c2)).toEqual([]);
        expect(await fnCount(c2)).toBe(0);
      } finally {
        await c2.end();
      }
      const up = await migrateUp({ url: scratchUrl });
      expect(up.applied).toContain("0011");
      expect((await migrateUp({ url: scratchUrl })).applied).toEqual([]);
      const c3 = new pg.Client({ connectionString: scratchUrl });
      c3.on("error", () => undefined);
      await c3.connect();
      try {
        expect(await present(c3)).toEqual([...NEW_TABLES].sort());
        expect(await fnCount(c3)).toBe(2);
        const rls = await c3.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity", [[...NEW_TABLES]]);
        expect(rls.rows[0]?.n).toBe(NEW_TABLES.length);
      } finally {
        await c3.end();
      }
    } finally {
      await c.end().catch(() => undefined);
    }
  }, 120_000);
});
