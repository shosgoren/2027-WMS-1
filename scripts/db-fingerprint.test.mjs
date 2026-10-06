import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_SQL,
  FP_PREFIX,
  FingerprintError,
  checkRoleAttributes,
  compareFingerprints,
  fingerprintHash,
  parseFingerprintOutput,
  takeFingerprint,
} from "./db-fingerprint.mjs";
import { createRedactor } from "./neon-spike.mjs";

const hex = () => randomBytes(32).toString("hex");
/** @param {string} name @param {Record<string, any>} [over] */
const role = (name, over = {}) => ({
  name, login: true, superuser: false, bypassrls: false, createdb: false, createrole: false, replication: false, memberships: 0, ...over,
});

/** @param {Record<string, any>} [over] @returns {import("./db-fingerprint.mjs").Fingerprint} */
function makeFingerprint(over = {}) {
  const d = { audit: hex(), sec: hex(), schema: hex(), rls: hex(), pol: hex() };
  return {
    db_now: "2026-10-06T10:00:00.000000Z",
    rls_bypass: true,
    server_version_num: "170011",
    migrations: [{ version: "0001", name: "baseline", checksum_sha256: d.schema }],
    tables: { "public.users": 3, "public.audit_logs": 10, "public.security_events": 7 },
    audit_logs: { count: 10, latest_at: "2026-10-06T09:00:00.000000Z", digest: d.audit },
    security_events: { count: 7, latest_at: "2026-10-06T09:59:58.000000Z", digest: d.sec },
    schema: { columns: 80, digest: d.schema },
    rls: { tables: 12, digest: d.rls },
    policies: { count: 9, digest: d.pol },
    roles: [role("wms_app"), role("wms_auth"), role("wms_identity_probe", { login: false }), role("wms_ops", { login: false }), role("wms_worker")],
    ...over,
  };
}

describe("compareFingerprints", () => {
  it("özdeş parmak izleri eşit; db_now farkı önemsiz", () => {
    const a = makeFingerprint();
    const b = structuredClone(a);
    b.db_now = "2026-10-06T11:11:11.000000Z";
    const r = compareFingerprints(a, b);
    expect(r.equal).toBe(true);
    expect(r.diffs).toEqual([]);
  });

  it("tek satırlık tablo sayısı farkı FAIL", () => {
    const a = makeFingerprint();
    const b = structuredClone(a);
    b.tables["public.users"] = 4;
    const r = compareFingerprints(a, b);
    expect(r.equal).toBe(false);
    expect(r.sections.table_counts).toBe(false);
    expect(r.diffs.join(" ")).toContain("public.users");
  });

  it("satır sayısı aynı, içerik özeti farklı → FAIL", () => {
    const a = makeFingerprint();
    const b = structuredClone(a);
    b.audit_logs.digest = hex();
    const r = compareFingerprints(a, b);
    expect(r.equal).toBe(false);
    expect(r.sections.audit_logs_digest).toBe(false);
    expect(r.sections.audit_logs_count).toBe(true);
  });

  it.each([
    ["migrations", (/** @type {any} */ f) => f.migrations.push({ version: "0002", name: "x", checksum_sha256: hex() })],
    ["schema", (/** @type {any} */ f) => { f.schema.digest = hex(); }],
    ["rls", (/** @type {any} */ f) => { f.rls.digest = hex(); }],
    ["policies", (/** @type {any} */ f) => { f.policies.count = 8; }],
    ["roles", (/** @type {any} */ f) => { f.roles[0].bypassrls = true; }],
    ["security_events_digest", (/** @type {any} */ f) => { f.security_events.digest = hex(); }],
    ["security_events_count", (/** @type {any} */ f) => { f.security_events.count = 8; }],
  ])("%s farkı yakalanır", (section, mutate) => {
    const a = makeFingerprint();
    const b = structuredClone(a);
    mutate(b);
    const r = compareFingerprints(a, b);
    expect(r.equal).toBe(false);
    expect(r.sections[section]).toBe(false);
  });

  it("yalnızca bir tarafta bulunan tablo fark sayılır", () => {
    const a = makeFingerprint();
    const b = structuredClone(a);
    b.tables["public.extra"] = 0;
    expect(compareFingerprints(a, b).equal).toBe(false);
  });
});

