"use server";
// Sevk ve müşteri iadesi eylemleri (T-315). İnce giriş: yalnızca girdi doğrulama (zod) + T-308 domain komutu (`shipOrder`, `createCustomerReturn`).
// Yetki (`stock.post`), kapsam, sevke uygunluk (SEVK alanındaki rezervasyon), iade üst sınırı (`RETURN_EXCEEDS_SHIPPED`) ve sayım kilidi (`LOCATION_LOCKED`)
// domain'dedir; burada yeniden yazılmaz. Miktarlar DİZGİ olarak iletilir (I-09). Her yazma eyleminin `clientKey` (UUID) girdisi zorunludur: anahtar yaşam
// döngüsü istemcidedir (`useKeyHolder`, T-229 deseni); aynı anahtar aynı içerikle yeniden gönderilirse domain saklı sonucu döner (ADR-018).
// Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnızca domain'e verilir).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import type { Permission } from "@wms/domain/identity/permissions";
import { createCustomerReturn, shipOrder } from "@wms/domain/operations";
import { findLocationByCode, listWarehouses } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
const keySchema = z.string().uuid();
/** Ondalık dizgi: biçim/ölçek denetimi domain'de (`DECIMAL_RE`); burada yalnızca uzunluk (sayı tipi reddedilir). */
const decimalSchema = z.string().min(1).max(32);
/** İade nedeni: boş/yalnız boşluk reddedilir; üst sınır domain'deki `REASON_MAX` (500) ile aynıdır (kontrol karakteri denetimi domain'de). */
const reasonSchema = z.string().trim().min(1).max(500);

const shipSchema = z
  .object({
    slug: slugSchema,
    clientKey: keySchema,
    orderId: idSchema,
    lines: z.array(z.object({ orderLineId: idSchema, quantity: decimalSchema }).strict()).min(1).max(200),
  })
  .strict();
const returnSchema = z
  .object({ slug: slugSchema, clientKey: keySchema, orderLineId: idSchema, quantity: decimalSchema, locationId: idSchema, reason: reasonSchema })
  .strict();
const locationSchema = z.object({ slug: slugSchema, code: z.string().trim().min(1).max(64) }).strict();

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

/**
 * Siparişin SEVK alanındaki (toplanmış) miktarını sevk eder (`stock.post`): satır başına temel birimde miktar. Rezervasyonsuz/toplanmamış miktar sevk edilmez
 * (domain `INSUFFICIENT_STOCK`); ikinci farklı anahtarlı deneme tüketilecek rezervasyon bulamaz ve aynı kodla reddedilir (AC-10). Aynı anahtar saklı sonucu döner.
 */
export async function shipOrderAction(raw: unknown) {
  return guardedAction({ schema: shipSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", input.clientKey, ctx);
    const r = await shipOrder(params, { orderId: input.orderId, lines: input.lines, requestId: ctx.requestId });
    return { replayed: r.replayed };
  })(raw);
}

/** Sevk edilmiş sipariş satırı için müşteri iadesi (`stock.post`): stok yalnız KARANTİNA boyutuna girer (kalite onayı bekler); üst sınır domain'dedir. */
export async function createCustomerReturnAction(raw: unknown) {
  return guardedAction({ schema: returnSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", input.clientKey, ctx);
    const r = await createCustomerReturn(params, {
      orderLineId: input.orderLineId,
      quantity: input.quantity,
      locationId: input.locationId,
      reason: input.reason,
      requestId: ctx.requestId,
    });
    return { replayed: r.replayed };
  })(raw);
}

/**
 * Okutulan/yazılan kabul rafı kodunu etkin depolarda çözer (salt okuma). Türü ve durumu olduğu gibi döner; "iade yalnız kabul alanına girer" kuralı
 * `createCustomerReturn` içindedir (ekran yalnızca erken geri bildirim için türü kullanır). Hiç eşleşme yoksa NOT_FOUND.
 */
export async function returnLocationAction(raw: unknown) {
  return guardedAction({ schema: locationSchema }, async (input, ctx) => {
    const params = { db: getAppDb(), principal: principalOf(ctx), tenantSlug: input.slug };
    const warehouses = (await listWarehouses(params)).items.filter((w) => w.status === "ACTIVE");
    const matches: { id: string; code: string; name: string; kind: string; status: string }[] = [];
    for (const w of warehouses) {
      const loc = await findLocationByCode(params, { warehouseId: w.id, code: input.code });
      if (loc !== null) matches.push({ id: loc.id, code: loc.code, name: loc.name, kind: loc.kind, status: loc.status });
    }
    if (matches.length === 0) throw new AppError("NOT_FOUND");
    return { matches };
  })(raw);
}
