// T-210: `wms/stock-sql-guard` lint kuralı (I-04, I-15, G-01). Repo ESLint yapılandırması Node API'siyle yüklenir; içerik `lintText` ile
// sanal yol altında lint edilir (diske dosya YAZILMAZ; tests/unit/ac/ac-28-lint.test.ts deseni). İzinler DOSYA düzeyindedir (dizin değil).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RULE = "wms/stock-sql-guard";
const at = (rel: string): string => path.join(REPO_ROOT, rel);

const LOCKING = "packages/db/src/locking.ts";
const POSTING = "packages/domain/src/stock/posting.ts";
const CONSISTENCY = "packages/domain/src/stock/consistency.ts";
const SERIALS = "packages/domain/src/catalog/serials.ts";
const DB_OTHER = "packages/db/src/queries-probe.ts";
const AUTH_INDEX = "packages/auth/src/index.ts";

let eslint: ESLint;
beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT });
  // İlk lintText yapılandırmayı yükler (yük altında saniyeler sürer); ısınma beforeAll zaman aşımında (60 sn) yapılır, vaka sınırında değil.
  await eslint.lintText("export {};\n", { filePath: at("packages/domain/src/__stock_sql_warmup__.ts"), warnIgnored: true });
}, 60_000);

/** Yalnızca bu kuralın mesajları. */
async function hits(source: string, rel: string): Promise<string[]> {
  // locking.ts'te (d) kuralı gereği sabit dışa aktarılamaz; SQL örnekleri orada dışa aktarımsız denenir.
  const code = rel === LOCKING ? source.replace(/^export const q/m, "const q") : source;
  const results = await eslint.lintText(code, { filePath: at(rel), warnIgnored: true });
  expect(results).toHaveLength(1);
  return (results[0] as ESLint.LintResult).messages.filter((m) => m.ruleId === RULE).map((m) => `${m.line}:${m.severity}`);
}

const q = (s: string): string => `export const q = ${s};\n`;
const LOCK_SQL = q("`SELECT * FROM public.stock_balances WHERE stock_dimension_id = ANY($1) ORDER BY stock_dimension_id FOR UPDATE`");

describe("(a) FOR UPDATE / FOR SHARE yalnızca locking.ts", () => {
  it("locking.ts'te temiz", async () => {
    expect(await hits(LOCK_SQL, LOCKING)).toEqual([]);
  });
  it.each([POSTING, CONSISTENCY, DB_OTHER, "apps/web/lib/x.ts"])("%s içinde ihlal", async (rel) => {
    expect(await hits(LOCK_SQL, rel)).toEqual(["1:2"]);
  });
  it.each([
    ["FOR SHARE", q('"SELECT 1 FROM location_count_locks WHERE location_id = $1 FOR SHARE"')],
    ["FOR NO KEY UPDATE", q('"SELECT 1 FROM stock_dimensions FOR NO KEY UPDATE"')],
    ["FOR KEY SHARE", q('"SELECT 1 FROM reservations FOR KEY SHARE"')],
    ["küçük harf + public + tırnak", q('"select 1 from \\"public\\".\\"stock_ledger\\" for update"')],
    ["serials da kilit kuralındadır", q('"SELECT id FROM public.serials WHERE id = $1 FOR UPDATE"')],
    ["+ birleştirme", q('"SELECT 1 FROM stock_balances " + "FOR UP" + "DATE"')],
    ["ifadeli şablon", q("`SELECT 1 FROM stock_balances WHERE id = ${1} FOR UPDATE`")],
  ])("%s", async (_n, code) => {
    expect(await hits(code, CONSISTENCY)).toHaveLength(1);
  });
  it("stok tablosu olmayan sorguda FOR UPDATE serbest (kapsam dar)", async () => {
    expect(await hits(q('"SELECT 1 FROM public.tenants WHERE id = $1 FOR UPDATE"'), "packages/db/src/with-membership.ts")).toEqual([]);
  });
  it("kilitsiz okuma yolu (SELECT) temiz", async () => {
    expect(await hits(q('"SELECT quantity FROM public.stock_balances WHERE tenant_id = $1"'), CONSISTENCY)).toEqual([]);
  });
});

