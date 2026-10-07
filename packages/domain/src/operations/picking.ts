// Toplama görevlendirmesi, toplama ve "ürün bulunamadı" (T-307; ADR-021 §3/§6, ADR-009, 16 Temel kurallar 3 ve 9, Senaryo A adım 6, Senaryo D adım 6-7).
//
// Komutlar (hepsi `executeStockCommand`: istemci anahtarı zorunlu, idempotency, zaman aşımı, yeniden deneme, audit; UI ve worker aynı komutu çağırır):
//   - `createPickAssignment` (`document.approve`): seçilen siparişlerin STORAGE'taki tahsisli satırlarından lokasyon kodu sırasına göre `PICK` görevleri
//     (ortak `group_id`, A-140). Tahsissiz satır görev üretmez; sonuçta miktar 0 ile listelenir. STOK ETKİSİ YOK, stok kilidi YOK (yalnız sipariş başlıkları).
//   - `confirmPick` (`stock.post`): okutma doğrulaması (lokasyon kodu + ürün barkodu; uyuşmazlık `VALIDATION_FAILED`/`SCAN_MISMATCH`) → bulunan miktar için
//     `STOCK_MOVE`/`MOVE` (kaynak raf → o deponun STAGING lokasyonu) + `reservationIds`: sipariş rezervasyonu malla birlikte SEVK·KUL'a taşınır → görev `DONE`.
//   - "Ürün bulunamadı" (bulunan < beklenen), AYNI transaction'da: eksik kısmın rezervasyonu serbest, lokasyon `pick_blocked = true`, atanmamış `OPEN` `COUNT`
//     görevi (lokasyon başına en çok bir açık görev), defter DEĞİŞMEZ (kural 9). Ardından yeniden tahsis `reallocateOrderLine` ile AYRI bir komut olarak denenir.
//
// Kilit sırası (I-15, `reserveOrder` ile aynı): stok kilitleri (`acquireStockLocks`, plan önceden tam bildirilir) → sipariş başlığı `FOR UPDATE` → görev satırı
// `FOR UPDATE` → (yalnız "bulunamadı") lokasyon satırı `FOR NO KEY UPDATE`. Başlık stoktan ÖNCE alınmaz (kilitlenme). Lokasyon satırının `pick_blocked` yazımı
// posting çekirdeğinin `FOR SHARE` okumasından ÖNCE `FOR NO KEY UPDATE` ile alınır: aksi `FOR SHARE → UPDATE` yükseltmesi eşzamanlı iki "bulunamadı"da 40P01 üretirdi
// (ADR-021 Sonuçlar); yine de 40P01 çıkarsa komut sarmalayıcısı yeniden dener (ADR-018). `FOR NO KEY UPDATE` seçildi: `warehouse_tasks`/`stock_dimensions`
// yabancı anahtar eklemeleri (`FOR KEY SHARE`) engellenmez.
//
// Yeniden tahsisin ayrı transaction olması (gerekçe): ilk komutun kilit planı (boyutlar) önceden bildirilmiştir ve komut içinde genişletilemez (I-15); yeniden
// tahsis başka lokasyonların boyutlarını kilitlemek zorundadır. Bu yüzden "bulunamadı kesinleşti, yeniden tahsis başarısız/hiç çalışmadı" ara durumu mümkündür
// (hata ya da işlem commit'ten hemen sonra ölürse): satır rezervesiz açık kalır (kural 9 ile uyumlu) ve yanıtta `reallocation` açıkça görünür (yutulmaz).
// Yeniden tahsis anahtarı `clientKey`'den TÜRETİLMEZ; GÖREV kimliğinden deterministik türetilir (`reallocationKey`): bir görevin tek yeniden tahsis kaydı olur.
// Sonuç (ya da kalıcı ret) bu kayıtta saklanır → aynı `clientKey` ile tekrar gelen istek (yeniden oynatma) yeniden tahsisi şöyle ele alır: kayıt varsa saklı sonucu
// döndürür (`replay: "DONE"`, ya da saklı ret → `"FAILED"`); kayıt yoksa (komut hiç çalışmadı / geçici hatayla düştü) AYNI deterministik anahtarla yeniden dener
// (`"RETRIED"`). Yeniden deneme çifte tahsis üretemez: sipariş başlığı kilidi altında kapasite = açık − Σ ACTIVE ile sınırlıdır ve anahtar tekildir.
//
// A-xx (rapor, docs/OPEN_QUESTIONS.md): A-307-1 hedef STAGING = görevin deposundaki ACTIVE STAGING lokasyonlarından kodu en küçük olan (görev tablosunda hedef sütunu
// yoktur); A-307-2 `foundQuantity` OKUTULAN BARKODUN biriminde ve okutma başına miktarıyla çarpılır (koli barkodu → temel birim, A-20), tam 6 ondalığa inmeli;
// A-307-3 beklenen = min(görev miktarı, o satırın o lokasyondaki ACTIVE rezervasyon toplamı); beklenenden fazla toplama reddedilir; A-307-4 yalnız takipsiz (lot/seri
// yok) AVAILABLE boyut görevlenir; A-307-5 aynı satır+lokasyon için açık PICK görevi varsa yalnız artan miktar için yeni görev açılır.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { appendAudit, type LockedState, type StockDimensionKey } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { BarcodeNotFoundError, resolveBarcode } from "../catalog/barcodes.ts";
import { runTenantQuery, type AccessTx, type Membership } from "../identity/access.ts";
import { hasPermission } from "../identity/permissions.ts";
import { assertWarehouseVisible, pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import {
  executeStockCommand,
  postApprovedDocumentInTx,
  registerTxCreatedDocument,
  type StockCommandApplied,
  type StockCommandContext,
  type StockCommandOutcome,
  type StockCommandPlan,
  type StockCommandResult,
  type StockDocCallParams,
} from "../stock/index.ts";
import { dimensionIdentity, toMicro } from "../stock/plan.ts";
import { readReservationPlanRows, versionConflict } from "../stock/reservation-reads.ts";
import { releaseSelected } from "../stock/reservations.ts";
import { normalizeCode } from "../warehouse/warehouses.ts";
import { reallocateOrderLine } from "./orders.ts";
import { DECIMAL_RE, decimalToMicro, documentState, emptyPlan, microToDecimal, planFieldPosting, tenantToday, tooLarge, uuidOf, type FieldPostSpec } from "./field-posting.ts";
import { completeTask, createTasks, TASK_KIND_PERMISSION, type NewTaskInput } from "./tasks.ts";

const MICRO = 1_000_000n;
const ORDERS_MAX = 200;
const SCAN_MAX = 256;
/** Kilit planı birim kullanmaz (yalnız boyut/lokasyon); yer tutucu. Gerçek birim apply'da ürünün temel birimidir. */
const PLAN_UNIT = "00000000-0000-0000-0000-000000000000";
const scanMismatch = (): AppError => new AppError("VALIDATION_FAILED", { detail: "SCAN_MISMATCH" });
const invalid = (): AppError => new AppError("VALIDATION_FAILED");

// ---------------------------------------------------------------------------------------------------------------------
// Saf kurallar (birim testi: picking.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Bir sipariş satırının bir STORAGE lokasyonundaki ACTIVE rezervasyon toplamı (görevlendirme girdisi). */
export interface PickSource {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly lineId: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly locationId: string;
  readonly locationCode: string;
  readonly warehouseId: string;
  /** 1e-6 ölçekli tam sayı (> 0). */
  readonly quantity: bigint;
}
export interface PickTaskSpec {
  readonly orderId: string;
  readonly lineId: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly warehouseId: string;
  readonly quantity: bigint;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Görev üretim sırası (A-140): lokasyon kodu artan, sonra sipariş numarası, satır no, satır kimliği (kararlı). Aynı (satır, lokasyon) için AÇIK görev miktarı
 * (`openByKey`, anahtar `satır|lokasyon`) düşülür; artan yoksa görev üretilmez (A-307-5).
 */
export function planPickTasks(sources: readonly PickSource[], openByKey: ReadonlyMap<string, bigint> = new Map()): PickTaskSpec[] {
  const ordered = [...sources].sort(
    (a, b) => cmpStr(a.locationCode, b.locationCode) || cmpStr(a.orderNumber, b.orderNumber) || a.lineNo - b.lineNo || cmpStr(a.lineId, b.lineId) || cmpStr(a.locationId, b.locationId),
  );
  const out: PickTaskSpec[] = [];
  for (const s of ordered) {
    const rest = s.quantity - (openByKey.get(`${s.lineId.toLowerCase()}|${s.locationId.toLowerCase()}`) ?? 0n);
    if (rest <= 0n) continue;
    out.push({ orderId: s.orderId, lineId: s.lineId, itemId: s.itemId, locationId: s.locationId, warehouseId: s.warehouseId, quantity: rest });
  }
  return out;
}

/** Beklenen = min(görev miktarı, ACTIVE rezervasyon); eksik = beklenen − bulunan (negatifse bulunan beklenenden fazladır: çağıran reddeder). */
export function pickShortfall(taskQuantity: bigint, reserved: bigint, found: bigint): { readonly expected: bigint; readonly short: bigint } {
  const expected = taskQuantity < reserved ? taskQuantity : reserved;
  return { expected, short: expected - found };
}

/**
 * `foundQuantity × okutma başına miktar × birim katsayısı` (hepsi 6 ondalıklı ondalık dizgi) → temel birimde 1e-6 ölçekli tam sayı. Sonuç tam 6 ondalığa
 * inmiyorsa `VALIDATION_FAILED`/`QUANTITY_SCALE` (sessiz yuvarlama yok).
 */
export function scaledBaseQuantity(found: string, perScan: string, factor: string): bigint {
  const product = decimalToMicro(found) * decimalToMicro(perScan) * decimalToMicro(factor); // 1e-18 ölçekli
  if (product % (MICRO * MICRO) !== 0n) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });
  return product / (MICRO * MICRO);
}

