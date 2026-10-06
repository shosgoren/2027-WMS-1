// `pnpm check:scope` (T-008a): daldaki değişen her dosya kartın "Dokunulacak dosyalar"
// globlarından en az biriyle eşleşmeli. Kartın kendisi örtük izinlidir; başka örtük izin yok.
//   --base <ref>     hedef dal (varsayılan: kartın Dal satırındaki `→ int/…` hedefi
//                    `origin/int/…`, yoksa `origin/main`; `int/*` dalında `origin/main`)
//   --branch <ad>    dal adı (varsayılan: geçerli dal; CI'da ayrık HEAD için)
// Kart listesi dalda değiştiyse `WARN SCOPE_CARD_CHANGED` (Supervisor §2 adım 4'te okur).
import path from "node:path";
import { CardError, mergedWorkBranches, parseCardFiles, resolveCards } from "./lib/cards.mjs";
import {
  branchPointsAt,
  changedFiles,
  currentBranch,
  DEFAULT_TARGET,
  fileAtRef,
  GitError,
  indexEntries,
  isAncestor,
  mergeBase,
  mergeHeads,
  mergeMsgSubject,
  mergeSubjects,
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
    try {
      scope = resolveCards(root, branch, () => [...mergeSubjects(root, mergeBase(root, args.base ?? DEFAULT_TARGET)), ...pendingMergeSubjects(root)]);
    } catch (e) {
      if (!(e instanceof CardError)) throw e;
      out.fail(e.code, e.file, e.message);
      return;
    }
    const first = scope.cards[0];
    const target =
      args.base ?? (scope.kind === "work" && first?.intTarget ? `origin/${first.intTarget}` : DEFAULT_TARGET);
    const base = mergeBase(root, target);
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
