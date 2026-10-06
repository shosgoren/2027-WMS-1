// İki tenantlı sentetik fikstür (T-104, qa-verifier). YALNIZCA TEST; üretim şeması/migration değildir.
//
// Migration rolüyle (DATABASE_URL_DIRECT) kurulur: süper kullanıcı RLS'i aşar (Neon'da sahip rol BYPASSRLS gerektirir).
// Her dünya (world): 1 tenant + sahip kullanıcı/üyelik (TENANT_ADMIN) + ikinci üye (PICKER) + 1 davet + tenant_settings.
// Tohum tamamen sentetiktir (G-09): rastgele UUID, `@example.test` e-posta, rastgele slug/token özeti.
// Temizlik FK sırasıyla yapılır; `security_events` append-only olduğundan fikstür oraya satır bırakmaz.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

export interface TenantWorld {
  label: string;
  tenantId: string;
  slug: string;
  ownerUserId: string;
  ownerMembershipId: string;
  memberUserId: string;
  memberMembershipId: string;
  invitationId: string;
}

export interface WorldRegistry {
  worlds: TenantWorld[];
  /** Dünyaya ait olmayan, ayrıca kurulan kullanıcılar (ör. çok-tenantlı kullanıcı). */
  extraUsers: string[];
}

export function newRegistry(): WorldRegistry {
  return { worlds: [], extraUsers: [] };
}

function hex(n: number): string {
  return randomBytes(n).toString("hex");
}

export async function mkUser(c: pg.Client, reg: WorldRegistry, tag: string): Promise<string> {
  const r = await c.query<{ id: string }>("INSERT INTO public.users (name, email) VALUES ($1, $2) RETURNING id", [
    `T104 ${tag}`,
    `t104-${hex(6)}@example.test`,
  ]);
  const id = (r.rows[0] as { id: string }).id;
  reg.extraUsers.push(id);
  return id;
}

export async function mkMembership(
  c: pg.Client,
  tenantId: string,
  userId: string,
  opts: { isOwner?: boolean; roles: string[] },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    "INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id",
    [tenantId, userId, opts.isOwner ?? false],
  );
  const id = (r.rows[0] as { id: string }).id;
  for (const role of opts.roles) {
    await c.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [
      tenantId,
      id,
      role,
    ]);
  }
  return id;
}

/** Bir tenant dünyası kurar (tek transaction değil; her ifade migration rolünün otomatik commit'i). */
export async function seedWorld(
  c: pg.Client,
  reg: WorldRegistry,
  label: string,
  opts: { status?: "ACTIVE" | "SUSPENDED" | "CLOSING" } = {},
): Promise<TenantWorld> {
  const tenantId = randomUUID();
  const slug = `t104-${label.toLowerCase()}-${hex(5)}`;
  const ownerUserId = await mkUser(c, reg, `${label} owner`);
  const memberUserId = await mkUser(c, reg, `${label} member`);
  await c.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, $4)", [
    tenantId,
    slug,
    `T104 Tenant ${label}`,
    opts.status ?? "ACTIVE",
  ]);
  const ownerMembershipId = await mkMembership(c, tenantId, ownerUserId, { isOwner: true, roles: ["TENANT_ADMIN"] });
  const memberMembershipId = await mkMembership(c, tenantId, memberUserId, { roles: ["PICKER"] });
  const invitationId = randomUUID();
  await c.query(
    `INSERT INTO public.invitations
       (tenant_id, id, email_normalized, role_key, token_hash, delivered_via, expires_at, invited_by_membership_id)
     VALUES ($1, $2, $3, 'PICKER', $4, 'SCREEN', now() + interval '1 day', $5)`,
    [tenantId, invitationId, `t104-inv-${hex(6)}@example.test`, createHash("sha256").update(hex(16)).digest("hex"), ownerMembershipId],
  );
  await c.query(
    `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status)
     VALUES ($1, 'tr-TR', 'Europe/Istanbul', 'PENDING')`,
    [tenantId],
  );
  const world: TenantWorld = {
    label,
    tenantId,
    slug,
    ownerUserId,
    ownerMembershipId,
    memberUserId,
    memberMembershipId,
    invitationId,
  };
  reg.worlds.push(world);
  return world;
}

/** Fikstür satırlarını siler (FK sırası: davet → rol → üyelik → ayar → tenant → kullanıcı). Hataları yutmaz. */
export async function cleanupRegistry(c: pg.Client, reg: WorldRegistry): Promise<void> {
  const tenantIds = reg.worlds.map((w) => w.tenantId);
  const userIds = [...reg.worlds.flatMap((w) => [w.ownerUserId, w.memberUserId]), ...reg.extraUsers];
  if (tenantIds.length > 0) {
    await c.query("DELETE FROM public.invitations WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.membership_roles WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.tenant_memberships WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.tenant_settings WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [tenantIds]);
  }
  if (userIds.length > 0) {
    await c.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [userIds]);
  }
  reg.worlds.length = 0;
  reg.extraUsers.length = 0;
}
