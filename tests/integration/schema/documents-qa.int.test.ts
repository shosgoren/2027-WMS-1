// katman: db — yalnızca DB katmanı (RLS/GRANT/FK/tetikleyici); API/dosya/cache/export bu kartın kapsamı değildir.
// Stok belgeleri şeması (0012) — BAĞIMSIZ doğrulama (T-209, qa-verifier). Uygulayıcı testlerine (documents-schema) dayanmaz;
// 0012 migration metni + ADR-017 §2/§5/§8/§10 + I-06/I-08/I-16'dan yeniden türetilmiş senaryolardır. Stok tabloları (defter,
// bakiye, boyut, rezervasyon) ve yazma koruması bu kartın kapsamı DEĞİLDİR (T-233).
//
// Roller: uygulama rolü wms_app (DATABASE_URL, PgBouncer transaction mode). Migration rolü (DATABASE_URL_DIRECT) fikstür ve "tablo
// sahibi/süper kullanıcı da bağlıdır" denemeleri içindir. Her deneme ROLLBACK ile biter; yalnızca beforeAll'daki POSTED belgeler
// kalıcıdır (fikstür temizliği tenant bazlıdır, session_replication_role=replica ile). Sentetik veri (G-09).
//
// Etiket politikası: @AC-04 yalnızca başka tenant'a referansın reddedilmesi gibi tenant-izolasyonu kanıtlarında; değişmezlik
// testleri AC-04 değildir ve etiketlenmez.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { APP_ROLE, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const INSUFFICIENT_PRIVILEGE = "42501";
const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const rnd = (): string => randomBytes(4).toString("hex");
const sha = (): string => createHash("sha256").update(randomBytes(16)).digest("hex");

const reg = newRegistry();
const clients: pg.Client[] = [];
let admin: pg.Client;
let app: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let tv: Record<string, string> = {};
/** A tenant'ının POSTED belgesi + satırları (beforeAll, kalıcı). */
let posted: { docId: string; line1: string; line2PartiallyReversed: string };

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

type Err = { code?: string; message?: string };
type Q = (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;
type Outcome = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string | undefined; message: string };
const fmt = (o: Outcome): string => (o.ok ? `ok rows=${o.rowCount}` : `error ${o.code ?? "?"}: ${o.message}`);

async function attempt(client: pg.Client, tenantId: string | null, work: (q: Q) => Promise<unknown>): Promise<Outcome> {
  await client.query("BEGIN");
  try {
    if (tenantId !== null) await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await client.query(sql, p);
      return last;
    });
    return { ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  } catch (e) {
    const err = e as Err;
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await client.query("ROLLBACK");
  }
}
const appOne = (tenantId: string | null, sql: string, p: unknown[] = []): Promise<Outcome> => attempt(app, tenantId, (q) => q(sql, p));
const ownerOne = (tenantId: string, sql: string, p: unknown[] = []): Promise<Outcome> => attempt(admin, tenantId, (q) => q(sql, p));

function expectRejected(o: Outcome, codes: string[], note: string, message?: RegExp): void {
  expect(o.ok, `${note}: reddedilmesi beklenirdi, gerçekleşen ${fmt(o)}`).toBe(false);
  if (!o.ok) {
    expect(codes, `${note}: beklenen ${codes.join("|")}, gerçekleşen ${fmt(o)}`).toContain(o.code);
    if (message !== undefined) expect(o.message, note).toMatch(message);
  }
}

const docInsert = `INSERT INTO public.documents (tenant_id, id, kind, type_version_id, number, warehouse_id, business_date, reason, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, '2026-02-01', 'qa', $7)`;
const lineInsert = `INSERT INTO public.document_lines
  (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, lot_id, serial_id)
  VALUES ($1, $2, $3, $4, $5, $6, 10, 1, 10, $7, $8, $9)`;

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
  const r = await admin.query<{ id: string; key: string }>("SELECT id, key FROM public.document_type_versions WHERE tenant_id IS NULL AND version = 1");
  tv = Object.fromEntries(r.rows.map((x) => [x.key, x.id]));
  for (const k of ["STOCK_IN", "STOCK_OUT", "STOCK_MOVE", "REVERSAL"]) expect(tv[k], `sistem sürümü ${k}`).toBeTruthy();

  // POSTED belge: DRAFT + 2 satır → POSTED (sahip, süper kullanıcı) → satır 2'de kısmi ters çevirme (5/10 PARTIAL).
  const docId = randomUUID();
  const line1 = randomUUID();
  const line2 = randomUUID();
  await admin.query(docInsert, [A.tenantId, docId, "STOCK_IN", tv.STOCK_IN, null, A.warehouseId, A.ownerUserId]);
  await admin.query(lineInsert, [A.tenantId, line1, docId, 1, A.itemId, A.unitId, A.rootLocationId, A.lotId, A.serialId]);
  await admin.query(lineInsert, [A.tenantId, line2, docId, 2, A.itemTwoId, A.unitId, A.rootLocationId, A.lotTwoId, null]);
  await admin.query("UPDATE public.documents SET number = $2, status = 'POSTED' WHERE id = $1", [docId, `QA-${rnd()}`]);
  await admin.query("UPDATE public.document_lines SET reversed_quantity = 5, reversal_status = 'PARTIAL' WHERE id = $1", [line2]);
  posted = { docId, line1, line2PartiallyReversed: line2 };
}, 60_000);

