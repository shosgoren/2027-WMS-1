// Stok tutarlılık denetimi: SALT OKUNUR karşılaştırma (T-225; ADR-019 §8, AC-21, I-04, I-14).
//
// Bu dosya stok tablolarına YAZMAZ ve kilit almaz (T-210 lint izinli dosyalarında değildir); yalnızca SELECT çalıştırır. Her parça
// çağıranın verdiği AYRI kısa transaction'dadır (çağıran tenant bağlamı + tenant satırı kilidinden sonra `setLocalReadOnly` uygular).
// Her parça TEK SQL ifadesidir: bakiye ⋈ Σ defter ⋈ Σ ACTIVE rezervasyon aynı ifadede → aynı anlık görüntü (yük altında yanlış alarm yok).
// Denetimler: (a) Σ defter = `quantity`, (b) Σ ACTIVE rezervasyon = `reserved_quantity`, (c) her lokasyonun bir `location_count_locks` satırı,
// (d) seri başına pozitif bakiyeli boyut ≤ 1. Bulgu yalnızca kimlik + denetim türüdür (kişisel veri/miktar yok).
import { sql } from "drizzle-orm";
import type { AccessTx } from "../identity/access.ts";

/** Parça boyutu (≤ 1.000 boyut/lokasyon/seri, ADR-019 §8). */
export const CONSISTENCY_CHUNK_SIZE = 1000;
/** `stock_consistency_runs.findings` içindeki en çok bulgu; toplam `mismatch_count`'tadır. */
export const CONSISTENCY_FINDINGS_MAX = 100;

export type ConsistencyCheck = "a" | "b" | "c" | "d";

export interface ConsistencyFinding {
  readonly check: ConsistencyCheck;
  /** a, b: `stock_dimension_id`; c: `location_id`; d: `serial_key`. */
  readonly id: string;
}

export interface ChunkResult {
  /** Bu parçada denetlenen öğe sayısı (0 → anahtar kümesi bitti). */
  readonly checked: number;
  /** Sonraki parça için `after` (checked = 0 ise null). */
  readonly last: string | null;
  readonly mismatchesByCheck: Readonly<Partial<Record<ConsistencyCheck, number>>>;
  /** Parçadaki ilk bulgular (≤ CONSISTENCY_FINDINGS_MAX). */
  readonly samples: readonly ConsistencyFinding[];
}

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

type DimRow = {
  checked: number | string;
  last: string | null;
  qty_bad: number | string;
  res_bad: number | string;
  qty_ids: string[] | null;
  res_ids: string[] | null;
};

/** (a) + (b): boyut anahtarı `after`'dan sonraki ≤ `limit` boyut; tek ifade. Eksik bakiye satırı 0 sayılır (defter/rezervasyon ≠ 0 ise fark). */
export async function checkDimensionChunk(tx: Pick<AccessTx, "execute">, tenantId: string, after: string, limit = CONSISTENCY_CHUNK_SIZE): Promise<ChunkResult> {
  const rows = await tx.execute<DimRow>(
    sql`WITH d AS (
          SELECT id FROM public.stock_dimensions WHERE tenant_id = ${tenantId}::uuid AND id > ${after}::uuid ORDER BY id LIMIT ${limit}::int
        ), l AS (
          SELECT stock_dimension_id, pg_catalog.sum(quantity) AS s FROM public.stock_ledger
           WHERE tenant_id = ${tenantId}::uuid AND stock_dimension_id IN (SELECT id FROM d) GROUP BY stock_dimension_id
        ), r AS (
          SELECT stock_dimension_id, pg_catalog.sum(quantity) AS s FROM public.reservations
           WHERE tenant_id = ${tenantId}::uuid AND status = 'ACTIVE' AND stock_dimension_id IN (SELECT id FROM d) GROUP BY stock_dimension_id
        ), x AS (
          SELECT d.id,
                 COALESCE(b.quantity, 0) <> COALESCE(l.s, 0) AS qty_bad,
                 COALESCE(b.reserved_quantity, 0) <> COALESCE(r.s, 0) AS res_bad
            FROM d
            LEFT JOIN public.stock_balances b ON b.tenant_id = ${tenantId}::uuid AND b.stock_dimension_id = d.id
            LEFT JOIN l ON l.stock_dimension_id = d.id
            LEFT JOIN r ON r.stock_dimension_id = d.id
        )
        SELECT pg_catalog.count(*)::int AS checked,
               (pg_catalog.array_agg(id::text ORDER BY id DESC))[1] AS last,
               pg_catalog.count(*) FILTER (WHERE qty_bad)::int AS qty_bad,
               pg_catalog.count(*) FILTER (WHERE res_bad)::int AS res_bad,
               (pg_catalog.array_agg(id::text ORDER BY id) FILTER (WHERE qty_bad))[1:${CONSISTENCY_FINDINGS_MAX}::int] AS qty_ids,
               (pg_catalog.array_agg(id::text ORDER BY id) FILTER (WHERE res_bad))[1:${CONSISTENCY_FINDINGS_MAX}::int] AS res_ids
          FROM x`,
  );
  const r = rows[0];
  if (r === undefined) throw new Error("consistency chunk returned no row");
  return {
    checked: Number(r.checked),
    last: r.last,
    mismatchesByCheck: { a: Number(r.qty_bad), b: Number(r.res_bad) },
    samples: [...(r.qty_ids ?? []).map((id) => ({ check: "a" as const, id })), ...(r.res_ids ?? []).map((id) => ({ check: "b" as const, id }))],
  };
}

