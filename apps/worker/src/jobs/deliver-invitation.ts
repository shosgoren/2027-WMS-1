// `invitation.deliver` işi (T-117; ADR-013, A-42): davet belirteci YALNIZCA burada üretilir (kuyruk yükünde yalnızca
// `invitationId`). Sıra: belirteç üret → özeti yaz → commit (`ctx.inTenant`, withSystemTenant) → transaction DIŞINDA gönder
// (MAJOR-1: gönderim sırasında satır kilidi yok). Yeniden denemede yeni belirteç ve yeni Idempotency-Key. Alıcı ve
// bağlantı loglanmaz (G-09).
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
      // (1) Belirteç üret → özeti yaz → COMMIT. Adaptör `inTenant`'a her zaman tenant transaction'ı verir
      // (JobHandler varsayılan Tx tipi `unknown`). Satır kilidi bu transaction'la biter.
      const prepared = await ctx.inTenant((rawTx) => prepareInvitationDelivery(rawTx as AccessTx, invitationId));
      if (prepared === null) {
        deps.logger.info("invitation.deliver skipped", { jobId: ctx.jobId, reason: "not_pending" });
        return;
      }
      // Alıcı yazıldığı andan sonra yapılandırma değişmiş olabilir: gönderimden önce yeniden denetlenir.
      if (!canDeliver(deps.config, prepared.email)) {
        throw new MailError("MAIL_DELIVERY_DISABLED", "recipient cannot be delivered in this environment");
      }
      // (2) Gönderim transaction DIŞINDA. Idempotency-Key belirteç özetinden türer: her yeniden deneme yeni belirteç ve
      // yeni anahtar üretir; "ack kayboldu" durumunda alıcıdaki SON e-postanın belirteci DB'dekidir (geçerli). Gönderim
      // hatası işi hataya düşürür (pg-boss yeniden dener); yazılan özet kalır, eski bağlantı geçersizdir.
      const link = `${base}/invite/${prepared.token}`;
      const rendered = renderTemplate("invitation", prepared.locale, link);
      await deps.mailer.send({ to: prepared.email, ...rendered, idempotencyKey: `invitation-${prepared.tokenHash}` });
      deps.logger.info("invitation email sent", { jobId: ctx.jobId, recipient: maskRecipient(prepared.email) });
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
