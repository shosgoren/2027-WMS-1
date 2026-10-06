// Stok belgeleri şeması (T-206, I-06, I-08, I-11, I-16, ADR-017 §5 §8-§10, ADR-018). GERÇEK rollerle: uygulama rolü wms_app
// (DATABASE_URL, pooler); migration rolü yalnızca fikstür kurulumu/temizliği ve sahip düzeyi denemeleri içindir.
// Sentetik veri: rastgele UUID/kodlar (G-09). Her deneme ROLLBACK ile biter (kalıcı değişiklik yok).
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const NEW_TABLES = ["document_type_versions", "number_sequences", "documents", "document_lines", "document_status_history", "idempotency_records"] as const;
const rnd = (): string => randomBytes(4).toString("hex");
const sha = (): string => createHash("sha256").update(randomBytes(16)).digest("hex");

const reg = newRegistry();
const clients: pg.Client[] = [];
let admin: pg.Client;
let app: pg.Client;
let app2: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let stockInTypeVersionId = "";

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

/** Verilen istemci, tenant bağlamı transaction-local (G-02); daima ROLLBACK. */
async function inTx(client: pg.Client, tenantId: string, work: (q: Q) => Promise<unknown>): Promise<Attempt> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await client.query(sql, p);
      return last;
    });
    return { ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await client.query("ROLLBACK");
  }
}
const inTenant = (tenantId: string, work: (q: Q) => Promise<unknown>): Promise<Attempt> => inTx(app, tenantId, work);
const one = (tenantId: string, sql: string, p: unknown[] = []): Promise<Attempt> => inTenant(tenantId, async (q) => q(sql, p));

function expectFail(r: Attempt, code: string, label?: string): void {
  expect(r.ok, label ?? JSON.stringify(r)).toBe(false);
  if (!r.ok) expect(r.code, `${label ?? ""} ${r.message}`).toBe(code);
}
function expectOk(r: Attempt, label?: string): void {
  expect(r.ok, `${label ?? ""} ${JSON.stringify(r)}`).toBe(true);
}

const insDoc = (w: TenantWorld, id: string): [string, unknown[]] => [
  `INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by)
   VALUES ($1, $2, 'STOCK_IN', $3, $4, '2026-02-01', $5)`,
  [w.tenantId, id, stockInTypeVersionId, w.warehouseId, w.ownerUserId],
];
const insLine = (w: TenantWorld, docId: string, lineId: string, no: number, cols: Partial<{ item: string; unit: string; lot: string | null; serial: string | null; target: string }> = {}): [string, unknown[]] => [
  `INSERT INTO public.document_lines (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, lot_id, serial_id)
   VALUES ($1, $2, $3, $4, $5, $6, 5, 1, 5, $7, $8, $9)`,
  [w.tenantId, lineId, docId, no, cols.item ?? w.itemId, cols.unit ?? w.unitId, cols.target ?? w.rootLocationId, cols.lot === undefined ? null : cols.lot, cols.serial === undefined ? null : cols.serial],
];

/** A bağlamında POSTED belge + tek satır kurar (aynı transaction'da; çağıran ROLLBACK eder). */
async function postedDoc(q: Q): Promise<{ docId: string; lineId: string }> {
  const docId = randomUUID();
  const lineId = randomUUID();
  await q(...insDoc(A, docId));
  await q(...insLine(A, docId, lineId, 1));
  await q("UPDATE public.documents SET number = $2, status = 'POSTED' WHERE tenant_id = $1 AND id = $3", [A.tenantId, `N-${rnd()}`, docId]);
  return { docId, lineId };
}

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  app2 = await connect(env.databaseUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
  const tv = await admin.query<{ id: string }>("SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = 'STOCK_IN' AND version = 1");
  stockInTypeVersionId = (tv.rows[0] as { id: string }).id;
}, 60_000);

