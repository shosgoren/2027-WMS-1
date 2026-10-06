// Denetim kaydı CSV üretimi (T-126). RFC 4180 kaçışı + CSV/formül enjeksiyonu önlemi + UTF-8 BOM (Excel TR).
// Dışa aktarılan sütunlar kartla sınırlıdır (G-09): ip/user_agent/request_id/e-posta HİÇBİR ZAMAN yazılmaz.

/** Excel'in UTF-8 algılaması için dosya başı BOM. */
export const CSV_BOM = "﻿";

export const AUDIT_CSV_HEADERS = ["Tarih (UTC)", "Kişi", "İşlem", "Kayıt türü", "Kayıt no", "Gerekçe", "Özet (JSON)"] as const;

/** NFKC sonrası baştaki boşluk/kontrol karakterleri atlanır; ardından formül başlangıcı mı. */
const FORMULA_AFTER_TRIM = /^[\s\u0000-\u001f\u007f]*[=+\-@]/u;

/** Sekme/CR ile başlayan hücre (boşluk kırpmasında kaybolmasın diye ayrıca denetlenir). */
function startsDangerous(value: string): boolean {
  if (value.startsWith("\t") || value.startsWith("\r")) return true;
  return FORMULA_AFTER_TRIM.test(value.normalize("NFKC"));
}

/**
 * Tek hücre: `null`/`undefined` → boş tırnaklı hücre. Formül başlangıcı (NFKC normalize + baştaki boşluk kırpılmış değerde
 * `=`, `+`, `-`, `@`; ham değerde sekme/CR; tam genişlik ＝＋－＠ dahil) `'` ile öne eklenir. TÜM hücreler çift tırnağa alınır,
 * içteki `"` ikilenir (RFC 4180; TR Excel'in `;` ayırıcısıyla bölünmesi formül çalıştıramaz).
 */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const safe = startsDangerous(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
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
