// Düzenek duman testi (T-005a): pooler URL'si gerçekten RLS'e tabi uygulama rolüne gider ve
// session'da tenant bağlamı yoktur. Her iki hedefte (compose, neon) koşar; compose hedefinde
// ek olarak PgBouncer yönetim konsolundan pool_mode = transaction doğrulanır.
//
// Uygulama rolü bağlantısı YALNIZCA DATABASE_URL'den kurulur; DATABASE_URL_DIRECT (migration rolü)
// bu dosyada kullanılmaz (T-002d güvenlik notu).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_CLIENT_SETTINGS } from "../../../packages/db/src/client.ts";
import { APP_ROLE, AUTH_ROLE, PGBOUNCER_ADMIN_URL_VAR, PROBE_ROLE, parsePoolSize, readAuthDatabaseUrl, readIntEnv, redactUrl } from "./env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);

/**
 * Beklenen PostgreSQL ana sürümü (T-005e): ortamdaki INT_EXPECTED_PG_MAJOR, yoksa .env.example
 * (global-setup'ın compose için okuduğu aynı dosya). Hiçbiri yoksa test düşer.
 */
function expectedPgMajor(): number {
  let raw = process.env.INT_EXPECTED_PG_MAJOR?.trim();
  if (raw === undefined || raw === "") {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env.example");
    raw = /^INT_EXPECTED_PG_MAJOR=(\S+)\s*$/m.exec(readFileSync(file, "utf8"))?.[1];
  }
  if (raw === undefined || !/^[0-9]{1,2}$/.test(raw)) {
    throw new Error("INT_EXPECTED_PG_MAJOR missing or not a major version number");
  }
  return Number(raw);
}

/** Bağlanır; sürücü hatasındaki URL/parola/host maskelenir (G-09). */
async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  // Bağlantı sonrası soket hataları da maskelensin ve süreç çökmesin; sorgu hatası ayrıca fırlar.
  client.on("error", (e) => console.error(`[harness] connection error: ${redactUrl(e.message, url)}`));
  try {
    await client.connect();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`connect failed: ${redactUrl(message, url)}`);
  }
  return client;
}

