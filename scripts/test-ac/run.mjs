// `pnpm test:ac` planlama, koşturma ve sonuç değerlendirme (T-007).
// Fail-closed: etiketli testi olmayan, gerçekten koşmamış, atlanmış veya koşturulamayan AC
// PASS sayılmaz.
// Karantina (T-008e; PROTOCOL §Karantina kuralı, `scripts/guards/lib/quarantine.mjs`): başlığında
// `@quarantine Q-xx` olan test atlanmaz, normal koşar; sonucu `QUARANTINED_PASS`/`QUARANTINED_FAIL`
// olarak raporlanır. Kırmızısı yalnızca kayıt geçerliyse (kayıtlı, `origin/main`'de birebir,
// süresi içinde, ≤14 gün, kapısı değerlendirilen fazın AC'si değil) kapıyı kırmaz → AC durumu
// `QUARANTINED_FAIL` (engelleyici değil); aksi hâlde normal FAIL.
// Rapor bütünlüğü (T-008j): vitest kendi süreç grubunda (`detached`) koşar; çıkınca grup SIGKILL ile
// sonlandırılır, JSON raporu ANCAK bundan sonra okunur (test kodunun arka planda bıraktığı süreç
// raporu sonradan yeniden yazamaz). Rapordaki sayılar vitest'in kendi özet satırıyla (`Tests …`,
// default reporter, stdout) karşılaştırılır; uyuşmazlık veya özet yoksa koşu güvenilmez → FAIL.
// Sınır: süreç grubundan kaçan (`setsid`/çift fork) süreç bu yolla durdurulamaz; o düzey yalıtım
// ayrı iş/konteyner ister (guards.yml `test-ac` işi PR ağacının dışına, `$RUNNER_TEMP`'e yazar).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadAcceptance } from "./acceptance.mjs";
import { evaluateCondition, loadConditions } from "./conditions.mjs";
import { acTagsOf, evaluateSite, gateAcIdsFor, loadQuarantine, quarantineTags } from "../guards/lib/quarantine.mjs";

/**
 * @typedef {import("./acceptance.mjs").AcceptanceCriterion} AcceptanceCriterion
 * @typedef {import("./conditions.mjs").ConditionsFile} ConditionsFile
 * @typedef {import("./conditions.mjs").ConditionResult} ConditionResult
 * @typedef {import("./collect.mjs").TaggedTest} TaggedTest
 * @typedef {import("./collect.mjs").TestKind} TestKind
 * @typedef {{ type: "phase", phase: string } | { type: "ids", ids: string[] } | { type: "ci" }} Mode
 * @typedef {"PASS" | "FAIL" | "NO_TEST" | "SKIPPED" | "CONDITION_UNKNOWN" | "QUARANTINED_FAIL"} Status
 * @typedef {{
 *   ac: AcceptanceCriterion,
 *   action: "run" | "skip" | "unknown",
 *   gatePhases: string[],
 *   blockOnNoTest: boolean,
 *   condition: ConditionResult | null,
 * }} PlanEntry
 * @typedef {{ file: string, fullName: string, status: string, message?: string }} TestOutcome
 * @typedef {{
 *   id: string,
 *   phase: string,
 *   status: Status,
 *   blocking: boolean,
 *   detail: string,
 *   condition: string | null,
 *   tests: TestOutcome[],
 * }} AcResult
 * @typedef {{ kind: TestKind, ok: boolean, exitCode: number | null, files: string[], error: string | null, outcomes: TestOutcome[], log: string | null }} RunOutcome
 * @typedef {(o: TestOutcome) => string | null} QuarantineJudge karantina kaydı geçersizse neden, geçerliyse `null`
 */

/** T-005a'nın entegrasyon yapılandırması (yoksa `.int.test.` dosyaları koşturulamaz → FAIL). */
export const INT_CONFIG = "vitest.int.config.ts";

/**
 * Modun hangi AC'leri nasıl ele alacağını belirler.
 * @param {AcceptanceCriterion[]} acs
 * @param {ConditionsFile} conds
 * @param {Mode} mode
 * @param {{ pilot: Map<string, import("../lib/pilot.mjs").PilotRow> | null, pilotError?: string | null }} sources
 * @returns {PlanEntry[]}
 */
