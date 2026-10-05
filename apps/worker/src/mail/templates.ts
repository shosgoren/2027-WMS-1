// İşlemsel e-posta şablonları (T-116): `invitation`, `password_reset`; TR varsayılan, EN. Düz metin + basit HTML.
// Bağlantı dışında kişisel veri yok. Anahtar düzeni `apps/web/messages` ile aynı (`email.<şablon>.<alan>`), ama
// dosya worker'a aittir (tek kaynak ihlali, Faz 1'de kabul; apps/web/messages henüz yok).
import type { MailLocale, MailTemplate } from "@wms/shared/mailer";

export const PRODUCT_NAME = "Etkin WMS";

interface TemplateMessages {
  readonly subject: string;
  readonly intro: string;
  readonly action: string;
  readonly expiry: string;
  readonly ignore: string;
}

export const MESSAGES: Record<MailLocale, { email: Record<MailTemplate, TemplateMessages> }> = {
  tr: {
    email: {
      invitation: {
        subject: `${PRODUCT_NAME} çalışma alanına davet edildiniz`,
        intro: `${PRODUCT_NAME} üzerinde bir çalışma alanına davet edildiniz.`,
        action: "Daveti kabul etmek için bağlantıya gidin:",
        expiry: "Bağlantı 72 saat geçerlidir ve yalnızca bir kez kullanılabilir.",
        ignore: "Bu daveti beklemiyorsanız bu e-postayı yok sayabilirsiniz.",
      },
      password_reset: {
        subject: `${PRODUCT_NAME} parola sıfırlama`,
        intro: `${PRODUCT_NAME} hesabınız için parola sıfırlama talebi alındı.`,
        action: "Yeni parola belirlemek için bağlantıya gidin:",
        expiry: "Bağlantı 30 dakika geçerlidir ve yalnızca bir kez kullanılabilir.",
        ignore: "Bu talebi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.",
      },
    },
  },
  en: {
    email: {
      invitation: {
        subject: `You have been invited to a ${PRODUCT_NAME} workspace`,
        intro: `You have been invited to a workspace on ${PRODUCT_NAME}.`,
        action: "Open the link to accept the invitation:",
        expiry: "The link is valid for 72 hours and can be used once.",
        ignore: "If you were not expecting this invitation, you can ignore this email.",
      },
      password_reset: {
        subject: `${PRODUCT_NAME} password reset`,
        intro: `A password reset was requested for your ${PRODUCT_NAME} account.`,
        action: "Open the link to choose a new password:",
        expiry: "The link is valid for 30 minutes and can be used once.",
        ignore: "If you did not request this, you can ignore this email.",
      },
    },
  },
};

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Yalnızca http(s) bağlantı kabul edilir (javascript: vb. reddedilir). */
function assertHttpLink(link: string): void {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error("email link is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("email link must be http(s)");
}

export function isMailTemplate(value: string): value is MailTemplate {
  return value === "invitation" || value === "password_reset";
}

export function renderTemplate(template: MailTemplate, locale: MailLocale, link: string): RenderedEmail {
  assertHttpLink(link);
  const m = MESSAGES[locale].email[template];
  const text = [m.intro, "", m.action, link, "", m.expiry, m.ignore, "", PRODUCT_NAME].join("\n");
  const safeLink = escapeHtml(link);
  const html =
    `<!doctype html><html lang="${locale}"><body>` +
    `<p>${escapeHtml(m.intro)}</p>` +
    `<p>${escapeHtml(m.action)}<br><a href="${safeLink}">${safeLink}</a></p>` +
    `<p>${escapeHtml(m.expiry)}<br>${escapeHtml(m.ignore)}</p>` +
    `<p>${PRODUCT_NAME}</p></body></html>`;
  return { subject: m.subject, text, html };
}