afterAll(async () => {
  try {
    if (admin !== undefined) await cleanupRegistry(admin, reg);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
}, 60_000);

describe("T-206 fiş tipi sürümleri ve numara serileri", () => {
  it("dört sistem sürümü (tenant_id NULL, v1) her iki tenant'a görünür; wms_app yazamaz; satır değişmez (I-11)", async () => {
    for (const w of [A, B]) {
      const r = await one(w.tenantId, "SELECT key, version FROM public.document_type_versions WHERE tenant_id IS NULL ORDER BY key");
      expectOk(r);
      if (r.ok) expect(r.rows).toEqual([{ key: "REVERSAL", version: 1 }, { key: "STOCK_IN", version: 1 }, { key: "STOCK_MOVE", version: 1 }, { key: "STOCK_OUT", version: 1 }]);
    }
    expectFail(await one(A.tenantId, "INSERT INTO public.document_type_versions (tenant_id, key, version) VALUES (NULL, 'X', 1)"), INSUFFICIENT_PRIVILEGE, "INSERT");
    expectFail(await one(A.tenantId, "UPDATE public.document_type_versions SET key = key"), INSUFFICIENT_PRIVILEGE, "UPDATE");
    expectFail(await one(A.tenantId, "DELETE FROM public.document_type_versions"), INSUFFICIENT_PRIVILEGE, "DELETE");
    // Sahip düzeyinde de değişmez (ENABLE ALWAYS tetikleyici).
    for (const sql of ["UPDATE public.document_type_versions SET definition = '{}'::jsonb", "DELETE FROM public.document_type_versions"]) {
      expectFail(await inTx(admin, A.tenantId, async (q) => q(sql)), INSUFFICIENT_PRIVILEGE, `sahip: ${sql}`);
    }
  });

  it("tenant-özel sürüm yalnızca sahibine görünür; başka tenant'ın sürümüne belge bağlamak fail-closed reddedilir", async () => {
    const tvB = randomUUID();
    const withBVersion = async (tenantId: string, work: (q: Q) => Promise<unknown>): Promise<Attempt> =>
      inTx(admin, tenantId, async (q) => {
        // FORCE RLS tablo sahibine de uygulanır ve yazma politikası yoktur: yalnızca bu (geri alınan) transaction'da kapatılır.
        await q("ALTER TABLE public.document_type_versions NO FORCE ROW LEVEL SECURITY");
        await q("INSERT INTO public.document_type_versions (id, tenant_id, key, version) VALUES ($1, $2, 'STOCK_IN', 7)", [tvB, B.tenantId]);
        await q("ALTER TABLE public.document_type_versions FORCE ROW LEVEL SECURITY");
        await work(q);
      });
    // admin süper kullanıcıysa RLS zaten atlanır; asıl tetikleyici denetimi wms_app ile aşağıda (görünürlük politikası) sınanır.
    const seen = await withBVersion(B.tenantId, async (q) => q("SELECT 1 FROM public.document_type_versions WHERE id = $1", [tvB]));
    expectOk(seen);
    // wms_app ile: A bağlamında rastgele (var olmayan/görünmeyen) sürüm → tetikleyici 23514 (FK'dan önce, fail-closed).
    const [sql, p] = insDoc(A, randomUUID());
    expectFail(await one(A.tenantId, sql, [p[0], p[1], randomUUID(), p[3], p[4]]), CHECK_VIOLATION, "bilinmeyen sürüm");
    // Sahip düzeyinde: B'nin tenant-özel sürümüne A belgesi bağlanamaz.
    const cross = await inTx(admin, A.tenantId, async (q) => {
      await q("ALTER TABLE public.document_type_versions NO FORCE ROW LEVEL SECURITY");
      await q("INSERT INTO public.document_type_versions (id, tenant_id, key, version) VALUES ($1, $2, 'STOCK_IN', 7)", [tvB, B.tenantId]);
      await q("ALTER TABLE public.document_type_versions FORCE ROW LEVEL SECURITY");
      await q(sql, [p[0], p[1], tvB, p[3], p[4]]);
    });
    expectFail(cross, CHECK_VIOLATION, "başka tenant'ın tenant-özel sürümü");
  });

  it("belge türü ile fiş tipi anahtarı uyuşmalıdır (type_version_id, kind) FK", async () => {
    const [, p] = insDoc(A, randomUUID());
    const r = await one(
      A.tenantId,
      `INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by)
       VALUES ($1, $2, 'STOCK_OUT', $3, $4, '2026-02-01', $5)`,
      p,
    );
    expectFail(r, FK_VIOLATION);
  });

  it("number_sequences: PK (tenant, tür, dönem); sayaç geri gitmez; tür kümesi; RLS", async () => {
    expectFail(await one(A.tenantId, "INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'STOCK_IN', '2026')", [A.tenantId]), UNIQUE_VIOLATION);
    expectOk(await one(A.tenantId, "INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'STOCK_IN', '2027')", [A.tenantId]));
    expectFail(await one(A.tenantId, "INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'BOGUS', '2027')", [A.tenantId]), CHECK_VIOLATION);
    expectFail(await one(A.tenantId, "INSERT INTO public.number_sequences (tenant_id, document_kind, period, next_value) VALUES ($1, 'STOCK_IN', '2028', 0)", [A.tenantId]), CHECK_VIOLATION);
    expectOk(await inTenant(A.tenantId, async (q) => {
      await q("UPDATE public.number_sequences SET next_value = next_value + 1 WHERE tenant_id = $1", [A.tenantId]);
    }));
    expectFail(
      await inTenant(A.tenantId, async (q) => {
        await q("UPDATE public.number_sequences SET next_value = 5 WHERE tenant_id = $1", [A.tenantId]);
        await q("UPDATE public.number_sequences SET next_value = 4 WHERE tenant_id = $1", [A.tenantId]);
      }),
      CHECK_VIOLATION,
      "azaltma",
    );
    expectFail(await one(A.tenantId, "INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'STOCK_IN', '2029')", [B.tenantId]), INSUFFICIENT_PRIVILEGE, "başka tenant");
    const seen = await one(A.tenantId, "SELECT count(*)::int AS n FROM public.number_sequences WHERE tenant_id = $1", [B.tenantId]);
    expectOk(seen);
    if (seen.ok) expect(seen.rows[0]).toEqual({ n: 0 });
  });
});

describe("T-206 (a) POSTED değişmezliği (I-08)", () => {
  it("POSTED satır miktarı UPDATE reddedilir; diğer sütunlar, silme ve satır ekleme de", async () => {
    for (const sql of [
      "UPDATE public.document_lines SET quantity = 6 WHERE id = $1",
      "UPDATE public.document_lines SET base_quantity = 6 WHERE id = $1",
      "UPDATE public.document_lines SET target_location_id = NULL, source_location_id = target_location_id WHERE id = $1",
      "DELETE FROM public.document_lines WHERE id = $1",
    ]) {
      const r = await inTenant(A.tenantId, async (q) => {
        const { lineId } = await postedDoc(q);
        await q(sql, [lineId]);
      });
      // DELETE yetkisi wms_app'te var (taslak düzenleme), tetikleyici POSTED'da reddeder.
      expectFail(r, CHECK_VIOLATION, sql);
      if (!r.ok) expect(r.message).toMatch(/DOCUMENT_(POSTED_IMMUTABLE|NOT_DRAFT)/);
    }
    const add = await inTenant(A.tenantId, async (q) => {
      const { docId } = await postedDoc(q);
      await q(...insLine(A, docId, randomUUID(), 2));
    });
    expectFail(add, CHECK_VIOLATION, "POSTED belgeye satır ekleme");
  });

  it("reversed_quantity artışı ve reversal_status ileri geçişi serbest; azaltma ve geri geçiş reddedilir", async () => {
    const ok = await inTenant(A.tenantId, async (q) => {
      const { lineId } = await postedDoc(q);
      await q("UPDATE public.document_lines SET reversed_quantity = 2, reversal_status = 'PARTIAL' WHERE id = $1", [lineId]);
      await q("UPDATE public.document_lines SET reversed_quantity = 5, reversal_status = 'FULL' WHERE id = $1", [lineId]);
      return q("SELECT reversed_quantity::text AS r, reversal_status AS s FROM public.document_lines WHERE id = $1", [lineId]);
    });
    expectOk(ok);
    if (ok.ok) expect(ok.rows[0]).toEqual({ r: "5.000000", s: "FULL" });
    const dec = await inTenant(A.tenantId, async (q) => {
      const { lineId } = await postedDoc(q);
      await q("UPDATE public.document_lines SET reversed_quantity = 3, reversal_status = 'PARTIAL' WHERE id = $1", [lineId]);
      await q("UPDATE public.document_lines SET reversed_quantity = 1, reversal_status = 'PARTIAL' WHERE id = $1", [lineId]);
    });
    expectFail(dec, CHECK_VIOLATION, "reversed_quantity azaltma");
    if (!dec.ok) expect(dec.message).toMatch(/REVERSAL_DECREASE/);
    const back = await inTenant(A.tenantId, async (q) => {
      const { lineId } = await postedDoc(q);
      await q("UPDATE public.document_lines SET reversed_quantity = 3, reversal_status = 'FULL' WHERE id = $1", [lineId]);
      await q("UPDATE public.document_lines SET reversed_quantity = 3, reversal_status = 'PARTIAL' WHERE id = $1", [lineId]);
    });
    expectFail(back, CHECK_VIOLATION, "reversal_status geri geçiş");
    const sameQtyBack = await inTenant(A.tenantId, async (q) => {
      const { lineId } = await postedDoc(q);
      await q("UPDATE public.document_lines SET reversed_quantity = 3, reversal_status = 'PARTIAL' WHERE id = $1", [lineId]);
      await q("UPDATE public.document_lines SET reversed_quantity = 0, reversal_status = 'NONE' WHERE id = $1", [lineId]);
    });
    expectFail(sameQtyBack, CHECK_VIOLATION, "sıfırlama");
    // Tutarsız çift (miktar var, durum NONE) CHECK ile reddedilir.
    const incons = await inTenant(A.tenantId, async (q) => {
      const { lineId } = await postedDoc(q);
      await q("UPDATE public.document_lines SET reversed_quantity = 1 WHERE id = $1", [lineId]);
    });
    expectFail(incons, CHECK_VIOLATION, "tutarsız ters çevirme çifti");
  });

  it("taslak belgede ters çevirme alanları değişmez; yeni satır ters çevrilmiş olamaz (grant dışı: sahip)", async () => {
    const r = await one(A.tenantId, "UPDATE public.document_lines SET reversed_quantity = 1, reversal_status = 'PARTIAL' WHERE id = $1", [A.documentLineId]);
    expectFail(r, CHECK_VIOLATION);
  });

  it("POSTED başlık: her UPDATE ve DELETE reddedilir (sahip dahil); numarasız POSTED olmaz; taslak başlıkta version her güncellemede artar", async () => {
    const upd = await inTenant(A.tenantId, async (q) => {
      const { docId } = await postedDoc(q);
      await q("UPDATE public.documents SET reason = 'x' WHERE id = $1", [docId]);
    });
    expectFail(upd, CHECK_VIOLATION, "POSTED başlık UPDATE");
    const del = await inTx(admin, A.tenantId, async (q) => {
      const { docId } = await postedDoc(q);
      await q("DELETE FROM public.documents WHERE id = $1", [docId]);
    });
    expectFail(del, CHECK_VIOLATION, "POSTED başlık DELETE (sahip)");
    const delLine = await inTx(admin, A.tenantId, async (q) => {
      const { lineId } = await postedDoc(q);
      await q("DELETE FROM public.document_lines WHERE id = $1", [lineId]);
    });
    expectFail(delLine, CHECK_VIOLATION, "POSTED satır DELETE (sahip)");
    expectFail(await one(A.tenantId, "UPDATE public.documents SET status = 'POSTED' WHERE id = $1", [A.documentId]), CHECK_VIOLATION, "numarasız POSTED");
    const ver = await inTenant(A.tenantId, async (q) => {
      await q("UPDATE public.documents SET reason = 'a' WHERE id = $1", [A.documentId]);
      await q("UPDATE public.documents SET reason = 'b' WHERE id = $1", [A.documentId]);
      return q("SELECT version FROM public.documents WHERE id = $1", [A.documentId]);
    });
    expectOk(ver);
    if (ver.ok) expect(ver.rows[0]).toEqual({ version: 3 });
    expectFail(await one(A.tenantId, "UPDATE public.documents SET version = 99 WHERE id = $1", [A.documentId]), INSUFFICIENT_PRIVILEGE, "version yazma yetkisi yok");
    // Sahip düzeyinde bile version istemci değeri yok sayılır.
    const owner = await inTx(admin, A.tenantId, async (q) => {
      await q("UPDATE public.documents SET version = 99 WHERE id = $1", [A.documentId]);
      return q("SELECT version FROM public.documents WHERE id = $1", [A.documentId]);
    });
    expectOk(owner);
    if (owner.ok) expect(owner.rows[0]).toEqual({ version: 2 });
  });

  it("değişmez başlık alanları (kind, type_version_id, reversal_of, created_by) sahip düzeyinde de değiştirilemez; ters kayıt kuralları", async () => {
    expectFail(await inTx(admin, A.tenantId, async (q) => q("UPDATE public.documents SET kind = 'STOCK_OUT' WHERE id = $1", [A.documentId])), CHECK_VIOLATION);
    expectFail(await inTx(admin, A.tenantId, async (q) => q("UPDATE public.documents SET created_by = $2 WHERE id = $1", [A.documentId, randomUUID()])), CHECK_VIOLATION);
    // REVERSAL ⇔ reversal_of_document_id; kendine ters kayıt yok; ters kayıt başka tenant'ın belgesine olamaz.
    const rev = (kindSql: string, of: string | null): Promise<Attempt> =>
      one(
        A.tenantId,
        `INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by, reversal_of_document_id)
         VALUES ($1, $2, ${kindSql}, (SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = ${kindSql} AND version = 1), $3, '2026-02-01', $4, $5)`,
        [A.tenantId, randomUUID(), A.warehouseId, A.ownerUserId, of],
      );
    expectOk(await rev("'REVERSAL'", A.documentId));
    expectFail(await rev("'REVERSAL'", null), CHECK_VIOLATION, "REVERSAL belge hedefsiz");
    expectFail(await rev("'STOCK_IN'", A.documentId), CHECK_VIOLATION, "STOCK_IN ters hedefli");
    expectFail(await rev("'REVERSAL'", B.documentId), FK_VIOLATION, "başka tenant'ın belgesini ters çevirme");
    // posting_job_id yalnızca APPROVED iken ve çiftli.
    expectFail(await one(A.tenantId, "UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3 WHERE id = $1", [A.documentId, randomUUID(), A.ownerUserId]), CHECK_VIOLATION, "DRAFT'ta posting_job_id");
    expectOk(
      await inTenant(A.tenantId, async (q) => {
        await q("UPDATE public.documents SET status = 'APPROVED', posting_job_id = $2, posting_requested_by = $3 WHERE id = $1", [A.documentId, randomUUID(), A.ownerUserId]);
      }),
    );
    expectFail(await one(A.tenantId, "UPDATE public.documents SET status = 'APPROVED', posting_job_id = $2 WHERE id = $1", [A.documentId, randomUUID()]), CHECK_VIOLATION, "tek başına posting_job_id");
  });
});

describe("T-206 (b) bileşik tenant FK'leri", () => {
  it("A belgesi B'nin ürünü/birimi/deposu/lokasyonu/sahibi/taşıma birimine bağlanamaz (23503)", async () => {
    const doc = randomUUID();
    const base = async (q: Q): Promise<void> => {
      await q(...insDoc(A, doc));
    };
    const cases: [string, Parameters<typeof insLine>[4]][] = [
      ["B ürünü", { item: B.itemId }],
      ["B birimi", { unit: B.unitId }],
      ["B lokasyonu", { target: B.rootLocationId }],
    ];
    for (const [label, cols] of cases) {
      expectFail(
        await inTenant(A.tenantId, async (q) => {
          await base(q);
          await q(...insLine(A, doc, randomUUID(), 1, cols));
        }),
        FK_VIOLATION,
        label,
      );
    }
    expectFail(
      await inTenant(A.tenantId, async (q) => {
        const [sql, p] = insDoc(A, doc);
        await q(sql, [p[0], p[1], p[2], B.warehouseId, p[4]]);
      }),
      FK_VIOLATION,
      "B deposu",
    );
    for (const [col, val] of [["inventory_owner_id", B.ownerId], ["handling_unit_id", B.handlingUnitId], ["source_location_id", B.childLocationId]] as const) {
      expectFail(
        await inTenant(A.tenantId, async (q) => {
          await base(q);
          await q(`UPDATE public.documents SET reason = 'x' WHERE id = $1`, [doc]);
          await q(...insLine(A, doc, randomUUID(), 1));
          await q(`UPDATE public.document_lines SET ${col} = $2 WHERE document_id = $1`, [doc, val]);
        }),
        FK_VIOLATION,
        col,
      );
    }
    // Başka tenant'a ait belge kimliğine satır: belge görünmez, FK reddeder.
    expectFail(await one(A.tenantId, ...insLine(A, B.documentId, randomUUID(), 9)), FK_VIOLATION, "B belgesine satır");
  });

  it("lot/seri ürüne bağlıdır: başka ürünün lotu ve serisi reddedilir; kendi ürününün lotu kabul; NULL lot FK'yı atlar", async () => {
    const doc = randomUUID();
    const withDoc = (work: (q: Q) => Promise<unknown>) =>
      inTenant(A.tenantId, async (q) => {
        await q(...insDoc(A, doc));
        await work(q);
      });
    // A.lotTwoId = itemTwo'nun lotu; satır itemId (ürün 1) için.
    expectFail(await withDoc((q) => q(...insLine(A, doc, randomUUID(), 1, { lot: A.lotTwoId }))), FK_VIOLATION, "başka ürünün lotu");
    expectFail(await withDoc((q) => q(...insLine(A, doc, randomUUID(), 1, { item: A.itemTwoId, lot: A.lotId }))), FK_VIOLATION, "ürün 2 için ürün 1'in lotu");
    expectFail(await withDoc((q) => q(...insLine(A, doc, randomUUID(), 1, { item: A.itemTwoId, serial: A.serialId }))), FK_VIOLATION, "başka ürünün serisi");
    expectFail(await withDoc((q) => q(...insLine(A, doc, randomUUID(), 1, { lot: B.lotId }))), FK_VIOLATION, "B'nin lotu");
    expectOk(await withDoc((q) => q(...insLine(A, doc, randomUUID(), 1, { lot: A.lotId, serial: A.serialId }))), "kendi ürününün lot/serisi");
    expectOk(await withDoc((q) => q(...insLine(A, doc, randomUUID(), 1, { lot: null, serial: null }))), "lot/seri yok");
  });

  it("satır kısıtları: miktar > 0, en az bir lokasyon, tekil satır no, durum kümesi; RLS yabancı tenant yazımı", async () => {
    const doc = randomUUID();
    const withDoc = (work: (q: Q) => Promise<unknown>) =>
      inTenant(A.tenantId, async (q) => {
        await q(...insDoc(A, doc));
        await work(q);
      });
    const ins = (qty: string, tgt: string | null, no: number, status = "AVAILABLE"): [string, unknown[]] => [
      `INSERT INTO public.document_lines (tenant_id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, stock_status)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7, $8)`,
      [A.tenantId, doc, no, A.itemId, A.unitId, qty, tgt, status],
    ];
    expectFail(await withDoc((q) => q(...ins("0", A.rootLocationId, 1))), CHECK_VIOLATION, "miktar 0");
    expectFail(await withDoc((q) => q(...ins("-1", A.rootLocationId, 1))), CHECK_VIOLATION, "miktar < 0");
    expectFail(await withDoc((q) => q(...ins("1", null, 1))), CHECK_VIOLATION, "lokasyonsuz");
    expectFail(await withDoc((q) => q(...ins("1", A.rootLocationId, 1, "BOGUS"))), CHECK_VIOLATION, "durum");
    expectFail(
      await withDoc(async (q) => {
        await q(...ins("1", A.rootLocationId, 1));
        await q(...ins("1", A.rootLocationId, 1));
      }),
      UNIQUE_VIOLATION,
      "aynı satır no",
    );
    expectFail(await one(A.tenantId, ...insDoc(B, randomUUID())), INSUFFICIENT_PRIVILEGE, "A bağlamında B belgesi");
  });
});

describe("T-206 (c) created_xid zorlama (I-16)", () => {
  it("wms_app durum geçmişine doğrudan INSERT yapamaz (42501); geçiş tetikleyiciyle sunucu değerleriyle satır üretir", async () => {
    const direct = await one(A.tenantId, "INSERT INTO public.document_status_history (tenant_id, document_id, to_status) VALUES ($1, $2, 'APPROVED')", [A.tenantId, A.documentId]);
    expectFail(direct, INSUFFICIENT_PRIVILEGE, "doğrudan INSERT (sütun yetkili)");
    if (!direct.ok) expect(direct.message).toMatch(/yalnızca documents durum tetikleyicisiyle/);
    for (const cols of ["(tenant_id, document_id, to_status, created_xid) VALUES ($1, $2, 'APPROVED', '1'::xid8)", "(tenant_id, document_id, to_status, occurred_at) VALUES ($1, $2, 'APPROVED', '2000-01-01')"]) {
      expectFail(await one(A.tenantId, `INSERT INTO public.document_status_history ${cols}`, [A.tenantId, A.documentId]), INSUFFICIENT_PRIVILEGE, cols);
    }
    expectFail(await one(A.tenantId, "INSERT INTO public.document_status_history (tenant_id, document_id, to_status) VALUES ($1, $2, 'DRAFT')", [A.tenantId, B.documentId]), FK_VIOLATION, "B belgesine geçmiş");
    const r = await inTenant(A.tenantId, async (q) => {
      await q("SELECT set_config('app.current_user_id', $1, true)", [A.ownerUserId]);
      await q("UPDATE public.documents SET status = 'APPROVED' WHERE id = $1", [A.documentId]);
      await q("UPDATE public.documents SET reason = 'durum degismedi' WHERE id = $1", [A.documentId]);
      return q(
        `SELECT from_status, to_status, actor_user_id::text AS actor, (created_xid = pg_current_xact_id()) AS same_xid, (occurred_at = now()) AS same_now
           FROM public.document_status_history WHERE document_id = $1 AND to_status = 'APPROVED'`,
        [A.documentId],
      );
    });
    expectOk(r);
    if (r.ok) expect(r.rows).toEqual([{ from_status: "DRAFT", to_status: "APPROVED", actor: A.ownerUserId, same_xid: true, same_now: true }]);
    // INSERT yolu: yeni belge ilk geçmiş satırını (NULL → DRAFT) üretir; aktör ayarı yoksa NULL.
    const ins = await inTenant(A.tenantId, async (q) => {
      const id = randomUUID();
      await q(...insDoc(A, id));
      return q("SELECT from_status, to_status, actor_user_id FROM public.document_status_history WHERE document_id = $1", [id]);
    });
    expectOk(ins);
    if (ins.ok) expect(ins.rows).toEqual([{ from_status: null, to_status: "DRAFT", actor_user_id: null }]);
    // Tetikleyici işlevi çağrılamaz.
    expectFail(await one(A.tenantId, "SELECT public.documents_write_status_history()"), INSUFFICIENT_PRIVILEGE, "işlev EXECUTE");
  });

  it("sahip düzeyinde bile doğrudan INSERT reddedilir (istemci created_xid/occurred_at hiçbir yoldan girmez); tetikleyici yolu sunucu değerini yazar", async () => {
    expectFail(
      await inTx(admin, A.tenantId, async (q) =>
        q("INSERT INTO public.document_status_history (tenant_id, id, document_id, to_status, created_xid, occurred_at) VALUES ($1, $2, $3, 'APPROVED', '1'::xid8, '2000-01-01')", [A.tenantId, randomUUID(), A.documentId]),
      ),
      INSUFFICIENT_PRIVILEGE,
      "sahip doğrudan INSERT",
    );
    const r = await inTx(admin, A.tenantId, async (q) => {
      await q("UPDATE public.documents SET status = 'APPROVED' WHERE id = $1", [A.documentId]);
      return q(
        "SELECT (created_xid = pg_current_xact_id()) AS same_xid, (occurred_at > '2020-01-01') AS fresh FROM public.document_status_history WHERE to_status = 'APPROVED' AND document_id = $1",
        [A.documentId],
      );
    });
    expectOk(r);
    if (r.ok) expect(r.rows[0]).toEqual({ same_xid: true, fresh: true });
  });
});

describe("T-206 (d) idempotency kayıtları (I-06, ADR-018)", () => {
  const ins = (w: TenantWorld, key: string, extra = ""): [string, unknown[]] => [
    `INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash${extra ? ", " + extra.split("=")[0] : ""}) VALUES ($1, 'stock.document.post', $2, $3, $4${extra ? ", " + extra.split("=")[1] : ""})`,
    [w.tenantId, key, w.ownerUserId, sha()],
  ];

  it("(tenant, komut, anahtar) tekil; aynı anahtar başka tenant'ta serbest; format CHECK'leri", async () => {
    const key = randomUUID();
    expectFail(
      await inTenant(A.tenantId, async (q) => {
        await q(...ins(A, key));
        await q(...ins(A, key));
      }),
      UNIQUE_VIOLATION,
    );
    expectOk(await one(A.tenantId, ...ins(A, key)));
    expectOk(await one(B.tenantId, ...ins(B, key)));
    expectFail(await one(A.tenantId, "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash) VALUES ($1, 'c', $2, $3, 'abc')", [A.tenantId, randomUUID(), A.ownerUserId]), CHECK_VIOLATION, "özet biçimi");
    expectFail(await one(A.tenantId, "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash, status) VALUES ($1, 'c', $2, $3, $4, 'REJECTED')", [A.tenantId, randomUUID(), A.ownerUserId, sha()]), CHECK_VIOLATION, "REJECTED hata kodsuz");
    expectOk(await one(A.tenantId, "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash, status, error_code, http_status, completed_at) VALUES ($1, 'c', $2, $3, $4, 'REJECTED', 'INSUFFICIENT_STOCK', 409, now())", [A.tenantId, randomUUID(), A.ownerUserId, sha()]), "REJECTED doğrudan");
    expectFail(await one(A.tenantId, "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash, status) VALUES ($1, 'c', $2, $3, $4, 'COMPLETED')", [A.tenantId, randomUUID(), A.ownerUserId, sha()]), CHECK_VIOLATION, "COMPLETED completed_at'siz");
  });

  it("wms_app ile request_hash / actor_user_id / client_key / command_type UPDATE → 42501; DELETE → 42501", async () => {
    const cases: [string, unknown[]][] = [
      ["request_hash = $2", [A.idempotencyRecordId, sha()]],
      ["actor_user_id = $2", [A.idempotencyRecordId, randomUUID()]],
      ["client_key = $2", [A.idempotencyRecordId, randomUUID()]],
      ["command_type = $2", [A.idempotencyRecordId, "x"]],
    ];
    for (const [set, p] of cases) {
      expectFail(await one(A.tenantId, `UPDATE public.idempotency_records SET ${set} WHERE id = $1`, p), INSUFFICIENT_PRIVILEGE, set);
    }
    expectFail(await one(A.tenantId, "DELETE FROM public.idempotency_records WHERE id = $1", [A.idempotencyRecordId]), INSUFFICIENT_PRIVILEGE, "DELETE");
    // Sahip düzeyinde tetikleyici de reddeder.
    expectFail(await inTx(admin, A.tenantId, async (q) => q("UPDATE public.idempotency_records SET request_hash = $2 WHERE id = $1", [A.idempotencyRecordId, sha()])), INSUFFICIENT_PRIVILEGE, "sahip request_hash");
    expectFail(await inTx(admin, A.tenantId, async (q) => q("UPDATE public.idempotency_records SET actor_user_id = $2 WHERE id = $1", [A.idempotencyRecordId, randomUUID()])), INSUFFICIENT_PRIVILEGE, "sahip actor");
  });

  it("IN_PROGRESS → COMPLETED geçişi izinli; sonlanmış kayıt değişmez (tekrar = önceki sonuç)", async () => {
    const r = await inTenant(A.tenantId, async (q) => {
      await q(
        `UPDATE public.idempotency_records SET status = 'COMPLETED', http_status = 200, completed_at = now(),
                result = '{"documentId": "x", "documentNumber": "N-1", "status": "POSTED", "reservationIds": [], "lines": [{"lineId": "l", "quantity": 1}]}'::jsonb
          WHERE id = $1`,
        [A.idempotencyRecordId],
      );
      return q("SELECT status FROM public.idempotency_records WHERE id = $1", [A.idempotencyRecordId]);
    });
    expectOk(r);
    if (r.ok) expect(r.rows[0]).toEqual({ status: "COMPLETED" });
    const again = await inTenant(A.tenantId, async (q) => {
      await q("UPDATE public.idempotency_records SET status = 'COMPLETED', http_status = 200, completed_at = now() WHERE id = $1", [A.idempotencyRecordId]);
      await q("UPDATE public.idempotency_records SET http_status = 201 WHERE id = $1", [A.idempotencyRecordId]);
    });
    expectFail(again, INSUFFICIENT_PRIVILEGE, "sonlanmış kayıt");
  });

  it("result üst düzey anahtar beyaz listesi: dışı anahtar CHECK reddi; nesne olmayan reddi; boş nesne/NULL kabul", async () => {
    const upd = (json: string | null): Promise<Attempt> =>
      one(A.tenantId, "UPDATE public.idempotency_records SET status = 'COMPLETED', completed_at = now(), result = $2::jsonb WHERE id = $1", [A.idempotencyRecordId, json]);
    expectFail(await upd('{"documentId": "x", "email": "a@b.c"}'), CHECK_VIOLATION, "beyaz liste dışı anahtar");
    expectFail(await upd('{"note": "serbest metin"}'), CHECK_VIOLATION, "serbest metin anahtarı");
    expectFail(await upd('["documentId"]'), CHECK_VIOLATION, "dizi");
    expectFail(await upd('"documentId"'), CHECK_VIOLATION, "skaler");
    expectOk(await upd("{}"), "boş nesne");
    expectOk(await upd(null), "NULL");
    expectOk(await upd('{"documentId": "x", "documentNumber": "N", "status": "POSTED", "reservationIds": ["r"], "lines": []}'), "tam beyaz liste");
    // INSERT yolunda da aynı CHECK.
    expectFail(
      await one(A.tenantId, "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash, result) VALUES ($1, 'c', $2, $3, $4, '{\"token\": \"x\"}'::jsonb)", [A.tenantId, randomUUID(), A.ownerUserId, sha()]),
      CHECK_VIOLATION,
      "INSERT beyaz liste dışı",
    );
  });
});

describe("T-206 (e) durum geçmişi append-only", () => {
  it("wms_app UPDATE/DELETE → 42501 (yetki yok); sahip düzeyinde tetikleyici UPDATE/DELETE/TRUNCATE'i reddeder", async () => {
    expectFail(await one(A.tenantId, "UPDATE public.document_status_history SET reason = 'x' WHERE id = $1", [A.statusHistoryId]), INSUFFICIENT_PRIVILEGE, "app UPDATE");
    expectFail(await one(A.tenantId, "DELETE FROM public.document_status_history WHERE id = $1", [A.statusHistoryId]), INSUFFICIENT_PRIVILEGE, "app DELETE");
    for (const sql of ["UPDATE public.document_status_history SET reason = 'x' WHERE id = $1", "DELETE FROM public.document_status_history WHERE id = $1"]) {
      expectFail(await inTx(admin, A.tenantId, async (q) => q(sql, [A.statusHistoryId])), INSUFFICIENT_PRIVILEGE, `sahip: ${sql}`);
    }
    expectFail(await inTx(admin, A.tenantId, async (q) => q("TRUNCATE public.document_status_history")), INSUFFICIENT_PRIVILEGE, "TRUNCATE");
  });

  it("belge/satır/geçmiş/idempotency için wms_ops hiçbir yetki taşımaz; PUBLIC'te yetki yok", async () => {
    const r = await admin.query<{ n: string }>(
      `SELECT c.relname AS n FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
          AND (has_table_privilege('wms_ops', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               OR has_any_column_privilege('wms_ops', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
               OR has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))`,
      [[...NEW_TABLES]],
    );
    expect(r.rows).toEqual([]);
  });
});

describe("T-206 satır yazımı yalnızca DRAFT'ta (spec 05 §Belge durumları)", () => {
  it("APPROVED ve CANCELLED belgenin satırı eklenemez/değiştirilemez/silinemez; DRAFT'ta serbest", async () => {
    for (const st of ["APPROVED", "CANCELLED"]) {
      for (const sql of ["ins", "UPDATE public.document_lines SET quantity = 9 WHERE id = $1", "DELETE FROM public.document_lines WHERE id = $1", "UPDATE public.document_lines SET reversed_quantity = 1, reversal_status = 'PARTIAL' WHERE id = $1"]) {
        const r = await inTenant(A.tenantId, async (q) => {
          const docId = randomUUID();
          const lineId = randomUUID();
          await q(...insDoc(A, docId));
          await q(...insLine(A, docId, lineId, 1));
          await q("UPDATE public.documents SET status = $2 WHERE id = $1", [docId, st]);
          if (sql === "ins") await q(...insLine(A, docId, randomUUID(), 2));
          else await q(sql, [lineId]);
        });
        expectFail(r, CHECK_VIOLATION, `${st}: ${sql}`);
        if (!r.ok) expect(r.message).toMatch(/DOCUMENT_NOT_DRAFT/);
      }
    }
    expectOk(
      await inTenant(A.tenantId, async (q) => {
        const docId = randomUUID();
        const lineId = randomUUID();
        await q(...insDoc(A, docId));
        await q(...insLine(A, docId, lineId, 1));
        await q("UPDATE public.document_lines SET quantity = 9, base_quantity = 9 WHERE id = $1", [lineId]);
        await q(...insLine(A, docId, randomUUID(), 2));
        await q("DELETE FROM public.document_lines WHERE id = $1", [lineId]);
      }),
      "DRAFT düzenleme",
    );
  });
});

describe("T-206 eşzamanlılık: posting commit etmeden satır yazımı bloklanır ve POSTED görüp reddedilir (I-08, MAJOR-1)", () => {
  /** Admin ile commit'li DRAFT belge + satır kurar (afterAll cleanupRegistry siler). */
  async function committedDraft(): Promise<{ docId: string; lineId: string }> {
    const docId = randomUUID();
    const lineId = randomUUID();
    const [dSql, dP] = insDoc(A, docId);
    await admin.query(dSql, dP);
    const [lSql, lP] = insLine(A, docId, lineId, 1);
    await admin.query(lSql, lP);
    return { docId, lineId };
  }
  async function waitLockWait(pid: number): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const r = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]);
      if ((r.rows[0]?.n ?? 0) > 0) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("T2 kilit beklemesine girmedi (tetikleyici üst belgeyi kilitlemiyor)");
  }

  const cases: [string, (docId: string, lineId: string) => [string, unknown[]]][] = [
    ["INSERT", (docId) => insLine(A, docId, randomUUID(), 2)],
    ["UPDATE", (_d, lineId) => ["UPDATE public.document_lines SET quantity = 7, base_quantity = 7 WHERE id = $1", [lineId]]],
    ["DELETE", (_d, lineId) => ["DELETE FROM public.document_lines WHERE id = $1", [lineId]]],
  ];
  for (const [label, stmt] of cases) {
    it(`${label}: T1 POSTED yapar (commit yok), T2 bloklanır; T1 commit → T2 hata, satır değişmemiş`, async () => {
      const { docId, lineId } = await committedDraft();
      await app.query("BEGIN");
      await app2.query("BEGIN");
      try {
        await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
        await app2.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
        const pid = (await app2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
        await app.query("UPDATE public.documents SET number = $2, status = 'POSTED' WHERE id = $1", [docId, `N-${rnd()}`]);
        const [sql, p] = stmt(docId, lineId);
        const t2 = app2.query(sql, p).then(
          () => ({ ok: true as const }),
          (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code, message: String(e.message) }),
        );
        await waitLockWait(pid);
        await app.query("COMMIT");
        const res = await t2;
        expect(res.ok, "T2 eski (DRAFT) durumu görüp geçti: I-08 kırık").toBe(false);
        if (!res.ok) {
          expect(res.code).toBe(CHECK_VIOLATION);
          expect(res.message).toMatch(/DOCUMENT_(POSTED_IMMUTABLE|NOT_DRAFT)/);
        }
      } finally {
        await app.query("ROLLBACK").catch(() => undefined);
        await app2.query("ROLLBACK").catch(() => undefined);
      }
      const after = await admin.query<{ n: number; q: string }>("SELECT count(*)::int AS n, coalesce(max(quantity), 0)::text AS q FROM public.document_lines WHERE document_id = $1", [docId]);
      expect(after.rows[0]).toEqual({ n: 1, q: "5.000000" });
    }, 30_000);
  }
});