export function plan(acs, conds, mode, sources) {
  /** @type {PlanEntry[]} */
  const out = [];
  for (const ac of acs) {
    const cond = ac.conditional ? conds.conditions[ac.id] : undefined;
    const condition = cond ? evaluateCondition(cond, { ...sources, facts: conds.facts }) : null;
    if (mode.type === "ids") {
      // Açıkça istenen AC koşuldan bağımsız koşar; koşul yalnızca bilgi olarak raporlanır.
      if (mode.ids.includes(ac.id)) out.push({ ac, action: "run", gatePhases: [ac.phase], blockOnNoTest: true, condition });
      continue;
    }
    if (mode.type === "phase") {
      const P = mode.phase;
      if (!condition) {
        if (ac.phase === P) out.push({ ac, action: "run", gatePhases: [P], blockOnNoTest: true, condition });
        continue;
      }
      if (P === ac.phase) {
        const action = condition.status === "MET" ? "run" : condition.status === "UNMET" ? "skip" : "unknown";
        out.push({ ac, action, gatePhases: [P], blockOnNoTest: true, condition });
      } else if (P === ac.fallbackPhase && condition.status !== "MET") {
        // "3A (koşul yoksa 3B)": koşul sağlanmıyorsa AC 3B kapısına girer; koşul bilinmiyorsa karar verilemez.
        const action = condition.status === "UNMET" ? "run" : "unknown";
        out.push({ ac, action, gatePhases: [P], blockOnNoTest: true, condition });
      }
      continue;
    }
    // CI modu: tüm AC'ler; mevcut etiketli testler her durumda koşar.
    /** @type {string[]} */
    let gatePhases;
    if (!condition || condition.status === "MET") gatePhases = [ac.phase];
    else if (condition.status === "UNMET") gatePhases = ac.fallbackPhase ? [ac.fallbackPhase] : [];
    else gatePhases = [ac.phase, ...(ac.fallbackPhase ? [ac.fallbackPhase] : [])];
    const gated = gatePhases.some((p) => conds.passedGates.includes(p));
    /** @type {PlanEntry["action"]} */
    let action = "run";
    if (condition?.status === "UNMET" && gatePhases.length === 0) action = "skip";
    if (condition?.status === "UNKNOWN") action = "unknown";
    out.push({ ac, action, gatePhases, blockOnNoTest: gated, condition });
  }
  return out;
}

/**
 * @param {string[]} ids
 * @returns {string} Vitest `-t` deseni
 */
export function namePattern(ids) {
  return `@(?:${ids.map((id) => id.replace(/[^A-Za-z0-9-]/g, "")).join("|")})(?![0-9])`;
}

/**
 * @param {string} fullName
 * @param {string} id
 * @returns {boolean}
 */
export function hasTag(fullName, id) {
  return new RegExp(`@${id}(?![0-9])`).test(fullName);
}

/**
 * Vitest JSON raporunu (`JsonTestResults`, vitest 5 tip tanımı) sonuçlara çevirir. Çözümlenemezse `null`.
 * @param {string} json
 * @param {string} root
 * @returns {TestOutcome[] | null}
 */
export function parseVitestReport(json, root) {
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || !Array.isArray(/** @type {{ testResults?: unknown }} */ (data).testResults)) return null;
  /** @type {TestOutcome[]} */
  const out = [];
  const files = /** @type {Array<{ name?: unknown, assertionResults?: unknown }>} */ (/** @type {{ testResults: unknown[] }} */ (data).testResults);
  for (const f of files) {
    const abs = String(f.name ?? "");
    const file = (path.isAbsolute(abs) ? path.relative(root, abs) : abs).split(path.sep).join("/");
    const list = Array.isArray(f.assertionResults) ? f.assertionResults : [];
    for (const a of /** @type {Array<{ fullName?: unknown, status?: unknown, failureMessages?: unknown }>} */ (list)) {
      /** @type {TestOutcome} */
      const o = { file, fullName: String(a.fullName ?? ""), status: String(a.status ?? "") };
      const msgs = Array.isArray(a.failureMessages) ? a.failureMessages : [];
      if (msgs.length > 0) o.message = String(msgs[0]).split("\n")[0] ?? "";
      out.push(o);
    }
  }
  return out;
}

/**
 * @typedef {{ total: number, failed: number, passed: number, expectedFail: number, skipped: number, todo: number }} VitestSummary
 */

/** ANSI renk/biçim kaçışları (GitHub Actions'ta vitest renkli basar). */
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Vitest default reporter'ın son `Tests` özet satırı (vitest 5 `getStateString`:
 * `N failed | N passed | N expected fail | N skipped | N todo (toplam)` veya `no tests`).
 * Bulunamaz veya tanınmayan parça içerirse `null` (fail-closed).
 * @param {string} stdout
 * @returns {VitestSummary | null}
 */
