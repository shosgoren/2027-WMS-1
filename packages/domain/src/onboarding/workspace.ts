// Onboarding komutları (T-121; ADR-016 §2-3; A-47, A-50, A-51). Web ve worker aynı komutları çağırır.
// - `createWorkspace`: tenant + sahip üyeliği + `tenant_settings` + `tenant.created` audit'i TEK transaction'da
//   (`withNewTenant`); `(created_by_user_id, creation_request_id)` ile idempotent.
// - `continueOnboarding`: kalan adımlar sırayla, her biri kendi transaction'ında ve idempotent.
// - `updateTenantSettings`: ad/dil/saat dilimi (`settings.manage`).
//
// Hata görünürlüğü (T-133 açık sorusu; seçim): `SLUG_TAKEN` ve `IDEMPOTENCY_MISMATCH` istemciye ayrı kod olarak
// gitmez; ikisi de `VALIDATION_FAILED` olur ve rezerve/biçim hatalı slug ile AYNI yanıtı verir. Böylece "bu slug başka
// bir çalışma alanında var" bilgisi, ayrılmış kelimeden ayırt edilemez ve slug yoklama oracle'ı oluşmaz. Slug
// verilmezse (otomatik) çakışmada belirlenimli sonekle sessizce sonraki aday denenir; hata hiç görünmez.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { MembershipError, appendAudit, createDbClient, withNewTenant, withUser } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import {
  mapAccessError,
  runTenantCommand,
  type AccessDbClient,
  type AccessPrincipal,
  type AccessTx,
} from "../identity/access.ts";
import { PHASE1_STEP_KEYS, getTemplate, type OnboardingStepKey, type SectorTemplate } from "./templates.ts";

export const SUPPORTED_LOCALES: readonly string[] = Object.freeze(["tr", "en"]);

/**
 * Ayrılmış slug'lar (ADR-016 5. tur eki MINOR-5). Karşılaştırma küçük harfe çevrildikten sonra yapılır; üretilen slug
 * da tabidir. `demo` yalnızca demo tenant'a aittir (DB de `tenants_slug_chk` ile zorlar).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "demo", "admin", "api", "app", "auth", "login", "logout", "signup", "register", "onboarding", "invite", "invitations",
  "t", "www", "static", "assets", "_next", "health", "status", "support", "help", "docs", "billing", "settings",
  "system", "root", "null", "undefined", "wms", "staging", "prod", "production", "test", "mail",
]);

const SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 120;

/** Küçük harfe çevirir; biçim ve ayrılmış kelime denetimi (`Demo` → ret). */
export function isValidSlug(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const s = raw.trim().toLowerCase();
  return SLUG_FORMAT.test(s) && !RESERVED_SLUGS.has(s);
}

const TR_MAP: Readonly<Record<string, string>> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };

/** Addan slug tabanı (Türkçe karakterler sadeleştirilir); boş kalırsa `workspace`. */
export function slugBaseFromName(name: string): string {
  const lowered = name
    .replace(/İ/g, "i")
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, (c) => TR_MAP[c] ?? c);
  const ascii = lowered.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const base = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return base === "" ? "workspace" : base;
}

/** Belirlenimli aday listesi (aynı ad + requestId → aynı liste): tekrar çağrı aynı slug'a varır. */
export function slugCandidates(name: string, requestId: string): readonly string[] {
  const base = slugBaseFromName(name);
  const out: string[] = [];
  if (!RESERVED_SLUGS.has(base)) out.push(base);
  for (let i = 1; i <= 4; i++) {
    const h = createHash("sha256").update(`${requestId.toLowerCase()}:${i}`).digest("hex").slice(0, 6);
    out.push(`${base}-${h}`);
  }
  return out;
}

/** Okunan anahtarlar: `WMS_ENV`, `SIGNUP_ENABLED`, `DEMO_EMAIL_DOMAIN` (`process.env` doğrudan geçirilebilir). */
export type WorkspaceEnv = Readonly<Record<string, string | undefined>>;

/** A-50: yalnızca `WMS_ENV` açıkça `local|ci` ve bayrak tam `"true"` iken açık (`@wms/auth` signupAllowed ile aynı kural). */
export function workspaceCreationAllowed(env: WorkspaceEnv): boolean {
  return env.SIGNUP_ENABLED === "true" && (env.WMS_ENV === "local" || env.WMS_ENV === "ci");
}

function isDemoEmail(email: string | null | undefined, rawDomain: string | undefined): boolean {
  const domain = rawDomain?.trim().toLowerCase();
  if (domain === undefined || domain === "" || typeof email !== "string") return false;
  const at = email.lastIndexOf("@");
  return at > 0 && email.slice(at + 1).trim().toLowerCase() === domain;
}