describe("fingerprintHash", () => {
  it("db_now ve anahtar sırasından bağımsız, içerikten bağımlı", () => {
    const a = makeFingerprint();
    const b = structuredClone(a);
    b.db_now = "2030-01-01T00:00:00.000000Z";
    b.tables = { "public.security_events": 7, "public.audit_logs": 10, "public.users": 3 };
    expect(fingerprintHash(a)).toBe(fingerprintHash(b));
    b.tables["public.users"] = 99;
    expect(fingerprintHash(a)).not.toBe(fingerprintHash(b));
  });
});

describe("checkRoleAttributes", () => {
  it("sağlıklı roller → sorun yok", () => {
    expect(checkRoleAttributes(makeFingerprint())).toEqual([]);
  });
  it("wms_ops: eksik, LOGIN'li, BYPASSRLS'li veya üyeli → sorun (A-80)", () => {
    const base = makeFingerprint();
    const without = { ...base, roles: base.roles.filter((r) => r.name !== "wms_ops") };
    expect(checkRoleAttributes(without)).toContain("wms_ops: rol yok");
    const bad = { ...base, roles: base.roles.map((r) => (r.name === "wms_ops" ? { ...r, login: true, bypassrls: true, memberships: 2 } : r)) };
    expect(checkRoleAttributes(bad)).toEqual(
      expect.arrayContaining(["wms_ops: LOGIN olmamalı (A-80)", "wms_ops: bypassrls=true", "wms_ops: üyelik sayısı 2"]),
    );
  });
  it("db_now anlık görüntüyle aynı zaman: transaction_timestamp()", () => {
    expect(FINGERPRINT_SQL).toContain("transaction_timestamp()");
    expect(FINGERPRINT_SQL).not.toContain("clock_timestamp");
    expect(FINGERPRINT_SQL).toContain("'wms_ops'");
  });
  it("BYPASSRLS, üyelik, eksik rol, LOGIN'li probe yakalanır", () => {
    const fp = makeFingerprint();
    fp.roles = [role("wms_app", { bypassrls: true }), role("wms_auth", { memberships: 1 }), role("wms_identity_probe", { login: true })];
    const p = checkRoleAttributes(fp);
    expect(p).toEqual(
      expect.arrayContaining(["wms_app: bypassrls=true", "wms_auth: üyelik sayısı 1", "wms_worker: rol yok", "wms_identity_probe: LOGIN olmamalı"]),
    );
  });
});

describe("parseFingerprintOutput", () => {
  it("geçerli çıktıyı ayrıştırır (öncesindeki gürültü satırlarını yok sayar)", () => {
    const fp = makeFingerprint();
    expect(parseFingerprintOutput(`NOTICE x\n${FP_PREFIX}${JSON.stringify(fp)}`)).toEqual(fp);
  });
  it("satır yoksa / JSON bozuksa / biçim hatalıysa hata", () => {
    expect(() => parseFingerprintOutput("")).toThrow(FingerprintError);
    expect(() => parseFingerprintOutput(`${FP_PREFIX}{`)).toThrow(/JSON değil/);
    const bad = makeFingerprint();
    bad.audit_logs.digest = "xyz";
    expect(() => parseFingerprintOutput(`${FP_PREFIX}${JSON.stringify(bad)}`)).toThrow(/audit_logs/);
    const neg = makeFingerprint();
    neg.tables["public.users"] = -1;
    expect(() => parseFingerprintOutput(`${FP_PREFIX}${JSON.stringify(neg)}`)).toThrow(/tables/);
  });
});

describe("takeFingerprint", () => {
  const target = { host: "h", user: "u", password: randomBytes(12).toString("hex"), database: "d" };
  it("psql başarısızlığını SQLSTATE ile bildirir, parola sızdırmaz", () => {
    const redactor = createRedactor();
    const psql = () => ({ ok: false, stdout: "", sqlstate: "42P01", error: "relation does not exist" });
    expect(() => takeFingerprint(target, redactor, { psql })).toThrow(/42P01/);
  });
  it("BYPASSRLS olmayan rolde kullanılamaz (fatal)", () => {
    const fp = makeFingerprint({ rls_bypass: false });
    const psql = () => ({ ok: true, stdout: `${FP_PREFIX}${JSON.stringify(fp)}`, sqlstate: null, error: null });
    try {
      takeFingerprint(target, createRedactor(), { psql });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FingerprintError);
      expect(/** @type {FingerprintError} */ (e).fatal).toBe(true);
    }
  });
  it("SQL salt-okunur transaction'da; yazma ifadesi içermez", () => {
    expect(FINGERPRINT_SQL).toContain("READ ONLY");
    expect(FINGERPRINT_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i);
  });
});
