// Hedef ayrıştırma (T-005a). Ortam nesneleri açıkça verilir; process.env'e dokunulmaz.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INT_PGBOUNCER_POOL_SIZE,
  IntEnvError,
  maskHost,
  parsePoolSize,
  parsePrepare,
  parseTarget,
  readIntEnv,
  redactUrl,
} from "./env.ts";

// Sentetik değerler (G-09): gerçek host/parola değildir.
const APP_URL = "postgresql://wms_app:s3cr3t-app-pw@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech:5432/wms?sslmode=require";
const DIRECT_URL = "postgresql://wms_migrator:s3cr3t-mig-pw@ep-cool-name-123456.eu-central-1.aws.neon.tech:5432/wms?sslmode=require";

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`non-Error thrown: ${String(e)}`);
  }
  throw new Error("expected function to throw");
}

function expectNoSecrets(message: string): void {
  for (const s of [APP_URL, DIRECT_URL, "s3cr3t-app-pw", "s3cr3t-mig-pw", "postgresql://", "ep-cool-name-123456"]) {
    expect(message).not.toContain(s);
  }
}

describe("parseTarget", () => {
  it("defaults to compose when WMS_INT_TARGET is unset or blank", () => {
    expect(parseTarget({})).toBe("compose");
    expect(parseTarget({ WMS_INT_TARGET: "  " })).toBe("compose");
  });

  it("accepts compose and neon", () => {
    expect(parseTarget({ WMS_INT_TARGET: "compose" })).toBe("compose");
    expect(parseTarget({ WMS_INT_TARGET: "neon" })).toBe("neon");
  });

  it("rejects unknown targets without echoing the value", () => {
    const e = thrown(() => parseTarget({ WMS_INT_TARGET: "prod-db-xyz" }));
    expect(e).toBeInstanceOf(IntEnvError);
    expect(e.message).toContain("WMS_INT_TARGET");
    expect(e.message).not.toContain("prod-db-xyz");
  });
});

describe("readIntEnv — neon", () => {
  it("fails with 'missing DATABASE_URL, DATABASE_URL_DIRECT' when both are unset or empty", () => {
    for (const env of [{ WMS_INT_TARGET: "neon" }, { WMS_INT_TARGET: "neon", DATABASE_URL: "", DATABASE_URL_DIRECT: " " }]) {
      const e = thrown(() => readIntEnv(env));
      expect(e).toBeInstanceOf(IntEnvError);
      expect(e.message).toContain("missing DATABASE_URL, DATABASE_URL_DIRECT");
    }
  });

  it("names only the missing variable and never includes the provided URL", () => {
    const noDirect = thrown(() => readIntEnv({ WMS_INT_TARGET: "neon", DATABASE_URL: APP_URL }));
    expect(noDirect.message).toContain("missing DATABASE_URL_DIRECT");
    expect(noDirect.message).not.toMatch(/missing DATABASE_URL[ ,(]/);
    expectNoSecrets(noDirect.message);

    const noApp = thrown(() => readIntEnv({ WMS_INT_TARGET: "neon", DATABASE_URL_DIRECT: DIRECT_URL }));
    expect(noApp.message).toContain("missing DATABASE_URL ");
    expect(noApp.message).not.toContain("missing DATABASE_URL_DIRECT");
    expectNoSecrets(noApp.message);
  });

  it("rejects malformed or non-postgres URLs without echoing them", () => {
    const bad = thrown(() => readIntEnv({ WMS_INT_TARGET: "neon", DATABASE_URL: "not a url s3cr3t-app-pw", DATABASE_URL_DIRECT: DIRECT_URL }));
    expect(bad.message).toBe("DATABASE_URL is not a valid URL");
    const http = thrown(() => readIntEnv({ WMS_INT_TARGET: "neon", DATABASE_URL: APP_URL, DATABASE_URL_DIRECT: "https://u:s3cr3t-mig-pw@example.test/x" }));
    expect(http.message).toBe("DATABASE_URL_DIRECT must use the postgres:// or postgresql:// scheme");
  });

  it("returns both URLs and the prepare override when complete", () => {
    expect(readIntEnv({ WMS_INT_TARGET: "neon", DATABASE_URL: APP_URL, DATABASE_URL_DIRECT: DIRECT_URL })).toEqual({
      target: "neon",
      databaseUrl: APP_URL,
      databaseUrlDirect: DIRECT_URL,
      prepare: undefined,
    });
    expect(
      readIntEnv({ WMS_INT_TARGET: "neon", DATABASE_URL: APP_URL, DATABASE_URL_DIRECT: DIRECT_URL, INT_DB_PREPARE: "true" }).prepare,
    ).toBe(true);
  });
});

describe("readIntEnv — compose", () => {
  it("requires the URLs written by global-setup", () => {
    const e = thrown(() => readIntEnv({}));
    expect(e.message).toContain("missing DATABASE_URL, DATABASE_URL_DIRECT");
    expect(e.message).toContain("global-setup");
  });
});

describe("parsePrepare", () => {
  it("is undefined when unset (production setting), boolean for true/false", () => {
    expect(parsePrepare({})).toBeUndefined();
    expect(parsePrepare({ INT_DB_PREPARE: "" })).toBeUndefined();
    expect(parsePrepare({ INT_DB_PREPARE: "true" })).toBe(true);
    expect(parsePrepare({ INT_DB_PREPARE: "false" })).toBe(false);
  });

  it("rejects anything else", () => {
    for (const v of ["1", "yes", "TRUE", "off"]) {
      expect(thrown(() => parsePrepare({ INT_DB_PREPARE: v }))).toBeInstanceOf(IntEnvError);
    }
  });
});

describe("parsePoolSize", () => {
  it("defaults to 2 and accepts positive integers", () => {
    expect(DEFAULT_INT_PGBOUNCER_POOL_SIZE).toBe(2);
    expect(parsePoolSize({})).toBe(2);
    expect(parsePoolSize({ INT_PGBOUNCER_POOL_SIZE: "1" })).toBe(1);
    expect(parsePoolSize({ INT_PGBOUNCER_POOL_SIZE: "20" })).toBe(20);
  });

  it("rejects zero, negatives and non-numbers", () => {
    for (const v of ["0", "-1", "2.5", "abc", "02"]) {
      expect(thrown(() => parsePoolSize({ INT_PGBOUNCER_POOL_SIZE: v }))).toBeInstanceOf(IntEnvError);
    }
  });
});

describe("maskHost / redactUrl", () => {
  it("keeps only a masked host and port", () => {
    expect(maskHost(APP_URL)).toBe("ep***.eu-central-1.aws.neon.tech:5432");
    expect(maskHost("postgresql://u:p@localhost:6432/wms")).toBe("lo***:6432");
    expect(maskHost("::not a url::")).toBe("<invalid-url>");
    expectNoSecrets(maskHost(APP_URL));
  });

  it("removes URL, password and raw host from driver error messages", () => {
    const msg = `getaddrinfo ENOTFOUND ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech (${APP_URL}) pw=s3cr3t-app-pw`;
    const out = redactUrl(msg, APP_URL);
    expectNoSecrets(out);
    expect(out).toContain("ENOTFOUND ep***.eu-central-1.aws.neon.tech");
  });
});
