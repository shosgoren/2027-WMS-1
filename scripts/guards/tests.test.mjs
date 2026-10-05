// T-008b `check:tests` testleri. Örnek test kodu yalnızca dize olarak tutulur (AST'de çağrı
// değildir); uçtan uca senaryolar `lib/testkit.mjs` ile geçici depoda koşar.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.mjs";
import { createRepo } from "./lib/testkit.mjs";
import { isTestFile, scanSource } from "./tests.mjs";

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * @param {string} src
 * @param {string} [file]
 */
function codes(src, file = "x.test.ts") {
  return scanSource(src, file).map((f) => `${f.code}@${f.line}`);
}

const IMPORT = `import { describe, it, test, expect, suite } from "vitest";\n`;

/** Her yasak biçim: [ad, kaynak (IMPORT'tan sonra), beklenen neden kodu, beklenen satır]. */
const FORBIDDEN = /** @type {Array<[string, string, string, number]>} */ ([
  ["it.skip", `it.skip("a", () => {});`, "SKIP", 2],
  ["test.skip", `test.skip("a", () => {});`, "SKIP", 2],
  ["describe.skip", `describe.skip("d", () => {});`, "SKIP", 2],
  ["suite.skip", `suite.skip("d", () => {});`, "SKIP", 2],
  ["it.only", `it.only("a", () => {});`, "ONLY", 2],
  ["describe.only", `describe.only("d", () => {});`, "ONLY", 2],
  ["test.todo", `test.todo("sonra");`, "TODO", 2],
  ["it.fails", `it.fails("a", () => {});`, "SKIP", 2],
  ["it.concurrent.skip", `it.concurrent.skip("a", async () => {});`, "SKIP", 2],
  ["describe.concurrent.only", `describe.concurrent.only("d", () => {});`, "ONLY", 2],
  ["it.skip.each", `it.skip.each([1, 2])("a %i", () => {});`, "SKIP", 2],
  ["it.each(...).only yok; test.only.each", `test.only.each([1])("a", () => {});`, "ONLY", 2],
  ["it[\"skip\"]", `it["skip"]("a", () => {});`, "SKIP", 2],
  ["it.skipIf", `it.skipIf(process.env.CI)("a", () => {});`, "CONDITIONAL_SKIP", 2],
  ["describe.runIf", `describe.runIf(process.platform === "linux")("d", () => {});`, "CONDITIONAL_SKIP", 2],
  ["xit", `xit("a", () => {});`, "SKIP", 2],
  ["xtest", `xtest("a", () => {});`, "SKIP", 2],
  ["xdescribe", `xdescribe("d", () => {});`, "SKIP", 2],
  ["fit", `fit("a", () => {});`, "ONLY", 2],
  ["fdescribe", `fdescribe("d", () => {});`, "ONLY", 2],
  ["playwright test.skip() gövde içi", `test("a", async () => {\n  test.skip();\n});`, "SKIP", 3],
  ["playwright test.skip(koşul)", `test("a", async ({ browserName }) => {\n  test.skip(browserName === "webkit", "x");\n});`, "SKIP", 3],
  ["playwright test.fixme()", `test("a", async () => {\n  test.fixme();\n});`, "SKIP", 3],
  ["playwright test.fail()", `test("a", async () => {\n  test.fail();\n});`, "SKIP", 3],
  ["playwright test.slow()", `test("a", async () => {\n  test.slow();\n});`, "SKIP", 3],
  ["playwright test.describe.skip", `test.describe.skip("d", () => {});`, "SKIP", 2],
  ["ctx.skip()", `it("a", (ctx) => {\n  ctx.skip();\n});`, "SKIP", 3],
  ["ayrıştırılmış skip()", `it("a", ({ skip }) => {\n  skip();\n});`, "SKIP", 3],
  ["node:test { skip: true }", `test("a", { skip: true }, () => {});`, "SKIP", 2],
  ["node:test { only: true }", `test("a", { only: true }, () => {});`, "ONLY", 2],
  ["node:test t.todo()", `test("a", (t) => {\n  t.todo("sonra");\n});`, "TODO", 3],
  ["if (process.env.CI) return", `it("a", () => {\n  if (process.env.CI) return;\n  expect(1).toBe(1);\n});`, "CONDITIONAL_SKIP", 3],
  ["if (CI) return", `const CI = !!process.env.CI;\nit("a", () => {\n  if (CI) return;\n  expect(1).toBe(1);\n});`, "CONDITIONAL_SKIP", 4],
  ["if (platform) { return }", `import os from "node:os";\ndescribe("d", () => {\n  if (os.platform() === "win32") {\n    return;\n  }\n  it("a", () => {});\n});`, "CONDITIONAL_SKIP", 4],
  ["if (!env.X) return (ikinci deyim)", `it("a", async () => {\n  const x = 1;\n  if (!process.env["DATABASE_URL"]) return;\n  expect(x).toBe(1);\n});`, "CONDITIONAL_SKIP", 4],
]);