describe("(b) INSERT/UPDATE/DELETE yalnızca STOCK_WRITE_FILES (dosya düzeyi)", () => {
  const WRITES: [string, string][] = [
    ["INSERT", q('"INSERT INTO public.stock_ledger (tenant_id) VALUES ($1)"')],
    ["UPDATE", q('"UPDATE stock_balances SET quantity = quantity + 1"')],
    ["UPDATE ONLY", q('"update only public.reservations set status = $1"')],
    ["DELETE", q('"DELETE FROM location_count_locks"')],
    ["INSERT stock_dimensions", q('"INSERT INTO stock_dimensions (tenant_id) VALUES ($1)"')],
    ["şablon", q("`UPDATE public.stock_balances SET quantity = ${1}`")],
    ["+ birleştirme", q('"UPDATE " + "stock_balances SET quantity = 0"')],
  ];
  it.each(["packages/db/src/locking.ts", POSTING, "packages/domain/src/stock/reservations.ts", "packages/domain/src/stock/reversal.ts"])(
    "izinli dosya %s temiz",
    async (rel) => {
      for (const [, code] of WRITES) expect(await hits(code, rel)).toEqual([]);
    },
  );
  it.each(WRITES)("consistency.ts içinde %s → ihlal (dizin değil dosya izni)", async (_n, code) => {
    expect(await hits(code, CONSISTENCY)).toHaveLength(1);
  });
  it.each(["packages/domain/src/stock/posting/helper.ts", "packages/domain/src/stock/posting.helper.ts", "packages/db/src/other.ts", "apps/web/lib/a.ts"])(
    "izinli dosyanın komşusu/alt yolu %s → ihlal",
    async (rel) => {
      expect(await hits(q('"INSERT INTO stock_ledger (tenant_id) VALUES ($1)"'), rel)).toHaveLength(1);
    },
  );
  it("serials yazımı (b) dışındadır: katalog dosyasında INSERT temiz", async () => {
    expect(await hits(q('"INSERT INTO public.serials (tenant_id, id) VALUES ($1, $2)"'), SERIALS)).toEqual([]);
  });
  it("tests/** kapsam dışı (fikstürler migration rolüyle yazar)", async () => {
    expect(await hits(q('"INSERT INTO public.stock_ledger (tenant_id) VALUES ($1)"'), "tests/integration/fixtures/x.ts")).toEqual([]);
  });
  it("benzer ad (stock_ledger_archive, reservations_view) ihlal sayılmaz", async () => {
    expect(await hits(q('"INSERT INTO stock_ledger_archive (a) VALUES (1)"'), CONSISTENCY)).toEqual([]);
  });
});

