// Denetim kaydı CSV üretimi (T-126). RFC 4180 kaçışı + CSV/formül enjeksiyonu önlemi + UTF-8 BOM (Excel TR).
// Dışa aktarılan sütunlar kartla sınırlıdır (G-09): ip/user_agent/request_id/e-posta HİÇBİR ZAMAN yazılmaz.

/** Excel'in UTF-8 algılaması için dosya başı BOM. */
export const CSV_BOM = "﻿";

export const AUDIT_CSV_HEADERS = ["Tarih (UTC)", "Kişi", "İşlem", "Kayıt türü", "Kayıt no", "Gerekçe", "Özet (JSON)"] as const;

/** Hücre başında formül olarak yorumlanabilen karakterler: `=`, `+`, `-`, `@`, sekme, CR. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Tek hücre: `null`/`undefined` → boş. Formül başlangıcı `'` ile öne ekle (metin olarak gösterilir), sonra RFC 4180:
 * `"`, `,`, CR veya LF içeren hücre çift tırnağa alınır, içteki `"` ikilenir.
 */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Bir satır (CRLF ile biter, RFC 4180). */
export function csvLine(cells: readonly (string | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

export interface AuditCsvRow {
  readonly occurredAt: Date;
  readonly actorName: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly reason: string | null;
  /** `change_summary` JSON metni (kayıt anında maskelenmiştir). */
  readonly changeSummary: string;
}

export function auditCsvHeader(): string {
  return csvLine(AUDIT_CSV_HEADERS);
}

export function auditCsvRow(r: AuditCsvRow): string {
  return csvLine([r.occurredAt.toISOString(), r.actorName, r.action, r.entityType, r.entityId, r.reason, r.changeSummary]);
}
