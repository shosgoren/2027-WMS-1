// T-008a `check:scope` + `cli.mjs` + `lib/cards.mjs` + `lib/output.mjs` testleri.
// Fixture depolar `lib/testkit.mjs` ile geçici dizinde gerçek git ile kurulur.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.mjs";
import {
  backtickSegmentsOutsideParens,
  cardIdFromBranch,
  cardIntTarget,
  CardError,
  mergedWorkBranches,
  parseCardFiles,
} from "./lib/cards.mjs";
import { createReporter, formatFinding, formatSummary } from "./lib/output.mjs";
import { parseScopeArgs } from "./scope.mjs";
import { createRepo } from "./lib/testkit.mjs";

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * @param {string} id
 * @param {string} files "Dokunulacak dosyalar" satırının gövdesi
 * @param {string} [intTarget]
 */
function card(id, files, intTarget) {
  const dal = `\`feat/${id}-x\`` + (intTarget === undefined ? "" : ` → \`${intTarget}\``);
  return `# ${id}: örnek\n**Faz:** 0 · **Ajan:** devops · **Dal:** ${dal}\n**Dokunulacak dosyalar (≤10):** ${files}\n**Kabul ölçütü:** —\n`;
}

/**
 * main'de üç kart (T-100, T-101, T-102) ve kaynak dosyalar; origin/main yayımlı.
 */
function fixture() {
  const r = createRepo({ prefix: "guards-scope-" });
  cleanups.push(() => r.cleanup());
  r.writeAll({
    ".gitignore": ".artifacts/\n",
    "docs/tasks/T-100.md": card("T-100", "`src/a.mjs`, `src/lib/**` (yardımcılar; `src/gizli.mjs` sayılmaz), `pkg/`"),
    "docs/tasks/T-101.md": card("T-101", "`src/b.mjs`"),
    "docs/tasks/T-102.md": card("T-102", "`src/c.mjs`"),
    "src/a.mjs": "a\n",
    "src/b.mjs": "b\n",
    "src/c.mjs": "c\n",
    "README.md": "r\n",
  });
  r.commit("init").publish("main");
  return r;
}

/**
 * @param {string} root
 * @param {string[]} argv
 */
async function check(root, argv = []) {
  /** @type {string[]} */
  const lines = [];
  const code = await main(["scope", ...argv], { root, log: (l) => lines.push(l) });
  return { code, lines, text: lines.join("\n") };
}

