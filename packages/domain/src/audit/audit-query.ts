// Denetim kaydı ekranı + CSV export (T-126; ADR-016 §7; I-13, I-14, I-16). Yalnızca okuma (+ `audit.exported` olayı).
//
// - `listAudit`: `audit.view`, keyset `(occurred_at DESC, id ASC)` (OFFSET yok; `audit_logs_tenant_occurred_idx` sırası).
//   İmleç opak (base64url JSON `{ts,id}`); tenant dışı satır dönmez çünkü RLS + `tenant_id` koşulu.
// - `openAuditExport`: ilk parçada (aynı kısa transaction) `pg_current_snapshot()` alınır; BÜTÜN parçalar
//   `pg_visible_in_snapshot(created_xid, snap)` ile süzülür → kesit sabit, export sürerken eklenen satır dosyada yok (I-16).
//   Her parça AYRI kısa transaction (I-14, G-02); üyelik/izin her parçada yeniden doğrulanır (yetki akış sırasında
//   düşerse akış kesilir). Yalnızca ilk parça `recentAuth` ister (A-39) ve `audit.exported` olayını yazar.
// - Dışa aktarılan sütunlar `csv.ts` ile sınırlıdır (G-09): ip/user_agent/request_id/e-posta yok.
import { sql } from "drizzle-orm";
import { AUDIT_ACTIONS, appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery, type AccessTx, type TenantAccessParams } from "../identity/access.ts";
import { CSV_BOM, auditCsvHeader, auditCsvRow } from "./csv.ts";
import { summaryKeyFor, validCursorTs } from "./today-impl.ts";

export const AUDIT_LIST_DEFAULT_LIMIT = 50;
export const AUDIT_LIST_MAX_LIMIT = 100;
export const AUDIT_EXPORT_CHUNK_SIZE = 1000;

export interface AuditFilters {
  /** `YYYY-MM-DD` (tenant saat diliminde günün başı, dahil). */
  readonly from?: string;
  /** `YYYY-MM-DD` (tenant saat diliminde gün dahil). */
  readonly to?: string;
  /** Kayıtlı eylem (`AUDIT_ACTIONS`). */
  readonly action?: string;
}

export interface AuditRow {
  readonly id: string;
  readonly occurredAt: Date;
  /** Kişi görünen adı (e-posta DÖNMEZ); sistem işlemi/bilinmeyen → `null`. */
  readonly actorName: string | null;
  readonly action: string;
  /** `action` kayıtlı mı (ekran i18n adı için). */
  readonly actionKnown: boolean;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly reason: string | null;
}

export interface AuditPage {
  /** Tenant saat dilimi (IANA), gösterim için. */
  readonly timeZone: string;
  readonly items: readonly AuditRow[];
  /** Opak imleç; yok → son sayfa. */
  readonly nextCursor: string | null;
}

export interface ListAuditOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly filters?: AuditFilters;
}

type QueryParams = Omit<TenantAccessParams, "permission" | "recentAuth">;
interface Cursor {
  readonly ts: string;
  readonly id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SNAPSHOT_RE = /^\d+:\d+:(?:\d+(?:,\d+)*)?$/;
const KNOWN: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);

export function encodeAuditCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ ts: c.ts, id: c.id }), "utf8").toString("base64url");
}

export function decodeAuditCursor(raw: string): Cursor {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new AppError("VALIDATION_FAILED");
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new AppError("VALIDATION_FAILED");
  }
  const c = o as { ts?: unknown; id?: unknown } | null;
  if (typeof c?.ts !== "string" || !validCursorTs(c.ts) || typeof c.id !== "string" || !UUID_RE.test(c.id)) throw new AppError("VALIDATION_FAILED");
  return { ts: c.ts, id: c.id };
}

function validDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function checkFilters(f: AuditFilters | undefined): AuditFilters {
  if (f === undefined) return {};
  if (typeof f !== "object" || f === null) throw new AppError("VALIDATION_FAILED");
  for (const k of ["from", "to"] as const) {
    const v = f[k];
    if (v !== undefined && (typeof v !== "string" || !validDate(v))) throw new AppError("VALIDATION_FAILED");
  }
  if (f.from !== undefined && f.to !== undefined && f.from > f.to) throw new AppError("VALIDATION_FAILED");
  if (f.action !== undefined && (typeof f.action !== "string" || !KNOWN.has(f.action))) throw new AppError("VALIDATION_FAILED");
  return { ...(f.from === undefined ? {} : { from: f.from }), ...(f.to === undefined ? {} : { to: f.to }), ...(f.action === undefined ? {} : { action: f.action }) };
}

async function tenantTimeZone(tx: AccessTx, tenantId: string): Promise<string> {
  const rows = await tx.execute<{ time_zone: string }>(sql`SELECT time_zone FROM public.tenant_settings WHERE tenant_id = ${tenantId}::uuid`);
  const tz = rows[0]?.time_zone;
  if (tz === undefined) throw new AppError("NOT_FOUND");
  return tz;
}

type RawRow = {
  id: string;
  occurred_at: Date | string;
  ts: string;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  reason: string | null;
  summary: string;
};

/** Ortak sayfa sorgusu: tenant + filtre + (isteğe bağlı) imleç + (isteğe bağlı) kesit; `limit` satır. */
async function selectRows(
  tx: AccessTx,
  tenantId: string,
  tz: string,
  filters: AuditFilters,
  cursor: Cursor | undefined,
  snapshot: string | undefined,
  limit: number,
  withSummary: boolean,
): Promise<RawRow[]> {
  const from = filters.from === undefined ? sql`` : sql`AND a.occurred_at >= ((${filters.from}::date)::timestamp AT TIME ZONE ${tz})`;
  const to = filters.to === undefined ? sql`` : sql`AND a.occurred_at < (((${filters.to}::date + 1))::timestamp AT TIME ZONE ${tz})`;
  const act = filters.action === undefined ? sql`` : sql`AND a.action = ${filters.action}`;
  const after =
    cursor === undefined
      ? sql``
      : sql`AND (a.occurred_at < ${cursor.ts}::timestamptz OR (a.occurred_at = ${cursor.ts}::timestamptz AND a.id > ${cursor.id}::uuid))`;
  const snap = snapshot === undefined ? sql`` : sql`AND pg_visible_in_snapshot(a.created_xid, ${snapshot}::pg_snapshot)`;
  const summary = withSummary ? sql`a.change_summary::text` : sql`'{}'::text`;
  return [
    ...(await tx.execute<RawRow>(
      sql`SELECT a.id, a.occurred_at, a.occurred_at::text AS ts, u.name AS actor_name, a.action, a.entity_type, a.entity_id, a.reason,
                 ${summary} AS summary
            FROM public.audit_logs a
            LEFT JOIN public.users u ON u.id = a.actor_user_id
           WHERE a.tenant_id = ${tenantId}::uuid ${from} ${to} ${act} ${after} ${snap}
           ORDER BY a.occurred_at DESC, a.id ASC
           LIMIT ${limit}`,
    )),
  ];
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export async function listAudit(params: QueryParams, options: ListAuditOptions = {}): Promise<AuditPage> {
  const limit = options.limit ?? AUDIT_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_LIST_MAX_LIMIT) throw new AppError("VALIDATION_FAILED");
  const cursor = options.cursor === undefined ? undefined : decodeAuditCursor(options.cursor);
  const filters = checkFilters(options.filters);
  return runTenantQuery({ ...params, permission: "audit.view" }, async (tx, m) => {
    const timeZone = await tenantTimeZone(tx, m.tenantId);
    const rows = await selectRows(tx, m.tenantId, timeZone, filters, cursor, undefined, limit + 1, false);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      timeZone,
      items: page.map((r) => ({
        id: r.id,
        occurredAt: toDate(r.occurred_at),
        actorName: r.actor_name,
        action: r.action,
        actionKnown: KNOWN.has(r.action) && summaryKeyFor(r.action) !== "audit.other",
        entityType: r.entity_type,
        entityId: r.entity_id,
        reason: r.reason,
      })),
      nextCursor: rows.length > limit && last !== undefined ? encodeAuditCursor({ ts: last.ts, id: last.id }) : null,
    };
  });
}

