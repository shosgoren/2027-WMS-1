// Mailpit HTTP gönderimi (yerel/CI). Uç nokta ve alanlar Mailpit v1.31.4 swagger/kaynağından doğrulandı:
// POST {baseUrl}/api/v1/send, JSON { From:{Email,Name}, To:[{Email,Name}], Subject, Text, HTML }, yanıt { ID }.
import { MailError, assertBareRecipient, type MailMessage, type Mailer } from "@wms/shared/mailer";

const REQUEST_TIMEOUT_MS = 15_000;

export interface MailpitOptions {
  readonly baseUrl: string;
  readonly from: string;
  readonly fetch?: typeof fetch;
}

/** `Ad <adres>` veya yalın adres → { Email, Name? }. */
export function parseFrom(from: string): { Email: string; Name?: string } {
  const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from);
  if (m === null) return { Email: from.trim() };
  const name = (m[1] ?? "").replace(/^"|"$/g, "");
  return name === "" ? { Email: (m[2] ?? "").trim() } : { Email: (m[2] ?? "").trim(), Name: name };
}

export function createMailpitMailer(options: MailpitOptions): Mailer {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    async send(message: MailMessage): Promise<void> {
      assertBareRecipient(message.to);
      let response: Response;
      try {
        response = await doFetch(`${base}/api/v1/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            From: parseFrom(options.from),
            To: [{ Email: message.to }],
            Subject: message.subject,
            Text: message.text,
            HTML: message.html,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new MailError("MAIL_SEND_FAILED", `mailpit request failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
      if (!response.ok) {
        throw new MailError("MAIL_SEND_FAILED", `mailpit responded with status ${response.status}`);
      }
    },
  };
}
