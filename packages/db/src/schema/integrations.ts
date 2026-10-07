// Dış referans eşlemesi ve senkron imleçleri (T-252) — `0019_external_refs` ile birebir.
//
// - `external_refs` POLİMORFİKTİR (entity_type + entity_id): bileşik FK kasıtlı olarak yoktur (A-252-1); tenant sınırı RLS ile.
// - SÜTUN DÜZEYİ YETKİ: INSERT listesinde `synced_at`/`version` yoktur (varsayılan + tetikleyici); UPDATE yalnız `external_code`
//   (tetikleyici version+1, synced_at). `sync_cursors` UPDATE yalnız imleç sütunları; tetikleyici geriye gitmeyi reddeder.
// - Tablo nesneleri yalnızca `@wms/db/internal/schema` alt yolundan açılır.
import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const EXTERNAL_REF_ENTITY_TYPES = ["ITEM", "UNIT", "WAREHOUSE", "LOCATION", "PARTY", "DOCUMENT", "LEDGER_ENTRY"] as const;
export type ExternalRefEntityType = (typeof EXTERNAL_REF_ENTITY_TYPES)[number];

export const externalRefs = pgTable(
  "external_refs",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    system: text("system").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    externalId: text("external_id").notNull(),
    externalCode: text("external_code"),
    syncedAt: timestamptz("synced_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    unique("external_refs_tenant_id_id_key").on(t.tenantId, t.id),
    unique("external_refs_entity_key").on(t.tenantId, t.system, t.entityType, t.entityId),
    unique("external_refs_external_key").on(t.tenantId, t.system, t.entityType, t.externalId),
    check("external_refs_system_chk", sql`${t.system} ~ '^[A-Z][A-Z0-9_]{0,31}$'`),
    check(
      "external_refs_entity_type_chk",
      sql`${t.entityType} IN ('ITEM', 'UNIT', 'WAREHOUSE', 'LOCATION', 'PARTY', 'DOCUMENT', 'LEDGER_ENTRY')`,
    ),
    check("external_refs_external_id_chk", sql`btrim(${t.externalId}) <> '' AND char_length(${t.externalId}) <= 200`),
    check(
      "external_refs_external_code_chk",
      sql`${t.externalCode} IS NULL OR (btrim(${t.externalCode}) <> '' AND char_length(${t.externalCode}) <= 200)`,
    ),
    check("external_refs_version_chk", sql`${t.version} >= 1`),
  ],
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    system: text("system").notNull(),
    stream: text("stream").notNull(),
    cursorXid: bigint("cursor_xid", { mode: "bigint" }).notNull().default(sql`0`),
    cursorId: uuid("cursor_id").notNull().default(sql`'00000000-0000-0000-0000-000000000000'`),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("sync_cursors_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sync_cursors_stream_key").on(t.tenantId, t.system, t.stream),
    check("sync_cursors_system_chk", sql`${t.system} ~ '^[A-Z][A-Z0-9_]{0,31}$'`),
    check("sync_cursors_stream_chk", sql`${t.stream} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    check("sync_cursors_xid_chk", sql`${t.cursorXid} >= 0`),
  ],
);

export type ExternalRef = typeof externalRefs.$inferSelect;
export type NewExternalRef = typeof externalRefs.$inferInsert;
export type SyncCursor = typeof syncCursors.$inferSelect;
export type NewSyncCursor = typeof syncCursors.$inferInsert;
