// Unit: migration koşturucusu (T-101). Ağ erişimi YOK: geri alma ortam/hedef denetimleri
// bağlantıdan önce yapılır; ulaşılamaz URL bir sızıntıyı bağlantı hatasıyla görünür kılar.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MigrationError,
  computeChecksum,
  loadMigrations,
  main,
  matchMigrationFiles,
  migrateDown,
  parseArgs,
  redact,
} from "./migrate.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof MigrationError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

const UNREACHABLE = "postgresql://wms_migrator:unit-secret-pw@127.0.0.1:1/unit";

describe("matchMigrationFiles", () => {
  it("pairs up/down files in version order", () => {
    const pairs = matchMigrationFiles([
      "0002_b.down.sql",
      "0001_a.up.sql",
      "0002_b.up.sql",
      "0001_a.down.sql",
      ".gitkeep",
    ]);
    expect(pairs).toEqual([
      { version: "0001", name: "a", upFile: "0001_a.up.sql", downFile: "0001_a.down.sql" },
      { version: "0002", name: "b", upFile: "0002_b.up.sql", downFile: "0002_b.down.sql" },
    ]);
  });

  it("accepts an empty directory", () => {
    expect(matchMigrationFiles([])).toEqual([]);
  });

  it("rejects an unpaired file", () => {
    expect(codeOf(() => matchMigrationFiles(["0001_a.up.sql"]))).toBe("MIGRATION_UNPAIRED_FILE");
    expect(codeOf(() => matchMigrationFiles(["0001_a.down.sql"]))).toBe("MIGRATION_UNPAIRED_FILE");
  });

  it("rejects a version gap or a start other than 0001", () => {
    const f = (v: string) => [`${v}_x.up.sql`, `${v}_x.down.sql`];
    expect(codeOf(() => matchMigrationFiles([...f("0001"), ...f("0003")]))).toBe("MIGRATION_VERSION_GAP");
    expect(codeOf(() => matchMigrationFiles(f("0002")))).toBe("MIGRATION_VERSION_GAP");
  });

  it("rejects a duplicated version (different names)", () => {
    expect(
      codeOf(() => matchMigrationFiles(["0001_a.up.sql", "0001_a.down.sql", "0001_b.up.sql", "0001_b.down.sql"])),
    ).toBe("MIGRATION_DUPLICATE_VERSION");
  });

  it("rejects malformed names", () => {
    for (const bad of ["1_a.up.sql", "0001_A.up.sql", "0001_a.sql", "0001_a.up.sql.bak", "0001__a.up.sql", "0001_a.sideways.sql"]) {
      expect(codeOf(() => matchMigrationFiles([bad]))).toBe("MIGRATION_BAD_FILENAME");
    }
  });
});

describe("computeChecksum", () => {
  it("is sha256 over up, a zero byte and down", () => {
    const up = Buffer.from("select 1;\n");
    const down = Buffer.from("select 2;\n");
    const expected = createHash("sha256").update(up).update(Buffer.from([0])).update(down).digest("hex");
    expect(computeChecksum(up, down)).toBe(expected);
  });

  it("changes when either file changes and does not confuse the boundary", () => {
    const base = computeChecksum(Buffer.from("a"), Buffer.from("b"));
    expect(computeChecksum(Buffer.from("a "), Buffer.from("b"))).not.toBe(base);
    expect(computeChecksum(Buffer.from("a"), Buffer.from("b "))).not.toBe(base);
    expect(computeChecksum(Buffer.from("ab"), Buffer.from(""))).not.toBe(computeChecksum(Buffer.from("a"), Buffer.from("b")));
  });
});

describe("loadMigrations (repo directory)", () => {
  it("loads 0001_baseline with a 64-hex checksum", () => {
    const [first] = loadMigrations();
    expect(first?.version).toBe("0001");
    expect(first?.name).toBe("baseline");
    expect(first?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseArgs", () => {
  it("parses up and down --to, ignoring the package manager's bare --", () => {
    expect(parseArgs(["up"])).toEqual({ kind: "up" });
    expect(parseArgs(["down", "--", "--to", "0001"])).toEqual({ kind: "down", to: "0001" });
    expect(parseArgs(["down", "--to=0000"])).toEqual({ kind: "down", to: "0000" });
  });

  it("rejects anything else", () => {
    for (const bad of [[], ["down"], ["up", "x"], ["down", "--to"], ["sideways"]]) {
      expect(codeOf(() => parseArgs(bad))).toBe("MIGRATION_BAD_ARGS");
    }
  });
});

describe("redact", () => {
  it("masks the URL and the password", () => {
    const out = redact(`failed ${UNREACHABLE} with unit-secret-pw`, UNREACHABLE);
    expect(out).not.toContain("unit-secret-pw");
    expect(out).not.toContain("127.0.0.1");
  });
});

describe("rollback guards (no connection is attempted)", () => {
  it("rejects outside local|ci|staging, including a missing WMS_ENV", async () => {
    for (const env of [undefined, "", "production", "prod"]) {
      await expect(migrateDown({ url: UNREACHABLE, to: "0000", wmsEnv: env })).rejects.toMatchObject({
        code: "MIGRATION_ENV_FORBIDDEN",
      });
    }
  });

  it("rejects a malformed or unknown target", async () => {
    await expect(migrateDown({ url: UNREACHABLE, to: "1", wmsEnv: "local" })).rejects.toMatchObject({ code: "MIGRATION_BAD_TARGET" });
    await expect(migrateDown({ url: UNREACHABLE, to: "0099", wmsEnv: "local" })).rejects.toMatchObject({ code: "MIGRATION_BAD_TARGET" });
  });
});

describe("main", () => {
  const sink = () => {
    const out: string[] = [];
    return { out, io: { log: (s: string) => out.push(s), logError: (s: string) => out.push(s) } };
  };

  it("fails without DATABASE_URL_DIRECT even when DATABASE_URL is set", async () => {
    const { out, io } = sink();
    const code = await main(["up"], { DATABASE_URL: UNREACHABLE }, io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("MIGRATION_NO_URL");
    expect(out.join("\n")).not.toContain("unit-secret-pw");
  });

  it("rejects DATABASE_URL_DIRECT identical to DATABASE_URL", async () => {
    const { out, io } = sink();
    const code = await main(["up"], { DATABASE_URL: UNREACHABLE, DATABASE_URL_DIRECT: UNREACHABLE }, io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("MIGRATION_WRONG_ROLE");
  });

  it("never prints the URL or password on a connection failure", async () => {
    const { out, io } = sink();
    const code = await main(["up"], { DATABASE_URL_DIRECT: UNREACHABLE }, io);
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).not.toContain("unit-secret-pw");
    expect(text).not.toContain("127.0.0.1");
  });
});
