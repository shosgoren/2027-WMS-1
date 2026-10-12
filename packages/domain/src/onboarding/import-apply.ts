// Açılış verisi içe aktarma: önizleme ve parça parça uygulama (T-289). Yalnız MEVCUT domain komutları çağrılır (G-01):
// `createUnit` (koli birimi), `createItem`, `setUnitConversion`, `addBarcode` (T-208) ve açılış stoku için
// `planFieldPosting`/`postFieldDocument` (`STOCK_IN`/`RECEIPT`, A-79; bakiyeye doğrudan yazılmaz).
// Stok kilitleri stok komutunun içindedir (`acquireStockLocks`); bu dosya `FOR UPDATE`/advisory kilit yazmaz. Açılış stoku depo grubu başına TEK
// `executeStockCommand` transaction'ında yazılır (kilitler → çift yeniden denetimi → oluştur + onayla + işle; saha yolu deseni). Ayrı kilit bağlantısı yok.
//
// - Önizleme (`previewImport`) hiçbir şey yazmaz; tüm sorunlar tek seferde döner. Uygulama (`applyImportChunk`) aynı dosyayı SUNUCUDA yeniden
//   ayrıştırır (istemciye güvenilmez); sorun varsa HİÇBİR şey yazılmaz (`VALIDATION_FAILED`).
// - Parça: bir çağrı `IMPORT_CHUNK_SIZE` (200) satırı işler; istemci parçaları sırayla çağırır. Her parça kendi komutlarında kalıcıdır; ilk
//   başarısız satırda DURULUR ve hangi satırların uygulandığı / denenmediği açıkça raporlanır (sahte başarı yok, G-07). Aynı dosyayı yeniden
//   yüklemek kalan parçaları tamamlar.
// - İdempotans: ürünler kodla (`CODE_TAKEN`/mevcut kayıt = zaten var, ek audit yok). Açılış stoku yalnız stoğu OLMAYAN (ürün, raf) çifti için yazılır;
//   aynı (ürün, raf, miktar) önceki içe aktarma belgesinden (POSTED, `import.opening_stock`) geliyorsa satır "zaten uygulanmış" sayılır ve atlanır: korunma
//   DURUM tabanlıdır ve komut içinde stok kilitleri altında yeniden denetlenir; dosyayı sıralamak/düzeltmek/satır eklemek eski satırı iki kez yazmaz.
// - Dosya içeriği diske/loga yazılmaz; yalnız bellek (G-09). Audit: her komut kendi audit'ini yazar; `requestId` hepsini bağlar.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { addBarcode } from "../catalog/barcodes.ts";
import { createItem } from "../catalog/items.ts";
import { createUnit, setUnitConversion } from "../catalog/units.ts";
import { runTenantQuery, type AccessTx, type TenantAccessParams } from "../identity/access.ts";
import { resolveWarehouseScope } from "../warehouse/scope.ts";
import { executeStockCommand, type StockCommandResult } from "../stock/index.ts";
import { planFieldPosting, postFieldDocument, type FieldLine, type FieldPostSpec } from "../operations/field-posting.ts";
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
  type PairState,
  stockItemCodes,
  type PreviewResult,
  type ProductContext,
  type ProductPlan,
  type ShelfInfo,
  type StockContext,
  type StockPlan,
  type UnitInfo,
} from "./import-parse.ts";

export type ImportCallParams = Omit<TenantAccessParams, "permission" | "recentAuth"> & { readonly requestId?: string };

/** Önizlemede dönen en çok sorun sayısı: ilk 50 (toplam `issueTotal` ayrıca verilir; UI "İlk 50 hata gösteriliyor" yazar). */
export const PREVIEW_ISSUE_LIMIT = 50;
export const STOCK_REASON = "import.opening_stock";
/**
 * "Zaten uygulandı" işareti (SR MINOR-2; A-289-7): kullanıcının yazabildiği serbest metin `documents.reason` DEĞİL, yalnız bu komutun yazdığı
 * `idempotency_records.command_type` (komut kodunda sabit; kullanıcı girdisi değildir, tablo sütun yetkisiyle sonradan değiştirilemez) ve
 * `result.documentId` bağıdır. `documents.source_kind` kullanılamaz: CHECK'inde içe aktarma değeri yok ve `source_id` çifti zorunlu (şema değişikliği bu kartta yok).
 */
