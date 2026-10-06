"use server";
// Üye davet eylemleri (T-117). İnce giriş: doğrulama + sarmalayıcı `guardedAction`; iş kuralı `@wms/domain`.
import { z } from "zod";
import { inviteMember, revokeInvitation, type InvitationDeps } from "@wms/domain/identity/invitations";
import { ROLE_KEYS } from "@wms/domain/identity/permissions";
import { assertMailModeAllowed, loadMailConfig } from "@wms/shared/mailer";
import { getAppDb } from "@wms/db";
import { headers } from "next/headers";
import { createProductionGuard } from "../../../../lib/action-guard.ts";
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

/** Mail yapılandırmasını yükler ve kipi ortama göre doğrular (staging/prod'da mailpit reddedilir; iş kuyruğa yazılmaz). */
function loadCheckedMailConfig() {
  const config = loadMailConfig(process.env);
  assertMailModeAllowed(config, process.env.WMS_ENV?.trim());
  return config;
}

export async function inviteMemberAction(raw: unknown) {
  return guardedAction({ schema: inviteSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const mailConfig = loadCheckedMailConfig(); // kuyruk/DB'den önce: hata durumunda hiçbir şey yazılmaz
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
      { mailConfig, queue: senderQueue ?? unavailableQueue, log: logInvitation },
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
