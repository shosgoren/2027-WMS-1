"use server";
// Üye davet eylemleri (T-117). İnce giriş: doğrulama + sarmalayıcı `guardedAction`; iş kuralı `@wms/domain`.
import { z } from "zod";
import { inviteMember, revokeInvitation, type InvitationDeps } from "@wms/domain/identity/invitations";
import { ROLE_KEYS } from "@wms/domain/identity/permissions";
import { loadMailConfig } from "@wms/shared/mailer";
import { headers } from "next/headers";
import { createProductionGuard, getAppDb } from "../../../../lib/action-guard.ts";

const slugSchema = z.string().min(1).max(63);

const inviteSchema = z.object({ slug: slugSchema, email: z.string().min(3).max(254), roleKey: z.enum(ROLE_KEYS) }).strict();
const revokeSchema = z.object({ slug: slugSchema, invitationId: z.string().uuid() }).strict();

/**
 * İş kuyruğu: web süreci henüz `@wms/queue-adapter`'a bağlı değildir (apps/web/package.json bağımlılığı yok; T-109b
 * kapsamı dışında kaldı). Bu yüzden `enqueue` AÇIKÇA reddeder ve `inviteMember` A-42 geri dönüş yoluna düşer:
 * bağlantı yalnızca daveti oluşturan yöneticiye ekranda gösterilir (`screenReason: QUEUE_UNAVAILABLE`). Sahte başarı yok.
 */
const unavailableQueue: InvitationDeps["queue"] = {
  enqueue: () => Promise.reject(new Error("job queue is not available in the web process")),
};

const guardedAction = createProductionGuard(() => headers());

export async function inviteMemberAction(raw: unknown) {
  return guardedAction({ schema: inviteSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const result = await inviteMember(
      {
        db: getAppDb(),
        principal,
        tenantSlug: input.slug,
        email: input.email,
        roleKey: input.roleKey,
        requestId: ctx.requestId,
      },
      { mailConfig: loadMailConfig(process.env), queue: unavailableQueue },
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