export const IMPORT_COMMAND_TYPE = "onboarding.import_opening_stock";

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
  readonly stock?: { readonly lines: number; readonly alreadyApplied: number; readonly items: number; readonly warehouses: number; readonly totalQuantity: string; readonly tenantHasStock: boolean };
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
    // Depo kapsamı (`resolveWarehouseScope`): kapsam dışı depoların rafları "bilinmeyen raf" gibi görünür (varlık sızmaz) ve stok yazılamaz.
    const scope = await resolveWarehouseScope(tx, m);
    const allowed = scope === null ? null : new Set(scope);
    const rows = await tx.execute<{ id: string; warehouse_id: string; wcode: string; code: string; kind: string; status: "ACTIVE" | "ARCHIVED"; wstatus: string }>(
      sql`SELECT l.id, l.warehouse_id, w.code AS wcode, l.code, l.kind, l.status, w.status AS wstatus
            FROM public.locations l
            JOIN public.warehouses w ON w.tenant_id = l.tenant_id AND w.id = l.warehouse_id
           WHERE l.tenant_id = ${m.tenantId}::uuid`,
    );
    const shelves = new Map<string, ShelfInfo[]>();
    for (const r of rows) {
      if (allowed !== null && !allowed.has(r.warehouse_id.toLowerCase())) continue;
      const k = shelfKey(r.code);
      shelves.set(k, [
        ...(shelves.get(k) ?? []),
        { id: r.id, warehouseId: r.warehouse_id, warehouseCode: r.wcode, code: r.code, kind: r.kind, status: r.wstatus === "ACTIVE" ? r.status : "ARCHIVED" },
      ]);
    }
    // Genel uyarı için "stok var mı": yalnız çağıranın depo kapsamındaki bakiyeler (kapsam dışı stokun varlığı sızmaz).
    const scopeList = scope === null ? null : sql.join(scope.map((id) => sql`${id}::uuid`), sql`, `);
    const any = await tx.execute<{ x: number }>(
      scope !== null && scope.length === 0
        ? sql`SELECT 1 AS x WHERE false`
        : sql`SELECT 1 AS x FROM public.stock_balances b
                JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
                JOIN public.locations l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
               WHERE b.tenant_id = ${m.tenantId}::uuid AND b.quantity > 0 ${scopeList === null ? sql`` : sql`AND l.warehouse_id IN (${scopeList})`} LIMIT 1`,
    );
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

/** Bir depo grubunun satır özeti (sıra bağımsız); komut girdi özetinde kullanılır. */
export function linesDigestOf(lines: readonly { readonly itemId: string; readonly locationId: string; readonly quantity: string }[]): string {
  return sha([...lines].map((l) => `${l.itemId}|${l.locationId}|${l.quantity}`).sort().join("\n"));
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
  // Tek doğrulama geçişi: çiftlerin stok durumu dosyadaki ürün kodlarından önceden okunur (satır başına sorgu yok).
  const itemIds = stockItemCodes(c.records).flatMap((code) => {
    const it = ctx.items.get(code);
    return it === undefined ? [] : [it.id];
  });
  const pairs = await loadPairStates(params, itemIds);
  const withPairs: StockContext = { ...ctx, pairs };
  return { kind: c.kind, result: validateStock(c.records, withPairs), stockCtx: withPairs, tenantHasStock };
}

const dec = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

interface PairStateMut {
  hasStock: boolean;
  applied: Set<string>;
  reversed: Set<string>;
  pending: Set<string>;
}

/**
 * (ürün, raf) çiftlerinin durumu (salt okuma): KİLİTLİ boyutta (AVAILABLE) hareket ya da bakiye > 0 (`hasStock`, A-289-9); bu çifte önceki içe aktarmayla (POSTED
 * STOCK_IN, işaret `IMPORT_COMMAND_TYPE`) yazılmış ve ters kaydı YAPILMAMIŞ miktarlar (`applied`), ters kaydı yapılmışlar (`reversed`, A-289-8); aynı çifti hedefleyen BİTMEMİŞ (DRAFT/APPROVED) STOCK_IN/STOCK_MOVE belgeleri (`pending`).
 * Yalnız verilen ürünler sorgulanır. Eski taslak otomatik İPTAL EDİLMEZ (iptal kullanıcının işini siler ve işleyen bir worker ile yarışabilir): çift "dolu" sayılır.
 */
