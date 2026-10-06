// T-117b: üyelik komutları (ADR-016 §5, §8, §10; A-45; AC-18). Gerçek wms_app / wms_auth bağlantıları + RLS. Fikstürler
// sentetik (G-09); parolalar çalışma anında üretilir. Migration rolü yalnızca kurulum/doğrulama içindir. Audit append-only
// olduğundan audit yazan tenant/kullanıcılar silinmez (kısa ömürlü ortam).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { createAuth, readAuthEnv, type AuthService } from "../../../packages/auth/src/index.ts";
import { hashPassword } from "../../../packages/auth/src/password.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { runTenantCommand, runTenantCommandById } from "../../../packages/domain/src/identity/access.ts";
import {
  MembershipDenied,
  changeRole,
  leaveTenant,
  removeMember,
  transferOwnership,
  type DenyReason,
  type MembershipDeps,
} from "../../../packages/domain/src/identity/memberships.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];
const BASE = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const PASSWORD = `P${randomBytes(12).toString("hex")}`;
const DEMO_DOMAIN = "demo-t117b.example.invalid";
const deps: MembershipDeps = { demoEmailDomain: DEMO_DOMAIN };

let app: DbClient;
let authClient: DbClient;
let auth: AuthService;
let adm: pg.Client;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  authClient = createDbClient({ url: authUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  auth = createAuth({
    client: authClient,
    env: readAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DATABASE_URL: env.databaseUrl, AUTH_DATABASE_URL: authUrl }),
  });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
}, 120_000);

