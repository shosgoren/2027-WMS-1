// T-208: katalog komutları (birim, ürün, dönüşüm, barkod, çözümleme). Gerçek wms_app bağlantısı + RLS; fikstürler sentetik (G-09).
// Migration rolü yalnızca kurulum/doğrulama/temizlik içindir. Audit append-only: audit yazan tenant'lar kısa ömürlü ortamda kalır.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant } from "../../../packages/db/src/index.ts";
import { createTenantContext, DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { addBarcode, BarcodeAmbiguousError, BarcodeNotFoundError, removeBarcode, resolveBarcode, resolveBarcodeQuery } from "../../../packages/domain/src/catalog/barcodes.ts";
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
    // K-1 (T-287): koli barkodunun adedi unit_conversions'tan gelir; önce katsayı, sonra barkod.
    await expectFail(addBarcode(admin(A), { itemId, unitId: A.boxUnitId, barcode: box }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID"); // dönüşümsüz birim
    await setUnitConversion(admin(A), { itemId, unitId: A.boxUnitId, factor: "12" });
    await expectFail(addBarcode(admin(A), { itemId, unitId: A.boxUnitId, barcode: box, quantity: "12.0" }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID"); // çifte sayım
    await expectFail(addBarcode(admin(A), { itemId, unitId: A.boxUnitId, barcode: box, quantity: "2" }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID");
    const { barcodeId } = await addBarcode(admin(A), { itemId, unitId: A.boxUnitId, barcode: box, quantity: "1.0" });
    expect(await resolveBarcodeQuery(picker(A), plain)).toEqual({ itemId, unitId: A.unitId, quantity: "1", unitFactor: "1", baseQuantity: "1" });
    expect(await resolveBarcodeQuery(picker(A), `  ${box} `)).toEqual({ itemId, unitId: A.boxUnitId, quantity: "1", unitFactor: "12", baseQuantity: "12" });
    // Temel birim barkodunda "okutma başına miktar" anlamlıdır (12'li poşet) ve ürün ölçeğine uyar.
    const pack = `P${rnd()}`;
    await addBarcode(admin(A), { itemId, barcode: pack, quantity: "12" });
    expect(await resolveBarcodeQuery(picker(A), pack)).toEqual({ itemId, unitId: A.unitId, quantity: "12", unitFactor: "1", baseQuantity: "12" });
    // Katsayısı ürün ölçeğine uymayan koli yuvarlanmaz: çözümleme QUANTITY_SCALE (0.25 katsayı, ölçek 1).
    const { itemId: fracItem } = await createItem(admin(A), { code: `I${rnd()}`, name: "Kesirli", baseUnitId: A.unitId, quantityScale: 1 });
    await setUnitConversion(admin(A), { itemId: fracItem, unitId: A.boxUnitId, factor: "0.25" });
    const fracBox = `F${rnd()}`;
    await addBarcode(admin(A), { itemId: fracItem, unitId: A.boxUnitId, barcode: fracBox });
    await expectFail(resolveBarcodeQuery(picker(A), fracBox), "VALIDATION_FAILED", "QUANTITY_SCALE");
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
    await setUnitConversion(admin(A), { itemId: i3, unitId: A.boxUnitId, factor: "6" });
    await addBarcode(admin(A), { itemId: i3, unitId: A.boxUnitId, barcode: sh2 });
    expect(await fail(resolveBarcodeQuery(picker(A), sh2))).toBeInstanceOf(BarcodeAmbiguousError);
    // Arşivlenen ürün adaylardan çıkar → tek eşleşme kalır.
    await archiveItem(admin(A), { itemId: i2 });
    expect(await resolveBarcodeQuery(picker(A), shared)).toEqual({ itemId: i1, unitId: A.unitId, quantity: "1", unitFactor: "1", baseQuantity: "1" });
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
    // Bu GTIN yalnızca bu testte kullanılır (A dünyasında başka testte eklenmez); beklenmedik tekrar test hatasıdır.
    const existing = await adm.query("SELECT 1 FROM public.item_barcodes WHERE tenant_id = $1 AND barcode = $2", [A.tenantId, gtin13]);
    expect(existing.rowCount).toBe(0);
    await addBarcode(admin(A), { itemId, barcode: gtin13 });
    const r = await resolveBarcodeQuery(picker(A), `]C101${"0" + gtin13}17261231${"10"}LOT9${GS}3000012`);
    expect(r).toMatchObject({ itemId, unitId: A.unitId, quantity: "1" });
    expect(r.gs1).toMatchObject({ gtin: "0" + gtin13, lot: "LOT9", expiryDate: "2026-12-31", quantity: "12" });
    // Bozuk kontrol hanesi: GS1 olarak çözülmez → NOT_FOUND.
    const bad = await fail(resolveBarcodeQuery(picker(A), `01${"0" + "4006381333932"}`));
    expect(bad).toBeInstanceOf(BarcodeNotFoundError);
    expect(bad).toMatchObject({ code: "NOT_FOUND", gs1Reason: "INVALID_GTIN_CHECK_DIGIT" });
    const zeroQty = await fail(resolveBarcodeQuery(picker(A), `]C101${"0" + gtin13}3000000`));
    expect(zeroQty).toMatchObject({ code: "NOT_FOUND", gs1Reason: "INVALID_QUANTITY" });
  });
});

// GTIN üretici (sentetik): gövdeye GS1 mod-10 kontrol hanesi ekler.
function gtinOf(body: string): string {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return `${body}${(10 - (sum % 10)) % 10}`;
}
const digits = (n: number): string => Array.from(randomBytes(n), (b) => String(b % 10)).join("");
async function mkItem(w: TenantWorld, name: string): Promise<string> {
  return (await createItem(admin(w), { code: `I${rnd()}`, name, baseUnitId: w.unitId })).itemId;
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("GS1 önceliği ve belirsizlik (A-108)", () => {
  /** Eski/içe aktarılmış ham GS1 dizgisi barkodu (addBarcode artık kabul etmez): doğrudan tabloya (migration rolü) yazılır. */
  async function legacyRawBarcode(itemId: string, barcode: string): Promise<void> {
    await adm.query("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3)", [A.tenantId, itemId, barcode]);
  }

  it("addBarcode geçerli GTIN içeren GS1 dizgisini reddeder (VALIDATION_FAILED); GTIN'in kendisi ve GS1 olmayan metin kabul", async () => {
    const itemId = await mkItem(A, "GS1 ham ret");
    const gtin14 = gtinOf(`0${digits(12)}`);
    for (const bad of [`01${gtin14}`, `]C101${gtin14}`, `]d201${gtin14}`, `01${gtin14}10LOT1`, `01${gtin14}17261231`]) {
      await expectFail(addBarcode(admin(A), { itemId, barcode: bad }), "VALIDATION_FAILED");
    }
    expect((await adm.query("SELECT 1 FROM public.item_barcodes WHERE item_id = $1", [itemId])).rowCount).toBe(0);
    await addBarcode(admin(A), { itemId, barcode: gtin14.slice(1) }); // GTIN-13
    await addBarcode(admin(A), { itemId, barcode: `01-ABC-${rnd()}` }); // GS1 değil
    await addBarcode(admin(A), { itemId, barcode: `0100${rnd()}` }); // GS1 olarak ayrıştırılamaz (kısa)
  });

  it("önek/FNC1 varken tam eşleşme ile GTIN eşleşmesi birleştirilir: farklı ürünler → BARCODE_AMBIGUOUS", async () => {
    const gtin14 = gtinOf(`0${digits(12)}`);
    const gtin13 = gtin14.slice(1);
    const p = await mkItem(A, "Tam eşleşme");
    const q = await mkItem(A, "GTIN eşleşme");
    await legacyRawBarcode(p, `]C101${gtin14}`);
    await addBarcode(admin(A), { itemId: q, barcode: gtin13 });
    const err = await fail(resolveBarcodeQuery(picker(A), `]C101${gtin14}`));
    expect(err).toBeInstanceOf(BarcodeAmbiguousError);
    expect((err as BarcodeAmbiguousError).candidates.map((c) => c.itemId).sort()).toEqual([p, q].sort());
    // Aynı ürün hem tam hem GTIN ile eşleşirse sahte belirsizlik yok.
    const r = await mkItem(A, "Aynı ürün");
    const g2 = gtinOf(`0${digits(12)}`);
    await legacyRawBarcode(r, `]C101${g2}`);
    await addBarcode(admin(A), { itemId: r, barcode: g2.slice(1) });
    expect(await resolveBarcodeQuery(picker(A), `]C101${g2}`)).toMatchObject({ itemId: r });
  });

  it("ÖNEKSİZ/GS'siz '01<gtin14>' (HID okuyucu): tam eşleşme + GTIN eşleşmesi birleşir; çakışmada BARCODE_AMBIGUOUS, sessiz atama yok", async () => {
    const gtin14 = gtinOf(`0${digits(12)}`);
    const p = await mkItem(A, "Ham dizgi sahibi");
    const q = await mkItem(A, "GTIN sahibi");
    await addBarcode(admin(A), { itemId: q, barcode: gtin14.slice(1) });
    // Tam eşleşme yok → GTIN eşleşmesi q'yu bulur.
    expect(await resolveBarcodeQuery(picker(A), `01${gtin14}`)).toMatchObject({ itemId: q });
    // Eski veri: p'ye ham dizgi bağlı → artık belirsiz (eskiden sessizce p'ye giderdi).
    await legacyRawBarcode(p, `01${gtin14}`);
    const err = await fail(resolveBarcodeQuery(picker(A), `01${gtin14}`));
    expect(err).toBeInstanceOf(BarcodeAmbiguousError);
    expect((err as BarcodeAmbiguousError).candidates.map((c) => c.itemId).sort()).toEqual([p, q].sort());
  });

  it("kısa biçimler: 12 hane öneksiz da; 8 hane yalnızca sembol önekiyle", async () => {
    const g12 = gtinOf(digits(11));
    const g8 = gtinOf(digits(7));
    const t = await mkItem(A, "GTIN-12");
    const u = await mkItem(A, "GTIN-8");
    await addBarcode(admin(A), { itemId: t, barcode: g12 });
    await addBarcode(admin(A), { itemId: u, barcode: g8 });
    expect(await resolveBarcodeQuery(picker(A), `01${g12.padStart(14, "0")}`)).toMatchObject({ itemId: t });
    expect(await resolveBarcodeQuery(picker(A), `]d201${g12.padStart(14, "0")}`)).toMatchObject({ itemId: t });
    await expectFail(resolveBarcodeQuery(picker(A), `01${g8.padStart(14, "0")}`), "NOT_FOUND");
    expect(await resolveBarcodeQuery(picker(A), `]d201${g8.padStart(14, "0")}`)).toMatchObject({ itemId: u });
  });
});

describe("belirsizlik anahtarı: miktar", () => {
  it("NULL miktar = 1: aynı ürün+birim+eşdeğer miktar sahte belirsizlik üretmez; farklı miktar üretir ve aday miktarı gösterir", async () => {
    const itemId = await mkItem(A, "Miktar anahtarı");
    const same = `QK${rnd()}`;
    await addBarcode(admin(A), { itemId, barcode: same }); // birim NULL → temel birim, miktar yok (=1)
    await addBarcode(admin(A), { itemId, unitId: A.unitId, barcode: same, quantity: "1" }); // aynı birim, miktar 1
    expect(await resolveBarcodeQuery(picker(A), same)).toEqual({ itemId, unitId: A.unitId, quantity: "1", unitFactor: "1", baseQuantity: "1" });
    const diff = `QD${rnd()}`;
    await addBarcode(admin(A), { itemId, barcode: diff });
    await addBarcode(admin(A), { itemId, unitId: A.unitId, barcode: diff, quantity: "6" });
    const err = await fail(resolveBarcodeQuery(picker(A), diff));
    expect(err).toBeInstanceOf(BarcodeAmbiguousError);
    expect((err as BarcodeAmbiguousError).candidates.map((c) => c.quantity).sort()).toEqual(["1", "6"]);
  });
  it("barkod miktarı sınırları: taşma ve işaret VALIDATION_FAILED (INTERNAL değil)", async () => {
    const itemId = await mkItem(A, "Miktar sınırı");
    for (const q of ["100000000000000", "-1", "abc"]) {
      await expectFail(addBarcode(admin(A), { itemId, barcode: `QB${rnd()}`, unitId: A.boxUnitId, quantity: q }), "VALIDATION_FAILED");
    }
  });
});

describe("tenant bağlamı ve açık tenant filtresi", () => {
  it("resolveBarcode yanlış/boş bağlamda NOT_FOUND; kimlik biçimi geçersizse VALIDATION_FAILED", async () => {
    const itemId = await mkItem(A, "Bağlam");
    const bc = `CTX${rnd()}`;
    await addBarcode(admin(A), { itemId, barcode: bc });
    const inA = await withTenant(createTenantContext(app, A.tenantId), (tx) => resolveBarcode(tx, A.tenantId, bc));
    expect(inA).toMatchObject({ itemId });
    // A bağlamı + B kimliği (açık filtre), B bağlamı + A kimliği (RLS), hiç verisi olmayan bağlam → NOT_FOUND.
    await expectFail(withTenant(createTenantContext(app, A.tenantId), (tx) => resolveBarcode(tx, B.tenantId, bc)), "NOT_FOUND");
    await expectFail(withTenant(createTenantContext(app, B.tenantId), (tx) => resolveBarcode(tx, A.tenantId, bc)), "NOT_FOUND");
    const empty = randomUUID();
    await expectFail(withTenant(createTenantContext(app, empty), (tx) => resolveBarcode(tx, empty, bc)), "NOT_FOUND");
    await expectFail(withTenant(createTenantContext(app, A.tenantId), (tx) => resolveBarcode(tx, "x", bc)), "VALIDATION_FAILED");
  });
});

describe("arşiv eşzamanlılığı (FOR SHARE ↔ FOR UPDATE)", () => {
  /** Arşiv sürerken (ürün satırı kilitli) komut bekler; arşiv commit olunca ACTIVE denetimi kilitten SONRA yapıldığı için reddedilir. */
  async function archivedWhileWaiting(itemId: string, run: () => Promise<unknown>): Promise<AppError> {
    await adm.query("BEGIN");
    try {
      await adm.query("SELECT 1 FROM public.items WHERE id = $1 FOR UPDATE", [itemId]);
      let settled = false;
      const p = run().then(
        () => {
          settled = true;
          return undefined;
        },
        (e: unknown) => {
          settled = true;
          return e;
        },
      );
      await delay(500);
      expect(settled).toBe(false); // komut ürün satırında bekliyor
      await adm.query("UPDATE public.items SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [itemId]);
      await adm.query("COMMIT");
      const err = await p;
      expect(err).toBeInstanceOf(AppError);
      return err as AppError;
    } catch (e) {
      await adm.query("ROLLBACK");
      throw e;
    }
  }

  it("addBarcode: arşiv commit olmadan bekler, sonra reddedilir; barkod satırı oluşmaz", async () => {
    const itemId = await mkItem(A, "Yarış barkod");
    const bc = `RACE${rnd()}`;
    const err = await archivedWhileWaiting(itemId, () => addBarcode(admin(A), { itemId, barcode: bc }));
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await adm.query("SELECT 1 FROM public.item_barcodes WHERE barcode = $1", [bc])).rowCount).toBe(0);
  });
  it("setUnitConversion: aynı yarışta reddedilir; dönüşüm satırı oluşmaz", async () => {
    const itemId = await mkItem(A, "Yarış dönüşüm");
    const err = await archivedWhileWaiting(itemId, () => setUnitConversion(admin(A), { itemId, unitId: A.boxUnitId, factor: "3" }));
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await adm.query("SELECT 1 FROM public.unit_conversions WHERE item_id = $1", [itemId])).rowCount).toBe(0);
  });
  it("paralel archiveItem ∥ addBarcode ∥ setUnitConversion: 40P01/INTERNAL yok; hata yalnızca VALIDATION_FAILED", async () => {
    // NOT: bu test FOR SHARE'i AYIRT ETMEZ (xid/created_at sırası kilit alma anında atandığı için commit sırasını kanıtlamaz;
    // mutasyonla da kırmızıya dönmez). Ayırt edici kanıt yukarıdaki iki deterministik test: kilit kaldırılınca kırmızı olur.
    for (let i = 0; i < 25; i++) {
      const itemId = await mkItem(A, `Yarış ${i}`);
      const [arch, add, conv] = await Promise.allSettled([
        archiveItem(admin(A), { itemId }),
        addBarcode(admin(A), { itemId, barcode: `RR${rnd()}` }),
        setUnitConversion(admin(A), { itemId, unitId: A.boxUnitId, factor: "2" }),
      ]);
      expect(arch.status).toBe("fulfilled");
      for (const r of [add, conv]) {
        if (r.status === "rejected") {
          expect(r.reason).toBeInstanceOf(AppError);
          expect((r.reason as AppError).code).toBe("VALIDATION_FAILED");
        }
      }
      expect((await adm.query("SELECT status FROM public.items WHERE id = $1", [itemId])).rows[0]).toMatchObject({ status: "ARCHIVED" });
    }
  });
});
