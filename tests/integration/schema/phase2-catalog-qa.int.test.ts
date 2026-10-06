// katman: db — yalnızca DB katmanı (RLS/GRANT/FK/tetikleyici); API/dosya/cache/export bu kartın kapsamı değildir.
// Faz 2 depo/lokasyon + katalog şeması — BAĞIMSIZ doğrulama (T-209, qa-verifier). Uygulayıcıların testlerine (warehouse-schema,
// catalog-schema, documents-schema) dayanmaz; 0010/0011 migration metni + ADR-017 §2 + ADR-011 §Doğrulama + 06 §Sayım kilidi
// yaşam döngüsü'nden yeniden türetilmiş senaryolardır.
//
// Roller: uygulama rolü wms_app (DATABASE_URL, PgBouncer transaction mode) — gerçek RLS/GRANT. Migration rolü (DATABASE_URL_DIRECT)
// yalnızca fikstür kurulumu/temizliği, katalog okuması ve "tablo sahibi" denemeleri içindir. Eşzamanlılık testleri GERÇEK paralel
// bağlantılarla yapılır (iki ayrı pooler bağlantısı; üçlü halka için doğrudan bağlantı + SET LOCAL ROLE wms_app). Her deneme
// ROLLBACK ile biter, yalnızca açıkça "COMMIT" denen senaryolar kalıcı satır bırakır (fikstür temizliği tenant bazlıdır).
// Sentetik veri: rastgele UUID/kodlar (G-09).
//
// Etiket politikası: @AC-04 yalnızca gerçek tenant-izolasyonu kanıtlarında (RLS okuma/yazma, FORCE, bileşik FK'nin başka tenant'a
// referansı reddetmesi). Döngü/değişmezlik/tekillik testleri AC-04 değildir ve etiketlenmez.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { APP_ROLE, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const INSUFFICIENT_PRIVILEGE = "42501";
const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const DEADLOCK = "40P01";
const RLS_MESSAGE = /row-level security/i;
const rnd = (): string => randomBytes(4).toString("hex");

/** 0010 + 0011 tabloları (0012 tabloları documents-qa'da). */
const TABLES_0010 = ["warehouses", "locations", "location_count_locks", "membership_warehouse_scopes"] as const;
const TABLES_0011 = ["units", "items", "unit_conversions", "item_barcodes", "inventory_owners", "lots", "serials", "handling_units"] as const;
const TABLES_0012 = ["document_type_versions", "number_sequences", "documents", "document_lines", "document_status_history", "idempotency_records"] as const;
const ALL_PHASE2_TABLES = [...TABLES_0010, ...TABLES_0011, ...TABLES_0012] as const;

const TENANT_TABLES = ALL_PHASE2_TABLES.filter((t) => t !== "document_type_versions");

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

type Err = { code?: string; message?: string };
type Q = (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;
type Outcome = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string | undefined; message: string };

const fmt = (o: Outcome): string => (o.ok ? `ok rows=${o.rowCount}` : `error ${o.code ?? "?"}: ${o.message}`);

