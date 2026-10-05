// AC-44 (T-008e): karantina kuralı — PROTOCOL §Karantina kuralı. Gerçek git deposu (testkit) +
// gerçek `check:tests` CLI'ı; (e) için ayrıca gerçek `pnpm test:ac` koşturucusu (iç içe Vitest).
// "Kayıt main'de" = `origin/main` (testkit `publish("main")`). Tarihler gerçek UTC bugününe göre.
// Fixture etiketleri `AC` / `QT` ile kurulur ki gerçek depoda `collect.mjs` ve `check:tests`
// bu dosyadaki dizeleri test başlığı saymasın (`scripts/test-ac/test-ac.test.mjs` ile aynı yöntem).
import { readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main as guardMain } from "../../scripts/guards/cli.mjs";
import { todayUtc } from "../../scripts/guards/lib/quarantine.mjs";
import { createRepo } from "../../scripts/guards/lib/testkit.mjs";
import { main as testAcMain } from "../../scripts/test-ac/cli.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AC = "@" + "AC-";
const QT = "@" + "quarantine";
/** Çocuk Vitest sürecine dış Vitest'in ortamı sızmasın. */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_OPTIONS"));

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** @param {number} n gün (negatif = geçmiş) */
const day = (n) => todayUtc(new Date(Date.now() + n * 86_400_000));

/** AC-05 faz 0 (= currentGatePhase, kapı AC'si), AC-50 faz 1. */
const ACCEPTANCE = `# Kabul
| ID | Senaryo | Beklenen | Faz |
|---|---|---|---|
| AC-05 | kapı | kapı | 0 |
| AC-50 | sonraki | sonraki | 1 |
`;
const CONDITIONS = JSON.stringify({ currentGatePhase: "0", passedGates: [], facts: {}, factSources: {}, conditions: {} });
const HEADER = "| Q | Test adı | Dosya | Neden | Sahip kart | Eklendiği tarih | Bitiş tarihi |\n|---|---|---|---|---|---|---|\n";

/**
 * @param {Array<{ id: string, file?: string, added?: string, end?: string }>} rows
 * @returns {string}
 */
function registry(rows) {
  const body = rows.map((r) => `| ${r.id} | kararsız | ${r.file ?? "tests/q.test.mjs"} | zamanlama | T-100 | ${r.added ?? day(-2)} | ${r.end ?? day(5)} |\n`).join("");
  return `# Test karantinası\n\n${HEADER}${body}`;
}

/**
 * Karantinalı test dosyası.
 * @param {string} title tam başlık
 * @param {"pass" | "fail"} kind
 */
function testFile(title, kind) {
  const body = kind === "fail" ? "expect(1 + 1).toBe(3);" : "expect(1 + 1).toBe(2);";
  return `import { expect, it } from "vitest";\nit(${JSON.stringify(title)}, () => {\n  ${body}\n});\n`;
}

/**
 * main: kabul dosyaları + `mainRows` kaydı (yayınlanmış `origin/main`); dal `feat/T-100-q`:
 * `branchRows` kaydı (verilmezse main ile aynı) + etiketli test.
 * @param {{ mainRows: Parameters<typeof registry>[0], branchRows?: Parameters<typeof registry>[0], title: string, kind?: "pass" | "fail" }} spec
 */
function fixture(spec) {
  const r = createRepo({ prefix: "ac44-" });
  cleanups.push(() => r.cleanup());
  r.writeAll({
    ".gitignore": ".artifacts/\nnode_modules\n",
    "docs/ACCEPTANCE.md": ACCEPTANCE,
    "docs/ACCEPTANCE.conditions.json": CONDITIONS,
    "tests/QUARANTINE.md": registry(spec.mainRows),
  });
  r.commit("init").publish("main");
  r.branch("feat/T-100-q");
  if (spec.branchRows !== undefined) r.write("tests/QUARANTINE.md", registry(spec.branchRows));
  r.write("tests/q.test.mjs", testFile(spec.title, spec.kind ?? "pass"));
  r.commit("karantina etiketi");
  return r;
}

/**
 * Gerçek `check:tests` CLI'ı.
 * @param {import("../../scripts/guards/lib/testkit.mjs").TestRepo} r
 */
async function checkTests(r) {
  /** @type {string[]} */
  const lines = [];
  const code = await guardMain(["tests"], { root: r.dir, log: (l) => lines.push(l) });
  const report = JSON.parse(readFileSync(path.join(r.dir, ".artifacts/guards/tests.json"), "utf8"));
  return { code, lines, out: lines.join("\n"), report };
}

/**
 * Gerçek `pnpm test:ac -- <id>` koşturucusu (iç içe Vitest).
 * @param {import("../../scripts/guards/lib/testkit.mjs").TestRepo} r
 * @param {string} id
 */
