// T-007 `pnpm test:ac` testleri. Fixture depolar geçici dizinde üretilir; iç içe gerçek Vitest koşar.
// Not: Bu dosyadaki test başlıkları etiket deseni içermez; fixture etiketleri `TAG` ile kurulur ki
// gerçek repoda `collect.mjs` bu dosyayı AC testi saymasın.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseAcceptance, parsePhaseCell } from "./acceptance.mjs";
import { main, parseArgs, UsageError } from "./cli.mjs";
import { extractTags } from "./collect.mjs";
import { evaluateCondition, parseConditions } from "./conditions.mjs";
import { MarkdownTableError, parsePilotTable } from "../lib/pilot.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TAG = "@" + "AC-";

/** Çocuk Vitest sürecine dış Vitest'in ortamı sızmasın. */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_OPTIONS"));

const ACCEPTANCE = `# Kabul
| ID | Senaryo | Beklenen | Faz |
|---|---|---|---|
| AC-05 | pooler | izole | 0 |
| AC-28 | lint | hata | 0 |
| AC-01 | eşzamanlı | negatif yok | 2 |

## Koşullu kabul senaryoları
| ID | Koşul | Senaryo | Beklenen | Faz |
|---|---|---|---|---|
| AC-34 | Pilotta en az bir ürün grubu LOT | lot | doğru lot | 3A (koşul yoksa 3B) |
| AC-32 | ADR-005 ayrı broker seçtiyse | relay | tek etki | 2 |
`;

/** @param {{ passedGates?: string[] }} [o] */
function conditionsJson(o = {}) {
  return JSON.stringify({
    currentGatePhase: "0",
    passedGates: o.passedGates ?? [],
    facts: { adr005_separate_broker: false },
    factSources: { adr005_separate_broker: "fixture" },
    conditions: {
      "AC-34": { source: "PILOT", key: "tracking_mode.*", anyOf: ["LOT", "LOT_AND_SERIAL"], phase: "3A", fallbackPhase: "3B" },
      "AC-32": { source: "FACT", key: "adr005_separate_broker", anyOf: [true], phase: "2" },
    },
  });
}

/** @param {string} tracking */
function pilotMd(tracking) {
  return `# Pilot\n| key | Alan | Değer | Varsayım |\n|---|---|---|---|\n| tracking_mode.ALL | Takip | ${tracking} | A-16 |\n| expiry_tracking | SKT | NO | A-17 |\n`;
}

/**
 * @param {string} title tam başlık (etiket `TAG` ile kurulmuş)
 * @param {"pass" | "fail" | "skip"} kind
 */
function testFile(title, kind) {
  const body = kind === "fail" ? "expect(1).toBe(2);" : "expect(1).toBe(1);";
  const fn = kind === "skip" ? "it.skip" : "it";
  return `import { expect, it } from "vitest";\n${fn}(${JSON.stringify(title)}, () => {\n  ${body}\n});\n`;
}

/** @type {string[]} */
const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * @param {{ acceptance?: string, conditions?: string, pilot?: string | null, files?: Record<string, string> }} spec
 * @returns {string}
 */
