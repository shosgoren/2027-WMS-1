import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  branchNameFor,
  buildSummary,
  cell,
  computeTestTimeoutMs,
  measureLatency,
  LATENCY_PROBE,
  createAppRole,
  createAppRoleSql,
  createLineFilter,
  createNeonApi,
  createRedactor,
  extractConnection,
  gatePassed,
  isPasswordRejection,
  main,
  maskSecret,
  parseAppRoleCheck,
  parseOwnerCheck,
  parsePsqlSqlstate,
  parsePsqlTimings,
  parseVitestReport,
  percentile,
  pickAc05Durations,
  pgUrl,
  pickAc05,
  readSpikeEnv,
  renderSummaryMd,
  scanDirForLeaks,
  scramSha256Keys,
  scramSha256Verifier,
} from "./neon-spike.mjs";

// Sentetik değerler (gerçek sır değildir; G-09).
const PASSWORD = "Sup3r$ecret/Pa:ss@word";
const OWNER = "neondb_owner";
const HOST = "ep-cool-darkness-123456.c-2.eu-central-1.aws.neon.tech";
const POOLER = "ep-cool-darkness-123456-pooler.c-2.eu-central-1.aws.neon.tech";
/** Sentetik hex parola (çalışma anında; düşük entropili). */
const APP_PW = "ab".repeat(16);
const URL_DIRECT = pgUrl({ user: OWNER, password: PASSWORD, host: HOST, database: "neondb" });
const URL_POOLED = pgUrl({ user: "wms_app", password: APP_PW, host: POOLER, database: "neondb" });

function seeded() {
  const r = createRedactor();
  for (const v of [PASSWORD, OWNER, HOST, POOLER, URL_DIRECT, URL_POOLED, APP_PW, "ep-cool-darkness-123456"]) r.add(v);
  return r;
}

