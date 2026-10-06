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
// Güvenlik özeti raporun incelediği commit'e bağlıdır (`security-reviewer: … @ <sha>`; T-008i MINOR 8):
// SHA head'in atası/kendisi olmalı ve `sha..head` arasında korunan değişiklik olmamalı (yalnızca
// korunmayan belgelere — ör. Supervisor'ın `SUPERVISOR_PATHS` kayıtlarına — yapılan commit'ler
// raporu bayatlatmaz); aksi SECURITY_REPORT_STALE. T-008k: karşılaştırma PR'ın KENDİ korunan
// değişiklik kümesi üzerindendir (`merge-base(taban, uç)..uç`); tabanı birleştirmek raporu bayatlatmaz.
// Push kipinde (T-008i MINOR 6) commit PR'ın kendisi olmalı: birleştirme commit'inde
// `HEAD^2 == head.sha`, her durumda `HEAD^{tree}` = `git merge-tree HEAD^1 head.sha` önizleme ağacı;
// aksi APPROVAL_UNVERIFIABLE (onay başka içeriğe taşınamaz).
// Karttaki `protected: true` beyandır; hiçbir koşulu karşılamaz (okunmaz bile).
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CardError, cardIdFromBranch, loadCard } from "./lib/cards.mjs";
import {
  changedFiles,
  currentBranch,
  DEFAULT_TARGET,
  fileAtRef,
  git,
  GitError,
  mergeBase,
  parseNameStatusZ,
  refExists,
  repoRoot,
  treeEntries,
} from "./lib/git.mjs";
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
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", rev]).trim();
  } catch (e) {
    // `^{commit}` soyulması yok: nesnesi silinmiş ebeveyn de kimliğiyle döner (sessiz `null` olmaz).
    // Yalnızca "ref gerçekten yok" (`--verify --quiet`: çıkış 1, çıktı ve stderr boş) = null.
    // Diğer her git hatası (bozuk depo, izin, sinyal → çıkış ≠ 1) fail-closed: GitError yukarı çıkar.
    if (e instanceof GitError && e.status === 1 && e.stdout.trim() === "" && e.stderr.trim() === "") return null;
    throw e;
  }
}

/**
 * Commit nesnesi yerelde var mı (tam SHA).
 * @param {string} root
 * @param {string} sha
 * @returns {boolean}
 */
function hasCommit(root, sha) {
  return /^[0-9a-f]{40}$/.test(sha) && refExists(root, sha);
}

/**
 * `from..to` arasındaki korunan değişiklikler (commit'ler; çalışma ağacı yok).
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @returns {ProtectedHit[]}
 */
function protectedBetween(root, from, to) {
  const out = git(root, ["diff", "--name-status", "-z", "-M", "--no-relative", "--no-ext-diff", "--no-textconv", from, to, "--"]);
  return classifyChanges(parseNameStatusZ(out), { before: (f) => fileAtRef(root, from, f), after: (f) => fileAtRef(root, to, f) });
}

/**
 * Not: taban dalı rapordan sonra değişirse (ör. taban sonradan geri alınırsa) koşu yeniden
 * tetiklenmez; Supervisor birleştirmeden hemen önce guards'ı yeniden koşturur (PROTOCOL).
 * Git yol argümanları `--literal-pathspecs` ile verilir (`:`, `*`, `?`, `[` sihirli sayılmaz).
 *
 * Güvenlik raporu SHA'sının tazelik denetimi (T-008i MINOR 8; T-008k madde 8). `null` = taze.
 * `target` verilirse (PR tabanı: `origin/<base>` veya push'ta `HEAD^1`) karar metin farkıyla değil
 * AĞAÇ GİRDİSİ karşılaştırmasıyla verilir. Aday yollar: PR'ın korunan değişiklikleri
 * (`merge-base(target, uç)..uç`, iki uç için) ∪ `sha..head` arasında değişen korunan yollar. Her yol
 * p için (mod, blob) çifti: head[p] == rapor[p] → taze; değilse head[p] == taban[p] (tabanın o
 * yoldaki girdisi birebir alınmış; yalnızca taban birleştirmesi) → taze; aksi STALE. Hem PR hem
 * taban aynı dosyayı değiştirdiyse sonuç ikisinden de farklıdır → STALE (muhafazakâr). `target`
 * verilmezse eski davranış (`sha..head` doğrudan fark).
 * @param {string} root
 * @param {string} head PR head SHA'sı
 * @param {string} [target] PR tabanı ref'i
 * @returns {(sha: string) => string | null}
 */