describe("(c) şema nesnesi importu", () => {
  const FORBIDDEN: [string, string][] = [
    ["adlandırılmış", 'import { stockBalances } from "@wms/db/internal/schema";\nexport const t = stockBalances;\n'],
    ["takma adlı", 'import { stockLedger as l } from "@wms/db/internal/schema";\nexport const t = l;\n'],
    ["ad alanı", 'import * as schema from "@wms/db/internal/schema";\nexport const t = schema;\n'],
    ["yeniden dışa aktarım", 'export { reservations } from "@wms/db/internal/schema";\n'],
    ["export *", 'export * from "@wms/db/internal/schema";\n'],
    ["dinamik import", 'export const m = () => import("@wms/db/internal/schema");\n'],
    ["dosya yolu (stock.ts)", 'import { stockDimensions } from "../../../db/src/schema/stock.ts";\nexport const t = stockDimensions;\n'],
    ["dosya yolu normalize edilmemiş", 'import { locationCountLocks } from "../../../db/src/./schema//warehouse.ts";\nexport const t = locationCountLocks;\n'],
    ["depo-göreli yol", 'import { stockDimensions } from "packages/db/src/schema/stock";\nexport const t = stockDimensions;\n'],
  ];
  it.each(FORBIDDEN)("domain dosyasında %s → ihlal", async (_n, code) => {
    expect((await hits(code, CONSISTENCY)).length).toBeGreaterThanOrEqual(1);
  });
  it.each(FORBIDDEN.slice(0, 7))("izinli yazma dosyasında %s temiz", async (_n, code) => {
    expect(await hits(code, POSTING)).toEqual([]);
  });
  it("T-238 (MINOR-5): serbest dizin yalnızca packages/db/src/schema/; db paketindeki diğer dosyalar artık serbest değildir", async () => {
    const imp = 'import { stockBalances } from "./schema/stock.ts";\nexport const t = stockBalances;\n';
    expect(await hits(imp, DB_OTHER)).toHaveLength(1);
    expect(await hits('import { stockBalances } from "./stock.ts";\nexport const t = stockBalances;\n', "packages/db/src/schema/other.ts")).toEqual([]);
    expect(await hits('export * from "./stock.ts";\nexport * from "./warehouse.ts";\n', "packages/db/src/schema/index.ts")).toEqual([]);
  });
  it("stok olmayan şema nesneleri (kimlik, katalog) ve tipler serbest", async () => {
    const code = 'import { users, type StockStatus } from "@wms/db/internal/schema";\nexport const t = [users, null as StockStatus | null];\n';
    expect(await hits(code, CONSISTENCY)).toEqual([]);
  });
  it("auth/src/index.ts: yalnızca ad alanı importu istisnadır", async () => {
    // T-238: ad alanı nesnesi başka değişkene atanamaz; örnek, nesneyi özellik olarak geçirir (gerçek kullanım: `{ schema }`).
    expect(await hits('import * as schema from "@wms/db/internal/schema";\nexport const t = { schema };\n', AUTH_INDEX)).toEqual([]);
    expect(await hits('import { stockBalances } from "@wms/db/internal/schema";\nexport const t = stockBalances;\n', AUTH_INDEX)).toHaveLength(1);
    expect(await hits('import * as schema from "@wms/db/internal/schema";\nexport const t = schema;\n', "packages/auth/src/other.ts")).toHaveLength(1);
  });
});

describe("(d) locking.ts dışa aktarımı", () => {
  it.each([
    ["alt adım işlevi", "export async function lockBalances(): Promise<void> {}\n"],
    ["sabit", "export const X = 1;\n"],
    ["liste", "const a = 1;\nexport { a };\n"],
    ["varsayılan", "export default function f(): void {}\n"],
    ["export *", 'export * from "./client.ts";\n'],
    ["yeniden dışa aktarım", 'export { rawDb } from "./client.ts";\n'],
    ["sınıf", "export class StockLockError extends Error {}\n"],
  ])("%s → ihlal", async (_n, code) => {
    expect(await hits(code, LOCKING)).toHaveLength(1);
  });
  it("acquireStockLocks ve tipler temiz", async () => {
    const code = [
      "export interface StockLockPlan { readonly a: number }",
      "export type LockedState = { readonly b: number };",
      "const impl = 1;",
      "export type { impl as ImplType };",
      "export async function acquireStockLocks(): Promise<void> {}",
      "",
    ].join("\n");
    expect(await hits(code, LOCKING)).toEqual([]);
  });
  it("aynı dışa aktarımlar başka dosyada (d) ihlali değildir", async () => {
    expect(await hits("export const X = 1;\n", "packages/db/src/other.ts")).toEqual([]);
  });
});

describe("inceleme MAJOR-1: MERGE INTO", () => {
  it.each([
    ["MERGE INTO stock_balances", q('"MERGE INTO stock_balances b USING x ON (b.id = x.id) WHEN MATCHED THEN UPDATE SET quantity = 0"')],
    ["merge into public.reservations", q('"merge into public.reservations r using x on (true) when matched then delete"')],
    ["MERGE INTO stock_ledger (şablon)", q("`MERGE INTO stock_ledger l USING x ON (${1} = 1) WHEN NOT MATCHED THEN INSERT DEFAULT VALUES`")],
  ])("%s consistency.ts içinde → ihlal", async (_n, code) => {
    expect(await hits(code, CONSISTENCY)).toHaveLength(1);
  });
  it("izinli yazma dosyasında MERGE temiz", async () => {
    expect(await hits(q('"MERGE INTO stock_balances b USING x ON (true) WHEN MATCHED THEN DELETE"'), POSTING)).toEqual([]);
  });
});

