#!/usr/bin/env node
// T-130 — Restore tatbikatı (`.github/workflows/restore-drill.yml`). YALNIZCA GitHub Actions'ta (ajan ortamından
// Neon'a erişim yok, ADR-013). Staging ANA DALINA HİÇBİR YAZMA YAPMAZ (yalnızca salt-okunur transaction; işaret satırı yok).
//
// Akış (A-48: yalnızca veritabanı; dosya deposu + silme işaretleri dahil tam tatbikat AC-17 / Faz 4P):
//   1. Ana dalda salt-okunur parmak izi (db-fingerprint.mjs). Zaman noktası T = parmak izi transaction'ının
//      `transaction_timestamp()` değeri (veritabanı saati; runner saat kayması etkisiz).
//   2. Neon API ile T anına GEÇİCİ dal `restore-drill-<run_id>`: POST /projects/{id}/branches
//      {branch:{name, parent_id, parent_timestamp: T}, endpoints:[{type:"read_write"}]} (G-04: @neondatabase/api-client
//      2.7.3 `CreateProjectBranch` tipi; parent_timestamp ISO 8601). Uç nokta hazır olana dek parmak izi denenir.
//   3. Geri yüklenen dalda parmak izi: ana dalla birebir eşit (T'den sonra ana dalda yazma olduysa ve geri
//      yüklemeye sızdıysa eşitlik bozulur) + geri yüklenen en yeni commit T'den sonra DEĞİL + RLS rol nitelikleri.
//   4. RTO = dal isteği → doğrulama tamam; RPO = T − geri yüklenen en yeni commit (security_events/audit_logs en
//      yeni occurred_at; salt-okunur ölçü). Hedefler A-48: RPO ≤ 15 dk, RTO ≤ 60 dk; aşılırsa kırmızı DEĞİL, raporlanır.
//      Sınır: staging boştayken "T sonrası veri yok" kanıtı yalnızca en yeni commit ≤ T denetimidir.
//   5. finally: geçici dal silinir ve yokluğu doğrulanır; silinemezse iş kırmızı (fail-closed). Silmeden önce dalın
//      default/primary/protected OLMADIĞI API'den doğrulanır (ad öneki + ana dal kimliği korumalarına ek);
//      `--cleanup` aynı koşunun artık dalını aynı korumalarla siler (idempotent).
//
// Gizlilik (G-09): her URI/parola/host/dal kimliği elde edildiği anda `::add-mask::` + kendi maskeleyicimiz; özet
// yalnızca tarih, T, RPO/RTO, eşitlik bayrakları, sayılar ve sonuç içerir; yazıldıktan sonra sızıntı için taranır.
// Çıkış kodu: 0 yeşil · 1 kırmızı.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FingerprintError, checkRoleAttributes, compareFingerprints, fingerprintHash, takeFingerprint } from "./db-fingerprint.mjs";
import { createNeonProjectApi, parsePgUri, readNeonEnv } from "./neon-api.mjs";
import { createNeonApi, createRedactor, runPsql, scanDirForLeaks } from "./neon-spike.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(ROOT, ".artifacts", "restore-drill");
export const BRANCH_PREFIX = "restore-drill-";
/** A-48 hedefleri (varsayım; aşılırsa raporlanır, kırmızı değildir). */
export const TARGETS = Object.freeze({ rpoSeconds: 15 * 60, rtoSeconds: 60 * 60 });
export const SCOPE_NOTE = "Yalnızca veritabanı; dosya deposu (Tigris) ve silme işaretleri dahil tam tatbikat AC-17 / Faz 4P.";
/** T ile dal isteği arasındaki asgari bekleme (T'nin Neon tarafında geçmişte kalması / saat kayması payı). */
/** Ölçülmez: ana dala yazım yolu yok (yalnızca salt-okunur transaction). */
export const MAIN_WRITES_NOTE = "ölçülmedi (tasarım gereği; ana dala yazım yolu yok)";
export const POINT_GAP_MS = 3000;
export const READY_TIMEOUT_MS = 10 * 60_000;
export const READY_INTERVAL_MS = 5000;

