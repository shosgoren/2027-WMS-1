// Bekçilerin ortak git yardımcıları (T-008a). Yalnızca `git` CLI'ı (`execFileSync`, kabuk yok).
// Depo her zaman `cwd` ile belirlenir: ortamdaki GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE … gibi
// konum değişkenleri silinir; aksi hâlde commit kancasında koşan bir bekçi (veya testi)
// yanlış depoya bakabilirdi. Ayrıca (T-008h m5) çıktıyı değiştirebilen yapılandırma/nesne
// değişkenleri (`GIT_CONFIG*`, `GIT_CONFIG_PARAMETERS`, `GIT_REPLACE_REF_BASE`) silinir ve her
// çağrı `--no-replace-objects` ile koşar: `refs/replace/*` bir commit'i/blob'u başka içerikle
// gösteremez.
import { execFileSync } from "node:child_process";

/** Varsayılan hedef dal (kartın Dal satırında `int/…` hedefi yoksa). */
export const DEFAULT_TARGET = "origin/main";

/** Depo konumunu `cwd` dışından belirleyen ortam değişkenleri. */
const LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

/** Yapılandırma enjeksiyonu ve nesne değiştirme değişkenleri (önekle: `GIT_CONFIG*`). */
const CONFIG_VAR_RE = /^GIT_CONFIG/;
const EXTRA_VARS = ["GIT_REPLACE_REF_BASE"];

export class GitError extends Error {
  /**
   * @param {string} message
   * @param {string[]} args
   */
  constructor(message, args) {
    super(message);
    this.name = "GitError";
    this.args = args;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(base = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...base };
  for (const k of [...LOCATION_VARS, ...EXTRA_VARS]) delete env[k];
  for (const k of Object.keys(env)) if (CONFIG_VAR_RE.test(k)) delete env[k];
  return env;
}

/**
 * `git <args>` koşar, stdout'u döner. Sıfır olmayan çıkış = `GitError` (stderr mesajda).
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
export function git(cwd, args) {
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = /** @type {{ stderr?: unknown, message?: unknown }} */ (e);
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    const msg = stderr || String(err.message ?? e);
    throw new GitError(`git ${args.join(" ")}: ${msg}`, args);
  }
}

/**
 * Deponun kök dizini (çalışma ağacı).
 * @param {string} cwd
 * @returns {string}
 */
export function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/**
 * Geçerli dal adı. Ayrık HEAD (detached) = hata; dal adı bilinmeden kapsam belirlenemez.
 * @param {string} cwd
 * @returns {string}
 */
export function currentBranch(cwd) {
  const name = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (name === "HEAD" || name === "") {
    throw new GitError("HEAD ayrık (detached); dal adı belirlenemedi (--branch ile verin)", ["rev-parse"]);
  }
  return name;
}

/**
 * @param {string} cwd
 * @param {string} ref
 * @returns {boolean}
 */
export function refExists(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * HEAD ile hedef dalın ortak atası.
 * @param {string} cwd
 * @param {string} [target]
 * @returns {string} commit kimliği
 */
export function mergeBase(cwd, target = DEFAULT_TARGET) {
  // Tek alt süreç (T-008l madde 1): başarısızlıkta ref'in yokluğu ile ortak ata yokluğu ayrılır.
  try {
    return git(cwd, ["merge-base", target, "HEAD"]).trim();
  } catch (e) {
    if (!refExists(cwd, target)) throw new GitError(`hedef ref bulunamadı: ${target}`, ["merge-base"]);
    throw e;
  }
}

/**
 * @typedef {"A" | "M" | "D" | "R" | "C" | "T" | "U" | "X" | "?"} ChangeStatus
 * @typedef {{ status: ChangeStatus, path: string, oldPath?: string }} Change
 */

/**
 * `git diff --name-status -z` çıktısını ayrıştırır. Yeniden adlandırma/kopya (R/C) iki yol taşır.
 * @param {string} out
 * @returns {Change[]}
 */
export function parseNameStatusZ(out) {
  const parts = out.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  /** @type {Change[]} */
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? "";
    const letter = code.charAt(0);
    if (letter === "" || !"AMDRCTUX".includes(letter)) {
      throw new GitError(`tanınmayan diff durumu: "${code}"`, ["diff"]);
    }
    const status = /** @type {ChangeStatus} */ (letter);
    if (status === "R" || status === "C") {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (oldPath === undefined || newPath === undefined) throw new GitError(`eksik ${status} kaydı`, ["diff"]);
      changes.push({ status, path: newPath, oldPath });
    } else {
      const p = parts[i++];
      if (p === undefined) throw new GitError(`eksik ${status} kaydı`, ["diff"]);
      changes.push({ status, path: p });
    }
  }
  return changes;
}