afterAll(async () => {
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
}
const rndEmail = (domain = "example.test"): string => `t117b-${randomBytes(6).toString("hex")}@${domain}`;
async function mkUser(email = rndEmail(), withPassword = false): Promise<{ id: string; email: string }> {
  const r = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T117b fixture', $1, true) RETURNING id", [email]);
  const id = (r.rows[0] as { id: string }).id;
  if (withPassword) {
    await adm.query("INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1::text, 'credential', $1::uuid, $2)", [id, await hashPassword(PASSWORD)]);
  }
  return { id, email };
}
async function mkMember(tenant: string, role: string, opts: { owner?: boolean; email?: string; withPassword?: boolean } = {}): Promise<Member> {
  const u = await mkUser(opts.email ?? rndEmail(), opts.withPassword ?? false);
  const m = await adm.query<{ id: string }>(
    "INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id",
    [tenant, u.id, opts.owner ?? false],
  );
  const membershipId = (m.rows[0] as { id: string }).id;
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, membershipId, role]);
  return { userId: u.id, membershipId, email: u.email };
}
async function mkTenant(opts: { demo?: boolean } = {}): Promise<Fx> {
  const tenant = randomUUID();
  const slug = `t117b-${randomBytes(6).toString("hex")}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T117b', $3)", [tenant, slug, opts.demo ?? false]);
  const owner = await mkMember(tenant, "TENANT_ADMIN", { owner: true });
  return { tenant, slug, owner };
}
const principalOf = (m: Member) => ({ userId: m.userId, mfaVerified: true });
const access = (fx: Fx, actor: Member) => ({ db: app, principal: principalOf(actor), tenantSlug: fx.slug });

async function row(membershipId: string): Promise<{ status: string; is_owner: boolean; roles_version: number; roles: string[] }> {
  const m = await adm.query("SELECT status, is_owner, roles_version FROM public.tenant_memberships WHERE id = $1", [membershipId]);
  const r = await adm.query("SELECT role_key FROM public.membership_roles WHERE membership_id = $1 ORDER BY role_key", [membershipId]);
  return { ...m.rows[0], roles: r.rows.map((x: { role_key: string }) => x.role_key) };
}
async function audits(tenant: string, action: string): Promise<{ entity_id: string; actor_user_id: string; change_summary: Record<string, unknown> }[]> {
  const r = await adm.query("SELECT entity_id, actor_user_id, change_summary FROM public.audit_logs WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at", [tenant, action]);
  return r.rows;
}
async function expectDenied(p: Promise<unknown>, reason?: DenyReason): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ code: "FORBIDDEN" });
  if (reason !== undefined) {
    expect((err as AppError).cause).toBeInstanceOf(MembershipDenied);
    expect(((err as AppError).cause as MembershipDenied).reason).toBe(reason);
  }
  expect(JSON.stringify((err as AppError).toBody())).not.toMatch(/LAST_OWNER|IDENTITY_SHARED|DEMO|OWNER_ROLE/);
}

// ---------------------------------------------------------------------------------------------
describe("changeRole", () => {
  it("yönetici rolü değiştirir: rol satırı, roles_version artar, audit aynı transaction'da", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const before = await row(target.membershipId);
    const res = await changeRole({ ...access(fx, fx.owner), memberId: target.membershipId, roleKey: "COUNTER" }, deps);
    expect(res).toEqual({ membershipId: target.membershipId, roleKey: "COUNTER", changed: true });
    const after = await row(target.membershipId);
    expect(after.roles).toEqual(["COUNTER"]);
    expect(after.roles_version).toBe(before.roles_version + 1);
    const a = await audits(fx.tenant, "member.role_changed");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ entity_id: target.membershipId, actor_user_id: fx.owner.userId, change_summary: { from_role: "PICKER", to_role: "COUNTER" } });
  });

  it("aynı rol istenirse yazma ve audit yok", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const before = await row(target.membershipId);
    const res = await changeRole({ ...access(fx, fx.owner), memberId: target.membershipId, roleKey: "PICKER" }, deps);
    expect(res.changed).toBe(false);
    expect((await row(target.membershipId)).roles_version).toBe(before.roles_version);
    expect(await audits(fx.tenant, "member.role_changed")).toHaveLength(0);
  });

  it("izinsiz (users.manage yok) çağıran FORBIDDEN; hiçbir şey değişmez", async () => {
    const fx = await mkTenant();
    const wm = await mkMember(fx.tenant, "WAREHOUSE_MANAGER");
    const target = await mkMember(fx.tenant, "PICKER");
    await expectDenied(changeRole({ ...access(fx, wm), memberId: target.membershipId, roleKey: "READ_ONLY" }, deps));
    expect((await row(target.membershipId)).roles).toEqual(["PICKER"]);
    expect(await audits(fx.tenant, "member.role_changed")).toHaveLength(0);
  });

  it("başka tenant'ın üyeliği NOT_FOUND (RLS: varlık sızdırılmaz)", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const foreign = await mkMember(b.tenant, "PICKER");
    await expect(changeRole({ ...access(a, a.owner), memberId: foreign.membershipId, roleKey: "COUNTER" }, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await row(foreign.membershipId)).roles).toEqual(["PICKER"]);
  });

  it("son sahibin rolü düşürülemez (rolsüz/yöneticisiz bırakma yok)", async () => {
    const fx = await mkTenant();
    const second = await mkMember(fx.tenant, "TENANT_ADMIN"); // sahip değil
    await expectDenied(changeRole({ ...access(fx, second), memberId: fx.owner.membershipId, roleKey: "READ_ONLY" }, deps), "LAST_OWNER");
    expect((await row(fx.owner.membershipId)).roles).toEqual(["TENANT_ADMIN"]);
  });

  it("son yönetici yöneticilikten düşürülemez; başka yönetici varken kendini düşürmek serbest", async () => {
    const fx = await mkTenant();
    const second = await mkMember(fx.tenant, "TENANT_ADMIN");
    // Sahip dışında yönetici var → sahip (kendi) rolünü düşüremez (sahibin rolü TENANT_ADMIN kalır).
    await expectDenied(changeRole({ ...access(fx, fx.owner), memberId: fx.owner.membershipId, roleKey: "WAREHOUSE_MANAGER" }, deps), "LAST_OWNER");
    // Sahip olmayan yönetici kendini düşürebilir (sahip yönetici olarak kalır).
    const ok = await changeRole({ ...access(fx, second), memberId: second.membershipId, roleKey: "WAREHOUSE_MANAGER" }, deps);
    expect(ok.changed).toBe(true);
    // Artık yalnızca sahip yönetici: sahip, devirsiz düşürülemez.
    await expectDenied(changeRole({ ...access(fx, fx.owner), memberId: fx.owner.membershipId, roleKey: "READ_ONLY" }, deps), "LAST_OWNER");
  });

  it("sahip olmayan yöneticiyi yükselt/düşür; roles_version her seferinde artar", async () => {
    const fx = await mkTenant();
    const t = await mkMember(fx.tenant, "READ_ONLY");
    const v0 = (await row(t.membershipId)).roles_version;
    await changeRole({ ...access(fx, fx.owner), memberId: t.membershipId, roleKey: "TENANT_ADMIN" }, deps);
    await changeRole({ ...access(fx, fx.owner), memberId: t.membershipId, roleKey: "PICKER" }, deps);
    const r = await row(t.membershipId);
    expect(r.roles).toEqual(["PICKER"]);
    expect(r.roles_version).toBe(v0 + 2);
  });
});

describe("removeMember / leaveTenant / AC-18", () => {
  it("çıkarma: REMOVED + audit; oturumlar silinmez ama sonraki yazma FORBIDDEN (AC-18)", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER", { withPassword: true });
    const login = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": "192.0.2.10", "user-agent": "t117b" },
        body: JSON.stringify({ email: target.email, password: PASSWORD }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((l) => l.split(";")[0] ?? "").join("; ");
    const headers = new Headers({ cookie, "fly-client-ip": "192.0.2.10" });
    expect((await auth.getPrincipal(headers))?.userId).toBe(target.userId);
    // Çıkarmadan önce yazabilir.
    await expect(runTenantCommand({ ...access(fx, target), permission: "stock.post" }, () => Promise.resolve("ok"))).resolves.toBe("ok");

    const res = await removeMember({ ...access(fx, fx.owner), memberId: target.membershipId }, deps);
    expect(res.membershipId).toBe(target.membershipId);
    const r = await row(target.membershipId);
    expect(r.status).toBe("REMOVED");
    expect(r.is_owner).toBe(false);
    const removed = await adm.query("SELECT removed_at FROM public.tenant_memberships WHERE id = $1", [target.membershipId]);
    expect(removed.rows[0].removed_at).not.toBeNull();
    expect(await audits(fx.tenant, "member.removed")).toHaveLength(1);

    // Çıkarma oturumları silmez (ADR-014 §3) ...
    const sessions = await adm.query("SELECT count(*)::int AS n FROM public.sessions WHERE user_id = $1", [target.userId]);
    expect(sessions.rows[0].n).toBe(1);
    expect((await auth.getPrincipal(headers))?.userId).toBe(target.userId);
    // ... ama eski oturumla her yazma/okuma reddedilir.
    // Tenant kimliği önceden çözülmüş eski bağlam (AC-18): withMembership FORBIDDEN verir.
    await expectDenied(
      runTenantCommandById({ db: app, principal: principalOf(target), tenantId: fx.tenant, permission: "stock.post" }, () => Promise.resolve("ok")),
    );
    // Slug yolu: üye olmayan tenant'ın varlığı sızdırılmaz.
    await expect(runTenantCommand({ ...access(fx, target), permission: "stock.view" }, () => Promise.resolve("ok"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("kendini removeMember ile çıkarma VALIDATION_FAILED (ayrılma için leaveTenant)", async () => {
    const fx = await mkTenant();
    const second = await mkMember(fx.tenant, "TENANT_ADMIN");
    await expect(removeMember({ ...access(fx, second), memberId: second.membershipId }, deps)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("son sahip çıkarılamaz ve ayrılamaz", async () => {
    const fx = await mkTenant();
    const second = await mkMember(fx.tenant, "TENANT_ADMIN");
    await expectDenied(removeMember({ ...access(fx, second), memberId: fx.owner.membershipId }, deps), "LAST_OWNER");
    await expectDenied(leaveTenant(access(fx, fx.owner)), "LAST_OWNER");
    expect((await row(fx.owner.membershipId)).status).toBe("ACTIVE");
    expect(await audits(fx.tenant, "member.removed")).toHaveLength(0);
    expect(await audits(fx.tenant, "member.left")).toHaveLength(0);
  });

  it("ikinci sahip varken sahip ayrılabilir; kalan tek sahip ayrılamaz", async () => {
    const fx = await mkTenant();
    const second = await mkMember(fx.tenant, "TENANT_ADMIN", { owner: true });
    await expect(leaveTenant(access(fx, fx.owner))).resolves.toMatchObject({ membershipId: fx.owner.membershipId });
    expect((await row(fx.owner.membershipId)).status).toBe("REMOVED");
    // Geriye kalan tek sahip artık ayrılamaz.
    await expectDenied(leaveTenant(access(fx, second)), "LAST_OWNER");
    const left = await audits(fx.tenant, "member.left");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ entity_id: fx.owner.membershipId, actor_user_id: fx.owner.userId });
  });

  it("yönetici olmayan üye ayrılabilir; ayrıldıktan sonra tenant'a erişemez", async () => {
    const fx = await mkTenant();
    const m = await mkMember(fx.tenant, "READ_ONLY");
    await leaveTenant(access(fx, m));
    expect((await row(m.membershipId)).status).toBe("REMOVED");
    await expect(runTenantCommand({ ...access(fx, m), permission: "stock.view" }, () => Promise.resolve(1))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("izinsiz çağıran removeMember yapamaz", async () => {
    const fx = await mkTenant();
    const wm = await mkMember(fx.tenant, "WAREHOUSE_MANAGER");
    const t = await mkMember(fx.tenant, "PICKER");
    await expectDenied(removeMember({ ...access(fx, wm), memberId: t.membershipId }, deps));
    expect((await row(t.membershipId)).status).toBe("ACTIVE");
  });

  it("eşzamanlı iki 'son sahip ayrılması'ndan en fazla biri başarılı; tenant sahipsiz kalmaz", async () => {
    for (let round = 0; round < 3; round += 1) {
      const fx = await mkTenant();
      const b = await mkMember(fx.tenant, "TENANT_ADMIN", { owner: true });
      const results = await Promise.allSettled([leaveTenant(access(fx, fx.owner)), leaveTenant(access(fx, b))]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      expect(ok).toBeLessThanOrEqual(1);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toBeInstanceOf(AppError);
          expect(["FORBIDDEN", "VERSION_CONFLICT"]).toContain((r.reason as AppError).code);
        }
      }
      const owners = await adm.query("SELECT count(*)::int AS n FROM public.tenant_memberships WHERE tenant_id = $1 AND is_owner AND status = 'ACTIVE'", [fx.tenant]);
      expect(owners.rows[0].n).toBeGreaterThanOrEqual(1);
    }
  }, 60_000);
});

describe("transferOwnership", () => {
  it("devir: hedef sahip + TENANT_ADMIN, çağıran sahipliği bırakır; her an en az bir sahip; audit", async () => {
    const fx = await mkTenant();
    const target = await mkMember(fx.tenant, "PICKER");
    const v0 = await row(fx.owner.membershipId);
    const res = await transferOwnership({ ...access(fx, fx.owner), toMemberId: target.membershipId }, deps);
    expect(res).toEqual({ fromMembershipId: fx.owner.membershipId, toMembershipId: target.membershipId });
    const t = await row(target.membershipId);
    expect(t).toMatchObject({ is_owner: true, roles: ["TENANT_ADMIN"] });
    const o = await row(fx.owner.membershipId);
    expect(o.is_owner).toBe(false);
    expect(o.roles).toEqual(["TENANT_ADMIN"]);
    expect(o.roles_version).toBe(v0.roles_version + 1);
    const a = await audits(fx.tenant, "ownership.transferred");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ entity_id: target.membershipId, actor_user_id: fx.owner.userId });
    // Eski sahip artık ayrılabilir (yeni sahip var).
    await expect(leaveTenant(access(fx, fx.owner))).resolves.toBeDefined();
  });

  it("sahip olmayan yönetici devredemez; hedef kendisi olamaz", async () => {
    const fx = await mkTenant();
    const admin2 = await mkMember(fx.tenant, "TENANT_ADMIN");
    await expectDenied(transferOwnership({ ...access(fx, admin2), toMemberId: admin2.membershipId }, deps), "NOT_OWNER");
    await expect(transferOwnership({ ...access(fx, fx.owner), toMemberId: fx.owner.membershipId }, deps)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await row(fx.owner.membershipId)).is_owner).toBe(true);
    expect(await audits(fx.tenant, "ownership.transferred")).toHaveLength(0);
  });

  it("izinsiz çağıran devredemez; REMOVED hedef NOT_FOUND", async () => {
    const fx = await mkTenant();
    const wm = await mkMember(fx.tenant, "WAREHOUSE_MANAGER");
    await expectDenied(transferOwnership({ ...access(fx, wm), toMemberId: wm.membershipId }, deps));
    const gone = await mkMember(fx.tenant, "PICKER");
    await adm.query("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = $1", [gone.membershipId]);
    await expect(transferOwnership({ ...access(fx, fx.owner), toMemberId: gone.membershipId }, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("demo korumaları (M9)", () => {
  it("demo tenant'ta TÜM üyelik komutları FORBIDDEN (davet dahil T-117)", async () => {
    const fx = await mkTenant({ demo: true });
    const t = await mkMember(fx.tenant, "PICKER");
    const second = await mkMember(fx.tenant, "TENANT_ADMIN", { owner: true });
    await expectDenied(changeRole({ ...access(fx, fx.owner), memberId: t.membershipId, roleKey: "COUNTER" }, deps), "DEMO");
    await expectDenied(removeMember({ ...access(fx, fx.owner), memberId: t.membershipId }, deps), "DEMO");
    await expectDenied(transferOwnership({ ...access(fx, fx.owner), toMemberId: second.membershipId }, deps), "DEMO");
    await expectDenied(leaveTenant(access(fx, t)), "DEMO");
    expect((await row(t.membershipId)).status).toBe("ACTIVE");
    expect((await row(t.membershipId)).roles).toEqual(["PICKER"]);
  });

  it("demo kullanıcısı üzerinde rol / çıkarma / devir FORBIDDEN (is_demo olmayan tenant)", async () => {
    const fx = await mkTenant();
    const demoUser = await mkMember(fx.tenant, "TENANT_ADMIN", { email: rndEmail(DEMO_DOMAIN) });
    await expectDenied(changeRole({ ...access(fx, fx.owner), memberId: demoUser.membershipId, roleKey: "READ_ONLY" }, deps), "DEMO");
    await expectDenied(removeMember({ ...access(fx, fx.owner), memberId: demoUser.membershipId }, deps), "DEMO");
    await expectDenied(transferOwnership({ ...access(fx, fx.owner), toMemberId: demoUser.membershipId }, deps), "DEMO");
    const r = await row(demoUser.membershipId);
    expect(r).toMatchObject({ status: "ACTIVE", is_owner: false, roles: ["TENANT_ADMIN"] });
    // Demo alan adı tanımsızsa e-posta tabanlı kısıt yok (yalnızca is_demo tenant kısıtı).
    await expect(changeRole({ ...access(fx, fx.owner), memberId: demoUser.membershipId, roleKey: "READ_ONLY" }, { demoEmailDomain: null })).resolves.toMatchObject({ changed: true });
  });
});
