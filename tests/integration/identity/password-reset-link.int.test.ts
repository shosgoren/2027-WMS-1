// T-117b: yönetici kaynaklı parola sıfırlama bağlantısı (B1; ADR-016 §9 ve 3.-5. tur ekleri; A-42, A-55) ve self-servis
// sıfırlama e-postası. Gerçek wms_app / wms_auth bağlantıları + gerçek Better Auth işleyicisi. Fikstürler sentetik (G-09);
// parolalar/belirteçler çalışma anında üretilir. Migration rolü yalnızca kurulum/doğrulama/hata enjeksiyonu içindir.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { createAuth, readAuthEnv, type AuthService } from "../../../packages/auth/src/index.ts";
import { hashPassword } from "../../../packages/auth/src/password.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { loadMailConfig } from "../../../packages/shared/src/mailer.ts";
import { runTenantCommand } from "../../../packages/domain/src/identity/access.ts";
import { acceptInvitation, inviteMember } from "../../../packages/domain/src/identity/invitations.ts";
import {
  MembershipDenied,
  createResetMailPort,
  issuePasswordResetLink,
  type DenyReason,
  type PasswordResetPort,
} from "../../../packages/domain/src/identity/memberships.ts";
import { ROLE_KEYS, ROLE_PERMISSIONS } from "../../../packages/domain/src/identity/permissions.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];
const BASE = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const PASSWORD = `P${randomBytes(12).toString("hex")}`;
const NEW_PASSWORD = `N${randomBytes(12).toString("hex")}`;
const DEMO_DOMAIN = "demo-t117b-rl.example.invalid";

let app: DbClient;
let authClient: DbClient;
let auth: AuthService; // kurtarma bayrağı KAPALI (varsayılan)
let authOn: AuthService; // AUTH_EMAIL_RECOVERY_ENABLED=true
let adm: pg.Client;
let port: PasswordResetPort;
const createdUsers: string[] = [];

function mkAuth(extra: Record<string, string> = {}, resetMail?: Parameters<typeof createAuth>[0]["resetMail"]): AuthService {
  return createAuth({
    client: authClient,
    env: readAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DATABASE_URL: env.databaseUrl, AUTH_DATABASE_URL: authUrl, ...extra }),
    ...(resetMail === undefined ? {} : { resetMail }),
  });
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  authClient = createDbClient({ url: authUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  auth = mkAuth();
  authOn = mkAuth({ AUTH_EMAIL_RECOVERY_ENABLED: "true" });
  port = {
    createToken: (u, t) => auth.createPasswordResetToken(u, t),
    discardToken: (id) => auth.discardPasswordResetToken(id),
    recordIssued: (i) => auth.recordPasswordResetLinkIssued(i),
  };
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
}, 120_000);

