// AC-37 (T-008g): bekçi testi — beş mutasyonun her biri ayrı ayrı `check:all`'ı (CI kipi; `--local`
// değil) kırmızıya çevirir, çıktı neden kodunu ve dosyayı gösterir; temiz durum 0. Gerçek git
// deposu (testkit) + gerçek CLI süreci (`node scripts/guards/cli.mjs all --root <depo>`); GitHub
// bağlamı yok (GITHUB_* ortamdan silinir) → korunan değişiklik onaylanamaz (APPROVAL_UNVERIFIABLE).
// Her mutasyon yalnızca hedeflenen bekçiyi kırar; diğer dört bekçi + belge denetimi OK kalır.
// Ek: `test:ac --ci` çalışma anı atlama denetimi (statik bekçinin kaçırdığı `Reflect.get(it, "skip")`)
// ve `--root`/`--out` (T-008g madde 5 b, c, f).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runAll } from "../../scripts/guards/all.mjs";
import { scanSource } from "../../scripts/guards/lib/assertion-count.mjs";
import { countSummaryLines, reportMismatch } from "../../scripts/test-ac/run.mjs";
import { createRepo } from "../../scripts/guards/lib/testkit.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GUARDS_CLI = path.join(REPO_ROOT, "scripts/guards/cli.mjs");
const TEST_AC_CLI = path.join(REPO_ROOT, "scripts/test-ac/cli.mjs");
/** Fixture içeriğindeki etiketler bu dosyanın etiketi sayılmasın diye parçalı yazılır. */
const TAG = "@" + "AC-";

/**
 * Çocuk sürece CI bağlamı ve dış Vitest ortamı sızmasın (CI kipi = bağlamsız; `--local` değil).
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_") && !k.startsWith("VITEST") && k !== "NODE_OPTIONS"),
  );
}

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const CARD = `# T-100: örnek
**Faz:** 0 · **Ajan:** devops · **Dal:** \`feat/T-100-x\`
**Dokunulacak dosyalar (≤10):** \`src/**\`, \`tests/**\`, \`eslint.config.mjs\`
`;

const AC_FILE = `import { expect, it } from "vitest";

function check(n) {
  expect(n).toBeGreaterThan(0);
}

it("toplama a ${TAG}01", () => {
  check(1);
});

it("toplama b ${TAG}01", () => {
  check(2);
  expect(String(2)).toBe("2");
});
`;

const UNIT_FILE = `import { expect, it } from "vitest";

it("çarpma", () => {
  expect(2 * 3).toBe(6);
});
`;

const ESLINT = `export default [{ rules: { "no-unused-vars": "error" } }];\n`;

const BASELINE = `${JSON.stringify({ acTests: { "AC-01": 2 }, acFileAssertions: { "tests/ac.test.mjs": 2 } }, null, 2)}\n`;

const STACK = `# Stack

## Kilitli sürümler
| bileşen | paket/imaj | sürüm | kaynak | ADR |
|---|---|---|---|---|
| örnek | x | — kilitsiz | — | — |
| TS | typescript | 6.0.3 | package.json#devDependencies.typescript | — |
`;

/** T-008k: `checkStackCoverage` denetimi atlanmasın diye fikstürde geçerli kilit + paket dosyası bulunur. */
const PACKAGE_JSON = `${JSON.stringify({ name: "fx", private: true, devDependencies: { typescript: "6.0.3" } }, null, 2)}\n`;
const LOCK = ["lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    devDependencies:", "      typescript:", "        specifier: 6.0.3", "        version: 6.0.3", ""].join("\n");

const MAP = `# Harita
| yol | durum | açıklama |
|---|---|---|
| \`src/\` | var | kod |
`;

/**
 * `main`: kart, testler, AC tabanı, lint yapılandırması; dal `feat/T-100-x` kapsam içi zararsız bir
 * değişiklik + `mutate` taşır.
 * @param {(r: import("../../scripts/guards/lib/testkit.mjs").TestRepo) => void} [mutate]
 * @param {{ lock?: string | null, pkg?: string }} [opts] `lock: null` → `pnpm-lock.yaml` hiç yok (taban dahil)
 */
