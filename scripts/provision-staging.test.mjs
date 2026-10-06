import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "./neon-spike.mjs";
import {
  APP_ROLES,
  appRoleDeviations,
  ensureAppRoles,
  ensureProbe,
  evaluateProbe,
  main,
  parseAppRoles,
  parseArgs,
  parseFlySecretNames,
  parseProbeCheck,
  planFlySecrets,
  planRoles,
  quoteIdent,
  renderImport,
  sqlDecisionRecorded,
} from "./provision-staging.mjs";

const OWNER = "neondb_owner";
const HOST_DIRECT = "ep-cool-dark-123456.c-2.eu-central-1.aws.neon.tech";
const HOST_POOLED = "ep-cool-dark-123456-pooler.c-2.eu-central-1.aws.neon.tech";
/** Koşu başına rastgele sahte değerler (literal sır yok). */
const rnd = (/** @type {string} */ prefix) => `${prefix}${randomBytes(9).toString("hex")}`;
const OWNER_PW = rnd("o");
const PW = { wms_app: rnd("a"), wms_auth: rnd("u"), wms_worker: rnd("w") };
const NEON_KEY = rnd("n");
const FLY_TOKEN = rnd("f");
const RESEND = rnd("r");
const DEMO_IN = rnd("demo-supplied-");
/** Deterministik "rastgele": her çağrı farklı doldurma baytı. */
const makeRand = () => {
  let i = 1;
  return (/** @type {number} */ n) => Buffer.alloc(n, i++);
};

/** psql çıktı satırları */
const roleRow = (/** @type {string} */ n, /** @type {Partial<Record<string, string>>} */ o = {}) =>
  ["role", n, o.login ?? "t", o.super ?? "f", o.bypass ?? "f", o.createdb ?? "f", o.createrole ?? "f", o.repl ?? "f", o.members ?? "0", o.owned ?? "0"].join("|");
const probeOut = (/** @type {string[]} */ members, m1 = "f", exists = true) =>
  [
    ...(exists ? ["attr|wms_identity_probe|f|f|f|f|f|f"] : []),
    ...members.map((m) => `member|${m}`),
    `m1|${m1}`,
    `owner|${OWNER}|f|t`,
  ].join("\n");
const OK_MEMBER = `${OWNER}|f|f|t|infra`;

describe("argümanlar / karar kaydı", () => {
  it("bayraklar", () => {
    expect(parseArgs([])).toMatchObject({ rotate: false, rotateAuthSecret: false, rotateSealKey: false, rolePath: "api" });
    expect(parseArgs(["--rotate", "--rotate-auth-secret", "--rotate-seal-key"])).toMatchObject({ rotate: true, rotateAuthSecret: true, rotateSealKey: true });
    expect(() => parseArgs(["--bilinmeyen"])).toThrow(/bilinmeyen/);
    expect(() => parseArgs(["--role-path", "sql"])).toThrow(/--sql-decision/);
    expect(parseArgs(["--role-path", "sql", "--sql-decision", "A-57"]).sqlDecision).toBe("A-57");
  });
  it("SQL yolu: yalnızca kimlikli + T-105 + SQL CREATE ROLE içeren karar satırı", () => {
    const t = "A-57 | karar | T-105 için SQL CREATE ROLE kabul\nA-58 | başka | T-106";
    expect(sqlDecisionRecorded("A-57", t)).toBe(true);
    expect(sqlDecisionRecorded("A-58", t)).toBe(false);
    expect(sqlDecisionRecorded("A-5", t)).toBe(false);
  });
  it("tanımlayıcı tırnaklama güvensiz adı reddeder", () => {
    expect(quoteIdent("wms_app")).toBe('"wms_app"');
    expect(() => quoteIdent('x"; DROP ROLE y; --')).toThrow(/güvensiz/);
  });
});

