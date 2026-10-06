// Üyelik komutları (T-117b; ADR-016 §5, §8, §9, §10; A-42, A-45, A-55): rol değişimi, çıkarma, ayrılma, sahiplik
// devri ve yönetici kaynaklı parola sıfırlama bağlantısı.
//
// - Hepsi `runTenantCommand` (güncel üyelik + izin, FOR SHARE) içinde; audit aynı transaction'da (I-12). `tenant_id`
//   yalnızca bağlamdan gelir. Kilit sırası: sahip üyelikler (`lockOwners`, kimliğe göre) → hedef üyelik. Eşzamanlı iki
//   "son sahip ayrılması" deadlock/serileştirme ile sıralanır: kazanan sürer, kaybeden `VERSION_CONFLICT` (retryable)
//   alır ve yeniden denerse son sahip kuralına çarpar.
// - Son sahip kuralı (§8): sahibi olan son ACTIVE üyeliğin çıkarılması/ayrılması/sahiplikten düşürülmesi/rolsüz
//   bırakılması reddedilir (devir önce). Sahibin rolü yalnızca `TENANT_ADMIN` olabilir; tenant yöneticisiz kalamaz.
// - Demo (M9): `is_demo` tenant'ta TÜM üyelik komutları kapalıdır; demo kullanıcıları (`DEMO_EMAIL_DOMAIN`) üzerinde
//   `changeRole`, `removeMember`, `transferOwnership` ve sıfırlama bağlantısı yasaktır.
// - Çıkarma oturumları SİLMEZ (ADR-014 §3): sonraki her yazma `withMembership` ile reddedilir (AC-18).
// - Ret nedenleri kullanıcıya nötr `FORBIDDEN`'dır; ayrıntı (`IDENTITY_SHARED`, `DEMO`, `OWNER`, `LAST_OWNER` …) yalnızca
//   `cause` (`MembershipDenied.reason`) içindedir ve yanıt gövdesine girmez (başka tenant üyeliği sızdırılmaz).
import { sql } from "drizzle-orm";
import { appendAudit, lockOwners } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { buildEmailSendPayload, canDeliver, type MailConfig } from "@wms/shared/mailer";
import type { Sealer } from "@wms/shared/seal";
import type { JobQueue } from "@wms/shared/queue";
import { mapAccessError, runTenantCommand, runTenantCommandById, type AccessTx, type TenantAccessParams } from "./access.ts";
import { isDemoAddress } from "./invitations.ts";
import { ROLE_KEYS, ROLE_PERMISSIONS, type RoleKey } from "./permissions.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ret nedeni (yalnızca iç; `AppError.cause` içinde). */
export type DenyReason =
  | "DEMO"
  | "OWNER"
  | "IDENTITY_SHARED"
  | "LAST_OWNER"
  | "LAST_ADMIN"
  | "OWNER_ROLE"
  | "SELF_ESCALATION"
  | "NOT_OWNER"
  | "NOT_MEMBER";

export class MembershipDenied extends Error {
  override name = "MembershipDenied";
  readonly reason: DenyReason;
  constructor(reason: DenyReason) {
    super(`membership command denied: ${reason}`);
    this.reason = reason;
  }
}

function deny(reason: DenyReason): AppError {
  const err = new AppError("FORBIDDEN");
  err.cause = new MembershipDenied(reason);
  return err;
}

function parseUuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw;
}

