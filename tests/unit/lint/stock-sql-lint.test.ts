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
  it("packages/db/src altında şema importu serbest", async () => {
    expect(await hits('import { stockBalances } from "./schema/stock.ts";\nexport const t = stockBalances;\n', DB_OTHER)).toEqual([]);
  });
  it("stok olmayan şema nesneleri (kimlik, katalog) ve tipler serbest", async () => {
    const code = 'import { users, type StockStatus } from "@wms/db/internal/schema";\nexport const t = [users, null as StockStatus | null];\n';
    expect(await hits(code, CONSISTENCY)).toEqual([]);
  });
  it("auth/src/index.ts: yalnızca ad alanı importu istisnadır", async () => {
    expect(await hits('import * as schema from "@wms/db/internal/schema";\nexport const t = schema;\n', AUTH_INDEX)).toEqual([]);
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
