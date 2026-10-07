"use server";
// Mal kabul ve yerleştirme eylemleri (T-313). İnce giriş: yalnızca girdi doğrulama (zod) + T-305 domain komutu / T-313 okuma sorgusu.
// Yetki (`document.create` / `stock.post` / `document.approve`), fazla kabul, sayım kilidi ve durum kuralları domain'dedir; burada yeniden yazılmaz.
// Miktarlar DİZGİ olarak iletilir (I-09; `Number`/float yok). Her yazma eyleminin `clientKey` (UUID) girdisi zorunludur: anahtar yaşam döngüsü
// istemcidedir (receipt-form.tsx `createKeyHolder`); aynı anahtar aynı içerikle yeniden gönderilirse domain tekrar oynatır (ADR-018 §1-3).
// Sayaç doğrulanmış tenant kimliğiyle tüketilir. Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnızca domain'e verilir).
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import type { Permission } from "@wms/domain/identity/permissions";
import { getItem, listItemConversions, listUnits, resolveBarcodeQuery } from "@wms/domain/catalog";
import { approveQuality, createInboundReceipt, getAvailableAtLocation, openInboundReceipt, putaway, receiveGoods } from "@wms/domain/operations";
import { findLocationByCode } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
const keySchema = z.string().uuid();
/** Ondalık dizgi: biçim/ölçek denetimi domain'de (`positiveDecimal`, `QUANTITY_SCALE`); burada yalnızca uzunluk (sayı tipi reddedilir). */
const decimalSchema = z.string().min(1).max(32);
const codeSchema = z.string().min(1).max(256);

const createSchema = z
  .object({
    slug: slugSchema,
    clientKey: keySchema,
    warehouseId: idSchema,
    supplierRef: z.string().max(100).optional(),
    lines: z.array(z.object({ itemId: idSchema, unitId: idSchema, expectedQuantity: decimalSchema }).strict()).min(1).max(200),
  })
  .strict();
const receiveSchema = z
  .object({
    slug: slugSchema,
    clientKey: keySchema,
    receiptId: idSchema,
    lines: z.array(z.object({ lineId: idSchema, received: decimalSchema, damaged: decimalSchema.optional(), locationId: idSchema }).strict()).min(1).max(200),
  })
  .strict();
const approveSchema = z.object({ slug: slugSchema, clientKey: keySchema, receiptId: idSchema }).strict();
const putawaySchema = z
  .object({
    slug: slugSchema,
    clientKey: keySchema,
    taskId: idSchema.optional(),
    sourceLocationId: idSchema,
    targetLocationId: idSchema,
    itemId: idSchema,
    quantity: decimalSchema,
  })
  .strict();
const scanItemSchema = z.object({ slug: slugSchema, code: codeSchema }).strict();
const scanLocationSchema = z.object({ slug: slugSchema, warehouseId: idSchema, code: codeSchema }).strict();
const availableSchema = z.object({ slug: slugSchema, locationId: idSchema, itemId: idSchema }).strict();
const unitsSchema = z.object({ slug: slugSchema, itemId: idSchema }).strict();

