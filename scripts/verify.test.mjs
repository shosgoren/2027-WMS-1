import { describe, expect, it } from "vitest";
import { MAX_ERRORS, parseEslintJson, parseTscOutput, parseVitestJson, summarize } from "./verify.mjs";

const ROOT = "/repo";

/** @param {number} n */
function errs(n) {
  return Array.from({ length: n }, (_, i) => ({ file: `src/f${i}.ts`, line: i + 1, message: `hata ${i}` }));
}

describe("summarize", () => {
  it("üç adım OK iken tek özet satırı basar ve ok=true döner", () => {
    const out = summarize([
      { step: "lint", ok: true, errors: [] },
      { step: "typecheck", ok: true, errors: [] },
      { step: "unit", ok: true, errors: [], testCount: 7 },
    ]);
    expect(out.ok).toBe(true);
    expect(out.summary).toBe("verify: lint OK · typecheck OK · unit OK (7 test)");
    expect(out.lines).toEqual([out.summary]);
  });

  it("bir adım FAIL ise ok=false, özet FAIL gösterir ve hatayı dosya:satır ile basar", () => {
    const out = summarize([
      { step: "lint", ok: true, errors: [] },
      { step: "typecheck", ok: false, errors: [{ file: "scripts/verify.mjs", line: 12, message: "TS2322: x" }] },
      { step: "unit", ok: true, errors: [], testCount: 3 },
    ]);
    expect(out.ok).toBe(false);
    expect(out.summary).toBe("verify: lint OK · typecheck FAIL · unit OK (3 test)");
    expect(out.lines[0]).toBe("[typecheck] scripts/verify.mjs:12 TS2322: x");
    expect(out.lines.at(-1)).toBe(out.summary);
  });

  it("satırı bilinmeyen hatayı yalnızca dosya adıyla basar", () => {
    const out = summarize([{ step: "lint", ok: false, errors: [{ file: "eslint", line: null, message: "çöktü" }] }]);
    expect(out.lines[0]).toBe("[lint] eslint çöktü");
  });

  it(`en fazla ${MAX_ERRORS} hata basar, kalanını sayar; adımlar arası toplam kesilir`, () => {
    const out = summarize([
      { step: "lint", ok: false, errors: errs(8) },
      { step: "typecheck", ok: false, errors: errs(7) },
      { step: "unit", ok: true, errors: [], testCount: 1 },
    ]);
    expect(out.lines).toHaveLength(MAX_ERRORS + 2);
    expect(out.lines[7]).toBe("[lint] src/f7.ts:8 hata 7");
    expect(out.lines[8]).toBe("[typecheck] src/f0.ts:1 hata 0");
    expect(out.lines[MAX_ERRORS]).toBe("… 5 hata daha (bkz. .artifacts/verify/*.log)");
    expect(out.summary).toBe("verify: lint FAIL · typecheck FAIL · unit OK (1 test)");
  });

  it("tam sınırda kesme satırı eklemez", () => {
    const out = summarize([{ step: "lint", ok: false, errors: errs(MAX_ERRORS) }]);
    expect(out.lines).toHaveLength(MAX_ERRORS + 1);
    expect(out.lines.some((l) => l.includes("hata daha"))).toBe(false);
  });

  it("unit test sayısını özete yazar; sayı yoksa 0 yazar", () => {
    expect(summarize([{ step: "unit", ok: true, errors: [], testCount: 42 }]).summary).toBe("verify: unit OK (42 test)");
    expect(summarize([{ step: "unit", ok: false, errors: [] }]).summary).toBe("verify: unit FAIL (0 test)");
  });

  it("boş sonuç listesi ok sayılmaz", () => {
    expect(summarize([]).ok).toBe(false);
  });
});

describe("parseTscOutput", () => {
  it("tsc ve pnpm -r önekli satırları dosya:satır + kod olarak çözer, diğerlerini yok sayar", () => {
    const text = [
      "/repo/scripts/verify.mjs(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "apps/web typecheck: src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
      "Scope: 2 of 3 workspace projects",
    ].join("\n");
    expect(parseTscOutput(text, ROOT)).toEqual([
      { file: "scripts/verify.mjs", line: 12, message: "TS2322: Type 'string' is not assignable to type 'number'." },
      { file: "src/a.ts", line: 3, message: "TS2304: Cannot find name 'x'." },
    ]);
  });
});

describe("parseEslintJson", () => {
  it("hata ve uyarıları kural adıyla, göreli yolla döner", () => {
    const json = JSON.stringify([
      {
        filePath: "/repo/a.mjs",
        messages: [
          { severity: 2, line: 4, message: "Unexpected any.", ruleId: "@typescript-eslint/no-explicit-any" },
          { severity: 1, line: 9, message: "unused", ruleId: null },
        ],
      },
      { filePath: "/repo/b.mjs", messages: [] },
    ]);
    expect(parseEslintJson(json, ROOT)).toEqual([
      { file: "a.mjs", line: 4, message: "Unexpected any. (@typescript-eslint/no-explicit-any)" },
      { file: "a.mjs", line: 9, message: "uyarı: unused" },
    ]);
  });

  it("JSON olmayan çıktıda null döner", () => {
    expect(parseEslintJson("Oops! Something went wrong", ROOT)).toBeNull();
  });
});

describe("parseVitestJson", () => {
  it("test sayısını ve başarısız testleri konumuyla döner", () => {
    const json = JSON.stringify({
      numTotalTests: 3,
      success: false,
      testResults: [
        {
          name: "/repo/x.test.ts",
          status: "failed",
          message: "",
          assertionResults: [
            { status: "passed", fullName: "a", failureMessages: [] },
            { status: "failed", fullName: "b", failureMessages: ["AssertionError: 1 !== 2\n    at ..."], location: { line: 5, column: 3 } },
          ],
        },
        { name: "/repo/y.test.ts", status: "failed", message: "Error: import hatası\nstack", assertionResults: [] },
      ],
    });
    expect(parseVitestJson(json, ROOT)).toEqual({
      testCount: 3,
      success: false,
      errors: [
        { file: "x.test.ts", line: 5, message: "b: AssertionError: 1 !== 2" },
        { file: "y.test.ts", line: null, message: "Error: import hatası" },
      ],
    });
  });

  it("geçersiz veya eksik raporda null döner", () => {
    expect(parseVitestJson("", ROOT)).toBeNull();
    expect(parseVitestJson(JSON.stringify({ success: true }), ROOT)).toBeNull();
  });
});
