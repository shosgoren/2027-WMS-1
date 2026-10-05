// T-008a `lib/git.mjs` testleri: geçici dizinde gerçek git deposu (testkit), sahte çıktı yok.
import { afterEach, describe, expect, it } from "vitest";
import {
  changedFiles,
  currentBranch,
  fileAtRef,
  GitError,
  gitEnv,
  mergeBase,
  mergeSubjects,
  parseNameStatusZ,
  refExists,
  repoRoot,
  touchedPaths,
} from "./git.mjs";
import { createRepo } from "./testkit.mjs";

/** @type {import("./testkit.mjs").TestRepo[]} */
const repos = [];
function repo() {
  const r = createRepo({ prefix: "guards-git-" });
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

/** main: a.txt, b.txt, dir/c.txt; origin/main yayımlı; feat/T-001-x dalı açık. */
function base() {
  const r = repo();
  r.writeAll({ "a.txt": "a\n", "b.txt": "b\n", "dir/c.txt": "c\n" }).commit("init").publish("main");
  r.branch("feat/T-001-x");
  return r;
}

describe("git yardımcıları", () => {
  it("repoRoot ve currentBranch gerçek depodan okunur", () => {
    const r = base();
    expect(repoRoot(r.dir)).toBe(r.git("rev-parse", "--show-toplevel").trim());
    expect(currentBranch(r.dir)).toBe("feat/T-001-x");
  });

  it("ayrık HEAD'de currentBranch hata verir", () => {
    const r = base();
    r.git("checkout", "--quiet", "--detach");
    expect(() => currentBranch(r.dir)).toThrow(GitError);
  });

  it("mergeBase hedef dalla ortak atayı bulur; hedef yoksa hata", () => {
    const r = base();
    const mainSha = r.git("rev-parse", "main").trim();
    r.write("a.txt", "a2\n").commit("feat");
    r.checkout("main").write("b.txt", "b2\n").commit("main ilerledi").publish("main").checkout("feat/T-001-x");
    expect(mergeBase(r.dir)).toBe(mainSha);
    expect(mergeBase(r.dir, "main")).toBe(mainSha);
    expect(refExists(r.dir, "origin/main")).toBe(true);
    expect(refExists(r.dir, "origin/yok")).toBe(false);
    expect(() => mergeBase(r.dir, "origin/yok")).toThrow(/hedef ref bulunamadı: origin\/yok/);
  });

  it("changedFiles ekleme, değişiklik, silme ve yeniden adlandırmayı (eski + yeni yol) verir", () => {
    const r = base();
    const mb = mergeBase(r.dir);
    r.write("new.txt", "n\n").write("a.txt", "a2\n").remove("b.txt").rename("dir/c.txt", "moved/c.txt").commit("değişiklikler");
    const changes = changedFiles(r.dir, mb, { includeWorktree: false });
    expect(changes).toEqual(
      expect.arrayContaining([
        { status: "A", path: "new.txt" },
        { status: "M", path: "a.txt" },
        { status: "D", path: "b.txt" },
        { status: "R", path: "moved/c.txt", oldPath: "dir/c.txt" },
      ]),
    );
    expect(changes).toHaveLength(4);
    expect(touchedPaths(changes)).toEqual(["a.txt", "b.txt", "dir/c.txt", "moved/c.txt", "new.txt"]);
  });

  it("changedFiles varsayılan olarak commit'lenmemiş ve izlenmeyen dosyaları da sayar", () => {
    const r = base();
    const mb = mergeBase(r.dir);
    r.write("a.txt", "kirli\n").write("yeni/izlenmeyen.txt", "u\n");
    expect(changedFiles(r.dir, mb)).toEqual([
      { status: "M", path: "a.txt" },
      { status: "?", path: "yeni/izlenmeyen.txt" },
    ]);
    expect(changedFiles(r.dir, mb, { includeWorktree: false })).toEqual([]);
  });

  it("ignore edilen dosyalar değişiklik sayılmaz; alt dizinden çağrıda yollar kökten", () => {
    const r = base();
    const mb = mergeBase(r.dir);
    r.write(".gitignore", "*.log\n").write("dir/x.log", "l\n").write("dir/y.txt", "y\n");
    const sub = `${r.dir}/dir`;
    expect(touchedPaths(changedFiles(sub, mb))).toEqual([".gitignore", "dir/y.txt"]);
  });

  it("fileAtRef dosyanın ref'teki içeriğini, yoksa null döner", () => {
    const r = base();
    r.write("a.txt", "değişti\n").commit("feat");
    expect(fileAtRef(r.dir, "origin/main", "a.txt")).toBe("a\n");
    expect(fileAtRef(r.dir, "HEAD", "a.txt")).toBe("değişti\n");
    expect(fileAtRef(r.dir, "origin/main", "yok.txt")).toBeNull();
  });

  it("mergeSubjects yalnızca ilk-ebeveyn birleştirme konularını verir", () => {
    const r = base();
    r.checkout("main").branch("int/dilim");
    r.branch("feat/T-002-y").write("y.txt", "y\n").commit("y").checkout("int/dilim");
    r.merge("feat/T-002-y", "Merge remote-tracking branch 'origin/feat/T-002-y' into int/dilim");
    r.write("z.txt", "z\n").commit("düz commit");
    expect(mergeSubjects(r.dir, mergeBase(r.dir))).toEqual([
      "Merge remote-tracking branch 'origin/feat/T-002-y' into int/dilim",
    ]);
  });

  it("parseNameStatusZ bozuk çıktıda hata verir", () => {
    expect(parseNameStatusZ("")).toEqual([]);
    expect(parseNameStatusZ("R100\0a\0b\0")).toEqual([{ status: "R", path: "b", oldPath: "a" }]);
    expect(() => parseNameStatusZ("Z\0a\0")).toThrow(GitError);
    expect(() => parseNameStatusZ("R100\0a\0")).toThrow(/eksik R/);
    expect(() => parseNameStatusZ("M\0")).toThrow(/eksik M/);
  });

  it("gitEnv depo konumu değişkenlerini siler, diğerlerini korur", () => {
    const env = gitEnv({ GIT_DIR: "/x", GIT_INDEX_FILE: "/y", GIT_WORK_TREE: "/z", PATH: "/bin", GIT_AUTHOR_NAME: "n" });
    expect(env).toEqual({ PATH: "/bin", GIT_AUTHOR_NAME: "n" });
  });
});
