import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDbFacade, cleanupBranch, computeRpoRto, drillBranchName, isDrillBranchName, latestCommitAt, main, runDrill, writeSummary, SCOPE_NOTE } from "./restore-drill.mjs";
import { createRedactor, maskSecret } from "./neon-spike.mjs";


/** @typedef {Record<string, any>} Any */
const hex = () => randomBytes(32).toString("hex");
/** @param {string} name @param {Any} [over] */
const role = (name, over = {}) => ({
  name, login: true, superuser: false, bypassrls: false, createdb: false, createrole: false, replication: false, memberships: 0, ...over,
});
/** Test parmak izi (rastgele özetler; literal sır yok).
 * @param {Any} [over]
 * @returns {Any} */
function makeFingerprint(over = {}) {
  return {
    db_now: "2026-10-06T10:00:00.000000Z",
    rls_bypass: true,
    server_version_num: "170011",
    migrations: [{ version: "0001", name: "baseline", checksum_sha256: hex() }],
    tables: { "public.users": 3, "public.audit_logs": 10, "public.security_events": 7 },
    audit_logs: { count: 10, latest_at: "2026-10-06T09:00:00.000000Z", digest: hex() },
    security_events: { count: 7, latest_at: "2026-10-06T09:59:58.000000Z", digest: hex() },
    schema: { columns: 80, digest: hex() },
    rls: { tables: 12, digest: hex() },
    policies: { count: 9, digest: hex() },
    roles: [role("wms_app"), role("wms_auth"), role("wms_identity_probe", { login: false }), role("wms_ops", { login: false }), role("wms_worker")],
    ...over,
  };
}

const RUN = "123456";
const NAME = `restore-drill-${RUN}`;

/** Sahte Neon + DB; `opts` ile hata/fark enjekte edilir.
 * @param {Any} [opts] */
function harness(opts = {}) {
  /** @type {any[]} */
  const log = [];
  const mainFp = makeFingerprint({ db_now: "2026-10-06T10:00:00.000000Z" });
  let clock = 1_000_000;
  const existing = new Set(["br-main"]);
  const neon = {
    resolveMain: async () => ({ branchId: "br-main", database: "wms", ownerRole: "owner", target: { host: "main.invalid", user: "o", password: "p", database: "wms" } }),
    getRetentionSeconds: async () => opts.retention ?? 86400,
    createRestoreBranch: async (/** @type {Any} */ a) => {
      log.push(["create", a]);
      if (opts.createFails) {
        if (opts.createLeavesBranch) existing.add("br-tmp");
        throw new Error("create failed");
      }
      existing.add("br-tmp");
      return { branchId: opts.sameIdAsMain ? "br-main" : "br-tmp" };
    },
    connectTarget: async () => ({ host: "tmp.invalid", user: "o", password: "p", database: "wms" }),
    findBranchIdByName: async (/** @type {string} */ n) => {
      log.push(["find", n]);
      return existing.has("br-tmp") ? "br-tmp" : null;
    },
    getBranchInfo: async (/** @type {string} */ id) => {
      log.push(["info", id]);
      if (!existing.has(id)) return null;
      const flags = opts.flags?.[id] ?? {};
      return { isDefault: id === "br-main", isPrimary: false, isProtected: false, ...flags };
    },
    deleteBranch: async (/** @type {string} */ id) => {
      log.push(["delete", id]);
      if (opts.deleteFails) throw new Error("delete failed");
      existing.delete(id);
    },
    branchExists: async (/** @type {string} */ id) => existing.has(id),
  };
  let fpCalls = 0;
  const db = {
    fingerprint: (/** @type {Any} */ t) => {
      if (t.host === "main.invalid") return mainFp;
      fpCalls++;
      if (opts.notReadyTimes && fpCalls <= opts.notReadyTimes) throw new Error("connection refused");
      const r = structuredClone(mainFp);
      if (opts.mutateRestored) opts.mutateRestored(r);
      return r;
    },
  };
  const deps = /** @type {any} */ ({
    neon,
    db,
    redactor: createRedactor(),
    now: () => (clock += opts.stepMs ?? 20_000),
    sleep: async () => {},
    today: () => "2026-10-06T10:05:00.000Z",
  });
  return { deps, log, existing };
}

