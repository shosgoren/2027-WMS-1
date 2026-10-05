// Onay kuralı (T-008c, T-008h; ADR-012 rev., PROTOCOL §Onay kaynağı, I-17). Saf işlev: PR
// açıklaması metni + PR head SHA'sı → onay kararı. Korunan değişiklikte PR açıklamasında şunların
// ikisi birden bulunmalı:
//   (a) tam satır:  APPROVED-BY: supervisor (ADR-012 rev.) @ <40 hex PR head SHA>
//       SHA head'e eşit değilse APPROVAL_STALE (onay son push'tan önce yazılmış; M4)
//   (b) rapor özeti: security-reviewer: BLOCKER: <n> · MAJOR: <n> · MINOR: <n> @ <40 hex SHA>
//       ve n(BLOCKER) == 0. SHA, raporun incelediği commit'tir (T-008i MINOR 8): PR head'inin atası
//       (veya kendisi) olmalı ve o commit'ten head'e korunan değişiklik olmamalı; aksi
//       SECURITY_REPORT_STALE. Tazelik git gerektirir: çağıran `securityFresh` ile verir; verilmezse
//       yalnızca SHA == head taze sayılır (fail-closed).
// Karttaki `protected: true` (veya açıklamada geçmesi) hiçbir koşulu karşılamaz.
// Görünmeyen veya alıntı olan metin sayılmaz (m1, CommonMark): çitli kod bloğu (kapanış: aynı
// karakter, ≥ uzunluk, bilgi dizesi yok, ≤3 boşluk girinti), 4 boşluk/sekme girintili kod
// (paragraf devamı değilse), HTML yorumu ve <pre>/<code>/<textarea>/<script>/<style> içeriği.
// Kapanmayan blok sonrasını yutar (fail-closed). Satır başı/sonu boşlukları yok sayılır.

/** Onay satırının sabit kısmı; tam satır `${APPROVAL_LINE} @ <sha>` (`approvalLine`). */
export const APPROVAL_LINE = "APPROVED-BY: supervisor (ADR-012 rev.)";

/** Tam onay satırı (40 küçük harf hex SHA). */
const APPROVAL_RE = /^APPROVED-BY: supervisor \(ADR-012 rev\.\) @ ([0-9a-f]{40})$/;

/**
 * Belirli bir head SHA'sı için onay satırı.
 * @param {string} sha
 * @returns {string}
 */
export function approvalLine(sha) {
  return `${APPROVAL_LINE} @ ${sha}`;
}

/**
 * Rapor özeti satırı: `security-reviewer: BLOCKER: n · MAJOR: n · MINOR: n @ <40 hex SHA>`. Ayraç `·`
 * (U+00B7); `|`, `,`, `;` de kabul. SHA'dan sonra rapor bağlantısı veya açıklama olabilir (boşlukla).
 */
export const SECURITY_LINE_RE =
  /^security-reviewer:\s*BLOCKER:\s*(\d+)\s*[·|,;]\s*MAJOR:\s*(\d+)\s*[·|,;]\s*MINOR:\s*(\d+)\s+@\s+([0-9a-f]{40})(?:\s+.*)?$/;

/** SHA'sız (T-008i öncesi) özet satırı: tanınır ama kabul edilmez (hata iletisi için). */
const SECURITY_LINE_NO_SHA_RE = /^security-reviewer:\s*BLOCKER:\s*\d+\s*[·|,;]\s*MAJOR:\s*\d+\s*[·|,;]\s*MINOR:\s*\d+(?:\s+(?!@).*)?$/;

/**
 * Belirli bir commit için rapor özeti satırı.
 * @param {{ blocker: number, major: number, minor: number }} counts
 * @param {string} sha raporun incelediği commit
 * @returns {string}
 */
export function securityLine(counts, sha) {
  return `security-reviewer: BLOCKER: ${counts.blocker} · MAJOR: ${counts.major} · MINOR: ${counts.minor} @ ${sha}`;
}