export function parseVitestSummary(stdout) {
  const lines = stdout.replace(ANSI_RE, "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*Tests\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (m === null) continue;
    const body = m[1] ?? "";
    /** @type {VitestSummary} */
    const out = { total: 0, failed: 0, passed: 0, expectedFail: 0, skipped: 0, todo: 0 };
    if (body === "no tests") return out;
    const t = /^(.+) \((\d+)\)$/.exec(body);
    if (t === null) return null;
    out.total = Number(t[2]);
    /** @type {Record<string, keyof VitestSummary>} */
    const keys = { failed: "failed", passed: "passed", "expected fail": "expectedFail", skipped: "skipped", todo: "todo" };
    for (const part of (t[1] ?? "").split(" | ")) {
      const pm = /^(\d+) (failed|passed|expected fail|skipped|todo)$/.exec(part.trim());
      const key = pm === null ? undefined : keys[pm[2] ?? ""];
      if (pm === null || key === undefined) return null;
      out[key] = Number(pm[1]);
    }
    return out;
  }
  return null;
}

/**
 * Vitest stdout'unda `Tests …` özet satırı sayısı (T-008k). Gerçek koşuda tam olarak bir tanedir;
 * 0 (özet yok) veya >1 (başka bir süreç/test sahte özet satırı basmış) güvenilmezdir.
 * @param {string} stdout
 * @returns {number}
 */
export function countSummaryLines(stdout) {
  return stdout.replace(ANSI_RE, "").split(/\r?\n/).filter((l) => /^\s*Tests\s+/.test(l)).length;
}

/**
 * Rapor ↔ özet denetimi (T-008k): önce "tam olarak bir özet satırı" şartı, sonra sayı eşleşmesi.
 * @param {TestOutcome[]} outcomes
 * @param {string} stdout
 * @returns {string | null} uyuşmazlık açıklaması; `null` = güvenilir
 */
export function reportMismatch(outcomes, stdout) {
  const n = countSummaryLines(stdout);
  if (n !== 1) return `vitest stdout'unda tam olarak bir "Tests" özet satırı olmalı (bulunan: ${n})`;
  return summaryMismatch(outcomes, parseVitestSummary(stdout));
}

/**
 * JSON rapor sonuçları vitest özet satırıyla uyuşuyor mu; uyuşmuyorsa açıklama.
 * Eşleme (vitest 5): JSON `failed` = özet failed; JSON `passed` = özet passed + expected fail;
 * toplam = özet toplamı.
 * @param {TestOutcome[]} outcomes
 * @param {VitestSummary | null} summary
 * @returns {string | null}
 */
export function summaryMismatch(outcomes, summary) {
  if (summary === null) return "vitest özet satırı (Tests …) bulunamadı veya çözümlenemedi";
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const passed = outcomes.filter((o) => o.status === "passed").length;
  if (outcomes.length === summary.total && failed === summary.failed && passed === summary.passed + summary.expectedFail) return null;
  return `JSON raporu (toplam ${outcomes.length}, geçen ${passed}, başarısız ${failed}) vitest özetiyle (toplam ${summary.total}, geçen ${summary.passed + summary.expectedFail}, başarısız ${summary.failed}) uyuşmuyor`;
}

/**
 * Vitest'i kendi süreç grubunda koşturur; çıkınca grubu (geride kalan torunlar dahil) SIGKILL ile
 * sonlandırır. Grup zaten boşsa (ESRCH) sorun değildir.
 * @param {string} bin
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} opts
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function spawnIsolated(bin, args, opts) {
  // `detached` (setsid) spawnSync'te de uygulanır; @types/node yalnızca SpawnOptions'ta tanımlar.
  /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding & { detached: boolean }} */
  // `stdio` (T-008k): stdin kapalı; stdout/stderr BU süreçte boru olarak alınır. Alt süreçler (ve
  // torunları) boruyu DEVRALABİLİR ve ona sahte satır yazabilir; bu engellenmez. Savunma
  // `reportMismatch`in "stdout'ta tam olarak bir `Tests` özet satırı" şartıdır: ikinci (sahte) satır
  // ya da eksik satır REPORT_MISMATCH verir. Süreç grubu sonlandırması (aşağıda) yalnızca artık
  // süreçleri temizler, çıktı bütünlüğünü sağlamaz.
  const options = { cwd: opts.cwd, env: opts.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, detached: true, stdio: ["ignore", "pipe", "pipe"] };
  const r = spawnSync(bin, args, options);
  if (typeof r.pid === "number" && r.pid > 0) {
    try {
      process.kill(-r.pid, "SIGKILL");
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ESRCH") throw e;
    }
  }
  return r;
}

