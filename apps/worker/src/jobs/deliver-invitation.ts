// `invitation.deliver` işi (T-117; ADR-013, A-42): davet belirteci YALNIZCA burada üretilir (kuyruk yükünde yalnızca
// `invitationId`). Tenant ACTIVE denetimi ve bağlam `ctx.inTenant` (withSystemTenant) ile kurulur; belirteç özeti ve
// e-posta gönderimi AYNI transaction'dadır: gönderim hata verirse özet yazımı geri alınır, yeniden denemede yeni
// belirteç üretilir (eskisi geçersiz). Alıcı ve bağlantı loglanmaz (G-09).
import { prepareInvitationDelivery } from "@wms/domain/identity/invitations";
import type { AccessTx } from "@wms/domain/identity/access";
import { MailError, canDeliver, maskRecipient, type MailConfig, type Mailer } from "@wms/shared/mailer";
import type { JobHandler } from "@wms/shared/queue";
import type { Logger } from "../lifecycle.js";
import { renderTemplate } from "../mail/templates.js";

export interface DeliverInvitationDeps {
  readonly config: MailConfig;
  readonly mailer: Mailer;
  readonly logger: Logger;
  /** Uygulama kökeni (`BETTER_AUTH_URL`); tanımsızsa iş yapılandırma hatasıyla düşer (sahte başarı yok). */
  readonly appBaseUrl: string | undefined;
}

export function createDeliverInvitationHandler(deps: DeliverInvitationDeps): JobHandler<"invitation.deliver"> {
  return async (ctx) => {
    const { invitationId } = ctx.payload;
    try {
      if (!ctx.hasTenant) throw new Error("invitation.deliver requires a tenant job");
      if (deps.appBaseUrl === undefined) throw new Error("BETTER_AUTH_URL is not configured");
      const base = deps.appBaseUrl.replace(/\/+$/, "");
      // Adaptör `inTenant`'a her zaman tenant transaction'ı verir (JobHandler varsayılan Tx tipi `unknown`).
      const sent = await ctx.inTenant(async (rawTx) => {
        const prepared = await prepareInvitationDelivery(rawTx as AccessTx, invitationId);
        if (prepared === null) return false;
        // Alıcı yazıldığı andan sonra yapılandırma değişmiş olabilir: gönderimden önce yeniden denetlenir.
        if (!canDeliver(deps.config, prepared.email)) {
          throw new MailError("MAIL_DELIVERY_DISABLED", "recipient cannot be delivered in this environment");
        }
        const link = `${base}/invite/${prepared.token}`;
        const rendered = renderTemplate("invitation", prepared.locale, link);
        await deps.mailer.send({ to: prepared.email, ...rendered, idempotencyKey: ctx.jobId });
        deps.logger.info("invitation email sent", { jobId: ctx.jobId, recipient: maskRecipient(prepared.email) });
        return true;
      });
      if (!sent) deps.logger.info("invitation.deliver skipped", { jobId: ctx.jobId, reason: "not_pending" });
    } catch (err) {
      deps.logger.error("invitation.deliver failed", {
        jobId: ctx.jobId,
        error: err instanceof Error ? err.name : "unknown",
        ...(err instanceof MailError ? { code: err.code } : {}),
      });
      throw err;
    }
  };
}
