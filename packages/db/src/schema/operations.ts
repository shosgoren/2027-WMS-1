// Saha belgeleri (T-301, ADR-021 §1-§4) — `0016_field_documents` ile birebir.
//
// - Tenant tabloları (RLS ENABLE+FORCE, USING+WITH CHECK): inbound_receipts, inbound_receipt_lines, sales_orders, sales_order_lines,
//   customer_returns, customer_return_lines. Politikalar, CHECK'ler, bileşik FK'ler, tetikleyiciler (version artışı, anahtar sütun
//   değişmezliği) ve sütun düzeyi yetkiler migration'dadır (şema yalnızca tip kaynağıdır).
// - SAPMA (drift testi): migration `numeric(20,6)` kullanır; Drizzle tanımı duyarlılıksız `numeric`tir (miktar string, float yok — I-09).
// - SÜTUN DÜZEYİ INSERT: başlıklarda `status`/`version`, sipariş satırında `shipped/returned/cancelled`, kabul satırında
//   `received/damaged` wms_app INSERT listesinde YOKTUR (varsayılan/tetikleyici/komut yazar); Drizzle `insert` bunları göndermemelidir.
// - Açık sipariş miktarı sütun değildir: requested − shipped − cancelled (iade girmez, 16 kural 6).
// - Sipariş/iade miktarları ürünün temel birimindedir (A-151); kabul satırı birim + katsayı taşır.
// - Tablo nesneleri yalnızca `@wms/db/internal/schema` alt yolundan açılır, genel yüzeye yalnızca tipler çıkar.
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const INBOUND_RECEIPT_STATUSES = ["DRAFT", "OPEN", "CLOSED", "CANCELLED"] as const;
export type InboundReceiptStatus = (typeof INBOUND_RECEIPT_STATUSES)[number];
export const SALES_ORDER_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];
export const CUSTOMER_RETURN_STATUSES = ["DRAFT", "OPEN", "CLOSED", "CANCELLED"] as const;
export type CustomerReturnStatus = (typeof CUSTOMER_RETURN_STATUSES)[number];
// T-302 (ADR-021 §5-§7) — `0017_tasks_counts_alerts`.
export const WAREHOUSE_TASK_KINDS = ["PUTAWAY", "PICK", "REPUTAWAY", "COUNT"] as const;
export type WarehouseTaskKind = (typeof WAREHOUSE_TASK_KINDS)[number];
export const WAREHOUSE_TASK_STATUSES = ["OPEN", "ASSIGNED", "DONE", "CANCELLED"] as const;
export type WarehouseTaskStatus = (typeof WAREHOUSE_TASK_STATUSES)[number];
/** `warehouse_tasks.source_kind` beyaz listesi (documents.source_kind alt kümesi). */
export const WAREHOUSE_TASK_SOURCE_KINDS = ["INBOUND_RECEIPT", "SALES_ORDER", "CUSTOMER_RETURN", "COUNT_SESSION"] as const;
export type WarehouseTaskSourceKind = (typeof WAREHOUSE_TASK_SOURCE_KINDS)[number];
export const COUNT_SESSION_STATUSES = ["COUNTING", "SUBMITTED", "APPROVED", "POSTED", "CANCELLED"] as const;
export type CountSessionStatus = (typeof COUNT_SESSION_STATUSES)[number];
export const STOCK_ALERT_KINDS = ["MIN_MAX"] as const;
export type StockAlertKind = (typeof STOCK_ALERT_KINDS)[number];
export const STOCK_ALERT_STATUSES = ["OPEN", "RESOLVED"] as const;
export type StockAlertStatus = (typeof STOCK_ALERT_STATUSES)[number];

export const inboundReceipts = pgTable(
  "inbound_receipts",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    warehouseId: uuid("warehouse_id").notNull(),
    number: text("number").notNull(),
    supplierRef: text("supplier_ref"),
    status: text("status").$type<InboundReceiptStatus>().notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("inbound_receipts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("inbound_receipts_tenant_number_key").on(t.tenantId, t.number),
    index("inbound_receipts_tenant_warehouse_idx").on(t.tenantId, t.warehouseId),
    index("inbound_receipts_tenant_status_idx").on(t.tenantId, t.status),
    check("inbound_receipts_version_chk", sql`${t.version} >= 1`),
  ],
);

