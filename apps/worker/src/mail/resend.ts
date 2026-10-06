// Resend REST gönderimi (yalnızca `fetch`). Uç nokta ve alanlar resend-node SDK kaynağından doğrulandı:
// POST {baseUrl}/emails, `Authorization: Bearer`, `Idempotency-Key`, gövde { from, to[], subject, html, text }.
import { MailError, assertBareRecipient, type MailMessage, type Mailer } from "@wms/shared/mailer";

export const RESEND_BASE_URL = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 15_000;

export interface ResendOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

export function createResendMailer(options: ResendOptions): Mailer {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? RESEND_BASE_URL;
  return {
    async send(message: MailMessage): Promise<void> {
      assertBareRecipient(message.to);
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/emails`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Ağ hatası mesajı URL/başlık içerebilir: yalnızca ad taşınır (G-09).
        throw new MailError("MAIL_SEND_FAILED", `resend request failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
      if (!response.ok) {
        // Yanıt gövdesi alıcı adresini yansıtabilir: okunmaz, yalnızca durum kodu taşınır. Yeniden deneme pg-boss'ta.
        throw new MailError("MAIL_SEND_FAILED", `resend responded with status ${response.status}`);
      }
    },
  };
}