async function readPairStates(tx: AccessTx, tenantId: string, itemIdsIn: readonly string[]): Promise<Map<string, PairStateMut>> {
  const out = new Map<string, PairStateMut>();
  const itemIds = [...new Set(itemIdsIn)];
  if (itemIds.length === 0) return out;
  const list = sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `);
  // A-289-9: hareket/bakiye denetimi yalnız stok komutunun KİLİTLEDİĞİ boyutu okur (AVAILABLE, lotsuz/serisiz/sahipsiz/taşıma birimsiz); kilit ile denetim aynı kümeyi kapsar.
  const moved = await tx.execute<{ item_id: string; location_id: string }>(
    sql`SELECT DISTINCT d.item_id, d.location_id FROM public.stock_dimensions d
         WHERE d.tenant_id = ${tenantId}::uuid AND d.item_id IN (${list})
           AND d.stock_status = 'AVAILABLE' AND d.lot_id IS NULL AND d.serial_id IS NULL AND d.inventory_owner_id IS NULL AND d.handling_unit_id IS NULL
           AND (EXISTS (SELECT 1 FROM public.stock_ledger l WHERE l.tenant_id = d.tenant_id AND l.stock_dimension_id = d.id)
                OR EXISTS (SELECT 1 FROM public.stock_balances b WHERE b.tenant_id = d.tenant_id AND b.stock_dimension_id = d.id AND b.quantity > 0))`,
  );
  for (const r of moved) out.set(`${r.item_id}|${r.location_id}`, { hasStock: true, applied: new Set(), reversed: new Set(), pending: new Set() });
  const lines = await tx.execute<{ item_id: string; location_id: string; q: string; st: string; imp: boolean; rv: string }>(
    sql`SELECT dl.item_id, dl.target_location_id AS location_id, dl.base_quantity::text AS q, d.status AS st, dl.reversal_status AS rv,
               (d.kind = 'STOCK_IN' AND EXISTS (SELECT 1 FROM public.idempotency_records r
                                                 WHERE r.tenant_id = d.tenant_id AND r.command_type = ${IMPORT_COMMAND_TYPE} AND r.status = 'COMPLETED'
                                                   AND r.result ->> 'documentId' = d.id::text)) AS imp
          FROM public.document_lines dl
          JOIN public.documents d ON d.tenant_id = dl.tenant_id AND d.id = dl.document_id
         WHERE dl.tenant_id = ${tenantId}::uuid AND d.kind IN ('STOCK_IN', 'STOCK_MOVE') AND d.status IN ('DRAFT', 'APPROVED', 'POSTED')
           AND dl.item_id IN (${list}) AND dl.target_location_id IS NOT NULL`,
  );
  for (const r of lines) {
    const key = `${r.item_id}|${r.location_id}`;
    const cur = out.get(key) ?? { hasStock: false, applied: new Set<string>(), reversed: new Set<string>(), pending: new Set<string>() };
    if (r.st === "POSTED") {
      // Ters kaydı yapılmış (kısmen ya da tamamen) açılış satırı "uygulandı" DEĞİLDİR (A-289-8): ayrı `reversed` kümesine girer.
      if (r.imp) (r.rv === "NONE" ? cur.applied : cur.reversed).add(dec(r.q));
    } else cur.pending.add(dec(r.q));
    out.set(key, cur);
  }
  return out;
}

async function loadPairStates(params: ImportCallParams, itemIds: readonly string[]): Promise<ReadonlyMap<string, PairState>> {
  return runTenantQuery({ ...params, permission: "stock.view" }, (tx, m) => readPairStates(tx, m.tenantId, itemIds));
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
    // Koli/barkod sayıları yalnız GERÇEKTEN yazılacakları sayar (apply ile aynı denetim): mevcut üründe zaten tanımlı olan koli/barkod sayıya girmez.
    const pctx = ev.productCtx;
    const packId = packUnit?.id;
    const hasBarcode = (b: string, code: string, ok: (unitId: string | null) => boolean): boolean => (pctx?.barcodes.get(b) ?? []).some((x) => x.itemCode === code && ok(x.unitId));
    const packNeeded = (p: ProductPlan): boolean => p.packQty !== null && (packId === undefined || pctx?.conversions.get(p.code)?.get(packId) !== p.packQty);
    const unitBarcodeNeeded = (p: ProductPlan): boolean => p.unitBarcode !== null && !(p.exists && hasBarcode(p.unitBarcode, p.code, (u) => u === null || u === pctx?.items.get(p.code)?.baseUnitId));
    const packBarcodeNeeded = (p: ProductPlan): boolean => p.packBarcode !== null && !(p.exists && packId !== undefined && hasBarcode(p.packBarcode, p.code, (u) => u === packId));
    const packs = plans.filter(packNeeded).length;
    const clean = result.issues.length === 0;
    return {
      ...base,
      products: {
        create: clean ? plans.filter((p) => !p.exists).length : 0,
        existing: clean ? plans.filter((p) => p.exists).length : 0,
        packs: clean ? packs : 0,
        barcodes: clean ? plans.reduce((n, p) => n + (unitBarcodeNeeded(p) ? 1 : 0) + (packBarcodeNeeded(p) ? 1 : 0), 0) : 0,
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
      alreadyApplied: clean ? plans.filter((p) => p.alreadyApplied).length : 0,
      items: clean ? new Set(plans.map((p) => p.itemId)).size : 0,
      warehouses: clean ? new Set(plans.filter((p) => !p.alreadyApplied).map((p) => p.warehouseId)).size : 0,
      totalQuantity: clean ? plans.filter((p) => !p.alreadyApplied).reduce((s, p) => addDecimal(s, p.quantity), "0") : "0",
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
  /** Yalnız `FAILED`: kilit altında yeniden denetimde çift dolu/bekleyen çıktı (sade metin için; hata kodu değildir). */
  readonly reason?: "PAIR_HAS_STOCK" | "PAIR_PENDING" | "PAIR_REVERSED";
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
export async function applyImportChunk(params: ImportCallParams, input: { readonly text: string; readonly chunk: number; readonly digest: string }): Promise<ChunkReport> {
  if (!Number.isSafeInteger(input.chunk) || input.chunk < 0 || typeof input.digest !== "string") throw new AppError("VALIDATION_FAILED");
  const ev = await evaluate(params, input.text);
  if ("early" in ev || ev.result.issues.length > 0) throw new AppError("VALIDATION_FAILED"); // hata varken HİÇBİR şey yazılmaz
  // Önizlemedeki içerik özeti: önizleme ile uygulama arasında dosya içeriği ya da bağlı veri değiştiyse reddedilir (HİÇBİR şey yazılmaz).
  if (digestOf(ev.kind, ev.result.plans) !== input.digest) throw new AppError("VALIDATION_FAILED");
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
  const rows = await applyStock(params, all.slice(from, from + IMPORT_CHUNK_SIZE), ev.stockCtx as StockContext);
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

/** Kilit altında yeniden denetimde çift dolu/bekleyen çıktı: hiçbir şey yazılmaz (transaction geri alınır); satır başına neden `conflicts`'te. */
class PairConflictError extends AppError {
  override name = "PairConflictError";
  constructor() {
    super("VALIDATION_FAILED");
  }
}

/**
 * Açılış stoku: depo grubu başına TEK `executeStockCommand` transaction'ı (saha yolu deseni, `field-posting.ts`; G-01: stok yalnız domain komutlarıyla):
 *   stok kilitleri (`acquireStockLocks`, plan önceden tam bildirilir) → kilitler alındıktan SONRA çiftlerin hâlâ boş olduğu ve bekleyen belge olmadığı
 *   YENİDEN denetlenir (eşzamanlı içe aktarma ya da normal STOCK_IN araya girmiş olabilir) → belge oluşturulur, onaylanır ve aynı transaction'da işlenir.
 * Ayrı advisory kilit/bağlantı ve polling YOKTUR: bekleyen ikinci işlem tek bağlantı tutar, kilit sahibi ek bağlantı istemez (havuz tükenmez).
 * Yetki: önizleme/uygulama başında dört izin (`settings.manage`, `document.create`, `document.approve`, `stock.post`) denetlenir; komut `stock.post` ister.
 */
async function applyStock(params: ImportCallParams, allPlans: readonly StockPlan[], ctx: StockContext): Promise<RowReport[]> {
  const byWarehouse = new Map<string, StockPlan[]>();
  const reports = new Map<number, RowReport>();
  // Önceki içe aktarmayla zaten yazılmış satırlar atlanır ve raporda "zaten vardı" görünür.
  const plans = allPlans;
  for (const pl of plans) if (pl.alreadyApplied) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: "REPLAYED" });
  for (const pl of plans) if (!pl.alreadyApplied) byWarehouse.set(pl.warehouseId, [...(byWarehouse.get(pl.warehouseId) ?? []), pl]);
  void ctx;
  let failed = false;
  for (const [warehouseId, group] of byWarehouse) {
    if (failed) {
      for (const pl of group) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: "NOT_ATTEMPTED" });
      continue;
    }
    const conflicts = new Map<number, "PAIR_HAS_STOCK" | "PAIR_PENDING" | "PAIR_REVERSED">();
    const skipped = new Set<number>();
    const toLine = (pl: StockPlan): FieldLine => ({
      itemId: pl.itemId,
      unitId: ctx.items.get(pl.itemCode)?.baseUnitId ?? "",
      quantity: pl.quantity,
      conversionFactor: "1",
      baseQuantity: pl.quantity,
      sourceLocationId: null,
      targetLocationId: pl.locationId,
      stockStatus: "AVAILABLE",
      targetStockStatus: null,
      sourceLineId: null,
    });
    const specOf = (rows: readonly StockPlan[]): FieldPostSpec => ({ kind: "STOCK_IN", warehouseId, sourceKind: null, sourceId: null, reason: STOCK_REASON, lines: rows.map(toLine) });
    try {
      const outcome = await executeStockCommand<{ warehouseId: string; lines: string }, StockCommandResult>({
        db: params.db,
        principal: params.principal,
        tenantSlug: params.tenantSlug,
        // Her deneme yeni anahtar: korunma durum tabanlıdır (çift boş değilse yazılmaz; aynı miktar önceki içe aktarmadansa "zaten uygulanmış"). İçerikten
        // türeyen anahtar, kalıcı saklanan bir RED'i (ör. bekleyen belge) sorun giderilse de sonsuza dek tekrarlardı.
        clientKey: randomUUID(),
        commandType: IMPORT_COMMAND_TYPE,
        permission: "stock.post",
        input: { warehouseId, lines: linesDigestOf(group) },
        plan: (tx, _i, m) => planFieldPosting(tx, m.tenantId, specOf(group)),
        apply: async (tx, locked, c) => {
          // Kilitler alındı: çiftlerin durumu BU transaction'ta yeniden okunur (kilit altında).
          const states = await readPairStates(tx, c.tenantId, group.map((g) => g.itemId));
          const todo: StockPlan[] = [];
          for (const pl of group) {
            const st = states.get(`${pl.itemId}|${pl.locationId}`);
            if (st !== undefined && st.hasStock) {
              if (st.applied.has(pl.quantity)) skipped.add(pl.row);
              else conflicts.set(pl.row, st.reversed.has(pl.quantity) ? "PAIR_REVERSED" : "PAIR_HAS_STOCK");
            } else if (st !== undefined && st.pending.size > 0) conflicts.set(pl.row, "PAIR_PENDING");
            else todo.push(pl);
          }
          if (conflicts.size > 0 || todo.length === 0) throw new PairConflictError(); // hiçbir şey yazılmadı
          return postFieldDocument(tx, locked, c, specOf(todo), params.requestId ?? null);
        },
      });
      if (outcome.status !== "COMPLETED") throw new AppError("INTERNAL"); // eşzamanlı komutta beklenmez; sahte başarı yok
      for (const pl of group) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: skipped.has(pl.row) || outcome.replayed ? "REPLAYED" : "APPLIED" });
    } catch (e) {
      if (e instanceof PairConflictError || conflicts.size > 0 || skipped.size === group.length) {
        if (conflicts.size > 0) {
          failed = true;
          for (const pl of group) {
            const why = conflicts.get(pl.row);
            if (why !== undefined) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: "FAILED", errorCode: "VALIDATION_FAILED", reason: why });
            else reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: skipped.has(pl.row) ? "REPLAYED" : "NOT_ATTEMPTED" });
          }
        } else for (const pl of group) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: "REPLAYED" }); // hepsi başka bir içe aktarmayla yazılmış
        continue;
      }
      failed = true;
      const err = errorOf(e);
      for (const pl of group) reports.set(pl.row, { row: pl.row, code: pl.itemCode, status: "FAILED", ...err });
    }
  }
  return plans.map((pl) => reports.get(pl.row) as RowReport);
}
