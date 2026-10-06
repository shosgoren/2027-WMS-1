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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

  // T-008k güvenlik MINOR-5: `pathToFileURL` adı cli.mjs'te yeniden bağlanamaz (muafiyet ada bakar).
  const FAKE_URL = "(s: string) => ({ href: s })";
  it.each([
    [
      "parametre gölgelemesi",
      `export async function load(pathToFileURL: ${FAKE_URL}, x: string): Promise<unknown> {\n  return import(pathToFileURL(x).href);\n}\n`,
    ],
    [
      "varsayılanlı parametre",
      `export async function load(x: string, pathToFileURL: ${FAKE_URL} = (s) => ({ href: s })): Promise<unknown> {\n  return import(pathToFileURL(x).href);\n}\n`,
    ],
    ["yerel const", `export async function load(x: string): Promise<unknown> {\n  const pathToFileURL = ${FAKE_URL};\n  return import(pathToFileURL(x).href);\n}\n`],
    [
      "desenle bağlama",
      `export async function load(x: string, o: { f: ${FAKE_URL} }): Promise<unknown> {\n  const { f: pathToFileURL } = o;\n  return import(pathToFileURL(x).href);\n}\n`,
    ],
    [
      "yerel işlev bildirimi",
      "export async function load(x: string): Promise<unknown> {\n  function pathToFileURL(s: string) {\n    return { href: s };\n  }\n  return import(pathToFileURL(x).href);\n}\n",
    ],
    [
      "başka modülden içe aktarma",
      'import { pathToFileURL } from "./evil.mjs";\n\nexport async function load(x: string): Promise<unknown> {\n  return import(pathToFileURL(x).href);\n}\n',
    ],
    [
      "node:url'den başka adla içe aktarma",
      'import { fileURLToPath as pathToFileURL } from "node:url";\n\nexport async function load(x: string): Promise<unknown> {\n  return import(pathToFileURL(x).href);\n}\n',
    ],
    [
      "catch parametresi",
      `export async function load(x: string): Promise<unknown> {\n  try {\n    return await import("node:url");\n  } catch (pathToFileURL) {\n    return import((pathToFileURL as { href: string }).href + x);\n  }\n}\n`,
    ],
  ])(
    "@AC-28 T-008k scripts/guards/cli.mjs: pathToFileURL yeniden bağlama (%s) → error",
    async (_name, code) => {
      const result = await lint(code, GUARD_LOADER_PATH);
      const hits = result.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID && m.message.includes("yeniden bağlama/gölgeleme"));
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it.each([
    ["eslint-disable-next-line", 'export async function load(x: string): Promise<unknown> {\n  // eslint-disable-next-line no-restricted-syntax -- muafiyet denemesi\n  return import(x);\n}\n'],
    ["eslint-disable bloğu", 'export async function load(x: string): Promise<unknown> {\n  /* eslint-disable no-restricted-syntax */\n  return import(x);\n}\n'],
  ])(
    "@AC-28 T-008k scripts/guards/cli.mjs: satır içi %s yorumu etkisiz → import(x) hâlâ error",
    async (_name, code) => {
      const result = await lint(code, GUARD_LOADER_PATH);
      const hits = result.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID && m.severity === 2);
      expect(hits).toHaveLength(1);
    },
    60_000,
  );

  it("@AC-28 T-008k: eslint-disable yorumu cli.mjs dışında çalışmaya devam eder (kod tabanı kırılmaz)", async () => {
    const code = 'export async function load(x: string): Promise<unknown> {\n  // eslint-disable-next-line no-restricted-syntax -- test\n  return import(x);\n}\n';
    const result = await lint(code, path.join(REPO_ROOT, "scripts/guards/__ac28_probe__.mjs"));
    expect(result.messages.filter((m) => m.ruleId === SYNTAX_RULE_ID)).toHaveLength(0);
  }, 60_000);

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
const NORMALIZED_RULE_ID = "wms/no-normalized-path-import";
const RAW_RULES = new Set([RULE_ID, SYNTAX_RULE_ID, LOADER_RULE_ID, NORMALIZED_RULE_ID]);

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

// T-127a eklemeleri (yalnızca ekleme; yukarıdaki vakalar değişmedi): web'de sistem DB yolları, `@wms/storage` iç
// modülü, `@wms/shared/cache-key`, `@aws-sdk/*` sınırları. Her kural: ihlal → tek error; izinli yol → hata yok.
const probe = (rel: string): string => path.join(REPO_ROOT, rel);
const WEB_PATH = probe("apps/web/app/__ac28_probe__.ts");
const WEB_AUTH_PATH = probe("apps/web/app/api/auth/__ac28_probe__.ts");
const WEB_AUTH_CLIENT_PATH = probe("apps/web/lib/auth-client.ts");
const STORAGE_INDEX_PATH = probe("packages/storage/src/index.ts");
const STORAGE_SRC_PATH = probe("packages/storage/src/__ac28_probe__.ts");
const STORAGE_OUTSIDE_SRC_PATH = probe("packages/storage/test/__ac28_probe__.ts");
const INTEGRATION_PATH = probe("tests/integration/__ac28_probe__.ts");
const INTEGRATION_STORAGE_PROBE_PATH = probe("tests/integration/storage/__ac28_probe__.ts");
const INTEGRATION_STORAGE_PATH = probe("tests/integration/storage/object-storage.int.test.ts");
const INTEGRATION_SETUP_PATH = probe("tests/integration/harness/global-setup.ts");
const AUTH_PACKAGE_PATH = probe("packages/auth/src/__ac28_probe__.ts");

