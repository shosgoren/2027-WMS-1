// Stok komutu yürütücüsü (T-213; 05 §İşlem sözleşmesi 7 adım, ADR-018, I-02, I-06, I-12, I-15, A-75, A-121).
//
// Akış (başarı yolu TEK transaction): withMembership(permission) → HEMEN `lock_timeout`/`statement_timeout` (transaction-local) →
// plan (salt okunur; iş kuralı DENETLEMEZ) → assertWarehouseInScope → idempotency (`IN_PROGRESS` ya da saklı sonuç/ret) →
// `acquireStockLocks(plan)` (kilitlerin TEK yolu; kendi FOR UPDATE yazılmaz) → apply → appendAudit → numara (EN SON kilit, ADR-018 §7)
// → idempotency `COMPLETED` + beyaz listeli sonuç. Geçici hatalarda (40P01/40001/55P03) tüm transaction en çok 3 deneme.
//
// Ret (ADR-018 §3, M-1): iş kuralı reddi ana transaction'ı geri alır; ardından AYRI kısa transaction'da `REJECTED` kaydı yazılır
// (`ON CONFLICT DO NOTHING`; önce yazan kazanır). Geçici hata (`VERSION_CONFLICT`), yetki hatası, `IDEMPOTENCY_MISMATCH`, `NOT_FOUND`,
// `INTERNAL` ve kapalı özellik reddi kaydedilmez. Kayıt yazılamazsa asıl ret döner + hata logu.
//
// plan sözleşmesi: `plan` yalnızca kilit planını ve depo kimliklerini çıkarmak için okur; belge/durum kurallarını `apply`'da, KİLİTLİ görüntü
// üzerinde denetler. Böylece aynı anahtarla tekrar (belge artık POSTED olsa bile) plan'da düşmez, saklı sonuca ulaşır.
//
// A-121 / Q-56: `acquireStockLocks` seri planını `STOCK_SERIAL_LOCK_ENABLED` kapalıyken hiç sorgu çalıştırmadan reddeder; bu hata
// ya da 42501 yakalanıp planı `serialIds`'siz yeniden çalıştırmak YASAKTIR (burada yeniden deneme yoktur: plan tek kez çalışır).
import { sql } from "drizzle-orm";
import { acquireStockLocks, appendAudit, type AuditEntry, type LockedState, type StockLockPlan } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { createConsoleLogger, type Logger } from "@wms/shared/log";
import {
  runTenantCommand,
  runTenantCommandById,
  type AccessDbClient,
  type AccessPrincipal,
  type AccessTx,
  type Membership,
} from "../identity/access.ts";
import type { Permission } from "../identity/permissions.ts";
import { assertWarehouseInScope } from "../warehouse/scope.ts";
import {
  StoredRejectionError,
  assertResultWhitelisted,
  beginIdempotency,
  completeIdempotency,
  isPersistedRejectionCode,
  parseClientKey,
  recordRejection,
  requestHash,
  type IdempotencyKey,
  type IdempotencyOutcome,
  type StockCommandResult,
} from "./idempotency.ts";
import { nextDocumentNumber, type NumberedDocumentKind } from "./numbering.ts";
import { sqlstateOf, withRetry, type RetryOptions } from "./retry.ts";

/** A-75: senkron stok komutu 2 sn / 10 sn; worker belge işleme 5 sn / 120 sn. */
export const STOCK_TIMEOUTS = {
  sync: { lockTimeoutMs: 2000, statementTimeoutMs: 10_000 },
  worker: { lockTimeoutMs: 5000, statementTimeoutMs: 120_000 },
} as const;

export interface StockTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

/** A-121: kapalı özellik reddi: `VALIDATION_FAILED`/`FEATURE_DISABLED` (ayrı, anlamlı mesaj). Kaydedilmez (yapılandırmaya bağlıdır). */
export class FeatureDisabledError extends AppError {
  override name = "FeatureDisabledError";
  readonly feature: string;
  constructor(feature: string) {
    super("VALIDATION_FAILED", { detail: "FEATURE_DISABLED" });
    this.feature = feature;
  }
}

const SERIAL_FLAG = "STOCK_SERIAL_LOCK_ENABLED";

