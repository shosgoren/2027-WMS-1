// Operasyon alanı genel yüzeyi (T-304). YALNIZCA genel komutlar/sorgular/tipler açılır; `createTasks` ve `completeTask` saha
// komutlarının transaction'ı içinden çağrılan iç yardımcılardır (görev `DONE` yalnızca stok etkisiyle aynı transaction'da — ADR-021 §6)
// ve bilerek burada YOKTUR (export testi: tests/integration/operations/tasks.int.test.ts).
export {
  REASON_MAX,
  TASK_KINDS,
  TASK_KIND_PERMISSION,
  TASK_LIST_LIMIT_DEFAULT,
  TASK_LIST_LIMIT_MAX,
  TASK_SOURCE_KINDS,
  TASK_STATUSES,
  assignTask,
  cancelTask,
  claimTask,
  listMyTasks,
  listTasks,
  nextTaskStatus,
  type AssignTaskInput,
  type CancelTaskInput,
  type ClaimTaskInput,
  type ListMyTasksInput,
  type ListTasksInput,
  type TaskCallParams,
  type TaskCursor,
  type TaskEvent,
  type TaskKind,
  type TaskPage,
  type TaskRow,
  type TaskSourceKind,
  type TaskStatus,
} from "./tasks.ts";
// Mal kabul, kalite onayı ve yerleştirme (T-305). `field-posting.ts` saha komutlarının iç bileşik yardımcısıdır: bilerek burada YOKTUR.
export {
  approveQuality,
  cancelInboundReceipt,
  createInboundReceipt,
  openInboundReceipt,
  receiveGoods,
  type ApproveQualityInput,
  type CancelInboundReceiptInput,
  type CreateInboundReceiptInput,
  type InboundReceiptLineInput,
  type QualityDimensionInput,
  type QualityReceiptLineInput,
  type ReceiptTransitionInput,
  type ReceiveGoodsInput,
  type ReceiveLineInput,
} from "./receiving.ts";
export { putaway, type PutawayInput } from "./putaway.ts";
// Mal kabul okuma sorguları (T-313; stock.view, keyset, depo kapsamı).
export {
  RECEIPT_LIST_LIMIT_DEFAULT,
  RECEIPT_LIST_LIMIT_MAX,
  RECEIPT_STATUSES,
  getAvailableAtLocation,
  getInboundReceipt,
  getLocationBrief,
  listInboundReceipts,
  type ListInboundReceiptsInput,
  type LocationBrief,
  type ReceiptCursor,
  type ReceiptDetail,
  type ReceiptLineView,
  type ReceiptPage,
  type ReceiptStatus,
  type ReceiptView,
  type ReceivingLocationView,
} from "./receiving-queries.ts";
// Müşteri siparişi, sipariş tahsisi ve iptal (T-306). `allocation.ts` saf öneri işlevidir (birim testi); `allocateInTx`/`releaseSelected` iç çekirdeklerdir: burada YOKTUR.
export {
  cancelOrderLine,
  cancelSalesOrder,
  createSalesOrder,
  reserveOrder,
  updateDraftOrder,
  type CancelOrderLineInput,
  type CancelSalesOrderInput,
  type CreateSalesOrderInput,
  type OrderAllocationOverride,
  type ReserveOrderInput,
  type SalesOrderLineInput,
  type UpdateDraftOrderInput,
} from "./orders.ts";
// Toplama görevlendirmesi, toplama ve "ürün bulunamadı" (T-307). `reallocateOrderLine` (orders.ts) ve saf kurallar (picking.ts: planPickTasks...) iç yardımcıdır: burada YOKTUR.
export {
  confirmPick,
  createPickAssignment,
  type ConfirmPickInput,
  type ConfirmPickResult,
  type PickAssignmentInput,
  type PickAssignmentResult,
  type PickNotFound,
  type PickReallocation,
} from "./picking.ts";
// Kısmi sevk ve müşteri iadesi (T-308). `planShipment`/`isShippableReservation` (shipping.ts) ve iade saf yardımcıları iç/test amaçlıdır: burada YOKTUR.
export { shipOrder, type ShipLineInput, type ShipOrderInput } from "./shipping.ts";
export { createCustomerReturn, type CreateCustomerReturnInput } from "./returns.ts";
// Rehberli saha akışı: görev adım ilerlemesi (T-293; ADR-025). Stok değiştirmez; Kaydet `putaway`'i aynı istemci anahtarıyla çağırır. `parseRecordStepInput`/`plainDecimal` saf yardımcılardır (birim testi) ve burada YOKTUR.
export {
  GUIDED_TASK_KINDS,
  RECORDABLE_STEPS,
  SCAN_CODE_MAX,
  TASK_PROGRESS_STEPS,
  beginSave,
  getTaskProgress,
  nextTaskFor,
  recordTaskStep,
  resetTaskProgress,
  savePutawayTask,
  type NextTask,
  type RecordStepResult,
  type RecordableStep,
  type StepRejectionReason,
  type TaskProgressCallParams,
  type TaskProgressStep,
  type TaskProgressView,
} from "./task-progress.ts";
