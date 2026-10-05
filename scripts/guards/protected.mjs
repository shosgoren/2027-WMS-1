// `pnpm check:protected` (T-008c; PROTOCOL §3b, §Onay kaynağı, I-17, ADR-012 rev., AC-43).
// Daldaki korunan değişiklikleri (`protected-paths.mjs`) bulur; varsa PR açıklamasında onay
// satırlarını (`lib/approval.mjs`) GitHub API'den doğrular. Doğrulayamazsa kırmızı (fail-closed).
//
// Kipler:
//   (varsayılan)  GitHub Actions bağlamı: `pull_request*` → olaydaki PR; `push` → commit'i getiren
//                 birleşmiş PR (GET /repos/{o}/{r}/commits/{sha}/pulls). Bağlam/API yoksa ve korunan
//                 değişiklik varsa FAIL APPROVAL_UNVERIFIABLE.
//   --pr <n>      PR numarasını açıkça ver (Supervisor birleştirmeden önce; GITHUB_TOKEN +
//                 GITHUB_REPOSITORY gerekir).
//   --local       yerel kanca: API'ye gitmez, korunan değişiklik için yalnızca uyarır
//                 (WARN PROTECTED_CHANGE_NEEDS_APPROVAL, çıkış 0).
//   --base <ref>  yalnızca `--local`'da karşılaştırma tabanı. Diğer kiplerde YOK SAYILIR (T-008h M3:
//                 `--base HEAD` boş fark → sahte OK). Taban: PR'da API'deki `base.ref`
//                 (`origin/<base.ref>`; API yoksa olaydaki GITHUB_BASE_REF yalnızca "korunan değişiklik
//                 yok" kararı için), push'ta `HEAD^1`, bağlamsızda kartın `→ int/…` hedefi / `origin/main`.
// Değişiklik kümesi (T-008h M2): `--local` dışında yalnızca `merge-base..HEAD` commit'leri ve
// içerik HEAD commit'inden okunur; çalışma ağacı (commit'li değişikliği geri alan düzenleme dahil)
// sayılmaz. `--local`'da commit'ler + indeks + çalışma ağacı + izlenmeyen dosyalar.
// Onay satırı PR head SHA'sına bağlıdır (`APPROVED-BY: … @ <sha>`; tutmazsa APPROVAL_STALE).
// Karttaki `protected: true` beyandır; hiçbir koşulu karşılamaz (okunmaz bile).
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CardError, cardIdFromBranch, loadCard } from "./lib/cards.mjs";
import { changedFiles, currentBranch, DEFAULT_TARGET, fileAtRef, git, GitError, mergeBase, refExists, repoRoot } from "./lib/git.mjs";
import { contextFromEnv, createGitHubClient, GitHubError } from "./lib/github.mjs";
import { evaluateApproval, REASONS } from "./lib/approval.mjs";
import { NO_FILE, UsageError } from "./lib/output.mjs";
import { classifyChanges } from "./protected-paths.mjs";

/**
 * @typedef {import("./lib/output.mjs").Reporter} Reporter
 * @typedef {import("./lib/github.mjs").GitHubClient} GitHubClient
 * @typedef {import("./lib/github.mjs").PullInfo} PullInfo
 * @typedef {import("./lib/github.mjs").CiContext} CiContext
 * @typedef {import("./protected-paths.mjs").ProtectedHit} ProtectedHit
 * @typedef {{ local: boolean, base: string | null, pr: number | null }} ProtectedArgs
 * @typedef {{
 *   root: string,
 *   argv: string[],
 *   out: Reporter,
 *   env?: NodeJS.ProcessEnv,
 *   createClient?: (env: NodeJS.ProcessEnv) => GitHubClient,
 * }} ProtectedContext
 */

export const WARN_LOCAL = "PROTECTED_CHANGE_NEEDS_APPROVAL";

/**
 * @param {string[]} argv
 * @returns {ProtectedArgs}
 */
