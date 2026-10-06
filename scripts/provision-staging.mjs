#!/usr/bin/env node
// T-105 — Staging veritabanı hazırlığı (`.github/workflows/provision-staging.yml`). YALNIZCA GitHub Actions'ta
// (ajan ortamından Neon/Fly'a erişim yok, ADR-013).
//
// Akış: (1) Neon ana dalı + sahip rol bağlantıları (scripts/neon-api.mjs; hepsi maskelenir) → (2) Fly sır ADLARI
// (`flyctl secrets list --json`; değer okunamaz) → (3) `wms_identity_probe` (NOLOGIN) + migration rolü üyeliği
// (ADR-015 §4, 3./5. tur ekleri; örtük ADMIN için A-67) → (4) uygulama rolleri `wms_app`, `wms_auth`, `wms_worker` ve
// katalogdan nitelik denetimi → (5) YALNIZCA hepsi yeşilse Fly sırları tek `flyctl secrets import --stage` çağrısıyla
// (stdin; argv/log'da değer yok). Probe OK değilse 4. adım SALT-OKURDUR (CREATE/ALTER/API yazımı yok): çalışan staging
// bağlantıları, Fly'a yazılamayacak parola değişimiyle bayatlamasın.
//
// Rol yolu: varsayılan `sql` (A-66, Supervisor kararı): roller dal sahibi rolle `CREATE ROLE … PASSWORD` ile yaratılır;
// parola koşu başına rastgele (256 bit), yalnızca bu süreçte üretilir, maskelenir ve düz metin olarak CREATE/ALTER ROLE
// içinde sunucuya gider (Neon SQL'de SCRAM verifier kabul etmez, A-56; kalan risk: Neon log_statement/pg_stat_statements).
// Tüm CREATE/ALTER ifadeleri TEK transaction'dadır (kısmi başarısızlıkta hiçbiri uygulanmaz). `--role-path api`: Neon API
// ile yaratılan roller `neon_superuser` üyesidir (BYPASSRLS, CREATEROLE …); nitelik denetimi bunu yakalar → BLOCKED
// (çıkış 2), bu koşuda yaratılan rol silinir, Fly'a HİÇBİR sır yazılmaz. `--role-path sql` için `--sql-decision <id>`
// (varsayılan A-66) ve docs/OPEN_QUESTIONS.md'de o kimlikli, "T-105" ve "SQL CREATE ROLE" geçen karar satırı gerekir.
//
// Sır kapsamı (G-09): tüm gizli değerler `::add-mask::` + kendi maskeleyicimiz; alt süreç ortamları daraltılır
// (flyctl yalnızca FLY_API_TOKEN, psql yalnızca bağlantı bilgisi). Özet yalnızca `.artifacts/t-105/summary.{json,md}`
// ve sır ADLARINI içerir; yazıldıktan sonra sızıntı için taranır.
//
// Çıkış kodu: 0 yeşil · 1 kırmızı (hata/sapma/sızıntı) · 2 BLOCKED (karar/yeniden açma gerekir).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRedactor, maskSecret, pgUrl, runPsql, scanDirForLeaks } from "./neon-spike.mjs";
import { createNeonProjectApi, readNeonEnv } from "./neon-api.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(ROOT, ".artifacts", "t-105");
export const FLY_APP = "etkin-wms-staging";
export const BETTER_AUTH_URL = "https://etkin-wms-staging.fly.dev";
export const PROBE_ROLE = "wms_identity_probe";
/** Uygulama rolleri ve Fly sırrı (hepsi pooled host; worker da transaction-mode pooler'dan, STACK.md pg-boss). */
export const APP_ROLES = Object.freeze([
  { role: "wms_app", secret: "DATABASE_URL" },
  { role: "wms_auth", secret: "AUTH_DATABASE_URL" },
  { role: "wms_worker", secret: "DATABASE_URL_WORKER" },
]);
/** Fly'da bulunmaması gereken sır (sahip/migration URI'si uygulama süreçlerine verilmez; Supervisor eki (e)). */
export const FORBIDDEN_FLY_SECRETS = Object.freeze(["DATABASE_URL_DIRECT", "STAGING_DATABASE_URL_DIRECT"]);
export const MIN_DEMO_PASSWORD_LENGTH = 16;
/** Varsayılan SQL rol yolu karar kaydı (docs/OPEN_QUESTIONS.md A-66). */
export const DEFAULT_SQL_DECISION = "A-66";

/** Neon/Postgres tanımlayıcısı olarak güvenle tırnaklanabilen ad. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** @param {string} name */
export function quoteIdent(name) {
  if (!IDENT_RE.test(name)) throw new Error("güvensiz tanımlayıcı reddedildi");
  return `"${name}"`;
}

// ---------------------------------------------------------------------------------------------
// Girdiler
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{
 *   rotate: boolean, rotateAuthSecret: boolean, rotateSealKey: boolean,
 *   rolePath: "api" | "sql", sqlDecision: string | null,
 * }} Flags
 */

/**
 * @param {string[]} argv
 * @returns {Flags}
 */
