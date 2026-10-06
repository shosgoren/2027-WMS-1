// Dış referans eşlemesi ve senkron imleçleri (T-252; A-252-1..A-252-7). ERP (Logo, Faz 6) hazırlığı: yalnız okuma/yazma API'si,
// adaptör ve ağ çağrısı yoktur.
//
// - Eşleme (UUID <-> dış kimlik) koddan bağımsızdır: iç taraf yalnızca `entity_id`; kod değişimi eşlemeyi etkilemez.
// - İki yönlü tekillik DB'dedir (`external_refs_entity_key`, `external_refs_external_key`); aynı dış kimlik başka varlığa ya da
//   varlık başka dış kimliğe bağlıysa `ExternalRefConflictError` (`reason = "EXTERNAL_REF_CONFLICT"`; A-252-3).
// - Yetki: `settings.manage` (yalnız TENANT_ADMIN; `integration.manage` izni yok, A-252-2). Yazma aynı transaction'da audit (I-12).
// - Varlığın aynı tenant'ta varlığı RLS altında burada doğrulanır (polimorfik tabloda bileşik FK yok, A-252-1). PARTY için tablo
//   yoktur: doğrulama kapalıdır (A-252-4).
// - İmleç = (created_xid, id) sırası (A-252-5); ilerleme `GREATEST` mantığıyla idempotenttir, geri gitmez (DB tetikleyicisi de reddeder).
// - `listUnsynced` yalnız `created_xid < pg_snapshot_xmin` olan (sonuçlanmış) defter satırlarını döndürür: düşük xid'li bir işlem
//   daha geç commit olsa da imleç onu atlayamaz (A-252-6).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { ledgerEntryExists, selectUnsyncedLedger } from "./ledger-reads.ts";
import { runTenantCommand, runTenantQuery, type AccessTx, type TenantAccessParams } from "../identity/access.ts";

export type IntegrationCallParams = Omit<TenantAccessParams, "permission" | "recentAuth">;

export const EXTERNAL_REF_ENTITY_TYPES = ["ITEM", "UNIT", "WAREHOUSE", "LOCATION", "PARTY", "DOCUMENT", "LEDGER_ENTRY"] as const;
export type ExternalRefEntityType = (typeof EXTERNAL_REF_ENTITY_TYPES)[number];

/** Desteklenen dışa aktarım akışları (A-252-5). */
export const SYNC_STREAMS = ["LEDGER"] as const;
export type SyncStream = (typeof SYNC_STREAMS)[number];

/** Varlık tablosu (sabit beyaz liste; kullanıcı girdisi SQL'e girmez). PARTY için tablo yok (A-252-4). */
const ENTITY_TABLE: Readonly<Record<ExternalRefEntityType, string | null>> = {
  ITEM: "items",
  UNIT: "units",
  WAREHOUSE: "warehouses",
  LOCATION: "locations",
  PARTY: null,
  DOCUMENT: "documents",
  LEDGER_ENTRY: null, // defter tablosu SQL'i ledger-reads.ts'tedir (dosya düzeyli stok SQL bekçisi)
};