afterAll(async () => {
  // Reddedilen/yarım kalan sıfırlama kayıtları paylaşılan veritabanında kalmaz (auth-core, `reset` içeren kayıt sayar).
  await adm.query("DELETE FROM public.verifications WHERE value = ANY($1::text[])", [createdUsers]).catch(() => undefined);
  await adm.end();
  await app.close();
  await authClient.close();
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Fikstürler
// ---------------------------------------------------------------------------------------------
interface Member {
  userId: string;
  membershipId: string;
  email: string;
}
interface Fx {
  tenant: string;
  slug: string;
  owner: Member;
  admin: Member; // sahip olmayan ikinci yönetici (bağlantıyı üreten)
}
let ipCounter = 0;
const nextIp = (): string => {
  ipCounter += 1;
  return `192.0.2.${(ipCounter % 250) + 1}`;
};
const rndEmail = (domain = "example.test"): string => `t117b-rl-${randomBytes(6).toString("hex")}@${domain}`;

async function mkMember(
  tenant: string,
  role: string,
  o: { owner?: boolean; email?: string; verified?: boolean; claim?: boolean; twoFactor?: boolean } = {},
): Promise<Member> {
  const email = o.email ?? rndEmail();
  const u = await adm.query<{ id: string }>(
    `INSERT INTO public.users (name, email, email_verified, invitation_claim_id, two_factor_enabled)
     VALUES ('T117b fixture', $1, $2, $3, $4) RETURNING id`,
    [email, o.verified ?? true, o.claim === true ? randomUUID() : null, o.twoFactor ?? false],
  );
  const userId = (u.rows[0] as { id: string }).id;
  createdUsers.push(userId);
  await adm.query("INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1::text, 'credential', $1::uuid, $2)", [userId, await hashPassword(PASSWORD)]);
  if (o.twoFactor === true) {
    await adm.query("INSERT INTO public.two_factors (secret, backup_codes, user_id) VALUES ('x', 'y', $1)", [userId]);
  }
  const m = await adm.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id", [tenant, userId, o.owner ?? false]);
  const membershipId = (m.rows[0] as { id: string }).id;
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, membershipId, role]);
  return { userId, membershipId, email };
}
async function mkTenant(opts: { demo?: boolean } = {}): Promise<Fx> {
  const tenant = randomUUID();
  const slug = `t117b-rl-${randomBytes(6).toString("hex")}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T117b RL', $3)", [tenant, slug, opts.demo ?? false]);
  const owner = await mkMember(tenant, "TENANT_ADMIN", { owner: true });
  const admin = await mkMember(tenant, "TENANT_ADMIN");
  return { tenant, slug, owner, admin };
}
const principalOf = (m: Member) => ({ userId: m.userId, mfaVerified: true });

type Params = Parameters<typeof issuePasswordResetLink>[0];
function issue(fx: Fx, actor: Member, memberId: string, over: Partial<Params> = {}, deps: Partial<Parameters<typeof issuePasswordResetLink>[1]> = {}) {
  return issuePasswordResetLink(
    { db: app, principal: principalOf(actor), tenantSlug: fx.slug, memberId, recentAuth: () => Promise.resolve(), ...over },
    { demoEmailDomain: DEMO_DOMAIN, port, ...deps },
  );
}
async function expectDenied(p: Promise<unknown>, reason: DenyReason): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ code: "FORBIDDEN" });
  expect(((err as AppError).cause as MembershipDenied).reason).toBe(reason);
  expect(JSON.stringify((err as AppError).toBody())).not.toMatch(/IDENTITY_SHARED|DEMO|OWNER|NOT_MEMBER/);
}

function reset(svc: AuthService, token: string, ip = nextIp()): Promise<Response> {
  return svc.handler(
    new Request(`${BASE}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": ip, "user-agent": "t117b-int" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    }),
  );
}
async function login(svc: AuthService, email: string, password = PASSWORD): Promise<Response> {
  return svc.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": nextIp(), "user-agent": "t117b-int" },
      body: JSON.stringify({ email, password }),
    }),
  );
}
const scalar = async (q: string, p: unknown[] = []): Promise<unknown> => Object.values((await adm.query(q, p)).rows[0] ?? {})[0];
const pwHash = (userId: string): Promise<unknown> => scalar("SELECT password FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential'", [userId]);
const events = async (userId: string): Promise<string[]> => (await adm.query("SELECT event_type FROM public.security_events WHERE user_id = $1 ORDER BY occurred_at, id", [userId])).rows.map((r: { event_type: string }) => r.event_type);
const grantCount = (userId: string): Promise<unknown> => scalar("SELECT count(*)::int FROM public.admin_reset_grants WHERE user_id = $1", [userId]);
/** Hedefe ait sıfırlama doğrulama kaydı (yönetici kayıtları `reset-password:` önekini korur). */
const adminRecordCount = (userId: string): Promise<unknown> =>
  scalar("SELECT count(*)::int FROM public.verifications WHERE value = $1 AND identifier LIKE 'reset-password:%'", [userId]);
const selfServiceToken = async (userId: string): Promise<string> => {
  const token = randomBytes(16).toString("hex");
  const identifier = createHash("sha256").update(`reset-password:${token}`).digest("base64url");
  await adm.query("INSERT INTO public.verifications (identifier, value, expires_at) VALUES ($1, $2, now() + interval '30 minutes')", [identifier, userId]);
  return token;
};