export function parseArgs(argv) {
  /** @type {Flags} */
  const f = { rotate: false, rotateAuthSecret: false, rotateSealKey: false, rolePath: "sql", sqlDecision: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rotate") f.rotate = true;
    else if (a === "--rotate-auth-secret") f.rotateAuthSecret = true;
    else if (a === "--rotate-seal-key") f.rotateSealKey = true;
    else if (a === "--role-path") {
      const v = argv[++i];
      if (v !== "api" && v !== "sql") throw new Error("--role-path api|sql olmalı");
      f.rolePath = v;
    } else if (a === "--sql-decision") {
      const v = argv[++i];
      if (typeof v !== "string" || !/^[AQ]-\d+$/.test(v)) throw new Error("--sql-decision <A-xx|Q-xx> olmalı");
      f.sqlDecision = v;
    } else throw new Error(`bilinmeyen argüman: ${String(a)}`);
  }
  // Varsayılan rol yolu `sql` + A-66 (Supervisor kararı: Neon API rolleri neon_superuser üyesi). `--role-path api` açıkça seçilir.
  if (f.rolePath === "sql" && f.sqlDecision === null) f.sqlDecision = DEFAULT_SQL_DECISION;
  return f;
}

/**
 * Supervisor karar satırı: `<id> | … T-105 … SQL CREATE ROLE …` (OPEN_QUESTIONS.md).
 * @param {string} id
 * @param {string} openQuestionsText
 */
export function sqlDecisionRecorded(id, openQuestionsText) {
  return openQuestionsText
    .split(/\r?\n/)
    .some((l) => l.startsWith(`${id} |`) && l.includes("T-105") && l.includes("SQL CREATE ROLE"));
}

// ---------------------------------------------------------------------------------------------
// Rastgele değerler
// ---------------------------------------------------------------------------------------------

/** @typedef {(n: number) => Buffer} RandFn */

/** @type {RandFn} */
const defaultRand = (n) => randomBytes(n);

/** Rol parolası (yalnızca SQL yolu): 32 bayt, base64url (tırnak/ters eğik çizgi içermez). @param {RandFn} rand */
export function genRolePassword(rand) {
  return rand(32).toString("base64url");
}
/** @param {RandFn} rand */
export const genAuthSecret = (rand) => rand(32).toString("hex");
/** @param {RandFn} rand */
export const genSealKey = (rand) => rand(32).toString("hex");
/** 18 bayt → 24 karakter base64url (≥ 16). @param {RandFn} rand */
export const genDemoPassword = (rand) => rand(18).toString("base64url");

// ---------------------------------------------------------------------------------------------
// Katalog denetimleri
// ---------------------------------------------------------------------------------------------

/** Uygulama rollerinin katalog sorgusu: nitelikler + (dolaylı) üyelik sayısı + sahip olunan nesne sayısı. */
export function appRolesCheckSql() {
  const names = APP_ROLES.map((r) => `'${r.role}'`).join(", ");
  return `SELECT 'role', r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
 (SELECT count(*) FROM pg_roles g WHERE g.oid <> r.oid AND pg_has_role(r.oid, g.oid, 'MEMBER')),
 (SELECT count(*) FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o')
FROM pg_roles r WHERE r.rolname IN (${names}) ORDER BY r.rolname;`;
}

/** Probe rolü + üyelikler + m1 + sahip rol bilgisi. */
export function probeCheckSql() {
  // Düz şablon (ifade yok): tanımlayıcı `wms_identity_probe` sabittir (PROBE_ROLE ile aynı).
  return `SELECT 'attr', rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
FROM pg_roles WHERE rolname = 'wms_identity_probe';
SELECT 'member', mr.rolname, m.admin_option, m.inherit_option, m.set_option, g.rolname
FROM pg_auth_members m JOIN pg_roles pr ON pr.oid = m.roleid JOIN pg_roles mr ON mr.oid = m.member
JOIN pg_roles g ON g.oid = m.grantor WHERE pr.rolname = 'wms_identity_probe' ORDER BY 2, 6;
SELECT 'm1', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_identity_probe')
  THEN pg_has_role(current_user, 'wms_identity_probe', 'MEMBER WITH ADMIN OPTION') ELSE false END;
SELECT 'owner', current_user, r.rolsuper, r.rolbypassrls, r.rolcreaterole FROM pg_roles r WHERE r.rolname = current_user;`;
}

/** @param {string} stdout @returns {string[][]} */
function rows(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => l.split("|"));
}

/**
 * @param {string} v
 * @returns {boolean}
 */
const tf = (v) => v === "t";

/**
 * @param {string} stdout
 * @returns {{ role: string, login: boolean, super: boolean, bypassrls: boolean, createdb: boolean, createrole: boolean,
 *   replication: boolean, memberships: number, owned: number }[]}
 */
export function parseAppRoles(stdout) {
  return rows(stdout)
    .filter((c) => c[0] === "role" && c.length >= 10)
    .map((c) => ({
      role: String(c[1]),
      login: tf(String(c[2])),
      super: tf(String(c[3])),
      bypassrls: tf(String(c[4])),
      createdb: tf(String(c[5])),
      createrole: tf(String(c[6])),
      replication: tf(String(c[7])),
      memberships: Number(c[8]),
      owned: Number(c[9]),
    }));
}

/**
 * Beklenen: LOGIN, diğer nitelikler yok, hiçbir role (dolaylı dahil, neon_superuser dahil) üye değil, sahip olunan nesne 0.
 * Sapma listesi yalnızca nitelik ADLARI içerir.
 * @param {ReturnType<typeof parseAppRoles>[number] | undefined} r
 * @returns {string[]}
 */
export function appRoleDeviations(r) {
  if (!r) return ["missing"];
  /** @type {string[]} */
  const d = [];
  if (!r.login) d.push("nologin");
  if (r.super) d.push("superuser");
  if (r.bypassrls) d.push("bypassrls");
  if (r.createdb) d.push("createdb");
  if (r.createrole) d.push("createrole");
  if (r.replication) d.push("replication");
  if (!Number.isFinite(r.memberships) || r.memberships !== 0) d.push("member-of-role");
  if (!Number.isFinite(r.owned) || r.owned !== 0) d.push("owns-objects");
  return d;
}

