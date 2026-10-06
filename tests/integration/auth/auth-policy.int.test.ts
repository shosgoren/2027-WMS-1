// @wms/auth politika entegrasyon testi (T-112b; ADR-014 §11-16, ADR-016 §9): gerçek Postgres, gerçek roller.
// Parolalar/gizler çalışma anında üretilir (G-09, gitleaks). IP'ler 198.51.100.0/24 (auth-core 203.0.113.0/24 kullanır).
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { InvitedAccountError, createAuth, readAuthEnv, type AuthService } from "../../../packages/auth/src/index.ts";
import { hashPassword } from "../../../packages/auth/src/password.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];
const BASE = "http://localhost:3000";
const PASSWORD = `P${randomBytes(12).toString("hex")}`;
const NEW_PASSWORD = `N${randomBytes(12).toString("hex")}`;
const WRONG_PASSWORD = `W${randomBytes(12).toString("hex")}`;
const SECRET = randomBytes(32).toString("hex");
const DEMO_DOMAIN = "demo-t112b.example.invalid";

let service: AuthService;
let signupService: AuthService;
let demoService: AuthService;
let authClient: DbClient;
let eventClient: DbClient;
let adm: pg.Client;
const tenantIds: string[] = [];

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
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function mkUser(domain = "example.invalid"): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `t112b-${randomBytes(6).toString("hex")}@${domain}`;
  await adm.query("INSERT INTO public.users (id, name, email, email_verified) VALUES ($1, 'T112b Kullanici', $2, true)", [id, email]);
  await adm.query("INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1, 'credential', $2, $3)", [
    id,
    id,
    await hashPassword(PASSWORD),
  ]);
  return { id, email };
}

function call(svc: AuthService, method: "GET" | "POST", path: string, body: unknown, ip: string, cookie?: string): Promise<Response> {
  return svc.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        origin: BASE,
        "fly-client-ip": ip,
        "user-agent": "t112b-int-test",
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
const post = (path: string, body: unknown, ip: string, cookie?: string): Promise<Response> => call(service, "POST", path, body, ip, cookie);

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

async function signIn(email: string, ip: string, password = PASSWORD, svc = service): Promise<{ res: Response; jar: string }> {
  const res = await call(svc, "POST", "/sign-in/email", { email, password }, ip);
  return { res, jar: jarFrom(res) };
}

const headersWith = (jar: string): Headers => new Headers({ cookie: jar, "fly-client-ip": "198.51.100.250" });

function newService(overrides: Record<string, string> = {}): AuthService {
  return createAuth({
    client: authClient,
    eventClient,
    env: readAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DATABASE_URL: env.databaseUrl, AUTH_DATABASE_URL: authUrl, ...overrides }),
  });
}

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

/** `/two-factor/enable` (oturum çerezi) → gizi döndürür; henüz doğrulanmadı. */
async function startEnable(jar: string, ip: string): Promise<string> {
  const enable = await post("/two-factor/enable", { password: PASSWORD }, ip, jar);
  expect(enable.status).toBe(200);
  const body = (await enable.json()) as { totpURI: string };
  const secret = new URL(body.totpURI).searchParams.get("secret");
  expect(secret).not.toBeNull();
  return secret ?? "";
}

