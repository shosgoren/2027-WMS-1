// Genel hız sınırı sayacı (T-127; `request_rate_limits`, T-107). Platform tablosudur (RLS yok, tenant bağlamı gerekmez);
// uygulama rolü (`wms_app`) bağlantısıyla tek transaction içinde TEK ifade çalışır (atomik UPSERT, okuma-sonra-yazma yok).
// Anahtar özetini (HMAC-SHA-256, 64 onaltılık) çağıran üretir: DB ham IP/kullanıcı/tenant değerini görmez.
import { sql } from "drizzle-orm";
import { rawDb, type DbClient } from "./client.ts";

export interface ConsumeRateLimitParams {
  /** Kapsam adı (`^[a-z][a-z0-9_.:-]{0,63}$`; DB CHECK). */
  readonly scope: string;
  /** 64 onaltılık küçük harf özet (DB CHECK). */
  readonly keyHash: string;
  readonly limit: number;
  readonly windowSeconds: number;
  /** Test için saat enjeksiyonu. */
  readonly now?: Date;
}

export interface ConsumeRateLimitResult {
  readonly allowed: boolean;
  /** Bu pencerede, bu istek dahil sayaç. */
  readonly count: number;
  /** Pencere bitimine kalan saniye (>=1). */
  readonly retryAfterSeconds: number;
}

/** Sabit pencere sayacını bir artırır; `count > limit` ise `allowed: false`. */
export async function consumeRateLimit(client: DbClient, p: ConsumeRateLimitParams): Promise<ConsumeRateLimitResult> {
  if (!Number.isInteger(p.limit) || p.limit < 1) throw new RangeError("consumeRateLimit: limit must be a positive integer");
  if (!Number.isInteger(p.windowSeconds) || p.windowSeconds < 1) throw new RangeError("consumeRateLimit: windowSeconds must be a positive integer");
  const windowMs = p.windowSeconds * 1000;
  const t = (p.now ?? new Date()).getTime();
  const start = new Date(Math.floor(t / windowMs) * windowMs);
  const rows = await rawDb(client).transaction(async (tx) =>
    tx.execute<{ count: number | string }>(sql`
      INSERT INTO public.request_rate_limits (scope, key_hash, window_start, count)
      VALUES (${p.scope}, ${p.keyHash}, ${start.toISOString()}::timestamptz, 1)
      ON CONFLICT (scope, key_hash, window_start)
      DO UPDATE SET count = public.request_rate_limits.count + 1
      RETURNING count`),
  );
  const row = rows[0];
  if (row === undefined) throw new Error("consumeRateLimit: RETURNING row missing");
  const count = Number(row.count);
  return {
    allowed: count <= p.limit,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((start.getTime() + windowMs - t) / 1000)),
  };
}
