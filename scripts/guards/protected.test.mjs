// T-008c `check:protected` testleri: korunan yol/içerik kuralları (`protected-paths.mjs`),
// GitHub istemcisi (`lib/github.mjs`, sahte `fetch` yalnızca burada), kipler ve fail-closed davranış.
// Fixture depolar `lib/testkit.mjs` ile geçici dizinde gerçek git ile kurulur.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.mjs";
import { APPROVAL_LINE, REASONS } from "./lib/approval.mjs";
import { API_VERSION, contextFromEnv, createGitHubClient, GitHubError, toPullInfo } from "./lib/github.mjs";
import { createReporter, UsageError } from "./lib/output.mjs";
import { createRepo } from "./lib/testkit.mjs";
import { checkProtected, parseProtectedArgs, WARN_LOCAL } from "./protected.mjs";
import {
  acceptedDecisionIds,
  adrAccepted,
  baselineLowered,
  classifyChanges,
  contentRules,
  npmrcConfigLines,
  poolerImages,
  staticRule,
  yamlConfigBlock,
} from "./protected-paths.mjs";

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const SEC0 = "security-reviewer: BLOCKER: 0 · MAJOR: 0 · MINOR: 1";
const OK_BODY = `Gerekçe.\n\n${APPROVAL_LINE}\n${SEC0}\n`;
const SHA_A = "a".repeat(40);

const COMPOSE = `services:
  postgres:
    image: postgres:17.11-trixie
  pgbouncer:
    image: edoburu/pgbouncer:v1.26.0-p0
    depends_on: [postgres]
  mailpit:
    image: axllent/mailpit:v1.31.4
`;

const ROOT_PKG = {
  name: "@x/root",
  scripts: { verify: "node scripts/verify.mjs", "check:protected": "node scripts/guards/cli.mjs protected", dev: "x" },
  dependencies: { "drizzle-orm": "0.45.0", zod: "4.0.0" },
  devDependencies: { vitest: "5.0.3" },
};

/** Korunan ve korunmayan dosyalar içeren `main`; origin/main yayımlı; çalışma dalı `feat/T-100-x`. */
function fixture() {
  const r = createRepo({ prefix: "guards-protected-" });
  cleanups.push(() => r.cleanup());
  r.writeAll({
    ".gitignore": ".artifacts/\n",
    "package.json": JSON.stringify(ROOT_PKG, null, 2) + "\n",
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { pg: "8.0.0" } }, null, 2) + "\n",
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\nauditConfig:\n  ignoreCves:\n    - CVE-2020-0001\n',
    ".npmrc": "audit-level=high\nsave-exact=true\n",
    "docker-compose.yml": COMPOSE,
    "docs/INVARIANTS.md": "# I\n",
    "docs/DECISIONS.md": "ADR-001 | 2026-10-05 | a | kabul\nADR-002 | 2026-10-05 | b | önerildi\n",
    "docs/adr/ADR-002.md": "# ADR-002\n\n**Tarih / Durum:** 2026-10-05 · **önerildi**\n",
    "tests/.ac-baseline.json": JSON.stringify({ "AC-01": 2, "AC-43": 3 }) + "\n",
    "db/migrations/0001_init.sql": "create table a();\n",
    "scripts/guards/x.mjs": "export {};\n",
    "src/a.mjs": "a\n",
  });
  r.commit("init").publish("main");
  r.branch("feat/T-100-x");
  return r;
}

/**
 * @typedef {import("./lib/github.mjs").PullInfo} PullInfo
 * @typedef {import("./lib/github.mjs").GitHubClient} GitHubClient
 */

/**
 * Sahte istemci (yalnızca test).
 * @param {{ pulls?: PullInfo[], commitPulls?: Record<string, PullInfo[]>, fail?: boolean }} opts
 */
function fakeClient(opts) {
  /** @type {string[]} */
  const calls = [];
  /** @type {GitHubClient} */
  const client = {
    async getPull(n) {
      calls.push(`pull:${n}`);
      if (opts.fail) throw new GitHubError("HTTP 503");
      const p = (opts.pulls ?? []).find((x) => x.number === n);
      if (p === undefined) throw new GitHubError("HTTP 404");
      return p;
    },
    async pullsForCommit(sha) {
      calls.push(`commit:${sha}`);
      if (opts.fail) throw new GitHubError("HTTP 503");
      return opts.commitPulls?.[sha] ?? [];
    },
  };
  return { client, calls };
}

