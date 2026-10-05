// T-008d `check:ac-ratchet` testleri: gerçek geçici git deposu (`lib/testkit.mjs`) + CLI.
// Örnek test kaynakları dize olarak tutulur; etiket `tag()` ile birleştirilir ki bu dosyanın
// metni (`collect.mjs` regex taraması) AC testi gibi görünmesin.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.mjs";
import { parseBaseline, parseRatchetArgs, raiseBaseline, serializeBaseline } from "./lib/assertion-count.mjs";
import { createRepo } from "./lib/testkit.mjs";

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** @param {number} n */
const tag = (n) => "@" + "AC-" + n;
const BASELINE = "tests/.ac-baseline.json";
const HEAD = `import { describe, expect, it } from "vitest";\n`;

/**
 * `n` adet etiketli test (her biri bir assertion).
 * @param {number} ac
 * @param {number} n
 */
function flat(ac, n) {
  let s = HEAD;
  for (let i = 0; i < n; i++) s += `it("${tag(ac)} t${i}", () => {\n  expect(f(${i})).toBe(${i});\n});\n`;
  return s;
}

/**
 * describe etiketli, içinde `n` etiketsiz `it` (etiket mirası).
 * @param {number} ac
 * @param {number} n
 */
function nested(ac, n) {
  let s = HEAD + `describe("${tag(ac)} grup", () => {\n`;
  for (let i = 0; i < n; i++) s += `  it("t${i}", () => {\n    expect(g(${i})).toEqual([${i}]);\n  });\n`;
  return s + "});\n";
}

/**
 * main: dosyalar + `--update` ile oluşturulmuş taban; dal `feat/T-100-x`.
 * @param {Record<string, string>} files
 */
async function setup(files) {
  const r = createRepo({ prefix: "ratchet-" });
  cleanups.push(() => r.cleanup());
  r.writeAll({ ".gitignore": ".artifacts/\n", ...files });
  const u = await check(r, "--update");
  expect(u.code).toBe(0);
  r.commit("init").publish("main");
  r.branch("feat/T-100-x");
  return r;
}

/**
 * @param {import("./lib/testkit.mjs").TestRepo} r
 * @param {...string} args
 */
