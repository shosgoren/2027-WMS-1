// "Yanlış bir şey yaptım" okuması (T-333): çağıranın KENDİ son kesinleşmiş (POSTED) stok belgeleri ve satır başına ters kayıt durumu.
// Salt okuma (`reversal.create`, depo kapsamlı); stok yazımı YOKTUR (G-01: düzeltme yalnız `reverseDocument` ile). Başka kullanıcının belgesi, başka tenant
// ve kapsam dışı depo sonuçta hiç görünmez (varlık sızdırmaz). Miktarlar temel birimdedir (A-224-2) ve metin olarak döner (I-09).
//
// A-333-1: "zaman" = belge oluşturulma zamanı (`documents.created_at`); `documents` tablosunda ayrı bir işleme zamanı sütunu yoktur.
// A-333-2: yalnız STOCK_IN/STOCK_OUT/STOCK_MOVE listelenir (`reverseDocument` yalnız bunları destekler; REVERSAL'ın ters kaydı yoktur).
// A-333-3: ters kaydı kesin engelli belge `blocked` bayrağıyla gelir (SOURCE_LINKED = saha akışından bağlı belge, STATUS_CHANGE = durum değiştiren taşıma,
//   FULLY_REVERSED = kalan yok); UI "düzeltilemez — yöneticine bildir" der. Yöneticiye istek akışı bu kartta YOKTUR (G-03).
// Anlık görüntü bilgidir: bakiye/rezervasyon engelleri (STOCK_USED vb.) burada hesaplanmaz, karar `reverseDocument`'ta kilit altında verilir.
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery, type TenantAccessParams } from "../identity/access.ts";
import { pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import { fromMicro, toMicro } from "./plan.ts";
import { remainingMicro } from "./reversal.ts";

export const RECENT_DOCUMENTS_DEFAULT_LIMIT = 20;
export const RECENT_DOCUMENTS_MAX_LIMIT = 50;

export type RecentDocumentBlocked = "SOURCE_LINKED" | "STATUS_CHANGE" | "FULLY_REVERSED";

export interface RecentDocumentLine {
  readonly lineId: string;
  readonly lineNo: number;
  readonly itemCode: string;
  readonly itemName: string;
  /** Belge satırı miktarı (asıl birimde, metin). */
  readonly quantity: string;
  readonly unitCode: string;
  /** Temel birimde miktar; ters kayıt miktarı bu birimdedir. */
  readonly baseQuantity: string;
  readonly baseUnitCode: string;
  readonly reversedQuantity: string;
  /** `baseQuantity − reversedQuantity`. */
  readonly remaining: string;
  readonly sourceLocationCode: string | null;
  readonly targetLocationCode: string | null;
}

export interface RecentDocument {
  readonly documentId: string;
  readonly number: string | null;
  readonly kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE";
  readonly createdAt: Date;
  readonly warehouseId: string;
  /** `null` = ters kayıt denenebilir (kesin karar `reverseDocument`'ta). */
  readonly blocked: RecentDocumentBlocked | null;
  readonly lines: readonly RecentDocumentLine[];
}

export interface RecentDocumentsResult {
  /** Tenant saat dilimi (IANA); `createdAt` gösterimi için (tenant_settings; yoksa UTC). */
  readonly timeZone: string;
  readonly documents: readonly RecentDocument[];
}

export interface ListMyRecentDocumentsOptions {
  /** 1..50 (varsayılan 20); aksi VALIDATION_FAILED. */
  readonly limit?: number;
}

type DocRow = { id: string; number: string | null; kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE"; created_at: Date | string; warehouse_id: string; source_kind: string | null };
type LineRow = {
  document_id: string;
  id: string;
  line_no: number;
  item_code: string;
  item_name: string;
  quantity: string;
  unit_code: string;
  base_quantity: string;
  base_unit_code: string;
  reversed_quantity: string;
  source_location_code: string | null;
  target_location_code: string | null;
  status_change: boolean;
};

/**
 * `reversal.create`: çağıranın oluşturduğu son N POSTED STOCK_IN/OUT/MOVE belgesi (yeniden eskiye), depo kapsamı içinde. Satır sırası `line_no`.
 */
export async function listMyRecentDocuments(
  params: Omit<TenantAccessParams, "permission" | "recentAuth">,
  options: ListMyRecentDocumentsOptions = {},
): Promise<RecentDocumentsResult> {
  const limit = options.limit ?? RECENT_DOCUMENTS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_DOCUMENTS_MAX_LIMIT) throw new AppError("VALIDATION_FAILED");
  return runTenantQuery({ ...params, permission: "reversal.create" }, async (tx, m) => {
    const allowed = await resolveWarehouseScope(tx, m);
    const scope = allowed === null ? sql`` : sql`AND d.warehouse_id = ANY(${pgUuidArray(allowed)}::uuid[])`;
    const tz = await tx.execute<{ time_zone: string }>(sql`SELECT time_zone FROM public.tenant_settings WHERE tenant_id = ${m.tenantId}::uuid`);
    const timeZone = tz[0]?.time_zone ?? "UTC";
    const docs = await tx.execute<DocRow>(
      sql`SELECT d.id, d.number, d.kind, d.created_at, d.warehouse_id, d.source_kind
            FROM public.documents d
           WHERE d.tenant_id = ${m.tenantId}::uuid AND d.created_by = ${m.userId}::uuid AND d.status = 'POSTED'
             AND d.kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE') ${scope}
           ORDER BY d.created_at DESC, d.id ASC
           LIMIT ${limit}`,
    );
    if (docs.length === 0) return { timeZone, documents: [] };
    const lineRows = await tx.execute<LineRow>(
      sql`SELECT l.document_id, l.id, l.line_no, i.code AS item_code, i.name AS item_name, l.quantity::text AS quantity, u.code AS unit_code,
                 l.base_quantity::text AS base_quantity, bu.code AS base_unit_code, l.reversed_quantity::text AS reversed_quantity,
                 sl.code AS source_location_code, tl.code AS target_location_code,
                 (l.target_stock_status IS NOT NULL AND l.target_stock_status <> l.stock_status) AS status_change
            FROM public.document_lines l
            JOIN public.items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
            JOIN public.units u ON u.tenant_id = l.tenant_id AND u.id = l.unit_id
            JOIN public.units bu ON bu.tenant_id = i.tenant_id AND bu.id = i.base_unit_id
            LEFT JOIN public.locations sl ON sl.tenant_id = l.tenant_id AND sl.id = l.source_location_id
            LEFT JOIN public.locations tl ON tl.tenant_id = l.tenant_id AND tl.id = l.target_location_id
           WHERE l.tenant_id = ${m.tenantId}::uuid AND l.document_id = ANY(${pgUuidArray(docs.map((d) => d.id))}::uuid[])
           ORDER BY l.document_id, l.line_no`,
    );
    const byDoc = new Map<string, LineRow[]>();
    for (const r of lineRows) {
      const list = byDoc.get(r.document_id) ?? [];
      list.push(r);
      byDoc.set(r.document_id, list);
    }
    const documents = docs.map((d): RecentDocument => {
      const rows = byDoc.get(d.id) ?? [];
      const lines = rows.map(
        (r): RecentDocumentLine => ({
          lineId: r.id,
          lineNo: Number(r.line_no),
          itemCode: r.item_code,
          itemName: r.item_name,
          quantity: r.quantity,
          unitCode: r.unit_code,
          baseQuantity: r.base_quantity,
          baseUnitCode: r.base_unit_code,
          reversedQuantity: r.reversed_quantity,
          remaining: fromMicro(remainingMicro({ baseQuantity: r.base_quantity, reversedQuantity: r.reversed_quantity })),
          sourceLocationCode: r.source_location_code,
          targetLocationCode: r.target_location_code,
        }),
      );
      let blocked: RecentDocumentBlocked | null = null;
      if (d.source_kind !== null) blocked = "SOURCE_LINKED";
      else if (d.kind === "STOCK_MOVE" && rows.some((r) => r.status_change)) blocked = "STATUS_CHANGE";
      else if (lines.every((l) => toMicro(l.remaining) === 0n)) blocked = "FULLY_REVERSED";
      return {
        documentId: d.id,
        number: d.number,
        kind: d.kind,
        createdAt: d.created_at instanceof Date ? d.created_at : new Date(d.created_at),
        warehouseId: d.warehouse_id,
        blocked,
        lines,
      };
    });
    return { timeZone, documents };
  });
}
