// AC-28 (lint kısmı) — bağımsız kabul testi (T-005c, qa-verifier). `pnpm verify` unit adımında koşar.
//
// AC-28: Tenant modülünde `withTenant` dışında global istemci kullanılır → lint CI'da hata verir.
// Repo ESLint yapılandırması (eslint.config.mjs) Node API'siyle yüklenir; içerik `lintText` ile
// sanal bir yol altında lint edilir (diske dosya YAZILMAZ). Kural kimliği T-005b'ninkidir:
// `no-restricted-imports`.
//
// T-005g eklemeleri (yalnızca ekleme; yukarıdaki vakalar değişmedi): dinamik biçimler
// (`import()`, `require`, `createRequire`) ve tenant bağlam ayarı dizeleri → `no-restricted-syntax`;
// genişletilmiş küme (pg-pool, drizzle sürücü alt yolları, göreli node_modules) → `no-restricted-imports`;
// kapsam `scripts/` ve `tests/unit/`; `packages/db/src` altında aynı içerik → hata yok.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RULE_ID = "no-restricted-imports";
const TENANT_MODULE_PATH = path.join(REPO_ROOT, "packages/domain/src/__ac28_probe__.ts");
const DB_PACKAGE_PATH = path.join(REPO_ROOT, "packages/db/src/__ac28_probe__.ts");
const SYNTAX_RULE_ID = "no-restricted-syntax";
const SCRIPTS_PATH = path.join(REPO_ROOT, "scripts/__ac28_probe__.mjs");
const UNIT_TEST_PATH = path.join(REPO_ROOT, "tests/unit/__ac28_probe__.test.ts");

/** Ham istemciyi tenant modülünde kullanan içerik (global istemci → withTenant atlanır). */
const RAW_CLIENT_SOURCE = [
  'import { createDbClient, rawDb } from "@wms/db/internal";',
  "",
  "export async function leak(url: string): Promise<number> {",
  "  const db = rawDb(createDbClient({ url, poolMax: 1, prepare: false }));",
  '  const rows = await db.execute("SELECT 1");',
  "  return rows.length;",
  "}",
  "",
].join("\n");

const DRIVER_SOURCES: Record<string, string> = {
  postgres: 'import postgres from "postgres";\n\nexport const sqlClient = postgres;\n',
  "drizzle-orm/postgres-js": 'import { drizzle } from "drizzle-orm/postgres-js";\n\nexport const make = drizzle;\n',
};

/** T-005g: genişletilmiş küme — statik import'ta `no-restricted-imports` error. */
const EXTENDED_STATIC_SOURCES: Record<string, string> = {
  "pg-pool": 'import Pool from "pg-pool";\n\nexport const make = Pool;\n',
  "drizzle-orm/pglite": 'import { drizzle } from "drizzle-orm/pglite";\n\nexport const make = drizzle;\n',
  "drizzle-orm/pg-proxy": 'import { drizzle } from "drizzle-orm/pg-proxy";\n\nexport const make = drizzle;\n',
  "drizzle-orm/vercel-postgres": 'import { drizzle } from "drizzle-orm/vercel-postgres";\n\nexport const make = drizzle;\n',
  "drizzle-orm/bun-sql": 'import { drizzle } from "drizzle-orm/bun-sql";\n\nexport const make = drizzle;\n',
  "drizzle-orm/node-postgres/driver": 'import { drizzle } from "drizzle-orm/node-postgres/driver";\n\nexport const make = drizzle;\n',
  "drizzle-orm/neon-serverless": 'import { drizzle } from "drizzle-orm/neon-serverless";\n\nexport const make = drizzle;\n',
  "göreli node_modules": 'import postgres from "../../db/node_modules/postgres/src/index.js";\n\nexport const make = postgres;\n',
};