/**
 * @param {Partial<PullInfo> & { headSha: string }} p
 * @returns {PullInfo}
 */
function pull(p) {
  return { number: 7, state: "open", body: OK_BODY, baseRef: "main", mergedAt: null, ...p };
}

/**
 * @param {Record<string, unknown>} payload
 */
function eventFile(payload) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "guards-event-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, "event.json");
  writeFileSync(f, JSON.stringify(payload));
  return f;
}

/**
 * @param {import("./lib/testkit.mjs").TestRepo} r
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv, client?: GitHubClient }} [o]
 */
async function check(r, o = {}) {
  /** @type {string[]} */
  const lines = [];
  const out = createReporter("protected", { root: r.dir, log: (l) => lines.push(l) });
  await checkProtected({
    root: r.dir,
    argv: o.argv ?? [],
    out,
    env: o.env ?? {},
    createClient: () => {
      if (o.client === undefined) throw new GitHubError("GITHUB_TOKEN yok");
      return o.client;
    },
  });
  const code = out.finish();
  return { code, lines, text: lines.join("\n") };
}

/**
 * @param {import("./lib/testkit.mjs").TestRepo} r
 * @param {number} [n]
 */
function prEnv(r, n = 7) {
  return {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventFile({ number: n, pull_request: { number: n, head: { sha: r.git("rev-parse", "HEAD").trim() } } }),
    GITHUB_BASE_REF: "main",
  };
}

/** @param {import("./lib/testkit.mjs").TestRepo} r */
function head(r) {
  return r.git("rev-parse", "HEAD").trim();
}

describe("protected-paths: yol kuralları", () => {
  it.each([
    "docs/INVARIANTS.md",
    "docs/ACCEPTANCE.md",
    "docs/ACCEPTANCE.conditions.json",
    "docs/spec/16-stock-effects.md",
    "packages/db/src/locking.ts",
    "packages/db/src/locking.mjs",
    ".github/workflows/ci.yml",
    ".github/CODEOWNERS",
    "eslint.config.mjs",
    "apps/web/eslint.config.mjs",
    "tsconfig.json",
    "apps/worker/tsconfig.build.json",
    "vitest.config.ts",
    "vitest.int.config.ts",
    "apps/web/playwright.config.ts",
    "scripts/verify.mjs",
    "scripts/check-docs.mjs",
    "scripts/guards/protected.mjs",
    "scripts/guards/lib/new-helper.mjs",
    "scripts/test-ac/run.mjs",
    "scripts/lib/pilot.mjs",
    ".githooks/pre-commit",
    "tests/QUARANTINE.md",
    ".pnpmfile.cjs",
    "apps/web/.pnpmfile.mjs",
  ])("%s korunur", (p) => {
    expect(staticRule(p)).not.toBeNull();
  });

  it.each(["src/a.mjs", "docs/STATE.md", "docs/tasks/T-100.md", "scripts/compose-smoke.mjs", "apps/web/app/page.tsx", "tests/.ac-baseline.json"])(
    "%s yol kuralıyla korunmaz",
    (p) => {
      expect(staticRule(p)).toBeNull();
    },
  );
});