describe("scanSource — yasak biçimler", () => {
  it.each(FORBIDDEN)("%s → FAIL", (_name, body, code, line) => {
    expect(codes(IMPORT + body)).toEqual([`${code}@${line}`]);
  });

  it("tsx ve mjs uzantıları da ayrıştırılır", () => {
    expect(codes(`it.only("a", () => { const e = <div />; });`, "a.test.tsx")).toEqual(["ONLY@1"]);
    expect(codes(`xit("a", () => {});`, "a.test.mjs")).toEqual(["SKIP@1"]);
  });

  it("birden çok bulgu satır sırasıyla", () => {
    const src = IMPORT + `it.only("a", () => {});\nit("b", () => {});\nit.todo("c");\n`;
    expect(codes(src)).toEqual(["ONLY@2", "TODO@4"]);
  });
});

describe("scanSource — yanlış alarm yok", () => {
  it("yorumdaki it.skip ve dizedeki \"only\" → OK", () => {
    const src =
      IMPORT +
      [
        `// it.skip("eski", () => {});`,
        `/* describe.only("x") ; xit("y") ; if (process.env.CI) return */`,
        `it("only ve skip kelimeleri", () => {`,
        `  const s = "only";`,
        `  const t = 'it.skip("a")';`,
        `  const u = \`test.todo \${s}\`;`,
        `  expect(s + t + u).toContain("only");`,
        `});`,
      ].join("\n");
    expect(codes(src)).toEqual([]);
  });

  it("temiz dosya → OK", () => {
    const src =
      IMPORT +
      [
        `describe("d", () => {`,
        `  it("a", () => { expect(1).toBe(1); });`,
        `  it.each([1, 2])("b %i", (n) => { expect(n).toBeGreaterThan(0); });`,
        `  test.concurrent("c", async () => { expect(true).toBe(true); });`,
        `  test("node:test skip:false", { skip: false }, () => {});`,
        `  it("ortamı okur ama atlamaz", () => {`,
        `    const ci = process.env.CI;`,
        `    if (ci) { expect(ci).toBeTruthy(); }`,
        `  });`,
        `  it("ortam dışı koşulla erken dönüş", () => {`,
        `    const xs = [];`,
        `    if (xs.length === 0) return;`,
        `  });`,
        `});`,
        `test.beforeEach(() => { if (process.env.CI) return; });`,
      ].join("\n");
    expect(codes(src)).toEqual([]);
  });
});

