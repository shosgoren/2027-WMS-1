// Rol × izin matrisi (ADR-016 §4, OPEN_QUESTIONS A-45). TEK KAYNAK: değişiklik A-45/Q-22 güncellemesi ister.
// Görev ayrımı (A-03) bu dosyada yoktur. Depo kapsamı yoktur (A-46: Faz 1 yetkisi tenant kapsamlıdır).
import type { Membership } from "@wms/db";

export const ROLE_KEYS = ["TENANT_ADMIN", "WAREHOUSE_MANAGER", "PICKER", "COUNTER", "READ_ONLY"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const PERMISSIONS = [
  "stock.view",
  "document.create",
  "document.approve",
  "stock.post",
  "reversal.create",
  "count_diff.approve",
  "takeout.request",
  "settings.manage",
  "users.manage",
  "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Derleme zamanı: bu dosyadaki RoleKey ile `@wms/db` üyelik rolü aynı küme olmalı.
type DbRoleKey = Membership["roles"][number];
const _roleKeysMatchDb: [RoleKey] extends [DbRoleKey] ? ([DbRoleKey] extends [RoleKey] ? true : never) : never = true;
void _roleKeysMatchDb;

export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly Permission[]>> = {
  TENANT_ADMIN: PERMISSIONS,
  WAREHOUSE_MANAGER: [
    "stock.view",
    "document.create",
    "document.approve",
    "stock.post",
    "reversal.create",
    "count_diff.approve",
    "audit.view",
  ],
  PICKER: ["stock.view", "stock.post"],
  COUNTER: ["stock.view", "document.create"],
  READ_ONLY: ["stock.view"],
};

/** Rollerden en az biri izni taşıyorsa `true`. Bilinmeyen rol/izin → `false`. */
export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  return roles.some((role) => {
    if (!Object.hasOwn(ROLE_PERMISSIONS, role)) return false;
    return (ROLE_PERMISSIONS as Readonly<Record<string, readonly Permission[]>>)[role]?.includes(permission) === true;
  });
}