describe("runDrill", () => {
  it("mutlu yol: eşit parmak izi, post yok, dal silindi, RPO/RTO hesaplı", async () => {
    const h = harness();
    const s = await runDrill(h.deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("pass");
    expect(s.fingerprints_equal).toBe(true);
    expect(s.table_counts_equal).toBe(true);
    expect(s.digests_equal).toBe(true);
    expect(s.restored_not_after_t).toBe(true);
    expect(s.main_writes).toBe(0);
    expect(s.restored_branch_deleted).toBe(true);
    expect(s.point_in_time).toBe("2026-10-06T10:00:00.000000Z");
    expect(s.rpo_seconds).toBe(2); // T 10:00:00 − son commit 09:59:58
    expect(s.rto_seconds).toBe(40); // iki now() çağrısı + hazırlık çağrısı arası 20 sn adımlar
    expect(s.rpo_within_target).toBe(true);
    expect(s.rto_within_target).toBe(true);
    const create = /** @type {any[]} */ (h.log.find((l) => l[0] === "create"));
    expect(create[1]).toEqual({ name: NAME, parentId: "br-main", timestamp: "2026-10-06T10:00:00.000000Z" });
    expect(h.log.some((l) => l[0] === "marker")).toBe(false);
    expect(h.existing.has("br-tmp")).toBe(false);
    expect(h.existing.has("br-main")).toBe(true);
  });

  it("tek satır fark → FAIL, yine de dal silinir", async () => {
    const h = harness({ mutateRestored: (/** @type {Any} */ r) => { r.tables["public.users"] += 1; } });
    const s = await runDrill(h.deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("fail");
    expect(s.fingerprints_equal).toBe(false);
    expect(s.table_counts_equal).toBe(false);
    expect(s.error).toContain("public.users");
    expect(s.restored_branch_deleted).toBe(true);
    expect(h.existing.has("br-tmp")).toBe(false);
  });

  it("geri yüklenen en yeni commit T'den sonraysa FAIL", async () => {
    const s = await runDrill(
      harness({ mutateRestored: (/** @type {Any} */ r) => { r.security_events.latest_at = "2026-10-06T10:00:01.000000Z"; } }).deps,
      { runId: RUN, branchName: NAME },
    );
    expect(s.result).toBe("fail");
    expect(s.restored_not_after_t).toBe(false);
  });

  it("geri yüklenen dalda BYPASSRLS uygulama rolü → FAIL", async () => {
    const s = await runDrill(harness({ mutateRestored: (/** @type {Any} */ r) => { /** @type {Any} */ (r.roles.find((/** @type {Any} */ x) => x.name === "wms_app")).bypassrls = true; } }).deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("fail");
    expect(s.roles_ok).toBe(false);
    expect(s.role_problems).toContain("wms_app: bypassrls=true");
  });

  it("silme başarısızsa iş kırmızı (diğer her şey yeşil olsa da)", async () => {
    const s = await runDrill(harness({ deleteFails: true }).deps, { runId: RUN, branchName: NAME });
    expect(s.fingerprints_equal).toBe(true);
    expect(s.result).toBe("fail");
    expect(s.restored_branch_deleted).toBe(false);
    expect(s.cleanup_error).toContain("delete failed");
  });

  it("dal isteği hata verse bile adla bulunan artık dal silinir", async () => {
    const h = harness({ createFails: true, createLeavesBranch: true });
    const s = await runDrill(h.deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("fail");
    expect(s.error).toContain("create failed");
    expect(h.log).toContainEqual(["delete", "br-tmp"]);
    expect(s.restored_branch_deleted).toBe(true);
  });

  it("dal hiç oluşmadıysa silme denenmez, sonuç yine kırmızı", async () => {
    const h = harness({ createFails: true });
    const s = await runDrill(h.deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("fail");
    expect(h.log.some((l) => l[0] === "delete")).toBe(false);
  });

  it("geri yüklenen kimlik ana dalla aynıysa ana dal SİLİNMEZ", async () => {
    const h = harness({ sameIdAsMain: true });
    const s = await runDrill(h.deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("fail");
    expect(h.log.some((l) => l[0] === "delete")).toBe(false);
    expect(h.existing.has("br-main")).toBe(true);
  });

  it("uç nokta hazır olana dek yeniden dener", async () => {
    const s = await runDrill(harness({ notReadyTimes: 3 }).deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("pass");
  });

  it("hazır olmazsa zaman aşımı ile kırmızı, dal silinir", async () => {
    const h = harness({ notReadyTimes: 10_000, stepMs: 120_000 });
    const s = await runDrill(h.deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("fail");
    expect(s.error).toContain("hazır olmadı");
    expect(s.restored_branch_deleted).toBe(true);
  });

  it("RTO hedefi aşılırsa raporlanır, sonuç kırmızı DEĞİL", async () => {
    const s = await runDrill(harness({ stepMs: 2_000_000 }).deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("pass");
    expect(s.rto_within_target).toBe(false);
  });

  it("çok kısa geçmiş saklama süresi reddedilir", async () => {
    const s = await runDrill(harness({ retention: 60 }).deps, { runId: RUN, branchName: NAME });
    expect(s.result).toBe("fail");
    expect(s.error).toContain("saklama");
  });
});

describe("computeRpoRto", () => {
  it("saniye hesabı ve hedef bayrakları (A-48)", () => {
    const r = computeRpoRto({ pointInTime: "2026-10-06T10:00:00Z", lastRestoredCommit: "2026-10-06T09:46:00Z", requestedAtMs: 0, verifiedAtMs: 3_700_000 });
    expect(r).toEqual({ rpoSeconds: 840, rtoSeconds: 3700, rpoOk: true, rtoOk: false });
  });
  it("RPO > 15 dk → hedef dışı; commit yoksa null", () => {
    expect(computeRpoRto({ pointInTime: "2026-10-06T10:00:00Z", lastRestoredCommit: "2026-10-06T09:00:00Z", requestedAtMs: 0, verifiedAtMs: 1000 }).rpoOk).toBe(false);
    expect(computeRpoRto({ pointInTime: "2026-10-06T10:00:00Z", lastRestoredCommit: null, requestedAtMs: 0, verifiedAtMs: 1000 }).rpoSeconds).toBeNull();
  });
  it("T'den sonraki commit → hata", () => {
    expect(() => computeRpoRto({ pointInTime: "2026-10-06T10:00:00Z", lastRestoredCommit: "2026-10-06T10:00:01Z", requestedAtMs: 0, verifiedAtMs: 1 })).toThrow(/zaman noktası/);
  });
  it("latestCommitAt en yeniyi seçer", () => {
    expect(latestCommitAt({ audit_logs: { latest_at: "2026-10-06T09:00:00Z" }, security_events: { latest_at: "2026-10-06T09:30:00Z" } })).toBe("2026-10-06T09:30:00Z");
    expect(latestCommitAt({ audit_logs: { latest_at: null }, security_events: { latest_at: null } })).toBeNull();
  });
});

describe("dal adı", () => {
  it("run_id'den türetilir; Actions dışında reddedilir", () => {
    expect(drillBranchName({ GITHUB_RUN_ID: "42" })).toBe("restore-drill-42");
    expect(drillBranchName({ GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" })).toBe("restore-drill-42-2");
    expect(() => drillBranchName({})).toThrow(/GITHUB_RUN_ID/);
    expect(isDrillBranchName("main")).toBe(false);
    expect(isDrillBranchName("restore-drill-42")).toBe(true);
  });
  it("artık dal default/primary/protected ise (mainId bilinmeden de) silinmez, hata döner", async () => {
    for (const flags of [{ isDefault: true }, { isPrimary: true }, { isProtected: true }]) {
      const h = harness({ flags: { "br-tmp": flags } });
      h.existing.add("br-tmp");
      const r = await cleanupBranch(h.deps.neon, { name: NAME, branchId: null, mainId: null });
      expect(r.deleted).toBe(false);
      expect(r.error).toContain("default/primary/protected");
      expect(h.log.some((l) => l[0] === "delete")).toBe(false);
    }
  });
  it("--cleanup: bayraksız artık dal silinir; dal yoksa sorun yok", async () => {
    const h = harness();
    h.existing.add("br-tmp");
    expect(await cleanupBranch(h.deps.neon, { name: NAME, branchId: null, mainId: null })).toEqual({ attempted: true, deleted: true, error: null });
    expect(h.existing.has("br-main")).toBe(true);
    expect(await cleanupBranch(h.deps.neon, { name: NAME, branchId: null, mainId: null })).toEqual({ attempted: false, deleted: false, error: null });
  });
  it("öneke uymayan ad silinmez", async () => {
    /** @type {string[]} */
    const calls = [];
    const neon = /** @type {any} */ ({ findBranchIdByName: async () => "x", deleteBranch: async (/** @type {string} */ id) => calls.push(id), branchExists: async () => false });
    const r = await cleanupBranch(neon, { name: "main", branchId: "br-main", mainId: null });
    expect(r.deleted).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("maskeleme", () => {
  it("URI içeren hata özetten ve konsoldan ayıklanır; özet dosyasında sızıntı yok", async () => {
    const pw = randomBytes(12).toString("hex");
    const uri = `postgresql://owner:${pw}@ep-cool-sky-123456.c-2.eu-central-1.aws.neon.tech/wms?sslmode=verify-full`;
    const h = harness({ createFails: true });
    maskSecret(h.deps.redactor, pw, { env: {} });
    h.deps.neon.createRestoreBranch = async () => {
      throw new Error(`bağlantı hatası ${uri} parola ${pw}`);
    };
    const s = await runDrill(h.deps, { runId: RUN, branchName: NAME });
    expect(JSON.stringify(s)).not.toContain(pw);
    expect(JSON.stringify(s)).not.toContain("neon.tech");
    expect(JSON.stringify(s)).not.toContain("postgresql://");
    const dir = mkdtempSync(path.join(tmpdir(), "rd-"));
    const { leaked } = writeSummary(s, h.deps.redactor, dir);
    expect(leaked).toBe(false);
    for (const f of readdirSync(dir)) {
      const t = readFileSync(path.join(dir, f), "utf8");
      expect(t).not.toContain(pw);
      expect(t).not.toContain("ep-cool-sky");
    }
    expect(readFileSync(path.join(dir, "summary.md"), "utf8")).toContain(SCOPE_NOTE);
  });

  it("özette sızıntı varsa içerik atılır", () => {
    const redactor = createRedactor();
    const secret = randomBytes(12).toString("hex");
    maskSecret(redactor, secret, { env: {} });
    const dir = mkdtempSync(path.join(tmpdir(), "rd-"));
    const { leaked } = writeSummary({ task: "T-130", result: "pass", date: "d", run_id: "1", scope: SCOPE_NOTE, targets: { rpo_seconds: 1, rto_seconds: 1 }, error: `x ${secret}` }, redactor, dir);
    expect(leaked).toBe(true);
    expect(readFileSync(path.join(dir, "summary.json"), "utf8")).not.toContain(secret);
    expect(JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")).result).toBe("fail");
  });
});

describe("createDbFacade", () => {
  it("yalnızca parmak izi sorgusu; ana dala yazma yok", () => {
    /** @type {string[]} */
    const seen = [];
    const fp = makeFingerprint();
    const db = createDbFacade(createRedactor(), (/** @type {any} */ _t, /** @type {string} */ sql) => {
      seen.push(sql);
      return { ok: true, stdout: `FP:${JSON.stringify(fp)}`, sqlstate: null, error: null };
    });
    db.fingerprint({ host: "h", user: "u", password: "p", database: "d" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("READ ONLY");
    expect(seen[0]).not.toMatch(/\bINSERT\b/i);
  });
});

describe("main", () => {
  it("NEON ortamı yoksa yalnızca ADLARI içeren hata, çıkış 1", async () => {
    /** @type {string[]} */
    const out = [];
    const code = await main({ argv: [], env: { GITHUB_RUN_ID: "5" }, write: (/** @type {string} */ x) => out.push(x) });
    expect(code).toBe(1);
    expect(out.join("")).toContain("NEON_API_KEY");
  });
  it("GITHUB_RUN_ID yoksa reddeder", async () => {
    /** @type {string[]} */
    const out = [];
    expect(await main({ argv: [], env: {}, write: (/** @type {string} */ x) => out.push(x) })).toBe(1);
    expect(out.join("")).toContain("GITHUB_RUN_ID");
  });
});
