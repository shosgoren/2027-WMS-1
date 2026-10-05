// T-008d `check:assertions` testleri: AST sayımı (dize kaynaklar) + gerçek geçici git deposunda
// CLI senaryoları (`lib/testkit.mjs`). Etiket `tag()` ile birleştirilir ki bu dosyanın metni
// `collect.mjs` regex taramasında AC testi gibi görünmesin.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.mjs";
import { parseBaseline, scanSource } from "./lib/assertion-count.mjs";
import { createRepo } from "./lib/testkit.mjs";

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** @param {number} n */
const tag = (n) => "@" + "AC-" + n;
const T = tag(1);
const HEAD = `import { describe, expect, it, test } from "vitest";\nimport assert from "node:assert/strict";\n`;
const BASELINE = "tests/.ac-baseline.json";

/**
 * Tek etiketli testin gövdesi → tarama.
 * @param {string} body
 */
const one = (body) => scanSource(`${HEAD}it("${T} a", () => {\n${body}\n});\n`, "x.test.ts");

/** Sabit assertion biçimleri (gövde satırı 4). */
const CONSTANT = [
  "expect(true).toBe(true);",
  "expect(true).toBeTruthy();",
  "expect(1).toBe(1);",
  "expect('x').toBeDefined();",
  "expect(null).toBeNull();",
  "expect(`s`).toEqual(`s`);",
  "expect([1, 2]).toEqual([1, 2]);",
  "expect({ a: 1 }).toStrictEqual({ a: 1 });",
  "expect(-1).not.toBe(0);",
  "expect(!0).toBe(true);",
  "expect(undefined).toBeUndefined();",
  "expect().toBe(1);",
  "expect(x).toBe(x);",
  "expect(res.code).toEqual( res.code );",
  "expect.soft(true).toBe(true);",
  "assert(true);",
  "assert.ok(1, 'mesaj');",
  "assert.equal(x, x);",
  "assert.strictEqual('a', 'a');",
];

/** Gerçek (sabit olmayan) assertion biçimleri. */
const REAL = [
  "expect(res.code).toBe(1);",
  "expect(true).toBe(isValid);",
  "expect(f()).toThrow();",
  "expect(() => f()).toThrowError('x');",
  "expect(text).not.toContain('FAIL');",
  "expect.soft(a).toBe(2);",
  "assert.equal(res.code, 0);",
  "assert(ok);",
  "assertEquals(a, b);",
];