/** `client` ile transaction-local tenant bağlamı (G-02) + `work`; daima ROLLBACK. `asApp` ise doğrudan bağlantı wms_app'e düşürülür. */
async function attempt(client: pg.Client, tenantId: string | null, work: (q: Q) => Promise<unknown>, asApp = false): Promise<Outcome> {
  await client.query("BEGIN");
  try {
    if (asApp) await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
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
/** Tablo sahibi/süper kullanıcı (RLS'i aşar; tetikleyiciler yine çalışır). */
const ownerOne = (tenantId: string, sql: string, p: unknown[] = []): Promise<Outcome> => attempt(admin, tenantId, (q) => q(sql, p));

function expectRejected(o: Outcome, codes: string[], note: string, message?: RegExp): void {
  expect(o.ok, `${note}: reddedilmesi beklenirdi, gerçekleşen ${fmt(o)}`).toBe(false);
  if (!o.ok) {
    expect(codes, `${note}: beklenen ${codes.join("|")}, gerçekleşen ${fmt(o)}`).toContain(o.code);
    if (message !== undefined) expect(o.message, note).toMatch(message);
  }
}

const locInsert = `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
                   VALUES ($1, $2, $3, $4, $5, 'Qa', $6, 'STORAGE')`;

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

// ---------------------------------------------------------------------------------------------
// 1. AC-04 (DB) — 0010–0012 kapsamı: FORCE RLS, sahip, PUBLIC, uygulama rolü yetki yüzeyi
// ---------------------------------------------------------------------------------------------
describe("Faz 2 şeması — RLS/FORCE, sahiplik ve yetki yüzeyi (katalogdan)", () => {
  it("@AC-04 0010–0012'nin 18 tablosu vardır ve her birinde RLS ENABLE + FORCE, en az bir politika, sahip wms_app değil", async () => {
    const r = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string; policies: string }>(
      `SELECT c.relname::text, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner)::text AS owner,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])`,
      [[...ALL_PHASE2_TABLES]],
    );
    expect(r.rows.map((x) => x.relname).sort(), "tablo kümesi sessizce küçülmemeli").toEqual([...ALL_PHASE2_TABLES].sort());
    const bad = r.rows.filter((x) => !x.relrowsecurity || !x.relforcerowsecurity || Number(x.policies) < 1 || x.owner === APP_ROLE);
    expect(bad.map((x) => `${x.relname}: enable=${x.relrowsecurity} force=${x.relforcerowsecurity} policies=${x.policies} owner=${x.owner}`)).toEqual([]);
  });

  it("@AC-04 tenant tablolarında politika TO'suz/PERMISSIVE ve USING = WITH CHECK = bağlam tenant'ı (küresel tablo hariç)", async () => {
    const r = await admin.query<{ tbl: string; permissive: string; cmd: string; qual: string | null; wc: string | null }>(
      `SELECT p.polrelid::regclass::text AS tbl, p.polpermissive::text AS permissive, p.polcmd AS cmd,
              pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p WHERE p.polrelid::regclass::text = ANY($1::text[])`,
      [[...TENANT_TABLES]],
    );
    const names = new Set(r.rows.map((x) => x.tbl.replace(/^public\./, "")));
    for (const t of TENANT_TABLES) expect(names.has(t), `${t}: politika yok`).toBe(true);
    for (const row of r.rows) {
      expect(row.permissive, `${row.tbl} PERMISSIVE olmalı`).toBe("true");
      expect(row.cmd, `${row.tbl}: komut kapsamı '*' (ALL) olmalı`).toBe("*");
      expect(row.qual ?? "", `${row.tbl} USING`).toMatch(/tenant_id = .*current_setting\('app\.current_tenant_id'/);
      expect(row.wc ?? "", `${row.tbl} WITH CHECK`).toMatch(/tenant_id = .*current_setting\('app\.current_tenant_id'/);
    }
  });

  it("@AC-04 PUBLIC ve wms_app'te tablo düzeyi INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER yok (yalnızca sütun GRANT'ı); PUBLIC'te hiçbir yetki yok", async () => {
    const pub = await admin.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = 'PUBLIC' AND table_name = ANY($1::text[])`,
      [[...ALL_PHASE2_TABLES]],
    );
    expect(pub.rows, "PUBLIC'e tablo yetkisi verilmiş").toEqual([]);
    const pubCols = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND grantee = 'PUBLIC' AND table_name = ANY($1::text[])`,
      [[...ALL_PHASE2_TABLES]],
    );
    expect(pubCols.rows, "PUBLIC'e sütun yetkisi verilmiş").toEqual([]);
    const bad: string[] = [];
    for (const t of ALL_PHASE2_TABLES) {
      for (const priv of ["INSERT", "UPDATE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const r = await admin.query<{ p: boolean }>(`SELECT has_table_privilege($1, $2::regclass, $3) AS p`, [APP_ROLE, `public.${t}`, priv]);
        if (r.rows[0]?.p === true) bad.push(`${t}: wms_app tablo düzeyi ${priv}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("DELETE yetkisi yalnızca membership_warehouse_scopes, item_barcodes ve document_lines'ta; location_count_locks'ta ve diğerlerinde yok", async () => {
    const withDelete: string[] = [];
    for (const t of ALL_PHASE2_TABLES) {
      const r = await admin.query<{ p: boolean }>(`SELECT has_table_privilege($1, $2::regclass, 'DELETE') AS p`, [APP_ROLE, `public.${t}`]);
      if (r.rows[0]?.p === true) withDelete.push(t);
    }
    expect(withDelete.sort()).toEqual(["document_lines", "item_barcodes", "membership_warehouse_scopes"]);
  });

  it("wms_app SECURITY INVOKER tetikleyici işlevleri: search_path sabit, PUBLIC'ten EXECUTE geri alınmış", async () => {
    const r = await admin.query<{ proname: string; secdef: boolean; cfg: string[] | null; pub: boolean }>(
      `SELECT p.proname::text, p.prosecdef AS secdef, p.proconfig AS cfg,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY($1::text[])`,
      [
        [
          "locations_check_depth",
          "locations_reject_tree_change",
          "locations_create_count_lock",
          "unit_conversions_reject_base_unit",
          "handling_units_reject_cycle",
        ],
      ],
    );
    expect(r.rows.length).toBe(5);
    for (const f of r.rows) {
      expect(f.secdef, `${f.proname} SECURITY DEFINER olmamalı`).toBe(false);
      expect(f.cfg ?? [], `${f.proname} search_path`).toContain("search_path=pg_catalog, pg_temp");
      expect(f.pub, `${f.proname} PUBLIC EXECUTE`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. AC-04 (DB) — kapsanan tabloların hepsinde A bağlamında B görünmez, bağlamsız (fail-closed) görünmez, B'ye yazılamaz
// ---------------------------------------------------------------------------------------------
describe("Faz 2 şeması — tenant izolasyonu (wms_app, RLS)", () => {
  it("@AC-04 A bağlamında her 0010/0011/0012 tablosunda B satırı 0, A satırları tam görünür (kontrol ≥1)", async () => {
    const failures: string[] = [];
    for (const t of ALL_PHASE2_TABLES) {
      if (t === "document_type_versions") continue; // küresel sistem tablosu: tenant_id NULL (aşağıda ayrı)
      const aN = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${t} WHERE tenant_id = $1`, [A.tenantId]);
      const bN = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${t} WHERE tenant_id = $1`, [B.tenantId]);
      if (Number(aN.rows[0]?.n) < 1 || Number(bN.rows[0]?.n) < 1) failures.push(`${t}: fikstür her iki tenant için satır tohumlamamış`);
      const r = await appOne(
        A.tenantId,
        `SELECT count(*) FILTER (WHERE tenant_id = $1)::int AS own, count(*) FILTER (WHERE tenant_id <> $1)::int AS foreign_rows FROM public.${t}`,
        [A.tenantId],
      );
      if (!r.ok) failures.push(`${t}: ${fmt(r)}`);
      else {
        const row = r.rows[0] as { own: number; foreign_rows: number };
        if (row.foreign_rows !== 0) failures.push(`${t}: A bağlamında ${row.foreign_rows} yabancı satır görünür`);
        if (row.own !== Number(aN.rows[0]?.n)) failures.push(`${t}: A kendi satırlarını göremiyor (${row.own} ≠ ${aN.rows[0]?.n})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("@AC-04 tenant bağlamı YOKKEN (ayarlanmamış / boş dize) hiçbir tablo satır döndürmez (fail-closed)", async () => {
    const failures: string[] = [];
    for (const t of ALL_PHASE2_TABLES) {
      const none = await appOne(null, `SELECT count(*)::int AS n FROM public.${t} WHERE ${t === "document_type_versions" ? "tenant_id IS NOT NULL" : "true"}`);
      if (!none.ok || (none.rows[0] as { n: number }).n !== 0) failures.push(`${t} (bağlamsız): ${fmt(none)}`);
      const empty = await attempt(app, null, async (q) => {
        await q("SELECT set_config('app.current_tenant_id', '', true)");
        return q(`SELECT count(*)::int AS n FROM public.${t} WHERE ${t === "document_type_versions" ? "tenant_id IS NOT NULL" : "true"}`);
      });
      if (!empty.ok || (empty.rows[0] as { n: number }).n !== 0) failures.push(`${t} (boş dize): ${fmt(empty)}`);
    }
    expect(failures).toEqual([]);
  });

  it("@AC-04 A bağlamında B anahtarlı INSERT RLS (WITH CHECK) hatasıyla reddedilir: warehouses, locations, units, items, handling_units", async () => {
    const cases: Array<[string, string, unknown[]]> = [
      ["warehouses", "INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, $3, 'x')", [B.tenantId, randomUUID(), `W${rnd()}`]],
      [
        "locations",
        "INSERT INTO public.locations (tenant_id, id, warehouse_id, code, name, depth, kind) VALUES ($1, $2, $3, $4, 'x', 0, 'STORAGE')",
        [B.tenantId, randomUUID(), B.warehouseId, `L${rnd()}`],
      ],
      ["units", "INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1, $2, $3, 'x')", [B.tenantId, randomUUID(), `U${rnd()}`]],
      [
        "items",
        "INSERT INTO public.items (tenant_id, id, code, name, base_unit_id) VALUES ($1, $2, $3, 'x', $4)",
        [B.tenantId, randomUUID(), `I${rnd()}`, B.unitId],
      ],
      [
        "handling_units",
        "INSERT INTO public.handling_units (tenant_id, id, kind, code) VALUES ($1, $2, 'KOLI', $3)",
        [B.tenantId, randomUUID(), `H${rnd()}`],
      ],
      [
        "item_barcodes",
        "INSERT INTO public.item_barcodes (tenant_id, item_id, barcode) VALUES ($1, $2, $3)",
        [B.tenantId, B.itemId, `BC-${rnd()}`],
      ],
      [
        "inventory_owners",
        "INSERT INTO public.inventory_owners (tenant_id, id, code, name) VALUES ($1, $2, $3, 'x')",
        [B.tenantId, randomUUID(), `O${rnd()}`],
      ],
    ];
    for (const [name, sql, p] of cases) expectRejected(await appOne(A.tenantId, sql, p), [INSUFFICIENT_PRIVILEGE], `${name} (A bağlamı, B anahtarı)`, RLS_MESSAGE);
  });

  it("@AC-04 A bağlamında B satırına UPDATE 0 satır etkiler (sahip: kontrol A satırı ≥1) — warehouses, locations, items, lots, handling_units", async () => {
    const cases: Array<[string, string, string, string]> = [
      ["warehouses", "name", B.warehouseId, A.warehouseId],
      ["locations", "name", B.rootLocationId, A.rootLocationId],
      ["items", "name", B.itemId, A.itemId],
      ["lots", "supplier_lot", B.lotId, A.lotId],
      ["handling_units", "status", B.handlingUnitId, A.handlingUnitId],
    ];
    for (const [t, col, bId, aId] of cases) {
      const foreign = await appOne(A.tenantId, `UPDATE public.${t} SET ${col} = ${col} WHERE id = $1`, [bId]);
      expect(foreign.ok && foreign.rowCount === 0, `${t}: B satırına UPDATE 0 değil: ${fmt(foreign)}`).toBe(true);
      const own = await appOne(A.tenantId, `UPDATE public.${t} SET ${col} = ${col} WHERE id = $1`, [aId]);
      expect(own.ok && own.rowCount === 1, `${t}: kontrol (A satırı) başarısız: ${fmt(own)}`).toBe(true);
    }
  });

  it("@AC-04 A bağlamında B'nin membership_warehouse_scopes / item_barcodes satırına DELETE 0 satır etkiler (kontrol A: 1)", async () => {
    const scopeB = await appOne(A.tenantId, "DELETE FROM public.membership_warehouse_scopes WHERE warehouse_id = $1", [B.warehouseId]);
    expect(scopeB.ok && scopeB.rowCount === 0, fmt(scopeB)).toBe(true);
    const scopeA = await appOne(A.tenantId, "DELETE FROM public.membership_warehouse_scopes WHERE warehouse_id = $1", [A.warehouseId]);
    expect(scopeA.ok && scopeA.rowCount === 1, fmt(scopeA)).toBe(true);
    const bcB = await appOne(A.tenantId, "DELETE FROM public.item_barcodes WHERE item_id = $1", [B.itemId]);
    expect(bcB.ok && bcB.rowCount === 0, fmt(bcB)).toBe(true);
    const bcA = await appOne(A.tenantId, "DELETE FROM public.item_barcodes WHERE item_id = $1", [A.itemId]);
    expect(bcA.ok && bcA.rowCount === 1, fmt(bcA)).toBe(true);
  });

  it("document_type_versions: A bağlamı sistem sürümlerini (tenant_id NULL) görür; wms_app INSERT/UPDATE/DELETE yapamaz (42501)", async () => {
    const seen = await appOne(A.tenantId, "SELECT key FROM public.document_type_versions WHERE tenant_id IS NULL ORDER BY key");
    expect(seen.ok && seen.rows.map((r) => r.key)).toEqual(["REVERSAL", "STOCK_IN", "STOCK_MOVE", "STOCK_OUT"]);
    expectRejected(
      await appOne(A.tenantId, "INSERT INTO public.document_type_versions (tenant_id, key, version) VALUES ($1, 'STOCK_IN', 99)", [A.tenantId]),
      [INSUFFICIENT_PRIVILEGE],
      "wms_app INSERT",
    );
    expectRejected(await appOne(A.tenantId, "UPDATE public.document_type_versions SET definition = '{}'::jsonb"), [INSUFFICIENT_PRIVILEGE], "wms_app UPDATE");
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.document_type_versions"), [INSUFFICIENT_PRIVILEGE], "wms_app DELETE");
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Bileşik FK'ler: başka tenant / başka depo / başka ürün referansı reddedilir (RI denetimi RLS'i atlar)
// ---------------------------------------------------------------------------------------------
describe("Faz 2 şeması — bileşik FK'ler (0010/0011)", () => {
  it("@AC-04 A'nın lokasyonu B'nin deposuna bağlanamaz (FK 23503)", async () => {
    expectRejected(await appOne(A.tenantId, locInsert, [A.tenantId, randomUUID(), B.warehouseId, null, `X${rnd()}`, 0]), [FK_VIOLATION], "A lokasyonu → B deposu");
  });

  it("@AC-04 A'nın lokasyonu B'nin lokasyonunu ebeveyn gösteremez (23503)", async () => {
    expectRejected(
      await appOne(A.tenantId, locInsert, [A.tenantId, randomUUID(), A.warehouseId, B.rootLocationId, `X${rnd()}`, 1]),
      [FK_VIOLATION],
      "A lokasyonu → B ebeveyni",
    );
  });

  it("A'nın lokasyonu AYNI tenant'ın BAŞKA deposundaki lokasyonu ebeveyn gösteremez (ağaç depo sınırı, 23503)", async () => {
    const r = await attempt(app, A.tenantId, async (q) => {
      const w2 = randomUUID();
      await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, $3, 'Depo 2')", [A.tenantId, w2, `W${rnd()}`]);
      await q(locInsert, [A.tenantId, randomUUID(), w2, A.rootLocationId, `X${rnd()}`, 1]);
    });
    expectRejected(r, [FK_VIOLATION], "ağaç depoyu aşamaz");
  });

  it("lokasyon depth bütünlüğü: kök depth<>0, çocuk depth<>ebeveyn+1 ve kendi kendinin ebeveyni reddedilir (23514)", async () => {
    expectRejected(await appOne(A.tenantId, locInsert, [A.tenantId, randomUUID(), A.warehouseId, null, `X${rnd()}`, 3]), [CHECK_VIOLATION], "kök depth=3");
    expectRejected(
      await appOne(A.tenantId, locInsert, [A.tenantId, randomUUID(), A.warehouseId, A.childLocationId, `X${rnd()}`, 1]),
      [CHECK_VIOLATION],
      "çocuk depth ebeveyn+1 değil",
    );
    const self = randomUUID();
    expectRejected(await appOne(A.tenantId, locInsert, [A.tenantId, self, A.warehouseId, self, `X${rnd()}`, 1]), [CHECK_VIOLATION, FK_VIOLATION], "kendi ebeveyni");
  });

  it("ağaçta döngü: aynı INSERT ifadesinde çocuğu ebeveynden önce yazmak ve iki satırın karşılıklı ebeveyn olması reddedilir", async () => {
    const x = randomUUID();
    const y = randomUUID();
    const wrongOrder = await appOne(
      A.tenantId,
      `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
       VALUES ($1, $2, $4, $3, $5, 'c', 1, 'STORAGE'), ($1, $3, $4, NULL, $6, 'p', 0, 'STORAGE')`,
      [A.tenantId, y, x, A.warehouseId, `X${rnd()}`, `X${rnd()}`],
    );
    expectRejected(wrongOrder, [FK_VIOLATION], "çocuk-önce çok satırlı INSERT");
    const mutual = await appOne(
      A.tenantId,
      `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
       VALUES ($1, $2, $4, $3, $5, 'a', 1, 'STORAGE'), ($1, $3, $4, $2, $6, 'b', 1, 'STORAGE')`,
      [A.tenantId, x, y, A.warehouseId, `X${rnd()}`, `X${rnd()}`],
    );
    expectRejected(mutual, [FK_VIOLATION, CHECK_VIOLATION], "karşılıklı ebeveyn (döngü)");
  });

  it("@AC-04 location_count_locks: B'nin lokasyonuna / olmayan lokasyona satır, A'nın üyeliği yerine B üyeliğiyle kilitleme reddedilir", async () => {
    expectRejected(
      await appOne(A.tenantId, "INSERT INTO public.location_count_locks (tenant_id, location_id) VALUES ($1, $2)", [A.tenantId, B.rootLocationId]),
      [FK_VIOLATION, UNIQUE_VIOLATION],
      "A kilit satırı → B lokasyonu",
    );
    expectRejected(
      await appOne(A.tenantId, "INSERT INTO public.location_count_locks (tenant_id, location_id) VALUES ($1, $2)", [A.tenantId, randomUUID()]),
      [FK_VIOLATION],
      "olmayan lokasyon",
    );
    expectRejected(
      await appOne(
        A.tenantId,
        "UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE location_id = $1",
        [A.rootLocationId, randomUUID(), B.ownerMembershipId],
      ),
      [FK_VIOLATION],
      "locked_by = B üyeliği",
    );
    // Kontrol: kendi üyeliğiyle kilitleme çalışır; tutarsız (kısmi) durum CHECK ile reddedilir.
    const ok = await appOne(
      A.tenantId,
      "UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE location_id = $1",
      [A.rootLocationId, randomUUID(), A.ownerMembershipId],
    );
    expect(ok.ok && ok.rowCount === 1, fmt(ok)).toBe(true);
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.location_count_locks SET status = 'COUNTING' WHERE location_id = $1", [A.rootLocationId]),
      [CHECK_VIOLATION],
      "COUNTING ama oturum/kilit alanları boş",
    );
  });

  it("@AC-04 membership_warehouse_scopes: B'nin deposu veya B'nin üyeliği A kapsamına yazılamaz (23503)", async () => {
    const ins = "INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)";
    expectRejected(await appOne(A.tenantId, ins, [A.tenantId, A.memberMembershipId, B.warehouseId]), [FK_VIOLATION], "A üyeliği → B deposu");
    expectRejected(await appOne(A.tenantId, ins, [A.tenantId, B.memberMembershipId, A.warehouseId]), [FK_VIOLATION], "B üyeliği → A deposu");
  });

  it("@AC-04 katalog FK'leri: B'nin birimi/ürünü/lotu/lokasyonu A satırında reddedilir (items, unit_conversions, lots, serials, handling_units, item_barcodes)", async () => {
    const cases: Array<[string, string, unknown[]]> = [
      ["items.base_unit", "INSERT INTO public.items (tenant_id, id, code, name, base_unit_id) VALUES ($1, $2, $3, 'x', $4)", [A.tenantId, randomUUID(), `I${rnd()}`, B.unitId]],
      ["unit_conversions.item", "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 2)", [A.tenantId, B.itemId, A.boxUnitId]],
      ["unit_conversions.unit", "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 2)", [A.tenantId, A.itemTwoId, B.boxUnitId]],
      ["lots.item", "INSERT INTO public.lots (tenant_id, item_id, lot_code) VALUES ($1, $2, $3)", [A.tenantId, B.itemId, `L${rnd()}`]],
      ["serials.item", "INSERT INTO public.serials (tenant_id, item_id, serial_no) VALUES ($1, $2, $3)", [A.tenantId, B.itemId, `S${rnd()}`]],
      ["serials.lot", "INSERT INTO public.serials (tenant_id, item_id, serial_no, lot_id) VALUES ($1, $2, $3, $4)", [A.tenantId, A.itemId, `S${rnd()}`, B.lotId]],
      ["handling_units.parent", "INSERT INTO public.handling_units (tenant_id, kind, code, parent_id) VALUES ($1, 'KOLI', $2, $3)", [A.tenantId, `H${rnd()}`, B.handlingUnitId]],
      ["handling_units.location", "INSERT INTO public.handling_units (tenant_id, kind, code, location_id) VALUES ($1, 'KOLI', $2, $3)", [A.tenantId, `H${rnd()}`, B.rootLocationId]],
      ["item_barcodes.item", "INSERT INTO public.item_barcodes (tenant_id, item_id, barcode) VALUES ($1, $2, $3)", [A.tenantId, B.itemId, `BC-${rnd()}`]],
      ["item_barcodes.unit", "INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, $3, $4)", [A.tenantId, A.itemId, B.unitId, `BC-${rnd()}`]],
    ];
    for (const [name, sql, p] of cases) expectRejected(await appOne(A.tenantId, sql, p), [FK_VIOLATION], name);
  });

  it("ADR-017 §2 ürüne bağlı hedefler: aynı tenant'ta BAŞKA ürünün lotu seriye bağlanamaz (serials_lot_fkey, 23503); doğru ürünün lotu geçer", async () => {
    expectRejected(
      await appOne(A.tenantId, "INSERT INTO public.serials (tenant_id, item_id, serial_no, lot_id) VALUES ($1, $2, $3, $4)", [A.tenantId, A.itemId, `S${rnd()}`, A.lotTwoId]),
      [FK_VIOLATION],
      "A ürün 1 serisi → ürün 2 lotu",
    );
    const ok = await appOne(A.tenantId, "INSERT INTO public.serials (tenant_id, item_id, serial_no, lot_id) VALUES ($1, $2, $3, $4)", [A.tenantId, A.itemId, `S${rnd()}`, A.lotId]);
    expect(ok.ok, fmt(ok)).toBe(true);
  });

  it("unit_conversions: temel birim için dönüşüm satırı reddedilir (23514)", async () => {
    expectRejected(
      await appOne(A.tenantId, "INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 1)", [A.tenantId, A.itemId, A.unitId]),
      [CHECK_VIOLATION],
      "temel birim dönüşümü",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Lokasyon ağacı değişmezliği ve sayım kilidi satırı yaşam döngüsü (06 §Sayım kilidi yaşam döngüsü ilk madde)
// ---------------------------------------------------------------------------------------------
describe("Lokasyon ağacı ve sayım kilidi satırı", () => {
  it("lokasyon parent_id güncellemesi reddedilir: wms_app (sütun yetkisi yok, 42501) ve tablo sahibi (tetikleyici, 23514); depth/warehouse_id/id de", async () => {
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.locations SET parent_id = $2 WHERE id = $1", [A.childLocationId, null]),
      [INSUFFICIENT_PRIVILEGE],
      "wms_app parent_id=NULL",
    );
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.locations SET parent_id = $2 WHERE id = $1", [A.rootLocationId, A.childLocationId]),
      [INSUFFICIENT_PRIVILEGE],
      "wms_app kökü çocuğunun altına taşı (döngü)",
    );
    const ownerCases: Array<[string, string, unknown[]]> = [
      ["parent_id döngü (kök → kendi çocuğu)", "UPDATE public.locations SET parent_id = $2 WHERE id = $1", [A.rootLocationId, A.childLocationId]],
      ["parent_id NULL", "UPDATE public.locations SET parent_id = NULL, depth = 0 WHERE id = $1", [A.childLocationId]],
      ["depth", "UPDATE public.locations SET depth = 5 WHERE id = $1", [A.childLocationId]],
      ["id", "UPDATE public.locations SET id = $2 WHERE id = $1", [A.childLocationId, randomUUID()]],
    ];
    for (const [name, sql, p] of ownerCases) {
      expectRejected(await ownerOne(A.tenantId, sql, p), [CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE], `sahip: ${name}`);
    }
    // Ağaç alanları dışındaki alan (sahip) değişebilir: bekçi aşırı geniş değil.
    const ok = await ownerOne(A.tenantId, "UPDATE public.locations SET name = 'yeni ad' WHERE id = $1", [A.childLocationId]);
    expect(ok.ok && ok.rowCount === 1, fmt(ok)).toBe(true);
  });

  it("yeni lokasyonun IDLE kilit satırı AYNI transaction'da vardır (çok satırlı INSERT dahil); ROLLBACK'te lokasyon da kilit de yoktur", async () => {
    const l1 = randomUUID();
    const l2 = randomUUID();
    const l3 = randomUUID();
    const r = await attempt(app, A.tenantId, async (q) => {
      await q(
        `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
         VALUES ($1, $2, $4, NULL, $5, 'a', 0, 'RECEIVING'), ($1, $3, $4, NULL, $6, 'b', 0, 'STAGING')`,
        [A.tenantId, l1, l2, A.warehouseId, `R${rnd()}`, `R${rnd()}`],
      );
      await q(locInsert, [A.tenantId, l3, A.warehouseId, l1, `R${rnd()}`, 1]);
      const locks = await q(
        "SELECT location_id, status, count_session_id, locked_at, locked_by FROM public.location_count_locks WHERE location_id = ANY($1::uuid[]) ORDER BY location_id",
        [[l1, l2, l3]],
      );
      expect(locks.rows.length).toBe(3);
      for (const row of locks.rows) {
        expect({ status: row.status, s: row.count_session_id, a: row.locked_at, b: row.locked_by }).toEqual({ status: "IDLE", s: null, a: null, b: null });
      }
    });
    expect(r.ok, fmt(r)).toBe(true); // attempt ROLLBACK eder
    const after = await admin.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM public.location_count_locks WHERE location_id = ANY($1::uuid[]))::text
            || '/' || (SELECT count(*) FROM public.locations WHERE id = ANY($1::uuid[]))::text AS n`,
      [[l1, l2, l3]],
    );
    expect(after.rows[0]?.n).toBe("0/0");
  });

  it("COMMIT edilen lokasyonun kilit satırı kalıcıdır ve mevcut her fikstür lokasyonunun TAM BİR kilit satırı vardır", async () => {
    const id = randomUUID();
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      await app.query(locInsert, [A.tenantId, id, A.warehouseId, null, `C${rnd()}`, 0]);
      await app.query("COMMIT");
    } catch (e) {
      await app.query("ROLLBACK");
      throw e;
    }
    const r = await admin.query<{ status: string }>("SELECT status FROM public.location_count_locks WHERE location_id = $1", [id]);
    expect(r.rows).toEqual([{ status: "IDLE" }]);
    const orphan = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.locations l
        WHERE l.tenant_id = ANY($1::uuid[])
          AND (SELECT count(*) FROM public.location_count_locks k WHERE k.location_id = l.id AND k.tenant_id = l.tenant_id) <> 1`,
      [[A.tenantId, B.tenantId]],
    );
    expect(orphan.rows[0]?.n).toBe("0");
  });

  it("location_count_locks DELETE reddedilir: wms_app 42501 (satır var); wms_ops de yetkisiz", async () => {
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.location_count_locks WHERE location_id = $1", [A.rootLocationId]), [INSUFFICIENT_PRIVILEGE], "wms_app DELETE");
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.location_count_locks"), [INSUFFICIENT_PRIVILEGE], "wms_app toplu DELETE");
    expectRejected(await appOne(A.tenantId, "TRUNCATE public.location_count_locks"), [INSUFFICIENT_PRIVILEGE], "wms_app TRUNCATE");
    const ops = await attempt(admin, A.tenantId, async (q) => {
      await q("SET LOCAL ROLE wms_ops");
      return q("SELECT count(*) FROM public.location_count_locks");
    });
    expectRejected(ops, [INSUFFICIENT_PRIVILEGE], "wms_ops SELECT");
  });

  it("lokasyon DELETE'i uygulama rolünde yok (arşivlenir): 42501", async () => {
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.locations WHERE id = $1", [A.childLocationId]), [INSUFFICIENT_PRIVILEGE], "wms_app lokasyon DELETE");
    expectRejected(await appOne(A.tenantId, "DELETE FROM public.warehouses WHERE id = $1", [A.warehouseId]), [INSUFFICIENT_PRIVILEGE], "wms_app depo DELETE");
  });
});

// ---------------------------------------------------------------------------------------------
// 5. NULL-safe tekillik (ADR-011 §Sonuçlar; ADR-017 §1 modeli)
// ---------------------------------------------------------------------------------------------
describe("NULL-safe tekillik", () => {
  it("item_barcodes: birimi NULL iki aynı barkod satırı reddedilir (23505); farklı ürün/birim ve farklı barkod geçer", async () => {
    const code = `BC-${rnd()}`;
    const ins = "INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, $3, $4)";
    const dup = await attempt(app, A.tenantId, async (q) => {
      await q(ins, [A.tenantId, A.itemId, null, code]);
      await q(ins, [A.tenantId, A.itemId, null, code]);
    });
    expectRejected(dup, [UNIQUE_VIOLATION], "NULL birimli çift barkod");
    const dupUnit = await attempt(app, A.tenantId, async (q) => {
      await q(ins, [A.tenantId, A.itemId, A.boxUnitId, code]);
      await q(ins, [A.tenantId, A.itemId, A.boxUnitId, code]);
    });
    expectRejected(dupUnit, [UNIQUE_VIOLATION], "dolu birimli çift barkod");
    // Çok satırlı tek ifade de reddedilir.
    const multi = await appOne(
      A.tenantId,
      "INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3), ($1, $2, NULL, $3)",
      [A.tenantId, A.itemId, code],
    );
    expectRejected(multi, [UNIQUE_VIOLATION], "tek ifadede iki NULL birimli aynı barkod");
    const fine = await attempt(app, A.tenantId, async (q) => {
      await q(ins, [A.tenantId, A.itemId, null, code]);
      await q(ins, [A.tenantId, A.itemId, A.boxUnitId, code]); // aynı barkod başka birim: A-69
      await q(ins, [A.tenantId, A.itemTwoId, null, code]); // aynı barkod başka ürün: A-69
      await q(ins, [A.tenantId, A.itemId, null, `BC-${rnd()}`]);
    });
    expect(fine.ok, fmt(fine)).toBe(true);
  });

  it("@AC-04 aynı barkod B tenant'ında serbesttir (tekillik tenant içi; B satırı A ekleme denemesini engellemez)", async () => {
    const code = `BC-${rnd()}`;
    await admin.query("INSERT INTO public.item_barcodes (tenant_id, item_id, barcode) VALUES ($1, $2, $3)", [B.tenantId, B.itemId, code]);
    const r = await appOne(A.tenantId, "INSERT INTO public.item_barcodes (tenant_id, item_id, barcode) VALUES ($1, $2, $3)", [A.tenantId, A.itemId, code]);
    expect(r.ok, fmt(r)).toBe(true);
  });

  it("document_type_versions: NULL tenant'lı (sistem) aynı (key, version) ikinci kez eklenemez (UNIQUE NULLS NOT DISTINCT, 23505)", async () => {
    // Süper kullanıcı RLS'i aşar; tetikleyiciler yine çalışır. ROLLBACK'li.
    const r = await attempt(admin, null, (q) => q("INSERT INTO public.document_type_versions (tenant_id, key, version) VALUES (NULL, 'STOCK_IN', 1)"));
    expectRejected(r, [UNIQUE_VIOLATION], "sistem STOCK_IN v1 tekrarı");
  });
});

// ---------------------------------------------------------------------------------------------
// 6. ADR-011 taşıma birimi döngü reddi (sıralı + eşzamanlı)
// ---------------------------------------------------------------------------------------------
async function mkUnits(tenantId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    await admin.query("INSERT INTO public.handling_units (tenant_id, id, kind, code) VALUES ($1, $2, 'KOLI', $3)", [tenantId, id, `H${rnd()}`]);
    ids.push(id);
  }
  return ids;
}

async function parentOf(id: string): Promise<string | null> {
  const r = await admin.query<{ parent_id: string | null }>("SELECT parent_id FROM public.handling_units WHERE id = $1", [id]);
  return r.rows[0]?.parent_id ?? null;
}

/** Tenant'ın tüm taşıma birimi grafında döngü var mı (yalnızca yürüyüş; sınırlı adım). */
async function hasCycle(tenantId: string): Promise<boolean> {
  const r = await admin.query<{ id: string; parent_id: string | null }>("SELECT id, parent_id FROM public.handling_units WHERE tenant_id = $1", [tenantId]);
  const parent = new Map(r.rows.map((x) => [x.id, x.parent_id]));
  for (const start of parent.keys()) {
    let cur: string | null | undefined = start;
    for (let i = 0; i <= parent.size && cur != null; i++) cur = parent.get(cur);
    if (cur != null) return true;
  }
  return false;
}

describe("ADR-011 taşıma birimi döngü reddi", () => {
  it("A→B→C→A (sıralı, wms_app) ve kendi kendinin ebeveyni reddedilir; döngüsüz iç içe koyma (palet→koli→koli) geçer", async () => {
    const [a, b, c] = (await mkUnits(A.tenantId, 3)) as [string, string, string];
    const setParent = "UPDATE public.handling_units SET parent_id = $2 WHERE id = $1";
    const r = await attempt(app, A.tenantId, async (q) => {
      await q(setParent, [a, b]); // a ⊂ b
      await q(setParent, [b, c]); // b ⊂ c
      await q(setParent, [c, a]); // c ⊂ a  → döngü
    });
    expectRejected(r, [CHECK_VIOLATION], "A→B→C→A", /HANDLING_UNIT_CYCLE/);
    expectRejected(await appOne(A.tenantId, setParent, [a, a]), [CHECK_VIOLATION], "kendi kendinin ebeveyni");
    const iki = await attempt(app, A.tenantId, async (q) => {
      await q(setParent, [a, b]);
      await q(setParent, [b, c]);
    });
    expect(iki.ok, fmt(iki)).toBe(true);
    // Ebeveyni değiştirip köke döndürmek geçerlidir (taşıma serbest, döngü değil).
    const tasi = await attempt(app, A.tenantId, async (q) => {
      await q(setParent, [a, b]);
      await q(setParent, [a, null]);
      await q(setParent, [a, c]);
    });
    expect(tasi.ok, fmt(tasi)).toBe(true);
  });

  it("uzun zincirde (12 halka) kuyruk-başa bağlama döngüsü reddedilir", async () => {
    const ids = await mkUnits(A.tenantId, 12);
    for (let i = 0; i < ids.length - 1; i++) {
      await admin.query("UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [ids[i], ids[i + 1]]);
    }
    const r = await appOne(A.tenantId, "UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [ids[ids.length - 1], ids[0]]);
    expectRejected(r, [CHECK_VIOLATION], "12 halkalı zincirde döngü", /HANDLING_UNIT_CYCLE/);
    expect(await hasCycle(A.tenantId)).toBe(false);
  });

  it("iki EŞZAMANLI çapraz iç içe koyma (X⊂Y ∥ Y⊂X, iki gerçek wms_app bağlantısı, 20 tur): ikisi birden commit edemez, graf döngüsüz kalır", async () => {
    const a = await connect(env.databaseUrl);
    const b = await connect(env.databaseUrl);
    const outcomes: string[] = [];
    for (let round = 0; round < 20; round++) {
      const [x, y] = (await mkUnits(A.tenantId, 2)) as [string, string];
      // İki bağlantıyı önce hazırla, sonra UPDATE'leri aynı anda başlat.
      await Promise.all([a, b].map(async (cl) => {
        await cl.query("BEGIN");
        await cl.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      }));
      const step = async (cl: pg.Client, me: string, other: string): Promise<string> => {
        try {
          await cl.query("UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [me, other]);
          await cl.query("COMMIT");
          return "commit";
        } catch (e) {
          await cl.query("ROLLBACK");
          return (e as Err).code ?? "err";
        }
      };
      const res = await Promise.all([step(a, x, y), step(b, y, x)]);
      outcomes.push(res.join("+"));
      const commits = res.filter((r) => r === "commit").length;
      expect(commits, `tur ${round}: ikisi de commit etti (${res.join("+")}) — döngü oluşmuş olabilir`).toBeLessThanOrEqual(1);
      for (const r of res) expect(["commit", CHECK_VIOLATION, DEADLOCK], `tur ${round}: beklenmeyen sonuç ${r}`).toContain(r);
      const px = await parentOf(x);
      const py = await parentOf(y);
      expect(px === y && py === x, `tur ${round}: X⊂Y ve Y⊂X birlikte kalıcı`).toBe(false);
    }
    expect(await hasCycle(A.tenantId)).toBe(false);
    console.info(`[T-209] eşzamanlı döngü turları: ${outcomes.join(",")}`);
    // Yarış gerçekten oynandı mı: en az bir turda bir taraf commit etmiş olmalı (aksi halde test boş koşmuş olurdu).
    expect(outcomes.some((o) => o.includes("commit")), `hiçbir turda commit yok: ${outcomes.join(",")}`).toBe(true);
  }, 120_000);

  it("üçlü halka eşzamanlı (A⊂B ∥ B⊂C ∥ C⊂A; üç doğrudan bağlantı, SET LOCAL ROLE wms_app, 10 tur): üçü birden commit edemez, graf döngüsüz", async () => {
    const cls = await Promise.all([connect(env.databaseUrlDirect), connect(env.databaseUrlDirect), connect(env.databaseUrlDirect)]);
    for (let round = 0; round < 10; round++) {
      const ids = (await mkUnits(A.tenantId, 3)) as [string, string, string];
      await Promise.all(
        cls.map(async (cl) => {
          await cl.query("BEGIN");
          await cl.query(`SET LOCAL ROLE ${APP_ROLE}`);
          await cl.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
        }),
      );
      const res = await Promise.all(
        cls.map(async (cl, i) => {
          try {
            await cl.query("UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [ids[i], ids[(i + 1) % 3]]);
            await cl.query("COMMIT");
            return "commit";
          } catch (e) {
            await cl.query("ROLLBACK");
            return (e as Err).code ?? "err";
          }
        }),
      );
      expect(res.filter((r) => r === "commit").length, `tur ${round}: üçü de commit etti (${res.join("+")})`).toBeLessThanOrEqual(2);
      for (const r of res) expect(["commit", CHECK_VIOLATION, DEADLOCK], `tur ${round}: beklenmeyen ${r}`).toContain(r);
      expect(await hasCycle(A.tenantId), `tur ${round}: döngü kalıcı`).toBe(false);
    }
  }, 120_000);

  it("@AC-04 B'nin taşıma birimi A birimine ebeveyn yapılamaz ve zincir yürüyüşü başka tenant'a sızmaz (23503)", async () => {
    const [a] = (await mkUnits(A.tenantId, 1)) as [string];
    expectRejected(
      await appOne(A.tenantId, "UPDATE public.handling_units SET parent_id = $2 WHERE id = $1", [a, B.handlingUnitId]),
      [FK_VIOLATION],
      "A birimi → B ebeveyni",
    );
  });
});
