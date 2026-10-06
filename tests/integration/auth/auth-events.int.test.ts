// Kimlik olaylarını yalnızca `wms_auth` yazar (T-112c; migration 0005; ADR-014 §14, ADR-016 §1).
// Gerçek roller (wms_app / wms_auth); tetikleyici BEFORE INSERT + SECURITY INVOKER → `current_user` = INSERT'i yapan rol
// (PG18 davranışı bu testle doğrulanır: SET ROLE ile `current_user` değişir, `session_user` değişmez).
// Sentetik parolalar çalışma anında üretilir (G-09).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, recordSecurityEvent } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { MIGRATIONS_DIR, migrateDown, migrateUp } from "../../../packages/db/src/migrate.ts";
import { AuthError, createAuth, readAuthEnv, type AuthService } from "../../../packages/auth/src/index.ts";
import { hashPassword } from "../../../packages/auth/src/password.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];
const BASE = "http://localhost:3000";
const PASSWORD = `P${randomBytes(12).toString("hex")}`;
const WRONG = `W${randomBytes(12).toString("hex")}`;
const SECRET = randomBytes(32).toString("hex");

const IDENTITY_TYPES = [
  "reauth.succeeded",
  "reauth.failed",
  "login_succeeded",
  "login_failed",
  "login_mfa_pending",
  "logout",
  "session.revoked",
  "mfa.verified",
  "password_changed",
  "password_reset",
  "password.changed",
  "two_factor_enabled",
  "two_factor_disabled",
  "two_factor_failed",
];
// Kimlik sınıfında OLMAYAN olaylar (uygulama sınıfı; öneklerin tam başta eşleştiğini de sınar).
const APP_TYPES = ["demo.action_forbidden", "app.check", "relogin_x", "xlogout", "reauthx.test", "sessions.x", "mfax.test"];

let adm: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let authClient: DbClient;
let appClient: DbClient;
let service: AuthService;

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

async function code(c: pg.Client, text: string, params: unknown[] = []): Promise<string> {
  try {
    await c.query(text, params);
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? "ERR";
  }
}

const ins = (type: string): string => `INSERT INTO public.security_events (event_type, detail) VALUES ('${type}', '{"t":"t112c"}')`;

beforeAll(async () => {
  adm = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  auth = await connect(authUrl);
  authClient = createDbClient({ url: authUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  appClient = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  service = createAuth({
    client: authClient,
    env: readAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DATABASE_URL: env.databaseUrl, AUTH_DATABASE_URL: authUrl }),
  });
});

afterAll(async () => {
  await authClient.close();
  await appClient.close();
  for (const c of [adm, app, auth]) await c.end().catch(() => undefined);
}, 60_000);