describe("inceleme MAJOR-2: Drizzle ile atlatma", () => {
  it.each([
    ["sql.identifier", 'import { sql } from "drizzle-orm";\nexport const q = sql`SELECT 1 FROM ${sql.identifier("stock_balances")}`;\n'],
    ["sql.identifier (public.)", 'import { sql } from "drizzle-orm";\nexport const q = sql.identifier("stock_ledger");\n'],
    ["pgTable", 'import { pgTable, uuid } from "drizzle-orm/pg-core";\nexport const t = pgTable("stock_balances", { id: uuid("id") });\n'],
    ["pgTable (reservations)", 'import { pgTable, uuid } from "drizzle-orm/pg-core";\nexport const t = pgTable("reservations", { id: uuid("id") });\n'],
  ])("%s consistency.ts içinde → ihlal", async (_n, code) => {
    expect(await hits(code, CONSISTENCY)).toHaveLength(1);
  });
  it("sql.identifier ve pgTable izinli yazma dosyasında temiz; pgTable şema tanım dosyasında temiz", async () => {
    expect(await hits('import { sql } from "drizzle-orm";\nexport const q = sql.identifier("stock_balances");\n', POSTING)).toEqual([]);
    const def = 'import { pgTable, uuid } from "drizzle-orm/pg-core";\nexport const t = pgTable("stock_balances", { id: uuid("id") });\n';
    expect(await hits(def, "packages/db/src/schema/stock.ts")).toEqual([]);
    expect(await hits(def, "packages/db/src/schema/other.ts")).toHaveLength(1);
  });
  it("sql.identifier stok olmayan tabloda serbest", async () => {
    expect(await hits('import { sql } from "drizzle-orm";\nexport const q = sql.identifier("users");\n', CONSISTENCY)).toEqual([]);
  });
  it.each([
    ["update", 'export const f = (qb: any) => qb.for("update");\n'],
    ["share", 'export const f = (qb: any) => qb.for("share", { of: null });\n'],
    ["no key update", 'export const f = (qb: any) => qb.for("no key update");\n'],
    ["key share", 'export const f = (qb: any) => qb.for("key share");\n'],
    ["büyük harf", 'export const f = (qb: any) => qb.for("UPDATE");\n'],
    ["değişkenli mod", "export const f = (qb: any, m: string) => qb.for(m);\n"],
  ])(".for(%s) locking.ts dışında → ihlal", async (_n, code) => {
    expect(await hits(code, CONSISTENCY)).toHaveLength(1);
  });
  it(".for(...) locking.ts içinde temiz; Symbol.for her yerde serbest", async () => {
    expect(await hits('const f = (qb: any) => qb.for("update");\nvoid f;\n', LOCKING)).toEqual([]);
    expect(await hits('export const k = Symbol.for("@wms/x");\n', CONSISTENCY)).toEqual([]);
  });
  it.each([
    ["değişkenle tablo + yazma fiili (şablon)", 'import { sql } from "drizzle-orm";\nconst t = "stock_balances";\nexport const q = (x: number) => sql`UPDATE ${sql.raw(t)} SET quantity = ${x}`;\n'],
    ["değişkenle birleştirme", 'const t = "stock_ledger";\nexport const q = (tbl: string) => "INSERT INTO " + tbl + " (a) VALUES (1)";\nexport const r = t;\n'],
    ["şablonda tablo değişkeni, kilit", 'const t = "stock_balances";\nexport const q = (tbl: string) => `SELECT 1 FROM ${tbl} FOR UPDATE`;\nexport const r = t;\n'],
    ["MERGE değişkenli", 'const t = "reservations";\nexport const q = (tbl: string) => `MERGE INTO ${tbl} USING x ON true WHEN MATCHED THEN DELETE`;\nexport const r = t;\n'],
  ])("%s → ihlal", async (_n, code) => {
    expect((await hits(code, CONSISTENCY)).length).toBeGreaterThanOrEqual(1);
  });
  it("dinamik şablon ama dosyada stok tablosu adı yok → temiz (bilinen sınır: ad başka dosyadan gelirse yakalanmaz)", async () => {
    expect(await hits('export const q = (tbl: string) => `UPDATE ${tbl} SET a = 1`;\n', CONSISTENCY)).toEqual([]);
  });
  it("dinamik yazma izinli dosyada temiz", async () => {
    expect(await hits('const t = "stock_balances";\nexport const q = (tbl: string) => `UPDATE ${tbl} SET a = 1`;\nexport const r = t;\n', POSTING)).toEqual([]);
  });
});

