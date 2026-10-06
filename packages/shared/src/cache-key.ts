// Tenant kapsamlı önbellek anahtarı (T-125; 02 §Tenant bağlamı: "cache anahtarı tenant kapsamlıdır").
// Her önbellek kullanımı bu yardımcıyı kullanır; anahtar `t:<tenantId>:<namespace>:<parça>:…`.
// Tenant kimliği yalnızca doğrulanmış bağlamdan (`StorageContext` ile aynı markalı kimlik) gelir; düz dizgi kabul edilmez.
// Ayırıcı `:` parçalarda KAÇIRILIR (`%3A`), böylece parça birleşimiyle başka tenant/namespace anahtarı üretilemez.
import { AppError } from "./errors.ts";
import { isIssuedStorageContext, type StorageContext } from "./storage.ts";

const LONE_SURROGATE_RE = /\p{Surrogate}/u;
const NAMESPACE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function escapePart(part: string): string {
  return part.replaceAll("%", "%25").replaceAll(":", "%3A");
}

export function tenantCacheKey(ctx: StorageContext, namespace: string, ...parts: readonly string[]): string {
  if (!isIssuedStorageContext(ctx)) throw new AppError("FORBIDDEN");
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) throw new AppError("VALIDATION_FAILED");
  for (const p of parts) {
    if (typeof p !== "string" || p === "" || LONE_SURROGATE_RE.test(p)) throw new AppError("VALIDATION_FAILED");
  }
  return ["t", ctx.tenantId, namespace, ...parts.map(escapePart)].join(":");
}