/** Neden kodları. */
export const REASONS = Object.freeze({
  NO_APPROVAL: "PROTECTED_NO_APPROVAL",
  SECURITY_MISSING: "SECURITY_REPORT_MISSING",
  SECURITY_BLOCKER: "SECURITY_BLOCKER",
  UNVERIFIABLE: "APPROVAL_UNVERIFIABLE",
  STALE: "APPROVAL_STALE",
  SECURITY_STALE: "SECURITY_REPORT_STALE",
});

/**
 * @typedef {{ blocker: number, major: number, minor: number, sha: string, line: string }} SecuritySummary
 * @typedef {(sha: string) => string | null} SecurityFreshness rapor SHA'sı taze ise `null`, değilse neden
 * @typedef {{ code: string, message: string }} ApprovalProblem
 * @typedef {{
 *   ok: boolean,
 *   approved: boolean,
 *   security: SecuritySummary[],
 *   problems: ApprovalProblem[],
 * }} ApprovalResult
 */

/** İçeriği görünmeyen/alıntı sayılan HTML öğeleri. */
const RAW_TAGS = "pre|code|textarea|script|style";
const HIDDEN_OPEN_RE = new RegExp(`<!--|<(${RAW_TAGS})(?=[\\s>/])`, "i");

/**
 * Sekmeleri 4'lük duraklara açarak baştaki boşluk genişliği.
 * @param {string} line
 * @returns {number}
 */
function indentWidth(line) {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w++;
    else if (ch === "\t") w += 4 - (w % 4);
    else break;
  }
  return w;
}

