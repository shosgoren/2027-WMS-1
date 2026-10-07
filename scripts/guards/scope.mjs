// `pnpm check:scope` (T-008a): daldaki değişen her dosya kartın "Dokunulacak dosyalar"
// globlarından en az biriyle eşleşmeli. Kartın kendisi örtük izinlidir; başka örtük izin yok.
//   --base <ref>     hedef dal (varsayılan: kartın Dal satırındaki `→ int/…` hedefi
//                    `origin/int/…`, yoksa `origin/main`; `int/*` dalında `origin/main`)
//   --branch <ad>    dal adı (varsayılan: geçerli dal; CI'da ayrık HEAD için)
// `main` kipi (T-299; dal adı `main`, yani main'e push): HEAD bir PR birleştirme commit'i olmalı
// (tam 2 ebeveyn + "Merge pull request #N from <sahip>/<dal>" konusu); PR dalı bundan çözülür ve
// o dalın kuralıyla (int/* → birleştirilmiş kartlar + SUPERVISOR_PATHS; feat|fix/T-xxx → tek kart)
// `HEAD^1..HEAD` farkı denetlenir. Çözülemezse FAIL (atla/geç yok); PR'sız commit FAIL (G-08).
// Kart listesi dalda değiştiyse `WARN SCOPE_CARD_CHANGED` (Supervisor §2 adım 4'te okur).
import path from "node:path";
import { CardError, cardIdFromBranch, isIntBranch, mergedWorkBranches, parseCardFiles, resolveCards } from "./lib/cards.mjs";
import {
  branchPointsAt,
  changedFiles,
  currentBranch,
  DEFAULT_TARGET,
  fileAtRef,
  git,
  GitError,
  indexEntries,
  isAncestor,
  mergeBase,
  mergeHeads,
  mergeMsgSubject,
  mergeSubjects,
  refExists,
  repoRoot,
  touchedPaths,
  treeEntries,
  worktreeEntries,
} from "./lib/git.mjs";
import { NO_FILE, UsageError } from "./lib/output.mjs";

/**
 * @typedef {import("./lib/cards.mjs").Card} Card
 * @typedef {import("./lib/output.mjs").Reporter} Reporter
 * @typedef {{ base: string | null, branch: string | null }} ScopeArgs
 */

/**
 * `int/*` dallarında (yalnızca orada) kartsız Supervisor commit'lerine açık yollar
 * (PROTOCOL §2: Supervisor STATE/JOURNAL/kart/ADR kayıtlarını entegrasyon dalında tutar;
 * Supervisor kararı, T-008a). `feat|fix/T-xxx` dallarında geçerli değildir — orada yalnızca
 * kart listesi. Bu yolların korunanlığı ayrı bekçidedir (`check:protected`).
 */
export const SUPERVISOR_PATHS = Object.freeze([
  "docs/STATE.md",
  "docs/JOURNAL.md",
  "docs/OPEN_QUESTIONS.md",
  "docs/DECISIONS.md",
  "docs/adr/**",
  "docs/tasks/**",
  "docs/MAP.md",
]);

/**
 * Süren çakışmalı birleştirmenin (MERGE_HEAD) hedef taraftan getirdiği yollar (T-242).
 * Yalnızca şu koşullarda bir MERGE_HEAD `M` sayılır: geçerli commit, hedefin atası (ya da
 * kendisi) ve `base` onun atası. Bu durumda bir yol muaf olur ancak şu ikisi birlikte doğruysa:
 *   (1) yol `base`'den `HEAD`'e değişmemiş (dalın kendi işi değil; dalın değiştirdiği yol
 *       her zaman kart listesine tabi kalır) ve
 *   (2) çalışma ağacındaki VE indeksteki (commit'e girecek) içeriği (mod + blob) `M`'dekiyle aynı
 *       (ya da üçünde de yok).
 * Birleşmeden gelen ama sonradan elle değiştirilen (kart dışı ek değişiklik) yol muaf olmaz.
 * Sahte/ilgisiz MERGE_HEAD (hedefin atası değil, `base`'in soyundan değil) = hiçbir yol muaf değil.
 * @param {string} root
 * @param {string} target
 * @param {string} base
 * @param {import("./lib/git.mjs").Change[]} changes
 * @returns {Set<import("./lib/git.mjs").Change>}
 */