/**
 * Bir test türü için koşturma. Vitest dosya listesi + `-t` ad filtresiyle koşar, JSON raporunu okur.
 * @param {{ root: string, kind: TestKind, files: string[], ids: string[], artifactDir: string, name: string, vitestBin: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {RunOutcome}
 */
export function runKind({ root, kind, files, ids, artifactDir, name, vitestBin, env }) {
  if (kind === "playwright") {
    const installed = existsSync(path.join(root, "node_modules/@playwright/test/package.json"));
    const error = installed
      ? "Playwright koşturma yolu henüz yok: Playwright'ı kuran Faz 1 kartı JSON raporu kurulu tip tanımıyla doğrulayıp ekler (fail-closed)"
      : "Playwright etiketi bulundu ama @playwright/test kurulu değil (Faz 1)";
    return { kind, ok: false, exitCode: null, files, error, outcomes: [], log: null };
  }
  /** @type {string[]} */
  const configArgs = [];
  if (kind === "int") {
    if (!existsSync(path.join(root, INT_CONFIG))) {
      return { kind, ok: false, exitCode: null, files, error: `${INT_CONFIG} yok (T-005a); entegrasyon testi koşturulamadı`, outcomes: [], log: null };
    }
    configArgs.push("--config", INT_CONFIG);
  }
  const jsonFile = path.join(artifactDir, `${name}.${kind}.vitest.json`);
  const logFile = path.join(artifactDir, `${name}.${kind}.log`);
  rmSync(jsonFile, { force: true });
  const args = [
    "run",
    ...configArgs,
    "--root",
    root,
    "--reporter=json",
    `--outputFile.json=${jsonFile}`,
    "--reporter=default",
    "-t",
    namePattern(ids),
    ...files,
  ];
  const r = spawnIsolated(vitestBin, args, { cwd: root, env: env ?? process.env });
  const spawnError = r.error ? `\n[spawn hatası] ${r.error.message}` : "";
  writeFileSync(logFile, `$ ${[vitestBin, ...args].join(" ")}\n[çıkış ${r.status}]\n--- stdout ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}${spawnError}\n`);
  const relLog = path.relative(root, logFile).split(path.sep).join("/");
  let json = "";
  try {
    json = readFileSync(jsonFile, "utf8");
  } catch {
    // Rapor yoksa aşağıda hata olarak işlenir.
  }
  const outcomes = parseVitestReport(json, root);
  if (!outcomes) {
    return { kind, ok: false, exitCode: r.status, files, error: `vitest JSON raporu okunamadı (çıkış ${r.status}), bkz. ${relLog}`, outcomes: [], log: relLog };
  }
  const mismatch = reportMismatch(outcomes, r.stdout ?? "");
  if (mismatch !== null) {
    return { kind, ok: false, exitCode: r.status, files, error: `REPORT_MISMATCH: ${mismatch}, bkz. ${relLog}`, outcomes: [], log: relLog };
  }
  // Çıkış ≠ 0 ama raporda başarısız test yoksa (yakalanmamış hata, yükleme hatası) tüm koşu güvenilmez.
  const explained = outcomes.some((o) => o.status === "failed");
  if (r.status !== 0 && !explained) {
    return { kind, ok: false, exitCode: r.status, files, error: `vitest çıkış ${r.status} (başarısız test yok; yakalanmamış hata?), bkz. ${relLog}`, outcomes, log: relLog };
  }
  return { kind, ok: true, exitCode: r.status, files, error: null, outcomes, log: relLog };
}

/**
 * Planı koşturur ve AC sonuçlarını üretir.
 * @param {PlanEntry[]} entries
 * @param {Map<string, TaggedTest[]>} tagsById
 * @param {{ root: string, artifactDir: string, name: string, vitestBin: string, env?: NodeJS.ProcessEnv, mode: Mode }} opts
 * @returns {{ results: AcResult[], runs: RunOutcome[] }}
 */
