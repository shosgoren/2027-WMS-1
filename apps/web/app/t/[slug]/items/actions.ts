"use server";
// Ürün kartı eylemleri (T-216). İnce giriş: yalnızca girdi doğrulama (zod) + T-208 domain komutu. Kod/ad normalleştirmesi, takip modu,
// ölçek, dönüşüm katsayısı kuralları ve yetki (`settings.manage`, A-68) sunucuda domain'dedir; burada yeniden yazılmaz. Katsayı ve
// barkod miktarı DİZGİ olarak domain'e iletilir (I-09: `Number`/float'a çevrilmez). Bu dosyada DB bağlantısı açılmaz (`getAppDb`
// yalnızca domain'e verilir). Köken (Origin) ve oturum denetimi ortak `createProductionGuard` içindedir.
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import { addBarcode, archiveItem, createItem, removeBarcode, setUnitConversion, updateItem } from "@wms/domain/catalog";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
// Sınırlar yalnızca istemci kötüye kullanımına karşı kaba üst sınırdır; asıl doğrulama/normalleştirme domain'dedir.
const textSchema = z.string().min(1).max(512);
/** Ondalık metin (katsayı/miktar): biçim ve ölçek denetimi domain'de (`assertConversionFactor`/`assertQuantityScale`); burada yalnızca uzunluk. */
const decimalSchema = z.string().min(1).max(64);
// `TrackingMode` / `PickPolicy` ile birebir (domain ayrıca doğrular).
const trackingSchema = z.enum(["NONE", "LOT", "SERIAL", "LOT_AND_SERIAL"]);
const pickSchema = z.enum(["FIFO", "FEFO"]);

const createItemSchema = z
  .object({
    slug: slugSchema,
    code: textSchema,
    name: textSchema,
    baseUnitId: idSchema,
    quantityScale: z.number().int().min(0).max(6).optional(),
    trackingMode: trackingSchema.optional(),
    pickPolicy: pickSchema.optional(),
  })
  .strict();
const updateItemSchema = z.object({ slug: slugSchema, itemId: idSchema, name: textSchema.optional(), pickPolicy: pickSchema.optional() }).strict();
const archiveItemSchema = z.object({ slug: slugSchema, itemId: idSchema }).strict();
const conversionSchema = z.object({ slug: slugSchema, itemId: idSchema, unitId: idSchema, factor: decimalSchema }).strict();
const addBarcodeSchema = z
  .object({ slug: slugSchema, itemId: idSchema, unitId: idSchema.nullable(), barcode: textSchema, quantity: decimalSchema.nullable() })
  .strict();
const removeBarcodeSchema = z.object({ slug: slugSchema, barcodeId: idSchema }).strict();

/** Komut izni `settings.manage`; sayaç doğrulanmış tenant kimliğiyle tüketilir (üye/yetkisiz çağıran sayaç tüketmez). */
async function writeContext(slug: string, ctx: ActionContext) {
  const principal = ctx.principal;
  if (principal === null) throw new Error("unreachable: principal required");
  await limitVerifiedTenant({ db: getAppDb(), principal, tenantSlug: slug, permission: "settings.manage" }, ctx);
  return { db: getAppDb(), principal, tenantSlug: slug };
}

export async function createItemAction(raw: unknown) {
  return guardedAction({ schema: createItemSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const r = await createItem(
      { ...params, requestId: ctx.requestId },
      {
        code: input.code,
        name: input.name,
        baseUnitId: input.baseUnitId,
        ...(input.quantityScale === undefined ? {} : { quantityScale: input.quantityScale }),
        ...(input.trackingMode === undefined ? {} : { trackingMode: input.trackingMode }),
        ...(input.pickPolicy === undefined ? {} : { pickPolicy: input.pickPolicy }),
      },
    );
    return { itemId: r.itemId };
  })(raw);
}

export async function updateItemAction(raw: unknown) {
  return guardedAction({ schema: updateItemSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const r = await updateItem(
      { ...params, requestId: ctx.requestId },
      { itemId: input.itemId, ...(input.name === undefined ? {} : { name: input.name }), ...(input.pickPolicy === undefined ? {} : { pickPolicy: input.pickPolicy }) },
    );
    return { changed: r.changed };
  })(raw);
}

export async function archiveItemAction(raw: unknown) {
  return guardedAction({ schema: archiveItemSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const r = await archiveItem({ ...params, requestId: ctx.requestId }, { itemId: input.itemId });
    return { changed: r.changed };
  })(raw);
}

export async function setConversionAction(raw: unknown) {
  return guardedAction({ schema: conversionSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const r = await setUnitConversion({ ...params, requestId: ctx.requestId }, { itemId: input.itemId, unitId: input.unitId, factor: input.factor });
    return { factor: r.factor };
  })(raw);
}

export async function addBarcodeAction(raw: unknown) {
  return guardedAction({ schema: addBarcodeSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const r = await addBarcode({ ...params, requestId: ctx.requestId }, { itemId: input.itemId, unitId: input.unitId, barcode: input.barcode, quantity: input.quantity });
    return { barcodeId: r.barcodeId };
  })(raw);
}

export async function removeBarcodeAction(raw: unknown) {
  return guardedAction({ schema: removeBarcodeSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const r = await removeBarcode({ ...params, requestId: ctx.requestId }, { barcodeId: input.barcodeId });
    return { barcodeId: r.barcodeId };
  })(raw);
}