describe(`harness (target=${env.target}) — app role via pooler`, () => {
  let app: pg.Client;

  beforeAll(async () => {
    app = await connect(env.databaseUrl);
  });

  afterAll(async () => {
    await app?.end();
  });

  it(`connects as the application role ${APP_ROLE}`, async () => {
    const r = await app.query<{ current_user: string }>("SELECT current_user");
    expect(r.rows).toEqual([{ current_user: APP_ROLE }]);
  });

  it("application role is not superuser and cannot bypass RLS", async () => {
    const r = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user",
    );
    expect(r.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("application role is a member of no other role (inherits no owner privileges, I-03)", async () => {
    const r = await app.query<{ granted: string }>(
      `SELECT g.rolname AS granted
         FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles mem ON mem.oid = m.member
         JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
        WHERE mem.rolname = current_user
        ORDER BY 1`,
    );
    expect(r.rows).toEqual([]);
  });

  it("has no tenant context outside a transaction", async () => {
    const r = await app.query<{ tenant: string | null }>(
      "SELECT current_setting('app.current_tenant_id', true) AS tenant",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.tenant ?? "").toBe("");
  });

  // Eşdeğerlik (T-005e) yalnızca compose hedefinde: neon tanı koşusu INT_DB_PREPARE'i bilerek çevirir.
  if (env.target === "compose") {
    it("PostgreSQL major version = INT_EXPECTED_PG_MAJOR (compose-Neon parity)", async () => {
      const r = await app.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
      expect(Math.floor(Number(r.rows[0]?.v) / 10000)).toBe(expectedPgMajor());
    });

    it("effective prepare = DB_CLIENT_SETTINGS.prepare (not overridden by INT_DB_PREPARE)", () => {
      expect(env.prepare ?? DB_CLIENT_SETTINGS.prepare).toBe(DB_CLIENT_SETTINGS.prepare);
      expect(env.prepare).toBeUndefined();
    });
  }
});

describe(`harness (target=${env.target}) — auth role via pooler`, () => {
  let auth: pg.Client;

  beforeAll(async () => {
    auth = await connect(authUrl);
  });

  afterAll(async () => {
    await auth?.end();
  });

  it(`connects as the identity role ${AUTH_ROLE}`, async () => {
    const r = await auth.query<{ current_user: string }>("SELECT current_user");
    expect(r.rows).toEqual([{ current_user: AUTH_ROLE }]);
  });

  it("identity role has the same restricted attributes as the application role", async () => {
    const r = await auth.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
         FROM pg_catalog.pg_roles WHERE rolname = current_user`,
    );
    expect(r.rows).toEqual([
      { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false },
    ]);
  });

  it("identity role is a member of no role", async () => {
    const r = await auth.query<{ granted: string }>(
      `SELECT g.rolname AS granted
         FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles mem ON mem.oid = m.member
         JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
        WHERE mem.rolname = current_user
        ORDER BY 1`,
    );
    expect(r.rows).toEqual([]);
  });

  it(`${PROBE_ROLE} is NOLOGIN with no privileged attributes`, async () => {
    const r = await auth.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [PROBE_ROLE],
    );
    expect(r.rows).toEqual([
      { rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false },
    ]);
  });

  it(`no role is a member of ${AUTH_ROLE} (nobody can SET ROLE into or inherit the identity role)`, async () => {
    const r = await auth.query<{ member: string }>(
      `SELECT mem.rolname AS member
         FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles mem ON mem.oid = m.member
         JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
        WHERE g.rolname = $1
        ORDER BY 1`,
      [AUTH_ROLE],
    );
    expect(r.rows).toEqual([]);
  });

  // ADR-015 5. tur eki MINOR-6 kural 1: migration rolü (DATABASE_URL_DIRECT kullanıcısı; yalnızca
  // ad okunur, o rolle bağlanılmaz) için admin/inherit yok, en az bir satırda set; başka üyede set/inherit yok.
  it(`${PROBE_ROLE} membership: migration role has SET only (no ADMIN, no INHERIT); no other member has SET/INHERIT`, async () => {
    const migrator = decodeURIComponent(new URL(env.databaseUrlDirect).username);
    const r = await auth.query<{ member: string; admin_option: boolean; inherit_option: boolean; set_option: boolean }>(
      `SELECT mem.rolname AS member, m.admin_option, m.inherit_option, m.set_option
         FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles mem ON mem.oid = m.member
         JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
        WHERE g.rolname = $1
        ORDER BY 1`,
      [PROBE_ROLE],
    );
    const own = r.rows.filter((row) => row.member === migrator);
    const others = r.rows.filter((row) => row.member !== migrator);
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(own.every((row) => row.admin_option === false)).toBe(true);
    expect(own.every((row) => row.inherit_option === false)).toBe(true);
    expect(own.some((row) => row.set_option === true)).toBe(true);
    expect(others.filter((row) => row.set_option || row.inherit_option)).toEqual([]);
    expect(others.map((row) => row.member)).not.toContain(APP_ROLE);
    expect(others.map((row) => row.member)).not.toContain(AUTH_ROLE);
  });
});

/** Aynı URL, parolası değiştirilmiş (yanlış) biçimde. */
function withWrongPassword(url: string): string {
  const u = new URL(url);
  u.password = `${decodeURIComponent(u.password)}-wrong`;
  return u.toString();
}

// T-101c: pooler kimlik doğrulaması. Doğru parola bağlanır (yukarıdaki bloklar), yanlış parola
// reddedilir. Neon pooler'ı için de geçerlidir (kimlik doğrulama sağlayıcıda), bu yüzden her iki hedefte koşar.
describe(`harness (target=${env.target}) — pooler rejects a wrong password`, () => {
  it.each([
    ["application role", env.databaseUrl],
    ["identity role", authUrl],
  ])("%s: wrong password is rejected, correct password is not echoed", async (_label, url) => {
    const wrong = withWrongPassword(url);
    const err = await connect(wrong).then(
      async (c) => {
        await c.end();
        return undefined;
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/^connect failed: /);
    expect(message).not.toContain(decodeURIComponent(new URL(url).password));
  });
});

// T-101c: PgBouncer userlist'inde açık metin parola yok; her satır SCRAM-SHA-256 verifier'dır.
// Dosya yalnızca pgbouncer konteynerinde olduğundan, DATABASE_URL portunu yayımlayan konteynerde
// `docker exec cat` ile okunur (içerik asla yazdırılmaz; yalnızca biçim denetlenir).
if (env.target === "compose") {
  describe("harness (target=compose) — PgBouncer userlist holds SCRAM verifiers only", () => {
    const VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/;

    function readUserlist(): string {
      const port = new URL(env.databaseUrl).port;
      const ids = execFileSync("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.ID}}"], { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.trim() !== "");
      if (ids.length !== 1) {
        throw new Error(`pgbouncer container lookup by published port found ${ids.length} containers (expected 1)`);
      }
      return execFileSync("docker", ["exec", ids[0] as string, "cat", "/auth/userlist.txt"], { encoding: "utf8" });
    }

    it("every userlist entry is `\"user\" \"SCRAM-SHA-256$...\"` and covers app, auth and admin users", () => {
      const lines = readUserlist().split("\n").filter((l) => l.trim() !== "");
      const users: string[] = [];
      for (const line of lines) {
        const m = /^"([a-z_]+)" "([^"]*)"$/.exec(line);
        expect(m, "userlist line format").not.toBeNull();
        const [, user, secret] = m as RegExpExecArray;
        expect(secret?.startsWith("SCRAM-SHA-256$")).toBe(true);
        expect(secret).toMatch(VERIFIER);
        users.push(user as string);
      }
      expect(users.sort()).toEqual([APP_ROLE, AUTH_ROLE, "pgbouncer_admin"].sort());
    });

    it("userlist does not contain any of the configured passwords", () => {
      const content = readUserlist();
      for (const url of [env.databaseUrl, authUrl, process.env[PGBOUNCER_ADMIN_URL_VAR] ?? ""]) {
        const password = decodeURIComponent(new URL(url).password);
        expect(password.length).toBeGreaterThan(0);
        expect(content.includes(password)).toBe(false);
      }
    });
  });
}