/**
 * Uygulama (`wms_app`) bağlantısı: web eylemi `@wms/db`'yi doğrudan bağımlılık olarak taşımadığından (kart dışı
 * `apps/web/package.json`) istemci burada kurulur. Ayarlar `DB_CLIENT_SETTINGS` ile aynıdır (poolMax 10, prepare kapalı;
 * PgBouncer transaction mode). URL boşsa hata (değer hata mesajına girmez, G-09).
 */
export function openAppDb(url: string | undefined): AccessDbClient {
  if (url === undefined || url.trim() === "") throw new AppError("INTERNAL");
  return createDbClient({ url, poolMax: 10, prepare: false });
}

export interface CreateWorkspaceInput {
  readonly db: AccessDbClient;
  /** Süreç ortamı (çağıran verir; domain `process.env` okumaz). */
  readonly env: WorkspaceEnv;
  readonly principal: AccessPrincipal | null | undefined;
  readonly name: string;
  /** Verilmezse addan üretilir. */
  readonly slug?: string | undefined;
  readonly templateKey: string;
  /** İstemci formunda üretilen UUID: aynı istek tekrarında aynı sonuç. */
  readonly requestId: string;
}

export interface CreateWorkspaceResult {
  readonly tenantId: string;
  readonly slug: string;
  /** `false`: aynı istek daha önce işlenmişti (ikinci tenant oluşmadı). */
  readonly created: boolean;
}

interface StepState {
  readonly key: string;
  readonly status: "PENDING" | "DONE";
  readonly completedAt?: string;
}

function validationFailed(): AppError {
  return new AppError("VALIDATION_FAILED");
}

function validName(name: unknown): name is string {
  return typeof name === "string" && name.trim() !== "" && name.trim().length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(name);
}

function creationFailure(e: unknown): unknown {
  if (e instanceof MembershipError && (e.code === "SLUG_TAKEN" || e.code === "IDEMPOTENCY_MISMATCH")) {
    const err = validationFailed();
    err.cause = e;
    return err;
  }
  return mapAccessError(e);
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
  const { db, env, principal, templateKey, requestId } = input;
  if (principal === null || principal === undefined) throw new AppError("UNAUTHENTICATED");
  // A-50 / m11: kapı en başta; kapalıyken doğrulama ayrıntısı bile üretilmez.
  if (!workspaceCreationAllowed(env)) throw new AppError("FORBIDDEN");
  if (typeof requestId !== "string" || !UUID_RE.test(requestId) || !validName(input.name)) throw validationFailed();
  const name = input.name.trim();
  const template = getTemplate(templateKey);
  if (template === undefined) throw validationFailed();
  const explicit = input.slug !== undefined && input.slug.trim() !== "";
  if (explicit && !isValidSlug(input.slug)) throw validationFailed();

  // M9: demo kullanıcısı (DEMO_EMAIL_DOMAIN) çalışma alanı oluşturamaz. E-posta sunucu tarafında DB'den okunur.
  let email: string | undefined;
  try {
    const rows = await withUser(db, principal.userId, (tx) =>
      tx.execute<{ email: string }>(sql`SELECT email FROM public.users WHERE id = ${principal.userId}::uuid`),
    );
    email = rows[0]?.email;
  } catch (e) {
    throw mapAccessError(e);
  }
  if (email === undefined) throw new AppError("UNAUTHENTICATED");
  if (isDemoEmail(email, env.DEMO_EMAIL_DOMAIN)) throw new AppError("FORBIDDEN");

  const candidates = explicit ? [(input.slug as string).trim().toLowerCase()] : slugCandidates(name, requestId);
  let last: unknown;
  for (const slug of candidates) {
    try {
      return await createWithSlug(db, principal.userId, name, slug, template, requestId);
    } catch (e) {
      last = e;
      const retryNext =
        !explicit && e instanceof MembershipError && (e.code === "SLUG_TAKEN" || e.code === "IDEMPOTENCY_MISMATCH");
      if (!retryNext) throw creationFailure(e);
    }
  }
  throw creationFailure(last);
}

