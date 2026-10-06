import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRedactor } from "./neon-spike.mjs";
import {
  DeployMigrateError,
  assertDirectUri,
  assertFallbackAllowed,
  buildChildEnv,
  main,
  parseArgs,
  readUriFile,
  resolveDirectUri,
  resolveViaNeonApi,
  runMigrateProcess,
  summarizeMigrateOutput,
} from "./deploy-migrate.mjs";

/** Koşu başına rastgele sahte değerler (literal sır yok). */
const rnd = (/** @type {string} */ p) => `${p}${randomBytes(9).toString("hex")}`;
const PW = rnd("pw");
const API_KEY = rnd("key");
const HOST = `ep-${rnd("h")}.eu-central-1.aws.neon.tech`;
const USER = rnd("owner");
const URI = `postgresql://${USER}:${PW}@${HOST}/neondb?sslmode=require`;
const AUG = new Date("2026-10-06T12:00:00Z");

describe("assertFallbackAllowed (A-54 tarih denetimi)", () => {
  it("2026-11-15 23:59:59Z → izinli", () => {
    expect(() => assertFallbackAllowed(new Date("2026-11-15T23:59:59Z"))).not.toThrow();
  });
  it("2026-11-16 → hata", () => {
    expect(() => assertFallbackAllowed(new Date("2026-11-16T00:00:00Z"))).toThrow(DeployMigrateError);
    expect(() => assertFallbackAllowed(new Date("2026-11-16T12:00:00Z"))).toThrow(/A-54/);
  });
});

describe("assertDirectUri", () => {
  it("pooler host → ret; hata iletisi URI içermez", () => {
    const pooled = `postgresql://${USER}:${PW}@${HOST.replace(".", "-pooler.")}/neondb`;
    try {
      assertDirectUri(pooled);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("pooler");
      expect(String(e)).not.toContain(PW);
    }
  });
  it("postgres olmayan şema / bozuk URI → ret", () => {
    expect(() => assertDirectUri("https://x/y")).toThrow(DeployMigrateError);
    expect(() => assertDirectUri("bozuk")).toThrow(DeployMigrateError);
  });
  it("doğrudan URI → kabul", () => {
    expect(() => assertDirectUri(URI)).not.toThrow();
  });
});

describe("buildChildEnv", () => {
  it("sırlar geçmez; yalnızca izinli + DATABASE_URL_DIRECT/WMS_ENV/DEMO_MODE", () => {
    const e = buildChildEnv(
      { PATH: "/bin", HOME: "/h", NEON_API_KEY: API_KEY, FLY_API_TOKEN: rnd("f"), DATABASE_URL: "x", STAGING_DATABASE_URL_DIRECT: URI, GITHUB_STEP_SUMMARY: "/s" },
      URI,
    );
    expect(Object.keys(e).sort()).toEqual(["DATABASE_URL_DIRECT", "DEMO_MODE", "HOME", "PATH", "WMS_ENV"]);
    const e2 = buildChildEnv({ PATH: "/bin", RUNNER_TEMP: "/t", NODE_OPTIONS: "--require /x", GITHUB_ACTIONS: "true" }, URI);
    expect(Object.keys(e2)).not.toContain("RUNNER_TEMP");
    expect(Object.keys(e2)).not.toContain("NODE_OPTIONS");
    expect(e["WMS_ENV"]).toBe("staging");
    expect(e["DEMO_MODE"]).toBe("1");
    expect(e["DATABASE_URL_DIRECT"]).toBe(URI);
    expect(JSON.stringify(e)).not.toContain(API_KEY);
  });
});

const fakeApi = (/** @type {any[]} */ uriQ = []) => () => ({
  findMainBranch: async () => ({ id: "br-1", name: "main" }),
  getReadWriteEndpoint: async () => ({ id: "ep-1", host: HOST, poolerHost: "p" }),
  getDatabase: async () => ({ name: "neondb", ownerName: USER }),
  getConnectionUri: async (/** @type {any} */ q) => (uriQ.push(q), URI),
});
const tmpFile = (name = "uri") => path.join(mkdtempSync(path.join(tmpdir(), "t106-")), name);

