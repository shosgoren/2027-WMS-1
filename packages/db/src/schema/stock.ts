// Stok çekirdeği (T-232) — `0013_stock_ledger` ile birebir (ADR-017 §1-§7, G-01 ikinci savunma).
//
// - Tenant tabloları (RLS ENABLE+FORCE, USING+WITH CHECK): stock_dimensions, stock_balances, stock_ledger, reservations.
//   Politikalar, CHECK'ler, bileşik FK'ler, tetikleyiciler (değişmezlik, sunucu alanları, ertelenmiş mutlak defter–bakiye denetimi)
//   ve sütun düzeyi yetkiler migration'dadır (şema yalnızca tip kaynağıdır).
// - SAPMA: drizzle-orm 0.45.3 `index().include()` sunmaz; INCLUDE (quantity) indeksleri (ledger/reservations toplam denetimi) yalnızca migration'dadır
//   (şemada aynı adlı, INCLUDE'suz karşılık). SAPMA (drift testi): migration `numeric(20,6)` kullanır; Drizzle tanımı duyarlılıksız `numeric`tir (miktar string, float yok — I-09).
// - SÜTUN DÜZEYİ INSERT: `stock_ledger.created_xid` / `occurred_at` ve `stock_balances.serial_key` wms_app INSERT listesinde YOKTUR
//   (tetikleyici yazar); Drizzle `insert` bu sütunları GÖNDERMEMELİDİR. `stock_dimensions.serial_key` üretilmiş sütundur.
// - closed_at sunucu değeridir (wms_app ne INSERT ne UPDATE yazabilir; terminal geçişte tetikleyici now() yazar).
// - Bakiyeye yalnızca stok komutları yazar (G-01); bu tabloları doğrudan yazan kod lint/denetimle yasaktır.
// - Tablo nesneleri yalnızca `@wms/db/internal/schema` alt yolundan açılır, genel yüzeye yalnızca tipler çıkar.
import { sql } from "drizzle-orm";
import { bigint, check, customType, date, index, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `xid8` (PostgreSQL işlem kimliği, 64 bit); sürücü metin döndürür. */
const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});

export const STOCK_STATUSES = ["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];
export const RESERVATION_STATUSES = ["ACTIVE", "CONSUMED", "RELEASED"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
/** Seri olmayan boyutun `serial_key` sentineli. */
export const NO_SERIAL_KEY = "00000000-0000-0000-0000-000000000000";

export const stockDimensions = pgTable(
  "stock_dimensions",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    itemId: uuid("item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    lotId: uuid("lot_id"),
    serialId: uuid("serial_id"),
    stockStatus: text("stock_status").$type<StockStatus>().notNull().default("AVAILABLE"),
    inventoryOwnerId: uuid("inventory_owner_id"),
    handlingUnitId: uuid("handling_unit_id"),
    serialKey: uuid("serial_key").generatedAlwaysAs(sql`COALESCE(serial_id, '00000000-0000-0000-0000-000000000000'::uuid)`),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("stock_dimensions_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_dimensions_tenant_id_id_serial_key_key").on(t.tenantId, t.id, t.serialKey),
    unique("stock_dimensions_tenant_id_id_item_key").on(t.tenantId, t.id, t.itemId),
    unique("stock_dimensions_natural_key")
      .on(t.tenantId, t.itemId, t.locationId, t.lotId, t.serialId, t.stockStatus, t.inventoryOwnerId, t.handlingUnitId)
      .nullsNotDistinct(),
    index("stock_dimensions_tenant_location_idx").on(t.tenantId, t.locationId),
    index("stock_dimensions_tenant_lot_idx").on(t.tenantId, t.lotId),
    index("stock_dimensions_tenant_serial_idx").on(t.tenantId, t.serialId),
    index("stock_dimensions_tenant_owner_idx").on(t.tenantId, t.inventoryOwnerId),
    index("stock_dimensions_tenant_handling_unit_idx").on(t.tenantId, t.handlingUnitId),
  ],
);

export const stockBalances = pgTable(
  "stock_balances",
  {
    tenantId: uuid("tenant_id").notNull(),
    stockDimensionId: uuid("stock_dimension_id").notNull(),
    quantity: numeric("quantity").notNull().default("0"),
    reservedQuantity: numeric("reserved_quantity").notNull().default("0"),
    version: bigint("version", { mode: "bigint" }).notNull().default(sql`0`),
    serialKey: uuid("serial_key").notNull().default(NO_SERIAL_KEY),
  },
  (t) => [
    primaryKey({ name: "stock_balances_pkey", columns: [t.tenantId, t.stockDimensionId] }),
    uniqueIndex("stock_balances_serial_positive_key")
      .on(t.tenantId, t.serialKey)
      .where(sql`${t.quantity} > 0 AND ${t.serialKey} <> '00000000-0000-0000-0000-000000000000'`),
    check("stock_balances_quantity_chk", sql`${t.quantity} >= 0`),
  ],
);

export const stockLedger = pgTable(
  "stock_ledger",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid("document_id").notNull(),
    documentLineId: uuid("document_line_id").notNull(),
    stockDimensionId: uuid("stock_dimension_id").notNull(),
    // Boyutun item_id'sinden tetikleyici türetir (istemci veremez; wms_app INSERT listesinde yok) → insert tipinde isteğe bağlı.
    itemId: uuid("item_id").notNull().default(sql`NULL`),
    quantity: numeric("quantity").notNull(),
    reason: text("reason").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    actorUserId: uuid("actor_user_id"),
    createdXid: xid8("created_xid")
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [
    unique("stock_ledger_tenant_id_id_key").on(t.tenantId, t.id),
    index("stock_ledger_dimension_sum_idx").on(t.tenantId, t.stockDimensionId),
    index("stock_ledger_document_line_idx").on(t.tenantId, t.documentId, t.documentLineId),
    index("stock_ledger_tenant_xid_idx").on(t.tenantId, t.createdXid),
  ],
);

export const reservations = pgTable(
  "reservations",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    stockDimensionId: uuid("stock_dimension_id").notNull(),
    documentLineId: uuid("document_line_id").notNull(),
    // Boyutun item_id'sinden tetikleyici türetir (INSERT/UPDATE; istemci veremez) → insert tipinde isteğe bağlı.
    itemId: uuid("item_id").notNull().default(sql`NULL`),
    quantity: numeric("quantity").notNull(),
    status: text("status").$type<ReservationStatus>().notNull().default("ACTIVE"),
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    closedAt: timestamptz("closed_at"),
  },
  (t) => [
    unique("reservations_tenant_id_id_key").on(t.tenantId, t.id),
    index("reservations_active_sum_idx").on(t.tenantId, t.stockDimensionId).where(sql`${t.status} = 'ACTIVE'`),
    index("reservations_dimension_idx").on(t.tenantId, t.stockDimensionId),
    index("reservations_document_line_idx").on(t.tenantId, t.documentLineId),
  ],
);

export type StockDimension = typeof stockDimensions.$inferSelect;
export type NewStockDimension = typeof stockDimensions.$inferInsert;
export type StockBalance = typeof stockBalances.$inferSelect;
export type NewStockBalance = typeof stockBalances.$inferInsert;
export type StockLedgerEntry = typeof stockLedger.$inferSelect;
export type NewStockLedgerEntry = typeof stockLedger.$inferInsert;
export type Reservation = typeof reservations.$inferSelect;
export type NewReservation = typeof reservations.$inferInsert;