describe("scanSource — @quarantine istisna değildir", () => {
  it("@quarantine yorumlu it.skip → QUARANTINE_NOT_SUPPORTED", () => {
    const src = IMPORT + `// @quarantine Q-01\nit.skip("kararsız", () => {});\n`;
    expect(codes(src)).toEqual(["QUARANTINE_NOT_SUPPORTED@3"]);
  });

  it("başlıkta @quarantine + gövde içi test.skip() → QUARANTINE_NOT_SUPPORTED", () => {
    const src = IMPORT + `test("kararsız @quarantine Q-02", () => {\n  test.skip();\n});\n`;
    expect(codes(src)).toEqual(["QUARANTINE_NOT_SUPPORTED@3"]);
  });

  it("atlamasız @quarantine etiketi tek başına bulgu değildir", () => {
    const src = IMPORT + `// @quarantine Q-03\nit("koşar", () => { expect(1).toBe(1); });\n`;
    expect(codes(src)).toEqual([]);
  });
});

describe("isTestFile", () => {
  it.each([
    ["src/a.test.ts", true],
    ["src/a.spec.tsx", true],
    ["scripts/x.test.mjs", true],
    ["tests/integration/db.ts", true],
    ["packages/p/tests/helpers.mjs", true],
    ["tests/QUARANTINE.md", false],
    ["src/a.ts", false],
    ["src/testing.ts", false],
  ])("%s → %s", (rel, expected) => {
    expect(isTestFile(rel)).toBe(expected);
  });
});

describe("pnpm check:tests (uçtan uca, geçici depo)", () => {
  /**
   * @param {Record<string, string>} files
   */
  async function check(files) {
    const r = createRepo({ prefix: "guards-tests-" });
    cleanups.push(() => r.cleanup());
    r.writeAll(files);
    /** @type {string[]} */
    const lines = [];
    const code = await main(["tests"], { root: r.dir, log: (l) => lines.push(l) });
    const report = JSON.parse(readFileSync(path.join(r.dir, ".artifacts", "guards", "tests.json"), "utf8"));
    return { code, lines, report };
  }

  it("temiz depo → OK, çıkış 0", async () => {
    const { code, lines, report } = await check({
      "src/a.test.ts": IMPORT + `it("a", () => { expect(1).toBe(1); });\n`,
      "src/a.ts": `export const x = "it.skip";\n`,
    });
    expect(code).toBe(0);
    expect(lines).toEqual(["check:tests OK"]);
    expect(report.details.scanned).toEqual(["src/a.test.ts"]);
  });

  it("eski (değişmemiş) dosyadaki skip de yakalanır; bulgu dosya:satır biçiminde", async () => {
    const { code, lines } = await check({
      "apps/web/x.spec.ts": IMPORT + `\nit.skip("a", () => {});\n`,
      "tests/integration/db.ts": IMPORT + `describe.only("d", () => {});\n`,
    });
    expect(code).toBe(1);
    expect(lines).toEqual([
      `[check:tests] FAIL SKIP apps/web/x.spec.ts:3 — it.skip`,
      `[check:tests] FAIL ONLY tests/integration/db.ts:2 — describe.only`,
      "check:tests FAIL (2)",
    ]);
  });

  it("node_modules, .artifacts, .next, dist hariç; başka muafiyet yok", async () => {
    const bad = IMPORT + `it.only("a", () => {});\n`;
    const { code, lines } = await check({
      "node_modules/p/a.test.ts": bad,
      ".artifacts/a.test.ts": bad,
      "apps/web/.next/a.test.ts": bad,
      "packages/p/dist/a.test.mjs": bad,
      "scripts/guards/fixture.test.mjs": bad,
    });
    expect(code).toBe(1);
    expect(lines).toEqual([`[check:tests] FAIL ONLY scripts/guards/fixture.test.mjs:2 — it.only`, "check:tests FAIL (1)"]);
  });

  it("argüman verilirse kullanım hatası (çıkış 2)", async () => {
    const r = createRepo({ prefix: "guards-tests-" });
    cleanups.push(() => r.cleanup());
    const code = await main(["tests", "--base", "x"], { root: r.dir, log: () => {} });
    expect(code).toBe(2);
  });
});
