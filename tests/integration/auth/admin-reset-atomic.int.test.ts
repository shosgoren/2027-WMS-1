// T-283: yönetici kaynaklı parola sıfırlaması TEK `wms_auth` transaction'ında (denetim + tüketim + parola + oturum iptali +
// olay; hedef `users` satırı FOR UPDATE). Deterministik yarış testleri: zamanlama ikinci bağlantının tuttuğu kilitlerle
// kurulur (uyku/zamanlayıcı yok; bekleme `pg_stat_activity` ile gözlenir). Fikstürler sentetik (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { createAuth, readAuthEnv, type AuthService } from "../../../packages/auth/src/index.ts";
import { hashPassword } from "../../../packages/auth/src/password.ts";
import { issuePasswordResetLink, type PasswordResetPort } from "../../../packages/domain/src/identity/memberships.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const BASE = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const PASSWORD = `P${randomBytes(12).toString("hex")}`;
const NEW_PASSWORD = `N${randomBytes(12).toString("hex")}`;

let app: DbClient;
let authClient: DbClient;
let auth: AuthService;
let port: PasswordResetPort;
let adm: pg.Client; // kurulum + gözlem
let holder: pg.Client; // kilit tutan ikinci bağlantı
let other: pg.Client; // yarışan üyelik değişikliği
const createdUsers: string[] = [];

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect, authUrl])}`);
  }
  return c;
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  authClient = createDbClient({ url: authUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  auth = createAuth({
    client: authClient,
    env: readAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DATABASE_URL: env.databaseUrl, AUTH_DATABASE_URL: authUrl }),
  });
  port = {
    createToken: (u, t) => auth.createPasswordResetToken(u, t),
    discardToken: (id) => auth.discardPasswordResetToken(id),
    recordIssued: (i) => auth.recordPasswordResetLinkIssued(i),
  };
  adm = await connect(env.databaseUrlDirect);
  holder = await connect(env.databaseUrlDirect);
  other = await connect(env.databaseUrlDirect);
}, 120_000);

afterAll(async () => {
  await adm.query("DELETE FROM public.verifications WHERE value = ANY($1::text[])", [createdUsers]).catch(() => undefined);
  await holder.query("ROLLBACK").catch(() => undefined);
  await other.query("ROLLBACK").catch(() => undefined);
  await Promise.all([adm.end(), holder.end(), other.end()]);
  await app.close();
  await authClient.close();
}, 60_000);

interface Member {
  userId: string;
  membershipId: string;
}
let ipCounter = 0;
const nextIp = (): string => `198.51.100.${(++ipCounter % 250) + 1}`;

async function mkTenant(): Promise<{ tenant: string; slug: string }> {
  const tenant = randomUUID();
  const slug = `t283-${randomBytes(6).toString("hex")}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T283', false)", [tenant, slug]);
  return { tenant, slug };
}
async function mkMember(tenant: string, role: string, owner = false): Promise<Member> {
  const u = await adm.query<{ id: string }>(
    "INSERT INTO public.users (name, email, email_verified) VALUES ('T283 fixture', $1, true) RETURNING id",
    [`t283-${randomBytes(6).toString("hex")}@example.test`],
  );
  const userId = (u.rows[0] as { id: string }).id;
  createdUsers.push(userId);
  await adm.query("INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1::text, 'credential', $1::uuid, $2)", [
    userId,
    await hashPassword(PASSWORD),
  ]);
  const m = await adm.query<{ id: string }>(
    "INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id",
    [tenant, userId, owner],
  );
  const membershipId = (m.rows[0] as { id: string }).id;
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, membershipId, role]);
  return { userId, membershipId };
}
async function mkSession(userId: string): Promise<void> {
  await adm.query(
    "INSERT INTO public.sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
    [randomBytes(16).toString("hex"), userId],
  );
}

/** Tenant + sahip + yönetici + hedef, canlı oturum ve üretilmiş yönetici belirteci. */
async function arrange(): Promise<{ target: Member; token: string; tenant: string }> {
  const { tenant, slug } = await mkTenant();
  await mkMember(tenant, "TENANT_ADMIN", true);
  const admin = await mkMember(tenant, "TENANT_ADMIN");
  const target = await mkMember(tenant, "PICKER");
  await mkSession(target.userId);
  const res = await issuePasswordResetLink(
    { db: app, principal: { userId: admin.userId, mfaVerified: true }, tenantSlug: slug, memberId: target.membershipId, recentAuth: () => Promise.resolve() },
    { demoEmailDomain: "demo-t283.example.invalid", port },
  );
  return { target, token: res.token, tenant };
}