describe("rol nitelik denetimi", () => {
  it("temiz rol → sapma yok; her sapma adlandırılır; eksik rol", () => {
    const [ok] = parseAppRoles(roleRow("wms_app"));
    expect(appRoleDeviations(ok)).toEqual([]);
    const [bad] = parseAppRoles(roleRow("wms_app", { bypass: "t", createrole: "t", createdb: "t", repl: "t", super: "t", members: "1", owned: "2", login: "f" }));
    expect(appRoleDeviations(bad)).toEqual(["nologin", "superuser", "bypassrls", "createdb", "createrole", "replication", "member-of-role", "owns-objects"]);
    expect(appRoleDeviations(undefined)).toEqual(["missing"]);
    expect(appRoleDeviations(/** @type {any} */ ({ ...ok, memberships: Number.NaN }))).toEqual(["member-of-role"]);
  });
});

describe("probe üyelik denetimi (ADR-015 5. tur eki MINOR-6)", () => {
  const ev = (/** @type {string[]} */ m, m1 = "f") => evaluateProbe(parseProbeCheck(probeOut(m, m1)), OWNER);
  it("migration rolü set + noinherit + noadmin → OK", () => {
    expect(ev([OK_MEMBER])).toMatchObject({ ok: true, problems: [] });
  });
  it("inherit_option=true → kırmızı", () => {
    expect(ev([`${OWNER}|f|t|t|infra`]).problems).toContain("migration-role-inherit");
  });
  it("migration rolü satırında admin_option=true → kırmızı (örtük ADMIN satırı dahil)", () => {
    const r = ev([OK_MEMBER, `${OWNER}|t|f|f|cloud_admin`]);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("migration-role-admin-option");
  });
  it("yetki seçeneği yok → kırmızı; üyelik yok → kırmızı", () => {
    expect(ev([`${OWNER}|f|f|f|infra`]).problems).toContain("migration-role-no-set");
    expect(ev([]).problems).toContain("migration-role-not-member");
  });
  it("başka üyede set/inherit → kırmızı; yalnızca-ADMIN satırı kabul + özete adıyla", () => {
    expect(ev([OK_MEMBER, "other|f|f|t|x"]).problems).toContain("other-member-set-or-inherit:other");
    expect(ev([OK_MEMBER, "wms_app|t|f|f|x"]).problems).toContain("app-role-member:wms_app");
    expect(ev([OK_MEMBER, "infra|t|f|f|cloud_admin"])).toMatchObject({ ok: true, adminOnly: ["infra"] });
  });
  it("m1: dolaylı ADMIN → kırmızı; bilinmeyen → kırmızı", () => {
    expect(ev([OK_MEMBER], "t").problems).toContain("migration-role-indirect-admin");
    expect(evaluateProbe({ ...parseProbeCheck(probeOut([OK_MEMBER])), indirectAdmin: null }, OWNER).problems).toContain("indirect-admin-unknown");
  });
  it("probe yoksa kırmızı; LOGIN / BYPASSRLS nitelikleri kırmızı", () => {
    expect(evaluateProbe(parseProbeCheck(probeOut([], "f", false)), OWNER).problems).toEqual(["probe-missing"]);
    const p = parseProbeCheck(probeOut([OK_MEMBER]));
    expect(evaluateProbe(/** @type {any} */ ({ ...p, attrs: { ...p.attrs, login: true, bypassrls: true } }), OWNER).problems).toEqual(["probe-login", "probe-bypassrls"]);
  });
});