/** T-005g: sürücüsüz drizzle alt yolları ve kök serbest kalır (kural aşırı geniş değil). */
const ALLOWED_STATIC_SOURCES: Record<string, string> = {
  "drizzle-orm": 'import { sql } from "drizzle-orm";\n\nexport const q = sql;\n',
  "drizzle-orm/pg-core": 'import { pgTable } from "drizzle-orm/pg-core";\n\nexport const t = pgTable;\n',
  "drizzle-orm/sql": 'import { sql } from "drizzle-orm/sql";\n\nexport const q = sql;\n',
};

/** T-005g Yapılacak 1: dinamik biçimler — `no-restricted-syntax` error. */
const DYNAMIC_SOURCES: Record<string, string> = {
  'import("@wms/db/internal")': 'export async function leak(): Promise<unknown> {\n  return import("@wms/db/internal");\n}\n',
  "import(`drizzle-orm/postgres-js`)": "export async function leak(): Promise<unknown> {\n  return import(`drizzle-orm/postgres-js`);\n}\n",
  'require("pg")': 'declare const require: (id: string) => unknown;\n\nexport const pg = require("pg");\n',
  'module.require("postgres")': 'declare const module: { require(id: string): unknown };\n\nexport const pg = module.require("postgres");\n',
  'createRequire(…)("pg")': 'import { createRequire } from "node:module";\n\nexport const pg = createRequire(import.meta.url)("pg");\n',
  'r = createRequire(…); r("drizzle-orm/node-postgres")':
    'import { createRequire } from "node:module";\n\nconst r = createRequire(import.meta.url);\nexport const d = r("drizzle-orm/node-postgres");\n',
  "import(değişken)": "export async function leak(name: string): Promise<unknown> {\n  return import(name);\n}\n",
};

// Bu test dosyası da aynı kuralla lint edilir: yasaklı tenant ayarı dizeleri parçalardan kurulur.
const SET_CONFIG = ["set", "config"].join("_");
const TENANT_GUC = ["app", "current_tenant_id"].join(".");

/** T-005g Yapılacak 4: tenant bağlam ayarı dizeleri — `no-restricted-syntax` error. */
const TENANT_SETTING_SOURCES: Record<string, string> = {
  [`${SET_CONFIG} dizesi`]: `export const q = "SELECT ${SET_CONFIG}('${TENANT_GUC}', $1, false)";\n`,
  [`sql\`…${TENANT_GUC}…\``]:
    "declare function sql(s: TemplateStringsArray, ...v: unknown[]): unknown;\n\n" +
    `export const q = (t: string) => sql\`SELECT current_setting('${TENANT_GUC}') = \${t}\`;\n`,
  "oturum SET LOCAL dizesi": 'export const q = ["SET LOCAL statement_timeout = 0"];\n',
};

/** packages/db/src içinde serbest: dinamik import, createRequire ve tenant ayarı dizesi. */
const DB_INTERNAL_DYNAMIC_SOURCE = [
  'import { createRequire } from "node:module";',
  "",
  "const load = createRequire(import.meta.url);",
  'export const pg = load("pg");',
  `export const q = "SELECT ${SET_CONFIG}('${TENANT_GUC}', $1, true)";`,
  "",
  "export async function internal(): Promise<unknown> {",
  '  return import("drizzle-orm/postgres-js");',
  "}",
  "",
].join("\n");

let eslint: ESLint;

async function lint(code: string, filePath: string): Promise<ESLint.LintResult> {
  const results = await eslint.lintText(code, { filePath, warnIgnored: true });
  expect(results).toHaveLength(1);
  return results[0] as ESLint.LintResult;
}

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

