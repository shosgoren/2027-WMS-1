// `@wms/auth` kimlik politikaları (T-112b; ADR-014 §11-16, ADR-016 §9-10): saf/yan etkisi dar yardımcılar.
// Better Auth nesnesine bağımlı değildir (index.ts bu dosyayı içe aktarır, tersi yok).
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { isUuid } from "@wms/db/internal";
import type { DrizzleDb } from "@wms/db/internal";

// ---------------------------------------------------------------------------------------------
// İstemci IP'si (ADR-014 §13, A-41): yalnızca `Fly-Client-IP`; X-Forwarded-For / X-Real-IP yok sayılır.
// ---------------------------------------------------------------------------------------------

/** Geçerli (IPv4/IPv6) `Fly-Client-IP` değeri; yoksa/bozuksa `null`. Başka hiçbir başlığa bakılmaz. */
export function resolveClientIp(headers: Headers | undefined): string | null {
  const raw = headers?.get("fly-client-ip")?.trim() ?? "";
  return isIP(raw) === 0 ? null : raw;
}

// ---------------------------------------------------------------------------------------------
// Kayıt kapısı (A-50)
// ---------------------------------------------------------------------------------------------

/** Self-servis kayıt yalnızca açıkça `local|ci` ortamında ve `SIGNUP_ENABLED=true` iken açılabilir. */
export function signupAllowed(wmsEnv: string | undefined, signupFlag: string | undefined): boolean {
  return signupFlag === "true" && (wmsEnv === "local" || wmsEnv === "ci");
}

// ---------------------------------------------------------------------------------------------
// Demo (A-43, ADR-014 §15)
// ---------------------------------------------------------------------------------------------

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `DEMO_EMAIL_DOMAIN` değeri: küçük harfli alan adı; geçersizse `null`. */
export function parseDemoDomain(value: string | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v !== undefined && DOMAIN_RE.test(v) ? v : null;
}

/** E-posta, tanımlı demo alan adındaysa (son `@` sonrası tam eşleşme, büyük/küçük harf duyarsız) `true`. */
export function isDemoEmail(email: string | null | undefined, demoDomain: string | null): boolean {
  if (demoDomain === null || typeof email !== "string") return false;
  const at = email.lastIndexOf("@");
  return at > 0 && email.slice(at + 1).trim().toLowerCase() === demoDomain;
}

/** Demo kullanıcısı için kapalı uçlar (M9). `before` kancası bu yolları `FORBIDDEN` yapar. */
export const DEMO_FORBIDDEN_PATHS: readonly string[] = Object.freeze([
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/update-user",
  "/change-email",
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/delete-user",
]);

// ---------------------------------------------------------------------------------------------
// Oturum ömrü (A-39) ve hız sınırı kuralları (A-41)
// ---------------------------------------------------------------------------------------------

export const SESSION_ABSOLUTE_MAX_SEC = 7 * 24 * 60 * 60;

/** Oturum oluşturulduktan itibaren mutlak üst sınır aşıldı mı (sınırın kendisi hâlâ geçerli). */
export function sessionAbsoluteExpired(createdAt: Date, now: Date = new Date()): boolean {
  const created = createdAt.getTime();
  if (!Number.isFinite(created)) return true; // bozuk zaman damgası: fail-closed
  return now.getTime() - created > SESSION_ABSOLUTE_MAX_SEC * 1000;
}

/** E-posta başına kurallar (IP'den bağımsız; farklı IP'lerden de işler). */
export const EMAIL_RATE_RULES = Object.freeze({
  /** 5 başarısız giriş / 15 dk; dolunca son başarısızlıktan itibaren 15 dk bekleme. */
  failedSignIn: { window: 15 * 60, max: 5 },
  /** Parola sıfırlama talebi: e-posta başına 5 / saat (IP başına kural index.ts'te). */
  passwordReset: { window: 60 * 60, max: 5 },
});

