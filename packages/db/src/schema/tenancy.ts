// Tenant/üyelik tabloları (T-103, ADR-016 §2-3, §9) — `0003_tenancy` ile birebir.
//
// - RLS'li tenant tabloları: tenants (id tenant kimliğidir; tenant_id sütunu yok), tenant_memberships,
//   membership_roles, invitations, tenant_settings (PK tenant_id). Politikalar ve yetkiler migration'dadır.
// - `admin_reset_grants` platform (RLS'siz) tablosudur; `wms_app` yalnızca INSERT yapabilir.
// - Tablo nesneleri yalnızca `@wms/db/internal/schema` alt yolundan açılır, genel yüzeye yalnızca tipler çıkar.
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const TENANT_STATUSES = ["ACTIVE", "SUSPENDED", "CLOSING"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ["ACTIVE", "REMOVED"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** Hazır roller (ADR-016 §4). İzin matrisi `packages/domain`'dedir (T-113); db yalnızca anahtarları bilir. */
export const ROLE_KEYS = ["TENANT_ADMIN", "WAREHOUSE_MANAGER", "PICKER", "COUNTER", "READ_ONLY"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const INVITATION_DELIVERIES = ["EMAIL", "SCREEN"] as const;
export type InvitationDelivery = (typeof INVITATION_DELIVERIES)[number];

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique("tenants_slug_key"),
  name: text("name").notNull(),
  status: text("status").$type<TenantStatus>().notNull().default("ACTIVE"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdByUserId: uuid("created_by_user_id"),
  creationRequestId: uuid("creation_request_id"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull(),
    status: text("status").$type<MembershipStatus>().notNull().default("ACTIVE"),
    isOwner: boolean("is_owner").notNull().default(false),
    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    removedAt: timestamptz("removed_at"),
    rolesVersion: integer("roles_version").notNull().default(0),
  },
  (t) => [index("tenant_memberships_user_id_idx").on(t.userId)],
);

export const membershipRoles = pgTable("membership_roles", {
  tenantId: uuid("tenant_id").notNull(),
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  membershipId: uuid("membership_id").notNull(),
  roleKey: text("role_key").$type<RoleKey>().notNull(),
});

export const invitations = pgTable("invitations", {
  tenantId: uuid("tenant_id").notNull(),
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  emailNormalized: text("email_normalized").notNull(),
  roleKey: text("role_key").$type<RoleKey>().notNull(),
  tokenHash: text("token_hash").notNull().unique("invitations_token_hash_key"),
  deliveredVia: text("delivered_via").$type<InvitationDelivery>().notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  acceptedAt: timestamptz("accepted_at"),
  revokedAt: timestamptz("revoked_at"),
  invitedByMembershipId: uuid("invited_by_membership_id").notNull(),
  claimId: uuid("claim_id"),
  claimExpiresAt: timestamptz("claim_expires_at"),
});

export const tenantSettings = pgTable("tenant_settings", {
  tenantId: uuid("tenant_id").primaryKey(),
  locale: text("locale").notNull(),
  timeZone: text("time_zone").notNull(),
  sectorTemplateKey: text("sector_template_key"),
  sectorTemplateVersion: integer("sector_template_version"),
  terminology: jsonb("terminology").notNull().default(sql`'{}'::jsonb`),
  onboardingStatus: text("onboarding_status").notNull(),
  onboardingSteps: jsonb("onboarding_steps").notNull().default(sql`'[]'::jsonb`),
  // T-301 (A-06): mal kabulde kalite kontrol varsayılan açık; wms_app yalnızca bu sütunu ek olarak UPDATE eder.
  receivingQcEnabled: boolean("receiving_qc_enabled").notNull().default(true),
  // T-302 (A-136): terk edilmiş sayım süresi (saat, 1-168); wms_app yalnızca bu sütunu ek olarak UPDATE eder.
  countAbandonHours: smallint("count_abandon_hours").notNull().default(8),
});

export const adminResetGrants = pgTable(
  "admin_reset_grants",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull(),
    issuingTenantId: uuid("issuing_tenant_id").notNull(),
    issuingMembershipId: uuid("issuing_membership_id").notNull(),
    verificationId: uuid("verification_id").notNull().unique("admin_reset_grants_verification_id_key"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [index("admin_reset_grants_user_id_idx").on(t.userId)],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type NewTenantMembership = typeof tenantMemberships.$inferInsert;
export type MembershipRole = typeof membershipRoles.$inferSelect;
export type NewMembershipRole = typeof membershipRoles.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type TenantSettings = typeof tenantSettings.$inferSelect;
export type NewTenantSettings = typeof tenantSettings.$inferInsert;
export type AdminResetGrant = typeof adminResetGrants.$inferSelect;
export type NewAdminResetGrant = typeof adminResetGrants.$inferInsert;
