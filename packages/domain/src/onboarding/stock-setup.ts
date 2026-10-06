// Sektör şablonu Faz 2 adımları (T-223; A-47, A-78): `units.applied` (T-208 `createUnit`) ve `locations.applied`
// (T-205 `createWarehouse`/`createLocation`). Stok DEĞİŞTİRMEZ (G-01): yalnızca katalog/depo kartı komutları çağrılır.
//
// İdempotans: var olan kod (`VALIDATION_FAILED`/`CODE_TAKEN`) o kaydın zaten uygulandığı anlamına gelir; ikinci çağrıda
// yeni satır ve yeni `unit.created`/`warehouse.created`/`location.created` audit'i oluşmaz. Her komut kendi transaction'ındadır
// (T-205/T-208 komutları `runTenantCommand`), bu yüzden yarıda kesilen adım yeniden çağrıda kalan kayıtları tamamlar.
// Adım audit'i (`onboarding.step_completed`) bu dosyada değil, `continueOnboarding`'de adım DONE yazılırken tekil atılır.
//
// A-223-2: kullanıcı D1 depoyu ARŞİVLEDİYSE `locations.applied` zaten uygulanmış sayılır (arşivli depoya lokasyon eklenemez;
// kullanıcının kararı ezilmez). A-223-3: mevcut `KABUL`/`SEVK` kodu başka türde olsa da dokunulmaz (kullanıcı değişikliği ezilmez).
import { AppError } from "@wms/shared/errors";
import type { CatalogCommandParams } from "../catalog/units.ts";
import { createUnit } from "../catalog/units.ts";
import { createLocation, createWarehouse, listWarehouses, normalizeCode, type WarehouseCallParams } from "../warehouse/index.ts";
import type { SectorTemplate } from "./templates.ts";

export type SetupCallParams = WarehouseCallParams & Pick<CatalogCommandParams, "requestId">;

export function isCodeTaken(e: unknown): boolean {
  return e instanceof AppError && e.code === "VALIDATION_FAILED" && e.detail === "CODE_TAKEN";
}

function setupOf(template: SectorTemplate): NonNullable<SectorTemplate["setup"]> {
  if (template.setup === undefined) throw new AppError("INTERNAL"); // Faz 2 adımı olmayan şablonda çağrılamaz
  return template.setup;
}

/** `units.applied`: şablon birimleri (temel birim ilk); katsayı yok (A-32). Yeni oluşturulan kodları döndürür. */
export async function applyUnitsStep(params: SetupCallParams, template: SectorTemplate): Promise<{ readonly created: readonly string[] }> {
  const setup = setupOf(template);
  const created: string[] = [];
  for (const u of setup.units) {
    try {
      await createUnit(params, u);
      created.push(u.code);
    } catch (e) {
      if (!isCodeTaken(e)) throw e;
    }
  }
  return { created };
}

/** Depo kimliği: yoksa oluşturur; varsa (arşivli dahil) mevcut kimliği ve durumunu döndürür. */
async function ensureWarehouse(
  params: SetupCallParams,
  w: { readonly code: string; readonly name: string },
): Promise<{ readonly id: string; readonly archived: boolean; readonly created: boolean }> {
  try {
    const r = await createWarehouse(params, w);
    return { id: r.warehouseId, archived: false, created: true };
  } catch (e) {
    if (!isCodeTaken(e)) throw e;
  }
  const code = normalizeCode(w.code);
  const page = await listWarehouses(params, { includeArchived: true });
  const hit = page.items.find((x) => x.code === code);
  if (hit === undefined) throw new AppError("INTERNAL"); // CODE_TAKEN ama görünmüyor: depo kapsamı dışı (beklenmez)
  return { id: hit.id, archived: hit.status === "ARCHIVED", created: false };
}

/** `locations.applied`: Ana Depo (`D1`) + `KABUL` (RECEIVING) + `SEVK` (STAGING) (A-78). Yeni oluşturulan kodları döndürür. */
export async function applyLocationsStep(
  params: SetupCallParams,
  template: SectorTemplate,
): Promise<{ readonly warehouseId: string; readonly created: readonly string[] }> {
  const setup = setupOf(template);
  const wh = await ensureWarehouse(params, setup.warehouse);
  const created: string[] = [];
  if (wh.created) created.push(setup.warehouse.code);
  if (wh.archived) return { warehouseId: wh.id, created }; // A-223-2
  for (const l of setup.locations) {
    try {
      await createLocation(params, { warehouseId: wh.id, parentId: null, code: l.code, name: l.name, kind: l.kind });
      created.push(l.code);
    } catch (e) {
      if (!isCodeTaken(e)) throw e;
    }
  }
  return { warehouseId: wh.id, created };
}