/** Hata enjeksiyonu: yalnızca belirtilen kullanıcı için tetikleyici (paralel testleri etkilemez); sonunda kaldırılır. */
async function withFault<T>(table: string, op: "INSERT" | "UPDATE" | "DELETE", userId: string, fn: () => Promise<T>): Promise<T> {
  const name = `t117b_fault_${randomBytes(4).toString("hex")}`;
  const ref = op === "DELETE" ? "OLD" : "NEW";
  await adm.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 't117b injected fault'; END $f$`);
  await adm.query(`CREATE TRIGGER ${name} BEFORE ${op} ON public.${table} FOR EACH ROW WHEN (${ref}.user_id = '${userId}') EXECUTE FUNCTION public.${name}()`);
  try {
    return await fn();
  } finally {
    await adm.query(`DROP TRIGGER ${name} ON public.${table}`);
    await adm.query(`DROP FUNCTION public.${name}()`);
  }
}

// ---------------------------------------------------------------------------------------------
describe("issuePasswordResetLink — üretim denetimleri", () => {
  it("yalnızca bu tenant'a üye hedef: bağlantı üretilir; kullanılınca tüm oturumlar düşer; security_events + audit var", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    // İki canlı oturum.
    const s1 = await login(auth, target.email);
    const s2 = await login(auth, target.email);
    expect([s1.status, s2.status]).toEqual([200, 200]);
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [target.userId])).toBe(2);
    const before = await pwHash(target.userId);

    const res = await issue(fx, fx.admin, target.membershipId);
    expect(res.token).toMatch(/^adm_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    expect(res.token.startsWith(`adm_${fx.tenant.replaceAll("-", "")}_`)).toBe(true);
    expect(res.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(res.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);

    // Grant + işaretli kayıt; düz belirteç DB'de yok.
    const g = await adm.query("SELECT issuing_tenant_id, issuing_membership_id, user_id FROM public.admin_reset_grants WHERE user_id = $1", [target.userId]);
    expect(g.rows).toEqual([{ issuing_tenant_id: fx.tenant, issuing_membership_id: fx.admin.membershipId, user_id: target.userId }]);
    expect(await adminRecordCount(target.userId)).toBe(1);
    const plain = await scalar("SELECT count(*)::int FROM public.verifications WHERE identifier LIKE '%' || $1 || '%'", [res.token]);
    expect(plain).toBe(0);
    // Üretim olayları: security_events (yönetici kimliği + tenant) ve tenant audit'i.
    expect(await events(target.userId)).toContain("password_reset_link.issued_by_admin");
    const ev = await adm.query("SELECT detail FROM public.security_events WHERE user_id = $1 AND event_type = 'password_reset_link.issued_by_admin'", [target.userId]);
    expect(ev.rows[0].detail).toMatchObject({ tenant_id: fx.tenant, admin_user_id: fx.admin.userId, membership_id: fx.admin.membershipId });
    const au = await adm.query("SELECT actor_user_id, entity_id FROM public.audit_logs WHERE tenant_id = $1 AND action = 'password_reset_link.issued'", [fx.tenant]);
    expect(au.rows).toEqual([{ actor_user_id: fx.admin.userId, entity_id: target.membershipId }]);

    // Kullanım (ayrı transaction'da yeniden denetlenir): parola değişir, TÜM oturumlar düşer, grant/kayıt tükenir.
    const used = await reset(auth, res.token);
    expect(used.status).toBe(200);
    expect(await pwHash(target.userId)).not.toBe(before);
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [target.userId])).toBe(0);
    expect(await grantCount(target.userId)).toBe(0);
    expect(await adminRecordCount(target.userId)).toBe(0);
    expect((await login(auth, target.email, NEW_PASSWORD)).status).toBe(200);
    const evs = await events(target.userId);
    expect(evs).toContain("password_reset");
    expect(evs).toContain("password_reset_link.consumed");
    const cons = await adm.query("SELECT detail FROM public.security_events WHERE user_id = $1 AND event_type = 'password_reset_link.consumed'", [target.userId]);
    expect(cons.rows[0].detail).toMatchObject({ issuing_tenant_id: fx.tenant, tenant_verified: true });
    // Tek kullanımlık.
    expect((await reset(auth, res.token)).status).toBeGreaterThanOrEqual(400);
  });

  it("hedef başka tenant'a da üye → FORBIDDEN (IDENTITY_SHARED); kayıt/grant oluşmaz", async () => {
    const fx = await mkTenant();
    const other = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    await adm.query("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false)", [other.tenant, target.userId]);
    await expectDenied(issue(fx, fx.admin, target.membershipId), "IDENTITY_SHARED");
    expect(await adminRecordCount(target.userId)).toBe(0);
    expect(await grantCount(target.userId)).toBe(0);
    expect(await events(target.userId)).not.toContain("password_reset_link.issued_by_admin");
  });

  it("demo tenant, demo hedef, sahip hedef, kendisi, çıkarılmış/yabancı hedef → ret", async () => {
    const demo = await mkTenant({ demo: true });
    const dt = await mkMember(demo.tenant, "PICKER");
    await expectDenied(issue(demo, demo.admin, dt.membershipId), "DEMO");
    expect(await adminRecordCount(dt.userId)).toBe(0);

    const fx = await mkTenant();
    const demoUser = await mkMember(fx.tenant, "PICKER", { email: rndEmail(DEMO_DOMAIN) });
    await expectDenied(issue(fx, fx.admin, demoUser.membershipId), "DEMO");
    await expectDenied(issue(fx, fx.admin, fx.owner.membershipId), "OWNER");
    await expect(issue(fx, fx.admin, fx.admin.membershipId)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Sıfır ACTIVE üyelikli hedef (çıkarılmış) ve başka tenant'ın üyeliği → FORBIDDEN (nötr).
    const gone = await mkMember(fx.tenant, "PICKER");
    await adm.query("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = $1", [gone.membershipId]);
    await expectDenied(issue(fx, fx.admin, gone.membershipId), "NOT_MEMBER");
    const foreign = await mkMember((await mkTenant()).tenant, "PICKER");
    await expectDenied(issue(fx, fx.admin, foreign.membershipId), "NOT_MEMBER");
    for (const u of [demoUser.userId, fx.owner.userId, gone.userId, foreign.userId]) expect(await adminRecordCount(u)).toBe(0);
  });

  it("tekillik işlevi: sıfır üyelikli kullanıcı için false", async () => {
    const fx = await mkTenant();
    const stray = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T117b stray', $1, true) RETURNING id", [rndEmail()]);
    const ok = await runTenantCommand({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, permission: "users.manage" }, async (tx) => {
      const r = await tx.execute<{ ok: boolean }>(
        `SELECT wms_probe.identity_exclusive_to_tenant('${(stray.rows[0] as { id: string }).id}'::uuid) AS ok`, // UUID: DB üretimi
      );
      return r[0]?.ok;
    });
    expect(ok).toBe(false);
  });

  it("izinsiz çağıran (users.manage yok) FORBIDDEN; yeniden doğrulama penceresi dolmuşsa RECENT_AUTH_REQUIRED; kanca yoksa ret", async () => {
    const fx = await mkTenant();
    const wm = await mkMember(fx.tenant, "WAREHOUSE_MANAGER");
    const target = await mkMember(fx.tenant, "PICKER");
    await expect(issue(fx, wm, target.membershipId)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Gerçek requireRecentAuth: 20 dk önce açılmış oturum, pencere 10 dk.
    const stale = { userId: fx.admin.userId, sessionId: randomUUID(), authenticatedAt: new Date(Date.now() - 20 * 60_000), mfaVerified: true, isDemo: false, twoFactorEnabled: false };
    const err = await issue(fx, fx.admin, target.membershipId, { recentAuth: () => auth.requireRecentAuth(stale, 600) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "UNAUTHENTICATED", detail: "RECENT_AUTH_REQUIRED" });
    const fresh = { ...stale, authenticatedAt: new Date() };
    await expect(issue(fx, fx.admin, target.membershipId, { recentAuth: () => auth.requireRecentAuth(fresh, 600) })).resolves.toBeDefined();

    const t2 = await mkMember(fx.tenant, "PICKER");
    await expect(issue(fx, fx.admin, t2.membershipId, { recentAuth: undefined })).rejects.toMatchObject({ code: "UNAUTHENTICATED", detail: "RECENT_AUTH_REQUIRED" });
    expect(await adminRecordCount(t2.userId)).toBe(0);
  });

  it("grant transaction'ı geri alınınca bağlantı dönmez ve işaretli kayıt kalmaz", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    await withFault("admin_reset_grants", "INSERT", target.userId, async () => {
      await expect(issue(fx, fx.admin, target.membershipId)).rejects.toBeInstanceOf(AppError);
    });
    expect(await adminRecordCount(target.userId)).toBe(0);
    expect(await grantCount(target.userId)).toBe(0);
    expect(await events(target.userId)).not.toContain("password_reset_link.issued_by_admin");
    expect(await scalar("SELECT count(*)::int FROM public.audit_logs WHERE tenant_id = $1 AND action = 'password_reset_link.issued'", [fx.tenant])).toBe(0);
  });

  it("üretim olayı yazılamazsa bağlantı dönmez ve belirteç silinir", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const failing: PasswordResetPort = { ...port, recordIssued: () => Promise.reject(new Error("injected")) };
    await expect(issue(fx, fx.admin, target.membershipId, {}, { port: failing })).rejects.toBeInstanceOf(AppError);
    expect(await adminRecordCount(target.userId)).toBe(0);
    expect(await grantCount(target.userId)).toBe(0);
    // Audit "üretildi" dedi ama olay yazılamadı: telafi satırı var.
    const au = await adm.query("SELECT change_summary->>'status' AS st FROM public.audit_logs WHERE tenant_id = $1 AND action = 'password_reset_link.issued' ORDER BY occurred_at, id", [fx.tenant]);
    expect(au.rows.map((r: { st: string }) => r.st)).toEqual(["issued", "revoked_before_delivery"]);
  });

  it("olay yazılamaz VE belirteç silinemezse telafi audit durumu discard_failed; hata loglanır", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const logs: Record<string, unknown>[] = [];
    const failing: PasswordResetPort = { ...port, recordIssued: () => Promise.reject(new Error("injected")), discardToken: () => Promise.reject(new Error("injected")) };
    await expect(issue(fx, fx.admin, target.membershipId, {}, { port: failing, log: (e) => logs.push(e) })).rejects.toBeInstanceOf(AppError);
    const au = await adm.query("SELECT change_summary->>'status' AS st FROM public.audit_logs WHERE tenant_id = $1 AND action = 'password_reset_link.issued' ORDER BY occurred_at, id", [fx.tenant]);
    expect(au.rows.map((r: { st: string }) => r.st)).toEqual(["issued", "discard_failed"]);
    expect(logs.some((l) => l.msg === "password reset token cleanup failed")).toBe(true);
    // Silinemeyen kayıt grant'siz değil ama bağlantı hiç dönmedi; temizlik (paylaşılan DB).
    await adm.query("DELETE FROM public.verifications WHERE value = $1", [target.userId]);
  });
});

describe("kullanım anı denetimi (before /reset-password)", () => {
  it("bağlantı üretildi → hedef başka tenant'a katıldı (davet kabulü) → kullanım reddedilir; grant ve kayıt silinmiş", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const target = await mkMember(a.tenant, "PICKER");
    const before = await pwHash(target.userId);
    const link = await issue(a, a.admin, target.membershipId);
    // B tenant'ı hedefi e-posta ekranı daveti ile (teslim edilemez ortam) davet eder; hedef kabul eder.
    const inv = await inviteMember(
      { db: app, principal: principalOf(b.admin), tenantSlug: b.slug, email: target.email, roleKey: "PICKER" },
      { mailConfig: loadMailConfig({}), queue: { enqueue: () => Promise.reject(new Error("unused")) } },
    );
    expect(inv.token).toBeDefined();
    await acceptInvitation(
      { db: app, token: inv.token as string, principal: { userId: target.userId } },
      { createInvitedAccount: () => Promise.reject(new Error("unused")), demoEmailDomain: null },
    );
    // Üyelik tetikleyicisi grant'i VE doğrulama kaydını sildi.
    expect(await grantCount(target.userId)).toBe(0);
    expect(await adminRecordCount(target.userId)).toBe(0);
    const res = await reset(auth, link.token);
    expect(res.status).toBe(403);
    expect(await pwHash(target.userId)).toBe(before);
    const rej = await adm.query("SELECT detail FROM public.security_events WHERE event_type = 'password_reset_link.rejected' AND detail->>'claimed_tenant_id' = $1", [a.tenant]);
    expect(rej.rows[0].detail).toMatchObject({ tenant_verified: false });
    expect(rej.rows[0].detail).not.toHaveProperty("issuing_tenant_id");
  });

  it("grant'i elle silinmiş işaretli belirteç → FORBIDDEN, parola değişmez", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const link = await issue(fx, fx.admin, target.membershipId);
    const before = await pwHash(target.userId);
    await adm.query("DELETE FROM public.admin_reset_grants WHERE user_id = $1", [target.userId]);
    const res = await reset(auth, link.token);
    expect(res.status).toBe(403);
    expect(await pwHash(target.userId)).toBe(before);
    expect(await events(target.userId)).toContain("password_reset_link.rejected");
  });

  it("grant'li ama işaretsiz kayıt → FORBIDDEN + inconsistent; grant silinmiş; parola değişmez", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const token = await selfServiceToken(target.userId);
    const vid = await scalar("SELECT id FROM public.verifications WHERE value = $1 AND identifier NOT LIKE 'reset-password:%'", [target.userId]);
    // Migration rolüyle grant (tetikleyici bekçisi için tenant bağlamı transaction-local).
    await adm.query("BEGIN");
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [fx.tenant]);
    await adm.query(
      `INSERT INTO public.admin_reset_grants (user_id, issuing_tenant_id, issuing_membership_id, verification_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [target.userId, fx.tenant, fx.admin.membershipId, vid],
    );
    await adm.query("COMMIT");
    const before = await pwHash(target.userId);
    const res = await reset(auth, token);
    expect(res.status).toBe(403);
    expect(await grantCount(target.userId)).toBe(0);
    expect(await pwHash(target.userId)).toBe(before);
    expect(await events(target.userId)).toContain("password_reset_link.inconsistent");
  });

  it("'invalid' reddinden sonra migration rolüyle grant satırı yok (tüketim commit edildi)", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const link = await issue(fx, fx.admin, target.membershipId);
    await adm.query("UPDATE public.tenant_memberships SET is_owner = true WHERE id = $1", [target.membershipId]); // hedef sahip yapıldı
    expect((await reset(auth, link.token)).status).toBe(403);
    expect(await grantCount(target.userId)).toBe(0);
    // Koşullar sonradan düzelse de bağlantı kullanılamaz (fail-closed).
    await adm.query("UPDATE public.tenant_memberships SET is_owner = false WHERE id = $1", [target.membershipId]);
    expect((await reset(auth, link.token)).status).toBe(403);
  });

  for (const [name, mutate] of [
    ["ihraç eden yönetici REMOVED", (fx: Fx) => adm.query("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = $1", [fx.admin.membershipId])],
    ["ihraç edenin rolü READ_ONLY", (fx: Fx) => adm.query("UPDATE public.membership_roles SET role_key = 'READ_ONLY' WHERE membership_id = $1", [fx.admin.membershipId])],
    ["tenant SUSPENDED", (fx: Fx) => adm.query("UPDATE public.tenants SET status = 'SUSPENDED' WHERE id = $1", [fx.tenant])],
    ["hedef sahip yapıldı", (fx: Fx, t: Member) => adm.query("UPDATE public.tenant_memberships SET is_owner = true WHERE id = $1", [t.membershipId])],
  ] as const) {
    it(`bağlantı üretildikten sonra ${name} → kullanım FORBIDDEN, parola değişmez`, async () => {
      const fx = await mkTenant();
      const target = await mkMember(fx.tenant, "PICKER");
      const link = await issue(fx, fx.admin, target.membershipId);
      const before = await pwHash(target.userId);
      await mutate(fx, target);
      const res = await reset(auth, link.token);
      expect(res.status).toBe(403);
      expect(await pwHash(target.userId)).toBe(before);
      expect(await grantCount(target.userId)).toBe(0);
    });
  }

  it("SQL'deki users.manage rol listesi ROLE_PERMISSIONS'tan türetilen listeye eşit", async () => {
    const def = String(await scalar("SELECT pg_get_functiondef('wms_probe.consume_admin_reset_grant(uuid)'::regprocedure)"));
    const m = /ir\.role_key IN \(([^)]*)\)/.exec(def);
    expect(m).not.toBeNull();
    const sqlRoles = [...(m?.[1] ?? "").matchAll(/'([A-Z_]+)'/g)].map((x) => x[1] as string).sort();
    const expected = ROLE_KEYS.filter((r) => ROLE_PERMISSIONS[r].includes("users.manage")).sort();
    expect(sqlRoles).toEqual(expected);
  });

  it("iki eşzamanlı /reset-password (işaretli belirteç): en fazla biri başarılı", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const link = await issue(fx, fx.admin, target.membershipId);
    const rs = await Promise.all([reset(auth, link.token), reset(auth, link.token)]);
    expect(rs.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
  });

  it("self-servis (işaretsiz) belirteç grant'sız normal akışla çalışır", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const token = await selfServiceToken(target.userId);
    const before = await pwHash(target.userId);
    expect((await reset(auth, token)).status).toBe(200);
    expect(await pwHash(target.userId)).not.toBe(before);
    expect(await events(target.userId)).not.toContain("password_reset_link.rejected");
  });
});

