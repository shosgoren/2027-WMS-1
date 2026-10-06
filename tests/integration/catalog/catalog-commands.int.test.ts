// T-208: katalog komutları (birim, ürün, dönüşüm, barkod, çözümleme). Gerçek wms_app bağlantısı + RLS; fikstürler sentetik (G-09).
// Migration rolü yalnızca kurulum/doğrulama/temizlik içindir. Audit append-only: audit yazan tenant'lar kısa ömürlü ortamda kalır.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { addBarcode, BarcodeAmbiguousError, removeBarcode, resolveBarcodeQuery } from "../../../packages/domain/src/catalog/barcodes.ts";
import { archiveItem, createItem, getItem, listItems, updateItem } from "../../../packages/domain/src/catalog/items.ts";
import { createUnit, listUnits, renameUnit, setUnitConversion } from "../../../packages/domain/src/catalog/units.ts";
import { GS } from "../../../packages/domain/src/catalog/gs1.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const rnd = (): string => randomBytes(4).toString("hex");

let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
  A = await seedWorld(adm, reg, "A");
  B = await seedWorld(adm, reg, "B");
}, 120_000);

afterAll(async () => {
  // Audit append-only (audit_logs → tenants FK): audit yazan tenant'lar silinemez; kısa ömürlü test veritabanında kalır
  // (memberships.int.test.ts ile aynı politika). Bu yüzden cleanupRegistry çağrılmaz.
  await adm.end();
  await app.close();
}, 120_000);

const admin = (w: TenantWorld) => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug });
const picker = (w: TenantWorld) => ({ db: app, principal: { userId: w.memberUserId, mfaVerified: true }, tenantSlug: w.slug });

async function fail(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}
const expectFail = async (p: Promise<unknown>, code: string, detail?: string): Promise<AppError> => {
  const e = await fail(p);
  expect(e.code).toBe(code);
  expect(e.detail).toBe(detail);
  return e;
};
async function auditCount(tenant: string, action: string): Promise<number> {
  const r = await adm.query("SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = $2", [tenant, action]);
  return (r.rows[0] as { n: number }).n;
}

describe("birim", () => {
  it("createUnit/renameUnit/listUnits; kod tekrarı CODE_TAKEN; audit yazılır", async () => {
    const code = `U${rnd()}`;
    const { unitId } = await createUnit(admin(A), { code, name: "Test birimi" });
    await expectFail(createUnit(admin(A), { code, name: "Başka" }), "VALIDATION_FAILED", "CODE_TAKEN");
    expect(await renameUnit(admin(A), { unitId, name: "Yeni ad" })).toEqual({ unitId, changed: true });
    expect(await renameUnit(admin(A), { unitId, name: "Yeni ad" })).toEqual({ unitId, changed: false });
    const list = await listUnits(picker(A)); // okuma stock.view
    expect(list.find((u) => u.id === unitId)).toMatchObject({ code, name: "Yeni ad", status: "ACTIVE" });
    expect(await auditCount(A.tenantId, "unit.created")).toBeGreaterThanOrEqual(1);
    expect(await auditCount(A.tenantId, "unit.updated")).toBeGreaterThanOrEqual(1);
    // Aynı kod başka tenant'ta serbest.
    await createUnit(admin(B), { code, name: "B birimi" });
  });
  it("PICKER yazma → FORBIDDEN; başka tenant birimi yeniden adlandırılamaz → NOT_FOUND", async () => {
    await expectFail(createUnit(picker(A), { code: `P${rnd()}`, name: "x" }), "FORBIDDEN");
    await expectFail(renameUnit(picker(A), { unitId: A.unitId, name: "x" }), "FORBIDDEN");
    await expectFail(renameUnit(admin(A), { unitId: B.unitId, name: "x" }), "NOT_FOUND");
  });
  it("geçersiz girdi VALIDATION_FAILED", async () => {
    await expectFail(createUnit(admin(A), { code: "  ", name: "x" }), "VALIDATION_FAILED");
    await expectFail(createUnit(admin(A), { code: "ok", name: "x\u0000y" }), "VALIDATION_FAILED");
    await expectFail(renameUnit(admin(A), { unitId: "not-a-uuid", name: "x" }), "VALIDATION_FAILED");
  });
});