export interface AuditExportOptions {
  readonly filters?: AuditFilters;
  /** `audit.exported` kaydına yazılır. */
  readonly requestId?: string | null;
  /** Test için parça boyutu (varsayılan 1000). */
  readonly chunkSize?: number;
}

export interface AuditExport {
  /** UTF-8 CSV (BOM + başlık + satırlar); her çekişte BİR parça = BİR kısa transaction. */
  readonly stream: ReadableStream<Uint8Array>;
}

/**
 * Export'u açar: ilk parça (izin + `recentAuth` + kesit + `audit.exported` + ilk satırlar) burada, akış başlamadan çalışır;
 * böylece FORBIDDEN / RECENT_AUTH_REQUIRED gibi hatalar HTTP durumuna çevrilebilir. `params.recentAuth` zorunludur (fail-closed).
 */
export async function openAuditExport(params: Omit<TenantAccessParams, "permission">, options: AuditExportOptions = {}): Promise<AuditExport> {
  if (params.recentAuth === undefined) throw new AppError("UNAUTHENTICATED", { detail: "RECENT_AUTH_REQUIRED" });
  const size = options.chunkSize ?? AUDIT_EXPORT_CHUNK_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > AUDIT_EXPORT_CHUNK_SIZE) throw new AppError("VALIDATION_FAILED");
  const filters = checkFilters(options.filters);
  const { recentAuth: _recentAuth, ...later } = params;
  void _recentAuth;

  const first = await runTenantQuery({ ...params, permission: "audit.view" }, async (tx, m) => {
    const snap = (await tx.execute<{ s: string }>(sql`SELECT pg_current_snapshot()::text AS s`))[0]?.s;
    if (snap === undefined || !SNAPSHOT_RE.test(snap)) throw new AppError("INTERNAL");
    const tz = await tenantTimeZone(tx, m.tenantId);
    await appendAudit(tx, {
      action: "audit.exported",
      actorUserId: m.userId,
      entityType: "audit_log",
      requestId: options.requestId ?? null,
      changeSummary: { format: "csv", ...(filters.from === undefined ? {} : { from: filters.from }), ...(filters.to === undefined ? {} : { to: filters.to }), ...(filters.action === undefined ? {} : { action: filters.action }) },
    });
    // Kesit: aynı transaction'ın yazdığı export olayı da kesitin DIŞINDADIR (xid, snapshot.xmax'tan sonra atanır).
    const rows = await selectRows(tx, m.tenantId, tz, filters, undefined, snap, size, true);
    return { snap, tz, rows };
  });

  const enc = new TextEncoder();
  const render = (rows: readonly RawRow[]): Uint8Array =>
    enc.encode(
      rows
        .map((r) =>
          auditCsvRow({
            occurredAt: toDate(r.occurred_at),
            actorName: r.actor_name,
            action: r.action,
            entityType: r.entity_type,
            entityId: r.entity_id,
            reason: r.reason,
            changeSummary: r.summary,
          }),
        )
        .join(""),
    );

  let pending: RawRow[] | null = first.rows;
  let head = true;
  const firstLast = first.rows[first.rows.length - 1];
  let lastCursor: Cursor | undefined = firstLast === undefined ? undefined : { ts: firstLast.ts, id: firstLast.id };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (head) {
        head = false;
        controller.enqueue(enc.encode(CSV_BOM + auditCsvHeader()));
      }
      let rows = pending;
      pending = null;
      if (rows === null) {
        // Sonraki parça: ayrı kısa transaction; üyelik/izin yeniden doğrulanır (recentAuth yalnızca ilk parçada).
        const cur = lastCursor;
        rows = await runTenantQuery({ ...later, permission: "audit.view" }, (tx, m) => selectRows(tx, m.tenantId, first.tz, filters, cur, first.snap, size, true));
      }
      const last = rows[rows.length - 1];
      if (last !== undefined) {
        lastCursor = { ts: last.ts, id: last.id };
        controller.enqueue(render(rows));
      }
      if (rows.length < size) {
        controller.close();
      }
    },
  });
  return { stream };
}
