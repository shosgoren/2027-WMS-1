// Platform kimlik tabloları (T-102, ADR-014 §10/§12, ADR-016 §1) — `0002_identity` ile birebir.
//
// - RLS YOK: global platform tabloları (tenant tablosu değil); koruma tablo yetkileridir
//   (Better Auth tablolarında yalnızca `wms_auth`; bkz. migration başı).
// - Alanlar Better Auth 1.7.7 çekirdek + `twoFactor` şemasından; ad eşlemesi: çoğul snake_case.
// - BİLİNÇLİ EKLER (Better Auth çekirdek şemasında YOK; drift testinde istisna):
//     `sessions.mfa_verified_at`   (ADR-014 §12; session.additionalFields, input:false)
//     `users.invitation_claim_id`  (ADR-016 3. tur m7; user.additionalFields, input:false)
// - Sürücüsüz alt yol (`drizzle-orm/pg-core`); tablo nesneleri yalnızca `@wms/db/internal/schema`
//   alt yolundan açılır, genel yüzeye yalnızca tipler çıkar.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `xid8` (PostgreSQL işlem kimliği, 64 bit); sürücü metin döndürür. */
const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique("users_email_key"),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  invitationClaimId: uuid("invitation_claim_id"),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    expiresAt: timestamptz("expires_at").notNull(),
    token: text("token").notNull().unique("sessions_token_key"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mfaVerifiedAt: timestamptz("mfa_verified_at"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const twoFactors = pgTable(
  "two_factors",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamptz("locked_until"),
  },
  (t) => [index("two_factors_user_id_idx").on(t.userId)],
);

export const authRateLimits = pgTable("auth_rate_limits", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  keyHash: text("key_hash").notNull().unique("auth_rate_limits_key_hash_key"),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    userId: uuid("user_id"),
    eventType: text("event_type").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdXid: xid8("created_xid")
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [index("security_events_user_occurred_idx").on(t.userId, t.occurredAt)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
export type TwoFactor = typeof twoFactors.$inferSelect;
export type NewTwoFactor = typeof twoFactors.$inferInsert;
export type AuthRateLimit = typeof authRateLimits.$inferSelect;
export type NewAuthRateLimit = typeof authRateLimits.$inferInsert;
export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;