describe("T-206 RLS politika biçimi (0010/0011 emsali)", () => {
  it("beş tenant tablosunda tek PERMISSIVE FOR ALL TO PUBLIC politika, tam USING/WITH CHECK; document_type_versions'ta tek SELECT politikası", async () => {
    const tenantEq = /^\(tenant_id = \(NULLIF\((?:pg_catalog\.)?current_setting\('app\.current_tenant_id'::text, true\), ''::text\)\)::uuid\)$/;
    for (const t of NEW_TABLES.filter((x) => x !== "document_type_versions")) {
      const r = await admin.query<{ n: string; permissive: boolean; cmd: string; roles: string; qual: string | null; chk: string | null; rls: boolean; forced: boolean }>(
        `SELECT (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid)::text AS n, p.polpermissive AS permissive, p.polcmd::text AS cmd, p.polroles::text AS roles,
                pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid WHERE c.oid = ('public.' || $1)::regclass`,
        [t],
      );
      expect(r.rows, t).toHaveLength(1);
      const row = r.rows[0] as (typeof r.rows)[number];
      expect(row.n, t).toBe("1");
      expect(row.permissive, t).toBe(true);
      expect(row.cmd, t).toBe("*");
      expect(row.roles, t).toBe("{0}");
      expect(row.qual, t).toMatch(tenantEq);
      expect(row.chk, t).toMatch(tenantEq);
      expect(row.rls && row.forced, t).toBe(true);
    }
    const v = await admin.query<{ n: string; permissive: boolean; cmd: string; roles: string; qual: string | null; chk: string | null; rls: boolean; forced: boolean }>(
      `SELECT (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid)::text AS n, p.polpermissive AS permissive, p.polcmd::text AS cmd, p.polroles::text AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid WHERE c.oid = 'public.document_type_versions'::regclass`,
    );
    expect(v.rows).toHaveLength(1);
    const row = v.rows[0] as (typeof v.rows)[number];
    expect(row.n).toBe("1");
    expect(row.cmd).toBe("r");
    expect(row.permissive).toBe(true);
    expect(row.roles).toBe("{0}");
    expect(row.chk).toBeNull();
    expect(row.qual).toMatch(/^\(\(tenant_id IS NULL\) OR \(tenant_id = \(NULLIF\((?:pg_catalog\.)?current_setting\('app\.current_tenant_id'::text, true\), ''::text\)\)::uuid\)\)$/);
    expect(row.rls && row.forced).toBe(true);
  });
});

