// Kolay kurulum okuyucuları (T-250): boş ekran rehberi ilerlemesi ve lokasyon seçici araması. Yalnızca SELECT (kilit/yazma yok).
// Okuma izni `stock.view`; depo kapsamı (`resolveWarehouseScope`) uygulanır: kapsam dışı depo ve lokasyon sonuçta yoktur.
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery } from "../identity/access.ts";
import { parseUuid, type WarehouseCallParams } from "./warehouses.ts";
import { assertWarehouseVisible, pgUuidArray, resolveWarehouseScope } from "./scope.ts";

export interface SetupProgress {
  /** En az bir aktif depo (kapsamdaki). */
  readonly hasWarehouse: boolean;
  /** Kapsamdaki aktif depolarda en az bir aktif lokasyon. */
  readonly hasLocation: boolean;
  /** En az bir ürün kartı (arşivli dahil değil: yalnızca aktif). */
  readonly hasItem: boolean;
  /** Rafı henüz olmayan ilk aktif depo (yoksa ilk aktif depo); adım 2 bu depoya götürür. */
  readonly nextWarehouseId: string | null;
}

export async function getSetupProgress(params: WarehouseCallParams): Promise<SetupProgress> {
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const scoped = sql`(${scope === null}::boolean OR w.id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))`;
    const whs = await tx.execute<{ id: string; has_loc: boolean }>(
      sql`SELECT w.id,
                 EXISTS (SELECT 1 FROM public.locations l WHERE l.tenant_id = w.tenant_id AND l.warehouse_id = w.id AND l.status = 'ACTIVE') AS has_loc
            FROM public.warehouses w
           WHERE w.tenant_id = ${m.tenantId}::uuid AND w.status = 'ACTIVE' AND ${scoped}
           ORDER BY has_loc, w.code COLLATE "C", w.id
           LIMIT 50`,
    );
    const item = await tx.execute<{ x: number }>(
      sql`SELECT 1 AS x FROM public.items WHERE tenant_id = ${m.tenantId}::uuid AND status = 'ACTIVE' LIMIT 1`,
    );
    return {
      hasWarehouse: whs.length > 0,
      hasLocation: whs.some((w) => w.has_loc),
      hasItem: item[0] !== undefined,
      nextWarehouseId: whs[0]?.id ?? null,
    };
  });
}

export const LOCATION_SEARCH_MAX = 20;

export interface LocationSuggestion {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly depth: number;
}

export interface SearchLocationsInput {
  readonly warehouseId: string;
  readonly q: string;
  readonly limit?: number;
}

/**
 * Yazdıkça arama: kod ya da adın ÖN eki (büyük/küçük harf duyarsız; joker yok) + kod tam eşleşmesi (barkod okutma: lokasyon etiketi koddur).
 * Yalnızca aktif lokasyonlar; sıra `(kod, id)`; sonuç `limit` ile sınırlı. Kapsam dışı/yok depo `NOT_FOUND`.
 */
export async function searchLocations(params: WarehouseCallParams, input: SearchLocationsInput): Promise<readonly LocationSuggestion[]> {
  const warehouseId = parseUuid(input.warehouseId);
  if (typeof input.q !== "string") throw new AppError("VALIDATION_FAILED");
  const q = input.q.trim();
  if (Array.from(q).length > 128) throw new AppError("VALIDATION_FAILED");
  const limit = input.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > LOCATION_SEARCH_MAX) throw new AppError("VALIDATION_FAILED");
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const wh = await tx.execute<{ id: string }>(sql`SELECT id FROM public.warehouses WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid`);
    if (wh[0] === undefined) throw new AppError("NOT_FOUND");
    await assertWarehouseVisible(tx, m, [warehouseId]);
    const rows = await tx.execute<{ id: string; code: string; name: string; depth: number | string }>(
      sql`SELECT id, code, name, depth FROM public.locations
           WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND status = 'ACTIVE'
             AND (${q === ""}::boolean OR starts_with(lower(code), lower(${q})) OR starts_with(lower(name), lower(${q})))
           ORDER BY code COLLATE "C", id
           LIMIT ${limit}`,
    );
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, depth: Number(r.depth) }));
  });
}
