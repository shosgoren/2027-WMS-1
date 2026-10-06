// Etiket alanı (T-312, ADR-022): Code 128 kodlayıcı + ZPL/SVG şablonları + etiket kaynağı okuma. Stok yazmaz.
// `loadLabelSource` yalnızca mevcut tenant kapsamlı okumaları (`stock.view`, RLS) kullanır: başka tenant'ın ya da olmayan kaynak
// `NOT_FOUND` (aynı yanıt); `stock.view` yoksa `FORBIDDEN`.
import { getItem, listItemBarcodes } from "../catalog/index.ts";
import { listUnits } from "../catalog/units.ts";
import { getLocationTree, type LocationRow } from "../warehouse/index.ts";
import { AppError } from "@wms/shared/errors";
import type { LabelData, LabelTemplate } from "./templates.ts";

export * from "./code128.ts";
export * from "./templates.ts";

type Params = Parameters<typeof listUnits>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TREE_PAGE = 200;
const TREE_MAX_PAGES = 20;

export interface LabelSourceQuery {
  readonly itemId?: string | undefined;
  readonly warehouseId?: string | undefined;
  readonly locationId?: string | undefined;
  /** `locationId` ile birlikte: kök ve tüm alt lokasyonlar. */
  readonly subtree?: boolean | undefined;
}
export interface LabelSource {
  readonly template: LabelTemplate;
  readonly datas: readonly LabelData[];
  /** Dosya adı için güvenli olmayan ham ad; çağıran temizler. */
  readonly name: string;
}

/**
 * Kaynak seçimi (A-T312-5): `itemId` ya da `warehouseId` [+ `locationId` [+ `subtree`]] (kök yoksa depodaki tüm lokasyonlar).
 * Hiçbiri verilmediyse `null`. Geçersiz kimlik `NOT_FOUND` (varlık sızdırılmaz).
 */
export async function loadLabelSource(params: Params, q: LabelSourceQuery): Promise<LabelSource | null> {
  const { itemId, warehouseId, locationId } = q;
  if (itemId !== undefined) {
    if (!UUID_RE.test(itemId)) throw new AppError("NOT_FOUND");
    const item = await getItem(params, { itemId });
    const [barcodes, units] = await Promise.all([listItemBarcodes(params, item.id), listUnits(params)]);
    const base = units.find((u) => u.id === item.baseUnitId);
    // Birincil barkod (A-T312-6): temel birimde, okutma başına 1 olan ilk barkod; yoksa ilk barkod; hiç yoksa ürün kodu basılır.
    const primary = barcodes.find((b) => b.unitId === item.baseUnitId && b.quantity === "1") ?? barcodes[0];
    return { template: "product", name: `urun-${item.code}`, datas: [{ code: item.code, name: item.name, unit: base?.code ?? "", barcode: primary?.barcode ?? null }] };
  }
  if (warehouseId === undefined) return null;
  if (!UUID_RE.test(warehouseId) || (locationId !== undefined && !UUID_RE.test(locationId))) throw new AppError("NOT_FOUND");
  const all: LocationRow[] = [];
  let after: { depth: number; code: string; id: string } | undefined;
  for (let p = 0; p < TREE_MAX_PAGES; p++) {
    const page = await getLocationTree(params, { warehouseId, limit: TREE_PAGE, ...(after === undefined ? {} : { after }) });
    all.push(...page.items);
    if (page.next === null) break;
    after = page.next;
  }
  let chosen: readonly LocationRow[] = all;
  if (locationId !== undefined) {
    const root = all.find((l) => l.id === locationId);
    if (root === undefined) throw new AppError("NOT_FOUND");
    if (q.subtree === true) {
      const ids = new Set([root.id]);
      // Ağaç derinlik sıralıdır: ebeveyn her zaman çocuktan önce gelir.
      chosen = all.filter((l) => {
        if (l.id === root.id) return true;
        if (l.parentId !== null && ids.has(l.parentId)) {
          ids.add(l.id);
          return true;
        }
        return false;
      });
    } else chosen = [root];
  }
  if (chosen.length === 0) throw new AppError("NOT_FOUND");
  return { template: "location", name: `lokasyon-${chosen[0]?.code ?? "etiket"}`, datas: chosen.map((l) => ({ code: l.code, name: l.name })) };
}