describe("T-206 migration 0012 ileri/geri/ileri (geçici veritabanı)", () => {
  const dbName = `wms_doc_${randomBytes(5).toString("hex")}`;
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
    (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~ '^(documents_|document_lines_|document_status_history_|document_type_versions_|number_sequences_|idempotency_records_)'")).rows[0]?.n ?? -1;
  const withClient = async <T>(work: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: scratchUrl });
    c.on("error", () => undefined);
    await c.connect();
    try {
      return await work(c);
    } finally {
      await c.end();
    }
  };

  it("sistem tohumu varken geri alma serbest; kullanıcı verisi varken ci dışında reddedilir, ci'da geri alınır; tekrar ileri aynı şekli ve tohumu kurar", async () => {
    await withClient(async (c) => {
      expect(await present(c)).toEqual([...NEW_TABLES].sort());
      expect(await fnCount(c)).toBe(11);
      expect((await c.query("SELECT 1 FROM public.document_type_versions WHERE tenant_id IS NULL")).rowCount).toBe(4);
      const t = randomUUID();
      await c.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'doc')", [t, `doc-${rnd()}`]);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [t]);
      await c.query("INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'STOCK_IN', '2026')", [t]);
      await c.query("COMMIT");
    });
    await expect(migrateDown({ url: scratchUrl, to: "0011", wmsEnv: "staging" })).rejects.toThrow(/veri kaybettiren geri alma/);
    const down = await migrateDown({ url: scratchUrl, to: "0011", wmsEnv: "ci" });
    expect(down.reverted).toContain("0012");
    await withClient(async (c) => {
      expect(await present(c)).toEqual([]);
      expect(await fnCount(c)).toBe(0);
    });
    const up = await migrateUp({ url: scratchUrl });
    expect(up.applied).toContain("0012");
    expect((await migrateUp({ url: scratchUrl })).applied).toEqual([]);
    await withClient(async (c) => {
      expect(await present(c)).toEqual([...NEW_TABLES].sort());
      expect(await fnCount(c)).toBe(11);
      const rls = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity", [[...NEW_TABLES]]);
      expect(rls.rows[0]?.n).toBe(NEW_TABLES.length);
      expect((await c.query("SELECT 1 FROM public.document_type_versions WHERE tenant_id IS NULL")).rowCount).toBe(4);
    });
  }, 120_000);
});