function makeRepo(spec) {
  const root = mkdtempSync(path.join(os.tmpdir(), "test-ac-"));
  tmpDirs.push(root);
  mkdirSync(path.join(root, "docs"), { recursive: true });
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
  writeFileSync(path.join(root, "docs/ACCEPTANCE.md"), spec.acceptance ?? ACCEPTANCE);
  writeFileSync(path.join(root, "docs/ACCEPTANCE.conditions.json"), spec.conditions ?? conditionsJson());
  const pilot = spec.pilot === undefined ? pilotMd("NONE") : spec.pilot;
  if (pilot !== null) writeFileSync(path.join(root, "docs/PILOT.md"), pilot);
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/**
 * @param {string} root
 * @param {string[]} argv
 */
function runCli(root, argv) {
  /** @type {string[]} */
  const lines = [];
  const code = main(argv, { root, log: (l) => lines.push(l), env: CHILD_ENV });
  return { code, lines, out: lines.join("\n") };
}

/** @param {string[]} lines @param {string} id */
function lineFor(lines, id) {
  return lines.find((l) => l.startsWith(`${id} `)) ?? "";
}

describe("koşturucu fixture senaryoları", { timeout: 60_000 }, () => {
  it("etiketsiz AC → NO_TEST ve çıkış 1", () => {
    const root = makeRepo({ files: { "tests/a.test.mjs": testFile(`a ${TAG}05`, "pass") } });
    const r = runCli(root, ["--phase", "0"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/^AC-05 +PASS/);
    expect(lineFor(r.lines, "AC-28")).toMatch(/^AC-28 +NO_TEST/);
    expect(lineFor(r.lines, "AC-01")).toBe("");
    expect(r.code).toBe(1);
  });

  it("fazın tüm etiketli testleri geçerse çıkış 0 ve ayrıntı dosyası yazılır", () => {
    const root = makeRepo({
      files: {
        "tests/a.test.mjs": testFile(`a ${TAG}05`, "pass"),
        "packages/x/src/b.test.mjs": testFile(`b ${TAG}28`, "pass"),
      },
    });
    const r = runCli(root, ["--phase=0"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/PASS — 1 test/);
    expect(lineFor(r.lines, "AC-28")).toMatch(/PASS — 1 test/);
    expect(r.code).toBe(0);
    const detail = JSON.parse(readFileSync(path.join(root, ".artifacts/test-ac/0.json"), "utf8"));
    expect(detail.ok).toBe(true);
    expect(detail.results.map((/** @type {{ id: string }} */ x) => x.id)).toEqual(["AC-05", "AC-28"]);
  });

  it("etiketli test kalırsa FAIL ve çıkış 1", () => {
    const root = makeRepo({
      files: {
        "tests/a.test.mjs": testFile(`a ${TAG}05`, "pass"),
        "tests/b.test.mjs": testFile(`b ${TAG}28`, "fail"),
      },
    });
    const r = runCli(root, ["--phase", "0"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/PASS/);
    expect(lineFor(r.lines, "AC-28")).toMatch(/FAIL — başarısız: tests\/b\.test\.mjs/);
    expect(r.code).toBe(1);
  });

  it("skip edilmiş etiketli test hata sayılır (gerçekten koşan 0)", () => {
    const root = makeRepo({
      files: {
        "tests/a.test.mjs": testFile(`a ${TAG}05`, "skip"),
        "tests/b.test.mjs": testFile(`b ${TAG}28`, "pass"),
      },
    });
    const r = runCli(root, ["--phase", "0"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/FAIL — .*atlanmış \(skipped\)/);
    expect(r.code).toBe(1);
  });

  it("etiketli testin bir kopyası atlanmışsa diğeri geçse de FAIL", () => {
    const root = makeRepo({
      files: {
        "tests/a.test.mjs": `import { expect, it } from "vitest";\nit(${JSON.stringify(`a ${TAG}05`)}, () => { expect(1).toBe(1); });\nit.skip(${JSON.stringify(`b ${TAG}05`)}, () => { expect(1).toBe(1); });\n`,
        "tests/b.test.mjs": testFile(`b ${TAG}28`, "pass"),
      },
    });
    const r = runCli(root, ["--phase", "0"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/FAIL — .*atlanmış/);
    expect(r.code).toBe(1);
  });

  it("koşul doğruysa koşullu AC kapıya dahil edilir ve koşar", () => {
    const root = makeRepo({ pilot: pilotMd("LOT"), files: { "tests/lot.test.mjs": testFile(`lot ${TAG}34`, "pass") } });
    const r = runCli(root, ["--phase", "3A"]);
    expect(lineFor(r.lines, "AC-34")).toMatch(/^AC-34 +PASS — 1 test \[koşul MET: PILOT tracking_mode\.ALL=LOT/);
    expect(r.code).toBe(0);
  });

  it("koşul doğru ama test yoksa NO_TEST ve çıkış 1", () => {
    const root = makeRepo({ pilot: pilotMd("LOT_AND_SERIAL") });
    const r = runCli(root, ["--phase", "3A"]);
    expect(lineFor(r.lines, "AC-34")).toMatch(/NO_TEST/);
    expect(r.code).toBe(1);
  });

  it("koşul yanlışsa SKIPPED ve koşul metni yazılır; çıkış 0", () => {
    const root = makeRepo({ pilot: pilotMd("NONE") });
    const r = runCli(root, ["--phase", "3A"]);
    expect(lineFor(r.lines, "AC-34")).toBe(
      "AC-34  SKIPPED(koşul: Pilotta en az bir ürün grubu LOT) — PILOT tracking_mode.ALL=NONE (gereken: tracking_mode.* ∈ LOT|LOT_AND_SERIAL)",
    );
    expect(r.code).toBe(0);
  });

  it("FACT koşulu yanlışsa (ayrı broker yok) faz 2'de SKIPPED", () => {
    const root = makeRepo({ files: { "tests/c.test.mjs": testFile(`c ${TAG}01`, "pass") } });
    const r = runCli(root, ["--phase", "2"]);
    expect(lineFor(r.lines, "AC-32")).toMatch(/SKIPPED\(koşul: ADR-005 ayrı broker seçtiyse\) — FACT adr005_separate_broker=false/);
    expect(lineFor(r.lines, "AC-01")).toMatch(/PASS/);
    expect(r.code).toBe(0);
  });

  it("3A (koşul yoksa 3B): koşul yanlış + --phase 3B → dahil", () => {
    const root = makeRepo({ pilot: pilotMd("NONE") });
    const r = runCli(root, ["--phase", "3B"]);
    expect(lineFor(r.lines, "AC-34")).toMatch(/^AC-34 +NO_TEST/);
    expect(r.code).toBe(1);
    const passing = makeRepo({ pilot: pilotMd("NONE"), files: { "tests/lot.test.mjs": testFile(`lot ${TAG}34`, "pass") } });
    expect(runCli(passing, ["--phase", "3B"]).code).toBe(0);
  });

  it("3A (koşul yoksa 3B): koşul doğru + --phase 3B → dahil değil", () => {
    const root = makeRepo({ pilot: pilotMd("LOT") });
    const r = runCli(root, ["--phase", "3B"]);
    expect(lineFor(r.lines, "AC-34")).toBe("");
    expect(r.code).toBe(0);
  });

  it("PILOT dosyası yok + --phase 3A → CONDITION_UNKNOWN ve çıkış 1", () => {
    const root = makeRepo({ pilot: null, files: { "tests/lot.test.mjs": testFile(`lot ${TAG}34`, "pass") } });
    const r = runCli(root, ["--phase", "3A"]);
    expect(lineFor(r.lines, "AC-34")).toBe("AC-34  CONDITION_UNKNOWN — docs/PILOT.md yok");
    expect(r.code).toBe(1);
  });

  it("PILOT'ta anahtar yoksa veya değer enum dışındaysa CONDITION_UNKNOWN", () => {
    const noKey = makeRepo({ pilot: "| key | Alan | Değer | Varsayım |\n|---|---|---|---|\n| expiry_tracking | SKT | NO | A-17 |\n" });
    expect(lineFor(runCli(noKey, ["--phase", "3A"]).lines, "AC-34")).toMatch(/CONDITION_UNKNOWN — .*"tracking_mode\.\*" anahtarı yok/);
    const badValue = makeRepo({ pilot: pilotMd("BATCH") });
    const r = runCli(badValue, ["--phase", "3A"]);
    expect(lineFor(r.lines, "AC-34")).toMatch(/CONDITION_UNKNOWN — .*tracking_mode\.ALL="BATCH" geçerli değil/);
    expect(r.code).toBe(1);
  });

  it("PILOT yokken koşullu AC içermeyen faz etkilenmez", () => {
    const root = makeRepo({
      pilot: null,
      files: { "tests/a.test.mjs": testFile(`a ${TAG}05`, "pass"), "tests/b.test.mjs": testFile(`b ${TAG}28`, "pass") },
    });
    expect(runCli(root, ["--phase", "0"]).code).toBe(0);
  });

  it("bozuk ACCEPTANCE satırı → hata ve çıkış 1", () => {
    const broken = ACCEPTANCE.replace("| AC-01 | eşzamanlı | negatif yok | 2 |", "| AC-01 | eşzamanlı | 2 |");
    const r = runCli(makeRepo({ acceptance: broken }), ["--phase", "0"]);
    expect(r.out).toMatch(/test:ac HATA: docs\/ACCEPTANCE\.md:6 satır 4 hücre içermeli/);
    expect(r.code).toBe(1);
    const badPhase = ACCEPTANCE.replace("| negatif yok | 2 |", "| negatif yok | 9 |");
    const r2 = runCli(makeRepo({ acceptance: badPhase }), ["--phase", "0"]);
    expect(r2.out).toMatch(/AC-01: tanınmayan faz "9"/);
    expect(r2.code).toBe(1);
  });

  it("`-- AC-05` yalnızca onu koşar", () => {
    const root = makeRepo({
      files: {
        "tests/a.test.mjs": testFile(`a ${TAG}05`, "pass"),
        "tests/b.test.mjs": testFile(`b ${TAG}28`, "fail"),
      },
    });
    const r = runCli(root, ["--", "AC-05"]);
    expect(r.lines.filter((l) => /^AC-\d+ /.test(l))).toEqual(["AC-05  PASS — 1 test"]);
    expect(r.code).toBe(0);
    const detail = JSON.parse(readFileSync(path.join(root, ".artifacts/test-ac/ids.json"), "utf8"));
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0].files).toEqual(["tests/a.test.mjs"]);
    expect(detail.runs[0].testCount).toBe(1);
  });

  it("ACCEPTANCE'ta olmayan AC istenirse hata", () => {
    const r = runCli(makeRepo({}), ["AC-99"]);
    expect(r.out).toMatch(/HATA: AC-99 ACCEPTANCE\.md'de yok/);
    expect(r.code).toBe(1);
  });

  it("--ci + passedGates:[] + etiketsiz AC → çıkış 0 ve NO_TEST raporlanır", () => {
    const root = makeRepo({ files: { "tests/a.test.mjs": testFile(`a ${TAG}05`, "pass") } });
    const r = runCli(root, ["--ci"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/PASS/);
    expect(lineFor(r.lines, "AC-28")).toMatch(/^AC-28 +NO_TEST — .*bilgi: faz 0 kapısı henüz geçilmedi/);
    expect(lineFor(r.lines, "AC-01")).toMatch(/NO_TEST/);
    expect(r.code).toBe(0);
  });

  it("--ci + passedGates:[\"0\"] + etiketsiz Faz 0 AC'si → çıkış 1", () => {
    const root = makeRepo({ conditions: conditionsJson({ passedGates: ["0"] }), files: { "tests/a.test.mjs": testFile(`a ${TAG}05`, "pass") } });
    const r = runCli(root, ["--ci"]);
    expect(lineFor(r.lines, "AC-28")).toBe(`AC-28  NO_TEST — ${TAG}28 etiketli test yok`);
    expect(lineFor(r.lines, "AC-01")).toMatch(/bilgi: faz 2/);
    expect(r.code).toBe(1);
  });

  it("--ci mevcut her etiketli testi koşar; kalan test kapısı geçilmemiş fazda da kırar", () => {
    const root = makeRepo({ files: { "tests/c.test.mjs": testFile(`c ${TAG}01`, "fail") } });
    const r = runCli(root, ["--ci"]);
    expect(lineFor(r.lines, "AC-01")).toMatch(/FAIL/);
    expect(r.code).toBe(1);
  });

  it("--ci koşulu sağlanmayan AC'nin mevcut testini de koşar", () => {
    const root = makeRepo({ files: { "tests/r.test.mjs": testFile(`relay ${TAG}32`, "fail") } });
    const r = runCli(root, ["--ci"]);
    expect(lineFor(r.lines, "AC-32")).toMatch(/FAIL/);
    expect(r.code).toBe(1);
  });

  it("ACCEPTANCE'ta olmayan etiket hata", () => {
    const root = makeRepo({ files: { "tests/a.test.mjs": testFile(`a ${TAG}5`, "pass") } });
    const r = runCli(root, ["--ci"]);
    expect(r.out).toContain(`HATA: bilinmeyen etiket ${TAG}5 (tests/a.test.mjs:2)`);
    expect(r.code).toBe(1);
  });

  it("entegrasyon testi yapılandırması yoksa FAIL (sessiz atlama yok)", () => {
    const root = makeRepo({
      files: { "tests/integration/a.int.test.mjs": testFile(`a ${TAG}05`, "pass"), "tests/b.test.mjs": testFile(`b ${TAG}28`, "pass") },
    });
    const r = runCli(root, ["--phase", "0"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/FAIL — vitest\.int\.config\.ts yok \(T-005a\)/);
    expect(lineFor(r.lines, "AC-28")).toMatch(/PASS/);
    expect(r.code).toBe(1);
  });

  it("yapılandırmanın kapsamadığı etiketli dosya koşmadıysa FAIL", () => {
    const root = makeRepo({
      files: {
        "vitest.config.mjs": `export default { test: { include: ["tests/**/*.test.mjs"] } };\n`,
        "scripts/a.spec.mjs": testFile(`a ${TAG}05`, "pass"),
        "tests/b.test.mjs": testFile(`b ${TAG}28`, "pass"),
      },
    });
    const r = runCli(root, ["--phase", "0"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/FAIL — /);
    expect(r.code).toBe(1);
  });

  it("Playwright etiketi varken Playwright kurulu değilse FAIL", () => {
    const root = makeRepo({
      files: {
        "tests/e2e/a.spec.ts": `import { test } from "@playwright/test";\ntest(${JSON.stringify(`a ${TAG}05`)}, async () => {});\n`,
        "tests/b.test.mjs": testFile(`b ${TAG}28`, "pass"),
      },
    });
    const r = runCli(root, ["--phase", "0"]);
    expect(lineFor(r.lines, "AC-05")).toMatch(/FAIL — Playwright etiketi bulundu ama @playwright\/test kurulu değil/);
    expect(r.code).toBe(1);
  });

  it("bilinmeyen argüman ve çakışan modlar kullanım hatası (çıkış 2)", () => {
    const root = makeRepo({});
    expect(runCli(root, ["--phase", "9"]).code).toBe(2);
    expect(runCli(root, ["--ci", "--phase", "0"]).code).toBe(2);
    expect(runCli(root, ["--watch"]).code).toBe(2);
  });

  it("argümansız çağrı currentGatePhase fazını değerlendirir", () => {
    const r = runCli(makeRepo({}), []);
    expect(r.out).toMatch(/test:ac faz 0: 2 AC/);
    expect(r.code).toBe(1);
  });
});

describe("ayrıştırıcılar", () => {
  it("faz hücresi: düz, koşullu yedek ve geçersiz değerler", () => {
    expect(parsePhaseCell("4P")).toEqual({ phase: "4P" });
    expect(parsePhaseCell("3A (koşul yoksa 3B)")).toEqual({ phase: "3A", fallbackPhase: "3B" });
    expect(parsePhaseCell("3C")).toBeNull();
    expect(parsePhaseCell("3A (koşul yoksa 3A)")).toBeNull();
    expect(parsePhaseCell("3A (koşul yoksa)")).toBeNull();
  });

  it("ACCEPTANCE: koşullu tablo ve ID sırası ayrıştırılır", () => {
    const acs = parseAcceptance(ACCEPTANCE);
    expect(acs.map((a) => a.id)).toEqual(["AC-05", "AC-28", "AC-01", "AC-34", "AC-32"]);
    expect(acs[3]).toMatchObject({ id: "AC-34", phase: "3A", fallbackPhase: "3B", conditional: true, condition: "Pilotta en az bir ürün grubu LOT" });
  });

  it("ACCEPTANCE: tanınmayan tablo, yinelenen ID, ana tabloda yedek faz hata", () => {
    expect(() => parseAcceptance(`${ACCEPTANCE}\n| a | b |\n|---|---|\n`)).toThrow(MarkdownTableError);
    expect(() => parseAcceptance(ACCEPTANCE.replace("| AC-28 |", "| AC-05 |"))).toThrow(/yinelenen ID AC-05/);
    expect(() => parseAcceptance(ACCEPTANCE.replace("| negatif yok | 2 |", "| negatif yok | 2 (koşul yoksa 3B) |"))).toThrow(/yalnızca koşullu tabloda/);
    expect(() => parseAcceptance(ACCEPTANCE.replace("| AC-28 |", "| AC28 |"))).toThrow(/geçersiz ID "AC28"/);
    expect(() => parseAcceptance("metin")).toThrow(/tam bir ana AC tablosu/);
  });

  it("conditions: ACCEPTANCE ile faz uyuşmazlığı, eksik/fazla koşul ve bilinmeyen alan hata", () => {
    const acs = parseAcceptance(ACCEPTANCE);
    const base = JSON.parse(conditionsJson());
    expect(() => parseConditions(JSON.stringify(base), acs)).not.toThrow();
    const wrongPhase = structuredClone(base);
    wrongPhase.conditions["AC-34"].fallbackPhase = "4P";
    expect(() => parseConditions(JSON.stringify(wrongPhase), acs)).toThrow(/AC-34\.fallbackPhase/);
    const missing = structuredClone(base);
    delete missing.conditions["AC-32"];
    expect(() => parseConditions(JSON.stringify(missing), acs)).toThrow(/AC-32 ACCEPTANCE\.md'de koşullu/);
    const extra = structuredClone(base);
    extra.conditions["AC-05"] = { source: "FACT", key: "x", anyOf: [true], phase: "0" };
    expect(() => parseConditions(JSON.stringify(extra), acs)).toThrow(/koşullu tabloda değil/);
    expect(() => parseConditions(JSON.stringify({ ...base, gate: "0" }), acs)).toThrow(/bilinmeyen alan "gate"/);
    expect(() => parseConditions(JSON.stringify({ ...base, currentGatePhase: 0 }), acs)).toThrow(/currentGatePhase/);
    expect(() => parseConditions(JSON.stringify({ ...base, factSources: {} }), acs)).toThrow(/factSources\.adr005_separate_broker/);
    const badEnum = structuredClone(base);
    badEnum.conditions["AC-34"].anyOf = ["LOTS"];
    expect(() => parseConditions(JSON.stringify(badEnum), acs)).toThrow(/"LOTS"/);
    expect(() => parseConditions("{", acs)).toThrow(/geçersiz JSON/);
  });

  it("koşul değerlendirme: FACT eksik → UNKNOWN; PILOT ayrıştırma hatası → UNKNOWN", () => {
    /** @type {import("./conditions.mjs").Condition} */
    const cond = { source: "FACT", key: "nope", anyOf: [true], phase: "2" };
    expect(evaluateCondition(cond, { pilot: null, facts: {} }).status).toBe("UNKNOWN");
    /** @type {import("./conditions.mjs").Condition} */
    const pc = { source: "PILOT", key: "expiry_tracking", anyOf: ["YES"], phase: "3A", fallbackPhase: "3B" };
    expect(evaluateCondition(pc, { pilot: null, pilotError: "bozuk", facts: {} })).toEqual({ status: "UNKNOWN", detail: "docs/PILOT.md ayrıştırılamadı: bozuk" });
  });

  it("PILOT tablosu: başlık, hücre sayısı, yinelenen key ve ikinci tablo hata", () => {
    expect(parsePilotTable(pilotMd("LOT")).get("tracking_mode.ALL")?.value).toBe("LOT");
    expect(() => parsePilotTable("| key | Değer |\n|---|---|\n| a | b |\n")).toThrow(/tablo başlığı/);
    expect(() => parsePilotTable(`${pilotMd("LOT")}| sector | S |\n`)).toThrow(/4 hücre/);
    expect(() => parsePilotTable(`${pilotMd("LOT")}| expiry_tracking | SKT | YES | A-1 |\n`)).toThrow(/yinelenen key/);
    expect(() => parsePilotTable(`${pilotMd("LOT")}\nmetin\n| a | b |\n`)).toThrow(/birden fazla tablo/);
  });

  it("etiket toplama: yalnızca başlıklar, skip işaretlenir, Playwright ve int ayrılır", () => {
    const src = [
      `import { describe, it } from "vitest";`,
      `// yorum ${TAG}01 sayılmaz`,
      `const s = "dize ${TAG}02 sayılmaz";`,
      `describe("grup ${TAG}03", () => {`,
      `  it.skip('atlanan ${TAG}04 ve ${TAG}04', () => {});`,
      `  it.each([1, 2])("tablo ${TAG}05 %i", () => {});`,
      `  it("${TAG}050 ve ${TAG}5", () => {});`,
      `});`,
    ].join("\n");
    const tags = extractTags(src, "tests/x.test.ts");
    expect(tags.map((t) => [t.id, t.line, t.staticSkip, t.kind])).toEqual([
      ["AC-03", 4, false, "unit"],
      ["AC-04", 5, true, "unit"],
      ["AC-05", 6, false, "unit"],
      ["AC-050", 7, false, "unit"],
      ["AC-5", 7, false, "unit"],
    ]);
    expect(extractTags(`it("a ${TAG}05", () => {})`, "tests/a.int.test.ts")[0]?.kind).toBe("int");
    expect(extractTags(`import { test } from '@playwright/test';\ntest("a ${TAG}05", async () => {})`, "e2e/a.spec.ts")[0]?.kind).toBe("playwright");
  });

  it("argümanlar: `--` yok sayılır, faz doğrulanır, modlar birleşmez", () => {
    expect(parseArgs(["--", "AC-05", "AC-05"])).toEqual({ phase: null, ci: false, ids: ["AC-05"] });
    expect(parseArgs(["--phase", "3B"])).toEqual({ phase: "3B", ci: false, ids: [] });
    expect(() => parseArgs(["--phase"])).toThrow(UsageError);
    expect(() => parseArgs(["--phase", "0", "AC-05"])).toThrow(/birlikte kullanılamaz/);
  });
});
