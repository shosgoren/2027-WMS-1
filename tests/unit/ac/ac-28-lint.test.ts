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