export function mergeBroughtChanges(root, target, base, changes) {
  /** @type {Set<import("./lib/git.mjs").Change>} */
  const exempt = new Set();
  const heads = mergeHeads(root).filter((m) => isAncestor(root, m, target) && isAncestor(root, base, m) && !isAncestor(root, m, "HEAD"));
  if (heads.length === 0 || changes.length === 0) return exempt;
  const paths = touchedPaths(changes);
  const baseE = new Map();
  const headE = new Map();
  const wtE = worktreeEntries(root, paths);
  const idxE = indexEntries(root, paths);
  /** @type {Map<string, string>[]} */
  const mergeE = heads.map(() => new Map());
  for (let i = 0; i < paths.length; i += 400) {
    const chunk = paths.slice(i, i + 400);
    for (const [k, v] of treeEntries(root, base, chunk)) baseE.set(k, v);
    for (const [k, v] of treeEntries(root, "HEAD", chunk)) headE.set(k, v);
    heads.forEach((m, j) => {
      for (const [k, v] of treeEntries(root, m, chunk)) mergeE[j]?.set(k, v);
    });
  }
  /** @param {string} p */
  const broughtByMerge = (p) =>
    baseE.get(p) === headE.get(p) && mergeE.some((e) => e.get(p) === wtE.get(p) && e.get(p) === idxE.get(p) && wtE.get(p) !== "?");
  for (const c of changes) {
    if (broughtByMerge(c.path) && (c.oldPath === undefined || broughtByMerge(c.oldPath))) exempt.add(c);
  }
  return exempt;
}

/**
 * Süren birleştirmede, birleştirilen ucu gösteren çalışma dalları için sentetik birleştirme konuları
 * (MERGE_MSG'den dal adı; dal ref'i gerçekten MERGE_HEAD'e işaret etmeli — elle yazılmış MERGE_MSG
 * tek başına kart açmaz).
 * @param {string} root
 * @returns {string[]}
 */
function pendingMergeSubjects(root) {
  const heads = mergeHeads(root);
  if (heads.length === 0) return [];
  return mergedWorkBranches([mergeMsgSubject(root)])
    .filter((b) => heads.some((h) => branchPointsAt(root, b, h)))
    .map((b) => `Merge branch '${b}'`);
}

/**
 * @param {string[]} argv
 * @returns {ScopeArgs}
 */
export function parseScopeArgs(argv) {
  /** @type {ScopeArgs} */
  const args = { base: null, branch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") continue;
    const m = /^--(base|branch)(?:=(.*))?$/.exec(a);
    if (m === null) throw new UsageError(`bilinmeyen argüman "${a}"`);
    const key = /** @type {"base" | "branch"} */ (m[1]);
    const v = m[2] ?? argv[++i];
    if (v === undefined || v === "") throw new UsageError(`--${key} bir değer ister`);
    if (args[key] !== null) throw new UsageError(`--${key} birden fazla verildi`);
    args[key] = v;
  }
  return args;
}

/**
 * @param {string} file
 * @param {string[]} globs
 * @returns {boolean}
 */
export function matchesAny(file, globs) {
  return globs.some((g) => path.posix.matchesGlob(file, g));
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{ added: string[], removed: string[] }}
 */
function listDiff(a, b) {
  return { added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) };
}

/**
 * Kartın dosya listesi merge-base'e göre değiştiyse uyarı.
 * @param {Reporter} out
 * @param {string} root
 * @param {string} base
 * @param {Card} card
 */