// ---------------------------------------------------------------------------------------------------------------------
// Ortak okumalar
// ---------------------------------------------------------------------------------------------------------------------
type Done = StockCommandResult & { readonly replayed: boolean };

function completed(o: StockCommandOutcome<StockCommandResult>): Done {
  if (o.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true }); // senkron komutlarda beklenmez
  return { ...o.result, replayed: o.replayed };
}

interface TaskInfo {
  readonly id: string;
  readonly warehouseId: string;
  readonly kind: string;
  readonly status: string;
  readonly assignedMembershipId: string | null;
  readonly locationId: string | null;
  readonly itemId: string | null;
  readonly quantity: string | null;
  readonly sourceKind: string | null;
  readonly sourceId: string | null;
  readonly sourceLineId: string | null;
  readonly version: number;
}
type TaskDb = {
  id: string; warehouse_id: string; kind: string; status: string; assigned_membership_id: string | null; location_id: string | null; item_id: string | null;
  quantity: string | null; source_kind: string | null; source_id: string | null; source_line_id: string | null; version: number | string;
};
const taskOf = (r: TaskDb): TaskInfo => ({
  id: r.id, warehouseId: r.warehouse_id, kind: r.kind, status: r.status, assignedMembershipId: r.assigned_membership_id, locationId: r.location_id, itemId: r.item_id,
  quantity: r.quantity, sourceKind: r.source_kind, sourceId: r.source_id, sourceLineId: r.source_line_id, version: Number(r.version),
});

