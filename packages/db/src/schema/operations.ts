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
import { check, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const INBOUND_RECEIPT_STATUSES = ["DRAFT", "OPEN", "CLOSED", "CANCELLED"] as const;
export type InboundReceiptStatus = (typeof INBOUND_RECEIPT_STATUSES)[number];
export const SALES_ORDER_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];
export const CUSTOMER_RETURN_STATUSES = ["DRAFT", "OPEN", "CLOSED", "CANCELLED"] as const;
export type CustomerReturnStatus = (typeof CUSTOMER_RETURN_STATUSES)[number];

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
