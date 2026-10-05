// T-008c/T-008h `lib/approval.mjs` testleri: PR açıklaması + head SHA → onay kararı (ADR-012 rev.).
import { describe, expect, it } from "vitest";
import { APPROVAL_LINE, approvalLine, effectiveLines, evaluateApproval, REASONS } from "./approval.mjs";

const SEC0 = "security-reviewer: BLOCKER: 0 · MAJOR: 1 · MINOR: 3";
const HEAD = "c".repeat(40);
const OLD = "d".repeat(40);
const APPROVED = approvalLine(HEAD);

/**
 * @param {string | null} body
 * @param {string} [head]
 * @returns {string[]}
 */
function codes(body, head = HEAD) {
  return evaluateApproval(body, head).problems.map((p) => p.code);
}

describe("evaluateApproval", () => {
  it("iki satır birlikte + BLOCKER 0 → onaylı", () => {
    const r = evaluateApproval(`Gerekçe: …\n\n${APPROVED}\n${SEC0}\n`, HEAD);
    expect(r.ok).toBe(true);
    expect(r.approved).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.security).toEqual([{ blocker: 0, major: 1, minor: 3, line: SEC0 }]);
  });

  it("boş / null açıklama → APPROVED-BY ve rapor eksik", () => {
    expect(codes(null)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
    expect(codes("")).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });

  it("yalnızca kart beyanı (`protected: true`) hiçbir koşulu karşılamaz", () => {
    expect(codes("**protected: true**\nprotected: true\n")).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });

  it("APPROVED-BY var, rapor yok → SECURITY_REPORT_MISSING", () => {
    expect(codes(`${APPROVED}\n`)).toEqual([REASONS.SECURITY_MISSING]);
  });

  it("rapor var, APPROVED-BY yok → PROTECTED_NO_APPROVAL", () => {
    expect(codes(`${SEC0}\n`)).toEqual([REASONS.NO_APPROVAL]);
  });

  it("BLOCKER > 0 → SECURITY_BLOCKER", () => {
    const r = evaluateApproval(`${APPROVED}\nsecurity-reviewer: BLOCKER: 2 · MAJOR: 0 · MINOR: 0\n`, HEAD);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toEqual([REASONS.SECURITY_BLOCKER]);
    expect(r.problems[0]?.message).toContain("2");
  });

  it("birden fazla rapor özeti: biri BLOCKER > 0 ise kırmızı (çelişkide fail-closed)", () => {
    expect(codes(`${APPROVED}\n${SEC0}\nsecurity-reviewer: BLOCKER: 1 · MAJOR: 0 · MINOR: 0\n`)).toEqual([
      REASONS.SECURITY_BLOCKER,
    ]);
  });

  it("APPROVED-BY satırı birebir olmalı (önek, sonek, harf, alıntı kabul edilmez)", () => {
    for (const l of [
      `> ${APPROVED}`,
      `- ${APPROVED}`,
      `${APPROVED} ✓`,
      "APPROVED-BY: supervisor",
      `approved-by: supervisor (ADR-012 rev.) @ ${HEAD}`,
      `APPROVED-BY: user (ADR-012 rev.) @ ${HEAD}`,
      `\`${APPROVED}\``,
      // SHA'sız eski biçim, kısa/büyük harf SHA, ayraçsız
      APPROVAL_LINE,
      `${APPROVAL_LINE} @ ${HEAD.slice(0, 12)}`,
      `${APPROVAL_LINE} @ ${HEAD.toUpperCase()}`,
      `${APPROVAL_LINE} ${HEAD}`,
    ]) {
      expect(codes(`${l}\n${SEC0}`), l).toEqual([REASONS.NO_APPROVAL]);
    }
  });

  it("satır başı/sonu boşluk ve CRLF kabul", () => {
    expect(codes(`  ${APPROVED}  \r\n\t${SEC0}\r\n`)).toEqual([]);
  });

  it("rapor özeti biçimi: ayraç varyantları ve sonda bağlantı kabul; bozuk biçim yok sayılır", () => {
    expect(codes(`${APPROVED}\nsecurity-reviewer: BLOCKER: 0 | MAJOR: 0 | MINOR: 0\n`)).toEqual([]);
    expect(codes(`${APPROVED}\n${SEC0} — https://example.invalid/rapor\n`)).toEqual([]);
    for (const l of [
      "security-reviewer: BLOCKER: yok · MAJOR: 0 · MINOR: 0",
      "security-reviewer: BLOCKER: 0",
      "security-reviewer: BLOCKER: -1 · MAJOR: 0 · MINOR: 0",
      "qa-verifier: BLOCKER: 0 · MAJOR: 0 · MINOR: 0",
      `* ${SEC0}`,
      `${SEC0}x`,
    ]) {
      expect(codes(`${APPROVED}\n${l}`), l).toEqual([REASONS.SECURITY_MISSING]);
    }
  });

  it("kod bloğu ve HTML yorumu içindeki satırlar sayılmaz", () => {
    expect(codes(`\`\`\`\n${APPROVED}\n${SEC0}\n\`\`\`\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
    expect(codes(`~~~md\n${APPROVED}\n~~~\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    expect(codes(`<!--\n${APPROVED}\n-->\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    expect(codes(`<!-- ${APPROVED} -->\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    // Yorum kapandıktan sonraki satır sayılır.
    expect(codes(`<!-- şablon -->\n${APPROVED}\n${SEC0}`)).toEqual([]);
  });

  it("kapanmayan kod bloğu sonrasını yutar (fail-closed)", () => {
    expect(codes(`\`\`\`\n${APPROVED}\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });
});

describe("onay head SHA'sına bağlı (T-008h M4)", () => {
  it("M4 saldırısı: eski head için yazılmış onay yeni push'tan sonra → APPROVAL_STALE", () => {
    expect(codes(`${approvalLine(OLD)}\n${SEC0}`)).toEqual([REASONS.STALE]);
  });

  it("biri eski biri güncel iki onay satırı → güncel olan geçerli", () => {
    expect(codes(`${approvalLine(OLD)}\n${APPROVED}\n${SEC0}`)).toEqual([]);
  });

  it("API head SHA'sı büyük harfle gelse de eşleşir; satır küçük harf olmalı", () => {
    expect(codes(`${APPROVED}\n${SEC0}`, HEAD.toUpperCase())).toEqual([]);
  });

  it("STALE ile BLOCKER birlikte raporlanır", () => {
    expect(codes(`${approvalLine(OLD)}\nsecurity-reviewer: BLOCKER: 1 · MAJOR: 0 · MINOR: 0`)).toEqual([
      REASONS.STALE,
      REASONS.SECURITY_BLOCKER,
    ]);
  });
});

describe("gövde ayrıştırma CommonMark'a uygun (T-008h m1)", () => {
  it("m1 saldırısı: daha uzun çit içindeki kısa ``` kapanış değildir", () => {
    expect(codes(`\`\`\`\`\n\`\`\`\n${APPROVED}\n${SEC0}\n\`\`\`\`\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });

  it("m1 saldırısı: bilgi dizeli satır kapanış değildir (```js içerde)", () => {
    expect(codes(`\`\`\`\n\`\`\`js\n${APPROVED}\n${SEC0}\n\`\`\`\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });

  it("m1 saldırısı: farklı karakterli çit kapanış değildir (``` içinde ~~~)", () => {
    expect(codes(`\`\`\`\n~~~\n${APPROVED}\n${SEC0}\n\`\`\`\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });

  it("m1 saldırısı: 4+ boşluk girintili kapanış çiti kapanış değildir", () => {
    expect(codes(`\`\`\`\n    \`\`\`\n${APPROVED}\n${SEC0}\n\`\`\`\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });

  it("≤3 boşluk girintili ve daha uzun kapanış çiti kapatır", () => {
    expect(codes(`\`\`\`\nx\n   \`\`\`\`\`\n${APPROVED}\n${SEC0}`)).toEqual([]);
  });

  it("m1 saldırısı: 4 boşluk / sekme girintili kod bloğu sayılmaz", () => {
    expect(codes(`Şablon:\n\n    ${APPROVED}\n    ${SEC0}\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
    expect(codes(`\t${APPROVED}\n\t${SEC0}\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });

  it("paragraf devamındaki girintili satır kod değildir (CommonMark)", () => {
    expect(codes(`${APPROVED}\n    ${SEC0}\n`)).toEqual([]);
  });

  it("m1 saldırısı: <pre>/<code>/<textarea> içeriği sayılmaz (tek ve çok satır)", () => {
    expect(codes(`<pre>\n${APPROVED}\n${SEC0}\n</pre>\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
    expect(codes(`<code>${APPROVED}</code>\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    expect(codes(`<PRE class="x">\n${APPROVED}\n</Pre>\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    expect(codes(`<textarea>\n${APPROVED}\n</textarea>\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    // Kapanmayan <pre> sonrasını yutar.
    expect(codes(`<pre>\n${APPROVED}\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
    // Kapandıktan sonraki satır sayılır; <p>/<preview> gibi başka etiketler gizlemez.
    expect(codes(`<pre>x</pre>\n${APPROVED}\n<preview>\n${SEC0}`)).toEqual([]);
  });

  it("m1 saldırısı: liste içindeki çit gizler; alıntıdaki kapanmayan çit sonrasını yutar (fail-closed)", () => {
    expect(codes(`- \`\`\`\n  ${APPROVED}\n  ${SEC0}\n  \`\`\`\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
    expect(codes(`> \`\`\`\n${APPROVED}\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });
});

describe("effectiveLines", () => {
  it("kod bloğu/yorum dışındaki kırpılmış satırlar", () => {
    expect(effectiveLines("a\n```\nb\n```\n c <!-- d --> e\n<!--\nf\n--> g\n")).toEqual(["a", "c  e", "", "g", ""]);
  });
});
