import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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
  resolveDirectUri,
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
    expect(e["WMS_ENV"]).toBe("staging");
    expect(e["DEMO_MODE"]).toBe("1");
    expect(e["DATABASE_URL_DIRECT"]).toBe(URI);
    expect(JSON.stringify(e)).not.toContain(API_KEY);
  });
});

describe("resolveDirectUri", () => {
  it("STAGING_DATABASE_URL_DIRECT varsa direct-secret; Neon API çağrılmaz; maskelenir", async () => {
    const writes = /** @type {string[]} */ ([]);
    const redactor = createRedactor();
    const r = await resolveDirectUri({
      env: { STAGING_DATABASE_URL_DIRECT: URI, GITHUB_ACTIONS: "true" },
      now: new Date("2027-01-01T00:00:00Z"), // tarih geçse bile asıl yol etkilenmez
      redactor,
      write: (s) => void writes.push(s),
      apiFactory: () => {
        throw new Error("API çağrılmamalı");
      },
    });
    expect(r).toEqual({ path: "direct-secret", uri: URI });
    expect(writes.join("")).toContain("::add-mask::");
    expect(redactor.redact(`x ${PW} y`)).not.toContain(PW);
  });

  it("sır yok + NEON_API_KEY → neon-api yolu (sahip rolün doğrudan URI'si, pooled=false)", async () => {
    /** @type {any[]} */
    const uriQ = [];
    const fake = () => ({
      findMainBranch: async () => ({ id: "br-1", name: "main" }),
      getReadWriteEndpoint: async () => ({ id: "ep-1", host: HOST, poolerHost: "p" }),
      getDatabase: async () => ({ name: "neondb", ownerName: USER }),
      getConnectionUri: async (/** @type {any} */ q) => (uriQ.push(q), URI),
    });
    const r = await resolveDirectUri({
      env: { NEON_API_KEY: API_KEY, NEON_PROJECT_ID: "proj" },
      now: AUG,
      redactor: createRedactor(),
      write: () => {},
      apiFactory: /** @type {any} */ (fake),
    });
    expect(r.path).toBe("neon-api");
    expect(r.uri).toBe(URI);
    expect(uriQ[0]).toEqual({ branchId: "br-1", databaseName: "neondb", roleName: USER, pooled: false });
  });

  it("2026-11-16 + yedek yol → hata (API çağrılmadan)", async () => {
    await expect(
      resolveDirectUri({
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

  it("ikisi de yok → hata, yalnızca ADLAR", async () => {
    await expect(
      resolveDirectUri({ env: {}, now: AUG, redactor: createRedactor(), write: () => {} }),
    ).rejects.toThrow(/NEON_API_KEY/);
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
      runner: async () => ({ code: 1, stdout: "migrate: MigrationError\n", leaked: false }),
    });
    expect(bad).toBe(1);
    const all = out.join("") + readFileSync(summaryFile, "utf8");
    expect(all).not.toContain(PW);
    expect(all).not.toContain(HOST);
  });

  it("main: yedek yolda özet 'fallback: neon-api' yazar; tarih geçince 1", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t106-"));
    const summaryFile = path.join(dir, "summary.md");
    const fake = () => ({
      findMainBranch: async () => ({ id: "b", name: "m" }),
      getReadWriteEndpoint: async () => ({ id: "e", host: HOST, poolerHost: "p" }),
      getDatabase: async () => ({ name: "neondb", ownerName: USER }),
      getConnectionUri: async () => URI,
    });
    let received = /** @type {Record<string, string> | null} */ (null);
    const env = { NEON_API_KEY: API_KEY, NEON_PROJECT_ID: "p" };
    const code = await main({
      env,
      now: AUG,
      write: () => {},
      summaryFile,
      apiFactory: /** @type {any} */ (fake),
      runner: async (x) => ((received = x.env), { code: 0, stdout: "migrate: 0 bekleyen migration (uygulanmış toplam: 3)\n", leaked: false }),
    });
    expect(code).toBe(0);
    expect(readFileSync(summaryFile, "utf8")).toContain("fallback: neon-api");
    expect(received).not.toBeNull();
    expect(Object.keys(received ?? {})).not.toContain("NEON_API_KEY");

    const late = await main({
      env,
      now: new Date("2026-11-16T00:00:00Z"),
      write: () => {},
      summaryFile,
      apiFactory: /** @type {any} */ (fake),
      runner: async () => {
        throw new Error("koşmamalı");
      },
    });
    expect(late).toBe(1);
  });
});
