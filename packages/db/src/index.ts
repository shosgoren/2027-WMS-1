// `@wms/db` genel yüzeyi (T-005b). Bilerek dar: ham istemci, TenantContext oluşturucusu ve
// sürücü ayarları yalnızca `@wms/db/internal` alt yolundadır (lint ile korunur).
export { createDbClient } from "./client.ts";
export type { TenantContext } from "./client.ts";
export { currentTenantId, currentUserId, withTenant } from "./with-tenant.ts";
export { MembershipError, lockOwners, withMembership, withNewTenant, withSystemTenant, withUser } from "./with-membership.ts";
export type {
  Membership,
  MembershipErrorCode,
  MembershipPermission,
  NewTenantOwner,
  NewTenantParams,
  WithMembershipParams,
} from "./with-membership.ts";
// Kimlik tabloları: yalnızca TİPLER (T-102); tablo nesneleri `@wms/db/internal/schema` alt yolundadır.
export type {
  Account,
  AuthRateLimit,
  NewAccount,
  NewAuthRateLimit,
  NewSecurityEvent,
  NewSession,
  NewTwoFactor,
  NewUser,
  NewVerification,
  SecurityEvent,
  Session,
  TwoFactor,
  User,
  Verification,
} from "./schema/identity.ts";
// Tenant/üyelik tabloları: yalnızca TİPLER (T-103); tablo nesneleri `@wms/db/internal/schema` alt yolundadır.
export type {
  AdminResetGrant,
  Invitation,
  InvitationDelivery,
  MembershipRole,
  MembershipStatus,
  NewAdminResetGrant,
  NewInvitation,
  NewMembershipRole,
  NewTenant,
  NewTenantMembership,
  NewTenantSettings,
  RoleKey,
  Tenant,
  TenantMembership,
  TenantSettings,
  TenantStatus,
} from "./schema/tenancy.ts";
// Audit (T-107): `appendAudit` yalnızca withMembership/withSystemTenant/withNewTenant transaction'ında kullanılır.
export { AUDIT_ACTIONS, AuditError, CHANGE_SUMMARY_MAX_BYTES, REDACTED, appendAudit, isSensitiveKey, looksSensitiveValue, maskChangeSummary, recordSecurityEvent } from "./audit.ts";
export type { AppendedAudit, AuditAction, AuditEntry, JsonValue, SecurityEventInput } from "./audit.ts";
export type { AuditLog, NewAuditLog, NewRequestRateLimit, RequestRateLimit } from "./schema/audit.ts";