describe("check:assertions sayımı (AST)", () => {
  it.each(CONSTANT)("sabit: %s → CONSTANT_ASSERTION + NO_ASSERTION, sayılmaz", (line) => {
    const s = one(`  const x = 1, res = { code: 1 };\n  ${line}`);
    expect(s.constants.map((c) => c.line)).toEqual([5]);
    expect(s.assertions).toBe(0);
    expect(s.noAssertion).toHaveLength(1);
  });

  it.each(REAL)("gerçek: %s → sayılır", (line) => {
    const s = one(`  ${line}`);
    expect(s.constants).toEqual([]);
    expect(s.assertions).toBe(1);
    expect(s.noAssertion).toEqual([]);
  });

  it("sayılmayanlar: matcher'sız expect, expect.assertions, expect.any, assert.fail, assertType; yorum ve dize", () => {
    const s = one(
      [
        "  expect(x);",
        "  expect.assertions(1);",
        "  const m = expect.any(String);",
        "  assert.fail('ulaşılmaz');",
        "  assertType<string>(m);",
        "  // expect(true).toBe(true)",
        "  const src = 'expect(true).toBe(true)';",
      ].join("\n"),
    );
    expect(s.assertions).toBe(0);
    expect(s.constants).toEqual([]);
    expect(s.noAssertion).toHaveLength(1);
  });

  it("boş `it` ve gövdesiz test → NO_ASSERTION (satır)", () => {
    const s = scanSource(`${HEAD}it("${T} boş", () => {});\ntest("${T} gövdesiz");\n`, "x.test.ts");
    expect(s.noAssertion.map((n) => n.line)).toEqual([3, 4]);
    expect(s.tests).toHaveLength(2);
  });

  it("describe etiketi miras: altındaki her `it` assertion ister; içi boş describe de NO_ASSERTION", () => {
    const src =
      HEAD +
      `describe("${T} grup", () => {\n` +
      `  it("dolu", () => {\n    expect(a).toBe(1);\n  });\n` +
      `  it("boş", () => {});\n` +
      `  describe("iç", () => {\n    it("sabit", () => {\n      expect(true).toBe(true);\n    });\n  });\n` +
      `});\n` +
      `describe("${tag(2)} test yok", () => {});\n` +
      `it("etiketsiz", () => {});\n`;
    const s = scanSource(src, "x.test.ts");
    expect(s.ids).toEqual(["AC-1", "AC-2"]);
    expect(s.tests.map((t) => t.title)).toEqual([`${T} grup dolu`, `${T} grup boş`, `${T} grup iç sabit`]);
    expect(s.noAssertion.map((n) => n.line)).toEqual([7, 9, 14]);
    expect(s.constants.map((c) => c.line)).toEqual([10]);
    expect(s.assertions).toBe(1);
  });

  it("yardımcı işlevdeki assertion geçişli sayılır; özyineleme sonsuz döngü yapmaz", () => {
    const src =
      HEAD +
      `function check(r) {\n  expect(r.code).toBe(0);\n}\n` +
      `const via = (r) => check(r);\n` +
      `function loop(n) {\n  return n > 0 ? loop(n - 1) : n;\n}\n` +
      `it("${T} yardımcı", () => {\n  via(run());\n});\n` +
      `it("${T} döngü", () => {\n  loop(3);\n});\n` +
      `it("${T} işlev referansı", () => check(run()));\n`;
    const s = scanSource(src, "x.test.ts");
    expect(s.noAssertion.map((n) => n.message)).toEqual([`"${T} döngü" testinde sabit olmayan assertion yok`]);
    expect(s.assertions).toBe(1);
  });

  it("it.each / test.describe / şablon başlık etiketi tanınır; etiketsiz dosya AC dosyası değildir", () => {
    const src =
      HEAD +
      "it.each([1, 2])(`" + T + " n=%i`, (n) => {\n  expect(n).toBeGreaterThan(0);\n});\n" +
      `test.describe("${tag(3)} pw", () => {\n  test("x", async () => {\n    await expect(page).toHaveTitle(/a/);\n  });\n});\n`;
    const s = scanSource(src, "x.spec.ts");
    expect(s.ids).toEqual(["AC-1", "AC-3"]);
    expect(s.tests).toHaveLength(2);
    expect(s.assertions).toBe(2);
    expect(scanSource(`${HEAD}it("a", () => { expect(true).toBe(true); });\n`, "y.test.ts").ids).toEqual([]);
  });
});

/**
 * @param {number} ac
 * @param {number} n assertion sayısı (tek testte)
 */
function file(ac, n) {
  let s = HEAD + `it("${tag(ac)} t", () => {\n  const r = run();\n`;
  for (let i = 0; i < n; i++) s += `  expect(r.v${i}).toBe(${i});\n`;
  return s + "});\n";
}

/**
 * @param {import("./lib/testkit.mjs").TestRepo} r
 * @param {string} guard
 * @param {...string} args
 */