/** Kap öneki (`>` alıntı, liste imleri) + çit açılışı. */
const FENCE_OPEN_RE = /^(?<pre>(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*)(?<sp>[ \t]*)(?<f>`{3,}|~{3,})(?<info>.*)$/;
const FENCE_CLOSE_RE = /^(?<lead>[ \t>]*)(?<f>`{3,}|~{3,})[ \t]*$/;

/**
 * Kod bloğu, girintili kod, HTML yorumu ve ham HTML öğeleri dışındaki satırlar (kırpılmış).
 * @param {string} body
 * @returns {string[]}
 */
export function effectiveLines(body) {
  /** @type {string[]} */
  const out = [];
  /** @type {{ ch: string, len: number, maxLead: number } | null} */
  let fence = null;
  /** @type {RegExp | null} açık gizli bölgenin bitişi */
  let hiddenEnd = null;
  let prevParagraph = false;
  for (const raw of body.split(/\r\n|\r|\n/)) {
    let line = raw;
    if (fence !== null) {
      const c = FENCE_CLOSE_RE.exec(line);
      const f = c?.groups?.["f"] ?? "";
      if (c !== null && f[0] === fence.ch && f.length >= fence.len && indentWidth((c.groups?.["lead"] ?? "").replace(/>/g, " ")) <= fence.maxLead) {
        fence = null;
      }
      continue;
    }
    // Gizli bölgeler (yorum, ham HTML öğeleri); kapanmayan bölge sonraki satırlara taşar.
    const startedHidden = hiddenEnd !== null;
    let kept = "";
    for (;;) {
      if (hiddenEnd !== null) {
        const m = hiddenEnd.exec(line);
        if (m === null) {
          line = "";
          break;
        }
        line = line.slice(m.index + m[0].length);
        hiddenEnd = null;
      }
      const o = HIDDEN_OPEN_RE.exec(line);
      if (o === null) {
        kept += line;
        break;
      }
      kept += line.slice(0, o.index);
      line = line.slice(o.index + o[0].length);
      hiddenEnd = o[1] === undefined ? /-->/ : new RegExp(`</${o[1]}\\s*>`, "i");
    }
    if (startedHidden && hiddenEnd !== null && kept.trim() === "") continue; // tümü gizli bölgenin içinde
    line = kept;
    const t = line.trim();
    if (t === "") {
      // Boş satır veya tümü gizli satır (HTML bloğu) paragrafı bitirir.
      prevParagraph = false;
      out.push("");
      continue;
    }
    const w = indentWidth(line);
    if (w >= 4 && !prevParagraph) continue; // girintili kod bloğu
    const fo = FENCE_OPEN_RE.exec(line);
    if (fo !== null) {
      const pre = fo.groups?.["pre"] ?? "";
      const sp = indentWidth(fo.groups?.["sp"] ?? "");
      const f = fo.groups?.["f"] ?? "";
      const info = fo.groups?.["info"] ?? "";
      const topLevel = pre === "";
      if ((!topLevel || sp <= 3) && !(f[0] === "`" && info.includes("`"))) {
        fence = { ch: f[0] ?? "`", len: f.length, maxLead: topLevel ? 3 : indentWidth(pre.replace(/[^\t]/g, " ")) + sp + 3 };
        prevParagraph = false;
        continue;
      }
    }
    out.push(t);
    prevParagraph = !/^#{1,6}(?:[ \t]|$)/.test(t);
  }
  return out;
}

/**
 * PR açıklamasını onay kuralına göre değerlendirir.
 * @param {string | null | undefined} body PR açıklaması (`null` = boş açıklama)
 * @param {string} headSha PR'ın head SHA'sı (API'den); onay satırı buna bağlı olmalı
 * @param {{ securityFresh?: SecurityFreshness }} [opts] rapor SHA'sının tazelik denetimi (git ile;
 *   `protected.mjs`). Verilmezse yalnızca head'in kendisi taze sayılır.
 * @returns {ApprovalResult}
 */
export function evaluateApproval(body, headSha, opts = {}) {
  const lines = effectiveLines(body ?? "");
  const head = headSha.toLowerCase();
  const shas = lines.map((l) => APPROVAL_RE.exec(l)?.[1]).filter((x) => x !== undefined);
  const approved = shas.includes(head);
  /** @type {SecuritySummary[]} */
  const security = [];
  for (const l of lines) {
    const m = SECURITY_LINE_RE.exec(l);
    if (m === null) continue;
    security.push({ blocker: Number(m[1]), major: Number(m[2]), minor: Number(m[3]), sha: /** @type {string} */ (m[4]), line: l });
  }
  const shaless = lines.filter((l) => SECURITY_LINE_NO_SHA_RE.test(l));
  /** @type {ApprovalProblem[]} */
  const problems = [];
  if (!approved && shas.length > 0) {
    problems.push({
      code: REASONS.STALE,
      message: `onay satırındaki SHA (${shas.map((x) => x.slice(0, 12)).join(", ")}) PR head SHA'sı (${head.slice(0, 12)}) değil; son push'tan sonra güncellenmeli`,
    });
  } else if (!approved) {
    problems.push({ code: REASONS.NO_APPROVAL, message: `PR açıklamasında tam satır "${approvalLine("<40 hex PR head SHA>")}" yok` });
  }
  if (security.length === 0) {
    problems.push({
      code: REASONS.SECURITY_MISSING,
      message: `PR açıklamasında security-reviewer rapor özeti satırı yok (security-reviewer: BLOCKER: <n> · MAJOR: <n> · MINOR: <n> @ <40 hex SHA>)${
        shaless.length > 0 ? "; SHA'sız özet satırı kabul edilmez (raporun incelediği commit eklenmeli)" : ""
      }`,
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
    // Her özet taze olmalı (çelişkide fail-closed): SHA head'in atası/kendisi ve aradaki commit'lerde
    // korunan değişiklik yok.
    const fresh = opts.securityFresh ?? ((/** @type {string} */ sha) => (sha === head ? null : "rapor SHA'sı PR head SHA'sı değil (tazelik denetlenmedi)"));
    /** @type {string[]} */
    const stale = [];
    for (const sha of new Set(security.map((s) => s.sha))) {
      const why = sha === head ? null : fresh(sha);
      if (why !== null) stale.push(`${sha.slice(0, 12)}: ${why}`);
    }
    if (stale.length > 0) {
      problems.push({ code: REASONS.SECURITY_STALE, message: `security-reviewer raporu bayat (${stale.join("; ")}); rapor yenilenmeli` });
    }
  }
  return { ok: problems.length === 0, approved, security, problems };
}
