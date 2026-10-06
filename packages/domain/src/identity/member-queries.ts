// Üyeler ekranı salt okunur sorguları (T-119a; ADR-016 §5, §9; A-42, A-43, A-45). Web tablo erişimi olmadan (T-127a)
// yalnızca bu okuyucuları çağırır. Yazma yok.
//
// - `listMembers` / `listPendingInvitations`: `runTenantQuery` (güncel üyelik + izin, MFA, tenant bağlamı, RLS).
// - Okuma izni (A-61 önerisi, spec'te `users.view` yok): üye listesi için `stock.view` (her rol; tenant üyesi okuyabilir),
//   e-posta yalnızca `users.manage` sahibine tam, diğerlerine maskeli (`a***@alanadi`). Bekleyen davetler (davet edilen
//   kişinin e-postası) yalnızca `users.manage` sahibine açıktır.
// - `resetLinkAvailable`: YALNIZCA `resetLinkPrechecks` (çağıran `users.manage`, tenant demo değil, hedef kendisi/demo/sahip
//   değil); NEDEN dönmez (T-119 2. tur m6). `identity_exclusive_to_tenant` probu BİLEREK çağrılmaz: hedefin `users` satırını
//   `FOR UPDATE` kilitler ve okuma yolunda tenant'lar arası girişi bekletirdi (inceleme MAJOR-1). Paylaşılan kimlik için
//   kesin karar `issuePasswordResetLink`'tedir (IDENTITY_SHARED → nötr FORBIDDEN); bu alan "sunulabilir" ipucudur. Liste yolu
//   `users` satırı kilidi almaz (int testli).
// - `getMembershipSummary`: `withUser` (tenant bağlamı boş; yalnızca kendi ACTIVE üyelikleri + tenant adı/slug). Roller
//   `membership_roles` politikası gereği tenant bağlamı ister; her tenant için `withMembership` (kendi doğrulanmış üyeliği,
//   roller `membership.roles`) kullanılır. Askıda/kapanan tenant `withMembership` ile reddedilir ve özetten düşer.
import { sql } from "drizzle-orm";
import { MembershipError, withMembership, withUser } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery, type AccessDbClient, type AccessPrincipal, type TenantAccessParams } from "./access.ts";
import { isDemoAddress } from "./invitations.ts";
import { hasPermission, type RoleKey } from "./permissions.ts";

export interface MemberQueryDeps {
  /** `DEMO_EMAIL_DOMAIN` (A-43); tanımsız → `null`. `invitations.ts` `isDemoAddress` ile aynı kaynak. */
  readonly demoEmailDomain: string | null;
}

type QueryParams = Omit<TenantAccessParams, "permission" | "recentAuth">;

export interface MemberRow {
  /** `tenant_memberships.id`; üyelik komutları `memberId`/`toMemberId` olarak bunu bekler (userId DEĞİL). */
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  /** `users.manage` sahibine tam; diğerlerine maskeli. */
  readonly email: string;
  readonly roles: readonly RoleKey[];
  readonly isOwner: boolean;
  readonly status: "ACTIVE";
  readonly isDemo: boolean;
  readonly resetLinkAvailable: boolean;
}

export interface PendingInvitationRow {
  readonly invitationId: string;
  readonly email: string;
  readonly role: RoleKey;
  readonly expiresAt: Date;
  readonly invitedBy: string;
}

export interface MembershipSummary {
  readonly userName: string;
  readonly memberships: readonly { readonly slug: string; readonly tenantName: string; readonly roles: readonly RoleKey[] }[];
}

/**
 * Yetkisiz okuyucu için (kesme kod noktasına göredir): yerel kısım <4 kod noktasıysa `***`, aksi halde ilk 2 + `***`;
 * alan adında ilk etiketin ilk harfi + `***`, aradaki tüm etiketler bu tek gruba çöker, yalnızca SON etiket (TLD) açık
 * (`abcd@mail.acme.com.tr` → `ab***@m***.tr`). Noktasız alan adı: ilk harf + `***`. `@` yoksa/boşsa `***`.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = Array.from(email.slice(0, at));
  const labels = email.slice(at + 1).split(".");
  const first = Array.from(labels[0] ?? "")[0] ?? "";
  const tld = labels.length > 1 ? `.${labels[labels.length - 1] ?? ""}` : "";
  return `${local.length < 4 ? "***" : `${local.slice(0, 2).join("")}***`}@${first}***${tld}`;
}

export interface ResetLinkInput {
  readonly callerCanManage: boolean;
  readonly tenantIsDemo: boolean;
  readonly isSelf: boolean;
  readonly isDemoTarget: boolean;
  readonly isOwner: boolean;
}

/** `issuePasswordResetLink` ön koşulları (kilit yok; paylaşılan kimlik denetimi yalnızca komutta). */
export function resetLinkPrechecks(i: ResetLinkInput): boolean {
  return i.callerCanManage && !i.tenantIsDemo && !i.isSelf && !i.isDemoTarget && !i.isOwner;
}