async function createWithSlug(
  db: AccessDbClient,
  userId: string,
  name: string,
  slug: string,
  template: SectorTemplate,
  requestId: string,
): Promise<CreateWorkspaceResult> {
  return withNewTenant(db, { userId, slug, name, creationRequestId: requestId }, async (tx, m) => {
    if (!m.created) {
      // Aynı istek farklı şablonla tekrarlandı → sessizce eski sonucu döndürme.
      const rows = await tx.execute<{ sector_template_key: string | null }>(
        sql`SELECT sector_template_key FROM public.tenant_settings WHERE tenant_id = ${m.tenantId}::uuid`,
      );
      if (rows[0]?.sector_template_key !== template.key) {
        throw new MembershipError("IDEMPOTENCY_MISMATCH", "creation request was already used with a different template");
      }
      return { tenantId: m.tenantId, slug, created: false };
    }
    const steps: StepState[] = template.steps.map((key) => ({ key, status: "PENDING" }));
    await tx.execute(
      sql`INSERT INTO public.tenant_settings
            (tenant_id, locale, time_zone, sector_template_key, sector_template_version, terminology,
             onboarding_status, onboarding_steps)
          VALUES (${m.tenantId}::uuid, ${template.locale}, ${template.timeZone}, ${template.key}, ${template.version},
                  ${JSON.stringify(template.terminology)}::jsonb, 'IN_PROGRESS', ${JSON.stringify(steps)}::jsonb)`,
    );
    await appendAudit(tx, {
      action: "tenant.created",
      actorUserId: userId,
      entityType: "tenant",
      entityId: m.tenantId,
      requestId,
      changeSummary: { slug, templateKey: template.key, templateVersion: template.version },
    });
    return { tenantId: m.tenantId, slug, created: true };
  });
}

// ---------------------------------------------------------------------------------------------
// continueOnboarding
// ---------------------------------------------------------------------------------------------

export interface ContinueOnboardingInput {
  readonly db: AccessDbClient;
  readonly principal: AccessPrincipal | null | undefined;
  readonly slug: string;
}

export interface OnboardingProgress {
  readonly status: "IN_PROGRESS" | "COMPLETED";
  /** Bu çağrıda tamamlanan adımlar (sırayla). */
  readonly applied: readonly string[];
}

type SettingsRow = {
  sector_template_key: string | null;
  sector_template_version: number | null;
  terminology: unknown;
  onboarding_status: string;
  onboarding_steps: unknown;
};

function asJson(v: unknown): unknown {
  return typeof v === "string" ? (JSON.parse(v) as unknown) : v;
}

function parseSteps(raw: unknown): StepState[] {
  const v = asJson(raw);
  if (!Array.isArray(v)) throw new Error("onboarding_steps is not an array");
  return v.map((s): StepState => {
    const o = s as { key?: unknown; status?: unknown; completedAt?: unknown };
    if (typeof o.key !== "string" || (o.status !== "PENDING" && o.status !== "DONE")) {
      throw new Error("onboarding_steps entry is malformed");
    }
    return typeof o.completedAt === "string"
      ? { key: o.key, status: o.status, completedAt: o.completedAt }
      : { key: o.key, status: o.status };
  });
}

type StepHandler = (tx: AccessTx, tenantId: string, row: SettingsRow, template: SectorTemplate) => Promise<void>;

/** Adım uygulayıcıları: idempotent ve kullanıcı değişikliğini ezmeyen uzlaştırma (kayıtlı şablon sürümünden). */
const STEP_HANDLERS: Readonly<Record<OnboardingStepKey, StepHandler>> = {
  "settings.applied": async (tx, tenantId, row, template) => {
    if (row.sector_template_key === null || row.sector_template_version === null) {
      await tx.execute(
        sql`UPDATE public.tenant_settings
               SET sector_template_key = ${template.key}, sector_template_version = ${template.version}
             WHERE tenant_id = ${tenantId}::uuid`,
      );
    }
  },
  "terminology.applied": async (tx, tenantId, _row, template) => {
    // Mevcut (kullanıcı/önceki) etiketler şablon varsayılanının üstündedir.
    await tx.execute(
      sql`UPDATE public.tenant_settings
             SET terminology = ${JSON.stringify(template.terminology)}::jsonb || terminology
           WHERE tenant_id = ${tenantId}::uuid`,
    );
  },
};

function isStepKey(k: string): k is OnboardingStepKey {
  return (PHASE1_STEP_KEYS as readonly string[]).includes(k);
}

