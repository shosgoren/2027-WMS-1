"use server";
// Sipariş, rezervasyon ve toplama görevlendirme eylemleri (T-314). İnce giriş: yalnızca girdi doğrulama (zod) + T-306/T-307 domain komutu / T-314a okuma sorgusu.
// Yetki (`document.create` sipariş; `document.approve` rezervasyon/iptal/görevlendirme), kapsam, durum ve stok kuralları domain'dedir; burada yeniden yazılmaz.
// Miktarlar DİZGİ olarak iletilir (I-09; `Number`/float yok). Her yazma eyleminin `clientKey` (UUID) girdisi zorunludur: anahtar yaşam döngüsü istemcidedir
// (order-form.tsx `useKeyFor`, receipts/receipt-form.tsx `createKeyHolder` deseni); aynı anahtar aynı içerikle yeniden gönderilirse domain tekrar oynatır (ADR-018).
// Sayaç doğrulanmış tenant kimliğiyle tüketilir. Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnızca domain'e verilir).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import type { Permission } from "@wms/domain/identity/permissions";
import { cancelOrderLine, cancelSalesOrder, createPickAssignment, createSalesOrder, reserveOrder } from "@wms/domain/operations";
import { stockByItem } from "@wms/domain/stock";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
const keySchema = z.string().uuid();
/** Ondalık dizgi: biçim/ölçek denetimi domain'de (`positiveDecimal`, `QUANTITY_SCALE`); burada yalnızca uzunluk (sayı tipi reddedilir). */
const decimalSchema = z.string().min(1).max(32);
/** Gerekçe: boş/yalnız boşluk reddedilir (iptal gerekçesiz yapılmaz); üst sınır domain'deki `REASON_MAX` (500) ile aynıdır. */
const reasonSchema = z.string().trim().min(1).max(500);

const createSchema = z
  .object({
    slug: slugSchema,
    clientKey: keySchema,
    number: z.string().max(40).optional(),
    customerRef: z.string().max(100).optional(),
    lines: z.array(z.object({ itemId: idSchema, unitId: idSchema, quantity: decimalSchema }).strict()).min(1).max(200),
  })
  .strict();
const dimensionSchema = z
  .object({
    locationId: idSchema,
    lotId: idSchema.nullable().optional(),
    serialId: idSchema.nullable().optional(),
    stockStatus: z.enum(["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"]).optional(),
    inventoryOwnerId: idSchema.nullable().optional(),
    handlingUnitId: idSchema.nullable().optional(),
  })
  .strict();
const reserveSchema = z
  .object({
    slug: slugSchema,
    clientKey: keySchema,
    orderId: idSchema,
    overrides: z
      .array(z.object({ lineId: idSchema, allocations: z.array(z.object({ dimension: dimensionSchema, quantity: decimalSchema }).strict()).min(1).max(50) }).strict())
      .min(1)
      .max(200)
      .optional(),
  })
  .strict();
const cancelLineSchema = z.object({ slug: slugSchema, clientKey: keySchema, lineId: idSchema, quantity: decimalSchema, reason: reasonSchema }).strict();
const cancelOrderSchema = z
  .object({ slug: slugSchema, clientKey: keySchema, orderId: idSchema, expectedVersion: z.number().int().min(1), reason: reasonSchema })
  .strict();
const assignSchema = z
  .object({ slug: slugSchema, clientKey: keySchema, orderIds: z.array(idSchema).min(1).max(200), assigneeMembershipId: idSchema.optional() })
  .strict();
const stockSchema = z.object({ slug: slugSchema, itemId: idSchema }).strict();

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

/** Sipariş oluşturur (`document.create`). Sonuç: sipariş kimliği + numarası; ekran doğrudan ayrıntıya gider (A-314a-2: kapsamlı kullanıcı listede göremeyebilir). */
export async function createOrderAction(raw: unknown) {
  return guardedAction({ schema: createSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.create", input.clientKey, ctx);
    const r = await createSalesOrder(params, {
      ...(input.number === undefined || input.number.trim() === "" ? {} : { number: input.number }),
      ...(input.customerRef === undefined || input.customerRef.trim() === "" ? {} : { customerRef: input.customerRef }),
      lines: input.lines,
      requestId: ctx.requestId,
    });
    return { orderId: r.documentId as string, number: r.documentNumber as string, replayed: r.replayed };
  })(raw);
}