function parseRole(raw: unknown): RoleKey {
  if (typeof raw !== "string" || !(ROLE_KEYS as readonly string[]).includes(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as RoleKey;
}

function sqlstateOf(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Üyelik değişikliklerinin DB tetikleyicisi/kısıtı reddi (`42501` vb.) `INTERNAL` olur; yalnızca erişim hataları eşlenir. */
function mapMembershipError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  if (sqlstateOf(e) === "23505") {
    const err = new AppError("VERSION_CONFLICT", { retryable: true });
    err.cause = e;
    return err;
  }
  return mapAccessError(e);
}

export interface MembershipDeps {
  /** `DEMO_EMAIL_DOMAIN` (A-43); tanımsız → `null` (e-posta ile demo kısıtı yok; `is_demo` tenant kısıtı yine geçerli). */
  readonly demoEmailDomain: string | null;
}

type CommandParams = Omit<TenantAccessParams, "permission"> & { readonly requestId?: string };

// ---------------------------------------------------------------------------------------------
// Saf kurallar (birim testli; komutlar kilitler alındıktan sonra bunları çağırır)
// ---------------------------------------------------------------------------------------------

export interface RuleTarget {
  readonly userId: string;
  readonly isOwner: boolean;
  readonly roles: readonly RoleKey[];
}

function permissionsOf(roles: readonly RoleKey[]): ReadonlySet<string> {
  return new Set(roles.flatMap((r) => [...ROLE_PERMISSIONS[r]]));
}

/**
 * Rol değişimi kararı. `ownerCount`: kilitli ACTIVE sahip sayısı (hedef dahil); `otherAdminCount`: hedef HARİÇ ACTIVE
 * `TENANT_ADMIN` sayısı. `null` = izinli, aksi ret nedeni.
 */
export function checkRoleChange(i: {
  readonly actorUserId: string;
  readonly target: RuleTarget;
  readonly newRole: RoleKey;
  readonly ownerCount: number;
  readonly otherAdminCount: number;
}): DenyReason | null {
  const { target, newRole } = i;
  // Kendi rolünü yükseltme yok: yeni rol, mevcut rollerin izinlerinin alt kümesi olmalı.
  if (target.userId === i.actorUserId) {
    const have = permissionsOf(target.roles);
    if (![...ROLE_PERMISSIONS[newRole]].every((p) => have.has(p))) return "SELF_ESCALATION";
  }
  // Sahibin rolü yalnızca TENANT_ADMIN olabilir (rolsüz/yöneticisiz sahip yok); düşürme için önce devir.
  if (target.isOwner && newRole !== "TENANT_ADMIN") return i.ownerCount <= 1 ? "LAST_OWNER" : "OWNER_ROLE";
  if (newRole !== "TENANT_ADMIN" && target.roles.includes("TENANT_ADMIN") && i.otherAdminCount < 1) return "LAST_ADMIN";
  return null;
}

/** Çıkarma/ayrılma kararı (ADR-016 §8): son sahip ve son yönetici korunur. */
export function checkDeparture(i: {
  readonly target: RuleTarget;
  readonly ownerCount: number;
  readonly otherAdminCount: number;
}): DenyReason | null {
  if (i.target.isOwner && i.ownerCount - 1 < 1) return "LAST_OWNER";
  if (i.target.roles.includes("TENANT_ADMIN") && i.otherAdminCount < 1) return "LAST_ADMIN";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Ortak okuma/denetim
// ---------------------------------------------------------------------------------------------

async function assertTenantNotDemo(tx: AccessTx, tenantId: string): Promise<void> {
  const rows = await tx.execute<{ is_demo: boolean }>(sql`SELECT is_demo FROM public.tenants WHERE id = ${tenantId}::uuid`);
  if (rows[0]?.is_demo !== false) throw deny("DEMO"); // M9 (2. tur m3): demo tenant'ta tüm üyelik komutları kapalı
}

interface TargetMembership {
  readonly id: string;
  readonly userId: string;
  readonly isOwner: boolean;
  readonly email: string;
  readonly roles: readonly RoleKey[];
}

/** Hedef ACTIVE üyeliği satır kilidiyle okur (eşzamanlı rol/çıkarma sıralanır). Yok/REMOVED → `NOT_FOUND`. */
async function loadTarget(tx: AccessTx, tenantId: string, memberId: string): Promise<TargetMembership> {
  const rows = await tx.execute<{ id: string; user_id: string; is_owner: boolean; email: string }>(
    sql`SELECT m.id, m.user_id, m.is_owner, u.email
          FROM public.tenant_memberships m
          JOIN public.users u ON u.id = m.user_id
         WHERE m.tenant_id = ${tenantId}::uuid AND m.id = ${memberId}::uuid AND m.status = 'ACTIVE'
           FOR UPDATE OF m`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  const roleRows = await tx.execute<{ role_key: RoleKey }>(
    sql`SELECT role_key FROM public.membership_roles WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${memberId}::uuid ORDER BY role_key`,
  );
  return { id: r.id, userId: r.user_id, isOwner: r.is_owner, email: r.email, roles: roleRows.map((x) => x.role_key) };
}

async function countActiveAdminsExcept(tx: AccessTx, tenantId: string, excludedMembershipId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n
          FROM public.tenant_memberships m
          JOIN public.membership_roles r ON r.tenant_id = m.tenant_id AND r.membership_id = m.id
         WHERE m.tenant_id = ${tenantId}::uuid AND m.status = 'ACTIVE' AND r.role_key = 'TENANT_ADMIN'
           AND m.id <> ${excludedMembershipId}::uuid`,
  );
  return rows[0]?.n ?? 0;
}

async function replaceRole(tx: AccessTx, tenantId: string, membershipId: string, role: RoleKey): Promise<void> {
  await tx.execute(sql`DELETE FROM public.membership_roles WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${membershipId}::uuid`);
  await tx.execute(
    sql`INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES (${tenantId}::uuid, ${membershipId}::uuid, ${role})`,
  );
}

/** M4: `roles_version` artar (beklemedeki `withMembership` okumasıyla sıralanır). */
async function bumpMembership(tx: AccessTx, tenantId: string, membershipId: string, set?: ReturnType<typeof sql>): Promise<void> {
  await tx.execute(
    sql`UPDATE public.tenant_memberships SET ${set === undefined ? sql`` : sql`${set}, `}roles_version = roles_version + 1
         WHERE tenant_id = ${tenantId}::uuid AND id = ${membershipId}::uuid`,
  );
}

// ---------------------------------------------------------------------------------------------
// changeRole
// ---------------------------------------------------------------------------------------------

export type ChangeRoleParams = CommandParams & { readonly memberId: string; readonly roleKey: string };
export interface ChangeRoleResult {
  readonly membershipId: string;
  readonly roleKey: RoleKey;
  /** Aynı rol istendiyse `false` (yazma ve audit yok). */
  readonly changed: boolean;
}

export async function changeRole(params: ChangeRoleParams, deps: MembershipDeps): Promise<ChangeRoleResult> {
  const { memberId: rawMember, roleKey: rawRole, requestId, ...access } = params;
  const memberId = parseUuid(rawMember);
  const role = parseRole(rawRole);
  try {
    return await runTenantCommand({ ...access, permission: "users.manage" }, async (tx, actor) => {
      await assertTenantNotDemo(tx, actor.tenantId);
      const owners = await lockOwners(tx, actor.tenantId);
      const target = await loadTarget(tx, actor.tenantId, memberId);
      if (isDemoAddress(target.email, deps.demoEmailDomain)) throw deny("DEMO");
      const before = target.roles[0];
      if (target.roles.length === 1 && before === role) return { membershipId: target.id, roleKey: role, changed: false };

      const denied = checkRoleChange({
        actorUserId: actor.userId,
        target,
        newRole: role,
        ownerCount: owners.length,
        otherAdminCount: await countActiveAdminsExcept(tx, actor.tenantId, target.id),
      });
      if (denied !== null) throw deny(denied);

      await replaceRole(tx, actor.tenantId, target.id, role);
      await bumpMembership(tx, actor.tenantId, target.id);
      await appendAudit(tx, {
        action: "member.role_changed",
        actorUserId: actor.userId,
        entityType: "membership",
        entityId: target.id,
        requestId: requestId ?? null,
        changeSummary: { from_role: before ?? null, to_role: role },
      });
      return { membershipId: target.id, roleKey: role, changed: true };
    });
  } catch (e) {
    throw mapMembershipError(e);
  }
}

// ---------------------------------------------------------------------------------------------
// removeMember / leaveTenant
// ---------------------------------------------------------------------------------------------

async function deactivate(tx: AccessTx, tenantId: string, membershipId: string): Promise<void> {
  await bumpMembership(tx, tenantId, membershipId, sql`status = 'REMOVED', is_owner = false, removed_at = now()`);
}

export type RemoveMemberParams = CommandParams & { readonly memberId: string };

export async function removeMember(params: RemoveMemberParams, deps: MembershipDeps): Promise<{ membershipId: string }> {
  const { memberId: rawMember, requestId, ...access } = params;
  const memberId = parseUuid(rawMember);
  try {
    return await runTenantCommand({ ...access, permission: "users.manage" }, async (tx, actor) => {
      await assertTenantNotDemo(tx, actor.tenantId);
      const owners = await lockOwners(tx, actor.tenantId);
      const target = await loadTarget(tx, actor.tenantId, memberId);
      if (target.userId === actor.userId) throw new AppError("VALIDATION_FAILED"); // kendini çıkarma = leaveTenant
      if (isDemoAddress(target.email, deps.demoEmailDomain)) throw deny("DEMO");
      const denied = checkDeparture({
        target,
        ownerCount: owners.length,
        otherAdminCount: await countActiveAdminsExcept(tx, actor.tenantId, target.id),
      });
      if (denied !== null) throw deny(denied);
      await deactivate(tx, actor.tenantId, target.id);
      await appendAudit(tx, {
        action: "member.removed",
        actorUserId: actor.userId,
        entityType: "membership",
        entityId: target.id,
        requestId: requestId ?? null,
        changeSummary: { was_owner: target.isOwner, roles: [...target.roles] },
      });
      return { membershipId: target.id };
    });
  } catch (e) {
    throw mapMembershipError(e);
  }
}

/** Her rolün taşıdığı ortak izin: kendi üyeliğinden ayrılmak ayrıca bir izin gerektirmez (yalnızca ACTIVE üyelik). */
const LEAVE_PERMISSION = "stock.view" as const;

export async function leaveTenant(params: CommandParams): Promise<{ membershipId: string }> {
  const { requestId, ...access } = params;
  try {
    return await runTenantCommand({ ...access, permission: LEAVE_PERMISSION }, async (tx, actor) => {
      await assertTenantNotDemo(tx, actor.tenantId);
      const owners = await lockOwners(tx, actor.tenantId);
      const self = await loadTarget(tx, actor.tenantId, actor.membershipId);
      const denied = checkDeparture({
        target: self,
        ownerCount: owners.length,
        otherAdminCount: await countActiveAdminsExcept(tx, actor.tenantId, self.id),
      });
      if (denied !== null) throw deny(denied);
      await deactivate(tx, actor.tenantId, self.id);
      await appendAudit(tx, {
        action: "member.left",
        actorUserId: actor.userId,
        entityType: "membership",
        entityId: self.id,
        requestId: requestId ?? null,
        changeSummary: { was_owner: self.isOwner },
      });
      return { membershipId: self.id };
    });
  } catch (e) {
    throw mapMembershipError(e);
  }
}

// ---------------------------------------------------------------------------------------------
// transferOwnership
// ---------------------------------------------------------------------------------------------

export type TransferOwnershipParams = CommandParams & { readonly toMemberId: string };

/**
 * Sahiplik devri: çağıran sahip olmalı; hedef ACTIVE, demo değil, kendisi değil. Hedef `TENANT_ADMIN` rolü ve
 * `is_owner` alır, çağıran `is_owner`'ı bırakır (yönetici kalır). Her an en az bir sahip vardır (tek transaction).
 */
export async function transferOwnership(params: TransferOwnershipParams, deps: MembershipDeps): Promise<{ fromMembershipId: string; toMembershipId: string }> {
  const { toMemberId: rawTo, requestId, ...access } = params;
  const toMemberId = parseUuid(rawTo);
  try {
    return await runTenantCommand({ ...access, permission: "users.manage" }, async (tx, actor) => {
      await assertTenantNotDemo(tx, actor.tenantId);
      const owners = await lockOwners(tx, actor.tenantId);
      if (!owners.some((o) => o.membershipId === actor.membershipId)) throw deny("NOT_OWNER");
      const target = await loadTarget(tx, actor.tenantId, toMemberId);
      if (target.id === actor.membershipId) throw new AppError("VALIDATION_FAILED");
      if (isDemoAddress(target.email, deps.demoEmailDomain)) throw deny("DEMO");

      if (!target.isOwner) {
        if (!target.roles.includes("TENANT_ADMIN") || target.roles.length !== 1) {
          await replaceRole(tx, actor.tenantId, target.id, "TENANT_ADMIN");
        }
        await bumpMembership(tx, actor.tenantId, target.id, sql`is_owner = true`);
      }
      await bumpMembership(tx, actor.tenantId, actor.membershipId, sql`is_owner = false`);
      await appendAudit(tx, {
        action: "ownership.transferred",
        actorUserId: actor.userId,
        entityType: "membership",
        entityId: target.id,
        requestId: requestId ?? null,
        changeSummary: { from_membership_id: actor.membershipId, to_membership_id: target.id },
      });
      return { fromMembershipId: actor.membershipId, toMembershipId: target.id };
    });
  } catch (e) {
    throw mapMembershipError(e);
  }
}

// ---------------------------------------------------------------------------------------------
// issuePasswordResetLink (B1; ADR-016 §9)
// ---------------------------------------------------------------------------------------------

/** `@wms/auth` dar yüzeyi (domain Better Auth import etmez). */
export interface PasswordResetPort {
  createToken(userId: string, issuingTenantId: string): Promise<{ token: string; verificationId: string; expiresAt: Date }>;
  discardToken(verificationId: string): Promise<void>;
  recordIssued(input: { targetUserId: string; issuingTenantId: string; adminUserId: string; issuingMembershipId: string }): Promise<void>;
}

export interface IssuePasswordResetLinkDeps extends MembershipDeps {
  readonly port: PasswordResetPort;
  /** Maskeli günlük (yalnızca sınıf adı/kod; belirteç, e-posta yok — G-09). */
  readonly log?: (entry: Readonly<Record<string, unknown>>) => void;
}

export type IssuePasswordResetLinkParams = CommandParams & { readonly memberId: string };

export interface IssuePasswordResetLinkResult {
  /** Düz belirteç: yalnızca bu sonuçta, yalnızca yöneticiye (A-42). */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Sıra (3. tur m1; inceleme @3b7efdf MINOR-2): (1) `users.manage` + `requireRecentAuth` (`recentAuth` ZORUNLU) ve ön
 * denetimler kısa bir transaction'da (hedef çözümü; kilit tutulmaz); (2) YÖNETİCİ İŞARETLİ doğrulama kaydı (`wms_auth`) —
 * `wms_app` transaction'ı ve `users` kilidi DIŞINDA; (3) tek `wms_app` transaction'ında üretim denetimleri YENİDEN
 * (tenant demo değil, hedef aynı kullanıcı/demo/sahip/kendisi değil, `wms_probe.identity_exclusive_to_tenant` true —
 * hedefin `users` satırını commit'e kadar `FOR UPDATE` kilitler) + `admin_reset_grants` + audit; COMMIT; (4) `security_events`
 * `password_reset_link.issued_by_admin`; (5) bağlantı yalnızca commit + olay yazımından SONRA döner. (2)'den sonra bir
 * adım başarısız olursa işaretli kayıt aynı istekte silinir; (4) başarısız olduysa audit "üretildi" dediği için ek bir
 * telafi audit satırı (`status: revoked_before_delivery`) yazılır.
 */
export async function issuePasswordResetLink(
  params: IssuePasswordResetLinkParams,
  deps: IssuePasswordResetLinkDeps,
): Promise<IssuePasswordResetLinkResult> {
  const { memberId: rawMember, requestId, ...access } = params;
  const memberId = parseUuid(rawMember);
  if (access.recentAuth === undefined) throw new AppError("UNAUTHENTICATED", { detail: "RECENT_AUTH_REQUIRED" }); // fail-closed
  const { port } = deps;

  const checkTarget = async (tx: AccessTx, tenantId: string, actorUserId: string): Promise<TargetMembership> => {
    await assertTenantNotDemo(tx, tenantId);
    // Bu tenant'ta ACTIVE olmayan hedef (çıkarılmış, sıfır üyelik, başka tenant kimliği): nötr FORBIDDEN (varlık sızmaz).
    const target = await loadTarget(tx, tenantId, memberId).catch((e: unknown) => {
      throw e instanceof AppError && e.code === "NOT_FOUND" ? deny("NOT_MEMBER") : e;
    });
    if (target.userId === actorUserId) throw new AppError("VALIDATION_FAILED");
    if (isDemoAddress(target.email, deps.demoEmailDomain)) throw deny("DEMO");
    if (target.isOwner) throw deny("OWNER");
    return target;
  };

  let createdVerificationId: string | undefined;
  let tenantIdForCleanup: string | undefined;
  let issued:
    | { token: string; expiresAt: Date; targetUserId: string; tenantId: string; adminUserId: string; membershipId: string; targetMembershipId: string }
    | undefined;
  try {
    // (1) ön denetim (recentAuth burada); kilit/transaction (2)'de tutulmaz.
    const pre = await runTenantCommand({ ...access, permission: "users.manage" }, async (tx, actor) => {
      const target = await checkTarget(tx, actor.tenantId, actor.userId);
      return { tenantId: actor.tenantId, targetUserId: target.userId };
    });
    tenantIdForCleanup = pre.tenantId;
    // (2) işaretli kayıt: wms_app transaction'ı ve users kilidi dışında.
    const created = await port.createToken(pre.targetUserId, pre.tenantId);
    createdVerificationId = created.verificationId;
    // (3) üretim transaction'ı: tüm denetimler yeniden; tenant kimliği önceden çözülmüştür (recentAuth (1)'de geçti).
    const { recentAuth: _recentAuth, tenantSlug: _slug, ...rest } = access;
    void _recentAuth;
    void _slug;
    issued = await runTenantCommandById({ ...rest, tenantId: pre.tenantId, permission: "users.manage" }, async (tx, actor) => {
      const target = await checkTarget(tx, actor.tenantId, actor.userId);
      if (target.userId !== pre.targetUserId) throw deny("NOT_MEMBER"); // (1)-(3) arasında üyelik başka kullanıcıya geçmiş olamaz; fail-closed
      const exclusive = await tx.execute<{ ok: boolean }>(
        sql`SELECT wms_probe.identity_exclusive_to_tenant(${target.userId}::uuid) AS ok`,
      );
      if (exclusive[0]?.ok !== true) throw deny("IDENTITY_SHARED");
      await tx.execute(
        sql`INSERT INTO public.admin_reset_grants (user_id, issuing_tenant_id, issuing_membership_id, verification_id, expires_at)
            VALUES (${target.userId}::uuid, ${actor.tenantId}::uuid, ${actor.membershipId}::uuid, ${created.verificationId}::uuid,
                    ${created.expiresAt.toISOString()}::timestamptz)`,
      );
      await appendAudit(tx, {
        action: "password_reset_link.issued",
        actorUserId: actor.userId,
        entityType: "membership",
        entityId: target.id,
        requestId: requestId ?? null,
        changeSummary: { status: "issued", expires_at: created.expiresAt.toISOString() },
      });
      return {
        token: created.token,
        expiresAt: created.expiresAt,
        targetUserId: target.userId,
        tenantId: actor.tenantId,
        adminUserId: actor.userId,
        membershipId: actor.membershipId,
        targetMembershipId: target.id,
      };
    });
    await port.recordIssued({
      targetUserId: issued.targetUserId,
      issuingTenantId: issued.tenantId,
      adminUserId: issued.adminUserId,
      issuingMembershipId: issued.membershipId,
    });
  } catch (e) {
    if (createdVerificationId !== undefined) {
      try {
        await port.discardToken(createdVerificationId);
      } catch (cleanup) {
        const c = cleanup as { name?: unknown } | null;
        deps.log?.({ level: "error", msg: "password reset token cleanup failed", error: typeof c?.name === "string" ? c.name : "unknown" });
      }
    }
    // Audit commit edildi ama olay yazılamadı: kayıt "üretildi" diyor → telafi satırı (best-effort, yutulmaz: loglanır).
    if (issued !== undefined && tenantIdForCleanup !== undefined) {
      const done = issued;
      try {
        const { recentAuth: _r, tenantSlug: _s, ...rest } = access;
        void _r;
        void _s;
        await runTenantCommandById({ ...rest, tenantId: done.tenantId, permission: "users.manage" }, (tx, actor) =>
          appendAudit(tx, {
            action: "password_reset_link.issued",
            actorUserId: actor.userId,
            entityType: "membership",
            entityId: done.targetMembershipId,
            requestId: requestId ?? null,
            changeSummary: { status: "revoked_before_delivery" },
          }),
        );
      } catch (comp) {
        const c = comp as { name?: unknown } | null;
        deps.log?.({ level: "error", msg: "password reset compensating audit failed", error: typeof c?.name === "string" ? c.name : "unknown" });
      }
    }
    throw mapMembershipError(e);
  }
  return { token: issued.token, expiresAt: issued.expiresAt };
}

// ---------------------------------------------------------------------------------------------
// Self-servis sıfırlama e-postası bağdaştırıcısı (A-42; T-116 `email.send`)
// ---------------------------------------------------------------------------------------------

export interface ResetMailPortDeps {
  readonly mailConfig: MailConfig;
  /** Yalnızca `enqueuePlatform` kullanılır (tenant'sız iş; yük mühürlü, düz belirteç yok). */
  readonly queue: Pick<JobQueue, "enqueuePlatform">;
  /** Mühür anahtarı ya da mühürleyici (`@wms/shared/seal`); yoksa kuyruğa yazılamaz (açık hata). */
  readonly sealKey: Sealer | string | undefined;
}

/** `@wms/auth` `CreateAuthParams.resetMail` için: `canDeliver` true ise `email.send` platform işi yazar. */
export function createResetMailPort(deps: ResetMailPortDeps): {
  canDeliver(recipient: string): boolean;
  sendResetLink(input: { to: string; link: string; locale: "tr" | "en" }): Promise<void>;
} {
  return {
    canDeliver: (recipient) => canDeliver(deps.mailConfig, recipient),
    async sendResetLink(input) {
      if (!canDeliver(deps.mailConfig, input.to)) throw new AppError("VALIDATION_FAILED");
      const payload = buildEmailSendPayload(deps.sealKey, { template: "password_reset", tenantId: null, locale: input.locale, to: input.to, link: input.link });
      await deps.queue.enqueuePlatform({ type: "email.send", payload: { ...payload, sealed: { ...payload.sealed } } });
    },
  };
}