/**
 * `base`'den bu yana değişen dosyalar: commit'lenmiş + indeks + çalışma ağacı (izlenen) ve
 * izlenmeyen (ignore edilmemiş) yeni dosyalar. Commit kancasında da CI'da da aynı sonucu
 * verir (temiz ağaçta yalnızca commit'ler kalır). Yeniden adlandırmada eski ve yeni yol.
 * @param {string} cwd depo kökü
 * @param {string} base commit/ref
 * @param {{ includeWorktree?: boolean }} [opts] `false` = yalnızca `base..HEAD` commit'leri
 * @returns {Change[]}
 */
export function changedFiles(cwd, base, opts = {}) {
  const includeWorktree = opts.includeWorktree ?? true;
  const range = includeWorktree ? [base] : [base, "HEAD"];
  const out = git(cwd, ["diff", "--name-status", "-z", "-M", "--no-relative", "--no-ext-diff", "--no-textconv", ...range, "--"]);
  const changes = parseNameStatusZ(out);
  if (includeWorktree) {
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"]);
    for (const p of untracked.split("\0")) {
      if (p !== "") changes.push({ status: "?", path: p });
    }
  }
  return changes;
}

/**
 * `rev` ağacındaki `files` girdileri: yol → `"<mod> <type> <id>"`; yol yoksa `""`. Tek `ls-tree`
 * süreci; tam yol eşleşmesi (`--literal-pathspecs`; `:`, `*`, `?`, `[` sihirli sayılmaz).
 * @param {string} cwd
 * @param {string} rev
 * @param {string[]} files
 * @returns {Map<string, string>}
 */
export function treeEntries(cwd, rev, files) {
  /** @type {Map<string, string>} */
  const entries = new Map(files.map((f) => [f, ""]));
  if (files.length === 0) return entries;
  const out = git(cwd, ["--literal-pathspecs", "ls-tree", "-z", rev, "--", ...files]);
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const file = rec.slice(tab + 1);
    if (!entries.has(file)) continue;
    const [mode, type, id] = rec.slice(0, tab).split(" ");
    entries.set(file, `${mode} ${type} ${id}`);
  }
  return entries;
}

/**
 * Bu dalın YAZMADIĞI değişiklikleri düşer (T-008l madde 2). `changes`, `base..çalışma ağacı`
 * farkıdır; hedef dalın (ya da `main`'in) içeriğini birleştiren bir merge commit'i, hedefte
 * olup `base`'de olmayan dosyaları da bu farka sokar (yerel `origin/<int>` bayat/`main` birleştirilmiş).
 * "Yabancı" commit'ler: `targets` uçları ∪ `base..HEAD` ilk-ebeveyn zincirindeki merge
 * commit'lerinin diğer ebeveynlerinden `targets` uçlarından birinin ATASI (veya kendisi) olanlar.
 * Bir değişiklik yalnızca şu koşulların HEPSİ doğruysa düşer: (1) dosya HEAD'de VAR ve HEAD
 * girdisi (mod, tür, blob) bir yabancı commit'teki girdiyle BİREBİR aynı (içerik zaten hedefte);
 * (2) yeniden adlandırma/kopyada eski yol yabancı commit'te de yok ve HEAD'de de yok (yeniden
 * adlandırma da oradan geldi); (3) yol indekste/çalışma ağacında HEAD'den farklı değil ve
 * izlenmeyen değil (yerel düzenleme = bu dalın yazdığı). Silmeler asla düşmez. Bu dalda yazılan,
 * yabancı commit'lerde birebir bulunmayan her değişiklik kalır.
 * @param {string} cwd depo kökü
 * @param {string} base `mergeBase(hedef)`
 * @param {Change[]} changes
 * @param {string[]} targets hedef ref'leri (örn. `origin/int/x`, `origin/main`); olmayanlar atlanır
 * @returns {Change[]}
 */
