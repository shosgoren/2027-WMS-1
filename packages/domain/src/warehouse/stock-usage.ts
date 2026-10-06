// Depo/lokasyon komutlarının stok tablosu OKUMALARI (T-243). Yalnızca SELECT; kilit ve yazma yoktur (I-15, G-01):
// stok tablosu adları komut dosyalarında geçmez (`wms/stock-sql-guard` dosya düzeyinde ad arar), kilit yolu `acquireStockLocks`'tur.
import { sql } from "drizzle-orm";
import type { AccessTx } from "../identity/access.ts";

/** Lokasyonda (verilirse) ya da depoda pozitif bakiye var mı (salt SELECT). */
export async function hasPositiveBalance(
  tx: AccessTx,
  tenantId: string,
  where: { readonly locationId: string } | { readonly warehouseId: string },
): Promise<boolean> {
  const rows =
    "locationId" in where
      ? await tx.execute<{ used: boolean }>(
          sql`SELECT EXISTS (
                SELECT 1 FROM public.stock_balances b
                  JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
                 WHERE b.tenant_id = ${tenantId}::uuid AND d.location_id = ${where.locationId}::uuid AND b.quantity > 0) AS used`,
        )
      : await tx.execute<{ used: boolean }>(
          sql`SELECT EXISTS (
                SELECT 1 FROM public.stock_balances b
                  JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
                  JOIN public.locations l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
                 WHERE b.tenant_id = ${tenantId}::uuid AND l.warehouse_id = ${where.warehouseId}::uuid AND b.quantity > 0) AS used`,
        );
  return rows[0]?.used === true;
}

/** Lokasyonun sayım kilidi satırı (0010 tetikleyicisi yaratır) var mı (salt SELECT, kilitsiz). */
export async function countLockRowExists(tx: AccessTx, tenantId: string, locationId: string): Promise<boolean> {
  const rows = await tx.execute<{ location_id: string }>(
    sql`SELECT location_id FROM public.location_count_locks WHERE tenant_id = ${tenantId}::uuid AND location_id = ${locationId}::uuid`,
  );
  return rows[0] !== undefined;
}

/** Verilen lokasyonlardan kaçının sayım kilidi satırı var (toplu oluşturmada tek sorgu; salt SELECT). `locationIds` geçerli UUID dizisidir. */
export async function countLockRowsExisting(tx: AccessTx, tenantId: string, locationIds: readonly string[]): Promise<number> {
  const literal = `{${locationIds.join(",")}}`;
  const rows = await tx.execute<{ n: string | number }>(
    sql`SELECT count(*) AS n FROM public.location_count_locks WHERE tenant_id = ${tenantId}::uuid AND location_id = ANY(${literal}::uuid[])`,
  );
  return Number(rows[0]?.n);
}