/** Görevi okur (tenant süzgeci açık). `lock` ise `FOR UPDATE`. Yok / başka tenant → `NOT_FOUND`. */
async function readTask(tx: AccessTx, tenantId: string, taskId: string, lock: boolean): Promise<TaskInfo> {
  const rows = await tx.execute<TaskDb>(
    lock
      ? sql`SELECT id, warehouse_id, kind, status, assigned_membership_id, location_id, item_id, quantity::text AS quantity, source_kind, source_id, source_line_id, version
              FROM public.warehouse_tasks WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid FOR UPDATE`
      : sql`SELECT id, warehouse_id, kind, status, assigned_membership_id, location_id, item_id, quantity::text AS quantity, source_kind, source_id, source_line_id, version
              FROM public.warehouse_tasks WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`,
  );
  const r = rows[0];
  if (r === undefined) throw new AppError("NOT_FOUND");
  return taskOf(r);
}

interface PickTaskFields {
  readonly locationId: string;
  readonly itemId: string;
  readonly quantity: bigint;
  readonly orderId: string;
  readonly lineId: string;
}
/** PICK görevinin değişmez alanları (görev türü/alan tamlığı denetimi). */
function pickFields(t: TaskInfo): PickTaskFields {
  if (t.kind !== "PICK" || t.locationId === null || t.itemId === null || t.quantity === null || t.sourceKind !== "SALES_ORDER" || t.sourceId === null || t.sourceLineId === null) {
    throw invalid();
  }
  return { locationId: t.locationId.toLowerCase(), itemId: t.itemId.toLowerCase(), quantity: toMicro(t.quantity), orderId: t.sourceId.toLowerCase(), lineId: t.sourceLineId.toLowerCase() };
}