function fixture(mutate, opts = {}) {
  const r = createRepo({ prefix: "ac37-" });
  cleanups.push(() => r.cleanup());
  r.writeAll({
    ".gitignore": ".artifacts/\n",
    "docs/tasks/T-100.md": CARD,
    "docs/STACK.md": STACK,
    "docs/MAP.md": MAP,
    "src/a.mjs": "export const a = 1;\n",
    "tests/ac.test.mjs": AC_FILE,
    "tests/unit.test.mjs": UNIT_FILE,
    "tests/.ac-baseline.json": BASELINE,
    "eslint.config.mjs": ESLINT,
    "package.json": opts.pkg ?? PACKAGE_JSON,
    ...(opts.lock === null ? {} : { "pnpm-lock.yaml": opts.lock ?? LOCK }),
  });
  r.commit("init").publish("main");
  r.branch("feat/T-100-x");
  r.write("src/a.mjs", "export const a = 2;\n");
  if (mutate !== undefined) mutate(r);
  r.commit("değişiklik");
  return r;
}

/**
 * Gerçek CLI süreci, başka bir çalışma dizininden `--root` ile.
 * @param {string} root
 */
function checkAll(root) {
  const res = spawnSync(process.execPath, [GUARDS_CLI, "all", "--root", root], {
    cwd: REPO_ROOT,
    env: childEnv(),
    encoding: "utf8",
  });
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const summary = text.split("\n").find((l) => l.startsWith("check:all → ")) ?? "";
  return { code: res.status, text, summary };
}

/**
 * Yalnızca `failing` bekçisi FAIL olan özet satırı.
 * @param {string} failing
 */
function onlyFailing(failing) {
  // `failing` hiçbir adım adı değilse (ör. "-") hepsi OK.
  const steps = ["scope", "tests", "ac-ratchet", "protected", "assertions", "docs"];
  return `check:all → ${steps.map((s) => `${s} ${s === failing ? "FAIL" : "OK"}`).join(" | ")}`;
}