describe("inceleme MINOR-1: auth ad alanı üye erişimi", () => {
  const NS = 'import * as schema from "@wms/db/internal/schema";\n';
  it.each([
    ["schema.stockBalances", `${NS}export const t = schema.stockBalances;\n`],
    ['schema["stockLedger"]', `${NS}export const t = schema["stockLedger"];\n`],
    ["schema[dinamik]", `${NS}export const t = (k: string) => (schema as Record<string, unknown>)[k];\n`],
    ["yapı bozma", `${NS}export const { reservations } = schema;\n`],
    ["yapı bozma + rest", `${NS}export const { users, ...rest } = schema;\nexport const r = rest;\n`],
  ])("auth/src/index.ts içinde %s → ihlal", async (_n, code) => {
    expect((await hits(code, AUTH_INDEX)).length).toBeGreaterThanOrEqual(1);
  });
  it("kimlik tablosu üye erişimi temiz", async () => {
    expect(await hits(`${NS}export const t = schema.users;\nexport const { sessions } = schema;\n`, AUTH_INDEX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// T-238 (T-210 son inceleme MINOR-1/2/3/5/6): kasıtlı dolambaçlar. Her ihlal sınıfı için yanlış pozitif olmayan örnek de vardır.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("T-238: tablo adı taşıma (sabit modülü, takma ad, join, sql.raw)", () => {
  it.each([
    ["sabit modülü", 'export const T = "stock_balances";\n'],
    ["public. önekli", 'export const T = "public.stock_ledger";\n'],
    ["çift tırnaklı", 'export const T = "\\"reservations\\"";\n'],
    ["serials (kilit tablosu)", 'export const T = "serials";\n'],
    ["boşluklu, büyük harf", 'export const T = "  STOCK_DIMENSIONS ";\n'],
    ["şablon (ifadesiz)", "export const T = `location_count_locks`;\n"],
    ["şablon parçası (ifadeli)", "export const q = (p: string) => `${p}stock_balances${p}`;\n"],
    ["+ ile bölünmüş", 'export const T = "stock_" + "ledger";\n'],
    ["+ zincirinde yaprak", 'export const q = (p: string) => p + "stock_balances";\n'],
    ["join (fiil dizisi)", 'export const q = ["UPDATE", "stock_balances"].join(" ");\n'],
    ["join (ad değişkenle)", 'const t = "stock_balances";\nexport const q = ["UPDATE", t].join(" ");\n'],
    ["sql.identifier(sabit)", 'import { sql } from "drizzle-orm";\nconst T = "stock_balances";\nexport const q = sql.identifier(T);\n'],
    ["sql.raw(birleştirme)", 'import { sql } from "drizzle-orm";\nconst T = "stock_balances";\nexport const q = sql.raw("UPDATE " + T);\n'],
    ["özellik anahtarı", 'export const m = { "stock_balances": 1 };\n'],
    ["yorum içeren ad", 'export const T = "/* x */ stock_balances";\n'],
  ])("consistency.ts içinde %s → ihlal", async (_n, code) => {
    expect((await hits(code, CONSISTENCY)).length).toBeGreaterThanOrEqual(1);
  });
  it("tüketici dosya (ad başka modülden gelir) tek başına temizdir: ihlal sabiti tutan modüldedir (bilinen sınır: izinli dosyadan dışa aktarılan sabit)", async () => {
    const consumer = 'import { sql } from "drizzle-orm";\nimport { T } from "./tables.ts";\nexport const q = sql.identifier(T);\nexport const r = sql.raw("UPDATE " + T);\nexport const j = ["UPDATE", T].join(" ");\n';
    expect(await hits(consumer, CONSISTENCY)).toEqual([]);
  });
  it.each([
    ["benzer ad (_view, _archive)", 'export const a = ["stock_balances_view", "stock_ledger_archive", "reservations_total"];\n'],
    ["ad başka metnin içinde", 'export const a = "my stock_balances note";\n'],
    ["stok olmayan tablo adları", 'export const a = ["users", "items", "documents", "locations", "serial"];\n'],
    ["şablon: ad yalnızca parça sonekinde", "export const q = (p: string) => `${p}_stock_balances`;\n"],
    ["yorumdaki ad", "// stock_balances\n/* reservations */\nexport const a = 1;\n"],
    ["alan adı (nav)", 'export const nav = [{ key: "reservations", href: "/r" }, { key: "serials" }];\n'],
    ["alan adı listesi", 'export const keys = ["serials", "lots"];\n'],
    ["yetki kaynağı", 'export const p = { resource: "reservations", action: "read" };\n'],
    ["çağrı argümanı (SQL dışı)", 'declare function can(r: string): boolean;\nexport const ok = can("reservations");\n'],
    ["karşılaştırma", 'export const f = (r: string) => r === "reservations";\n'],
    ["tür düzeyi şablon", 'export type K = `${"a" | "b"}_x`;\n'],
  ])("yanlış pozitif yok: %s", async (_n, code) => {
    expect(await hits(code, CONSISTENCY)).toEqual([]);
  });
  it("izinli yazma dosyalarında ve şema tanım dosyalarında tam ad serbest; başka şema dosyasında değil", async () => {
    for (const rel of [LOCKING, POSTING, "packages/domain/src/stock/reservations.ts", "packages/domain/src/stock/reversal.ts", "packages/db/src/schema/stock.ts", "packages/db/src/schema/warehouse.ts"]) {
      // locking.ts'te (d) kuralı gereği dışa aktarım yoktur; dışa aktarımsız biçim tüm izinli dosyalarda denenir.
      expect(await hits('const T = "stock_balances";\nvoid T;\n', rel)).toEqual([]);
    }
    // catalog.ts yalnızca `serials` tanımı için izinlidir; yazma tablosu adı orada da ihlaldir.
    expect(await hits('export const T = "serials";\n', "packages/db/src/schema/catalog.ts")).toEqual([]);
    expect(await hits('export const T = "stock_balances";\n', "packages/db/src/schema/catalog.ts")).toHaveLength(1);
    expect(await hits('export const T = "serials";\n', "packages/db/src/schema/other.ts")).toHaveLength(1);
  });
  it("tests/** kapsam dışı", async () => {
    expect(await hits('export const T = "stock_balances";\n', "tests/integration/fixtures/x.ts")).toEqual([]);
  });
});

describe("T-238: pgTable takma adı", () => {
  it.each([
    ["import as", 'import { pgTable as tbl, uuid } from "drizzle-orm/pg-core";\nexport const t = tbl("x", { id: uuid("id") });\n'],
    ["import as + stok adı", 'import { pgTable as tbl, uuid } from "drizzle-orm/pg-core";\nexport const t = tbl("stock_balances", { id: uuid("id") });\n'],
    ["yapı bozma takma adı", 'import * as pg from "drizzle-orm/pg-core";\nconst { pgTable: tbl } = pg;\nexport const t = tbl("x", {});\n'],
  ])("consistency.ts içinde %s → ihlal", async (_n, code) => {
    expect((await hits(code, CONSISTENCY)).length).toBeGreaterThanOrEqual(1);
  });
  it("yanlış pozitif yok: takmasız pgTable (stok olmayan), diğer içe aktarımlar takma adlı olabilir", async () => {
    expect(await hits('import { pgTable, uuid } from "drizzle-orm/pg-core";\nexport const t = pgTable("widgets", { id: uuid("id") });\n', CONSISTENCY)).toEqual([]);
    expect(await hits('import { uuid as u, text as tx } from "drizzle-orm/pg-core";\nexport const c = [u, tx];\n', CONSISTENCY)).toEqual([]);
    // Bilinen sınır: `const tbl = pgTable` tek başına ihlal değildir (AC-28 örneği); `const tbl = pgTable` sonrası `tbl("…")` bilinen sınırdır (kural yorumu).
    expect(await hits('import { pgTable } from "drizzle-orm/pg-core";\nexport const t = pgTable;\n', CONSISTENCY)).toEqual([]);
    // (`const tbl = pgTable; tbl("stock_balances")` kural yorumundaki bilinen sınırlardandır: tam-ad kuralı yalnızca SQL'e ulaşan bağlamlarda çalışır.)
  });
  it("şema tanım dosyası ve izinli dosyada takma ad serbest", async () => {
    const code = 'import { pgTable as tbl, uuid } from "drizzle-orm/pg-core";\nexport const t = tbl("x", { id: uuid("id") });\n';
    expect(await hits(code, "packages/db/src/schema/stock.ts")).toEqual([]);
    expect(await hits(code, POSTING)).toEqual([]);
  });
});

describe("T-238: hesaplanmış .for üyesi ve yorumla bölünmüş SQL", () => {
  it.each([
    ['qb["for"]("update")', 'export const f = (qb: any) => qb["for"]("update");\n'],
    ["qb[`for`](share)", 'export const f = (qb: any) => qb[`for`]("share");\n'],
    ['qb["for"](değişkenli mod)', 'export const f = (qb: any, m: string) => qb["for"](m);\n'],
    ['qb?.["for"]("update")', 'export const f = (qb: any) => qb?.["for"]("update");\n'],
    ["qb[k]('update') (statik olmayan üye)", 'export const f = (qb: any, k: string) => qb[k]("update");\n'],
    ["qb[k]('NO KEY UPDATE')", 'export const f = (qb: any, k: string) => qb[k]("NO KEY UPDATE");\n'],
  ])("%s locking.ts dışında → ihlal", async (_n, code) => {
    expect(await hits(code, CONSISTENCY)).toHaveLength(1);
  });
  it("yanlış pozitif yok: ilgisiz hesaplanmış üyeler, Symbol[\"for\"], kilit kipi olmayan argüman; locking.ts içinde temiz", async () => {
    expect(await hits('export const a = (o: any, k: string) => [o["map"](1), o[k](1), o["for"]("each"), o[k]("x")];\n', CONSISTENCY)).toEqual([]);
    expect(await hits('export const s = Symbol["for"]("@wms/x");\n', CONSISTENCY)).toEqual([]);
    expect(await hits('const f = (qb: any) => qb["for"]("update");\nvoid f;\n', LOCKING)).toEqual([]);
  });
  it.each([
    ["UPDATE /**/ tablo", q('"UPDATE /**/ stock_balances SET quantity = 0"')],
    ["UPDATE /* x */ ONLY tablo", q('"UPDATE /* x */ ONLY /* y */ stock_balances SET quantity = 0"')],
    ["iç içe blok yorum", q('"UPDATE /* a /* b */ c */ stock_balances SET quantity = 0"')],
    ["satır yorumu + yeni satır", q('"UPDATE -- x\\n stock_balances SET quantity = 0"')],
    ["INSERT INTO /**/ tablo", q('"INSERT INTO/**/stock_ledger (a) VALUES (1)"')],
    ["DELETE FROM /**/ tablo", q('"DELETE /**/ FROM /**/ reservations"')],
    ["şablon + yorum", q("`UPDATE /**/ public.stock_balances SET quantity = ${1}`")],
    ["FOR /**/ UPDATE", q('"SELECT 1 FROM stock_balances FOR /**/ UPDATE"')],
    ["FOR -- yorum UPDATE", q('"SELECT 1 FROM stock_balances FOR -- x\\n UPDATE"')],
  ])("consistency.ts içinde %s → ihlal", async (_n, code) => {
    expect((await hits(code, CONSISTENCY)).length).toBeGreaterThanOrEqual(1);
  });
  it("yanlış pozitif yok: yorum içeren stok dışı SQL ve yorumla ayrılmış ilgisiz sözcükler; izinli dosyada yorumlu yazma temiz", async () => {
    expect(await hits(q('"UPDATE /* not */ users SET a = 1 -- stock"'), CONSISTENCY)).toEqual([]);
    expect(await hits(q('"SELECT 1 /* UPDATE */ FROM stock_balances_view"'), CONSISTENCY)).toEqual([]);
    expect(await hits(q('"UPDATE /**/ stock_balances SET quantity = 0"'), POSTING)).toEqual([]);
    expect(await hits(q('"SELECT 1 FROM stock_balances FOR /**/ UPDATE"'), LOCKING)).toEqual([]);
  });
});

describe("T-238: auth ad alanı nesnesi başka değişkene atanamaz", () => {
  const NS = 'import * as schema from "@wms/db/internal/schema";\n';
  it.each([
    ["const s = schema", `${NS}const s = schema;\nexport const t = s.stockBalances;\n`],
    ["const s = schema as X", `${NS}const s = schema as Record<string, unknown>;\nexport const t = s;\n`],
    ["const s = schema!", `${NS}const s = schema!;\nexport const t = s;\n`],
    ["const s = c ? schema : null", `${NS}const s = Math.random() > 0.5 ? schema : null;\nexport const t = s;\n`],
    ["const s = x || schema", `${NS}const s = (globalThis as any).x || schema;\nexport const t = s;\n`],
    ["const s = (0, schema)", `${NS}const s = (0, schema);\nexport const t = s;\n`],
    ["let s; s = schema", `${NS}let s: unknown;\ns = schema;\nexport const t = s;\n`],
  ])("auth/src/index.ts içinde %s → ihlal", async (_n, code) => {
    expect((await hits(code, AUTH_INDEX)).length).toBeGreaterThanOrEqual(1);
  });
  it("yanlış pozitif yok: üye erişimi, yapı bozma, nesne özelliği olarak geçirme, çağrı argümanı, ilgisiz değişkenler", async () => {
    const code = [
      NS,
      "const users = schema.users;",
      "const { sessions } = schema;",
      "const cfg = { schema };",
      "declare function use(x: unknown): unknown;",
      "const used = use(schema);",
      "const other = 1;",
      "let again: unknown;",
      "again = other;",
      "export const all = [users, sessions, cfg, used, again];",
      "",
    ].join("\n");
    expect(await hits(code, AUTH_INDEX)).toEqual([]);
  });
  it("ad alanı atama kuralı başka dosyalarda geçerli değildir (ad alanı importunun kendisi zaten ihlal)", async () => {
    expect(await hits("const schema = { a: 1 };\nconst s = schema;\nexport const t = s;\n", "packages/auth/src/other.ts")).toEqual([]);
  });
});

describe("T-238: (iv) yalnızca tablo konumu dinamik olan şablonlar", () => {
  const READ = 'export const r = (a: string) => `SELECT quantity FROM public.stock_balances WHERE tenant_id = ${a}`;\n';
  it.each([
    ["UPDATE public.items + stok SELECT", `${READ}export const u = (x: string, y: string) => \`UPDATE public.items SET name = \${x} WHERE id = \${y}\`;\n`],
    ["INSERT INTO public.warehouses + stok SELECT", `${READ}export const i = (a: string, b: string) => \`INSERT INTO public.warehouses (code, name) VALUES (\${a}, \${b})\`;\n`],
    ["FROM public.lots FOR SHARE + serials SELECT", 'export const k = "SELECT id FROM public.serials WHERE lot_id IS NULL";\nexport const l = (a: string) => `SELECT id FROM public.lots WHERE id = ${a} FOR SHARE`;\n'],
    ["stok SELECT + stok dışı DELETE", `${READ}export const d = (a: string) => \`DELETE FROM public.locations WHERE id = \${a}\`;\n`],
  ])("consistency.ts içinde %s → temiz", async (_n, code) => {
    expect(await hits(code, CONSISTENCY)).toEqual([]);
  });
  it.each([
    ["UPDATE ${T}", 'const T = "stock_balances";\nexport const q = (x: number) => `UPDATE ${T} SET quantity = ${x}`;\n'],
    ["sql.identifier(t) şablonu", 'import { sql } from "drizzle-orm";\nconst t = "stock_ledger";\nexport const q = sql`INSERT INTO ${sql.identifier(t)} (a) VALUES (1)`;\n'],
    ["FROM ${T} ... FOR UPDATE", 'const T = "stock_balances";\nexport const q = (a: string) => `SELECT 1 FROM ${T} WHERE id = ${a} FOR UPDATE`;\n'],
    ["FROM public.${T} FOR SHARE", 'const T = "reservations";\nexport const q = `SELECT 1 FROM public.${T} FOR SHARE`;\n'],
    ["JOIN ${T} FOR UPDATE", 'const T = "stock_dimensions";\nexport const q = `SELECT 1 FROM x JOIN ${T} ON true FOR UPDATE`;\n'],
  ])("consistency.ts içinde %s → ihlal", async (_n, code) => {
    expect((await hits(code, CONSISTENCY)).length).toBeGreaterThanOrEqual(1);
  });
});
