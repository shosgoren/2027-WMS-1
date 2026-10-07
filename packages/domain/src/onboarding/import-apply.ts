// Açılış verisi içe aktarma: önizleme ve parça parça uygulama (T-289). Yalnız MEVCUT domain komutları çağrılır (G-01):
// `createUnit` (koli birimi), `createItem`, `setUnitConversion`, `addBarcode` (T-208) ve açılış stoku için
// `createStockDocument` → `approveDocument` → `postDocument` (`STOCK_IN`, A-79; bakiyeye doğrudan yazılmaz).
// Bu dosya stok kilidi almaz/`FOR UPDATE` yazmaz; kilitler stok komutlarının içindedir (`acquireStockLocks`).
//
// - Önizleme (`previewImport`) hiçbir şey yazmaz; tüm sorunlar tek seferde döner. Uygulama (`applyImportChunk`) aynı dosyayı SUNUCUDA yeniden
//   ayrıştırır (istemciye güvenilmez); sorun varsa HİÇBİR şey yazılmaz (`VALIDATION_FAILED`).
// - Parça: bir çağrı `IMPORT_CHUNK_SIZE` (200) satırı işler; istemci parçaları sırayla çağırır. Her parça kendi komutlarında kalıcıdır; ilk
//   başarısız satırda DURULUR ve hangi satırların uygulandığı / denenmediği açıkça raporlanır (sahte başarı yok, G-07). Aynı dosyayı yeniden
//   yüklemek kalan parçaları tamamlar.
// - İdempotans: ürünler kodla (`CODE_TAKEN`/mevcut kayıt = zaten var, ek audit yok); stok belgeleri dosya özeti + parça + depo + adımdan türeyen
//   istemci anahtarlarıyla (A-73): aynı dosya ikinci kez yüklenirse komutlar önceki sonucu döndürür, ek defter satırı oluşmaz.
// - Dosya içeriği diske/loga yazılmaz; yalnız bellek (G-09). Audit: her komut kendi audit'ini yazar; `requestId` hepsini bağlar.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { addBarcode } from "../catalog/barcodes.ts";
import { createItem } from "../catalog/items.ts";
import { createUnit, setUnitConversion } from "../catalog/units.ts";
import { runTenantQuery, type AccessTx, type TenantAccessParams } from "../identity/access.ts";
import { approveDocument, createStockDocument, postDocument, type DocumentLineInput } from "../stock/index.ts";
import {
  IMPORT_CHUNK_SIZE,
  PACK_UNIT_CODE,
  PACK_UNIT_NAME,
  classify,
  shelfKey,
  validateProducts,
  validateStock,
  type BarcodeInfoCtx,
  type ImportIssue,
  type ImportKind,
  type ItemInfoCtx,
  type PreviewResult,
  type ProductContext,
  type ProductPlan,
  type ShelfInfo,
  type StockContext,
  type StockPlan,
  type UnitInfo,
} from "./import-parse.ts";

export type ImportCallParams = Omit<TenantAccessParams, "permission" | "recentAuth"> & { readonly requestId?: string };

/** Önizlemede dönen en çok sorun sayısı (toplam ayrıca verilir; UI ilk 50'yi gösterir). */
export const PREVIEW_ISSUE_LIMIT = 100;
export const STOCK_REASON = "import.opening_stock";

