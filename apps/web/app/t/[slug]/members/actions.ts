"use server";
// Üye davet (T-117) ve üyelik (T-117b) eylemleri. İnce giriş: doğrulama + sarmalayıcı `guardedAction`; iş kuralı
// `@wms/domain`. Tenant erişimi yalnızca domain komutları (`runTenantCommand`) üzerinden; bu dosyada DB bağlantısı açılmaz.
import { z } from "zod";
import { createPasswordResetToken, discardPasswordResetToken, ensureRecentAuth, recordPasswordResetLinkIssued } from "@wms/auth";
import {
  changeRole,
  issuePasswordResetLink,
  leaveTenant,
  removeMember,
  transferOwnership,
  type MembershipDeps,
} from "@wms/domain/identity/memberships";
import { inviteMember, revokeInvitation, type InvitationDeps } from "@wms/domain/identity/invitations";
import { ROLE_KEYS } from "@wms/domain/identity/permissions";
import { loadMailConfig } from "@wms/shared/mailer";
import { getAppDb } from "@wms/db";
import { headers } from "next/headers";
import { createProductionGuard, limitVerifiedTenant } from "../../../../lib/action-guard.ts";
import { getSenderQueue } from "../../../../lib/queue.ts";

const slugSchema = z.string().min(1).max(63);

const inviteSchema = z.object({ slug: slugSchema, email: z.string().min(3).max(254), roleKey: z.enum(ROLE_KEYS) }).strict();
const revokeSchema = z.object({ slug: slugSchema, invitationId: z.string().uuid() }).strict();

/** Kuyruk yoksa `inviteMember` A-42 geri dönüşüne düşer (ekranda bağlantı + `screenReason`); varsayılan yol EMAIL. */
const unavailableQueue: InvitationDeps["queue"] = {
  enqueue: () => Promise.reject(new Error("job queue is not available in the web process")),
};

const logInvitation: NonNullable<InvitationDeps["log"]> = (entry) => {
  console.error(JSON.stringify(entry));
};

const guardedAction = createProductionGuard(() => headers());

export async function inviteMemberAction(raw: unknown) {
  return guardedAction({ schema: inviteSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    await limitVerifiedTenant({ db: getAppDb(), principal, tenantSlug: input.slug, permission: "users.manage" }, ctx);
    const senderQueue = await getSenderQueue(); // transaction dışında başlatılır
    const result = await inviteMember(
      {
        db: getAppDb(),
        principal,
        tenantSlug: input.slug,
        email: input.email,
        roleKey: input.roleKey,
        requestId: ctx.requestId,
      },
      { mailConfig: loadMailConfig(process.env), queue: senderQueue ?? unavailableQueue, log: logInvitation },
    );
    return {
      invitationId: result.invitationId,
      expiresAt: result.expiresAt.toISOString(),
      delivery: result.delivery,
      ...(result.screenReason === undefined ? {} : { screenReason: result.screenReason }),
      // Düz bağlantı yalnızca bu yanıtta, yalnızca daveti oluşturan yöneticiye (A-42).
      ...(result.token === undefined ? {} : { inviteLink: `${ctx.origin}/invite/${result.token}` }),
    };
  })(raw);
}

export async function revokeInvitationAction(raw: unknown) {
  return guardedAction({ schema: revokeSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    await limitVerifiedTenant({ db: getAppDb(), principal, tenantSlug: input.slug, permission: "users.manage" }, ctx);
    await revokeInvitation({
      db: getAppDb(),
      principal,
      tenantSlug: input.slug,
      invitationId: input.invitationId,
      requestId: ctx.requestId,
    });
    return { revoked: true as const };
  })(raw);
}

// ---------------------------------------------------------------------------------------------
// Üyelik eylemleri (T-117b)
// ---------------------------------------------------------------------------------------------

const changeRoleSchema = z.object({ slug: slugSchema, memberId: z.string().uuid(), roleKey: z.enum(ROLE_KEYS) }).strict();
const memberSchema = z.object({ slug: slugSchema, memberId: z.string().uuid() }).strict();
const leaveSchema = z.object({ slug: slugSchema }).strict();
const transferSchema = z.object({ slug: slugSchema, toMemberId: z.string().uuid() }).strict();

function membershipDeps(): MembershipDeps {
  return { demoEmailDomain: process.env.DEMO_EMAIL_DOMAIN?.trim().toLowerCase() || null };
}

export async function changeRoleAction(raw: unknown) {
  return guardedAction({ schema: changeRoleSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const result = await changeRole(
      { db: getAppDb(), principal, tenantSlug: input.slug, memberId: input.memberId, roleKey: input.roleKey, requestId: ctx.requestId },
      membershipDeps(),
    );
    return { membershipId: result.membershipId, roleKey: result.roleKey, changed: result.changed };
  })(raw);
}

export async function removeMemberAction(raw: unknown) {
  return guardedAction({ schema: memberSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const result = await removeMember(
      { db: getAppDb(), principal, tenantSlug: input.slug, memberId: input.memberId, requestId: ctx.requestId },
      membershipDeps(),
    );
    return { membershipId: result.membershipId };
  })(raw);
}

export async function leaveTenantAction(raw: unknown) {
  return guardedAction({ schema: leaveSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const result = await leaveTenant({ db: getAppDb(), principal, tenantSlug: input.slug, requestId: ctx.requestId });
    return { membershipId: result.membershipId };
  })(raw);
}

export async function transferOwnershipAction(raw: unknown) {
  return guardedAction({ schema: transferSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const result = await transferOwnership(
      { db: getAppDb(), principal, tenantSlug: input.slug, toMemberId: input.toMemberId, requestId: ctx.requestId },
      membershipDeps(),
    );
    return { fromMembershipId: result.fromMembershipId, toMembershipId: result.toMembershipId };
  })(raw);
}

/** Yönetici kaynaklı sıfırlama bağlantısı (B1): bağlantı yalnızca bu yanıtta, yalnızca yöneticiye döner (A-42). */
export async function issuePasswordResetLinkAction(raw: unknown) {
  return guardedAction({ schema: memberSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const requestHeaders = await headers();
    const result = await issuePasswordResetLink(
      {
        db: getAppDb(),
        principal,
        tenantSlug: input.slug,
        memberId: input.memberId,
        requestId: ctx.requestId,
        // Yeniden doğrulama penceresi (A-39); transaction DIŞINDA çağrılır (access.ts).
        recentAuth: () => ensureRecentAuth(requestHeaders),
      },
      {
        ...membershipDeps(),
        port: {
          createToken: createPasswordResetToken,
          discardToken: discardPasswordResetToken,
          recordIssued: recordPasswordResetLinkIssued,
        },
        log: logInvitation,
      },
    );
    // Better Auth `GET /reset-password/:token?callbackURL=` belirteci geri çağrı adresine taşır.
    const link = `${ctx.origin}/api/auth/reset-password/${result.token}?callbackURL=${encodeURIComponent("/reset-password")}`;
    return { resetLink: link, expiresAt: result.expiresAt.toISOString() };
  })(raw);
}