function testAc(r, id) {
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(r.dir, "node_modules"), "dir");
  /** @type {string[]} */
  const lines = [];
  const code = testAcMain(["--", id], { root: r.dir, log: (l) => lines.push(l), env: CHILD_ENV });
  const artifact = JSON.parse(readFileSync(path.join(r.dir, ".artifacts/test-ac/ids.json"), "utf8"));
  return { code, lines, out: lines.join("\n"), artifact };
}

describe("@AC-44 karantina kuralı (check:tests, gerçek depo)", { timeout: 60_000 }, () => {
  it("@AC-44 (a) kayıtsız etiket → FAIL QUARANTINE_UNREGISTERED (dosya:satır), çıkış 1", async () => {
    const r = fixture({ mainRows: [], title: `kararsız ${QT} Q-09` });
    const { code, out } = await checkTests(r);
    expect(code).toBe(1);
    expect(out).toContain("FAIL QUARANTINE_UNREGISTERED tests/q.test.mjs:2 — Q-09: tests/QUARANTINE.md'de kaydı yok");
    expect(out).toMatch(/check:tests FAIL \(1\)$/);
  });

  it("@AC-44 (a) kimliksiz etiket ve başka dosyaya ait kayıt da kayıtsızdır", async () => {
    const bare = await checkTests(fixture({ mainRows: [], title: `kararsız ${QT}` }));
    expect(bare.code).toBe(1);
    expect(bare.out).toContain("FAIL QUARANTINE_UNREGISTERED tests/q.test.mjs:2");
    const other = await checkTests(fixture({ mainRows: [{ id: "Q-01", file: "tests/baska.test.mjs" }], title: `kararsız ${QT} Q-01` }));
    expect(other.code).toBe(1);
    expect(other.out).toContain("QUARANTINE_UNREGISTERED tests/q.test.mjs:2 — Q-01: kayıt başka dosya için (tests/baska.test.mjs)");
  });

  it("@AC-44 (b) kaydı yalnızca PR dalında olan → FAIL QUARANTINE_NOT_APPROVED", async () => {
    const r = fixture({ mainRows: [], branchRows: [{ id: "Q-01" }], title: `kararsız ${QT} Q-01` });
    const { code, out } = await checkTests(r);
    expect(code).toBe(1);
    expect(out).toContain("FAIL QUARANTINE_NOT_APPROVED tests/q.test.mjs:2 — Q-01: kayıt origin/main'de yok");
    expect(out).toMatch(/check:tests FAIL \(1\)$/);
  });

  it("@AC-44 (b) main'deki kaydı PR'da değiştirmek (bitişi uzatmak) da onaysızdır", async () => {
    const r = fixture({ mainRows: [{ id: "Q-01", end: day(1) }], branchRows: [{ id: "Q-01", end: day(6) }], title: `kararsız ${QT} Q-01` });
    const { code, out } = await checkTests(r);
    expect(code).toBe(1);
    expect(out).toContain("QUARANTINE_NOT_APPROVED tests/q.test.mjs:2 — Q-01: kayıt origin/main'dekinden farklı");
  });

  it("@AC-44 (c) currentGatePhase AC testi (doğrudan veya describe'dan miras) → FAIL QUARANTINE_GATE_AC", async () => {
    const direct = await checkTests(fixture({ mainRows: [{ id: "Q-01" }], title: `kapı ${AC}05 ${QT} Q-01` }));
    expect(direct.code).toBe(1);
    expect(direct.out).toContain("FAIL QUARANTINE_GATE_AC tests/q.test.mjs:2 — kapı AC testi karantinaya alınamaz (AC-05)");
    expect(direct.out).toMatch(/check:tests FAIL \(1\)$/);

    const r = fixture({ mainRows: [{ id: "Q-01" }], title: "yer tutucu" });
    r.write(
      "tests/q.test.mjs",
      `import { describe, expect, it } from "vitest";\ndescribe(${JSON.stringify(`grup ${QT} Q-01`)}, () => {\n  it(${JSON.stringify(`iç ${AC}05`)}, () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n`,
    );
    const nested = await checkTests(r);
    expect(nested.code).toBe(1);
    expect(nested.out).toContain("FAIL QUARANTINE_GATE_AC tests/q.test.mjs:2 — kapı AC testi karantinaya alınamaz (AC-05)");
  });

  it("@AC-44 (d) bitişi geçmiş kayıt → FAIL QUARANTINE_EXPIRED; 14 günü aşan → QUARANTINE_TOO_LONG", async () => {
    const expired = await checkTests(fixture({ mainRows: [{ id: "Q-01", added: day(-10), end: day(-1) }], title: `kararsız ${QT} Q-01` }));
    expect(expired.code).toBe(1);
    expect(expired.out).toContain(`FAIL QUARANTINE_EXPIRED tests/QUARANTINE.md:5 — Q-01: bitiş ${day(-1)} geçti (bugün ${day(0)} UTC)`);
    expect(expired.out).toContain("MEVCUT KARANTİNA: 1 (süresi dolmuş: 1)");
    expect(expired.out).toMatch(/check:tests FAIL \(1\)$/);

    const long = await checkTests(fixture({ mainRows: [{ id: "Q-01", added: day(-1), end: day(14) }], title: `kararsız ${QT} Q-01` }));
    expect(long.code).toBe(1);
    expect(long.out).toContain("FAIL QUARANTINE_TOO_LONG tests/QUARANTINE.md:5 — Q-01:");
    expect(long.out).toContain("= 15 gün (en fazla 14)");
  });

  it("@AC-44 (e) tüm koşulları sağlayan karantina → check:tests OK, rapor satırı görünür", async () => {
    const r = fixture({ mainRows: [{ id: "Q-01", added: day(-1), end: day(13) }], title: `kararsız ${AC}50 ${QT} Q-01`, kind: "fail" });
    const { code, lines, report } = await checkTests(r);
    expect(code).toBe(0);
    expect(lines).toEqual([
      `[check:tests] WARN QUARANTINE_ACTIVE tests/QUARANTINE.md — MEVCUT KARANTİNA: 1 (süresi dolmuş: 0) — Q-01 bitiş ${day(13)}`,
      "check:tests OK",
    ]);
    expect(report.details.quarantine.count).toBe(1);
    expect(report.details.quarantine.sites[0].acIds).toEqual(["AC-50"]);
  });
});

