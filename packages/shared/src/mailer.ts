// İşlemsel e-posta sözleşmesi (ADR-013, T-116): gönderim kipi, `canDeliver` ve kuyruk yükü kurucusu.
// Ağ çağrısı yoktur; sağlayıcı gerçeklemeleri `apps/worker/src/mail` altındadır.
import { createSealer, type SealedBox, type Sealer } from "./seal.ts";

export const MAIL_MODES = ["resend", "mailpit", "disabled"] as const;
export type MailMode = (typeof MAIL_MODES)[number];

export type MailLocale = "tr" | "en";
export const MAIL_TEMPLATES = ["invitation", "password_reset"] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

/** `email.send` işinin tür adı; mühür AAD'sinde kullanılır. */
export const EMAIL_SEND_JOB_TYPE = "email.send";

export interface MailConfig {
  readonly mode: MailMode;
  /** Resend API anahtarı (Fly sırrı). */
  readonly resendApiKey: string | undefined;
  /** Gönderen adresi (`MAIL_FROM`, sır değil). */
  readonly from: string | undefined;
  /** Doğrulanmış alan adı varsa alıcı kısıtı kalkar (ADR-013). */
  readonly verifiedDomain: string | undefined;
  /** Doğrulanmış alan adı yokken izinli alıcılar (küçük harf). Sır olarak tutulur. */
  readonly restrictedRecipients: ReadonlySet<string>;
  /** Mailpit HTTP kök adresi (örn. http://localhost:8025). */
  readonly mailpitUrl: string | undefined;
}

/** 15 §Hata kodlarına eklenmesi gereken kod için bkz. rapor bulgusu; T-112 aynı adı kullanır. */
export class MailError extends Error {
  override name = "MailError";
  readonly code: "MAIL_DELIVERY_DISABLED" | "MAIL_SEND_FAILED";
  constructor(code: MailError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function blankToUndefined(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t === undefined || t === "" ? undefined : t;
}

/** Ortamdan okur. `MAIL_MODE` tanımsız → `disabled`; bilinmeyen değer yapılandırma hatasıdır (sessiz düşme yok). */
export function loadMailConfig(env: Readonly<Record<string, string | undefined>>): MailConfig {
  const rawMode = blankToUndefined(env.MAIL_MODE) ?? "disabled";
  if (!(MAIL_MODES as readonly string[]).includes(rawMode)) {
    throw new Error(`MAIL_MODE geçersiz: ${MAIL_MODES.join(" | ")} bekleniyor`);
  }
  const restricted = (env.MAIL_RESTRICTED_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  return {
    mode: rawMode as MailMode,
    resendApiKey: blankToUndefined(env.RESEND_API_KEY),
    from: blankToUndefined(env.MAIL_FROM),
    verifiedDomain: blankToUndefined(env.MAIL_VERIFIED_DOMAIN),
    restrictedRecipients: new Set(restricted),
    mailpitUrl: blankToUndefined(env.MAILPIT_URL),
  };
}

/**
 * Gönderim önceden bildirimi: komutlar (T-117) işi kuyruğa yazmadan önce çağırır; false ise kendi geri dönüş
 * yolunu kullanır (A-42). `resend` kipinde anahtar veya gönderen yoksa false (sahte başarı yok).
 */
export function canDeliver(config: MailConfig, recipient: string): boolean {
  switch (config.mode) {
    case "disabled":
      return false;
    case "mailpit":
      return true;
    case "resend": {
      if (config.resendApiKey === undefined || config.from === undefined) return false;
      if (config.verifiedDomain !== undefined) return true;
      return config.restrictedRecipients.has(recipient.trim().toLowerCase());
    }
  }
}

/** Log için maskeli alıcı: `a***@d***`. Biçimsiz girdi tamamen maskelenir. */
export function maskRecipient(recipient: string): string {
  const at = recipient.indexOf("@");
  if (at <= 0 || at === recipient.length - 1) return "***";
  return `${recipient[0]}***@${recipient[at + 1]}***`;
}

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Sağlayıcıya iletilen tekillik anahtarı = iş kimliği (A-53). */
  readonly idempotencyKey: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface EmailSendInput {
  readonly template: MailTemplate;
  readonly locale: MailLocale;
  readonly to: string;
  readonly link: string;
}

/**
 * `email.send` yükünü kurar: yalnızca `{ template, locale, sealed }`. Anahtar yoksa/geçersizse açık hata
 * fırlatır (kuyruğa yazılamaz). Davet e-postası bu yolu kullanmaz (T-117 `invitation.deliver`).
 */
export function buildEmailSendPayload(
  sealerOrKey: Sealer | string | undefined,
  input: EmailSendInput,
): { template: MailTemplate; locale: MailLocale; sealed: SealedBox } {
  const sealer = typeof sealerOrKey === "object" ? sealerOrKey : createSealer(sealerOrKey);
  const sealed = sealer.seal(
    { to: input.to, link: input.link },
    { jobType: EMAIL_SEND_JOB_TYPE, template: input.template },
  );
  return { template: input.template, locale: input.locale, sealed };
}