export interface ImportPreview {
  readonly kind: ImportKind;
  /** Dosyadaki dolu veri satırı sayısı. */
  readonly rowCount: number;
  readonly issues: readonly ImportIssue[];
  readonly issueTotal: number;
  /**
   * Özet sayılar (başlık/dosya düzeyi sorun yoksa): ürün (ürün dosyasında satır, stok dosyasında farklı ürün), stok satırı ve hatalı satır.
   * Hata varsa da dosyadaki sayıları verir; "kaç şey içe aktarılacak" değil "dosyada ne var" bilgisidir.
   */
  readonly summary?: { readonly items: number; readonly stockLines: number; readonly errorRows: number };
  /** Yalnız ürünler: yeni oluşturulacak / sistemde zaten olan ürün sayısı, koli tanımı ve barkod sayıları. */
  readonly products?: { readonly create: number; readonly existing: number; readonly packs: number; readonly barcodes: number; readonly willCreatePackUnit: boolean };
  /** Yalnız açılış stoku: satır, ürün ve depo sayısı; toplam miktar (kanonik dizgi). */
  readonly stock?: { readonly lines: number; readonly items: number; readonly warehouses: number; readonly totalQuantity: string; readonly tenantHasStock: boolean };
  /** Hata yoksa kaç parçada uygulanır. */
  readonly chunkCount: number;
  /** Dosya özeti (kanonik içerik; biçimden bağımsız); stok anahtarlarının kaynağı. */
  readonly digest: string;
}

// --- sistem anlık görüntüsü ------------------------------------------------------------------------------------------

async function assertPermissions(params: ImportCallParams, kind: ImportKind): Promise<void> {
  const perms = kind === "PRODUCTS" ? (["settings.manage"] as const) : (["settings.manage", "document.create", "document.approve", "stock.post"] as const);
  for (const permission of perms) await runTenantQuery({ ...params, permission }, () => Promise.resolve(null));
}

function canonicalFactor(f: string): string {
  return f.includes(".") ? f.replace(/0+$/, "").replace(/\.$/, "") : f;
}

async function loadItems(tx: AccessTx, tenantId: string): Promise<Map<string, ItemInfoCtx>> {
  const rows = await tx.execute<{ id: string; code: string; name: string; base_unit_id: string; status: "ACTIVE" | "ARCHIVED"; quantity_scale: number; tracking_mode: string }>(
    sql`SELECT id, code, name, base_unit_id, status, quantity_scale, tracking_mode FROM public.items WHERE tenant_id = ${tenantId}::uuid`,
  );
  return new Map(
    rows.map((r) => [r.code, { id: r.id, code: r.code, name: r.name, baseUnitId: r.base_unit_id, status: r.status, quantityScale: Number(r.quantity_scale), trackingMode: r.tracking_mode }] as const),
  );
}

async function loadUnits(tx: AccessTx, tenantId: string): Promise<UnitInfo[]> {
  const rows = await tx.execute<UnitInfo>(sql`SELECT id, code, name, status FROM public.units WHERE tenant_id = ${tenantId}::uuid`);
  return [...rows];
}

async function loadProductContext(params: ImportCallParams): Promise<ProductContext> {
  return runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const units = await loadUnits(tx, m.tenantId);
    const items = await loadItems(tx, m.tenantId);
    const bc = await tx.execute<{ barcode: string; code: string; unit_id: string | null }>(
      sql`SELECT b.barcode, i.code, b.unit_id FROM public.item_barcodes b
            JOIN public.items i ON i.tenant_id = b.tenant_id AND i.id = b.item_id
           WHERE b.tenant_id = ${m.tenantId}::uuid`,
    );
    const barcodes = new Map<string, BarcodeInfoCtx[]>();
    for (const r of bc) barcodes.set(r.barcode, [...(barcodes.get(r.barcode) ?? []), { itemCode: r.code, unitId: r.unit_id }]);
    const cv = await tx.execute<{ code: string; unit_id: string; f: string }>(
      sql`SELECT i.code, c.unit_id, c.to_base_factor::text AS f FROM public.unit_conversions c
            JOIN public.items i ON i.tenant_id = c.tenant_id AND i.id = c.item_id
           WHERE c.tenant_id = ${m.tenantId}::uuid`,
    );
    const conversions = new Map<string, Map<string, string>>();
    for (const r of cv) {
      const inner = conversions.get(r.code) ?? new Map<string, string>();
      inner.set(r.unit_id, canonicalFactor(r.f));
      conversions.set(r.code, inner);
    }
    return { units, items, barcodes, conversions };
  });
}