export function execute(entries, tagsById, opts) {
  const toRun = entries.filter((e) => e.action === "run" || (opts.mode.type === "ci" && (tagsById.get(e.ac.id)?.length ?? 0) > 0));
  /** @type {Map<TestKind, { files: Set<string>, ids: Set<string> }>} */
  const byKind = new Map();
  for (const e of toRun) {
    for (const t of tagsById.get(e.ac.id) ?? []) {
      const g = byKind.get(t.kind) ?? { files: new Set(), ids: new Set() };
      g.files.add(t.file);
      g.ids.add(e.ac.id);
      byKind.set(t.kind, g);
    }
  }
  /** @type {RunOutcome[]} */
  const runs = [];
  for (const kind of /** @type {TestKind[]} */ (["unit", "int", "playwright"])) {
    const g = byKind.get(kind);
    if (!g) continue;
    runs.push(runKind({ ...opts, kind, files: [...g.files].sort(), ids: [...g.ids].sort() }));
  }
  const judge = quarantineJudge(opts.root, opts.mode);
  const results = entries.map((e) => resultFor(e, tagsById.get(e.ac.id) ?? [], runs, opts.mode, judge));
  return { results, runs };
}

/**
 * Karantina geçerlilik yargıcı (tembel: kayıt, `main` ve kapı fazı ilk karantinalı testte okunur).
 * Kapı AC kümesi: `currentGatePhase` ∪ `passedGates` (+ `--phase P` ise P).
 * @param {string} root
 * @param {Mode} mode
 * @returns {QuarantineJudge}
 */
export function quarantineJudge(root, mode) {
  /** @type {{ state: import("../guards/lib/quarantine.mjs").QuarantineState, gateAcs: Set<string> | null, gateError: string | null } | null} */
  let ctx = null;
  return (o) => {
    if (ctx === null) {
      /** @type {Set<string> | null} */
      let gateAcs = null;
      /** @type {string | null} */
      let gateError = null;
      try {
        const acs = loadAcceptance(root);
        gateAcs = gateAcIdsFor(acs, loadConditions(root, acs), mode.type === "phase" ? [mode.phase] : []);
      } catch (e) {
        gateError = e instanceof Error ? e.message : String(e);
      }
      ctx = { state: loadQuarantine(root), gateAcs, gateError };
    }
    const findings = evaluateSite({ file: o.file, title: o.fullName, acIds: acTagsOf(o.fullName) }, ctx.state, { gateAcs: ctx.gateAcs, gateError: ctx.gateError, withDates: true });
    return findings.length === 0 ? null : findings.map((f) => `${f.code}: ${f.message}`).join("; ");
  };
}

/**
 * Test başlığı karantina etiketi taşıyor mu.
 * @param {TestOutcome} o
 * @returns {boolean}
 */
function isQuarantined(o) {
  const t = quarantineTags(o.fullName);
  return t.ids.length > 0 || t.bare;
}

/**
 * @param {PlanEntry} e
 * @param {TaggedTest[]} tags
 * @param {RunOutcome[]} runs
 * @param {Mode} mode
 * @param {QuarantineJudge} judge
 * @returns {AcResult}
 */