export function parseProtectedArgs(argv) {
  /** @type {ProtectedArgs} */
  const args = { local: false, base: null, pr: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") continue;
    if (a === "--local") {
      args.local = true;
      continue;
    }
    const m = /^--(base|pr)(?:=(.*))?$/.exec(a);
    if (m === null) throw new UsageError(`bilinmeyen argüman "${a}"`);
    const key = /** @type {"base" | "pr"} */ (m[1]);
    const v = m[2] ?? argv[++i];
    if (v === undefined || v === "") throw new UsageError(`--${key} bir değer ister`);
    if (args[key] !== null) throw new UsageError(`--${key} birden fazla verildi`);
    if (key === "pr") {
      if (!/^[1-9]\d*$/.test(v)) throw new UsageError(`--pr pozitif tamsayı ister: "${v}"`);
      args.pr = Number(v);
    } else {
      args.base = v;
    }
  }
  if (args.local && args.pr !== null) throw new UsageError("--local ile --pr birlikte verilemez");
  return args;
}

/**
 * Ortamdan gerçek GitHub istemcisi. Eksik değişken = GitHubError (→ APPROVAL_UNVERIFIABLE).
 * @param {NodeJS.ProcessEnv} env
 * @returns {GitHubClient}
 */
export function clientFromEnv(env) {
  const token = env["GITHUB_TOKEN"] ?? "";
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  if (token === "") throw new GitHubError("GITHUB_TOKEN yok");
  if (repository === "") throw new GitHubError("GITHUB_REPOSITORY yok");
  const apiUrl = env["GITHUB_API_URL"];
  return createGitHubClient({ token, repository, ...(apiUrl ? { apiUrl } : {}) });
}

/**
 * Bağlamsız (yerel) varsayılan hedef: kartın `→ int/…` hedefi, yoksa `origin/main`.
 * @param {string} root
 * @returns {string}
 */
function defaultTarget(root) {
  try {
    const id = cardIdFromBranch(currentBranch(root));
    if (id === null) return DEFAULT_TARGET;
    const t = loadCard(root, id).intTarget;
    return t === null ? DEFAULT_TARGET : `origin/${t}`;
  } catch (e) {
    if (e instanceof CardError || e instanceof GitError) return DEFAULT_TARGET;
    throw e;
  }
}

/**
 * @param {string} root
 * @param {string} rev
 * @returns {string | null}
 */
function revParse(root, rev) {
  return refExists(root, rev) ? git(root, ["rev-parse", "--verify", `${rev}^{commit}`]).trim() : null;
}

/**
 * @param {string} root
 * @returns {(file: string) => string | null}
 */
function worktreeReader(root) {
  return (file) => {
    const abs = path.join(root, file);
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8");
  };
}

/**
 * @param {Reporter} out
 * @param {ProtectedHit[]} hits
 * @param {string} code
 * @param {string} message
 */
function failAll(out, hits, code, message) {
  for (const h of hits) out.fail(code, h.path, `${message} [${h.reason}]`);
}

/**
 * Onayın okunacağı PR'ı bulur. Bulunamazsa açıklama döner (→ APPROVAL_UNVERIFIABLE).
 * @param {string} root
 * @param {CiContext} ci
 * @param {() => GitHubClient} client
 * @param {PullInfo | null} known önceden alınmış PR (taban için)
 * @returns {Promise<{ pull: PullInfo } | { error: string }>}
 */
async function findPull(root, ci, client, known) {
  if (ci.kind === "none") return { error: `PR bağlamı yok: ${ci.reason}` };
  if (ci.kind === "pr") {
    const pull = known ?? (await client().getPull(ci.number));
    // Onay metni denetlenen koda bağlı olmalı: PR'ın şimdiki head'i bu koşunun HEAD'i (veya
    // `refs/pull/N/merge` birleştirme commit'inin ikinci ebeveyni) olmalı.
    const heads = [revParse(root, "HEAD"), revParse(root, "HEAD^2")].filter((x) => x !== null);
    if (!heads.includes(pull.headSha)) {
      return { error: `PR #${pull.number} head ${pull.headSha.slice(0, 12)} denetlenen commit değil (PR güncellendi; yeniden koşturun)` };
    }
    return { pull };
  }
  const head = revParse(root, "HEAD");
  if (head !== ci.sha) return { error: `GITHUB_SHA (${ci.sha.slice(0, 12)}) çalışma ağacının HEAD'i değil` };
  const parent = revParse(root, "HEAD^1");
  if (ci.before !== null && ci.before !== parent) {
    return { error: "push birden fazla commit/birleştirme içeriyor (before ≠ HEAD^1); onay tek PR'a bağlanamaz" };
  }
  const pulls = (await client().pullsForCommit(ci.sha)).filter((p) => p.mergedAt !== null && p.baseRef === ci.branch);
  if (pulls.length !== 1) {
    return { error: `${ci.sha.slice(0, 12)} commit'ini "${ci.branch}" dalına getiren birleşmiş PR ${pulls.length === 0 ? "bulunamadı" : "tekil değil"}` };
  }
  return { pull: /** @type {PullInfo} */ (pulls[0]) };
}