export async function continueOnboarding(input: ContinueOnboardingInput): Promise<OnboardingProgress> {
  const { db, principal, slug } = input;
  const applied: string[] = [];
  // Her yineleme TEK adımı kendi transaction'ında uygular; hata önceki tamamlanmış adımları geri almaz.
  for (let guard = 0; guard < 32; guard++) {
    const outcome = await runTenantCommand(
      { db, principal, tenantSlug: slug, permission: "settings.manage" },
      async (tx, membership): Promise<{ done: boolean; step?: string }> => {
        const rows = await tx.execute<SettingsRow>(
          sql`SELECT sector_template_key, sector_template_version, terminology, onboarding_status, onboarding_steps
                FROM public.tenant_settings WHERE tenant_id = ${membership.tenantId}::uuid FOR UPDATE`,
        );
        const row = rows[0];
        if (row === undefined) throw new AppError("NOT_FOUND");
        if (row.onboarding_status === "COMPLETED") return { done: true };
        const steps = parseSteps(row.onboarding_steps);
        const next = steps.find((s) => s.status === "PENDING" && isStepKey(s.key));
        if (next === undefined) {
          // Bilinmeyen (Faz 2) bekleyen adım varsa tamamlanmış sayılmaz.
          if (steps.some((s) => s.status === "PENDING")) return { done: true };
          await tx.execute(
            sql`UPDATE public.tenant_settings SET onboarding_status = 'COMPLETED' WHERE tenant_id = ${membership.tenantId}::uuid`,
          );
          return { done: true };
        }
        const template = getTemplate(row.sector_template_key ?? "", row.sector_template_version ?? undefined);
        if (template === undefined) throw new Error("onboarding: sector template is not registered");
        await STEP_HANDLERS[next.key as OnboardingStepKey](tx, membership.tenantId, row, template);
        const updated = steps.map((s) =>
          s.key === next.key ? { key: s.key, status: "DONE" as const, completedAt: new Date().toISOString() } : s,
        );
        const allDone = updated.every((s) => s.status === "DONE");
        await tx.execute(
          sql`UPDATE public.tenant_settings
                 SET onboarding_steps = ${JSON.stringify(updated)}::jsonb,
                     onboarding_status = ${allDone ? "COMPLETED" : "IN_PROGRESS"}
               WHERE tenant_id = ${membership.tenantId}::uuid`,
        );
        await appendAudit(tx, {
          action: "onboarding.step_completed",
          actorUserId: membership.userId,
          entityType: "tenant",
          entityId: membership.tenantId,
          changeSummary: { step: next.key },
        });
        return { done: allDone, step: next.key };
      },
    );
    if (outcome.step !== undefined) applied.push(outcome.step);
    if (outcome.done) break;
  }
  const final = await runTenantCommand(
    { db, principal, tenantSlug: slug, permission: "settings.manage" },
    async (tx, membership) => {
      const rows = await tx.execute<{ onboarding_status: string }>(
        sql`SELECT onboarding_status FROM public.tenant_settings WHERE tenant_id = ${membership.tenantId}::uuid`,
      );
      return rows[0]?.onboarding_status;
    },
  );
  return { status: final === "COMPLETED" ? "COMPLETED" : "IN_PROGRESS", applied };
}

// ---------------------------------------------------------------------------------------------
// updateTenantSettings
// ---------------------------------------------------------------------------------------------

export interface TenantSettingsInput {
  readonly name: string;
  readonly locale: string;
  readonly timeZone: string;
}

function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function updateTenantSettings(
  db: AccessDbClient,
  slug: string,
  principal: AccessPrincipal | null | undefined,
  input: TenantSettingsInput,
): Promise<{ changed: boolean }> {
  if (!validName(input?.name) || !SUPPORTED_LOCALES.includes(input.locale) || !validTimeZone(input.timeZone)) {
    throw validationFailed();
  }
  const next = { name: input.name.trim(), locale: input.locale, timeZone: input.timeZone };
  return runTenantCommand({ db, principal, tenantSlug: slug, permission: "settings.manage" }, async (tx, membership) => {
    const rows = await tx.execute<{ name: string; locale: string; time_zone: string }>(
      sql`SELECT t.name, s.locale, s.time_zone
            FROM public.tenants t JOIN public.tenant_settings s ON s.tenant_id = t.id
           WHERE t.id = ${membership.tenantId}::uuid FOR UPDATE OF s`,
    );
    const prev = rows[0];
    if (prev === undefined) throw new AppError("NOT_FOUND");
    if (prev.name === next.name && prev.locale === next.locale && prev.time_zone === next.timeZone) {
      return { changed: false };
    }
    await tx.execute(sql`UPDATE public.tenants SET name = ${next.name} WHERE id = ${membership.tenantId}::uuid`);
    await tx.execute(
      sql`UPDATE public.tenant_settings SET locale = ${next.locale}, time_zone = ${next.timeZone}
           WHERE tenant_id = ${membership.tenantId}::uuid`,
    );
    const changes: Record<string, { from: string; to: string }> = {};
    if (prev.name !== next.name) changes.name = { from: prev.name, to: next.name };
    if (prev.locale !== next.locale) changes.locale = { from: prev.locale, to: next.locale };
    if (prev.time_zone !== next.timeZone) changes.timeZone = { from: prev.time_zone, to: next.timeZone };
    await appendAudit(tx, {
      action: "tenant.settings_changed",
      actorUserId: membership.userId,
      entityType: "tenant",
      entityId: membership.tenantId,
      changeSummary: changes,
    });
    return { changed: true };
  });
}
