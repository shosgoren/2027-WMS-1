// T-008b `check:tests` testleri. Örnek test kodu yalnızca dize olarak tutulur (AST'de çağrı
// değildir); uçtan uca senaryolar `lib/testkit.mjs` ile geçici depoda koşar.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseVitestSummary, runKind, summaryMismatch } from "../test-ac/run.mjs";
import { main } from "./cli.mjs";
import { scanSource as acScan } from "./lib/assertion-count.mjs";
import { CODES, daysBetween, entryDateFindings, evaluateSite, parseRegistry, quarantineTags } from "./lib/quarantine.mjs";
import { createRepo } from "./lib/testkit.mjs";
import { isTestFile, quarantineSites, scanSource } from "./tests.mjs";

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
  // T-008i MINOR 1: test bağlamından yapı bozulan skip → CONDITIONAL_SKIP (vitest `ctx.skip(koşul)`)
  ["ayrıştırılmış skip()", `it("a", ({ skip }) => {\n  skip();\n});`, "CONDITIONAL_SKIP", 3],
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

/** T-008h m6: security-reviewer'ın denediği atlatmalar — [ad, tam kaynak, beklenen kodlar]. */
const EVASIONS = /** @type {Array<[string, string, string[]]>} */ ([
  ["takma ad: import { it as t } + t.skip", `import { it as t } from "vitest";\nt.skip("a", () => {});`, ["SKIP@2"]],
  ["takma ad: import { describe as d } + d.only", `import { describe as d } from "vitest";\nd.only("x", () => {});`, ["ONLY@2"]],
  ["takma ad: playwright test as base + base.fixme", `import { test as base } from "@playwright/test";\nbase.fixme("a", async () => {});`, ["SKIP@2"]],
  ["varsayılan içe aktarım: node:test", `import t from "node:test";\nt.todo("sonra");`, ["TODO@2"]],
  ["ad alanı: import * as v + v.it.skip", `import * as v from "vitest";\nv.it.skip("a", () => {});`, ["SKIP@2"]],
  ["ad alanı: v.xit", `import * as v from "vitest";\nv.xit("a", () => {});`, ["SKIP@2"]],
  ["takma ad: xit as later", `import { xit as later } from "vitest";\nlater("a", () => {});`, ["SKIP@2"]],
  [
    "test.extend() sonucu: myTest.skip",
    `import { test } from "vitest";\nconst myTest = test.extend({ db: async ({}, use) => use(1) });\nmyTest.skip("a", () => {});`,
    ["SKIP@3"],
  ],
  [
    "playwright base.extend + export + .only",
    `import { test as base } from "@playwright/test";\nexport const test = base.extend({});\ntest.describe.only("d", () => {});`,
    ["ONLY@3"],
  ],
  [
    "zincirleme türetme: const c = it.concurrent; c.skip",
    `import { it as t } from "vitest";\nconst c = t.concurrent;\nc.skip("a", async () => {});`,
    ["SKIP@3"],
  ],
  ["yapı bozma: const { skip } = it", `import { it } from "vitest";\nconst { skip } = it;\nskip("a", () => {});`, ["SKIP@2", "SKIP@3"]],
  ["yapı bozma: const { only: o } = test", `import { test } from "vitest";\nconst { only: o } = test;\no("a", () => {});`, ["ONLY@2"]],
  ["yapı bozma: takma ad kökten", `import { it as t } from "vitest";\nconst { skipIf } = t;\nskipIf(true)("a", () => {});`, ["CONDITIONAL_SKIP@2"]],
  [
    "yapı bozma: ad alanından kök + .only",
    `import * as v from "vitest";\nconst { it: q } = v;\nq.only("a", () => {});`,
    ["ONLY@3"],
  ],
  [
    "ayrı bayrak: const s = !!process.env.X; if (s) return",
    `import { it, expect } from "vitest";\nconst s = !!process.env.X;\nit("a", () => {\n  if (s) return;\n  expect(1).toBe(1);\n});`,
    ["CONDITIONAL_SKIP@4"],
  ],
  [
    "ayrı bayrak: dolaylı türetme (const a = process.env.X; const b = a === '1')",
    `import { it, expect } from "vitest";\nconst a = process.env.X;\nconst b = a === "1";\nit("a", () => {\n  if (!b) { return; }\n  expect(1).toBe(1);\n});`,
    ["CONDITIONAL_SKIP@5"],
  ],
  [
    "ayrı bayrak: yapı bozma ile ortam (const { HAS_DB: d } = process.env)",
    `import { describe, it } from "vitest";\nconst { HAS_DB: d } = process.env;\ndescribe("x", () => {\n  if (!d) return;\n  it("a", () => {});\n});`,
    ["CONDITIONAL_SKIP@4"],
  ],
  [
    "ayrı bayrak + takma ad birlikte",
    `import { test as t } from "vitest";\nconst skipIt = Boolean(process.env.SKIP);\nt("a", () => {\n  if (skipIt) return;\n});`,
    ["CONDITIONAL_SKIP@4"],
  ],
]);

