// Sayım okuma sorguları (T-316a; T-313 `receiving-queries.ts` deseni). Salt okur: yazma yok, kilit yok, stok kuralı yok.
//
// - `listCountSessions` `stock.view`; `getCountSession` `field` kipinde `stock.view`, `review` kipinde `count_diff.approve` ister (komut izin matrisiyle aynı: A-132).
// - KÖR SAYIM SUNUCUDA ZORLANIR: `field` kipinde referans (sistem) miktarı ve fark SQL'den bile okunmaz ve satır nesnesinde ANAHTAR olarak bulunmaz
//   (alan "null" değil, hiç yoktur). Kip oturumun `blind` bayrağından bağımsızdır (A-316a-2: fail-closed).
// - Tenant kimliği yalnızca doğrulanmış üyelikten gelir ve her sorguda AÇIK süzgeçtir (RLS ikinci savunma). Depo kapsamı (A-46): liste kapsam süzgeciyle,
//   tekil okuma `assertWarehouseVisible` ile; yok / başka tenant / kapsam dışı oturum aynı `NOT_FOUND` (varlık sızmaz).
// - Terk bayrağı `findAbandonedCounts` çıktısından türetilir (eşik ve tanım TEK kaynak: counting.ts; burada kopya yoktur).
// - Keyset (started_at DESC, id DESC), OFFSET yok (I-14); miktarlar `numeric` → metin (I-09).
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery } from "../identity/access.ts";
import { assertWarehouseVisible, pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import { findAbandonedCounts, type CountStockStatus } from "./counting.ts";
import { isCalendarTime, type TaskCallParams } from "./tasks.ts";

export const COUNT_SESSION_STATUSES = ["COUNTING", "SUBMITTED", "APPROVED", "POSTED", "CANCELLED"] as const;
export type CountSessionStatus = (typeof COUNT_SESSION_STATUSES)[number];
export const COUNT_VIEWS = ["field", "review"] as const;
export type CountView = (typeof COUNT_VIEWS)[number];
export const COUNT_LIST_LIMIT_DEFAULT = 30;
export const COUNT_LIST_LIMIT_MAX = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface CountSessionView {
  readonly id: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly status: CountSessionStatus;
  /** Oturumun başlatılırken seçilen kör bayrağı (bilgi); `field` kipi bundan bağımsız daima kördür. */
  readonly blind: boolean;
  /** Oturuma bağlı lokasyon sayısı (kilitli ∪ satırı olan; A-316a-1). */
  readonly locationCount: number;
  /** Mikrosaniyeli UTC ISO (`YYYY-MM-DDTHH:MM:SS.ffffffZ`). */
  readonly startedAt: string;
  readonly startedBy: { readonly membershipId: string; readonly name: string | null };
  /** `findAbandonedCounts` ile aynı eşik/tanım: `COUNTING` kilitli ve eşiği aşmış. */
  readonly abandoned: boolean;
}
export interface CountSessionCursor {
  readonly startedAt: string;
  readonly id: string;
}
export interface CountSessionPage {
  readonly items: readonly CountSessionView[];
  readonly next: CountSessionCursor | null;
}
export interface ListCountSessionsInput {
  readonly status?: CountSessionStatus;
  readonly afterKey?: CountSessionCursor;
  readonly limit?: number;
}

export interface CountLocationView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Şu an bu oturuma `COUNTING` kilitli mi (kapanmış oturumda false). */
  readonly locked: boolean;
}
/** Saha (kör) satırı: referans ve fark alanları YOKTUR. */
export interface CountFieldLine {
  readonly id: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitCode: string;
  readonly unitName: string;
  readonly quantityScale: number;
  readonly stockStatus: CountStockStatus;
  /** Sayılan miktar (henüz sayılmadıysa `null`); sayacın kendi girdisidir, sistem miktarı değildir. */
  readonly counted: string | null;
}
/** Gözden geçirme satırı: referans / sayılan / fark (`counted − reference`; sayılmadıysa `null`). */
export interface CountReviewLine extends CountFieldLine {
  readonly reference: string;
  readonly difference: string | null;
}
export interface CountFieldDetail {
  readonly view: "field";
  readonly session: CountSessionView;
  readonly locations: readonly CountLocationView[];
  readonly lines: readonly CountFieldLine[];
}
export interface CountReviewDetail {
  readonly view: "review";
  readonly session: CountSessionView;
  readonly locations: readonly CountLocationView[];
  readonly lines: readonly CountReviewLine[];
}
export type CountSessionDetail = CountFieldDetail | CountReviewDetail;