describe("protected-paths: içerik kuralları", () => {
  it("AC tabanı: artış/ekleme serbest; düşüş, kaldırma, silme, bozuk JSON korunur; ilk oluşturma serbest", () => {
    const b = JSON.stringify({ "AC-01": 2, "AC-43": 3 });
    expect(baselineLowered(b, JSON.stringify({ "AC-01": 3, "AC-43": 3, "AC-44": 1 }))).toBeNull();
    expect(baselineLowered(b, JSON.stringify({ "AC-01": 1, "AC-43": 3 }))).toContain("AC-01: 2 → 1");
    expect(baselineLowered(b, JSON.stringify({ "AC-43": 3 }))).toContain("AC-01: 2 → yok");
    expect(baselineLowered(b, null)).toContain("silindi");
    expect(baselineLowered(b, "{bozuk")).toContain("ayrıştırılamadı");
    expect(baselineLowered("{bozuk", b)).toContain("ayrıştırılamadı");
    expect(baselineLowered(null, b)).toBeNull();
    // İç içe biçim de (T-008d biçimi henüz yok): tüm sayısal yapraklar.
    expect(baselineLowered(JSON.stringify({ counts: { "AC-01": 2 } }), JSON.stringify({ counts: { "AC-01": 1 } }))).toContain(
      "counts.AC-01",
    );
  });

  it('ADR: durum "kabul"e geçerse korunur; zaten kabul olanın düzenlenmesi serbest', () => {
    const onerildi = "# A\n**Tarih / Durum:** 2026-10-05 · **önerildi**\n";
    const kabul = "# A\n**Tarih / Durum:** 2026-10-05 · **kabul** (ADR-012 rev.)\n";
    expect(adrAccepted(onerildi)).toBe(false);
    expect(adrAccepted(kabul)).toBe(true);
    expect(adrAccepted("# A\n**Tarih / Durum:** · **kabul edilmedi**? hayır: reddedildi\n")).toBe(true); // belirsizde korunur
    expect(contentRules("docs/adr/ADR-020.md", onerildi, kabul).map((h) => h.rule)).toEqual(["adr-accepted"]);
    expect(contentRules("docs/adr/ADR-020.md", null, kabul).map((h) => h.rule)).toEqual(["adr-accepted"]);
    expect(contentRules("docs/adr/ADR-020.md", kabul, kabul + "ek\n")).toEqual([]);
    expect(contentRules("docs/adr/ADR-020.md", null, onerildi)).toEqual([]);
    expect(contentRules("docs/adr/_TEMPLATE.md", null, kabul)).toEqual([]);
  });

  it('DECISIONS.md: yeni "kabul" satırı korunur; önerildi satırı serbest', () => {
    const b = "ADR-001 | t | a | kabul\nADR-002 | t | b | önerildi\n";
    expect([...acceptedDecisionIds(b)]).toEqual(["ADR-001"]);
    expect(contentRules("docs/DECISIONS.md", b, b.replace("önerildi", "kabul (koşullu)"))[0]?.reason).toContain("ADR-002");
    expect(contentRules("docs/DECISIONS.md", b, b + "ADR-003 | t | c | önerildi\n")).toEqual([]);
    expect(contentRules("docs/DECISIONS.md", b, b + "ADR-003 | t | c | kabul\n")[0]?.reason).toContain("ADR-003");
  });

  it("kök package.json: ORM/sürücü sürümü ve bekçi betikleri korunur; diğer alanlar serbest", () => {
    const b = JSON.stringify(ROOT_PKG);
    /** @param {(p: any) => void} f */
    const after = (f) => {
      const p = structuredClone(ROOT_PKG);
      f(p);
      return JSON.stringify(p);
    };
    expect(contentRules("package.json", b, after((p) => (p.dependencies.zod = "4.1.0")))).toEqual([]);
    expect(contentRules("package.json", b, after((p) => (p.scripts.dev = "y")))).toEqual([]);
    expect(contentRules("package.json", b, after((p) => (p.dependencies["drizzle-orm"] = "0.46.0")))[0]?.reason).toContain(
      "dependencies.drizzle-orm",
    );
    expect(contentRules("package.json", b, after((p) => (p.devDependencies.pg = "8.1.0")))[0]?.reason).toContain(
      "devDependencies.pg",
    );
    expect(contentRules("package.json", b, after((p) => (p.scripts["check:protected"] = "true")))[0]?.reason).toContain(
      "scripts.check:protected",
    );
    expect(contentRules("package.json", b, after((p) => delete p.scripts.verify))[0]?.reason).toContain("scripts.verify");
    expect(contentRules("package.json", b, after((p) => (p.pnpm = { auditConfig: { ignoreCves: ["CVE-1"] } })))[0]?.reason).toContain(
      "pnpm.auditConfig",
    );
    expect(contentRules("package.json", b, "{bozuk")[0]?.reason).toContain("ayrıştırılamadı");
  });

  it("tüm package.json'lar: auditConfig, overrides, resolutions, configDependencies (üst düzey ve pnpm.) korunur", () => {
    const b = JSON.stringify({ name: "web", dependencies: { pg: "8.0.0" } });
    /** @param {Record<string, unknown>} extra */
    const after = (extra) => JSON.stringify({ name: "web", dependencies: { pg: "8.0.0" }, ...extra });
    // Alt pakette sürüm alanı kök kuralıdır, burada serbest.
    expect(contentRules("apps/web/package.json", b, JSON.stringify({ name: "web", dependencies: { pg: "8.1.0" } }))).toEqual([]);
    /** @type {Array<[Record<string, unknown>, string]>} */
    const cases = [
      [{ pnpm: { auditConfig: { ignoreCves: [] } } }, "pnpm.auditConfig"],
      [{ auditConfig: {} }, "auditConfig"],
      [{ overrides: { lodash: "4.0.0" } }, "overrides"],
      [{ pnpm: { overrides: { "foo>bar": "1.0.0" } } }, "pnpm.overrides"],
      [{ resolutions: { lodash: "4.0.0" } }, "resolutions"],
      [{ configDependencies: { x: "1.0.0+sha512-abc" } }, "configDependencies"],
      [{ pnpm: { configDependencies: { x: "1" } } }, "pnpm.configDependencies"],
    ];
    for (const [extra, field] of cases) {
      for (const file of ["apps/web/package.json", "package.json"]) {
        const h = contentRules(file, b, after(extra));
        expect(h[0]?.rule, `${file} ${field}`).toBe("package-json");
        expect(h[0]?.reason, `${file} ${field}`).toContain(field);
      }
    }
  });

  it("pnpm-workspace.yaml: auditConfig/overrides/configDependencies/pnpmfile blokları korunur, diğer anahtarlar serbest", () => {
    const b = 'packages:\n  - "apps/*"\nauditConfig:\n  ignoreCves:\n    - CVE-1\n';
    expect(yamlConfigBlock(b)).toBe("auditConfig:\n  ignoreCves:\n    - CVE-1");
    expect(contentRules("pnpm-workspace.yaml", b, b.replace('"apps/*"', '"apps/*"\n  - "packages/*"'))).toEqual([]);
    expect(contentRules("pnpm-workspace.yaml", b, b + "    - CVE-2\n")[0]?.rule).toBe("pm-config");
    expect(contentRules("pnpm-workspace.yaml", null, "auditConfig: {ignoreCves: [CVE-9]}\n")[0]?.rule).toBe("pm-config");
    for (const add of [
      "overrides:\n  lodash: 4.0.0\n",
      "configDependencies:\n  x: 1.0.0+sha512-abc\n",
      "pnpmfile: hooks/x.cjs\n",
      "globalPnpmfile: /tmp/x.cjs\n",
    ]) {
      expect(contentRules("pnpm-workspace.yaml", b, b + add)[0]?.rule, add).toBe("pm-config");
    }
    const o = b + "overrides:\n  lodash: 4.0.0\n";
    expect(contentRules("pnpm-workspace.yaml", o, o.replace("4.0.0", "4.0.1"))[0]?.rule).toBe("pm-config");
  });

  it(".npmrc: audit/pnpmfile/override anahtarları korunur, diğerleri serbest", () => {
    expect(npmrcConfigLines("# audit=false\naudit-level = high\nsave-exact=true\n")).toBe("audit-level=high");
    expect(contentRules(".npmrc", "audit-level=high\n", "audit-level=high\nsave-exact=false\n")).toEqual([]);
    expect(contentRules(".npmrc", "audit-level=high\n", "audit-level=critical\n")[0]?.rule).toBe("pm-config");
    expect(contentRules("apps/web/.npmrc", null, "audit=false\n")[0]?.rule).toBe("pm-config");
    expect(contentRules(".npmrc", null, "global-pnpmfile=/tmp/x.cjs\n")[0]?.rule).toBe("pm-config");
    expect(contentRules(".npmrc", null, "pnpmfile=x.cjs\n")[0]?.rule).toBe("pm-config");
  });

  it("compose: pooler imaj etiketi korunur, diğer imajlar serbest", () => {
    expect(poolerImages(COMPOSE)).toBe("pgbouncer=edoburu/pgbouncer:v1.26.0-p0");
    expect(contentRules("docker-compose.yml", COMPOSE, COMPOSE.replace("mailpit:v1.31.4", "mailpit:v1.32.0"))).toEqual([]);
    expect(contentRules("docker-compose.yml", COMPOSE, COMPOSE.replace("v1.26.0-p0", "v1.27.0"))[0]?.rule).toBe("pooler-image");
    // Servis adı aynı, imaj başka adla değişirse de yakalanır.
    expect(contentRules("docker-compose.yml", COMPOSE, COMPOSE.replace("edoburu/pgbouncer:v1.26.0-p0", "evil/pool:latest"))[0]?.rule).toBe(
      "pooler-image",
    );
  });

  it("migration: tabanda var olanın değişmesi/silinmesi/taşınması korunur; yeni migration serbest", () => {
    const before = (/** @type {string} */ f) => (f === "db/migrations/0001.sql" ? "a" : null);
    /** @param {string | null} v */
    const after = (v) => (/** @type {string} */ f) => (f === "db/migrations/0001.sql" ? v : null);
    expect(classifyChanges([{ status: "A", path: "db/migrations/0002.sql" }], { before, after: after("a") })).toEqual([]);
    expect(classifyChanges([{ status: "?", path: "db/migrations/0002.sql" }], { before, after: after("a") })).toEqual([]);
    expect(classifyChanges([{ status: "M", path: "db/migrations/0001.sql" }], { before, after: after("b") })[0]?.rule).toBe("migration");
    expect(classifyChanges([{ status: "D", path: "db/migrations/0001.sql" }], { before, after: after(null) })[0]?.rule).toBe("migration");
    expect(
      classifyChanges([{ status: "R", path: "db/migrations/0009.sql", oldPath: "db/migrations/0001.sql" }], {
        before,
        after: after(null),
      })[0]?.path,
    ).toBe("db/migrations/0001.sql");
  });

  it("ad değişikliği: korunan yoldan çıkarma da korunur", () => {
    const hits = classifyChanges([{ status: "R", path: "tmp/x.mjs", oldPath: "scripts/guards/x.mjs" }], {
      before: () => "x",
      after: () => "x",
    });
    expect(hits.map((h) => h.path)).toEqual(["scripts/guards/x.mjs"]);
  });
});

