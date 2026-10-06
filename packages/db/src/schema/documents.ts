// Stok belgeleri (T-206) — `0012_stock_documents` ile birebir.
//
// - Tenant tabloları (RLS ENABLE+FORCE, USING+WITH CHECK): number_sequences, documents, document_lines, document_status_history,
//   idempotency_records. `document_type_versions` KÜRESEL/SİSTEM tablosudur (tenant_id NULL = sistem, A-79; wms_app yalnızca SELECT).
//   Politikalar, CHECK'ler, bileşik FK'ler, tetikleyiciler (POSTED değişmezliği, version artışı, created_xid zorlama, append-only)
//   ve sütun düzeyi yetkiler migration'dadır (şema yalnızca tip kaynağıdır).
// - SAPMA (drift testi): migration `numeric(20,6)` kullanır; information_schema.data_type yalnızca `numeric` döner → Drizzle tanımı
//   duyarlılıksız `numeric`tir (miktar string, float yok — I-09). Kesinlik kaynağı migration'dır.
// - SÜTUN DÜZEYİ INSERT: `document_status_history.created_xid` / `occurred_at` ve `documents.status` / `documents.version`
//   wms_app INSERT listesinde YOKTUR; Drizzle `insert` bu sütunları GÖNDERMEMELİDİR (varsayılan/tetikleyici yazar). Bu yüzden
//   şemada varsayılanlı (`default`) işaretlidir ve `$inferInsert`te isteğe bağlıdır; uygulama kodu değer vermez.
// - Tablo nesneleri yalnızca `@wms/db/internal/schema` alt yolundan açılır, genel yüzeye yalnızca tipler çıkar.
import { sql } from "drizzle-orm";
import { bigint, check, customType, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `xid8` (PostgreSQL işlem kimliği, 64 bit); sürücü metin döndürür. */
const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});

export const DOCUMENT_KINDS = ["STOCK_IN", "STOCK_OUT", "STOCK_MOVE", "REVERSAL", "COUNT_ADJUSTMENT"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_STATUSES = ["DRAFT", "APPROVED", "POSTED", "CANCELLED"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
/** T-301 (ADR-021 §2): `documents.source_kind` beyaz listesi (CHECK documents_source_kind_chk). */
export const DOCUMENT_SOURCE_KINDS = ["INBOUND_RECEIPT", "SALES_ORDER", "CUSTOMER_RETURN", "COUNT_SESSION", "TASK"] as const;
export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number];
export const REVERSAL_STATUSES = ["NONE", "PARTIAL", "FULL"] as const;
export type ReversalStatus = (typeof REVERSAL_STATUSES)[number];
export const LINE_STOCK_STATUSES = ["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"] as const;
export type LineStockStatus = (typeof LINE_STOCK_STATUSES)[number];
export const IDEMPOTENCY_STATUSES = ["IN_PROGRESS", "COMPLETED", "REJECTED", "FAILED"] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

export const documentTypeVersions = pgTable(
  "document_type_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id"),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("document_type_versions_id_key_key").on(t.id, t.key),
    unique("document_type_versions_tenant_key_version_key").on(t.tenantId, t.key, t.version).nullsNotDistinct(),
  ],
);

export const numberSequences = pgTable(
  "number_sequences",
  {
    tenantId: uuid("tenant_id").notNull(),
    documentKind: text("document_kind").$type<DocumentKind>().notNull(),
    period: text("period").notNull(),
    nextValue: bigint("next_value", { mode: "bigint" }).notNull().default(sql`1`),
  },
  (t) => [primaryKey({ name: "number_sequences_pkey", columns: [t.tenantId, t.documentKind, t.period] })],
);

export const documents = pgTable(
  "documents",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: text("kind").$type<DocumentKind>().notNull(),
    typeVersionId: uuid("type_version_id").notNull(),
    number: text("number"),
    status: text("status").$type<DocumentStatus>().notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    warehouseId: uuid("warehouse_id").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    reversalOfDocumentId: uuid("reversal_of_document_id"),
    postingJobId: uuid("posting_job_id"),
    postingRequestedBy: uuid("posting_requested_by"),
    reason: text("reason"),
    // T-301 (ADR-021 §2): saha belgesi kaynağı (polimorfik; FK yok, A-152). İkisi birlikte dolu/boş; yalnızca INSERT'te yazılır.
    sourceKind: text("source_kind").$type<DocumentSourceKind>(),
    sourceId: uuid("source_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("documents_tenant_id_id_key").on(t.tenantId, t.id),
    unique("documents_tenant_kind_number_key").on(t.tenantId, t.kind, t.number),
    index("documents_tenant_warehouse_idx").on(t.tenantId, t.warehouseId),
    index("documents_tenant_status_idx").on(t.tenantId, t.status, t.businessDate),
    index("documents_tenant_reversal_of_idx").on(t.tenantId, t.reversalOfDocumentId),
    index("documents_type_version_idx").on(t.typeVersionId),
    check("documents_version_chk", sql`${t.version} >= 1`),
  ],
);