describe("B1: saklanan kimlik belirteç olarak gönderilemez; kısa parola bağlantıyı yakmaz", () => {
  it("saklanan kimlik/özet belirteç olarak gönderilirse grant YAKILMADAN ve self-servis yola düşmeden reddedilir (ardışık iki istek dahil)", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const link = await issue(fx, fx.admin, target.membershipId);
    const stored = String(await scalar("SELECT identifier FROM public.verifications WHERE value = $1 AND identifier LIKE 'reset-password:%'", [target.userId]));
    expect(stored).toMatch(/^reset-password:h\./);
    const digest = stored.slice("reset-password:".length); // `h.<özet>`
    const before = await pwHash(target.userId);
    for (const attempt of [digest, digest.slice(2), stored, `adm_${fx.tenant.replaceAll("-", "")}_${digest}`]) {
      // Biçim dışı → 403 (arama yok); biçime uyan özet (yalnızca alfasayısal) → kayıt bulunamaz (400). Hiçbiri 200 olamaz.
      expect([400, 403]).toContain((await reset(auth, attempt)).status);
      expect([400, 403]).toContain((await reset(auth, attempt)).status); // ikinci ardışık istek de self-servis yola düşmez
    }
    expect(await pwHash(target.userId)).toBe(before);
    expect(await grantCount(target.userId)).toBe(1);
    expect(await adminRecordCount(target.userId)).toBe(1);
    // Asıl bağlantı hâlâ çalışır.
    expect((await reset(auth, link.token)).status).toBe(200);
    expect(await pwHash(target.userId)).not.toBe(before);
  });

  it("GET /reset-password/:token: saklanan h.<özet> başarı yönlendirmesi vermez; geçerli belirteç yönlendirir; kayıt aranmaz", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const link = await issue(fx, fx.admin, target.membershipId);
    const stored = String(await scalar("SELECT identifier FROM public.verifications WHERE value = $1 AND identifier LIKE 'reset-password:%'", [target.userId]));
    const digest = stored.slice("reset-password:".length);
    const get = (t: string): Promise<Response> =>
      auth.handler(
        new Request(`${BASE}/api/auth/reset-password/${encodeURIComponent(t)}?callbackURL=${encodeURIComponent("/reset-password")}`, {
          method: "GET",
          headers: { origin: BASE, "fly-client-ip": nextIp(), "user-agent": "t117b-int" },
          redirect: "manual",
        }),
      );
    const bad = await get(digest);
    expect(bad.status).toBe(403);
    expect(bad.headers.get("location") ?? "").not.toMatch(/[?&]token=/);
    const good = await get(link.token);
    expect([301, 302, 303, 307]).toContain(good.status);
    expect(good.headers.get("location") ?? "").toContain(`token=${link.token}`);
    expect(await grantCount(target.userId)).toBe(1); // GET grant'i tüketmez
  });

  it("kısa parola ile kullanım bağlantıyı tüketmez", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const link = await issue(fx, fx.admin, target.membershipId);
    const short = await auth.handler(
      new Request(`${BASE}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": nextIp(), "user-agent": "t117b-int" },
        body: JSON.stringify({ token: link.token, newPassword: "kisa" }),
      }),
    );
    expect(short.status).toBe(400);
    expect(await grantCount(target.userId)).toBe(1);
    expect((await reset(auth, link.token)).status).toBe(200);
  });
});

describe("A-55 e-posta kurtarma (AUTH_EMAIL_RECOVERY_ENABLED, ADR-014 4.-5. tur)", () => {
  async function recoverable(fx: Fx, o: { claim?: boolean; verified?: boolean } = {}): Promise<Member> {
    const m = await mkMember(fx.tenant, "PICKER", { verified: o.verified ?? false, claim: o.claim ?? true, twoFactor: true });
    expect((await login(auth, m.email)).status).toBe(200); // canlı oturum (2FA kaydı var ama bu testte giriş akışı kurulmaz)
    return m;
  }
  const state = async (userId: string) => ({
    verified: await scalar("SELECT email_verified FROM public.users WHERE id = $1", [userId]),
    twoFactorEnabled: await scalar("SELECT two_factor_enabled FROM public.users WHERE id = $1", [userId]),
    twoFactors: await scalar("SELECT count(*)::int FROM public.two_factors WHERE user_id = $1", [userId]),
  });

  it("bayrak KAPALI: parola değişir; email_verified=false, 2FA kayıtlı, kurtarma olayı yok", async () => {
    const fx = await mkTenant();
    const m = await recoverable(fx);
    const before = await pwHash(m.userId);
    expect((await reset(auth, await selfServiceToken(m.userId))).status).toBe(200);
    expect(await pwHash(m.userId)).not.toBe(before);
    expect(await state(m.userId)).toEqual({ verified: false, twoFactorEnabled: true, twoFactors: 1 });
    expect(await events(m.userId)).not.toContain("account.recovered_via_email");
  });

  it("bayrak AÇIK: oturumlar düşer, 2FA silinir/kapanır, email_verified=true, olay yazılır", async () => {
    const fx = await mkTenant();
    const m = await recoverable(fx);
    expect((await reset(authOn, await selfServiceToken(m.userId))).status).toBe(200);
    expect(await state(m.userId)).toEqual({ verified: true, twoFactorEnabled: false, twoFactors: 0 });
    expect(await scalar("SELECT count(*)::int FROM public.sessions WHERE user_id = $1", [m.userId])).toBe(0);
    expect(await events(m.userId)).toContain("account.recovered_via_email");
  });

  it("bayrak AÇIK + invitation_claim_id NULL doğrulanmamış hesap (yerel kayıt) → kurtarma etkisi yok", async () => {
    const fx = await mkTenant();
    const m = await recoverable(fx, { claim: false });
    expect((await reset(authOn, await selfServiceToken(m.userId))).status).toBe(200);
    expect(await state(m.userId)).toEqual({ verified: false, twoFactorEnabled: true, twoFactors: 1 });
    expect(await events(m.userId)).not.toContain("account.recovered_via_email");
  });

  it("bayrak AÇIK: yönetici bağlantısı kullanımı email_verified'i ve 2FA'yı değiştirmez", async () => {
    const fx = await mkTenant();
    const m = await recoverable(fx);
    const link = await issue(fx, fx.admin, m.membershipId);
    expect((await reset(authOn, link.token)).status).toBe(200);
    expect(await state(m.userId)).toEqual({ verified: false, twoFactorEnabled: true, twoFactors: 1 });
    expect(await events(m.userId)).not.toContain("account.recovered_via_email");
  });

  it("bayrak AÇIK + two_factors silme adımı başarısız → kurtarma alanları değişmez; recovery_failed yazılır", async () => {
    const fx = await mkTenant();
    const m = await recoverable(fx);
    const token = await selfServiceToken(m.userId);
    const res = await withFault("two_factors", "DELETE", m.userId, () => reset(authOn, token));
    expect(res.status).toBe(500);
    expect(await state(m.userId)).toEqual({ verified: false, twoFactorEnabled: true, twoFactors: 1 });
    const evs = await events(m.userId);
    expect(evs).not.toContain("account.recovered_via_email");
    expect(evs).toContain("account.recovery_failed");
  });

  it("bayrak AÇIK + parola güncellemesi başarısız → kurtarma alanları değişmez", async () => {
    const fx = await mkTenant();
    const m = await recoverable(fx);
    const token = await selfServiceToken(m.userId);
    const before = await pwHash(m.userId);
    const res = await withFault("accounts", "UPDATE", m.userId, () => reset(authOn, token));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await pwHash(m.userId)).toBe(before);
    expect(await state(m.userId)).toEqual({ verified: false, twoFactorEnabled: true, twoFactors: 1 });
    expect(await events(m.userId)).not.toContain("account.recovered_via_email");
  });
});

describe("self-servis sıfırlama e-postası (A-42): sendResetPassword → enqueuePlatform('email.send', { sealed })", () => {
  it("teslim edilebilirse mühürlü platform işi yazılır; bağlantı yanıtta yok; var/yok ayrımı yok; teslim edilemezse 503", async () => {
    const jobs: unknown[] = [];
    const queue = {
      enqueuePlatform: (job: unknown) => {
        jobs.push(job);
        return Promise.resolve({ jobId: "j" });
      },
    };
    const mailOn = loadMailConfig({ MAIL_MODE: "mailpit", MAILPIT_URL: "http://localhost:8025", MAIL_FROM: "noreply@example.test" });
    const svc = mkAuth({}, createResetMailPort({ mailConfig: mailOn, queue, sealKey: randomBytes(32).toString("hex") }));
    const fx = await mkTenant();
    const u = await mkMember(fx.tenant, "PICKER");
    const ask = (email: string): Promise<Response> =>
      svc.handler(
        new Request(`${BASE}/api/auth/request-password-reset`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": nextIp(), "user-agent": "t117b-int" },
          body: JSON.stringify({ email }),
        }),
      );
    const known = await ask(u.email);
    const unknownRes = await ask(rndEmail());
    expect(known.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    const kb = await known.text();
    expect(kb).toBe(await unknownRes.text());
    expect(kb).not.toMatch(/reset-password|token/i);
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as { type: string; payload: { template: string; sealed: Record<string, unknown> } };
    expect(job.type).toBe("email.send");
    expect(job.payload.template).toBe("password_reset");
    const text = JSON.stringify(job);
    expect(text).not.toContain(u.email);
    expect(text).not.toContain("reset-password");
    expect(Object.keys(job.payload.sealed).sort()).toEqual(["ct", "iv", "kid", "tag", "v"]);
    // Teslim edilemeyen alıcı/kapalı posta: tekdüze 503 (UI "yöneticinden iste" der), iş yok.
    const off = mkAuth({}, createResetMailPort({ mailConfig: loadMailConfig({}), queue, sealKey: randomBytes(32).toString("hex") }));
    const r = await off.handler(
      new Request(`${BASE}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": nextIp(), "user-agent": "t117b-int" },
        body: JSON.stringify({ email: u.email }),
      }),
    );
    expect(r.status).toBe(503);
    expect(jobs).toHaveLength(1);
  });
});
