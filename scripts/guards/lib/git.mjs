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
   * @param {{ status?: number | null, stdout?: string, stderr?: string }} [info] süreç çıkış kodu (sinyalle ölümde `null`) ve çıktıları
   */
  constructor(message, args, info = {}) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.status = info.status ?? null;
    this.stdout = info.stdout ?? "";
    this.stderr = info.stderr ?? "";
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
    const err = /** @type {{ stderr?: unknown, stdout?: unknown, status?: unknown, message?: unknown }} */ (e);
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    const msg = stderr || String(err.message ?? e);
    throw new GitError(`git ${args.join(" ")}: ${msg}`, args, {
      status: typeof err.status === "number" ? err.status : null,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr,
    });
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
  // Tam commit SHA'sı içerik-adreslidir (değişmez; `--no-replace-objects`): bulunan içerik süreç
  // içinde önbelleklenir (T-008l madde 1). `HEAD`/dal adları ASLA önbelleklenmez; "yok" (null) de değil.
  const key = /^[0-9a-f]{40}$/.test(ref) ? `${cwd}\0${ref}\0${file}` : null;
  if (key !== null) {
    const hit = BLOB_CACHE.get(key);
    if (hit !== undefined) return hit;
  }
  const spec = `${ref}:${file}`;
  // Tek alt süreç: blob okunur; başarısızsa `cat-file -e` ile "yok" ile "okunamadı"
  // (ör. girdi blob değil, nesne bozuk) ayrılır — yoksa `null`, varsa asıl hata (fail-closed) fırlar.
  try {
    const content = git(cwd, ["cat-file", "blob", spec]);
    if (key !== null) BLOB_CACHE.set(key, content);
    return content;
  } catch (e) {
    try {
      git(cwd, ["cat-file", "-e", spec]);
    } catch {
      return null;
    }
    throw e;
  }
}

/** @type {Map<string, string>} */
const BLOB_CACHE = new Map();

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
