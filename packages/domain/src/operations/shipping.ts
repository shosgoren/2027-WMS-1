// Kısmi sevk (T-308; ADR-021 §3, ADR-009, 16 Temel kurallar 2/4/5/6, Senaryo A adım 7, Senaryo D adım 8, AC-08 sevk kolu, AC-10).
//
// `shipOrder` (`stock.post`): sevk alanındaki (`STAGING`) sipariş rezervasyonunu TÜKETEREK müşteri çıkışı: primitif `STOCK_OUT`/`SHIPMENT` belgesi (kaynak
// `SALES_ORDER`, satır kaynağı sipariş satırı) saha komutunun tek istemci anahtarıyla oluşturulur → onaylanır → işlenir (`field-posting.ts`), sipariş
// rezervasyonu stok çekirdeğinin iç `consumes` yoluyla aynı transaction'da `CONSUMED` olur (`planReservationEffects`; genel `postDocument` bu yolu taşıyamaz),
// `shipped_quantity` artar, açık miktar 0'a inen siparişte tüm satırlar kapalıysa sipariş `CLOSED` olur (A-140/A-306-4).
//
// Sevke uygunluk (AC-08): yalnız satırın ACTIVE, `STAGING` lokasyonundaki, takipsiz `AVAILABLE` boyuttaki rezervasyonu sevk edilebilir. Rezervasyonsuz sevk, raftaki
// (toplanmamış) rezervasyon, `RECEIVING`/`QUARANTINE`/`DAMAGED` boyuttaki stok sevk yoluna girmez: istenen miktar uygun rezervasyondan fazlaysa
// `INSUFFICIENT_STOCK` (çıkış rezervasyondan karşılanmazsa çekirdek de `VALIDATION_FAILED` ile reddeder; A-134).
// AC-10: ikinci sevk denemesi tüketilecek rezervasyon bulamaz → ret; aynı anahtar → önceki sonuç (idempotency); `shipped + cancelled ≤ requested` DB CHECK'i son savunma.
//
// Kilit sırası (I-15, picking.ts ile aynı): stok kilitleri (`acquireStockLocks`; plan önceden tam bildirilir: boyutlar + rezervasyon kimlikleri) → sipariş başlığı
// `FOR UPDATE` → sipariş satırları `FOR UPDATE` (satır kimliğine göre sıralı) → satır yazımı. Başlık stoktan ÖNCE alınmaz. Başlık kilidinden önce satır yazılmaz
// (0016 `field_docs_lines_guard_closed` satır UPDATE'inde başlığı `FOR SHARE` okur; önce `FOR UPDATE` yoksa 40P01 yükseltmesi olurdu).
//
// A-xx (docs/OPEN_QUESTIONS.md): A-308-1 miktarlar TEMEL birimdedir (sipariş satırı birim saklamaz, A-306-1); A-308-2 sevk belgesi TEK depodur (Q-99): satırların
// uygun rezervasyonları tek depoda olmalı, birden çok depodaysa `warehouseId` verilir (yalnız o depodan sevk; verilmeden belirsizse `VALIDATION_FAILED`);
// A-308-3 bir satırın rezervasyonları birden çok STAGING boyutundaysa miktar, boyut kimliği sırasıyla (lokasyon kimliği artan) bölünür, her boyut ayrı belge satırıdır.
import { sql } from "drizzle-orm";
import type { StockDimensionKey } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";
import {
  SYNC_POST_MAX_LINES,
  executeStockCommand,
  type StockCommandApplied,
  type StockCommandOutcome,
  type StockCommandPlan,
  type StockCommandResult,
  type StockDocCallParams,
} from "../stock/index.ts";
import { dimensionIdentity, toMicro } from "../stock/plan.ts";
import { readReservationPlanRows, versionConflict, type ReservationPlanRow } from "../stock/reservation-reads.ts";
import {
  DECIMAL_RE,
  baseQuantityOf,
  decimalToMicro,
  documentState,
  emptyPlan,
  microToDecimal,
  planFieldPosting,
  postFieldDocument,
  tooLarge,
  uuidOf,
  type FieldConsume,
  type FieldLine,
  type FieldPostSpec,
} from "./field-posting.ts";

/** Kilit planı birim kullanmaz (yalnız boyut/lokasyon); yer tutucu. Gerçek birim apply'da ürünün temel birimidir. */
const PLAN_UNIT = "00000000-0000-0000-0000-000000000000";
const invalid = (): AppError => new AppError("VALIDATION_FAILED");
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const lc = (s: string): string => s.toLowerCase();

