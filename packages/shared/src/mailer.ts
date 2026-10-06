// İşlemsel e-posta sözleşmesi (ADR-013, T-116): gönderim kipi, `canDeliver` ve kuyruk yükü kurucusu.
// Ağ çağrısı yoktur; sağlayıcı gerçeklemeleri `apps/worker/src/mail` altındadır.
import { PLATFORM_SEAL_SCOPE, createSealer, type SealedBox, type Sealer } from "./seal.ts";

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

/**
 * Kalıcı hata işareti: kuyruk bağdaştırıcısı (`@wms/queue-adapter`) `permanent === true` taşıyan hatayı yeniden
 * denemeden sonlandırır (iş `failed` kalır). Sınıfa bağımlılık yoktur; paketler arası yalnızca bu alan okunur.
 */
export interface PermanentFailure {
  readonly permanent: true;
}

/** 4xx olduğu halde geçici sayılan durumlar: istek zaman aşımı, eşzamanlı idempotency çakışması (409, Resend), erken istek, hız sınırı. */
const TRANSIENT_4XX: readonly number[] = [408, 409, 425, 429];

/** 15 §Hata kodlarına eklenmesi gereken kod için bkz. rapor bulgusu; T-112 aynı adı kullanır. */
export class MailError extends Error {
  override name = "MailError";
  readonly code: "MAIL_DELIVERY_DISABLED" | "MAIL_SEND_FAILED" | "MAIL_RECIPIENT_INVALID";
  /** Sağlayıcı HTTP durumu: yalnızca `options.status` ile verilir (mesaj metni ayrıştırılmaz); ağ hatasında tanımsız. */
  readonly status: number | undefined;
  /**
   * Yeniden denemenin sonucu değiştirmeyeceği hata: kip kapalı, alıcı geçersiz, sağlayıcı 4xx (408, 409, 425, 429 hariç).
   * Ağ hatası, 5xx, 408, 409, 425 ve 429 geçicidir.
   */
  readonly permanent: boolean;
  constructor(code: MailError["code"], message: string, options?: { readonly status?: number }) {
    super(message);
    this.code = code;
    this.status = options?.status;
    this.permanent =
      code === "MAIL_SEND_FAILED"
        ? this.status !== undefined && this.status >= 400 && this.status < 500 && !TRANSIENT_4XX.includes(this.status)
        : true;
  }
}

/** Mühürden çıkan yük kullanılamaz (bilinmeyen şablon, eksik alan): yeniden denemek sonucu değiştirmez. */
export class MailPayloadError extends Error implements PermanentFailure {
  override name = "MailPayloadError";
  readonly permanent = true as const;
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

/** Kip/ortam uyumsuzluğu: genel hata yerine ayırt edilebilir ad ve kod taşır (log ve alarm için; mesaj değer içermez). */
export class MailConfigError extends Error {
  override name = "MailConfigError";
  readonly code = "MAIL_MODE_NOT_ALLOWED" as const;
}

/** `mailpit` kipine izin verilen ortamlar (A-50 ile aynı küme). */
const MAILPIT_ENVS: readonly string[] = ["local", "ci"];

/**
 * `mailpit` kipi yalnızca açıkça `WMS_ENV` ∈ {local, ci} iken açılabilir; tanımsız, staging, production veya
 * bilinmeyen değer reddedilir (fail-closed). Aksi halde mailpit arayüzüne erişen doğrulanmış bir hesap, gönderilen
 * davet/sıfırlama bağlantılarını okuyup hesap açabilir. Açılışta çağrılır; mesaj değer içermez (G-09).
 */
export function assertMailModeAllowed(config: Pick<MailConfig, "mode">, wmsEnv: string | undefined): void {
  if (config.mode === "mailpit" && !MAILPIT_ENVS.includes(wmsEnv ?? "")) {
    throw new MailConfigError("MAIL_MODE=mailpit is only allowed when WMS_ENV is local or ci");
  }
}

/** Tek, çıplak `local@domain` adresi: virgül, `<`, `>`, boşluk, CRLF, tırnak vb. içeremez. */
const BARE_ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const ADDRESS_MAX = 254;
/** RFC 5321 §4.5.3.1.1: yerel kısım en çok 64 sekizli. */
const LOCAL_PART_MAX = 64;

/** Yerel kısım: en çok 64 karakter; baş/son nokta ve ardışık nokta (`..`) yok (RFC 5321/5322 dot-atom). */
function isValidLocalPart(local: string): boolean {
  return local.length >= 1 && local.length <= LOCAL_PART_MAX && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..");
}

export function isBareAddress(value: string): boolean {
  if (value.length > ADDRESS_MAX || !BARE_ADDRESS_RE.test(value)) return false;
  return isValidLocalPart(value.slice(0, value.indexOf("@")));
}

/** Mühürden çıkan alıcı çıplak adres değilse kalıcı hata (gönderim yok). Değer mesaja girmez (G-09). */
export function assertBareRecipient(value: string): void {
  if (!isBareAddress(value)) throw new MailError("MAIL_RECIPIENT_INVALID", "recipient is not a single bare address");
}

/**
 * Gönderim önceden bildirimi: komutlar (T-117) işi kuyruğa yazmadan önce çağırır; false ise kendi geri dönüş
 * yolunu kullanır (A-42). `resend` kipinde anahtar/gönderen, `mailpit` kipinde adres/gönderen yoksa false (sahte başarı yok).
 */
export function canDeliver(config: MailConfig, recipient: string): boolean {
  if (!isBareAddress(recipient)) return false;
  switch (config.mode) {
    case "disabled":
      return false;
    case "mailpit":
      return config.mailpitUrl !== undefined && config.from !== undefined;
    case "resend": {
      if (config.resendApiKey === undefined || config.from === undefined) return false;
      if (config.verifiedDomain !== undefined) return true;
      return config.restrictedRecipients.has(recipient.toLowerCase());
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
  /** Tenant işinde tenant kimliği (işin yazıldığı tenant); platform işinde (`enqueuePlatform`) `null`. */
  readonly tenantId: string | null;
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
    { jobType: EMAIL_SEND_JOB_TYPE, template: input.template, tenantId: input.tenantId ?? PLATFORM_SEAL_SCOPE },
  );
  return { template: input.template, locale: input.locale, sealed };
}