function reset(token: string): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": nextIp(), "user-agent": "t283-int" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    }),
  );
}
const scalar = async (q: string, p: unknown[] = []): Promise<unknown> => Object.values((await adm.query(q, p)).rows[0] ?? {})[0];
const pwHash = (userId: string): Promise<unknown> => scalar("SELECT password FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential'", [userId]);
const sessions = (userId: string): Promise<unknown> => scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [userId]);
const grants = (userId: string): Promise<unknown> => scalar("SELECT count(*)::int FROM public.admin_reset_grants WHERE user_id = $1", [userId]);
const eventCount = (userId: string, type: string): Promise<unknown> =>
  scalar("SELECT count(*)::int FROM public.security_events WHERE user_id = $1 AND event_type = $2", [userId, type]);

/** Başka bir bağlantının, metni `pattern` ile eşleşen ifadede bir kilit beklediğini gözlenene kadar bekler (sonsuz değil). */
async function waitUntilBlocked(pattern: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const n = await scalar(
      "SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE $1",
      [pattern],
    );
    if (n === 1) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no backend blocked on ${pattern}`);
}

describe("T-283 yönetici sıfırlaması atomik", () => {
  it("üyelik değişikliği DENETİM ile YAZIM arasına giremez: sıfırlama tamamlanana kadar bekler (hedef users FOR UPDATE)", async () => {
    const { target, token } = await arrange();
    const { tenant: otherTenant } = await mkTenant();
    const before = await pwHash(target.userId);
    // Parola yazımını (accounts UPDATE) kilitle: sıfırlama grant'i tüketip users'ı kilitledikten sonra burada bekler.
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential' FOR UPDATE", [target.userId]);
    const resetP = reset(token);
    await waitUntilBlocked("UPDATE public.accounts%");
    // Sıfırlama bu noktada denetimi bitirmiş ve users kilidini tutuyor; araya başka tenant üyeliği sokulmaya çalışılır.
    await other.query("BEGIN");
    const joinP = other.query("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false)", [otherTenant, target.userId]);
    await waitUntilBlocked("INSERT INTO public.tenant_memberships%");
    // Üyelik girişi henüz commit değil ve sıfırlama da bitmedi.
    expect(await pwHash(target.userId)).toBe(before);
    await holder.query("ROLLBACK");
    const res = await resetP;
    expect(res.status).toBe(200);
    await joinP;
    await other.query("COMMIT");
    expect(await pwHash(target.userId)).not.toBe(before);
    expect(await sessions(target.userId)).toBe(0);
    expect(await grants(target.userId)).toBe(0);
    expect(await eventCount(target.userId, "password_reset_link.consumed")).toBe(1);
    expect(await eventCount(target.userId, "password_reset")).toBe(1);
  });

  it("üyelik değişikliği ÖNCE commit olursa sıfırlama reddedilir: parola ve oturum değişmez", async () => {
    const { target, token } = await arrange();
    const { tenant: otherTenant } = await mkTenant();
    const before = await pwHash(target.userId);
    // Hedef başka tenant'a katılıyor (commit edilmedi; tetikleyici grant'i siler ve users'ta FOR KEY SHARE tutar).
    await other.query("BEGIN");
    await other.query("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false)", [otherTenant, target.userId]);
    const resetP = reset(token);
    await waitUntilBlocked("SELECT id FROM public.users WHERE id =%FOR UPDATE%");
    await other.query("COMMIT");
    const res = await resetP;
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("RESET_LINK_REJECTED");
    expect(await pwHash(target.userId)).toBe(before);
    expect(await sessions(target.userId)).toBe(1);
    expect(await grants(target.userId)).toBe(0);
    expect(await eventCount(target.userId, "password_reset_link.consumed")).toBe(0);
    expect(await eventCount(target.userId, "password_reset")).toBe(0);
  });

  it("parola yazımı başarısızsa grant tüketilmez, hiçbir şey yazılmaz; sonra yeniden denenebilir", async () => {
    const { target, token } = await arrange();
    const before = await pwHash(target.userId);
    const name = `t283_fault_${randomBytes(4).toString("hex")}`;
    await adm.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 't283 injected fault'; END $f$`);
    await adm.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON public.accounts FOR EACH ROW WHEN (OLD.user_id = '${target.userId}') EXECUTE FUNCTION public.${name}()`);
    try {
      const res = await reset(token);
      expect(res.status).toBe(403);
    } finally {
      await adm.query(`DROP TRIGGER ${name} ON public.accounts`);
      await adm.query(`DROP FUNCTION public.${name}()`);
    }
    expect(await pwHash(target.userId)).toBe(before);
    expect(await sessions(target.userId)).toBe(1);
    expect(await grants(target.userId)).toBe(1);
    expect(await scalar("SELECT count(*)::int FROM public.verifications WHERE value = $1 AND identifier LIKE 'reset-password:%'", [target.userId])).toBe(1);
    expect(await eventCount(target.userId, "password_reset_link.consumed")).toBe(0);
    expect((await reset(token)).status).toBe(200);
    expect(await pwHash(target.userId)).not.toBe(before);
  });
});
