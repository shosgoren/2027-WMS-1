// Onay kuralı (T-008c; ADR-012 rev., PROTOCOL §Onay kaynağı, I-17). Saf işlev: PR açıklaması
// metni → onay kararı. Korunan değişiklikte PR açıklamasında şunların ikisi birden bulunmalı:
//   (a) tam satır:  APPROVED-BY: supervisor (ADR-012 rev.)
//   (b) rapor özeti: security-reviewer: BLOCKER: <n> · MAJOR: <n> · MINOR: <n>   ve n(BLOCKER) == 0
// Karttaki `protected: true` (veya açıklamada geçmesi) hiçbir koşulu karşılamaz.
// Kod bloğu (``` / ~~~) ve HTML yorumu (<!-- -->) içindeki satırlar sayılmaz: şablon/alıntı
// metni onay yerine geçmez. Satır başı/sonu boşlukları yok sayılır; başka hiçbir gevşetme yok.

/** Onay satırı (birebir). */
export const APPROVAL_LINE = "APPROVED-BY: supervisor (ADR-012 rev.)";

/**
 * Rapor özeti satırı. Ayraç `·` (U+00B7); `|`, `,`, `;` de kabul. Satır sonunda rapor bağlantısı
 * veya açıklama olabilir (boşlukla ayrılmış).
 */
export const SECURITY_LINE_RE =
  /^security-reviewer:\s*BLOCKER:\s*(\d+)\s*[·|,;]\s*MAJOR:\s*(\d+)\s*[·|,;]\s*MINOR:\s*(\d+)(?:\s+.*)?$/;

/** Neden kodları. */
export const REASONS = Object.freeze({
  NO_APPROVAL: "PROTECTED_NO_APPROVAL",
  SECURITY_MISSING: "SECURITY_REPORT_MISSING",
  SECURITY_BLOCKER: "SECURITY_BLOCKER",
  UNVERIFIABLE: "APPROVAL_UNVERIFIABLE",
});

/**
 * @typedef {{ blocker: number, major: number, minor: number, line: string }} SecuritySummary
 * @typedef {{ code: string, message: string }} ApprovalProblem
 * @typedef {{
 *   ok: boolean,
 *   approved: boolean,
 *   security: SecuritySummary[],
 *   problems: ApprovalProblem[],
 * }} ApprovalResult
 */

/**
 * Kod bloğu ve HTML yorumu dışındaki satırlar (kırpılmış).
 * @param {string} body
 * @returns {string[]}
 */
export function effectiveLines(body) {
  /** @type {string[]} */
  const out = [];
  /** @type {string | null} */
  let fence = null;
  let inComment = false;
  for (const raw of body.split(/\r\n|\r|\n/)) {
    let line = raw;
    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (inComment) {
      const end = line.indexOf("-->");
      if (end === -1) continue;
      inComment = false;
      line = line.slice(end + 3);
    }
    // Satır içi yorumları çıkar; kapanmayan yorum sonraki satırlara taşar.
    for (;;) {
      const start = line.indexOf("<!--");
      if (start === -1) break;
      const end = line.indexOf("-->", start + 4);
      if (end === -1) {
        line = line.slice(0, start);
        inComment = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 3);
    }
    const t = line.trim();
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (f !== null) {
      fence = /** @type {string} */ (f[1]);
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * PR açıklamasını onay kuralına göre değerlendirir.
 * @param {string | null | undefined} body PR açıklaması (`null` = boş açıklama)
 * @returns {ApprovalResult}
 */
export function evaluateApproval(body) {
  const lines = effectiveLines(body ?? "");
  const approved = lines.includes(APPROVAL_LINE);
  /** @type {SecuritySummary[]} */
  const security = [];
  for (const l of lines) {
    const m = SECURITY_LINE_RE.exec(l);
    if (m === null) continue;
    security.push({ blocker: Number(m[1]), major: Number(m[2]), minor: Number(m[3]), line: l });
  }
  /** @type {ApprovalProblem[]} */
  const problems = [];
  if (!approved) {
    problems.push({ code: REASONS.NO_APPROVAL, message: `PR açıklamasında tam satır "${APPROVAL_LINE}" yok` });
  }
  if (security.length === 0) {
    problems.push({
      code: REASONS.SECURITY_MISSING,
      message: "PR açıklamasında security-reviewer rapor özeti satırı yok (security-reviewer: BLOCKER: <n> · MAJOR: <n> · MINOR: <n>)",
    });
  } else {
    // Birden fazla özet varsa hepsi BLOCKER: 0 olmalı (çelişkili raporda fail-closed).
    const bad = security.filter((s) => s.blocker !== 0);
    if (bad.length > 0) {
      problems.push({
        code: REASONS.SECURITY_BLOCKER,
        message: `security-reviewer BLOCKER sayısı 0 değil (${bad.map((s) => s.blocker).join(", ")})`,
      });
    }
  }
  return { ok: problems.length === 0, approved, security, problems };
}