/** Aktif üyeler: ad, e-posta (yetkiye göre), roller, sahiplik, demo, sıfırlama bağlantısı üretilebilirliği. */
export async function listMembers(params: QueryParams, deps: MemberQueryDeps): Promise<MemberRow[]> {
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, actor) => {
    const canManage = hasPermission(actor.roles, "users.manage");
    const tenantRows = await tx.execute<{ is_demo: boolean }>(sql`SELECT is_demo FROM public.tenants WHERE id = ${actor.tenantId}::uuid`);
    const tenantIsDemo = tenantRows[0]?.is_demo !== false; // fail-closed
    const rows = await tx.execute<{ user_id: string; name: string; email: string; is_owner: boolean; id: string }>(
      sql`SELECT m.id, m.user_id, u.name, u.email, m.is_owner
            FROM public.tenant_memberships m
            JOIN public.users u ON u.id = m.user_id
           WHERE m.tenant_id = ${actor.tenantId}::uuid AND m.status = 'ACTIVE'
           ORDER BY u.name, u.email, m.id`,
    );
    const roleRows = await tx.execute<{ membership_id: string; role_key: RoleKey }>(
      sql`SELECT membership_id, role_key FROM public.membership_roles
           WHERE tenant_id = ${actor.tenantId}::uuid ORDER BY role_key`,
    );
    const rolesBy = new Map<string, RoleKey[]>();
    for (const r of roleRows) {
      const list = rolesBy.get(r.membership_id);
      if (list === undefined) rolesBy.set(r.membership_id, [r.role_key]);
      else list.push(r.role_key);
    }
    return rows.map((r) => {
      const isDemo = isDemoAddress(r.email, deps.demoEmailDomain);
      return {
        membershipId: r.id,
        userId: r.user_id,
        displayName: r.name,
        email: canManage ? r.email : maskEmail(r.email),
        roles: rolesBy.get(r.id) ?? [],
        isOwner: r.is_owner,
        status: "ACTIVE" as const,
        isDemo,
        resetLinkAvailable: resetLinkPrechecks({
          callerCanManage: canManage,
          tenantIsDemo,
          isSelf: r.user_id === actor.userId,
          isDemoTarget: isDemo,
          isOwner: r.is_owner,
        }),
      };
    });
  });
}

/** Bekleyen (süresi dolmamış, kabul/iptal edilmemiş) davetler; yalnızca `users.manage`. Belirteç/özet/talep alanları seçilmez. */
export async function listPendingInvitations(params: QueryParams): Promise<PendingInvitationRow[]> {
  return runTenantQuery({ ...params, permission: "users.manage" }, async (tx, actor) => {
    const rows = await tx.execute<{ id: string; email_normalized: string; role_key: RoleKey; expires_at: Date | string; invited_by: string | null }>(
      sql`SELECT i.id, i.email_normalized, i.role_key, i.expires_at, u.name AS invited_by
            FROM public.invitations i
            JOIN public.tenant_memberships im ON im.tenant_id = i.tenant_id AND im.id = i.invited_by_membership_id
            JOIN public.users u ON u.id = im.user_id
           WHERE i.tenant_id = ${actor.tenantId}::uuid
             AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
           ORDER BY i.expires_at, i.id`,
    );
    return rows.map((r) => ({
      invitationId: r.id,
      email: r.email_normalized,
      role: r.role_key,
      expiresAt: r.expires_at instanceof Date ? r.expires_at : new Date(r.expires_at),
      invitedBy: r.invited_by ?? "",
    }));
  });
}

export interface MembershipSummaryParams {
  readonly db: AccessDbClient;
  readonly principal: AccessPrincipal | null | undefined;
}

/** Çağıranın kendi adı ve aktif üyelikleri (tenant değiştirici). Başka kullanıcının verisi yok. */
export async function getMembershipSummary(params: MembershipSummaryParams): Promise<MembershipSummary> {
  const { db, principal } = params;
  if (principal === null || principal === undefined) throw new AppError("UNAUTHENTICATED");
  const userId = principal.userId;
  try {
    const listed = await withUser(db, userId, async (tx) => {
      const me = await tx.execute<{ name: string }>(sql`SELECT name FROM public.users WHERE id = ${userId}::uuid`);
      const tenants = await tx.execute<{ id: string; slug: string; name: string }>(
        sql`SELECT t.id, t.slug, t.name FROM public.tenants t
              JOIN public.tenant_memberships m ON m.tenant_id = t.id
             WHERE m.user_id = ${userId}::uuid AND m.status = 'ACTIVE'
             ORDER BY t.name, t.slug`,
      );
      return { name: me[0]?.name, tenants };
    });
    if (listed.name === undefined) throw new AppError("NOT_FOUND");
    const memberships: { slug: string; tenantName: string; roles: readonly RoleKey[] }[] = [];
    for (const t of listed.tenants) {
      try {
        const roles = await withMembership({ client: db, userId, tenantId: t.id }, (_tx, m) => Promise.resolve(m.roles));
        memberships.push({ slug: t.slug, tenantName: t.name, roles });
      } catch (e) {
        // Askıda/kapanan tenant ya da arada düşen üyelik: özetten çıkar; diğer hatalar yutulmaz.
        if (e instanceof MembershipError && (e.code === "FORBIDDEN" || e.code === "TENANT_SUSPENDED" || e.code === "TENANT_CLOSING")) continue;
        throw e;
      }
    }
    return { userName: listed.name, memberships };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const err = new AppError("INTERNAL");
    err.cause = e;
    throw err;
  }
}
