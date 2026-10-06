// Davet yaşam döngüsü (T-117; ADR-016 §3, §10, §12; ADR-014 §11; A-42, A-43, A-45).
//
// - `inviteMember` / `revokeInvitation`: `runTenantCommand` (users.manage); audit aynı transaction'da.
// - Teslim (A-42): `canDeliver` true ise davet "teslim bekliyor" yazılır (`delivered_via='EMAIL'`, `token_hash` =
//   atılan rastgele 32 baytın özeti: şema NOT NULL — yer tutucu hiçbir belirteçle eşleşmez) ve aynı transaction'da
//   `invitation.deliver` işi YALNIZCA `invitationId` ile kuyruğa girer; belirteci worker üretir (e-posta + bellek).
//   `canDeliver` false ya da iş kuyruğa yazılamazsa `delivered_via='SCREEN'`: belirteç komutta üretilir, DB'ye yalnızca
//   SHA-256, düz değer daveti oluşturan yöneticiye sonuçta BİR KEZ döner.
// - `acceptInvitation`: belirteçten tenant `withInvitationTenant` (migration 0006) ile çözülür; her adımda davet
//   `FOR UPDATE` ile yeniden doğrulanır. Hesap yoksa m8 sırası (iki bağlantı, tek transaction yok): (1) talep, (2)
//   `createInvitedAccount` (DI; domain `@wms/auth` import etmez), (3) üyelik + rol + `accepted_at`.
// - Hatalar `docs/spec/15-engineering.md` kodlarıdır; geçersiz/süresi dolmuş/iptal/kabul edilmiş belirteç tek tip `NOT_FOUND`.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { MembershipError, appendAudit, withInvitationTenant } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { canDeliver, isBareAddress, type MailConfig } from "@wms/shared/mailer";
import type { JobQueue } from "@wms/shared/queue";
import { mapAccessError, runTenantCommand, type AccessDbClient, type AccessPrincipal, type AccessTx, type TenantAccessParams } from "./access.ts";
import { ROLE_KEYS, type RoleKey } from "./permissions.ts";

/** Davet geçerlilik süresi (A-42). */
export const INVITATION_TTL_HOURS = 72;
/** Hesap-yok akışında talebin geçerlilik süresi (T-117 m8). */
export const INVITATION_CLAIM_TTL_MINUTES = 10;

// ---------------------------------------------------------------------------------------------
// Belirteç ve girdi yardımcıları (saf; birim testli)
// ---------------------------------------------------------------------------------------------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32 bayt rastgele, base64url (43 karakter). Düz değer yalnızca bellekte ve e-posta/ekran yolunda yaşar. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isWellFormedInvitationToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/** DB'ye yazılan tek biçim: küçük harf hex SHA-256 (64 karakter). */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** "Teslim bekliyor" yer tutucusu: kimsenin bilmediği rastgele değerin özeti (hiçbir belirteçle eşleşmez). */
export function placeholderTokenHash(): string {
  return hashInvitationToken(randomBytes(32).toString("base64url"));
}

/** Kırp + küçük harf; tek çıplak adres değilse `VALIDATION_FAILED` (değer hataya girmez). */
export function normalizeInvitationEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const email = raw.trim().toLowerCase();
  if (!isBareAddress(email)) throw new AppError("VALIDATION_FAILED");
  return email;
}

/** Demo kullanıcısı: adres `DEMO_EMAIL_DOMAIN` alan adında (A-43). Tanımsız alan adı → demo kısıtı yok. */
export function isDemoAddress(email: string, demoEmailDomain: string | null | undefined): boolean {
  if (demoEmailDomain === null || demoEmailDomain === undefined || demoEmailDomain === "") return false;
  return email.trim().toLowerCase().endsWith(`@${demoEmailDomain.toLowerCase()}`);
}

