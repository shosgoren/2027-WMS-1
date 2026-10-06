// Uygulama hata sözleşmesi (T-113; docs/spec/15-engineering.md §API sözleşmesi, ADR-016 §11).
// Yalnızca Faz 1'de kullanılan kodlar burada; kalan kodlar kullanan kartta eklenir. Kullanıcıya dönen yanıt
// iç ayrıntı / SQL / SQLSTATE taşımaz: yalnızca `code`, isteğe bağlı `detail`, i18n `messageKey`, `retryable`.

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "TENANT_SUSPENDED",
  "TENANT_CLOSING",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "RATE_LIMITED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Kodu inceltmeyen ama istemcinin yönlendirmesi gereken ayrıntılar (A-38, ADR-016). */
export const ERROR_DETAILS = ["MFA_REQUIRED", "RECENT_AUTH_REQUIRED"] as const;
export type ErrorDetail = (typeof ERROR_DETAILS)[number];

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TENANT_SUSPENDED: 403,
  TENANT_CLOSING: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
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
