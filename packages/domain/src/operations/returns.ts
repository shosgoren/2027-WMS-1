// Müşteri iadesi (T-308; ADR-021 §3, 16 Temel kurallar 4 ve 6, Senaryo A adım 8, Senaryo D adım 9, A-135, A-150, A-154).
//
// `createCustomerReturn` (`stock.post`): orijinal sevk satırına (sipariş satırı) bağlı iade: primitif `STOCK_IN` belgesi, defter nedeni `RETURN`,
// `+quantity` hedef deponun seçilen `RECEIVING` lokasyonunda `QUARANTINE` boyutuna (iade stoğu kullanılabilir/sevke uygun sayılmaz; AC-08). Belge kaynağı
// `SALES_ORDER` (kaynak satır = sipariş satırı; `customer_returns` başlığı açılmaz, A-308-5). `returned_quantity` artar; AÇIK MİKTAR DEĞİŞMEZ ve sipariş yeniden
// açılmaz (kural 6): kapanmış siparişte yalnız `returned_quantity` değişebilir (0016 `field_docs_lines_guard_closed`, A-154).
//
// Üst sınır (A-135/A-150): `quantity ≤ shipped − returned`; aksi `VALIDATION_FAILED`/`RETURN_EXCEEDS_SHIPPED`. Sınır DB CHECK'i değildir (A-150), komut kuralıdır ve
// sipariş satırı `FOR UPDATE` kilitliyken denetlenir: eşzamanlı iki iade toplamı sevki aşamaz.
//
// Kilit sırası (I-15): stok kilitleri (`acquireStockLocks`; hedef boyut önceden bildirilir) → sipariş başlığı `FOR UPDATE` → sipariş satırı `FOR UPDATE` → belge ve
// satır yazımı. Başlık stoktan ÖNCE alınmaz.
//
// A-xx (docs/OPEN_QUESTIONS.md): A-308-4 iade nedeni zorunlu (boş değil, ≤ 500, kontrol karakteri yok) ve `documents.reason` alanına yazılır; A-308-5 iade belgesi
// kaynağı `SALES_ORDER`+sipariş satırı (iade başlığı/satırı tabloları UI kartında devreye girer); A-308-6 iade deposu sevk deposundan bağımsızdır: seçilen `RECEIVING`
// lokasyonun deposu (kapsam denetimi motordadır); A-308-7 takipli (lot/seri) ürünün iadesi bu komutta yoktur (lot/seri taşınmaz → çekirdek `TRACKING_VIOLATION`).
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import {
  executeStockCommand,
  type StockCommandApplied,
  type StockCommandOutcome,
  type StockCommandPlan,
  type StockCommandResult,
  type StockDocCallParams,
} from "../stock/index.ts";
import { toMicro } from "../stock/plan.ts";
import {
  DECIMAL_RE,
  baseQuantityOf,
  decimalToMicro,
  emptyPlan,
  microToDecimal,
  planFieldPosting,
  postFieldDocument,
  uuidOf,
  type FieldLine,
} from "./field-posting.ts";

const PLAN_UNIT = "00000000-0000-0000-0000-000000000000";
const REASON_MAX = 500;
const CONTROL_RE = /\p{C}/u;
const invalid = (): AppError => new AppError("VALIDATION_FAILED");

export interface CreateCustomerReturnInput {
  readonly orderLineId: string;
  /** Temel birimde pozitif ondalık dizgi (sipariş satırı birim saklamaz, A-306-1). */
  readonly quantity: string;
  /** Hedef deponun `RECEIVING` türünde lokasyonu. */
  readonly locationId: string;
  readonly reason: string;
  readonly requestId?: string | null;
}

/** A-308-4: boş olmayan, ≤ 500 karakter, kontrol karakteri içermeyen neden (kırpılmış hâli saklanır). */
export function parseReturnReason(raw: unknown): string {
  if (typeof raw !== "string") throw invalid();
  const v = raw.trim();
  if (v === "" || v.length > REASON_MAX || CONTROL_RE.test(v)) throw invalid();
  return v;
}

/** A-135: iade edilebilir miktar = sevk − önceki iadeler (negatif olamaz). */
export function returnableOf(shipped: bigint, returned: bigint): bigint {
  const r = shipped - returned;
  return r < 0n ? 0n : r;
}