/** A-307-1: görevin deposundaki ACTIVE STAGING lokasyonlarından kodu en küçük olan; yoksa `null`. */
async function stagingOf(tx: AccessTx, tenantId: string, warehouseId: string): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND kind = 'STAGING' AND status = 'ACTIVE'
         ORDER BY code, id LIMIT 1`,
  );
  return rows[0]?.id.toLowerCase() ?? null;
}

const isPlain = (k: StockDimensionKey): boolean => k.stockStatus === "AVAILABLE" && k.lotId === null && k.serialId === null && k.inventoryOwnerId === null && k.handlingUnitId === null;

// ---------------------------------------------------------------------------------------------------------------------
// createPickAssignment
// ---------------------------------------------------------------------------------------------------------------------
export interface PickAssignmentInput {
  /** 1–200 sipariş (OPEN). */
  readonly orderIds: readonly string[];
  /** Verilirse üretilen görevler bu üyeye atanır (`stock.post` izni ve depo kapsamı gerekir). */
  readonly assigneeMembershipId?: string | null;
  readonly requestId?: string | null;
}
export type PickAssignmentResult = Done & {
  /** Ortak `group_id` (görev üretildiyse). */
  readonly groupId: string | null;
  /** Üretilen görevler, üretim sırasıyla (lokasyon kodu, sipariş no, satır no). */
  readonly taskIds: readonly string[];
};

type SourceDb = { order_id: string; number: string; line_id: string; line_no: number | string; item_id: string; location_id: string; code: string; warehouse_id: string; qty: string };
/** Siparişlerin STORAGE'taki tahsisli (takipsiz AVAILABLE) satır × lokasyon toplamları; depo kapsamı dışı lokasyonlar hiç görünmez. */
async function readPickSources(tx: AccessTx, tenantId: string, orderIds: readonly string[], scope: readonly string[] | null): Promise<PickSource[]> {
  if (scope !== null && scope.length === 0) return [];
  const rows = await tx.execute<SourceDb>(
    sql`SELECT o.id AS order_id, o.number, l.id AS line_id, l.line_no, d.item_id, d.location_id, loc.code, loc.warehouse_id, sum(r.quantity)::text AS qty
          FROM public.sales_orders o
          JOIN public.sales_order_lines l ON l.tenant_id = o.tenant_id AND l.order_id = o.id
          JOIN public.reservations r ON r.tenant_id = l.tenant_id AND r.order_line_id = l.id AND r.status = 'ACTIVE'
          JOIN public.stock_dimensions d ON d.tenant_id = r.tenant_id AND d.id = r.stock_dimension_id
          JOIN public.locations loc ON loc.tenant_id = d.tenant_id AND loc.id = d.location_id
         WHERE o.tenant_id = ${tenantId}::uuid AND o.id = ANY(${pgUuidArray(orderIds)}::uuid[])
           AND loc.kind = 'STORAGE' AND d.stock_status = 'AVAILABLE' AND d.lot_id IS NULL AND d.serial_id IS NULL AND d.inventory_owner_id IS NULL AND d.handling_unit_id IS NULL
           AND (${scope === null}::boolean OR loc.warehouse_id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))
         GROUP BY o.id, o.number, l.id, l.line_no, d.item_id, d.location_id, loc.code, loc.warehouse_id`,
  );
  return rows.map((r) => ({
    orderId: r.order_id.toLowerCase(), orderNumber: r.number, lineId: r.line_id.toLowerCase(), lineNo: Number(r.line_no), itemId: r.item_id.toLowerCase(),
    locationId: r.location_id.toLowerCase(), locationCode: r.code, warehouseId: r.warehouse_id.toLowerCase(), quantity: toMicro(r.qty),
  }));
}

/** Atanacak üye: bu tenant'ta ACTIVE, `stock.post` sahibi ve (A-46) görevlerin depolarını kapsıyor (`assignTask` ile aynı kurallar). */
async function assertAssignable(tx: AccessTx, m: Membership, membershipId: string, warehouseIds: readonly string[]): Promise<void> {
  const target = await tx.execute<{ role_key: string | null }>(
    sql`SELECT r.role_key
          FROM public.tenant_memberships tm
          LEFT JOIN public.membership_roles r ON r.tenant_id = tm.tenant_id AND r.membership_id = tm.id
         WHERE tm.tenant_id = ${m.tenantId}::uuid AND tm.id = ${membershipId}::uuid AND tm.status = 'ACTIVE'`,
  );
  if (target.length === 0) throw new AppError("NOT_FOUND");
  const roles = target.flatMap((r) => (r.role_key === null ? [] : [r.role_key]));
  if (!hasPermission(roles, TASK_KIND_PERMISSION.PICK)) throw invalid();
  const scope = await resolveWarehouseScope(tx, { ...m, membershipId, roles: roles as Membership["roles"] });
  if (scope !== null && warehouseIds.some((w) => !scope.includes(w.toLowerCase()))) throw invalid();
}

/** `document.approve`: bkz. dosya başı. Stok etkisi yok; sipariş başlıkları `FOR UPDATE` (kimlik sırasıyla), stok kilidi yok. */
export async function createPickAssignment(params: StockDocCallParams, input: PickAssignmentInput): Promise<PickAssignmentResult> {
  if (!Array.isArray(input.orderIds) || input.orderIds.length < 1) throw invalid();
  if (input.orderIds.length > ORDERS_MAX) throw tooLarge();
  const orderIds = [...new Set(input.orderIds.map(uuidOf))].sort(cmpStr);
  const assignee = input.assigneeMembershipId === undefined || input.assigneeMembershipId === null ? null : uuidOf(input.assigneeMembershipId);
  const hashInput = { orderIds, assigneeMembershipId: assignee };
  let plannedWarehouses: ReadonlySet<string> = new Set();
  const result = completed(
    await executeStockCommand<typeof hashInput, StockCommandResult>({
      db: params.db,
      principal: params.principal,
      tenantSlug: params.tenantSlug,
      clientKey: params.clientKey,
      commandType: "pick.assign",
      permission: "document.approve",
      input: hashInput,
      ...(params.retry === undefined ? {} : { retry: params.retry }),
      ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
      ...(params.logger === undefined ? {} : { logger: params.logger }),
      plan: async (tx, _i, m): Promise<StockCommandPlan> => {
        const found = await tx.execute<{ id: string }>(
          sql`SELECT id FROM public.sales_orders WHERE tenant_id = ${m.tenantId}::uuid AND id = ANY(${pgUuidArray(orderIds)}::uuid[])`,
        );
        if (found.length !== orderIds.length) throw new AppError("NOT_FOUND");
        const scope = await resolveWarehouseScope(tx, m);
        const sources = await readPickSources(tx, m.tenantId, orderIds, scope);
        const warehouseIds = [...new Set(sources.map((s) => s.warehouseId))];
        plannedWarehouses = new Set(warehouseIds);
        return emptyPlan(warehouseIds);
      },
      apply: async (tx, _locked, ctx) => {
        // Sipariş başlıkları kimlik sırasıyla `FOR UPDATE`: reserve/cancel/confirmPick ile seri çalışır; stok kilidi tutulmadığından döngü yok.
        const heads = await tx.execute<{ id: string; status: string }>(
          sql`SELECT id, status FROM public.sales_orders WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${pgUuidArray(orderIds)}::uuid[]) ORDER BY id FOR UPDATE`,
        );
        if (heads.length !== orderIds.length) throw new AppError("NOT_FOUND");
        if (heads.some((h) => h.status !== "OPEN")) throw documentState();
        const scope = await resolveWarehouseScope(tx, ctx.membership);
        const sources = await readPickSources(tx, ctx.tenantId, orderIds, scope);
        if (sources.some((s) => !plannedWarehouses.has(s.warehouseId))) throw versionConflict(); // plandan sonra yeni depoda tahsis çıktı: kapsam yeniden denetlenir
        const lines = await tx.execute<{ id: string; line_no: number | string; number: string }>(
          sql`SELECT l.id, l.line_no, o.number FROM public.sales_order_lines l JOIN public.sales_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
               WHERE l.tenant_id = ${ctx.tenantId}::uuid AND l.order_id = ANY(${pgUuidArray(orderIds)}::uuid[]) ORDER BY o.number, l.line_no, l.id`,
        );
        const open = await tx.execute<{ source_line_id: string; location_id: string; qty: string }>(
          sql`SELECT source_line_id, location_id, sum(quantity)::text AS qty FROM public.warehouse_tasks
               WHERE tenant_id = ${ctx.tenantId}::uuid AND kind = 'PICK' AND status IN ('OPEN', 'ASSIGNED')
                 AND source_line_id = ANY(${pgUuidArray(lines.map((l) => l.id))}::uuid[])
               GROUP BY source_line_id, location_id`,
        );
        const openByKey = new Map(open.map((o) => [`${o.source_line_id.toLowerCase()}|${o.location_id.toLowerCase()}`, toMicro(o.qty)]));
        const specs = planPickTasks(sources, openByKey);
        const assignedOf = new Map<string, bigint>();
        for (const s of specs) assignedOf.set(s.lineId, (assignedOf.get(s.lineId) ?? 0n) + s.quantity);
        const linesOut = lines.map((l) => ({ lineId: l.id, lineNo: Number(l.line_no), quantity: microToDecimal(assignedOf.get(l.id.toLowerCase()) ?? 0n) }));
        if (specs.length === 0) return { result: { lines: linesOut }, audit: null }; // görev yok = durum değişimi yok (kayıtlı audit eylemi yok)
        for (const w of new Set(specs.map((s) => s.warehouseId))) {
          if ((await stagingOf(tx, ctx.tenantId, w)) === null) throw invalid(); // hedef STAGING lokasyonu yok (A-307-1)
        }
        if (assignee !== null) await assertAssignable(tx, ctx.membership, assignee, [...new Set(specs.map((s) => s.warehouseId))]);
        const groupId = randomUUID();
        const inputs: NewTaskInput[] = specs.map((s) => ({
          warehouseId: s.warehouseId,
          kind: "PICK",
          groupId,
          sourceKind: "SALES_ORDER",
          sourceId: s.orderId,
          sourceLineId: s.lineId,
          locationId: s.locationId,
          itemId: s.itemId,
          quantity: microToDecimal(s.quantity),
        }));
        const taskIds = await createTasks(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, inputs, input.requestId ?? null);
        if (assignee !== null) {
          const upd = await tx.execute<{ id: string; version: number | string }>(
            sql`UPDATE public.warehouse_tasks SET status = 'ASSIGNED', assigned_membership_id = ${assignee}::uuid
                 WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${pgUuidArray(taskIds)}::uuid[]) AND status = 'OPEN' RETURNING id, version`,
          );
          if (upd.length !== taskIds.length) throw new AppError("INTERNAL"); // yeni doğan görev; sessiz no-op yok
          for (const u of upd) {
            await appendAudit(tx, {
              action: "warehouse_task.assigned",
              actorUserId: ctx.userId,
              entityType: "warehouse_task",
              entityId: u.id,
              requestId: input.requestId ?? null,
              changeSummary: { from_status: "OPEN", to_status: "ASSIGNED", from_membership_id: null, to_membership_id: assignee, version: Number(u.version) },
            });
          }
        }
        return {
          result: { documentId: groupId, lines: linesOut },
          audit: {
            action: "pick_assignment.created",
            entityType: "pick_assignment",
            entityId: groupId,
            requestId: input.requestId ?? null,
            changeSummary: { orderCount: orderIds.length, taskCount: taskIds.length, assigned: assignee !== null },
          },
        };
      },
    }),
  );
  // Görev kimlikleri sonuçta (beyaz liste) yoktur: grup kimliğiyle, üretim sırasıyla okunur (yeniden oynatmada da aynı).
  const groupId = result.documentId ?? null;
  const taskIds =
    groupId === null
      ? []
      : await runTenantQuery({ ...params, permission: "document.approve" }, async (tx, m) => {
          const rows = await tx.execute<{ id: string }>(
            sql`SELECT t.id FROM public.warehouse_tasks t
                  JOIN public.locations loc ON loc.tenant_id = t.tenant_id AND loc.id = t.location_id
                  JOIN public.sales_order_lines l ON l.tenant_id = t.tenant_id AND l.id = t.source_line_id
                  JOIN public.sales_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
                 WHERE t.tenant_id = ${m.tenantId}::uuid AND t.group_id = ${groupId}::uuid
                 ORDER BY loc.code, o.number, l.line_no, t.id`,
          );
          return rows.map((r) => r.id);
        });
  return { ...result, groupId, taskIds };
}

// ---------------------------------------------------------------------------------------------------------------------
// confirmPick
// ---------------------------------------------------------------------------------------------------------------------
export interface ConfirmPickInput {
  readonly taskId: string;
  /** Bulunan miktar, OKUTULAN BARKODUN biriminde ve okutma başına miktarıyla çarpılarak temel birime çevrilir (A-307-2); 0 = hiç bulunamadı. */
  readonly foundQuantity: string;
  /** Okutulan lokasyon kodu (görevdeki kaynak lokasyonla eşleşmeli). */
  readonly scannedLocationCode: string;
  /** Okutulan ürün barkodu (`resolveBarcode`; görevdeki ürüne çözülmeli). */
  readonly scannedItemBarcode: string;
  readonly requestId?: string | null;
}
export interface PickReallocation {
  /** `ALLOCATED`: yeni rezervasyon eklendi · `NONE`: uygun stok yok (satır rezervesiz açık kalır) · `FAILED`: komut başarısız (ara durum; `code`). */
  readonly status: "ALLOCATED" | "NONE" | "FAILED";
  /** Yalnızca YENİDEN OYNATMADA: `DONE` saklı sonuç döndü · `RETRIED` yeniden tahsis şimdi çalıştı · `FAILED` saklı ret ya da şimdiki hata. */
  readonly replay?: "DONE" | "RETRIED" | "FAILED";
  /** Bu çağrıda tahsis edilen temel birim miktarı (ondalık dizgi). */
  readonly quantity?: string;
  readonly reservationIds?: readonly string[];
  readonly code?: string;
}
export interface PickNotFound {
  readonly shortQuantity: string;
  readonly locationId: string;
  /** Açık sayım görevi (aynı lokasyonda mevcut olan ya da bu komutun açtığı); SAKLI sonuçtan okunur. */
  readonly countTaskId: string;
}
export type ConfirmPickResult = Done & {
  readonly taskId: string;
  /** Temel birimde bulunan miktar. */
  readonly foundQuantity: string;
  readonly notFound?: PickNotFound;
  /** Yalnızca "bulunamadı"da ve yeniden oynatma OLMADAN (bkz. dosya başı). */
  readonly reallocation?: PickReallocation;
};

async function systemTypeVersionId(tx: AccessTx, kind: string): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = ${kind} AND version = 1`);
  const id = rows[0]?.id;
  if (id === undefined) throw new AppError("INTERNAL");
  return id;
}