/**
 * @param {ProtectedContext} ctx
 */
export async function checkProtected(ctx) {
  const { out } = ctx;
  const env = ctx.env ?? process.env;
  const createClient = ctx.createClient ?? clientFromEnv;
  const args = parseProtectedArgs(ctx.argv);
  out.detail("mode", args.local ? "local" : args.pr !== null ? "pr-arg" : "ci");

  /** @type {CiContext} */
  const ci = args.local
    ? { kind: "none", reason: "--local" }
    : args.pr !== null
      ? { kind: "pr", number: args.pr, eventHeadSha: null }
      : contextFromEnv(env);
  out.detail("context", ci);

  /** @type {GitHubClient | null} */
  let clientCache = null;
  const client = () => (clientCache ??= createClient(env));

  try {
    const root = repoRoot(ctx.root);
    /** @type {PullInfo | null} */
    let known = null;
    /** @type {string} */
    let target;
    if (!args.local && args.base !== null) out.detail("baseIgnored", args.base);
    if (args.local) target = args.base ?? defaultTarget(root);
    else if (ci.kind === "pr") {
      try {
        known = await client().getPull(ci.number);
        target = `origin/${known.baseRef}`;
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        // API yoksa olaydaki taban yalnızca "korunan değişiklik yok" kararına yeter; korunan
        // değişiklik varsa `findPull` yine API'ye gider ve UNVERIFIABLE olur.
        const baseRef = args.pr === null ? env["GITHUB_BASE_REF"] : undefined;
        if (baseRef === undefined || baseRef === "") {
          out.fail(REASONS.UNVERIFIABLE, NO_FILE, `PR tabanı GitHub API'den okunamadı: ${e.message}`);
          return;
        }
        out.detail("apiError", e.message);
        target = `origin/${baseRef}`;
      }
    } else if (ci.kind === "push") target = "HEAD^1";
    else target = defaultTarget(root);

    const base = mergeBase(root, target);
    out.detail("target", target);
    out.detail("mergeBase", base);
    const changes = changedFiles(root, base, { includeWorktree: args.local });
    const after = args.local ? worktreeReader(root) : (/** @type {string} */ f) => fileAtRef(root, "HEAD", f);
    const hits = classifyChanges(changes, { before: (f) => fileAtRef(root, base, f), after });
    out.detail("protected", hits);
    if (hits.length === 0) return;

    if (args.local) {
      for (const h of hits) {
        out.warn(WARN_LOCAL, h.path, `korunan değişiklik (${h.reason}); PR açıklamasında APPROVED-BY + security-reviewer özeti gerekir`);
      }
      return;
    }

    /** @type {{ pull: PullInfo } | { error: string }} */
    let found;
    try {
      found = await findPull(root, ci, client, known);
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      found = { error: `GitHub API: ${e.message}` };
    }
    if ("error" in found) {
      failAll(out, hits, REASONS.UNVERIFIABLE, found.error);
      return;
    }
    const result = evaluateApproval(found.pull.body, found.pull.headSha);
    out.detail("approval", {
      pr: found.pull.number,
      headSha: found.pull.headSha,
      approved: result.approved,
      security: result.security.map((s) => ({ blocker: s.blocker, major: s.major, minor: s.minor })),
      problems: result.problems.map((p) => p.code),
    });
    for (const p of result.problems) failAll(out, hits, p.code, `PR #${found.pull.number}: ${p.message}`);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    out.fail("GIT_ERROR", NO_FILE, e.message);
  }
}

/**
 * `cli.mjs` giriş noktası.
 * @param {{ root: string, argv: string[], out: Reporter }} ctx
 */
export async function run(ctx) {
  await checkProtected(ctx);
}