/** `stock.post`: bkz. dosya başı. */
export async function createCustomerReturn(params: StockDocCallParams, input: CreateCustomerReturnInput): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const orderLineId = uuidOf(input.orderLineId);
  const locationId = uuidOf(input.locationId);
  if (typeof input.quantity !== "string" || !DECIMAL_RE.test(input.quantity)) throw invalid();
  const quantity = input.quantity;
  const qty = decimalToMicro(quantity);
  if (qty <= 0n) throw invalid();
  const reason = parseReturnReason(input.reason);
  const requestId = input.requestId ?? null;
  const hashInput = { orderLineId, quantity, locationId, reason };

  const outcome: StockCommandOutcome<StockCommandResult> = await executeStockCommand<typeof hashInput, StockCommandResult>({
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    commandType: "sales_order.customer_return",
    permission: "stock.post",
    input: hashInput,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    plan: async (tx, _i, m): Promise<StockCommandPlan> => {
      const loc = await tx.execute<{ warehouse_id: string }>(
        sql`SELECT warehouse_id FROM public.locations WHERE tenant_id = ${m.tenantId}::uuid AND id = ${locationId}::uuid`,
      );
      const line = await tx.execute<{ order_id: string; item_id: string }>(
        sql`SELECT order_id, item_id FROM public.sales_order_lines WHERE tenant_id = ${m.tenantId}::uuid AND id = ${orderLineId}::uuid`,
      );
      const warehouses = loc.map((l) => l.warehouse_id.toLowerCase());
      const l = line[0];
      if (l === undefined || loc[0] === undefined) return emptyPlan(warehouses); // apply kilit altında NOT_FOUND verir
      try {
        return await planFieldPosting(tx, m.tenantId, {
          kind: "STOCK_IN",
          warehouseId: loc[0].warehouse_id,
          sourceKind: "SALES_ORDER",
          sourceId: l.order_id,
          lines: [inLine(l.item_id, PLAN_UNIT, quantity, locationId, orderLineId)],
          ledgerReason: "RETURN",
        });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        return emptyPlan(warehouses);
      }
    },
    apply: async (tx, locked, ctx): Promise<StockCommandApplied> => {
      const known = await tx.execute<{ order_id: string }>(
        sql`SELECT order_id FROM public.sales_order_lines WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderLineId}::uuid`,
      );
      if (known[0] === undefined) throw new AppError("NOT_FOUND");
      const orderId = known[0].order_id.toLowerCase();
      // Kilit sırası: stok (alındı) → sipariş başlığı → sipariş satırı. Durum sınırı YOK: iade kapanmış siparişte de gelir (kural 6, A-154).
      const head = await tx.execute<{ id: string }>(
        sql`SELECT id FROM public.sales_orders WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderId}::uuid FOR UPDATE`,
      );
      if (head[0] === undefined) throw new AppError("NOT_FOUND");
      const rows = await tx.execute<{ item_id: string; shipped: string; returned: string }>(
        sql`SELECT item_id, shipped_quantity::text AS shipped, returned_quantity::text AS returned
              FROM public.sales_order_lines WHERE tenant_id = ${ctx.tenantId}::uuid AND order_id = ${orderId}::uuid AND id = ${orderLineId}::uuid FOR UPDATE`,
      );
      const line = rows[0];
      if (line === undefined) throw new AppError("NOT_FOUND"); // A-152: satır gerçekten bu siparişe ait
      if (qty > returnableOf(toMicro(line.shipped), toMicro(line.returned))) throw new AppError("VALIDATION_FAILED", { detail: "RETURN_EXCEEDS_SHIPPED" });

      const loc = await tx.execute<{ warehouse_id: string; kind: string }>(
        sql`SELECT warehouse_id, kind FROM public.locations WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${locationId}::uuid`,
      );
      if (loc[0] === undefined) throw new AppError("NOT_FOUND");
      if (loc[0].kind !== "RECEIVING") throw invalid(); // A-135: iade yalnız kabul alanına girer
      const unit = await tx.execute<{ base_unit_id: string }>(
        sql`SELECT base_unit_id FROM public.items WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${line.item_id}::uuid`,
      );
      if (unit[0] === undefined) throw new AppError("NOT_FOUND");

      const applied = await postFieldDocument(
        tx,
        locked,
        ctx,
        {
          kind: "STOCK_IN",
          warehouseId: loc[0].warehouse_id,
          sourceKind: "SALES_ORDER",
          sourceId: orderId,
          lines: [inLine(line.item_id, unit[0].base_unit_id, quantity, locationId, orderLineId)],
          reason,
          ledgerReason: "RETURN",
        },
        requestId,
      );
      // Yalnız `returned_quantity` değişir (açık miktar ve sipariş durumu değişmez). 0 satır dönerse sessiz no-op değil hata.
      const upd = await tx.execute<{ id: string }>(
        sql`UPDATE public.sales_order_lines SET returned_quantity = returned_quantity + ${microToDecimal(qty)}::numeric
             WHERE tenant_id = ${ctx.tenantId}::uuid AND order_id = ${orderId}::uuid AND id = ${orderLineId}::uuid RETURNING id`,
      );
      if (upd[0] === undefined) throw new AppError("INTERNAL");
      if (applied.audit === null) return applied;
      return {
        ...applied,
        audit: {
          ...applied.audit,
          reason,
          changeSummary: { ...(applied.audit.changeSummary ?? {}), orderId, orderLineId, returnedQuantity: microToDecimal(qty) },
        },
      };
    },
  });
  if (outcome.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true });
  return { ...outcome.result, replayed: outcome.replayed };
}

/** İade satırı: `+quantity` hedef `RECEIVING` lokasyonunda `QUARANTINE`; temel birim, katsayı 1; miktar I-09 tek yolundan (`toBase`) geçer. */
function inLine(itemId: string, unitId: string, quantity: string, locationId: string, orderLineId: string): FieldLine {
  return {
    itemId,
    unitId,
    quantity: microToDecimal(decimalToMicro(quantity)),
    conversionFactor: "1.000000",
    baseQuantity: baseQuantityOf(quantity, "1.000000"),
    sourceLocationId: null,
    targetLocationId: locationId,
    stockStatus: "QUARANTINE",
    targetStockStatus: null,
    sourceLineId: orderLineId,
  };
}