/**
 * Toplama taşıması: primitif `STOCK_MOVE` belgesini aynı transaction'da oluştur → onayla → işle (T-305 bileşik yolu: `registerTxCreatedDocument` +
 * `postApprovedDocumentInTx`), sipariş rezervasyonları `moves` ile hedef boyuta taşınır. (`postFieldDocument` `moves` taşımaz; dosyası bu kartın kapsamında değil.)
 */
async function postPickMove(
  tx: AccessTx,
  locked: LockedState,
  ctx: StockCommandContext,
  a: { readonly spec: FieldPostSpec; readonly taskId: string; readonly reservationIds: readonly string[]; readonly requestId: string | null },
): Promise<StockCommandApplied> {
  const wh = await tx.execute<{ status: string }>(
    sql`SELECT status FROM public.warehouses WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${a.spec.warehouseId}::uuid FOR SHARE`,
  );
  if (wh[0] === undefined) throw new AppError("NOT_FOUND");
  if (wh[0].status !== "ACTIVE") throw invalid();
  const line = a.spec.lines[0];
  if (line === undefined || a.spec.lines.length !== 1) throw new AppError("INTERNAL");
  const date = await tenantToday(tx, ctx.tenantId);
  const typeVersionId = await systemTypeVersionId(tx, "STOCK_MOVE");
  const documentId = randomUUID();
  const lineId = randomUUID();
  registerTxCreatedDocument(tx, documentId);
  await tx.execute(
    sql`INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by, source_kind, source_id)
        VALUES (${ctx.tenantId}::uuid, ${documentId}::uuid, 'STOCK_MOVE', ${typeVersionId}::uuid, ${a.spec.warehouseId}::uuid, ${date}::date, ${ctx.userId}::uuid, 'TASK', ${a.taskId}::uuid)`,
  );
  await tx.execute(
    sql`INSERT INTO public.document_lines
          (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, source_location_id, target_location_id, stock_status, target_stock_status, source_line_id)
        VALUES (${ctx.tenantId}::uuid, ${lineId}::uuid, ${documentId}::uuid, 1, ${line.itemId}::uuid, ${line.unitId}::uuid, ${line.quantity}::numeric, ${line.conversionFactor}::numeric,
                ${line.baseQuantity}::numeric, ${line.sourceLocationId}::uuid, ${line.targetLocationId}::uuid, ${line.stockStatus}, ${line.targetStockStatus}, NULL)`,
  );
  const approved = await tx.execute<{ id: string }>(
    sql`UPDATE public.documents SET status = 'APPROVED' WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${documentId}::uuid AND status = 'DRAFT' RETURNING id`,
  );
  if (approved[0] === undefined) throw new AppError("INTERNAL");
  return postApprovedDocumentInTx(tx, locked, ctx, documentId, { requestId: a.requestId, moves: [{ lineId, reservationIds: a.reservationIds, allowOrderReservations: true }] });
}