/** Çıktıda hiçbir gizli parça kalmadığını doğrular. @param {string} out */
function expectClean(out) {
  for (const s of [PASSWORD, encodeURIComponent(PASSWORD), OWNER, HOST, POOLER, "ep-cool-darkness-123456", APP_PW]) {
    expect(out).not.toContain(s);
  }
  expect(out).not.toMatch(/postgres(?:ql)?:\/\//i);
}

describe("createRedactor", () => {
  it("URL, parola (ham ve URL kodlu), kullanıcı, host ve uç nokta kimliğini çıkarır", () => {
    const r = seeded();
    const msg = `connect failed ${URL_DIRECT} password authentication failed for user "${OWNER}" host ${HOST} pw=${PASSWORD} enc=${encodeURIComponent(PASSWORD)}`;
    const out = r.redact(msg);
    expectClean(out);
    expect(out).toContain("connect failed");
  });

  it("bilinmeyen (kümede olmayan) postgres URL'si ve Neon uç nokta host'u genel desenle maskelenir", () => {
    const r = createRedactor();
    const out = r.redact("x postgresql://u:p@ep-other-thing-999.c-3.us-east-2.aws.neon.tech/db y ep-wild-sun-42.c-1.aws.neon.tech z");
    expect(out).toBe("x <url> y <neon-endpoint> z");
  });

  it("leaks: türleri döndürür, değeri değil; temiz metin → boş", () => {
    const r = seeded();
    expect(r.leaks(`fail ${PASSWORD}`)).toEqual(["secret-value"]);
    expect(r.leaks("postgres://a:b@somehost/db")).toEqual(["credential-url"]);
    expect(r.leaks("host ep-brave-moon-777777.c-2.aws.neon.tech")).toContain("neon-endpoint");
    expect(r.leaks("[test:int] target=neon app=ep***.c-2.eu-central-1.aws.neon.tech wms_app")).toEqual([]);
  });

  it("IPv4 ve IPv6 adresleri maskelenir; saat damgası ve sürüm dizeleri bozulmaz", () => {
    const r = createRedactor();
    const msg =
      'psql: error: connection to server at "x" (3.125.57.42), port 5432 failed; also (2a05:d014:1f8:c501:94c0:e3ac:5d7e:1a2b) ' +
      "and [fe80::1] and ::1 at 18:28:08 server_version 17.5";
    const out = r.redact(msg);
    expect(out).not.toContain("3.125.57.42");
    expect(out).not.toContain("2a05:d014");
    expect(out).not.toContain("fe80::1");
    expect(out).not.toMatch(/::1\b/);
    expect(out).toContain("(<ip>), port 5432");
    expect(out).toContain("18:28:08");
    expect(out).toContain("17.5");
  });

  it("çok kısa değerler kümeye eklenmez (anlamsız eşleşme olmasın)", () => {
    const r = createRedactor();
    r.add("ab");
    r.add("");
    r.add(undefined);
    expect(r.size()).toBe(0);
  });
});

describe("maskSecret", () => {
  it("Actions'ta ::add-mask:: yazar; Actions dışında değeri HİÇ yazmaz", () => {
    const r = createRedactor();
    /** @type {string[]} */
    const out = [];
    maskSecret(r, PASSWORD, { env: { GITHUB_ACTIONS: "true" }, write: (s) => out.push(s) });
    expect(out).toEqual([`::add-mask::${PASSWORD}\n`]);
    /** @type {string[]} */
    const local = [];
    maskSecret(r, "another-secret-value", { env: {}, write: (s) => local.push(s) });
    expect(local).toEqual([]);
    expect(r.redact("another-secret-value")).toBe("***");
  });
});

describe("createLineFilter", () => {
  it("parça sınırında bölünen gizli değer de maskelenir ve sızıntı sayılır", () => {
    const r = seeded();
    /** @type {string[]} */
    const written = [];
    /** @type {string[][]} */
    const leaks = [];
    const f = createLineFilter(r, (s) => written.push(s), (k) => leaks.push(k));
    const line = `Error: connect ECONNREFUSED ${HOST}:5432 user=${OWNER}\n`;
    const cut = line.indexOf(HOST) + 5;
    f.push(line.slice(0, cut));
    f.push(line.slice(cut));
    f.push("ok line\npartial-tail");
    f.end();
    const out = written.join("");
    expectClean(out);
    expect(out).toContain("ok line\n");
    expect(out).toContain("partial-tail");
    expect(leaks).toHaveLength(1);
  });
});

describe("scanDirForLeaks", () => {
  /** @type {string | undefined} */
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("alt dizinler dahil sızıntılı dosyaları yol + türle bildirir", () => {
    dir = mkdtempSync(path.join(tmpdir(), "neon-spike-"));
    mkdirSync(path.join(dir, "runs", "gate"), { recursive: true });
    writeFileSync(path.join(dir, "summary.md"), "temiz");
    writeFileSync(path.join(dir, "runs", "gate", "report.json"), JSON.stringify({ msg: `boom ${URL_DIRECT}` }));
    const found = scanDirForLeaks(dir, seeded());
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe(path.join("runs", "gate", "report.json"));
    expect(JSON.stringify(found)).not.toContain(PASSWORD);
  });
});

describe("readSpikeEnv / branchNameFor", () => {
  it("eksik girdilerin yalnızca ADLARI hata mesajında", () => {
    expect(() => readSpikeEnv({})).toThrow(/NEON_API_KEY, NEON_PROJECT_ID/);
    let msg = "";
    try {
      readSpikeEnv({ NEON_API_KEY: "napi_secretvalue123", NEON_PROJECT_ID: "  " });
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toContain("NEON_PROJECT_ID");
    expect(msg).not.toContain("napi_secretvalue123");
  });

  it("main: girdi yoksa çıkış ≠ 0, değer basılmaz", async () => {
    /** @type {string[]} */
    const lines = [];
    const code = await main({ env: { NEON_API_KEY: "napi_secretvalue123" }, log: (s) => lines.push(s) });
    expect(code).not.toBe(0);
    expect(lines.join("\n")).toContain("NEON_PROJECT_ID");
    expect(lines.join("\n")).not.toContain("napi_secretvalue123");
  });

  it("dal adı spike-<run_id>; yeniden denemede ek", () => {
    expect(branchNameFor({ GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" })).toBe("spike-123");
    expect(branchNameFor({ GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" })).toBe("spike-123-2");
    expect(branchNameFor({})).toMatch(/^spike-local-[0-9]+$/);
  });
});

describe("extractConnection / pgUrl / createAppRoleSql", () => {
  const created = {
    branch: { id: "br-curly-wave-af4i4oeu" },
    endpoints: [{ id: "ep-cool-darkness-123456", host: HOST, type: "read_write", region_id: "aws-eu-central-1" }],
    databases: [{ name: "neondb", owner_name: OWNER }],
    connection_uris: [
      { connection_uri: URL_DIRECT, connection_parameters: { database: "neondb", password: PASSWORD, role: OWNER, host: HOST, pooler_host: POOLER } },
    ],
  };

  it("belgedeki yanıt biçiminden alanları alır", () => {
    expect(extractConnection(created)).toEqual({
      branchId: "br-curly-wave-af4i4oeu",
      endpointId: "ep-cool-darkness-123456",
      regionId: "aws-eu-central-1",
      host: HOST,
      poolerHost: POOLER,
      database: "neondb",
      ownerRole: OWNER,
      ownerPassword: PASSWORD,
    });
  });

  it("pooler_host / connection_uris yoksa -pooler eki türetilir, parola null", () => {
    const c = extractConnection({ ...created, connection_uris: undefined });
    expect(c.poolerHost).toBe(POOLER);
    expect(c.ownerPassword).toBeNull();
  });

  it("eksik alan → hata, mesajda değer yok", () => {
    expect(() => extractConnection({ branch: {}, endpoints: [] })).toThrow(/branch\.id/);
  });

  it("pgUrl tam TLS doğrulamalı ve kimlik bilgilerini kodlar", () => {
    const u = new URL(URL_DIRECT);
    expect(decodeURIComponent(u.password)).toBe(PASSWORD);
    expect(u.searchParams.get("sslmode")).toBe("verify-full");
    expect(u.hostname).toBe(HOST);
  });

  it("wms_app SQL'i kartın özniteliklerini taşır, DÜZ PAROLA değil SCRAM özeti gönderir; hex olmayan parola reddedilir", () => {
    const sql = createAppRoleSql(APP_PW);
    expect(sql).not.toContain(APP_PW);
    expect(sql).toMatch(/PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+';/);
    for (const kw of ["LOGIN", "NOSUPERUSER", "NOBYPASSRLS", "NOCREATEDB", "NOCREATEROLE", "NOREPLICATION"]) expect(sql).toContain(kw);
    expect(() => createAppRoleSql("x'; DROP ROLE y; --")).toThrow();
  });
});

describe("SCRAM-SHA-256 (RFC 5802 / RFC 7677)", () => {
  // RFC 7677 §3 test vektörü: kullanıcı "user", parola "pencil".
  const SALT = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const AUTH_MESSAGE =
    "n=user,r=rOprNGfwEbeRWgbNEkqO," +
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096," +
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
  const CLIENT_PROOF = "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=";
  const SERVER_SIGNATURE = "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";

  it("ServerKey RFC 7677 ServerSignature'ını, StoredKey ClientProof'unu üretir", () => {
    const { clientKey, storedKey, serverKey } = scramSha256Keys("pencil", SALT, 4096);
    expect(createHmac("sha256", serverKey).update(AUTH_MESSAGE).digest("base64")).toBe(SERVER_SIGNATURE);
    const clientSignature = createHmac("sha256", storedKey).update(AUTH_MESSAGE).digest();
    const proof = Buffer.from(clientKey.map((b, i) => b ^ (clientSignature[i] ?? 0)));
    expect(proof.toString("base64")).toBe(CLIENT_PROOF);
  });

  it("PostgreSQL rolpassword biçimi: SCRAM-SHA-256$<iter>:<tuz>$<StoredKey>:<ServerKey>", () => {
    const v = scramSha256Verifier("pencil", { salt: SALT, iterations: 4096 });
    const { storedKey, serverKey } = scramSha256Keys("pencil", SALT, 4096);
    expect(v).toBe(`SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$${storedKey.toString("base64")}:${serverKey.toString("base64")}`);
    expect(v).not.toContain("pencil");
  });

  it("tuz verilmezse her çağrıda rastgele (16 bayt); ASCII dışı parola reddedilir", () => {
    const a = scramSha256Verifier("pencil");
    const b = scramSha256Verifier("pencil");
    expect(a).not.toBe(b);
    expect(Buffer.from(a.split("$")[1]?.split(":")[1] ?? "", "base64")).toHaveLength(16);
    expect(() => scramSha256Verifier("şifre")).toThrow(/ASCII/);
  });
});

describe("createAppRole (SCRAM → reddedilirse bir kez düz parola)", () => {
  const PW192 = "cd".repeat(24); // sentetik, 192 bit uzunluğunda hex
  const direct = { host: HOST, user: OWNER, password: PASSWORD, database: "neondb" };
  /**
   * @param {Array<{ ok: boolean, sqlstate?: string | null, error?: string | null }>} script
   */
  function fakeRun(script) {
    /** @type {string[]} */
    const sqls = [];
    /** @type {(t: any, sql: string) => import("./neon-spike.mjs").PsqlResult} */
    const run = (_t, sql) => {
      sqls.push(sql);
      const next = script[sqls.length - 1];
      if (next === undefined) throw new Error("beklenmeyen ek psql çağrısı");
      return { ok: next.ok, stdout: "", sqlstate: next.sqlstate ?? null, error: next.error ?? null };
    };
    return { run, sqls };
  }

  it("SCRAM kabul edilirse tek deneme; düz parola hiç gönderilmez; özet maskelenir", () => {
    const f = fakeRun([{ ok: true }]);
    /** @type {string[]} */
    const masked = [];
    const r = createAppRole({ direct, password: PW192, redactor: createRedactor(), mask: (v) => masked.push(v), run: f.run });
    expect(r).toMatchObject({ ok: true, path: "scram" });
    expect(f.sqls).toHaveLength(1);
    expect(f.sqls[0]).not.toContain(PW192);
    expect(f.sqls[0]).toContain("SCRAM-SHA-256$4096:");
    expect(masked).toHaveLength(1);
    expect(f.sqls[0]).toContain(masked[0]);
  });

  it("parola reddi (22023) → bir kez düz parolayla yeniden dener; yol ve iki deneme kaydedilir", () => {
    const f = fakeRun([{ ok: false, sqlstate: "22023", error: "ERROR:  22023: password is too weak" }, { ok: true }]);
    const r = createAppRole({ direct, password: PW192, redactor: createRedactor(), mask: () => undefined, run: f.run });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("plaintext-retry");
    expect(r.attempts.map((a) => [a.path, a.ok, a.sqlstate])).toEqual([
      ["scram", false, "22023"],
      ["plaintext", true, null],
    ]);
    expect(f.sqls[1]).toContain(`PASSWORD '${PW192}'`);
  });

  it("düz parola da reddedilirse başarısız (üçüncü deneme yok)", () => {
    const f = fakeRun([
      { ok: false, sqlstate: "28P01", error: "x" },
      { ok: false, sqlstate: "28P01", error: "y" },
    ]);
    const r = createAppRole({ direct, password: PW192, redactor: createRedactor(), mask: () => undefined, run: f.run });
    expect(r).toMatchObject({ ok: false, path: "plaintext-retry" });
    expect(f.sqls).toHaveLength(2);
  });

  it("başka neden (yetki 42501, çakışan rol 42710, bağlantı hatası) → yeniden deneme yok", () => {
    for (const fail of [
      { ok: false, sqlstate: "42501", error: "ERROR:  42501: permission denied to create role" },
      { ok: false, sqlstate: "42710", error: 'ERROR:  42710: role "wms_app" already exists' },
      { ok: false, sqlstate: null, error: 'psql: error: connection to server at "<ip>" failed: FATAL:  password authentication failed' },
    ]) {
      const f = fakeRun([fail]);
      const r = createAppRole({ direct, password: PW192, redactor: createRedactor(), mask: () => undefined, run: f.run });
      expect(r).toMatchObject({ ok: false, path: "scram" });
      expect(f.sqls).toHaveLength(1);
    }
  });

  it("isPasswordRejection: SQLSTATE'siz veya bağlantı hatası asla parola reddi sayılmaz", () => {
    expect(isPasswordRejection({ ok: false, stdout: "", sqlstate: "22023", error: "x" })).toBe(true);
    expect(isPasswordRejection({ ok: false, stdout: "", sqlstate: "XX000", error: "ERROR:  XX000: invalid password format" })).toBe(true);
    expect(isPasswordRejection({ ok: false, stdout: "", sqlstate: null, error: "password" })).toBe(false);
    expect(isPasswordRejection({ ok: true, stdout: "", sqlstate: null, error: null })).toBe(false);
  });

  it("isPasswordRejection: LINE bağlamı, DETAIL satırı ve 42xxx sınıfı yeniden denemeyi tetiklemez", () => {
    const syntax = "ERROR:  42601: syntax error at or near \"x\"\nLINE 1: CREATE ROLE wms_app LOGIN PASSWORD '***' x\n                                                    ^";
    expect(isPasswordRejection({ ok: false, stdout: "", sqlstate: "42601", error: syntax })).toBe(false);
    expect(isPasswordRejection({ ok: false, stdout: "", sqlstate: "42501", error: "ERROR:  42501: permission denied to set password" })).toBe(false);
    const detail = "ERROR:  XX000: internal error\nDETAIL:  password policy service unavailable";
    expect(isPasswordRejection({ ok: false, stdout: "", sqlstate: "XX000", error: detail })).toBe(false);
    expect(isPasswordRejection({ ok: false, stdout: "", sqlstate: "28P01", error: "ERROR:  28P01: anything" })).toBe(true);
  });

  it("192 bitten kısa parola reddedilir", () => {
    expect(() => createAppRole({ direct, password: "ab".repeat(16), redactor: createRedactor(), mask: () => undefined, run: fakeRun([]).run })).toThrow(/192/);
  });
});

describe("psql çıktı ayrıştırıcıları", () => {
  it("SQLSTATE (VERBOSITY verbose)", () => {
    expect(parsePsqlSqlstate("psql:<stdin>:1: ERROR:  42501: permission denied to create role")).toBe("42501");
    expect(parsePsqlSqlstate("psql: error: connection failed")).toBeNull();
  });

  it("wms_app denetimi: beklenen öznitelikler + 0 üyelik → ok", () => {
    expect(parseAppRoleCheck("t|f|f|f|f|f|0").ok).toBe(true);
    expect(parseAppRoleCheck("t|f|t|f|f|f|0").ok).toBe(false);
    expect(parseAppRoleCheck("t|f|f|f|f|f|1").ok).toBe(false);
    expect(parseAppRoleCheck("").ok).toBe(false);
  });

  it("sahip rol denetimi", () => {
    expect(parseOwnerCheck("f|t|t|t")).toEqual({ superuser: false, bypassrls: true, createrole: true, neonSuperuserMember: true });
    expect(parseOwnerCheck("x")).toBeNull();
  });
});

describe("createNeonApi", () => {
  /**
   * @param {Array<{ status: number, body: unknown }>} script
   */
  function fakeFetch(script) {
    /** @type {{ url: string, method: string, auth: string | undefined, body: string | undefined }[]} */
    const calls = [];
    /** @type {import("./neon-spike.mjs").FetchLike} */
    const impl = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body });
      const next = script[calls.length - 1];
      if (next === undefined) throw new Error("beklenmeyen ek çağrı");
      return { status: next.status, text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)) };
    };
    return { impl, calls };
  }

  const base = { apiKey: "napi_secretvalue123", projectId: "dry-heart-13671059", sleep: async () => undefined, pollIntervalMs: 0 };

  it("dal oluşturma: belgelenen uç nokta + gövde; Bearer başlığı", async () => {
    const f = fakeFetch([{ status: 201, body: { branch: { id: "br-x" } } }]);
    const api = createNeonApi({ ...base, redactor: createRedactor(), fetchImpl: f.impl });
    await api.createBranch("spike-1");
    expect(f.calls[0]?.url).toBe("https://console.neon.tech/api/v2/projects/dry-heart-13671059/branches");
    expect(f.calls[0]?.method).toBe("POST");
    expect(f.calls[0]?.auth).toBe("Bearer napi_secretvalue123");
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toEqual({ branch: { name: "spike-1" }, endpoints: [{ type: "read_write" }] });
  });

  it("silme: önce dalın bekleyen işlemleri beklenir, sonra silinir ve silme işlemleri 'finished' olana dek yoklanır", async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          operations: [
            { id: "opA", branch_id: "br-x", action: "start_compute", status: "running" },
            { id: "opB", branch_id: "br-other", action: "start_compute", status: "running" },
            { id: "opC", branch_id: "br-x", action: "create_branch", status: "finished" },
          ],
        },
      },
      { status: 200, body: { operation: { status: "finished" } } },
      { status: 200, body: { operations: [{ id: "op1", action: "delete_timeline", status: "running" }] } },
      { status: 200, body: { operation: { status: "running" } } },
      { status: 200, body: { operation: { status: "finished" } } },
    ]);
    const api = createNeonApi({ ...base, redactor: createRedactor(), fetchImpl: f.impl });
    await api.deleteBranch("br-x");
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(/^.*\/projects\/[^/]+/, "")}`)).toEqual([
      "GET /operations",
      "GET /operations/opA",
      "DELETE /branches/br-x",
      "GET /operations/op1",
      "GET /operations/op1",
    ]);
  });

  it("başarısız işlem ve HTTP hatası → hata; mesajda anahtar/gizli değer yok", async () => {
    const r = createRedactor();
    r.add("napi_secretvalue123");
    r.add(HOST);
    const f = fakeFetch([
      { status: 200, body: { operations: [] } },
      { status: 200, body: { operations: [{ id: "op1", action: "delete_timeline", status: "failed" }] } },
    ]);
    await expect(createNeonApi({ ...base, redactor: r, fetchImpl: f.impl }).deleteBranch("br-x")).rejects.toThrow(/durumu failed/);
    const g = fakeFetch([{ status: 401, body: { message: `bad key napi_secretvalue123 for ${HOST}` } }]);
    let msg = "";
    try {
      await createNeonApi({ ...base, redactor: r, fetchImpl: g.impl }).getProject();
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toContain("HTTP 401");
    expect(msg).not.toContain("napi_secretvalue123");
    expect(msg).not.toContain(HOST);
  });

  it("423 Locked yeniden denenir", async () => {
    const f = fakeFetch([
      { status: 423, body: { message: "locked" } },
      { status: 200, body: { project: { region_id: "aws-eu-central-1" } } },
    ]);
    const p = await createNeonApi({ ...base, redactor: createRedactor(), fetchImpl: f.impl }).getProject();
    expect(p.project.region_id).toBe("aws-eu-central-1");
    expect(f.calls).toHaveLength(2);
  });
});

describe("parseVitestReport / gatePassed / pickAc05", () => {
  const report = {
    testResults: [
      {
        name: "/w/tests/integration/ac/ac-05-pooler-isolation.int.test.ts",
        status: "passed",
        assertionResults: [
          { fullName: "AC-05 pool=1 @AC-05 pool=1: 2 tenant", status: "passed" },
          { fullName: "AC-05 pool=1 @AC-05 pool=1: abort", status: "passed" },
          { fullName: "AC-05 pool=2 @AC-05 pool=2: 2 tenant", status: "passed" },
          { fullName: "AC-05 pool=2 @AC-05 pool=2: abort", status: "passed" },
        ],
      },
      { name: "/w/tests/integration/ac/ac-28-runtime.int.test.ts", status: "passed", assertionResults: [{ fullName: "@AC-28 select", status: "passed" }] },
      { name: "/w/tests/integration/harness/harness.int.test.ts", status: "passed", assertionResults: [{ fullName: "harness x", status: "passed" }] },
    ],
  };

  it("AC ve harness sayıları", () => {
    const r = parseVitestReport(report);
    expect(r.ac05Pool1).toEqual({ total: 2, passed: 2, failed: 0, status: "PASS" });
    expect(r.ac05Pool2.status).toBe("PASS");
    expect(r.ac28.status).toBe("PASS");
    expect(r.harness.status).toBe("PASS");
    expect(gatePassed({ exitCode: 0, results: r, leakLines: 0 })).toBe(true);
  });

  it("kapı: başarısız AC, eksik AC, sızıntı veya ≠0 çıkış → geçmez", () => {
    const failed = structuredClone(report);
    const target = failed.testResults[0]?.assertionResults[2];
    if (target === undefined) throw new Error("fixture");
    target.status = "failed";
    expect(gatePassed({ exitCode: 0, results: parseVitestReport(failed), leakLines: 0 })).toBe(false);
    const noAc28 = { testResults: [report.testResults[0], report.testResults[2]] };
    expect(gatePassed({ exitCode: 0, results: parseVitestReport(noAc28), leakLines: 0 })).toBe(false);
    expect(gatePassed({ exitCode: 0, results: parseVitestReport(report), leakLines: 1 })).toBe(false);
    expect(gatePassed({ exitCode: 1, results: parseVitestReport(report), leakLines: 0 })).toBe(false);
    expect(gatePassed({ exitCode: 0, results: null, leakLines: 0 })).toBe(false);
  });

  it("pickAc05 hata METİNLERİNİ almaz; yalnızca sayılar ve SQLSTATE", () => {
    const a = pickAc05({
      prepare: true,
      prepareSource: "INT_DB_PREPARE",
      calls: 100,
      completed: 98,
      errors: 2,
      preparedErrors: 2,
      errorSqlstates: ["26000", `x ${URL_DIRECT}`],
      errorDetails: [{ message: `boom ${URL_DIRECT}` }],
      foreignRows: 0,
      outsideTxRows: 0,
    });
    expect(a?.errorSqlstates).toEqual(["26000"]);
    expectClean(JSON.stringify(a));
  });
});

describe("buildSummary / renderSummaryMd", () => {
  const gate = {
    prepare: false,
    exitCode: 0,
    status: "PASS",
    leakLines: 0,
    results: parseVitestReport({ testResults: [] }),
    ac05: { pool1: { prepare: false, errors: 0, preparedErrors: 0, errorSqlstates: [], calls: 100, completed: 100, foreignRows: 0, outsideTxRows: 0 }, pool2: null },
  };

  it("ADR-004'ün 8 alanı md'de; değer yoksa 'gözlenemedi' veya 'çalıştırılmadı'", () => {
    const md = renderSummaryMd(buildSummary({ date: "2026-10-05T00:00:00Z", result: "FAIL" }));
    for (const field of [
      "Neon bölgesi",
      "Pooler türü ve sürümü",
      "PostgreSQL ana sürümü",
      "Sürücü ve sürümü",
      "Drizzle sürümü",
      "Prepared statement",
      "Doğrudan bağlantı yöntemi",
      "Koşu tarihi ve sonucu",
    ]) {
      expect(md).toContain(`| ${field} |`);
    }
    expect(md).toContain("gözlenemedi");
    expect(md).toContain("çalıştırılmadı");
    expect(md).toContain("YALNIZCA istemci havuzuyla");
  });

  it("rol oluşturma hatası (SQLSTATE + çok satırlı maskeli mesaj) tabloyu bozmadan özete girer", () => {
    const s = buildSummary({
      date: "2026-10-05T00:00:00Z",
      result: "FAIL",
      blocked: "Q-06: wms_app sahip rolüyle doğrudan bağlantıda oluşturulamadı (yol scram, SQLSTATE 42501)",
      appRole: {
        created: false,
        path: "scram",
        attempts: [{ path: "scram", ok: false, sqlstate: "42501", error: "ERROR:  42501: permission denied\nLOCATION:  a|b" }],
        check: "çalıştırılmadı",
      },
    });
    const md = renderSummaryMd(s);
    const row = md.split("\n").find((l) => l.startsWith("| Doğrudan bağlantı yöntemi |"));
    expect(row).toContain("42501");
    expect(row).toContain("permission denied");
    expect(row).toContain("a\\|b");
    expect(md).toContain("BLOCKED: Q-06");
    expect(cell("x\ny|z")).toBe("x y\\|z");
  });

  it("dolu özet: değerler görünür, girdiye karışmış gizli değer redaksiyon sonrası kalmaz", () => {
    const r = seeded();
    const s = buildSummary({
      date: "2026-10-05T00:00:00Z",
      result: "PASS",
      region: "aws-eu-central-1",
      projectPgVersion: 17,
      serverVersionPooled: "17.5",
      serverVersionDirect: "17.5",
      driverVersion: "3.4.9",
      drizzleVersion: "0.45.3",
      pooler: { observed: true, sessions: 6, distinctBackendPids: 1, directSessions: 2, directDistinctBackendPids: 2 },
      appRole: { ok: true },
      owner: `hata: ${URL_DIRECT}`,
      gate,
      cleanup: "silindi",
    });
    const md = r.redact(renderSummaryMd(s));
    const json = r.redact(JSON.stringify(s));
    expect(md).toContain("aws-eu-central-1");
    expect(md).toContain("17.5");
    expect(md).toContain("3.4.9");
    expect(md).toContain("0.45.3");
    expect(md).toContain("çoklama gözlendi: evet");
    expect(md).toContain("A-01: teyit");
    expectClean(md);
    expectClean(json);
    expect(r.leaks(md)).toEqual([]);
  });
});

describe("gecikme ölçümü yardımcıları (T-005d zaman aşımı tanısı)", () => {
  it("percentile: en yakın sıra; boş → null", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
  });

  it("parsePsqlTimings: yalnızca 'Time: x ms' satırları", () => {
    expect(parsePsqlTimings("Time: 0.352 ms\n1\nTime: 12 ms\nnoise Time: 9 ms\nTime: 1.5 ms (00:00.002)\n")).toEqual([0.352, 12, 1.5]);
    expect(parsePsqlTimings("")).toEqual([]);
  });

  it("pickAc05Durations: başarısız/zaman aşımı dahil süre; hata metni ve başka testler yok", () => {
    const out = pickAc05Durations({
      testResults: [
        {
          assertionResults: [
            { fullName: "AC-05 pool=1 @AC-05 pool=1: 2 tenant × 50 eşzamanlı withTenant — x", status: "failed", duration: 30001.2, failureMessages: ["secret-host"] },
            { fullName: "AC-28 something", status: "passed", duration: 5 },
          ],
        },
      ],
    });
    expect(out).toEqual([{ test: "pool=1 2 tenant × 50 eşzamanlı withTenant — x", status: "failed", durationMs: 30001 }]);
    expect(JSON.stringify(out)).not.toContain("secret-host");
  });
});

describe("computeTestTimeoutMs (ölçülen RTT ile orantılı bütçe)", () => {
  it("ölçüm yok/hatalı → 30000 (fail-closed), ölçülemedi yazılır", () => {
    for (const l of [undefined, null, { error: "x" }, { roundTripMs: { p95: null } }, { roundTripMs: { p95: 0 } }]) {
      const r = computeTestTimeoutMs(l);
      expect(r.ms).toBe(30000);
      expect(r.measured).toBe(false);
      expect(r.formula).toContain("ölçülemedi");
    }
  });
  it("RTT 100 ms → 180000; RTT 1000 ms → 600000 üst sınır; düşük RTT → 30000 taban", () => {
    expect(computeTestTimeoutMs({ roundTripMs: { p95: 100 } }).ms).toBe(180000);
    expect(computeTestTimeoutMs({ roundTripMs: { p95: 1000 } }).ms).toBe(600000);
    expect(computeTestTimeoutMs({ roundTripMs: { p95: 1 } }).ms).toBe(30000);
    expect(computeTestTimeoutMs({ roundTripMs: { p95: 100 } }).formula).toContain("3 × 600 × RTT_p95_ms");
  });
});

describe("computeTestTimeoutMs hookMs ve measureLatency sınırları", () => {
  it("hookMs: ölçüm yok → 60000; RTT 100 → 180000; RTT 1000 → 600000", () => {
    expect(computeTestTimeoutMs(null).hookMs).toBe(60000);
    expect(computeTestTimeoutMs({ roundTripMs: { p95: 1 } }).hookMs).toBe(60000);
    expect(computeTestTimeoutMs({ roundTripMs: { p95: 100 } }).hookMs).toBe(180000);
    expect(computeTestTimeoutMs({ roundTripMs: { p95: 1000 } }).hookMs).toBe(600000);
  });

  it("süre sınırı aşılmışsa psql çalıştırılmadan 'süre sınırı aşıldı' (→ ölçülemedi)", () => {
    let t = 0;
    const now = () => (t++ === 0 ? 0 : LATENCY_PROBE.budgetMs + 1);
    const r = measureLatency({ host: "h", user: "u", password: "p", database: "d" }, createRedactor(), now);
    expect(r.error).toBe("ölçüm süre sınırı aşıldı");
    expect(computeTestTimeoutMs(r).ms).toBe(30000);
    expect(computeTestTimeoutMs(r).measured).toBe(false);
  });

  it("Time satırı sayısı beklenenle eşleşmiyorsa ölçüm geçersiz sayılır (sabitler 30 ve 120)", () => {
    expect(LATENCY_PROBE.roundTrips).toBe(30);
    expect(LATENCY_PROBE.transactions * LATENCY_PROBE.stmtsPerTx).toBe(120);
    expect(computeTestTimeoutMs({ error: "ölçüm geçersiz: 29 Time satırı, beklenen 30" }).measured).toBe(false);
  });
});
