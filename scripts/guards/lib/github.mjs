// GitHub REST istemcisi (T-008c). Yeni bağımlılık yok: Node 24 yerleşik `fetch`.
// Kullanılan uç noktalar ve alanlar (docs.github.com/en/rest; API sürümü 2022-11-28):
//   GET /repos/{owner}/{repo}/pulls/{pull_number}       → number, state, body, head.sha, base.ref, merged_at
//   GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls → aynı alanlar ("Pull Request Simple" dizisi;
//       varsayılan dalda bulunan commit için onu getiren birleşmiş PR)
//   Başlıklar: Accept: application/vnd.github+json, Authorization: Bearer <token>, X-GitHub-Api-Version.
// `merge_commit_sha` kullanılmaz (API 2026-03-10 sürümünde kaldırıldı).
// Ortam (GitHub Actions varsayılan değişkenleri): GITHUB_REPOSITORY, GITHUB_API_URL,
// GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA, GITHUB_REF_NAME; GITHUB_TOKEN iş akışından verilir.
// Arayüz enjekte edilebilir (`fetchImpl`); test çifti yalnızca testlerde (G-07).
import { readFileSync } from "node:fs";

export const API_VERSION = "2022-11-28";
export const DEFAULT_API_URL = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GitHubError";
  }
}

/**
 * @typedef {{ number: number, state: string, body: string | null, headSha: string, baseRef: string, mergedAt: string | null }} PullInfo
 * @typedef {{ getPull: (n: number) => Promise<PullInfo>, pullsForCommit: (sha: string) => Promise<PullInfo[]> }} GitHubClient
 * @typedef {(input: string, init: { method: string, headers: Record<string, string>, signal: AbortSignal }) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>} FetchLike
 */

/**
 * API yanıtındaki PR nesnesini doğrular ve daraltır. Beklenmeyen biçim = hata (fail-closed).
 * @param {unknown} v
 * @returns {PullInfo}
 */
export function toPullInfo(v) {
  const o = /** @type {Record<string, unknown>} */ (v !== null && typeof v === "object" ? v : {});
  const head = /** @type {Record<string, unknown>} */ (o["head"] ?? {});
  const base = /** @type {Record<string, unknown>} */ (o["base"] ?? {});
  const number = o["number"];
  const state = o["state"];
  const body = o["body"];
  const headSha = head["sha"];
  const baseRef = base["ref"];
  const mergedAt = o["merged_at"];
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) throw new GitHubError("PR yanıtında geçersiz `number`");
  if (typeof state !== "string") throw new GitHubError("PR yanıtında geçersiz `state`");
  if (body !== null && typeof body !== "string") throw new GitHubError("PR yanıtında geçersiz `body`");
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) throw new GitHubError("PR yanıtında geçersiz `head.sha`");
  if (typeof baseRef !== "string" || baseRef === "") throw new GitHubError("PR yanıtında geçersiz `base.ref`");
  if (mergedAt !== null && mergedAt !== undefined && typeof mergedAt !== "string") {
    throw new GitHubError("PR yanıtında geçersiz `merged_at`");
  }
  return { number, state, body, headSha, baseRef, mergedAt: typeof mergedAt === "string" ? mergedAt : null };
}

/**
 * @param {{ token: string, repository: string, apiUrl?: string, fetchImpl?: FetchLike }} opts
 * @returns {GitHubClient}
 */
export function createGitHubClient(opts) {
  if (opts.token === "") throw new GitHubError("GITHUB_TOKEN boş");
  if (!REPO_RE.test(opts.repository)) throw new GitHubError(`GITHUB_REPOSITORY geçersiz: "${opts.repository}"`);
  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(apiUrl)) throw new GitHubError(`GITHUB_API_URL https değil: "${apiUrl}"`);
  const fetchImpl = opts.fetchImpl ?? /** @type {FetchLike} */ (/** @type {unknown} */ (globalThis.fetch));
  const [owner, repo] = /** @type {[string, string]} */ (opts.repository.split("/"));
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  /**
   * @param {string} p
   * @returns {Promise<unknown>}
   */
  async function get(p) {
    const url = `${apiUrl}${repoPath}${p}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${opts.token}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "etkin-wms-check-protected",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new GitHubError(`GET ${repoPath}${p}: ağ hatası (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!res.ok) throw new GitHubError(`GET ${repoPath}${p}: HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new GitHubError(`GET ${repoPath}${p}: yanıt JSON değil`);
    }
  }

  return {
    async getPull(n) {
      if (!Number.isInteger(n) || n <= 0) throw new GitHubError(`geçersiz PR numarası: ${n}`);
      return toPullInfo(await get(`/pulls/${n}`));
    },
    async pullsForCommit(sha) {
      if (!SHA_RE.test(sha)) throw new GitHubError(`geçersiz commit: "${sha}"`);
      const v = await get(`/commits/${sha}/pulls?per_page=100`);
      if (!Array.isArray(v)) throw new GitHubError("commits/{sha}/pulls yanıtı dizi değil");
      return v.map(toPullInfo);
    },
  };
}

/**
 * @typedef {{ kind: "pr", number: number, eventHeadSha: string | null }
 *   | { kind: "push", sha: string, branch: string, before: string | null }
 *   | { kind: "none", reason: string }} CiContext
 */

/**
 * GitHub Actions ortamından PR/push bağlamı. `pull_request`/`pull_request_target` → PR numarası
 * olay yükünden (`number`, `pull_request.number`); `push` → `GITHUB_SHA` + dal; diğerleri → yok.
 * @param {NodeJS.ProcessEnv} env
 * @param {(file: string) => string} [readFile]
 * @returns {CiContext}
 */
export function contextFromEnv(env, readFile = (f) => readFileSync(f, "utf8")) {
  const event = env["GITHUB_EVENT_NAME"] ?? "";
  if (event === "") return { kind: "none", reason: "GITHUB_EVENT_NAME yok (GitHub Actions dışında; --pr verin)" };
  /** @type {Record<string, unknown>} */
  let payload = {};
  const p = env["GITHUB_EVENT_PATH"];
  if (p !== undefined && p !== "") {
    try {
      const v = JSON.parse(readFile(p));
      if (v !== null && typeof v === "object") payload = /** @type {Record<string, unknown>} */ (v);
    } catch (e) {
      return { kind: "none", reason: `olay yükü okunamadı (${e instanceof Error ? e.message : String(e)})` };
    }
  }
  if (event === "pull_request" || event === "pull_request_target") {
    const pr = /** @type {Record<string, unknown>} */ (payload["pull_request"] ?? {});
    const n = payload["number"] ?? pr["number"];
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return { kind: "none", reason: "olay yükünde PR numarası yok" };
    const head = /** @type {Record<string, unknown>} */ (pr["head"] ?? {});
    const sha = head["sha"];
    return { kind: "pr", number: n, eventHeadSha: typeof sha === "string" && SHA_RE.test(sha) ? sha : null };
  }
  if (event === "push") {
    const sha = env["GITHUB_SHA"] ?? "";
    const branch = env["GITHUB_REF_NAME"] ?? "";
    if (!SHA_RE.test(sha)) return { kind: "none", reason: "push olayında GITHUB_SHA yok/geçersiz" };
    if (branch === "") return { kind: "none", reason: "push olayında GITHUB_REF_NAME yok" };
    const before = payload["before"];
    return {
      kind: "push",
      sha,
      branch,
      before: typeof before === "string" && SHA_RE.test(before) && !/^0+$/.test(before) ? before : null,
    };
  }
  return { kind: "none", reason: `"${event}" olayında PR bağlamı yok` };
}