type LockRow = { checked: number | string; last: string | null; bad: number | string; ids: string[] | null };

/** (c): lokasyon anahtarı `after`'dan sonraki ≤ `limit` lokasyon; kilit satırı eksik olanlar. Tek ifade. */
export async function checkLocationLockChunk(tx: Pick<AccessTx, "execute">, tenantId: string, after: string, limit = CONSISTENCY_CHUNK_SIZE): Promise<ChunkResult> {
  const rows = await tx.execute<LockRow>(
    sql`WITH loc AS (
          SELECT id FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id > ${after}::uuid ORDER BY id LIMIT ${limit}::int
        ), x AS (
          SELECT loc.id, (c.location_id IS NULL) AS bad
            FROM loc LEFT JOIN public.location_count_locks c ON c.tenant_id = ${tenantId}::uuid AND c.location_id = loc.id
        )
        SELECT pg_catalog.count(*)::int AS checked,
               (pg_catalog.array_agg(id::text ORDER BY id DESC))[1] AS last,
               pg_catalog.count(*) FILTER (WHERE bad)::int AS bad,
               (pg_catalog.array_agg(id::text ORDER BY id) FILTER (WHERE bad))[1:${CONSISTENCY_FINDINGS_MAX}::int] AS ids
          FROM x`,
  );
  const r = rows[0];
  if (r === undefined) throw new Error("consistency chunk returned no row");
  return {
    checked: Number(r.checked),
    last: r.last,
    mismatchesByCheck: { c: Number(r.bad) },
    samples: (r.ids ?? []).map((id) => ({ check: "c" as const, id })),
  };
}

type SerialRow = { serial_key: string };

/**
 * (d): pozitif bakiyeli birden çok boyutu olan seriler, `serial_key > after` sırasıyla ≤ `limit` seri. Tek ifade. `checked` = bulunan ihlalli seri sayısı
 * (sağlam seri anahtarları listelenmez); `checked < limit` → küme bitti.
 */
export async function checkSerialChunk(tx: Pick<AccessTx, "execute">, tenantId: string, after: string, limit = CONSISTENCY_CHUNK_SIZE): Promise<ChunkResult> {
  const rows = await tx.execute<SerialRow>(
    sql`SELECT serial_key::text AS serial_key FROM public.stock_balances
         WHERE tenant_id = ${tenantId}::uuid AND quantity > 0 AND serial_key <> ${NIL_UUID}::uuid AND serial_key > ${after}::uuid
         GROUP BY serial_key HAVING pg_catalog.count(*) > 1
         ORDER BY serial_key LIMIT ${limit}::int`,
  );
  const ids = rows.map((r) => r.serial_key);
  return {
    checked: ids.length,
    last: ids.length === 0 ? null : (ids[ids.length - 1] as string),
    mismatchesByCheck: { d: ids.length },
    samples: ids.slice(0, CONSISTENCY_FINDINGS_MAX).map((id) => ({ check: "d" as const, id })),
  };
}

export interface ConsistencyReport {
  /** Denetlenen boyut sayısı (a/b parçalarının toplamı). */
  readonly checkedDimensions: number;
  readonly mismatchCount: number;
  readonly findings: readonly ConsistencyFinding[];
}

/** Parça sonuçlarını toplar: bulgular ilk `CONSISTENCY_FINDINGS_MAX` ile sınırlıdır; sayı toplamdır. */
export class ConsistencyAccumulator {
  private dims = 0;
  private total = 0;
  private readonly found: ConsistencyFinding[] = [];

  add(check: "dimensions" | "locks" | "serials", r: ChunkResult): void {
    if (check === "dimensions") this.dims += r.checked;
    for (const n of Object.values(r.mismatchesByCheck)) this.total += n ?? 0;
    for (const s of r.samples) if (this.found.length < CONSISTENCY_FINDINGS_MAX) this.found.push(s);
  }

  report(): ConsistencyReport {
    return { checkedDimensions: this.dims, mismatchCount: this.total, findings: this.found };
  }
}
