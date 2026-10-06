// T-111 — Faz 1 modül sınırları (lint izin listeleri). Repo ESLint yapılandırması Node API'siyle
// yüklenir; içerik `lintText` ile sanal yollarda lint edilir (diske dosya YAZILMAZ).
// Modül adları: ADR-014 (better-auth, @node-rs/argon2), ADR-005 eki (pg-boss).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMPORTS = "no-restricted-imports";
const SYNTAX = "no-restricted-syntax";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

/** Sanal dosyada yalnızca yasaklı-modül kurallarının (import/syntax/alias) bulgularını döndürür. */
async function boundaryHits(code: string, relPath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, relPath), warnIgnored: true });
  expect(results).toHaveLength(1);
  return (results[0] as ESLint.LintResult).messages
    .filter((m) => m.ruleId === IMPORTS || m.ruleId === SYNTAX || m.ruleId === "wms/no-aliased-module-loader")
    .map((m) => `${m.ruleId}:${m.line}`);
}

/** Yasaklı belirteçler bu dosyada da lint edilir: parçalardan kurulur (ac-28 deseni). */
const sp = (...parts: string[]): string => parts.join("/");
const imp = (spec: string): string => `import * as m from "${spec}";\n\nexport const x = m;\n`;

describe("T-111 lint sınırları: izin verilenler", () => {
  it.each([
    ["packages/auth/x.ts", imp(sp("@wms", "db", "internal", "schema"))],
    ["packages/auth/x.ts", imp(sp("@wms", "db", "internal"))],
    ["packages/auth/x.ts", imp("better-auth")],
    ["packages/auth/x.ts", imp("better-auth/plugins")],
    ["packages/auth/x.ts", imp(sp("@better-auth", "drizzle-adapter"))],
    ["packages/auth/x.ts", imp(sp("@node-rs", "argon2"))],
    ["apps/web/app/api/auth/[...all]/route.ts", imp("better-auth/next-js")],
    ["apps/web/lib/auth-client.ts", imp("better-auth/react")],
    ["packages/queue-adapter/src/x.ts", imp("pg-boss")],
    ["packages/auth/x.ts", `export const q = () => import("${sp("@wms", "db", "internal", "schema")}");\n`],
  ])("%s → %s izinli", async (file, code) => {
    expect(await boundaryHits(code, file)).toEqual([]);
  }, 60_000);
});

describe("T-111 lint sınırları: yasaklılar", () => {
  it.each([
    ["packages/domain/x.ts", imp(sp("@wms", "db", "internal", "schema"))],
    ["apps/web/app/api/auth/x.ts", imp(sp("@wms", "db", "internal", "schema"))],
    ["apps/web/app/page.tsx", imp("better-auth")],
    ["apps/web/app/page.tsx", imp("better-auth/react")],
    ["packages/domain/x.ts", imp(sp("@better-auth", "drizzle-adapter"))],
    ["packages/domain/x.ts", imp(sp("@node-rs", "argon2"))],
    ["apps/web/lib/auth-client.ts", imp("better-auth")],
    ["apps/web/lib/auth-client.ts", imp("better-auth/plugins")],
    ["apps/web/lib/auth-client.ts", imp(sp("@node-rs", "argon2"))],
    ["apps/worker/src/x.ts", imp("pg-boss")],
    ["packages/auth/x.ts", imp("pg-boss")],
    ["packages/queue-adapter/src/x.ts", imp("better-auth")],
    ["packages/queue-adapter/src/x.ts", imp(sp("@wms", "db", "internal"))],
    ["packages/auth/x.ts", imp(sp("drizzle-orm", "postgres-js"))],
    ["packages/auth/x.ts", imp("postgres")],
    ["packages/auth/x.ts", imp("pg")],
    ["packages/db/src/x.ts", imp("pg-boss")],
    ["tests/integration/x.ts", imp("better-auth")],
  ])("%s → %s hata", async (file, code) => {
    const hits = await boundaryHits(code, file);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^no-restricted-imports:/);
  }, 60_000);

  it.each([
    ["apps/worker/src/x.ts", 'export const q = () => import("pg-boss");\n'],
    ["apps/web/app/page.tsx", 'declare const require: (s: string) => unknown;\n\nexport const a = require("better-auth/react");\n'],
    [
      "packages/domain/x.ts",
      'import { createRequire } from "node:module";\n\nconst load = createRequire(import.meta.url);\nexport const a = load("pg-boss");\n',
    ],
    ["packages/auth/x.ts", `export const q = () => import("${sp("drizzle-orm", "postgres-js")}");\n`],
  ])("%s dinamik biçim → hata", async (file, code) => {
    const hits = await boundaryHits(code, file);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("packages/auth içinde statik olmayan import() hâlâ yasak", async () => {
    const hits = await boundaryHits("export const q = (n: string) => import(n);\n", "packages/auth/x.ts");
    expect(hits).toHaveLength(1);
  }, 60_000);
});