export function dropForeignChanges(cwd, base, changes, targets) {
  if (changes.length === 0) return changes;
  const tips = [...new Set(targets)].filter((t) => refExists(cwd, t));
  if (tips.length === 0) return changes;
  /** @type {Set<string>} */
  const foreign = new Set(tips.map((t) => git(cwd, ["rev-parse", "--verify", `${t}^{commit}`]).trim()));
  const merges = git(cwd, ["rev-list", "--first-parent", "--merges", "--parents", `${base}..HEAD`]);
  for (const line of merges.split("\n")) {
    const [, , ...extra] = line.trim().split(/\s+/);
    for (const o of extra) {
      if (o === undefined || o === "" || foreign.has(o)) continue;
      const contained = tips.some((t) => {
        try {
          git(cwd, ["merge-base", "--is-ancestor", o, t]);
          return true;
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          return false;
        }
      });
      if (contained) foreign.add(o);
    }
  }
  const dirty = new Set(touchedPaths(changedFiles(cwd, "HEAD")));
  const candidates = touchedPaths(changes.filter((c) => c.status !== "D"));
  const head = treeEntries(cwd, "HEAD", candidates);
  const foreignTrees = [...foreign].map((rev) => treeEntries(cwd, rev, candidates));
  return changes.filter((c) => {
    if (c.status === "D") return true;
    if (dirty.has(c.path) || (c.oldPath !== undefined && dirty.has(c.oldPath))) return true;
    const h = head.get(c.path) ?? "";
    if (h === "") return true;
    if (c.oldPath !== undefined && (head.get(c.oldPath) ?? "") !== "") return true;
    return !foreignTrees.some((t) => t.get(c.path) === h && (c.oldPath === undefined || (t.get(c.oldPath) ?? "") === ""));
  });
}

/**
 * Değişikliklerin dokunduğu tüm yollar (ad değişikliğinde eski + yeni), tekil ve sıralı.
 * @param {Change[]} changes
 * @returns {string[]}
 */
export function touchedPaths(changes) {
  const set = new Set();
  for (const c of changes) {
    set.add(c.path);
    if (c.oldPath !== undefined) set.add(c.oldPath);
  }
  return [...set].sort();
}

/**
 * Bir dosyanın verilen ref'teki içeriği (örn. `origin/main` veya merge-base). Yoksa `null`.
 * @param {string} cwd
 * @param {string} ref
 * @param {string} file depo köküne göre yol
 * @returns {string | null}
 */
export function fileAtRef(cwd, ref, file) {
  const spec = `${ref}:${file}`;
  // Tek alt süreç (T-008l madde 1): blob okunur; başarısızsa `cat-file -e` ile "yok" ile "okunamadı"
  // (ör. girdi blob değil, nesne bozuk) ayrılır — yoksa `null`, varsa asıl hata (fail-closed) fırlar.
  try {
    return git(cwd, ["cat-file", "blob", spec]);
  } catch (e) {
    try {
      git(cwd, ["cat-file", "-e", spec]);
    } catch {
      return null;
    }
    throw e;
  }
}

/**
 * `base..HEAD` aralığındaki ilk-ebeveyn birleştirme commit'lerinin konu satırları.
 * @param {string} cwd
 * @param {string} base
 * @returns {string[]}
 */
export function mergeSubjects(cwd, base) {
  const out = git(cwd, ["log", "--first-parent", "--merges", "--format=%s", `${base}..HEAD`]);
  return out.split("\n").filter((l) => l !== "");
}

/**
 * `base..HEAD` aralığındaki TÜM birleştirme commit'lerinin konu satırları — ilk-ebeveyn olmayanlar
 * dahil (T-008l madde 3): birleşen bir dalın içinde birleşmiş çalışma dalları da görünür
 * (dolaylı gelen kart; boş merge commit'i geçici çözümü gerekmez).
 * @param {string} cwd
 * @param {string} base
 * @returns {string[]}
 */
export function allMergeSubjects(cwd, base) {
  const out = git(cwd, ["log", "--merges", "--format=%s", `${base}..HEAD`]);
  return out.split("\n").filter((l) => l !== "");
}

/**
 * `base..HEAD` ilk-ebeveyn zincirindeki merge commit'lerinin BİRLEŞEN tarafı (birinci ebeveyn dışı)
 * uç commit'lerinin konu satırları (T-008l madde 3: kart kimliği `T-xxx` önekinden).
 * @param {string} cwd
 * @param {string} base
 * @returns {string[]}
 */
export function mergedTipSubjects(cwd, base) {
  const merges = git(cwd, ["rev-list", "--first-parent", "--merges", "--parents", `${base}..HEAD`]);
  /** @type {string[]} */
  const tips = [];
  for (const line of merges.split("\n")) {
    const [, , ...extra] = line.trim().split(/\s+/);
    for (const t of extra) if (t !== undefined && t !== "" && !tips.includes(t)) tips.push(t);
  }
  if (tips.length === 0) return [];
  const out = git(cwd, ["log", "--no-walk=unsorted", "--format=%s", ...tips, "--"]);
  return out.split("\n").filter((l) => l !== "");
}