async function loadStockContext(params: ImportCallParams): Promise<{ readonly ctx: StockContext; readonly tenantHasStock: boolean }> {
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const items = await loadItems(tx, m.tenantId);
    const rows = await tx.execute<{ id: string; warehouse_id: string; wcode: string; code: string; kind: string; status: "ACTIVE" | "ARCHIVED"; wstatus: string }>(
      sql`SELECT l.id, l.warehouse_id, w.code AS wcode, l.code, l.kind, l.status, w.status AS wstatus
            FROM public.locations l
            JOIN public.warehouses w ON w.tenant_id = l.tenant_id AND w.id = l.warehouse_id
           WHERE l.tenant_id = ${m.tenantId}::uuid`,
    );
    const shelves = new Map<string, ShelfInfo[]>();
    for (const r of rows) {
      const k = shelfKey(r.code);
      shelves.set(k, [
        ...(shelves.get(k) ?? []),
        { id: r.id, warehouseId: r.warehouse_id, warehouseCode: r.wcode, code: r.code, kind: r.kind, status: r.wstatus === "ACTIVE" ? r.status : "ARCHIVED" },
      ]);
    }
    const any = await tx.execute<{ x: number }>(sql`SELECT 1 AS x FROM public.stock_balances WHERE tenant_id = ${m.tenantId}::uuid AND quantity > 0 LIMIT 1`);
    return { ctx: { items, shelves }, tenantHasStock: any[0] !== undefined };
  });
}

// --- özet ve anahtarlar ----------------------------------------------------------------------------------------------

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Kanonik içerik özeti: ayırıcı, BOM, boşluk, sütun sırası ve başlık yazımı sonucu değiştirmez; yalnız doğrulanmış plan satırlarının değerleri girer. */
export function digestOf(kind: ImportKind, plans: readonly (ProductPlan | StockPlan)[]): string {
  const lines =
    kind === "PRODUCTS"
      ? (plans as readonly ProductPlan[]).map((p) => [p.code, p.name, p.baseUnitCode, p.packQty ?? "", p.unitBarcode ?? "", p.packBarcode ?? ""].join("\u001f"))
      : (plans as readonly StockPlan[]).map((p) => [p.itemCode, p.locationId, p.quantity].join("\u001f"));
  return sha(`${kind}\n${lines.join("\n")}`);
}