describe("lib/github.mjs", () => {
  const PR_JSON = { number: 7, state: "open", body: "b", head: { sha: SHA_A, ref: "feat/x" }, base: { ref: "main" }, merged_at: null };

  /**
   * @param {Array<{ status: number, json: unknown }>} responses
   */
  function fakeFetch(responses) {
    /** @type {Array<{ url: string, headers: Record<string, string> }>} */
    const calls = [];
    /** @type {import("./lib/github.mjs").FetchLike} */
    const fetchImpl = async (url, init) => {
      calls.push({ url, headers: init.headers });
      const r = responses.shift();
      if (r === undefined) throw new Error("bağlantı reddedildi");
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
    };
    return { fetchImpl, calls };
  }

  it("getPull: URL, başlıklar (Bearer, API sürümü) ve alanlar", async () => {
    const f = fakeFetch([{ status: 200, json: PR_JSON }]);
    const c = createGitHubClient({ token: "t0k", repository: "own/rep", fetchImpl: f.fetchImpl });
    expect(await c.getPull(7)).toEqual({ number: 7, state: "open", body: "b", headSha: SHA_A, baseRef: "main", mergedAt: null });
    expect(f.calls[0]?.url).toBe("https://api.github.com/repos/own/rep/pulls/7");
    expect(f.calls[0]?.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer t0k",
      "X-GitHub-Api-Version": API_VERSION,
    });
  });

  it("pullsForCommit: commits/{sha}/pulls", async () => {
    const f = fakeFetch([{ status: 200, json: [{ ...PR_JSON, merged_at: "2026-10-05T10:00:00Z", body: null }] }]);
    const c = createGitHubClient({ token: "t", repository: "o/r", apiUrl: "https://ghe.example.invalid/api/v3/", fetchImpl: f.fetchImpl });
    const ps = await c.pullsForCommit(SHA_A);
    expect(ps[0]?.mergedAt).toBe("2026-10-05T10:00:00Z");
    expect(ps[0]?.body).toBeNull();
    expect(f.calls[0]?.url).toBe(`https://ghe.example.invalid/api/v3/repos/o/r/commits/${SHA_A}/pulls?per_page=100`);
  });

  it("HTTP hatası, ağ hatası, JSON dışı, beklenmeyen biçim → GitHubError (token mesajda yok)", async () => {
    const c1 = createGitHubClient({ token: "gizli-token", repository: "o/r", fetchImpl: fakeFetch([{ status: 401, json: {} }]).fetchImpl });
    await expect(c1.getPull(7)).rejects.toThrow(/HTTP 401/);
    await expect(c1.getPull(7)).rejects.not.toThrow(/gizli-token/);
    const c2 = createGitHubClient({ token: "t", repository: "o/r", fetchImpl: fakeFetch([]).fetchImpl });
    await expect(c2.getPull(7)).rejects.toThrow(GitHubError);
    /** @type {import("./lib/github.mjs").FetchLike} */
    const notJson = async () => ({ ok: true, status: 200, json: async () => JSON.parse("<html>") });
    await expect(createGitHubClient({ token: "t", repository: "o/r", fetchImpl: notJson }).getPull(7)).rejects.toThrow(/JSON değil/);
    const c3 = createGitHubClient({ token: "t", repository: "o/r", fetchImpl: fakeFetch([{ status: 200, json: { ...PR_JSON, body: 5 } }]).fetchImpl });
    await expect(c3.getPull(7)).rejects.toThrow(/body/);
    const c4 = createGitHubClient({ token: "t", repository: "o/r", fetchImpl: fakeFetch([{ status: 200, json: {} }]).fetchImpl });
    await expect(c4.pullsForCommit(SHA_A)).rejects.toThrow(/dizi değil/);
  });

  it("geçersiz yapılandırma reddedilir", () => {
    expect(() => createGitHubClient({ token: "", repository: "o/r" })).toThrow(GitHubError);
    expect(() => createGitHubClient({ token: "t", repository: "o/r/../x" })).toThrow(GitHubError);
    expect(() => createGitHubClient({ token: "t", repository: "o/r", apiUrl: "http://api.github.com" })).toThrow(/https/);
    expect(() => toPullInfo({ ...PR_JSON, head: { sha: "kısa" } })).toThrow(/head.sha/);
  });

  it("contextFromEnv: pull_request, push, diğer olaylar, eksik yük", () => {
    const read = (/** @type {string} */ f) => {
      if (f === "pr.json") return JSON.stringify({ number: 12, pull_request: { number: 12, head: { sha: SHA_A } } });
      if (f === "push.json") return JSON.stringify({ before: "b".repeat(40) });
      throw new Error("yok");
    };
    expect(contextFromEnv({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "pr.json" }, read)).toEqual({
      kind: "pr",
      number: 12,
      eventHeadSha: SHA_A,
    });
    expect(
      contextFromEnv({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: "push.json", GITHUB_SHA: SHA_A, GITHUB_REF_NAME: "main" }, read),
    ).toEqual({ kind: "push", sha: SHA_A, branch: "main", before: "b".repeat(40) });
    expect(contextFromEnv({}, read).kind).toBe("none");
    expect(contextFromEnv({ GITHUB_EVENT_NAME: "workflow_dispatch" }, read).kind).toBe("none");
    expect(contextFromEnv({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "yok.json" }, read).kind).toBe("none");
    expect(contextFromEnv({ GITHUB_EVENT_NAME: "pull_request" }, read).kind).toBe("none");
  });
});

