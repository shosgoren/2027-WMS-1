// Fiş numaralama (T-213; 05 §Rezervasyon ve hareketler, A-70, A-05; ADR-018 §7).
//
// - Kapsam: tenant + belge türü + dönem. Dönem = iş tarihinin takvim yılı (A-70); biçim `<önek>-<YYYY>-<6 hane>`; önekler `GRS`
//   (STOCK_IN), `CKS` (STOCK_OUT), `TSM` (STOCK_MOVE), `TRS` (REVERSAL), `KBL` (INBOUND_RECEIPT; A-305-1). Boşluk kabul (A-05; yalnızca geri alınan transaction'da yok).
// - Atomik: `INSERT … ON CONFLICT DO UPDATE … RETURNING` tek ifadede satır kilidi alır; eşzamanlı iki komut sırayla numara alır.
// - Kilit sırası (ADR-018 §7): `number_sequences` satırı komutun SON kilididir; çağıran bunu apply'dan sonra, idempotency
//   tamamlanmadan hemen önce çağırır (`executeStockCommand` bunu yapar).
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";

export type NumberedDocumentKind = "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE" | "REVERSAL" | "INBOUND_RECEIPT";

export const NUMBER_PREFIX: Readonly<Record<NumberedDocumentKind, string>> = {
  STOCK_IN: "GRS",
  STOCK_OUT: "CKS",
  STOCK_MOVE: "TSM",
  REVERSAL: "TRS",
  // A-305-1 (A-139/Q-79 varsayılanı; kartlarda önek tanımı yok): beklenen teslim (kabul belgesi) numarası `KBL-<YYYY>-<6 hane>`.
  INBOUND_RECEIPT: "KBL",
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` iş tarihini doğrular (gerçek takvim günü) ve yılı döndürür. */
export function yearOfBusinessDate(businessDate: string): number {
  const m = typeof businessDate === "string" ? DATE_RE.exec(businessDate) : null;
  if (m === null) throw new AppError("VALIDATION_FAILED");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 9999 || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new AppError("VALIDATION_FAILED");
  }
  return y;
}

/** Numara dönemi (A-70): iş tarihinin takvim yılı. */
export function periodOf(businessDate: string): string {
  return String(yearOfBusinessDate(businessDate));
}

export function formatDocumentNumber(kind: NumberedDocumentKind, period: string, sequence: number | bigint): string {
  const prefix = NUMBER_PREFIX[kind];
  if (prefix === undefined) throw new AppError("VALIDATION_FAILED");
  return `${prefix}-${period}-${String(sequence).padStart(6, "0")}`;
}

/**
 * Sıradaki numarayı atomik ayırır. `number_sequences.next_value` "bir sonraki verilecek" değerdir: ilk çağrıda satır
 * `next_value = 2` ile eklenir ve 1 verilir. Satır kilidi transaction sonuna kadar tutulur.
 */
export async function nextDocumentNumber(tx: AccessTx, tenantId: string, kind: NumberedDocumentKind, businessDate: string): Promise<string> {
  const period = periodOf(businessDate);
  if (NUMBER_PREFIX[kind] === undefined) throw new AppError("VALIDATION_FAILED");
  const rows = await tx.execute<{ next_value: string }>(
    sql`INSERT INTO public.number_sequences (tenant_id, document_kind, period, next_value)
        VALUES (${tenantId}::uuid, ${kind}, ${period}, 2)
        ON CONFLICT (tenant_id, document_kind, period)
        DO UPDATE SET next_value = public.number_sequences.next_value + 1
        RETURNING next_value::text AS next_value`,
  );
  const row = rows[0];
  if (row === undefined) throw new AppError("INTERNAL");
  return formatDocumentNumber(kind, period, BigInt(row.next_value) - 1n);
}