/** Çakışma: `AppError` alt sınıfı (erişim katmanı `AppError`'ı olduğu gibi geçirir); HTTP/i18n eşlemesi Faz 6 (A-252-3). */
export class ExternalRefConflictError extends AppError {
  readonly reason = "EXTERNAL_REF_CONFLICT" as const;
  constructor() {
    super("VALIDATION_FAILED");
    this.name = "ExternalRefConflictError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const CONTROL_RE = /\p{C}/u;
const EXT_MAX = 200;
const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 500;
const XID_RE = /^[0-9]{1,18}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function uuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
}
function system(raw: unknown): string {
  if (typeof raw !== "string" || !SYSTEM_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw;
}
function entityType(raw: unknown): ExternalRefEntityType {
  if (typeof raw !== "string" || !(EXTERNAL_REF_ENTITY_TYPES as readonly string[]).includes(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as ExternalRefEntityType;
}
function extText(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const v = raw.trim();
  if (v === "" || Array.from(v).length > EXT_MAX || CONTROL_RE.test(v)) throw new AppError("VALIDATION_FAILED");
  return v;
}
function stream(raw: unknown): SyncStream {
  if (typeof raw !== "string" || !(SYNC_STREAMS as readonly string[]).includes(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as SyncStream;
}

export interface ExternalRefRow {
  readonly id: string;
  readonly system: string;
  readonly entityType: ExternalRefEntityType;
  readonly entityId: string;
  readonly externalId: string;
  readonly externalCode: string | null;
  readonly syncedAt: Date;
  readonly version: number;
}
type RawRef = {
  id: string;
  system: string;
  entity_type: ExternalRefEntityType;
  entity_id: string;
  external_id: string;
  external_code: string | null;
  synced_at: Date | string;
  version: number;
};
const REF_COLS = sql`id, system, entity_type, entity_id, external_id, external_code, synced_at, version`;
const toRow = (r: RawRef): ExternalRefRow => ({
  id: r.id,
  system: r.system,
  entityType: r.entity_type,
  entityId: r.entity_id,
  externalId: r.external_id,
  externalCode: r.external_code,
  syncedAt: new Date(r.synced_at), // ham sürücü değeri metin olabilir
  version: r.version,
});

export interface LinkExternalRefInput {
  readonly system: string;
  readonly entityType: ExternalRefEntityType;
  readonly entityId: string;
  readonly externalId: string;
  /** Verilmezse mevcut dış kod korunur. */
  readonly externalCode?: string;
  readonly requestId?: string | null;
}
export interface LinkExternalRefResult {
  readonly ref: ExternalRefRow;
  /** `true`: yeni eşleme; `false`: var olan (aynıysa değişmedi, dış kod farklıysa güncellendi — `updated`). */
  readonly created: boolean;
  readonly updated: boolean;
}

/**
 * Eşlemeyi kurar; idempotenttir (aynı çağrı tekrarında değişiklik/audit yok). Aynı dış kimlik başka varlığa, ya da bu varlık başka dış
 * kimliğe bağlıysa `ExternalRefConflictError` (kendiliğinden yeniden bağlama yok; A-252-7).
 */
export async function linkExternalRef(params: IntegrationCallParams, input: LinkExternalRefInput): Promise<LinkExternalRefResult> {
  const sys = system(input.system);
  const type = entityType(input.entityType);
  const entityId = uuid(input.entityId);
  const externalId = extText(input.externalId);
  const externalCode = input.externalCode === undefined ? undefined : extText(input.externalCode);
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const table = ENTITY_TABLE[type];
    if (type === "LEDGER_ENTRY") {
      if (!(await ledgerEntryExists(tx, m.tenantId, entityId))) throw new AppError("NOT_FOUND");
    } else if (table !== null) {
      const hit = await tx.execute(
        sql`SELECT 1 AS one FROM ${sql.raw(`public.${table}`)} WHERE tenant_id = ${m.tenantId}::uuid AND id = ${entityId}::uuid`,
      );
      if (hit[0] === undefined) throw new AppError("NOT_FOUND");
    }
    const refId = randomUUID();
    const ins = await tx.execute<RawRef>(
      sql`INSERT INTO public.external_refs (tenant_id, id, system, entity_type, entity_id, external_id, external_code)
          VALUES (${m.tenantId}::uuid, ${refId}::uuid, ${sys}, ${type}, ${entityId}::uuid, ${externalId}, ${externalCode ?? null})
          ON CONFLICT DO NOTHING
          RETURNING ${REF_COLS}`,
    );
    const audit = async (ref: ExternalRefRow, change: "created" | "updated"): Promise<void> => {
      await appendAudit(tx, {
        action: "external_ref.linked",
        actorUserId: m.userId,
        entityType: "external_ref",
        entityId: ref.id,
        requestId: input.requestId ?? null,
        changeSummary: { system: sys, linkedEntityType: type, linkedEntityId: entityId, externalId, change },
      });
    };
    if (ins[0] !== undefined) {
      const ref = toRow(ins[0]);
      await audit(ref, "created");
      return { ref, created: true, updated: false };
    }
    // Çakışma: ya bu varlığın eşlemesi vardır ya bu dış kimlik başka varlığa bağlıdır.
    const cur = await tx.execute<RawRef>(
      sql`SELECT ${REF_COLS} FROM public.external_refs
           WHERE tenant_id = ${m.tenantId}::uuid AND system = ${sys} AND entity_type = ${type} AND entity_id = ${entityId}::uuid
             FOR NO KEY UPDATE`,
    );
    const row = cur[0];
    if (row === undefined || row.external_id !== externalId) throw new ExternalRefConflictError();
    if (externalCode === undefined || externalCode === row.external_code) return { ref: toRow(row), created: false, updated: false };
    const upd = await tx.execute<RawRef>(
      sql`UPDATE public.external_refs SET external_code = ${externalCode}
           WHERE tenant_id = ${m.tenantId}::uuid AND id = ${row.id}::uuid RETURNING ${REF_COLS}`,
    );
    const ref = toRow(upd[0] as RawRef);
    await audit(ref, "updated");
    return { ref, created: false, updated: true };
  });
}

export interface ResolveByExternalIdInput {
  readonly system: string;
  readonly entityType: ExternalRefEntityType;
  readonly externalId: string;
}
/** Dış kimlikten iç eşlemeyi çözer; yoksa `null`. */
export async function resolveByExternalId(params: IntegrationCallParams, input: ResolveByExternalIdInput): Promise<ExternalRefRow | null> {
  const sys = system(input.system);
  const type = entityType(input.entityType);
  const externalId = extText(input.externalId);
  return runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const r = await tx.execute<RawRef>(
      sql`SELECT ${REF_COLS} FROM public.external_refs
           WHERE tenant_id = ${m.tenantId}::uuid AND system = ${sys} AND entity_type = ${type} AND external_id = ${externalId}`,
    );
    return r[0] === undefined ? null : toRow(r[0]);
  });
}

export interface ResolveByEntityInput {
  readonly system: string;
  readonly entityType: ExternalRefEntityType;
  readonly entityId: string;
}
/** İç varlıktan dış eşlemeyi çözer (ters yön); yoksa `null`. */
export async function resolveByEntity(params: IntegrationCallParams, input: ResolveByEntityInput): Promise<ExternalRefRow | null> {
  const sys = system(input.system);
  const type = entityType(input.entityType);
  const entityId = uuid(input.entityId);
  return runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const r = await tx.execute<RawRef>(
      sql`SELECT ${REF_COLS} FROM public.external_refs
           WHERE tenant_id = ${m.tenantId}::uuid AND system = ${sys} AND entity_type = ${type} AND entity_id = ${entityId}::uuid`,
    );
    return r[0] === undefined ? null : toRow(r[0]);
  });
}