afterAll(async () => {
  try {
    if (admin !== undefined) await cleanupRegistry(admin, reg);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
}, 60_000);

// ---------------------------------------------------------------------------------------------
// 1. POSTED değişmezliği (I-08, ADR-017 §8)
// ---------------------------------------------------------------------------------------------
describe("POSTED belge/satır değişmezliği", () => {
  it("fikstür kontrolü: POSTED belge ve kısmi ters çevrilmiş satır beklenen durumda", async () => {
    const d = await admin.query("SELECT status, version FROM public.documents WHERE id = $1", [posted.docId]);
    expect(d.rows[0]).toMatchObject({ status: "POSTED" });
    const l = await admin.query("SELECT reversed_quantity::text AS rq, reversal_status FROM public.document_lines WHERE id = $1", [posted.line2PartiallyReversed]);
    expect(l.rows[0]).toEqual({ rq: "5.000000", reversal_status: "PARTIAL" });
  });

  it("POSTED satırın reversed_quantity/reversal_status DIŞINDAKİ her yazılabilir sütunu wms_app ile değiştirilemez (23514)", async () => {
    const cases: Array<[string, string, unknown[]]> = [
      ["quantity", "quantity = 11", []],
      ["base_quantity", "base_quantity = 11", []],
      ["conversion_factor", "conversion_factor = 2", []],
      ["line_no", "line_no = 9", []],
      ["item_id", "item_id = $2", [A.itemTwoId]],
      ["unit_id", "unit_id = $2", [A.boxUnitId]],
      ["target_location_id", "target_location_id = $2", [A.childLocationId]],
      ["source_location_id", "source_location_id = $2", [A.childLocationId]],
      ["stock_status", "stock_status = 'BLOCKED'", []],
      ["lot_id", "lot_id = NULL", []],
      ["serial_id", "serial_id = NULL", []],
      ["inventory_owner_id", "inventory_owner_id = $2", [A.ownerId]],
      ["handling_unit_id", "handling_unit_id = $2", [A.handlingUnitId]],
    ];
    for (const [col, set, extra] of cases) {
      const o = await appOne(A.tenantId, `UPDATE public.document_lines SET ${set} WHERE id = $1`, [posted.line1, ...extra]);
      expectRejected(o, [CHECK_VIOLATION], `POSTED satır ${col}`, /DOCUMENT_POSTED_IMMUTABLE/);
    }
  });

  it("POSTED satırda değişmeyen değer atamak (no-op) da yalnızca izinli sütun kümesinde geçer; quantity ile reversed_quantity birlikte değişirse reddedilir", async () => {
    const mixed = await appOne(A.tenantId, "UPDATE public.document_lines SET quantity = 11, reversed_quantity = 6, reversal_status = 'PARTIAL' WHERE id = $1", [
      posted.line2PartiallyReversed,
    ]);
    expectRejected(mixed, [CHECK_VIOLATION], "karma değişiklik", /DOCUMENT_POSTED_IMMUTABLE/);
  });

  it("POSTED satırda reversed_quantity AZALTMA reddedilir (23514, REVERSAL_DECREASE); artış ve ileri durum geçişi serbesttir", async () => {
    const id = posted.line2PartiallyReversed;
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.document_lines SET reversed_quantity = 3, reversal_status = 'PARTIAL' WHERE id = $1", [id]),
      [CHECK_VIOLATION],
      "5 → 3",
      /REVERSAL_DECREASE/,
    );
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.document_lines SET reversed_quantity = 0, reversal_status = 'NONE' WHERE id = $1", [id]),
      [CHECK_VIOLATION],
      "5 → 0",
      /REVERSAL_DECREASE/,
    );
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.document_lines SET reversal_status = 'NONE' WHERE id = $1", [id]),
      [CHECK_VIOLATION],
      "yalnızca durumu NONE'a çek",
    );
    // Tablo sahibi/süper kullanıcı da bağlıdır.
    expectRejected(
      await ownerOne(A.tenantId, "UPDATE public.document_lines SET reversed_quantity = 1, reversal_status = 'PARTIAL' WHERE id = $1", [id]),
      [CHECK_VIOLATION],
      "sahip: 5 → 1",
      /REVERSAL_DECREASE/,
    );
    const up = await appOne(A.tenantId, "UPDATE public.document_lines SET reversed_quantity = 7, reversal_status = 'PARTIAL' WHERE id = $1", [id]);
    expect(up.ok && up.rowCount === 1, `artış: ${fmt(up)}`).toBe(true);
    const full = await appOne(A.tenantId, "UPDATE public.document_lines SET reversed_quantity = 10, reversal_status = 'FULL' WHERE id = $1", [id]);
    expect(full.ok && full.rowCount === 1, `FULL: ${fmt(full)}`).toBe(true);
    const fromFull = await attempt(app, A.tenantId, async (q) => {
      await q("UPDATE public.document_lines SET reversed_quantity = 10, reversal_status = 'FULL' WHERE id = $1", [id]);
      await q("UPDATE public.document_lines SET reversal_status = 'PARTIAL' WHERE id = $1", [id]);
    });
    expectRejected(fromFull, [CHECK_VIOLATION], "FULL → PARTIAL geri alma", /REVERSAL_DECREASE/);
  });

  it("POSTED belgeye satır eklenemez, POSTED belgenin satırı silinemez (wms_app 23514); DRAFT satırında ters çevirme alanları değişemez", async () => {
    expectRejected(
      await appOne(A.tenantId, lineInsert, [A.tenantId, randomUUID(), posted.docId, 3, A.itemId, A.unitId, A.rootLocationId, null, null]),
      [CHECK_VIOLATION],
      "POSTED belgeye satır ekle",
      /DOCUMENT_POSTED_IMMUTABLE/,
    );
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.document_lines WHERE id = $1", [posted.line1]), [CHECK_VIOLATION], "POSTED satır sil", /DOCUMENT_POSTED_IMMUTABLE/);
    expectRejected(await ownerOne(A.tenantId, "DELETE FROM public.document_lines WHERE document_id = $1", [posted.docId]), [CHECK_VIOLATION], "sahip: POSTED satır sil");
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.document_lines SET reversed_quantity = 1, reversal_status = 'PARTIAL' WHERE id = $1", [A.documentLineId]),
      [CHECK_VIOLATION],
      "DRAFT satırında ters çevirme",
    );
  });

  it("POSTED belge başlığında her yazılabilir sütun reddedilir; belge silinemez (wms_app 42501 yetkisiz, sahip 23514)", async () => {
    const cases: Array<[string, string, unknown[]]> = [
      ["status", "status = 'CANCELLED'", []],
      ["status DRAFT", "status = 'DRAFT'", []],
      ["number", "number = 'X-1'", []],
      ["reason", "reason = 'degisti'", []],
      ["business_date", "business_date = '2030-01-01'", []],
      ["warehouse_id", "warehouse_id = $2", [A.warehouseId]],
    ];
    for (const [col, set, extra] of cases) {
      expectRejected(await appOne(A.tenantId, `UPDATE public.documents SET ${set} WHERE id = $1`, [posted.docId, ...extra]), [CHECK_VIOLATION], `POSTED belge ${col}`, /DOCUMENT_POSTED_IMMUTABLE/);
    }
    expectRejected(await ownerOne(A.tenantId, "UPDATE public.documents SET reason = 'sahip' WHERE id = $1", [posted.docId]), [CHECK_VIOLATION], "sahip UPDATE", /DOCUMENT_POSTED_IMMUTABLE/);
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.documents WHERE id = $1", [posted.docId]), [INSUFFICIENT_PRIVILEGE], "wms_app DELETE");
    expectRejected(await ownerOne(A.tenantId, "DELETE FROM public.documents WHERE id = $1", [posted.docId]), [CHECK_VIOLATION], "sahip DELETE", /DOCUMENT_POSTED_IMMUTABLE/);
  });

  it("belge yaşam döngüsü: numarasız POSTED reddedilir; DRAFT→POSTED geçişi version'ı +1 yapar, sonrası değişmez; wms_app version/kind/created_by yazamaz", async () => {
    const id = randomUUID();
    const r = await attempt(app, A.tenantId, async (q) => {
      await q(docInsert, [A.tenantId, id, "STOCK_IN", tv.STOCK_IN, null, A.warehouseId, A.ownerUserId]);
      await q(lineInsert, [A.tenantId, randomUUID(), id, 1, A.itemId, A.unitId, A.rootLocationId, null, null]);
      const v0 = await q("SELECT version, status FROM public.documents WHERE id = $1", [id]);
      expect(v0.rows[0]).toEqual({ version: 1, status: "DRAFT" });
      await q("UPDATE public.documents SET reason = 'a' WHERE id = $1", [id]);
      await q("UPDATE public.documents SET reason = 'b' WHERE id = $1", [id]);
      const v2 = await q("SELECT version FROM public.documents WHERE id = $1", [id]);
      expect(v2.rows[0]).toEqual({ version: 3 });
      await q("UPDATE public.documents SET number = $2, status = 'POSTED' WHERE id = $1", [id, `QA-${rnd()}`]);
      const v3 = await q("SELECT version, status FROM public.documents WHERE id = $1", [id]);
      expect(v3.rows[0]).toEqual({ version: 4, status: "POSTED" });
    });
    expect(r.ok, fmt(r)).toBe(true);
    expectRejected(await appOne(A.tenantId, "UPDATE public.documents SET status = 'POSTED' WHERE id = $1", [A.documentId]), [CHECK_VIOLATION], "numarasız POSTED (CHECK)");
    for (const col of ["version = 99", "kind = 'STOCK_OUT'", "created_by = $2", "reversal_of_document_id = $1"]) {
      const p = col.includes("$2") ? [A.documentId, randomUUID()] : [A.documentId];
      expectRejected(await appOne(A.tenantId, `UPDATE public.documents SET ${col} WHERE id = $1`, p), [INSUFFICIENT_PRIVILEGE], `wms_app ${col.split(" ")[0]}`);
    }
    // Sahip de sabit alanları değiştiremez (tetikleyici).
    expectRejected(await ownerOne(A.tenantId, "UPDATE public.documents SET kind = 'STOCK_OUT' WHERE id = $1", [A.documentId]), [CHECK_VIOLATION, FK_VIOLATION], "sahip kind");
    expectRejected(await ownerOne(A.tenantId, "UPDATE public.documents SET type_version_id = $2 WHERE id = $1", [A.documentId, tv.STOCK_OUT]), [CHECK_VIOLATION, FK_VIOLATION], "sahip type_version_id");
  });

  it("INSERT ile doğrudan POSTED/APPROVED belge ve ters çevrilmiş satır wms_app tarafından yaratılamaz", async () => {
    expectRejected(
      await appOne(
        A.tenantId,
        `INSERT INTO public.documents (tenant_id, id, kind, type_version_id, status, number, warehouse_id, business_date, created_by)
         VALUES ($1, $2, 'STOCK_IN', $3, 'POSTED', 'X-1', $4, '2026-02-01', $5)`,
        [A.tenantId, randomUUID(), tv.STOCK_IN, A.warehouseId, A.ownerUserId],
      ),
      [INSUFFICIENT_PRIVILEGE],
      "status INSERT yetkisi yok",
    );
    expectRejected(
      await appOne(
        A.tenantId,
        `INSERT INTO public.document_lines (tenant_id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, reversed_quantity)
         VALUES ($1, $2, 5, $3, $4, 10, 1, 10, $5, 1)`,
        [A.tenantId, A.documentId, A.itemId, A.unitId, A.rootLocationId],
      ),
      [INSUFFICIENT_PRIVILEGE],
      "reversed_quantity INSERT yetkisi yok",
    );
    // Sahip yolu: yeni satır ters çevrilmiş doğamaz.
    expectRejected(
      await ownerOne(
        A.tenantId,
        `INSERT INTO public.document_lines (tenant_id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, reversed_quantity, reversal_status)
         VALUES ($1, $2, 5, $3, $4, 10, 1, 10, $5, 1, 'PARTIAL')`,
        [A.tenantId, A.documentId, A.itemId, A.unitId, A.rootLocationId],
      ),
      [CHECK_VIOLATION],
      "sahip: ters çevrilmiş doğan satır",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Bileşik FK'ler: başka tenant / başka ürün referansı (M-3)
// ---------------------------------------------------------------------------------------------
describe("belge satırı ve belge başlığı bileşik FK'leri", () => {
  const lineCols = (over: Partial<Record<string, unknown>>): unknown[] => {
    const base: Record<string, unknown> = {
      doc: A.documentId,
      item: A.itemId,
      unit: A.unitId,
      target: A.rootLocationId,
      lot: null,
      serial: null,
    };
    const m = { ...base, ...over };
    return [A.tenantId, randomUUID(), m.doc, 2, m.item, m.unit, m.target, m.lot, m.serial];
  };

  it("@AC-04 A belge satırı B'nin ürününe/birimine/lokasyonuna/lotuna/serisine/belgesine bağlanamaz (23503)", async () => {
    const cases: Array<[string, Partial<Record<string, unknown>>]> = [
      ["B ürünü", { item: B.itemId }],
      ["B birimi", { unit: B.unitId }],
      ["B hedef lokasyonu", { target: B.rootLocationId }],
      ["B lotu", { lot: B.lotId }],
      ["B serisi", { serial: B.serialId }],
      ["B belgesi", { doc: B.documentId }],
    ];
    for (const [name, over] of cases) expectRejected(await appOne(A.tenantId, lineInsert, lineCols(over)), [FK_VIOLATION], name);
    const ctl = await appOne(A.tenantId, lineInsert, lineCols({}));
    expect(ctl.ok, `kontrol (tamamen A): ${fmt(ctl)}`).toBe(true);
  });

  it("@AC-04 kaynak lokasyon, sahip, taşıma birimi: B kayıtları reddedilir (23503)", async () => {
    const ins = (col: string, val: string): Promise<Outcome> =>
      appOne(
        A.tenantId,
        `INSERT INTO public.document_lines (tenant_id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, ${col})
         VALUES ($1, $2, 2, $3, $4, 1, 1, 1, $5, $6)`,
        [A.tenantId, A.documentId, A.itemId, A.unitId, A.rootLocationId, val],
      );
    expectRejected(await ins("source_location_id", B.rootLocationId), [FK_VIOLATION], "B kaynak lokasyonu");
    expectRejected(await ins("inventory_owner_id", B.ownerId), [FK_VIOLATION], "B sahibi");
    expectRejected(await ins("handling_unit_id", B.handlingUnitId), [FK_VIOLATION], "B taşıma birimi");
    const ctl = await ins("handling_unit_id", A.handlingUnitId);
    expect(ctl.ok, fmt(ctl)).toBe(true);
  });

  it("ADR-017 §2 ürüne bağlı hedefler: A ürününün satırı aynı tenant'ta BAŞKA ürünün lotuna/serisine bağlanamaz (23503)", async () => {
    expectRejected(await appOne(A.tenantId, lineInsert, lineCols({ item: A.itemId, lot: A.lotTwoId })), [FK_VIOLATION], "ürün 1 satırı → ürün 2 lotu");
    expectRejected(await appOne(A.tenantId, lineInsert, lineCols({ item: A.itemTwoId, lot: A.lotId })), [FK_VIOLATION], "ürün 2 satırı → ürün 1 lotu");
    const serialOther = await attempt(app, A.tenantId, async (q) => {
      const s = randomUUID();
      await q("INSERT INTO public.serials (tenant_id, id, item_id, serial_no) VALUES ($1, $2, $3, $4)", [A.tenantId, s, A.itemTwoId, `S${rnd()}`]);
      await q(lineInsert, lineCols({ item: A.itemId, serial: s }));
    });
    expectRejected(serialOther, [FK_VIOLATION], "ürün 1 satırı → ürün 2 serisi");
    const ctl = await appOne(A.tenantId, lineInsert, lineCols({ item: A.itemId, lot: A.lotId, serial: A.serialId }));
    expect(ctl.ok, `kontrol (ürün 1 + kendi lotu/serisi): ${fmt(ctl)}`).toBe(true);
    // UPDATE yolu: satırın lot'unu başka ürünün lotuna çevirmek de reddedilir.
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.document_lines SET lot_id = $2 WHERE id = $1", [A.documentLineId, A.lotTwoId]),
      [FK_VIOLATION],
      "UPDATE ile başka ürünün lotu",
    );
    // Ürünü değiştirip lot'u bırakmak da (lot artık başka ürünün) reddedilir.
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.document_lines SET item_id = $2 WHERE id = $1", [A.documentLineId, A.itemTwoId]),
      [FK_VIOLATION],
      "UPDATE ile ürün değişimi, lot eski ürünün",
    );
  });

  it("@AC-04 belge başlığı: B'nin deposu, B'nin belgesi (reversal_of) ve B'nin üyesi olmayan referanslar reddedilir (23503)", async () => {
    expectRejected(await appOne(A.tenantId, docInsert, [A.tenantId, randomUUID(), "STOCK_IN", tv.STOCK_IN, null, B.warehouseId, A.ownerUserId]), [FK_VIOLATION], "B deposu");
    expectRejected(
      await appOne(
        A.tenantId,
        `INSERT INTO public.documents (tenant_id, kind, type_version_id, warehouse_id, business_date, reversal_of_document_id, created_by)
         VALUES ($1, 'REVERSAL', $2, $3, '2026-02-01', $4, $5)`,
        [A.tenantId, tv.REVERSAL, A.warehouseId, B.documentId, A.ownerUserId],
      ),
      [FK_VIOLATION],
      "REVERSAL → B belgesi",
    );
    expectRejected(
      await appOne(A.tenantId, "INSERT INTO public.document_status_history (tenant_id, document_id, to_status) VALUES ($1, $2, 'APPROVED')", [A.tenantId, B.documentId]),
      [FK_VIOLATION],
      "durum geçmişi → B belgesi",
    );
    const ctl = await appOne(A.tenantId, "INSERT INTO public.document_status_history (tenant_id, document_id, to_status) VALUES ($1, $2, 'APPROVED')", [A.tenantId, A.documentId]);
    expect(ctl.ok, fmt(ctl)).toBe(true);
  });

  it("belge türü/sürüm tutarlılığı: sürüm anahtarı ≠ belge türü (23503); olmayan sürüm (23514); B'nin tenant-özel sürümü A belgesinde reddedilir (23514)", async () => {
    expectRejected(await appOne(A.tenantId, docInsert, [A.tenantId, randomUUID(), "STOCK_IN", tv.STOCK_OUT, null, A.warehouseId, A.ownerUserId]), [FK_VIOLATION], "kind STOCK_IN + STOCK_OUT sürümü");
    expectRejected(await appOne(A.tenantId, docInsert, [A.tenantId, randomUUID(), "STOCK_IN", randomUUID(), null, A.warehouseId, A.ownerUserId]), [CHECK_VIOLATION, FK_VIOLATION], "olmayan sürüm");
    const cross = await attempt(admin, A.tenantId, async (q) => {
      const bv = randomUUID();
      await q("INSERT INTO public.document_type_versions (id, tenant_id, key, version) VALUES ($1, $2, 'STOCK_IN', 1)", [bv, B.tenantId]);
      await q(docInsert, [A.tenantId, randomUUID(), "STOCK_IN", bv, null, A.warehouseId, A.ownerUserId]);
    });
    expectRejected(cross, [CHECK_VIOLATION], "B'nin tenant-özel sürümü → A belgesi");
    // Aynı sürüm B'nin kendi belgesinde geçerlidir (kontrol): reddin nedeni tenant uyuşmazlığıdır.
    const own = await attempt(admin, B.tenantId, async (q) => {
      const bv = randomUUID();
      await q("INSERT INTO public.document_type_versions (id, tenant_id, key, version) VALUES ($1, $2, 'STOCK_IN', 1)", [bv, B.tenantId]);
      await q(docInsert, [B.tenantId, randomUUID(), "STOCK_IN", bv, null, B.warehouseId, B.ownerUserId]);
    });
    expect(own.ok, `kontrol: ${fmt(own)}`).toBe(true);
  });

  it("document_type_versions değişmezdir: süper kullanıcı dahil UPDATE/DELETE reddedilir (42501), session_replication_role=replica ile de", async () => {
    expectRejected(await attempt(admin, null, (q) => q("UPDATE public.document_type_versions SET definition = '{}'::jsonb")), [INSUFFICIENT_PRIVILEGE], "UPDATE");
    expectRejected(await attempt(admin, null, (q) => q("DELETE FROM public.document_type_versions")), [INSUFFICIENT_PRIVILEGE], "DELETE");
    const replica = await attempt(admin, null, async (q) => {
      await q("SET LOCAL session_replication_role = replica");
      return q("DELETE FROM public.document_type_versions");
    });
    expectRejected(replica, [INSUFFICIENT_PRIVILEGE], "replica altında DELETE");
  });

  it("number_sequences: next_value azaltılamaz (23514); anahtar sütunları wms_app ile yazılamaz (42501)", async () => {
    expectRejected(
      await attempt(app, A.tenantId, async (q) => {
        await q("UPDATE public.number_sequences SET next_value = 10 WHERE document_kind = 'STOCK_IN'");
        await q("UPDATE public.number_sequences SET next_value = 9 WHERE document_kind = 'STOCK_IN'");
      }),
      [CHECK_VIOLATION],
      "sayaç geri gitti",
    );
    expectRejected(await appOne(A.tenantId, "UPDATE public.number_sequences SET period = '2099' WHERE document_kind = 'STOCK_IN'"), [INSUFFICIENT_PRIVILEGE], "period");
    const up = await appOne(A.tenantId, "UPDATE public.number_sequences SET next_value = next_value + 1 WHERE document_kind = 'STOCK_IN'");
    expect(up.ok && up.rowCount === 1, fmt(up)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. idempotency_records (I-06, ADR-017 §10)
// ---------------------------------------------------------------------------------------------
describe("idempotency_records", () => {
  const insertRec = (over: { result?: unknown; status?: string; error?: string | null; key?: string } = {}): [string, unknown[]] => [
    `INSERT INTO public.idempotency_records (tenant_id, id, command_type, client_key, actor_user_id, request_hash, status, result, error_code, http_status, completed_at)
     VALUES ($1, $2, 'stock.qa', $3, $4, $5, $6, $7::jsonb, $8, NULL, CASE WHEN $6 = 'IN_PROGRESS' THEN NULL ELSE now() END)`,
    [
      A.tenantId,
      randomUUID(),
      over.key ?? randomUUID(),
      A.ownerUserId,
      sha(),
      over.status ?? "IN_PROGRESS",
      over.result === undefined ? null : JSON.stringify(over.result),
      over.error ?? null,
    ],
  ];

  it("wms_app UPDATE ile request_hash / actor_user_id / client_key / command_type / tenant_id / id / created_at değiştirilemez (42501)", async () => {
    const cols: Array<[string, string, unknown[]]> = [
      ["request_hash", "request_hash = $2", [sha()]],
      ["actor_user_id", "actor_user_id = $2", [randomUUID()]],
      ["client_key", "client_key = $2", [randomUUID()]],
      ["command_type", "command_type = 'baska'", []],
      ["tenant_id", "tenant_id = $2", [B.tenantId]],
      ["id", "id = $2", [randomUUID()]],
      ["created_at", "created_at = now() - interval '1 day'", []],
    ];
    for (const [name, set, extra] of cols) {
      expectRejected(
        await appOne(A.tenantId, `UPDATE public.idempotency_records SET ${set} WHERE id = $1`, [A.idempotencyRecordId, ...extra]),
        [INSUFFICIENT_PRIVILEGE],
        `wms_app ${name}`,
      );
    }
  });

  it("tablo sahibi/süper kullanıcı da request_hash ve actor_user_id'yi değiştiremez (tetikleyici, 42501)", async () => {
    expectRejected(await ownerOne(A.tenantId, "UPDATE public.idempotency_records SET request_hash = $2 WHERE id = $1", [A.idempotencyRecordId, sha()]), [INSUFFICIENT_PRIVILEGE], "sahip request_hash");
    expectRejected(await ownerOne(A.tenantId, "UPDATE public.idempotency_records SET actor_user_id = $2 WHERE id = $1", [A.idempotencyRecordId, randomUUID()]), [INSUFFICIENT_PRIVILEGE], "sahip actor_user_id");
  });

  it("sonlanmış kayıt (COMPLETED/REJECTED) tamamen değişmezdir (42501); IN_PROGRESS → COMPLETED geçişi izinlidir; DELETE yok", async () => {
    const id = A.idempotencyRecordId;
    const done = "UPDATE public.idempotency_records SET status = 'COMPLETED', result = $2::jsonb, http_status = 200, completed_at = now() WHERE id = $1";
    const ok = await appOne(A.tenantId, done, [id, JSON.stringify({ documentId: randomUUID(), status: "POSTED" })]);
    expect(ok.ok && ok.rowCount === 1, `geçiş: ${fmt(ok)}`).toBe(true);
    const twice = await attempt(app, A.tenantId, async (q) => {
      await q(done, [id, JSON.stringify({ documentId: randomUUID() })]);
      await q("UPDATE public.idempotency_records SET result = $2::jsonb WHERE id = $1", [id, JSON.stringify({ documentId: randomUUID() })]);
    });
    expectRejected(twice, [INSUFFICIENT_PRIVILEGE], "COMPLETED sonucu ikinci kez değiştir");
    const flip = await attempt(app, A.tenantId, async (q) => {
      await q(done, [id, JSON.stringify({ status: "POSTED" })]);
      await q("UPDATE public.idempotency_records SET status = 'FAILED', error_code = 'X', completed_at = now() WHERE id = $1", [id]);
    });
    expectRejected(flip, [INSUFFICIENT_PRIVILEGE], "COMPLETED → FAILED");
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.idempotency_records WHERE id = $1", [id]), [INSUFFICIENT_PRIVILEGE], "wms_app DELETE");
  });

  it("result beyaz listesi: beyaz liste dışı anahtar, JSON dizi/skaler/null reddedilir (23514) — INSERT ve UPDATE yolunda; beyaz listedeki anahtarlar geçer", async () => {
    const bad: unknown[] = [
      { secret: "x" },
      { documentId: randomUUID(), extra: 1 },
      { DocumentId: randomUUID() },
      { email: "kisi@example.test" },
      [1, 2],
      "metin",
      42,
    ];
    for (const result of bad) {
      const [sql, p] = insertRec({ result, status: "COMPLETED" });
      expectRejected(await appOne(A.tenantId, sql, p), [CHECK_VIOLATION], `INSERT result=${JSON.stringify(result)}`);
      expectRejected(
        await appOne(A.tenantId, "UPDATE public.idempotency_records SET status = 'COMPLETED', result = $2::jsonb, completed_at = now() WHERE id = $1", [A.idempotencyRecordId, JSON.stringify(result)]),
        [CHECK_VIOLATION],
        `UPDATE result=${JSON.stringify(result)}`,
      );
    }
    const jsonNull = await appOne(
      A.tenantId,
      "UPDATE public.idempotency_records SET status = 'COMPLETED', result = 'null'::jsonb, completed_at = now() WHERE id = $1",
      [A.idempotencyRecordId],
    );
    expectRejected(jsonNull, [CHECK_VIOLATION], "JSON null literali");
    const [sql, p] = insertRec({
      result: { documentId: randomUUID(), documentNumber: "N-1", status: "POSTED", reservationIds: [], lines: [{ lineNo: 1, qty: 1 }] },
      status: "COMPLETED",
    });
    const ok = await appOne(A.tenantId, sql, p);
    expect(ok.ok, `beyaz liste: ${fmt(ok)}`).toBe(true);
  });

  it("tekillik ve biçim: aynı (command_type, client_key) ikinci kayıt 23505; request_hash 64 küçük harf hex değilse 23514; REJECTED hata kodsuz 23514", async () => {
    const key = randomUUID();
    const [sql, p] = insertRec({ key });
    const dup = await attempt(app, A.tenantId, async (q) => {
      await q(sql, p);
      await q(sql, [A.tenantId, randomUUID(), ...p.slice(2)]);
    });
    expectRejected(dup, [UNIQUE_VIOLATION], "aynı client_key");
    for (const hash of ["abc", "G".repeat(64), sha().toUpperCase()]) {
      expectRejected(
        await appOne(A.tenantId, "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash) VALUES ($1, 'c', $2, $3, $4)", [
          A.tenantId,
          randomUUID(),
          A.ownerUserId,
          hash,
        ]),
        [CHECK_VIOLATION],
        `hash=${hash.slice(0, 6)}`,
      );
    }
    const [s2, p2] = insertRec({ status: "REJECTED", error: null });
    expectRejected(await appOne(A.tenantId, s2, p2), [CHECK_VIOLATION], "REJECTED hata kodsuz");
  });
});

// ---------------------------------------------------------------------------------------------
// 4. document_status_history: append-only + sunucu alanları (I-16, ADR-017 §5)
// ---------------------------------------------------------------------------------------------
describe("document_status_history", () => {
  const hist = "INSERT INTO public.document_status_history (tenant_id, document_id, from_status, to_status, actor_user_id) VALUES ($1, $2, NULL, 'DRAFT', $3)";

  it("wms_app istemci created_xid / occurred_at veremez (sütun yetkisi yok, 42501); normal INSERT'te created_xid = bu transaction'ın xid'i", async () => {
    expectRejected(
      await appOne(A.tenantId, "INSERT INTO public.document_status_history (tenant_id, document_id, to_status, created_xid) VALUES ($1, $2, 'DRAFT', '1'::xid8)", [A.tenantId, A.documentId]),
      [INSUFFICIENT_PRIVILEGE],
      "created_xid",
    );
    expectRejected(
      await appOne(A.tenantId, "INSERT INTO public.document_status_history (tenant_id, document_id, to_status, occurred_at) VALUES ($1, $2, 'DRAFT', '2000-01-01')", [A.tenantId, A.documentId]),
      [INSUFFICIENT_PRIVILEGE],
      "occurred_at",
    );
    const r = await attempt(app, A.tenantId, async (q) => {
      const ins = await q(`${hist} RETURNING created_xid::text AS x, occurred_at = now() AS now_ok`, [A.tenantId, A.documentId, A.ownerUserId]);
      const cur = await q("SELECT pg_current_xact_id()::text AS x");
      expect(ins.rows[0]).toEqual({ x: (cur.rows[0] as { x: string }).x, now_ok: true });
    });
    expect(r.ok, fmt(r)).toBe(true);
  });

  it("tablo sahibi/süper kullanıcı istemci created_xid ve occurred_at verse bile sunucu değeri yazılır (yok sayılır); replica modunda da", async () => {
    for (const replica of [false, true]) {
      const r = await attempt(admin, A.tenantId, async (q) => {
        if (replica) await q("SET LOCAL session_replication_role = replica");
        const ins = await q(
          `INSERT INTO public.document_status_history (tenant_id, document_id, to_status, created_xid, occurred_at)
           VALUES ($1, $2, 'DRAFT', '1'::xid8, '2000-01-01T00:00:00Z') RETURNING created_xid::text AS x, occurred_at > '2020-01-01' AS recent`,
          [A.tenantId, A.documentId],
        );
        const cur = await q("SELECT pg_current_xact_id()::text AS x");
        expect(ins.rows[0], `replica=${replica}`).toEqual({ x: (cur.rows[0] as { x: string }).x, recent: true });
        expect((ins.rows[0] as { x: string }).x).not.toBe("1");
      });
      expect(r.ok, fmt(r)).toBe(true);
    }
  });

  it("append-only: UPDATE/DELETE wms_app'te 42501 (yetki), tablo sahibinde 42501 (tetikleyici); TRUNCATE sahipte replica dahil reddedilir", async () => {
    expectRejected(await appOne(A.tenantId, "UPDATE public.document_status_history SET reason = 'x'"), [INSUFFICIENT_PRIVILEGE], "wms_app UPDATE");
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.document_status_history"), [INSUFFICIENT_PRIVILEGE], "wms_app DELETE");
    expectRejected(await appOne(A.tenantId, "TRUNCATE public.document_status_history"), [INSUFFICIENT_PRIVILEGE], "wms_app TRUNCATE");
    expectRejected(await ownerOne(A.tenantId, "UPDATE public.document_status_history SET reason = 'x' WHERE id = $1", [A.statusHistoryId]), [INSUFFICIENT_PRIVILEGE], "sahip UPDATE");
    expectRejected(await ownerOne(A.tenantId, "DELETE FROM public.document_status_history WHERE id = $1", [A.statusHistoryId]), [INSUFFICIENT_PRIVILEGE], "sahip DELETE");
    expectRejected(await ownerOne(A.tenantId, "TRUNCATE public.document_status_history"), [INSUFFICIENT_PRIVILEGE], "sahip TRUNCATE");
    const replicaTruncate = await attempt(admin, A.tenantId, async (q) => {
      await q("SET LOCAL session_replication_role = replica");
      return q("TRUNCATE public.document_status_history");
    });
    expectRejected(replicaTruncate, [INSUFFICIENT_PRIVILEGE], "replica altında TRUNCATE");
  });

  it("wms_app session_replication_role'ü değiştiremez (append-only atlatma yolu uygulama rolüne kapalı, 42501)", async () => {
    expectRejected(await appOne(A.tenantId, "SET LOCAL session_replication_role = replica"), [INSUFFICIENT_PRIVILEGE], "SET session_replication_role");
    expectRejected(await appOne(A.tenantId, "ALTER TABLE public.document_status_history DISABLE TRIGGER ALL"), [INSUFFICIENT_PRIVILEGE, "42501"], "DISABLE TRIGGER");
    // Rol sızıntısı yok: uygulama rolü süper kullanıcı değil, BYPASSRLS değil.
    const r = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1", [APP_ROLE]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("@AC-04 durum geçmişi A bağlamında B'nin satırını göstermez ve B anahtarıyla yazılamaz", async () => {
    const seen = await appOne(A.tenantId, "SELECT count(*)::int AS n FROM public.document_status_history WHERE tenant_id = $1", [B.tenantId]);
    expect(seen.ok && (seen.rows[0] as { n: number }).n === 0, fmt(seen)).toBe(true);
    expectRejected(await appOne(A.tenantId, hist, [B.tenantId, B.documentId, A.ownerUserId]), [INSUFFICIENT_PRIVILEGE], "B anahtarlı INSERT", /row-level security/i);
  });
});