async function check(r, ...args) {
  /** @type {string[]} */
  const lines = [];
  const code = await main(["ac-ratchet", ...args], { root: r.dir, log: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
}

/** @param {import("./lib/testkit.mjs").TestRepo} r */
const baselineOf = (r) => parseBaseline(readFileSync(path.join(r.dir, BASELINE), "utf8"));

describe("check:ac-ratchet", () => {
  it("ilk --update tabanı tarar; sıralı anahtarlı deterministik biçim; sonra OK", async () => {
    const r = await setup({ "tests/b.test.ts": flat(7, 2), "tests/a.test.ts": nested(12, 3) });
    const text = readFileSync(path.join(r.dir, BASELINE), "utf8");
    expect(text).toBe(
      serializeBaseline({ acTests: { "AC-12": 3, "AC-7": 2 }, acFileAssertions: { "tests/a.test.ts": 3, "tests/b.test.ts": 2 } }),
    );
    expect(Object.keys(JSON.parse(text).acTests)).toEqual(["AC-12", "AC-7"]);
    const res = await check(r);
    expect(res.code).toBe(0);
    expect(res.text).toContain("check:ac-ratchet OK");
  });

  it("etiketli test silinir → FAIL AC_TEST_REMOVED + dosya", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 3), "tests/b.test.ts": flat(6, 1) });
    r.write("tests/a.test.ts", flat(5, 2)).commit("test sil");
    const res = await check(r);
    expect(res.code).toBe(1);
    expect(res.text).toContain("[check:ac-ratchet] FAIL AC_TEST_REMOVED tests/a.test.ts — AC-5: 1 test eksik (taban 3, gerçek 2)");
    expect(res.text).not.toContain("tests/b.test.ts");
  });

  it("describe etiketinden miras alan `it` silinir → FAIL AC_TEST_REMOVED (commit edilmemiş değişiklik de)", async () => {
    const r = await setup({ "tests/a.test.ts": nested(9, 4) });
    r.write("tests/a.test.ts", nested(9, 3));
    const res = await check(r);
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL AC_TEST_REMOVED tests/a.test.ts — AC-9: 1 test eksik (taban 4, gerçek 3)");
  });

  it("etiketli dosya silinir → FAIL AC_TEST_REMOVED o dosya", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 1), "tests/c.test.ts": flat(5, 1) });
    r.remove("tests/c.test.ts").commit("sil");
    const res = await check(r);
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL AC_TEST_REMOVED tests/c.test.ts — AC-5");
  });

  it("yeni etiketli test → FAIL BASELINE_STALE + --update önerisi; --update sonrası OK", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 1) });
    r.write("tests/a.test.ts", flat(5, 2)).write("tests/n.test.ts", flat(8, 1)).commit("yeni testler");
    const res = await check(r);
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL BASELINE_STALE tests/.ac-baseline.json — AC-5: taban 1 < gerçek 2; `pnpm check:ac-ratchet --update`");
    expect(res.text).toContain("FAIL BASELINE_STALE tests/.ac-baseline.json — AC-8: tabanda yok (gerçek 1)");
    const up = await check(r, "--update");
    expect(up.code).toBe(0);
    expect(baselineOf(r).acTests).toEqual({ "AC-5": 2, "AC-8": 1 });
    const again = await check(r);
    expect(again.code).toBe(0);
    expect(again.text).toContain("check:ac-ratchet OK");
  });

  it("--update düşüş yazmaz: taban aynı kalır, AC_TEST_REMOVED sürer", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 3) });
    const before = readFileSync(path.join(r.dir, BASELINE), "utf8");
    r.write("tests/a.test.ts", flat(5, 1)).commit("iki test sil");
    const up = await check(r, "--update");
    expect(up.code).toBe(1);
    expect(up.text).toContain("FAIL AC_TEST_REMOVED tests/a.test.ts — AC-5: 2 test eksik (taban 3, gerçek 1)");
    expect(readFileSync(path.join(r.dir, BASELINE), "utf8")).toBe(before);
  });

  it("dalda taban düşürülür → WARN BASELINE_LOWERED (yalnızca bildirir; onay check:protected'da)", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 2) });
    r.write("tests/a.test.ts", flat(5, 1));
    r.write(BASELINE, serializeBaseline({ acTests: { "AC-5": 1 }, acFileAssertions: { "tests/a.test.ts": 1 } })).commit("taban düşür");
    const res = await check(r);
    expect(res.code).toBe(0);
    expect(res.text).toContain("[check:ac-ratchet] WARN BASELINE_LOWERED tests/.ac-baseline.json — AC tabanı düştü (acTests.AC-5: 2 → 1");
    expect(res.text).toContain("check:ac-ratchet OK");
  });

  it("dosya taşıma (aynı testler) → FAIL değil", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 2) });
    r.rename("tests/a.test.ts", "tests/sub/a.test.ts").commit("taşı");
    const res = await check(r);
    expect(res.code).toBe(0);
    expect(res.text).toContain("check:ac-ratchet OK");
  });

  it("taban yok → FAIL BASELINE_MISSING; bozuk → FAIL BASELINE_INVALID", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 1) });
    r.remove(BASELINE);
    const missing = await check(r);
    expect(missing.code).toBe(1);
    expect(missing.text).toContain("FAIL BASELINE_MISSING tests/.ac-baseline.json");
    r.write(BASELINE, JSON.stringify({ acTests: { "AC-5": -1 }, acFileAssertions: {} }));
    const bad = await check(r);
    expect(bad.code).toBe(1);
    expect(bad.text).toContain("FAIL BASELINE_INVALID tests/.ac-baseline.json — \"acTests.AC-5\" negatif olmayan tamsayı olmalı");
    r.write(BASELINE, "{");
    const broken = await check(r);
    expect(broken.text).toContain("FAIL BASELINE_INVALID");
  });

  it("--base ref'i yok → WARN BASE_UNAVAILABLE, dosya yerine taban gösterilir", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 2) });
    r.write("tests/a.test.ts", flat(5, 1));
    const res = await check(r, "--base", "origin/yok");
    expect(res.code).toBe(1);
    expect(res.text).toContain("WARN BASE_UNAVAILABLE");
    expect(res.text).toContain("FAIL AC_TEST_REMOVED tests/.ac-baseline.json — AC-5");
  });

  it("bilinmeyen argüman → kullanım hatası (çıkış 2)", async () => {
    const r = await setup({ "tests/a.test.ts": flat(5, 1) });
    const res = await check(r, "--force");
    expect(res.code).toBe(2);
    expect(() => parseRatchetArgs("ac-ratchet", ["--base"])).toThrow("--base bir değer ister");
    expect(parseRatchetArgs("ac-ratchet", ["--update", "--base=origin/int/x"])).toEqual({ update: true, base: "origin/int/x" });
  });

  it("raiseBaseline yalnızca yukarı: azalan ve kaybolan anahtarlar korunur", () => {
    const old = { acTests: { "AC-1": 3, "AC-2": 1 }, acFileAssertions: { "a.test.ts": 5, "gone.test.ts": 2 } };
    const next = raiseBaseline(old, { acTests: { "AC-1": 1, "AC-3": 2 }, acFileAssertions: { "a.test.ts": 7 } }, []);
    expect(next).toEqual({ acTests: { "AC-1": 3, "AC-2": 1, "AC-3": 2 }, acFileAssertions: { "a.test.ts": 7, "gone.test.ts": 2 } });
  });
});