function checkCardChanged(out, root, base, card) {
  const before = fileAtRef(root, base, card.path);
  if (before === null) {
    out.warn("SCOPE_CARD_CHANGED", card.path, `kart dalda oluşturuldu; dosya listesi: ${card.globs.join(", ")}`);
    return;
  }
  /** @type {string[]} */
  let prev;
  try {
    prev = parseCardFiles(before, card.path);
  } catch (e) {
    if (!(e instanceof CardError)) throw e;
    out.warn("SCOPE_CARD_CHANGED", card.path, `tabandaki kart listesi okunamadı (${e.message}); şimdiki: ${card.globs.join(", ")}`);
    return;
  }
  const { added, removed } = listDiff(prev, card.globs);
  if (added.length === 0 && removed.length === 0) return;
  const parts = [];
  if (added.length > 0) parts.push(`eklenen: ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`çıkarılan: ${removed.join(", ")}`);
  out.warn("SCOPE_CARD_CHANGED", card.path, `kartın dosya listesi dalda değişti (${parts.join("; ")})`);
}

/** `main` dalı adı: bu adla çalışan bekçi main-push kipindedir. */
export const MAIN_BRANCH = "main";

/**
 * GitHub PR birleştirme konusu. Dal adı boşluksuz tek simge; ardındaki isteğe bağlı serbest metin
 * (Supervisor'ın verdiği başlık eki) dal çözümüne katılmaz.
 */
const PR_MERGE_SUBJECT = /^Merge pull request #([1-9]\d{0,8}) from ([A-Za-z0-9][A-Za-z0-9-]*)\/(\S+)(?:\s.*)?$/;

/** main-push kipinde PR dalının çözülememesi (kod + ileti; her biri FAIL). */
class MainPushError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "MainPushError";
    this.code = code;
  }
}

/**
 * main'e push edilen HEAD'in PR birleştirme commit'i olduğunu doğrular ve PR dalını çözer.
 * Yalnız konuya güvenilmez: ikinci ebeveyn, iş akışının `refs/pull/N/head`'den getirdiği
 * `refs/remotes/pull/N/head` ile birebir aynı olmalı (GitHub'ın PR başı; konu sahte yazılsa da
 * PR #N'nin başı değilse FAIL). Ayrıca `origin/<dal>` hâlâ varsa ikinci ebeveyn onun atası olmalı.
 * @param {string} root
 * @returns {{ prBranch: string, number: string, base: string, tip: string }}
 */
function resolveMainPush(root) {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1);
  if (parents.length !== 2) {
    throw new MainPushError(
      "MAIN_DIRECT_PUSH",
      `HEAD bir PR birleştirme commit'i değil (${parents.length} ebeveyn; 2 beklenir) — main'e doğrudan push yasak (G-08)`,
    );
  }
  const [base, tip] = /** @type {[string, string]} */ (parents);
  const subject = git(root, ["log", "-1", "--format=%s", "HEAD"]).trim();
  const m = PR_MERGE_SUBJECT.exec(subject);
  if (m === null) {
    throw new MainPushError("MAIN_PR_SUBJECT", `birleştirme konusu "Merge pull request #N from <sahip>/<dal>" biçiminde değil: "${subject}"`);
  }
  const number = /** @type {string} */ (m[1]);
  const prBranch = /** @type {string} */ (m[3]);
  const prRef = `refs/remotes/pull/${number}/head`;
  if (!refExists(root, prRef)) {
    throw new MainPushError("MAIN_PR_UNVERIFIED", `PR #${number} başı (${prRef}) yerelde yok; ikinci ebeveyn doğrulanamadı`);
  }
  const prHead = git(root, ["rev-parse", `${prRef}^{commit}`]).trim();
  if (prHead !== tip) {
    throw new MainPushError("MAIN_PR_UNVERIFIED", `ikinci ebeveyn ${tip.slice(0, 7)}, PR #${number} başı ${prHead.slice(0, 7)} ile aynı değil`);
  }
  const branchRef = `refs/remotes/origin/${prBranch}`;
  if (refExists(root, branchRef) && !isAncestor(root, tip, branchRef)) {
    throw new MainPushError("MAIN_PR_UNVERIFIED", `ikinci ebeveyn ${tip.slice(0, 7)}, origin/${prBranch} dalının commit'i değil`);
  }
  if (cardIdFromBranch(prBranch) === null && !isIntBranch(prBranch)) {
    throw new MainPushError("MAIN_PR_SUBJECT", `PR dalı "${prBranch}" kart kalıbına uymuyor (feat|fix/T-xxx[a-z]?-… veya int/…)`);
  }
  return { prBranch, number, base, tip };
}