describe("ürün", () => {
  it("createItem varsayılanları (NONE, ölçek 0, FIFO); kod tekrarı; olmayan/başka tenant birimi NOT_FOUND", async () => {
    const code = `I${rnd()}`;
    const { itemId } = await createItem(admin(A), { code, name: "Ürün", baseUnitId: A.unitId });
    expect(await getItem(picker(A), { itemId })).toMatchObject({ code, trackingMode: "NONE", quantityScale: 0, pickPolicy: "FIFO", status: "ACTIVE", baseUnitId: A.unitId });
    await expectFail(createItem(admin(A), { code, name: "x", baseUnitId: A.unitId }), "VALIDATION_FAILED", "CODE_TAKEN");
    await expectFail(createItem(admin(A), { code: `I${rnd()}`, name: "x", baseUnitId: B.unitId }), "NOT_FOUND");
    await expectFail(createItem(picker(A), { code: `I${rnd()}`, name: "x", baseUnitId: A.unitId }), "FORBIDDEN");
    await expectFail(createItem(admin(A), { code: `I${rnd()}`, name: "x", baseUnitId: A.unitId, quantityScale: 7 }), "VALIDATION_FAILED");
    // @ts-expect-error geçersiz takip modu çalışma zamanında reddedilir
    await expectFail(createItem(admin(A), { code: `I${rnd()}`, name: "x", baseUnitId: A.unitId, trackingMode: "BAD" }), "VALIDATION_FAILED");
    expect((await listItems(picker(A))).some((i) => i.id === itemId)).toBe(true);
    expect((await listItems(picker(B))).some((i) => i.id === itemId)).toBe(false);
  });

  it("updateItem: ad/politika değişir; stoklu ürünün takip modu/birim/ölçek değişimi IN_USE; stoksuzda da ret (A-87)", async () => {
    const { itemId } = await createItem(admin(A), { code: `I${rnd()}`, name: "Eski", baseUnitId: A.unitId, quantityScale: 2 });
    expect(await updateItem(admin(A), { itemId, name: "Yeni", pickPolicy: "FEFO" })).toEqual({ itemId, changed: true });
    expect(await getItem(admin(A), { itemId })).toMatchObject({ name: "Yeni", pickPolicy: "FEFO" });
    expect(await updateItem(admin(A), { itemId, name: "Yeni", trackingMode: "NONE", quantityScale: 2 })).toEqual({ itemId, changed: false });
    await expectFail(updateItem(admin(A), { itemId, trackingMode: "LOT" }), "VALIDATION_FAILED"); // stoksuz: A-87
    // A.itemNoneId stoklu (boyut + bakiye + açık rezervasyon).
    await expectFail(updateItem(admin(A), { itemId: A.itemNoneId, trackingMode: "LOT" }), "VALIDATION_FAILED", "IN_USE");
    await expectFail(updateItem(admin(A), { itemId: A.itemNoneId, quantityScale: 3 }), "VALIDATION_FAILED", "IN_USE");
    await expectFail(updateItem(admin(A), { itemId: A.itemNoneId, baseUnitId: A.boxUnitId }), "VALIDATION_FAILED", "IN_USE");
    const after = await adm.query("SELECT tracking_mode, quantity_scale, base_unit_id FROM public.items WHERE id = $1", [A.itemNoneId]);
    expect(after.rows[0]).toMatchObject({ tracking_mode: "NONE", quantity_scale: 0, base_unit_id: A.unitId });
    await expectFail(updateItem(picker(A), { itemId, name: "x" }), "FORBIDDEN");
    await expectFail(updateItem(admin(A), { itemId: B.itemId, name: "x" }), "NOT_FOUND");
  });

  it("archiveItem: pozitif bakiye/açık rezervasyon IN_USE; boş ürün arşivlenir, tekrar no-op; arşivli ürün güncellenemez", async () => {
    await expectFail(archiveItem(admin(A), { itemId: A.itemNoneId }), "VALIDATION_FAILED", "IN_USE");
    const stillActive = await adm.query("SELECT status FROM public.items WHERE id = $1", [A.itemNoneId]);
    expect(stillActive.rows[0]).toMatchObject({ status: "ACTIVE" });
    const { itemId } = await createItem(admin(A), { code: `I${rnd()}`, name: "Arşivlik", baseUnitId: A.unitId });
    expect(await archiveItem(admin(A), { itemId })).toEqual({ itemId, changed: true });
    expect(await archiveItem(admin(A), { itemId })).toEqual({ itemId, changed: false });
    expect(await getItem(admin(A), { itemId })).toMatchObject({ status: "ARCHIVED" });
    await expectFail(updateItem(admin(A), { itemId, name: "x" }), "VALIDATION_FAILED");
    await expectFail(archiveItem(picker(A), { itemId }), "FORBIDDEN");
    await expectFail(archiveItem(admin(A), { itemId: B.itemId }), "NOT_FOUND");
  });
});