type SessionDbRow = {
  id: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  status: CountSessionStatus;
  blind: boolean;
  location_count: number | string;
  started_key: string;
  started_by: string;
  started_by_name: string | null;
};

const uuid = (raw: unknown): string => {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
};

function cursorOf(raw: CountSessionCursor | undefined): { key: string; id: string } | null {
  if (raw === undefined) return null;
  if (typeof raw.startedAt !== "string" || !CURSOR_TIME_RE.test(raw.startedAt) || !isCalendarTime(raw.startedAt)) throw new AppError("VALIDATION_FAILED");
  return { key: raw.startedAt, id: uuid(raw.id) };
}
function limitOf(raw: number | undefined): number {
  if (raw === undefined) return COUNT_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(raw) || raw < 1 || raw > COUNT_LIST_LIMIT_MAX) throw new AppError("VALIDATION_FAILED");
  return raw;
}

const toView = (r: SessionDbRow, abandoned: ReadonlySet<string>): CountSessionView => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  warehouseCode: r.warehouse_code,
  warehouseName: r.warehouse_name,
  status: r.status,
  blind: r.blind,
  locationCount: Number(r.location_count),
  startedAt: r.started_key,
  startedBy: { membershipId: r.started_by, name: r.started_by_name },
  abandoned: abandoned.has(r.id),
});

const SESSION_SELECT = sql`SELECT s.id, s.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, s.status, s.blind,
       (SELECT count(*) FROM (
          SELECT x.location_id FROM public.count_session_lines x WHERE x.tenant_id = s.tenant_id AND x.session_id = s.id
          UNION
          SELECT k.location_id FROM public.location_count_locks k WHERE k.tenant_id = s.tenant_id AND k.count_session_id = s.id AND k.status = 'COUNTING'
        ) u)::int AS location_count,
       to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_key,
       s.started_by, usr.name AS started_by_name
  FROM public.count_sessions s
  JOIN public.warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
  LEFT JOIN public.tenant_memberships mb ON mb.tenant_id = s.tenant_id AND mb.id = s.started_by
  LEFT JOIN public.users usr ON usr.id = mb.user_id`;

/** Terk bayrağı kümesi: eşik/tanım `findAbandonedCounts`'tan (tek kaynak). */
async function abandonedIds(tx: Parameters<typeof findAbandonedCounts>[0], tenantId: string): Promise<ReadonlySet<string>> {
  return new Set((await findAbandonedCounts(tx, tenantId)).map((a) => a.sessionId.toLowerCase()));
}

