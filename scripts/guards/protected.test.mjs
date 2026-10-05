// T-008c/T-008h `check:protected` testleri: korunan yol/içerik kuralları (`protected-paths.mjs`),
// GitHub istemcisi (`lib/github.mjs`, sahte `fetch` yalnızca burada), kipler ve fail-closed davranış.
// Fixture depolar `lib/testkit.mjs` ile geçici dizinde gerçek git ile kurulur. "… saldırısı" adlı
// testler security-reviewer'ın (int/faz0-bekciler-1) denediği atlatmanın kendisidir (T-008h).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.mjs";
import { approvalLine, REASONS, securityLine } from "./lib/approval.mjs";
import { gitEnv } from "./lib/git.mjs";
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
  FlowMap,
  FlowSeq,
  flowSeq,
  globToRegExp,
  isLockAlias,
  LockfileError,
  lockfileGuarded,
  parseFlow,
  parseLockYaml,
  matchesGlob,
  poolerImages,
  staticRule,
} from "./protected-paths.mjs";

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** @param {string} sha raporun incelediği commit (T-008i MINOR 8) */
const SEC0 = (sha) => securityLine({ blocker: 0, major: 0, minor: 1 }, sha);
/** @param {string} sha PR head SHA'sı */
const okBody = (sha) => `Gerekçe.\n\n${approvalLine(sha)}\n${SEC0(sha)}\n`;
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

/** pnpm-lock v9 örneği: vitest → chai → loupe kapanışı; zod/tslib kapanış dışı. */
const LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "settings:",
  "  autoInstallPeers: true",
  "",
  "importers:",
  "",
  "  .:",
  "    dependencies:",
  "      zod:",
  "        specifier: 4.0.0",
  "        version: 4.0.0",
  "    devDependencies:",
  "      vitest:",
  "        specifier: 5.0.3",
  "        version: 5.0.3",
  "",
  "  apps/worker: {}",
  "",
  "packages:",
  "",
  "  '@vitest/runner@5.0.3':",
  "    resolution: {integrity: sha512-AAA}",
  "",
  "  chai@6.3.0:",
  "    resolution: {integrity: sha512-CHAI}",
  "    engines: {node: ^22.12.0 || >=24.0.0}",
  "",
  "  loupe@3.2.1:",
  "    resolution: {integrity: sha512-LOUPE}",
  "",
  "  tslib@2.8.1:",
  "    resolution: {integrity: sha512-TSLIB}",
  "",
  "  vitest@5.0.3:",
  "    resolution: {integrity: sha512-BBB}",
  "    engines: {node: '>=22'}",
  "    hasBin: true",
  "    peerDependencies:",
  "      '@types/node': '*'",
  "    peerDependenciesMeta:",
  "      '@types/node':",
  "        optional: true",
  "",
  "  zod@4.0.0:",
  "    resolution: {integrity: sha512-ZZZ}",
  "",
  "snapshots:",
  "",
  "  '@vitest/runner@5.0.3': {}",
  "",
  "  chai@6.3.0:",
  "    dependencies:",
  "      loupe: 3.2.1",
  "",
  "  loupe@3.2.1: {}",
  "",
  "  tslib@2.8.1: {}",
  "",
  "  vitest@5.0.3:",
  "    dependencies:",
  "      chai: 6.3.0",
  "    transitivePeerDependencies:",
  "      - supports-color",
  "",
  "  zod@4.0.0:",
  "    dependencies:",
  "      tslib: 2.8.1",
  "",
].join("\n");

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
  return { number: 7, state: "open", body: okBody(p.headSha), baseRef: "main", mergedAt: null, ...p };
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
    // T-008h B1/M5/M6: paket yöneticisi yapılandırmasının tamamı, yamalar
    ".npmrc",
    "apps/web/.npmrc",
    "pnpm-workspace.yaml",
    "patches/vitest@5.0.3.patch",
    "patches/sub/x.diff",
    "apps/web/patches/pg.patch",
    "vendor/fix.patch",
    // T-008i MINOR 4: `git apply` yaması her yerde
    "vendor/fix.diff",
    "apps/web/x/.y.diff",
    // T-008h m8: AC faz değişikliği
    "docs/PILOT.md",
    // T-008h M7: nokta ile başlayan adlar `**`/`*` altında da
    ".github/workflows/.x.yml",
    "scripts/guards/lib/.h.mjs",
    "scripts/guards/.hidden/x.mjs",
    ".githooks/.pre-commit",
    "apps/.x/tsconfig.json",
    "apps/web/.eslint.config.mjs/eslint.config.mjs",
  ])("%s korunur", (p) => {
    expect(staticRule(p)).not.toBeNull();
  });

  it.each([
    "src/a.mjs",
    "docs/STATE.md",
    "docs/tasks/T-100.md",
    "scripts/compose-smoke.mjs",
    "apps/web/app/page.tsx",
    "tests/.ac-baseline.json",
    "docs/PILOT.md.bak",
    "xscripts/guards/a.mjs",
    "scripts/guardsx/a.mjs",
    "src/patch.mjs",
    "src/diff.mjs",
    "docs/a.diff.md",
  ])(
    "%s yol kuralıyla korunmaz",
    (p) => {
      expect(staticRule(p)).toBeNull();
    },
  );
});