describe("birim dönüşümü", () => {
  it("katsayı kuralları, temel birim reddi, güncelleme; belge satırındaki kopya etkilenmez (I-09)", async () => {
    const { itemId } = await createItem(admin(A), { code: `I${rnd()}`, name: "Dönüşümlü", baseUnitId: A.unitId });
    await expectFail(setUnitConversion(admin(A), { itemId, unitId: A.unitId, factor: "1" }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID");
    for (const bad of ["0", "-3", "0.0000001", "abc", ""]) {
      await expectFail(setUnitConversion(admin(A), { itemId, unitId: A.boxUnitId, factor: bad }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID");
    }
    expect(await setUnitConversion(admin(A), { itemId, unitId: A.boxUnitId, factor: "12.50" })).toEqual({ itemId, unitId: A.boxUnitId, factor: "12.5" });
    await setUnitConversion(admin(A), { itemId, unitId: A.boxUnitId, factor: "24" });
    const rows = await adm.query("SELECT to_base_factor::text AS f FROM public.unit_conversions WHERE item_id = $1", [itemId]);
    expect(rows.rows).toHaveLength(1);
    expect(Number((rows.rows[0] as { f: string }).f)).toBe(24);
    expect(await auditCount(A.tenantId, "unit_conversion.set")).toBeGreaterThanOrEqual(2);
    await expectFail(setUnitConversion(picker(A), { itemId, unitId: A.boxUnitId, factor: "2" }), "FORBIDDEN");
    await expectFail(setUnitConversion(admin(A), { itemId: B.itemId, unitId: A.boxUnitId, factor: "2" }), "NOT_FOUND");
    await expectFail(setUnitConversion(admin(A), { itemId, unitId: B.boxUnitId, factor: "2" }), "NOT_FOUND");
  });
});

describe("barkod ve çözümleme", () => {
  it("tek eşleşme: birim ve miktar döner; birim yoksa temel birim ve miktar 1", async () => {
    const { itemId } = await createItem(admin(A), { code: `I${rnd()}`, name: "Tekil", baseUnitId: A.unitId, quantityScale: 1 });
    const plain = `S${rnd()}`;
    const box = `K${rnd()}`;
    await addBarcode(admin(A), { itemId, barcode: plain });
    const { barcodeId } = await addBarcode(admin(A), { itemId, unitId: A.boxUnitId, barcode: box, quantity: "12.0" });
    expect(await resolveBarcodeQuery(picker(A), plain)).toEqual({ itemId, unitId: A.unitId, quantity: "1" });
    expect(await resolveBarcodeQuery(picker(A), `  ${box} `)).toEqual({ itemId, unitId: A.boxUnitId, quantity: "12" });
    await expectFail(resolveBarcodeQuery(picker(A), `Z${rnd()}`), "NOT_FOUND");
    await expectFail(resolveBarcodeQuery(picker(A), "   "), "VALIDATION_FAILED");
    await expectFail(addBarcode(admin(A), { itemId, unitId: A.boxUnitId, barcode: box }), "VALIDATION_FAILED", "CODE_TAKEN");
    await expectFail(addBarcode(admin(A), { itemId, barcode: plain }), "VALIDATION_FAILED", "CODE_TAKEN"); // NULL birim da tekil
    await expectFail(addBarcode(admin(A), { itemId, barcode: `Q${rnd()}`, quantity: "1.25" }), "VALIDATION_FAILED", "QUANTITY_SCALE");
    await expectFail(addBarcode(admin(A), { itemId, barcode: `Q${rnd()}`, quantity: "0" }), "VALIDATION_FAILED");
    await expectFail(addBarcode(picker(A), { itemId, barcode: `Q${rnd()}` }), "FORBIDDEN");
    await expectFail(addBarcode(admin(A), { itemId: B.itemId, barcode: `Q${rnd()}` }), "NOT_FOUND");
    // removeBarcode gerçek silme (A-88)
    expect(await removeBarcode(admin(A), { barcodeId })).toEqual({ barcodeId });
    const gone = await adm.query("SELECT 1 FROM public.item_barcodes WHERE id = $1", [barcodeId]);
    expect(gone.rowCount).toBe(0);
    await expectFail(resolveBarcodeQuery(picker(A), box), "NOT_FOUND");
    await expectFail(removeBarcode(admin(A), { barcodeId }), "NOT_FOUND");
    await expectFail(removeBarcode(picker(A), { barcodeId }), "FORBIDDEN");
    expect(await auditCount(A.tenantId, "item_barcode.removed")).toBeGreaterThanOrEqual(1);
  });

  it("belirsiz barkod sessizce atanmaz: BARCODE_AMBIGUOUS + aday listesi (kod, ad)", async () => {
    const code1 = `I${rnd()}`;
    const code2 = `I${rnd()}`;
    const { itemId: i1 } = await createItem(admin(A), { code: code1, name: "Birinci", baseUnitId: A.unitId });
    const { itemId: i2 } = await createItem(admin(A), { code: code2, name: "İkinci", baseUnitId: A.unitId });
    const shared = `AMB${rnd()}`;
    await addBarcode(admin(A), { itemId: i1, barcode: shared });
    await addBarcode(admin(A), { itemId: i2, barcode: shared });
    const err = await fail(resolveBarcodeQuery(picker(A), shared));
    expect(err).toBeInstanceOf(BarcodeAmbiguousError);
    expect(err).toMatchObject({ code: "VALIDATION_FAILED", detail: "BARCODE_AMBIGUOUS" });
    const cands = (err as BarcodeAmbiguousError).candidates;
    expect(cands.map((c) => c.itemCode).sort()).toEqual([code1, code2].sort());
    expect(cands.map((c) => c.itemName).sort()).toEqual(["Birinci", "İkinci"]);
    // Aynı ürün, farklı birim → yine belirsiz.
    const { itemId: i3 } = await createItem(admin(A), { code: `I${rnd()}`, name: "Üçüncü", baseUnitId: A.unitId });
    const sh2 = `AMB${rnd()}`;
    await addBarcode(admin(A), { itemId: i3, barcode: sh2 });
    await addBarcode(admin(A), { itemId: i3, unitId: A.boxUnitId, barcode: sh2, quantity: "6" });
    expect(await fail(resolveBarcodeQuery(picker(A), sh2))).toBeInstanceOf(BarcodeAmbiguousError);
    // Arşivlenen ürün adaylardan çıkar → tek eşleşme kalır.
    await archiveItem(admin(A), { itemId: i2 });
    expect(await resolveBarcodeQuery(picker(A), shared)).toEqual({ itemId: i1, unitId: A.unitId, quantity: "1" });
    // Arşivli ürüne barkod eklenemez.
    await expectFail(addBarcode(admin(A), { itemId: i2, barcode: `Q${rnd()}` }), "VALIDATION_FAILED");
  });

  it("tenant izolasyonu: B'nin barkodu A'da çözülmez; aynı barkod iki tenant'ta ayrı çözülür", async () => {
    const { itemId: bItem } = await createItem(admin(B), { code: `I${rnd()}`, name: "B ürünü", baseUnitId: B.unitId });
    const bc = `ISO${rnd()}`;
    await addBarcode(admin(B), { itemId: bItem, barcode: bc });
    await expectFail(resolveBarcodeQuery(picker(A), bc), "NOT_FOUND");
    expect(await resolveBarcodeQuery(picker(B), bc)).toMatchObject({ itemId: bItem });
    const { itemId: aItem } = await createItem(admin(A), { code: `I${rnd()}`, name: "A ürünü", baseUnitId: A.unitId });
    await addBarcode(admin(A), { itemId: aItem, barcode: bc });
    expect(await resolveBarcodeQuery(picker(A), bc)).toMatchObject({ itemId: aItem }); // belirsizlik tenant'lar arasında oluşmaz
    expect(await resolveBarcodeQuery(picker(B), bc)).toMatchObject({ itemId: bItem });
  });

  it("GS1 öğe dizgisi GTIN üzerinden çözülür (GTIN-13 kayıtlı barkod; lot/SKT/adet döner)", async () => {
    const { itemId } = await createItem(admin(A), { code: `I${rnd()}`, name: "GS1 ürünü", baseUnitId: A.unitId });
    const gtin13 = "4006381333931";
    // Bu GTIN başka testlerden kalmış olabilir (tenant başına tek dünya): önce yoksa ekle.
    const existing = await adm.query("SELECT 1 FROM public.item_barcodes WHERE tenant_id = $1 AND barcode = $2", [A.tenantId, gtin13]);
    expect(existing.rowCount).toBe(0);
    await addBarcode(admin(A), { itemId, barcode: gtin13 });
    const r = await resolveBarcodeQuery(picker(A), `]C101${"0" + gtin13}17261231${"10"}LOT9${GS}3000012`);
    expect(r).toMatchObject({ itemId, unitId: A.unitId, quantity: "1" });
    expect(r.gs1).toMatchObject({ gtin: "0" + gtin13, lot: "LOT9", expiryDate: "2026-12-31", quantity: "12" });
    // Bozuk kontrol hanesi: GS1 olarak çözülmez → NOT_FOUND.
    await expectFail(resolveBarcodeQuery(picker(A), `01${"0" + "4006381333932"}`), "NOT_FOUND");
  });
});
