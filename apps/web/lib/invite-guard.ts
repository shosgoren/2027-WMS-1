// Davet önizleme sayfası hız sınırı koruması (T-117d). Sayfa render'ı DB'ye belirteç sorar: T-127 IP sınırına bağlıdır.
// IP çözülemezse (üretimde `Fly-Client-IP` yok → `clientIp` FORBIDDEN) ve sınır aşımında sayfa 500 vermez: belirteçli URL
// hata günlüğüne düşmez; çağıran tek tip nötr metin gösterir. Beklenmeyen hatalar (DB/sır yok) fail-closed olarak fırlar.
import { AppError } from "@wms/shared/errors";
import { RateLimitedError, clientIp, type RateLimiter } from "./rate-limit.ts";

export type InviteGuardResult = "ok" | "rate_limited" | "unavailable";

export async function guardInvitePreview(headers: Headers, limiter: RateLimiter): Promise<InviteGuardResult> {
  let ip: string;
  try {
    ip = clientIp(headers);
  } catch (e) {
    if (e instanceof AppError && e.code === "FORBIDDEN") return "unavailable";
    throw e;
  }
  try {
    await limiter.check("ip", ip);
  } catch (e) {
    if (e instanceof RateLimitedError) return "rate_limited";
    throw e;
  }
  return "ok";
}
