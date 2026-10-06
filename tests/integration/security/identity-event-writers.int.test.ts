// 0007_identity_event_classes (T-112d): account.*, password_reset_link.*, demo.account_*, demo.password_* yalnızca wms_auth.
// Gerçek roller (wms_app / wms_auth); `demo.action_forbidden` wms_app'e açık KALIR. İleri/geri/ileri ayrı veritabanında.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateDown, migrateUp } from "../../../packages/db/src/migrate.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];

const NEW_IDENTITY = [
  "account.recovered_via_email",
  "account.recovery_failed",
  "account_x",
  "password_reset_link.issued_by_admin",
  "password_reset_link.rejected",
  "demo.account_created",
  "demo.account_taken_over",
  "demo.password_reset",
];
// Büyük harf: wms_auth için biçim CHECK'i reddeder (23514); wms_app için tetikleyici lower() ile 42501 verir.
const UPPER = ["ACCOUNT.RECOVERED", "Demo.Account_Created"];
// 0005 `password[_.]` zaten kapsıyordu (yeni migration gerektirmeden kapalı).
const ALREADY_CLOSED = ["password_reset_link.consumed", "password_reset_link.inconsistent"];
// Kapsam dışı kalmalı: wms_app yazmaya devam eder.
const APP_OPEN = ["demo.action_forbidden", "demo.reseed", "demo.accounts", "accountant.x", "demo_account_x", "demox.account_y"];

const ins = (type: string): string => `INSERT INTO public.security_events (event_type, detail) VALUES ('${type}', '{"t":"t112d"}')`;

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
  return c;
}

async function code(c: pg.Client, text: string): Promise<string> {
  try {
    await c.query(text);
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? "ERR";
  }
}

let app: pg.Client;
let auth: pg.Client;

beforeAll(async () => {
  app = await connect(env.databaseUrl);
  auth = await connect(authUrl);
});

afterAll(async () => {
  for (const c of [app, auth]) await c.end().catch(() => undefined);
}, 60_000);

describe(`0007 kimlik olayı sınıfı genişlemesi (target=${env.target})`, () => {
  it("wms_app yeni kimlik sınıfı olaylarını yazamaz (42501)", async () => {
    for (const t of [...NEW_IDENTITY, ...ALREADY_CLOSED]) expect(await code(app, ins(t)), `app ${t}`).toBe("42501");
  });

  it("büyük/küçük harf ile sınıf atlatılamaz (lower)", async () => {
    for (const t of UPPER) expect(await code(app, ins(t)), `app ${t}`).toBe("42501");
  });

  it("wms_auth yeni kimlik sınıfı olaylarını yazabilir", async () => {
    for (const t of [...NEW_IDENTITY, ...ALREADY_CLOSED]) expect(await code(auth, ins(t)), `auth ${t}`).toBe("OK");
  });

  it("kapsam dışı türler (demo.action_forbidden dahil) wms_app ve wms_auth ile yazılır", async () => {
    for (const t of APP_OPEN) {
      expect(await code(app, ins(t)), `app ${t}`).toBe("OK");
      expect(await code(auth, ins(t)), `auth ${t}`).toBe("OK");
    }
  });

  it("işlev SECURITY INVOKER, wms_app EXECUTE taşımaz, tetikleyici ENABLE ALWAYS", async () => {
    const adm = await connect(env.databaseUrlDirect);
    try {
      const r = await adm.query<{ sd: boolean; ex: boolean; en: string }>(
        `SELECT p.prosecdef AS sd, has_function_privilege('wms_app', p.oid, 'EXECUTE') AS ex,
                (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid = 'public.security_events'::regclass AND tgname = 'security_events_identity_writers') AS en
           FROM pg_proc p WHERE p.oid = 'public.security_events_restrict_identity_writers()'::regprocedure`,
      );
      expect(r.rows[0]).toEqual({ sd: false, ex: false, en: "A" });
    } finally {
      await adm.end();
    }
  });
});

describe("0007 ileri/geri/ileri", () => {
  let dirCache: string | undefined;
  let dbName = "";
  afterAll(async () => {
    if (dirCache !== undefined) rmSync(dirCache, { recursive: true, force: true });
    if (dbName !== "") {
      const a = await connect(env.databaseUrlDirect);
      try {
        await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    }
  }, 60_000);

  it("geri alma 0005 gövdesine döner (satırlar korunur), yeniden ileri kısıtı geri getirir", async () => {
    dirCache = mkdtempSync(path.join(tmpdir(), "wms-mig-0007-"));
    cpSync(MIGRATIONS_DIR, dirCache, {
      recursive: true,
      filter: (src) => !/[\\/]\d{4}_/.test(src) || (/[\\/](\d{4})_[^\\/]*$/.exec(src)?.[1] ?? "9999") <= "0007",
    });
    const dir = dirCache;
    dbName = `wms_idc_${randomBytes(5).toString("hex")}`;
    const a = await connect(env.databaseUrlDirect);
    try {
      await a.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await a.end();
    }
    const u = new URL(env.databaseUrlDirect);
    u.pathname = `/${dbName}`;
    const url = u.toString();
    expect((await migrateUp({ url, dir })).applied).toContain("0007");

    const c = await connect(url);
    try {
      // Tablo sahibi de yazamaz (current_user <> wms_auth).
      expect(await code(c, ins("account.recovery_failed"))).toBe("42501");
      expect(await code(c, ins("demo.action_forbidden"))).toBe("OK");
    } finally {
      await c.end();
    }

    expect((await migrateDown({ url, dir, to: "0006", wmsEnv: "ci" })).reverted).toEqual(["0007"]);
    const c2 = await connect(url);
    try {
      expect(await code(c2, ins("account.recovery_failed"))).toBe("OK"); // 0005 gövdesi: account.* kısıtsız
      expect(await code(c2, ins("password_reset_link.rejected"))).toBe("42501"); // password[_.] hâlâ kapalı
      expect(await code(c2, ins("reauth.succeeded"))).toBe("42501"); // 0005 kısıtı yerinde
      const n = await c2.query<{ n: string }>("SELECT count(*)::text AS n FROM public.security_events");
      expect(Number(n.rows[0]?.n)).toBeGreaterThanOrEqual(2);
    } finally {
      await c2.end();
    }

    expect((await migrateUp({ url, dir })).applied).toEqual(["0007"]);
    const c3 = await connect(url);
    try {
      expect(await code(c3, ins("demo.password_reset"))).toBe("42501");
    } finally {
      await c3.end();
    }
  }, 120_000);
});
