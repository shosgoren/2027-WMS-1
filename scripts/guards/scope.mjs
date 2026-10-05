// `pnpm check:scope` (T-008a): daldaki değişen her dosya kartın "Dokunulacak dosyalar"
// globlarından en az biriyle eşleşmeli. Kartın kendisi örtük izinlidir; başka örtük izin yok.
//   --base <ref>     hedef dal (varsayılan: kartın Dal satırındaki `→ int/…` hedefi
//                    `origin/int/…`, yoksa `origin/main`; `int/*` dalında `origin/main`)
//   --branch <ad>    dal adı (varsayılan: geçerli dal; CI'da ayrık HEAD için)
// Kart listesi dalda değiştiyse `WARN SCOPE_CARD_CHANGED` (Supervisor §2 adım 4'te okur).
import path from "node:path";
import { CardError, parseCardFiles, resolveCards } from "./lib/cards.mjs";
import { changedFiles, currentBranch, DEFAULT_TARGET, fileAtRef, GitError, mergeBase, mergeSubjects, repoRoot } from "./lib/git.mjs";
import { NO_FILE, UsageError } from "./lib/output.mjs";

/**
 * @typedef {import("./lib/cards.mjs").Card} Card
 * @typedef {import("./lib/output.mjs").Reporter} Reporter
 * @typedef {{ base: string | null, branch: string | null }} ScopeArgs
 */

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
      scope = resolveCards(root, branch, () => mergeSubjects(root, mergeBase(root, args.base ?? DEFAULT_TARGET)));
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
    const ids = scope.cards.map((c) => c.id).join(", ") || "birleştirilmiş kart yok";
    const changes = changedFiles(root, base);
    out.detail("changes", changes);

    /** @type {Set<string>} */
    const reported = new Set();
    for (const c of changes) {
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