function chainNode(e: unknown, sqlstate: string): { message?: unknown } | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur !== undefined && cur !== null; i++) {
    if ((cur as { code?: unknown }).code === sqlstate) return cur as { message?: unknown };
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function withCause<T extends AppError>(err: T, cause: unknown): T {
  err.cause = cause;
  return err;
}

/**
 * Alt katman hatalarını `AppError`'a eşler (ham SQLSTATE/mesaj yanıta girmez; kök neden `cause`'da):
 * - `StockLockError` (db): FORBIDDEN → FORBIDDEN; seri bayrağı kapalı → `FeatureDisabledError`; diğer kodlar aynı adlı `AppError`.
 * - 23514 (CHECK/tetikleyici): `TRACKING_VIOLATION:` önekli → `TRACKING_VIOLATION`; `DOCUMENT_NOT_DRAFT`/`DOCUMENT_POSTED_IMMUTABLE` →
 *   `VALIDATION_FAILED`/`DOCUMENT_STATE`; diğer → `VALIDATION_FAILED`.
 * - 23503 (bileşik FK): `NOT_FOUND` (varlık sızdırılmaz).
 * Geçici SQLSTATE'ler (40P01/40001/55P03) ve tanınmayan hatalar DOKUNULMADAN döner (yeniden deneme sınıflandırması için).
 */
export function mapStockError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  const x = e as { name?: unknown; code?: unknown; detail?: unknown } | null;
  if (x !== null && typeof x === "object" && x.name === "StockLockError") {
    const detail = typeof x.detail === "string" ? x.detail : "";
    switch (x.code) {
      case "FORBIDDEN":
        return withCause(new AppError("FORBIDDEN"), e);
      case "VALIDATION_FAILED":
        return withCause(detail.includes(SERIAL_FLAG) ? new FeatureDisabledError("STOCK_SERIAL_LOCK") : new AppError("VALIDATION_FAILED"), e);
      case "NOT_FOUND":
        return withCause(new AppError("NOT_FOUND"), e);
      case "VERSION_CONFLICT":
        return withCause(new AppError("VERSION_CONFLICT"), e); // belge sürümü değişti: istemci yeniden yüklemeli (yeniden deneme anlamsız)
      case "LOCATION_LOCKED":
        return withCause(new AppError("LOCATION_LOCKED"), e);
      case "COUNT_LOCK_ROW_MISSING":
        return withCause(new AppError("COUNT_LOCK_ROW_MISSING"), e);
      default:
        return withCause(new AppError("INTERNAL"), e);
    }
  }
  const state = sqlstateOf(e);
  if (state === "23514") {
    const message = String(chainNode(e, "23514")?.message ?? "");
    if (message.startsWith("TRACKING_VIOLATION")) return withCause(new AppError("TRACKING_VIOLATION"), e);
    if (message.startsWith("DOCUMENT_NOT_DRAFT") || message.startsWith("DOCUMENT_POSTED_IMMUTABLE")) {
      return withCause(new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" }), e);
    }
    return withCause(new AppError("VALIDATION_FAILED"), e);
  }
  if (state === "23503") return withCause(new AppError("NOT_FOUND"), e);
  return e;
}

// --- tipler -----------------------------------------------------------------------------------------------------------

/** `plan` çıktısı: kilit planı (tam, önceden) + yetki denetimi için dokunulan depolar. */
export interface StockCommandPlan {
  readonly warehouseIds: readonly string[];
  readonly locks: StockLockPlan;
}

/** Kilit gerektirmeyen komutlar için boş plan. */
export const EMPTY_LOCK_PLAN: StockLockPlan = { locationIds: [], dimensions: [], reservationIds: [], serialIds: [] };

export type StockAudit = Omit<AuditEntry, "actorUserId">;

/** Numara adımı (EN SON): `documentId` belgesine numara yazılır; `status: "POSTED"` ise aynı UPDATE'te POSTED yapılır (DB: POSTED ⇒ numara). */
export interface StockNumbering {
  readonly documentId: string;
  readonly kind: NumberedDocumentKind;
  readonly businessDate: string;
  readonly status?: "POSTED";
}

export interface StockCommandApplied {
  readonly result: StockCommandResult;
  /** `null` yalnızca kayıtlı bir audit eylemi olmayan komutlar içindir (açık istisna; rapor Bulgusu). */
  readonly audit: StockAudit | null;
  readonly numbering?: StockNumbering;
}

export interface StockCommandContext {
  readonly membership: Membership;
  readonly tenantId: string;
  readonly userId: string;
  readonly commandType: string;
  readonly clientKey: string;
  readonly requestHash: string;
  readonly idempotencyRecordId: string;
}

export interface StockCommandParams<I, R extends StockCommandResult = StockCommandResult> {
  readonly db: AccessDbClient;
  readonly principal: AccessPrincipal | null | undefined;
  /** Tam olarak biri verilir. */
  readonly tenantSlug?: string;
  readonly tenantId?: string;
  readonly commandType: string;
  /** İstemci UUID anahtarı; yok ⇒ `VALIDATION_FAILED`/`IDEMPOTENCY_KEY_REQUIRED`. */
  readonly clientKey: string | null | undefined;
  readonly input: I;
  readonly permission: Permission;
  readonly plan: (tx: AccessTx, input: I, membership: Membership) => Promise<StockCommandPlan>;
  readonly apply: (tx: AccessTx, locked: LockedState, ctx: StockCommandContext) => Promise<StockCommandApplied & { readonly result: R }>;
  readonly timeouts?: StockTimeouts;
  /** Test/ayar: yeniden deneme uykusu ve rastgelelik. */
  readonly retry?: Pick<RetryOptions, "sleep" | "random" | "maxAttempts">;
  readonly logger?: Logger;
}

export type StockCommandOutcome<R extends StockCommandResult = StockCommandResult> =
  | { readonly status: "COMPLETED"; readonly replayed: boolean; readonly result: R }
  /** Aynı anahtarlı istek hâlâ işleniyor (yalnızca eşik üstü belge/worker yolunda; T-222). */
  | { readonly status: "IN_PROGRESS" };

let fallbackLogger: Logger | undefined;
const defaultLogger = (): Logger => (fallbackLogger ??= createConsoleLogger("domain"));

const COMMAND_TYPE_RE = /^[a-z][a-z0-9_.]{0,63}$/;

function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  return withCause(new AppError("INTERNAL"), e);
}

