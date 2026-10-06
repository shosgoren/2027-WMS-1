// Defter (stock_ledger) OKUMALARI — yalnızca SELECT (T-252; I-04, G-01). Stok tablosu adı yalnızca bu dosyadadır: `wms/stock-sql-guard`
// dosya düzeyinde ad arar (kardeş örnek: warehouse/stock-usage.ts). Yazma ve kilit yoktur.
import { sql } from "drizzle-orm";
import type { AccessTx } from "../identity/access.ts";

export type RawLedgerEntry = {
  id: string;
  xid: string;
  document_id: string;
  document_line_id: string;
  item_id: string;
  quantity: string;
  reason: string;
  business_date: string;
  occurred_at: Date | string;
  item_ext: string | null;
  doc_ext: string | null;
};

/** Defter satırı bu tenant'ta var mı (RLS altında). */
export async function ledgerEntryExists(tx: AccessTx, tenantId: string, ledgerId: string): Promise<boolean> {
  const r = await tx.execute(sql`SELECT 1 AS one FROM public.stock_ledger WHERE tenant_id = ${tenantId}::uuid AND id = ${ledgerId}::uuid`);
  return r[0] !== undefined;
}

/**
 * LEDGER_ENTRY dış referansı olmayan, SONUÇLANMIŞ (`created_xid < pg_snapshot_xmin`, A-252-6) defter satırları; (created_xid, id) sırası,
 * `after` konumundan sonrası. Ürün/belge dış kimliği aynı sorguda gelir.
 */
export async function selectUnsyncedLedger(
  tx: AccessTx,
  tenantId: string,
  system: string,
  after: { readonly xid: string; readonly id: string },
  limit: number,
): Promise<RawLedgerEntry[]> {
  return tx.execute<RawLedgerEntry>(
    sql`SELECT l.id, l.created_xid::text AS xid, l.document_id, l.document_line_id, l.item_id, l.quantity::text AS quantity,
               l.reason, l.business_date::text AS business_date, l.occurred_at,
               ir.external_id AS item_ext, dr.external_id AS doc_ext
          FROM public.stock_ledger l
          LEFT JOIN public.external_refs lr ON lr.tenant_id = l.tenant_id AND lr.system = ${system}
               AND lr.entity_type = 'LEDGER_ENTRY' AND lr.entity_id = l.id
          LEFT JOIN public.external_refs ir ON ir.tenant_id = l.tenant_id AND ir.system = ${system}
               AND ir.entity_type = 'ITEM' AND ir.entity_id = l.item_id
          LEFT JOIN public.external_refs dr ON dr.tenant_id = l.tenant_id AND dr.system = ${system}
               AND dr.entity_type = 'DOCUMENT' AND dr.entity_id = l.document_id
         WHERE l.tenant_id = ${tenantId}::uuid
           AND lr.id IS NULL
           AND l.created_xid < pg_snapshot_xmin(pg_current_snapshot())
           AND (l.created_xid::text::bigint, l.id) > (${after.xid}::bigint, ${after.id}::uuid)
         ORDER BY l.created_xid, l.id
         LIMIT ${limit}`,
  );
}
