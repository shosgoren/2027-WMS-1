// `@wms/db` genel yüzeyi (T-005b). Bilerek dar: ham istemci, TenantContext oluşturucusu ve
// sürücü ayarları yalnızca `@wms/db/internal` alt yolundadır (lint ile korunur).
import { DB_CLIENT_SETTINGS, createDbClient, type DbClient } from "./client.ts";
export { createDbClient } from "./client.ts";
export type { DbClient, TenantContext } from "./client.ts";

const APP_DB_KEY = Symbol.for("@wms/db/app-db");

/**
 * Web sürecinin veritabanına eriştiği TEK nokta (T-117 / T-127a): `DATABASE_URL` (yalnızca uygulama rolü `wms_app`,
 * pooler) ile süreç başına tek havuz. Tekil `globalThis` üzerinde tutulur (dev hot-reload modülü yeniden yükleyince yeni
 * havuz açılmaz). Ayarlar `DB_CLIENT_SETTINGS`. `DATABASE_URL` yoksa hata (URL değeri mesaja girmez, G-09).
 */
export function getAppDb(): DbClient {
  const g = globalThis as { [APP_DB_KEY]?: DbClient };
  const existing = g[APP_DB_KEY];
  if (existing !== undefined) return existing;
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === "") throw new Error("getAppDb: DATABASE_URL is not configured");
  const client = createDbClient({ url, ...DB_CLIENT_SETTINGS });
  g[APP_DB_KEY] = client;
  return client;
}
export { currentTenantId, currentUserId, withTenant } from "./with-tenant.ts";
export { MembershipError, lockOwners, withMembership, withInvitationTenant, withNewTenant, withSystemTenant, withUser } from "./with-membership.ts";
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
// Bağlantı hedefi karşılaştırması (connection-target.ts, yan etkisiz): kuyruk kurulum CLI'ı uygulama bağlantısını reddetmek için kullanır.
export { consumeRateLimit } from "./rate-limit.ts";
export type { ConsumeRateLimitParams, ConsumeRateLimitResult } from "./rate-limit.ts";
export { sameConnectionTarget } from "./connection-target.ts";
// Demo tenant kimliği (T-123): slug'tan türetilen sabit; worker ve domain aynı sabiti kullanır. `ensureDemoTenant` yalnızca migrate.ts'tedir.
export { DEMO_TENANT_ID, DEMO_TENANT_NAME, DEMO_TENANT_NAMESPACE, DEMO_TENANT_SLUG, demoModeEnabled, uuidV5 } from "./demo-tenant.ts";
// Sağlık yoklamaları (T-129): `/api/health` DB ve kuyruk şeması erişimi (satır okumaz).
export { createHealthProbe, getHealthProbe } from "./health.ts";
export type { HealthProbe, HealthProbeOptions, HealthSnapshot, ProbeResult } from "./health.ts";