function parseRole(raw: unknown): RoleKey {
  if (typeof raw !== "string" || !(ROLE_KEYS as readonly string[]).includes(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as RoleKey;
}

function parseUuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw;
}

// ---------------------------------------------------------------------------------------------
// Hata eşleme
// ---------------------------------------------------------------------------------------------

function sqlstateOf(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function withCause(err: AppError, cause: unknown): AppError {
  err.cause = cause;
  return err;
}

/** `MembershipError("NOT_FOUND")` (`withInvitationTenant`) ve `@wms/auth` `InvitedAccountError` → `AppError`; gerisi `mapAccessError`. */
function mapInvitationError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  if (e instanceof MembershipError && e.code === "NOT_FOUND") return withCause(new AppError("NOT_FOUND"), e);
  const named = e as { name?: unknown; code?: unknown } | null;
  if (named?.name === "InvitedAccountError") {
    if (named.code === "FORBIDDEN") return withCause(new AppError("FORBIDDEN"), e);
    if (named.code === "NOT_FOUND") return withCause(new AppError("NOT_FOUND"), e);
    if (named.code === "VALIDATION_FAILED") return withCause(new AppError("VALIDATION_FAILED"), e);
  }
  if (sqlstateOf(e) === "23505") return withCause(new AppError("VERSION_CONFLICT", { retryable: true }), e);
  return mapAccessError(e);
}

// ---------------------------------------------------------------------------------------------
// inviteMember / revokeInvitation
// ---------------------------------------------------------------------------------------------

export interface InvitationDeps {
  readonly mailConfig: MailConfig;
  /** Yalnızca `enqueue` kullanılır; iş komutun transaction'ında yazılır. */
  readonly queue: Pick<JobQueue<AccessTx>, "enqueue">;
}

export type InviteMemberParams = Omit<TenantAccessParams, "permission"> & {
  readonly email: string;
  readonly roleKey: string;
  readonly requestId?: string;
};

export interface InviteMemberResult {
  readonly invitationId: string;
  readonly expiresAt: Date;
  readonly delivery: "EMAIL" | "SCREEN";
  /** Yalnızca `SCREEN`: düz belirteç, yalnızca bu sonuçta bir kez. */
  readonly token?: string;
  /** `SCREEN` ise nedeni: posta teslimi kapalı/uygun değil ya da iş kuyruğa yazılamadı (ekranda bağlantı gösterilir). */
  readonly screenReason?: "DELIVERY_UNAVAILABLE" | "QUEUE_UNAVAILABLE";
}

export async function inviteMember(params: InviteMemberParams, deps: InvitationDeps): Promise<InviteMemberResult> {
  const { email: rawEmail, roleKey: rawRole, requestId, ...access } = params;
  const email = normalizeInvitationEmail(rawEmail);
  const role = parseRole(rawRole);
  try {
    return await runTenantCommand({ ...access, permission: "users.manage" }, async (tx, membership) => {
      const tenant = await tx.execute<{ is_demo: boolean }>(
        sql`SELECT is_demo FROM public.tenants WHERE id = ${membership.tenantId}::uuid`,
      );
      if (tenant[0]?.is_demo !== false) throw new AppError("FORBIDDEN"); // M9: demo tenant'ta davet tamamen kapalı

      const alreadyMember = await tx.execute<{ one: number }>(
        sql`SELECT 1 AS one
              FROM public.users u
              JOIN public.tenant_memberships m ON m.user_id = u.id
             WHERE lower(u.email) = ${email}
               AND m.tenant_id = ${membership.tenantId}::uuid AND m.status = 'ACTIVE'
             LIMIT 1`,
      );
      if (alreadyMember.length > 0) throw new AppError("VALIDATION_FAILED"); // A-xx: ACTIVE üyeye davet yok

      // Aynı e-postaya açık davet varsa yenisi eskisini iptal eder.
      const superseded = await tx.execute<{ id: string }>(
        sql`UPDATE public.invitations SET revoked_at = now()
             WHERE tenant_id = ${membership.tenantId}::uuid AND email_normalized = ${email}
               AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
      );
      for (const old of superseded) {
        await appendAudit(tx, {
          action: "invitation.revoked",
          actorUserId: membership.userId,
          entityType: "invitation",
          entityId: old.id,
          requestId: requestId ?? null,
          changeSummary: { reason: "superseded" },
        });
      }

      const invitationId = randomUUID();
      let delivery: "EMAIL" | "SCREEN" = "SCREEN";
      let screenReason: InviteMemberResult["screenReason"] = "DELIVERY_UNAVAILABLE";
      if (canDeliver(deps.mailConfig, email)) {
        try {
          // Savepoint: kuyruk yazımı başarısız olursa transaction zehirlenmez; ekranda bağlantıya düşülür (A-42).
          await tx.transaction((sp) =>
            deps.queue.enqueue(sp, {
              type: "invitation.deliver",
              actorUserId: membership.userId,
              payload: { invitationId },
            }),
          );
          delivery = "EMAIL";
          screenReason = undefined;
        } catch {
          // Kök neden yanıta girmez; sonuçta `screenReason: QUEUE_UNAVAILABLE` ile görünür (sahte başarı yok, G-07).
          screenReason = "QUEUE_UNAVAILABLE";
        }
      }

      const token = delivery === "SCREEN" ? generateInvitationToken() : undefined;
      const tokenHash = token === undefined ? placeholderTokenHash() : hashInvitationToken(token);
      const inserted = await tx.execute<{ expires_at: Date | string }>(
        sql`INSERT INTO public.invitations
              (tenant_id, id, email_normalized, role_key, token_hash, delivered_via, expires_at, invited_by_membership_id)
            VALUES (${membership.tenantId}::uuid, ${invitationId}::uuid, ${email}, ${role}, ${tokenHash}, ${delivery},
                    now() + make_interval(hours => ${INVITATION_TTL_HOURS}), ${membership.membershipId}::uuid)
         RETURNING expires_at`,
      );
      const expiresRaw = inserted[0]?.expires_at;
      if (expiresRaw === undefined) throw new Error("inviteMember: insert returned no row");
      const expiresAt = expiresRaw instanceof Date ? expiresRaw : new Date(expiresRaw);

      await appendAudit(tx, {
        action: "member.invited",
        actorUserId: membership.userId,
        entityType: "invitation",
        entityId: invitationId,
        requestId: requestId ?? null,
        changeSummary: { role_key: role, delivered_via: delivery, expires_at: expiresAt.toISOString() },
      });

      return {
        invitationId,
        expiresAt,
        delivery,
        ...(token === undefined ? {} : { token }),
        ...(screenReason === undefined ? {} : { screenReason }),
      };
    });
  } catch (e) {
    throw mapInvitationError(e);
  }
}

export type RevokeInvitationParams = Omit<TenantAccessParams, "permission"> & {
  readonly invitationId: string;
  readonly requestId?: string;
};

export async function revokeInvitation(params: RevokeInvitationParams): Promise<void> {
  const { invitationId: rawId, requestId, ...access } = params;
  const invitationId = parseUuid(rawId);
  try {
    await runTenantCommand({ ...access, permission: "users.manage" }, async (tx, membership) => {
      const revoked = await tx.execute<{ id: string }>(
        sql`UPDATE public.invitations SET revoked_at = now()
             WHERE tenant_id = ${membership.tenantId}::uuid AND id = ${invitationId}::uuid
               AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
      );
      if (revoked.length === 0) throw new AppError("NOT_FOUND");
      await appendAudit(tx, {
        action: "invitation.revoked",
        actorUserId: membership.userId,
        entityType: "invitation",
        entityId: invitationId,
        requestId: requestId ?? null,
        changeSummary: { reason: "revoked" },
      });
    });
  } catch (e) {
    throw mapInvitationError(e);
  }
}

// ---------------------------------------------------------------------------------------------
// acceptInvitation
// ---------------------------------------------------------------------------------------------

export interface CreateInvitedAccountPort {
  (input: { invitationTokenHash: string; claimId: string; name: string; password: string }): Promise<{ userId: string; reused: boolean }>;
}

export interface AcceptInvitationDeps {
  /** `@wms/auth` `createInvitedAccount` (T-112b); domain Better Auth import etmez. */
  readonly createInvitedAccount: CreateInvitedAccountPort;
  /** `DEMO_EMAIL_DOMAIN` (A-43): demo kullanıcıları kabul edemez; tanımsız → `null`. */
  readonly demoEmailDomain: string | null;
}

export interface AcceptInvitationParams {
  /** `wms_app` istemcisi. */
  readonly db: AccessDbClient;
  readonly token: string;
  /** Oturumdaki kullanıcı (mevcut hesapla kabul). Yoksa `newAccount` ile hesap açılır. */
  readonly principal?: Pick<AccessPrincipal, "userId"> | null;
  readonly newAccount?: { readonly name: string; readonly password: string };
  readonly requestId?: string;
}

export interface AcceptInvitationResult {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly membershipId: string;
  readonly userId: string;
}

interface LockedInvitation {
  readonly id: string;
  readonly email: string;
  readonly roleKey: RoleKey;
  readonly claimId: string | null;
  readonly claimActive: boolean;
}

/** Daveti `FOR UPDATE` ile yeniden okur ve geçerliliği doğrular (işlevin sonucuna körü körüne güvenilmez). */
async function lockValidInvitation(tx: AccessTx, tenantId: string, tokenHash: string): Promise<LockedInvitation> {
  const rows = await tx.execute<{
    id: string;
    email_normalized: string;
    role_key: RoleKey;
    claim_id: string | null;
    claim_active: boolean;
  }>(
    sql`SELECT i.id, i.email_normalized, i.role_key, i.claim_id,
               (i.claim_id IS NOT NULL AND i.claim_expires_at > now()) AS claim_active
          FROM public.invitations i
          JOIN public.tenants t ON t.id = i.tenant_id
         WHERE i.tenant_id = ${tenantId}::uuid AND i.token_hash = ${tokenHash}
           AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
           AND t.status = 'ACTIVE' AND NOT t.is_demo
           FOR UPDATE OF i`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  return { id: r.id, email: r.email_normalized, roleKey: r.role_key, claimId: r.claim_id, claimActive: r.claim_active === true };
}

async function assertNotActiveMember(tx: AccessTx, tenantId: string, email: string): Promise<void> {
  const rows = await tx.execute<{ one: number }>(
    sql`SELECT 1 AS one
          FROM public.users u
          JOIN public.tenant_memberships m ON m.user_id = u.id
         WHERE lower(u.email) = ${email} AND m.tenant_id = ${tenantId}::uuid AND m.status = 'ACTIVE'
         LIMIT 1`,
  );
  if (rows.length > 0) throw new AppError("VALIDATION_FAILED"); // rol sessizce değişmez (rol değişimi T-117b)
}

/** Üyelik (REMOVED ise yeniden etkin) + tek rol + `accepted_at`; talep temizlenir. */
async function activateMembership(
  tx: AccessTx,
  tenantId: string,
  inv: LockedInvitation,
  userId: string,
  requestId: string | undefined,
): Promise<{ membershipId: string; tenantSlug: string }> {
  const existing = await tx.execute<{ id: string; status: string }>(
    sql`SELECT id, status FROM public.tenant_memberships
         WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid
           FOR UPDATE`,
  );
  let membershipId: string;
  const found = existing[0];
  if (found === undefined) {
    const created = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner, joined_at)
          VALUES (${tenantId}::uuid, ${userId}::uuid, 'ACTIVE', false, now())
          RETURNING id`,
    );
    const id = created[0]?.id;
    if (id === undefined) throw new Error("acceptInvitation: membership insert returned no row");
    membershipId = id;
  } else if (found.status === "REMOVED") {
    membershipId = found.id;
    await tx.execute(
      sql`UPDATE public.tenant_memberships
             SET status = 'ACTIVE', is_owner = false, joined_at = now(), removed_at = NULL, roles_version = roles_version + 1
           WHERE tenant_id = ${tenantId}::uuid AND id = ${membershipId}::uuid`,
    );
    await tx.execute(
      sql`DELETE FROM public.membership_roles WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${membershipId}::uuid`,
    );
  } else {
    throw new AppError("VALIDATION_FAILED"); // ACTIVE üyelik zaten var
  }
  await tx.execute(
    sql`INSERT INTO public.membership_roles (tenant_id, membership_id, role_key)
        VALUES (${tenantId}::uuid, ${membershipId}::uuid, ${inv.roleKey})`,
  );
  await tx.execute(
    sql`UPDATE public.invitations SET accepted_at = now(), claim_id = NULL, claim_expires_at = NULL
         WHERE tenant_id = ${tenantId}::uuid AND id = ${inv.id}::uuid`,
  );
  await appendAudit(tx, {
    action: "invitation.accepted",
    actorUserId: userId,
    entityType: "invitation",
    entityId: inv.id,
    requestId: requestId ?? null,
    changeSummary: { role_key: inv.roleKey, membership_id: membershipId },
  });
  const slug = await tx.execute<{ slug: string }>(sql`SELECT slug FROM public.tenants WHERE id = ${tenantId}::uuid`);
  const tenantSlug = slug[0]?.slug;
  if (tenantSlug === undefined) throw new Error("acceptInvitation: tenant slug not readable");
  return { membershipId, tenantSlug };
}

interface UserRow {
  readonly email: string;
  readonly verified: boolean;
}

async function readUser(tx: AccessTx, userId: string): Promise<UserRow> {
  const rows = await tx.execute<{ email: string; email_verified: boolean }>(
    sql`SELECT email, email_verified FROM public.users WHERE id = ${userId}::uuid`,
  );
  const u = rows[0];
  if (u === undefined) throw new AppError("UNAUTHENTICATED");
  return { email: u.email.trim().toLowerCase(), verified: u.email_verified === true };
}

export async function acceptInvitation(params: AcceptInvitationParams, deps: AcceptInvitationDeps): Promise<AcceptInvitationResult> {
  const { db, token, principal, newAccount, requestId } = params;
  if (!isWellFormedInvitationToken(token)) throw new AppError("NOT_FOUND");
  const tokenHash = hashInvitationToken(token);
  try {
    if (principal !== null && principal !== undefined) {
      return await acceptWithExistingAccount(db, tokenHash, parseUuid(principal.userId), deps, requestId);
    }
    if (newAccount === undefined || typeof newAccount.name !== "string" || typeof newAccount.password !== "string") {
      throw new AppError("VALIDATION_FAILED");
    }
    return await acceptWithNewAccount(db, tokenHash, newAccount, deps, requestId);
  } catch (e) {
    throw mapInvitationError(e);
  }
}

/** Mevcut hesapla kabul (M3): e-posta birebir ve `email_verified=true` (pre-hijack önlemi). Tek transaction. */
async function acceptWithExistingAccount(
  db: AccessDbClient,
  tokenHash: string,
  userId: string,
  deps: AcceptInvitationDeps,
  requestId: string | undefined,
): Promise<AcceptInvitationResult> {
  return withInvitationTenant(
    db,
    tokenHash,
    async (tx, tenantId) => {
      const inv = await lockValidInvitation(tx, tenantId, tokenHash);
      const user = await readUser(tx, userId);
      if (isDemoAddress(user.email, deps.demoEmailDomain)) throw new AppError("FORBIDDEN"); // M9
      // Başka e-postalı hesap ya da doğrulanmamış e-posta: FORBIDDEN (yönlendirme: e-postanı doğrula / parolanı sıfırla).
      if (user.email !== inv.email || !user.verified) throw new AppError("FORBIDDEN");
      const { membershipId, tenantSlug } = await activateMembership(tx, tenantId, inv, userId, requestId);
      return { tenantId, tenantSlug, membershipId, userId };
    },
    { userId },
  );
}

/** Hesap-yok akışı (ADR-016 3. tur m7/m8). */
async function acceptWithNewAccount(
  db: AccessDbClient,
  tokenHash: string,
  account: { readonly name: string; readonly password: string },
  deps: AcceptInvitationDeps,
  requestId: string | undefined,
): Promise<AcceptInvitationResult> {
  // (1) wms_app tx: davet FOR UPDATE; geçerli talep varken ikinci talep VERSION_CONFLICT; süresi dolmuş talebin
  // claim_id'si KORUNUR (yalnızca claim_expires_at yenilenir), yoksa yeni UUID.
  const claimId = await withInvitationTenant(db, tokenHash, async (tx, tenantId) => {
    const inv = await lockValidInvitation(tx, tenantId, tokenHash);
    if (isDemoAddress(inv.email, deps.demoEmailDomain)) throw new AppError("FORBIDDEN"); // M9
    if (inv.claimActive) throw new AppError("VERSION_CONFLICT", { retryable: true });
    await assertNotActiveMember(tx, tenantId, inv.email);
    const claim = inv.claimId ?? randomUUID();
    await tx.execute(
      sql`UPDATE public.invitations
             SET claim_id = ${claim}::uuid, claim_expires_at = now() + make_interval(mins => ${INVITATION_CLAIM_TTL_MINUTES})
           WHERE tenant_id = ${tenantId}::uuid AND id = ${inv.id}::uuid`,
    );
    return claim;
  });

  // (2) wms_auth: hesap (var + başka talep → FORBIDDEN; aynı talep → yeniden kullanım). E-posta doğrulama durumu
  // `delivered_via` sütunundan gelir (T-112b); çağıran beyanı yok.
  const created = await deps.createInvitedAccount({
    invitationTokenHash: tokenHash,
    claimId,
    name: account.name,
    password: account.password,
  });
  const userId = parseUuid(created.userId);

  // (3) wms_app tx: talep eşleşir ve süresi dolmadıysa üyelik + rol + accepted_at. Başarısızsa aynı belirteçle yeniden
  // deneme (2)'yi yeniden kullanım ile geçer.
  return withInvitationTenant(
    db,
    tokenHash,
    async (tx, tenantId) => {
      const inv = await lockValidInvitation(tx, tenantId, tokenHash);
      if (inv.claimId !== claimId || !inv.claimActive) throw new AppError("VERSION_CONFLICT", { retryable: true });
      const user = await readUser(tx, userId);
      if (user.email !== inv.email) throw new AppError("FORBIDDEN");
      const { membershipId, tenantSlug } = await activateMembership(tx, tenantId, inv, userId, requestId);
      return { tenantId, tenantSlug, membershipId, userId };
    },
    { userId },
  );
}

// ---------------------------------------------------------------------------------------------
// Worker teslimi (`invitation.deliver`; apps/worker/src/jobs/deliver-invitation.ts çağırır)
// ---------------------------------------------------------------------------------------------

export interface PreparedInvitationDelivery {
  readonly email: string;
  readonly locale: "tr" | "en";
  /** Düz belirteç: yalnızca bellek + e-posta. DB'ye yalnızca özeti yazıldı. */
  readonly token: string;
}

/**
 * Tenant bağlamlı transaction'da (worker `ctx.inTenant`): davet hâlâ geçerli (kabul/iptal/süre yok) ve e-posta ile
 * teslim bekliyorsa YENİ belirteç üretir, özetini yazar ve düz değeri döndürür (eski belirteç/yer tutucu geçersiz kalır;
 * yeniden denemede yeniden çağrılır). Geçerli değilse `null` (iş sessizce biter; sahte başarı değil: gönderilecek bir şey yok).
 * Çağıran e-postayı AYNI transaction içinde gönderir: gönderim hata verirse özet yazımı geri alınır.
 */
export async function prepareInvitationDelivery(tx: AccessTx, invitationId: string): Promise<PreparedInvitationDelivery | null> {
  const id = parseUuid(invitationId);
  const rows = await tx.execute<{ id: string; tenant_id: string; email_normalized: string }>(
    sql`SELECT i.id, i.tenant_id, i.email_normalized
          FROM public.invitations i
          JOIN public.tenants t ON t.id = i.tenant_id
         WHERE i.id = ${id}::uuid
           AND i.delivered_via = 'EMAIL'
           AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
           AND t.status = 'ACTIVE' AND NOT t.is_demo
           FOR UPDATE OF i`,
  );
  const inv = rows[0];
  if (inv === undefined) return null;
  const token = generateInvitationToken();
  await tx.execute(
    sql`UPDATE public.invitations SET token_hash = ${hashInvitationToken(token)}
         WHERE tenant_id = ${inv.tenant_id}::uuid AND id = ${inv.id}::uuid`,
  );
  const settings = await tx.execute<{ locale: string }>(
    sql`SELECT locale FROM public.tenant_settings WHERE tenant_id = ${inv.tenant_id}::uuid`,
  );
  const locale = settings[0]?.locale === "en" ? "en" : "tr";
  return { email: inv.email_normalized, locale, token };
}