describe(`kimlik olayı yazarı kısıtı (target=${env.target})`, () => {
  it("wms_app kimlik sınıfı olayları yazamaz (42501)", async () => {
    for (const t of IDENTITY_TYPES) expect(await code(app, ins(t)), t).toBe("42501");
  });

  it("büyük/küçük harf ve ham SQL ile sınıf atlatılamaz (lower)", async () => {
    expect(await code(app, ins("REAUTH.SUCCEEDED"))).toBe("42501");
    expect(await code(app, ins("Login_Succeeded"))).toBe("42501");
  });

  it("wms_auth kimlik sınıfı olayları yazabilir", async () => {
    for (const t of IDENTITY_TYPES) expect(await code(auth, ins(t)), t).toBe("OK");
  });

  it("uygulama sınıfı olaylar wms_app ve wms_auth ile yazılır", async () => {
    for (const t of APP_TYPES) {
      expect(await code(app, ins(t)), `app ${t}`).toBe("OK");
      expect(await code(auth, ins(t)), `auth ${t}`).toBe("OK");
    }
  });

  it("tablo sahibi (migrator/süper kullanıcı) kimlik olayı yazamaz; session_replication_role=replica atlatmaz", async () => {
    expect(await code(adm, ins("reauth.succeeded"))).toBe("42501");
    // Ön koşul AÇIKÇA doğrulanır (tutmazsa test KIRMIZI; sessiz atlama yok): migrator replica rolüne geçebilmeli.
    expect(await code(adm, "SET session_replication_role = replica"), "ön koşul: migrator session_replication_role ayarlayabilmeli").toBe("OK");
    try {
      expect(await code(adm, ins("reauth.succeeded"))).toBe("42501");
    } finally {
      await adm.query("SET session_replication_role = DEFAULT");
    }
  });

  it("PG18: tetikleyici current_user'a bakar (SET ROLE değişir; SECURITY INVOKER)", async () => {
    const c = await connect(env.databaseUrlDirect);
    try {
      // Ön koşullar AÇIKÇA doğrulanır (tutmazsa test KIRMIZI): migrator her iki role geçebilmeli.
      expect(await code(c, "SET ROLE wms_app"), "ön koşul: migrator SET ROLE wms_app yapabilmeli").toBe("OK");
      await c.query("RESET ROLE");
      expect(await code(c, "SET ROLE wms_auth"), "ön koşul: migrator SET ROLE wms_auth yapabilmeli").toBe("OK");
      await c.query("RESET ROLE");
      await c.query("SET ROLE wms_app");
      const who = await c.query<{ cu: string; su: string }>("SELECT current_user AS cu, session_user AS su");
      expect(who.rows[0]?.cu).toBe("wms_app");
      expect(who.rows[0]?.su).not.toBe("wms_app");
      expect(await code(c, ins("login_succeeded"))).toBe("42501");
      await c.query("RESET ROLE");
      await c.query("SET ROLE wms_auth");
      expect((await c.query<{ cu: string }>("SELECT current_user AS cu")).rows[0]?.cu).toBe("wms_auth");
      expect(await code(c, ins("login_succeeded"))).toBe("OK");
    } finally {
      await c.query("RESET ROLE").catch(() => undefined);
      await c.end();
    }
  });

  it("tür biçimi CHECK (23514): baştaki boşluk, büyük harf (sahip rol dahil), Kiril harfli tür; alt çizgili kimlik benzerleri wms_auth'a kısıtlı", async () => {
    // Kiril 'е' (U+0435) ile 'reauth.succeeded' benzeri tür: sınıf regex'ine uymaz, biçim CHECK'i reddeder.
    const cyr = "r\u0435auth.succeeded";
    for (const c of [app, auth, adm]) {
      expect(await code(c, ins(" reauth.succeeded"))).toBe("23514");
      expect(await code(c, ins(cyr))).toBe("23514");
      expect(await code(c, ins("a".repeat(65)))).toBe("23514");
      expect(await code(c, ins("1abc"))).toBe("23514");
    }
    expect(await code(adm, ins("app.UPPER"))).toBe("23514");
    for (const t of ["reauth_succeeded", "session_revoked", "mfa_verified"]) {
      expect(await code(app, ins(t)), `app ${t}`).toBe("42501");
      expect(await code(auth, ins(t)), `auth ${t}`).toBe("OK");
    }
  });

  it("sütun yetkileri: wms_auth yalnızca 6 sütuna INSERT eder, SELECT yok; id/occurred_at verilemez", async () => {
    expect(await code(auth, "SELECT id FROM public.security_events LIMIT 1")).toBe("42501");
    expect(await code(auth, `INSERT INTO public.security_events (id, event_type) VALUES (gen_random_uuid(), 'reauth.succeeded')`)).toBe("42501");
    expect(await code(auth, `INSERT INTO public.security_events (event_type, occurred_at) VALUES ('reauth.succeeded', now() + interval '1 day')`)).toBe("42501");
  });

  it("recordSecurityEvent: wms_auth returning:false ile yazar; RETURNING yolu wms_auth'ta 42501; wms_app uygulama olayında kimlik döner", async () => {
    const userId = randomUUID();
    await recordSecurityEvent(authClient, { eventType: "reauth.succeeded", userId }, { returning: false });
    const row = await adm.query("SELECT 1 FROM public.security_events WHERE user_id = $1 AND event_type = 'reauth.succeeded'", [userId]);
    expect(row.rowCount).toBe(1);
    await expect(recordSecurityEvent(authClient, { eventType: "reauth.succeeded", userId })).rejects.toBeDefined();
    const id = await recordSecurityEvent(appClient, { eventType: "app.check", userId });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(recordSecurityEvent(appClient, { eventType: "reauth.succeeded", userId }, { returning: false })).rejects.toBeDefined();
    const count = await adm.query("SELECT count(*)::int AS n FROM public.security_events WHERE user_id = $1 AND event_type = 'reauth.succeeded'", [userId]);
    expect(count.rows[0]).toMatchObject({ n: 1 });
  });
});