async function check(r, guard, ...args) {
  /** @type {string[]} */
  const lines = [];
  const code = await main([guard, ...args], { root: r.dir, log: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
}

/** @param {Record<string, string>} files */
async function setup(files) {
  const r = createRepo({ prefix: "assertions-" });
  cleanups.push(() => r.cleanup());
  r.writeAll({ ".gitignore": ".artifacts/\n", ...files });
  expect((await check(r, "ac-ratchet", "--update")).code).toBe(0);
  r.commit("init").publish("main");
  r.branch("feat/T-100-x");
  return r;
}

/** @param {import("./lib/testkit.mjs").TestRepo} r */
const baselineOf = (r) => parseBaseline(readFileSync(path.join(r.dir, BASELINE), "utf8"));

describe("check:assertions (CLI)", () => {
  it("temiz depo → OK; taban dosya başına assertion sayısını tutar", async () => {
    const r = await setup({ "tests/a.test.ts": file(4, 3), "tests/plain.test.ts": `${HEAD}it("a", () => {});\n` });
    expect(baselineOf(r).acFileAssertions).toEqual({ "tests/a.test.ts": 3 });
    const res = await check(r, "assertions");
    expect(res.code).toBe(0);
    expect(res.text).toContain("check:assertions OK");
  });

  it("expect(true) eklenir → FAIL CONSTANT_ASSERTION dosya:satır", async () => {
    const r = await setup({ "tests/a.test.ts": file(4, 2) });
    r.write("tests/a.test.ts", file(4, 2).replace("  expect(r.v0).toBe(0);\n", "  expect(r.v0).toBe(0);\n  expect(true).toBeTruthy();\n")).commit("sabit");
    const res = await check(r, "assertions");
    expect(res.code).toBe(1);
    expect(res.text).toContain("[check:assertions] FAIL CONSTANT_ASSERTION tests/a.test.ts:6 — sabit assertion: expect(true).toBeTruthy(…)");
  });

  it("assertion silinir → FAIL ASSERTIONS_DECREASED", async () => {
    const r = await setup({ "tests/a.test.ts": file(4, 3) });
    r.write("tests/a.test.ts", file(4, 2)).commit("assertion sil");
    const res = await check(r, "assertions");
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL ASSERTIONS_DECREASED tests/a.test.ts — assertion sayısı 3 → 2");
    const up = await check(r, "assertions", "--update");
    expect(up.code).toBe(1);
    expect(baselineOf(r).acFileAssertions["tests/a.test.ts"]).toBe(3);
  });

  it("assertion'lar silinip boş `it` kalır → NO_ASSERTION + ASSERTIONS_DECREASED", async () => {
    const r = await setup({ "tests/a.test.ts": file(4, 2) });
    r.write("tests/a.test.ts", file(4, 0)).commit("boşalt");
    const res = await check(r, "assertions");
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL NO_ASSERTION tests/a.test.ts:3");
    expect(res.text).toContain("FAIL ASSERTIONS_DECREASED tests/a.test.ts — assertion sayısı 2 → 0");
  });

  it("etiketli dosya silinir → FAIL ASSERTIONS_DECREASED (→ 0)", async () => {
    const r = await setup({ "tests/a.test.ts": file(4, 2), "tests/b.test.ts": file(5, 1) });
    r.remove("tests/b.test.ts").commit("sil");
    const res = await check(r, "assertions");
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL ASSERTIONS_DECREASED tests/b.test.ts — assertion sayısı 1 → 0");
  });

  it("assertion eklenir → FAIL BASELINE_STALE; --update sonrası OK", async () => {
    const r = await setup({ "tests/a.test.ts": file(4, 1) });
    r.write("tests/a.test.ts", file(4, 2)).commit("ekle");
    const res = await check(r, "assertions");
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL BASELINE_STALE tests/a.test.ts — taban 1 < gerçek 2; `pnpm check:ac-ratchet --update`");
    expect((await check(r, "assertions", "--update")).code).toBe(0);
    expect(baselineOf(r).acFileAssertions).toEqual({ "tests/a.test.ts": 2 });
    expect((await check(r, "assertions")).code).toBe(0);
  });

  it("dosya taşıma → WARN BASELINE_MOVED (FAIL değil); --update taban yolunu günceller, sonra OK", async () => {
    const r = await setup({ "tests/a.test.ts": file(4, 2) });
    r.rename("tests/a.test.ts", "tests/moved/a.test.ts").commit("taşı");
    const res = await check(r, "assertions");
    expect(res.code).toBe(0);
    expect(res.text).toContain("WARN BASELINE_MOVED tests/moved/a.test.ts — tests/a.test.ts → tests/moved/a.test.ts taşınmış (2 assertion)");
    const up = await check(r, "ac-ratchet", "--update");
    expect(up.code).toBe(0);
    expect(up.text).toContain("WARN BASELINE_MOVED tests/moved/a.test.ts — taban yolu güncellendi: tests/a.test.ts → tests/moved/a.test.ts");
    expect(baselineOf(r).acFileAssertions).toEqual({ "tests/moved/a.test.ts": 2 });
    const after = await check(r, "assertions");
    expect(after.code).toBe(0);
    expect(after.text).not.toContain("BASELINE_MOVED");
  });

  it("taşınırken assertion azalır → taşıma sayılmaz, ASSERTIONS_DECREASED + BASELINE_STALE", async () => {
    const r = await setup({ "tests/a.test.ts": file(4, 2) });
    r.remove("tests/a.test.ts").write("tests/b.test.ts", file(4, 1)).commit("taşı ve azalt");
    const res = await check(r, "assertions");
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL ASSERTIONS_DECREASED tests/a.test.ts — assertion sayısı 2 → 0");
    expect(res.text).not.toContain("BASELINE_MOVED");
  });
});