beforeAll(async () => {
  authClient = createDbClient({ url: authUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  eventClient = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  service = newService();
  signupService = newService({ WMS_ENV: "local", SIGNUP_ENABLED: "true" });
  demoService = newService({ DEMO_EMAIL_DOMAIN: DEMO_DOMAIN });
  adm = await connect(env.databaseUrlDirect);
});

afterAll(async () => {
  for (const t of tenantIds) {
    await adm.query("DELETE FROM public.invitations WHERE tenant_id = $1", [t]).catch(() => undefined);
    await adm.query("DELETE FROM public.membership_roles WHERE tenant_id = $1", [t]).catch(() => undefined);
    await adm.query("DELETE FROM public.tenant_memberships WHERE tenant_id = $1", [t]).catch(() => undefined);
  }
  await authClient.close();
  await eventClient.close();
  await adm.end().catch(() => undefined);
}, 60_000);

const scalar = async (sqlText: string, params: unknown[]): Promise<unknown> => {
  const r = await adm.query(sqlText, params);
  return r.rows[0] === undefined ? undefined : Object.values(r.rows[0] as Record<string, unknown>)[0];
};

describe(`auth politikası (target=${env.target})`, () => {
  it("kayıt ucu bayrak kapalıyken reddedilir ve hesap açılmaz", async () => {
    const email = `t112b-${randomBytes(6).toString("hex")}@example.invalid`;
    const res = await post("/sign-up/email", { email, password: PASSWORD, name: "X" }, nextIp());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await scalar("SELECT count(*)::int FROM public.users WHERE email = $1", [email])).toBe(0);
  });

  it("SIGNUP_ENABLED=true (local): kayıt açık; gövdedeki invitationClaimId reddedilir ve DB'ye yazılmaz (input:false → FIELD_NOT_ALLOWED)", async () => {
    const claim = randomUUID();
    const evil = `t112b-${randomBytes(6).toString("hex")}@example.invalid`;
    const rejected = await call(signupService, "POST", "/sign-up/email", { email: evil, password: PASSWORD, name: "X", invitationClaimId: claim }, nextIp());
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.status).toBeLessThan(500);
    expect(await scalar("SELECT count(*)::int FROM public.users WHERE invitation_claim_id = $1", [claim])).toBe(0);
    const ok = `t112b-${randomBytes(6).toString("hex")}@example.invalid`;
    const created = await call(signupService, "POST", "/sign-up/email", { email: ok, password: PASSWORD, name: "X" }, nextIp());
    expect(created.status).toBe(200);
    expect(await scalar("SELECT invitation_claim_id FROM public.users WHERE email = $1", [ok])).toBeNull();
    expect(await scalar("SELECT count(*)::int FROM public.users WHERE email = $1", [ok])).toBe(1);
  });

  it("BLOCKER-1: /update-session gövdesinde mfaVerifiedAt → 404; DB NULL; mfaVerified=false", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const { jar } = await signIn(u.email, ip);
    const res = await post("/update-session", { mfaVerifiedAt: new Date().toISOString() }, ip, jar);
    expect([403, 404]).toContain(res.status);
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1 AND mfa_verified_at IS NOT NULL", [u.id])).toBe(0);
    expect((await service.getPrincipal(headersWith(jar)))?.mfaVerified).toBe(false);
  });

  it("MAJOR-1: /update-user gövdesinde invitationClaimId → 4xx; DB değeri değişmedi", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const { jar } = await signIn(u.email, ip);
    const res = await post("/update-user", { name: "Yeni", invitationClaimId: randomUUID() }, ip, jar);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await scalar("SELECT invitation_claim_id FROM public.users WHERE id = $1", [u.id])).toBeNull();
  });

  it("2FA etkinleştirme: diğer oturum düşer; doğrulanan oturum mfaVerified=true", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const a = await signIn(u.email, ip);
    const b = await signIn(u.email, ip);
    expect((await service.getPrincipal(headersWith(b.jar)))?.userId).toBe(u.id);
    const secret = await startEnable(a.jar, ip);
    // Doğrulamadan önce oturum MFA-doğrulanmamış.
    expect((await service.getPrincipal(headersWith(a.jar)))?.mfaVerified).toBe(false);
    const confirm = await post("/two-factor/verify-totp", { code: totp(secret) }, ip, a.jar);
    expect(confirm.status).toBe(200);
    expect(await service.getPrincipal(headersWith(b.jar))).toBeNull();
    expect(await service.getPrincipal(headersWith(a.jar))).toBeNull();
    const rotated = jarFrom(confirm, a.jar);
    const p = await service.getPrincipal(headersWith(rotated));
    expect(p?.userId).toBe(u.id);
    expect(p?.mfaVerified).toBe(true);
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [u.id])).toBe(1);
  });

  it("m6: 2FA kapatılınca aynı oturumda mfaVerified=false; yeni gizle açılınca doğrulanana kadar false, sonra true; diğer oturumlar düşer", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const first = await signIn(u.email, ip);
    const secret1 = await startEnable(first.jar, ip);
    const confirm1 = await post("/two-factor/verify-totp", { code: totp(secret1) }, ip, first.jar);
    expect(confirm1.status).toBe(200);
    const jar1 = jarFrom(confirm1, first.jar);
    expect((await service.getPrincipal(headersWith(jar1)))?.mfaVerified).toBe(true);

    // İkinci cihaz: parola + TOTP ile doğrulanmış ikinci oturum.
    const second = await signIn(u.email, ip);
    expect(((await second.res.clone().json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const verified2 = await post("/two-factor/verify-totp", { code: totp(secret1, Date.now() + 30_000) }, ip, second.jar);
    expect(verified2.status).toBe(200);
    const jar2 = jarFrom(verified2, second.jar);
    expect((await service.getPrincipal(headersWith(jar2)))?.mfaVerified).toBe(true);

    // Kapat: yeni oturum çerezi; MFA işareti NULL; diğer oturumlar düşmüş.
    const disable = await post("/two-factor/disable", { password: PASSWORD }, ip, jar1);
    expect(disable.status).toBe(200);
    const jar3 = jarFrom(disable, jar1);
    const afterDisable = await service.getPrincipal(headersWith(jar3));
    expect(afterDisable?.userId).toBe(u.id);
    expect(afterDisable?.mfaVerified).toBe(false);
    expect(await service.getPrincipal(headersWith(jar2))).toBeNull();
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1 AND mfa_verified_at IS NOT NULL", [u.id])).toBe(0);

    // Yeniden etkinleştirme (yeni giz): doğrulanana kadar false.
    const secret2 = await startEnable(jar3, ip);
    expect(secret2).not.toBe(secret1);
    expect((await service.getPrincipal(headersWith(jar3)))?.mfaVerified).toBe(false);
    const confirm2 = await post("/two-factor/verify-totp", { code: totp(secret2) }, ip, jar3);
    expect(confirm2.status).toBe(200);
    expect((await service.getPrincipal(headersWith(jarFrom(confirm2, jar3))))?.mfaVerified).toBe(true);
  });

  it("parola sıfırlama sonrası tüm oturumlar düşer (revokeSessionsOnPasswordReset)", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const a = await signIn(u.email, ip);
    const b = await signIn(u.email, ip);
    expect((await service.getPrincipal(headersWith(a.jar)))?.userId).toBe(u.id);
    const token = randomBytes(16).toString("hex");
    // Better Auth `verification.storeIdentifier: "hashed"` (verification-token-storage.mjs:4-7: SHA-256, base64url).
    const identifier = createHash("sha256").update(`reset-password:${token}`).digest("base64url");
    await adm.query("INSERT INTO public.verifications (identifier, value, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [identifier, u.id]);
    const reset = await post("/reset-password", { newPassword: NEW_PASSWORD, token }, nextIp());
    expect(reset.status).toBe(200);
    expect(await service.getPrincipal(headersWith(a.jar))).toBeNull();
    expect(await service.getPrincipal(headersWith(b.jar))).toBeNull();
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [u.id])).toBe(0);
    expect((await signIn(u.email, nextIp(), NEW_PASSWORD)).res.status).toBe(200);
  });

  it("parola değişiminde diğer oturumlar düşer (istemci revokeOtherSessions göndermese de)", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const a = await signIn(u.email, ip);
    const b = await signIn(u.email, ip);
    const res = await post("/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, ip, a.jar);
    expect(res.status).toBe(200);
    expect(await service.getPrincipal(headersWith(b.jar))).toBeNull();
    expect((await service.getPrincipal(headersWith(jarFrom(res, a.jar))))?.userId).toBe(u.id);
  });

  it("e-posta başına kilit farklı IP'lerden de işler; anahtar özetlenir", async () => {
    const u = await mkUser();
    for (let i = 0; i < 5; i += 1) {
      const r = await signIn(u.email, nextIp(), WRONG_PASSWORD);
      expect(r.res.status).toBeGreaterThanOrEqual(400);
      expect(r.res.status).not.toBe(429);
    }
    // Yeni IP + DOĞRU parola bile kilitli.
    const locked = await signIn(u.email, nextIp(), PASSWORD);
    expect(locked.res.status).toBe(429);
    expect(await service.getPrincipal(headersWith(locked.jar))).toBeNull();
    // Büyük harfli e-posta aynı kovaya düşer.
    expect((await signIn(u.email.toUpperCase(), nextIp(), PASSWORD)).res.status).toBe(429);
    // Düz e-posta rate-limit tablosunda yok.
    const rows = await adm.query("SELECT key_hash FROM public.auth_rate_limits WHERE key_hash = $1", [
      createHash("sha256").update(`email:signin-fail:${u.email.toLowerCase()}`).digest("hex"),
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(await scalar("SELECT count(*)::int FROM public.auth_rate_limits WHERE key_hash LIKE '%@%'", [])).toBe(0);
  });

  it("MAJOR-1: paralel yanlış girişler (farklı IP'ler) — yalnızca 5'i parola doğrulamasına ulaşır (401), kalanı 429", async () => {
    const u = await mkUser();
    const results = await Promise.all(Array.from({ length: 20 }, () => signIn(u.email, nextIp(), WRONG_PASSWORD)));
    const statuses = results.map((r) => r.res.status);
    expect(statuses.filter((c) => c === 401)).toHaveLength(5);
    expect(statuses.filter((c) => c === 429)).toHaveLength(15);
    // Kilit doğru parolayı da engeller.
    expect((await signIn(u.email, nextIp(), PASSWORD)).res.status).toBe(429);
  });

  it("MAJOR-1: başarılı girişler rezervi geri alır (sayaç -1; sıfırlama değil): 3 başarılı + 5 yanlış → 5 × 401, 6. 429", async () => {
    const u = await mkUser();
    for (let i = 0; i < 3; i += 1) expect((await signIn(u.email, nextIp(), PASSWORD)).res.status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await signIn(u.email, nextIp(), WRONG_PASSWORD)).res.status).toBe(401);
    expect((await signIn(u.email, nextIp(), WRONG_PASSWORD)).res.status).toBe(429);
  });

  /** wms_auth'un `sessions` DELETE ifadelerinden, metni `pattern` içerenleri bu kullanıcı için reddeden test tetikleyicisi. */
  async function withDeleteFailure<T>(userId: string, pattern: string, run: () => Promise<T>): Promise<T> {
    const fn = `t112b_delfail_${randomBytes(4).toString("hex")}`;
    await adm.query(
      `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
       BEGIN
         IF OLD.user_id = '${userId}' AND pg_catalog.current_query() LIKE '${pattern}' THEN
           RAISE EXCEPTION 't112b induced delete failure';
         END IF;
         RETURN OLD;
       END $f$`,
    );
    await adm.query(`CREATE TRIGGER ${fn} BEFORE DELETE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    try {
      return await run();
    } finally {
      await adm.query(`DROP TRIGGER IF EXISTS ${fn} ON public.sessions`);
      await adm.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
    }
  }

  it("MINOR-2: change-password sonrası diğer oturumlar silinemezse fail-closed — istek hata, tüm oturumlar (mevcut dahil) düşer", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const a = await signIn(u.email, ip);
    const b = await signIn(u.email, ip);
    // 1. deneme (`token <>` içeren ifade) başarısız; 2. deneme (kullanıcının tüm oturumları) başarılı.
    const res = await withDeleteFailure(u.id, "%token <>%", () => post("/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, ip, a.jar));
    expect(res.status).toBe(500);
    expect(await service.getPrincipal(headersWith(a.jar))).toBeNull();
    expect(await service.getPrincipal(headersWith(b.jar))).toBeNull();
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [u.id])).toBe(0);
  });

  it("MINOR-1: 2FA etkinleştirmede oturum iptali başarısızsa fail-closed — istek hata, mevcut oturum silinir", async () => {
    const u = await mkUser();
    const ip = nextIp();
    const a = await signIn(u.email, ip);
    const secret = await startEnable(a.jar, ip);
    // Toplu iptal (`WHERE user_id =`) engellenir; geri dönüş (`WHERE token =`) mevcut oturumu siler.
    const res = await withDeleteFailure(u.id, "%WHERE user_id =%", () => post("/two-factor/verify-totp", { code: totp(secret) }, ip, a.jar));
    expect(res.status).toBe(500);
    expect(await service.getPrincipal(headersWith(a.jar))).toBeNull();
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [u.id])).toBe(0);
  });

  it("M9: demo kullanıcısı list-sessions → 403 FORBIDDEN; olayda IP/UA yok; normal kullanıcı etkilenmez", async () => {
    const demo = await mkUser(DEMO_DOMAIN);
    const ip = nextIp();
    const { res, jar } = await signIn(demo.email, ip, PASSWORD, demoService);
    expect(res.status).toBe(200);
    const list = await call(demoService, "GET", "/list-sessions", undefined, ip, jar);
    expect(list.status).toBe(403);
    const upd = await call(demoService, "POST", "/update-user", { name: "x" }, ip, jar);
    expect(upd.status).toBe(403);
    const ev = await adm.query<{ ip: string | null; user_agent: string | null }>(
      "SELECT ip, user_agent FROM public.security_events WHERE user_id = $1 AND event_type = 'demo.action_forbidden'",
      [demo.id],
    );
    expect(ev.rows.length).toBeGreaterThanOrEqual(2);
    for (const r of ev.rows) {
      expect(r.ip).toBeNull();
      expect(r.user_agent).toBeNull();
    }
    const normal = await mkUser();
    const n = await signIn(normal.email, nextIp(), PASSWORD, demoService);
    expect((await call(demoService, "GET", "/list-sessions", undefined, nextIp(), n.jar)).status).toBe(200);
  });

  it("7 günü aşmış oturum getPrincipal → null ve oturum silinir", async () => {
    const u = await mkUser();
    const { jar } = await signIn(u.email, nextIp());
    expect((await service.getPrincipal(headersWith(jar)))?.userId).toBe(u.id);
    await adm.query("UPDATE public.sessions SET created_at = now() - interval '8 days' WHERE user_id = $1", [u.id]);
    expect(await service.getPrincipal(headersWith(jar))).toBeNull();
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [u.id])).toBe(0);
  });
});

describe("createInvitedAccount (ADR-014 MAJOR-1, MINOR-3; ADR-016 m7)", () => {
  async function mkInvite(opts: { claimId: string; claimExpiresInSec?: number; via?: string }): Promise<{ tokenHash: string; email: string }> {
    const inviter = await mkUser();
    const tenantId = randomUUID();
    await adm.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'T112b')", [tenantId, `t112b-${randomBytes(6).toString("hex")}`]);
    tenantIds.push(tenantId);
    const m = await adm.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id", [tenantId, inviter.id]);
    const membershipId = (m.rows[0] as { id: string }).id;
    const tokenHash = randomBytes(32).toString("hex");
    const email = `inv-${randomBytes(6).toString("hex")}@example.invalid`;
    await adm.query(
      `INSERT INTO public.invitations (tenant_id, email_normalized, role_key, token_hash, delivered_via, expires_at,
                                       invited_by_membership_id, claim_id, claim_expires_at)
       VALUES ($1, $2, 'PICKER', $3, $4, now() + interval '1 hour', $5, $6, now() + make_interval(secs => $7))`,
      [tenantId, email, tokenHash, opts.via ?? "EMAIL", membershipId, opts.claimId, opts.claimExpiresInSec ?? 600],
    );
    return { tokenHash, email };
  }

  it("aynı claimId ile iki çağrı → tek hesap; e-posta doğrulanmış; parola kaydı var; giriş yapılabilir", async () => {
    const claimId = randomUUID();
    const inv = await mkInvite({ claimId });
    const input = { invitationTokenHash: inv.tokenHash, claimId, name: "Davetli", password: PASSWORD };
    const first = await service.createInvitedAccount(input);
    expect(first.reused).toBe(false);
    const second = await service.createInvitedAccount(input);
    expect(second).toEqual({ userId: first.userId, reused: true });
    expect(await scalar("SELECT count(*)::int FROM public.users WHERE email = $1", [inv.email])).toBe(1);
    const row = await adm.query<{ email_verified: boolean; invitation_claim_id: string; id: string }>(
      "SELECT id, email_verified, invitation_claim_id FROM public.users WHERE email = $1",
      [inv.email],
    );
    expect(row.rows[0]).toMatchObject({ id: first.userId, email_verified: true, invitation_claim_id: claimId });
    expect(await scalar("SELECT count(*)::int FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential' AND password IS NOT NULL", [first.userId])).toBe(1);
    expect((await signIn(inv.email, nextIp())).res.status).toBe(200);
  });

  it("SCREEN teslimi → email_verified=false", async () => {
    const claimId = randomUUID();
    const inv = await mkInvite({ claimId, via: "SCREEN" });
    await service.createInvitedAccount({ invitationTokenHash: inv.tokenHash, claimId, name: "Davetli", password: PASSWORD });
    expect(await scalar("SELECT email_verified FROM public.users WHERE email = $1", [inv.email])).toBe(false);
  });

  it("farklı/süresi dolmuş claimId → hesap açılmaz (NOT_FOUND)", async () => {
    const claimId = randomUUID();
    const inv = await mkInvite({ claimId });
    await expect(
      service.createInvitedAccount({ invitationTokenHash: inv.tokenHash, claimId: randomUUID(), name: "X", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const expiredClaim = randomUUID();
    const exp = await mkInvite({ claimId: expiredClaim, claimExpiresInSec: -60 });
    const err = await service
      .createInvitedAccount({ invitationTokenHash: exp.tokenHash, claimId: expiredClaim, name: "X", password: PASSWORD })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvitedAccountError);
    expect(await scalar("SELECT count(*)::int FROM public.users WHERE email = ANY($1)", [[inv.email, exp.email]])).toBe(0);
  });

  it("aynı e-postalı başka hesap (claim yok) → FORBIDDEN", async () => {
    const claimId = randomUUID();
    const inv = await mkInvite({ claimId });
    await adm.query("INSERT INTO public.users (name, email) VALUES ('Var', $1)", [inv.email]);
    await expect(
      service.createInvitedAccount({ invitationTokenHash: inv.tokenHash, claimId, name: "X", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("MINOR-3: parola hesabı yazımı yapay hatayla başarısız → users satırı yok; sonra aynı claimId ile başarılı", async () => {
    const claimId = randomUUID();
    const inv = await mkInvite({ claimId });
    const fn = `t112b_fail_${randomBytes(4).toString("hex")}`;
    await adm.query(
      `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
       BEGIN
         IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.email = '${inv.email}') THEN
           RAISE EXCEPTION 't112b induced failure';
         END IF;
         RETURN NEW;
       END $f$`,
    );
    await adm.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    try {
      await expect(
        service.createInvitedAccount({ invitationTokenHash: inv.tokenHash, claimId, name: "X", password: PASSWORD }),
      ).rejects.toBeDefined();
      expect(await scalar("SELECT count(*)::int FROM public.users WHERE email = $1", [inv.email])).toBe(0);
    } finally {
      await adm.query(`DROP TRIGGER IF EXISTS ${fn} ON public.accounts`);
      await adm.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
    }
    const ok = await service.createInvitedAccount({ invitationTokenHash: inv.tokenHash, claimId, name: "X", password: PASSWORD });
    expect(ok.reused).toBe(false);
    expect(await scalar("SELECT count(*)::int FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential' AND password IS NOT NULL", [ok.userId])).toBe(1);
    expect((await signIn(inv.email, nextIp())).res.status).toBe(200);
  });
});