/** Defter sırası imleci: (`created_xid`, `id`). `xid` ondalık metin (xid8 → bigint aralığı). */
export interface SyncPosition {
  readonly xid: string;
  readonly id: string;
}
export const SYNC_START: SyncPosition = Object.freeze({ xid: "0", id: NIL_UUID });

function position(p: SyncPosition): SyncPosition {
  if (typeof p?.xid !== "string" || !XID_RE.test(p.xid)) throw new AppError("VALIDATION_FAILED");
  return { xid: String(BigInt(p.xid)), id: uuid(p.id) };
}

export interface SyncCursorInput {
  readonly system: string;
  readonly stream: SyncStream;
}
type RawCursor = {
  cursor_xid: string;
  cursor_id: string;
};

/** Kayıtlı imleç; hiç ilerletilmediyse başlangıç konumu. */
export async function getSyncCursor(params: IntegrationCallParams, input: SyncCursorInput): Promise<SyncPosition> {
  const sys = system(input.system);
  const st = stream(input.stream);
  return runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, m) => readCursor(tx, m.tenantId, sys, st));
}

async function readCursor(tx: AccessTx, tenantId: string, sys: string, st: string): Promise<SyncPosition> {
  const r = await tx.execute<RawCursor>(
    sql`SELECT cursor_xid::text AS cursor_xid, cursor_id FROM public.sync_cursors
         WHERE tenant_id = ${tenantId}::uuid AND system = ${sys} AND stream = ${st}`,
  );
  return r[0] === undefined ? SYNC_START : { xid: r[0].cursor_xid, id: r[0].cursor_id };
}