describe("ensureProbe", () => {
  /** @param {Array<(sql: string) => any>} script */
  const psqlOf = (script) => {
    /** @type {string[]} */
    const seen = [];
    const fn = (/** @type {string} */ sql) => {
      seen.push(sql);
      const step = script[seen.length - 1];
      if (!step) throw new Error(`beklenmeyen psql çağrısı: ${sql.slice(0, 40)}`);
      return step(sql);
    };
    return { fn, seen };
  };
  const out = (/** @type {string} */ stdout) => () => ({ ok: true, stdout, sqlstate: null, error: null });
  const fail = (/** @type {string} */ state) => () => ({ ok: false, stdout: "", sqlstate: state, error: "x" });

  it("probe yok: createrole_self_grant boş + yalnızca SET üyeliği; sonra doğrulama → OK satırı", async () => {
    const p = psqlOf([out(probeOut([], "f", false)), out(""), out(probeOut([OK_MEMBER]))]);
    const r = ensureProbe({ psql: p.fn, migrationRole: OWNER, say: () => undefined });
    expect(r).toMatchObject({ status: "OK", line: "wms_identity_probe: OK (set, noinherit, noadmin)", created: true, ownerBypassrls: true, ownerSuper: false });
    expect(p.seen[1]).toMatch(/^BEGIN;\nSET LOCAL createrole_self_grant = '';\nCREATE ROLE/);
    expect(p.seen[1]).toMatch(/COMMIT;$/);
    expect(p.seen[1]).toContain("NOLOGIN NOSUPERUSER NOBYPASSRLS");
    expect(p.seen[1]).toContain(`GRANT wms_identity_probe TO "${OWNER}" WITH ADMIN FALSE, SET TRUE, INHERIT FALSE;`);
  });
  it("örtük ADMIN satırı geri alınamaz → bu koşuda yaratılan probe silinir, BLOCKED", () => {
    const implicit = `${OWNER}|t|f|f|cloud_admin`;
    const p = psqlOf([
      out(probeOut([], "f", false)),
      out(""),
      out(probeOut([OK_MEMBER, implicit], "t")),
      out(""), // REVOKE (grantor = sahip)
      fail("42501"), // REVOKE … GRANTED BY cloud_admin
      out(probeOut([OK_MEMBER, implicit], "t")),
      out(""), // DROP
    ]);
    const r = ensureProbe({ psql: p.fn, migrationRole: OWNER, say: () => undefined });
    expect(r.status).toBe("BLOCKED");
    expect(r.problems).toContain("migration-role-admin-option");
    expect(r.attempts).toEqual(["create+grant:ok", "revoke-admin:ok", "revoke-admin:42501", "cleanup-drop-probe:ok"]);
    expect(p.seen[4]).toContain('GRANTED BY "cloud_admin"');
    expect(p.seen[6]).toBe("DROP ROLE wms_identity_probe;");
  });
  it("var olan, bozuk probe silinmez", () => {
    const p = psqlOf([out(probeOut([`${OWNER}|f|t|t|infra`])), out(probeOut([`${OWNER}|f|t|t|infra`]))]);
    const r = ensureProbe({ psql: p.fn, migrationRole: OWNER, say: () => undefined });
    expect(r.status).toBe("BLOCKED");
    expect(p.seen.some((s) => s.startsWith("DROP ROLE"))).toBe(false);
  });
  it("sorgu hatası → kırmızı", () => {
    const p = psqlOf([fail("08006")]);
    expect(ensureProbe({ psql: p.fn, migrationRole: OWNER, say: () => undefined }).status).toBe("RED");
  });
});