// PgBouncer yönetim konsolu yalnızca compose hedefinde vardır (Neon pooler'ı sağlayıcı yönetir,
// Q-02 / T-005d). Bu blok neon hedefinde KAYDEDİLMEZ (atlanmış test olarak da görünmez); compose
// hedefinde yönetim URL'si yoksa test atlanmaz, düşer.
if (env.target === "compose") {
  describe("harness (target=compose) — PgBouncer admin console", () => {
    let admin: pg.Client;

    beforeAll(async () => {
      const adminUrl = process.env[PGBOUNCER_ADMIN_URL_VAR];
      if (adminUrl === undefined || adminUrl === "") {
        throw new Error(`${PGBOUNCER_ADMIN_URL_VAR} missing — compose target must be started by global-setup`);
      }
      admin = await connect(adminUrl);
    });

    afterAll(async () => {
      await admin?.end();
    });

    async function config(): Promise<Map<string, string>> {
      const r = await admin.query<{ key: string; value: string }>("SHOW CONFIG");
      return new Map(r.rows.map((row) => [row.key, row.value]));
    }

    it("pool_mode = transaction", async () => {
      expect((await config()).get("pool_mode")).toBe("transaction");
    });

    it("default_pool_size = INT_PGBOUNCER_POOL_SIZE (default 2)", async () => {
      expect((await config()).get("default_pool_size")).toBe(String(parsePoolSize(process.env)));
    });

    it(`DATABASE_URL goes through PgBouncer (pool for ${APP_ROLE} exists)`, async () => {
      const r = await admin.query<{ database: string; user: string }>("SHOW POOLS");
      expect(r.rows.map((row) => row.user)).toContain(APP_ROLE);
    });

    it(`AUTH_DATABASE_URL goes through PgBouncer (pool for ${AUTH_ROLE} exists)`, async () => {
      const r = await admin.query<{ database: string; user: string }>("SHOW POOLS");
      expect(r.rows.map((row) => row.user)).toContain(AUTH_ROLE);
    });
  });
}