/** Barkodun birimi → temel birim katsayısı (temel birim 1; aksi `unit_conversions`). Dönüşümü olmayan birim `VALIDATION_FAILED`. */
async function unitFactor(tx: AccessTx, tenantId: string, itemId: string, unitId: string): Promise<{ readonly factor: string; readonly baseUnitId: string; readonly scale: number }> {
  const it = await tx.execute<{ base_unit_id: string; quantity_scale: number | string }>(
    sql`SELECT base_unit_id, quantity_scale FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid`,
  );
  const item = it[0];
  if (item === undefined) throw new AppError("NOT_FOUND");
  const base = { baseUnitId: item.base_unit_id, scale: Number(item.quantity_scale) };
  if (item.base_unit_id.toLowerCase() === unitId.toLowerCase()) return { factor: "1.000000", ...base };
  const c = await tx.execute<{ f: string }>(
    sql`SELECT to_base_factor::text AS f FROM public.unit_conversions WHERE tenant_id = ${tenantId}::uuid AND item_id = ${itemId}::uuid AND unit_id = ${unitId}::uuid`,
  );
  if (c[0] === undefined) throw invalid();
  return { factor: c[0].f, ...base };
}

function parseScan(raw: unknown): string {
  if (typeof raw !== "string") throw invalid();
  const v = raw.trim();
  if (v === "" || v.length > SCAN_MAX) throw invalid();
  return v;
}