describe("check:scope fixture senaryoları", () => {
  it("kart içi değişiklik → OK", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").write("src/a.mjs", "a2\n").write("src/lib/deep/u.mjs", "u\n").write("pkg/p.json", "{}\n").commit("iş");
    const res = await check(r.dir);
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["check:scope OK"]);
  });

  it("kart dışı dosya → FAIL OUT_OF_SCOPE <yol>", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").write("src/a.mjs", "a2\n").write("README.md", "değişti\n").commit("iş");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.lines).toContainEqual(expect.stringMatching(/^\[check:scope\] FAIL OUT_OF_SCOPE README\.md — kart dosya listesinde yok \(T-100; durum M\)$/));
    expect(res.lines.at(-1)).toBe("check:scope FAIL (1)");
  });

  it("parantez içindeki backtick yolu izin vermez", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").write("src/gizli.mjs", "g\n").commit("iş");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL OUT_OF_SCOPE src/gizli.mjs");
  });

  it("kart dışına yeniden adlandırma → FAIL (yeni yol), eski yol kart içi", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").rename("src/a.mjs", "elsewhere/a.mjs").commit("taşı");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.lines).toContainEqual(
      expect.stringMatching(/FAIL OUT_OF_SCOPE elsewhere\/a\.mjs — .*yeniden adlandırma src\/a\.mjs → elsewhere\/a\.mjs/),
    );
    expect(res.text).not.toContain("OUT_OF_SCOPE src/a.mjs");
  });

  it("kart dışından içeri yeniden adlandırma → FAIL (eski yol silinmiş sayılır)", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").rename("README.md", "src/lib/README.md").commit("taşı");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL OUT_OF_SCOPE README.md");
  });

  it("kartı olmayan dal → FAIL CARD_NOT_FOUND", async () => {
    const r = fixture();
    r.branch("feat/T-999-yok").write("src/a.mjs", "a2\n").commit("iş");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.lines).toContainEqual("[check:scope] FAIL CARD_NOT_FOUND docs/tasks/T-999.md — T-999 kartı yok");
  });

  it("kalıba uymayan dal adı → FAIL CARD_NOT_FOUND (fail-closed)", async () => {
    const r = fixture();
    r.branch("deneme").write("src/a.mjs", "a2\n").commit("iş");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toMatch(/FAIL CARD_NOT_FOUND - — dal adı "deneme" kart kalıbına uymuyor/);
  });

  it("int/ dalında iki kartın birleşimi → OK, üçüncü kartın dosyası → FAIL", async () => {
    const r = fixture();
    r.branch("int/dilim").publish("int/dilim");
    r.branch("feat/T-100-x").write("src/a.mjs", "a2\n").commit("100").checkout("int/dilim");
    r.merge("feat/T-100-x", "Merge remote-tracking branch 'origin/feat/T-100-x' into int/dilim");
    r.branch("fix/T-101-y").write("src/b.mjs", "b2\n").commit("101").checkout("int/dilim");
    r.merge("fix/T-101-y", "Merge pull request #7 from owner/fix/T-101-y");

    const ok = await check(r.dir);
    expect(ok.code).toBe(0);
    expect(ok.lines).toEqual(["check:scope OK"]);

    r.write("src/c.mjs", "c2\n").commit("T-102 dosyası doğrudan int'e");
    const bad = await check(r.dir);
    expect(bad.code).toBe(1);
    expect(bad.lines).toContainEqual(expect.stringMatching(/^\[check:scope\] FAIL OUT_OF_SCOPE src\/c\.mjs — kart dosya listesinde yok \(T-100, T-101; durum M\)$/));
  });

  it("int/ dalında birleştirilen dalın kartı yoksa → FAIL CARD_NOT_FOUND", async () => {
    const r = fixture();
    r.branch("int/dilim");
    r.branch("feat/T-555-x").write("src/a.mjs", "a2\n").commit("555").checkout("int/dilim");
    r.merge("feat/T-555-x");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL CARD_NOT_FOUND docs/tasks/T-555.md");
  });

  it("kart listesi dalda genişletilmiş → OK + SCOPE_CARD_CHANGED", async () => {
    const r = fixture();
    r.branch("feat/T-101-x")
      .write("docs/tasks/T-101.md", card("T-101", "`src/b.mjs`, `extra/**`"))
      .write("extra/e.txt", "e\n")
      .commit("kart genişledi");
    const res = await check(r.dir);
    expect(res.code).toBe(0);
    expect(res.lines).toContainEqual(
      "[check:scope] WARN SCOPE_CARD_CHANGED docs/tasks/T-101.md — kartın dosya listesi dalda değişti (eklenen: extra/**)",
    );
    expect(res.lines.at(-1)).toBe("check:scope OK");
  });

  it("kartın kendisi örtük izinli; listesi değişmeyen kart düzenlemesi uyarı üretmez", async () => {
    const r = fixture();
    r.branch("feat/T-101-x").write("docs/tasks/T-101.md", card("T-101", "`src/b.mjs`") + "\nNot.\n").commit("kart notu");
    const res = await check(r.dir);
    expect(res.lines).toEqual(["check:scope OK"]);
    expect(res.code).toBe(0);
  });

  it("başka bir kartın dosyası örtük izinli değil", async () => {
    const r = fixture();
    r.branch("feat/T-101-x").write("docs/tasks/T-102.md", "değişti\n").commit("başka kart");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL OUT_OF_SCOPE docs/tasks/T-102.md");
  });

  it("dalda oluşturulan kart → SCOPE_CARD_CHANGED uyarısı", async () => {
    const r = fixture();
    r.branch("feat/T-103-x").write("docs/tasks/T-103.md", card("T-103", "`src/d.mjs`")).write("src/d.mjs", "d\n").commit("yeni kart");
    const res = await check(r.dir);
    expect(res.code).toBe(0);
    expect(res.text).toContain("WARN SCOPE_CARD_CHANGED docs/tasks/T-103.md — kart dalda oluşturuldu");
  });

  it("commit'lenmemiş izlenmeyen dosya da denetlenir", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").write("tmp/not.txt", "x\n");
    const res = await check(r.dir);
    expect(res.code).toBe(1);
    expect(res.text).toContain("FAIL OUT_OF_SCOPE tmp/not.txt — kart dosya listesinde yok (T-100; durum ?)");
  });

  it("hedef dal kartın Dal satırındaki int/ hedefinden türetilir; --base bunu ezer", async () => {
    const r = fixture();
    r.write("docs/tasks/T-104.md", card("T-104", "`src/e.mjs`", "int/dilim")).commit("kart").publish("main");
    r.branch("int/dilim").write("src/c.mjs", "int'te başka iş\n").commit("int işi").publish("int/dilim");
    r.branch("feat/T-104-x").write("src/e.mjs", "e\n").commit("104");
    const res = await check(r.dir);
    expect(res.lines).toEqual(["check:scope OK"]);
    const json = JSON.parse(readFileSync(path.join(r.dir, ".artifacts/guards/scope.json"), "utf8"));
    expect(json.details.target).toBe("origin/int/dilim");

    const vsMain = await check(r.dir, ["--base", "origin/main"]);
    expect(vsMain.code).toBe(1);
    expect(vsMain.text).toContain("FAIL OUT_OF_SCOPE src/c.mjs");
  });

  it("hedef ref yoksa → FAIL GIT_ERROR", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").write("src/a.mjs", "a2\n").commit("iş");
    const res = await check(r.dir, ["--base=origin/yok"]);
    expect(res.code).toBe(1);
    expect(res.text).toMatch(/FAIL GIT_ERROR - — hedef ref bulunamadı: origin\/yok/);
  });

  it("--branch ayrık HEAD'de dal adını verir", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").write("src/a.mjs", "a2\n").commit("iş");
    r.git("checkout", "--quiet", "--detach");
    expect((await check(r.dir)).text).toContain("FAIL GIT_ERROR");
    expect((await check(r.dir, ["--branch", "feat/T-100-x"])).lines).toEqual(["check:scope OK"]);
  });

  it("ayrıntı .artifacts/guards/scope.json'a yazılır", async () => {
    const r = fixture();
    r.branch("feat/T-100-x").write("README.md", "x\n").commit("iş");
    await check(r.dir);
    const json = JSON.parse(readFileSync(path.join(r.dir, ".artifacts/guards/scope.json"), "utf8"));
    expect(json.guard).toBe("scope");
    expect(json.ok).toBe(false);
    expect(json.failures).toEqual([
      { level: "FAIL", code: "OUT_OF_SCOPE", file: "README.md", message: "kart dosya listesinde yok (T-100; durum M)" },
    ]);
    expect(json.details.branch).toBe("feat/T-100-x");
    expect(json.details.cards[0].globs).toEqual(["src/a.mjs", "src/lib/**", "pkg/**"]);
  });
});

