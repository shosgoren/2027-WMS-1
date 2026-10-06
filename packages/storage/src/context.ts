// Depolama bağlamı üreticisi + marka WeakSet'i (T-125, security MAJOR @7e66131).
// Bu modül package.json `exports`'ta YOKTUR: yalnızca `index.ts` (ve aynı paketin testleri) içeriden import eder; böylece
// başka paket `issue…(body.tenantId)` ile bağlam sahteleyemez. Üretici tenant kimliğini çağırandan değil, yalnızca
// `index.ts`'in tx oturum ayarından okuduğu değerle çağırır.
import { AppError } from "@wms/shared/errors";
import type { StorageContext } from "@wms/shared/storage";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const issued = new WeakSet<object>();

export function issueStorageContextFromVerifiedTenant(verifiedTenantId: unknown): StorageContext {
  if (typeof verifiedTenantId !== "string" || !UUID_RE.test(verifiedTenantId)) throw new AppError("FORBIDDEN");
  const ctx = Object.freeze({ tenantId: verifiedTenantId.toLowerCase() }) as unknown as StorageContext;
  issued.add(ctx);
  return ctx;
}

export function isIssuedStorageContext(ctx: unknown): ctx is StorageContext {
  return typeof ctx === "object" && ctx !== null && issued.has(ctx);
}