// MAJOR-1 (güvenlik incelemesi): parola argv'ye (/proc/<pid>/cmdline) düşmemeli. Init betiği
// psql'e parolayı `--set`/`-v` ile vermemeli; `\getenv` ile ortamdan okumalı (yorumlar hariç).
describe("infra/postgres/init/01-roles.sh — no secret in argv", () => {
  const script = readFileSync(new URL("../../../infra/postgres/init/01-roles.sh", import.meta.url), "utf8");
  const code = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    // satır devamlarını birleştir: çok satırlı psql çağrısı tek komut olarak değerlendirilir
    .replace(/\\\n/g, " ");

  it("does not pass passwords via psql --set / --variable / -v (separate, adjacent or = forms)", () => {
    expect(code).not.toMatch(/--set\b[^\n]*pass/i);
    expect(code).not.toMatch(/(?:^|\s)-v\s*\w*pass/i);
    expect(code).not.toMatch(/--set(?:=|\s)\w*pass/i);
    expect(code).not.toMatch(/--variable(?:=|\s)\w*pass/i);
  });

  it("does not put a password in a PGPASSWORD= assignment or a connection URI", () => {
    expect(code).not.toMatch(/PGPASSWORD\s*=/);
    expect(code).not.toMatch(/postgres(?:ql)?:\/\/[^\s/@]*:[^\s/@]+@/i);
  });

  it("silences the failing statement in the server log before any CREATE ROLE ... PASSWORD (T-101b MINOR-2)", () => {
    const setAt = code.search(/^SET\s+log_min_error_statement\s*=\s*panic\s*;/im);
    const createAt = code.search(/^CREATE\s+ROLE\b/im);
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(setAt);
  });

  it("reads both role passwords from the environment with \\getenv", () => {
    expect(code).toMatch(/^\\getenv\s+app_password\s+WMS_APP_PASSWORD$/m);
    expect(code).toMatch(/^\\getenv\s+auth_password\s+WMS_AUTH_PASSWORD$/m);
  });
});

// T-101c: verifier üretici betik de parolayı argv'ye koymaz; perl'e yalnızca ortam değişkeni ADI verilir.
describe("infra/pgbouncer/make-verifier.sh + docker-compose.yml — no plaintext userlist", () => {
  const stripComments = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
  const script = stripComments(readFileSync(new URL("../../../infra/pgbouncer/make-verifier.sh", import.meta.url), "utf8"));
  const composeText = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");

  /** Üst düzey `  <ad>:` servis bloğunu döndürür. */
  function serviceBlock(name: string): string {
    const start = composeText.search(new RegExp(`^  ${name}:\\s*$`, "m"));
    expect(start, `service ${name}`).toBeGreaterThanOrEqual(0);
    const rest = composeText.slice(start + 1);
    const next = rest.search(/^ {2}[a-z][\w-]*:\s*$|^[a-z]/m);
    return stripComments(next === -1 ? rest : rest.slice(0, next));
  }

  it("passes only an environment variable NAME to perl and never a password flag", () => {
    expect(script).not.toMatch(/PGPASSWORD\s*=/);
    expect(script).not.toMatch(/hexpass|-kdfopt\s+pass|--pass\b|-pass\b/i);
    expect(script).toMatch(/'\s*"\$1"/);
  });

  it("pgbouncer service has no wms_app/wms_auth password and waits for the userlist job", () => {
    const pgbouncer = serviceBlock("pgbouncer");
    expect(pgbouncer).not.toMatch(/WMS_APP_PASSWORD|WMS_AUTH_PASSWORD/);
    expect(pgbouncer).toMatch(/pgbouncer-userlist:\s*\n\s*condition:\s*service_completed_successfully/);
    expect(pgbouncer).not.toMatch(/printf[^\n]*userlist/);
  });

  it("userlist is produced by pgbouncer-userlist only, with a read-only mount into pgbouncer", () => {
    expect(serviceBlock("pgbouncer-userlist")).toMatch(/make-verifier\.sh/);
    expect(serviceBlock("pgbouncer")).toMatch(/pgbouncer-auth:\/auth:ro/);
  });
});
