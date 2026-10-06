// "Bugün yaptıkların" (T-122a; docs/spec/08-ux-i18n.md ana ekran): çağıranın KENDİ bugünkü audit satırları.
// - Gün sınırı tenant saat diliminde (`tenant_settings.time_zone`), DST'ye dayanıklı (yerel gün başlangıcı + 1 gün).
// - Yalnızca eylem, zaman ve i18n anahtarı döner; `change_summary`/`reason`/ip/user_agent/entity DÖNMEZ (G-09, en az veri).
// - İzin: A-65 — kendi satırların için `stock.view` (her rol); başkasının satırı sorguda zaten yok.
// - Keyset: (occurred_at DESC, id ASC) — `audit_logs_tenant_occurred_idx` sırası. İmleç opak; mikrosaniye kaybolmasın
//   diye zaman damgası metin olarak taşınır.
import { sql } from "drizzle-orm";
import { AUDIT_ACTIONS } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery, type TenantAccessParams } from "../identity/access.ts";

export const TODAY_ACTIONS_MAX_LIMIT = 20;
export const TODAY_ACTIONS_DEFAULT_LIMIT = 5;
export const AUDIT_OTHER_KEY = "audit.other";

export interface MyActionRow {
  readonly action: string;
  readonly occurredAt: Date;
  /** i18n anahtarı: bilinen eylem `audit.<action>`, bilinmeyen `audit.other`. */
  readonly summaryKey: string;
}

/** Opak imleç: bir sonraki sayfa için `nextCursor` olduğu gibi geri verilir. */
export interface MyActionsCursor {
  readonly ts: string;
  readonly id: string;
}

export interface MyActionsPage {
  /** Tenant saat dilimi (IANA); `occurredAt` gösterimi için. Ayrı izin gerektirmez (gün sınırı için zaten okunur). */
  readonly timeZone: string;
  readonly items: readonly MyActionRow[];
  readonly nextCursor: MyActionsCursor | null;
}

export interface ListMyActionsOptions {
  /** 1..20 (varsayılan 5); aksi VALIDATION_FAILED. */
  readonly limit?: number;
  readonly cursor?: MyActionsCursor;
}

const KNOWN: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?([+-]\d{2}(?::\d{2})?)$/;

/** Biçim + takvim gidiş-dönüşü (2026-02-30, saat 25 vb. reddedilir). */
export function validCursorTs(ts: string): boolean {
  const m = TS_RE.exec(ts);
  if (m === null) return false;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== se) return false;
  const off = m[7] === undefined ? null : m[7];
  if (off !== null) {
    const [oh, om] = off.slice(1).split(":").map(Number) as [number, number | undefined];
    if (oh > 15 || (om ?? 0) > 59) return false;
  }
  return !Number.isNaN(Date.parse(`${ts.replace(" ", "T")}`.replace(/([+-]\d{2})$/, "$1:00")));
}

export function summaryKeyFor(action: string): string {
  return KNOWN.has(action) ? `audit.${action}` : AUDIT_OTHER_KEY;
}

/** İç uygulama (genel paket yüzeyinde YOK); `now` yalnızca testten enjekte edilir. */
export async function listMyActionsTodayAt(
  params: Omit<TenantAccessParams, "permission" | "recentAuth">,
  options: ListMyActionsOptions,
  now: Date,
): Promise<MyActionsPage> {
  const limit = options.limit ?? TODAY_ACTIONS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > TODAY_ACTIONS_MAX_LIMIT) throw new AppError("VALIDATION_FAILED");
  const cursor = options.cursor;
  if (cursor !== undefined && (typeof cursor.ts !== "string" || !validCursorTs(cursor.ts) || typeof cursor.id !== "string" || !UUID_RE.test(cursor.id))) {
    throw new AppError("VALIDATION_FAILED");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new AppError("VALIDATION_FAILED");

  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, membership) => {
    const tz = await tx.execute<{ time_zone: string }>(
      sql`SELECT time_zone FROM public.tenant_settings WHERE tenant_id = ${membership.tenantId}::uuid`,
    );
    const timeZone = tz[0]?.time_zone;
    if (timeZone === undefined) throw new AppError("NOT_FOUND");
    const after =
      cursor === undefined
        ? sql``
        : sql`AND (a.occurred_at < ${cursor.ts}::timestamptz OR (a.occurred_at = ${cursor.ts}::timestamptz AND a.id > ${cursor.id}::uuid))`;
    const rows = await tx.execute<{ id: string; action: string; occurred_at: Date | string; ts: string }>(
      sql`WITH d AS (
            SELECT date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE ${timeZone}) AS local_start
          )
          SELECT a.id, a.action, a.occurred_at, a.occurred_at::text AS ts
            FROM public.audit_logs a, d
           WHERE a.tenant_id = ${membership.tenantId}::uuid
             AND a.actor_user_id = ${membership.userId}::uuid
             AND a.occurred_at >= (d.local_start AT TIME ZONE ${timeZone})
             AND a.occurred_at <  ((d.local_start + interval '1 day') AT TIME ZONE ${timeZone})
             ${after}
           ORDER BY a.occurred_at DESC, a.id ASC
           LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      timeZone,
      items: page.map((r) => ({
        action: r.action,
        occurredAt: r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at),
        summaryKey: summaryKeyFor(r.action),
      })),
      nextCursor: rows.length > limit && last !== undefined ? { ts: last.ts, id: last.id } : null,
    };
  });
}