/** T-008i MINOR 1: hesaplanan üye, bağlamdan yapı bozulan skip, dinamik içe aktarım kökleri. */
const EVASIONS_T008I = /** @type {Array<[string, string, string[]]>} */ ([
  ["hesaplanan üye: it[\"sk\" + \"ip\"]", `${IMPORT}it["sk" + "ip"]("a", () => {});`, ["SKIP@2"]],
  ["hesaplanan üye: şablon dize it[`sk${\"ip\"}`]", `${IMPORT}it[\`sk\${"ip"}\`]("a", () => {});`, ["SKIP@2"]],
  ["hesaplanan üye: yer tutucusuz şablon describe[`only`]", `${IMPORT}describe[\`only\`]("d", () => {});`, ["ONLY@2"]],
  ["hesaplanan üye: (\"o\" + \"nly\") parantezli", `${IMPORT}test[("o" + "nly")]("a", () => {});`, ["ONLY@2"]],
  ["hesaplanan üye: değişken it[k] (indirgenemez)", `${IMPORT}const k = "skip";\nit[k]("a", () => {});`, ["SKIP@3"]],
  ["hesaplanan üye: ad alanı v[k]", `import * as v from "vitest";\nconst k = "it";\nv[k].skip("a", () => {});`, ["SKIP@3"]],
  ["hesaplanan yapı bozma: const { [\"sk\"+\"ip\"]: s } = it", `${IMPORT}const { ["sk" + "ip"]: s } = it;\ns("a", () => {});`, ["SKIP@2"]],
  ["hesaplanan yapı bozma: const { [k]: s } = it (indirgenemez)", `${IMPORT}const k = "skip";\nconst { [k]: s } = it;\ns("a", () => {});`, ["SKIP@3"]],
  ["bağlamdan yeniden adlı skip: ({ skip: s }) => s(koşul)", `${IMPORT}it("a", ({ skip: s }) => {\n  s(process.env.CI === "1");\n  expect(1).toBe(1);\n});`, ["CONDITIONAL_SKIP@3"]],
  ["bağlamdan gövdede yapı bozma: const { skip } = ctx", `${IMPORT}it("a", (ctx) => {\n  const { skip: later } = ctx;\n  later();\n});`, ["CONDITIONAL_SKIP@4"]],
  ["bağlamdan atama: const s = ctx.skip", `${IMPORT}test("a", async (ctx) => {\n  const s = ctx["skip"];\n  s();\n});`, ["CONDITIONAL_SKIP@4"]],
  ["bağlamdan yapı bozma, ifade gövdeli ok", `${IMPORT}it("a", ({ skip: s }) => s());`, ["CONDITIONAL_SKIP@2"]],
  ["dinamik içe aktarım: const v = await import(\"vitest\"); v.it.skip", `const v = await import("vitest");\nv.it.skip("a", () => {});`, ["SKIP@2"]],
  ["dinamik içe aktarım: (await import(\"vitest\")).describe.only", `(await import("vitest")).describe.only("d", () => {});`, ["ONLY@1"]],
  ["dinamik içe aktarım: yapı bozma + takma ad", `const { it: t } = await import("vitest");\nt.skip("a", () => {});`, ["SKIP@2"]],
  ["dinamik içe aktarım: türetilmiş kök + yapı bozma", `const v = await import("vitest");\nconst { skip } = v.it;\nskip("a", () => {});`, ["SKIP@2", "SKIP@3"]],
  ["dinamik içe aktarım: .then(({ test }) => test.only(…))", `import("vitest").then(({ test: q }) => {\n  q.only("a", () => {});\n});`, ["ONLY@2"]],
  ["dinamik içe aktarım: .then((v) => v.xit(…))", `import("vitest").then((v) => v.xit("a", () => {}));`, ["SKIP@1"]],
  ["require(\"vitest\")", `const v = require("vitest");\nv.test.todo("x");`, ["TODO@2"]],
]);

