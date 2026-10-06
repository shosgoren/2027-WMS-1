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

/** Yeni (takipsiz ürün, çocuk lokasyon) boyutu; durum ile benzersizleştirilir. */
async function newDim(q: Q, w: TenantWorld, status = "AVAILABLE"): Promise<string> {
  const id = randomUUID();
  await q(insDim, [w.tenantId, id, w.itemNoneId, w.childLocationId, null, null, status]);
  return id;
}
async function mkItem(q: Q, w: TenantWorld, mode: string): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode) VALUES ($1, $2, $3, 't232', $4, $5)", [w.tenantId, id, `X${rnd()}`, w.unitId, mode]);
  return id;
}
async function mkLot(q: Q, w: TenantWorld, item: string): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.lots (tenant_id, id, item_id, lot_code) VALUES ($1, $2, $3, $4)", [w.tenantId, id, item, `L${rnd()}`]);
  return id;
}
async function mkSerial(q: Q, w: TenantWorld, item: string, lot: string | null): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.serials (tenant_id, id, item_id, serial_no, lot_id) VALUES ($1, $2, $3, $4, $5)", [w.tenantId, id, item, `S${rnd()}`, lot]);
  return id;
}
const ledger = (q: Q, w: TenantWorld, dim: string, qty: number): Promise<pg.QueryResult> => q(insLedger, [w.tenantId, w.documentId, w.documentLineNoneId, dim, qty]);

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
    for (const c of ["stock_dimension_id", "quantity", "status"]) expect(await col("reservations", c, "UPDATE"), c).toBe(true);
    for (const c of ["tenant_id", "id", "document_line_id", "created_at", "expires_at", "closed_at", "item_id"]) expect(await col("reservations", c, "UPDATE"), c).toBe(false);
    expect(await col("reservations", "closed_at", "INSERT")).toBe(false);
    expect(await col("reservations", "item_id", "INSERT")).toBe(false);
    expect(await col("stock_ledger", "item_id", "INSERT")).toBe(false);
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
      await q(insDim, [A.tenantId, randomUUID(), A.itemNoneId, A.rootLocationId, null, null, "AVAILABLE"]);
    });
    expectFail(dupe, UNIQUE_VIOLATION, "NULL'lu boyut kopyası");
    expectFail(await asApp(A.tenantId, (q) => newDim(q, A, "FOO")), CHECK_VIOLATION, "durum");
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.stock_dimensions SET stock_status = 'BLOCKED'")), INSUFFICIENT_PRIVILEGE, "app UPDATE");
    expectFail(await asApp(A.tenantId, (q) => q("DELETE FROM public.stock_dimensions")), INSUFFICIENT_PRIVILEGE, "app DELETE");
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.stock_dimensions SET created_at = now()")), INSUFFICIENT_PRIVILEGE, "sahip UPDATE");
    expectFail(await asAdmin(A.tenantId, (q) => q("DELETE FROM public.stock_dimensions WHERE tenant_id = $1", [A.tenantId])), INSUFFICIENT_PRIVILEGE, "sahip DELETE");
  });

  it("M-3: başka ürünün lotu/serisiyle boyut → FK reddi; B'nin ürünü/lokasyonuyla A boyutu → FK reddi; boyut UPDATE yok", async () => {
    // lotId/serialId A.itemId'nin; boyut başka (uygun takip modlu) ürünle → (tenant_id, item_id, lot_id|serial_id) FK'leri.
    expectFail(
      await asApp(A.tenantId, async (q) => q(insDim, [A.tenantId, randomUUID(), await mkItem(q, A, "LOT"), A.rootLocationId, A.lotId, null, "AVAILABLE"])),
      FK_VIOLATION,
      "başka ürünün lotu",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => q(insDim, [A.tenantId, randomUUID(), await mkItem(q, A, "SERIAL"), A.rootLocationId, null, A.serialId, "AVAILABLE"])),
      FK_VIOLATION,
      "başka ürünün serisi",
    );
    expectFail(await asApp(A.tenantId, (q) => q(insDim, [A.tenantId, randomUUID(), B.itemNoneId, A.rootLocationId, null, null, "AVAILABLE"])), FK_VIOLATION, "B ürünü");
    expectFail(await asApp(A.tenantId, (q) => q(insDim, [A.tenantId, randomUUID(), A.itemNoneId, B.rootLocationId, null, null, "AVAILABLE"])), FK_VIOLATION, "B lokasyonu");
    expectFail(await asApp(A.tenantId, (q) => newDim(q, A).then(() => q("UPDATE public.stock_dimensions SET handling_unit_id = $1", [B.handlingUnitId]))), INSUFFICIENT_PRIVILEGE, "UPDATE yok");
  });

  it("MAJOR-2/MINOR-6: boyut takip moduyla tutarlı olmalı (NONE/LOT/SERIAL/LOT_AND_SERIAL); serinin lotu boyutun lotuyla eşit", async () => {
    type Case = { mode: string; lot: boolean; serial: boolean; ok: boolean };
    const cases: Case[] = [
      { mode: "NONE", lot: false, serial: false, ok: true },
      { mode: "NONE", lot: true, serial: false, ok: false },
      { mode: "NONE", lot: false, serial: true, ok: false },
      { mode: "LOT", lot: true, serial: false, ok: true },
      { mode: "LOT", lot: false, serial: false, ok: false },
      { mode: "LOT", lot: true, serial: true, ok: false },
      { mode: "SERIAL", lot: false, serial: true, ok: true },
      { mode: "SERIAL", lot: false, serial: false, ok: false },
      { mode: "SERIAL", lot: true, serial: true, ok: false },
      { mode: "LOT_AND_SERIAL", lot: true, serial: true, ok: true },
      { mode: "LOT_AND_SERIAL", lot: true, serial: false, ok: false },
      { mode: "LOT_AND_SERIAL", lot: false, serial: true, ok: false },
      { mode: "LOT_AND_SERIAL", lot: false, serial: false, ok: false },
    ];
    for (const c of cases) {
      const r = await asApp(A.tenantId, async (q) => {
        const item = await mkItem(q, A, c.mode);
        const lot = c.lot ? await mkLot(q, A, item) : null;
        // SERIAL ürünün serisi lotsuzdur; LOT_AND_SERIAL serisi boyutun lotunu taşır.
        const serial = c.serial ? await mkSerial(q, A, item, c.mode === "LOT_AND_SERIAL" ? lot : null) : null;
        await q(insDim, [A.tenantId, randomUUID(), item, A.rootLocationId, lot, serial, "AVAILABLE"]);
      });
      const label = `${c.mode} lot=${c.lot} serial=${c.serial}`;
      if (c.ok) expectOk(r, label);
      else expectFail(r, CHECK_VIOLATION, label, "TRACKING_VIOLATION");
    }
    // MINOR-6: serinin lotu ≠ boyutun lotu → ret (LOT_AND_SERIAL, iki farklı lot).
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const item = await mkItem(q, A, "LOT_AND_SERIAL");
        const lot1 = await mkLot(q, A, item);
        const lot2 = await mkLot(q, A, item);
        const serial = await mkSerial(q, A, item, lot1);
        await q(insDim, [A.tenantId, randomUUID(), item, A.rootLocationId, lot2, serial, "AVAILABLE"]);
      }),
      CHECK_VIOLATION,
      "seri lotu ≠ boyut lotu",
      "TRACKING_VIOLATION",
    );
  });

  it("MAJOR-1: belge satırının ürünü boyutun ürünüyle eşit olmalı (defter INSERT, rezervasyon INSERT ve boyut taşıma)", async () => {
    // X ürünlü (itemId) satır + NONE ürünlü boyut → defter reddi; sunucu item_id'yi boyuttan türetir, istemci veremez.
    expectFail(await asApp(A.tenantId, (q) => q(insLedger, [A.tenantId, A.documentId, A.documentLineId, A.dimensionId, 1])), FK_VIOLATION, "defter: satır ürünü ≠ boyut ürünü");
    expectFail(await asApp(A.tenantId, (q) => q(insRes, [A.tenantId, A.dimensionId, A.documentLineId, 1])), FK_VIOLATION, "rezervasyon: satır ürünü ≠ boyut ürünü");
    // Rezervasyonun boyutunu başka ürüne taşımak: UPDATE'te item_id yeniden türetilir, satır FK'si reddeder.
    expectFail(
      await asApp(A.tenantId, (q) => q("UPDATE public.reservations SET stock_dimension_id = $2 WHERE id = $1", [A.reservationId, A.serialDimensionId])),
      FK_VIOLATION,
      "rezervasyon başka ürüne taşındı",
    );
    // Aynı ürünün başka boyutuna taşıma serbest (denetim bakiyelerde): onay.
    expectOk(
      await asApp(
        A.tenantId,
        async (q) => {
          const d2 = await newDim(q, A, "DAMAGED");
          await q("UPDATE public.reservations SET stock_dimension_id = $2 WHERE id = $1", [A.reservationId, d2]);
        },
        "rollback",
      ),
      "aynı ürün, başka boyut",
    );
    // Kayıt, sunucunun türettiği item_id'yi taşır.
    const r = await asApp(A.tenantId, (q) => q("SELECT item_id FROM public.stock_ledger WHERE id = $1", [A.ledgerId]));
    expectOk(r);
    if (r.ok) expect((r.rows[0] as { item_id: string }).item_id).toBe(A.itemNoneId);
    // Bağlı satırın ürünü değiştirilemez (FK; DRAFT satır UPDATE'i de reddedilir).
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.document_lines SET item_id = $2 WHERE id = $1", [A.documentLineNoneId, A.itemId])), FK_VIOLATION, "bağlı satırın ürünü");
  });

  it("(f) A'nın bakiye/defter/rezervasyonu B'nin boyut kimliğine → FK reddi; B'nin belge satırına → FK reddi", async () => {
    expectFail(await asApp(A.tenantId, (q) => q(insBal, [A.tenantId, B.dimensionId, 0, 0])), FK_VIOLATION, "bakiye");
    expectFail(await asApp(A.tenantId, (q) => ledger(q, A, B.dimensionId, 1)), FK_VIOLATION, "defter");
    expectFail(await asApp(A.tenantId, (q) => q(insRes, [A.tenantId, B.dimensionId, A.documentLineId, 1])), FK_VIOLATION, "rezervasyon");
    expectFail(await asApp(A.tenantId, (q) => q(insLedger, [A.tenantId, B.documentId, B.documentLineId, A.dimensionId, 1])), FK_VIOLATION, "B belge satırı (defter)");
    expectFail(await asApp(A.tenantId, (q) => q(insRes, [A.tenantId, A.dimensionId, B.documentLineId, 1])), FK_VIOLATION, "B belge satırı (rezervasyon)");
    // Satır kendi tenant'ında olsa bile başka belgenin satırıyla eşleşmeyen document_id → bileşik FK.
    expectFail(await asApp(A.tenantId, (q) => q(insLedger, [A.tenantId, randomUUID(), A.documentLineNoneId, A.dimensionId, 1])), FK_VIOLATION, "yanlış document_id");
    // RLS WITH CHECK: A bağlamında B tenant_id'li satır.
    expectFail(await asApp(A.tenantId, (q) => q(insLedger, [B.tenantId, B.documentId, B.documentLineId, B.dimensionId, 1])), INSUFFICIENT_PRIVILEGE, "WITH CHECK");
  });

  it("I-05: negatif miktar, rezerve > miktar, sıfır defter satırı, boş gerekçe reddi", async () => {
    expectFail(await asApp(A.tenantId, async (q) => q(insBal, [A.tenantId, await newDim(q, A), -1, 0])), CHECK_VIOLATION, "negatif");
    expectFail(await asApp(A.tenantId, async (q) => q(insBal, [A.tenantId, await newDim(q, A), 1, 2])), CHECK_VIOLATION, "rezerve>miktar");
    expectFail(await asApp(A.tenantId, async (q) => ledger(q, A, await newDim(q, A), 0)), CHECK_VIOLATION, "sıfır defter");
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.stock_balances SET quantity = quantity - 11 WHERE stock_dimension_id = $1", [A.dimensionId])), CHECK_VIOLATION, "bakiye eksiye");
    expectFail(
      await asApp(A.tenantId, (q) => q(insLedger.replace("'t232'", "'  '"), [A.tenantId, A.documentId, A.documentLineNoneId, A.dimensionId, 1])),
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
      { tgname: "stock_ledger_set_item_id", tgenabled: "A" },
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
          [A.tenantId, A.documentId, A.documentLineNoneId, A.dimensionId],
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
          [A.tenantId, A.documentId, A.documentLineNoneId, A.dimensionId],
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
          [A.tenantId, A.documentId, A.documentLineNoneId, dim],
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
    expectFail(await asApp(A.tenantId, (q) => q(insRes, [A.tenantId, A.dimensionId, A.documentLineNoneId, 2]), "commit"), CHECK_VIOLATION, "yalnız rezervasyon", MISMATCH);
    expectOk(
      await asApp(
        A.tenantId,
        async (q) => {
          await q(insRes, [A.tenantId, A.dimensionId, A.documentLineNoneId, 2]);
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
          await q("UPDATE public.reservations SET status = 'CONSUMED' WHERE id = $1", [A.reservationId]);
          await q("UPDATE public.stock_balances SET reserved_quantity = 0 WHERE stock_dimension_id = $1", [A.dimensionId]);
        },
        "check",
      ),
      "tüketim",
    );
    expectFail(
      await asApp(A.tenantId, async (q) => {
        await q("UPDATE public.reservations SET status = 'RELEASED' WHERE id = $1", [A.reservationId]);
        await q("UPDATE public.reservations SET quantity = 1 WHERE id = $1", [A.reservationId]);
      }),
      CHECK_VIOLATION,
      "sonlanmış rezervasyon",
    );
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.reservations SET document_line_id = $2 WHERE id = $1", [A.reservationId, A.documentLineId])), INSUFFICIENT_PRIVILEGE, "document_line_id UPDATE");
    expectFail(await asApp(A.tenantId, (q) => q("INSERT INTO public.reservations (tenant_id, id, stock_dimension_id, document_line_id, quantity, status) VALUES ($1, gen_random_uuid(), $2, $3, 1, 'CONSUMED')", [A.tenantId, A.dimensionId, A.documentLineNoneId])), CHECK_VIOLATION, "CONSUMED INSERT");
  });

  it("(e) uyumlu defter + bakiye + rezervasyon → gerçek COMMIT ile kabul; sonradan bozmak reddedilir", async () => {
    let dim = "";
    const r = await asApp(
      A.tenantId,
      async (q) => {
        dim = await newDim(q, A, "BLOCKED");
        await ledger(q, A, dim, 7);
        await q(insBal, [A.tenantId, dim, 7, 2]);
        await q(insRes, [A.tenantId, dim, A.documentLineNoneId, 2]);
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

describe("T-232 rezervasyon sunucu alanları (MINOR-4)", () => {
  it("closed_at istemciden gelmez: UPDATE yetkisi yok; terminal geçişte sunucu now() yazar; expires_at > created_at", async () => {
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.reservations SET closed_at = '2000-01-01' WHERE id = $1", [A.reservationId])), INSUFFICIENT_PRIVILEGE, "closed_at UPDATE");
    expectFail(
      await asApp(A.tenantId, (q) => q("INSERT INTO public.reservations (tenant_id, id, stock_dimension_id, document_line_id, quantity, closed_at) VALUES ($1, gen_random_uuid(), $2, $3, 1, now())", [A.tenantId, A.dimensionId, A.documentLineNoneId])),
      INSUFFICIENT_PRIVILEGE,
      "closed_at INSERT",
    );
    // Sahip istemci değeri verse bile tetikleyici ezer (terminal geçiş → now()).
    const r = await asAdmin(
      A.tenantId,
      async (q) => {
        await q("UPDATE public.reservations SET status = 'CONSUMED', closed_at = '2000-01-01' WHERE id = $1", [A.reservationId]);
        await q("UPDATE public.stock_balances SET reserved_quantity = 0 WHERE stock_dimension_id = $1", [A.dimensionId]);
        return q("SELECT (closed_at = now()) AS server_now, status FROM public.reservations WHERE id = $1", [A.reservationId]);
      },
      "check",
    );
    expectOk(r);
    if (r.ok) expect(r.rows[0]).toEqual({ server_now: true, status: "CONSUMED" });
    const bad = (expr: string) =>
      asApp(A.tenantId, async (q) => {
        const d = await newDim(q, A, "QUARANTINE");
        await q(`INSERT INTO public.reservations (tenant_id, id, stock_dimension_id, document_line_id, quantity, expires_at) VALUES ($1, gen_random_uuid(), $2, $3, 1, ${expr})`, [A.tenantId, d, A.documentLineNoneId]);
      });
    expectFail(await bad("now() - interval '1 hour'"), CHECK_VIOLATION, "geçmiş expires_at");
    expectFail(await bad("now()"), CHECK_VIOLATION, "expires_at = created_at");
    expectOk(await bad("now() + interval '1 hour'"), "gelecek expires_at");
  });
});

describe("T-232 eşzamanlılık (MINOR-7)", () => {
  async function committedDim(status: string): Promise<string> {
    const dim = randomUUID();
    // (takipsiz ürün, kök lokasyon, durum, sahip) kombinasyonu bu test kümesine ayrılmıştır (diğer testler sahipsiz boyut kullanır).
    const r = await asApp(
      A.tenantId,
      async (q) => {
        await q("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, stock_status, inventory_owner_id) VALUES ($1, $2, $3, $4, $5, $6)", [
          A.tenantId,
          dim,
          A.itemNoneId,
          A.rootLocationId,
          status,
          A.ownerId,
        ]);
        await q(insBal, [A.tenantId, dim, 0, 0]);
      },
      "commit",
    );
    expectOk(r, "boyut kurulumu");
    return dim;
  }
  const begin = async (c: pg.Client, level = "READ COMMITTED"): Promise<void> => {
    await c.query(`BEGIN ISOLATION LEVEL ${level}`);
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
  };
  const total = async (dim: string): Promise<{ q: string; l: string }> => {
    const r = await asApp(A.tenantId, (q) =>
      q(
        `SELECT b.quantity::text AS q, (SELECT sum(quantity)::text FROM public.stock_ledger WHERE stock_dimension_id = b.stock_dimension_id) AS l
           FROM public.stock_balances b WHERE b.stock_dimension_id = $1`,
        [dim],
      ),
    );
    expectOk(r);
    return r.ok ? (r.rows[0] as { q: string; l: string }) : { q: "?", l: "?" };
  };

  it("iki istemci aynı boyuta eşzamanlı +5/+3 (FOR UPDATE ile serileşir): bakiye = defter = 8", async () => {
    const dim = await committedDim("AVAILABLE");
    const c1 = await connect(env.databaseUrl);
    const c2 = await connect(env.databaseUrl);
    const post = async (c: pg.Client, n: number): Promise<void> => {
      await c.query("SELECT quantity FROM public.stock_balances WHERE stock_dimension_id = $1 FOR UPDATE", [dim]);
      await c.query(insLedger, [A.tenantId, A.documentId, A.documentLineNoneId, dim, n]);
      await c.query("UPDATE public.stock_balances SET quantity = quantity + $2, version = version + 1 WHERE stock_dimension_id = $1", [dim, n]);
    };
    await begin(c1);
    await begin(c2);
    await post(c1, 5);
    const second = post(c2, 3); // c1 commit'e kadar kilitte bekler
    await new Promise((r) => setTimeout(r, 200));
    await c1.query("COMMIT");
    await second;
    await c2.query("COMMIT");
    expect(await total(dim)).toEqual({ q: "8.000000", l: "8.000000" });
  });

  it("bayat değerle SET quantity = <sabit> yapan kayıp güncelleme commit'te reddedilir", async () => {
    const dim = await committedDim("QUARANTINE");
    const c1 = await connect(env.databaseUrl);
    const c2 = await connect(env.databaseUrl);
    await begin(c1);
    await begin(c2);
    const stale1 = Number(((await c1.query("SELECT quantity::text AS q FROM public.stock_balances WHERE stock_dimension_id = $1", [dim])).rows[0] as { q: string }).q);
    const stale2 = Number(((await c2.query("SELECT quantity::text AS q FROM public.stock_balances WHERE stock_dimension_id = $1", [dim])).rows[0] as { q: string }).q);
    await c1.query(insLedger, [A.tenantId, A.documentId, A.documentLineNoneId, dim, 5]);
    await c1.query("UPDATE public.stock_balances SET quantity = $2 WHERE stock_dimension_id = $1", [dim, stale1 + 5]);
    await c1.query("COMMIT");
    await c2.query(insLedger, [A.tenantId, A.documentId, A.documentLineNoneId, dim, 3]);
    await c2.query("UPDATE public.stock_balances SET quantity = $2 WHERE stock_dimension_id = $1", [dim, stale2 + 3]); // 3 (bayat) ≠ 5 + 3
    await expect(c2.query("COMMIT")).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringContaining(MISMATCH) });
    await c2.query("ROLLBACK").catch(() => undefined);
    expect(await total(dim)).toEqual({ q: "5.000000", l: "5.000000" });
  });

  it("REPEATABLE READ: anlık görüntüden sonra başkası commit ettiyse aynı satırı güncellemek serileştirme hatası verir (40001)", async () => {
    const dim = await committedDim("DAMAGED");
    const c1 = await connect(env.databaseUrl);
    const c2 = await connect(env.databaseUrl);
    await begin(c1, "REPEATABLE READ");
    await c1.query("SELECT quantity FROM public.stock_balances WHERE stock_dimension_id = $1", [dim]); // anlık görüntü sabitlenir
    await begin(c2);
    await c2.query(insLedger, [A.tenantId, A.documentId, A.documentLineNoneId, dim, 5]);
    await c2.query("UPDATE public.stock_balances SET quantity = quantity + 5 WHERE stock_dimension_id = $1", [dim]);
    await c2.query("COMMIT");
    await expect(c1.query("UPDATE public.stock_balances SET quantity = quantity + 3 WHERE stock_dimension_id = $1", [dim])).rejects.toMatchObject({ code: "40001" });
    await c1.query("ROLLBACK").catch(() => undefined);
    expect(await total(dim)).toEqual({ q: "5.000000", l: "5.000000" });
  });
});

describe("T-232 sahip yolu: takip modu / seri lotu değişmezliği (MINOR-1)", () => {
  it("boyutu olan ürünün tracking_mode'u reddedilir; boyutu olmayan ürünün modu değişebilir; bağlam yoksa fail-closed", async () => {
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.items SET tracking_mode = 'LOT' WHERE id = $1", [A.itemNoneId])), CHECK_VIOLATION, "boyutlu ürün", "TRACKING_VIOLATION");
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.items SET tracking_mode = 'NONE' WHERE id = $1", [A.itemId])), CHECK_VIOLATION, "seri boyutlu ürün", "TRACKING_VIOLATION");
    expectOk(
      await asAdmin(A.tenantId, async (q) => {
        const item = await mkItem(q, A, "NONE");
        await q("UPDATE public.items SET tracking_mode = 'LOT' WHERE id = $1", [item]);
        return q("SELECT tracking_mode FROM public.items WHERE id = $1", [item]);
      }),
      "boyutsuz ürün",
    );
    // Aynı değere set edilmesi (no-op) engellenmez.
    expectOk(await asAdmin(A.tenantId, (q) => q("UPDATE public.items SET tracking_mode = tracking_mode WHERE id = $1", [A.itemNoneId])), "no-op");
    // Bağlam yok/başka tenant: RLS satırları gizleyebileceğinden denetim fail-closed reddeder.
    expectFail(await asAdmin(B.tenantId, (q) => q("UPDATE public.items SET tracking_mode = 'LOT' WHERE id = $1", [A.itemNoneId])), CHECK_VIOLATION, "yanlış bağlam", CTX_MISMATCH);
    // wms_app zaten yetkisiz.
    expectFail(await asApp(A.tenantId, (q) => q("UPDATE public.items SET tracking_mode = 'LOT' WHERE id = $1", [A.itemNoneId])), INSUFFICIENT_PRIVILEGE, "wms_app");
    // Replica modu da atlatmaz (ENABLE ALWAYS).
    expectFail(
      await asAdmin(A.tenantId, async (q) => {
        await q("SET LOCAL session_replication_role = replica");
        await q("UPDATE public.items SET tracking_mode = 'LOT' WHERE id = $1", [A.itemNoneId]);
      }),
      CHECK_VIOLATION,
      "replica",
      "TRACKING_VIOLATION",
    );
  });

  it("boyutta kullanılan serinin lot_id'si değiştirilemez; kullanılmayan serininki değişebilir", async () => {
    expectFail(await asAdmin(A.tenantId, (q) => q("UPDATE public.serials SET lot_id = NULL WHERE id = $1", [A.serialId])), CHECK_VIOLATION, "kullanılan seri", "TRACKING_VIOLATION");
    expectOk(
      await asAdmin(A.tenantId, async (q) => {
        const item = await mkItem(q, A, "LOT_AND_SERIAL");
        const lot = await mkLot(q, A, item);
        const serial = await mkSerial(q, A, item, null);
        await q("UPDATE public.serials SET lot_id = $2 WHERE id = $1", [serial, lot]);
      }),
      "kullanılmayan seri",
    );
    expectFail(await asAdmin(B.tenantId, (q) => q("UPDATE public.serials SET lot_id = NULL WHERE id = $1", [A.serialId])), CHECK_VIOLATION, "yanlış bağlam", CTX_MISMATCH);
  });
});

describe("T-232 bölünmüş yazım ve kilitsiz güncelleme eşzamanlılığı (MINOR-3)", () => {
  async function dimWithZeroBalance(status: string): Promise<string> {
    const dim = randomUUID();
    const r = await asApp(
      A.tenantId,
      async (q) => {
        await q("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, stock_status, inventory_owner_id, handling_unit_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
          A.tenantId,
          dim,
          A.itemNoneId,
          A.childLocationId,
          status,
          A.ownerId,
          A.handlingUnitId,
        ]);
        await q(insBal, [A.tenantId, dim, 0, 0]);
      },
      "commit",
    );
    expectOk(r, "boyut kurulumu");
    return dim;
  }
  const begin = async (c: pg.Client, level: string): Promise<void> => {
    await c.query(`BEGIN ISOLATION LEVEL ${level}`);
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
  };
  const totals = async (dim: string): Promise<{ q: string; l: string | null }> => {
    const r = await asApp(A.tenantId, (q) =>
      q(
        `SELECT b.quantity::text AS q, (SELECT sum(quantity)::text FROM public.stock_ledger WHERE stock_dimension_id = b.stock_dimension_id) AS l
           FROM public.stock_balances b WHERE b.stock_dimension_id = $1`,
        [dim],
      ),
    );
    expectOk(r);
    return r.ok ? (r.rows[0] as { q: string; l: string | null }) : { q: "?", l: "?" };
  };
  const settle = async (c: pg.Client): Promise<{ ok: boolean; code?: string; message?: string }> => {
    try {
      await c.query("COMMIT");
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      await c.query("ROLLBACK").catch(() => undefined);
      return { ok: false, code: err.code, message: err.message };
    }
  };

  for (const level of ["READ COMMITTED", "REPEATABLE READ"]) {
    it(`${level}: T1 yalnız defter, T2 yalnız bakiye, eşzamanlı commit → ikisi de denetimden düşer; sonuç değişmez`, async () => {
      const dim = await dimWithZeroBalance(level === "READ COMMITTED" ? "AVAILABLE" : "QUARANTINE");
      const c1 = await connect(env.databaseUrl);
      const c2 = await connect(env.databaseUrl);
      await begin(c1, level);
      await begin(c2, level);
      await c1.query(insLedger, [A.tenantId, A.documentId, A.documentLineNoneId, dim, 5]); // yalnız defter
      await c2.query("UPDATE public.stock_balances SET quantity = quantity + 5 WHERE stock_dimension_id = $1", [dim]); // yalnız bakiye
      const [r1, r2] = await Promise.all([settle(c1), settle(c2)]);
      expect(r1.ok, `T1 (yalnız defter) kabul edildi: ${JSON.stringify(r1)}`).toBe(false);
      expect(r2.ok, `T2 (yalnız bakiye) kabul edildi: ${JSON.stringify(r2)}`).toBe(false);
      expect(r1.code).toBe(CHECK_VIOLATION);
      expect(r2.code).toBe(CHECK_VIOLATION);
      expect(r1.message).toContain(MISMATCH);
      expect(r2.message).toContain(MISMATCH);
      expect(await totals(dim)).toEqual({ q: "0.000000", l: null });
    });
  }

  for (const level of ["READ COMMITTED", "REPEATABLE READ"]) {
    it(`${level}: FOR UPDATE'siz quantity = quantity + n ile iki eşzamanlı +n: toplam doğru ya da biri reddedilir; bakiye = defter`, async () => {
      const dim = await dimWithZeroBalance(level === "READ COMMITTED" ? "DAMAGED" : "BLOCKED");
      const c1 = await connect(env.databaseUrl);
      const c2 = await connect(env.databaseUrl);
      await begin(c1, level);
      await begin(c2, level);
      const post = async (c: pg.Client, n: number): Promise<{ ok: boolean; code?: string }> => {
        try {
          await c.query(insLedger, [A.tenantId, A.documentId, A.documentLineNoneId, dim, n]);
          await c.query("UPDATE public.stock_balances SET quantity = quantity + $2 WHERE stock_dimension_id = $1", [dim, n]);
          return { ok: true };
        } catch (e) {
          await c.query("ROLLBACK").catch(() => undefined);
          return { ok: false, code: (e as { code?: string }).code };
        }
      };
      const w1 = await post(c1, 5);
      const w2p = post(c2, 3); // aynı satır kilidinde c1'in commit'ini bekler
      await new Promise((r) => setTimeout(r, 200));
      const s1 = await settle(c1);
      const w2 = await w2p;
      const s2 = w2.ok ? await settle(c2) : { ok: false, code: w2.code };
      expect(w1.ok && s1.ok, "T1 tutarlı, kabul edilmeliydi").toBe(true);
      const t = await totals(dim);
      expect(t.q, "bakiye = defter").toBe(t.l);
      if (s2.ok) expect(t.q).toBe("8.000000");
      else {
        expect(t.q).toBe("5.000000");
        // REPEATABLE READ'de bayat anlık görüntü: serileştirme hatası; READ COMMITTED'da denetim reddi.
        expect(["40001", CHECK_VIOLATION]).toContain(s2.code);
      }
      if (level === "READ COMMITTED") expect(s2.ok, "READ COMMITTED'da kilitsiz +n doğru toplanmalı").toBe(true);
      else expect(s2.ok, "REPEATABLE READ'de ikinci yazım 40001 almalı").toBe(false);
    });
  }
});

describe("T-232 (i) 100 satırlık belge eşdeğeri commit süresi (ölçüm)", () => {
  it("tek transaction: 100 boyut + 100 defter + 100 bakiye; commit süresi raporlanır", async () => {
    const C = await seedWorld(admin, reg, "C");
    const tag = rnd();
    // LOT takipli ürün + 100 benzersiz lot + belge satırı migration rolüyle kurulur (fikstür); ölçüm wms_app ile.
    const perfItem = randomUUID();
    const perfLine = randomUUID();
    await admin.query("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode) VALUES ($1, $2, 'UPERF', 'perf', $3, 'LOT')", [C.tenantId, perfItem, C.unitId]);
    await admin.query(
      "INSERT INTO public.lots (tenant_id, id, item_id, lot_code) SELECT $1, gen_random_uuid(), $2, $3 || '-' || g FROM generate_series(1, 100) g",
      [C.tenantId, perfItem, tag],
    );
    await admin.query(
      `INSERT INTO public.document_lines (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id)
       VALUES ($1, $2, $3, 9, $4, $5, 1, 1, 1, $6)`,
      [C.tenantId, perfLine, C.documentId, perfItem, C.unitId, C.rootLocationId],
    );
    const r = await asApp(
      C.tenantId,
      async (q) => {
        await q(
          `INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id)
           SELECT $1, gen_random_uuid(), $2, $3, l.id FROM public.lots l WHERE l.tenant_id = $1 AND l.item_id = $2 AND l.lot_code LIKE $4`,
          [C.tenantId, perfItem, C.rootLocationId, `${tag}-%`],
        );
        await q(
          `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date)
           SELECT $1, gen_random_uuid(), $2, $3, d.id, 10, 't232', '2026-02-01' FROM public.stock_dimensions d WHERE d.tenant_id = $1 AND d.item_id = $4 AND d.lot_id IS NOT NULL`,
          [C.tenantId, C.documentId, perfLine, perfItem],
        );
        await q(
          `INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, reserved_quantity)
           SELECT $1, d.id, 10, 0 FROM public.stock_dimensions d WHERE d.tenant_id = $1 AND d.item_id = $2 AND d.lot_id IS NOT NULL`,
          [C.tenantId, perfItem],
        );
      },
      "commit",
    );
    expectOk(r, "100 satır commit");
    const n = await asApp(C.tenantId, (q) => q("SELECT count(*)::int AS n FROM public.stock_ledger l JOIN public.stock_dimensions d ON d.tenant_id = l.tenant_id AND d.id = l.stock_dimension_id WHERE l.tenant_id = $1 AND d.item_id = $2", [C.tenantId, perfItem]));
    if (n.ok) expect((n.rows[0] as { n: number }).n).toBe(100);
    if (r.ok) {
      console.info(`T232_COMMIT_100_LINES_MS=${r.ms.toFixed(1)}`);
      // Mutlak üst sınır değil, gevşek bir akıl sağlığı eşiği (ADR-017: stok kesinleştirme p95 hedefi 1 sn).
      expect(r.ms).toBeLessThan(5000);
    }
  }, 60_000);
});
