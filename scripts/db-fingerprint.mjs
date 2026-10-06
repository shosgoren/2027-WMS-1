#!/usr/bin/env node
// T-130 — Veritabanı parmak izi (restore tatbikatı: ana dal ile geri yüklenen dal karşılaştırması).
//
// Tek salt-okunur, REPEATABLE READ transaction'da (migration/sahip rolü, psql ile; scripts/** altında PG sürücüsü
// import'u AC-28 ile yasak) şunlar toplanır:
//   * `wms_meta.schema_migrations` listesi (sürüm, ad, sağlama),
//   * uygulama tablolarının tam satır sayısı (sistem şemaları ve Neon'un `neon` şeması hariç),
//   * `audit_logs` ve `security_events`: `created_xid, id` sıralı satır özetlerinin SHA-256'sı (değerler değil özet),
//   * şema özeti: `information_schema.columns` + tablo RLS bayrakları + politikalar (SHA-256),
//   * rol nitelikleri (wms_app / wms_auth / wms_worker / wms_identity_probe; parola/URL yok).
// Çıktıda kişisel veri, URL, host, parola YOKTUR; yalnızca tablo adları, sayılar ve özetler.
//
// Not: sayımlar ve özetler satır düzeyi güvenliğini (FORCE RLS) atlayan sahip rolü gerektirir (Neon sahip rolü
// BYPASSRLS, A-60/Q-32). Rol BYPASSRLS değilse sayımlar 0 görünür → parmak izi KULLANILAMAZ (fail-closed).
// Sınır: özetler `string_agg` ile tek sorguda hesaplanır; demo/staging hacmi içindir (büyük veri → ayrı tasarım).
import { runPsql } from "./neon-spike.mjs";
import { createHash } from "node:crypto";

/** Uygulama rolleri (hepsi NOSUPERUSER NOBYPASSRLS LOGIN, üyelik 0) ve NOLOGIN kimlik probu. */
export const APP_ROLE_NAMES = Object.freeze(["wms_app", "wms_auth", "wms_worker"]);
export const PROBE_ROLE_NAME = "wms_identity_probe";
/** Katalog taramasında dışlanan şemalar (sistem + Neon'un yönettiği `neon`). */
export const EXCLUDED_SCHEMAS = Object.freeze(["pg_catalog", "information_schema", "neon"]);
/** Çıktı satırı öneki (psql çıktısındaki başka satırlardan ayırmak için). */
export const FP_PREFIX = "FP:";

const TS_FMT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const EXCLUDED_SQL = EXCLUDED_SCHEMAS.map((s) => `'${s}'`).join(", ");