/** Restore sonrası stok tutarlılık sorgusu (T-284; salt okunur, yalnızca sayı döner). */
export const CONSISTENCY_PREFIX = "SC:";
export const STOCK_CONSISTENCY_SQL = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${readFileSync(path.join(ROOT, "scripts", "lib", "stock-consistency.sql"), "utf8")}\nCOMMIT;\n`;
/** Sıfır olması gereken sayaçlar (ad → kırmızı iletisi; değer/kimlik içermez). */
export const CONSISTENCY_ZERO_COUNTERS = Object.freeze([
  "ledger_ne_balance",
  "reservations_ne_reserved",
  "reserved_gt_quantity",
  "negative_quantity",
  "negative_reserved",
]);

export class DrillError extends Error {
  name = "DrillError";
}

// ---------------------------------------------------------------------------------------------
// Saf yardımcılar
// ---------------------------------------------------------------------------------------------

/**
 * Geçici dal adı: `restore-drill-<run_id>` (yeniden denemede `-<attempt>`); Actions dışında koşu reddedilir.
 * @param {Record<string, string | undefined>} env
 */
export function drillBranchName(env) {
  const runId = (env.GITHUB_RUN_ID ?? "").trim();
  const attempt = (env.GITHUB_RUN_ATTEMPT ?? "1").trim();
  if (!/^[0-9]+$/.test(runId)) throw new DrillError("GITHUB_RUN_ID yok/geçersiz: tatbikat yalnızca GitHub Actions'ta koşar");
  return attempt === "1" || attempt === "" ? `${BRANCH_PREFIX}${runId}` : `${BRANCH_PREFIX}${runId}-${attempt}`;
}

/** @param {string} name */
export function isDrillBranchName(name) {
  return /^restore-drill-[0-9]+(-[0-9]+)?$/.test(name);
}

/**
 * RPO/RTO hesabı.
 * @param {{ pointInTime: string, lastRestoredCommit: string | null, requestedAtMs: number, verifiedAtMs: number }} m
 * @returns {{ rpoSeconds: number | null, rtoSeconds: number, rpoOk: boolean | null, rtoOk: boolean }}
 */
export function computeRpoRto(m) {
  const rtoSeconds = round3((m.verifiedAtMs - m.requestedAtMs) / 1000);
  if (rtoSeconds < 0) throw new DrillError("RTO negatif: saat tutarsız");
  let rpoSeconds = null;
  if (m.lastRestoredCommit !== null) {
    rpoSeconds = round3((Date.parse(m.pointInTime) - Date.parse(m.lastRestoredCommit)) / 1000);
    if (rpoSeconds < 0) throw new DrillError("geri yüklenen son commit T'den sonra: zaman noktası ihlali");
  }
  return {
    rpoSeconds,
    rtoSeconds,
    rpoOk: rpoSeconds === null ? null : rpoSeconds <= TARGETS.rpoSeconds,
    rtoOk: rtoSeconds <= TARGETS.rtoSeconds,
  };
}

/** @param {number} n */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * @param {{ audit_logs: { latest_at: string | null }, security_events: { latest_at: string | null } }} fp
 * @returns {string | null} iki tablodaki en yeni occurred_at
 */
export function latestCommitAt(fp) {
  const ts = [fp.audit_logs.latest_at, fp.security_events.latest_at].filter((/** @type {string | null} */ x) => x !== null);
  if (ts.length === 0) return null;
  return ts.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/**
 * Tutarlılık sorgusu çıktısını ayrıştırır ve biçimini doğrular (değer içermeyen hata iletileri).
 * @param {string} stdout
 * @returns {Record<string, any>}
 */
export function parseConsistencyOutput(stdout) {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(CONSISTENCY_PREFIX));
  if (line === undefined) throw new DrillError("tutarlılık çıktısı bulunamadı");
  let sc;
  try {
    sc = JSON.parse(line.slice(CONSISTENCY_PREFIX.length));
  } catch {
    throw new DrillError("tutarlılık çıktısı JSON değil");
  }
  if (typeof sc?.rls_bypass !== "boolean") throw new DrillError("tutarlılık çıktısı geçersiz: rls_bypass");
  for (const k of ["dimensions", "balances", "ledger_rows", ...CONSISTENCY_ZERO_COUNTERS]) {
    if (typeof sc[k] !== "number" || !Number.isInteger(sc[k]) || sc[k] < 0) throw new DrillError(`tutarlılık çıktısı geçersiz: ${k}`);
  }
  return sc;
}

/**
 * Tutarlılık sonucundaki ihlal adları (boş = tutarlı). RLS'yi atlamayan rol → sonuç güvenilmez → ihlal sayılır.
 * @param {Record<string, any>} sc
 * @returns {string[]}
 */
export function consistencyProblems(sc) {
  /** @type {string[]} */
  const problems = [];
  if (sc.rls_bypass !== true) problems.push("rls_bypass_yok");
  for (const k of CONSISTENCY_ZERO_COUNTERS) if (sc[k] !== 0) problems.push(`${k}=${sc[k]}`);
  return problems;
}

/**
 * Restore edilen dalda salt-okunur stok tutarlılık sorgusu.
 * @param {PsqlTarget} target
 * @param {import("./neon-spike.mjs").Redactor} redactor
 * @param {{ psql?: typeof runPsql, timeoutMs?: number }} [opts]
 */
export function takeConsistency(target, redactor, opts = {}) {
  const psql = opts.psql ?? runPsql;
  const r = psql(target, STOCK_CONSISTENCY_SQL, redactor, opts.timeoutMs ?? 300_000);
  if (!r.ok) throw new DrillError(`tutarlılık sorgusu başarısız${r.sqlstate ? ` (SQLSTATE ${r.sqlstate})` : ""}`);
  return parseConsistencyOutput(r.stdout);
}

/**
 * Özetteki serbest metni (hata iletisi) maskeler ve kısaltır.
 * @param {import("./neon-spike.mjs").Redactor} redactor
 * @param {unknown} e
 */
export function safeMessage(redactor, e) {
  const msg = e instanceof Error ? e.message : String(e);
  return redactor.redact(msg).replace(/\s+/g, " ").slice(0, 300);
}

// ---------------------------------------------------------------------------------------------
// Tatbikat çekirdeği (bağımlılıklar enjekte edilir; birim testleri sahte Neon/DB ile koşar)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {import("./db-fingerprint.mjs").Fingerprint} Fingerprint
 * @typedef {import("./neon-spike.mjs").PsqlTarget} PsqlTarget
 * @typedef {{
 *   resolveMain: () => Promise<{ branchId: string, database: string, ownerRole: string, target: PsqlTarget }>,
 *   getRetentionSeconds: () => Promise<number | null>,
 *   createRestoreBranch: (a: { name: string, parentId: string, timestamp: string }) => Promise<{ branchId: string }>,
 *   connectTarget: (a: { branchId: string, database: string, ownerRole: string }) => Promise<PsqlTarget>,
 *   findBranchIdByName: (name: string) => Promise<string | null>,
 *   getBranchInfo: (id: string) => Promise<{ isDefault: boolean, isPrimary: boolean, isProtected: boolean } | null>,
 *   deleteBranch: (id: string) => Promise<void>,
 *   branchExists: (id: string) => Promise<boolean>,
 * }} NeonFacade
 * @typedef {{
 *   fingerprint: (t: PsqlTarget) => Fingerprint,
 *   consistency: (t: PsqlTarget) => Record<string, any>,
 * }} DbFacade
 * @typedef {{ neon: NeonFacade, db: DbFacade, redactor: import("./neon-spike.mjs").Redactor,
 *   now?: () => number, sleep?: (ms: number) => Promise<unknown>, today?: () => string }} DrillDeps
 */

/**
 * Geçici dalı güvenle siler: ad önekini ve ana dal kimliğini denetler, silmeden sonra yokluğu doğrular.
 * @param {NeonFacade} neon
 * @param {{ name: string, branchId: string | null, mainId: string | null }} c
 * @returns {Promise<{ attempted: boolean, deleted: boolean, error: string | null }>}
 */
export async function cleanupBranch(neon, c) {
  try {
    if (!isDrillBranchName(c.name)) throw new DrillError("dal adı tatbikat önekine uymuyor: silme reddedildi");
    const id = c.branchId ?? (await neon.findBranchIdByName(c.name));
    if (id === null) return { attempted: false, deleted: false, error: null };
    if (c.mainId !== null && id === c.mainId) throw new DrillError("silinecek dal ana dalla aynı: silme reddedildi");
    const info = await neon.getBranchInfo(id);
    // Kimlik az önce biliniyordu/listelendi: bilgi yoksa yokluk kanıtlanamaz → fail-open olmasın (kırmızı).
    if (info === null) throw new DrillError("dal kimliği biliniyor ama dal bilgisi alınamadı: silme doğrulanamadı");
    if (info.isDefault || info.isPrimary || info.isProtected) {
      throw new DrillError("silinecek dal default/primary/protected: silme reddedildi");
    }
    await neon.deleteBranch(id);
    if (await neon.branchExists(id)) throw new DrillError("silme sonrası dal hâlâ listede");
    return { attempted: true, deleted: true, error: null };
  } catch (e) {
    return { attempted: true, deleted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * @param {DrillDeps} deps
 * @param {{ runId: string, branchName: string }} cfg
 */
export async function runDrill(deps, cfg) {
  const { neon, db, redactor } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const today = deps.today ?? (() => new Date().toISOString());
  /** @type {Record<string, any>} */
  const s = {
    task: "T-130",
    date: today(),
    run_id: cfg.runId,
    scope: SCOPE_NOTE,
    targets: { rpo_seconds: TARGETS.rpoSeconds, rto_seconds: TARGETS.rtoSeconds, basis: "A-48 (varsayım)" },
    point_in_time: null,
    history_retention_seconds: null,
    rpo_seconds: null,
    rto_seconds: null,
    rpo_within_target: null,
    rto_within_target: null,
    table_counts_equal: null,
    tables_compared: null,
    digests_equal: null,
    fingerprints_equal: null,
    fingerprint_sha256: null,
    sections: null,
    restored_not_after_t: null,
    main_writes: MAIN_WRITES_NOTE,
    roles_ok: null,
    role_problems: null,
    content_equal: null,
    stock_consistency: null,
    stock_consistency_ok: null,
    restored_branch_deleted: null,
    error: null,
    result: "fail",
  };
  /** @type {string | null} */
  let branchId = null;
  /** @type {string | null} */
  let mainId = null;
  let ok = false;
  try {
    const main = await neon.resolveMain();
    mainId = main.branchId;
    s.history_retention_seconds = await neon.getRetentionSeconds();

    const fpMain = db.fingerprint(main.target);
    const pointInTime = fpMain.db_now;
    s.point_in_time = pointInTime;
    if (s.history_retention_seconds !== null && s.history_retention_seconds < 600) {
      throw new DrillError("geçmiş saklama süresi tatbikat için çok kısa (<10 dk)");
    }

    await sleep(POINT_GAP_MS);

    const requestedAtMs = now();
    const created = await neon.createRestoreBranch({ name: cfg.branchName, parentId: main.branchId, timestamp: pointInTime });
    branchId = created.branchId;
    if (branchId === main.branchId) throw new DrillError("geri yüklenen dal kimliği ana dalla aynı");
    const target = await neon.connectTarget({ branchId, database: main.database, ownerRole: main.ownerRole });

    /** @type {Fingerprint | null} */
    let fpRestored = null;
    const deadline = now() + READY_TIMEOUT_MS;
    for (let attempt = 0; fpRestored === null; attempt++) {
      try {
        fpRestored = db.fingerprint(target);
      } catch (e) {
        if (e instanceof FingerprintError && e.fatal) throw e;
        if (now() > deadline) throw new DrillError(`geri yüklenen dal hazır olmadı: ${safeMessage(redactor, e)}`);
        await sleep(READY_INTERVAL_MS);
      }
    }
    const verifiedAtMs = now();

    // Restore sonrası bağımsız stok tutarlılığı (T-284): hata/ihlal = kırmızı (fail-closed; catch'e düşer).
    const sc = db.consistency(target);
    const scProblems = consistencyProblems(sc);
    const cmp = compareFingerprints(fpMain, fpRestored);
    const roleProblems = checkRoleAttributes(fpRestored);
    const restoredLast = latestCommitAt(fpRestored);
    s.restored_not_after_t = restoredLast === null || Date.parse(restoredLast) <= Date.parse(pointInTime);
    const timing = computeRpoRto({ pointInTime, lastRestoredCommit: latestCommitAt(fpRestored), requestedAtMs, verifiedAtMs });

    s.rpo_seconds = timing.rpoSeconds;
    s.rto_seconds = timing.rtoSeconds;
    s.rpo_within_target = timing.rpoOk;
    s.rto_within_target = timing.rtoOk;
    s.table_counts_equal = cmp.sections.table_counts === true;
    s.tables_compared = Object.keys(fpRestored.tables).length;
    s.digests_equal =
      cmp.sections.audit_logs_digest === true && cmp.sections.security_events_digest === true && cmp.sections.schema === true;
    s.content_equal = Object.entries(cmp.sections).filter(([k]) => k.startsWith("content_")).every(([, v]) => v === true);
    s.stock_consistency = Object.fromEntries(Object.entries(sc).filter(([k]) => k !== "rls_bypass"));
    s.stock_consistency_ok = scProblems.length === 0;
    s.fingerprints_equal = cmp.equal;
    s.fingerprint_sha256 = fingerprintHash(fpRestored);
    s.sections = cmp.sections;
    s.roles_ok = roleProblems.length === 0;
    s.role_problems = roleProblems;
    ok = cmp.equal && s.restored_not_after_t && s.roles_ok && s.stock_consistency_ok;
    if (!cmp.equal) s.error = `parmak izi farkı: ${cmp.diffs.join("; ")}`.slice(0, 300);
    else if (scProblems.length > 0) s.error = `stok tutarlılık ihlali: ${scProblems.join("; ")}`.slice(0, 300);
  } catch (e) {
    s.error = safeMessage(redactor, e);
    ok = false;
  } finally {
    const c = await cleanupBranch(neon, { name: cfg.branchName, branchId, mainId });
    s.restored_branch_deleted = c.attempted ? c.deleted : branchId === null ? "no-branch-created" : false;
    if (c.error !== null) {
      s.cleanup_error = safeMessage(redactor, c.error);
      ok = false;
    }
  }
  s.result = ok ? "pass" : "fail";
  return s;
}

// ---------------------------------------------------------------------------------------------
// Özet
// ---------------------------------------------------------------------------------------------

/** @param {Record<string, any>} s */
export function renderSummaryMd(s) {
  const yn = (/** @type {boolean | null} */ v) => (v === null ? "-" : v ? "evet" : "hayır");
  const lines = [
    "# Restore tatbikatı (T-130)",
    "",
    `- Sonuç: **${String(s.result).toUpperCase()}**`,
    `- Tarih: ${s.date} · koşu: ${s.run_id}`,
    `- Zaman noktası T: ${s.point_in_time ?? "-"} (geçmiş saklama: ${s.history_retention_seconds ?? "-"} sn)`,
    `- Ölçülen RPO: ${s.rpo_seconds ?? "-"} sn (hedef ≤ ${s.targets.rpo_seconds} sn; hedef içinde: ${yn(s.rpo_within_target)})`,
    `- Ölçülen RTO: ${s.rto_seconds ?? "-"} sn (hedef ≤ ${s.targets.rto_seconds} sn; hedef içinde: ${yn(s.rto_within_target)})`,
    `- Tablo sayıları eşit: ${yn(s.table_counts_equal)} (${s.tables_compared ?? "-"} tablo)`,
    `- Özetler eşit (audit_logs, security_events, şema): ${yn(s.digests_equal)}`,
    `- Stok içerik özetleri eşit: ${yn(s.content_equal)}`,
    `- Restore sonrası stok tutarlılığı (defter=bakiye, rezervasyon=reserved, reserved≤miktar, negatif yok): ${yn(s.stock_consistency_ok)}${s.stock_consistency ? ` (${JSON.stringify(s.stock_consistency)})` : ""}`,
    `- Parmak izleri eşit: ${yn(s.fingerprints_equal)} (sağlama: ${s.fingerprint_sha256 ?? "-"})`,
    `- Geri yüklenen en yeni commit T'den sonra değil: ${yn(s.restored_not_after_t)} · ana dala yazma: ${s.main_writes}`,
    `- Uygulama rolü nitelikleri tamam: ${yn(s.roles_ok)}${s.role_problems && s.role_problems.length > 0 ? ` (${s.role_problems.join("; ")})` : ""}`,
    `- Geçici dal silindi: ${String(s.restored_branch_deleted)}`,
    ...(s.error ? [`- Hata: ${s.error}`] : []),
    ...(s.cleanup_error ? [`- Temizlik hatası: ${s.cleanup_error}`] : []),
    "",
    `Kapsam: ${s.scope}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Özeti yazar ve sızıntı için tarar; sızıntıda dosyalar sızıntısız bir sonuçla değiştirilir.
 * @param {Record<string, any>} s
 * @param {import("./neon-spike.mjs").Redactor} redactor
 * @param {string} [outDir]
 * @returns {{ leaked: boolean }}
 */
export function writeSummary(s, redactor, outDir = OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(s, null, 2)}\n`);
  writeFileSync(path.join(outDir, "summary.md"), renderSummaryMd(s));
  const leaks = scanDirForLeaks(outDir, redactor);
  if (leaks.length === 0) return { leaked: false };
  const stub = { task: "T-130", result: "fail", error: "özette sızıntı tespit edildi; içerik atıldı", scope: SCOPE_NOTE };
  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(stub, null, 2)}\n`);
  writeFileSync(path.join(outDir, "summary.md"), "# Restore tatbikatı (T-130)\n\n- Sonuç: **FAIL** (özette sızıntı tespit edildi; içerik atıldı)\n");
  return { leaked: true };
}

// ---------------------------------------------------------------------------------------------
// Gerçek bağlantılar (Neon API + psql)
// ---------------------------------------------------------------------------------------------

/**
 * @param {Record<string, string | undefined>} env
 * @param {import("./neon-spike.mjs").Redactor} redactor
 * @returns {NeonFacade}
 */
export function createNeonFacade(env, redactor) {
  const { apiKey, projectId } = readNeonEnv(env);
  const api = createNeonProjectApi({ apiKey, projectId, redactor });
  const raw = createNeonApi({ apiKey, projectId, redactor });
  return {
    async resolveMain() {
      const m = await api.resolveMainBranch();
      return { branchId: m.branchId, database: m.database, ownerRole: m.ownerRole, target: m.ownerDirect };
    },
    async getRetentionSeconds() {
      const p = await raw.getProject();
      const v = p?.project?.history_retention_seconds;
      return typeof v === "number" ? v : null;
    },
    async createRestoreBranch({ name, parentId, timestamp }) {
      const r = await raw.request("branch/create", "POST", "/branches", {
        branch: { name, parent_id: parentId, parent_timestamp: timestamp },
        endpoints: [{ type: "read_write" }],
      });
      const id = r?.branch?.id;
      if (typeof id !== "string") throw new DrillError("Neon API branch/create: yanıtta branch.id yok");
      api.mask(id);
      await raw.waitOperations("branch/create", Array.isArray(r?.operations) ? r.operations : []);
      return { branchId: id };
    },
    async connectTarget({ branchId, database, ownerRole }) {
      await api.getReadWriteEndpoint(branchId);
      const uri = await api.getConnectionUri({ branchId, databaseName: database, roleName: ownerRole, pooled: false });
      const t = parsePgUri(uri);
      api.mask(t.password);
      return t;
    },
    async findBranchIdByName(name) {
      const b = (await raw.listBranches()).find((/** @type {any} */ x) => x?.name === name);
      if (typeof b?.id !== "string") return null;
      api.mask(b.id);
      return b.id;
    },
    async getBranchInfo(id) {
      const b = (await raw.listBranches()).find((/** @type {any} */ x) => x?.id === id);
      if (b === undefined) return null;
      return { isDefault: b.default === true, isPrimary: b.primary === true, isProtected: b.protected === true };
    },
    async deleteBranch(id) {
      await raw.deleteBranch(id);
    },
    async branchExists(id) {
      return (await raw.listBranches()).some((/** @type {any} */ x) => x?.id === id);
    },
  };
}

/**
 * @param {import("./neon-spike.mjs").Redactor} redactor
 * @param {typeof runPsql} [psql]
 * @returns {DbFacade}
 */
export function createDbFacade(redactor, psql = runPsql) {
  return {
    fingerprint: (t) => takeFingerprint(t, redactor, { psql }),
    consistency: (t) => takeConsistency(t, redactor, { psql }),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, write?: (s: string) => void }} [o]
 * @returns {Promise<number>} çıkış kodu
 */
export async function main(o = {}) {
  const argv = o.argv ?? process.argv.slice(2);
  const env = o.env ?? process.env;
  const write = o.write ?? ((s) => process.stdout.write(s));
  const redactor = createRedactor();
  const cleanupOnly = argv.includes("--cleanup");
  try {
    const branchName = drillBranchName(env);
    const runId = (env.GITHUB_RUN_ID ?? "").trim();
    const neon = createNeonFacade(env, redactor);
    if (cleanupOnly) {
      const c = await cleanupBranch(neon, { name: branchName, branchId: null, mainId: null });
      if (c.error !== null) {
        write(`restore-drill cleanup: BAŞARISIZ: ${safeMessage(redactor, c.error)}\n`);
        return 1;
      }
      write(`restore-drill cleanup: ${c.attempted ? "geçici dal silindi" : "artık dal yok"}\n`);
      return 0;
    }
    const summary = await runDrill({ neon, db: createDbFacade(redactor), redactor }, { runId, branchName });
    const { leaked } = writeSummary(summary, redactor);
    write(
      `restore-drill: ${leaked ? "FAIL (özette sızıntı)" : String(summary.result).toUpperCase()} · RPO ${summary.rpo_seconds ?? "-"} sn · RTO ${summary.rto_seconds ?? "-"} sn` +
        ` · eşit ${summary.fingerprints_equal} · dal silindi ${String(summary.restored_branch_deleted)}${summary.error ? ` · ${summary.error}` : ""}\n`,
    );
    return summary.result === "pass" && !leaked ? 0 : 1;
  } catch (e) {
    write(`restore-drill: HATA: ${safeMessage(redactor, e)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
