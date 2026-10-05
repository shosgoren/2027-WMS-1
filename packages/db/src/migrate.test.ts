// Unit: migration koşturucusu (T-101). Ağ erişimi YOK: geri alma ortam/hedef denetimleri
// bağlantıdan önce yapılır; ulaşılamaz URL bir sızıntıyı bağlantı hatasıyla görünür kılar.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MigrationError,
  computeChecksum,
  loadMigrations,
  main,
  matchMigrationFiles,
  migrateDown,
  parseArgs,
  parseTarget,
  redact,
  redactErrorChain,
  sameConnectionTarget,
  migrateUp,
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
  it("masks the URL, the password, the user name and the host", () => {
    const out = redact(`failed ${UNREACHABLE} with unit-secret-pw as wms_migrator on 127.0.0.1`, UNREACHABLE);
    for (const leak of ["unit-secret-pw", "wms_migrator", "127.0.0.1"]) expect(out).not.toContain(leak);
  });

  it("masks every postgres(ql):// URL in the message, not only the configured one", () => {
    const out = redact("a postgres://u1:p1@h1:5432/d1 b postgresql://u2:p2@h2/d2", UNREACHABLE);
    for (const leak of ["u1", "p1", "h1", "u2", "p2", "h2"]) expect(out).not.toContain(leak);
  });

  it("fails closed on a malformed percent escape: password still masked", () => {
    const bad = "postgresql://mig_user:p%zzsecret@127.0.0.1:1/unit";
    const out = redact(`oops p%zzsecret mig_user ${bad}`, bad);
    expect(out).not.toContain("p%zzsecret");
    expect(out).not.toContain("mig_user");
  });

  it("fails closed on an unparsable URL: credentials in the authority are masked", () => {
    const bad = "postgresql://mig_user:unit-secret-pw@[::bad/unit";
    const out = redact(`x unit-secret-pw mig_user`, bad);
    expect(out).not.toContain("unit-secret-pw");
    expect(out).not.toContain("mig_user");
  });

  it("masks the generic URL first: a short user name equal to the scheme prefix does not break the pattern (MINOR 6)", () => {
    const url = "postgresql://postgres:s3cr3t-pw@db.internal:5432/app";
    const out = redact(`boom postgresql://postgres:s3cr3t-pw@db.internal:5432/app and postgres://postgres:zzz@other.host/x`, url);
    expect(out).toBe("boom [url] and [url]");
    expect(out).not.toContain("ql://");
  });

  it("masks short names only on word boundaries (the rest of the message stays readable)", () => {
    const url = "postgresql://db:pw-long-secret@dbhost.internal/app";
    const out = redact("db error in database dbhost.internal for db", url);
    expect(out).toBe("[gizli] error in database [gizli] for [gizli]");
  });

  it("masks every host of a multi-host URL", () => {
    const url = "postgresql://u:pw-secret-x@h1.example:5432,h2.example:5433/d";
    const out = redact("tried h1.example then h2.example", url);
    expect(out).not.toContain("h1.example");
    expect(out).not.toContain("h2.example");
  });

  it("redactErrorChain walks causes and masks before truncating", () => {
    const e = new Error("outer", { cause: new Error(`inner ${UNREACHABLE} unit-secret-pw`) });
    const out = redactErrorChain(e, UNREACHABLE);
    expect(out).toContain("outer");
    expect(out).not.toContain("unit-secret-pw");
    expect(out).not.toContain("wms_migrator");
  });
});