describe("cli.mjs", () => {
  /** @returns {string} */
  function tmp() {
    const d = mkdtempSync(path.join(os.tmpdir(), "guards-cli-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  }

  it("modülü yazılmamış bekçi → FAIL NOT_IMPLEMENTED + çıkış 1", async () => {
    const root = tmp();
    for (const name of ["tests", "ac-ratchet", "protected", "assertions", "pilot"]) {
      /** @type {string[]} */
      const lines = [];
      const code = await main([name], { root, guardsDir: root, log: (l) => lines.push(l) });
      expect(code).toBe(1);
      expect(lines[0]).toMatch(new RegExp(`^\\[check:${name}\\] FAIL NOT_IMPLEMENTED - — check:${name} henüz yazılmadı`));
      expect(lines.at(-1)).toBe(`check:${name} FAIL (1)`);
    }
  });

  it("bilinmeyen bekçi adı → çıkış 2", async () => {
    /** @type {string[]} */
    const lines = [];
    expect(await main(["yok"], { root: tmp(), log: (l) => lines.push(l) })).toBe(2);
    expect(await main([], { root: tmp(), log: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toContain('bilinmeyen bekçi "yok"');
  });

  it("run dışa aktarmayan modül → FAIL GUARD_INVALID", async () => {
    const root = tmp();
    writeFileSync(path.join(root, "tests.mjs"), "export const x = 1;\n");
    /** @type {string[]} */
    const lines = [];
    expect(await main(["tests"], { root, guardsDir: root, log: (l) => lines.push(l) })).toBe(1);
    expect(lines[0]).toBe("[check:tests] FAIL GUARD_INVALID tests.mjs — modül `run(ctx)` dışa aktarmıyor");
  });

  it("kullanım hatası → çıkış 2", async () => {
    /** @type {string[]} */
    const lines = [];
    expect(await main(["scope", "--bilinmeyen"], { root: tmp(), log: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toBe('check:scope HATA: bilinmeyen argüman "--bilinmeyen"');
  });
});

describe("lib/cards.mjs", () => {
  it("dal adından kart kimliği", () => {
    expect(cardIdFromBranch("feat/T-008a-guard-core-scope")).toBe("T-008a");
    expect(cardIdFromBranch("fix/T-123-x")).toBe("T-123");
    expect(cardIdFromBranch("feat/T-008a")).toBeNull();
    expect(cardIdFromBranch("feat/T-08-x")).toBeNull();
    expect(cardIdFromBranch("chore/T-001-x")).toBeNull();
    expect(cardIdFromBranch("int/faz0")).toBeNull();
  });

  it("birleştirme konularından çalışma dalları", () => {
    expect(
      mergedWorkBranches([
        "Merge remote-tracking branch 'origin/feat/T-007-test-ac' into int/faz0-bekciler-1",
        "Merge pull request #1 from shosgoren/fix/T-002a-x",
        "Merge branch 'feat/T-007-test-ac'",
        "Merge branch 'main' into int/faz0",
        "Merge pull request #2 from shosgoren/int/faz0-iskelet",
      ]),
    ).toEqual(["feat/T-007-test-ac", "fix/T-002a-x"]);
  });

  it("parantez içi backtick'ler yok sayılır (iç içe dahil)", () => {
    expect(backtickSegmentsOutsideParens("`a`, `b` (x `c` (y `d`) `e`), `f(g)`")).toEqual(["a", "b", "f(g)"]);
    expect(() => backtickSegmentsOutsideParens("`a")).toThrow(CardError);
  });

  it("gerçek kart satırı biçimi (T-008a) ayrıştırılır", () => {
    const text =
      "**Dokunulacak dosyalar (≤10):** `scripts/guards/cli.mjs`, `scripts/guards/lib/testkit.mjs` (geçici dizinde `git init`), `package.json` (kök; yalnızca `check:scope|tests` satırları → `scripts/guards/cli.mjs <ad>`)\n";
    expect(parseCardFiles(text, "k.md")).toEqual(["scripts/guards/cli.mjs", "scripts/guards/lib/testkit.mjs", "package.json"]);
  });

  it("geçersiz kart listeleri hata verir (fail-closed)", () => {
    expect(() => parseCardFiles("# kart\n", "k.md")).toThrow(/"Dokunulacak dosyalar" satırı yok/);
    expect(() => parseCardFiles("**Dokunulacak dosyalar:** yok\n", "k.md")).toThrow(/listesinde yol yok/);
    expect(() => parseCardFiles("**Dokunulacak dosyalar:** `a b`\n", "k.md")).toThrow(/geçersiz yol/);
    expect(() => parseCardFiles("**Dokunulacak dosyalar:** `../x`\n", "k.md")).toThrow(/depo dışını/);
    expect(() => parseCardFiles("**Dokunulacak dosyalar:** `a`\n**Dokunulacak dosyalar:** `b`\n", "k.md")).toThrow(/birden fazla/);
  });

  it("kartın int/ hedefi Dal satırından okunur", () => {
    expect(cardIntTarget("**Faz:** 0 · **Dal:** `feat/T-1-x` → `int/faz0-bekciler-1`\n")).toBe("int/faz0-bekciler-1");
    expect(cardIntTarget("**Faz:** 0 · **Dal:** `feat/T-1-x`\n")).toBeNull();
  });
});

describe("lib/output.mjs", () => {
  it("tek biçim: FAIL satırı ve özet", () => {
    expect(formatFinding("scope", { level: "FAIL", code: "OUT_OF_SCOPE", file: "a.txt", message: "neden" })).toBe(
      "[check:scope] FAIL OUT_OF_SCOPE a.txt — neden",
    );
    expect(formatFinding("x", { level: "WARN", code: "C", file: "", message: "m" })).toBe("[check:x] WARN C - — m");
    expect(formatSummary("scope", 0)).toBe("check:scope OK");
    expect(formatSummary("scope", 3)).toBe("check:scope FAIL (3)");
  });

  it("raporlayıcı uyarıda çıkış 0, hatada 1 döner ve iki kez bitirilemez", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "guards-out-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    /** @type {string[]} */
    const lines = [];
    const w = createReporter("demo", { root, log: (l) => lines.push(l) });
    w.warn("W", "f", "m");
    expect(w.finish()).toBe(0);
    expect(() => w.finish()).toThrow(/iki kez/);
    const f = createReporter("demo", { root, log: (l) => lines.push(l) });
    f.fail("E", "f", "m");
    expect(f.failCount).toBe(1);
    expect(f.finish()).toBe(1);
    expect(() => createReporter("Kötü Ad", { root })).toThrow(/geçersiz bekçi adı/);
  });
});

describe("scope argümanları", () => {
  it("--base/--branch iki biçimde; tekrar ve eksik değer hata", () => {
    expect(parseScopeArgs(["--", "--base", "origin/x", "--branch=feat/T-1-a"])).toEqual({ base: "origin/x", branch: "feat/T-1-a" });
    expect(() => parseScopeArgs(["--base"])).toThrow(/değer ister/);
    expect(() => parseScopeArgs(["--base=a", "--base=b"])).toThrow(/birden fazla/);
  });
});