/** `stock.post`: bkz. dosya başı. */
export async function confirmPick(params: StockDocCallParams, input: ConfirmPickInput): Promise<ConfirmPickResult> {
  const taskId = uuidOf(input.taskId);
  if (typeof input.foundQuantity !== "string" || !DECIMAL_RE.test(input.foundQuantity)) throw invalid();
  const foundText = input.foundQuantity;
  const scannedLocation = parseScan(input.scannedLocationCode);
  const scannedBarcode = parseScan(input.scannedItemBarcode);
  const hashInput = { taskId, foundQuantity: foundText, scannedLocationCode: scannedLocation, scannedItemBarcode: scannedBarcode };
  let plannedStaging: string | null = null;
  const requestId = input.requestId ?? null;
  const result = completed(
    await executeStockCommand<typeof hashInput, StockCommandResult>({
      db: params.db,
      principal: params.principal,
      tenantSlug: params.tenantSlug,
      clientKey: params.clientKey,
      commandType: "pick.confirm",
      permission: "stock.post",
      input: hashInput,
      ...(params.retry === undefined ? {} : { retry: params.retry }),
      ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
      ...(params.logger === undefined ? {} : { logger: params.logger }),
      plan: async (tx, _i, m): Promise<StockCommandPlan> => {
        const t = await readTask(tx, m.tenantId, taskId, false); // yok → NOT_FOUND
        try {
          const f = pickFields(t);
          const staging = await stagingOf(tx, m.tenantId, t.warehouseId);
          if (staging === null) throw invalid();
          plannedStaging = staging;
          const rows = (await readReservationPlanRows(tx, m.tenantId, { orderLineId: f.lineId })).filter(
            (r) => r.status === "ACTIVE" && r.key.locationId.toLowerCase() === f.locationId && r.key.itemId.toLowerCase() === f.itemId && isPlain(r.key),
          );
          const plan = await planFieldPosting(tx, m.tenantId, {
            kind: "STOCK_MOVE",
            warehouseId: t.warehouseId,
            sourceKind: "TASK",
            sourceId: t.id,
            lines: [{ itemId: f.itemId, unitId: PLAN_UNIT, quantity: "1", conversionFactor: "1", baseQuantity: "1", sourceLocationId: f.locationId, targetLocationId: staging, stockStatus: "AVAILABLE", targetStockStatus: null, sourceLineId: null }],
          });
          return { warehouseIds: plan.warehouseIds, locks: { ...plan.locks, reservationIds: rows.map((r) => r.id.toLowerCase()).sort(cmpStr) } };
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          return emptyPlan([t.warehouseId]); // apply kilit altında asıl hatayı verir
        }
      },
      apply: async (tx, locked, ctx) => {
        const t0 = await readTask(tx, ctx.tenantId, taskId, false); // değişmez alanlar (guard_keys); başlık kilidi için sipariş kimliği
        const f = pickFields(t0);
        // Kilit sırası: stok (alındı) → sipariş başlığı → görev.
        const head = await tx.execute<{ status: string }>(
          sql`SELECT status FROM public.sales_orders WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${f.orderId}::uuid FOR UPDATE`,
        );
        if (head[0] === undefined) throw new AppError("NOT_FOUND");
        const task = await readTask(tx, ctx.tenantId, taskId, true);
        if (task.status !== "OPEN" && task.status !== "ASSIGNED") throw documentState();
        if (task.status === "ASSIGNED" && task.assignedMembershipId !== ctx.membership.membershipId && !hasPermission(ctx.membership.roles, "document.approve")) {
          throw new AppError("FORBIDDEN");
        }
        if (head[0].status !== "OPEN") throw documentState();
        await assertWarehouseVisible(tx, ctx.membership, [task.warehouseId]);

        // Okutma doğrulaması (yazımdan ÖNCE): lokasyon kodu ve ürün barkodu görevle eşleşmeli.
        const loc = await tx.execute<{ code: string }>(sql`SELECT code FROM public.locations WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${f.locationId}::uuid`);
        if (loc[0] === undefined) throw new AppError("NOT_FOUND");
        if (normalizeCode(scannedLocation) !== normalizeCode(loc[0].code)) throw scanMismatch();
        let resolved;
        try {
          resolved = await resolveBarcode(tx, ctx.tenantId, scannedBarcode);
        } catch (e) {
          if (e instanceof BarcodeNotFoundError) throw scanMismatch(); // bilinmeyen barkod görevdeki ürün değildir
          throw e;
        }
        if (resolved.itemId.toLowerCase() !== f.itemId) throw scanMismatch();
        const unit = await unitFactor(tx, ctx.tenantId, f.itemId, resolved.unitId);
        const found = scaledBaseQuantity(foundText, resolved.quantity, unit.factor);
        if (found % 10n ** BigInt(6 - unit.scale) !== 0n) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });

        // Rezervasyonlar: kilit sonrası yeniden okunur; kilitli görüntüyle uyuşmayan satır plan bayattır.
        const rows = (await readReservationPlanRows(tx, ctx.tenantId, { orderLineId: f.lineId })).filter(
          (r) => r.status === "ACTIVE" && r.key.locationId.toLowerCase() === f.locationId && r.key.itemId.toLowerCase() === f.itemId && isPlain(r.key),
        );
        const lockedById = new Map(locked.reservations.map((r) => [r.id.toLowerCase(), r]));
        const dimIds = new Map(locked.dimensions.map((d) => [dimensionIdentity(d.key), d.id]));
        let reserved = 0n;
        for (const r of rows) {
          const lr = lockedById.get(r.id.toLowerCase());
          if (lr === undefined || lr.status !== "ACTIVE" || lr.stockDimensionId !== dimIds.get(dimensionIdentity(r.key))) throw versionConflict();
          reserved += toMicro(lr.quantity);
        }
        if (reserved === 0n) throw documentState(); // tahsis kalmadı (iptal/serbest): görev bayat
        const { expected, short } = pickShortfall(f.quantity, reserved, found);
        if (short < 0n) throw invalid(); // beklenenden fazla toplama yok (A-307-3)
        const staging = await stagingOf(tx, ctx.tenantId, task.warehouseId);
        if (staging === null) throw invalid();
        if (plannedStaging !== null && staging !== plannedStaging) throw versionConflict();

        // "Ürün bulunamadı": lokasyon satırı posting çekirdeğinin `FOR SHARE`ından ÖNCE `FOR NO KEY UPDATE` (yükseltme kilitlenmesi yok; bkz. dosya başı).
        if (short > 0n) {
          const l = await tx.execute<{ id: string }>(
            sql`SELECT id FROM public.locations WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${f.locationId}::uuid FOR NO KEY UPDATE`,
          );
          if (l[0] === undefined) throw new AppError("NOT_FOUND");
        }

        let applied: StockCommandApplied | undefined;
        if (found > 0n) {
          const spec: FieldPostSpec = {
            kind: "STOCK_MOVE",
            warehouseId: task.warehouseId,
            sourceKind: "TASK",
            sourceId: task.id,
            lines: [
              {
                itemId: f.itemId,
                unitId: unit.baseUnitId,
                quantity: microToDecimal(found),
                conversionFactor: "1.000000",
                baseQuantity: microToDecimal(found),
                sourceLocationId: f.locationId,
                targetLocationId: staging,
                stockStatus: "AVAILABLE",
                targetStockStatus: null,
                sourceLineId: null,
              },
            ],
          };
          applied = await postPickMove(tx, locked, ctx, { spec, taskId: task.id, reservationIds: rows.map((r) => r.id.toLowerCase()).sort(cmpStr), requestId });
        }

        let countTaskId: string | null = null;
        let notFoundAudit: StockCommandApplied["audit"] = null;
        if (short > 0n) {
          // Eksik kısmın rezervasyonu serbest: taşımadan sonra kalan satırlar TAZE okunur (kilitli görüntüdeki miktar bayat).
          const remaining = (await readReservationPlanRows(tx, ctx.tenantId, { orderLineId: f.lineId })).filter(
            (r) => r.status === "ACTIVE" && r.key.locationId.toLowerCase() === f.locationId && r.key.itemId.toLowerCase() === f.itemId && isPlain(r.key),
          );
          if (remaining.length === 0) throw new AppError("INTERNAL");
          const rel = await releaseSelected(tx, ctx.tenantId, locked, remaining, short, { freshQuantities: true });
          const upd = await tx.execute<{ id: string }>(
            sql`UPDATE public.locations SET pick_blocked = true WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${f.locationId}::uuid RETURNING id`,
          );
          if (upd[0] === undefined) throw new AppError("INTERNAL");
          // Lokasyon başına en çok bir açık sayım görevi (lokasyon satırı kilidi bu denetimi seri yapar).
          const existing = await tx.execute<{ id: string }>(
            sql`SELECT id FROM public.warehouse_tasks WHERE tenant_id = ${ctx.tenantId}::uuid AND kind = 'COUNT' AND status IN ('OPEN', 'ASSIGNED') AND location_id = ${f.locationId}::uuid
                 ORDER BY created_at, id LIMIT 1`,
          );
          countTaskId =
            existing[0]?.id ??
            (
              await createTasks(
                tx,
                { tenantId: ctx.tenantId, userId: ctx.userId },
                [{ warehouseId: task.warehouseId, kind: "COUNT", sourceKind: "SALES_ORDER", sourceId: f.orderId, sourceLineId: f.lineId, locationId: f.locationId }],
                requestId,
              )
            )[0] ??
            null;
          notFoundAudit = {
            action: "pick.not_found",
            entityType: "location",
            entityId: f.locationId,
            requestId,
            changeSummary: {
              taskId: task.id,
              orderId: f.orderId,
              foundQuantity: microToDecimal(found),
              expectedQuantity: microToDecimal(expected),
              shortQuantity: microToDecimal(short),
              releasedReservations: rel.closedIds.length,
              countTaskId,
            },
          };
          if (applied !== undefined) await appendAudit(tx, { ...notFoundAudit, actorUserId: ctx.userId });
        }
        await completeTask(tx, task.id, task.version, ctx.membership, requestId);
        // Saklı sonuç: lines[0] = görev (quantity = bulunan, baseQuantity = beklenen); "bulunamadı"da lines[1] = sayım görevi (lineId = görev kimliği, quantity = eksik).
        const line = { lineId: task.id, lineNo: 1, quantity: microToDecimal(found), baseQuantity: microToDecimal(expected) };
        const resultLines = countTaskId === null ? [line] : [line, { lineId: countTaskId, lineNo: 2, quantity: microToDecimal(short) }];
        if (applied !== undefined) return { ...applied, result: { ...applied.result, lines: resultLines } };
        return { result: { lines: resultLines }, audit: notFoundAudit };
      },
    }),
  );

  // Sonuç gövdesi: saklı sonuçtan türetilir (yeniden oynatmada da aynı): lines[0].quantity = bulunan, baseQuantity = beklenen.
  const entry = result.lines?.[0];
  if (entry === undefined || entry.quantity === undefined || entry.baseQuantity === undefined) throw new AppError("INTERNAL");
  const shortMicro = toMicro(entry.baseQuantity) - toMicro(entry.quantity);
  const base: ConfirmPickResult = { ...result, taskId, foundQuantity: entry.quantity };
  if (shortMicro <= 0n) return base;
  const countEntry = result.lines?.[1];
  if (countEntry === undefined) throw new AppError("INTERNAL"); // eksik varsa sayım görevi saklı sonuçta olmalı
  const fields = await runTenantQuery({ ...params, permission: "stock.post" }, async (tx, m) => pickFields(await readTask(tx, m.tenantId, taskId, false))); // değişmez alanlar
  const notFound: PickNotFound = { shortQuantity: microToDecimal(shortMicro), locationId: fields.locationId, countTaskId: countEntry.lineId };
  return { ...base, notFound, reallocation: await tryReallocate(params, fields, taskId, requestId, result.replayed) };
}