describe(`reauthenticate → reauth.* olayları wms_auth ile yazılır (target=${env.target})`, () => {
  async function mkSession(): Promise<{ userId: string; email: string; sessionId: string; headers: Headers }> {
    const userId = randomUUID();
    const email = `t112c-${randomBytes(6).toString("hex")}@example.invalid`;
    await adm.query("INSERT INTO public.users (id, name, email, email_verified) VALUES ($1, 'T112c', $2, true)", [userId, email]);
    await adm.query("INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1, 'credential', $2, $3)", [
      userId,
      userId,
      await hashPassword(PASSWORD),
    ]);
    const ip = `203.0.113.${100 + Math.floor(Math.random() * 100)}`;
    const res = await service.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": ip, "user-agent": "t112c" },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((l) => l.split(";")[0] ?? "")
      .filter((c) => c.includes("session_token"))
      .join("; ");
    const headers = new Headers({ cookie, "fly-client-ip": ip, "user-agent": "t112c-reauth" });
    const principal = await service.getPrincipal(headers);
    if (principal === null) throw new Error("principal expected");
    return { userId, email, sessionId: principal.sessionId, headers };
  }
  const events = async (userId: string): Promise<{ event_type: string; ip: string | null; user_agent: string | null; detail: Record<string, unknown> }[]> =>
    (await adm.query("SELECT event_type, ip, user_agent, detail FROM public.security_events WHERE user_id = $1 AND event_type LIKE 'reauth.%' ORDER BY occurred_at, id", [userId])).rows;

  it("doğru parola → reauth.succeeded (wms_auth); yanlış parola → AuthError + reauth.failed; parola/e-posta olayda yok", async () => {
    const s = await mkSession();
    const principal = await service.getPrincipal(s.headers);
    if (principal === null) throw new Error("principal expected");
    await service.reauthenticate(principal, PASSWORD, s.headers);
    await expect(service.reauthenticate(principal, WRONG, s.headers)).rejects.toBeInstanceOf(AuthError);
    const ev = await events(s.userId);
    expect(ev.map((e) => e.event_type)).toEqual(["reauth.succeeded", "reauth.failed"]);
    // Ham oturum kimliği değil SHA-256 özeti; alan adı maskeleme anahtarlarına takılmaz (`sref`).
    expect(ev[0]).toMatchObject({ user_agent: "t112c-reauth", detail: { sref: createHash("sha256").update(s.sessionId).digest("hex") } });
    expect(JSON.stringify(ev)).not.toContain(s.sessionId);
    const dump = JSON.stringify(ev);
    for (const secret of [PASSWORD, WRONG, s.email]) expect(dump).not.toContain(secret);
  });

  it("5 başarısızlıktan sonra e-posta kilidi: doğru parola da reddedilir (olay başarılı yazılmaz)", async () => {
    const s = await mkSession();
    const principal = await service.getPrincipal(s.headers);
    if (principal === null) throw new Error("principal expected");
    for (let i = 0; i < 5; i += 1) await expect(service.reauthenticate(principal, WRONG, s.headers)).rejects.toBeInstanceOf(AuthError);
    await expect(service.reauthenticate(principal, PASSWORD, s.headers)).rejects.toBeInstanceOf(AuthError);
    const types = (await events(s.userId)).map((e) => e.event_type);
    expect(types).not.toContain("reauth.succeeded");
    expect(types.filter((t) => t === "reauth.failed")).toHaveLength(6);
  });

  it("parolasız hesapta (yalnızca sosyal) ve kilitli hesapta aynı tekdüze hata; reauth.failed yazılır (sahte doğrulama yolu)", async () => {
    const s = await mkSession();
    const principal = await service.getPrincipal(s.headers);
    if (principal === null) throw new Error("principal expected");
    await adm.query("UPDATE public.accounts SET password = NULL WHERE user_id = $1", [s.userId]);
    const err = await service.reauthenticate(principal, PASSWORD, s.headers).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code: "UNAUTHENTICATED", reason: "REAUTH_REQUIRED" });
    expect((await events(s.userId)).map((e) => e.event_type)).toEqual(["reauth.failed"]);
    // Kilit: 5 rezervasyon doldurulur; doğru parola bile aynı hatayı verir.
    const t = await mkSession();
    const p2 = await service.getPrincipal(t.headers);
    if (p2 === null) throw new Error("principal expected");
    for (let i = 0; i < 5; i += 1) await expect(service.reauthenticate(p2, WRONG, t.headers)).rejects.toMatchObject({ reason: "REAUTH_REQUIRED" });
    const locked = await service.reauthenticate(p2, PASSWORD, t.headers).then(() => undefined, (e: unknown) => e);
    expect(locked).toBeInstanceOf(AuthError);
    expect(locked).toMatchObject({ code: "UNAUTHENTICATED", reason: "REAUTH_REQUIRED" });
    const last = (await events(t.userId)).at(-1);
    expect(last).toMatchObject({ event_type: "reauth.failed", detail: { locked: true } });
  });

  it("silinmiş/başkasına ait oturumla yeniden doğrulama reddedilir ve olay yazılmaz", async () => {
    const s = await mkSession();
    const other = await mkSession();
    const principal = await service.getPrincipal(s.headers);
    if (principal === null) throw new Error("principal expected");
    await expect(service.reauthenticate({ ...principal, userId: other.userId }, PASSWORD, s.headers)).rejects.toBeInstanceOf(AuthError);
    await adm.query("DELETE FROM public.sessions WHERE id = $1", [s.sessionId]);
    await expect(service.reauthenticate(principal, PASSWORD, s.headers)).rejects.toBeInstanceOf(AuthError);
    expect(await events(s.userId)).toEqual([]);
    expect(await events(other.userId)).toEqual([]);
  });
});

