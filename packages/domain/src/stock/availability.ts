// Kullanılabilir stok sorgusu (T-217; 16 kural 5; salt okuma). T-221 (rezervasyon) ve T-226 (ekran) kullanır.
//   Kullanılabilir = Σ fiziksel (stok durumu AVAILABLE ∧ lokasyon türü STORAGE|STAGING ∧ pick_blocked = false) − Σ aktif rezervasyon.
// Rezerve sütunu aktif rezervasyonların bakiye yansımasıdır (DB denetimi: reserved_quantity = Σ ACTIVE rezervasyon). Yazma/kilit YOK:
// çağıran `runTenantQuery`/komut transaction'ından `tx` verir.
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";

export interface AvailabilityFilter {
  readonly itemId: string;
  /** Verilirse tek lokasyon. */
  readonly locationId?: string;
  readonly lotId?: string;
}
export interface AvailabilityRow {
  readonly itemId: string;
  readonly locationId: string;
  /** numeric(20,6) metni. */
  readonly physical: string;
  readonly reserved: string;
  readonly available: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string): string => {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new AppError("VALIDATION_FAILED");
  return v.toLowerCase();
};

/** Ürün (ve isteğe bağlı lokasyon/lot) başına lokasyon bazlı kullanılabilir miktar; yalnızca kural 5'e uyan boyutlar. */
export async function readAvailability(tx: AccessTx, tenantId: string, filter: AvailabilityFilter): Promise<readonly AvailabilityRow[]> {
  const itemId = uuid(filter.itemId);
  const loc = filter.locationId === undefined ? null : uuid(filter.locationId);
  const lot = filter.lotId === undefined ? null : uuid(filter.lotId);
  const rows = await tx.execute<{ item_id: string; location_id: string; physical: string; reserved: string; available: string }>(
    sql`SELECT d.item_id, d.location_id,
               sum(b.quantity)::text AS physical,
               sum(b.reserved_quantity)::text AS reserved,
               sum(b.quantity - b.reserved_quantity)::text AS available
          FROM public.stock_balances b
          JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
          JOIN public.locations l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
         WHERE b.tenant_id = ${tenantId}::uuid AND d.item_id = ${itemId}::uuid
           AND d.stock_status = 'AVAILABLE' AND l.kind IN ('STORAGE', 'STAGING') AND l.pick_blocked = false
           AND (${loc}::uuid IS NULL OR d.location_id = ${loc}::uuid)
           AND (${lot}::uuid IS NULL OR d.lot_id = ${lot}::uuid)
         GROUP BY d.item_id, d.location_id
        HAVING sum(b.quantity) <> 0
         ORDER BY d.location_id`,
  );
  return rows.map((r) => ({ itemId: r.item_id, locationId: r.location_id, physical: r.physical, reserved: r.reserved, available: r.available }));
}
