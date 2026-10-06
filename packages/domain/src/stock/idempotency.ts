// Stok komutu idempotency (T-213; I-06, ADR-018 §1-§3, ADR-017 §10, A-73).
//
// - Anahtar `(tenant_id, command_type, client_key)`; `client_key` istemcinin ürettiği UUID'dir. `request_hash` = girdinin kanonik
//   JSON'unun SHA-256'sı (anahtar sıralı; sunucu alanları hariç). Kayıt aktöre bağlıdır.
// - Mevcut kayıt: aktör ≠ çağıran ya da özet farklı → `IDEMPOTENCY_MISMATCH` (saklı sonuç dönmez, kaydedilmez). `COMPLETED` → saklı
//   sonuç; `REJECTED`/`FAILED` → saklı hata (aynı ret); `IN_PROGRESS` → "işleniyor".
// - Ret kaydı ana transaction geri alındıktan SONRA ayrı kısa transaction'da yazılır (`recordRejection`); yarışta önce yazılan kazanır.
// - `result` yalnızca beyaz listeden yazılır (ADR-017 §10): üst düzey anahtarlar DB CHECK'inde, iç içe alanlar burada doğrulanır.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AccessTx } from "../identity/access.ts";
import { AppError, ERROR_CODES, ERROR_DETAILS, type ErrorCode, type ErrorDetail } from "@wms/shared/errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPTH = 32;

