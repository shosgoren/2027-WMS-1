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
`;

const MAP = `# Harita
| yol | durum | açıklama |
|---|---|---|
| \`src/\` | var | kod |
`;

/**
 * `main`: kart, testler, AC tabanı, lint yapılandırması; dal `feat/T-100-x` kapsam içi zararsız bir
 * değişiklik + `mutate` taşır.
 * @param {(r: import("../../scripts/guards/lib/testkit.mjs").TestRepo) => void} [mutate]
 */
function fixture(mutate) {
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