/**
 * @param {string} stdout
 */
export function parseProbeCheck(stdout) {
  const all = rows(stdout);
  const attr = all.find((c) => c[0] === "attr" && c.length >= 8);
  const owner = all.find((c) => c[0] === "owner" && c.length >= 5);
  const m1 = all.find((c) => c[0] === "m1" && c.length >= 2);
  return {
    exists: attr !== undefined,
    attrs: attr
      ? { login: tf(String(attr[2])), super: tf(String(attr[3])), bypassrls: tf(String(attr[4])), createdb: tf(String(attr[5])), createrole: tf(String(attr[6])), replication: tf(String(attr[7])) }
      : null,
    members: all
      .filter((c) => c[0] === "member" && c.length >= 6)
      .map((c) => ({ member: String(c[1]), admin: tf(String(c[2])), inherit: tf(String(c[3])), set: tf(String(c[4])), grantor: String(c[5]) })),
    indirectAdmin: m1 ? tf(String(m1[1])) : null,
    owner: owner ? { name: String(owner[1]), super: tf(String(owner[2])), bypassrls: tf(String(owner[3])), createrole: tf(String(owner[4])) } : null,
  };
}

/**
 * ADR-015 5. tur eki MINOR-6 kural 1 (tüm `pg_auth_members` satırları) + 3. tur m1 (dolaylı ADMIN yok).
 * @param {ReturnType<typeof parseProbeCheck>} p
 * @param {string} migrationRole
 * @param {{ waiveOwnerAdmin?: boolean }} [opts] A-67: yalnızca sahip rolün kendi ADMIN'i (doğrudan satır / dolaylı m1) WARN sayılır;
 *   çağıran bunu yalnızca sahip rolün rolbypassrls=true VE rolcreaterole=true olduğunda açar.
 * @returns {{ ok: boolean, problems: string[], warnings: string[], adminOnly: string[] }}
 */
export function evaluateProbe(p, migrationRole, opts = {}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const adminOnly = [];
  /** @type {string[]} */
  const warnings = [];
  /** @param {string} id */
  const ownerAdmin = (id) => (opts.waiveOwnerAdmin ? warnings.push(id) : problems.push(id));
  if (!p.exists || !p.attrs) return { ok: false, problems: ["probe-missing"], warnings, adminOnly };
  const a = p.attrs;
  if (a.login) problems.push("probe-login");
  if (a.super) problems.push("probe-superuser");
  if (a.bypassrls) problems.push("probe-bypassrls");
  if (a.createdb) problems.push("probe-createdb");
  if (a.createrole) problems.push("probe-createrole");
  if (a.replication) problems.push("probe-replication");
  const mine = p.members.filter((m) => m.member === migrationRole);
  const others = p.members.filter((m) => m.member !== migrationRole);
  if (mine.length === 0) problems.push("migration-role-not-member");
  if (mine.some((m) => m.inherit)) problems.push("migration-role-inherit");
  if (mine.some((m) => m.admin)) ownerAdmin("migration-role-admin-option");
  if (mine.length > 0 && !mine.some((m) => m.set)) problems.push("migration-role-no-set");
  for (const m of others) {
    if (m.set || m.inherit) problems.push(`other-member-set-or-inherit:${m.member}`);
    else if (APP_ROLES.some((r) => r.role === m.member)) problems.push(`app-role-member:${m.member}`);
    else if (m.admin) adminOnly.push(m.member);
  }
  if (p.indirectAdmin === true) ownerAdmin("migration-role-indirect-admin");
  else if (p.indirectAdmin !== false) problems.push("indirect-admin-unknown");
  return { ok: problems.length === 0, problems, warnings, adminOnly };
}

// ---------------------------------------------------------------------------------------------
// Probe rolü (altyapı adımı; ADR-015 §4)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {(sql: string) => { ok: boolean, stdout: string, sqlstate: string | null, error: string | null }} PsqlFn
 */

/**
 * `wms_identity_probe` oluşturur/doğrular. Yol A (ADR-015 5. tur eki): oturumda `createrole_self_grant` boş,
 * sahip/migration rolü oluşturur, `GRANT … WITH ADMIN FALSE, SET TRUE, INHERIT FALSE`, örtük ADMIN satırı için
 * `REVOKE ADMIN OPTION FOR` (her yetki veren için `GRANTED BY` denemesi). Denetim hâlâ kırmızıysa: bu koşuda
 * yaratıldıysa rol silinir (artık bırakılmaz) ve BLOCKED döner; ADR-015 yeniden açılır (yol B: migration rolü dışında
 * bir altyapı rolü — ayrı Supervisor kararı).
 * @param {{ psql: PsqlFn, migrationRole: string, say: (s: string) => void }} o
 * @returns {{ status: "OK" | "BLOCKED" | "RED", warn: boolean, warnings: string[], line: string, problems: string[], adminOnly: string[], created: boolean,
 *   ownerSuper: boolean | null, ownerBypassrls: boolean | null, attempts: string[] }}
 */
