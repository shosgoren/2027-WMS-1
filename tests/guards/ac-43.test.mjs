// AC-43 (birim düzeyi, T-008c): onay kaynağı testi — ADR-012 rev., PROTOCOL §Onay kaynağı, I-17.
// Gerçek git deposu (testkit) + `check:protected`; GitHub yalnızca bu testte sahte istemciyle
// (PR olayı bağlamı) taklit edilir. Canlı GitHub kanıtı T-009b'de.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvalLine, REASONS } from "../../scripts/guards/lib/approval.mjs";
import { GitHubError } from "../../scripts/guards/lib/github.mjs";
import { createReporter } from "../../scripts/guards/lib/output.mjs";
import { createRepo } from "../../scripts/guards/lib/testkit.mjs";
import { checkProtected } from "../../scripts/guards/protected.mjs";

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const SEC = (/** @type {number} */ blocker) => `security-reviewer: BLOCKER: ${blocker} · MAJOR: 0 · MINOR: 2`;
const CARD = `# T-100: örnek
**Faz:** 0 · **Ajan:** devops · **Dal:** \`feat/T-100-x\` → \`int/x\`
**protected: true** (beyan; onay değildir)
**Dokunulacak dosyalar (≤10):** \`docs/INVARIANTS.md\`, \`tests/.ac-baseline.json\`
`;

/**
 * main: korunan dosya + AC tabanı; dal `feat/T-100-x` korunan dosyayı değiştirir (veya `edit`).
 * @param {(r: import("../../scripts/guards/lib/testkit.mjs").TestRepo) => void} [edit]
 */
function fixture(edit) {
  const r = createRepo({ prefix: "ac43-" });
  cleanups.push(() => r.cleanup());
  r.writeAll({
    ".gitignore": ".artifacts/\n",
    "docs/INVARIANTS.md": "# Değişmezler\n",
    "docs/tasks/T-100.md": CARD,
    "tests/.ac-baseline.json": JSON.stringify({ "AC-37": 2, "AC-43": 1 }) + "\n",
  });
  r.commit("init").publish("main");
  r.branch("feat/T-100-x");
  if (edit === undefined) r.write("docs/INVARIANTS.md", "# Değişmezler (gevşetildi)\n");
  else edit(r);
  r.commit("değişiklik");
  return r;
}

/** @param {import("../../scripts/guards/lib/testkit.mjs").TestRepo} r */
const headOf = (r) => r.git("rev-parse", "HEAD").trim();

/**
 * PR olayı bağlamında `check:protected`. `body === undefined` → API erişimi yok.
 * @param {import("../../scripts/guards/lib/testkit.mjs").TestRepo} r
 * @param {string | null | undefined} body
 */
async function checkPr(r, body) {
  const head = headOf(r);
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac43-event-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const eventPath = path.join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ number: 43, pull_request: { number: 43, head: { sha: head } } }));
  /** @type {string[]} */
  const lines = [];
  const out = createReporter("protected", { root: r.dir, log: (l) => lines.push(l) });
  await checkProtected({
    root: r.dir,
    argv: [],
    out,
    env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_BASE_REF: "main" },
    createClient: () => {
      if (body === undefined) throw new GitHubError("GITHUB_TOKEN yok");
      return {
        async getPull(n) {
          return { number: n, state: "open", body, headSha: head, baseRef: "main", mergedAt: null };
        },
        async pullsForCommit() {
          throw new GitHubError("beklenmeyen çağrı");
        },
      };
    },
  });
  const code = out.finish();
  return { code, text: lines.join("\n") };
}

describe("AC-43 onay kaynağı (check:protected)", () => {
  it("@AC-43 (a) yalnızca kartta protected: true → FAIL PROTECTED_NO_APPROVAL", async () => {
    const r = fixture();
    const res = await checkPr(r, "Bu kart **protected: true** beyan eder.\nprotected: true\n");
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
    expect(res.text).toContain(`FAIL ${REASONS.SECURITY_MISSING} docs/INVARIANTS.md`);
  });

  it("@AC-43 (b) APPROVED-BY var, security-reviewer rapor özeti yok → FAIL SECURITY_REPORT_MISSING", async () => {
    const r = fixture();
    const res = await checkPr(r, `${approvalLine(headOf(r))}\n`);
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.SECURITY_MISSING} docs/INVARIANTS.md`);
    expect(res.text).not.toContain(REASONS.NO_APPROVAL);
  });

  it("@AC-43 (c) rapor var ama BLOCKER > 0 → FAIL SECURITY_BLOCKER", async () => {
    const r = fixture();
    const res = await checkPr(r, `${approvalLine(headOf(r))}\n${SEC(1)}\n`);
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.SECURITY_BLOCKER} docs/INVARIANTS.md`);
    expect(res.text).not.toContain(REASONS.NO_APPROVAL);
    expect(res.text).not.toContain(REASONS.SECURITY_MISSING);
  });

  it("@AC-43 (d) APPROVED-BY satırı yok (rapor BLOCKER 0) → FAIL PROTECTED_NO_APPROVAL", async () => {
    const r = fixture();
    const res = await checkPr(r, `${SEC(0)}\n`);
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
    expect(res.text).not.toContain(REASONS.SECURITY_MISSING);
    expect(res.text).not.toContain(REASONS.SECURITY_BLOCKER);
  });

  it("@AC-43 (e) APPROVED-BY satırındaki SHA PR head SHA'sı değil → FAIL APPROVAL_STALE", async () => {
    const r = fixture();
    const approved = headOf(r);
    r.write("docs/INVARIANTS.md", "# Değişmezler (onaydan sonra yine değişti)\n").commit("onay sonrası push");
    const res = await checkPr(r, `${approvalLine(approved)}\n${SEC(0)}\n`);
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.STALE} docs/INVARIANTS.md`);
    expect(res.text).not.toContain(REASONS.NO_APPROVAL);
    expect(res.text).not.toContain(REASONS.SECURITY_MISSING);
  });

  it("@AC-43 APPROVED-BY @ head SHA + BLOCKER: 0 rapor özeti birlikte → OK", async () => {
    const r = fixture();
    const res = await checkPr(r, `Gerekçe: …\n\n${approvalLine(headOf(r))}\n${SEC(0)}\n`);
    expect(res.code).toBe(0);
    expect(res.text).toContain("check:protected OK");
  });

  it("@AC-43 GitHub API erişimi yok → FAIL APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    const res = await checkPr(r, undefined);
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} docs/INVARIANTS.md`);
  });

  it("@AC-43 AC tabanı artışı korunan sayılmaz (onaysız OK)", async () => {
    const r = fixture((x) => x.write("tests/.ac-baseline.json", JSON.stringify({ "AC-37": 3, "AC-43": 2, "AC-44": 1 }) + "\n"));
    const res = await checkPr(r, undefined);
    expect(res.code).toBe(0);
  });

  it("@AC-43 AC tabanı düşüşü korunur (onaysız FAIL)", async () => {
    const r = fixture((x) => x.write("tests/.ac-baseline.json", JSON.stringify({ "AC-37": 1, "AC-43": 1 }) + "\n"));
    const res = await checkPr(r, "");
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.NO_APPROVAL} tests/.ac-baseline.json`);
  });
});
