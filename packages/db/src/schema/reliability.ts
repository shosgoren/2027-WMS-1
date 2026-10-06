// Kuyruk güvenilirliği (T-211) — `0014_reliability` ile birebir (ADR-019 §1-§2, §8-§10).
//
// - processed_events: tenant_id NULL olabilir (platform işi); UNIQUE NULLS NOT DISTINCT (tenant_id, consumer, event_id). RLS: tenant satırı
//   tenant_id = bağlam; NULL satırı yalnızca tenant bağlamı boşken. wms_app yalnızca SELECT + INSERT (tenant_id, consumer, event_id).
// - stock_consistency_runs: yalnızca OK|MISMATCH (RUNNING yok); tamamlanan koşunun son transaction'ında bir kez yazılır. created_xid wms_app
//   INSERT listesinde YOKTUR (tetikleyici yazar); Drizzle `insert` bu sütunu GÖNDERMEMELİDİR. Yazma app.system_reason koşulludur.
// - stock_consistency_signals: tenant kimliği YOK (M-7), append-only; wms_app yalnızca INSERT (status, mismatch_count; SELECT yok → RETURNING yok),
//   wms_ops SELECT. occurred_at/created_xid tetikleyiciyle sunucu değerine zorlanır.
// - SAPMA (drift testi): Drizzle UNIQUE ... NULLS NOT DISTINCT'i `.nullsNotDistinct()` ile ifade eder (stock.ts emsali).
// - Tablo nesneleri yalnızca `@wms/db/internal/schema` alt yolundan açılır, genel yüzeye yalnızca tipler çıkar.
import { sql } from "drizzle-orm";
import { bigint, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `xid8` (PostgreSQL işlem kimliği, 64 bit); sürücü metin döndürür. */
const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});

export const CONSISTENCY_RUN_STATUSES = ["OK", "MISMATCH"] as const;
export type ConsistencyRunStatus = (typeof CONSISTENCY_RUN_STATUSES)[number];
export const CONSISTENCY_SIGNAL_STATUSES = ["OK", "MISMATCH", "FAILED"] as const;
export type ConsistencySignalStatus = (typeof CONSISTENCY_SIGNAL_STATUSES)[number];

export const processedEvents = pgTable(
  "processed_events",
  {
    tenantId: uuid("tenant_id"),
    consumer: text("consumer").notNull(),
    eventId: uuid("event_id").notNull(),
    processedAt: timestamptz("processed_at").notNull().defaultNow(),
  },
  (t) => [unique("processed_events_natural_key").on(t.tenantId, t.consumer, t.eventId).nullsNotDistinct()],
);

export const stockConsistencyRuns = pgTable(
  "stock_consistency_runs",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    jobId: uuid("job_id").notNull(),
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at").notNull(),
    status: text("status").$type<ConsistencyRunStatus>().notNull(),
    checkedDimensions: bigint("checked_dimensions", { mode: "bigint" }).notNull(),
    mismatchCount: integer("mismatch_count").notNull(),
    findings: jsonb("findings").notNull().default(sql`'[]'::jsonb`),
    createdXid: xid8("created_xid")
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [
    unique("stock_consistency_runs_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_consistency_runs_tenant_id_job_id_key").on(t.tenantId, t.jobId),
    index("stock_consistency_runs_tenant_finished_idx").on(t.tenantId, t.finishedAt),
  ],
);

export const stockConsistencySignals = pgTable(
  "stock_consistency_signals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    status: text("status").$type<ConsistencySignalStatus>().notNull(),
    mismatchCount: integer("mismatch_count").notNull().default(0),
    createdXid: xid8("created_xid")
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [index("stock_consistency_signals_occurred_idx").on(t.occurredAt)],
);