/**
 * @param {{ root: string, argv: string[], out: Reporter }} ctx
 */
export function run(ctx) {
  const { out } = ctx;
  const args = parseScopeArgs(ctx.argv);
  try {
    const root = repoRoot(ctx.root);
    const branch = args.branch ?? currentBranch(root);
    out.detail("branch", branch);

    /** @type {{ kind: "work" | "int", cards: Card[] }} */
    let scope;
    /** @type {string} */
    let target;
    /** @type {string} */
    let base;
    try {
      if (branch === MAIN_BRANCH) {
        if (args.base !== null) throw new UsageError("--base main kipinde (dal adı main) verilemez; taban HEAD^1'dir");
        const pr = resolveMainPush(root);
        out.detail("prMerge", { number: pr.number, branch: pr.prBranch, base: pr.base, tip: pr.tip });
        const { base: b, tip } = pr;
        scope = resolveCards(root, pr.prBranch, () =>
          git(root, ["log", "--first-parent", "--merges", "--format=%s", `${b}..${tip}`]).split("\n").filter((l) => l !== ""),
        );
        target = b;
        base = b;
      } else {
        scope = resolveCards(root, branch, () => [...mergeSubjects(root, mergeBase(root, args.base ?? DEFAULT_TARGET)), ...pendingMergeSubjects(root)]);
        const first = scope.cards[0];
        target = args.base ?? (scope.kind === "work" && first?.intTarget ? `origin/${first.intTarget}` : DEFAULT_TARGET);
        base = mergeBase(root, target);
      }
    } catch (e) {
      if (e instanceof MainPushError) {
        out.fail(e.code, NO_FILE, e.message);
        return;
      }
      if (!(e instanceof CardError)) throw e;
      out.fail(e.code, e.file, e.message);
      return;
    }
    out.detail("target", target);
    out.detail("mergeBase", base);
    out.detail("cards", scope.cards.map((c) => ({ id: c.id, path: c.path, globs: c.globs })));

    const cardPaths = scope.cards.map((c) => c.path);
    const globs = scope.cards.flatMap((c) => c.globs);
    if (scope.kind === "int") globs.push(...SUPERVISOR_PATHS);
    const ids = scope.cards.map((c) => c.id).join(", ") || "birleştirilmiş kart yok";
    const changes = changedFiles(root, base);
    out.detail("changes", changes);
    const fromMerge = mergeBroughtChanges(root, target, base, changes);
    if (fromMerge.size > 0) out.detail("mergeBrought", [...fromMerge].map((c) => c.path));

    /** @type {Set<string>} */
    const reported = new Set();
    for (const c of changes) {
      if (fromMerge.has(c)) continue;
      for (const p of c.oldPath === undefined ? [c.path] : [c.oldPath, c.path]) {
        if (cardPaths.includes(p) || matchesAny(p, globs) || reported.has(p)) continue;
        reported.add(p);
        const how = c.oldPath === undefined ? `durum ${c.status}` : `yeniden adlandırma ${c.oldPath} → ${c.path}`;
        out.fail("OUT_OF_SCOPE", p, `kart dosya listesinde yok (${ids}; ${how})`);
      }
    }
    for (const card of scope.cards) checkCardChanged(out, root, base, card);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    out.fail("GIT_ERROR", NO_FILE, e.message);
  }
}
