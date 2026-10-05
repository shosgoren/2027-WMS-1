// @wms/auth çekirdek entegrasyon testi (T-112; ADR-014): gerçek Postgres + PgBouncer, gerçek roller.
//
// - Better Auth tabloları `wms_auth` (AUTH_DATABASE_URL), olaylar `wms_app` (DATABASE_URL) ile yazılır.
// - Kayıt ucu kapalıdır (`disableSignUp: true`); kullanıcılar migration rolüyle FİKSTÜR olarak açılır
//   (parola özeti `hashPassword` ile). Parolalar bu dosyaya özgü sentetik değerlerdir (G-09).
// - Her senaryo kendi `fly-client-ip` değerini kullanır (IP başına hız sınırı kovaları ayrışır).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AuthError, createAuth, readAuthEnv, type AuthService } from "../../../packages/auth/src/index.ts";
import { hashPassword } from "../../../packages/auth/src/password.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];

const BASE = "http://localhost:3000";
const INSUFFICIENT_PRIVILEGE = "42501";
const PASSWORD = "Sentetik-Parola-T112-A";
const WRONG_PASSWORD = "Sentetik-Yanlis-T112-B";

let service: AuthService;
let authClient: DbClient;
let eventClient: DbClient;
let adm: pg.Client;
let app: pg.Client;

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

let ipCounter = 0;
/** Her çağrıda ayrı TEST-NET-3 adresi (203.0.113.0/24). */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

async function mkUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `t112-${randomBytes(6).toString("hex")}@example.invalid`;
  await adm.query("INSERT INTO public.users (id, name, email, email_verified) VALUES ($1, 'T112 Kullanici', $2, true)", [id, email]);
  await adm.query(
    "INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1, 'credential', $2, $3)",
    [id, id, await hashPassword(PASSWORD)],
  );
  return { id, email };
}

