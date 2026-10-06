// Uygulama hata sözleşmesi (T-113; docs/spec/15-engineering.md §API sözleşmesi, ADR-016 §11).
// Faz 1 kodları + Faz 2 stok kodları (T-203, ADR-018 §8); `PERIOD_CLOSED`/`ENTITLEMENT_REQUIRED` Faz 4S'te (A-71). Kullanıcıya dönen yanıt
// iç ayrıntı / SQL / SQLSTATE taşımaz (`INTERNAL`: tanınmayan hata; kök neden yalnızca `cause`'da): yalnızca `code`, isteğe bağlı `detail`, i18n `messageKey`, `retryable`.

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "TENANT_SUSPENDED",
  "TENANT_CLOSING",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "RATE_LIMITED",
  "INTERNAL",
  "INSUFFICIENT_STOCK",
  "TRACKING_VIOLATION",
  "LOCATION_LOCKED",
  "REVERSAL_BLOCKED",
  "IDEMPOTENCY_MISMATCH",
  "COUNT_LOCK_ROW_MISSING",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Kodu inceltmeyen ama istemcinin yönlendirmesi gereken ayrıntılar (A-38, ADR-016). */
export const ERROR_DETAILS = [
  "MFA_REQUIRED",
  "RECENT_AUTH_REQUIRED",
  "CODE_TAKEN",
  "IN_USE",
  "PARENT_INVALID",
  "HANDLING_UNIT_CYCLE",
  "BARCODE_AMBIGUOUS",
  "UNIT_CONVERSION_INVALID",
  "QUANTITY_SCALE",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_STATE",
  "IDEMPOTENCY_KEY_REQUIRED",
  "WAREHOUSE_OUT_OF_SCOPE",
  "FEATURE_DISABLED",
] as const;
export type ErrorDetail = (typeof ERROR_DETAILS)[number];

/** Her ayrıntının bağlı olduğu kod (`errors.<kod>.<ayrıntı>` anahtarı için; 15 §Hata sözleşmesi). */
export const ERROR_DETAIL_CODE: Readonly<Record<ErrorDetail, ErrorCode>> = {
  MFA_REQUIRED: "FORBIDDEN",
  RECENT_AUTH_REQUIRED: "UNAUTHENTICATED",
  CODE_TAKEN: "VALIDATION_FAILED",
  IN_USE: "VALIDATION_FAILED",
  PARENT_INVALID: "VALIDATION_FAILED",
  HANDLING_UNIT_CYCLE: "VALIDATION_FAILED",
  BARCODE_AMBIGUOUS: "VALIDATION_FAILED",
  UNIT_CONVERSION_INVALID: "VALIDATION_FAILED",
  QUANTITY_SCALE: "VALIDATION_FAILED",
  DOCUMENT_TOO_LARGE: "VALIDATION_FAILED",
  DOCUMENT_STATE: "VALIDATION_FAILED",
  IDEMPOTENCY_KEY_REQUIRED: "VALIDATION_FAILED",
  WAREHOUSE_OUT_OF_SCOPE: "FORBIDDEN",
  FEATURE_DISABLED: "VALIDATION_FAILED",
};

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TENANT_SUSPENDED: 403,
  TENANT_CLOSING: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  INSUFFICIENT_STOCK: 409,
  TRACKING_VIOLATION: 422,
  LOCATION_LOCKED: 423,
  REVERSAL_BLOCKED: 409,
  IDEMPOTENCY_MISMATCH: 409,
  COUNT_LOCK_ROW_MISSING: 500,
};

/** i18n anahtarı: `errors.<kod>` ya da ayrıntılıysa `errors.<kod>.<ayrıntı>` (küçük harf). */
export function errorMessageKey(code: ErrorCode, detail?: ErrorDetail): string {
  const base = `errors.${code.toLowerCase()}`;
  return detail === undefined ? base : `${base}.${detail.toLowerCase()}`;
}

export interface AppErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly detail?: ErrorDetail;
    readonly messageKey: string;
    readonly retryable: boolean;
  };
}

export interface AppErrorOptions {
  readonly detail?: ErrorDetail;
  readonly retryable?: boolean;
}

export class AppError extends Error {
  override name = "AppError";
  readonly code: ErrorCode;
  readonly detail: ErrorDetail | undefined;
  readonly retryable: boolean;
  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    // `message` yalnızca kod/ayrıntıdır: iç ayrıntı taşınmaz (kök neden `cause` ile loga gider, yanıta girmez).
    super(options.detail === undefined ? code : `${code}: ${options.detail}`);
    this.code = code;
    this.detail = options.detail;
    this.retryable = options.retryable ?? false;
  }
  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
  get messageKey(): string {
    return errorMessageKey(this.code, this.detail);
  }
  toBody(): AppErrorBody {
    return {
      error: {
        code: this.code,
        ...(this.detail === undefined ? {} : { detail: this.detail }),
        messageKey: this.messageKey,
        retryable: this.retryable,
      },
    };
  }
}
