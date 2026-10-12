"use server";
// Sayım eylemleri (T-316). İnce giriş: yalnızca girdi doğrulama (zod) + T-309 domain komutu / T-316a okuma sorgusu.
// Yetki, kilit, durum ve fark kuralları domain'dedir; burada yeniden yazılmaz (G-01). İzinler (A-132): başlatma/iptal `document.approve`,
// sayım girişi/gönderim `document.create`, onay ve fark fişi `count_diff.approve`; yetkisiz çağrı domain'de `FORBIDDEN` olur ve aynen aktarılır.
// Miktarlar DİZGİ olarak iletilir (I-09). Her yazma eyleminin `clientKey` (UUID) girdisi zorunludur (T-277a): anahtar yaşam döngüsü istemcidedir
// (count-review.tsx `useAttemptKey`: her kullanıcı denemesi yeni anahtar, çift gönderimde aynı anahtar).
// KÖR SAYIM: bu dosyadaki tek saha okuması `view: "field"` kullanır (referans/fark alanı sunucuda bile gelmez); `review` yalnızca [id]/page.tsx'te çağrılır.
// Sayaç doğrulanmış tenant kimliğiyle tüketilir. Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnızca domain'e verilir).
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import { getItem, resolveBarcodeQuery } from "@wms/domain/catalog";
import type { Permission } from "@wms/domain/identity/permissions";
import { approveCount, cancelCount, getCountSession, postCountAdjustment, recordCount, startCount, submitCount } from "@wms/domain/operations";
import { getLocationTree } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
const keySchema = z.string().uuid();
/** Ondalık dizgi: biçim/ölçek denetimi domain'de (`QUANTITY_SCALE`); burada yalnızca uzunluk (sayı tipi reddedilir). */
const decimalSchema = z.string().min(1).max(32);
const statusSchema = z.enum(["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"]);

const startSchema = z
  .object({ slug: slugSchema, clientKey: keySchema, warehouseId: idSchema, locationIds: z.array(idSchema).min(1).max(200), blind: z.boolean().optional() })
  .strict();
const recordSchema = z
  .object({
    slug: slugSchema,
    clientKey: keySchema,
    sessionId: idSchema,
    lines: z.array(z.object({ locationId: idSchema, itemId: idSchema, countedQuantity: decimalSchema, stockStatus: statusSchema.optional() }).strict()).min(1).max(200),
  })
  .strict();
const transitionSchema = z.object({ slug: slugSchema, clientKey: keySchema, sessionId: idSchema }).strict();
const cancelSchema = z.object({ slug: slugSchema, clientKey: keySchema, sessionId: idSchema, reason: z.string().trim().min(1).max(500) }).strict();
const scanSchema = z.object({ slug: slugSchema, code: z.string().min(1).max(256) }).strict();
const fieldSchema = z.object({ slug: slugSchema, sessionId: idSchema }).strict();
const locationsSchema = z
  .object({ slug: slugSchema, warehouseId: idSchema, after: z.object({ depth: z.number().int().min(0).max(16), code: z.string().min(1).max(256), id: idSchema }).strict().optional() })
  .strict();

// 'use server' dosyası yalnızca async işlev dışa aktarır; bu yardımcı yereldir (davranışı actions.test.ts zincir eylemi üzerinden sınar).
/** Zincirin ikinci komutunun anahtarı: ilk anahtardan belirlenimci türetilir (aynı anahtar → aynı fiş anahtarı; tekrar oynatma güvenli). */
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

/** Sayımı başlatır (`document.approve`): seçili lokasyonlar tek işlemde kilitlenir; biri doluysa hiçbiri kilitlenmez (kısmi kilit yok). */
export async function startCountAction(raw: unknown) {
  return guardedAction({ schema: startSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", input.clientKey, ctx);
    const r = await startCount(params, {
      warehouseId: input.warehouseId,
      locationIds: input.locationIds,
      ...(input.blind === undefined ? {} : { blind: input.blind }),
      requestId: ctx.requestId,
    });
    return { sessionId: r.sessionId, replayed: r.replayed };
  })(raw);
}

/** Sayım değerlerini yazar (`document.create`); stok yazmaz. Aynı (lokasyon, ürün, durum) tekrar yazılırsa son değer geçerlidir. */
export async function recordCountAction(raw: unknown) {
  return guardedAction({ schema: recordSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.create", input.clientKey, ctx);
    const r = await recordCount(params, {
      sessionId: input.sessionId,
      lines: input.lines.map((l) => ({ locationId: l.locationId, itemId: l.itemId, countedQuantity: l.countedQuantity, ...(l.stockStatus === undefined ? {} : { stockStatus: l.stockStatus }) })),
      requestId: ctx.requestId,
    });
    return { recorded: r.recorded };
  })(raw);
}

/** Sayımı onaya gönderir (`document.create`); tüm satırlar sayılmış olmalıdır (kural domain'de). */
export async function submitCountAction(raw: unknown) {
  return guardedAction({ schema: transitionSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.create", input.clientKey, ctx);
    const r = await submitCount(params, { sessionId: input.sessionId, requestId: ctx.requestId });
    return { status: r.status };
  })(raw);
}

/** Yalnız onay (`count_diff.approve`). Fark listesi istemciye taşınmaz (gözden geçirme ekranı kendi okumasını yapar). */
export async function approveCountAction(raw: unknown) {
  return guardedAction({ schema: transitionSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "count_diff.approve", input.clientKey, ctx);
    const r = await approveCount(params, { sessionId: input.sessionId, requestId: ctx.requestId });
    return { status: r.status };
  })(raw);
}