/** Görevden deterministik UUID (SHA-256; sürüm/varyant bitleri ayarlı): görev başına tek yeniden tahsis idempotency kaydı. `clientKey`'den türetilmez. */
export function reallocationKey(taskId: string): string {
  const h = createHash("sha256").update(`pick-reallocation:${taskId.toLowerCase()}`).digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** Yeniden tahsis: AYRI komut, görevden türetilen deterministik anahtar (bkz. dosya başı). Hata yutulmaz: `FAILED` + kod yanıtta ve günlükte. */
async function tryReallocate(params: StockDocCallParams, f: PickTaskFields, taskId: string, requestId: string | null, pickReplayed: boolean): Promise<PickReallocation> {
  try {
    const r = await reallocateOrderLine({ ...params, clientKey: reallocationKey(taskId) }, { orderId: f.orderId, lineId: f.lineId, requestId });
    const ids = r.reservationIds ?? [];
    return {
      status: ids.length > 0 ? "ALLOCATED" : "NONE",
      quantity: r.lines?.[0]?.quantity ?? "0.000000",
      reservationIds: ids,
      ...(pickReplayed ? { replay: r.replayed ? ("DONE" as const) : ("RETRIED" as const) } : {}),
    };
  } catch (e) {
    const code = e instanceof AppError ? e.code : "INTERNAL";
    params.logger?.error("pick.reallocation_failed", { code, orderId: f.orderId, lineId: f.lineId });
    return { status: "FAILED", code, ...(pickReplayed ? { replay: "FAILED" as const } : {}) };
  }
}