function resultFor(e, tags, runs, mode, judge) {
  const { ac, condition } = e;
  const phase = ac.fallbackPhase ? `${ac.phase} (koşul yoksa ${ac.fallbackPhase})` : ac.phase;
  const condText = ac.condition ?? null;
  const gateNote = e.gatePhases.length > 0 ? e.gatePhases.join("/") : "—";
  /** @param {Status} status @param {boolean} blocking @param {string} detail @param {TestOutcome[]} [tests] @returns {AcResult} */
  const res = (status, blocking, detail, tests = []) => ({ id: ac.id, phase, status, blocking, detail, condition: condText, tests });

  const ranBecauseTestsExist = mode.type === "ci" && tags.length > 0;
  if (e.action === "skip" && !ranBecauseTestsExist) {
    return res("SKIPPED", false, condition?.detail ?? "");
  }
  if (e.action === "unknown" && !ranBecauseTestsExist) {
    const blocking = mode.type !== "ci" || e.blockOnNoTest;
    const info = blocking ? "" : ` — bilgi: faz ${gateNote} kapısı geçilmedi`;
    return res("CONDITION_UNKNOWN", blocking, `${condition?.detail ?? ""}${info}`);
  }
  if (tags.length === 0) {
    const info = e.blockOnNoTest ? "" : ` — bilgi: faz ${gateNote} kapısı henüz geçilmedi (--ci)`;
    return res("NO_TEST", e.blockOnNoTest, `@${ac.id} etiketli test yok${info}`);
  }
  const condInfo = condition ? ` [koşul ${condition.status}: ${condition.detail}]` : "";
  /** @type {string[]} */
  const problems = [];
  /** @type {TestOutcome[]} */
  const tests = [];
  for (const kind of new Set(tags.map((t) => t.kind))) {
    const run = runs.find((r) => r.kind === kind);
    if (!run) {
      problems.push(`${kind} koşusu yapılmadı`);
      continue;
    }
    if (run.error) problems.push(run.error);
    const mine = run.outcomes.filter((o) => hasTag(o.fullName, ac.id));
    tests.push(...mine);
    for (const file of new Set(tags.filter((t) => t.kind === kind).map((t) => t.file))) {
      if (!mine.some((o) => o.file === file)) problems.push(`${file}: etiketli test koşmadı (yapılandırma kapsamı dışında veya yüklenemedi)`);
    }
  }
  const failed = tests.filter((o) => o.status === "failed");
  const skipped = tests.filter((o) => o.status !== "failed" && o.status !== "passed");
  const passed = tests.filter((o) => o.status === "passed");
  /** Karantina rapor satırları (geçerli/geçersiz fark etmeksizin her karantinalı test). */
  /** @type {string[]} */
  const quarantine = [];
  let quarantinedFails = 0;
  for (const p of passed.filter(isQuarantined)) quarantine.push(`QUARANTINED_PASS ${p.file} › ${p.fullName}`);
  for (const f of failed) {
    const msg = `${f.file} › ${f.fullName}${f.message ? ` — ${f.message}` : ""}`;
    if (!isQuarantined(f)) {
      problems.push(`başarısız: ${msg}`);
      continue;
    }
    const invalid = judge(f);
    quarantine.push(`QUARANTINED_FAIL ${msg}${invalid === null ? " (kayıt geçerli; kapıyı kırmaz)" : ""}`);
    if (invalid === null) quarantinedFails++;
    else problems.push(`başarısız (karantina geçersiz: ${invalid}): ${msg}`);
  }
  for (const s of skipped) problems.push(`atlanmış (${s.status}): ${s.file} › ${s.fullName} — skip/todo kabul edilmez`);
  if (passed.length === 0 && quarantinedFails === 0 && problems.length === 0) problems.push("gerçekten koşan test 0");
  const qInfo = quarantine.length > 0 ? ` [karantina: ${quarantine.join("; ")}]` : "";
  if (problems.length > 0) return res("FAIL", true, `${problems.join("; ")}${qInfo}${condInfo}`, tests);
  if (quarantinedFails > 0) return res("QUARANTINED_FAIL", false, `${passed.length} test geçti, ${quarantinedFails} karantinalı test başarısız${qInfo}${condInfo}`, tests);
  return res("PASS", false, `${passed.length} test${qInfo}${condInfo}`, tests);
}

/**
 * Tek satırlık AC çıktısı.
 * @param {AcResult} r
 * @returns {string}
 */
export function formatResult(r) {
  const label = r.status === "SKIPPED" ? `SKIPPED(koşul: ${r.condition ?? "?"})` : r.status;
  return `${r.id.padEnd(6)} ${label}${r.detail ? ` — ${r.detail}` : ""}`;
}

/**
 * @param {AcResult[]} results
 * @param {string[]} errors
 * @returns {{ ok: boolean, summary: string }}
 */
export function summarizeResults(results, errors) {
  /** @type {Record<Status, number>} */
  const counts = { PASS: 0, FAIL: 0, NO_TEST: 0, SKIPPED: 0, CONDITION_UNKNOWN: 0, QUARANTINED_FAIL: 0 };
  for (const r of results) counts[r.status]++;
  const blocking = results.filter((r) => r.blocking).length + errors.length;
  const ok = blocking === 0;
  // QUARANTINED_FAIL yalnızca varsa gösterilir (T-008e; önceki özet biçimi korunur).
  const parts = Object.entries(counts)
    .filter(([k, v]) => k !== "QUARANTINED_FAIL" || v > 0)
    .map(([k, v]) => `${k} ${v}`);
  const err = errors.length > 0 ? ` · HATA ${errors.length}` : "";
  return { ok, summary: `${results.length} AC · ${parts.join(" · ")}${err} → ${ok ? "OK" : `KIRMIZI (${blocking} engelleyici)`}` };
}