describe(`0005_security_event_writers ileri/geri/ileri (target=${env.target})`, () => {
  let dirCache: string | undefined;
  let dbName: string | undefined;
  // 0001..0005 geçici kopyası (sonraki migration'lar bu testin beklentilerini değiştirmesin; sabit liste yok).
  const dir = (): string => {
    if (dirCache !== undefined) return dirCache;
    dirCache = mkdtempSync(path.join(tmpdir(), "wms-mig-0005-"));
    cpSync(MIGRATIONS_DIR, dirCache, {
      recursive: true,
      filter: (src) => !/[\\/]\d{4}_/.test(src) || (/[\\/](\d{4})_[^\\/]*$/.exec(src)?.[1] ?? "9999") <= "0005",
    });
    return dirCache;
  };
  afterAll(async () => {
    if (dirCache !== undefined) rmSync(dirCache, { recursive: true, force: true });
    if (dbName !== undefined) {
      const c = await connect(env.databaseUrlDirect);
      try {
        await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    }
  }, 60_000);

  it("geri alma yalnızca tetikleyiciyi/işlevi kaldırır, satırlar korunur (bekçi gerekmez); yeniden ileri kısıtı geri getirir", async () => {
    dbName = `wms_evw_${randomBytes(5).toString("hex")}`;
    const a = await connect(env.databaseUrlDirect);
    try {
      await a.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await a.end();
    }
    const u = new URL(env.databaseUrlDirect);
    u.pathname = `/${dbName}`;
    const url = u.toString();
    expect((await migrateUp({ url, dir: dir() })).applied).toContain("0005");
    const trigs = async (): Promise<{ t: string[]; f: string[] }> => {
      const c = await connect(url);
      try {
        const t = await c.query<{ n: string }>("SELECT tgname AS n FROM pg_trigger WHERE tgrelid = 'public.security_events'::regclass AND tgname = 'security_events_identity_writers'");
        const f = await c.query<{ n: string }>("SELECT proname AS n FROM pg_proc WHERE proname = 'security_events_restrict_identity_writers'");
        return { t: t.rows.map((r) => r.n), f: f.rows.map((r) => r.n) };
      } finally {
        await c.end();
      }
    };
    expect(await trigs()).toEqual({ t: ["security_events_identity_writers"], f: ["security_events_restrict_identity_writers"] });
    const c = await connect(url);
    try {
      expect(await code(c, ins("reauth.succeeded"))).toBe("42501"); // sahip rol bile yazamaz
      expect(await code(c, ins("app.keep"))).toBe("OK");
    } finally {
      await c.end();
    }
    // Geri al (staging'de de: veri kaybı yok → bekçi RAISE etmemeli; ortam kapısı yalnızca 0002 down'ında).
    const down = await migrateDown({ url, dir: dir(), to: "0004", wmsEnv: "ci" });
    expect(down.reverted).toEqual(["0005"]);
    expect(await trigs()).toEqual({ t: [], f: [] });
    const c2 = await connect(url);
    try {
      expect(await code(c2, ins("reauth.succeeded"))).toBe("OK"); // kısıt kalktı
      const n = await c2.query<{ n: string }>("SELECT count(*)::text AS n FROM public.security_events");
      expect(Number(n.rows[0]?.n)).toBeGreaterThanOrEqual(2); // satırlar korundu
    } finally {
      await c2.end();
    }
    expect((await migrateUp({ url, dir: dir() })).applied).toEqual(["0005"]);
    expect(await trigs()).toEqual({ t: ["security_events_identity_writers"], f: ["security_events_restrict_identity_writers"] });
    const c3 = await connect(url);
    try {
      expect(await code(c3, ins("login_failed"))).toBe("42501");
    } finally {
      await c3.end();
    }
  });
});
