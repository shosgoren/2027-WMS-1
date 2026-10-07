// Toplu raf oluşturucu (T-250; A-250-2, A-250-3, A-250-4). "Bölge A, raf 1–10, göz 1–5" → `A-01-01 … A-10-05` (50 lokasyon).
//
// - İki adım: `previewBulkLocations` (salt okuma: sayı, ilk/son kod, örnekler, MEVCUT KODLA ÇAKIŞMALAR) ve `createBulkLocations`
//   (tek transaction, hepsi ya da hiçbiri). Çakışma varsa oluşturma `CODE_TAKEN` ile reddedilir; kullanıcı önizlemede çakışmaları görür.
// - Yetki, depo kapsamı, depo/ebeveyn kilidi (`FOR SHARE`), `depth` ve tür kuralları `createLocation` ile aynıdır (`settings.manage`).
//   Kodlar domain'de üretilir (UI'da kural yok); biçim: `<BÖLGE>-<raf>-<göz>`, sayılar en az 2 basamak sıfır dolgulu. Ad = kod (A-250-3).
// - Üst sınır {@link BULK_LOCATIONS_MAX} (A-250-2): sınırı aşan istek, hiçbir kod üretilmeden `VALIDATION_FAILED`. Depo başına toplam
//   {@link WAREHOUSE_LOCATIONS_MAX} (A-259-1) mevcut + planlanan sayıyla denetlenir (önizleme de reddeder).
// - İdempotency (A-250-4): `idempotencyKey` (UUID) zorunlu. Anahtar, komutun tek `location.created` audit satırında (`entity_id`; ayrıca `bulk_ref`; anahtar adları audit maskeleme listesine takılmasın diye `*_fp`/`*_loc`) saklanır;
//   aynı anahtar + aynı girdi → yeni yazım yok, `replayed: true`; aynı anahtar + farklı girdi → `IDEMPOTENCY_MISMATCH`. Eşzamanlı aynı anahtar
//   transaction-düzeyi advisory kilitle serileşir. Anahtar {@link IDEMPOTENCY_WINDOW_DAYS} gün aranır (audit taraması sınırlı kalsın).
// - Audit: komut başına TEK satır (`location.created`, `entity_type = location_batch`); tek tek lokasyon satırı yok (A-250-3).
//   Her lokasyon için sayım kilidi satırı 0010 tetikleyicisiyle oluşur; komut sayısını doğrular (yoksa `COUNT_LOCK_ROW_MISSING`).
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx } from "../identity/access.ts";
import { parseUuid, codeTaken, type WarehouseCallParams } from "./warehouses.ts";
import { WAREHOUSE_LOCATIONS_MAX, assertWarehouseCapacity, childDepth, parseKind, type LocationKindValue } from "./locations.ts";

export { WAREHOUSE_LOCATIONS_MAX };
import { assertWarehouseVisible } from "./scope.ts";
import { countLockRowsExisting } from "./stock-usage.ts";

/** A-250-2: tek komutta en çok lokasyon. */
export const BULK_LOCATIONS_MAX = 2000;
/** A-250-4: idempotency anahtarının aranacağı pencere. */
export const IDEMPOTENCY_WINDOW_DAYS = 7;
const RANGE_MAX = 999;
const ZONE_RE = /^[A-Z0-9]{1,8}$/;
const PREVIEW_SAMPLE = 30;
const CONFLICT_LIST_MAX = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BulkLocationsSpec {
  readonly warehouseId: string;
  /** Üst lokasyon; yoksa depo altında kök düzeyde. */
  readonly parentId?: string | null;
  /** Bölge öneki (ör. `A`); büyütülür. */
  readonly zone: string;
  readonly rackFrom: number;
  readonly rackTo: number;
  readonly levelFrom: number;
  readonly levelTo: number;
  /** Varsayılan `STORAGE` (`TRANSIT` yalnızca kök düzeyde, toplu oluşturmada kullanılamaz). */
  readonly kind?: LocationKindValue;
}

export interface BulkPlan {
  readonly codes: readonly string[];
  readonly kind: LocationKindValue;
  readonly zone: string;
}

function int(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > RANGE_MAX) throw new AppError("VALIDATION_FAILED");
  return raw;
}