export function ensureProbe(o) {
  const owner = quoteIdent(o.migrationRole);
  /** @type {string[]} */
  const attempts = [];
  const inspect = () => {
    const r = o.psql(probeCheckSql());
    if (!r.ok) return { err: r.error ?? "psql hatası", p: null };
    return { err: null, p: parseProbeCheck(r.stdout) };
  };
  /** @param {string} line @param {string[]} problems */
  const red = (line, problems, extra = {}) => ({
    status: /** @type {const} */ ("RED"),
    warn: false,
    warnings: [],
    line,
    problems,
    adminOnly: [],
    created: false,
    ownerSuper: null,
    ownerBypassrls: null,
    attempts,
    ...extra,
  });

  let first = inspect();
  if (first.p === null) return red(`${PROBE_ROLE}: FAIL (katalog sorgusu başarısız)`, ["inspect-failed"]);
  const ownerSuper = first.p.owner?.super ?? null;
  const ownerBypassrls = first.p.owner?.bypassrls ?? null;
  let created = false;
  /** Bu koşuda yaratılan probe, sonraki bir adım başarısızsa artık bırakılmaz. */
  const dropIfCreated = () => {
    if (!created) return;
    const d = o.psql(`DROP ROLE ${PROBE_ROLE};`);
    attempts.push(`cleanup-drop-probe:${d.ok ? "ok" : (d.sqlstate ?? "error")}`);
  };
  if (!first.p.exists) {
    // Transaction-yerel `createrole_self_grant` boş: örtük üyelik yalnızca ADMIN olur (ADR-015 5. tur eki MINOR-6).
    const c = o.psql(`BEGIN;
SET LOCAL createrole_self_grant = '';
CREATE ROLE ${PROBE_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT ${PROBE_ROLE} TO ${owner} WITH ADMIN FALSE, SET TRUE, INHERIT FALSE;
COMMIT;`);
    attempts.push(`create+grant:${c.ok ? "ok" : (c.sqlstate ?? "error")}`);
    if (!c.ok) return red(`${PROBE_ROLE}: FAIL (oluşturma/üyelik SQLSTATE ${c.sqlstate ?? "?"})`, ["create-failed"], { ownerSuper, ownerBypassrls });
    created = true;
    first = inspect();
    if (first.p === null) {
      dropIfCreated();
      return red(`${PROBE_ROLE}: FAIL (katalog sorgusu başarısız)`, ["inspect-failed"], { created, ownerSuper, ownerBypassrls });
    }
  }
  let ev = evaluateProbe(first.p, o.migrationRole);
  let finalProbe = first.p;
  if (!ev.ok && ev.problems.some((p) => p === "migration-role-admin-option" || p === "migration-role-indirect-admin")) {
    // Örtük ADMIN satırlarını her yetki veren için geri almayı dene (başarısızlık beklenen/olası; sonuç katalogdan okunur).
    const grantors = [...new Set(first.p.members.filter((m) => m.member === o.migrationRole && m.admin).map((m) => m.grantor))];
    const stmts = [`REVOKE ADMIN OPTION FOR ${PROBE_ROLE} FROM ${owner};`];
    for (const g of grantors) {
      try {
        stmts.push(`REVOKE ADMIN OPTION FOR ${PROBE_ROLE} FROM ${owner} GRANTED BY ${quoteIdent(g)};`);
      } catch {
        attempts.push("revoke-admin:skipped-unsafe-grantor");
      }
    }
    for (const s of stmts) {
      const r = o.psql(s);
      attempts.push(`revoke-admin:${r.ok ? "ok" : (r.sqlstate ?? "error")}`);
    }
    const again = inspect();
    if (again.p === null) {
      dropIfCreated();
      return red(`${PROBE_ROLE}: FAIL (katalog sorgusu başarısız)`, ["inspect-failed"], { created, ownerSuper, ownerBypassrls });
    }
    ev = evaluateProbe(again.p, o.migrationRole);
    finalProbe = again.p;
  }
  // A-67: örtük ADMIN kaldırılamıyorsa yalnızca sahip rol bypassrls VE createrole ise WARN (gerekçeli); aksi halde FAIL.
  const waive = finalProbe.owner?.bypassrls === true && finalProbe.owner?.createrole === true;
  if (!ev.ok || ev.warnings.length > 0) ev = evaluateProbe(finalProbe, o.migrationRole, { waiveOwnerAdmin: waive });
  if (ev.ok && ev.warnings.length > 0) {
    return {
      status: "OK",
      warn: true,
      line: `${PROBE_ROLE}: WARN (set, noinherit; sahip rolün örtük ADMIN'i kaldırılamadı — A-67: sahip rol zaten BYPASSRLS + CREATEROLE)`,
      problems: [],
      warnings: ev.warnings,
      adminOnly: ev.adminOnly,
      created,
      ownerSuper,
      ownerBypassrls,
      attempts,
    };
  }
  if (ev.ok) {
    return {
      status: "OK",
      warn: false,
      warnings: [],
      line: `${PROBE_ROLE}: OK (set, noinherit, noadmin)`,
      problems: [],
      adminOnly: ev.adminOnly,
      created,
      ownerSuper,
      ownerBypassrls,
      attempts,
    };
  }
  dropIfCreated();
  return {
    status: "BLOCKED",
    warn: false,
    warnings: [],
    line: `${PROBE_ROLE}: BLOCKED (${ev.problems.join(", ")}) — ADR-015 5. tur eki MINOR-6 yeniden açılır`,
    problems: ev.problems,
    adminOnly: ev.adminOnly,
    created,
    ownerSuper,
    ownerBypassrls,
    attempts,
  };
}

// ---------------------------------------------------------------------------------------------
// Uygulama rolleri
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{
 *   createRole: (branchId: string, name: string) => Promise<string>,
 *   resetRolePassword: (branchId: string, name: string) => Promise<string>,
 *   deleteRole: (branchId: string, name: string) => Promise<void>,
 * }} RoleApi
 */