describe("parseProtectedArgs", () => {
  it("argümanlar", () => {
    expect(parseProtectedArgs([])).toEqual({ local: false, base: null, pr: null });
    expect(parseProtectedArgs(["--", "--local", "--base=origin/x"])).toEqual({ local: true, base: "origin/x", pr: null });
    expect(parseProtectedArgs(["--pr", "12"])).toEqual({ local: false, base: null, pr: 12 });
    expect(() => parseProtectedArgs(["--pr", "0"])).toThrow(UsageError);
    expect(() => parseProtectedArgs(["--pr", "1", "--local"])).toThrow(UsageError);
    expect(() => parseProtectedArgs(["--x"])).toThrow(UsageError);
    expect(() => parseProtectedArgs(["--base"])).toThrow(UsageError);
  });
});

describe("check:protected", () => {
  it("korunan değişiklik yoksa API'ye gitmeden OK", async () => {
    const r = fixture();
    r.write("src/a.mjs", "b\n").commit("x");
    const res = await check(r);
    expect(res.code).toBe(0);
    expect(res.text).toContain("check:protected OK");
  });

  it("--local: korunan değişiklik yalnızca uyarı, çıkış 0; API çağrılmaz", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n");
    const { client, calls } = fakeClient({});
    const res = await check(r, { argv: ["--local"], client });
    expect(res.code).toBe(0);
    expect(res.text).toContain(`WARN ${WARN_LOCAL} docs/INVARIANTS.md`);
    expect(calls).toEqual([]);
  });

  it("bağlam yok (CI dışı, --pr yok) + korunan değişiklik → APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write("scripts/guards/x.mjs", "export const x = 1;\n").commit("x");
    const res = await check(r);
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} scripts/guards/x.mjs`);
  });

  it("PR: onaylı açıklama → OK; açıklama sonradan bozulursa → FAIL", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const ok = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: head(r) })] }).client });
    expect(ok.code).toBe(0);
    const bad = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: head(r), body: "düzenlendi" })] }).client });
    expect(bad.code).toBe(1);
    expect(bad.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
  });

  it("PR: head SHA denetlenen commit değilse → APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const res = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: SHA_A })] }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} docs/INVARIANTS.md`);
  });

  it("PR: refs/pull/N/merge (HEAD^2 = PR head) kabul", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const prHead = head(r);
    r.checkout("main").branch("pr-merge").merge("feat/T-100-x", "Merge pr");
    const res = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: prHead })] }).client });
    expect(res.code).toBe(0);
  });

  it("PR: API hatası → APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const res = await check(r, { env: prEnv(r), client: fakeClient({ fail: true }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} docs/INVARIANTS.md`);
    expect(res.text).toContain("HTTP 503");
  });

  it("--pr: taban PR'ın base.ref'inden (origin/<ref>)", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const { client, calls } = fakeClient({ pulls: [pull({ number: 9, headSha: head(r) })] });
    const res = await check(r, { argv: ["--pr", "9"], client });
    expect(res.code).toBe(0);
    expect(calls).toEqual(["pull:9"]);
  });

  it("push (main): commit'i getiren birleşmiş PR'ın açıklaması okunur", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    r.checkout("main").merge("feat/T-100-x", "Merge pull request #7");
    const sha = head(r);
    const parent = r.git("rev-parse", "HEAD^1").trim();
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: eventFile({ before: parent }),
      GITHUB_SHA: sha,
      GITHUB_REF_NAME: "main",
    };
    const merged = pull({ headSha: SHA_A, mergedAt: "2026-10-05T10:00:00Z" });
    const other = pull({ number: 8, headSha: SHA_A, baseRef: "int/x", mergedAt: "2026-10-05T09:00:00Z", body: "" });
    expect((await check(r, { env, client: fakeClient({ commitPulls: { [sha]: [other, merged] } }).client })).code).toBe(0);

    const none = await check(r, { env, client: fakeClient({ commitPulls: { [sha]: [other] } }).client });
    expect(none.code).toBe(1);
    expect(none.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} docs/INVARIANTS.md`);

    const unmerged = await check(r, { env, client: fakeClient({ commitPulls: { [sha]: [pull({ headSha: SHA_A })] } }).client });
    expect(unmerged.code).toBe(1);

    const bad = await check(r, {
      env,
      client: fakeClient({ commitPulls: { [sha]: [pull({ headSha: SHA_A, mergedAt: "2026-10-05T10:00:00Z", body: "yok" })] } }).client,
    });
    expect(bad.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
  });

  it("push: before ≠ HEAD^1 (birden fazla birleştirme) → APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    r.checkout("main").merge("feat/T-100-x", "Merge pull request #7");
    const sha = head(r);
    const env = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventFile({ before: SHA_A }), GITHUB_SHA: sha, GITHUB_REF_NAME: "main" };
    const merged = pull({ headSha: SHA_A, mergedAt: "2026-10-05T10:00:00Z" });
    const res = await check(r, { env, client: fakeClient({ commitPulls: { [sha]: [merged] } }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(REASONS.UNVERIFIABLE);
  });

  it("çalışma ağacı ve izlenmeyen dosyalar da sayılır; yeni korunan dosya (ilk oluşturma) korunur", async () => {
    const r = fixture();
    r.write(".github/workflows/ci.yml", "on: push\n");
    const res = await check(r);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} .github/workflows/ci.yml`);
  });

  it("CLI üzerinden: --local uyarı + OK; bilinmeyen argüman çıkış 2", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n");
    /** @type {string[]} */
    const lines = [];
    expect(await main(["protected", "--local"], { root: r.dir, log: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain(WARN_LOCAL);
    expect(await main(["protected", "--nope"], { root: r.dir, log: () => {} })).toBe(2);
  });
});