describe("parseTarget", () => {
  it("parses a multi-host URL that new URL() rejects, and falls back to PGPORT / default 5432", () => {
    const t = parseTarget("postgresql://u:p@h1:5433,h2/db", { PGPORT: "6543" });
    expect(t?.hosts).toEqual([
      { host: "h1", port: "5433" },
      { host: "h2", port: "6543" },
    ]);
    expect(t?.user).toBe("u");
    expect(t?.db).toBe("db");
    expect(parseTarget("postgresql://u@h/db", {})?.hosts).toEqual([{ host: "h", port: "5432" }]);
  });

  it("is undefined for garbage, a bad scheme, a missing host or a non-numeric port", () => {
    for (const bad of ["not a url", "mysql://u@h/db", "postgresql://u@/db", "postgresql://u@h:abc/db", "postgresql://u@[::bad/db"]) {
      expect(parseTarget(bad, {}), bad).toBeUndefined();
    }
    expect(parseTarget("postgresql://u@h/db", { PGPORT: "x" })).toBeUndefined();
  });

  it("treats localhost, 127.0.0.1 and ::1 as the same host and flags host/port query overrides", () => {
    const hosts = ["postgresql://u@localhost/d", "postgresql://u@127.0.0.1/d", "postgresql://u@[::1]/d"].map((u) => parseTarget(u, {})?.hosts);
    expect(new Set(hosts.map((h) => JSON.stringify(h))).size).toBe(1);
    expect(parseTarget("postgresql://u@h/d?host=/tmp", {})?.hasHostOverride).toBe(true);
    expect(parseTarget("postgresql://u@h/d?sslmode=require", {})?.hasHostOverride).toBe(false);
  });
});

describe("sameConnectionTarget", () => {
  it("compares host, port, user and database, not the raw string", () => {
    const base = "postgresql://u:p@db.example:5432/w";
    expect(sameConnectionTarget(base, "postgres://u:other@DB.example/w?sslmode=require", {})).toBe(true);
    expect(sameConnectionTarget(base, "postgresql://u:p@db.example:5433/w", {})).toBe(false);
    expect(sameConnectionTarget(base, "postgresql://v:p@db.example:5432/w", {})).toBe(false);
    expect(sameConnectionTarget(base, "postgresql://u:p@db.example:5432/x", {})).toBe(false);
  });

  it("treats localhost and 127.0.0.1 as equivalent and honours PGPORT when the port is omitted", () => {
    expect(sameConnectionTarget("postgresql://u:p@localhost:5432/w", "postgresql://u:q@127.0.0.1/w", {})).toBe(true);
    expect(sameConnectionTarget("postgresql://u:p@localhost/w", "postgresql://u:q@127.0.0.1:5433/w", { PGPORT: "5433" })).toBe(true);
    expect(sameConnectionTarget("postgresql://u:p@localhost/w", "postgresql://u:q@127.0.0.1:5432/w", { PGPORT: "5433" })).toBe(false);
  });

  it("fails closed: unparsable, host-override and overlapping multi-host inputs count as the same target", () => {
    expect(sameConnectionTarget("garbage", "postgresql://u@h/d", {})).toBe(true);
    expect(sameConnectionTarget("garbage", "garbage2", {})).toBe(true);
    expect(sameConnectionTarget("postgresql://u@a/d?host=b", "postgresql://u@c/d", {})).toBe(true);
    expect(sameConnectionTarget("postgresql://u@a,b/d", "postgresql://u@b/d", {})).toBe(true);
    expect(sameConnectionTarget("postgresql://u@a,b/d", "postgresql://u@c/d", {})).toBe(false);
  });
});

describe("pooler URLs are refused before any connection", () => {
  it("rejects a Neon -pooler host and PgBouncer port 6432", async () => {
    for (const url of [
      "postgresql://m:p@ep-x-pooler.eu-central-1.aws.neon.tech/w",
      "postgresql://m:p@127.0.0.1:6432/w",
    ]) {
      await expect(migrateUp({ url })).rejects.toMatchObject({ code: "MIGRATION_POOLER_URL" });
    }
  });

  it("fails closed on multi-host, unparsable and host-override URLs (MINOR 4)", async () => {
    for (const url of [
      "postgresql://m:p@h1:5432,h2:6432/w",
      "postgresql://m:p@h1,h2/w",
      "postgresql://m:p@[::bad/w",
      "postgresql://m:p@h:notaport/w",
      "postgresql://m:p@h/w?host=ep-x-pooler.example",
      "postgresql://m:p@h/w?port=6432",
      "mysql://m:p@h/w",
    ]) {
      await expect(migrateUp({ url }), url).rejects.toMatchObject({ code: "MIGRATION_POOLER_URL" });
    }
  });

  it("takes PGPORT into account when the URL has no port", async () => {
    vi.stubEnv("PGPORT", "6432");
    try {
      await expect(migrateUp({ url: "postgresql://m:p@127.0.0.1/w" })).rejects.toMatchObject({ code: "MIGRATION_POOLER_URL" });
    } finally {
      vi.unstubAllEnvs();
    }
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