/** Belge adımı için kararlı istemci anahtarı (UUID biçimli; parseClientKey). Aynı dosya + parça + depo + adım → aynı anahtar (I-06). */
export function stockClientKey(digest: string, chunk: number, warehouseId: string, phase: "create" | "approve" | "post"): string {
  const h = sha(`import-stock|${digest}|${chunk}|${warehouseId}|${phase}`);
  // v4 biçimli UUID: sürüm/varyant bitleri sabitlenir.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function addDecimal(a: string, b: string): string {
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const total = BigInt(ai + af.padEnd(scale, "0")) + BigInt(bi + bf.padEnd(scale, "0"));
  const s = total.toString().padStart(scale + 1, "0");
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

// --- önizleme ---------------------------------------------------------------------------------------------------------

interface Evaluated {
  readonly kind: ImportKind;
  readonly result: PreviewResult<ProductPlan> | PreviewResult<StockPlan>;
  readonly productCtx?: ProductContext;
  readonly stockCtx?: StockContext;
  readonly tenantHasStock: boolean;
}

async function evaluate(params: ImportCallParams, text: string): Promise<Evaluated | { readonly early: ImportPreview }> {
  const c = classify(text);
  if (!c.ok) {
    return { early: { kind: "PRODUCTS", rowCount: 0, issues: c.issues, issueTotal: c.issues.length, chunkCount: 0, digest: "" } };
  }
  await assertPermissions(params, c.kind);
  if (c.kind === "PRODUCTS") {
    const productCtx = await loadProductContext(params);
    return { kind: c.kind, result: validateProducts(c.records, productCtx), productCtx, tenantHasStock: false };
  }
  const { ctx, tenantHasStock } = await loadStockContext(params);
  return { kind: c.kind, result: validateStock(c.records, ctx), stockCtx: ctx, tenantHasStock };
}

export async function previewImport(params: ImportCallParams, text: string): Promise<ImportPreview> {
  const ev = await evaluate(params, text);
  if ("early" in ev) return ev.early;
  const { result } = ev;
  const issues = result.issues.slice(0, PREVIEW_ISSUE_LIMIT);
  const headerLevel = result.issues.some((i) => i.row <= 1);
  const errorRows = new Set(result.issues.map((i) => i.row)).size;
  const summary = headerLevel
    ? undefined
    : { items: ev.kind === "PRODUCTS" ? result.rowCount : result.distinctItems, stockLines: ev.kind === "STOCK" ? result.rowCount : 0, errorRows };
  const base = { kind: ev.kind, rowCount: result.rowCount, issues, issueTotal: result.issues.length, ...(summary === undefined ? {} : { summary }) };
  if (ev.kind === "PRODUCTS") {
    const plans = result.plans as readonly ProductPlan[];
    const packUnit = ev.productCtx?.units.find((u) => u.code === PACK_UNIT_CODE);
    const packs = plans.filter((p) => p.packQty !== null).length;
    const clean = result.issues.length === 0;
    return {
      ...base,
      products: {
        create: clean ? plans.filter((p) => !p.exists).length : 0,
        existing: clean ? plans.filter((p) => p.exists).length : 0,
        packs: clean ? packs : 0,
        barcodes: clean ? plans.reduce((n, p) => n + (p.unitBarcode === null ? 0 : 1) + (p.packBarcode === null ? 0 : 1), 0) : 0,
        willCreatePackUnit: clean && (packs > 0 || plans.some((p) => p.packBarcode !== null)) && packUnit === undefined,
      },
      chunkCount: clean ? Math.ceil(plans.length / IMPORT_CHUNK_SIZE) : 0,
      digest: clean ? digestOf("PRODUCTS", plans) : "",
    };
  }
  const plans = result.plans as readonly StockPlan[];
  const clean = result.issues.length === 0;
  return {
    ...base,
    stock: {
      lines: clean ? plans.length : 0,
      items: clean ? new Set(plans.map((p) => p.itemId)).size : 0,
      warehouses: clean ? new Set(plans.map((p) => p.warehouseId)).size : 0,
      totalQuantity: clean ? plans.reduce((s, p) => addDecimal(s, p.quantity), "0") : "0",
      tenantHasStock: ev.tenantHasStock,
    },
    chunkCount: clean ? Math.ceil(plans.length / IMPORT_CHUNK_SIZE) : 0,
    digest: clean ? digestOf("STOCK", plans) : "",
  };
}

// --- uygulama ---------------------------------------------------------------------------------------------------------

export type RowStatus = "CREATED" | "UPDATED" | "UNCHANGED" | "APPLIED" | "REPLAYED" | "FAILED" | "NOT_ATTEMPTED";

export interface RowReport {
  readonly row: number;
  readonly code: string;
  readonly status: RowStatus;
  /** Yalnız `FAILED`: hata kodu (`ERROR_CODES`) ve varsa ayrıntı. */
  readonly errorCode?: string;
  readonly errorDetail?: string;
}

export interface ChunkReport {
  readonly kind: ImportKind;
  readonly chunk: number;
  readonly chunkCount: number;
  readonly digest: string;
  readonly rows: readonly RowReport[];
  readonly counts: Readonly<Record<RowStatus, number>>;
  /** Parça tamamen uygulandı (hata yok); istemci sıradaki parçaya geçebilir. */
  readonly complete: boolean;
}

function counts(rows: readonly RowReport[]): Record<RowStatus, number> {
  const c: Record<RowStatus, number> = { CREATED: 0, UPDATED: 0, UNCHANGED: 0, APPLIED: 0, REPLAYED: 0, FAILED: 0, NOT_ATTEMPTED: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

function errorOf(e: unknown): { errorCode: string; errorDetail?: string } {
  if (e instanceof AppError) return { errorCode: e.code, ...(e.detail === undefined ? {} : { errorDetail: e.detail }) };
  return { errorCode: "INTERNAL" };
}

const isCodeTaken = (e: unknown): boolean => e instanceof AppError && e.code === "VALIDATION_FAILED" && e.detail === "CODE_TAKEN";

/**
 * Bir parçayı uygular. Yetki/doğrulama hataları (`FORBIDDEN`, `VALIDATION_FAILED`) FIRLATILIR (hiçbir şey yazılmamıştır); satır düzeyindeki
 * komut hataları rapora `FAILED` olarak girer ve parça orada durur (sonraki satırlar `NOT_ATTEMPTED`).
 */
export async function applyImportChunk(params: ImportCallParams, input: { readonly text: string; readonly chunk: number }): Promise<ChunkReport> {
  if (!Number.isSafeInteger(input.chunk) || input.chunk < 0) throw new AppError("VALIDATION_FAILED");
  const ev = await evaluate(params, input.text);
  if ("early" in ev || ev.result.issues.length > 0) throw new AppError("VALIDATION_FAILED"); // hata varken HİÇBİR şey yazılmaz
  const chunkCount = Math.ceil(ev.result.plans.length / IMPORT_CHUNK_SIZE);
  if (input.chunk >= chunkCount) throw new AppError("VALIDATION_FAILED");
  const from = input.chunk * IMPORT_CHUNK_SIZE;
  if (ev.kind === "PRODUCTS") {
    const plans = (ev.result.plans as readonly ProductPlan[]).slice(from, from + IMPORT_CHUNK_SIZE);
    const rows = await applyProducts(params, plans, ev.productCtx as ProductContext);
    return { kind: "PRODUCTS", chunk: input.chunk, chunkCount, digest: digestOf("PRODUCTS", ev.result.plans), rows, counts: counts(rows), complete: !rows.some((r) => r.status === "FAILED") };
  }
  const all = ev.result.plans as readonly StockPlan[];
  const digest = digestOf("STOCK", all);
  const rows = await applyStock(params, all.slice(from, from + IMPORT_CHUNK_SIZE), ev.stockCtx as StockContext, digest, input.chunk);
  return { kind: "STOCK", chunk: input.chunk, chunkCount, digest, rows, counts: counts(rows), complete: !rows.some((r) => r.status === "FAILED") };
}

async function applyProducts(params: ImportCallParams, plans: readonly ProductPlan[], ctx: ProductContext): Promise<RowReport[]> {
  const p = { ...params };
  const rows: RowReport[] = [];
  const unitId = new Map(ctx.units.map((u) => [u.code, u.id] as const));
  let packUnitId = unitId.get(PACK_UNIT_CODE);
  const ensurePackUnit = async (): Promise<string> => {
    if (packUnitId !== undefined) return packUnitId;
    try {
      packUnitId = (await createUnit(p, { code: PACK_UNIT_CODE, name: PACK_UNIT_NAME })).unitId;
    } catch (e) {
      if (!isCodeTaken(e)) throw e;
      packUnitId = (await runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, m) => (await loadUnits(tx, m.tenantId)).find((u) => u.code === PACK_UNIT_CODE)?.id)) ?? undefined;
      if (packUnitId === undefined) throw new AppError("INTERNAL");
    }
    return packUnitId;
  };
  let failed = false;
  for (const plan of plans) {
    if (failed) {
      rows.push({ row: plan.row, code: plan.code, status: "NOT_ATTEMPTED" });
      continue;
    }
    try {
      let changed = false;
      let created = false;
      let itemId = ctx.items.get(plan.code)?.id;
      const baseUnit = unitId.get(plan.baseUnitCode) ?? ctx.units.find((u) => u.code === plan.baseUnitCode)?.id;
      if (baseUnit === undefined) throw new AppError("NOT_FOUND");
      if (itemId === undefined) {
        itemId = (await createItem(p, { code: plan.code, name: plan.name, baseUnitId: baseUnit })).itemId;
        created = true;
      }
      const needsPack = plan.packQty !== null || plan.packBarcode !== null;
      const pack = needsPack ? await ensurePackUnit() : undefined;
      if (plan.packQty !== null && pack !== undefined) {
        const sys = ctx.conversions.get(plan.code)?.get(pack);
        if (sys !== plan.packQty) {
          await setUnitConversion(p, { itemId, unitId: pack, factor: plan.packQty });
          changed = true;
        }
      }
      const existingBarcodes = (b: string): readonly BarcodeInfoCtx[] => ctx.barcodes.get(b) ?? [];
      if (plan.unitBarcode !== null) {
        const have = existingBarcodes(plan.unitBarcode).some((b) => b.itemCode === plan.code && (b.unitId === null || b.unitId === baseUnit));
        if (!have) {
          try {
            await addBarcode(p, { itemId, unitId: null, barcode: plan.unitBarcode });
            changed = true;
          } catch (e) {
            if (!isCodeTaken(e)) throw e;
          }
        }
      }
      if (plan.packBarcode !== null && pack !== undefined) {
        const have = existingBarcodes(plan.packBarcode).some((b) => b.itemCode === plan.code && b.unitId === pack);
        if (!have) {
          try {
            // K-1: koli barkodunda adet katsayıdan gelir; barkoda ayrı miktar yazılmaz.
            await addBarcode(p, { itemId, unitId: pack, barcode: plan.packBarcode });
            changed = true;
          } catch (e) {
            if (!isCodeTaken(e)) throw e;
          }
        }
      }
      rows.push({ row: plan.row, code: plan.code, status: created ? "CREATED" : changed ? "UPDATED" : "UNCHANGED" });
    } catch (e) {
      failed = true;
      rows.push({ row: plan.row, code: plan.code, status: "FAILED", ...errorOf(e) });
    }
  }
  return rows;
}

async function applyStock(params: ImportCallParams, plans: readonly StockPlan[], ctx: StockContext, digest: string, chunk: number): Promise<RowReport[]> {
  const itemById = new Map([...ctx.items.values()].map((i) => [i.id, i] as const));
  const byWarehouse = new Map<string, StockPlan[]>();
  for (const pl of plans) byWarehouse.set(pl.warehouseId, [...(byWarehouse.get(pl.warehouseId) ?? []), pl]);
  const reports = new Map<number, RowReport>();
  let failed = false;
  for (const [warehouseId, group] of byWarehouse) {
    if (failed) {
      for (const pl of group) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: "NOT_ATTEMPTED" });
      continue;
    }
    try {
      const lines: DocumentLineInput[] = group.map((pl) => {
        const item = itemById.get(pl.itemId);
        if (item === undefined) throw new AppError("INTERNAL");
        return { itemId: pl.itemId, unitId: item.baseUnitId, quantity: pl.quantity, conversionFactor: "1", baseQuantity: pl.quantity, targetLocationId: pl.locationId };
      });
      const call = (phase: "create" | "approve" | "post") => ({ db: params.db, principal: params.principal, tenantSlug: params.tenantSlug, clientKey: stockClientKey(digest, chunk, warehouseId, phase) });
      const rid = params.requestId === undefined ? {} : { requestId: params.requestId };
      const doc = await createStockDocument(call("create"), { kind: "STOCK_IN", warehouseId, reason: STOCK_REASON, lines, ...rid });
      const documentId = doc.documentId;
      if (documentId === undefined) throw new AppError("INTERNAL");
      await approveDocument(call("approve"), { documentId, expectedVersion: 1, ...rid });
      const posted = await postDocument(call("post"), { documentId, expectedVersion: 2, ...rid });
      // Eşik üstü belge kuyruğa gider (`PROCESSING`): bu akışta belge ≤ 200 satırdır; yine de sahte başarı yazılmaz.
      if (posted.status !== "POSTED") throw new AppError("INTERNAL");
      for (const pl of group) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: posted.replayed ? "REPLAYED" : "APPLIED" });
    } catch (e) {
      failed = true;
      const err = errorOf(e);
      for (const pl of group) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: "FAILED", ...err });
    }
  }
  return plans.map((pl) => reports.get(pl.row) as RowReport);
}