/** Saf plan: doğrulama + kod üretimi (DB yok). Sınır aşımı kod üretilmeden reddedilir. */
export function planBulkLocations(spec: Pick<BulkLocationsSpec, "zone" | "rackFrom" | "rackTo" | "levelFrom" | "levelTo" | "kind">): BulkPlan {
  if (typeof spec.zone !== "string") throw new AppError("VALIDATION_FAILED");
  const zone = spec.zone.trim().toUpperCase();
  if (!ZONE_RE.test(zone)) throw new AppError("VALIDATION_FAILED");
  const rackFrom = int(spec.rackFrom);
  const rackTo = int(spec.rackTo);
  const levelFrom = int(spec.levelFrom);
  const levelTo = int(spec.levelTo);
  if (rackFrom > rackTo || levelFrom > levelTo) throw new AppError("VALIDATION_FAILED");
  const kind = spec.kind === undefined ? "STORAGE" : parseKind(spec.kind);
  if (kind === "TRANSIT") throw new AppError("VALIDATION_FAILED", { detail: "PARENT_INVALID" });
  const total = (rackTo - rackFrom + 1) * (levelTo - levelFrom + 1);
  if (total > BULK_LOCATIONS_MAX) throw new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_TOO_LARGE" });
  const rackW = Math.max(2, String(rackTo).length);
  const levelW = Math.max(2, String(levelTo).length);
  const codes: string[] = [];
  for (let r = rackFrom; r <= rackTo; r++) {
    for (let l = levelFrom; l <= levelTo; l++) {
      codes.push(`${zone}-${String(r).padStart(rackW, "0")}-${String(l).padStart(levelW, "0")}`);
    }
  }
  return { codes, kind, zone };
}

/** Girdinin kısa parmak izi (aynı anahtar + farklı girdi ayrımı için). */
function specDigest(warehouseId: string, parentId: string | null, plan: BulkPlan): string {
  const first = plan.codes[0] ?? "";
  const last = plan.codes[plan.codes.length - 1] ?? "";
  return createHash("sha256").update(JSON.stringify([warehouseId, parentId, plan.kind, plan.codes.length, first, last])).digest("hex").slice(0, 32);
}

export interface BulkPreview {
  readonly count: number;
  readonly first: string;
  readonly last: string;
  /** İlk birkaç kod (önizleme örneği). */
  readonly sample: readonly string[];
  /** Depoda zaten bulunan kodlar (en çok {@link CONFLICT_LIST_MAX}); doluysa oluşturma reddedilir. */
  readonly conflicts: readonly string[];
  readonly conflictCount: number;
  readonly max: number;
}