/** Yalnız fark fişi (`count_diff.approve`): onaylı oturum için. "Onaylandı, fiş bekliyor" durumundan yeniden denemenin yolu budur. */
export async function postCountAdjustmentAction(raw: unknown) {
  return guardedAction({ schema: transitionSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "count_diff.approve", input.clientKey, ctx);
    const r = await postCountAdjustment(params, { sessionId: input.sessionId, requestId: ctx.requestId });
    return { replayed: r.replayed };
  })(raw);
}

/**
 * Zincir: "Onayla ve fark fişini işle" tek düğme, İKİ AYRI domain komutu (kart madde 3). İlk komut (onay) başarısızsa hata aynen döner (ikincisi çağrılmaz).
 * Onay başarılı, fiş başarısızsa istek BAŞARILI döner (`posted: false` + `postError`): oturum `APPROVED`'dır, ekran "onaylandı, fiş bekliyor" gösterir ve yalnız
 * `postCountAdjustmentAction` ile yeniden dener. Fiş anahtarı onay anahtarından türetilir; onay geri alınmaz ve kural yeniden yazılmaz.
 */
export async function approveAndPostCountAction(raw: unknown) {
  return guardedAction({ schema: transitionSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "count_diff.approve", input.clientKey, ctx);
    await approveCount(params, { sessionId: input.sessionId, requestId: ctx.requestId });
    try {
      await postCountAdjustment({ ...params, clientKey: deriveKey(input.clientKey, "post") }, { sessionId: input.sessionId, requestId: ctx.requestId });
      return { approved: true as const, posted: true as const };
    } catch (e) {
      // Onay kalıcıdır; hatayı yutma: kod + ayrıntı + istek kimliği istemciye gider. Tanınmayan hata genel INTERNAL olur ve (yalnız sınıf adı) loglanır (G-09).
      const known = e instanceof AppError;
      if (!known) console.error(JSON.stringify({ level: "error", msg: "count post failed after approve", requestId: ctx.requestId, error: e instanceof Error ? e.name : typeof e }));
      return {
        approved: true as const,
        posted: false as const,
        postError: { code: known ? e.code : "INTERNAL", ...(known && e.detail !== undefined ? { detail: e.detail } : {}), requestId: ctx.requestId },
      };
    }
  })(raw);
}

/** İptal (`document.approve`): gerekçe zorunlu; fark UYGULANMAZ, kilitler açılır. */
export async function cancelCountAction(raw: unknown) {
  return guardedAction({ schema: cancelSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", input.clientKey, ctx);
    const r = await cancelCount(params, { sessionId: input.sessionId, reason: input.reason, requestId: ctx.requestId });
    return { replayed: r.replayed };
  })(raw);
}

/** Saha okuması: YALNIZ `field` kipi (referans ve fark alanı sunucuda hiç gelmez). Her kayıttan sonra ilerlemeyi tazelemek içindir. */
export async function fieldCountAction(raw: unknown) {
  return guardedAction({ schema: fieldSchema }, async (input, ctx) => {
    const d = await getCountSession(readContext(input.slug, ctx), { sessionId: input.sessionId, view: "field" });
    // Açık beyaz liste (savunma derinliği): alan eklemek bilinçli olur; domain sızdırsa bile referans/fark istemciye geçmez.
    return {
      locations: d.locations.map((l) => ({ id: l.id, code: l.code, name: l.name, locked: l.locked })),
      lines: d.lines.map((l) => ({ id: l.id, locationId: l.locationId, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, unitCode: l.unitCode, unitName: l.unitName, quantityScale: l.quantityScale, stockStatus: l.stockStatus, counted: l.counted })),
    };
  })(raw);
}

/** Başlatma formu: deponun etkin lokasyonları, keyset sayfa (okuma `stock.view`; kapsam domain'de). */
export async function listCountLocationsAction(raw: unknown) {
  return guardedAction({ schema: locationsSchema }, async (input, ctx) => {
    const page = await getLocationTree(readContext(input.slug, ctx), { warehouseId: input.warehouseId, includeArchived: false, limit: 200, ...(input.after === undefined ? {} : { after: input.after }) });
    return { items: page.items.filter((l) => l.status === "ACTIVE").map((l) => ({ id: l.id, code: l.code, name: l.name, kind: l.kind })), next: page.next };
  })(raw);
}

/**
 * Okutulan ürün barkodu (saha sayımı): `resolveBarcode` çıktısı AYNEN geçer (adet `baseQuantity`, temel birim; koli içi adet sunucuda hesaplanır) + ürünün miktar ölçeği
 * (`quantityScale`): ondalıklı ürün (örn. kg) sahada ondalık sayılır, ölçeğe uymayan giriş istemcide ve `recordCount`ta (QUANTITY_SCALE) reddedilir. Okuma `stock.view`.
 */
export async function resolveCountItemAction(raw: unknown) {
  return guardedAction({ schema: scanSchema }, async (input, ctx) => {
    const params = readContext(input.slug, ctx);
    const r = await resolveBarcodeQuery(params, input.code);
    const item = await getItem(params, { itemId: r.itemId });
    return { itemId: r.itemId, itemCode: item.code, itemName: item.name, baseQuantity: r.baseQuantity, quantityScale: item.quantityScale };
  })(raw);
}