export interface AdvanceSyncCursorInput extends SyncCursorInput {
  readonly to: SyncPosition;
}
/**
 * İmleci ileri alır. İdempotent: aynı/daha geri konum (tekrar teslim, yarış) imleci DEĞİŞTİRMEZ ve `advanced: false` döner;
 * her durumda dönen `cursor` kayıtlı güncel konumdur.
 */
export async function advanceSyncCursor(
  params: IntegrationCallParams,
  input: AdvanceSyncCursorInput,
): Promise<{ readonly advanced: boolean; readonly cursor: SyncPosition }> {
  const sys = system(input.system);
  const st = stream(input.stream);
  const to = position(input.to);
  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const r = await tx.execute<RawCursor>(
      sql`INSERT INTO public.sync_cursors (tenant_id, id, system, stream, cursor_xid, cursor_id)
          VALUES (${m.tenantId}::uuid, ${randomUUID()}::uuid, ${sys}, ${st}, ${to.xid}::bigint, ${to.id}::uuid)
          ON CONFLICT ON CONSTRAINT sync_cursors_stream_key DO UPDATE
            SET cursor_xid = EXCLUDED.cursor_xid, cursor_id = EXCLUDED.cursor_id
            WHERE (public.sync_cursors.cursor_xid, public.sync_cursors.cursor_id) < (EXCLUDED.cursor_xid, EXCLUDED.cursor_id)
          RETURNING cursor_xid::text AS cursor_xid, cursor_id`,
    );
    if (r[0] !== undefined) return { advanced: true, cursor: { xid: r[0].cursor_xid, id: r[0].cursor_id } };
    return { advanced: false, cursor: await readCursor(tx, m.tenantId, sys, st) };
  });
}

export interface ListUnsyncedInput extends SyncCursorInput {
  /** Bu konumdan SONRAKİ satırlar; verilmezse kayıtlı imleç. */
  readonly after?: SyncPosition;
  readonly limit?: number;
}
export interface UnsyncedLedgerEntry {
  readonly ledgerId: string;
  readonly position: SyncPosition;
  readonly documentId: string;
  readonly documentLineId: string;
  readonly itemId: string;
  /** Ondalık metin (I-09). */
  readonly quantity: string;
  readonly reason: string;
  readonly businessDate: string;
  readonly occurredAt: Date;
  /** Bu `system` için ürün/belge dış kimliği (yoksa `null`). */
  readonly itemExternalId: string | null;
  readonly documentExternalId: string | null;
}

/**
 * Dışa aktarılmamış (LEDGER_ENTRY dış referansı olmayan) sonuçlanmış defter satırları, (created_xid, id) sırasıyla. İç UUID'ler ile
 * ürün/belge dış kimliğini birlikte taşır; salt okunur (adaptör Faz 6).
 */
export async function listUnsynced(
  params: IntegrationCallParams,
  input: ListUnsyncedInput,
): Promise<{ readonly entries: readonly UnsyncedLedgerEntry[]; readonly next: SyncPosition | null }> {
  const sys = system(input.system);
  const st = stream(input.stream);
  const limit = input.limit ?? LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw new AppError("VALIDATION_FAILED");
  const explicit = input.after === undefined ? undefined : position(input.after);
  return runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, m) => {
    const after = explicit ?? (await readCursor(tx, m.tenantId, sys, st));
    const rows = await selectUnsyncedLedger(tx, m.tenantId, sys, after, limit);
    const entries = rows.map(
      (r): UnsyncedLedgerEntry => ({
        ledgerId: r.id,
        position: { xid: r.xid, id: r.id },
        documentId: r.document_id,
        documentLineId: r.document_line_id,
        itemId: r.item_id,
        quantity: r.quantity,
        reason: r.reason,
        businessDate: r.business_date,
        occurredAt: new Date(r.occurred_at),
        itemExternalId: r.item_ext,
        documentExternalId: r.doc_ext,
      }),
    );
    const last = entries[entries.length - 1];
    return { entries, next: last === undefined ? null : last.position };
  });
}