async function assignNumber(tx: AccessTx, tenantId: string, n: StockNumbering): Promise<string> {
  // Numara satırı (number_sequences) komutun SON kilididir; belge satırı bu noktada acquireStockLocks/apply ile zaten kilitlidir.
  const number = await nextDocumentNumber(tx, tenantId, n.kind, n.businessDate);
  const rows =
    n.status === "POSTED"
      ? await tx.execute<{ id: string }>(
          sql`UPDATE public.documents SET number = ${number}, status = 'POSTED', posting_job_id = NULL, posting_requested_by = NULL
               WHERE tenant_id = ${tenantId}::uuid AND id = ${n.documentId}::uuid AND number IS NULL RETURNING id`,
        )
      : await tx.execute<{ id: string }>(
          sql`UPDATE public.documents SET number = ${number}
               WHERE tenant_id = ${tenantId}::uuid AND id = ${n.documentId}::uuid AND number IS NULL RETURNING id`,
        );
  if (rows[0] === undefined) throw new AppError("INTERNAL"); // belge yok ya da zaten numaralı: sözleşme ihlali
  return number;
}

/** Bkz. dosya başı. Dönen `replayed: true` ⇒ saklı sonuç (ikinci audit/yazma yok). */
export async function executeStockCommand<I, R extends StockCommandResult = StockCommandResult>(
  p: StockCommandParams<I, R>,
): Promise<StockCommandOutcome<R>> {
  if (!COMMAND_TYPE_RE.test(p.commandType)) throw new TypeError("executeStockCommand: commandType is not valid");
  if ((p.tenantSlug === undefined) === (p.tenantId === undefined)) {
    throw new TypeError("executeStockCommand: exactly one of tenantSlug / tenantId is required");
  }
  const clientKey = parseClientKey(p.clientKey);
  const hash = requestHash(p.input);
  const timeouts = p.timeouts ?? STOCK_TIMEOUTS.sync;
  const logger = p.logger ?? defaultLogger();
  const seen: { tenantId?: string; userId?: string } = {};

  const body = async (tx: AccessTx, m: Membership): Promise<StockCommandOutcome<R>> => {
    seen.tenantId = m.tenantId;
    seen.userId = m.userId;
    try {
      const plan = await p.plan(tx, p.input, m);
      await assertWarehouseInScope(tx, m, plan.warehouseIds);
      const key: IdempotencyKey = { tenantId: m.tenantId, commandType: p.commandType, clientKey, actorUserId: m.userId, requestHash: hash };
      const begun = await beginIdempotency(tx, key);
      if (begun.kind === "COMPLETED") return { status: "COMPLETED", replayed: true, result: begun.result as R };
      if (begun.kind === "REJECTED") throw begun.error;
      if (begun.kind === "IN_PROGRESS") return { status: "IN_PROGRESS" };

      const locked = await acquireStockLocks(tx, m.tenantId, plan.locks);
      const applied = await p.apply(tx, locked, {
        membership: m,
        tenantId: m.tenantId,
        userId: m.userId,
        commandType: p.commandType,
        clientKey,
        requestHash: hash,
        idempotencyRecordId: begun.recordId,
      });
      // Beyaz liste sorgudan önce de denetlenir: liste dışı alan yazımdan ÖNCE reddedilir.
      assertResultWhitelisted(applied.result);
      if (applied.audit !== null) await appendAudit(tx, { ...applied.audit, actorUserId: m.userId });
      let result: StockCommandResult = applied.result;
      if (applied.numbering !== undefined) {
        const documentNumber = await assignNumber(tx, m.tenantId, applied.numbering);
        result = { ...result, documentNumber };
      }
      await completeIdempotency(tx, m.tenantId, begun.recordId, result);
      return { status: "COMPLETED", replayed: false, result: result as R };
    } catch (e) {
      throw mapStockError(e);
    }
  };

  const attempt = (): Promise<StockCommandOutcome<R>> =>
    p.tenantId !== undefined
      ? runTenantCommandById({ db: p.db, principal: p.principal, tenantId: p.tenantId, permission: p.permission, timeouts }, body)
      : runTenantCommand({ db: p.db, principal: p.principal, tenantSlug: p.tenantSlug as string, permission: p.permission, timeouts }, body);

  try {
    return await withRetry(attempt, {
      ...p.retry,
      onDone: (r) => {
        if (r.attempts > 1) {
          logger.info("stock.command.retry", { commandType: p.commandType, attempts: r.attempts, totalWaitMs: r.totalWaitMs, sqlstate: r.sqlstate, outcome: r.outcome });
        }
      },
    });
  } catch (e) {
    const err = asAppError(e);
    const tenantId = seen.tenantId;
    const userId = seen.userId;
    const persist =
      tenantId !== undefined &&
      userId !== undefined &&
      isPersistedRejectionCode(err.code) &&
      !(err instanceof StoredRejectionError) &&
      !(err instanceof FeatureDisabledError);
    if (!persist) throw err;
    const key: IdempotencyKey = { tenantId, commandType: p.commandType, clientKey, actorUserId: userId, requestHash: hash };
    const existing = await persistRejection(p, key, err, timeouts, logger);
    if (existing === undefined) throw err;
    if (existing.kind === "COMPLETED") return { status: "COMPLETED", replayed: true, result: existing.result as R };
    if (existing.kind === "REJECTED") throw existing.error;
    if (existing.kind === "IN_PROGRESS") return { status: "IN_PROGRESS" };
    throw err;
  }
}

/**
 * Ayrı kısa transaction'da ret kaydı (`withMembership` + zaman aşımları). Yazıldıysa `undefined`; çakışmada mevcut kaydın sonucu.
 * `IDEMPOTENCY_MISMATCH` fırlatır (kayıt başka içerik/aktörle var). Diğer her hata loglanır ve yutulmaz: asıl ret çağırana döner.
 */
async function persistRejection<I, R extends StockCommandResult>(
  p: StockCommandParams<I, R>,
  key: IdempotencyKey,
  err: AppError,
  timeouts: StockTimeouts,
  logger: Logger,
): Promise<IdempotencyOutcome | undefined> {
  try {
    const outcome = await runTenantCommandById(
      { db: p.db, principal: p.principal, tenantId: key.tenantId, permission: p.permission, timeouts },
      (tx) => recordRejection(tx, key, err.code, err.detail, err.httpStatus),
    );
    return outcome.written ? undefined : outcome.existing;
  } catch (e) {
    if (e instanceof AppError && e.code === "IDEMPOTENCY_MISMATCH") throw e;
    logger.error("stock.command.reject_record_failed", { commandType: p.commandType, errorCode: err.code, sqlstate: sqlstateOf(e) });
    return undefined;
  }
}
