// AC-28 (lint kısmı) — bağımsız kabul testi (T-005c, qa-verifier). `pnpm verify` unit adımında koşar.
//
// AC-28: Tenant modülünde `withTenant` dışında global istemci kullanılır → lint CI'da hata verir.
// Repo ESLint yapılandırması (eslint.config.mjs) Node API'siyle yüklenir; içerik `lintText` ile
// sanal bir yol altında lint edilir (diske dosya YAZILMAZ). Kural kimliği T-005b'ninkidir:
// `no-restricted-imports`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RULE_ID = "no-restricted-imports";
const TENANT_MODULE_PATH = path.join(REPO_ROOT, "packages/domain/src/__ac28_probe__.ts");
const DB_PACKAGE_PATH = path.join(REPO_ROOT, "packages/db/src/__ac28_probe__.ts");

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
});