describe("resolveDirectUri (Migrate adımı; NEON_API_KEY görmez)", () => {
  it("STAGING_DATABASE_URL_DIRECT varsa direct-secret; maskelenir; tarih geçse de etkilenmez", () => {
    const writes = /** @type {string[]} */ ([]);
    const redactor = createRedactor();
    const r = resolveDirectUri({
      env: { STAGING_DATABASE_URL_DIRECT: URI, GITHUB_ACTIONS: "true" },
      now: new Date("2027-01-01T00:00:00Z"),
      redactor,
      write: (s) => void writes.push(s),
    });
    expect(r).toEqual({ path: "direct-secret", uri: URI });
    expect(writes.join("")).toContain("::add-mask::");
    expect(redactor.redact(`x ${PW} y`)).not.toContain(PW);
  });

  it("sır yok + --uri-file → neon-api yolu; dosya okunup silinir", () => {
    const f = tmpFile();
    writeFileSync(f, `${URI}\n`, { mode: 0o600 });
    const r = resolveDirectUri({ env: {}, now: AUG, redactor: createRedactor(), write: () => {}, uriFile: f });
    expect(r).toEqual({ path: "neon-api", uri: URI });
    expect(existsSync(f)).toBe(false);
  });

  it("sır yok + dosya yok → hata", () => {
    expect(() => resolveDirectUri({ env: {}, now: AUG, redactor: createRedactor() })).toThrow(/URI kaynağı yok/);
  });

  it("2026-11-16 + yedek yol (dosya) → hata, dosya okunmaz", () => {
    const f = tmpFile();
    writeFileSync(f, `${URI}\n`, { mode: 0o600 });
    expect(() =>
      resolveDirectUri({ env: {}, now: new Date("2026-11-16T00:00:00Z"), redactor: createRedactor(), uriFile: f }),
    ).toThrow(/A-54/);
    expect(existsSync(f)).toBe(true);
  });

  it("grup/herkes okuyabilen URI dosyası → ret", () => {
    const f = tmpFile();
    writeFileSync(f, `${URI}\n`, { mode: 0o644 });
    expect(() => readUriFile(f)).toThrow(/0600/);
  });
});

describe("resolveViaNeonApi (yedek yol adımı)", () => {
  it("sahip rolün doğrudan (pooled=false) URI'sini döndürür", async () => {
    /** @type {any[]} */
    const uriQ = [];
    const uri = await resolveViaNeonApi({
      env: { NEON_API_KEY: API_KEY, NEON_PROJECT_ID: "proj" },
      now: AUG,
      redactor: createRedactor(),
      write: () => {},
      apiFactory: /** @type {any} */ (fakeApi(uriQ)),
    });
    expect(uri).toBe(URI);
    expect(uriQ[0]).toEqual({ branchId: "br-1", databaseName: "neondb", roleName: USER, pooled: false });
  });

  it("2026-11-16 → hata (API çağrılmadan)", async () => {
    await expect(
      resolveViaNeonApi({
        env: { NEON_API_KEY: API_KEY, NEON_PROJECT_ID: "proj" },
        now: new Date("2026-11-16T00:00:00Z"),
        redactor: createRedactor(),
        write: () => {},
        apiFactory: () => {
          throw new Error("API çağrılmamalı");
        },
      }),
    ).rejects.toThrow(/A-54/);
  });

  it("anahtar yok → hata, yalnızca ADLAR", async () => {
    await expect(resolveViaNeonApi({ env: {}, now: AUG, redactor: createRedactor() })).rejects.toThrow(/NEON_API_KEY/);
  });
});

describe("parseArgs", () => {
  it("geçerli kombinasyonlar ve hatalar", () => {
    expect(parseArgs([])).toEqual({ resolveOnly: false });
    expect(parseArgs(["--resolve-only", "--out", "/x"])).toEqual({ resolveOnly: true, out: "/x" });
    expect(parseArgs(["--uri-file", "/y"])).toEqual({ resolveOnly: false, uriFile: "/y" });
    expect(() => parseArgs(["--resolve-only"])).toThrow(DeployMigrateError);
    expect(() => parseArgs(["--resolve-only", "--out", "/x", "--uri-file", "/y"])).toThrow(DeployMigrateError);
    expect(() => parseArgs(["--bilinmeyen"])).toThrow(DeployMigrateError);
  });
});

describe("summarizeMigrateOutput", () => {
  it("uygulanan sürüm listesi ve queue satırı", () => {
    const s = summarizeMigrateOutput(
      "pnpm gürültü\nmigrate: 3 migration uygulandı (0001_a, 0002_b, 0003_c); uygulanmış toplam: 3\nmigrate: demo tenant kuruldu\nqueue install: pg-boss şeması hazır\n",
    );
    expect(s.applied).toEqual(["0001_a", "0002_b", "0003_c"]);
    expect(s.nothingPending).toBe(false);
    expect(s.lines).toHaveLength(3);
  });
  it("0 bekleyen", () => {
    const s = summarizeMigrateOutput("migrate: 0 bekleyen migration (uygulanmış toplam: 3)\n");
    expect(s.nothingPending).toBe(true);
    expect(s.applied).toEqual([]);
  });
});

