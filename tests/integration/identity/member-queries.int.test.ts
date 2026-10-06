// T-119a: üyeler ekranı salt okunur sorguları. Gerçek wms_app bağlantısı + RLS. Fikstürler sentetik (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { getMembershipSummary, listMembers, listPendingInvitations } from "../../../packages/domain/src/identity/member-queries.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const DEMO_DOMAIN = "demo-t119a.example.invalid";
const deps = { demoEmailDomain: DEMO_DOMAIN };

let app: DbClient;
let adm: pg.Client;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

interface Member {
  userId: string;
  membershipId: string;
  email: string;
  name: string;
}
interface Fx {
  tenant: string;
  slug: string;
  owner: Member;
}
const rnd = (): string => randomBytes(6).toString("hex");
async function mkMember(tenant: string, role: string, opts: { owner?: boolean; email?: string; userId?: string; name?: string } = {}): Promise<Member> {
  const email = opts.email ?? `t119a-${rnd()}@example.test`;
  const name = opts.name ?? `T119a ${rnd()}`;
  let userId = opts.userId;
  if (userId === undefined) {
    const r = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ($1, $2, true) RETURNING id", [name, email]);
    userId = (r.rows[0] as { id: string }).id;
  }
  const m = await adm.query<{ id: string }>(
    "INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id",
    [tenant, userId, opts.owner ?? false],
  );
  const membershipId = (m.rows[0] as { id: string }).id;
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, membershipId, role]);
  return { userId, membershipId, email, name };
}
async function mkTenant(opts: { demo?: boolean; name?: string } = {}): Promise<Fx> {
  const tenant = randomUUID();
  const slug = `t119a-${rnd()}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, $3, $4)", [tenant, slug, opts.name ?? "T119a", opts.demo ?? false]);
  const owner = await mkMember(tenant, "TENANT_ADMIN", { owner: true });
  return { tenant, slug, owner };
}
async function mkInvite(fx: Fx, by: Member, email: string, over: { expires?: string; accepted?: boolean; revoked?: boolean } = {}): Promise<string> {
  const r = await adm.query<{ id: string }>(
    `INSERT INTO public.invitations (tenant_id, email_normalized, role_key, token_hash, delivered_via, expires_at, accepted_at, revoked_at, invited_by_membership_id)
     VALUES ($1, $2, 'PICKER', $3, 'SCREEN', ${over.expires ?? "now() + interval '1 day'"}, ${over.accepted === true ? "now()" : "NULL"}, ${over.revoked === true ? "now()" : "NULL"}, $4) RETURNING id`,
    [fx.tenant, email, randomBytes(32).toString("hex"), by.membershipId],
  );
  return (r.rows[0] as { id: string }).id;
}
const acc = (fx: Fx, actor: Member) => ({ db: app, principal: { userId: actor.userId, mfaVerified: true }, tenantSlug: fx.slug });

describe("listMembers", () => {
  it("başka tenant üyesi sızmaz; satır şekli ve roller doğru", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const p = await mkMember(a.tenant, "PICKER");
    const foreign = await mkMember(b.tenant, "PICKER");
    const rows = await listMembers(acc(a, a.owner), deps);
    expect(rows.map((r) => r.userId).sort()).toEqual([a.owner.userId, p.userId].sort());
    expect(rows.some((r) => r.userId === foreign.userId)).toBe(false);
    const pr = rows.find((r) => r.userId === p.userId);
    expect(pr).toMatchObject({ displayName: p.name, email: p.email, roles: ["PICKER"], isOwner: false, status: "ACTIVE", isDemo: false, resetLinkAvailable: true });
    expect(rows.find((r) => r.userId === a.owner.userId)).toMatchObject({ isOwner: true, resetLinkAvailable: false });
  });

  it("resetLinkAvailable: paylaşılan kimlik, demo hedef, sahip ve kendisi için false", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const solo = await mkMember(a.tenant, "PICKER");
    const shared = await mkMember(a.tenant, "COUNTER");
    await mkMember(b.tenant, "READ_ONLY", { userId: shared.userId });
    const demo = await mkMember(a.tenant, "READ_ONLY", { email: `x-${rnd()}@${DEMO_DOMAIN}` });
    const rows = await listMembers(acc(a, a.owner), deps);
    const by = (m: Member) => rows.find((r) => r.userId === m.userId);
    expect(by(solo)?.resetLinkAvailable).toBe(true);
    expect(by(shared)?.resetLinkAvailable).toBe(false);
    expect(by(demo)).toMatchObject({ isDemo: true, resetLinkAvailable: false });
    expect(by(a.owner)?.resetLinkAvailable).toBe(false);
    // Bir yönetici (sahip olmayan) kendi satırında false.
    const adm2 = await mkMember(a.tenant, "TENANT_ADMIN");
    const rows2 = await listMembers(acc(a, adm2), deps);
    expect(rows2.find((r) => r.userId === adm2.userId)?.resetLinkAvailable).toBe(false);
    expect(rows2.find((r) => r.userId === solo.userId)?.resetLinkAvailable).toBe(true);
  });

  it("yetkisiz (users.manage yok) çağıran: resetLinkAvailable hep false, e-posta maskeli", async () => {
    const a = await mkTenant();
    const wm = await mkMember(a.tenant, "WAREHOUSE_MANAGER");
    const t = await mkMember(a.tenant, "PICKER");
    const rows = await listMembers(acc(a, wm), deps);
    expect(rows.every((r) => !r.resetLinkAvailable)).toBe(true);
    const tr = rows.find((r) => r.userId === t.userId);
    expect(tr?.email).not.toBe(t.email);
    expect(tr?.email).toMatch(/^.{1,2}\*\*\*@example\.test$/);
  });

  it("demo tenant'ta resetLinkAvailable false; üye olmayan çağıran NOT_FOUND", async () => {
    const d = await mkTenant({ demo: true });
    const t = await mkMember(d.tenant, "PICKER");
    const rows = await listMembers(acc(d, d.owner), deps);
    expect(rows.find((r) => r.userId === t.userId)?.resetLinkAvailable).toBe(false);
    const other = await mkTenant();
    await expect(listMembers({ db: app, principal: { userId: other.owner.userId, mfaVerified: true }, tenantSlug: d.slug }, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listPendingInvitations", () => {
  it("yalnızca bekleyen, süresi dolmamış davetler; başka tenant sızmaz; belirteç alanı yok", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const live = await mkInvite(a, a.owner, `live-${rnd()}@example.test`);
    await mkInvite(a, a.owner, `exp-${rnd()}@example.test`, { expires: "now() - interval '1 hour'" });
    await mkInvite(a, a.owner, `acc-${rnd()}@example.test`, { accepted: true });
    await mkInvite(a, a.owner, `rev-${rnd()}@example.test`, { revoked: true });
    await mkInvite(b, b.owner, `foreign-${rnd()}@example.test`);
    const rows = await listPendingInvitations(acc(a, a.owner));
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({ invitationId: live, role: "PICKER", invitedBy: a.owner.name });
    expect(r?.expiresAt).toBeInstanceOf(Date);
    expect(Object.keys(r ?? {}).sort()).toEqual(["email", "expiresAt", "invitationId", "invitedBy", "role"]);
    expect(JSON.stringify(rows)).not.toMatch(/token|hash|claim/i);
  });

  it("users.manage yoksa FORBIDDEN", async () => {
    const a = await mkTenant();
    const wm = await mkMember(a.tenant, "WAREHOUSE_MANAGER");
    await mkInvite(a, a.owner, `x-${rnd()}@example.test`);
    const err = await listPendingInvitations(acc(a, wm)).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("getMembershipSummary", () => {
  it("yalnızca kendi aktif üyelikleri ve rolleri; başka kullanıcı verisi yok", async () => {
    const a = await mkTenant({ name: "Alfa" });
    const b = await mkTenant({ name: "Beta" });
    const c = await mkTenant({ name: "Gama" });
    const me = await mkMember(a.tenant, "PICKER");
    await mkMember(b.tenant, "TENANT_ADMIN", { userId: me.userId });
    const other = await mkMember(c.tenant, "PICKER");
    // Çıkarılmış üyelik özette yok.
    await adm.query("UPDATE public.tenant_memberships SET status='REMOVED', removed_at=now() WHERE tenant_id=$1 AND user_id=$2", [c.tenant, other.userId]);
    const s = await getMembershipSummary({ db: app, principal: { userId: me.userId, mfaVerified: true } });
    expect(s.userName).toBe(me.name);
    expect(s.memberships).toEqual([
      { slug: a.slug, tenantName: "Alfa", roles: ["PICKER"] },
      { slug: b.slug, tenantName: "Beta", roles: ["TENANT_ADMIN"] },
    ]);
    const so = await getMembershipSummary({ db: app, principal: { userId: other.userId, mfaVerified: true } });
    expect(so.memberships).toEqual([]);
    expect(JSON.stringify(so)).not.toContain(me.email);
  });

  it("askıdaki tenant özetten düşer; kimliksiz çağrı UNAUTHENTICATED", async () => {
    const a = await mkTenant({ name: "Aktif" });
    const s = await mkTenant({ name: "Askida" });
    const me = await mkMember(a.tenant, "READ_ONLY");
    await mkMember(s.tenant, "READ_ONLY", { userId: me.userId });
    await adm.query("UPDATE public.tenants SET status='SUSPENDED' WHERE id=$1", [s.tenant]);
    const r = await getMembershipSummary({ db: app, principal: { userId: me.userId, mfaVerified: false } });
    expect(r.memberships.map((m) => m.slug)).toEqual([a.slug]);
    await expect(getMembershipSummary({ db: app, principal: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
