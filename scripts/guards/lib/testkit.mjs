// Bekçi testleri için gerçek git deposu kurulumu (T-008a). Geçici dizinde `git init`;
// sahte git çıktısı yok. Ortamdaki genel/sistem git yapılandırması ve konum değişkenleri
// (GIT_DIR …) yalıtılır ki testler kullanıcı ayarlarından ve commit kancalarından etkilenmesin.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "./git.mjs";

/** @returns {NodeJS.ProcessEnv} */
function isolatedEnv() {
  return {
    ...gitEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: "testkit",
    GIT_AUTHOR_EMAIL: "testkit@example.invalid",
    GIT_COMMITTER_NAME: "testkit",
    GIT_COMMITTER_EMAIL: "testkit@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Geçici dizinde `main` dallı boş depo kurar.
 * @param {{ prefix?: string }} [opts]
 */
export function createRepo(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), opts.prefix ?? "guards-"));
  const env = isolatedEnv();

  /**
   * @param {...string} args
   * @returns {string}
   */
  function git(...args) {
    return execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  git("init", "--quiet", "--initial-branch=main");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", os.devNull);

  const repo = {
    dir,
    git,
    /**
     * Dosya yazar (dizinleri oluşturur).
     * @param {string} rel
     * @param {string} content
     */
    write(rel, content) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return repo;
    },
    /** @param {Record<string, string>} files */
    writeAll(files) {
      for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
      return repo;
    },
    /** @param {string} rel */
    remove(rel) {
      rmSync(path.join(dir, rel));
      return repo;
    },
    /**
     * `git mv` ile yeniden adlandırma (indekse alınır).
     * @param {string} from
     * @param {string} to
     */
    rename(from, to) {
      mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      git("mv", from, to);
      return repo;
    },
    /**
     * Çalışma ağacının tamamını commit'ler.
     * @param {string} message
     */
    commit(message) {
      git("add", "--all");
      git("commit", "--quiet", "--allow-empty", "-m", message);
      return repo;
    },
    /**
     * Dal oluşturur ve geçer (varsayılan: geçerli HEAD'den).
     * @param {string} name
     * @param {string} [from]
     */
    branch(name, from) {
      git("checkout", "--quiet", "-b", name, ...(from === undefined ? [] : [from]));
      return repo;
    },
    /** @param {string} name */
    checkout(name) {
      git("checkout", "--quiet", name);
      return repo;
    },
    /**
     * Geçerli dala `--no-ff` birleştirme; konu satırı verilebilir.
     * @param {string} name
     * @param {string} [message]
     */
    merge(name, message) {
      git("merge", "--quiet", "--no-ff", "-m", message ?? `Merge branch '${name}'`, name);
      return repo;
    },
    /**
     * `refs/remotes/origin/<ad>` ref'ini yerel dala eşitler (uzak depo gerektirmeden `origin/…`).
     * @param {string} name
     */
    publish(name) {
      git("update-ref", `refs/remotes/origin/${name}`, name);
      return repo;
    },
    /**
     * Dosyayı git'e haber vermeden taşır (izlenmeyen yeni yol + silinen eski yol).
     * @param {string} from
     * @param {string} to
     */
    moveUntracked(from, to) {
      mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      renameSync(path.join(dir, from), path.join(dir, to));
      return repo;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return repo;
}

/** @typedef {ReturnType<typeof createRepo>} TestRepo */
