// `email.send` işi (T-116): mühürlü yükü açar, şablonu üretir, `Mailer` ile gönderir.
// - Tenant işiyse (`ctx.hasTenant`) tenant'ın ACTIVE olduğu `ctx.inTenant` (withSystemTenant) ile doğrulanır;
//   platform işinde (parola sıfırlama, `enqueuePlatform`) tenant yoktur ve bu adım atlanır.
// - Alıcı adresi ve bağlantı loglanmaz (maskeli alıcı). Hata yutulmaz: fırlatılır, pg-boss yeniden dener.
import {
  EMAIL_SEND_JOB_TYPE,
  MailError,
  canDeliver,
  maskRecipient,
  type MailConfig,
  type Mailer,
} from "@wms/shared/mailer";
import type { JobHandler } from "@wms/shared/queue";
import type { Sealer } from "@wms/shared/seal";
import type { Logger } from "../lifecycle.js";
import { createMailpitMailer } from "../mail/mailpit.js";
import { createResendMailer } from "../mail/resend.js";
import { isMailTemplate, renderTemplate } from "../mail/templates.js";

/** Kipe göre `Mailer`; `disabled`/eksik yapılandırma `MAIL_DELIVERY_DISABLED` ile reddeder (sahte başarı yok). */
export function createMailer(config: MailConfig, doFetch?: typeof fetch): Mailer {
  if (config.mode === "resend" && config.resendApiKey !== undefined && config.from !== undefined) {
    return createResendMailer({
      apiKey: config.resendApiKey,
      from: config.from,
      ...(doFetch !== undefined ? { fetch: doFetch } : {}),
    });
  }
  if (config.mode === "mailpit" && config.mailpitUrl !== undefined && config.from !== undefined) {
    return createMailpitMailer({
      baseUrl: config.mailpitUrl,
      from: config.from,
      ...(doFetch !== undefined ? { fetch: doFetch } : {}),
    });
  }
  return {
    send: () => Promise.reject(new MailError("MAIL_DELIVERY_DISABLED", "mail delivery is disabled or not configured")),
  };
}

export interface SendEmailDeps {
  readonly sealer: Sealer;
  readonly config: MailConfig;
  readonly mailer: Mailer;
  readonly logger: Logger;
}

export function createSendEmailHandler(deps: SendEmailDeps): JobHandler<"email.send"> {
  return async (ctx) => {
    const { template, locale, sealed } = ctx.payload;
    try {
      if (ctx.hasTenant) {
        // Tenant ACTIVE değilse withSystemTenant reddeder; iş hata ile döner.
        await ctx.inTenant(() => Promise.resolve());
      }
      if (!isMailTemplate(template)) throw new Error("unknown email template");
      const data = deps.sealer.open(sealed, { jobType: EMAIL_SEND_JOB_TYPE, template });
      const to = data.to;
      const link = data.link;
      if (to === undefined || link === undefined) throw new Error("sealed payload is incomplete");
      // Alıcı bu işin yazıldığı andan sonra yapılandırma değişmiş olabilir: gönderimden önce yeniden denetlenir.
      if (!canDeliver(deps.config, to)) {
        throw new MailError("MAIL_DELIVERY_DISABLED", "recipient cannot be delivered in this environment");
      }
      const rendered = renderTemplate(template, locale, link);
      await deps.mailer.send({ to, ...rendered, idempotencyKey: ctx.jobId });
      deps.logger.info("email sent", { jobId: ctx.jobId, template, locale, recipient: maskRecipient(to) });
    } catch (err) {
      // Yalnızca ad/kod loglanır: hata mesajı adres veya bağlantı taşıyabilir (G-09).
      deps.logger.error("email.send failed", {
        jobId: ctx.jobId,
        template,
        error: err instanceof Error ? err.name : "unknown",
        ...(err instanceof MailError ? { code: err.code } : {}),
      });
      throw err;
    }
  };
}
