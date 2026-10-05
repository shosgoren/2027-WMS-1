// `@wms/db` genel yüzeyi (T-005b). Bilerek dar: ham istemci, TenantContext oluşturucusu ve
// sürücü ayarları yalnızca `@wms/db/internal` alt yolundadır (lint ile korunur).
export { createDbClient } from "./client.ts";
export type { TenantContext } from "./client.ts";
export { withTenant } from "./with-tenant.ts";
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
