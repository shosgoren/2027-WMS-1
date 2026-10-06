// Kuyruk tüketici sözleşmesi (ADR-019 §2-4, I-07): `processed_events` ile etkide tam bir kez.
//
// - `consumeOnce`: DB yan etkisi `processed_events` satırıyla AYNI transaction'da; satır zaten varsa `fn` çalışmaz.
// - `deliverExternalOnce`: haricî çağrı (e-posta vb.). Satır varsa çağrı yok; yoksa `call(idempotencyKey = jobId)` ve
//   BAŞARIYLA dönerse ayrı kısa transaction'da satır. Satır yazımı başarısız olursa iş hata verir ve yeniden teslimde çağrı
//   aynı anahtarla tekrarlanır (haricî tarafın tekilleştirmesine güvenilir; ADR-019 §4).
// - Tüm yazımlar `wms_app` bağlantısıyla (ADR-019 §1): tenant işinde `ctx.inTenant` (tenant_id = bağlam), platform
//   işinde (`enqueuePlatform`) tenant bağlamı BOŞ transaction (`ctx.inPlatform`, tenant_id NULL). Tenant kimliği
//   parametre değildir: her zaman transaction-local `app.current_tenant_id` ayarından türetilir (G-02).
import { currentTenantId } from "@wms/db";
import { QueueError } from "@wms/shared/queue";
import { sql } from "drizzle-orm";
import type { TenantTx } from "./index.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSUMER_MAX = 200;

/** `processed_events_consumer_chk` ile aynı kısıt: boş olmayan, ≤ 200 karakter. */
function assertArgs(consumer: unknown, eventId: unknown): asserts eventId is string {
  if (typeof consumer !== "string" || consumer.trim() === "" || consumer.length > CONSUMER_MAX) {
    throw new QueueError("VALIDATION_FAILED", "consumer must be a non-empty string (max 200)");
  }
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) {
    throw new QueueError("VALIDATION_FAILED", "eventId must be a UUID (queue job id)");
  }
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

/** `(tenant_id, consumer, event_id)` satırını yazar; yeni satır eklendiyse `true`. Tenant bağlamdan türer. */
async function insertProcessed(tx: TenantTx, consumer: string, eventId: string): Promise<boolean> {
  // Tenant kimliği çağıranın parametresi DEĞİL, transaction bağlamından okunur (`currentTenantId`); bağlam boşsa NULL
  // (platform işi). RLS `WITH CHECK` değeri ayrıca bağlamla eşitler.
  const tenantId = (await currentTenantId(tx)) ?? null;
  const result: unknown = await tx.execute(
    sql`INSERT INTO processed_events (tenant_id, consumer, event_id)
        VALUES (${tenantId}::uuid, ${consumer}, ${eventId}::uuid)
        ON CONFLICT DO NOTHING
        RETURNING 1 AS one`,
  );
  return rowCount(result) > 0;
}

/** Bu bağlamda (tenant ya da platform; RLS süzer) satır var mı. */
async function hasProcessed(tx: TenantTx, consumer: string, eventId: string): Promise<boolean> {
  const result: unknown = await tx.execute(
    sql`SELECT 1 AS one FROM processed_events
        WHERE consumer = ${consumer} AND event_id = ${eventId}::uuid LIMIT 1`,
  );
  return rowCount(result) > 0;
}

export type ConsumeOnceResult<R> = { readonly applied: true; readonly result: R } | { readonly applied: false };

/**
 * `fn(tx)`'i en fazla bir kez uygular: `processed_events` satırı eklenemezse (aynı bağlamda, aynı tüketici, aynı olay
 * zaten işlenmiş) `fn` çalışmaz ve `{ applied: false }` döner (sessiz onay). Eşzamanlı ikinci transaction birincinin
 * commit/rollback'ini bekler (tekillik kısıtı). `fn` hata fırlatırsa satır dahil her şey geri alınır.
 */
export async function consumeOnce<R>(
  tx: TenantTx,
  consumer: string,
  eventId: string,
  fn: (tx: TenantTx) => Promise<R>,
): Promise<ConsumeOnceResult<R>> {
  assertArgs(consumer, eventId);
  if (!(await insertProcessed(tx, consumer, eventId))) return { applied: false };
  return { applied: true, result: await fn(tx) };
}

/** `deliverExternalOnce`'ın ihtiyaç duyduğu iş bağlamı alt kümesi (`JobContext` ile uyumlu). */
export interface ExternalOnceContext {
  readonly jobId: string;
  readonly hasTenant: boolean;
  inTenant<R>(fn: (tx: unknown) => Promise<R>): Promise<R>;
  inPlatform<R>(fn: (tx: unknown) => Promise<R>): Promise<R>;
}

/**
 * Haricî çağrıyı en fazla bir kez (başarıyla) yapar. `call` transaction DIŞINDA çalışır ve idempotency anahtarı olarak
 * `ctx.jobId`'i alır (ADR-019 §4; çağıran isterse başka anahtar türetebilir, örn. davet). Dönüş: çağrı yapıldıysa `true`,
 * önceden işlenmişse `false`. `call` hata fırlatırsa satır yazılmaz ve hata aynen yayılır (yeniden deneme).
 */
export async function deliverExternalOnce(
  ctx: ExternalOnceContext,
  consumer: string,
  call: (idempotencyKey: string) => Promise<void>,
): Promise<boolean> {
  assertArgs(consumer, ctx.jobId);
  const run = <R>(fn: (tx: TenantTx) => Promise<R>): Promise<R> =>
    ctx.hasTenant ? ctx.inTenant((tx) => fn(tx as TenantTx)) : ctx.inPlatform((tx) => fn(tx as TenantTx));
  if (await run((tx) => hasProcessed(tx, consumer, ctx.jobId))) return false;
  await call(ctx.jobId);
  // Ayrı kısa transaction: `ON CONFLICT DO NOTHING` eşzamanlı başka teslimin satırını sorun etmez.
  await run((tx) => insertProcessed(tx, consumer, ctx.jobId));
  return true;
}