describe("planlar", () => {
  it("rol parolası: rol yok / --rotate / Fly sırrı yok → yeni parola; aksi halde yok", () => {
    const all = new Set(APP_ROLES.map((r) => r.role));
    const secrets = new Set(APP_ROLES.map((r) => r.secret));
    expect(planRoles({ exists: all, flySecrets: secrets, rotate: false }).every((p) => !p.needPassword)).toBe(true);
    expect(planRoles({ exists: all, flySecrets: secrets, rotate: true }).every((p) => p.needPassword)).toBe(true);
    expect(planRoles({ exists: new Set(["wms_app"]), flySecrets: secrets, rotate: false }).map((p) => [p.role, p.create, p.needPassword])).toEqual([
      ["wms_app", false, false],
      ["wms_auth", true, true],
      ["wms_worker", true, true],
    ]);
    const noSecret = new Set(["AUTH_DATABASE_URL", "DATABASE_URL_WORKER"]);
    expect(planRoles({ exists: all, flySecrets: noSecret, rotate: false }).map((p) => p.needPassword)).toEqual([true, false, false]);
  });

  const flags0 = { rotate: false, rotateAuthSecret: false, rotateSealKey: false, rolePath: /** @type {const} */ ("api"), sqlDecision: null };
  it("sır var → yeniden üretme yok (kept); yoksa üretilir; statik ayarlar her zaman", () => {
    const existing = new Set(["BETTER_AUTH_SECRET", "QUEUE_SEAL_KEY", "DEMO_PASSWORD", "DATABASE_URL", "AUTH_DATABASE_URL", "DATABASE_URL_WORKER", "RESEND_API_KEY"]);
    const p = planFlySecrets({ existing, flags: flags0, rand: makeRand(), urls: new Map(), resendKey: null, demoPasswordInput: null });
    expect([...p.entries.keys()].sort()).toEqual(["BETTER_AUTH_URL", "SIGNUP_ENABLED", "WMS_ENV"]);
    expect(p.entries.get("SIGNUP_ENABLED")).toBe("false");
    expect(p.entries.get("WMS_ENV")).toBe("staging");
    expect(p.entries.get("BETTER_AUTH_URL")).toBe("https://etkin-wms-staging.fly.dev");
    expect(p.actions).toMatchObject({ BETTER_AUTH_SECRET: "kept", QUEUE_SEAL_KEY: "kept", DEMO_PASSWORD: "kept", DATABASE_URL: "kept", RESEND_API_KEY: "kept" });
  });
  it("boş Fly: üretilir (demo parola ≥ 16, anahtarlar 64 hex); RESEND yoksa absent", () => {
    const p = planFlySecrets({ existing: new Set(), flags: flags0, rand: makeRand(), urls: new Map([["DATABASE_URL", "postgresql://u:p@h/d"]]), resendKey: null, demoPasswordInput: null });
    expect(p.entries.get("BETTER_AUTH_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(p.entries.get("QUEUE_SEAL_KEY")).toMatch(/^[0-9a-f]{64}$/);
    expect((p.entries.get("DEMO_PASSWORD") ?? "").length).toBeGreaterThanOrEqual(16);
    expect(p.entries.get("BETTER_AUTH_SECRET")).not.toBe(p.entries.get("QUEUE_SEAL_KEY"));
    expect(p.actions.RESEND_API_KEY).toBe("absent");
    expect(p.entries.has("RESEND_API_KEY")).toBe(false);
    expect(p.actions.DATABASE_URL).toBe("created");
  });
  it("döndürme bayrakları yalnızca ilgili sırrı yeniler; verilen demo parolası ve RESEND yazılır; migration URL'si hiç yazılmaz", () => {
    const existing = new Set(["BETTER_AUTH_SECRET", "QUEUE_SEAL_KEY", "DEMO_PASSWORD"]);
    const p = planFlySecrets({
      existing,
      flags: { ...flags0, rotateAuthSecret: true },
      rand: makeRand(),
      urls: new Map(),
      resendKey: RESEND,
      demoPasswordInput: DEMO_IN,
    });
    expect(p.actions).toMatchObject({ BETTER_AUTH_SECRET: "rotated", QUEUE_SEAL_KEY: "kept", DEMO_PASSWORD: "rotated", RESEND_API_KEY: "created" });
    expect(p.entries.get("DEMO_PASSWORD")).toBe(DEMO_IN);
    expect([...p.entries.keys()].some((k) => /DIRECT/.test(k))).toBe(false);
    expect(planFlySecrets({ existing, flags: { ...flags0, rotateSealKey: true }, rand: makeRand(), urls: new Map(), resendKey: null, demoPasswordInput: null }).actions.QUEUE_SEAL_KEY).toBe("rotated");
  });
  it("içe aktarma metni: NAME=VALUE; satır sonu/boş değer ve güvensiz ad reddedilir", () => {
    expect(renderImport(new Map([["A_B", "x"], ["C", "y=z"]]))).toBe("A_B=x\nC=y=z\n");
    expect(() => renderImport(new Map([["A", "x\ny"]]))).toThrow(/satır sonu/);
    expect(() => renderImport(new Map([["A", ""]]))).toThrow(/boş/);
    expect(() => renderImport(new Map([["a b", "x"]]))).toThrow(/güvensiz/);
  });
  it("flyctl sır listesi: eski ve yeni alan adı; bozuk çıktı hata", () => {
    expect([...parseFlySecretNames('[{"name":"A"},{"Name":"B"}]')].sort()).toEqual(["A", "B"]);
    expect(parseFlySecretNames("").size).toBe(0);
    expect(() => parseFlySecretNames("{}")).toThrow(/dizi/);
    expect(() => parseFlySecretNames("[{}]")).toThrow(/okunamadı/);
    expect(() => parseFlySecretNames("not json")).toThrow(/JSON değil/);
  });
});

describe("ensureAppRoles", () => {
  const flags = { rotate: false, rotateAuthSecret: false, rotateSealKey: false, rolePath: /** @type {"api" | "sql"} */ ("api"), sqlDecision: null };
  const cleanRows = APP_ROLES.map((r) => roleRow(r.role)).join("\n");
  const superRows = APP_ROLES.map((r) => roleRow(r.role, { bypass: "t", createrole: "t", createdb: "t", repl: "t", members: "1" })).join("\n");

  it("API yolu: neon_superuser üyesi roller → BLOCKED, bu koşuda yaratılanlar silinir, parola dönmez", async () => {
    /** @type {string[]} */
    const calls = [];
    let n = 0;
    const api = {
      createRole: async (/** @type {string} */ _b, /** @type {string} */ name) => (calls.push(`create:${name}`), PW[/** @type {keyof typeof PW} */ (name)]),
      resetRolePassword: async () => "x",
      deleteRole: async (/** @type {string} */ _b, /** @type {string} */ name) => void calls.push(`delete:${name}`),
    };
    const psql = () => ({ ok: true, stdout: n++ === 0 ? "" : superRows, sqlstate: null, error: null });
    const r = await ensureAppRoles({ psql, api, branchId: "br", flags, flySecrets: new Set(), rand: makeRand(), mask: () => undefined, say: () => undefined });
    expect(r.status).toBe("BLOCKED");
    expect(r.passwords.size).toBe(0);
    expect(calls).toEqual(["create:wms_app", "create:wms_auth", "create:wms_worker", "delete:wms_app", "delete:wms_auth", "delete:wms_worker"]);
    expect(r.lines[0]).toBe("wms_app: BLOCKED (bypassrls, createdb, createrole, replication, member-of-role)");
    expect(r.note).toMatch(/Supervisor kararı gerekir/);
  });
  it("mevcut rol sapmışsa: hiçbir parola değiştirilmez, hiçbir rol silinmez", async () => {
    /** @type {string[]} */
    const calls = [];
    const api = {
      createRole: async () => (calls.push("create"), "x"),
      resetRolePassword: async () => (calls.push("reset"), "x"),
      deleteRole: async () => void calls.push("delete"),
    };
    const r = await ensureAppRoles({
      psql: () => ({ ok: true, stdout: superRows, sqlstate: null, error: null }),
      api,
      branchId: "br",
      flags: { ...flags, rotate: true },
      flySecrets: new Set(),
      rand: makeRand(),
      mask: () => undefined,
      say: () => undefined,
    });
    expect(r.status).toBe("BLOCKED");
    expect(calls).toEqual([]);
  });
  it("API yolu yeşil: var olan rol + Fly sırrı var → parola dokunulmaz; eksik rol yaratılır", async () => {
    /** @type {string[]} */
    const calls = [];
    let n = 0;
    const api = {
      createRole: async (/** @type {string} */ _b, /** @type {string} */ name) => (calls.push(`create:${name}`), PW[/** @type {keyof typeof PW} */ (name)]),
      resetRolePassword: async () => (calls.push("reset"), "x"),
      deleteRole: async () => void calls.push("delete"),
    };
    const psql = () => ({ ok: true, stdout: n++ === 0 ? roleRow("wms_app") : cleanRows, sqlstate: null, error: null });
    const r = await ensureAppRoles({
      psql,
      api,
      branchId: "br",
      flags,
      flySecrets: new Set(["DATABASE_URL"]),
      rand: makeRand(),
      mask: () => undefined,
      say: () => undefined,
    });
    expect(r.status).toBe("OK");
    expect(calls).toEqual(["create:wms_auth", "create:wms_worker"]);
    expect([...r.passwords.keys()]).toEqual(["wms_auth", "wms_worker"]);
    expect(r.lines).toEqual(APP_ROLES.map((x) => `${x.role}: OK (nosuperuser, nobypassrls)`));
  });
  it("SQL yolu: CREATE ROLE niteliklerle, parola yalnızca SQL girdisinde; maskelenir", async () => {
    /** @type {string[]} */
    const sqls = [];
    /** @type {string[]} */
    const masked = [];
    let n = 0;
    const psql = (/** @type {string} */ sql) => {
      sqls.push(sql);
      const stdout = n++ === 0 ? "" : n === 5 ? cleanRows : "";
      return { ok: true, stdout, sqlstate: null, error: null };
    };
    const r = await ensureAppRoles({
      psql,
      api: /** @type {any} */ (null),
      branchId: "br",
      flags: { ...flags, rolePath: "sql" },
      flySecrets: new Set(),
      rand: makeRand(),
      mask: (v) => void masked.push(v),
      say: () => undefined,
    });
    expect(r.status).toBe("OK");
    expect(sqls[1]).toMatch(/^CREATE ROLE "wms_app" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '[A-Za-z0-9_-]+';$/);
    expect(masked).toHaveLength(3);
    expect(sqls[1]).toContain(masked[0]);
  });
});

describe("main (sahte Neon/psql/flyctl)", () => {
  /** @type {string[]} */
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** @param {{ rolesExist?: boolean, existingFly?: string[], rolesBlocked?: boolean, probeBlocked?: boolean, importFails?: boolean, flyAfterMissing?: boolean }} [o] */
  function harness(o = {}) {
    const outDir = mkdtempSync(path.join(tmpdir(), "t105-"));
    dirs.push(outDir);
    /** @type {string[]} */
    const said = [];
    /** @type {string[]} */
    const imports = [];
    /** @type {string[]} */
    const roleCalls = [];
    const redactor = createRedactor();
    const implicit = `${OWNER}|t|f|f|cloud_admin`;
    let roleReads = 0;
    const psql = (/** @type {any} */ _t, /** @type {string} */ sql) => {
      const ok = (/** @type {string} */ stdout) => ({ ok: true, stdout, sqlstate: null, error: null });
      if (sql.includes("'attr'")) return ok(o.probeBlocked ? probeOut([OK_MEMBER, implicit], "t") : probeOut([OK_MEMBER]));
      if (sql.includes("'role'")) {
        roleReads++;
        if (roleReads === 1 && !o.rolesExist) return ok("");
        return ok(APP_ROLES.map((r) => roleRow(r.role, o.rolesBlocked ? { bypass: "t", members: "1" } : {})).join("\n"));
      }
      return ok("");
    };
    let listCalls = 0;
    const fly = {
      listSecretNames: () => {
        listCalls++;
        const s = new Set(o.existingFly ?? []);
        if (listCalls > 1 && !o.importFails && !o.flyAfterMissing) for (const l of imports.join("").split("\n")) if (l.includes("=")) s.add(l.slice(0, l.indexOf("=")));
        return s;
      },
      importStaged: (/** @type {string} */ t) => {
        if (o.importFails) throw new Error("flyctl secrets import başarısız (çıkış 1)");
        imports.push(t);
      },
    };
    const api = {
      resolveMainBranch: async () => {
        for (const v of [OWNER_PW, HOST_DIRECT, HOST_POOLED, OWNER, "br-main"]) redactor.add(v);
        return {
          branchId: "br-main",
          endpointId: "ep-cool-dark-123456",
          host: HOST_DIRECT,
          poolerHost: HOST_POOLED,
          database: "neondb",
          ownerRole: OWNER,
          ownerDirect: { host: HOST_DIRECT, user: OWNER, password: OWNER_PW, database: "neondb" },
        };
      },
      createRole: async (/** @type {string} */ _b, /** @type {string} */ name) => {
        roleCalls.push(`create:${name}`);
        redactor.add(PW[/** @type {keyof typeof PW} */ (name)]);
        return PW[/** @type {keyof typeof PW} */ (name)];
      },
      resetRolePassword: async (/** @type {string} */ _b, /** @type {string} */ name) => {
        roleCalls.push(`reset:${name}`);
        return PW[/** @type {keyof typeof PW} */ (name)];
      },
      deleteRole: async (/** @type {string} */ _b, /** @type {string} */ name) => void roleCalls.push(`delete:${name}`),
    };
    const env = { NEON_API_KEY: NEON_KEY, NEON_PROJECT_ID: "dry-heart-13671059", FLY_API_TOKEN: FLY_TOKEN, RESEND_API_KEY: RESEND };
    const run = (/** @type {string[]} */ argv = [], /** @type {Record<string, string>} */ extraEnv = {}) =>
      main({ env: { ...env, ...extraEnv }, argv, say: (s) => void said.push(s), rand: makeRand(), redactor, api, fly, psql, outDir });
    return { run, said, imports, roleCalls, outDir, redactor };
  }
  const allText = (/** @type {ReturnType<typeof harness>} */ h) =>
    [...h.said, ...readdirSync(h.outDir).map((f) => readFileSync(path.join(h.outDir, f), "utf8"))].join("\n");

  it("yeşil: özet satırları + sır ADLARI; hiçbir değer (URL/host/parola/anahtar) çıktıda ve özette yok", async () => {
    const h = harness();
    expect(await h.run()).toBe(0);
    const text = allText(h);
    expect(text).toContain("wms_app: OK (nosuperuser, nobypassrls)");
    expect(text).toContain("wms_auth: OK");
    expect(text).toContain("wms_worker: OK");
    expect(text).toContain("wms_identity_probe: OK (set, noinherit, noadmin)");
    expect(text).toContain("owner_bypassrls: true");
    for (const name of ["DATABASE_URL", "AUTH_DATABASE_URL", "DATABASE_URL_WORKER", "BETTER_AUTH_SECRET", "DEMO_PASSWORD", "QUEUE_SEAL_KEY", "RESEND_API_KEY", "SIGNUP_ENABLED"]) {
      expect(text).toContain(name);
    }
    const imported = h.imports.join("");
    for (const secret of [...Object.values(PW), OWNER_PW, HOST_DIRECT, HOST_POOLED, OWNER, FLY_TOKEN, NEON_KEY, RESEND]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    // Fly'a giden metin: pooled host + uygulama rolü; sahip kimlik bilgisi ve DIRECT adı yok.
    expect(imported).toContain(`DATABASE_URL=postgresql://wms_app:${PW.wms_app}@${HOST_POOLED}/neondb?sslmode=verify-full`);
    expect(imported).toContain(`AUTH_DATABASE_URL=postgresql://wms_auth:`);
    expect(imported).toContain(`DATABASE_URL_WORKER=postgresql://wms_worker:`);
    expect(imported).not.toContain(OWNER_PW);
    expect(imported).not.toContain("DIRECT");
    expect(imported).toContain(`RESEND_API_KEY=${RESEND}`);
    expect(h.redactor.leaks(allText(h))).toEqual([]);
  });

  it("ikinci koşu (roller + sırlar var): rol parolaları ve sırlar yeniden üretilmez", async () => {
    const h = harness({
      rolesExist: true,
      existingFly: ["DATABASE_URL", "AUTH_DATABASE_URL", "DATABASE_URL_WORKER", "BETTER_AUTH_SECRET", "QUEUE_SEAL_KEY", "DEMO_PASSWORD", "RESEND_API_KEY"],
    });
    expect(await h.run()).toBe(0);
    expect(h.roleCalls).toEqual([]);
    const imported = h.imports.join("");
    for (const name of ["DATABASE_URL=", "AUTH_DATABASE_URL=", "DATABASE_URL_WORKER=", "BETTER_AUTH_SECRET=", "QUEUE_SEAL_KEY=", "DEMO_PASSWORD="]) {
      expect(imported).not.toContain(name);
    }
    expect(imported).toContain("SIGNUP_ENABLED=false");
    expect(imported).toContain("WMS_ENV=staging");
  });

  it("--rotate: var olan roller için parola sıfırlanır ve URL'ler yeniden yazılır", async () => {
    const h = harness({ rolesExist: true, existingFly: ["DATABASE_URL", "AUTH_DATABASE_URL", "DATABASE_URL_WORKER"] });
    expect(await h.run(["--rotate"])).toBe(0);
    expect(h.roleCalls).toEqual(["reset:wms_app", "reset:wms_auth", "reset:wms_worker"]);
    expect(h.imports.join("")).toContain(`DATABASE_URL=postgresql://wms_app:${PW.wms_app}@`);
  });

  it("DATABASE_URL_DIRECT Fly'da varsa kırmızı (hiçbir şey yazılmaz)", async () => {
    const h = harness({ existingFly: ["DATABASE_URL_DIRECT"] });
    expect(await h.run()).toBe(1);
    expect(h.imports).toEqual([]);
    expect(allText(h)).toContain("yasak sır adı");
  });

  it("roller niteliksiz (API yolu) → BLOCKED çıkış 2, Fly'a yazım yok, yaratılan roller silinir", async () => {
    const h = harness({ rolesBlocked: true });
    expect(await h.run()).toBe(2);
    expect(h.imports).toEqual([]);
    expect(h.roleCalls).toEqual(["create:wms_app", "create:wms_auth", "create:wms_worker", "delete:wms_app", "delete:wms_auth", "delete:wms_worker"]);
    expect(allText(h)).toContain("Fly'a hiçbir sır yazılmadı");
  });

  it("probe BLOCKED → çıkış 2, Fly'a yazım yok (roller yine de değerlendirilir: tek koşuda tüm engeller görünür)", async () => {
    const h = harness({ probeBlocked: true });
    expect(await h.run()).toBe(2);
    expect(h.roleCalls).toEqual(["create:wms_app", "create:wms_auth", "create:wms_worker"]);
    expect(h.imports).toEqual([]);
    expect(allText(h)).toContain("wms_identity_probe: BLOCKED");
  });

  it("Fly yazımı başarısız → kırmızı; yazım sonrası eksik ad → kırmızı", async () => {
    expect(await harness({ importFails: true }).run()).toBe(1);
    const h = harness({ flyAfterMissing: true });
    expect(await h.run()).toBe(1);
    expect(allText(h)).toContain("Fly sır doğrulaması FAIL");
  });

  it("SQL yolu: karar kaydı yoksa BLOCKED (hiçbir ağ/psql çağrısı yok)", async () => {
    const h = harness();
    const code = await main({
      env: { NEON_API_KEY: "k", NEON_PROJECT_ID: "p", FLY_API_TOKEN: "t" },
      argv: ["--role-path", "sql", "--sql-decision", "A-99"],
      say: () => undefined,
      readFile: () => "A-1 | x",
      outDir: h.outDir,
      api: { resolveMainBranch: () => Promise.reject(new Error("çağrılmamalı")) },
    });
    expect(code).toBe(2);
  });

  it("eksik girdi: yalnızca ADLAR; STAGING_DEMO_PASSWORD çok kısa → kırmızı", async () => {
    const h = harness();
    expect(await main({ env: {}, argv: [], say: (s) => void h.said.push(s), outDir: h.outDir })).toBe(1);
    expect(h.said.join("\n")).toContain("NEON_API_KEY, NEON_PROJECT_ID");
    expect(await harness().run([], { STAGING_DEMO_PASSWORD: "kisa" })).toBe(1);
  });
});