describe("@AC-44 karantinalı test yine koşar ve sonucu raporlanır (test:ac, iç içe Vitest)", { timeout: 120_000 }, () => {
  it("@AC-44 (e) geçerli karantinadaki başarısız test koşar → QUARANTINED_FAIL, kapıyı kırmaz (çıkış 0)", () => {
    const r = fixture({ mainRows: [{ id: "Q-01" }], title: `kararsız ${AC}50 ${QT} Q-01`, kind: "fail" });
    const { code, lines, artifact } = testAc(r, "AC-50");
    const line = lines.find((l) => l.startsWith("AC-50 ")) ?? "";
    expect(line).toMatch(/^AC-50 +QUARANTINED_FAIL — 0 test geçti, 1 karantinalı test başarısız/);
    expect(line).toContain("QUARANTINED_FAIL tests/q.test.mjs › kararsız");
    expect(line).toContain("(kayıt geçerli; kapıyı kırmaz)");
    expect(code).toBe(0);
    // Test gerçekten koştu: Vitest raporunda başarısız sonuç var.
    const res = artifact.results.find((/** @type {{ id: string }} */ x) => x.id === "AC-50");
    expect(res.blocking).toBe(false);
    expect(res.tests.map((/** @type {{ status: string }} */ t) => t.status)).toEqual(["failed"]);
  });

  it("@AC-44 (e) geçerli karantinadaki geçen test → PASS, raporda QUARANTINED_PASS", () => {
    const r = fixture({ mainRows: [{ id: "Q-01" }], title: `kararsız ${AC}50 ${QT} Q-01`, kind: "pass" });
    const { code, lines } = testAc(r, "AC-50");
    const line = lines.find((l) => l.startsWith("AC-50 ")) ?? "";
    expect(line).toMatch(/^AC-50 +PASS — 1 test \[karantina: QUARANTINED_PASS tests\/q\.test\.mjs › kararsız/);
    expect(code).toBe(0);
  });

  it("@AC-44 (b)(d) geçersiz karantinadaki başarısız test kapıyı kırar (FAIL, çıkış 1)", () => {
    const pending = testAc(fixture({ mainRows: [], branchRows: [{ id: "Q-01" }], title: `kararsız ${AC}50 ${QT} Q-01`, kind: "fail" }), "AC-50");
    expect(pending.lines.find((l) => l.startsWith("AC-50 "))).toMatch(/^AC-50 +FAIL — başarısız \(karantina geçersiz: QUARANTINE_NOT_APPROVED: /);
    expect(pending.code).toBe(1);
    const expired = testAc(fixture({ mainRows: [{ id: "Q-01", added: day(-10), end: day(-1) }], title: `kararsız ${AC}50 ${QT} Q-01`, kind: "fail" }), "AC-50");
    expect(expired.lines.find((l) => l.startsWith("AC-50 "))).toContain("QUARANTINE_EXPIRED");
    expect(expired.code).toBe(1);
  });

  it("@AC-44 (c) kapı AC'sinin karantinası geçersizdir: başarısız kapı testi FAIL (çıkış 1)", () => {
    const r = fixture({ mainRows: [{ id: "Q-01" }], title: `kapı ${AC}05 ${QT} Q-01`, kind: "fail" });
    const { code, lines } = testAc(r, "AC-05");
    expect(lines.find((l) => l.startsWith("AC-05 "))).toMatch(/^AC-05 +FAIL — başarısız \(karantina geçersiz: QUARANTINE_GATE_AC: kapı AC testi karantinaya alınamaz \(AC-05\)\)/);
    expect(code).toBe(1);
  });
});
