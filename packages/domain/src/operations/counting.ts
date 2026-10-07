// Kilitli sayım (T-309; 06 §Sayım ve §Sayım kilidi yaşam döngüsü, ADR-021 §3/§5/§6, 16 Senaryo A adım 11 ve Senaryo D adım 10, AC-13, AC-39).
//
// Komutlar ve izinler (A-132): `startCount`/`cancelCount` `document.approve`; `recordCount`/`submitCount` `document.create`; `approveCount` ve
// `postCountAdjustment` `count_diff.approve`. Oturum durum makinesi 0017 tetikleyicisinde atlamasızdır: COUNTING → SUBMITTED → APPROVED → POSTED
// (CANCELLED her açık durumdan); `approveCount` COUNTING'den çağrılırsa aynı transaction'da iki geçişi sırayla yapar.
//
// - Stok kilitleri YALNIZCA `acquireStockLocks` ile (executeStockCommand): `startCount` `countStart` planıyla, `postCountAdjustment`/`cancelCount`
//   `countSessionId` planıyla (A-111). Oturum başlığı `acquireStockLocks`'tan ÖNCE (`plan` içinde) `FOR NO KEY UPDATE` ile kilitlenir (I-15 "belge önce";
//   Supervisor notu 3): satır yazan `recordCount`/`submitCount`/`approveCount` da aynı kilidi alır, 0017 `count_session_lines_guard_closed` başlığı `FOR SHARE`
//   okur → kilit yükseltmesi/çapraz sıra yok. `location_count_locks` yazımı yalnızca posting çekirdeğindeki yardımcılardadır (lint STOCK_WRITE_FILES).
// - Fark hesabı KİLİTLİ bakiyeye göredir (Supervisor notu 1): `count_session_lines.reference_quantity` yalnız kör olmayan ekranda gösterimdir, hesapta KULLANILMAZ.
//   Satırdaki `location_id` ile boyutun `location_id`'si aynı kilit altında eşit olmalıdır (not 2; aksi `INTERNAL`, işlem geri alınır).
// - Miktarlar I-09: sayım girişi `toBase(q, "1", ürün ölçeği)` (6 ondalığa/ürün ölçeğine inmiyorsa `QUANTITY_SCALE`, yuvarlama yok); fark miktarı kesin tam sayı farkıdır
//   ve `baseQuantityOf` yolundan geçer. Fark fişi `COUNT_ADJUSTMENT`/`COUNT_DIFF`, `source_kind = COUNT_SESSION` taşır: 0017/T-224 gereği ters kayıt yolu kapalıdır.
// - `count_sessions.approved_by` yalnız SUBMITTED → APPROVED geçişinde, aynı UPDATE'te yazılır (Supervisor notu 5): başka komut bu sütunu hiç yazmaz.
//
// A-xx (OPEN_QUESTIONS): A-309-1 fark fişi numarası `SAY-<YYYY>-<6 hane>`; A-309-2 sayım granülü (lokasyon, ürün, stok durumu) ve yalnız takipsiz/sahipsiz/taşıma birimsiz boyutlar;
// A-309-3 `submitCount`/`approveCount` tüm satırların sayılmış olmasını ister (sayılmayan satır sıfır sayılmaz); A-309-4 sistemde olmayan bulgu yalnız AVAILABLE boyutuna +;
// A-309-5 sayım farkı rezerve miktarın altına inemez (`INSUFFICIENT_STOCK`; Q-122); A-309-6 kilit zaman aşımı tükenince `LOCATION_LOCKED` (ayrıntısız).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { toBase } from "../catalog/quantity.ts";
import { runTenantCommand, type AccessTx, type Membership, type TenantAccessParams } from "../identity/access.ts";
import { assertWarehouseVisible, pgUuidArray } from "../warehouse/scope.ts";
import {
  EMPTY_LOCK_PLAN,
  MAX_DOCUMENT_LINES,
  SYNC_POST_MAX_LINES,
  assertLocationsActiveInWarehouse,
  executeStockCommand,
  sqlstateOf,
  type StockCommandApplied,
  type StockCommandOutcome,
  type StockCommandResult,
  type StockDocCallParams,
} from "../stock/index.ts";
import { releaseCountLocks, setLocationsCounting } from "../stock/posting.ts";
import { toMicro } from "../stock/plan.ts";
import { baseQuantityOf, decimalToMicro, documentState, microToDecimal, postFieldDocument, tooLarge, uuidOf, type FieldLine } from "./field-posting.ts";
import { completeTask } from "./tasks.ts";

const CONTROL_RE = /\p{C}/u;
export const COUNT_REASON_MAX = 500;
/** Bir komutta en çok lokasyon / sayım satırı (senkron sınırı; A-142). */
export const COUNT_MAX_LOCATIONS = 200;
export const COUNT_MAX_INPUT_LINES = 200;
const STATUSES = ["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"] as const;
export type CountStockStatus = (typeof STATUSES)[number];

/** A-136: sayım ekranı varsayılan KÖR (referans miktar gösterilmez). Yalnız gösterim; hesapta referans kullanılmaz. */
export const COUNT_BLIND_DEFAULT = true;