/** Parmak izi SQL'i (tek transaction; yalnızca SELECT). */
export const FINGERPRINT_SQL = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT '${FP_PREFIX}' || json_build_object(
  'db_now', to_char(clock_timestamp() AT TIME ZONE 'UTC', ${TS_FMT}),
  'rls_bypass', (SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user),
  'server_version_num', current_setting('server_version_num'),
  'migrations', (SELECT coalesce(json_agg(json_build_object('version', m.version, 'name', m.name, 'checksum_sha256', m.checksum_sha256) ORDER BY m.version), '[]'::json)
                 FROM wms_meta.schema_migrations m),
  'tables', (SELECT coalesce(json_object_agg(t.fqn, t.n ORDER BY t.fqn), '{}'::json) FROM (
               SELECT format('%I.%I', n.nspname, c.relname) AS fqn,
                      (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN (${EXCLUDED_SQL}) AND n.nspname NOT LIKE 'pg\\_%'
             ) t),
  'audit_logs', (SELECT json_build_object('count', count(*),
                   'latest_at', to_char(max(a.occurred_at) AT TIME ZONE 'UTC', ${TS_FMT}),
                   'digest', encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(a::text, 'UTF8')), 'hex'), ',' ORDER BY a.created_xid, a.id), ''), 'UTF8')), 'hex'))
                 FROM public.audit_logs a),
  'security_events', (SELECT json_build_object('count', count(*),
                   'latest_at', to_char(max(s.occurred_at) AT TIME ZONE 'UTC', ${TS_FMT}),
                   'digest', encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(s::text, 'UTF8')), 'hex'), ',' ORDER BY s.created_xid, s.id), ''), 'UTF8')), 'hex'))
                 FROM public.security_events s),
  'schema', (SELECT json_build_object('columns', count(*),
                   'digest', encode(sha256(convert_to(coalesce(string_agg(concat_ws('|', c.table_schema, c.table_name, c.column_name, c.ordinal_position, c.data_type, c.is_nullable, coalesce(c.column_default, '')), E'\\n' ORDER BY c.table_schema, c.table_name, c.ordinal_position), ''), 'UTF8')), 'hex'))
                 FROM information_schema.columns c WHERE c.table_schema NOT IN (${EXCLUDED_SQL}) AND c.table_schema NOT LIKE 'pg\\_%'),
  'rls', (SELECT json_build_object('tables', count(*),
                   'digest', encode(sha256(convert_to(coalesce(string_agg(format('%I.%I:%s:%s', n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity), E'\\n' ORDER BY n.nspname, c.relname), ''), 'UTF8')), 'hex'))
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN (${EXCLUDED_SQL}) AND n.nspname NOT LIKE 'pg\\_%'),
  'policies', (SELECT json_build_object('count', count(*),
                   'digest', encode(sha256(convert_to(coalesce(string_agg(concat_ws('|', p.schemaname, p.tablename, p.policyname, p.cmd, p.roles::text, coalesce(p.qual, ''), coalesce(p.with_check, '')), E'\\n' ORDER BY p.schemaname, p.tablename, p.policyname), ''), 'UTF8')), 'hex'))
                 FROM pg_policies p WHERE p.schemaname NOT IN (${EXCLUDED_SQL})),
  'roles', (SELECT coalesce(json_agg(json_build_object('name', r.rolname, 'login', r.rolcanlogin, 'superuser', r.rolsuper,
                   'bypassrls', r.rolbypassrls, 'createdb', r.rolcreatedb, 'createrole', r.rolcreaterole, 'replication', r.rolreplication,
                   'memberships', (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)) ORDER BY r.rolname), '[]'::json)
              FROM pg_roles r WHERE r.rolname IN (${[...APP_ROLE_NAMES, PROBE_ROLE_NAME].map((s) => `'${s}'`).join(", ")}))
)::text;
COMMIT;
`;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * @typedef {{ count: number, latest_at: string | null, digest: string }} EventDigest
 * @typedef {{
 *   db_now: string, rls_bypass: boolean, server_version_num: string,
 *   migrations: { version: string, name: string, checksum_sha256: string }[],
 *   tables: Record<string, number>,
 *   audit_logs: EventDigest, security_events: EventDigest,
 *   schema: { columns: number, digest: string }, rls: { tables: number, digest: string },
 *   policies: { count: number, digest: string },
 *   roles: { name: string, login: boolean, superuser: boolean, bypassrls: boolean, createdb: boolean, createrole: boolean, replication: boolean, memberships: number }[],
 * }} Fingerprint
 */

export class FingerprintError extends Error {
  name = "FingerprintError";
  /** true: yeniden denemek anlamsız (örn. rol BYPASSRLS değil). */
  fatal = false;
}

/**
 * psql çıktısından parmak izini ayrıştırır ve biçimini doğrular (değer içermeyen hata iletileri).
 * @param {string} stdout
 * @returns {Fingerprint}
 */
export function parseFingerprintOutput(stdout) {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(FP_PREFIX));
  if (line === undefined) throw new FingerprintError("parmak izi çıktısı bulunamadı");
  let fp;
  try {
    fp = JSON.parse(line.slice(FP_PREFIX.length));
  } catch {
    throw new FingerprintError("parmak izi JSON değil");
  }
  const bad = (/** @type {string} */ what) => new FingerprintError(`parmak izi biçimi geçersiz: ${what}`);
  if (typeof fp?.db_now !== "string" || Number.isNaN(Date.parse(fp.db_now))) throw bad("db_now");
  if (typeof fp.rls_bypass !== "boolean") throw bad("rls_bypass");
  if (!Array.isArray(fp.migrations)) throw bad("migrations");
  if (fp.tables === null || typeof fp.tables !== "object" || Array.isArray(fp.tables)) throw bad("tables");
  for (const [k, v] of Object.entries(fp.tables)) if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw bad(`tables.${k}`);
  for (const key of ["audit_logs", "security_events"]) {
    const e = fp[key];
    if (typeof e?.count !== "number" || typeof e?.digest !== "string" || !HEX64.test(e.digest)) throw bad(key);
    if (e.latest_at !== null && (typeof e.latest_at !== "string" || Number.isNaN(Date.parse(e.latest_at)))) throw bad(`${key}.latest_at`);
  }
  for (const key of ["schema", "rls", "policies"]) {
    if (typeof fp[key]?.digest !== "string" || !HEX64.test(fp[key].digest)) throw bad(key);
  }
  if (!Array.isArray(fp.roles)) throw bad("roles");
  return fp;
}

/**
 * Parmak izini alır. Sahip rolü BYPASSRLS değilse (sayımlar güvenilmez) hata.
 * @param {import("./neon-spike.mjs").PsqlTarget} target
 * @param {import("./neon-spike.mjs").Redactor} redactor
 * @param {{ psql?: typeof runPsql, timeoutMs?: number }} [opts]
 * @returns {Fingerprint}
 */
export function takeFingerprint(target, redactor, opts = {}) {
  const psql = opts.psql ?? runPsql;
  const r = psql(target, FINGERPRINT_SQL, redactor, opts.timeoutMs ?? 120_000);
  if (!r.ok) throw new FingerprintError(`parmak izi sorgusu başarısız${r.sqlstate ? ` (SQLSTATE ${r.sqlstate})` : ""}: ${r.error ?? ""}`.trim());
  const fp = parseFingerprintOutput(r.stdout);
  if (!fp.rls_bypass) {
    const err = new FingerprintError("parmak izi kullanılamaz: bağlantı rolü BYPASSRLS değil (FORCE RLS tabloları 0 satır görünür)");
    err.fatal = true;
    throw err;
  }
  return fp;
}

/**
 * İki parmak izini karşılaştırır. `db_now` karşılaştırılmaz. Çıktıda yalnızca bölüm/tablo adları var (değer yok).
 * Tek satırlık fark → `equal=false`.
 * @param {Fingerprint} a ana dal
 * @param {Fingerprint} b geri yüklenen dal
 * @returns {{ equal: boolean, sections: Record<string, boolean>, diffs: string[] }}
 */
export function compareFingerprints(a, b) {
  /** @type {string[]} */
  const diffs = [];
  /** @type {Record<string, boolean>} */
  const sections = {};
  /** @param {string} name @param {boolean} same @param {string} [detail] */
  const mark = (name, same, detail) => {
    sections[name] = same;
    if (!same) diffs.push(detail ?? name);
  };
  mark("server_version", a.server_version_num === b.server_version_num);
  mark("migrations", JSON.stringify(a.migrations) === JSON.stringify(b.migrations));
  const names = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort();
  const tableDiffs = names.filter((n) => a.tables[n] !== b.tables[n]);
  mark("table_counts", tableDiffs.length === 0, `table_counts: ${tableDiffs.join(",")}`);
  for (const key of /** @type {const} */ (["audit_logs", "security_events"])) {
    mark(`${key}_count`, a[key].count === b[key].count);
    mark(`${key}_digest`, a[key].digest === b[key].digest);
  }
  mark("schema", a.schema.digest === b.schema.digest && a.schema.columns === b.schema.columns);
  mark("rls", a.rls.digest === b.rls.digest && a.rls.tables === b.rls.tables);
  mark("policies", a.policies.digest === b.policies.digest && a.policies.count === b.policies.count);
  mark("roles", JSON.stringify(a.roles) === JSON.stringify(b.roles));
  return { equal: diffs.length === 0, sections, diffs };
}

/**
 * Uygulama rollerinin RLS açısından güvenli niteliklerini denetler (sorun listesi; boş = tamam).
 * @param {Fingerprint} fp
 * @returns {string[]}
 */
export function checkRoleAttributes(fp) {
  /** @type {string[]} */
  const problems = [];
  for (const name of APP_ROLE_NAMES) {
    const r = fp.roles.find((x) => x.name === name);
    if (r === undefined) {
      problems.push(`${name}: rol yok`);
      continue;
    }
    if (!r.login) problems.push(`${name}: LOGIN değil`);
    for (const attr of /** @type {const} */ (["superuser", "bypassrls", "createdb", "createrole", "replication"])) {
      if (r[attr]) problems.push(`${name}: ${attr}=true`);
    }
    if (r.memberships !== 0) problems.push(`${name}: üyelik sayısı ${r.memberships}`);
  }
  const probe = fp.roles.find((x) => x.name === PROBE_ROLE_NAME);
  if (probe === undefined) problems.push(`${PROBE_ROLE_NAME}: rol yok`);
  else if (probe.login) problems.push(`${PROBE_ROLE_NAME}: LOGIN olmamalı`);
  return problems;
}

/**
 * Karşılaştırılabilir alanların tek özet sağlaması (`db_now` hariç; sırasız anahtar farkı etkisiz).
 * @param {Fingerprint} fp
 */
export function fingerprintHash(fp) {
  const rest = /** @type {Record<string, unknown>} */ ({ ...fp });
  delete rest.db_now;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/** @param {unknown} v @returns {string} */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