/**
 * Rezerve eder (`document.approve`). `overrides` yoksa A-138 önerisi kullanılır; varsa elle tahsistir. Yetersiz stok RET DEĞİLDİR (T-306): sonuçta satır başına
 * tahsis edilen miktar döner; 0 olan satır tahsissiz açık kalmıştır ve ekran bunu "tahsis edilemeyen miktar" olarak gösterir.
 */
export async function reserveOrderAction(raw: unknown) {
  return guardedAction({ schema: reserveSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", input.clientKey, ctx);
    const r = await reserveOrder(params, {
      orderId: input.orderId,
      ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
      requestId: ctx.requestId,
    });
    return { replayed: r.replayed, lines: (r.lines ?? []).map((l) => ({ lineId: l.lineId, lineNo: l.lineNo, quantity: l.quantity ?? "0" })) };
  })(raw);
}

/** Satır iptali (`document.approve`): gerekçe zorunlu; miktar temel birimde dizgi, açık miktardan büyük olamaz (domain). */
export async function cancelOrderLineAction(raw: unknown) {
  return guardedAction({ schema: cancelLineSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", input.clientKey, ctx);
    const r = await cancelOrderLine(params, { lineId: input.lineId, quantity: input.quantity, reason: input.reason, requestId: ctx.requestId });
    return { replayed: r.replayed };
  })(raw);
}

/** Siparişin tamamı iptal (`document.approve`): yalnızca hiç sevk yapılmamışsa (domain A-306-6, aksi DOCUMENT_STATE); sürüm uyuşmazlığı VERSION_CONFLICT. */
export async function cancelOrderAction(raw: unknown) {
  return guardedAction({ schema: cancelOrderSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", input.clientKey, ctx);
    const r = await cancelSalesOrder(params, { orderId: input.orderId, expectedVersion: input.expectedVersion, reason: input.reason, requestId: ctx.requestId });
    return { replayed: r.replayed };
  })(raw);
}

/**
 * Toplama görevlendirmesi (domain izni `document.approve`; atanacak üye `stock.post` sahibi olmalı, depo kapsamı domain'de denetlenir).
 * Sonuç `groupId === null` ise görev ÜRETİLMEMİŞTİR (tahsis yok ya da zaten görevli); ekran bunu açıkça söyler.
 */
export async function createPickAssignmentAction(raw: unknown) {
  return guardedAction({ schema: assignSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", input.clientKey, ctx);
    const r = await createPickAssignment(params, {
      orderIds: input.orderIds,
      ...(input.assigneeMembershipId === undefined ? {} : { assigneeMembershipId: input.assigneeMembershipId }),
      requestId: ctx.requestId,
    });
    return {
      replayed: r.replayed,
      groupId: r.groupId,
      taskCount: r.taskIds.length,
      lines: (r.lines ?? []).map((l) => ({ lineId: l.lineId, lineNo: l.lineNo, quantity: l.quantity ?? "0" })),
    };
  })(raw);
}

/**
 * Elle tahsis için ürünün tahsis edilebilir stok boyutları (`stock.view`, depo kapsamı domain'de). Yalnız görüntü verisi: öneri/uygunluk kuralı yeniden yazılmaz;
 * kilit altındaki asıl denetim `reserveOrder` içindedir. En çok 50 boyut (sayfa).
 */
export async function lineStockAction(raw: unknown) {
  return guardedAction({ schema: stockSchema }, async (input, ctx) => {
    const r = await stockByItem({ db: getAppDb(), principal: principalOf(ctx), tenantSlug: input.slug }, { itemId: input.itemId, limit: 50 });
    return {
      rows: r.rows
        // `available` sorgudan gelir ve uygunluk kuralını (durum, lokasyon türü, pick_blocked) zaten uygular; uygun olmayan boyut "0.000000"dır.
        .filter((x) => x.available !== "0.000000" && !x.available.startsWith("-"))
        .map((x) => ({
          dimension: {
            locationId: x.locationId,
            lotId: x.lot?.id ?? null,
            serialId: x.serial?.id ?? null,
            stockStatus: x.stockStatus,
            inventoryOwnerId: x.owner?.id ?? null,
            handlingUnitId: x.handlingUnit?.id ?? null,
          },
          locationCode: x.locationCode,
          warehouseCode: x.warehouseCode,
          lotCode: x.lot?.code ?? null,
          serialNo: x.serial?.serialNo ?? null,
          available: x.available,
        })),
      truncated: r.nextCursor !== null,
    };
  })(raw);
}