/** Sayım oturumları, yeniden eskiye (started_at, id), keyset; kapsam dışı depo oturumları görünmez. `stock.view`. */
export async function listCountSessions(params: TaskCallParams, input: ListCountSessionsInput = {}): Promise<CountSessionPage> {
  const limit = limitOf(input.limit);
  const cur = cursorOf(input.afterKey);
  const status = input.status ?? null;
  if (status !== null && !(COUNT_SESSION_STATUSES as readonly string[]).includes(status)) throw new AppError("VALIDATION_FAILED");
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const rows = await tx.execute<SessionDbRow>(
      sql`${SESSION_SELECT}
           WHERE s.tenant_id = ${m.tenantId}::uuid
             AND (${status}::text IS NULL OR s.status = ${status}::text)
             AND (${scope === null}::boolean OR s.warehouse_id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))
             AND (${cur === null}::boolean OR (s.started_at, s.id) < (${cur?.key ?? "1970-01-01T00:00:00.000000Z"}::timestamptz, ${cur?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
           ORDER BY s.started_at DESC, s.id DESC
           LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const abandoned = await abandonedIds(tx, m.tenantId);
    const last = page[page.length - 1];
    return { items: page.map((r) => toView(r, abandoned)), next: rows.length > limit && last !== undefined ? { startedAt: last.started_key, id: last.id } : null };
  });
}

type LineDbRow = {
  id: string;
  location_id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  unit_code: string;
  unit_name: string;
  quantity_scale: number | string;
  stock_status: CountStockStatus;
  counted: string | null;
  reference?: string;
  difference?: string | null;
};

/**
 * Tek oturum: başlık + lokasyonlar + satırlar. `view: "field"` (`stock.view`) kördür: referans/fark sorguya bile girmez. `view: "review"` (`count_diff.approve`)
 * referans / sayılan / fark döner. İzin, oturum varlığından ÖNCE denetlenir (rol tabanlı `FORBIDDEN` varlık sızdırmaz). Yok / başka tenant / kapsam dışı → `NOT_FOUND`.
 */
export function getCountSession(params: TaskCallParams, input: { readonly sessionId: string; readonly view: "field" }): Promise<CountFieldDetail>;
export function getCountSession(params: TaskCallParams, input: { readonly sessionId: string; readonly view: "review" }): Promise<CountReviewDetail>;
export function getCountSession(params: TaskCallParams, input: { readonly sessionId: string; readonly view: CountView }): Promise<CountSessionDetail>;
export async function getCountSession(params: TaskCallParams, input: { readonly sessionId: string; readonly view: CountView }): Promise<CountSessionDetail> {
  const sessionId = uuid(input.sessionId);
  const view = input.view;
  if (!(COUNT_VIEWS as readonly string[]).includes(view)) throw new AppError("VALIDATION_FAILED");
  return runTenantQuery({ ...params, permission: view === "review" ? "count_diff.approve" : "stock.view" }, async (tx, m) => {
    const rows = await tx.execute<SessionDbRow>(sql`${SESSION_SELECT} WHERE s.tenant_id = ${m.tenantId}::uuid AND s.id = ${sessionId}::uuid`);
    const row = rows[0];
    if (row === undefined) throw new AppError("NOT_FOUND");
    await assertWarehouseVisible(tx, m, [row.warehouse_id]);
    const session = toView(row, await abandonedIds(tx, m.tenantId));

    const locs = await tx.execute<{ id: string; code: string; name: string; locked: boolean }>(
      sql`SELECT l.id, l.code, l.name,
                 EXISTS (SELECT 1 FROM public.location_count_locks k
                          WHERE k.tenant_id = l.tenant_id AND k.location_id = l.id AND k.count_session_id = ${sessionId}::uuid AND k.status = 'COUNTING') AS locked
            FROM public.locations l
           WHERE l.tenant_id = ${m.tenantId}::uuid
             AND l.id IN (SELECT x.location_id FROM public.count_session_lines x WHERE x.tenant_id = ${m.tenantId}::uuid AND x.session_id = ${sessionId}::uuid
                          UNION
                          SELECT k.location_id FROM public.location_count_locks k
                           WHERE k.tenant_id = ${m.tenantId}::uuid AND k.count_session_id = ${sessionId}::uuid AND k.status = 'COUNTING')
           ORDER BY l.code COLLATE "C", l.id`,
    );
    const locations = locs.map((l) => ({ id: l.id, code: l.code, name: l.name, locked: l.locked === true }));

    // Kör kipte referans/fark sütunları SORGUYA HİÇ girmez (boş parça).
    const reviewCols = view === "review" ? sql`, l.reference_quantity::text AS reference, (l.counted_quantity - l.reference_quantity)::text AS difference` : sql``;
    const lineRows = await tx.execute<LineDbRow>(
      sql`SELECT l.id, l.location_id, l.item_id, i.code AS item_code, i.name AS item_name, un.code AS unit_code, un.name AS unit_name, i.quantity_scale,
                 COALESCE(d.stock_status, 'AVAILABLE') AS stock_status, l.counted_quantity::text AS counted${reviewCols}
            FROM public.count_session_lines l
            JOIN public.items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
            JOIN public.units un ON un.tenant_id = i.tenant_id AND un.id = i.base_unit_id
            JOIN public.locations lo ON lo.tenant_id = l.tenant_id AND lo.id = l.location_id
            LEFT JOIN public.stock_dimensions d ON d.tenant_id = l.tenant_id AND d.id = l.stock_dimension_id
           WHERE l.tenant_id = ${m.tenantId}::uuid AND l.session_id = ${sessionId}::uuid
           ORDER BY lo.code COLLATE "C", i.code COLLATE "C", COALESCE(d.stock_status, 'AVAILABLE'), l.id`,
    );
    // Açık beyaz liste eşlemesi: alan ekleme/silme bilinçli olur (kör kipte anahtar sızıntısı olamaz).
    const field = (r: LineDbRow): CountFieldLine => ({
      id: r.id,
      locationId: r.location_id,
      itemId: r.item_id,
      itemCode: r.item_code,
      itemName: r.item_name,
      unitCode: r.unit_code,
      unitName: r.unit_name,
      quantityScale: Number(r.quantity_scale),
      stockStatus: r.stock_status,
      counted: r.counted,
    });
    if (view === "review") {
      return {
        view: "review",
        session,
        locations,
        lines: lineRows.map((r): CountReviewLine => ({ ...field(r), reference: r.reference as string, difference: r.difference ?? null })),
      };
    }
    return { view: "field", session, locations, lines: lineRows.map(field) };
  });
}