/** İstek özetinden çıkarılan sunucu/korelasyon alanları (her derinlikte): aynı içerik yeniden gönderimde değişebilirler. */
export const SERVER_FIELDS: ReadonlySet<string> = new Set([
  "actorUserId",
  "requestId",
  "requestedAt",
  "occurredAt",
  "clientKey",
  "idempotencyKey",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function canon(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new AppError("VALIDATION_FAILED");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new AppError("VALIDATION_FAILED");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new AppError("VALIDATION_FAILED"); // undefined (üst düzey), bigint, function, symbol
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AppError("VALIDATION_FAILED");
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canon(v, depth + 1))).join(",")}]`;
  }
  if (!isPlainObject(value)) throw new AppError("VALIDATION_FAILED");
  const parts: string[] = [];
  for (const k of Object.keys(value).sort()) {
    const v = value[k];
    if (v === undefined || SERVER_FIELDS.has(k)) continue;
    parts.push(`${JSON.stringify(k)}:${canon(v, depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Kanonik JSON: nesne anahtarları sıralı, `undefined` alanlar ve sunucu alanları atılır, dizi sırası korunur. */
export function canonicalJson(value: unknown): string {
  return canon(value, 0);
}

/** Komut girdisinin SHA-256 özeti (küçük harf hex, 64 karakter; DB CHECK biçimi). */
export function requestHash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

/** İstemci anahtarı zorunlu ve UUID olmalıdır (ADR-018 §1); yoksa `VALIDATION_FAILED`/`IDEMPOTENCY_KEY_REQUIRED`. */
export function parseClientKey(raw: unknown): string {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    throw new AppError("VALIDATION_FAILED", { detail: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
}

// --- result beyaz listesi (ADR-017 §10) -------------------------------------------------------------------------------

/** Satır başına sayısal sonuç: yalnızca bu alanlar (kişisel veri/serbest metin yok). */
export interface StockResultLine {
  readonly lineId: string;
  readonly lineNo?: number;
  readonly quantity?: string;
  readonly baseQuantity?: string;
  readonly reversedQuantity?: string;
}

/** `idempotency_records.result` içeriği (beyaz liste). */
export interface StockCommandResult {
  readonly documentId?: string;
  readonly documentNumber?: string | null;
  readonly status?: "DRAFT" | "APPROVED" | "POSTED" | "CANCELLED";
  readonly reservationIds?: readonly string[];
  readonly lines?: readonly StockResultLine[];
}

const RESULT_KEYS: ReadonlySet<string> = new Set(["documentId", "documentNumber", "status", "reservationIds", "lines"]);
const LINE_KEYS: ReadonlySet<string> = new Set(["lineId", "lineNo", "quantity", "baseQuantity", "reversedQuantity"]);
const STATUSES: ReadonlySet<string> = new Set(["DRAFT", "APPROVED", "POSTED", "CANCELLED"]);
const DECIMAL_RE = /^-?\d{1,14}(\.\d{1,6})?$/;
const NUMBER_MAX = 64;

function resultInvalid(why: string): AppError {
  // Üretim kodu hatası (beyaz liste dışı alan): kullanıcıya INTERNAL; ayrıntı yalnızca cause'da.
  const err = new AppError("INTERNAL");
  err.cause = new Error(`idempotency result rejected: ${why}`);
  return err;
}

/** Sonucu beyaz listeye karşı doğrular; liste dışı alan ya da biçim hatası `INTERNAL` (cause: neden). Geçerli sonucu döndürür. */
export function assertResultWhitelisted(result: StockCommandResult): StockCommandResult {
  if (!isPlainObject(result)) throw resultInvalid("result must be a plain object");
  const r = result as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (r[k] !== undefined && !RESULT_KEYS.has(k)) throw resultInvalid(`field not allowed: ${k}`);
  }
  if (r.documentId !== undefined && !(typeof r.documentId === "string" && UUID_RE.test(r.documentId))) throw resultInvalid("documentId");
  if (r.documentNumber !== undefined && r.documentNumber !== null) {
    if (typeof r.documentNumber !== "string" || r.documentNumber === "" || r.documentNumber.length > NUMBER_MAX) throw resultInvalid("documentNumber");
  }
  if (r.status !== undefined && !(typeof r.status === "string" && STATUSES.has(r.status))) throw resultInvalid("status");
  if (r.reservationIds !== undefined) {
    if (!Array.isArray(r.reservationIds) || !r.reservationIds.every((x) => typeof x === "string" && UUID_RE.test(x))) throw resultInvalid("reservationIds");
  }
  if (r.lines !== undefined) {
    if (!Array.isArray(r.lines)) throw resultInvalid("lines");
    for (const line of r.lines as unknown[]) {
      if (!isPlainObject(line)) throw resultInvalid("lines[]");
      for (const k of Object.keys(line)) {
        if (line[k] !== undefined && !LINE_KEYS.has(k)) throw resultInvalid(`line field not allowed: ${k}`);
      }
      if (!(typeof line.lineId === "string" && UUID_RE.test(line.lineId))) throw resultInvalid("lines[].lineId");
      if (line.lineNo !== undefined && !(Number.isSafeInteger(line.lineNo) && (line.lineNo as number) >= 1)) throw resultInvalid("lines[].lineNo");
      for (const k of ["quantity", "baseQuantity", "reversedQuantity"] as const) {
        if (line[k] !== undefined && !(typeof line[k] === "string" && DECIMAL_RE.test(line[k] as string))) throw resultInvalid(`lines[].${k}`);
      }
    }
  }
  return result;
}

// --- hata kodu saklama ------------------------------------------------------------------------------------------------

/**
 * Kalıcı saklanan iş kuralı retleri (ADR-018 §3): `INSUFFICIENT_STOCK`, `TRACKING_VIOLATION`, `LOCATION_LOCKED`, `REVERSAL_BLOCKED`,
 * `VALIDATION_FAILED` (DOCUMENT_STATE/DOCUMENT_TOO_LARGE/… ayrıntıları dahil). Geçici/yetki hataları (`VERSION_CONFLICT`,
 * `FORBIDDEN`, `UNAUTHENTICATED`, `TENANT_*`), `IDEMPOTENCY_MISMATCH` ve ortam/veri durumuna bağlı `NOT_FOUND`/`INTERNAL` saklanmaz.
 */
const PERSISTED_REJECTION_CODES: ReadonlySet<ErrorCode> = new Set([
  "INSUFFICIENT_STOCK",
  "TRACKING_VIOLATION",
  "LOCATION_LOCKED",
  "REVERSAL_BLOCKED",
  "VALIDATION_FAILED",
]);

export function isPersistedRejectionCode(code: ErrorCode): boolean {
  return PERSISTED_REJECTION_CODES.has(code);
}

/** `error_code` sütunu: `KOD` ya da `KOD/AYRINTI`. */
export function encodeErrorCode(code: ErrorCode, detail: ErrorDetail | undefined): string {
  return detail === undefined ? code : `${code}/${detail}`;
}

/** Saklı `error_code` → `AppError` (tanınmayan değer `INTERNAL`). */
export function decodeErrorCode(stored: string): AppError {
  const [code, detail] = stored.split("/");
  if (code === undefined || !(ERROR_CODES as readonly string[]).includes(code)) return new AppError("INTERNAL");
  if (detail === undefined) return new AppError(code as ErrorCode);
  if (!(ERROR_DETAILS as readonly string[]).includes(detail)) return new AppError(code as ErrorCode);
  return new AppError(code as ErrorCode, { detail: detail as ErrorDetail });
}

/** Saklı retten yeniden üretilen hata (yeniden kaydedilmez; I-06 "tekrar = önceki sonuç"). */
export class StoredRejectionError extends AppError {
  override name = "StoredRejectionError";
}

// --- kayıt işlemleri --------------------------------------------------------------------------------------------------

export type IdempotencyOutcome =
  | { readonly kind: "NEW"; readonly recordId: string }
  | { readonly kind: "COMPLETED"; readonly result: StockCommandResult }
  | { readonly kind: "REJECTED"; readonly error: AppError }
  | { readonly kind: "IN_PROGRESS" };

export interface IdempotencyKey {
  readonly tenantId: string;
  readonly commandType: string;
  readonly clientKey: string;
  readonly actorUserId: string;
  readonly requestHash: string;
}

type ExistingRow = {
  id: string;
  actor_user_id: string;
  request_hash: string;
  status: string;
  result: unknown;
  error_code: string | null;
};

function evaluate(row: ExistingRow, key: IdempotencyKey): Exclude<IdempotencyOutcome, { kind: "NEW" }> {
  // Önce kimlik/özet: başka kullanıcıya ya da farklı içeriğe saklı sonuç dönmez (I-06, MINOR-3).
  if (row.actor_user_id.toLowerCase() !== key.actorUserId.toLowerCase() || row.request_hash !== key.requestHash) {
    throw new AppError("IDEMPOTENCY_MISMATCH");
  }
  if (row.status === "COMPLETED") {
    const raw = row.result;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    return { kind: "COMPLETED", result: (parsed ?? {}) as StockCommandResult };
  }
  if (row.status === "REJECTED" || row.status === "FAILED") {
    const stored = decodeErrorCode(row.error_code ?? "INTERNAL");
    return { kind: "REJECTED", error: new StoredRejectionError(stored.code, stored.detail === undefined ? {} : { detail: stored.detail }) };
  }
  return { kind: "IN_PROGRESS" };
}

async function readExisting(tx: AccessTx, key: IdempotencyKey, lock: boolean): Promise<ExistingRow | undefined> {
  const rows = await tx.execute<ExistingRow>(
    lock
      ? sql`SELECT id, actor_user_id, request_hash, status, result, error_code FROM public.idempotency_records
             WHERE tenant_id = ${key.tenantId}::uuid AND command_type = ${key.commandType} AND client_key = ${key.clientKey}::uuid
               FOR UPDATE`
      : sql`SELECT id, actor_user_id, request_hash, status, result, error_code FROM public.idempotency_records
             WHERE tenant_id = ${key.tenantId}::uuid AND command_type = ${key.commandType} AND client_key = ${key.clientKey}::uuid`,
  );
  return rows[0];
}

/**
 * ADR-018 §2: `INSERT … ON CONFLICT DO NOTHING RETURNING` ile `IN_PROGRESS` satırı; çakışmada kayıt `FOR UPDATE` okunur ve
 * değerlendirilir. Zaman aşımları çağıran tarafından önceden kurulmuş olmalıdır (benzersiz indeks beklemesi sınırlıdır).
 */
export async function beginIdempotency(tx: AccessTx, key: IdempotencyKey): Promise<IdempotencyOutcome> {
  const inserted = await tx.execute<{ id: string }>(
    sql`INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash)
        VALUES (${key.tenantId}::uuid, ${key.commandType}, ${key.clientKey}::uuid, ${key.actorUserId}::uuid, ${key.requestHash})
        ON CONFLICT ON CONSTRAINT idempotency_records_tenant_command_key_key DO NOTHING
        RETURNING id`,
  );
  const id = inserted[0]?.id;
  if (id !== undefined) return { kind: "NEW", recordId: id };
  const existing = await readExisting(tx, key, true);
  if (existing === undefined) throw new AppError("VERSION_CONFLICT", { retryable: true }); // satır araya giren geri almayla yok oldu: yeniden dene
  return evaluate(existing, key);
}

/** Başarı: aynı transaction'da `COMPLETED` + beyaz listeli sonuç. */
export async function completeIdempotency(tx: AccessTx, tenantId: string, recordId: string, result: StockCommandResult): Promise<void> {
  const safe = assertResultWhitelisted(result);
  const rows = await tx.execute<{ id: string }>(
    sql`UPDATE public.idempotency_records
           SET status = 'COMPLETED', result = ${JSON.stringify(safe)}::jsonb, http_status = 200, completed_at = now()
         WHERE tenant_id = ${tenantId}::uuid AND id = ${recordId}::uuid AND status = 'IN_PROGRESS'
        RETURNING id`,
  );
  if (rows[0] === undefined) throw new AppError("INTERNAL"); // kayıt IN_PROGRESS değil: sözleşme ihlali
}

/**
 * Ret kaydı (ADR-018 §3): AYRI kısa transaction'da `REJECTED` + `error_code`, `ON CONFLICT DO NOTHING`. Çakışmada mevcut kayıt
 * değerlendirilip döndürülür (önce yazan kazanır); özet/aktör farklıysa `IDEMPOTENCY_MISMATCH` fırlatır.
 */
export async function recordRejection(
  tx: AccessTx,
  key: IdempotencyKey,
  code: ErrorCode,
  detail: ErrorDetail | undefined,
  httpStatus: number,
): Promise<{ readonly written: true } | { readonly written: false; readonly existing: IdempotencyOutcome }> {
  const rows = await tx.execute<{ id: string }>(
    sql`INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash, status, error_code, http_status, completed_at)
        VALUES (${key.tenantId}::uuid, ${key.commandType}, ${key.clientKey}::uuid, ${key.actorUserId}::uuid, ${key.requestHash},
                'REJECTED', ${encodeErrorCode(code, detail)}, ${httpStatus}, now())
        ON CONFLICT ON CONSTRAINT idempotency_records_tenant_command_key_key DO NOTHING
        RETURNING id`,
  );
  if (rows[0] !== undefined) return { written: true };
  const existing = await readExisting(tx, key, false);
  if (existing === undefined) return { written: false, existing: { kind: "IN_PROGRESS" } };
  return { written: false, existing: evaluate(existing, key) };
}
