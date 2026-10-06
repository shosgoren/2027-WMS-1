// Depo, lokasyon ağacı, sayım kilidi satırı ve depo kapsamı (T-202) — `0010_warehouses_locations` ile birebir.
//
// - RLS'li tenant tabloları (ENABLE+FORCE, USING+WITH CHECK); politikalar, CHECK'ler, bileşik FK'ler, tetikleyiciler
//   ve yetkiler migration'dadır (şema yalnızca tip kaynağıdır).
// - `location_count_locks` satırı lokasyon INSERT'inde tetikleyiciyle oluşur; uygulama kodu doğrudan yazmaz.
// - Tablo nesneleri yalnızca `@wms/db/internal/schema` alt yolundan açılır, genel yüzeye yalnızca tipler çıkar.
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const WAREHOUSE_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number];
export const LOCATION_KINDS = ["RECEIVING", "STORAGE", "STAGING", "TRANSIT"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export const COUNT_LOCK_STATUSES = ["IDLE", "COUNTING"] as const;
export type CountLockStatus = (typeof COUNT_LOCK_STATUSES)[number];

export const warehouses = pgTable(
  "warehouses",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<WarehouseStatus>().notNull().default("ACTIVE"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    archivedAt: timestamptz("archived_at"),
  },
  (t) => [
    unique("warehouses_tenant_id_id_key").on(t.tenantId, t.id),
    unique("warehouses_tenant_code_key").on(t.tenantId, t.code),
  ],
);

export const locations = pgTable(
  "locations",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    warehouseId: uuid("warehouse_id").notNull(),
    parentId: uuid("parent_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    depth: smallint("depth").notNull().default(0),
    kind: text("kind").$type<LocationKind>().notNull(),
    pickBlocked: boolean("pick_blocked").notNull().default(false),
    status: text("status").$type<WarehouseStatus>().notNull().default("ACTIVE"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    archivedAt: timestamptz("archived_at"),
  },
  (t) => [
    unique("locations_tenant_id_id_key").on(t.tenantId, t.id),
    unique("locations_tenant_warehouse_id_key").on(t.tenantId, t.warehouseId, t.id),
    unique("locations_tenant_warehouse_code_key").on(t.tenantId, t.warehouseId, t.code),
    index("locations_tenant_warehouse_parent_idx").on(t.tenantId, t.warehouseId, t.parentId),
  ],
);

export const locationCountLocks = pgTable(
  "location_count_locks",
  {
    tenantId: uuid("tenant_id").notNull(),
    locationId: uuid("location_id").primaryKey(),
    status: text("status").$type<CountLockStatus>().notNull().default("IDLE"),
    countSessionId: uuid("count_session_id"),
    lockedAt: timestamptz("locked_at"),
    lockedBy: uuid("locked_by"),
  },
  (t) => [index("location_count_locks_tenant_status_idx").on(t.tenantId, t.status)],
);

export const membershipWarehouseScopes = pgTable(
  "membership_warehouse_scopes",
  {
    tenantId: uuid("tenant_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "membership_warehouse_scopes_pkey", columns: [t.tenantId, t.membershipId, t.warehouseId] }),
    index("membership_warehouse_scopes_tenant_warehouse_idx").on(t.tenantId, t.warehouseId),
  ],
);

export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;
export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
export type LocationCountLock = typeof locationCountLocks.$inferSelect;
export type MembershipWarehouseScope = typeof membershipWarehouseScopes.$inferSelect;
export type NewMembershipWarehouseScope = typeof membershipWarehouseScopes.$inferInsert;