describe("runMigrateProcess + main", () => {
  const fixture = (/** @type {string} */ code) => ({ command: process.execPath, args: ["-e", code] });

  it("alt süreç yalnızca daraltılmış ortamı görür ve çıktı maskelenir", async () => {
    const redactor = createRedactor();
    redactor.add(PW);
    const out = /** @type {string[]} */ ([]);
    const r = await runMigrateProcess({
      env: { PATH: process.env["PATH"] ?? "", DATABASE_URL_DIRECT: URI },
      redactor,
      write: (s) => void out.push(s),
      ...fixture(
        `console.log("migrate: 1 migration uygulandı (0001_x); uygulanmış toplam: 1"); console.log("sızıntı", process.env.DATABASE_URL_DIRECT); console.log("anahtar:", String(process.env.NEON_API_KEY));`,
      ),
    });
    expect(r.code).toBe(0);
    expect(r.leaked).toBe(true);
    expect(out.join("")).not.toContain(PW);
    expect(out.join("")).toContain("anahtar: undefined");
  });

  it("main: alt süreç hatası → 1 (fail-closed), yol özetlenir; başarı → 0 ve özet dosyası", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t106-"));
    const summaryFile = path.join(dir, "summary.md");
    const env = { STAGING_DATABASE_URL_DIRECT: URI, PATH: process.env["PATH"] };
    const out = /** @type {string[]} */ ([]);
    const ok = await main({
      env,
      now: AUG,
      write: (s) => void out.push(s),
      summaryFile,
      argv: [],
      runner: async () => ({ code: 0, stdout: "migrate: 3 migration uygulandı (0001_a, 0002_b, 0003_c); uygulanmış toplam: 3\n", leaked: false }),
    });
    expect(ok).toBe(0);
    const md = readFileSync(summaryFile, "utf8");
    expect(md).toContain("`direct-secret`");
    expect(md).toContain("0001_a, 0002_b, 0003_c");
    expect(md).not.toContain("fallback");

    const bad = await main({
      env,
      now: AUG,
      write: (s) => void out.push(s),
      summaryFile,
      argv: [],
      runner: async () => ({ code: 1, stdout: "migrate: MigrationError\n", leaked: false }),
    });
    expect(bad).toBe(1);
    const all = out.join("") + readFileSync(summaryFile, "utf8");
    expect(all).not.toContain(PW);
    expect(all).not.toContain(HOST);
  });

  it("main: --resolve-only 0600 dosya yazar; --uri-file ile Migrate fallback özeti; tarih geçince 1", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t106-"));
    const summaryFile = path.join(dir, "summary.md");
    const uriFile = path.join(dir, "uri");
    const out = /** @type {string[]} */ ([]);
    const code1 = await main({
      env: { NEON_API_KEY: API_KEY, NEON_PROJECT_ID: "p" },
      now: AUG,
      write: (s) => void out.push(s),
      argv: ["--resolve-only", "--out", uriFile],
      apiFactory: /** @type {any} */ (fakeApi()),
    });
    expect(code1).toBe(0);
    expect(statSync(uriFile).mode & 0o777).toBe(0o600);
    expect(out.join("")).not.toContain(PW);

    let received = /** @type {Record<string, string> | null} */ (null);
    const code = await main({
      env: { PATH: process.env["PATH"] },
      now: AUG,
      write: () => {},
      summaryFile,
      argv: ["--uri-file", uriFile],
      runner: async (x) => ((received = x.env), { code: 0, stdout: "migrate: 0 bekleyen migration (uygulanmış toplam: 3)\n", leaked: false }),
    });
    expect(code).toBe(0);
    expect(readFileSync(summaryFile, "utf8")).toContain("fallback: neon-api");
    expect(received).not.toBeNull();
    expect(Object.keys(received ?? {})).not.toContain("NEON_API_KEY");
    expect(existsSync(uriFile)).toBe(false);

    const late = await main({
      env: { NEON_API_KEY: API_KEY, NEON_PROJECT_ID: "p" },
      now: new Date("2026-11-16T00:00:00Z"),
      write: () => {},
      argv: ["--resolve-only", "--out", path.join(dir, "uri2")],
      apiFactory: /** @type {any} */ (fakeApi()),
    });
    expect(late).toBe(1);
    expect(existsSync(path.join(dir, "uri2"))).toBe(false);
  });
});