/** Kural 1: web'de `@wms/db` sistem/oturumsuz bağlam yolları. */
const WEB_DB_SOURCES: Record<string, string> = {
  "createDbClient": 'import { createDbClient } from "@wms/db";\n\nexport const c = createDbClient;\n',
  "withSystemTenant": 'import { withSystemTenant } from "@wms/db";\n\nexport const c = withSystemTenant;\n',
  "withNewTenant": 'import { withNewTenant } from "@wms/db";\n\nexport const c = withNewTenant;\n',
  "recordSecurityEvent": 'import { recordSecurityEvent } from "@wms/db";\n\nexport const c = recordSecurityEvent;\n',
  "yeniden adlandırma { withSystemTenant as w }": 'import { withSystemTenant as w } from "@wms/db";\n\nexport const c = w;\n',
  "ad alanı import * as db": 'import * as db from "@wms/db";\n\nexport const c = db;\n',
  "yeniden dışa aktarım export { … } from": 'export { withSystemTenant } from "@wms/db";\n',
  'dinamik import("@wms/db")': 'export const c = (): Promise<unknown> => import("@wms/db");\n',
  'createRequire(…)("@wms/db")': 'import { createRequire } from "node:module";\n\nexport const c = createRequire(import.meta.url)("@wms/db");\n',
  "appendAudit": 'import { appendAudit } from "@wms/db";\n\nexport const c = appendAudit;\n',
  // security MAJOR-1: takma adlı yükleyici ve şablon dizgisi.
  'const load = createRequire(…); load("@wms/db")':
    'import { createRequire } from "node:module";\n\nconst load = createRequire(import.meta.url);\nexport const c = load("@wms/db");\n',
  "const load = createRequire(…); load(`@wms/db`)":
    'import { createRequire } from "node:module";\n\nconst load = createRequire(import.meta.url);\nexport const c = load(`@wms/db`);\n',
  "require(`@wms/db`)": 'declare const require: (id: string) => unknown;\n\nexport const c = require(`@wms/db`);\n',
  "createRequire(u)(`@wms/db`)": 'import { createRequire } from "node:module";\n\nexport const c = createRequire(import.meta.url)(`@wms/db`);\n',
  "import(`@wms/db`)": "export const c = (): Promise<unknown> => import(`@wms/db`);\n",
  'import x = require("@wms/db") (TS)': 'import db = require("@wms/db");\n\nexport const c = db;\n',
};

/** Kural 1 yanlış pozitif: web'de serbest `@wms/db` kullanımı (oturum/üyelik yolları, tipler). */
const WEB_DB_ALLOWED: Record<string, string> = {
  "withUser/withMembership": 'import { withMembership, withUser } from "@wms/db";\n\nexport const c = [withMembership, withUser];\n',
  "yalnızca tip": 'import type { TenantContext } from "@wms/db";\n\nexport type C = TenantContext;\n',
};