/**
 * Hangi roller için yeni parola gerekir: rol yok, `--rotate`, ya da rolün Fly sırrı yok (Fly sırrı okunamaz; yoksa
 * parola bilinmez). Parola yalnızca yeni üretildiğinde Fly'a yazılır.
 * @param {{ exists: Set<string>, flySecrets: Set<string>, rotate: boolean }} o
 * @returns {{ role: string, secret: string, create: boolean, needPassword: boolean }[]}
 */
export function planRoles(o) {
  return APP_ROLES.map((s) => {
    const create = !o.exists.has(s.role);
    return { role: s.role, secret: s.secret, create, needPassword: create || o.rotate || !o.flySecrets.has(s.secret) };
  });
}

/**
 * @param {{
 *   psql: PsqlFn, api: RoleApi, branchId: string, flags: Flags, flySecrets: Set<string>, rand: RandFn,
 *   mask: (v: string) => void, say: (s: string) => void, readOnly?: boolean,
 * }} o
 * @returns {Promise<{ status: "OK" | "BLOCKED" | "RED", lines: string[], passwords: Map<string, string>,
 *   deviations: Record<string, string[]>, created: string[], rotated: string[], note: string | null }>}
 */
export async function ensureAppRoles(o) {
  /** @type {string[]} */
  const lines = [];
  /** @type {Record<string, string[]>} */
  const deviations = {};
  const passwords = new Map();
  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const rotated = [];
  /** @param {"BLOCKED" | "RED"} status @param {string} note */
  const stop = (status, note) => ({ status, lines, passwords: new Map(), deviations, created, rotated, note });

  const read = () => {
    const r = o.psql(appRolesCheckSql());
    return r.ok ? { ok: true, roles: parseAppRoles(r.stdout), err: null } : { ok: false, roles: [], err: r.error ?? "psql hatası" };
  };
  const before = read();
  if (!before.ok) return stop("RED", "rol katalog sorgusu başarısız");
  const exists = new Set(before.roles.map((r) => r.role));
  // Var olan rollerin niteliği ÖNCE denetlenir: sapma varsa hiçbir parola değiştirilmez (Fly'daki mevcut URL bozulmasın).
  for (const r of before.roles) {
    const d = appRoleDeviations(r);
    if (d.length > 0) deviations[r.role] = d;
  }
  if (Object.keys(deviations).length > 0) {
    for (const [role, d] of Object.entries(deviations)) lines.push(`${role}: BLOCKED (mevcut rol sapması: ${d.join(", ")})`);
    return stop("BLOCKED", "mevcut rol niteliği beklenenden farklı; parola değiştirilmedi, rol silinmedi (elle karar)");
  }

  const plan = planRoles({ exists, flySecrets: o.flySecrets, rotate: o.flags.rotate });
  if (o.readOnly) {
    // Probe OK değil: yalnızca katalog raporu; hiçbir CREATE/ALTER/API yazımı yok (parola değişip Fly'a yazılamaz).
    for (const p of plan) lines.push(`${p.role}: salt-okur (${p.create ? "yok, yaratılmadı" : "mevcut, sapma yok"}; probe OK değil → yazım yapılmadı)`);
    return stop("BLOCKED", "probe OK değil: uygulama rolleri salt-okur denetlendi (CREATE/ALTER/API yazımı yok)");
  }
  if (o.flags.rolePath === "sql") {
    // Tüm CREATE/ALTER ROLE ifadeleri tek transaction'da: kısmi başarısızlıkta hiçbiri uygulanmaz.
    /** @type {string[]} */
    const stmts = [];
    for (const p of plan.filter((x) => x.needPassword)) {
      const pw = genRolePassword(o.rand);
      o.mask(pw);
      stmts.push(
        p.create
          ? `CREATE ROLE ${quoteIdent(p.role)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${pw}';`
          : `ALTER ROLE ${quoteIdent(p.role)} WITH PASSWORD '${pw}';`,
      );
      passwords.set(p.role, pw);
    }
    if (stmts.length > 0) {
      const r = o.psql(`BEGIN;\n${stmts.join("\n")}\nCOMMIT;`);
      if (!r.ok) {
        lines.push(`rol işlemleri: FAIL (tek transaction geri alındı; SQLSTATE ${r.sqlstate ?? "?"})`);
        return stop("RED", "SQL rol işlemi başarısız (hiçbir rol değişmedi)");
      }
      for (const p of plan.filter((x) => x.needPassword)) (p.create ? created : rotated).push(p.role);
    }
  } else {
    for (const p of plan.filter((x) => x.needPassword)) {
      const pw = p.create ? await o.api.createRole(o.branchId, p.role) : await o.api.resetRolePassword(o.branchId, p.role);
      passwords.set(p.role, pw);
      (p.create ? created : rotated).push(p.role);
    }
  }

  const after = read();
  if (!after.ok) return stop("RED", "rol katalog sorgusu başarısız");
  for (const s of APP_ROLES) {
    const d = appRoleDeviations(after.roles.find((r) => r.role === s.role));
    if (d.length > 0) deviations[s.role] = d;
  }
  if (Object.keys(deviations).length > 0) {
    for (const [role, d] of Object.entries(deviations)) lines.push(`${role}: BLOCKED (${d.join(", ")})`);
    // Bu koşuda yaratılan, niteliği sapan roller bırakılmaz (API yolunda neon_superuser üyeliği → BYPASSRLS).
    if (o.flags.rolePath === "sql") {
      for (const role of created) {
        const d = o.psql(`DROP ROLE ${quoteIdent(role)};`);
        lines.push(d.ok ? `${role}: bu koşuda yaratılan rol silindi` : `${role}: FAIL (yaratılan rol silinemedi — elle silinmeli, SQLSTATE ${d.sqlstate ?? "?"})`);
      }
    }
    if (o.flags.rolePath === "api") {
      for (const role of created) {
        try {
          await o.api.deleteRole(o.branchId, role);
          lines.push(`${role}: bu koşuda yaratılan rol silindi`);
        } catch (e) {
          lines.push(`${role}: FAIL (yaratılan rol silinemedi — elle silinmeli): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return stop("BLOCKED", o.flags.rolePath === "api"
      ? "API ile yaratılan roller beklenen niteliklerde değil (Neon belgesi: neon_superuser üyeliği) → SQL CREATE ROLE yolu için Supervisor kararı gerekir (Supervisor eki (d), A-56)"
      : "SQL ile yaratılan roller beklenen niteliklerde değil");
  }
  for (const s of APP_ROLES) lines.push(`${s.role}: OK (nosuperuser, nobypassrls)`);
  return { status: "OK", lines, passwords, deviations, created, rotated, note: null };
}

// ---------------------------------------------------------------------------------------------
// Fly sırları
// ---------------------------------------------------------------------------------------------

/**
 * `flyctl secrets list --json` çıktısından sır ADLARI (eski `Name` / yeni `name` biçimi).
 * @param {string} stdout
 * @returns {Set<string>}
 */
export function parseFlySecretNames(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
  } catch {
    throw new Error("flyctl secrets list: çıktı JSON değil");
  }
  if (!Array.isArray(parsed)) throw new Error("flyctl secrets list: dizi bekleniyordu");
  const names = new Set();
  for (const e of parsed) {
    const n = e?.name ?? e?.Name;
    if (typeof n !== "string" || n === "") throw new Error("flyctl secrets list: sır adı okunamadı");
    names.add(n);
  }
  return names;
}

/**
 * @param {{
 *   existing: Set<string>, flags: Flags, rand: RandFn, urls: Map<string, string>, resendKey: string | null,
 *   demoPasswordInput: string | null,
 * }} o
 * @returns {{ entries: Map<string, string>, actions: Record<string, string> }} actions yalnızca sır ADI → eylem
 */
export function planFlySecrets(o) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  /** @type {Record<string, string>} */
  const actions = {};
  /** @param {string} name @param {string} value @param {string} action */
  const put = (name, value, action) => {
    entries.set(name, value);
    actions[name] = action;
  };
  for (const s of APP_ROLES) {
    const url = o.urls.get(s.secret);
    if (url !== undefined) put(s.secret, url, o.existing.has(s.secret) ? "rotated" : "created");
    else actions[s.secret] = "kept";
  }
  const gen = (/** @type {string} */ name, /** @type {() => string} */ make, /** @type {boolean} */ rotate) => {
    if (!o.existing.has(name)) put(name, make(), "generated");
    else if (rotate) put(name, make(), "rotated");
    else actions[name] = "kept";
  };
  gen("BETTER_AUTH_SECRET", () => genAuthSecret(o.rand), o.flags.rotateAuthSecret);
  gen("QUEUE_SEAL_KEY", () => genSealKey(o.rand), o.flags.rotateSealKey);
  if (o.demoPasswordInput !== null) put("DEMO_PASSWORD", o.demoPasswordInput, o.existing.has("DEMO_PASSWORD") ? "rotated" : "created");
  else gen("DEMO_PASSWORD", () => genDemoPassword(o.rand), false);
  put("BETTER_AUTH_URL", BETTER_AUTH_URL, "set");
  put("WMS_ENV", "staging", "set");
  put("SIGNUP_ENABLED", "false", "set");
  if (o.resendKey !== null) put("RESEND_API_KEY", o.resendKey, o.existing.has("RESEND_API_KEY") ? "rotated" : "created");
  else actions.RESEND_API_KEY = o.existing.has("RESEND_API_KEY") ? "kept" : "absent";
  return { entries, actions };
}

/**
 * `NAME=VALUE` satırları (stdin'e verilir). Satır sonu içeren değer reddedilir.
 * @param {Map<string, string>} entries
 */
export function renderImport(entries) {
  let out = "";
  for (const [k, v] of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error("güvensiz sır adı");
    if (/[\r\n]/.test(v) || v === "") throw new Error(`sır ${k}: değer boş ya da satır sonu içeriyor`);
    out += `${k}=${v}\n`;
  }
  return out;
}

/**
 * flyctl sarmalayıcısı: ortam yalnızca FLY_API_TOKEN (+ PATH/HOME); değerler argv'de değil stdin'de.
 * @param {{ token: string, app: string, redactor: import("./neon-spike.mjs").Redactor, bin?: string }} o
 */
export function createFlyctl(o) {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FLY_API_TOKEN: o.token, FLY_NO_UPDATE_CHECK: "1" };
  /** @param {string[]} args @param {string} [input] */
  const run = (args, input) => {
    const r = spawnSync(o.bin ?? "flyctl", args, { input, encoding: "utf8", env, timeout: 300_000 });
    if (r.error) throw new Error(`flyctl çalıştırılamadı: ${o.redactor.redact(r.error.message)}`);
    if (r.status !== 0) throw new Error(`flyctl ${args.slice(0, 2).join(" ")} başarısız (çıkış ${r.status}): ${o.redactor.redact((r.stderr ?? "").trim()).slice(0, 400)}`);
    return r.stdout ?? "";
  };
  return {
    listSecretNames: () => parseFlySecretNames(run(["secrets", "list", "--app", o.app, "--json"])),
    /** @param {string} text */
    importStaged: (text) => void run(["secrets", "import", "--stage", "--app", o.app], text),
  };
}

// ---------------------------------------------------------------------------------------------
// Özet
// ---------------------------------------------------------------------------------------------

/**
 * @param {Record<string, any>} s
 */
export function renderSummaryMd(s) {
  const L = [`# T-105 staging hazırlığı — ${s.status}`, "", `Rol yolu: \`${s.rolePath}\``, ""];
  for (const l of s.lines) L.push(`- ${l}`);
  L.push("", `demo parolası: ${s.demoPassword}`, `owner_bypassrls: ${s.ownerBypassrls}`, `owner_superuser: ${s.ownerSuperuser}`, "");
  if (s.notes.length > 0) {
    L.push("## Notlar");
    for (const n of s.notes) L.push(`- ${n}`);
    L.push("");
  }
  L.push("## Fly sırları (yalnızca ADLAR; sahnelendi, sonraki dağıtımda etkin olur)");
  for (const [k, v] of Object.entries(s.flySecrets)) L.push(`- ${k}: ${v}`);
  L.push("", `Fly'da yasak sır adı (DATABASE_URL_DIRECT): ${s.forbiddenPresent.length === 0 ? "yok" : s.forbiddenPresent.join(", ")}`);
  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

/**
 * @param {{
 *   env?: Record<string, string | undefined>, argv?: string[], say?: (s: string) => void, rand?: RandFn,
 *   redactor?: import("./neon-spike.mjs").Redactor, api?: any, fly?: { listSecretNames: () => Set<string>, importStaged: (t: string) => void },
 *   psql?: (target: any, sql: string) => ReturnType<PsqlFn>, outDir?: string, readFile?: (p: string) => string,
 * }} [o]
 * @returns {Promise<number>}
 */
export async function main(o = {}) {
  const env = o.env ?? process.env;
  const say = o.say ?? ((s) => process.stdout.write(`${s}\n`));
  const rand = o.rand ?? defaultRand;
  const redactor = o.redactor ?? createRedactor();
  const outDir = o.outDir ?? OUT_DIR;
  const readFile = o.readFile ?? ((p) => readFileSync(p, "utf8"));
  /** @param {string | null | undefined} v */
  const mask = (v) => maskSecret(redactor, v, { env });

  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Record<string, string>} */
  let flyActions = {};
  /** @type {string[]} */
  let forbiddenPresent = [];
  /** @type {"OK" | "RED" | "BLOCKED"} */
  let status = "RED";
  let ownerBypassrls = "unknown";
  let ownerSuper = "unknown";
  let demoSource = "yazılmadı";
  /** @type {Flags | null} */
  let flags = null;

  const finish = () => {
    mkdirSync(outDir, { recursive: true });
    const summary = {
      task: "T-105",
      status,
      rolePath: flags?.rolePath ?? "?",
      lines,
      notes,
      ownerBypassrls,
      ownerSuperuser: ownerSuper,
      flySecrets: flyActions,
      forbiddenPresent,
      demoPassword: demoSource,
    };
    writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(path.join(outDir, "summary.md"), renderSummaryMd(summary));
    const leaks = scanDirForLeaks(outDir, redactor);
    if (leaks.length > 0) {
      say(`[provision-staging] FAIL: özet dosyasında sızıntı (${leaks.map((l) => `${l.file}:${l.kinds.join("+")}`).join(", ")})`);
      writeFileSync(path.join(outDir, "summary.md"), "# T-105 — özet sızıntı nedeniyle silindi\n");
      writeFileSync(path.join(outDir, "summary.json"), "{}\n");
      return 1;
    }
    for (const l of lines) say(`[provision-staging] ${redactor.redact(l)}`);
    say(`[provision-staging] ${status}`);
    return status === "OK" ? 0 : status === "BLOCKED" ? 2 : 1;
  };

  try {
    flags = parseArgs(o.argv ?? process.argv.slice(2));
    if (flags.rolePath === "sql") {
      let text = "";
      try {
        text = readFile(path.join(ROOT, "docs", "OPEN_QUESTIONS.md"));
      } catch {
        text = "";
      }
      if (!sqlDecisionRecorded(String(flags.sqlDecision), text)) {
        lines.push(`SQL rol yolu BLOCKED: docs/OPEN_QUESTIONS.md'de ${flags.sqlDecision} kimlikli, "T-105" ve "SQL CREATE ROLE" içeren Supervisor karar satırı yok`);
        status = "BLOCKED";
        return finish();
      }
    }
    const { apiKey, projectId } = readNeonEnv(env);
    const flyToken = (env.FLY_API_TOKEN ?? "").trim();
    if (flyToken === "") throw new Error("missing FLY_API_TOKEN (repo sırrı)");
    const resendKey = (env.RESEND_API_KEY ?? "").trim() || null;
    const demoIn = (env.STAGING_DEMO_PASSWORD ?? "").trim() || null;
    if (demoIn !== null && demoIn.length < MIN_DEMO_PASSWORD_LENGTH) {
      throw new Error(`STAGING_DEMO_PASSWORD en az ${MIN_DEMO_PASSWORD_LENGTH} karakter olmalı`);
    }
    for (const v of [apiKey, flyToken, resendKey, demoIn]) mask(v);

    const api = o.api ?? createNeonProjectApi({ apiKey, projectId, redactor, env });
    const fly = o.fly ?? createFlyctl({ token: flyToken, app: FLY_APP, redactor });
    const conn = await api.resolveMainBranch();
    const psql = /** @type {PsqlFn} */ (
      (sql) => (o.psql ? o.psql(conn.ownerDirect, sql) : runPsql(conn.ownerDirect, sql, redactor))
    );

    const existing = fly.listSecretNames();
    forbiddenPresent = FORBIDDEN_FLY_SECRETS.filter((n) => existing.has(n));
    if (forbiddenPresent.length > 0) {
      lines.push(`Fly'da yasak sır adı var: ${forbiddenPresent.join(", ")} (Supervisor eki (e); elle kaldırılmalı)`);
      status = "RED";
      return finish();
    }

    const probe = ensureProbe({ psql, migrationRole: conn.ownerRole, say });
    lines.push(probe.line);
    if (probe.adminOnly.length > 0) notes.push(`wms_identity_probe yalnızca-ADMIN üyeler (ADR-015 1(b)): ${probe.adminOnly.join(", ")}`);
    if (probe.warn) notes.push(`m1 WARN (A-67): sahip rolün probe üzerindeki örtük ADMIN'i kaldırılamadı (${probe.warnings.join(", ")}); gerekçe: sahip rol rolbypassrls=true VE rolcreaterole=true, ADMIN yeni yetenek kazandırmaz. Uygulama rollerinin probe üyeliği denetimi değişmedi (FAIL)`);
    if (probe.attempts.length > 0) notes.push(`probe girişimleri: ${probe.attempts.join(", ")}`);
    ownerBypassrls = probe.ownerBypassrls === null ? "unknown" : String(probe.ownerBypassrls);
    ownerSuper = probe.ownerSuper === null ? "unknown" : String(probe.ownerSuper);
    lines.push(`owner_bypassrls: ${ownerBypassrls}`);
    if (probe.status === "RED") {
      status = "RED";
      return finish();
    }

    const roles = await ensureAppRoles({ psql, api, branchId: conn.branchId, flags, flySecrets: existing, rand, mask, say, readOnly: probe.status !== "OK" });
    lines.push(...roles.lines);
    if (roles.note) notes.push(roles.note);
    if (roles.created.length > 0) notes.push(`bu koşuda yaratılan roller: ${roles.created.join(", ")}`);
    if (roles.rotated.length > 0) notes.push(`bu koşuda parolası döndürülen roller: ${roles.rotated.join(", ")}`);
    if (probe.status === "BLOCKED" || roles.status === "BLOCKED") {
      status = "BLOCKED";
      notes.push("Fly'a hiçbir sır yazılmadı");
      return finish();
    }
    if (roles.status !== "OK") {
      status = "RED";
      notes.push("Fly'a hiçbir sır yazılmadı");
      return finish();
    }

    /** @type {Map<string, string>} */
    const urls = new Map();
    for (const s of APP_ROLES) {
      const pw = roles.passwords.get(s.role);
      if (pw === undefined) continue;
      const url = pgUrl({ user: s.role, password: pw, host: conn.poolerHost, database: conn.database });
      mask(url);
      urls.set(s.secret, url);
    }
    const plan = planFlySecrets({ existing, flags, rand, urls, resendKey, demoPasswordInput: demoIn });
    // Yalnızca gizli değerler maskelenir (sabit ayarlar — staging, false, URL — maskelenirse özet/log bozulur).
    for (const [k, v] of plan.entries) if (plan.actions[k] !== "set") mask(v);
    flyActions = plan.actions;
    if (flags.rotateAuthSecret) notes.push("BETTER_AUTH_SECRET yenilendi: tüm oturumlar sonraki dağıtımda düşer");
    if (flags.rotateSealKey) notes.push("QUEUE_SEAL_KEY yenilendi: kuyrukta bekleyen email.send işleri çözülemez (yalnızca kuyruk boşken döndürün)");
    demoSource = demoIn !== null ? "repo sırrından (STAGING_DEMO_PASSWORD)" : plan.actions.DEMO_PASSWORD === "generated" ? "üretildi (okunamaz)" : "mevcut Fly sırrı (dokunulmadı; kaynağı bilinmiyor)";
    if (plan.actions.DEMO_PASSWORD === "generated") notes.push("DEMO_PASSWORD rastgele üretildi ve okunamaz; bilinen bir değer için STAGING_DEMO_PASSWORD repo sırrını ekleyip yeniden koşun");
    if (plan.actions.RESEND_API_KEY === "absent") notes.push("RESEND_API_KEY repo sırrı yok: e-posta gönderimi MAIL_DELIVERY_DISABLED ile reddedilir (U-03)");
    try {
      fly.importStaged(renderImport(plan.entries));
    } catch (e) {
      lines.push(`Fly sır yazımı FAIL: ${e instanceof Error ? e.message : String(e)}`);
      notes.push("Neon parolaları değişmiş olabilir; Fly yazımı başarısız → yeniden koşun (--rotate ile)");
      status = "RED";
      return finish();
    }
    const after = fly.listSecretNames();
    const missing = [...plan.entries.keys()].filter((n) => !after.has(n));
    const forbiddenAfter = FORBIDDEN_FLY_SECRETS.filter((n) => after.has(n));
    forbiddenPresent = forbiddenAfter;
    if (missing.length > 0 || forbiddenAfter.length > 0) {
      lines.push(`Fly sır doğrulaması FAIL: eksik=[${missing.join(", ")}] yasak=[${forbiddenAfter.join(", ")}]`);
      status = "RED";
      return finish();
    }
    lines.push(`Fly sırları sahnelendi (ADLAR): ${[...plan.entries.keys()].join(", ")}`);
    status = "OK";
    return finish();
  } catch (e) {
    lines.push(`FAIL: ${redactor.redact(e instanceof Error ? e.message : String(e))}`);
    status = "RED";
    return finish();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