// ---------------------------------------------------------------------------------------------------------------------
// Saf kurallar (birim testi: shipping.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Sevke uygun rezervasyon satırı: ACTIVE, `STAGING` lokasyonunda, takipsiz (lot/seri/sahip/taşıma birimi yok) `AVAILABLE` boyutta. */
export function isShippableReservation(r: Pick<ReservationPlanRow, "status" | "locationKind" | "key">): boolean {
  const k = r.key;
  return (
    r.status === "ACTIVE" &&
    r.locationKind === "STAGING" &&
    k.stockStatus === "AVAILABLE" &&
    k.lotId === null &&
    k.serialId === null &&
    k.inventoryOwnerId === null &&
    k.handlingUnitId === null
  );
}

/** Bir sevk parçası: tek boyuttan çıkış + o boyutun sipariş satırı rezervasyonları (çekirdek `min(Σ, çıkış)` ile id sırasıyla tüketir). */
export interface ShipPart {
  readonly key: StockDimensionKey;
  readonly quantity: bigint;
  readonly reservationIds: readonly string[];
}

/**
 * `quantity` miktarını satırın uygun rezervasyonlarına boyut kimliği sırasıyla böler (A-308-3). Toplam yetmezse `INSUFFICIENT_STOCK` (rezervasyonsuz sevk yok,
 * AC-08); `quantity ≤ 0` `VALIDATION_FAILED`. Her boyut için o boyuttaki tüm rezervasyon kimlikleri taşınır (kilit planı ve tüketim aynı kümeyi görür).
 */