describe("AC-28 lint (T-127a): apps/web @wms/db sistem yolları", () => {
  it.each(
    [WEB_PATH, WEB_AUTH_PATH, WEB_AUTH_CLIENT_PATH].flatMap((file) =>
      Object.entries(WEB_DB_SOURCES).map(([name, code]) => [path.relative(REPO_ROOT, file), name, code, file] as const),
    ),
  )(
    "@AC-28 %s içinde %s → tek error",
    async (_rel, _name, code, file) => {
      const hits = rawHits(await lint(code, file));
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it.each(Object.entries(WEB_DB_ALLOWED))(
    "@AC-28 web'de serbest (%s)",
    async (_name, code) => {
      const result = await lint(code, WEB_PATH);
      expect(rawHits(result)).toHaveLength(0);
      expect(result.errorCount).toBe(0);
    },
    60_000,
  );

  it(
    "@AC-28 aynı sistem yolları web dışında (packages/domain, packages/auth) kuraldan etkilenmez",
    async () => {
      const code = WEB_DB_SOURCES.withSystemTenant as string;
      for (const file of [TENANT_MODULE_PATH, AUTH_PACKAGE_PATH]) {
        const result = await lint(code, file);
        expect(rawHits(result), file).toHaveLength(0);
        expect(result.errorCount, file).toBe(0);
      }
    },
    60_000,
  );
});

const AWS_STATIC = 'import { S3Client } from "@aws-sdk/client-s3";\n\nexport const c = S3Client;\n';
const AWS_SOURCES: Record<string, string> = {
  "statik @aws-sdk/client-s3": AWS_STATIC,
  "statik @aws-sdk/s3-request-presigner": 'import { getSignedUrl } from "@aws-sdk/s3-request-presigner";\n\nexport const c = getSignedUrl;\n',
  'dinamik import("@aws-sdk/client-s3")': 'export const c = (): Promise<unknown> => import("@aws-sdk/client-s3");\n',
  'createRequire(…)("@aws-sdk/client-sts")':
    'import { createRequire } from "node:module";\n\nexport const c = createRequire(import.meta.url)("@aws-sdk/client-sts");\n',
};

const STORAGE_CONTEXT_SOURCES: Record<string, string> = {
  "paket adı derin yolu @wms/storage/src/context": 'import { issueStorageContextFromVerifiedTenant } from "@wms/storage/src/context";\n\nexport const c = issueStorageContextFromVerifiedTenant;\n',
  "paket adı alt yolu @wms/storage/context": 'import { isIssuedStorageContext } from "@wms/storage/context";\n\nexport const c = isIssuedStorageContext;\n',
  "göreli ../../storage/src/context.ts": 'import { isIssuedStorageContext } from "../../storage/src/context.ts";\n\nexport const c = isIssuedStorageContext;\n',
  "göreli packages/storage/src/context.js": 'import { isIssuedStorageContext } from "../../../packages/storage/src/context.js";\n\nexport const c = isIssuedStorageContext;\n',
  "mutlak /repo/packages/storage/src/context": 'import { isIssuedStorageContext } from "/repo/packages/storage/src/context";\n\nexport const c = isIssuedStorageContext;\n',
  'dinamik import("@wms/storage/src/context")': 'export const c = (): Promise<unknown> => import("@wms/storage/src/context");\n',
  'createRequire(…)("../../storage/src/context.ts")':
    'import { createRequire } from "node:module";\n\nexport const c = createRequire(import.meta.url)("../../storage/src/context.ts");\n',
};

const CACHE_KEY_SOURCES: Record<string, string> = {
  "paket adı @wms/shared/cache-key": 'import { formatTenantCacheKey } from "@wms/shared/cache-key";\n\nexport const c = formatTenantCacheKey;\n',
  "göreli ../../shared/src/cache-key.ts": 'import { formatTenantCacheKey } from "../../shared/src/cache-key.ts";\n\nexport const c = formatTenantCacheKey;\n',
  "mutlak /repo/packages/shared/src/cache-key": 'import { formatTenantCacheKey } from "/repo/packages/shared/src/cache-key";\n\nexport const c = formatTenantCacheKey;\n',
  'dinamik import("@wms/shared/cache-key")': 'export const c = (): Promise<unknown> => import("@wms/shared/cache-key");\n',
  "yeniden dışa aktarım": 'export { formatTenantCacheKey } from "@wms/shared/cache-key";\n',
};

describe("AC-28 lint (T-127a): @aws-sdk yalnızca packages/storage", () => {
  it.each(
    [TENANT_MODULE_PATH, WEB_PATH, DB_PACKAGE_PATH, AUTH_PACKAGE_PATH, INTEGRATION_PATH, INTEGRATION_STORAGE_PROBE_PATH].flatMap((file) =>
      Object.entries(AWS_SOURCES).map(([name, code]) => [path.relative(REPO_ROOT, file), name, code, file] as const),
    ),
  )(
    "@AC-28 %s içinde %s → tek error",
    async (_rel, _name, code, file) => {
      const hits = rawHits(await lint(code, file));
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it.each([STORAGE_INDEX_PATH, STORAGE_SRC_PATH, STORAGE_OUTSIDE_SRC_PATH, INTEGRATION_STORAGE_PATH, INTEGRATION_SETUP_PATH].flatMap((file) =>
    Object.entries(AWS_SOURCES).map(([name, code]) => [path.relative(REPO_ROOT, file), name, code, file] as const),
  ))(
    "@AC-28 izinli yol %s içinde %s → hata yok",
    async (_rel, _name, code, file) => {
      const result = await lint(code, file);
      expect(rawHits(result)).toHaveLength(0);
      expect(result.errorCount).toBe(0);
    },
    60_000,
  );
});

describe("AC-28 lint (T-127a): @wms/storage context.ts paket dışından yasak", () => {
  it.each(
    [TENANT_MODULE_PATH, WEB_PATH, DB_PACKAGE_PATH, INTEGRATION_PATH, INTEGRATION_STORAGE_PROBE_PATH].flatMap((file) =>
      Object.entries(STORAGE_CONTEXT_SOURCES).map(([name, code]) => [path.relative(REPO_ROOT, file), name, code, file] as const),
    ),
  )(
    "@AC-28 %s içinde %s → tek error",
    async (_rel, _name, code, file) => {
      const hits = rawHits(await lint(code, file));
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it(
    "@AC-28 node_modules üzerinden context.ts → error (node_modules + context yasakları birlikte raporlar)",
    async () => {
      const code = 'import { isIssuedStorageContext } from "../../../node_modules/@wms/storage/src/context.ts";\n\nexport const c = isIssuedStorageContext;\n';
      const hits = rawHits(await lint(code, TENANT_MODULE_PATH));
      // Tam iki rapor: node_modules yasağı + storage context yasağı.
      expect(hits).toHaveLength(2);
      expect(hits.every((h) => h.severity === 2)).toBe(true);
    },
    60_000,
  );

  it(
    "@AC-28 packages/storage içinden ama src/ dışından ../src/context.ts → tek error",
    async () => {
      const code = 'import { isIssuedStorageContext } from "../src/context.ts";\n\nexport const c = isIssuedStorageContext;\n';
      const hits = rawHits(await lint(code, STORAGE_OUTSIDE_SRC_PATH));
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it(
    "@AC-28 izinli: packages/storage/src/** içinde ./context.ts ve paket yolu; başka yerde paket girişi @wms/storage",
    async () => {
      const own = 'import { isIssuedStorageContext } from "./context.ts";\n\nexport const c = isIssuedStorageContext;\n';
      const viaPath = STORAGE_CONTEXT_SOURCES["göreli ../../storage/src/context.ts"] as string;
      for (const file of [STORAGE_INDEX_PATH, STORAGE_SRC_PATH]) {
        for (const code of [own, viaPath]) {
          const result = await lint(code, file);
          expect(rawHits(result), `${file}: ${code}`).toHaveLength(0);
          expect(result.errorCount, `${file}: ${code}`).toBe(0);
        }
      }
      const entry = 'import { createStorageContext } from "@wms/storage";\n\nexport const c = createStorageContext;\n';
      for (const file of [TENANT_MODULE_PATH, WEB_PATH]) {
        const result = await lint(entry, file);
        expect(rawHits(result), file).toHaveLength(0);
        expect(result.errorCount, file).toBe(0);
      }
    },
    60_000,
  );
});

/**
 * security MAJOR-2: normalize edilmemiş yol yazımları (`.`, `..`, çift `/`). Eşleştirme belirtecin normalize edilmiş ve
 * içe aktaran dosyaya göre çözülmüş biçimi üzerindendir. `from` = içe aktaran probe dosyası.
 */
const NORMALIZED_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["src/./context.ts", TENANT_MODULE_PATH, "../../storage/src/./context.ts"],
  ["src//context.ts", TENANT_MODULE_PATH, "../../storage/src//context.ts"],
  ["storage/./src/context.ts", TENANT_MODULE_PATH, "../../storage/./src/context.ts"],
  ["src/../src/context.ts", TENANT_MODULE_PATH, "../../storage/src/../src/context.ts"],
  ["packages/./storage/src/context", WEB_PATH, "../../../../packages/./storage/src/context"],
  ["storage/test'ten ../src/./context.ts", STORAGE_OUTSIDE_SRC_PATH, "../src/./context.ts"],
  ["storage/test'ten ../src//context.ts", STORAGE_OUTSIDE_SRC_PATH, "../src//context.ts"],
  ["storage/test'ten ./../src/context", STORAGE_OUTSIDE_SRC_PATH, "./../src/context"],
  ["shared/src/./cache-key.ts", TENANT_MODULE_PATH, "../../shared/src/./cache-key.ts"],
  ["shared/src//cache-key.ts", TENANT_MODULE_PATH, "../../shared/src//cache-key.ts"],
  ["shared/src/x/../cache-key.ts", TENANT_MODULE_PATH, "../../shared/src/x/../cache-key.ts"],
  ["@wms/shared/./cache-key", TENANT_MODULE_PATH, "@wms/shared/./cache-key"],
  // Yüzde kodlaması, geçersiz kodlama, `file:` ve ters eğik çizgi.
  ["%2E kodlu: ../../storage/src/%2E/context.ts", TENANT_MODULE_PATH, "../../storage/src/%2E/context.ts"],
  ["%63ontext.ts kodlu", TENANT_MODULE_PATH, "../../storage/src/%63ontext.ts"],
  ["%2e%2e kodlu: ../../storage/src/%2e%2e/src/context", TENANT_MODULE_PATH, "../../storage/src/%2e%2e/src/context"],
  ["%2F kodlu ayırıcı", TENANT_MODULE_PATH, "..%2F..%2Fstorage%2Fsrc%2Fcontext.ts"],
  ["geçersiz kodlama (%E0%A4%A) güvenli tarafta", TENANT_MODULE_PATH, "../../storage/src/context%E0%A4%A.ts"],
  ["file: kodlu", TENANT_MODULE_PATH, "file:///repo/packages/storage/src/%63ontext.ts"],
  ["file: + ./ ", TENANT_MODULE_PATH, "file:///repo/packages/./storage/src/context.ts"],
  ["ters eğik çizgi ..\\..\\storage\\src\\context.ts", TENANT_MODULE_PATH, "..\\..\\storage\\src\\context.ts"],
  ["karışık ters eğik çizgi shared", TENANT_MODULE_PATH, "../../shared\\src\\.\\cache-key.ts"],
  ["storage/src içinden (index.ts değil) ./../src/./cache-key yolu", STORAGE_SRC_PATH, "../../shared/src/./cache-key.ts"],
];

describe("AC-28 lint (T-127a): normalize edilmemiş yol atlatmaları", () => {
  it.each(NORMALIZED_CASES)(
    "@AC-28 %s → tek error (static import)",
    async (_name, file, spec) => {
      const hits = rawHits(await lint(`import { x } from ${JSON.stringify(spec)};\n\nexport const c = x;\n`, file));
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it.each(NORMALIZED_CASES)(
    "@AC-28 %s → tek error (import(), createRequire, takma ad, export from)",
    async (_name, file, spec) => {
      const q = JSON.stringify(spec);
      const forms = [
        `export const c = (): Promise<unknown> => import(${q});\n`,
        `import { createRequire } from "node:module";\n\nexport const c = createRequire(import.meta.url)(${q});\n`,
        `import { createRequire } from "node:module";\n\nconst load = createRequire(import.meta.url);\nexport const c = load(${q});\n`,
        `export { x } from ${q};\n`,
      ];
      for (const code of forms) {
        const hits = rawHits(await lint(code, file));
        expect(hits, code).toHaveLength(1);
      }
    },
    60_000,
  );

  it(
    "@AC-28 packages/shared/src içinde de göreli cache-key import'u, `import * as`, import() ve `export … from` yasak (muafiyet yok)",
    async () => {
      const file = probe("packages/shared/src/__ac28_probe__.ts");
      for (const spec of ["./cache-key.ts", "./cache-key", "./x/../cache-key.ts", "../src/./cache-key.ts", "./%63ache-key.ts"]) {
        const reexports = [`export { x } from ${JSON.stringify(spec)};\n`, `export * from ${JSON.stringify(spec)};\n`];
        for (const code of reexports) {
          const hits = rawHits(await lint(code, file));
          expect(hits, code).toHaveLength(1);
          expect(hits[0]?.severity, code).toBe(2);
        }
        const others = [
          `import { x } from ${JSON.stringify(spec)};\n\nexport const c = x;\n`,
          `import * as ns from ${JSON.stringify(spec)};\n\nexport const c = ns;\n`,
          `export const c = (): Promise<unknown> => import(${JSON.stringify(spec)});\n`,
          `import { x } from ${JSON.stringify(spec)};\nexport { x };\n`,
        ];
        for (const code of others) {
          const hits = rawHits(await lint(code, file));
          expect(hits, code).toHaveLength(1);
          expect(hits[0]?.severity, code).toBe(2);
        }
      }
    },
    60_000,
  );

  it(
    "@AC-28 izinli: storage/src/** içinde normalize edilmemiş ./context; shared/src içinde ./cache-key; storage/src/index.ts cache-key",
    async () => {
      const ok: Array<[string, string]> = [
        [STORAGE_INDEX_PATH, 'import { a } from "./././context.ts";\n\nexport const c = a;\n'],
        [STORAGE_SRC_PATH, 'import { a } from "../src/./context.ts";\n\nexport const c = a;\n'],
        [STORAGE_INDEX_PATH, 'import { a } from "../../shared/src/./cache-key.ts";\n\nexport const c = a;\n'],
      ];
      for (const [file, code] of ok) {
        const result = await lint(code, file);
        expect(rawHits(result), `${file}: ${code}`).toHaveLength(0);
        expect(result.errorCount, `${file}: ${code}`).toBe(0);
      }
    },
    60_000,
  );
});

describe("AC-28 lint (T-127a): @wms/shared/cache-key yalnızca packages/storage/src/index.ts", () => {
  it.each(
    [TENANT_MODULE_PATH, WEB_PATH, DB_PACKAGE_PATH, INTEGRATION_PATH, STORAGE_SRC_PATH, STORAGE_OUTSIDE_SRC_PATH].flatMap((file) =>
      Object.entries(CACHE_KEY_SOURCES).map(([name, code]) => [path.relative(REPO_ROOT, file), name, code, file] as const),
    ),
  )(
    "@AC-28 %s içinde %s → tek error",
    async (_rel, _name, code, file) => {
      const hits = rawHits(await lint(code, file));
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it(
    "@AC-28 packages/storage/src/index.ts içinde cache-key serbest; @wms/shared diğer alt yolları her yerde serbest",
    async () => {
      for (const code of Object.values(CACHE_KEY_SOURCES)) {
        const result = await lint(code, STORAGE_INDEX_PATH);
        expect(rawHits(result), code).toHaveLength(0);
        expect(result.errorCount, code).toBe(0);
      }
      const other = 'import { AppError } from "@wms/shared/errors";\n\nexport const c = AppError;\n';
      for (const file of [TENANT_MODULE_PATH, WEB_PATH, STORAGE_SRC_PATH]) {
        const result = await lint(other, file);
        expect(rawHits(result), file).toHaveLength(0);
        expect(result.errorCount, file).toBe(0);
      }
    },
    60_000,
  );
});

// T-127b: "use client" dosyalarında sunucu paketi import yasağı (`wms/no-client-server-import`, `wms/no-client-server-loader`).
// Her biçim için negatif; sunucu bileşeni (yönergesiz) ve istemci dosyasında serbest modüller için pozitif.
const CLIENT_RULES = new Set(["wms/no-client-server-import", "wms/no-client-server-loader"]);
const CLIENT_PATH = probe("apps/web/app/__ac28_client__.tsx");
const CLIENT_LIB_PATH = probe("apps/web/lib/__ac28_client__.ts");
const clientHits = (result: ESLint.LintResult): ESLint.LintResult["messages"] =>
  result.messages.filter((m) => m.ruleId !== null && CLIENT_RULES.has(m.ruleId));
const USE_CLIENT = '"use client";\n\n';
const CREATE_REQUIRE = 'import { createRequire } from "node:module";\n\n';

const CLIENT_SERVER_SOURCES: Record<string, string> = {
  'statik import @wms/db': 'import { withUser } from "@wms/db";\n\nexport const c = withUser;\n',
  "statik import @wms/domain": 'import { listMembers } from "@wms/domain";\n\nexport const c = listMembers;\n',
  "statik import @wms/auth": 'import { auth } from "@wms/auth";\n\nexport const c = auth;\n',
  "statik import @wms/storage": 'import { tenantCacheKey } from "@wms/storage";\n\nexport const c = tenantCacheKey;\n',
  "statik import @wms/queue-adapter": 'import { createQueue } from "@wms/queue-adapter";\n\nexport const c = createQueue;\n',
  "alt yol @wms/domain/members": 'import { x } from "@wms/domain/members";\n\nexport const c = x;\n',
  "yalnızca tip import (@wms/db)": 'import type { TenantContext } from "@wms/db";\n\nexport type C = TenantContext;\n',
  "ad alanı import * as": 'import * as db from "@wms/db";\n\nexport const c = db;\n',
  "yan etkili import": 'import "@wms/domain";\n',
  "yeniden dışa aktarım export { } from": 'export { withUser } from "@wms/db";\n',
  "yeniden dışa aktarım export * from": 'export * from "@wms/auth";\n',
  'dinamik import("@wms/db")': 'export const c = (): Promise<unknown> => import("@wms/db");\n',
  "dinamik import(`@wms/storage`)": "export const c = (): Promise<unknown> => import(`@wms/storage`);\n",
  'require("@wms/domain")': 'declare const require: (id: string) => unknown;\n\nexport const c = require("@wms/domain");\n',
  'createRequire(…)("@wms/auth")': `${CREATE_REQUIRE}export const c = createRequire(import.meta.url)("@wms/auth");\n`,
  'const load = createRequire(…); load("@wms/db")': `${CREATE_REQUIRE}const load = createRequire(import.meta.url);\nexport const c = load("@wms/db");\n`,
  "const load = createRequire(…); load(`@wms/queue-adapter`)":
    `${CREATE_REQUIRE}const load = createRequire(import.meta.url);\nexport const c = load(\`@wms/queue-adapter\`);\n`,
  'import x = require("@wms/db") (TS)': 'import db = require("@wms/db");\n\nexport const c = db;\n',
  "action-guard (göreli, uzantılı)": 'import { guard } from "../lib/action-guard.ts";\n\nexport const c = guard;\n',
  "rate-limit (göreli, uzantısız)": 'import { limit } from "../lib/rate-limit";\n\nexport const c = limit;\n',
  "queue (normalize edilmemiş yol)": 'import { q } from "../lib/./queue.ts";\n\nexport const c = q;\n',
  "queue (src/../ atlatması)": 'import { q } from "../lib/x/../queue";\n\nexport const c = q;\n',
  'dinamik import("../lib/queue.ts")': 'export const c = (): Promise<unknown> => import("../lib/queue.ts");\n',
  'require("../lib/action-guard.ts")': 'declare const require: (id: string) => unknown;\n\nexport const c = require("../lib/action-guard.ts");\n',
  "yeniden dışa aktarım action-guard": 'export { guard } from "../lib/action-guard.ts";\n',
  "packages/db yolu": 'import { x } from "../../../packages/db/src/index.ts";\n\nexport const c = x;\n',
};

describe("AC-28 lint (T-127b): \"use client\" dosyalarında sunucu paketi import yasağı", () => {
  it.each(Object.entries(CLIENT_SERVER_SOURCES))(
    "@AC-28 \"use client\" apps/web/app: %s → tek error",
    async (_name, body) => {
      const hits = clientHits(await lint(USE_CLIENT + body, CLIENT_PATH));
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe(2);
    },
    60_000,
  );

  it(
    "@AC-28 \"use client\" apps/web/lib içinde aynı dizindeki ./action-guard, ./rate-limit, ./queue yasak",
    async () => {
      for (const mod of ["./action-guard.ts", "./rate-limit", "./queue.ts", "././queue"]) {
        const hits = clientHits(await lint(`${USE_CLIENT}import { x } from "${mod}";\n\nexport const c = x;\n`, CLIENT_LIB_PATH));
        expect(hits, mod).toHaveLength(1);
        expect(hits[0]?.severity, mod).toBe(2);
      }
    },
    60_000,
  );

  it(
    "@AC-28 yönerge öncülünde (\"use strict\" sonrası) ve yorum satırlarından sonra \"use client\" da geçerli",
    async () => {
      const code = '// başlık\n"use strict";\n"use client";\nimport { withUser } from "@wms/db";\n\nexport const c = withUser;\n';
      expect(clientHits(await lint(code, CLIENT_PATH))).toHaveLength(1);
    },
    60_000,
  );

  it(
    "@AC-28 sunucu bileşeni (\"use client\" yok) aynı içe aktarımları yapabilir; kural yalnızca istemci dosyasını bağlar",
    async () => {
      for (const [name, body] of Object.entries(CLIENT_SERVER_SOURCES)) {
        const hits = clientHits(await lint(body, CLIENT_PATH));
        expect(hits, name).toHaveLength(0);
      }
      // Yönerge yalnızca dosyanın ilk ifadeleri arasındaysa geçerlidir (sonradan gelen dize yönerge değildir).
      const late = 'import { withUser } from "@wms/db";\n"use client";\n\nexport const c = withUser;\n';
      expect(clientHits(await lint(late, CLIENT_PATH))).toHaveLength(0);
    },
    60_000,
  );

  it(
    "@AC-28 \"use client\" dosyasında serbest: bileşen/yardımcı paketler, aynı dizin modülleri, sunucu eylemi dosyası",
    async () => {
      const allowed = [
        'import { Button } from "@wms/ui";\n',
        'import { AppError } from "@wms/shared/errors";\n',
        'import { createAuthClient } from "better-auth/react";\n',
        'import { inviteMemberAction } from "./actions.ts";\n',
        'import { authPost } from "../lib/auth-client.ts";\n',
        'import { safeRedirect } from "../lib/safe-redirect.ts";\n',
        'import { useState } from "react";\n',
        'import { notQueue } from "../lib/queue-ui.ts";\n',
      ];
      for (const body of allowed) {
        const result = await lint(`${USE_CLIENT}${body}\nexport const c = 1;\n`, CLIENT_PATH);
        expect(clientHits(result), body).toHaveLength(0);
      }
    },
    60_000,
  );

  it(
    "@AC-28 packages/** ve apps/web dışı \"use client\" dosyaları bu kuralın kapsamı dışındadır",
    async () => {
      const code = '"use client";\nimport { withUser } from "@wms/db";\n\nexport const c = withUser;\n';
      expect(clientHits(await lint(code, TENANT_MODULE_PATH))).toHaveLength(0);
    },
    60_000,
  );
});

// T-127b (inceleme MAJOR/MINOR): yönerge çözülmüş değerle, sorgu/parça ekli belirteç, packages/ui kapsamı.
describe("AC-28 lint (T-127b): yönerge ve belirteç biçimleri", () => {
  it(
    "@AC-28 kaçışlı yönerge (\"use \\x63lient\") da \"use client\" sayılır",
    async () => {
      const code = '"use \\x63lient";\nimport { withUser } from "@wms/db";\n\nexport const c = withUser;\n';
      expect(clientHits(await lint(code, CLIENT_PATH))).toHaveLength(1);
    },
    60_000,
  );

  it.each([
    ['import { a } from "@wms/db?x";\n\nexport const c = a;\n'],
    ['import { a } from "@wms/db#x";\n\nexport const c = a;\n'],
    ['import { a } from "@wms/domain/members?x#y";\n\nexport const c = a;\n'],
    ['import { a } from "../lib/queue.ts?x";\n\nexport const c = a;\n'],
    ['import { a } from "../lib/action-guard#x";\n\nexport const c = a;\n'],
    ['export const c = (): Promise<unknown> => import("@wms/auth?x");\n'],
  ])(
    "@AC-28 sorgu/parça ekli belirteç yasak: %s",
    async (body) => {
      const hits = clientHits(await lint(USE_CLIENT + body, CLIENT_PATH));
      expect(hits).toHaveLength(1);
    },
    60_000,
  );

  it(
    "@AC-28 packages/ui/src içindeki \"use client\" dosyaları da kapsamdadır; yönergesiz ui dosyası serbest",
    async () => {
      const ui = probe("packages/ui/src/__ac28_client__.tsx");
      const body = 'import { withUser } from "@wms/db";\n\nexport const c = withUser;\n';
      expect(clientHits(await lint(USE_CLIENT + body, ui))).toHaveLength(1);
      expect(clientHits(await lint(body, ui))).toHaveLength(0);
    },
    60_000,
  );
});

// T-127b: istemci içe aktarım GRAFI. Her `"use client"` dosyasından (apps/web, packages/ui) göreli ve `@wms/*` iş alanı
// içe aktarımları geçişli çözülür (`"use server"` dosyasında durulur: Next onları RPC referansına çevirir); yasaklı kümeye
// ulaşan her yol zincirle raporlanır. Doğrudan ihlali lint yakalar; bu test yönergesiz ara modül üzerinden dolaylı yolu yakalar.
const GRAPH_SPEC_RE = /^@wms\/(?:db|domain|auth|storage|queue-adapter)(?:[/?#]|$)/;
const GRAPH_FILE_RE = /^(?:apps\/web\/lib\/(?:action-guard|rate-limit|queue)\.[cm]?[jt]sx?|packages\/(?:db|domain|auth|storage|queue-adapter)\/)/;
const GRAPH_EXTS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const toPosix = (p: string): string => p.split(path.sep).join("/");

function readIfFile(file: string): string | null {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

function resolveWithExt(base: string): string | null {
  const swapped = /\.(?:m?js)$/.test(base) ? [base.replace(/\.mjs$/, ".mts").replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")] : [];
  const candidates = [base, ...swapped, ...GRAPH_EXTS.map((e) => base + e), ...GRAPH_EXTS.map((e) => path.join(base, `index${e}`))];
  return candidates.find((c) => readIfFile(c) !== null) ?? null;
}

/** `@wms/<paket>[/alt]` → package.json `exports` ile kaynak dosya (iş alanı paketi değilse null). */
function resolveWorkspace(root: string, spec: string): string | null {
  const m = /^(@wms\/[^/]+)(\/.*)?$/.exec(spec);
  if (!m) return null;
  const pkgsDir = path.join(root, "packages");
  if (!fs.existsSync(pkgsDir)) return null;
  for (const dir of fs.readdirSync(pkgsDir)) {
    const raw = readIfFile(path.join(pkgsDir, dir, "package.json"));
    if (raw === null) continue;
    const pkg = JSON.parse(raw) as { name?: string; exports?: Record<string, unknown> };
    if (pkg.name !== m[1]) continue;
    const target = pkg.exports?.[`.${m[2] ?? ""}`];
    return typeof target === "string" ? resolveWithExt(path.join(pkgsDir, dir, target)) : null;
  }
  return null;
}

function parseModule(file: string, text: string): { imports: string[]; useServer: boolean; useClient: boolean } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const directives: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    directives.push(st.expression.text);
  }
  const pre = ts.preProcessFile(text, true, true);
  return { imports: pre.importedFiles.map((f) => f.fileName), useServer: directives.includes("use server"), useClient: directives.includes("use client") };
}

function listSources(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listSources(full, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Yasaklı kümeye ulaşan zincirler: ["apps/web/…/a.tsx", "apps/web/lib/x.ts", "@wms/db"]. */
function clientGraphViolations(root: string): string[] {
  const rel = (f: string): string => toPosix(path.relative(root, f));
  const roots = [...listSources(path.join(root, "apps/web")), ...listSources(path.join(root, "packages/ui"))].filter((f) => {
    const text = readIfFile(f);
    return text !== null && parseModule(f, text).useClient;
  });
  const violations: string[] = [];
  for (const start of roots) {
    const seen = new Set<string>([start]);
    const queue: Array<{ file: string; chain: string[] }> = [{ file: start, chain: [rel(start)] }];
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const text = readIfFile(item.file);
      if (text === null) continue;
      const info = parseModule(item.file, text);
      if (info.useServer && item.file !== start) continue;
      for (const spec of info.imports) {
        const bare = spec.replace(/[?#].*$/, "");
        if (GRAPH_SPEC_RE.test(spec)) {
          violations.push([...item.chain, spec].join(" -> "));
          continue;
        }
        const target = bare.startsWith(".") || path.isAbsolute(bare) ? resolveWithExt(path.resolve(path.dirname(item.file), bare)) : resolveWorkspace(root, bare);
        if (target === null) continue;
        if (GRAPH_FILE_RE.test(rel(target))) {
          violations.push([...item.chain, rel(target)].join(" -> "));
          continue;
        }
        if (seen.has(target)) continue;
        seen.add(target);
        queue.push({ file: target, chain: [...item.chain, rel(target)] });
      }
    }
  }
  return violations;
}

describe("AC-28 lint (T-127b): istemci içe aktarım grafı", () => {
  const roots: string[] = [];
  const fixture = (files: Record<string, string>): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac28-graph-"));
    roots.push(root);
    const base: Record<string, string> = {
      "packages/ui/package.json": JSON.stringify({ name: "@wms/ui", exports: { ".": "./src/index.ts" } }),
      "packages/db/package.json": JSON.stringify({ name: "@wms/db", exports: { ".": "./src/index.ts" } }),
      "packages/shared/package.json": JSON.stringify({ name: "@wms/shared", exports: { "./errors": "./src/errors.ts" } }),
      "packages/db/src/index.ts": "export const db = 1;\n",
      "packages/shared/src/errors.ts": "export const e = 1;\n",
    };
    for (const [rel, text] of Object.entries({ ...base, ...files })) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  };
  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  it("@AC-28 dolaylı zincir (istemci -> yönergesiz yerel modül -> @wms/db) zincirle raporlanır", () => {
    const root = fixture({
      "apps/web/app/c.tsx": '"use client";\nimport { h } from "../lib/helper.ts";\nexport const c = h;\n',
      "apps/web/lib/helper.ts": 'import { v } from "./deeper";\nexport const h = v;\n',
      "apps/web/lib/deeper.ts": 'import { db } from "@wms/db";\nexport const v = db;\n',
    });
    expect(clientGraphViolations(root)).toEqual(["apps/web/app/c.tsx -> apps/web/lib/helper.ts -> apps/web/lib/deeper.ts -> @wms/db"]);
  });

  it("@AC-28 dolaylı zincir: iş alanı paketi (@wms/ui) ve yasaklı yerel dosya (apps/web/lib/queue)", () => {
    const root = fixture({
      "apps/web/app/c.tsx": '"use client";\nimport { U } from "@wms/ui";\nexport const c = U;\n',
      "packages/ui/src/index.ts": 'export { U } from "./u.ts";\n',
      "packages/ui/src/u.ts": 'import { q } from "../../../apps/web/lib/queue.ts";\nexport const U = q;\n',
      "apps/web/lib/queue.ts": "export const q = 1;\n",
    });
    expect(clientGraphViolations(root)).toEqual(["apps/web/app/c.tsx -> packages/ui/src/index.ts -> packages/ui/src/u.ts -> apps/web/lib/queue.ts"]);
  });

  it("@AC-28 dolaylı zincir: dinamik import ve require ile ulaşılan modül de izlenir; packages/ui kökleri taranır", () => {
    const root = fixture({
      "packages/ui/src/k.tsx": "'use client';\nexport const k = () => import(\"./lazy.ts\");\n",
      "packages/ui/src/lazy.ts": 'const r = require("@wms/db?x");\nexport default r;\n',
    });
    expect(clientGraphViolations(root)).toEqual(["packages/ui/src/k.tsx -> packages/ui/src/lazy.ts -> @wms/db?x"]);
  });

  it("@AC-28 \"use server\" dosyasında durulur; yönergesiz sunucu dosyası kök değildir; temiz grafik boş", () => {
    const root = fixture({
      "apps/web/app/c.tsx": '"use client";\nimport { act } from "./actions.ts";\nimport { AppError } from "@wms/shared/errors";\nexport const c = [act, AppError];\n',
      "apps/web/app/actions.ts": '"use server";\nimport { db } from "@wms/db";\nexport const act = db;\n',
      "apps/web/app/page.tsx": 'import { db } from "@wms/db";\nexport default db;\n',
    });
    expect(clientGraphViolations(root)).toEqual([]);
  });

  it("@AC-28 gerçek depoda hiçbir \"use client\" dosyası (apps/web, packages/ui) yasaklı kümeye ulaşmaz", () => {
    expect(clientGraphViolations(REPO_ROOT)).toEqual([]);
  });
});
