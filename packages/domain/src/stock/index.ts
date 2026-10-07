// Stok komutu çekirdeği (T-213): 7 adımlı yürütücü, idempotency, yeniden deneme, belge yaşam döngüsü, numaralama.
// İşleme mantığı (defter/bakiye) T-217'de `executeStockCommand`'a takılır; UI ve worker aynı komutları çağırır.
export {
  EMPTY_LOCK_PLAN,
  FeatureDisabledError,
  STOCK_TIMEOUTS,
  executeStockCommand,
  mapStockError,
  type StockAudit,
  type StockCommandApplied,
  type StockCommandContext,
  type StockCommandOutcome,
  type StockCommandParams,
  type StockCommandPlan,
  type StockNumbering,
  type StockTimeouts,
} from "./command.ts";
export {
  SERVER_FIELDS,
  StoredRejectionError,
  assertResultWhitelisted,
  beginIdempotency,
  canonicalJson,
  completeIdempotency,
  decodeErrorCode,
  encodeErrorCode,
  isPersistedRejectionCode,
  parseClientKey,
  recordRejection,
  requestHash,
  type IdempotencyKey,
  type IdempotencyOutcome,
  type StockCommandResult,
  type StockResultLine,
} from "./idempotency.ts";
export {
  MAX_ATTEMPTS,
  RETRYABLE_SQLSTATES,
  isRetryableDbError,
  jitterDelay,
  sqlstateOf,
  withRetry,
  type RetryOptions,
  type RetryReport,
} from "./retry.ts";
export {
  MAX_DOCUMENT_LINES,
  approveDocument,
  assertItemsActive,
  assertLocationsActiveInWarehouse,
  assertNotProcessing,
  cancelDocument,
  createStockDocument,
  readDocumentHeader,
  updateDraft,
  type CancelDocumentInput,
  type CreateStockDocumentInput,
  type DocumentHeader,
  type DocumentLineInput,
  type StockDocCallParams,
  type StockDocumentKind,
  type TransitionInput,
  type UpdateDraftInput,
} from "./documents.ts";
export {
  NUMBER_PREFIX,
  formatDocumentNumber,
  nextDocumentNumber,
  periodOf,
  yearOfBusinessDate,
  type NumberedDocumentKind,
} from "./numbering.ts";
export { SYNC_POST_MAX_LINES, postDocument, type PostDocumentInput } from "./posting.ts";
// T-305: saha komutlarının (kabul, yerleştirme…) belgeyi aynı transaction'da oluşturup işlemesi için DAR bileşik yol: yalnızca posting çekirdeği
// (kilitli görüntü üzerinde işleme) açılır; çekirdek belge kilidini ya da "bu tx'te yaratıldı" kaydını ister (aksi INTERNAL) ve apps/web bu adları import edemez (eslint.config.mjs WEB_STOCK_CORE_NAMES: `no-restricted-imports`, yalnızca apps/web kapsamı); defter/bakiye yazımı hâlâ yalnızca posting.ts'tedir (G-01). Kilitler yine executeStockCommand/acquireStockLocks'tadır.
export { postApprovedDocumentInTx, registerTxCreatedDocument, type PostInTxOptions } from "./posting.ts";
export {
  RESERVATION_EXPIRY_FLAG,
  applyReservedDeltas,
  assertReservableDimensions,
  closeReservations,
  isReservationExpiryEnabled,
  moveReservations,
  planReservationEffects,
  readScopedAvailability,
  release,
  releaseForCancellation,
  reserve,
  type ReleaseInput,
  type ReleaseResult,
  type ReservationAllocationInput,
  type ReservationDimensionInput,
  type ReservationEffects,
  type ReservationMoveInput,
  type ReservationMoveOp,
  type ReservationOp,
  type ReserveInput,
} from "./reservations.ts";
export { readCancellationLockSet, readReservationPlanRows, type ReservationPlanRow } from "./reservation-reads.ts";
export {
  REASON_BY_KIND,
  allocateAcross,
  remainingToReserve,
  reservedExcluding,
  type ReservationSlice,
  type ReservationTake,
  buildPostingPlan,
  dimensionIdentity,
  fromMicro,
  toMicro,
  type LedgerEntry,
  type LedgerReason,
  type PostingKind,
  type PostingLine,
  type PostingPlan,
  type PostingStatus,
} from "./plan.ts";
export { assertLineRules, assertSerialUnique, assertSufficient, type BalanceView, type ItemInfo, type SerialInfo } from "./rules.ts";
export { assertTracking, type TrackedLine, type TrackingMode } from "./tracking.ts";
export { readAvailability, type AvailabilityFilter, type AvailabilityRow } from "./availability.ts";
// T-224: ters kayıt (I-08, AC-06): kalan ters çevrilmemiş miktar sınırı, bağımlı işlem denetimi, `REVERSAL_BLOCKED`. Yazım reversal.ts'tedir (eslint STOCK_WRITE_FILES).
export {
  REVERSAL_MAX_LINES,
  getReversalCapacity,
  reverseDocument,
  type ReverseDocumentInput,
  type ReverseDocumentResult,
  type ReverseLineRequest,
  type ReversalCapacityLine,
} from "./reversal.ts";