export type CountCallParams = Omit<TenantAccessParams, "permission" | "recentAuth">;

// --- ortak okumalar -----------------------------------------------------------------------------------------------------------

type SessionStatus = "COUNTING" | "SUBMITTED" | "APPROVED" | "POSTED" | "CANCELLED";
interface SessionRow {
  readonly id: string;
  readonly warehouseId: string;
  readonly status: SessionStatus;
  readonly blind: boolean;
}

/**
 * Oturum başlığını `FOR NO KEY UPDATE` ile kilitler (başlık satırı stok kilit tablosu değildir). Yok / başka tenant → `NOT_FOUND`; kapsam dışı depo → `NOT_FOUND`
 * (A-46; varlık sızmaz). Çağıran `acquireStockLocks`'tan ÖNCE (plan içinde) ya da satır yazmadan önce çağırır.
 */
async function lockSession(tx: AccessTx, m: Membership, sessionId: string): Promise<SessionRow> {
  const rows = await tx.execute<{ id: string; warehouse_id: string; status: SessionStatus; blind: boolean }>(
    sql`SELECT id, warehouse_id, status, blind FROM public.count_sessions
         WHERE tenant_id = ${m.tenantId}::uuid AND id = ${sessionId}::uuid FOR NO KEY UPDATE`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  await assertWarehouseVisible(tx, m, [r.warehouse_id]);
  return { id: r.id, warehouseId: r.warehouse_id, status: r.status, blind: r.blind };
}

/** Oturuma kilitli lokasyonlar (salt okuma; başlık kilidi altında kümeyi yalnız bu oturumun komutları değiştirir). */
async function sessionLocationIds(tx: AccessTx, tenantId: string, sessionId: string): Promise<string[]> {
  const rows = await tx.execute<{ location_id: string }>(
    sql`SELECT location_id FROM public.location_count_locks
         WHERE tenant_id = ${tenantId}::uuid AND count_session_id = ${sessionId}::uuid AND status = 'COUNTING' ORDER BY location_id`,
  );
  return rows.map((r) => r.location_id.toLowerCase());
}

interface LineRow {
  readonly id: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly dimensionId: string | null;
  readonly reference: string;
  readonly counted: string | null;
  /** Boyutlu satırda boyutun durumu; boyutsuz (sistemde olmayan) satırda `AVAILABLE`. */
  readonly stockStatus: CountStockStatus;
  /** Boyutlu satırda boyutun kendi lokasyonu (not 2: satır lokasyonuyla eşit olmalı). */
  readonly dimensionLocationId: string | null;
  readonly dimensionItemId: string | null;
  readonly tracked: boolean;
}

async function readLines(tx: AccessTx, tenantId: string, sessionId: string): Promise<LineRow[]> {
  const rows = await tx.execute<{
    id: string; location_id: string; item_id: string; stock_dimension_id: string | null; reference_quantity: string; counted_quantity: string | null;
    stock_status: CountStockStatus | null; dim_location_id: string | null; dim_item_id: string | null; tracked: boolean | null;
  }>(
    sql`SELECT l.id, l.location_id, l.item_id, l.stock_dimension_id, l.reference_quantity::text AS reference_quantity, l.counted_quantity::text AS counted_quantity,
               d.stock_status, d.location_id AS dim_location_id, d.item_id AS dim_item_id,
               (d.lot_id IS NOT NULL OR d.serial_id IS NOT NULL OR d.inventory_owner_id IS NOT NULL OR d.handling_unit_id IS NOT NULL) AS tracked
          FROM public.count_session_lines l
          LEFT JOIN public.stock_dimensions d ON d.tenant_id = l.tenant_id AND d.id = l.stock_dimension_id
         WHERE l.tenant_id = ${tenantId}::uuid AND l.session_id = ${sessionId}::uuid
         ORDER BY l.location_id, l.item_id, d.stock_status NULLS LAST, l.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    locationId: r.location_id.toLowerCase(),
    itemId: r.item_id.toLowerCase(),
    dimensionId: r.stock_dimension_id,
    reference: r.reference_quantity,
    counted: r.counted_quantity,
    stockStatus: r.stock_status ?? "AVAILABLE",
    dimensionLocationId: r.dim_location_id === null ? null : r.dim_location_id.toLowerCase(),
    dimensionItemId: r.dim_item_id === null ? null : r.dim_item_id.toLowerCase(),
    tracked: r.tracked === true,
  }));
}

function reasonOf(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (v === "" || v.length > COUNT_REASON_MAX || CONTROL_RE.test(v)) throw new AppError("VALIDATION_FAILED");
  return v;
}

async function itemScales(tx: AccessTx, tenantId: string, itemIds: readonly string[]): Promise<Map<string, { scale: number; baseUnitId: string }>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; quantity_scale: number; base_unit_id: string }>(
    sql`SELECT id, quantity_scale, base_unit_id FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(itemIds)}::uuid[])`,
  );
  return new Map(rows.map((r) => [r.id.toLowerCase(), { scale: Number(r.quantity_scale), baseUnitId: r.base_unit_id }]));
}

/** `toBase(q, "1", ürün ölçeği)` — tek kural (I-09): yuvarlama yok, ölçeğe inmiyorsa `QUANTITY_SCALE`. Kanonik 6 ondalıklı dizgi döner. */
function countedBase(raw: unknown, scale: number): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  return baseQuantityOf(toBase(raw, "1", scale), "1");
}

// --- startCount ---------------------------------------------------------------------------------------------------------------

export interface StartCountInput {
  readonly warehouseId: string;
  readonly locationIds: readonly string[];
  /** Varsayılan `true` (A-136). */
  readonly blind?: boolean;
  readonly requestId?: string | null;
}
export interface CountCommandResult extends StockCommandResult {
  readonly replayed: boolean;
}

/** Tükenmiş yeniden denemede (lock_timeout) ham `VERSION_CONFLICT` yerine açık `LOCATION_LOCKED` (06: "lokasyonda süren işlem var"; A-309-6). */
function lockWaitExhausted(e: unknown): boolean {
  return e instanceof AppError && e.code === "VERSION_CONFLICT" && sqlstateOf(e) === "55P03";
}

/**
 * `document.approve`: sayım başlatır. Tek transaction: `countStart` kilidi (süren stok işlemlerini bekler; tümü IDLE değilse `LOCATION_LOCKED`, kısmi kilit yok) →
 * lokasyonlar `FOR SHARE` + ACTIVE yeniden okunur (arşivle yarış; T-217 notu) → oturum `COUNTING` → referans bakiyeler (kilit beklemesinden SONRA okunur) →
 * kilitler `COUNTING`. Takipli (lot/seri/sahip/taşıma birimi) bakiye varsa `VALIDATION_FAILED` (A-309-2; fail-closed).
 */
export async function startCount(params: StockDocCallParams, input: StartCountInput): Promise<CountCommandResult & { readonly sessionId: string }> {
  const warehouseId = uuidOf(input.warehouseId);
  if (!Array.isArray(input.locationIds) || input.locationIds.length < 1 || input.locationIds.length > COUNT_MAX_LOCATIONS) throw new AppError("VALIDATION_FAILED");
  const locationIds = [...new Set(input.locationIds.map((l) => uuidOf(l)))].sort();
  const blind = input.blind === undefined ? COUNT_BLIND_DEFAULT : input.blind;
  if (typeof blind !== "boolean") throw new AppError("VALIDATION_FAILED");
  const hashInput = { warehouseId, locationIds, blind };
  let sessionId = randomUUID(); // her deneme `plan`'da yenilenir (yeniden denemede önceki kimlik kullanılmaz)
  let outcome: StockCommandOutcome<StockCommandResult>;
  try {
    outcome = await executeStockCommand<typeof hashInput, StockCommandResult>({
      db: params.db,
      principal: params.principal,
      tenantSlug: params.tenantSlug,
      clientKey: params.clientKey,
      commandType: "stock.count.start",
      permission: "document.approve",
      input: hashInput,
      ...(params.retry === undefined ? {} : { retry: params.retry }),
      ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
      ...(params.logger === undefined ? {} : { logger: params.logger }),
      plan: async () => {
        sessionId = randomUUID();
        return { warehouseIds: [warehouseId], locks: { ...EMPTY_LOCK_PLAN, locationIds, countStart: { sessionId } } };
      },
      apply: async (tx, _locked, ctx): Promise<StockCommandApplied> => {
        // Kilit beklemesinden SONRA: lokasyon FOR SHARE + ACTIVE + depo eşitliği (arşiv FOR NO KEY UPDATE ile çakışır → arşivli lokasyon hiçbir zaman COUNTING olmaz).
        await assertLocationsActiveInWarehouse(tx, ctx.tenantId, locationIds, warehouseId);
        await tx.execute(
          sql`INSERT INTO public.count_sessions (tenant_id, id, warehouse_id, blind, started_by)
              VALUES (${ctx.tenantId}::uuid, ${sessionId}::uuid, ${warehouseId}::uuid, ${blind}::boolean, ${ctx.membership.membershipId}::uuid)`,
        );
        // Referans bakiye: lokasyon kilitleri bu transaction'da FOR UPDATE tutulur; her yazıcı FOR SHARE'ini commit ile bırakmıştır (READ COMMITTED ifade görüntüsü).
        const stock = await tx.execute<{ dimension_id: string; item_id: string; location_id: string; quantity: string; tracked: boolean }>(
          sql`SELECT d.id AS dimension_id, d.item_id, d.location_id, b.quantity::text AS quantity,
                     (d.lot_id IS NOT NULL OR d.serial_id IS NOT NULL OR d.inventory_owner_id IS NOT NULL OR d.handling_unit_id IS NOT NULL) AS tracked
                FROM public.stock_dimensions d
                JOIN public.stock_balances b ON b.tenant_id = d.tenant_id AND b.stock_dimension_id = d.id
               WHERE d.tenant_id = ${ctx.tenantId}::uuid AND d.location_id = ANY(${pgUuidArray(locationIds)}::uuid[]) AND b.quantity > 0
               ORDER BY d.location_id, d.item_id, d.id`,
        );
        if (stock.length > MAX_DOCUMENT_LINES) throw tooLarge();
        if (stock.some((r) => r.tracked)) throw new AppError("VALIDATION_FAILED"); // A-309-2
        if (stock.length > 0) {
          const json = JSON.stringify(
            stock.map((r) => ({
              tenant_id: ctx.tenantId,
              id: randomUUID(),
              session_id: sessionId,
              warehouse_id: warehouseId,
              location_id: r.location_id,
              dimension_id: r.dimension_id,
              item_id: r.item_id,
              reference_quantity: r.quantity,
            })),
          );
          await tx.execute(
            sql`INSERT INTO public.count_session_lines (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity)
                SELECT w.tenant_id, w.id, w.session_id, w.warehouse_id, w.location_id, w.dimension_id, w.item_id, w.reference_quantity
                  FROM jsonb_to_recordset(${json}::jsonb)
                    AS w(tenant_id uuid, id uuid, session_id uuid, warehouse_id uuid, location_id uuid, dimension_id uuid, item_id uuid, reference_quantity numeric)`,
          );
        }
        await setLocationsCounting(tx, ctx.tenantId, sessionId, ctx.membership.membershipId, locationIds);
        return {
          result: { documentId: sessionId },
          audit: {
            action: "count.started",
            entityType: "count_session",
            entityId: sessionId,
            requestId: input.requestId ?? null,
            changeSummary: { warehouse_id: warehouseId, location_count: locationIds.length, line_count: stock.length, blind },
          },
        };
      },
    });
  } catch (e) {
    if (lockWaitExhausted(e)) {
      const err = new AppError("LOCATION_LOCKED"); // lokasyonda süren işlem var (06)
      err.cause = e;
      throw err;
    }
    throw e;
  }
  if (outcome.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true });
  return { ...outcome.result, sessionId: outcome.result.documentId as string, replayed: outcome.replayed };
}

// --- recordCount / submitCount / approveCount (stok yazmaz) --------------------------------------------------------------------

export interface RecordCountLineInput {
  readonly locationId: string;
  readonly itemId: string;
  /** Temel birimde ≥ 0 ondalık dizgi. */
  readonly countedQuantity: string;
  /** Varsayılan `AVAILABLE`. Oturumda satırı olan durumlar için; sistemde olmayan bulgu yalnız `AVAILABLE` (A-309-4). */
  readonly stockStatus?: CountStockStatus;
}
export interface RecordCountInput {
  readonly sessionId: string;
  readonly lines: readonly RecordCountLineInput[];
  readonly requestId?: string | null;
}

/**
 * `document.create`: sayım değerlerini yazar (stok YAZMAZ; kilitli lokasyonda serbest). Aynı (lokasyon, ürün, durum) tekrar yazılırsa son değer geçerlidir.
 * Oturum `COUNTING` ya da `SUBMITTED` olmalı (onaya kadar düzeltilebilir). Lokasyon oturuma kilitli olmalıdır; sayı ürün ölçeğine uymalıdır (`QUANTITY_SCALE`).
 */
export async function recordCount(params: CountCallParams, input: RecordCountInput): Promise<{ readonly recorded: number }> {
  const sessionId = uuidOf(input.sessionId);
  if (!Array.isArray(input.lines) || input.lines.length < 1) throw new AppError("VALIDATION_FAILED");
  if (input.lines.length > COUNT_MAX_INPUT_LINES) throw new AppError("VALIDATION_FAILED", { detail: "TOO_MANY_LINES" });
  const seen = new Set<string>();
  const parsed = input.lines.map((l) => {
    const status = l.stockStatus ?? "AVAILABLE";
    if (!(STATUSES as readonly string[]).includes(status)) throw new AppError("VALIDATION_FAILED");
    const p = { locationId: uuidOf(l.locationId), itemId: uuidOf(l.itemId), stockStatus: status as CountStockStatus, raw: l.countedQuantity };
    const k = `${p.locationId}|${p.itemId}|${p.stockStatus}`;
    if (seen.has(k)) throw new AppError("VALIDATION_FAILED"); // aynı komutta aynı satır bir kez
    seen.add(k);
    return p;
  });
  return runTenantCommand({ ...params, permission: "document.create" }, async (tx, m) => {
    const s = await lockSession(tx, m, sessionId);
    if (s.status !== "COUNTING" && s.status !== "SUBMITTED") throw documentState();
    const locations = new Set(await sessionLocationIds(tx, m.tenantId, sessionId));
    if (parsed.some((p) => !locations.has(p.locationId))) throw new AppError("VALIDATION_FAILED");
    const items = await itemScales(tx, m.tenantId, [...new Set(parsed.map((p) => p.itemId))]);
    const lines = await readLines(tx, m.tenantId, sessionId);
    let written = 0;
    for (const p of parsed) {
      const item = items.get(p.itemId);
      if (item === undefined) throw new AppError("NOT_FOUND");
      const counted = countedBase(p.raw, item.scale);
      const hit = lines.find((x) => x.locationId === p.locationId && x.itemId === p.itemId && x.stockStatus === p.stockStatus);
      let lineId = hit?.id;
      if (lineId === undefined) {
        if (p.stockStatus !== "AVAILABLE") throw new AppError("VALIDATION_FAILED"); // A-309-4
        lineId = randomUUID();
        // Sistemde olmayan bulgu: boyutsuz satır, referans 0 (0017 reference_chk). Sayılan değer ayrı UPDATE'te (INSERT listesinde yok).
        await tx.execute(
          sql`INSERT INTO public.count_session_lines (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity)
              VALUES (${m.tenantId}::uuid, ${lineId}::uuid, ${sessionId}::uuid, ${s.warehouseId}::uuid, ${p.locationId}::uuid, NULL, ${p.itemId}::uuid, 0)`,
        );
      }
      const upd = await tx.execute<{ id: string }>(
        sql`UPDATE public.count_session_lines SET counted_quantity = ${counted}::numeric, counted_by = ${m.membershipId}::uuid
             WHERE tenant_id = ${m.tenantId}::uuid AND id = ${lineId}::uuid AND session_id = ${sessionId}::uuid RETURNING id`,
      );
      if (upd[0] === undefined) throw new AppError("INTERNAL");
      written += 1;
    }
    await appendAudit(tx, {
      action: "count.recorded",
      actorUserId: m.userId,
      entityType: "count_session",
      entityId: sessionId,
      requestId: input.requestId ?? null,
      changeSummary: { line_count: written },
    });
    return { recorded: written };
  });
}

export interface CountTransitionInput {
  readonly sessionId: string;
  readonly requestId?: string | null;
}

function assertAllCounted(lines: readonly LineRow[]): void {
  if (lines.some((l) => l.counted === null)) throw new AppError("VALIDATION_FAILED"); // A-309-3
}

/** `document.create`: COUNTING → SUBMITTED. Tüm satırlar sayılmış olmalı (A-309-3). */
export async function submitCount(params: CountCallParams, input: CountTransitionInput): Promise<{ readonly status: "SUBMITTED" }> {
  const sessionId = uuidOf(input.sessionId);
  return runTenantCommand({ ...params, permission: "document.create" }, async (tx, m) => {
    const s = await lockSession(tx, m, sessionId);
    if (s.status !== "COUNTING") throw documentState();
    assertAllCounted(await readLines(tx, m.tenantId, sessionId));
    const r = await tx.execute<{ id: string }>(
      sql`UPDATE public.count_sessions SET status = 'SUBMITTED' WHERE tenant_id = ${m.tenantId}::uuid AND id = ${sessionId}::uuid AND status = 'COUNTING' RETURNING id`,
    );
    if (r[0] === undefined) throw new AppError("INTERNAL");
    await appendAudit(tx, {
      action: "count.submitted",
      actorUserId: m.userId,
      entityType: "count_session",
      entityId: sessionId,
      requestId: input.requestId ?? null,
      changeSummary: { warehouse_id: s.warehouseId },
    });
    return { status: "SUBMITTED" } as const;
  });
}

export interface CountDifference {
  readonly locationId: string;
  readonly itemId: string;
  readonly stockStatus: CountStockStatus;
  readonly referenceQuantity: string;
  readonly countedQuantity: string;
  /** İşaretli, referansa göre (gösterim). Defterdeki asıl fark işleme anında KİLİTLİ bakiyeye göre hesaplanır. */
  readonly difference: string;
}

/**
 * `count_diff.approve`: COUNTING|SUBMITTED → APPROVED (COUNTING'den iki geçiş, atlamasız). `approved_by` YALNIZ bu geçişte ve aynı UPDATE'te yazılır
 * (Supervisor notu 5). Onaylanan oturumun satırları donar (0017). Dönen fark listesi referansa göre bilgi amaçlıdır (kör sayımda yalnız yetkiliye gösterilir).
 */
export async function approveCount(
  params: CountCallParams,
  input: CountTransitionInput,
): Promise<{ readonly status: "APPROVED"; readonly differences: readonly CountDifference[] }> {
  const sessionId = uuidOf(input.sessionId);
  return runTenantCommand({ ...params, permission: "count_diff.approve" }, async (tx, m) => {
    const s = await lockSession(tx, m, sessionId);
    if (s.status !== "COUNTING" && s.status !== "SUBMITTED") throw documentState();
    const lines = await readLines(tx, m.tenantId, sessionId);
    assertAllCounted(lines);
    if (s.status === "COUNTING") {
      const a = await tx.execute<{ id: string }>(
        sql`UPDATE public.count_sessions SET status = 'SUBMITTED' WHERE tenant_id = ${m.tenantId}::uuid AND id = ${sessionId}::uuid AND status = 'COUNTING' RETURNING id`,
      );
      if (a[0] === undefined) throw new AppError("INTERNAL");
    }
    const b = await tx.execute<{ id: string }>(
      sql`UPDATE public.count_sessions SET status = 'APPROVED', approved_by = ${m.membershipId}::uuid
           WHERE tenant_id = ${m.tenantId}::uuid AND id = ${sessionId}::uuid AND status = 'SUBMITTED' RETURNING id`,
    );
    if (b[0] === undefined) throw new AppError("INTERNAL");
    const differences: CountDifference[] = [];
    for (const l of lines) {
      const diff = decimalToMicro(l.counted as string) - decimalToMicro(l.reference);
      if (diff === 0n) continue;
      differences.push({
        locationId: l.locationId,
        itemId: l.itemId,
        stockStatus: l.stockStatus,
        referenceQuantity: l.reference,
        countedQuantity: l.counted as string,
        difference: `${diff < 0n ? "-" : ""}${microToDecimal(diff < 0n ? -diff : diff)}`,
      });
    }
    await appendAudit(tx, {
      action: "count.approved",
      actorUserId: m.userId,
      entityType: "count_session",
      entityId: sessionId,
      requestId: input.requestId ?? null,
      changeSummary: { warehouse_id: s.warehouseId, line_count: lines.length, difference_line_count: differences.length, from_status: s.status },
    });
    return { status: "APPROVED", differences } as const;
  });
}

// --- postCountAdjustment ------------------------------------------------------------------------------------------------------

export interface PostCountAdjustmentInput {
  readonly sessionId: string;
  readonly requestId?: string | null;
}

interface DimKey {
  readonly itemId: string;
  readonly locationId: string;
  readonly stockStatus: CountStockStatus;
}
const identityOf = (k: DimKey): string => `${k.itemId}|${k.locationId}|${k.stockStatus}`;

/** Satırın boyut anahtarı (takipsiz): boyutlu satırda boyutun kendisi, boyutsuz satırda (ürün, lokasyon, AVAILABLE). Not 2 burada değil, kilitli görüntüde denetlenir. */
function keyOfLine(l: LineRow): DimKey {
  return { itemId: l.itemId, locationId: l.locationId, stockStatus: l.stockStatus };
}

/**
 * `count_diff.approve`: onaylı oturumun fark fişini işler (`COUNT_ADJUSTMENT`/`COUNT_DIFF`; A-111). Fark = sayılan − KİLİTLİ bakiye (referans değil). Aynı transaction'da:
 * fark satırları defter+bakiye → kilitler `IDLE` → lokasyonların `pick_blocked = false` → oturum `POSTED` → açık `COUNT` görevleri `DONE`. Fark yoksa belge açılmaz,
 * yine de kilitler açılır ve oturum kapanır. Reddedilen komut hiçbir şey yazmaz (kilitler `COUNTING` kalır).
 */
export async function postCountAdjustment(params: StockDocCallParams, input: PostCountAdjustmentInput): Promise<CountCommandResult> {
  const sessionId = uuidOf(input.sessionId);
  const hashInput = { sessionId };
  const outcome = await executeStockCommand<typeof hashInput, StockCommandResult>({
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    commandType: "stock.count.post",
    permission: "count_diff.approve",
    input: hashInput,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    plan: async (tx, _i, m) => {
      const s = await lockSession(tx, m, sessionId); // I-15: başlık stok kilitlerinden ÖNCE
      const held = await sessionLocationIds(tx, m.tenantId, sessionId);
      if (held.length === 0) return { warehouseIds: [s.warehouseId], locks: EMPTY_LOCK_PLAN }; // POSTED/CANCELLED: apply `DOCUMENT_STATE` verir
      const lines = await readLines(tx, m.tenantId, sessionId);
      const dims = new Map<string, DimKey>();
      for (const l of lines) dims.set(identityOf(keyOfLine(l)), keyOfLine(l));
      // Plan, oturum kilidindeki lokasyonlar ∪ satır lokasyonlarıdır: kilitsiz (IDLE) ya da başka oturuma kilitli bir satır lokasyonu `LOCATION_LOCKED` verir (AC-39 d).
      const locationIds = [...new Set([...held, ...lines.map((l) => l.locationId)])].sort();
      return {
        warehouseIds: [s.warehouseId],
        locks: {
          ...EMPTY_LOCK_PLAN,
          locationIds,
          dimensions: [...dims.values()].map((k) => ({
            itemId: k.itemId, locationId: k.locationId, lotId: null, serialId: null, stockStatus: k.stockStatus, inventoryOwnerId: null, handlingUnitId: null,
          })),
          countSessionId: sessionId,
        },
      };
    },
    apply: async (tx, locked, ctx): Promise<StockCommandApplied> => {
      const m = ctx.membership;
      const s = await lockSession(tx, m, sessionId); // bu transaction'da zaten kilitli (plan); durum kilit altında yeniden okunur
      if (s.status !== "APPROVED") throw documentState();
      const lines = await readLines(tx, ctx.tenantId, sessionId);
      assertAllCounted(lines);
      const items = await itemScales(tx, ctx.tenantId, [...new Set(lines.map((l) => l.itemId))]);
      const dimByIdentity = new Map(locked.dimensions.map((d) => [identityOf({ itemId: d.key.itemId.toLowerCase(), locationId: d.key.locationId.toLowerCase(), stockStatus: d.key.stockStatus }), d]));
      const balanceByDim = new Map(locked.balances.map((b) => [b.stockDimensionId, b]));
      const diffs: { itemId: string; locationId: string; stockStatus: CountStockStatus; delta: bigint }[] = [];
      for (const l of lines) {
        if (l.tracked) throw new AppError("INTERNAL"); // A-309-2: başlatma takipli boyutu hiç satıra almaz
        const dim = dimByIdentity.get(identityOf(keyOfLine(l)));
        if (dim === undefined) throw new AppError("INTERNAL"); // plan satırı kapsamıyor: kilitli görüntüde boyut yok
        // Not 2: satırın lokasyonu/ürünü ile boyutun lokasyonu/ürünü AYNI KİLİT altında eşit olmalı (DB bileşik FK yalnız ürün eşitliğini zorlar).
        if (l.dimensionId !== null && (l.dimensionId.toLowerCase() !== dim.id.toLowerCase() || l.dimensionLocationId !== l.locationId || l.dimensionItemId !== l.itemId)) {
          throw new AppError("INTERNAL");
        }
        const bal = balanceByDim.get(dim.id);
        if (bal === undefined) throw new AppError("INTERNAL");
        const delta = decimalToMicro(l.counted as string) - toMicro(bal.quantity); // KİLİTLİ bakiyeye göre (reference_quantity KULLANILMAZ)
        if (delta !== 0n) diffs.push({ itemId: l.itemId, locationId: l.locationId, stockStatus: l.stockStatus, delta });
      }
      diffs.sort((a, b) => (a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : a.stockStatus < b.stockStatus ? -1 : 1));
      if (diffs.length > SYNC_POST_MAX_LINES) throw tooLarge();

      const lockedLocationIds = locked.locations.map((l) => l.locationId.toLowerCase());
      let applied: StockCommandApplied | undefined;
      if (diffs.length > 0) {
        const fieldLines: FieldLine[] = diffs.map((d) => {
          const item = items.get(d.itemId);
          if (item === undefined) throw new AppError("INTERNAL");
          const abs = d.delta < 0n ? -d.delta : d.delta;
          const base = baseQuantityOf(microToDecimal(abs), "1"); // I-09: tek yol, yuvarlama yok
          return {
            itemId: d.itemId,
            unitId: item.baseUnitId,
            quantity: base,
            conversionFactor: "1",
            baseQuantity: base,
            sourceLocationId: d.delta < 0n ? d.locationId : null,
            targetLocationId: d.delta > 0n ? d.locationId : null,
            stockStatus: d.stockStatus,
            targetStockStatus: null,
            sourceLineId: null,
          };
        });
        applied = await postFieldDocument(
          tx,
          locked,
          ctx,
          { kind: "COUNT_ADJUSTMENT", warehouseId: s.warehouseId, sourceKind: "COUNT_SESSION", sourceId: sessionId, lines: fieldLines },
          input.requestId ?? null,
        );
      }

      // Aynı transaction'da kilit açma, pick_blocked, oturum, görevler (06 §Kontrollü istisna: ayrı "kilidi aç" adımı yoktur).
      await releaseCountLocks(tx, ctx.tenantId, sessionId, lockedLocationIds);
      await tx.execute(
        sql`UPDATE public.locations SET pick_blocked = false
             WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${pgUuidArray(lockedLocationIds)}::uuid[]) AND pick_blocked`,
      );
      const posted = await tx.execute<{ id: string }>(
        sql`UPDATE public.count_sessions SET status = 'POSTED' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${sessionId}::uuid AND status = 'APPROVED' RETURNING id`,
      );
      if (posted[0] === undefined) throw new AppError("INTERNAL");
      const tasks = await tx.execute<{ id: string; version: number }>(
        sql`SELECT id, version FROM public.warehouse_tasks
             WHERE tenant_id = ${ctx.tenantId}::uuid AND kind = 'COUNT' AND status IN ('OPEN', 'ASSIGNED')
               AND location_id = ANY(${pgUuidArray(lockedLocationIds)}::uuid[]) ORDER BY id`,
      );
      for (const t of tasks) await completeTask(tx, t.id, Number(t.version), m, input.requestId ?? null);

      const summary = { warehouse_id: s.warehouseId, location_count: lockedLocationIds.length, difference_line_count: diffs.length, tasks_completed: tasks.length };
      if (applied === undefined) {
        return {
          result: { status: "POSTED" },
          audit: { action: "count.posted", entityType: "count_session", entityId: sessionId, requestId: input.requestId ?? null, changeSummary: summary },
        };
      }
      await appendAudit(tx, {
        action: "count.posted",
        actorUserId: ctx.userId,
        entityType: "count_session",
        entityId: sessionId,
        requestId: input.requestId ?? null,
        changeSummary: { ...summary, document_id: applied.result.documentId },
      });
      return applied;
    },
  });
  if (outcome.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true });
  return { ...outcome.result, replayed: outcome.replayed };
}

// --- cancelCount --------------------------------------------------------------------------------------------------------------

export interface CancelCountInput {
  readonly sessionId: string;
  /** Zorunlu gerekçe (1–500; denetim karakteri yok); audit `reason`. */
  readonly reason: string;
  readonly requestId?: string | null;
}

/**
 * `document.approve`: COUNTING|SUBMITTED|APPROVED oturumu iptal eder; fark UYGULANMAZ, kilitler aynı transaction'da `IDLE` olur (gerekçe audit'e). `pick_blocked` ve
 * açık `COUNT` görevleri olduğu gibi kalır (sayım yapılmadı).
 */
export async function cancelCount(params: StockDocCallParams, input: CancelCountInput): Promise<CountCommandResult> {
  const sessionId = uuidOf(input.sessionId);
  const reason = reasonOf(input.reason);
  const hashInput = { sessionId, reason };
  const outcome = await executeStockCommand<typeof hashInput, StockCommandResult>({
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    commandType: "stock.count.cancel",
    permission: "document.approve",
    input: hashInput,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    plan: async (tx, _i, m) => {
      const s = await lockSession(tx, m, sessionId); // I-15: başlık stok kilitlerinden ÖNCE
      const held = await sessionLocationIds(tx, m.tenantId, sessionId);
      if (held.length === 0) return { warehouseIds: [s.warehouseId], locks: EMPTY_LOCK_PLAN }; // zaten kapanmış: apply `DOCUMENT_STATE`
      return { warehouseIds: [s.warehouseId], locks: { ...EMPTY_LOCK_PLAN, locationIds: held, countSessionId: sessionId } };
    },
    apply: async (tx, locked, ctx): Promise<StockCommandApplied> => {
      const s = await lockSession(tx, ctx.membership, sessionId);
      if (s.status === "POSTED" || s.status === "CANCELLED") throw documentState();
      const lockedLocationIds = locked.locations.map((l) => l.locationId.toLowerCase());
      await releaseCountLocks(tx, ctx.tenantId, sessionId, lockedLocationIds);
      const r = await tx.execute<{ id: string }>(
        sql`UPDATE public.count_sessions SET status = 'CANCELLED', cancel_reason = ${reason}
             WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${sessionId}::uuid AND status IN ('COUNTING', 'SUBMITTED', 'APPROVED') RETURNING id`,
      );
      if (r[0] === undefined) throw new AppError("INTERNAL");
      return {
        result: { documentId: sessionId, status: "CANCELLED" },
        audit: {
          action: "count.cancelled",
          entityType: "count_session",
          entityId: sessionId,
          requestId: input.requestId ?? null,
          reason,
          changeSummary: { warehouse_id: s.warehouseId, from_status: s.status, location_count: lockedLocationIds.length },
        },
      };
    },
  });
  if (outcome.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true });
  return { ...outcome.result, replayed: outcome.replayed };
}

// --- terk edilmiş sayım alarmı (worker; salt okuma) ------------------------------------------------------------------------------

export interface AbandonedCount {
  readonly sessionId: string;
  readonly warehouseId: string;
  readonly sessionStatus: SessionStatus;
  readonly lockedLocations: number;
  /** En eski kilidin yaşı (saat). */
  readonly openHours: number;
  /** Tenant ayarı `count_abandon_hours` (A-136 varsayılan 8). */
  readonly thresholdHours: number;
}

/**
 * Tanımlı süreyi (`tenant_settings.count_abandon_hours`, yoksa 8) aşan `COUNTING` kilitli oturumlar (06 §Terk edilmiş sayım). SALT OKUMA: kilidi AÇMAZ, oturumu
 * değiştirmez; yalnızca yetkili iptal veya onay kapatır. Çağıran (worker) tenant bağlamını `withSystemTenant` ile kurar ve alarmı loglar.
 */
export async function findAbandonedCounts(tx: Pick<AccessTx, "execute">, tenantId: string): Promise<AbandonedCount[]> {
  const rows = await tx.execute<{ session_id: string; warehouse_id: string; status: SessionStatus; locations: number | string; open_hours: number | string; threshold: number | string }>(
    sql`SELECT s.id AS session_id, s.warehouse_id, s.status, count(*) AS locations,
               extract(epoch FROM (now() - min(k.locked_at))) / 3600.0 AS open_hours,
               COALESCE(ts.count_abandon_hours, 8) AS threshold
          FROM public.location_count_locks k
          JOIN public.count_sessions s ON s.tenant_id = k.tenant_id AND s.id = k.count_session_id
          LEFT JOIN public.tenant_settings ts ON ts.tenant_id = k.tenant_id
         WHERE k.tenant_id = ${tenantId}::uuid AND k.status = 'COUNTING'
           AND k.locked_at < now() - make_interval(hours => COALESCE(ts.count_abandon_hours, 8)::int)
         GROUP BY s.id, s.warehouse_id, s.status, ts.count_abandon_hours
         ORDER BY min(k.locked_at), s.id`,
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    warehouseId: r.warehouse_id,
    sessionStatus: r.status,
    lockedLocations: Number(r.locations),
    openHours: Math.round(Number(r.open_hours) * 100) / 100,
    thresholdHours: Number(r.threshold),
  }));
}