/** E-posta anahtarı: küçük harf + kırpma; depolamada ayrıca SHA-256 özetlenir. */
export function emailRateKey(kind: "signin-fail" | "pwd-reset", email: string): string {
  return `email:${kind}:${email.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------------------------
// Better Auth ek alanları ve kapalı uçlar (ADR-014 4. tur BLOCKER-1 / MAJOR-1)
// ---------------------------------------------------------------------------------------------

/** `input: false` istemci girdisini dışlar (better-auth db/schema.mjs:63-75); yazım yalnızca sunucu kodundadır. */
export const SESSION_ADDITIONAL_FIELDS = Object.freeze({
  mfaVerifiedAt: { type: "date", required: false, input: false },
} as const);

export const USER_ADDITIONAL_FIELDS = Object.freeze({
  invitationClaimId: { type: "string", required: false, input: false },
} as const);

/** `/update-session` (oturum alanlarını istemciden yazar) ve `/verify-password` (parola oracle'ı) kapalı. */
export const DISABLED_PATHS: readonly string[] = Object.freeze(["/update-session", "/verify-password"]);

// ---------------------------------------------------------------------------------------------
// Davetle hesap açma (ADR-014 5. tur MINOR-3, ADR-016 §9 + 3./4. tur ekleri)
// ---------------------------------------------------------------------------------------------

/** Kod `docs/spec/15-engineering.md` listesindendir. */
export class InvitedAccountError extends Error {
  override name = "InvitedAccountError";
  readonly code: "VALIDATION_FAILED" | "NOT_FOUND" | "FORBIDDEN";
  constructor(code: "VALIDATION_FAILED" | "NOT_FOUND" | "FORBIDDEN") {
    super(code);
    this.code = code;
  }
}

export interface CreateInvitedAccountInput {
  readonly invitationTokenHash: string;
  readonly claimId: string;
  readonly name: string;
  readonly password: string;
}

export interface InvitedAccountDeps {
  /** `wms_auth` bağlantısı (maskeli). */
  readonly db: Pick<DrizzleDb, "execute">;
  readonly passwordMinLength: number;
  readonly passwordMaxLength: number;
  readonly hashPassword: (password: string) => Promise<string>;
  /** Kullanıcı + parola hesabını TEK transaction'da yazar (index.ts: `internalAdapter.createOAuthUser`). */
  readonly createUserWithPassword: (data: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    invitationClaimId: string;
    passwordHash: string;
  }) => Promise<void>;
  readonly newId: () => string;
}

/**
 * E-posta ve doğrulama durumu PARAMETRE DEĞİLDİR: `wms_probe.invitation_for_account_creation` işlevinden okunur;
 * `email_verified=true` yalnızca `delivered_via='EMAIL'` iken. Aynı e-postalı hesap varsa: `invitation_claim_id`
 * eşitse mevcut kimlik döner (yeniden kullanım), değilse `FORBIDDEN`.
 */
export async function createInvitedAccountWith(
  deps: InvitedAccountDeps,
  input: CreateInvitedAccountInput,
): Promise<{ userId: string; reused: boolean }> {
  const { invitationTokenHash, claimId, name, password } = input;
  if (
    typeof invitationTokenHash !== "string" ||
    invitationTokenHash === "" ||
    !isUuid(claimId) ||
    typeof name !== "string" ||
    name.trim() === "" ||
    name.length > 200 ||
    typeof password !== "string" ||
    password.length < deps.passwordMinLength ||
    password.length > deps.passwordMaxLength
  ) {
    throw new InvitedAccountError("VALIDATION_FAILED");
  }
  const invite = await deps.db.execute<{ email_normalized: string; delivered_via: string }>(
    sql`SELECT email_normalized, delivered_via
          FROM wms_probe.invitation_for_account_creation(${invitationTokenHash}, ${claimId}::uuid)`,
  );
  const row = invite[0];
  if (row === undefined) throw new InvitedAccountError("NOT_FOUND");
  const email = row.email_normalized.toLowerCase();
  const lookup = async (): Promise<{ id: string; invitation_claim_id: string | null } | undefined> =>
    (
      await deps.db.execute<{ id: string; invitation_claim_id: string | null }>(
        sql`SELECT id, invitation_claim_id FROM public.users WHERE email = ${email}`,
      )
    )[0];
  const decide = (existing: { id: string; invitation_claim_id: string | null }): { userId: string; reused: boolean } => {
    if (existing.invitation_claim_id === claimId) return { userId: existing.id, reused: true };
    throw new InvitedAccountError("FORBIDDEN");
  };
  const existing = await lookup();
  if (existing !== undefined) return decide(existing);

  const id = deps.newId();
  const passwordHash = await deps.hashPassword(password);
  try {
    await deps.createUserWithPassword({
      id,
      name: name.trim(),
      email,
      emailVerified: row.delivered_via === "EMAIL",
      invitationClaimId: claimId,
      passwordHash,
    });
  } catch (error) {
    // Eşzamanlı aynı talep: kayıt yarışı kaybedildiyse kazananın hesabı yeniden kullanılır; aksi hata yayılır.
    const raced = await lookup();
    if (raced !== undefined && raced.invitation_claim_id === claimId) return { userId: raced.id, reused: true };
    throw error;
  }
  return { userId: id, reused: false };
}
