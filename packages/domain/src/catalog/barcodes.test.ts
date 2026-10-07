// resolveBarcode birim testi (T-287a; K-1): `unitFactor` / `baseQuantity` tek doğruluk kaynağı. DB yok: `tx.execute` sahte satır döndürür;
// SQL ve RLS davranışı tests/integration/catalog/catalog-commands.int.test.ts'te gerçek PostgreSQL ile sınanır.
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";
import { resolveBarcode } from "./barcodes.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const ADET = "33333333-3333-4333-8333-333333333333";
const KOLI = "44444444-4444-4444-8444-444444444444";

type Row = { item_id: string; item_code: string; item_name: string; unit_id: string; unit_code: string; quantity: string | null; base_unit_id: string; quantity_scale: number; factor: string | null };
const row = (o: Partial<Row>): Row => ({
  item_id: ITEM,
  item_code: "KRT-1",
  item_name: "Karton",
  unit_id: ADET,
  unit_code: "ADET",
  quantity: null,
  base_unit_id: ADET,
  quantity_scale: 0,
  factor: null,
  ...o,
});
const txOf = (rows: readonly Row[]): AccessTx => ({ execute: async () => rows }) as unknown as AccessTx;
// Düz metin barkod (GS1 değil): yalnızca tam eşleşme sorgusu çalışır.
const CODE = "ABC-1";

async function failure(rows: readonly Row[]): Promise<string> {
  try {
    await resolveBarcode(txOf(rows), TENANT, CODE);
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return `${(e as AppError).code}/${(e as AppError).detail ?? ""}`;
  }
  return "çözüldü";
}

describe("resolveBarcode: unitFactor ve baseQuantity (K-1)", () => {
  it("temel birim barkodu: katsayı 1; okutma başına miktar temel birimdir (12'li poşet)", async () => {
    expect(await resolveBarcode(txOf([row({})]), TENANT, CODE)).toEqual({ itemId: ITEM, unitId: ADET, quantity: "1", unitFactor: "1", baseQuantity: "1" });
    expect(await resolveBarcode(txOf([row({ quantity: "12.000000" })]), TENANT, CODE)).toMatchObject({ quantity: "12", unitFactor: "1", baseQuantity: "12" });
  });

  it("koli barkodu: adet unit_conversions katsayısından gelir", async () => {
    const r = await resolveBarcode(txOf([row({ unit_id: KOLI, unit_code: "KOLI", factor: "12.000000" })]), TENANT, CODE);
    expect(r).toEqual({ itemId: ITEM, unitId: KOLI, quantity: "1", unitFactor: "12", baseQuantity: "12" });
  });

  it("barkodda miktar 1 yazılı koli (1.000000) kabul; miktar ≠ 1 kapalı başarısız (çifte sayım olmaz)", async () => {
    expect(await resolveBarcode(txOf([row({ unit_id: KOLI, quantity: "1.000000", factor: "6" })]), TENANT, CODE)).toMatchObject({ baseQuantity: "6" });
    expect(await failure([row({ unit_id: KOLI, quantity: "12.000000", factor: "12" })])).toBe("VALIDATION_FAILED/UNIT_CONVERSION_INVALID");
  });

  it("dönüşümü olmayan koli birimi UNIT_CONVERSION_INVALID", async () => {
    expect(await failure([row({ unit_id: KOLI, factor: null })])).toBe("VALIDATION_FAILED/UNIT_CONVERSION_INVALID");
  });

  it("ürün ölçeğini aşan sonuç yuvarlanmaz: 0.5 katsayılı birim ölçek 0'da QUANTITY_SCALE; ölçek 1'de tam", async () => {
    const half = { unit_id: KOLI, factor: "0.500000" };
    expect(await failure([row({ ...half, quantity_scale: 0 })])).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(await resolveBarcode(txOf([row({ ...half, quantity_scale: 1 })]), TENANT, CODE)).toMatchObject({ unitFactor: "0.5", baseQuantity: "0.5" });
  });

  it("temel birim barkodunda ürün ölçeğini aşan miktar QUANTITY_SCALE", async () => {
    expect(await failure([row({ quantity: "1.500000", quantity_scale: 0 })])).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
  });
});
