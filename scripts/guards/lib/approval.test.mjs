// T-008c `lib/approval.mjs` testleri: PR açıklaması → onay kararı (ADR-012 rev.).
import { describe, expect, it } from "vitest";
import { APPROVAL_LINE, effectiveLines, evaluateApproval, REASONS } from "./approval.mjs";

const SEC0 = "security-reviewer: BLOCKER: 0 · MAJOR: 1 · MINOR: 3";

/**
 * @param {string | null} body
 * @returns {string[]}
 */
function codes(body) {
  return evaluateApproval(body).problems.map((p) => p.code);
}

describe("evaluateApproval", () => {
  it("iki satır birlikte + BLOCKER 0 → onaylı", () => {
    const r = evaluateApproval(`Gerekçe: …\n\n${APPROVAL_LINE}\n${SEC0}\n`);
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
    expect(codes(`${APPROVAL_LINE}\n`)).toEqual([REASONS.SECURITY_MISSING]);
  });

  it("rapor var, APPROVED-BY yok → PROTECTED_NO_APPROVAL", () => {
    expect(codes(`${SEC0}\n`)).toEqual([REASONS.NO_APPROVAL]);
  });

  it("BLOCKER > 0 → SECURITY_BLOCKER", () => {
    const r = evaluateApproval(`${APPROVAL_LINE}\nsecurity-reviewer: BLOCKER: 2 · MAJOR: 0 · MINOR: 0\n`);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toEqual([REASONS.SECURITY_BLOCKER]);
    expect(r.problems[0]?.message).toContain("2");
  });

  it("birden fazla rapor özeti: biri BLOCKER > 0 ise kırmızı (çelişkide fail-closed)", () => {
    expect(codes(`${APPROVAL_LINE}\n${SEC0}\nsecurity-reviewer: BLOCKER: 1 · MAJOR: 0 · MINOR: 0\n`)).toEqual([
      REASONS.SECURITY_BLOCKER,
    ]);
  });

  it("APPROVED-BY satırı birebir olmalı (önek, sonek, harf, alıntı kabul edilmez)", () => {
    for (const l of [
      `> ${APPROVAL_LINE}`,
      `- ${APPROVAL_LINE}`,
      `${APPROVAL_LINE} ✓`,
      "APPROVED-BY: supervisor",
      "approved-by: supervisor (ADR-012 rev.)",
      "APPROVED-BY: user (ADR-012 rev.)",
      `\`${APPROVAL_LINE}\``,
    ]) {
      expect(codes(`${l}\n${SEC0}`), l).toEqual([REASONS.NO_APPROVAL]);
    }
  });

  it("satır başı/sonu boşluk ve CRLF kabul", () => {
    expect(codes(`  ${APPROVAL_LINE}  \r\n\t${SEC0}\r\n`)).toEqual([]);
  });

  it("rapor özeti biçimi: ayraç varyantları ve sonda bağlantı kabul; bozuk biçim yok sayılır", () => {
    expect(codes(`${APPROVAL_LINE}\nsecurity-reviewer: BLOCKER: 0 | MAJOR: 0 | MINOR: 0\n`)).toEqual([]);
    expect(codes(`${APPROVAL_LINE}\n${SEC0} — https://example.invalid/rapor\n`)).toEqual([]);
    for (const l of [
      "security-reviewer: BLOCKER: yok · MAJOR: 0 · MINOR: 0",
      "security-reviewer: BLOCKER: 0",
      "security-reviewer: BLOCKER: -1 · MAJOR: 0 · MINOR: 0",
      "qa-verifier: BLOCKER: 0 · MAJOR: 0 · MINOR: 0",
      `* ${SEC0}`,
      `${SEC0}x`,
    ]) {
      expect(codes(`${APPROVAL_LINE}\n${l}`), l).toEqual([REASONS.SECURITY_MISSING]);
    }
  });

  it("kod bloğu ve HTML yorumu içindeki satırlar sayılmaz", () => {
    expect(codes(`\`\`\`\n${APPROVAL_LINE}\n${SEC0}\n\`\`\`\n`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
    expect(codes(`~~~md\n${APPROVAL_LINE}\n~~~\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    expect(codes(`<!--\n${APPROVAL_LINE}\n-->\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    expect(codes(`<!-- ${APPROVAL_LINE} -->\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL]);
    // Yorum kapandıktan sonraki satır sayılır.
    expect(codes(`<!-- şablon -->\n${APPROVAL_LINE}\n${SEC0}`)).toEqual([]);
  });

  it("kapanmayan kod bloğu sonrasını yutar (fail-closed)", () => {
    expect(codes(`\`\`\`\n${APPROVAL_LINE}\n${SEC0}`)).toEqual([REASONS.NO_APPROVAL, REASONS.SECURITY_MISSING]);
  });
});

describe("effectiveLines", () => {
  it("kod bloğu/yorum dışındaki kırpılmış satırlar", () => {
    expect(effectiveLines("a\n```\nb\n```\n c <!-- d --> e\n<!--\nf\n--> g\n")).toEqual(["a", "c  e", "", "g", ""]);
  });
});