async function loadTarget(tx: AccessTx, tenantId: string, warehouseId: string, parentId: string | null): Promise<number> {
  const wh = await tx.execute<{ status: string }>(
    sql`SELECT status FROM public.warehouses WHERE tenant_id = ${tenantId}::uuid AND id = ${warehouseId}::uuid FOR SHARE`,
  );
  if (wh[0] === undefined) throw new AppError("NOT_FOUND");
  if (wh[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
  let parentDepth: number | null = null;
  if (parentId !== null) {
    const p = await tx.execute<{ depth: number | string; status: string }>(
      sql`SELECT depth, status FROM public.locations
           WHERE tenant_id = ${tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND id = ${parentId}::uuid
           FOR SHARE`,
    );
    const parent = p[0];
    if (parent === undefined || parent.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED", { detail: "PARENT_INVALID" });
    parentDepth = Number(parent.depth);
  }
  return childDepth(parentDepth);
}

async function findConflicts(tx: AccessTx, tenantId: string, warehouseId: string, codes: readonly string[]): Promise<{ list: string[]; count: number }> {
  // Kodlar `[A-Z0-9-]` ile sınırlıdır (planBulkLocations) → dizi sabit değeri güvenli.
  const arr = `{${codes.join(",")}}`;
  const rows = await tx.execute<{ code: string }>(
    sql`SELECT code FROM public.locations
         WHERE tenant_id = ${tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND code = ANY(${arr}::text[])
         ORDER BY code COLLATE "C"`,
  );
  return { list: rows.slice(0, CONFLICT_LIST_MAX).map((r) => r.code), count: rows.length };
}

/**
 * İdempotency araması (T-259 MINOR-5): toplu komutun audit satırı `entity_type = 'location_batch'`, `entity_id` = idempotency anahtarı.
 * `entity_id = anahtar` (texteq: leakproof) 0021 kısmi indeksini (`audit_logs_tenant_bulk_ref_idx`) RLS altında da kullanır; eski
 * `change_summary->>'bulk_ref'` koşulu (jsonb işlevleri leakproof değil) wms_app planında seq scan'e düşerdi. Test aynı SQL'i EXPLAIN eder.
 */
export function bulkRefLookupSql(tenantId: string, key: string): SQL {
  return sql`SELECT change_summary->>'spec_fp' AS spec_fp, change_summary->>'created' AS created
            FROM public.audit_logs
           WHERE tenant_id = ${tenantId}::uuid AND entity_type = 'location_batch' AND entity_id = ${key}
             AND action = 'location.created'
             AND occurred_at > now() - make_interval(days => ${IDEMPOTENCY_WINDOW_DAYS}::int)
           LIMIT 1`;
}

function parentOf(spec: BulkLocationsSpec): string | null {
  return spec.parentId === undefined || spec.parentId === null ? null : parseUuid(spec.parentId);
}

/** Salt okuma önizleme: kaç lokasyon, örnek kodlar ve mevcut kodlarla çakışmalar. Yazma yok. */
export async function previewBulkLocations(params: WarehouseCallParams, spec: BulkLocationsSpec): Promise<BulkPreview> {
  const warehouseId = parseUuid(spec.warehouseId);
  const parentId = parentOf(spec);
  const plan = planBulkLocations(spec);
  return runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, m) => {
    await assertWarehouseVisible(tx, m, [warehouseId]);
    const wh = await tx.execute<{ status: string }>(
      sql`SELECT status FROM public.warehouses WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid`,
    );
    if (wh[0] === undefined) throw new AppError("NOT_FOUND");
    if (wh[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    if (parentId !== null) {
      const p = await tx.execute<{ depth: number | string; status: string }>(
        sql`SELECT depth, status FROM public.locations WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND id = ${parentId}::uuid`,
      );
      if (p[0] === undefined || p[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED", { detail: "PARENT_INVALID" });
      childDepth(Number(p[0].depth));
    }
    await assertWarehouseCapacity(tx, m.tenantId, warehouseId, plan.codes.length, false);
    const conflicts = await findConflicts(tx, m.tenantId, warehouseId, plan.codes);
    return {
      count: plan.codes.length,
      first: plan.codes[0] as string,
      last: plan.codes[plan.codes.length - 1] as string,
      sample: plan.codes.slice(0, PREVIEW_SAMPLE),
      conflicts: conflicts.list,
      conflictCount: conflicts.count,
      max: BULK_LOCATIONS_MAX,
    };
  });
}

export interface CreateBulkLocationsInput extends BulkLocationsSpec {
  /** İstemcinin ürettiği UUID; aynı anahtarla yeniden gönderim yeni kayıt üretmez. */
  readonly idempotencyKey: string;
  readonly requestId?: string | null;
}

export interface BulkCreateResult {
  readonly created: number;
  readonly first: string;
  readonly last: string;
  /** `true`: bu anahtarla önceden tamamlanmış komutun sonucu (yeni yazım yok). */
  readonly replayed: boolean;
}

export async function createBulkLocations(params: WarehouseCallParams, input: CreateBulkLocationsInput): Promise<BulkCreateResult> {
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "") {
    throw new AppError("VALIDATION_FAILED", { detail: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  if (!UUID_RE.test(input.idempotencyKey)) throw new AppError("VALIDATION_FAILED");
  const key = input.idempotencyKey.toLowerCase();
  const warehouseId = parseUuid(input.warehouseId);
  const parentId = parentOf(input);
  const plan = planBulkLocations(input);
  const fp = specDigest(warehouseId, parentId, plan);
  const first = plan.codes[0] as string;
  const last = plan.codes[plan.codes.length - 1] as string;

  return runTenantCommand({ ...params, permission: "settings.manage" }, async (tx, m) => {
    await assertWarehouseVisible(tx, m, [warehouseId]);
    // Aynı anahtarın eşzamanlı iki isteği burada serileşir; ikincisi birincinin audit satırını görür.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${m.tenantId}:bulk-locations:${key}`}, 0))`);
    const prior = await tx.execute<{ spec_fp: string | null; created: string | null }>(bulkRefLookupSql(m.tenantId, key));
    if (prior[0] !== undefined) {
      if (prior[0].spec_fp !== fp) throw new AppError("IDEMPOTENCY_MISMATCH");
      return { created: Number(prior[0].created ?? plan.codes.length), first, last, replayed: true };
    }

    const depth = await loadTarget(tx, m.tenantId, warehouseId, parentId);
    await assertWarehouseCapacity(tx, m.tenantId, warehouseId, plan.codes.length, true);
    const conflicts = await findConflicts(tx, m.tenantId, warehouseId, plan.codes);
    if (conflicts.count > 0) throw codeTaken();

    const arr = `{${plan.codes.join(",")}}`;
    const ins = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
          SELECT ${m.tenantId}::uuid, gen_random_uuid(), ${warehouseId}::uuid, ${parentId}::uuid, c, c, ${depth}, ${plan.kind}
            FROM unnest(${arr}::text[]) AS c
          ON CONFLICT ON CONSTRAINT locations_tenant_warehouse_code_key DO NOTHING
          RETURNING id`,
    );
    // Eşzamanlı başka yazım araya girdiyse (kısıt) hepsi geri alınır: kısmi sonuç yok.
    if (ins.length !== plan.codes.length) throw codeTaken();
    const ids = ins.map((r) => r.id);
    if ((await countLockRowsExisting(tx, m.tenantId, ids.map(parseUuid))) !== ids.length) throw new AppError("COUNT_LOCK_ROW_MISSING");
    await appendAudit(tx, {
      action: "location.created",
      actorUserId: m.userId,
      entityType: "location_batch",
      entityId: key, // idempotency anahtarı = toplu komutun kimliği (arama indeksi için, bkz. bulkRefLookupSql)
      requestId: input.requestId ?? null,
      changeSummary: {
        warehouse_id: warehouseId,
        parent_id: parentId,
        depth,
        kind: plan.kind,
        created: ids.length,
        first_loc: first,
        last_loc: last,
        bulk_ref: key,
        spec_fp: fp,
      },
    });
    return { created: ids.length, first, last, replayed: false };
  });
}