export function planShipment(rows: readonly ReservationPlanRow[], quantity: bigint): ShipPart[] {
  if (quantity <= 0n) throw invalid();
  const groups = new Map<string, { key: StockDimensionKey; total: bigint; ids: string[] }>();
  for (const r of rows) {
    if (!isShippableReservation(r)) continue;
    const id = dimensionIdentity(r.key);
    const g = groups.get(id) ?? { key: r.key, total: 0n, ids: [] };
    g.total += toMicro(r.quantity);
    g.ids.push(lc(r.id));
    groups.set(id, g);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => cmpStr(a, b)).map(([, g]) => g);
  if (ordered.reduce((a, g) => a + g.total, 0n) < quantity) throw new AppError("INSUFFICIENT_STOCK");
  const parts: ShipPart[] = [];
  let left = quantity;
  for (const g of ordered) {
    if (left === 0n) break;
    if (g.total <= 0n) continue;
    const take = g.total < left ? g.total : left;
    parts.push({ key: g.key, quantity: take, reservationIds: [...g.ids].sort(cmpStr) });
    left -= take;
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------------------------------
// Komut
// ---------------------------------------------------------------------------------------------------------------------
export interface ShipLineInput {
  readonly orderLineId: string;
  /** Temel birimde pozitif ondalık dizgi (A-308-1). */
  readonly quantity: string;
}
export interface ShipOrderInput {
  readonly orderId: string;
  readonly lines: readonly ShipLineInput[];
  /** A-308-2: satırların uygun rezervasyonları birden çok depodaysa sevk edilecek depo. */
  readonly warehouseId?: string;
  readonly requestId?: string | null;
}

interface ParsedLine {
  readonly orderLineId: string;
  readonly quantity: string;
  readonly micro: bigint;
}

function parseLines(raw: unknown): ParsedLine[] {
  if (!Array.isArray(raw) || raw.length < 1) throw invalid();
  if (raw.length > SYNC_POST_MAX_LINES) throw tooLarge();
  const seen = new Set<string>();
  return (raw as unknown[]).map((x) => {
    if (x === null || typeof x !== "object") throw invalid();
    const { orderLineId, quantity } = x as { orderLineId?: unknown; quantity?: unknown };
    const id = uuidOf(orderLineId);
    if (seen.has(id)) throw invalid(); // aynı satır iki kez: tek satırda topla
    seen.add(id);
    if (typeof quantity !== "string" || !DECIMAL_RE.test(quantity)) throw invalid();
    const micro = decimalToMicro(quantity);
    if (micro <= 0n) throw invalid();
    return { orderLineId: id, quantity, micro };
  });
}

interface OrderLineRow {
  readonly id: string;
  readonly requested: bigint;
  readonly shipped: bigint;
  readonly cancelled: bigint;
}

async function lockOrderLines(tx: AccessTx, tenantId: string, orderId: string): Promise<OrderLineRow[]> {
  const rows = await tx.execute<{ id: string; requested: string; shipped: string; cancelled: string }>(
    sql`SELECT id, requested_quantity::text AS requested, shipped_quantity::text AS shipped, cancelled_quantity::text AS cancelled
          FROM public.sales_order_lines WHERE tenant_id = ${tenantId}::uuid AND order_id = ${orderId}::uuid ORDER BY id FOR UPDATE`,
  );
  return rows.map((r) => ({ id: lc(r.id), requested: toMicro(r.requested), shipped: toMicro(r.shipped), cancelled: toMicro(r.cancelled) }));
}

/** Satırın sevke uygun rezervasyonları (kilitsiz okuma; apply kilitten sonra yeniden okur). `warehouseId` verilmişse yalnız o depo. */
async function shippableRows(tx: AccessTx, tenantId: string, orderLineId: string, warehouseId: string | null): Promise<ReservationPlanRow[]> {
  return (await readReservationPlanRows(tx, tenantId, { orderLineId })).filter((r) => isShippableReservation(r) && (warehouseId === null || lc(r.warehouseId) === warehouseId));
}

function warehousesOf(rowsByLine: ReadonlyMap<string, readonly ReservationPlanRow[]>): string[] {
  return [...new Set([...rowsByLine.values()].flatMap((rs) => rs.map((r) => lc(r.warehouseId))))].sort(cmpStr);
}

/** `stock.post`: bkz. dosya başı. */
export async function shipOrder(params: StockDocCallParams, input: ShipOrderInput): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const orderId = uuidOf(input.orderId);
  const lines = parseLines(input.lines);
  const warehouseFilter = input.warehouseId === undefined ? null : uuidOf(input.warehouseId);
  const requestId = input.requestId ?? null;
  const hashInput = { orderId, lines: lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })), warehouseId: warehouseFilter };

  const outcome: StockCommandOutcome<StockCommandResult> = await executeStockCommand<typeof hashInput, StockCommandResult>({
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    commandType: "sales_order.ship",
    permission: "stock.post",
    input: hashInput,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    plan: async (tx, _i, m): Promise<StockCommandPlan> => {
      const rowsByLine = new Map<string, ReservationPlanRow[]>();
      for (const l of lines) rowsByLine.set(l.orderLineId, await shippableRows(tx, m.tenantId, l.orderLineId, warehouseFilter));
      const warehouses = warehousesOf(rowsByLine);
      try {
        if (warehouses.length !== 1) throw invalid();
        const fieldLines: FieldLine[] = [];
        const reservationIds: string[] = [];
        for (const l of lines) {
          for (const p of planShipment(rowsByLine.get(l.orderLineId) ?? [], l.micro)) {
            fieldLines.push(outLine(PLAN_UNIT, p, l.orderLineId));
            reservationIds.push(...p.reservationIds);
          }
        }
        const plan = await planFieldPosting(tx, m.tenantId, { kind: "STOCK_OUT", warehouseId: warehouses[0] as string, sourceKind: "SALES_ORDER", sourceId: orderId, lines: fieldLines });
        return { warehouseIds: plan.warehouseIds, locks: { ...plan.locks, reservationIds: [...new Set(reservationIds)].sort(cmpStr) } };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        return emptyPlan(warehouses); // apply kilit altında asıl hatayı verir
      }
    },
    apply: async (tx, locked, ctx): Promise<StockCommandApplied> => {
      // Kilit sırası: stok (alındı) → sipariş başlığı → sipariş satırları.
      const head = await tx.execute<{ status: string }>(
        sql`SELECT status FROM public.sales_orders WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderId}::uuid FOR UPDATE`,
      );
      if (head[0] === undefined) throw new AppError("NOT_FOUND");
      if (head[0].status !== "OPEN") throw documentState();
      const orderLines = await lockOrderLines(tx, ctx.tenantId, orderId);
      const lineById = new Map(orderLines.map((l) => [l.id, l]));
      // A-152: bildirilen satır gerçekten bu siparişe ait olmalı (başka siparişin satırıyla kaynak bağlanamaz).
      for (const l of lines) if (!lineById.has(l.orderLineId)) throw new AppError("NOT_FOUND");

      // Rezervasyonlar kilitten SONRA yeniden okunur. Önce saf denetimler (INSUFFICIENT_STOCK, belirsiz depo, belge büyüklüğü): plan bu hatalar yüzünden boş
      // kalmış olabilir (kilitli görüntü rezervasyonu içermez) ve asıl hata `VERSION_CONFLICT` ile maskelenmemelidir. Sonra kilitli görüntüyle uyuşmayan satır = plan bayat.
      const rowsByLine = new Map<string, ReservationPlanRow[]>();
      for (const l of lines) rowsByLine.set(l.orderLineId, await shippableRows(tx, ctx.tenantId, l.orderLineId, warehouseFilter));
      const partsByLine = lines.map((l) => ({ l, parts: planShipment(rowsByLine.get(l.orderLineId) ?? [], l.micro) })); // INSUFFICIENT_STOCK burada
      const warehouses = warehousesOf(rowsByLine);
      if (warehouses.length !== 1) throw invalid(); // A-308-2: belirsiz depo
      if (partsByLine.reduce((a, x) => a + x.parts.length, 0) > SYNC_POST_MAX_LINES) throw tooLarge();
      const lockedById = new Map(locked.reservations.map((r) => [lc(r.id), r]));
      const dimIds = new Map(locked.dimensions.map((d) => [dimensionIdentity(d.key), d.id]));
      for (const rows of rowsByLine.values()) {
        for (const r of rows) {
          const lr = lockedById.get(lc(r.id));
          if (lr === undefined || lr.status !== "ACTIVE" || lr.stockDimensionId !== dimIds.get(dimensionIdentity(r.key))) throw versionConflict();
        }
      }
      const spec = await (async (): Promise<FieldPostSpec> => {
        const fieldLines: FieldLine[] = [];
        const consumes: FieldConsume[] = [];
        const units = await baseUnitsOf(tx, ctx.tenantId, [...new Set(partsByLine.flatMap(({ parts }) => parts.map((p) => p.key.itemId)))].sort(cmpStr));
        for (const { l, parts } of partsByLine) {
          for (const p of parts) {
            consumes.push({ lineIndex: fieldLines.length, orderLineId: l.orderLineId, reservationIds: p.reservationIds });
            fieldLines.push(outLine(units.get(p.key.itemId) as string, p, l.orderLineId));
          }
        }
        return { kind: "STOCK_OUT", warehouseId: warehouses[0] as string, sourceKind: "SALES_ORDER", sourceId: orderId, lines: fieldLines, consumes };
      })();

      const applied = await postFieldDocument(tx, locked, ctx, spec, requestId);

      // Sipariş satırları: shipped artar (0 satır dönerse sessiz no-op değil hata); DB CHECK shipped + cancelled ≤ requested son savunmadır.
      const json = JSON.stringify(lines.map((l) => ({ id: l.orderLineId, qty: microToDecimal(l.micro) })));
      const upd = await tx.execute<{ id: string }>(
        sql`UPDATE public.sales_order_lines s SET shipped_quantity = s.shipped_quantity + w.qty
              FROM jsonb_to_recordset(${json}::jsonb) AS w(id uuid, qty numeric)
             WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.order_id = ${orderId}::uuid AND s.id = w.id RETURNING s.id`,
      );
      if (upd.length !== lines.length) throw new AppError("INTERNAL");
      const shippedNow = new Map(lines.map((l) => [l.orderLineId, l.micro]));
      const closed = orderLines.every((l) => l.requested - l.shipped - (shippedNow.get(l.id) ?? 0n) - l.cancelled === 0n);
      if (closed) {
        const done = await tx.execute<{ id: string }>(
          sql`UPDATE public.sales_orders SET status = 'CLOSED' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderId}::uuid AND status = 'OPEN' RETURNING id`,
        );
        if (done[0] === undefined) throw new AppError("INTERNAL");
      }
      if (applied.audit === null) return applied;
      return {
        ...applied,
        audit: {
          ...applied.audit,
          changeSummary: {
            ...(applied.audit.changeSummary ?? {}),
            orderId,
            orderClosed: closed,
            orderLines: lines.map((l) => ({ orderLineId: l.orderLineId, quantity: microToDecimal(l.micro) })),
          },
        },
      };
    },
  });
  if (outcome.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true });
  return { ...outcome.result, replayed: outcome.replayed };
}

/** Parçanın çıkış satırı: temel birim, katsayı 1 (A-308-1); miktar I-09 tek yolundan (`toBase`) geçer, yuvarlama yazılmaz. */
function outLine(unitId: string, p: ShipPart, orderLineId: string): FieldLine {
  const quantity = microToDecimal(p.quantity);
  return {
    itemId: p.key.itemId,
    unitId,
    quantity,
    conversionFactor: "1.000000",
    baseQuantity: baseQuantityOf(quantity, "1.000000"),
    sourceLocationId: p.key.locationId,
    targetLocationId: null,
    stockStatus: "AVAILABLE",
    targetStockStatus: null,
    sourceLineId: orderLineId,
  };
}

async function baseUnitsOf(tx: AccessTx, tenantId: string, itemIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of itemIds) {
    const r = await tx.execute<{ base_unit_id: string }>(sql`SELECT base_unit_id FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`);
    if (r[0] === undefined) throw new AppError("NOT_FOUND");
    out.set(id, r[0].base_unit_id);
  }
  return out;
}