// 'use server' dosyası yalnızca async işlev dışa aktarır; bu yardımcı yereldir (davranışı actions.test.ts createReceiptAction üzerinden sınar).
/** `open` komutunun anahtarı: oluşturma anahtarından belirlenimci türetilir (aynı anahtar → aynı açma anahtarı; tekrar oynatma güvenli). */
function deriveKey(clientKey: string, purpose: string): string {
  const h = createHash("sha256").update(`${clientKey}:${purpose}`).digest("hex");
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function principalOf(ctx: ActionContext) {
  if (ctx.principal === null) throw new Error("unreachable: principal required");
  return ctx.principal;
}

/** Yazma bağlamı: sayaç doğrulanmış tenant kimliğiyle tüketilir; komut izni domain'de yeniden denetlenir. */
async function writeContext(slug: string, permission: Permission, clientKey: string, ctx: ActionContext) {
  const principal = principalOf(ctx);
  await limitVerifiedTenant({ db: getAppDb(), principal, tenantSlug: slug, permission }, ctx);
  return { db: getAppDb(), principal, tenantSlug: slug, clientKey };
}
const readContext = (slug: string, ctx: ActionContext) => ({ db: getAppDb(), principal: principalOf(ctx), tenantSlug: slug });

/** Beklenen teslimi oluşturur ve açar (`document.create`). Açma başarısız olursa DRAFT kalır; aynı anahtarla yeniden gönderim yalnızca açmayı tamamlar. */
export async function createReceiptAction(raw: unknown) {
  return guardedAction({ schema: createSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.create", input.clientKey, ctx);
    const created = await createInboundReceipt(params, {
      warehouseId: input.warehouseId,
      ...(input.supplierRef === undefined || input.supplierRef.trim() === "" ? {} : { supplierRef: input.supplierRef }),
      lines: input.lines,
      requestId: ctx.requestId,
    });
    const receiptId = created.documentId as string;
    await openInboundReceipt({ ...params, clientKey: deriveKey(input.clientKey, "open") }, { receiptId, expectedVersion: 1, requestId: ctx.requestId });
    return { receiptId, number: created.documentNumber as string };
  })(raw);
}

/** Fiziksel kabul (`stock.post`): kabul ve hasarlı miktar; fazla kabul reddi domain'dedir. */
export async function receiveGoodsAction(raw: unknown) {
  return guardedAction({ schema: receiveSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", input.clientKey, ctx);
    const r = await receiveGoods(params, { receiptId: input.receiptId, lines: input.lines, requestId: ctx.requestId });
    return { replayed: r.replayed };
  })(raw);
}

/** Kalite onayı (`document.approve`): belgenin bekleyen karantina miktarının tamamı. */
export async function approveQualityAction(raw: unknown) {
  return guardedAction({ schema: approveSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", input.clientKey, ctx);
    const r = await approveQuality(params, { receiptId: input.receiptId, requestId: ctx.requestId });
    return { replayed: r.replayed };
  })(raw);
}

/** Yerleştirme (`stock.post`): kaynak → STORAGE hedef; görev varsa aynı transaction'da kapanır. Sayım kilidi `LOCATION_LOCKED` olarak döner. */
export async function putawayAction(raw: unknown) {
  return guardedAction({ schema: putawaySchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", input.clientKey, ctx);
    const r = await putaway(params, {
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      sourceLocationId: input.sourceLocationId,
      targetLocationId: input.targetLocationId,
      itemId: input.itemId,
      quantity: input.quantity,
      requestId: ctx.requestId,
    });
    return { replayed: r.replayed };
  })(raw);
}

/** Okutulan ürün barkodunu çözer (koli barkodu adet getirir, A-20). Bulunamaz → NOT_FOUND; belirsiz → VALIDATION_FAILED/BARCODE_AMBIGUOUS. */
export async function resolveItemScanAction(raw: unknown) {
  return guardedAction({ schema: scanItemSchema }, async (input, ctx) => {
    const params = readContext(input.slug, ctx);
    const r = await resolveBarcodeQuery(params, input.code);
    const item = await getItem(params, { itemId: r.itemId });
    return { itemId: r.itemId, itemCode: item.code, itemName: item.name, unitId: r.unitId, quantity: r.quantity };
  })(raw);
}

/** Okutulan lokasyon kodunu depo içinde çözer; yoksa NOT_FOUND. */
export async function resolveLocationScanAction(raw: unknown) {
  return guardedAction({ schema: scanLocationSchema }, async (input, ctx) => {
    const loc = await findLocationByCode(readContext(input.slug, ctx), { warehouseId: input.warehouseId, code: input.code });
    if (loc === null) throw new AppError("NOT_FOUND");
    return { id: loc.id, code: loc.code, name: loc.name, kind: loc.kind, status: loc.status };
  })(raw);
}

/** Kaynak lokasyondaki yerleştirilebilir miktar (varsayılan miktar için; kural `putaway` komutundadır). */
export async function availableAtLocationAction(raw: unknown) {
  return guardedAction({ schema: availableSchema }, async (input, ctx) => getAvailableAtLocation(readContext(input.slug, ctx), { locationId: input.locationId, itemId: input.itemId }))(raw);
}

/** Ürünün seçilebilir birimleri: temel birim + dönüşümü tanımlı birimler (form birim seçimi). */
export async function itemUnitsAction(raw: unknown) {
  return guardedAction({ schema: unitsSchema }, async (input, ctx) => {
    const params = readContext(input.slug, ctx);
    const item = await getItem(params, { itemId: input.itemId });
    const conv = await listItemConversions(params, input.itemId);
    const base = (await listUnits(params)).find((u) => u.id === item.baseUnitId);
    const units = [{ unitId: item.baseUnitId, unitCode: base?.code ?? "", unitName: base?.name ?? "" }, ...conv.map((c) => ({ unitId: c.unitId, unitCode: c.unitCode, unitName: c.unitName }))];
    return { itemName: item.name, itemCode: item.code, units };
  })(raw);
}