describe("AC-37 bekçi zinciri (check:all, CI kipi)", { timeout: 60_000 }, () => {
  it("@AC-37 temiz durum → çıkış 0, altı adım OK", () => {
    const r = fixture();
    const res = checkAll(r.dir);
    expect(res.summary).toBe(onlyFailing("-"));
    expect(res.code).toBe(0);
  });

  it("@AC-37 kart dışı dosya → FAIL OUT_OF_SCOPE + dosya, yalnızca scope kırmızı", () => {
    const r = fixture((x) => x.write("docs/notlar.md", "# kart dışı\n"));
    const res = checkAll(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("[check:scope] FAIL OUT_OF_SCOPE docs/notlar.md");
    expect(res.summary).toBe(onlyFailing("scope"));
  });

  it("@AC-37 bir test it.skip → FAIL SKIP + dosya, yalnızca tests kırmızı", () => {
    const r = fixture((x) => x.write("tests/unit.test.mjs", UNIT_FILE.replace('it("çarpma"', 'it.skip("çarpma"')));
    const res = checkAll(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toMatch(/\[check:tests\] FAIL SKIP tests\/unit\.test\.mjs/);
    expect(res.summary).toBe(onlyFailing("tests"));
  });

  it("@AC-37 bir @AC testi silinir → FAIL AC_TEST_REMOVED, yalnızca ac-ratchet kırmızı", () => {
    const removed = AC_FILE.replace(`it("toplama a ${TAG}01", () => {\n  check(1);\n});\n\n`, "");
    expect(removed).not.toBe(AC_FILE);
    const r = fixture((x) => x.write("tests/ac.test.mjs", removed));
    const res = checkAll(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("[check:ac-ratchet] FAIL AC_TEST_REMOVED tests/ac.test.mjs — AC-01");
    expect(res.summary).toBe(onlyFailing("ac-ratchet"));
  });

  it("@AC-37 assertion expect(true) yapılır → FAIL CONSTANT_ASSERTION + dosya, yalnızca assertions kırmızı", () => {
    const constant = AC_FILE.replace('expect(String(2)).toBe("2");', "expect(true).toBe(true);");
    expect(constant).not.toBe(AC_FILE);
    const r = fixture((x) => x.write("tests/ac.test.mjs", constant));
    const res = checkAll(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toMatch(/\[check:assertions\] FAIL CONSTANT_ASSERTION tests\/ac\.test\.mjs:\d+/);
    expect(res.summary).toBe(onlyFailing("assertions"));
  });

  it("@AC-37 lint kuralı gevşetilir (korunan yol, kartta listeli) → FAIL APPROVAL_UNVERIFIABLE + dosya, yalnızca protected kırmızı", () => {
    const r = fixture((x) => x.write("eslint.config.mjs", ESLINT.replace('"error"', '"off"')));
    const res = checkAll(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toMatch(/\[check:protected\] FAIL (APPROVAL_UNVERIFIABLE|PROTECTED_NO_APPROVAL) eslint\.config\.mjs/);
    expect(res.summary).toBe(onlyFailing("protected"));
  });

  it("@AC-37 kilit dosyası yok → docs FAIL (denetim atlanmaz), yalnızca docs kırmızı", () => {
    const r = fixture(undefined, { lock: null });
    const res = checkAll(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("stack: pnpm-lock.yaml okunamadı");
    expect(res.summary).toBe(onlyFailing("docs"));
  });

  it("@AC-37 STACK'te kilitli olmayan doğrudan bağımlılık → docs FAIL, yalnızca docs kırmızı", () => {
    const pkg = JSON.stringify({ name: "fx", private: true, devDependencies: { typescript: "6.0.3", leftpad: "1.0.0" } });
    const r = fixture(undefined, { pkg });
    const res = checkAll(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("doğrudan bağımlılık STACK'te kilitli değil: leftpad");
    expect(res.summary).toBe(onlyFailing("docs"));
  });

  it("@AC-37 --root verilen dizini denetler (çağıranın deposunu değil); ayrıntı o kökün .artifacts'ına", () => {
    const r = fixture((x) => x.write("docs/notlar.md", "# kart dışı\n"));
    const res = checkAll(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("docs/notlar.md");
    const report = JSON.parse(readFileSync(path.join(r.dir, ".artifacts/guards/all.json"), "utf8"));
    expect(report.ok).toBe(false);
    expect(report.steps.map((/** @type {{ name: string }} */ s) => s.name)).toEqual(["scope", "tests", "ac-ratchet", "protected", "assertions", "docs"]);
  });
});

const ACCEPTANCE = `# Kabul
| ID | Senaryo | Beklenen | Faz |
|---|---|---|---|
| AC-01 | örnek | geçer | 0 |
`;

const CONDITIONS = JSON.stringify({ currentGatePhase: "0", passedGates: [], facts: {}, factSources: {}, conditions: {} });

/**
 * `test:ac` fixture'ı (git gerekmez); `node_modules` gerçek depoya bağlanır.
 * @param {Record<string, string>} files
 */
function acFixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ac37-testac-"));
  const out = mkdtempSync(path.join(os.tmpdir(), "ac37-out-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs/ACCEPTANCE.md"), ACCEPTANCE);
  writeFileSync(path.join(root, "docs/ACCEPTANCE.conditions.json"), CONDITIONS);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return { root, out };
}

/**
 * @param {string} root
 * @param {string} out
 */
function testAcCi(root, out) {
  const res = spawnSync(process.execPath, [TEST_AC_CLI, "--ci", "--root", root, "--out", out], {
    cwd: REPO_ROOT,
    env: childEnv(),
    encoding: "utf8",
  });
  return { code: res.status, text: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

describe("test:ac --ci çalışma anı atlama denetimi + --root/--out (T-008g 5c, 5f)", { timeout: 120_000 }, () => {
  it("@AC-37 statik bekçinin görmediği Reflect.get(it, \"skip\") → RUNTIME_SKIP + dosya, çıkış 1", () => {
    const hidden = `import { expect, it } from "vitest";\nconst atla = Reflect.get(it, "sk" + "ip");\natla("gizli", () => {\n  expect(1).toBe(2);\n});\nit("açık", () => {\n  expect(1).toBe(1);\n});\n`;
    const { root, out } = acFixture({ "tests/gizli.test.mjs": hidden });
    const res = testAcCi(root, out);
    expect(res.text).toMatch(/HATA: RUNTIME_SKIP tests\/gizli\.test\.mjs › gizli \(skipped\)/);
    expect(res.text).not.toMatch(/RUNTIME_SKIP tests\/gizli\.test\.mjs › açık/);
    expect(res.code).toBe(1);
  });

  it("atlama yoksa --ci çıkış 0; rapor ve vitest çıktısı --out'a, --root ağacına değil", () => {
    const { root, out } = acFixture({ "tests/temiz.test.mjs": UNIT_FILE });
    const res = testAcCi(root, out);
    expect(res.text).not.toContain("RUNTIME_SKIP");
    expect(res.code).toBe(0);
    expect(existsSync(path.join(out, "ci.json"))).toBe(true);
    expect(existsSync(path.join(out, "ci.all.vitest.json"))).toBe(true);
    expect(existsSync(path.join(root, ".artifacts"))).toBe(false);
    const report = JSON.parse(readFileSync(path.join(out, "ci.json"), "utf8"));
    expect(report.runtimeSkipAudit.total).toBe(1);
    expect(report.runtimeSkipAudit.skipped).toEqual([]);
  });

  it("@AC-37 detached alt süreç sahte ikinci Tests özet satırı basar → REPORT_MISMATCH, çıkış 1 (T-008k)", () => {
    const forged = `import { spawn } from "node:child_process";\nimport { expect, it } from "vitest";\n\nit("sahte özet", async () => {\n  const child = spawn(process.execPath, ["-e", "process.stdout.write('      Tests  1 passed (1)\\\\n')"], { detached: true, stdio: "inherit" });\n  await new Promise((resolve) => child.on("close", resolve));\n  expect(1).toBe(1);\n});\n`;
    const { root, out } = acFixture({ "tests/sahte.test.mjs": forged });
    const res = testAcCi(root, out);
    expect(res.text).toMatch(/REPORT_MISMATCH çalışma anı atlama denetimi: vitest stdout'unda tam olarak bir "Tests" özet satırı olmalı \(bulunan: 2\)/);
    expect(res.code).toBe(1);
  });

  it("--root olmayan dizin → kullanım hatası (çıkış 2)", () => {
    const res = spawnSync(process.execPath, [TEST_AC_CLI, "--ci", "--root", path.join(os.tmpdir(), "ac37-olmayan-dizin")], {
      cwd: REPO_ROOT,
      env: childEnv(),
      encoding: "utf8",
    });
    expect(res.status).toBe(2);
  });
});

describe("check:all tabanda bulunmayan bekçi (Supervisor kararı, T-008g bulgu 1–2)", () => {
  /**
   * @param {string[]} missing tabanda olmayan bekçiler
   * @param {string[]} [failing] koşup FAIL dönen bekçiler
   */
  async function runWithBase(missing, failing = []) {
    /** @type {string[]} */
    const lines = [];
    /** @type {string[]} */
    const ran = [];
    const root = mkdtempSync(path.join(os.tmpdir(), "ac37-all-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const code = await runAll({
      root,
      argv: [],
      log: (l) => lines.push(l),
      runGuard: async (g) => {
        ran.push(g);
        return failing.includes(g) ? 1 : 0;
      },
      hasGuard: (g) => !missing.includes(g),
      docs: () => true,
    });
    return { code, ran, text: lines.join("\n"), summary: lines.at(-1) ?? "" };
  }

  it("tabanda olmayan ac-ratchet/assertions → SKIPPED(base), koşturulmaz; geri kalan OK ise çıkış 0", async () => {
    const res = await runWithBase(["ac-ratchet", "assertions"]);
    expect(res.summary).toBe("check:all → scope OK | tests OK | ac-ratchet SKIPPED(base) | protected OK | assertions SKIPPED(base) | docs OK");
    expect(res.text).toContain("SKIPPED_NOT_IN_BASE ac-ratchet");
    expect(res.ran).toEqual(["scope", "tests", "protected"]);
    expect(res.code).toBe(0);
  });

  it("atlanan bekçi varken başka bekçi FAIL → çıkış 1", async () => {
    const res = await runWithBase(["assertions"], ["protected"]);
    expect(res.summary).toContain("protected FAIL");
    expect(res.summary).toContain("assertions SKIPPED(base)");
    expect(res.code).toBe(1);
  });

  it.each(["scope", "tests", "protected"])("güven kökü %s tabanda yoksa FAIL GUARD_NOT_IN_BASE, koşturulmaz", async (g) => {
    const res = await runWithBase([g]);
    expect(res.text).toContain(`[check:${g}] FAIL GUARD_NOT_IN_BASE`);
    expect(res.summary).toContain(`${g} FAIL`);
    expect(res.ran).not.toContain(g);
    expect(res.code).toBe(1);
  });
});

/**
 * T-008k madde 7: etkisiz assertion biçimleri. Her vaka bir `@AC` testinin gövdesidir; tek assertion'ı
 * etkisizse sayı 0 ve NO_ASSERTION bulgusu çıkar. Yanlış pozitif vakaları (etkili benzerleri) sayılır.
 * `ASSERT` düz metin olarak fikstür içindedir (bu dosyanın assertion'ı değildir).
 */
const ASSERT = "expect(v()).toBe(2);";
/** @param {string} body @param {string} [pre] */
function acSource(body, pre = "") {
  return `import { expect, it } from "vitest";\n${pre}\nfunction v() {\n  return 2;\n}\n\nit("vaka ${TAG}01", async () => {\n${body}\n});\n`;
}

/** @type {Array<[string, string, string?]>} [ad, gövde, ön kod] */
const INEFFECTIVE = [
  ["const-yerel sabit yanlış koşul", `const f = false;\nif (f) {\n  ${ASSERT}\n}`],
  ["const-yerel sabit doğru koşulun else kolu", `const f = 1;\nif (f) {\n} else {\n  ${ASSERT}\n}`],
  ["modül düzeyi const sabit koşul", `if (DEBUG) {\n  ${ASSERT}\n}`, "const DEBUG = false;"],
  ["for-of boş dizi", `for (const x of []) {\n  ${ASSERT}\n  void x;\n}`],
  ["for-of const-yerel boş dizi", `const xs = [];\nfor (const x of xs) {\n  ${ASSERT}\n  void x;\n}`],
  ["for sıfır turlu sayaç", `for (let i = 0; i < 0; i++) {\n  ${ASSERT}\n}`],
  ["boş dizi forEach", `[].forEach(() => {\n  ${ASSERT}\n});`],
  ["const-yerel boş dizi map", `const xs = [];\nxs.map(() => {\n  ${ASSERT}\n});`],
  ["setTimeout geri çağrısı", `setTimeout(() => {\n  ${ASSERT}\n}, 10);`],
  ["queueMicrotask geri çağrısı", `queueMicrotask(() => {\n  ${ASSERT}\n});`],
  ["globalThis.setImmediate geri çağrısı", `globalThis.setImmediate(() => {\n  ${ASSERT}\n});`],
  ["await'siz then", `Promise.resolve().then(() => {\n  ${ASSERT}\n});`],
  ["await'siz catch", `Promise.reject(new Error("x")).catch(() => {\n  ${ASSERT}\n});`],
  ["await'siz then zinciri", `Promise.resolve().then(() => 1).then(() => {\n  ${ASSERT}\n});`],
  ["finally içinde return", `try {\n  ${ASSERT}\n} finally {\n  return;\n}`],
  ["catch + finally return", `try {\n  throw new Error("x");\n} catch {\n  ${ASSERT}\n} finally {\n  return;\n}`],
  ["çağrılmayan iç işlev bildirimi", `function inner() {\n  ${ASSERT}\n}`],
  ["çağrılmayan iç ok işlevi", `const inner = () => {\n  ${ASSERT}\n};`],
  ["ifade deyimi işlev", `(() => {\n  ${ASSERT}\n});`],
  // T-008k güvenlik incelemesi MINOR 1-4.
  ["döngüsel const tanımı (RangeError yok, sayılmaz)", `if (a) {\n  ${ASSERT}\n}`, "const a = b;\nconst b = a;"],
  ["kendine başvuran const koşulu", `if (a) {\n  ${ASSERT}\n}`, "const a = a;"],
  ["işlev yalnızca `void` ile geçirilmiş (bildirim)", `function inner() {\n  ${ASSERT}\n}\nvoid inner;`],
  ["işlev yalnızca takma adla geçirilmiş (ok işlevi)", `const inner = () => {\n  ${ASSERT}\n};\nconst alias = inner;\nvoid alias;`],
  ["const sayaç sınırı sıfır", `const n = 0;\nfor (let i = 0; i < n; i++) {\n  ${ASSERT}\n}`],
  ["const başlangıç ve sınır", `const s = 5;\nconst n = 3;\nfor (let i = s; i < n; i++) {\n  ${ASSERT}\n}`],
  ["for-of Array.from([])", `for (const x of Array.from([])) {\n  ${ASSERT}\n  void x;\n}`],
  ["boş dizi concat() forEach", `[].concat().forEach(() => {\n  ${ASSERT}\n});`],
  ["Array.from([]) const forEach", `const xs = Array.from([]);\nxs.forEach(() => {\n  ${ASSERT}\n});`],
  ["new Array() for-of", `for (const x of new Array()) {\n  ${ASSERT}\n  void x;\n}`],
  ["hesaplanmış üye globalThis[\"setTimeout\"]", `globalThis["setTimeout"](() => {\n  ${ASSERT}\n}, 10);`],
  ["hesaplanmış üye boş dizi [\"forEach\"]", `[]["forEach"](() => {\n  ${ASSERT}\n});`],
  ["hesaplanmış üye await'siz [\"then\"]", `Promise.resolve()["then"](() => {\n  ${ASSERT}\n});`],
  ["const boş dizi yalnızca okunuyor", `const xs = [];\nvoid xs.length;\nfor (const x of xs) {\n  ${ASSERT}\n  void x;\n}`],
];

/** @type {Array<[string, string, string?]>} */
const EFFECTIVE = [
  ["let sabit koşul (yeniden atanabilir)", `let f = false;\nf = true;\nif (f) {\n  ${ASSERT}\n}`],
  ["const doğru koşul", `const f = true;\nif (f) {\n  ${ASSERT}\n}`],
  ["parametre const'u gölgeler", `const g = (f) => {\n  if (f) {\n    ${ASSERT}\n  }\n};\ng(true);`, "const f = false;"],
  ["for-of dolu dizi", `for (const x of [1, 2]) {\n  ${ASSERT}\n  void x;\n}`],
  ["for sayaç 2 tur", `for (let i = 0; i < 2; i++) {\n  ${ASSERT}\n}`],
  ["dolu dizi forEach", `[1].forEach(() => {\n  ${ASSERT}\n});`],
  ["zamanlayıcıyı bekleyip sonra assertion", `await new Promise((resolve) => setTimeout(resolve, 1));\n${ASSERT}`],
  ["await edilen then", `await Promise.resolve().then(() => {\n  ${ASSERT}\n});`],
  ["return edilen then", `return Promise.resolve().then(() => {\n  ${ASSERT}\n});`],
  ["await edilen then zinciri", `await Promise.resolve().then(() => 1).then(() => {\n  ${ASSERT}\n});`],
  ["await Promise.all içindeki then", `await Promise.all([Promise.resolve().then(() => {\n  ${ASSERT}\n})]);`],
  ["finally yalnızca temizlik", `try {\n  ${ASSERT}\n} finally {\n  v();\n}`],
  ["çağrılan iç işlev bildirimi", `function inner() {\n  ${ASSERT}\n}\ninner();`],
  ["çağrılan iç ok işlevi", `const inner = () => {\n  ${ASSERT}\n};\ninner();`],
  ["çağrılan IIFE", `(() => {\n  ${ASSERT}\n})();`],
  // T-008k güvenlik incelemesi MINOR 1-4.
  ["işlev argüman olarak geçirilmiş", `function inner() {\n  ${ASSERT}\n}\n[1].forEach(inner);`],
  ["işlev .call ile çağrılmış", `const inner = () => {\n  ${ASSERT}\n};\ninner.call(null);`],
  ["const sayaç sınırı 2", `const n = 2;\nfor (let i = 0; i < n; i++) {\n  ${ASSERT}\n}`],
  ["let sayaç sınırı yeniden atanır", `let n = 0;\nn = 2;\nfor (let i = 0; i < n; i++) {\n  ${ASSERT}\n}`],
  ["const dizi push sonrası for-of", `const xs = [];\nxs.push(1);\nfor (const x of xs) {\n  ${ASSERT}\n  void x;\n}`],
  ["const dizi unshift sonrası forEach", `const xs = [];\nxs.unshift(1);\nxs.forEach(() => {\n  ${ASSERT}\n});`],
  ["const dizi splice sonrası for-of", `const xs = [];\nxs.splice(0, 0, 1);\nfor (const x of xs) {\n  ${ASSERT}\n  void x;\n}`],
  ["const dizi length ataması sonrası for-of", `const xs = [];\nxs.length = 2;\nfor (const x of xs) {\n  ${ASSERT}\n  void x;\n}`],
  ["const dizi dizin ataması sonrası for-of", `const xs = [];\nxs[0] = 1;\nfor (const x of xs) {\n  ${ASSERT}\n  void x;\n}`],
  ["const dizi argüman olarak geçirilip doldurulur", `const xs = [];\nfill(xs);\nfor (const x of xs) {\n  ${ASSERT}\n  void x;\n}`, "function fill(a) {\n  a.push(1);\n}"],
  ["const dizi takma adla doldurulur", `const xs = [];\nconst ys = xs;\nys.push(1);\nfor (const x of xs) {\n  ${ASSERT}\n  void x;\n}`],
  ["Array.from([1]) for-of", `for (const x of Array.from([1])) {\n  ${ASSERT}\n  void x;\n}`],
  ["boş dizi concat([1]) forEach", `[].concat([1]).forEach(() => {\n  ${ASSERT}\n});`],
  ["hesaplanmış üye zamanlayıcıyı bekleyip sonra assertion", `await new Promise((resolve) => globalThis["setTimeout"](resolve, 1));\n${ASSERT}`],
];

describe("assertion-count etkisiz assertion biçimleri (T-008k madde 7)", () => {
  it.each(INEFFECTIVE)("@AC-37 saldırı: %s → assertion sayılmaz, NO_ASSERTION", (_n, body, pre) => {
    const scan = scanSource(acSource(body, pre), "tests/x.test.mjs");
    expect(scan.assertions).toBe(0);
    expect(scan.noAssertion).toHaveLength(1);
  });

  it.each(EFFECTIVE)("@AC-37 yanlış pozitif yok: %s → assertion sayılır", (_n, body, pre) => {
    const scan = scanSource(acSource(body, pre), "tests/x.test.mjs");
    expect(scan.assertions).toBe(1);
    expect(scan.noAssertion).toHaveLength(0);
  });
});

describe("test-ac tek Tests özet satırı şartı (T-008k madde 6)", () => {
  const outcome = { file: "a.test.mjs", fullName: "t", status: "passed" };
  it("@AC-37 özet satırı sayısı: 0 ve >1 → uyuşmazlık, tam 1 + eşleşen sayı → null", () => {
    const one = "      Tests  1 passed (1)\n";
    expect(countSummaryLines(one)).toBe(1);
    expect(reportMismatch([outcome], one)).toBeNull();
    expect(reportMismatch([outcome], "özet yok\n")).toContain("bulunan: 0");
    expect(reportMismatch([outcome], `${one}${one}`)).toContain("bulunan: 2");
    expect(reportMismatch([outcome], `      Tests  9 passed (9)\n${one}`)).toContain("bulunan: 2");
    expect(reportMismatch([outcome], "      Tests  2 passed (2)\n")).toContain("uyuşmuyor");
  });
});