export function securityFreshness(root, head, target) {
  return (sha) => {
    if (sha === head) return null;
    try {
      if (!hasCommit(root, sha)) return "commit bu depoda yok (başka dalın/zorla yazılmış geçmişin commit'i olabilir)";
      if (!hasCommit(root, head)) return "PR head commit'i yerelde yok; tazelik doğrulanamadı";
      try {
        git(root, ["merge-base", "--is-ancestor", sha, head]);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        return "PR head'inin atası değil";
      }
      if (target === undefined) {
        const hits = protectedBetween(root, sha, head);
        if (hits.length > 0) return `rapordan sonra korunan değişiklik: ${hits.map((h) => h.path).join(", ")}`;
        return null;
      }
      if (!refExists(root, target)) return `PR tabanı (${target}) yerelde yok; tazelik doğrulanamadı`;
      const mbSha = git(root, ["merge-base", target, sha]).trim();
      const mbHead = git(root, ["merge-base", target, head]).trim();
      const ownAtSha = protectedBetween(root, mbSha, sha).map((h) => h.path);
      const ownAtHead = protectedBetween(root, mbHead, head).map((h) => h.path);
      const between = protectedBetween(root, sha, head).map((h) => h.path);
      const candidates = [...new Set([...ownAtSha, ...ownAtHead, ...between])];
      const headTree = treeEntries(root, head, candidates);
      const reportTree = treeEntries(root, sha, candidates);
      const baseTree = treeEntries(root, target, candidates);
      const mbTree = treeEntries(root, mbSha, candidates);
      const changed = candidates.filter((f) => {
        const h = headTree.get(f) ?? "";
        const r = reportTree.get(f) ?? "";
        const b = baseTree.get(f) ?? "";
        // Fail-closed: aday yol (bir uçta değiştiği biliniyor) hiçbir uçta okunamadıysa doğrulanamadı = bayat.
        if (h === "" && r === "" && b === "") return true;
        if (h === r) return false;
        // head == taban yalnızca rapor anında PR bu yolu DEĞİŞTİRMEDİYSE (rapor == merge-base) taze;
        // PR'ın incelenen değişikliği sonradan tabana geri döndürüldüyse bayat (MINOR-1).
        if (h === b) return r !== (mbTree.get(f) ?? "");
        return true;
      });
      if (changed.length > 0) return `rapordan sonra korunan değişiklik: ${changed.join(", ")}`;
      return null;
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      return `git ile doğrulanamadı (${e.message})`;
    }
  };
}

/**
 * Push kipinde HEAD'in PR'ın birleştirilmiş hâli olduğunu doğrular (T-008i MINOR 6). `null` = tamam.
 * @param {string} root
 * @param {string} prHead PR'ın head SHA'sı (API)
 * @returns {string | null}
 */
export function verifyPushMerge(root, prHead) {
  try {
    const parent = revParse(root, "HEAD^1");
    if (parent === null) return "HEAD'in ebeveyni yok";
    const second = revParse(root, "HEAD^2");
    if (second !== null && second !== prHead) {
      return `birleştirme commit'inin ikinci ebeveyni (${second.slice(0, 12)}) PR head'i (${prHead.slice(0, 12)}) değil`;
    }
    if (!hasCommit(root, prHead)) return `PR head commit'i (${prHead.slice(0, 12)}) yerelde yok; birleştirme doğrulanamadı`;
    /** @type {string} */
    let preview;
    try {
      preview = (git(root, ["merge-tree", "--write-tree", "--no-messages", parent, prHead]).split("\n")[0] ?? "").trim();
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      return `PR birleştirme önizlemesi üretilemedi (çakışma veya eksik geçmiş): ${e.message}`;
    }
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
    if (preview !== tree) {
      return `HEAD ağacı (${tree.slice(0, 12)}) PR birleştirme önizlemesinin ağacı (${preview.slice(0, 12)}) değil; commit PR dışı içerik taşıyor`;
    }
    return null;
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    return `git ile doğrulanamadı (${e.message})`;
  }
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
  const pull = /** @type {PullInfo} */ (pulls[0]);
  const bad = verifyPushMerge(root, pull.headSha.toLowerCase());
  if (bad !== null) return { error: `push commit'i PR #${pull.number}'in birleştirilmiş hâli değil: ${bad}` };
  return { pull };
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
    const result = evaluateApproval(found.pull.body, found.pull.headSha, {
      securityFresh: securityFreshness(root, found.pull.headSha.toLowerCase(), target),
    });
    out.detail("freshnessNote", "taban dalı değişirse koşu yeniden tetiklenmez; Supervisor birleştirmeden hemen önce guards'ı yeniden koşturur");
    out.detail("approval", {
      pr: found.pull.number,
      headSha: found.pull.headSha,
      approved: result.approved,
      security: result.security.map((s) => ({ blocker: s.blocker, major: s.major, minor: s.minor, sha: s.sha })),
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