describe("scanSource — atlatma denemeleri (T-008i MINOR 1)", () => {
  it.each(EVASIONS_T008I)("MINOR 1 saldırısı: %s → FAIL", (_name, src, expected) => {
    expect(codes(src)).toEqual(expected);
  });

  it("sabit, yasak olmayan hesaplanan üye ve bağlamın başka alanları → OK", () => {
    const src = [
      IMPORT.trim(),
      `it["concurrent"]("a", async () => { expect(1).toBe(1); });`,
      `test[\`each\`]([1])("b %i", (n) => { expect(n).toBe(1); });`,
      `it("c", ({ task, expect: e }) => { e(task.name).toBe("c"); });`,
      `it("d", (ctx) => { const { task } = ctx; expect(task).toBeDefined(); });`,
      `const v = await import("node:path");`,
      `v.join("a", "b");`,
    ].join("\n");
    expect(codes(src)).toEqual([]);
  });
});

describe("scanSource — atlatma denemeleri (T-008h m6)", () => {
  it.each(EVASIONS)("m6 saldırısı: %s → FAIL", (_name, src, expected) => {
    expect(codes(src)).toEqual(expected);
  });

  it("alakasız modülden aynı adlı içe aktarım / ortamdan türemeyen bayrak → OK", () => {
    const src = [
      `import { it, expect } from "vitest";`,
      `import { skip as skipList } from "./list.mjs";`,
      `const n = [1].length > 0;`,
      `it("a", () => {`,
      `  const xs = skipList([1, 2], 1);`,
      `  if (n) { expect(xs).toEqual([2]); }`,
      `  if (xs.length === 0) return;`,
      `});`,
      `const cfg = { s: true };`,
      `it("b", () => { if (cfg.s) return; });`,
    ].join("\n");
    expect(codes(src)).toEqual([]);
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

describe("scanSource — karantina etiketi istisna değildir", () => {
  it("karantina yorumlu it.skip → QUARANTINE_NOT_SUPPORTED", () => {
    const src = IMPORT + `// @quarantine Q-01\nit.skip("kararsız", () => {});\n`;
    expect(codes(src)).toEqual(["QUARANTINE_NOT_SUPPORTED@3"]);
  });

  it("başlıkta karantina etiketi + gövde içi test.skip() → QUARANTINE_NOT_SUPPORTED", () => {
    const src = IMPORT + `test("kararsız @quarantine Q-02", () => {\n  test.skip();\n});\n`;
    expect(codes(src)).toEqual(["QUARANTINE_NOT_SUPPORTED@3"]);
  });

  it("atlamasız karantina etiketi tek başına scanSource bulgusu değildir", () => {
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

// T-008e: karantina etiketleri ve kayıt. Etiket dizeleri `QT` ile kurulur ki bu dosyanın kendi
// başlıkları gerçek depoda karantina etiketi sayılmasın.
const QT = "@" + "quarantine";
/** `collect.mjs` (regex) bu dosyadaki fixture dizelerini AC etiketi saymasın. */
const AC = "@" + "AC-";

describe("quarantineSites — etiket yalnızca başlıkta; describe mirası; takma adlar (T-008e)", () => {
  it("başlıktaki etiket, describe mirası ve alt testlerin AC etiketleri", () => {
    const src =
      IMPORT +
      `it("a ${QT} Q-01 ${AC}50", () => { expect(1).toBe(1); });\n` +
      `describe("grup ${QT} Q-02", () => {\n  it("iç ${AC}05", () => { expect(1).toBe(1); });\n});\n` +
      `describe("dış ${AC}07", () => {\n  it("iç ${QT} Q-03", () => { expect(1).toBe(1); });\n});\n` +
      `// ${QT} Q-04 (yorum etiket değildir)\nit("düz", () => { expect(1).toBe(1); });\n`;
    expect(quarantineSites(src, "x.test.ts").map((x) => [x.line, x.title, x.acIds])).toEqual([
      [2, `a ${QT} Q-01 ${AC}50`, ["AC-50"]],
      [3, `grup ${QT} Q-02`, ["AC-05"]],
      [7, `dış ${AC}07 iç ${QT} Q-03`, ["AC-07"]],
    ]);
  });

  it("takma ad, ad alanı, extend ve test.describe takma adı izlenir", () => {
    const src =
      `import { it as t, describe as d } from "vitest";\nimport * as v from "vitest";\nimport { test } from "vitest";\n` +
      `const tt = test.extend({});\nconst grp = test.describe;\n` +
      `t("a ${QT} Q-01", () => {});\n` +
      `v.it("b ${QT} Q-02", () => {});\n` +
      `tt("c ${QT} Q-03", () => {});\n` +
      `grp("g ${AC}05", () => {\n  t("iç ${QT} Q-04", () => {});\n});\n` +
      `d("h ${QT} Q-05", () => {});\n` +
      `other("x ${QT} Q-06", () => {});\n`;
    expect(quarantineSites(src, "x.test.ts").map((x) => [x.line, x.title])).toEqual([
      [6, `a ${QT} Q-01`],
      [7, `b ${QT} Q-02`],
      [8, `c ${QT} Q-03`],
      [10, `g ${AC}05 iç ${QT} Q-04`],
      [12, `h ${QT} Q-05`],
    ]);
  });

  it("quarantineTags: kimlikli, kimliksiz, yinelenen", () => {
    expect(quarantineTags(`a ${QT} Q-01 ${QT} Q-01 ${QT} Q-12`)).toEqual({ ids: ["Q-01", "Q-12"], bare: false });
    expect(quarantineTags(`a ${QT}`)).toEqual({ ids: [], bare: true });
    expect(quarantineTags(`a ${QT}d Q-01`)).toEqual({ ids: [], bare: false });
    expect(quarantineTags("karantina yok")).toEqual({ ids: [], bare: false });
  });
});

describe("assertion-count — takma adlar check:tests ile aynı çözülür (T-008d bulgu 4)", () => {
  it("import takma adı, ad alanı, extend ve test.describe takma adı altındaki @AC testleri sayılır", () => {
    const src =
      `import { it as t, describe as d } from "vitest";\nimport * as v from "vitest";\nimport { test, expect } from "vitest";\n` +
      `const tt = test.extend({});\nconst grp = test.describe;\n` +
      `t("a ${AC}01", () => { expect(f()).toBe(1); });\n` +
      `v.it("b ${AC}01", () => { expect(f()).toBe(1); });\n` +
      `tt("c ${AC}02", () => { expect(f()).toBe(1); });\n` +
      `grp("g ${AC}03", () => {\n  t("iç", () => { expect(f()).toBe(1); });\n});\n` +
      `d("h ${AC}04", () => {\n  v.test("iç boş", () => {});\n});\n`;
    const r = acScan(src, "x.test.ts");
    expect(r.tests.map((x) => [x.ids, x.title])).toEqual([
      [["AC-01"], `a ${AC}01`],
      [["AC-01"], `b ${AC}01`],
      [["AC-02"], `c ${AC}02`],
      [["AC-03"], `g ${AC}03 iç`],
      [["AC-04"], `h ${AC}04 iç boş`],
    ]);
    expect(r.noAssertion.map((x) => x.line)).toEqual([13]);
  });
});

describe("parseRegistry — tests/QUARANTINE.md (T-008e)", () => {
  const H = "| Q | Test adı | Dosya | Neden | Sahip kart | Eklendiği tarih | Bitiş tarihi |\n|---|---|---|---|---|---|---|\n";

  it("boş tablo ve geçerli satır", () => {
    expect(parseRegistry(`# K\n\n${H}`)).toEqual({ entries: new Map(), errors: [] });
    const r = parseRegistry(`${H}| Q-01 | kararsız | \`tests/a.test.ts\` | zamanlama | T-100 | 2026-10-01 | 2026-10-15 |\n`);
    expect(r.errors).toEqual([]);
    expect(r.entries.get("Q-01")).toEqual({
      id: "Q-01",
      test: "kararsız",
      file: "tests/a.test.ts",
      reason: "zamanlama",
      card: "T-100",
      added: "2026-10-01",
      end: "2026-10-15",
      line: 3,
    });
  });

  it("bozuk satırlar ve tablo yapısı fail-closed", () => {
    const rows = [
      "| Q1 | t | a.ts | n | T-100 | 2026-10-01 | 2026-10-02 |",
      "| Q-02 |  | a.ts | n | T-100 | 2026-10-01 | 2026-10-02 |",
      "| Q-03 | t | ../a.ts | n | T-1 | 2026-02-30 | 2026-10-02 |",
      "| Q-04 | t | a.ts | n | T-100 | 2026-10-05 | 2026-10-01 |",
      "| Q-05 | t | a.ts | n | T-100 | 2026-10-01 |",
      "| Q-06 | t | a.ts | n | T-100 | 2026-10-01 | 2026-10-02 |",
      "| Q-06 | t | a.ts | n | T-100 | 2026-10-01 | 2026-10-02 |",
    ];
    const r = parseRegistry(H + rows.join("\n") + "\n");
    expect([...r.entries.keys()]).toEqual(["Q-06"]);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7, 9]);
    expect(r.errors[2]?.message).toContain("depo-göreli yol değil");
    expect(r.errors[2]?.message).toContain("T-xxx");
    expect(r.errors[2]?.message).toContain("2026-02-30");
    expect(r.errors[5]?.message).toContain("Q-06 yinelenmiş");
    expect(parseRegistry("tablo yok").errors[0]?.message).toContain("bulunan: 0");
    expect(parseRegistry("| A | B |\n|---|---|\n").errors[0]?.message).toContain("başlık");
  });

  it("daysBetween UTC takvim günü", () => {
    expect(daysBetween("2026-10-01", "2026-10-15")).toBe(14);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});

describe("pnpm check:tests — karantina kaydı (uçtan uca, T-008e)", () => {
  const H = "| Q | Test adı | Dosya | Neden | Sahip kart | Eklendiği tarih | Bitiş tarihi |\n|---|---|---|---|---|---|---|\n";

  it("boş kayıt, etiket yok → OK (rapor satırı basılmaz)", async () => {
    const r = createRepo({ prefix: "guards-tests-q-" });
    cleanups.push(() => r.cleanup());
    r.writeAll({ "tests/QUARANTINE.md": `# K\n\n${H}`, "src/a.test.ts": IMPORT + `it("a", () => { expect(1).toBe(1); });\n` });
    /** @type {string[]} */
    const lines = [];
    expect(await main(["tests"], { root: r.dir, log: (l) => lines.push(l) })).toBe(0);
    expect(lines).toEqual(["check:tests OK"]);
  });

  it("bozuk kayıt dosyası → FAIL QUARANTINE_REGISTRY_INVALID; etiket varken kabul dosyası yoksa → QUARANTINE_GATE_AC (fail-closed)", async () => {
    const r = createRepo({ prefix: "guards-tests-q-" });
    cleanups.push(() => r.cleanup());
    r.writeAll({
      "tests/QUARANTINE.md": `${H}| Q-01 | t | src/a.test.ts | n | T-100 | bozuk | 2026-10-02 |\n`,
      "src/a.test.ts": IMPORT + `it("a ${QT} Q-01", () => { expect(1).toBe(1); });\n`,
    });
    r.commit("init").publish("main");
    /** @type {string[]} */
    const lines = [];
    expect(await main(["tests"], { root: r.dir, log: (l) => lines.push(l) })).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("FAIL QUARANTINE_REGISTRY_INVALID tests/QUARANTINE.md:3");
    expect(out).toContain("FAIL QUARANTINE_UNREGISTERED src/a.test.ts:2");
    expect(out).toContain("FAIL QUARANTINE_GATE_AC src/a.test.ts:2 — kapı fazı belirlenemedi");
  });

  it("origin/main yoksa hiçbir kayıt onaylı sayılmaz → QUARANTINE_NOT_APPROVED", async () => {
    const r = createRepo({ prefix: "guards-tests-q-" });
    cleanups.push(() => r.cleanup());
    const today = new Date().toISOString().slice(0, 10);
    r.writeAll({
      "docs/ACCEPTANCE.md": "| ID | Senaryo | Beklenen | Faz |\n|---|---|---|---|\n| AC-50 | s | b | 1 |\n",
      "docs/ACCEPTANCE.conditions.json": JSON.stringify({ currentGatePhase: "0", passedGates: [], facts: {}, factSources: {}, conditions: {} }),
      "tests/QUARANTINE.md": `${H}| Q-01 | t | src/a.test.ts | n | T-100 | ${today} | ${today} |\n`,
      "src/a.test.ts": IMPORT + `it("a ${QT} Q-01", () => { expect(1).toBe(1); });\n`,
    });
    r.commit("init");
    /** @type {string[]} */
    const lines = [];
    expect(await main(["tests"], { root: r.dir, log: (l) => lines.push(l) })).toBe(1);
    expect(lines.join("\n")).toContain("FAIL QUARANTINE_NOT_APPROVED src/a.test.ts:2 — Q-01: origin/main:tests/QUARANTINE.md yok");
  });
});

// T-132b: kapı AC kümesi = currentGatePhase ∪ passedGates (check:tests uçtan uca).
describe("karantina: geçilmiş kapıların AC testleri korunur (T-132b)", () => {
  const H = "| Q | Test adı | Dosya | Neden | Sahip kart | Eklendiği tarih | Bitiş tarihi |\n|---|---|---|---|---|---|---|\n";
  const ACCEPT = "| ID | Senaryo | Beklenen | Faz |\n|---|---|---|---|\n| AC-50 | s | b | 0 |\n| AC-51 | s | b | 1 |\n| AC-52 | s | b | 2 |\n";
  /**
   * @param {string} acId
   * @param {string[]} passedGates
   */
  async function run(acId, passedGates) {
    const r = createRepo({ prefix: "guards-tests-q-" });
    cleanups.push(() => r.cleanup());
    const today = new Date().toISOString().slice(0, 10);
    r.writeAll({
      "docs/ACCEPTANCE.md": ACCEPT,
      "docs/ACCEPTANCE.conditions.json": JSON.stringify({ currentGatePhase: "1", passedGates, facts: {}, factSources: {}, conditions: {} }),
      "tests/QUARANTINE.md": `${H}| Q-01 | t | src/a.test.ts | n | T-100 | ${today} | ${today} |\n`,
      "src/a.test.ts": IMPORT + `it("a ${AC}${acId.slice(3)} ${QT} Q-01", () => { expect(1).toBe(1); });\n`,
    });
    r.commit("init").publish("main");
    /** @type {string[]} */
    const lines = [];
    const code = await main(["tests"], { root: r.dir, log: (l) => lines.push(l) });
    return { code, out: lines.join("\n") };
  }

  it("passedGates:[0], currentGatePhase:1 → Faz 0 AC testi karantinaya alınamaz", async () => {
    const r = await run("AC-50", ["0"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL QUARANTINE_GATE_AC src/a.test.ts:2 — kapı AC testi karantinaya alınamaz (AC-50)");
  });

  it("Faz 1 (güncel) AC testi de karantinaya alınamaz", async () => {
    const r = await run("AC-51", ["0"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("QUARANTINE_GATE_AC src/a.test.ts:2 — kapı AC testi karantinaya alınamaz (AC-51)");
  });

  it("geçilmemiş faz AC'si için karantina eskisi gibi mümkün; passedGates boşken Faz 0 AC'si de", async () => {
    const a = await run("AC-52", ["0"]);
    expect(a.out).not.toContain("QUARANTINE_GATE_AC");
    const b = await run("AC-50", []);
    expect(b.out).not.toContain("QUARANTINE_GATE_AC");
  });
});

// T-008j madde 3 (bekciler-2 incelemesi MINOR): ileri tarihli "eklendiği tarih" 14 gün sınırını
// ötelemesin diye `eklendi ≤ bugün (UTC)` zorunlu → aksi QUARANTINE_FUTURE_DATE.
describe("karantina: eklendiği tarih ≤ bugün (T-008j madde 3)", () => {
  const H = "| Q | Test adı | Dosya | Neden | Sahip kart | Eklendiği tarih | Bitiş tarihi |\n|---|---|---|---|---|---|---|\n";
  /** @param {number} n */
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  /**
   * @param {string} added
   * @param {string} end
   */
  const entry = (added, end) => ({ id: "Q-01", test: "t", file: "src/a.test.ts", reason: "n", card: "T-100", added, end, line: 3 });

  it("saldırı: eklendi = yarın → QUARANTINE_FUTURE_DATE (bitiş 14 gün içinde olsa da)", () => {
    const f = entryDateFindings(entry("2026-10-06", "2026-10-19"), "2026-10-05");
    expect(f.map((x) => x.code)).toEqual([CODES.FUTURE_DATE]);
    expect(f[0]?.message).toContain("2026-10-06 bugünden (2026-10-05 UTC) ileri");
    expect(CODES.FUTURE_DATE).toBe("QUARANTINE_FUTURE_DATE");
  });

  it("saldırı: uzak gelecek tarihli kayıt test:ac yargıcında da (withDates) geçersiz", () => {
    const e = entry("2027-01-01", "2027-01-14");
    const registry = { entries: new Map([["Q-01", e]]), errors: [] };
    const state = { registry, main: registry, mainRef: "origin/main", mainError: null, today: "2026-10-05" };
    const f = evaluateSite({ file: "src/a.test.ts", title: `a ${QT} Q-01`, acIds: [] }, state, { gateAcs: new Set(), withDates: true });
    expect(f.map((x) => x.code)).toEqual([CODES.FUTURE_DATE]);
  });

  it("yanlış pozitif yok: eklendi = bugün veya geçmiş → bulgu yok", () => {
    expect(entryDateFindings(entry("2026-10-05", "2026-10-19"), "2026-10-05")).toEqual([]);
    expect(entryDateFindings(entry("2026-10-01", "2026-10-15"), "2026-10-05")).toEqual([]);
  });

  it("CLI: kayıt satırında eklendi = yarın → check:tests FAIL; bugün → OK", async () => {
    for (const [added, code] of /** @type {Array<[string, number]>} */ ([
      [day(1), 1],
      [day(0), 0],
    ])) {
      const r = createRepo({ prefix: "guards-tests-qf-" });
      cleanups.push(() => r.cleanup());
      r.writeAll({ "tests/QUARANTINE.md": `${H}| Q-01 | t | src/a.test.ts | n | T-100 | ${added} | ${day(13)} |\n`, "src/a.test.ts": IMPORT + `it("a", () => { expect(1).toBe(1); });\n` });
      /** @type {string[]} */
      const lines = [];
      expect(await main(["tests"], { root: r.dir, log: (l) => lines.push(l) }), added).toBe(code);
      const out = lines.join("\n");
      if (code === 1) expect(out).toContain(`FAIL QUARANTINE_FUTURE_DATE tests/QUARANTINE.md:3 — Q-01: eklendiği tarih ${added}`);
      else expect(out).not.toContain("QUARANTINE_FUTURE_DATE");
    }
  });
});

// T-008j madde 7 (bekciler-2 incelemesi MINOR): test:ac koşturucusu (`scripts/test-ac/run.mjs`)
// vitest bittikten sonra süreç grubunu sonlandırır ve JSON rapor sayılarını vitest özet satırıyla
// karşılaştırır. Bu dosyada çünkü kart test listesi `scripts/test-ac/test-ac.test.mjs`'i içermez.
describe("test:ac rapor bütünlüğü (T-008j madde 7)", () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
  const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_OPTIONS"));
  const ESC = String.fromCharCode(27);

  /** @param {Record<string, string>} files */
  function fixture(files) {
    const root = mkdtempSync(path.join(os.tmpdir(), "test-ac-integrity-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
    for (const [rel, content] of Object.entries(files)) writeFileSync(path.join(root, rel), content);
    const artifactDir = path.join(root, "out");
    mkdirSync(artifactDir);
    return { root, artifactDir };
  }

  /**
   * Sahte vitest: JSON raporu (`passed` sayısı) yazar ve verilen özet satırını basar.
   * @param {string} dir
   * @param {{ passed: number, failed: number, summary: string | null }} spec
   */
  function fakeVitest(dir, spec) {
    const bin = path.join(dir, "fake-vitest.mjs");
    const results = [
      ...Array.from({ length: spec.passed }, (_, i) => ({ fullName: `@AC-1 p${i}`, status: "passed", failureMessages: [] })),
      ...Array.from({ length: spec.failed }, (_, i) => ({ fullName: `@AC-1 f${i}`, status: "failed", failureMessages: ["x"] })),
    ];
    const report = JSON.stringify({ testResults: [{ name: path.join(dir, "a.test.mjs"), assertionResults: results }] });
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nconst a = process.argv.find((x) => x.startsWith("--outputFile.json="));\nwriteFileSync(a.slice("--outputFile.json=".length), ${JSON.stringify(report)});\n${spec.summary === null ? "" : `console.log(${JSON.stringify(spec.summary)});\n`}process.exit(${spec.failed > 0 ? 1 : 0});\n`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  /** @param {{ root: string, artifactDir: string }} fx @param {string} vitestBin */
  const run = (fx, vitestBin) => {
    return runKind({ root: fx.root, kind: "unit", files: ["a.test.mjs"], ids: ["AC-1"], artifactDir: fx.artifactDir, name: "t", vitestBin, env: CHILD_ENV });
  };

  it("parseVitestSummary: vitest 5 biçimleri, ANSI renkli satır, son satır geçerlidir; tanınmayan → null", () => {
    expect(parseVitestSummary(" Test Files  1 passed (1)\n      Tests  8 passed | 18 skipped (26)\n")).toEqual({ total: 26, failed: 0, passed: 8, expectedFail: 0, skipped: 18, todo: 0 });
    expect(parseVitestSummary(`${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m${ESC}[2m | ${ESC}[22m${ESC}[1m${ESC}[32m2 passed${ESC}[39m${ESC}[22m${ESC}[90m (3)${ESC}[39m\n`)).toEqual({ total: 3, failed: 1, passed: 2, expectedFail: 0, skipped: 0, todo: 0 });
    expect(parseVitestSummary("      Tests  1 expected fail | 1 todo (2)")).toEqual({ total: 2, failed: 0, passed: 0, expectedFail: 1, skipped: 0, todo: 1 });
    expect(parseVitestSummary("      Tests  no tests")).toEqual({ total: 0, failed: 0, passed: 0, expectedFail: 0, skipped: 0, todo: 0 });
    // Test kodunun önce bastığı sahte satır, vitest'in sonraki gerçek özetini geçemez.
    expect(parseVitestSummary("      Tests  9 passed (9)\n...\n      Tests  1 failed (1)\n")?.failed).toBe(1);
    expect(parseVitestSummary("      Tests  1 passed | 2 bogus (3)")).toBeNull();
    expect(parseVitestSummary("özet yok")).toBeNull();
  });

  it("summaryMismatch: sayılar uyuşursa null; geçen/başarısız/toplam farkı veya özet yoksa açıklama", () => {
    const o = (/** @type {string} */ status) => ({ file: "a.test.mjs", fullName: "@AC-1 x", status });
    const outcomes = [o("passed"), o("failed"), o("skipped")];
    expect(summaryMismatch(outcomes, { total: 3, failed: 1, passed: 1, expectedFail: 0, skipped: 1, todo: 0 })).toBeNull();
    expect(summaryMismatch(outcomes, { total: 3, failed: 0, passed: 2, expectedFail: 0, skipped: 1, todo: 0 })).toContain("uyuşmuyor");
    expect(summaryMismatch(outcomes, { total: 4, failed: 1, passed: 1, expectedFail: 0, skipped: 2, todo: 0 })).toContain("toplam 3");
    expect(summaryMismatch(outcomes, null)).toContain("bulunamadı");
  });

  it("saldırı: JSON raporu 'geçti' der ama vitest özeti başarısız der → REPORT_MISMATCH, koşu güvenilmez", () => {
    const fx = fixture({});
    const r = run(fx, fakeVitest(fx.root, { passed: 1, failed: 0, summary: "      Tests  1 failed (1)" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("REPORT_MISMATCH");
    expect(r.outcomes).toEqual([]);
  });

  it("saldırı: özet satırı yok (rapor tek kaynak olamaz) → REPORT_MISMATCH", () => {
    const fx = fixture({});
    const r = run(fx, fakeVitest(fx.root, { passed: 1, failed: 0, summary: null }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("özet satırı");
  });

  it("yanlış pozitif yok: rapor ve özet uyuşursa (geçen ve başarısız) koşu güvenilir", () => {
    const fx = fixture({});
    const ok = run(fx, fakeVitest(fx.root, { passed: 2, failed: 0, summary: "      Tests  2 passed (2)" }));
    expect(ok.ok).toBe(true);
    expect(ok.outcomes.map((x) => x.status)).toEqual(["passed", "passed"]);
    const red = run(fx, fakeVitest(fx.root, { passed: 1, failed: 1, summary: "      Tests  1 failed | 1 passed (2)" }));
    expect(red.ok).toBe(true);
    expect(red.outcomes.map((x) => x.status)).toEqual(["passed", "failed"]);
  });

  it(
    "saldırı: testin arka planda bıraktığı süreç vitest bittikten sonra yazamaz (süreç grubu sonlandırılır); gerçek vitest ile uyuşan rapor güvenilir",
    async () => {
      const marker = "late-write.txt";
      const fx = fixture({
        "a.test.mjs": [
          `import { spawn } from "node:child_process";`,
          `import { expect, it } from "vitest";`,
          `it(${JSON.stringify("@" + "AC-1 arka plan")}, () => {`,
          `  const code = ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1500);`)};`,
          `  spawn(process.execPath, ["-e", code], { cwd: process.cwd(), stdio: "ignore" }).unref();`,
          `  expect(process.cwd()).toBeTruthy();`,
          `});`,
          ``,
        ].join("\n"),
      });
      const r = run(fx, path.join(REPO_ROOT, "node_modules/.bin/vitest"));
      expect(r.error).toBeNull();
      expect(r.ok).toBe(true);
      expect(r.outcomes.map((x) => x.status)).toEqual(["passed"]);
      await new Promise((res) => setTimeout(res, 2500));
      expect(existsSync(path.join(fx.root, marker))).toBe(false);
    },
    60_000,
  );
});
