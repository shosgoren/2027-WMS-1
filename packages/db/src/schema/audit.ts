// Audit ve hız sınırı tabloları (T-107, ADR-016 §7) — `0004_audit` ile birebir.
//
// - `audit_logs`: tenant tablosu (RLS ENABLE+FORCE); append-only (UPDATE/DELETE/TRUNCATE tetikleyiciyle reddedilir).
//   `tenant_id` DEFAULT'u `app.current_tenant_id`'dir; `wms_app` bu sütunda INSERT yetkisi taşımaz.
// - `request_rate_limits`: platform tablosu (RLS yok); anahtar yalnızca SHA-256 özetidir.
// - Tablo nesneleri yalnızca `@wms/db/internal/schema` alt yolundan açılır, genel yüzeye yalnızca tipler çıkar.
import { sql } from "drizzle-orm";
import { customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `xid8` (PostgreSQL işlem kimliği, 64 bit); sürücü metin döndürür. */
const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .default(sql`NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid`),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    actorUserId: uuid("actor_user_id"),
    onBehalfOfUserId: uuid("on_behalf_of_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    reason: text("reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    changeSummary: jsonb("change_summary").notNull().default(sql`'{}'::jsonb`),
    createdXid: xid8("created_xid")
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [
    unique("audit_logs_tenant_id_id_key").on(t.tenantId, t.id),
    index("audit_logs_tenant_occurred_idx").on(t.tenantId, t.occurredAt.desc(), t.id),
  ],
);

export const requestRateLimits = pgTable(
  "request_rate_limits",
  {
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    windowStart: timestamptz("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ name: "request_rate_limits_pkey", columns: [t.scope, t.keyHash, t.windowStart] })],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type RequestRateLimit = typeof requestRateLimits.$inferSelect;
export type NewRequestRateLimit = typeof requestRateLimits.$inferInsert;
