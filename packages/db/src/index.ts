// `@wms/db` genel yüzeyi (T-005b). Bilerek dar: ham istemci, TenantContext oluşturucusu ve
// sürücü ayarları yalnızca `@wms/db/internal` alt yolundadır (lint ile korunur).
export { createDbClient } from "./client.ts";
export type { TenantContext } from "./client.ts";
export { withTenant } from "./with-tenant.ts";