describe("protected-paths: glob eşleyici (T-008h M7)", () => {
  it("M7 saldırısı: Node path.matchesGlob `**` ile nokta adlarını eşlemez; bizimki eşler", () => {
    expect(path.posix.matchesGlob(".github/workflows/.x.yml", ".github/**")).toBe(false); // saldırının dayanağı
    expect(matchesGlob(".github/workflows/.x.yml", ".github/**")).toBe(true);
    expect(matchesGlob("scripts/guards/lib/.h.mjs", "scripts/guards/**")).toBe(true);
  });

  it("`*` bölüm içi, `**` sıfır veya daha çok dizin; özel karakterler düz", () => {
    expect(matchesGlob("tsconfig.json", "**/tsconfig*.json")).toBe(true);
    expect(matchesGlob("a/b/tsconfig.build.json", "**/tsconfig*.json")).toBe(true);
    expect(matchesGlob("a/tsconfigXjson", "**/tsconfig*.json")).toBe(false);
    expect(matchesGlob("packages/db/src/locking.ts", "packages/db/src/locking.*")).toBe(true);
    expect(matchesGlob("packages/db/src/x/locking.ts", "packages/db/src/locking.*")).toBe(false);
    expect(matchesGlob("db/migrations/0001.sql", "**/migrations/**")).toBe(true);
    expect(matchesGlob("migrations/a/b.sql", "**/migrations/**")).toBe(true);
    expect(matchesGlob("scripts/guards", "scripts/guards/**")).toBe(false);
    expect(matchesGlob("docs/adr/ADR-012.md", "docs/adr/ADR-*.md")).toBe(true);
    expect(matchesGlob("docs/adr/ADR-0/1.md", "docs/adr/ADR-*.md")).toBe(false);
  });

  it("desteklenmeyen glob sözdizimi sessizce yanlış eşlemez, hata verir", () => {
    for (const g of ["a/?.js", "a/[ab].js", "a/{x,y}.js", "a/!x", "a/b**/c"]) expect(() => globToRegExp(g), g).toThrow();
  });
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

  it("kök package.json: ORM/sürücü/bekçi aracı sürümü ve betiklerin tamamı korunur; diğer alanlar serbest", () => {
    const b = JSON.stringify(ROOT_PKG);
    /** @param {(p: any) => void} f */
    const after = (f) => {
      const p = structuredClone(ROOT_PKG);
      f(p);
      return JSON.stringify(p);
    };
    expect(contentRules("package.json", b, after((p) => (p.dependencies.zod = "4.1.0")))).toEqual([]);
    expect(contentRules("package.json", b, after((p) => (p.description = "x")))).toEqual([]);
    // T-008h B2: tüm betikler (yaşam döngüsü, pre/post) korunur; `dev` dahil.
    expect(contentRules("package.json", b, after((p) => (p.scripts.dev = "y")))[0]?.reason).toContain("scripts.dev");
    expect(contentRules("package.json", b, after((p) => (p.devDependencies.vitest = "5.0.4")))[0]?.reason).toContain(
      "devDependencies.vitest",
    );
    expect(contentRules("package.json", b, after((p) => (p.devDependencies["@vitest/coverage-v8"] = "5.0.3")))[0]?.reason).toContain(
      "devDependencies.@vitest/coverage-v8",
    );
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

  it("B2 saldırısı: precheck:*/preverify/postinstall/prepare betikleri korunur (tüm manifestlerde)", () => {
    const b = JSON.stringify(ROOT_PKG);
    for (const [k, v] of /** @type {Array<[string, string]>} */ ([
      ["precheck:protected", "node -e \"process.exit(0)\""],
      ["postcheck:protected", "true"],
      ["preverify", "x"],
      ["postinstall", "node evil.mjs"],
      ["prepare", "node evil.mjs"],
      ["pretest:ac", "x"],
    ])) {
      for (const file of ["package.json", "apps/web/package.json"]) {
        const a = JSON.stringify({ ...ROOT_PKG, scripts: { ...ROOT_PKG.scripts, [k]: v } });
        const h = contentRules(file, b, a);
        expect(h[0]?.rule, `${file} ${k}`).toBe("package-json");
        expect(h[0]?.reason, `${file} ${k}`).toContain(`scripts.${k}`);
      }
    }
  });

  it("tüm package.json'lar: scripts, pnpm (tamamı), auditConfig, overrides, resolutions, configDependencies … korunur", () => {
    const b = JSON.stringify({ name: "web", dependencies: { pg: "8.0.0" } });
    /** @param {Record<string, unknown>} extra */
    const after = (extra) => JSON.stringify({ name: "web", dependencies: { pg: "8.0.0" }, ...extra });
    expect(contentRules("apps/web/package.json", b, after({ dependencies: { pg: "8.0.0", zod: "4.0.0" } }))).toEqual([]);
    // T-008h M5: korunan paket sürümü yalnızca kökte değil, tüm manifestlerde; `catalog:` ile de.
    expect(contentRules("apps/web/package.json", b, JSON.stringify({ name: "web", dependencies: { pg: "8.1.0" } }))[0]?.reason).toContain(
      "dependencies.pg",
    );
    expect(contentRules("apps/web/package.json", b, JSON.stringify({ name: "web", dependencies: { pg: "catalog:" } }))[0]?.reason).toContain(
      "dependencies.pg",
    );
    expect(
      contentRules("apps/web/package.json", b, after({ devDependencies: { typescript: "catalog:evil" } }))[0]?.reason,
    ).toContain("devDependencies.typescript");
    /** @type {Array<[Record<string, unknown>, string]>} */
    const cases = [
      [{ scripts: { build: "next build" } }, "scripts.build"],
      [{ pnpm: { patchedDependencies: { vitest: "patches/v.patch" } } }, "pnpm.patchedDependencies"],
      [{ pnpm: { onlyBuiltDependencies: ["evil"] } }, "pnpm.onlyBuiltDependencies"],
      [{ pnpm: { packageExtensions: { vitest: { dependencies: { evil: "1" } } } } }, "pnpm.packageExtensions"],
      [{ packageManager: "pnpm@9.0.0" }, "packageManager"],
      [{ devEngines: { runtime: { name: "node", version: "20" } } }, "devEngines"],
      [{ dependenciesMeta: { evil: { injected: true } } }, "dependenciesMeta"],
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

  it("B1 saldırısı: .npmrc / pnpm-workspace.yaml'da her anahtar (node-options, script-shell, catalog …) korunur", () => {
    const ws = 'packages:\n  - "apps/*"\n';
    for (const [file, before, after] of /** @type {Array<[string, string | null, string]>} */ ([
      [".npmrc", "save-exact=true\n", "save-exact=true\nnode-options=--import=./x.mjs\n"],
      [".npmrc", null, "script-shell=./evil.sh\n"],
      [".npmrc", "", "registry=https://evil.example.invalid/\n"],
      [".npmrc", "", "ignore-scripts=true\n"],
      [".npmrc", "", "enable-pre-post-scripts=true\n"],
      [".npmrc", "save-exact=true\n", "save-exact=false\n"],
      ["apps/web/.npmrc", null, "nodeOptions=--require ./x.cjs\n"],
      ["pnpm-workspace.yaml", ws, ws + "nodeOptions: --import=./x.mjs\n"],
      ["pnpm-workspace.yaml", ws, ws + "catalog:\n  pg: 9.0.0\n"],
      ["pnpm-workspace.yaml", ws, ws + "catalogs:\n  db:\n    pg: 9.0.0\n"],
      ["pnpm-workspace.yaml", ws, ws + "patchedDependencies:\n  vitest: patches/v.patch\n"],
      ["pnpm-workspace.yaml", ws, ws + "onlyBuiltDependencies:\n  - evil\n"],
      ["pnpm-workspace.yaml", ws, ws + "packageExtensions:\n  vitest:\n    dependencies:\n      evil: 1.0.0\n"],
      ["pnpm-workspace.yaml", ws, ws.replace('"apps/*"', '"apps/*"\n  - "packages/*"')],
    ])) {
      const hits = classifyChanges([{ status: before === null ? "A" : "M", path: file }], {
        before: () => before,
        after: () => after,
      });
      expect(hits.map((h) => h.path), `${file}: ${after}`).toEqual([file]);
    }
  });

  it("M6: pnpm-lock.yaml'da korunan paketin girdisi/resolution'ı, tarball/git çözümlemesi ve kilit ayarları korunur", () => {
    const lock = LOCK;
    expect(lockfileGuarded(lock)).toContain('closure vitest@5.0.3 snapshot={"dependencies":{"chai":"6.3.0"},');
    expect(lockfileGuarded(lock)).not.toContain("zod");
    // Serbest: kapanış dışındaki paketin integrity/sürüm güncellemesi, ona ait snapshot değişikliği.
    expect(contentRules("pnpm-lock.yaml", lock, lock.replace("sha512-ZZZ", "sha512-ZZ2"))).toEqual([]);
    expect(contentRules("pnpm-lock.yaml", lock, lock.replace("      tslib: 2.8.1", "      tslib: 2.8.2").replace("tslib@2.8.1", "tslib@2.8.2").replace("tslib@2.8.1", "tslib@2.8.2"))).toEqual([]);
    for (const [name, after] of /** @type {Array<[string, string]>} */ ([
      ["vitest resolution", lock.replace("sha512-BBB", "sha512-EVIL")],
      ["vitest tarball", lock.replace("{integrity: sha512-BBB}", "{tarball: https://evil.example.invalid/vitest.tgz}")],
      ["@vitest/runner sürüm", lock.replace("'@vitest/runner@5.0.3':", "'@vitest/runner@5.0.4':")],
      ["korunmayan pakete tarball", lock.replace("{integrity: sha512-ZZZ}", "{tarball: https://evil.example.invalid/zod.tgz}")],
      ["korunmayan pakete git", lock.replace("{integrity: sha512-ZZZ}", "{commit: abc, repo: https://evil.example.invalid/z.git, type: git}")],
      ["çok satırlı resolution", lock.replace("    resolution: {integrity: sha512-ZZZ}", "    resolution:\n      tarball: https://evil.example.invalid/z.tgz")],
      ["settings", lock.replace("autoInstallPeers: true", "autoInstallPeers: false")],
      ["patchedDependencies", lock.replace("importers:", "patchedDependencies:\n  vitest: {path: patches/v.patch, hash: x}\n\nimporters:")],
    ])) {
      expect(contentRules("pnpm-lock.yaml", lock, after)[0]?.rule, name).toBe("lockfile");
    }
  });

  it("T-008i M6 saldırısı: vitest snapshot'ında chai → evil-chai@1.0.0 takma adı + integrity'li packages girdisi → korunur", () => {
    const evil = LOCK.replace("      chai: 6.3.0", "      chai: evil-chai@1.0.0")
      .replace("\nsnapshots:\n", "\n  evil-chai@1.0.0:\n    resolution: {integrity: sha512-EVILCHAI}\n\nsnapshots:\n")
      .concat("\n  evil-chai@1.0.0: {}\n");
    const hits = contentRules("pnpm-lock.yaml", LOCK, evil);
    expect(hits.map((h) => h.rule)).toEqual(["lockfile"]);
    expect(lockfileGuarded(evil)).toContain("alias snapshot vitest@5.0.3 dependencies chai evil-chai@1.0.0");
    expect(lockfileGuarded(evil)).toContain("closure evil-chai@1.0.0");
  });

  it.each(/** @type {Array<[string, (l: string) => string]>} */ ([
    // Kapanış: geçişli düğümün sürümü, integrity'si, eklenmesi/çıkarılması, peer çözümü
    ["geçişli düğüm sürüm değişimi (chai 6.3.0 → 6.3.1 + yeni girdiler)", (l) => l.replace("      chai: 6.3.0", "      chai: 6.3.1").replace("chai@6.3.0", "chai@6.3.1").replace("chai@6.3.0", "chai@6.3.1")],
    ["geçişli düğüm integrity (chai)", (l) => l.replace("sha512-CHAI", "sha512-EVIL")],
    ["iki adım ötedeki düğüm integrity (loupe)", (l) => l.replace("sha512-LOUPE", "sha512-EVIL")],
    ["geçişli düğüme yeni bağımlılık eklenmesi", (l) => l.replace("  chai@6.3.0:\n    dependencies:\n", "  chai@6.3.0:\n    dependencies:\n      zod: 4.0.0\n")],
    ["geçişli düğümden bağımlılık çıkarılması", (l) => l.replace("      loupe: 3.2.1\n", "")],
    ["geçişli düğüme optionalDependencies", (l) => l.replace("  loupe@3.2.1: {}", "  loupe@3.2.1:\n    optionalDependencies:\n      zod: 4.0.0")],
    ["geçişli düğümün packages girdisi silinir", (l) => l.replace("  loupe@3.2.1:\n    resolution: {integrity: sha512-LOUPE}\n", "")],
    ["korunan importer specifier", (l) => l.replace("specifier: 5.0.3", "specifier: ^5.0.3")],
    // Takma ad herhangi bir yerde (kapanış dışında da)
    ["kapanış dışı snapshot'ta takma ad", (l) => l.replace("      tslib: 2.8.1", "      tslib: evil-tslib@2.8.1")],
    ["importer'da npm: takma adı", (l) => l.replace("        specifier: 4.0.0\n        version: 4.0.0", "        specifier: npm:evil@4.0.0\n        version: evil@4.0.0")],
    ["kapsamlı takma ad", (l) => l.replace("      tslib: 2.8.1", "      tslib: '@evil/tslib@2.8.1'")],
  ]))("T-008i M6: %s → korunur", (_name, edit) => {
    const after = edit(LOCK);
    expect(after).not.toBe(LOCK);
    expect(contentRules("pnpm-lock.yaml", LOCK, after).map((h) => h.rule)).toEqual(["lockfile"]);
  });

  it.each(/** @type {Array<[string, (l: string) => string]>} */ ([
    ["sekme", (l) => l.replace("    dependencies:\n      chai", "    dependencies:\n\t  chai")],
    ["yinelenen snapshot anahtarı (tırnaklı/tırnaksız)", (l) => l.concat("\n  'chai@6.3.0': {}\n")],
    ["yinelenen bağımlılık anahtarı", (l) => l.replace("      chai: 6.3.0\n", "      chai: 6.3.0\n      chai: 6.3.1\n")],
    ["satır sonu yorumu", (l) => l.replace("      chai: 6.3.0", "      chai: 6.3.0 # evil-chai@1.0.0")],
    ["çapa / takma ad", (l) => l.replace("      chai: 6.3.0", "      chai: *evil")],
    ["etiket", (l) => l.replace("      chai: 6.3.0", "      chai: !!str 6.3.0")],
    ["blok skaler", (l) => l.replace("      chai: 6.3.0", "      chai: |\n        6.3.0")],
    ["akış biçimli bağımlılıklar", (l) => l.replace("    dependencies:\n      chai: 6.3.0", "    dependencies: {chai: evil-chai@1.0.0}")],
    ["akışta takma ad", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: *a}")],
    ["birleştirme anahtarı", (l) => l.replace("    dependencies:\n      chai: 6.3.0", "    <<: {dependencies: {chai: evil-chai@1.0.0}}\n    dependencies:\n      chai: 6.3.0")],
    ["tek olmayan girinti", (l) => l.replace("      chai: 6.3.0", "       chai: 6.3.0")],
    ["boş blok", (l) => l.replace("    dependencies:\n      chai: 6.3.0\n", "    dependencies:\n")],
    ["belge imi", (l) => l.concat("\n---\nsnapshots: {}\n")],
    ["yinelenen üst düzey blok", (l) => l.concat("\nsnapshots:\n  vitest@5.0.3: {}\n")],
    ["lockfileVersion 6", (l) => l.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'")],
    ["çift tırnakta kaçış", (l) => l.replace("      chai: 6.3.0", '      chai: "6.3.0\\u0000"')],
    // T-015: düğüm başındaki göstergeler ve belirsiz akış biçimleri yine fail-closed.
    ["akışta çapa", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: &a sha512-CHAI}")],
    ["akışta etiket", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: !!str sha512-CHAI}")],
    ["akışta blok skaler göstergesi", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: >sha512-CHAI}")],
    ["akış düz skalerinde &", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: sha512-CHAI&x}")],
    ["akışta iç içe eşleme (a: b: c)", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: sha512-CHAI: evil}")],
    ["akışta değersiz anahtar", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: }")],
    ["akışta örtük anahtar (b:})", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: sha512-CHAI:}")],
    ["akış dizisinde eşleme", (l) => l.replace("{integrity: sha512-CHAI}", "[integrity: sha512-CHAI]")],
    ["akışta boş öğe", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: sha512-CHAI,, tarball: x}")],
    ["akışta tırnaktan sonra metin", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: 'sha512-CHAI' evil}")],
    ["akış düz skalerinde tırnak", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: sha512-'CHAI'}")],
    ["akışta satır sonu yorumu", (l) => l.replace("{integrity: sha512-CHAI}", "{integrity: sha512-CHAI #x}")],
  ]))("T-008i M6 fail-closed: %s → ayrıştırılamaz, korunur", (_name, edit) => {
    const after = edit(LOCK);
    expect(after).not.toBe(LOCK);
    expect(() => lockfileGuarded(after)).toThrow(LockfileError);
    const hits = contentRules("pnpm-lock.yaml", LOCK, after);
    expect(hits.map((h) => h.rule)).toEqual(["lockfile"]);
    expect(hits[0]?.reason).toContain("ayrıştırılamadı");
  });

  it("T-015: akış düz skalerinde `*`, `>`, `|`, `^`, `~`, boşluk (pnpm engines) ayrıştırılır; kapanış dışı → serbest", () => {
    const engines = "  zod@4.0.0:\n    resolution: {integrity: sha512-ZZZ}\n";
    expect(LOCK).toContain(engines);
    const after = LOCK.replace(engines, `${engines}    engines: {node: 6.* || 8.* || >= 10.*}\n    cpu: [x64, arm64]\n`);
    const tree = parseLockYaml(after);
    const pkgs = tree.get("packages");
    const zod = pkgs?.kind === "map" ? pkgs.entries.get("zod@4.0.0") : undefined;
    const eng = zod?.kind === "map" ? zod.entries.get("engines") : undefined;
    expect(eng).toEqual({ kind: "scalar", value: "{node: 6.* || 8.* || >= 10.*}" });
    expect(lockfileGuarded(after)).toBe(lockfileGuarded(LOCK));
    expect(contentRules("pnpm-lock.yaml", LOCK, after)).toEqual([]);
    for (const v of ["{node: ^20.19.0 || ^22.13.0 || >=24}", "{node: ~1.2 || 3.x}", "{iojs: '>=1.0.0', node: '>=0.10.0'}", "{a: {b: c}, d: [e, f]}", "[a, ]", "{}"]) {
      expect(() => parseLockYaml(`lockfileVersion: '9.0'\nk: ${v}\n`), v).not.toThrow();
    }
    // Kapanıştaki pakette aynı ekleme → korunan değişiklik (gevşeme yok).
    const chai = "    resolution: {integrity: sha512-CHAI}\n";
    const inClosure = LOCK.replace(chai, `${chai}    os: [linux]\n`);
    expect(contentRules("pnpm-lock.yaml", LOCK, inClosure).map((h) => h.rule)).toEqual(["lockfile"]);
  });

  // T-016 (security-reviewer int/faz0-pooler @ 1e92a8a MAJOR): `resolution` ham metin regex'iyle
  // değerlendiriliyordu; tırnaklı anahtar (`"tarball":`) `\btarball\s*:` desenine uymadığı için kapanış
  // dışı pakete tarball çözümlemesi bekçiden gizlenebiliyordu. Artık anahtar–değer çiftleri ayrıştırılır.
  const ZOD_RES = "{integrity: sha512-ZZZ}";
  it.each(/** @type {Array<[string, string]>} */ ([
    ["çift tırnaklı \"tarball\" (saldırının kendisi)", '{integrity: sha512-ZZZ, "tarball": https://e/x.tgz}'],
    ["tek tırnaklı 'tarball'", "{integrity: sha512-ZZZ, 'tarball': https://e/x.tgz}"],
    ["tırnaklı tarball önce", "{'tarball': https://e/x.tgz, integrity: sha512-ZZZ}"],
    ["kaçışlı tek tırnak anahtar ('tar''ball')", "{integrity: sha512-ZZZ, 'tar''ball': https://e/x.tgz}"],
    ["tırnaklı directory", '{integrity: sha512-ZZZ, "directory": ../evil}'],
    ["tırnaklı git (repo/commit/type)", `{integrity: sha512-ZZZ, "repo": https://e/z.git, 'commit': abc, "type": git}`],
    ["tırnaklı path", "{integrity: sha512-ZZZ, 'path': /tmp/x}"],
    ["bilinmeyen anahtar", "{integrity: sha512-ZZZ, mirror: https://e/x.tgz}"],
    ["değersiz anahtar", "{integrity: sha512-ZZZ, tarball}"],
    ["integrity değeri eşleme", "{integrity: {tarball: https://e/x.tgz}}"],
    ["integrity yok (boş eşleme)", "{}"],
    ["eşleme değil (dizi)", "[integrity, tarball]"],
    ["blok biçim + tırnaklı anahtar", '\n      integrity: sha512-ZZZ\n      "tarball": https://e/x.tgz'],
    ["blok biçim + akış değerli integrity", "\n      integrity: {tarball: https://e/x.tgz}"],
  ]))("T-016 MAJOR: kapanış dışı pakete integrity dışı resolution (%s) → korunur", (_name, res) => {
    const after = LOCK.replace(`    resolution: ${ZOD_RES}`, `    resolution:${res.startsWith("\n") ? "" : " "}${res}`);
    expect(after).not.toBe(LOCK);
    expect(lockfileGuarded(after)).toMatch(/^resolution zod@4\.0\.0 /m);
    const hits = contentRules("pnpm-lock.yaml", LOCK, after);
    expect(hits.map((h) => h.rule)).toEqual(["lockfile"]);
    expect(hits[0]?.reason).not.toContain("ayrıştırılamadı");
  });

  it.each(/** @type {Array<[string, string]>} */ ([
    ["çift tırnakta ters bölü kaçışlı anahtar", '{integrity: sha512-ZZZ, "tar\\u0062all": https://e/x.tgz}'],
    ["çift tırnakta \\x kaçışı", '{integrity: sha512-ZZZ, "tar\\x62all": https://e/x.tgz}'],
    ["normalize edilince yinelenen anahtar", "{integrity: sha512-ZZZ, 'integrity': sha512-EVIL}"],
    ["koleksiyon anahtarı", "{integrity: sha512-ZZZ, [tarball]: https://e/x.tgz}"],
  ]))("T-016 MAJOR fail-closed: %s → ayrıştırılamaz, korunur", (_name, res) => {
    const after = LOCK.replace(`resolution: ${ZOD_RES}`, `resolution: ${res}`);
    expect(after).not.toBe(LOCK);
    expect(() => lockfileGuarded(after)).toThrow(LockfileError);
    const hits = contentRules("pnpm-lock.yaml", LOCK, after);
    expect(hits.map((h) => h.rule)).toEqual(["lockfile"]);
    expect(hits[0]?.reason).toContain("ayrıştırılamadı");
  });

  it("T-016 yanlış pozitif yok: integrity-yalnız resolution (tırnaklı anahtar / blok biçim) kapanış dışında serbest", () => {
    for (const res of ['{"integrity": sha512-ZZ2}', "{'integrity': 'sha512-ZZ2'}", "{ integrity: sha512-ZZ2 }", "\n      integrity: sha512-ZZ2", "\n      'integrity': sha512-ZZ2"]) {
      const after = LOCK.replace(`    resolution: ${ZOD_RES}`, `    resolution:${res.startsWith("\n") ? "" : " "}${res}`);
      expect(after, res).not.toBe(LOCK);
      expect(lockfileGuarded(after), res).not.toMatch(/^resolution /m);
      expect(contentRules("pnpm-lock.yaml", LOCK, after), res).toEqual([]);
    }
    // Ayrıştırılmış yapı: anahtarlar tırnaktan arındırılır, `''` kaçışı açılır, iç içe yapı korunur.
    /** @param {Array<[string, import("./protected-paths.mjs").FlowValue]>} e */
    const fm = (e) => new FlowMap(e);
    const parsed = parseFlow(`{a: 'b''c', "d": [e, {f: g}], h}`, 1);
    expect(parsed).toEqual(fm([["a", "b'c"], ["d", flowSeq(["e", fm([["f", "g"]])])], ["h", null]]));
    expect(parsed instanceof FlowMap && parsed.get("d")).toBeInstanceOf(FlowSeq);
    expect(parseFlow("{node: 6.* || 8.* || >= 10.*}", 1)).toEqual(fm([["node", "6.* || 8.* || >= 10.*"]]));
    expect(parseFlow("[a, ]", 1)).toEqual(flowSeq(["a"]));
  });

  it("isLockAlias: takma ad biçimleri", () => {
    expect(isLockAlias("evil@1.0.0")).toBe(true);
    expect(isLockAlias("@s/evil@1.0.0(p@1)")).toBe(true);
    expect(isLockAlias("npm:evil@1")).toBe(true);
    expect(isLockAlias("1.0.0")).toBe(false);
    expect(isLockAlias("5.0.3(@types/node@24.19.1)(vite@8.3.2(@types/node@24.19.1))")).toBe(false);
    expect(isLockAlias("link:../db")).toBe(false);
  });

  it("deponun gerçek pnpm-lock.yaml'ı ayrıştırılır; kapanış vitest → chai'yi içerir; kendine eşit → korunan değişiklik yok", () => {
    const real = readFileSync(path.join(import.meta.dirname, "../../pnpm-lock.yaml"), "utf8");
    const fp = lockfileGuarded(real);
    expect(fp).toMatch(/^closure chai@\d/m);
    expect(fp).toMatch(/^closure vitest@\d/m);
    expect(contentRules("pnpm-lock.yaml", real, real)).toEqual([]);
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
    const c = createGitHubClient({ token: "t", repository: "o/r", apiUrl: "https://api.github.com/", fetchImpl: f.fetchImpl });
    const ps = await c.pullsForCommit(SHA_A);
    expect(ps[0]?.mergedAt).toBe("2026-10-05T10:00:00Z");
    expect(ps[0]?.body).toBeNull();
    expect(f.calls[0]?.url).toBe(`https://api.github.com/repos/o/r/commits/${SHA_A}/pulls?per_page=100`);
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
    expect(() => createGitHubClient({ token: "t", repository: "o/r", apiUrl: "http://api.github.com" })).toThrow(GitHubError);
    expect(() => toPullInfo({ ...PR_JSON, head: { sha: "kısa" } })).toThrow(/head.sha/);
  });

  it("m4 saldırısı: GITHUB_API_URL yalnızca https://api.github.com (token başka hosta gitmez)", () => {
    const f = fakeFetch([]);
    for (const apiUrl of [
      "https://evil.example.invalid",
      "https://api.github.com.evil.example.invalid",
      "https://api.github.com@evil.example.invalid",
      "https://ghe.example.invalid/api/v3",
      "https://api.github.com/repos/x/y/../..",
    ]) {
      expect(() => createGitHubClient({ token: "t", repository: "o/r", apiUrl, fetchImpl: f.fetchImpl }), apiUrl).toThrow(/izinli değil/);
    }
    expect(f.calls).toEqual([]);
  });

  it("m4 saldırısı: REPO_RE `..` ve `.` bölümlerini reddeder", () => {
    for (const repository of ["o/..", "../r", "o/.", "o/a..b", ".x/r", "o/r/x", "o", "-o/r"]) {
      expect(() => createGitHubClient({ token: "t", repository }), repository).toThrow(GitHubError);
    }
    expect(() => createGitHubClient({ token: "t", repository: "shosgoren/2027-WMS-1" })).not.toThrow();
    expect(() => createGitHubClient({ token: "t", repository: "o-1/r.x_y" })).not.toThrow();
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

describe("lib/git.mjs ortam sertleştirmesi (T-008h m5)", () => {
  it("gitEnv GIT_CONFIG_* / GIT_CONFIG_PARAMETERS / GIT_CONFIG_GLOBAL / GIT_REPLACE_REF_BASE siler", () => {
    const env = gitEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "diff.external",
      GIT_CONFIG_VALUE_0: "/tmp/x",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='/tmp/x'",
      GIT_CONFIG_GLOBAL: "/tmp/g",
      GIT_CONFIG_SYSTEM: "/tmp/s",
      GIT_CONFIG: "/tmp/c",
      GIT_REPLACE_REF_BASE: "refs/evil/",
      GIT_DIR: "/x",
      PATH: "/bin",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("m5 saldırısı: refs/replace ile HEAD tabana eşlenirse bile korunan değişiklik görülür (--no-replace-objects)", async () => {
    const r = fixture();
    const mainSha = r.git("rev-parse", "main").trim();
    r.write("docs/INVARIANTS.md", "# gevşetildi\n").commit("x");
    const h = head(r);
    r.git("replace", h, mainSha);
    // Saldırının dayanağı: replace etkin git, HEAD'i taban commit'i olarak görür (boş fark).
    expect(r.git("diff", "--name-only", "main", "HEAD").trim()).toBe("");
    const res = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: h, body: SEC0(h) })] }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
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
    const prHead = head(r);
    r.checkout("main").merge("feat/T-100-x", "Merge pull request #7");
    const sha = head(r);
    const parent = r.git("rev-parse", "HEAD^1").trim();
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: eventFile({ before: parent }),
      GITHUB_SHA: sha,
      GITHUB_REF_NAME: "main",
    };
    const merged = pull({ headSha: prHead, mergedAt: "2026-10-05T10:00:00Z" });
    const other = pull({ number: 8, headSha: SHA_A, baseRef: "int/x", mergedAt: "2026-10-05T09:00:00Z", body: "" });
    expect((await check(r, { env, client: fakeClient({ commitPulls: { [sha]: [other, merged] } }).client })).code).toBe(0);

    const none = await check(r, { env, client: fakeClient({ commitPulls: { [sha]: [other] } }).client });
    expect(none.code).toBe(1);
    expect(none.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} docs/INVARIANTS.md`);

    const unmerged = await check(r, { env, client: fakeClient({ commitPulls: { [sha]: [pull({ headSha: prHead })] } }).client });
    expect(unmerged.code).toBe(1);

    const bad = await check(r, {
      env,
      client: fakeClient({ commitPulls: { [sha]: [pull({ headSha: prHead, mergedAt: "2026-10-05T10:00:00Z", body: "yok" })] } }).client,
    });
    expect(bad.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
  });

  /**
   * Push olayı ortamı (HEAD = GITHUB_SHA, before = HEAD^1).
   * @param {import("./lib/testkit.mjs").TestRepo} r
   */
  function pushEnv(r) {
    return {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: eventFile({ before: r.git("rev-parse", "HEAD^1").trim() }),
      GITHUB_SHA: head(r),
      GITHUB_REF_NAME: "main",
    };
  }

  it("MINOR 6 saldırısı: push birleştirme commit'inin HEAD^2'si PR head'i değil → APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const prHead = head(r);
    // Onaylı PR'ın head'i değil, başka bir commit birleştiriliyor.
    r.write("docs/INVARIANTS.md", "# onaydan sonra gevşetildi\n").commit("y");
    r.checkout("main").merge("feat/T-100-x", "Merge pull request #7");
    const merged = pull({ headSha: prHead, mergedAt: "2026-10-05T10:00:00Z" });
    const res = await check(r, { env: pushEnv(r), client: fakeClient({ commitPulls: { [head(r)]: [merged] } }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} docs/INVARIANTS.md`);
    expect(res.text).toContain("ikinci ebeveyni");
  });

  it("MINOR 6 saldırısı: birleştirme commit'ine PR dışı içerik eklenmiş (evil merge) → APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const prHead = head(r);
    r.checkout("main").merge("feat/T-100-x", "Merge pull request #7");
    r.write("scripts/guards/x.mjs", "export const gevsek = true;\n");
    r.git("add", "--all");
    r.git("commit", "--quiet", "--amend", "--no-edit");
    expect(r.git("rev-parse", "HEAD^2").trim()).toBe(prHead);
    const merged = pull({ headSha: prHead, mergedAt: "2026-10-05T10:00:00Z" });
    const res = await check(r, { env: pushEnv(r), client: fakeClient({ commitPulls: { [head(r)]: [merged] } }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} scripts/guards/x.mjs`);
    expect(res.text).toContain("önizlemesinin ağacı");
  });

  it("MINOR 6: squash birleştirme — ağaç önizlemeye eşitse OK, PR dışı içerik varsa APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const prHead = head(r);
    r.checkout("main");
    r.git("merge", "--quiet", "--squash", "feat/T-100-x");
    r.commit("Squash PR #7");
    const merged = pull({ headSha: prHead, mergedAt: "2026-10-05T10:00:00Z" });
    const ok = await check(r, { env: pushEnv(r), client: fakeClient({ commitPulls: { [head(r)]: [merged] } }).client });
    expect(ok.code).toBe(0);

    r.git("reset", "--quiet", "--hard", "HEAD^1");
    r.git("merge", "--quiet", "--squash", "feat/T-100-x");
    r.write("docs/ACCEPTANCE.md", "# gevşetildi\n").commit("Squash PR #7 + ek");
    const bad = await check(r, { env: pushEnv(r), client: fakeClient({ commitPulls: { [head(r)]: [merged] } }).client });
    expect(bad.code).toBe(1);
    expect(bad.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} docs/ACCEPTANCE.md`);
  });

  it("MINOR 6: PR head commit'i yerelde yoksa (squash, eksik geçmiş) → APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    r.checkout("main");
    r.git("merge", "--quiet", "--squash", "feat/T-100-x");
    r.commit("Squash PR #7");
    const merged = pull({ headSha: SHA_A, mergedAt: "2026-10-05T10:00:00Z" });
    const res = await check(r, { env: pushEnv(r), client: fakeClient({ commitPulls: { [head(r)]: [merged] } }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} docs/INVARIANTS.md`);
    expect(res.text).toContain("yerelde yok");
  });

  it("MINOR 8: PR kipinde rapor SHA'sından sonra korunan değişiklik → SECURITY_REPORT_STALE; yalnızca korunmayan değişiklik → OK", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const reviewed = head(r);
    r.write("docs/STATE.md", "# durum\n").commit("supervisor");
    const body = () => `${approvalLine(head(r))}\n${SEC0(reviewed)}\n`;
    const fresh = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: head(r), body: body() })] }).client });
    expect(fresh.code).toBe(0);
    r.write("package.json", JSON.stringify({ ...ROOT_PKG, scripts: { ...ROOT_PKG.scripts, postinstall: "node x" } }, null, 2) + "\n").commit("y");
    const stale = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: head(r), body: body() })] }).client });
    expect(stale.code).toBe(1);
    expect(stale.text).toContain(`FAIL ${REASONS.SECURITY_STALE} docs/INVARIANTS.md`);
    expect(stale.text).toContain("rapordan sonra korunan değişiklik: package.json");
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

  it("--local: çalışma ağacı ve izlenmeyen dosyalar da sayılır; yeni korunan dosya (ilk oluşturma) korunur", async () => {
    const r = fixture();
    r.write(".github/workflows/ci.yml", "on: push\n");
    const res = await check(r, { argv: ["--local"] });
    expect(res.text).toContain(`WARN ${WARN_LOCAL} .github/workflows/ci.yml`);
  });

  it("bağlamsız (CI dışı, --local değil): yeni korunan dosya commit'lenince → APPROVAL_UNVERIFIABLE", async () => {
    const r = fixture();
    r.write(".github/workflows/ci.yml", "on: push\n").commit("x");
    const res = await check(r);
    expect(res.text).toContain(`FAIL ${REASONS.UNVERIFIABLE} .github/workflows/ci.yml`);
  });

  it("M2 saldırısı: commit'li korunan değişiklik çalışma ağacında geri alınır → yine FAIL (PR olayı ve --pr)", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# gevşetildi\n").commit("x");
    r.write("docs/INVARIANTS.md", "# I\n"); // çalışma ağacı tabana eşit
    const body = { headSha: head(r), body: SEC0(head(r)) };
    const ev = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull(body)] }).client });
    expect(ev.code).toBe(1);
    expect(ev.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
    const arg = await check(r, { argv: ["--pr", "7"], client: fakeClient({ pulls: [pull(body)] }).client });
    expect(arg.code).toBe(1);
    expect(arg.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
  });

  it("M2 saldırısı: commit'te bekçi betiği eklenip çalışma ağacında kaldırılırsa içerik HEAD'den okunur → FAIL", async () => {
    const r = fixture();
    const pkg = { ...ROOT_PKG, scripts: { ...ROOT_PKG.scripts, "precheck:protected": "node -e 0" } };
    r.write("package.json", JSON.stringify(pkg, null, 2) + "\n").commit("x");
    r.write("package.json", JSON.stringify(ROOT_PKG, null, 2) + "\n");
    const res = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: head(r), body: SEC0(head(r)) })] }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.NO_APPROVAL} package.json`);
    expect(res.text).toContain("scripts.precheck:protected");
  });

  it("PR kipinde çalışma ağacı sayılmaz (yalnızca commit'ler)", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# commit'lenmemiş\n");
    const res = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: head(r), body: "" })] }).client });
    expect(res.code).toBe(0);
  });

  it("M3 saldırısı: PR/CI kipinde --base HEAD (boş fark) yok sayılır → FAIL", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# gevşetildi\n").commit("x");
    const p = pull({ headSha: head(r), body: SEC0(head(r)) });
    for (const argv of [["--base", "HEAD"], ["--pr", "7", "--base", "HEAD"], ["--base=feat/T-100-x"]]) {
      const res = await check(r, { argv, env: argv.includes("--pr") ? {} : prEnv(r), client: fakeClient({ pulls: [p] }).client });
      expect(res.code, argv.join(" ")).toBe(1);
      expect(res.text, argv.join(" ")).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
    }
  });

  it("M3 saldırısı: PR olayında taban API'deki base.ref'tir (GITHUB_BASE_REF HEAD'i gösterse de)", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# gevşetildi\n").commit("x").publish("feat/T-100-x");
    const env = { ...prEnv(r), GITHUB_BASE_REF: "feat/T-100-x" };
    const res = await check(r, { env, client: fakeClient({ pulls: [pull({ headSha: head(r), body: SEC0(head(r)) })] }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.NO_APPROVAL} docs/INVARIANTS.md`);
  });

  it("M4 saldırısı: onay önceki head için yazılmış, sonra yeni commit push'lanmış → APPROVAL_STALE", async () => {
    const r = fixture();
    r.write("docs/INVARIANTS.md", "# I2\n").commit("x");
    const approvedHead = head(r);
    r.write("docs/INVARIANTS.md", "# I3 (onaydan sonra)\n").commit("y");
    const res = await check(r, {
      env: prEnv(r),
      client: fakeClient({ pulls: [pull({ headSha: head(r), body: okBody(approvedHead) })] }).client,
    });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.STALE} docs/INVARIANTS.md`);
  });

  it.each([
    ["B1 .npmrc node-options", ".npmrc", "node-options=--import=./x.mjs\n"],
    ["B1 .npmrc script-shell", ".npmrc", "script-shell=./x.sh\n"],
    ["B1 pnpm-workspace nodeOptions", "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\nnodeOptions: --import=./x.mjs\n'],
    ["M5 catalog", "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\ncatalog:\n  pg: 9.0.0\n'],
    ["M5 alt paket sürücü sürümü", "apps/web/package.json", JSON.stringify({ name: "web", dependencies: { pg: "catalog:" } })],
    ["M6 yama", "patches/pg@8.0.0.patch", "--- a\n+++ b\n"],
    ["M7 nokta adlı iş akışı", ".github/workflows/.x.yml", "on: push\n"],
    ["M7 nokta adlı bekçi yardımcısı", "scripts/guards/lib/.h.mjs", "export {};\n"],
    ["m8 PILOT", "docs/PILOT.md", "# pilot: AC-34 3A\n"],
  ])("%s saldırısı: onaysız PR → FAIL PROTECTED_NO_APPROVAL", async (_name, file, content) => {
    const r = fixture();
    r.write(file, content).commit("x");
    const res = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: head(r), body: SEC0(head(r)) })] }).client });
    expect(res.code).toBe(1);
    expect(res.text).toContain(`FAIL ${REASONS.NO_APPROVAL} ${file}`);
  });

  it("B2 saldırısı: package.json'a pre/post/yaşam döngüsü betiği → FAIL PROTECTED_NO_APPROVAL", async () => {
    for (const k of ["precheck:protected", "preverify", "postinstall", "prepare"]) {
      const r = fixture();
      r.write("package.json", JSON.stringify({ ...ROOT_PKG, scripts: { ...ROOT_PKG.scripts, [k]: "node -e 0" } }, null, 2) + "\n").commit("x");
      const res = await check(r, { env: prEnv(r), client: fakeClient({ pulls: [pull({ headSha: head(r), body: SEC0(head(r)) })] }).client });
      expect(res.code, k).toBe(1);
      expect(res.text, k).toContain(`FAIL ${REASONS.NO_APPROVAL} package.json`);
    }
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