function post(path: string, body: unknown, ip: string, cookie?: string): Promise<Response> {
  return service.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "fly-client-ip": ip,
        "user-agent": "t112-int-test",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Set-Cookie başlıklarından `ad=değer` çerez başlığı; süresi dolmuş/boş değerler atılır. */
function jarFrom(res: Response, previous = ""): string {
  const jar = new Map<string, string>();
  for (const part of previous.split("; ")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const line of res.headers.getSetCookie()) {
    const first = line.split(";")[0] ?? "";
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i);
    const value = first.slice(i + 1);
    if (value === "" || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function sessionCookieValue(jar: string): string | undefined {
  return jar.split("; ").find((c) => c.includes("session_token"))?.split("=").slice(1).join("=");
}

async function signIn(email: string, ip: string, password = PASSWORD): Promise<{ res: Response; jar: string }> {
  const res = await post("/sign-in/email", { email, password }, ip);
  return { res, jar: jarFrom(res) };
}

function headersWith(jar: string): Headers {
  return new Headers({ cookie: jar, "fly-client-ip": "203.0.113.250" });
}

// RFC 6238 (SHA-1, 6 hane, 30 sn) — sınama yardımcısı; Better Auth'a bağımlı değil.
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const off = (h[h.length - 1] ?? 0) & 0x0f;
  const bin = (((h[off] ?? 0) & 0x7f) << 24) | (((h[off + 1] ?? 0) & 0xff) << 16) | (((h[off + 2] ?? 0) & 0xff) << 8) | ((h[off + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

beforeAll(async () => {
  authClient = createDbClient({ url: authUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  eventClient = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  service = createAuth({
    client: authClient,
    eventClient,
    env: readAuthEnv({
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: BASE,
      DATABASE_URL: env.databaseUrl,
      AUTH_DATABASE_URL: authUrl,
    }),
  });
  adm = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
});

afterAll(async () => {
  await authClient.close();
  await eventClient.close();
  await adm.end().catch(() => undefined);
  await app.end().catch(() => undefined);
}, 60_000);

describe(`auth çekirdek (target=${env.target})`, () => {
  it("giriş → oturumlu istek → çıkış → aynı çerezle istek null", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const { res, jar } = await signIn(u.email, ip);
    expect(res.status).toBe(200);
    const p = await service.getPrincipal(headersWith(jar));
    expect(p).not.toBeNull();
    expect(p?.userId).toBe(u.id);
    expect(p?.mfaVerified).toBe(false);
    expect(p?.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const out = await post("/sign-out", {}, ip, jar);
    expect(out.status).toBe(200);
    // Çıkıştan sonra ESKİ çerezle (istemci silmemiş gibi) istek: DB'den doğrulanır → null.
    expect(await service.getPrincipal(headersWith(jar))).toBeNull();
    const left = await adm.query("SELECT count(*)::int AS n FROM public.sessions WHERE user_id = $1", [u.id]);
    expect(left.rows[0]).toMatchObject({ n: 0 });
  });

  it("oturum belirteci DB'de DÜZ saklanır (ADR-014 risk satırı: rol ayrımı tek savunma)", async () => {
    const u = await mkUser();
    const { jar } = await signIn(u.email, nextIp());
    const cookieToken = decodeURIComponent(sessionCookieValue(jar) ?? "").split(".")[0];
    const row = await adm.query<{ token: string }>("SELECT token FROM public.sessions WHERE user_id = $1", [u.id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.token).toBe(cookieToken);
  });

  it("revokeUserSessions tüm oturumları düşürür", async () => {
    const u = await mkUser();
    const a = await signIn(u.email, nextIp());
    const b = await signIn(u.email, nextIp());
    expect(await service.getPrincipal(headersWith(a.jar))).not.toBeNull();
    expect(await service.getPrincipal(headersWith(b.jar))).not.toBeNull();
    await service.revokeUserSessions(u.id);
    expect(await service.getPrincipal(headersWith(a.jar))).toBeNull();
    expect(await service.getPrincipal(headersWith(b.jar))).toBeNull();
  });

  it("çerez yok / bozuk çerez → null", async () => {
    expect(await service.getPrincipal(new Headers())).toBeNull();
    expect(await service.getPrincipal(new Headers({ cookie: "better-auth.session_token=bozuk.imza" }))).toBeNull();
  });

  it("yanlış parola × eşik → 429; hız sınırı anahtarları SHA-256 özeti (düz IP yok)", async () => {
    const u = await mkUser();
    const ip = nextIp();
    for (let i = 0; i < 10; i += 1) {
      const { res } = await signIn(u.email, ip, WRONG_PASSWORD);
      expect(res.status).toBe(401);
    }
    const blocked = await signIn(u.email, ip, WRONG_PASSWORD);
    expect(blocked.res.status).toBe(429);
    // Doğru parola da aynı IP kovasında engellenir.
    expect((await signIn(u.email, ip)).res.status).toBe(429);
    // Başka IP etkilenmez.
    expect((await signIn(u.email, nextIp())).res.status).toBe(200);

    const keys = await adm.query<{ key_hash: string }>("SELECT key_hash FROM public.auth_rate_limits");
    expect(keys.rows.length).toBeGreaterThan(0);
    for (const k of keys.rows) {
      expect(k.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(k.key_hash).not.toContain(ip);
    }
  });

  it("TOTP etkin kullanıcıda ikinci adım olmadan oturum tamamlanmaz", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const first = await signIn(u.email, ip);
    expect(first.res.status).toBe(200);

    // 2FA kurulumu: enable (parola ister) → TOTP doğrulaması ile etkinleşir.
    const enable = await post("/two-factor/enable", { password: PASSWORD }, ip, first.jar);
    expect(enable.status).toBe(200);
    const enabled = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    expect(enabled.backupCodes.length).toBeGreaterThan(0);
    const secret = new URL(enabled.totpURI).searchParams.get("secret");
    expect(secret).not.toBeNull();
    const confirm = await post("/two-factor/verify-totp", { code: totp(secret ?? "") }, ip, first.jar);
    expect(confirm.status).toBe(200);
    const flag = await adm.query("SELECT two_factor_enabled FROM public.users WHERE id = $1", [u.id]);
    expect(flag.rows[0]).toMatchObject({ two_factor_enabled: true });

    // TOTP gizi ve yedek kodlar DB'de ŞİFRELİ (düz sır/kod görünmez).
    const tf = await adm.query<{ secret: string; backup_codes: string }>("SELECT secret, backup_codes FROM public.two_factors WHERE user_id = $1", [u.id]);
    expect(tf.rows).toHaveLength(1);
    expect(tf.rows[0]?.secret).not.toBe(secret);
    for (const code of enabled.backupCodes) expect(tf.rows[0]?.backup_codes).not.toContain(code);

    // Etkinleştirme oturumu döndürür (totp/index.mjs:206-212: yeni oturum + eskisi silinir) → çerez güncellenir.
    const rotatedJar = jarFrom(confirm, first.jar);
    expect(rotatedJar).not.toBe(first.jar);
    expect(await service.getPrincipal(headersWith(first.jar))).toBeNull();
    expect((await service.getPrincipal(headersWith(rotatedJar)))?.userId).toBe(u.id);
    await post("/sign-out", {}, ip, rotatedJar);

    // Yeni giriş: yalnızca parola → oturum YOK, ikinci adım çağrısı.
    const second = await signIn(u.email, ip);
    expect(second.res.status).toBe(200);
    expect(((await second.res.clone().json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(sessionCookieValue(second.jar)).toBeUndefined();
    expect(await service.getPrincipal(headersWith(second.jar))).toBeNull();
    const none = await adm.query("SELECT count(*)::int AS n FROM public.sessions WHERE user_id = $1", [u.id]);
    expect(none.rows[0]).toMatchObject({ n: 0 });

    // Yanlış kod → oturum yok; doğru kod → oturum.
    const bad = await post("/two-factor/verify-totp", { code: "000000" }, ip, second.jar);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(await service.getPrincipal(headersWith(jarFrom(bad, second.jar)))).toBeNull();
    const good = await post("/two-factor/verify-totp", { code: totp(secret ?? "") }, ip, second.jar);
    expect(good.status).toBe(200);
    const p = await service.getPrincipal(headersWith(jarFrom(good, second.jar)));
    expect(p?.userId).toBe(u.id);
  });

  it("security_events: olaylar yazılır, parola/belirteç içermez", async () => {
    const u = await mkUser();
    const ip = nextIp();
    await signIn(u.email, ip, WRONG_PASSWORD);
    const ok = await signIn(u.email, ip);
    await post("/sign-out", {}, ip, ok.jar);
    const rows = await adm.query<{ event_type: string; user_id: string | null; ip: string | null; user_agent: string | null; detail: unknown }>(
      "SELECT event_type, user_id, ip, user_agent, detail FROM public.security_events WHERE user_id = $1 ORDER BY occurred_at",
      [u.id],
    );
    const types = rows.rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(["login_failed", "login_succeeded", "logout"]));
    expect(rows.rows.find((r) => r.event_type === "login_succeeded")).toMatchObject({ ip, user_agent: "t112-int-test" });
    const dump = JSON.stringify(rows.rows);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(WRONG_PASSWORD);
    expect(dump).not.toContain(decodeURIComponent(sessionCookieValue(ok.jar) ?? "").split(".")[0] ?? "x-yok");
  });

  it("kayıt ucu kapalı; /update-session kapalı (404); parola sıfırlama e-postası bağlı değil", async () => {
    const email = `t112-signup-${randomBytes(4).toString("hex")}@example.invalid`;
    const su = await post("/sign-up/email", { email, password: PASSWORD, name: "X" }, nextIp());
    expect(su.status).toBeGreaterThanOrEqual(400);
    expect(su.status).toBeLessThan(500);
    const made = await adm.query("SELECT count(*)::int AS n FROM public.users WHERE email = $1", [email]);
    expect(made.rows[0]).toMatchObject({ n: 0 });

    const u = await mkUser();
    const { jar } = await signIn(u.email, nextIp());
    const upd = await post("/update-session", { mfaVerifiedAt: new Date().toISOString() }, nextIp(), jar);
    expect(upd.status).toBe(404);
    const col = await adm.query("SELECT mfa_verified_at FROM public.sessions WHERE user_id = $1", [u.id]);
    expect(col.rows[0]).toMatchObject({ mfa_verified_at: null });

    // Var olan ve olmayan e-posta aynı yanıtı verir (kullanıcı sızıntısı yok).
    const known = await post("/request-password-reset", { email: u.email }, nextIp());
    const unknown = await post("/request-password-reset", { email: `yok-${randomBytes(4).toString("hex")}@example.invalid` }, nextIp());
    expect(known.status).toBe(503);
    expect(unknown.status).toBe(503);
    expect(await known.json()).toEqual(await unknown.json());
    const tokens = await adm.query("SELECT count(*)::int AS n FROM public.verifications WHERE identifier LIKE '%reset%'");
    expect(tokens.rows[0]).toMatchObject({ n: 0 });
  });

  it("requireRecentAuth: pencere içinde geçer, dışında UNAUTHENTICATED (DB saati)", async () => {
    const u = await mkUser();
    const { jar } = await signIn(u.email, nextIp());
    const p = await service.getPrincipal(headersWith(jar));
    expect(p).not.toBeNull();
    if (p === null) return;
    await expect(service.requireRecentAuth(p, 600)).resolves.toBeUndefined();
    await adm.query("UPDATE public.sessions SET created_at = now() - interval '20 minutes' WHERE id = $1", [p.sessionId]);
    const old = await service.getPrincipal(headersWith(jar));
    expect(old).not.toBeNull();
    if (old === null) return;
    await expect(service.requireRecentAuth(old, 600)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(service.requireRecentAuth(old, 600)).rejects.toBeInstanceOf(AuthError);
    await expect(service.requireRecentAuth(old, 3600)).resolves.toBeUndefined();
  });

  it("wms_app bağlantısıyla Better Auth tablolarını okuma → yetki hatası (ADR-014 §10)", async () => {
    for (const table of ["sessions", "accounts", "verifications", "two_factors", "auth_rate_limits"]) {
      await expect(app.query(`SELECT 1 FROM public.${table} LIMIT 1`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
    await expect(app.query("SELECT password FROM public.accounts LIMIT 1")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});