export const documentLines = pgTable(
  "document_lines",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    quantity: numeric("quantity").notNull(),
    conversionFactor: numeric("conversion_factor").notNull(),
    baseQuantity: numeric("base_quantity").notNull(),
    sourceLocationId: uuid("source_location_id"),
    targetLocationId: uuid("target_location_id"),
    lotId: uuid("lot_id"),
    serialId: uuid("serial_id"),
    stockStatus: text("stock_status").$type<LineStockStatus>().notNull().default("AVAILABLE"),
    inventoryOwnerId: uuid("inventory_owner_id"),
    handlingUnitId: uuid("handling_unit_id"),
    // T-301: kaynak saha belgesi satırı (polimorfik, FK yok; yalnızca INSERT).
    sourceLineId: uuid("source_line_id"),
    // T-301: STOCK_MOVE hedef durumu (NULL = kaynak durumla aynı); stock_status ile aynı küme.
    targetStockStatus: text("target_stock_status").$type<LineStockStatus>(),
    reversedQuantity: numeric("reversed_quantity").notNull().default("0"),
    reversalStatus: text("reversal_status").$type<ReversalStatus>().notNull().default("NONE"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("document_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("document_lines_tenant_document_id_key").on(t.tenantId, t.documentId, t.id),
    unique("document_lines_tenant_id_id_item_key").on(t.tenantId, t.id, t.itemId),
    unique("document_lines_tenant_document_line_no_key").on(t.tenantId, t.documentId, t.lineNo),
    index("document_lines_tenant_item_idx").on(t.tenantId, t.itemId),
    index("document_lines_tenant_unit_idx").on(t.tenantId, t.unitId),
    index("document_lines_tenant_source_idx").on(t.tenantId, t.sourceLocationId),
    index("document_lines_tenant_target_idx").on(t.tenantId, t.targetLocationId),
    index("document_lines_tenant_lot_idx").on(t.tenantId, t.lotId),
    index("document_lines_tenant_serial_idx").on(t.tenantId, t.serialId),
  ],
);

export const documentStatusHistory = pgTable(
  "document_status_history",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid("document_id").notNull(),
    fromStatus: text("from_status").$type<DocumentStatus>(),
    toStatus: text("to_status").$type<DocumentStatus>().notNull(),
    actorUserId: uuid("actor_user_id"),
    reason: text("reason"),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    createdXid: xid8("created_xid")
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [
    unique("document_status_history_tenant_id_id_key").on(t.tenantId, t.id),
    index("document_status_history_tenant_document_idx").on(t.tenantId, t.documentId, t.occurredAt),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    commandType: text("command_type").notNull(),
    clientKey: uuid("client_key").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").$type<IdempotencyStatus>().notNull().default("IN_PROGRESS"),
    result: jsonb("result"),
    errorCode: text("error_code"),
    httpStatus: integer("http_status"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    unique("idempotency_records_tenant_id_id_key").on(t.tenantId, t.id),
    unique("idempotency_records_tenant_command_key_key").on(t.tenantId, t.commandType, t.clientKey),
  ],
);

export type DocumentTypeVersion = typeof documentTypeVersions.$inferSelect;
export type NumberSequence = typeof numberSequences.$inferSelect;
export type NewNumberSequence = typeof numberSequences.$inferInsert;
export type StockDocument = typeof documents.$inferSelect;
export type NewStockDocument = typeof documents.$inferInsert;
export type DocumentLine = typeof documentLines.$inferSelect;
export type NewDocumentLine = typeof documentLines.$inferInsert;
export type DocumentStatusHistoryRow = typeof documentStatusHistory.$inferSelect;
export type NewDocumentStatusHistoryRow = typeof documentStatusHistory.$inferInsert;
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