describe("AC-28 lint: ham DB istemcisi tenant modülünde yasak", () => {
  it(
    `@AC-28 packages/domain içinde @wms/db/internal import'u → ${RULE_ID} error`,
    async () => {
      const result = await lint(RAW_CLIENT_SOURCE, TENANT_MODULE_PATH);
      const hits = result.messages.filter((m) => m.ruleId === RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
      expect(hits[0]?.line).toBe(1);
      expect(result.errorCount).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  it.each(Object.entries(DRIVER_SOURCES))(
    `@AC-28 packages/domain içinde sürücü import'u (%s) → ${RULE_ID} error`,
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      const hits = result.messages.filter((m) => m.ruleId === RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it(
    "@AC-28 aynı içerik packages/db/src altında → hata yok (kuralın kapsamı doğru)",
    async () => {
      const result = await lint(RAW_CLIENT_SOURCE, DB_PACKAGE_PATH);
      expect(result.messages.filter((m) => m.ruleId === RULE_ID)).toHaveLength(0);
      expect(result.errorCount).toBe(0);
      expect(result.warningCount).toBe(0);
    },
    60_000,
  );

  it.each(Object.entries(EXTENDED_STATIC_SOURCES))(
    `@AC-28 packages/domain içinde genişletilmiş küme (%s) → ${RULE_ID} error`,
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      const hits = result.messages.filter((m) => m.ruleId === RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
      expect(hits[0]?.line).toBe(1);
    },
    60_000,
  );

  it.each(Object.entries(ALLOWED_STATIC_SOURCES))(
    "@AC-28 sürücüsüz yol (%s) packages/domain içinde serbest",
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      expect(result.messages.filter((m) => m.ruleId === RULE_ID || m.ruleId === SYNTAX_RULE_ID)).toHaveLength(0);
      expect(result.errorCount).toBe(0);
    },
    60_000,
  );

  it.each(Object.entries(DYNAMIC_SOURCES))(
    `@AC-28 packages/domain içinde dinamik biçim (%s) → ${SYNTAX_RULE_ID} error`,
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      const hits = result.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
      expect(result.errorCount).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  it.each([
    ["scripts/", SCRIPTS_PATH],
    ["tests/unit/", UNIT_TEST_PATH],
  ])(
    `@AC-28 kapsam: %s altında @wms/db/internal import'u → ${RULE_ID} error`,
    async (_dir, filePath) => {
      const result = await lint(RAW_CLIENT_SOURCE, filePath);
      const hits = result.messages.filter((m) => m.ruleId === RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
      expect(hits[0]?.line).toBe(1);
    },
    60_000,
  );

  it.each([
    ["scripts/", SCRIPTS_PATH],
    ["tests/unit/", UNIT_TEST_PATH],
  ])(
    `@AC-28 kapsam: %s altında dinamik import("@wms/db/internal") → ${SYNTAX_RULE_ID} error`,
    async (_dir, filePath) => {
      const code = 'export async function leak() {\n  return import("@wms/db/internal");\n}\n';
      const result = await lint(code, filePath);
      const hits = result.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
      expect(hits[0]?.line).toBe(2);
    },
    60_000,
  );

  it.each(Object.entries(TENANT_SETTING_SOURCES))(
    `@AC-28 packages/domain içinde tenant ayarı (%s) → ${SYNTAX_RULE_ID} error`,
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      const hits = result.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it(
    "@AC-28 dinamik import, createRequire ve tenant ayarı dizesi packages/db/src altında → hata yok",
    async () => {
      const result = await lint(DB_INTERNAL_DYNAMIC_SOURCE, DB_PACKAGE_PATH);
      expect(result.messages.filter((m) => m.ruleId === RULE_ID || m.ruleId === SYNTAX_RULE_ID)).toHaveLength(0);
      expect(result.errorCount).toBe(0);
      expect(result.warningCount).toBe(0);
    },
    60_000,
  );
});

// T-015 eklemeleri (yalnızca ekleme; yukarıdaki vakalar değişmedi): takma adlı çağrı denetiminin yanlış
// pozitifi (çıplak yol dizesi modül belirteci değildir) ve bekçi yükleyicisinin dar muafiyeti.
const GUARD_LOADER_PATH = path.join(REPO_ROOT, "scripts/guards/cli.mjs");
const GUARD_TEST_PATH = path.join(REPO_ROOT, "scripts/guards/__ac28_probe__.test.mjs");

/** Modül belirteci konumunda olmayan yol dizeleri → hata yok. */
const NON_SPECIFIER_SOURCES: Record<string, string> = {
  'matchesGlob("packages/db/src/x.ts", …)':
    'declare function matchesGlob(f: string, g: string): boolean;\n\nexport const m = matchesGlob("packages/db/src/x.ts", "packages/db/src/*.ts");\n',
  'path.join("packages/db/src", …) (şablon)':
    'declare function join(...p: string[]): string;\n\nexport const f = (n: string) => join(`packages/db/src/${n}`);\n',
  'has("node_modules/x")': 'declare function has(p: string): boolean;\n\nexport const h = has("node_modules/postgres");\n',
};

/** Modül belirteci konumundaki aynı yollar → `no-restricted-syntax` error (tek rapor). */
const SPECIFIER_PATH_SOURCES: Record<string, string> = {
  'require("packages/db/src/client.ts")': 'declare const require: (id: string) => unknown;\n\nexport const c = require("packages/db/src/client.ts");\n',
  'import("../../db/src/client.ts")': 'export async function leak(): Promise<unknown> {\n  return import("../../db/src/client.ts");\n}\n',
  'r = createRequire(…); r("../../packages/db/src/client.ts")':
    'import { createRequire } from "node:module";\n\nconst r = createRequire(import.meta.url);\nexport const c = r("../../packages/db/src/client.ts");\n',
  'load(`../${x}/packages/db/src/client.ts`)':
    "declare function load(id: string): unknown;\n\nexport const c = (x: string) => load(`../${x}/packages/db/src/client.ts`);\n",
  'load(`${base}packages/db/src/client.ts`)':
    "declare function load(id: string): unknown;\n\nexport const c = (base: string) => load(`${base}packages/db/src/client.ts`);\n",
  'load("/abs/node_modules/postgres")': 'declare function load(id: string): unknown;\n\nexport const c = load("/abs/node_modules/postgres");\n',
};

describe("AC-28 lint (T-015): yanlış pozitif ve bekçi yükleyicisi muafiyeti", () => {
  it.each(Object.entries(NON_SPECIFIER_SOURCES))(
    "@AC-28 modül belirteci olmayan yol dizesi (%s) → hata yok",
    async (_name, code) => {
      for (const filePath of [TENANT_MODULE_PATH, GUARD_TEST_PATH]) {
        const result = await lint(code, filePath);
        expect(result.messages.filter((m) => m.ruleId === RULE_ID || m.ruleId === SYNTAX_RULE_ID), filePath).toHaveLength(0);
        expect(result.errorCount, filePath).toBe(0);
      }
    },
    60_000,
  );

  it.each(Object.entries(SPECIFIER_PATH_SOURCES))(
    `@AC-28 modül belirteci konumunda packages/db/src veya node_modules yolu (%s) → ${SYNTAX_RULE_ID} error`,
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      const hits = result.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it(
    "@AC-28 scripts/guards/cli.mjs: yalnızca import(pathToFileURL(<ifade>).href) serbest",
    async () => {
      const loader =
        'import { pathToFileURL } from "node:url";\n\nexport async function load(file: string): Promise<unknown> {\n  return import(pathToFileURL(file).href);\n}\n';
      const ok = await lint(loader, GUARD_LOADER_PATH);
      expect(ok.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID)).toHaveLength(0);
      expect(ok.errorCount).toBe(0);
      // Aynı içerik başka bir bekçi dosyasında → error (muafiyet dosyaya özgü).
      const other = await lint(loader, GUARD_TEST_PATH);
      expect(other.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID)).toHaveLength(1);
    },
    60_000,
  );

  // T-008k: muafiyet yalnızca `pathToFileURL(x).href`; diğer statik olmayan biçimler cli.mjs'te de error.
  it.each([
    ["import(file)", "export async function load(file: string): Promise<unknown> {\n  return import(file);\n}\n"],
    ["import(x.href)", "export async function load(x: { href: string }): Promise<unknown> {\n  return import(x.href);\n}\n"],
    [
      'import(pathToFileURL(x)["href"])',
      'import { pathToFileURL } from "node:url";\n\nexport async function load(x: string): Promise<unknown> {\n  return import(pathToFileURL(x)["href"]);\n}\n',
    ],
    [
      "import(pathToFileURL(x).pathname)",
      'import { pathToFileURL } from "node:url";\n\nexport async function load(x: string): Promise<unknown> {\n  return import(pathToFileURL(x).pathname);\n}\n',
    ],
    [
      "import(url.pathToFileURL(x).href)",
      'import url from "node:url";\n\nexport async function load(x: string): Promise<unknown> {\n  return import(url.pathToFileURL(x).href);\n}\n',
    ],
    [
      "import(pathToFileURL(...xs).href)",
      'import { pathToFileURL } from "node:url";\n\nexport async function load(xs: string[]): Promise<unknown> {\n  return import(pathToFileURL(...xs).href);\n}\n',
    ],
  ])(
    "@AC-28 T-008k scripts/guards/cli.mjs: %s → error",
    async (_name, code) => {
      const result = await lint(code, GUARD_LOADER_PATH);
      const hits = result.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it.each([
    ['import("@wms/db/internal")', 'export async function leak(): Promise<unknown> {\n  return import("@wms/db/internal");\n}\n', SYNTAX_RULE_ID],
    ["require(değişken)", "declare const require: (id: string) => unknown;\n\nexport const f = (n: string) => require(n);\n", SYNTAX_RULE_ID],
    ['createRequire(…)("pg")', 'import { createRequire } from "node:module";\n\nexport const pg = createRequire(import.meta.url)("pg");\n', SYNTAX_RULE_ID],
    [`${SET_CONFIG} dizesi`, `export const q = "SELECT ${SET_CONFIG}('${TENANT_GUC}', $1, false)";\n`, SYNTAX_RULE_ID],
    ["statik @wms/db/internal", RAW_CLIENT_SOURCE, RULE_ID],
  ])(
    "@AC-28 scripts/guards/cli.mjs içinde de yasak: %s → error",
    async (_name, code, ruleId) => {
      const result = await lint(code, GUARD_LOADER_PATH);
      const hits = result.messages.filter((m) => m.ruleId === ruleId);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );
});

// T-016 eklemeleri (yalnızca ekleme; yukarıdaki vakalar değişmedi): security-reviewer (int/faz0-pooler
// @ 1e92a8a) lint MINOR'ları — createRequire takma adı, göreli ön ekli dinamik şablon / eval, büyük/küçük
// harf duyarsız SET/RESET ve parçalanmış tenant ayarı dizesi. Her madde: saldırı → tek error; yanlış
// pozitif kontrolü → hata yok.
const LOADER_RULE_ID = "wms/no-aliased-module-loader";
const RAW_RULES = new Set([RULE_ID, SYNTAX_RULE_ID, LOADER_RULE_ID]);

/** Madde 2: `createRequire` takma adları ve dönüş değerinin atandığı adlar → `wms/no-aliased-module-loader`. */
const ALIASED_LOADER_SOURCES: Record<string, string> = {
  'const load = createRequire(u); load("postgres")':
    'import { createRequire } from "node:module";\n\nconst load = createRequire(import.meta.url);\nexport const pg = load("postgres");\n',
  'import { createRequire as cr } + cr(u)("pg")':
    'import { createRequire as cr } from "node:module";\n\nexport const pg = cr(import.meta.url)("pg");\n',
  'module (önek yok) + takma ad: mk(u) → l("pg-native")':
    'import { createRequire as mk } from "module";\n\nconst l = mk(import.meta.url);\nexport const pg = l("pg-native");\n',
  'ad alanı: nm.createRequire(u) → l("pg")':
    'import * as nm from "node:module";\n\nconst l = nm.createRequire(import.meta.url);\nexport const pg = l("pg");\n',
  'yapı bozumu: { createRequire: mk } = await import("node:module")':
    'const { createRequire: mk } = await import("node:module");\nconst l = mk(import.meta.url);\nexport const pg = l("pg");\n',
  'zincir: a = createRequire(u); b = a; b("pg")':
    'import { createRequire } from "node:module";\n\nconst a = createRequire(import.meta.url);\nconst b = a;\nexport const pg = b("pg");\n',
  'atama + bind: let l; l = cr.bind(null)(u); l("postgres")':
    'import { createRequire as cr } from "node:module";\n\nlet l: (id: string) => unknown;\nl = cr.bind(null)(import.meta.url);\nexport const pg = l("postgres");\n',
  "yükleyiciye değişken: load(n)":
    'import { createRequire } from "node:module";\n\nconst load = createRequire(import.meta.url);\nexport const f = (n: string) => load(n);\n',
  "yükleyiciye göreli dinamik şablon: load(`../${n}`)":
    'import { createRequire } from "node:module";\n\nconst load = createRequire(import.meta.url);\nexport const f = (n: string) => load(`../${n}`);\n',
};

/** Madde 2 yanlış pozitif: izlenmeyen adlar ve serbest belirteçler → hata yok. */
const ALIASED_LOADER_ALLOWED: Record<string, string> = {
  'createRequire yükleyicisiyle serbest paket ("zod") ve göreli statik yol':
    'import { createRequire } from "node:module";\n\nconst load = createRequire(import.meta.url);\nexport const z = load("zod");\nexport const c = load("./local.cjs");\n',
  'yükleyici olmayan "load" adlı fonksiyon: load("postgres") (compose servis adı)':
    'declare function load(service: string): unknown;\n\nexport const svc = load("postgres");\n',
  "aynı ad başka kapsamda yükleyici değil":
    'import { createRequire } from "node:module";\n\nexport const outer = () => {\n  const load = createRequire(import.meta.url);\n  return load("zod");\n};\nexport const inner = (load: (s: string) => unknown) => load("pg");\n',
};

/** Madde 3: göreli ön ekli dinamik şablon ve dinamik kod yürütme → `no-restricted-syntax`. */
const CODE_EXEC_SOURCES: Record<string, string> = {
  "import(`../${x}`)": "export const f = (x: string): Promise<unknown> => import(`../${x}`);\n",
  "import(`./drivers/${x}.js`)": "export const f = (x: string): Promise<unknown> => import(`./drivers/${x}.js`);\n",
  "require(`../${x}`)": "declare const require: (id: string) => unknown;\n\nexport const f = (x: string) => require(`../${x}`);\n",
  'eval("…")': 'export const v = eval("1 + 1");\n',
  "(0, eval)(…)": 'export const v = (0, eval)("1 + 1");\n',
  "globalThis.eval(…)": 'export const v = globalThis.eval("1 + 1");\n',
  'new Function("…")': 'export const fn = new Function("return 1");\n',
  'Function("…")': 'export const fn = Function("return 1");\n',
  'module._load("pg")': 'declare const module: { _load(id: string): unknown };\n\nexport const pg = module._load("pg");\n',
  'Module["_load"]("pg")': 'declare const Module: { _load(id: string): unknown };\n\nexport const pg = Module["_load"]("pg");\n',
};

/** Madde 3 yanlış pozitif → hata yok. */
const CODE_EXEC_ALLOWED: Record<string, string> = {
  "statik göreli şablon import(`./x.js`)": "export const f = (): Promise<unknown> => import(`./x.js`);\n",
  'alan adlı yöntem: redis.eval("lua")': 'declare const redis: { eval(s: string): unknown };\n\nexport const v = redis.eval("return 1");\n',
  "eval/Function adlı özellik okuması": 'declare const o: { eval: number; Function: string };\n\nexport const a = [o.eval, o.Function];\n',
};

/** Madde 4: büyük/küçük harf duyarsız SET/RESET ve parçalanmış tenant ayarı → `no-restricted-syntax`. */
const SET_RESET_SOURCES: Record<string, string> = {
  "SQL: set role": 'export const q = "set role app_admin";\n',
  "SQL: reset all": 'export const q = "reset all";\n',
  "SQL: set search_path": 'export const q = "set search_path to evil, public";\n',
  "SQL: Set Local (karışık harf)": 'export const q = "Set Local statement_timeout = 0";\n',
  "şablon: reset role": "export const q = `reset role`;\n",
  '"SELECT set_" + "config(…)"': "export const q = \"SELECT set_\" + \"config('x', $1, false)\";\n",
  '"app." + "current_tenant" + "_id"': 'export const k = "app." + "current_tenant" + "_id";\n',
  "ifadeli şablonda _config": "export const q = (s: string) => `SELECT ${s}_config('x', $1, false)`;\n",
  '"set_".concat(…)': 'export const q = "set_".concat("config");\n',
  "+= ile current_tenant": 'let k = "app.";\nk += "current_tenant_id";\nexport const key = k;\n',
};

/** Madde 4 yanlış pozitif → hata yok. */
const SET_RESET_ALLOWED: Record<string, string> = {
  'sözcük içi: "reset_" / "offset_" / "asset_" birleştirmesi':
    'export const f = (n: string) => ["reset_" + n, "offset_" + n, "asset_" + n];\n',
  'SET/RESET ile başlamayan: "Settings", "setup ", "reset-password"':
    'export const a = ["Settings", "setup step", "reset-password"];\n',
  "birleştirme dışında tek başına parça (ör. sözlük anahtarı)": 'export const keys = ["set_x", "app_config"];\n',
};

/** Ham istemci/tenant ayarı kurallarının (üçü) raporları. */
function rawHits(result: ESLint.LintResult): ESLint.LintResult["messages"] {
  return result.messages.filter((m) => m.ruleId !== null && RAW_RULES.has(m.ruleId));
}

describe("AC-28 lint (T-016): createRequire takma adı, dinamik şablon/eval, SET/RESET", () => {
  it.each(Object.entries(ALIASED_LOADER_SOURCES))(
    `@AC-28 createRequire takma adı (%s) → ${LOADER_RULE_ID} error (tek rapor)`,
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      const hits = rawHits(result);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.ruleId).toBe(LOADER_RULE_ID);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it.each(Object.entries(ALIASED_LOADER_ALLOWED))(
    "@AC-28 createRequire yanlış pozitif yok (%s)",
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      expect(rawHits(result)).toHaveLength(0);
      expect(result.errorCount).toBe(0);
    },
    60_000,
  );

  it.each([...Object.entries(CODE_EXEC_SOURCES), ...Object.entries(SET_RESET_SOURCES)])(
    `@AC-28 packages/domain içinde (%s) → ${SYNTAX_RULE_ID} error (tek rapor)`,
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      const hits = rawHits(result);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.ruleId).toBe(SYNTAX_RULE_ID);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it.each([...Object.entries(CODE_EXEC_ALLOWED), ...Object.entries(SET_RESET_ALLOWED)])(
    "@AC-28 yanlış pozitif yok (%s)",
    async (_name, code) => {
      const result = await lint(code, TENANT_MODULE_PATH);
      expect(rawHits(result)).toHaveLength(0);
      expect(result.errorCount).toBe(0);
    },
    60_000,
  );

  it(
    "@AC-28 T-016 vakaları scripts/guards/cli.mjs muafiyetine girmez; packages/db/src altında serbest",
    async () => {
      const samples = [
        ALIASED_LOADER_SOURCES['const load = createRequire(u); load("postgres")'],
        CODE_EXEC_SOURCES["import(`../${x}`)"],
        CODE_EXEC_SOURCES['eval("…")'],
        SET_RESET_SOURCES["SQL: set role"],
        SET_RESET_SOURCES['"SELECT set_" + "config(…)"'],
      ];
      for (const code of samples) {
        expect(code).toBeDefined();
        const inLoader = await lint(code as string, GUARD_LOADER_PATH);
        expect(rawHits(inLoader), code).toHaveLength(1);
        const inDb = await lint(code as string, DB_PACKAGE_PATH);
        expect(rawHits(inDb), code).toHaveLength(0);
        expect(inDb.errorCount, code).toBe(0);
      }
    },
    60_000,
  );
});