export const inboundReceiptLines = pgTable(
  "inbound_receipt_lines",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    receiptId: uuid("receipt_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    conversionFactor: numeric("conversion_factor").notNull(),
    expectedQuantity: numeric("expected_quantity").notNull().default("0"),
    receivedQuantity: numeric("received_quantity").notNull().default("0"),
    damagedQuantity: numeric("damaged_quantity").notNull().default("0"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("inbound_receipt_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("inbound_receipt_lines_tenant_receipt_line_no_key").on(t.tenantId, t.receiptId, t.lineNo),
    index("inbound_receipt_lines_tenant_item_idx").on(t.tenantId, t.itemId),
    index("inbound_receipt_lines_tenant_unit_idx").on(t.tenantId, t.unitId),
  ],
);

export const salesOrders = pgTable(
  "sales_orders",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    number: text("number").notNull(),
    customerRef: text("customer_ref"),
    status: text("status").$type<SalesOrderStatus>().notNull().default("OPEN"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("sales_orders_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sales_orders_tenant_number_key").on(t.tenantId, t.number),
    index("sales_orders_tenant_status_idx").on(t.tenantId, t.status),
    check("sales_orders_version_chk", sql`${t.version} >= 1`),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orderId: uuid("order_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    requestedQuantity: numeric("requested_quantity").notNull(),
    shippedQuantity: numeric("shipped_quantity").notNull().default("0"),
    returnedQuantity: numeric("returned_quantity").notNull().default("0"),
    cancelledQuantity: numeric("cancelled_quantity").notNull().default("0"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("sales_order_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sales_order_lines_tenant_id_id_item_key").on(t.tenantId, t.id, t.itemId),
    unique("sales_order_lines_tenant_order_line_no_key").on(t.tenantId, t.orderId, t.lineNo),
    index("sales_order_lines_tenant_item_idx").on(t.tenantId, t.itemId),
    check("sales_order_lines_open_chk", sql`${t.shippedQuantity} + ${t.cancelledQuantity} <= ${t.requestedQuantity}`),
  ],
);

export const customerReturns = pgTable(
  "customer_returns",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    warehouseId: uuid("warehouse_id").notNull(),
    number: text("number").notNull(),
    status: text("status").$type<CustomerReturnStatus>().notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("customer_returns_tenant_id_id_key").on(t.tenantId, t.id),
    unique("customer_returns_tenant_number_key").on(t.tenantId, t.number),
    index("customer_returns_tenant_warehouse_idx").on(t.tenantId, t.warehouseId),
    check("customer_returns_version_chk", sql`${t.version} >= 1`),
  ],
);

export const customerReturnLines = pgTable(
  "customer_return_lines",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    returnId: uuid("return_id").notNull(),
    lineNo: integer("line_no").notNull(),
    salesOrderLineId: uuid("sales_order_line_id").notNull(),
    itemId: uuid("item_id").notNull(),
    quantity: numeric("quantity").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("customer_return_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("customer_return_lines_tenant_return_line_no_key").on(t.tenantId, t.returnId, t.lineNo),
    index("customer_return_lines_tenant_order_line_idx").on(t.tenantId, t.salesOrderLineId),
    index("customer_return_lines_tenant_item_idx").on(t.tenantId, t.itemId),
  ],
);

export const warehouseTasks = pgTable(
  "warehouse_tasks",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    warehouseId: uuid("warehouse_id").notNull(),
    kind: text("kind").$type<WarehouseTaskKind>().notNull(),
    status: text("status").$type<WarehouseTaskStatus>().notNull().default("OPEN"),
    assignedMembershipId: uuid("assigned_membership_id"),
    groupId: uuid("group_id"),
    sourceKind: text("source_kind").$type<WarehouseTaskSourceKind>(),
    sourceId: uuid("source_id"),
    sourceLineId: uuid("source_line_id"),
    locationId: uuid("location_id"),
    itemId: uuid("item_id"),
    quantity: numeric("quantity"),
    version: integer("version").notNull().default(1),
    completedAt: timestamptz("completed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("warehouse_tasks_tenant_id_id_key").on(t.tenantId, t.id),
    index("warehouse_tasks_tenant_warehouse_status_idx").on(t.tenantId, t.warehouseId, t.status),
    index("warehouse_tasks_tenant_assignee_idx").on(t.tenantId, t.assignedMembershipId).where(sql`${t.assignedMembershipId} IS NOT NULL`),
    index("warehouse_tasks_tenant_source_idx").on(t.tenantId, t.sourceKind, t.sourceId).where(sql`${t.sourceId} IS NOT NULL`),
    index("warehouse_tasks_tenant_group_idx").on(t.tenantId, t.groupId).where(sql`${t.groupId} IS NOT NULL`),
    index("warehouse_tasks_tenant_location_idx").on(t.tenantId, t.locationId).where(sql`${t.locationId} IS NOT NULL`),
    index("warehouse_tasks_tenant_item_idx").on(t.tenantId, t.itemId).where(sql`${t.itemId} IS NOT NULL`),
    check("warehouse_tasks_assigned_chk", sql`${t.status} <> 'ASSIGNED' OR ${t.assignedMembershipId} IS NOT NULL`),
    check("warehouse_tasks_version_chk", sql`${t.version} >= 1`),
  ],
);

export const countSessions = pgTable(
  "count_sessions",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    warehouseId: uuid("warehouse_id").notNull(),
    status: text("status").$type<CountSessionStatus>().notNull().default("COUNTING"),
    blind: boolean("blind").notNull().default(false),
    startedBy: uuid("started_by").notNull(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamptz("approved_at"),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    unique("count_sessions_tenant_id_id_key").on(t.tenantId, t.id),
    unique("count_sessions_tenant_id_id_warehouse_key").on(t.tenantId, t.id, t.warehouseId),
    index("count_sessions_tenant_warehouse_status_idx").on(t.tenantId, t.warehouseId, t.status),
  ],
);

export const countSessionLines = pgTable(
  "count_session_lines",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    locationId: uuid("location_id").notNull(),
    stockDimensionId: uuid("stock_dimension_id"),
    itemId: uuid("item_id").notNull(),
    referenceQuantity: numeric("reference_quantity").notNull(),
    countedQuantity: numeric("counted_quantity"),
    countedBy: uuid("counted_by"),
    countedAt: timestamptz("counted_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("count_session_lines_tenant_id_id_key").on(t.tenantId, t.id),
    index("count_session_lines_tenant_location_idx").on(t.tenantId, t.locationId),
    index("count_session_lines_tenant_item_idx").on(t.tenantId, t.itemId),
  ],
);

export const itemStockPolicies = pgTable(
  "item_stock_policies",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    warehouseId: uuid("warehouse_id").notNull(),
    itemId: uuid("item_id").notNull(),
    minQuantity: numeric("min_quantity").notNull(),
    maxQuantity: numeric("max_quantity").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("item_stock_policies_tenant_id_id_key").on(t.tenantId, t.id),
    unique("item_stock_policies_tenant_warehouse_item_key").on(t.tenantId, t.warehouseId, t.itemId),
    index("item_stock_policies_tenant_item_idx").on(t.tenantId, t.itemId),
    check("item_stock_policies_range_chk", sql`${t.minQuantity} >= 0 AND ${t.minQuantity} <= ${t.maxQuantity}`),
    check("item_stock_policies_version_chk", sql`${t.version} >= 1`),
  ],
);

export const stockAlerts = pgTable(
  "stock_alerts",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: text("kind").$type<StockAlertKind>().notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    itemId: uuid("item_id").notNull(),
    status: text("status").$type<StockAlertStatus>().notNull().default("OPEN"),
    observedQuantity: numeric("observed_quantity").notNull(),
    threshold: numeric("threshold").notNull(),
    openedAt: timestamptz("opened_at").notNull().defaultNow(),
    resolvedAt: timestamptz("resolved_at"),
  },
  (t) => [
    unique("stock_alerts_tenant_id_id_key").on(t.tenantId, t.id),
    index("stock_alerts_tenant_warehouse_idx").on(t.tenantId, t.warehouseId),
    index("stock_alerts_tenant_item_idx").on(t.tenantId, t.itemId),
  ],
);

export type InboundReceipt = typeof inboundReceipts.$inferSelect;
export type NewInboundReceipt = typeof inboundReceipts.$inferInsert;
export type InboundReceiptLine = typeof inboundReceiptLines.$inferSelect;
export type NewInboundReceiptLine = typeof inboundReceiptLines.$inferInsert;
export type SalesOrder = typeof salesOrders.$inferSelect;
export type NewSalesOrder = typeof salesOrders.$inferInsert;
export type SalesOrderLine = typeof salesOrderLines.$inferSelect;
export type NewSalesOrderLine = typeof salesOrderLines.$inferInsert;
export type CustomerReturn = typeof customerReturns.$inferSelect;
export type NewCustomerReturn = typeof customerReturns.$inferInsert;
export type CustomerReturnLine = typeof customerReturnLines.$inferSelect;
export type NewCustomerReturnLine = typeof customerReturnLines.$inferInsert;
export type WarehouseTask = typeof warehouseTasks.$inferSelect;
export type NewWarehouseTask = typeof warehouseTasks.$inferInsert;
export type CountSession = typeof countSessions.$inferSelect;
export type NewCountSession = typeof countSessions.$inferInsert;
export type CountSessionLine = typeof countSessionLines.$inferSelect;
export type NewCountSessionLine = typeof countSessionLines.$inferInsert;
export type ItemStockPolicy = typeof itemStockPolicies.$inferSelect;
export type NewItemStockPolicy = typeof itemStockPolicies.$inferInsert;
export type StockAlert = typeof stockAlerts.$inferSelect;
export type NewStockAlert = typeof stockAlerts.$inferInsert;
