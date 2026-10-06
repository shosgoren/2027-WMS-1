"use server";
// Depo ve lokasyon eylemleri (T-207). İnce giriş: yalnızca girdi doğrulama (zod) + T-205 domain komutu; kod/ad normalleştirmesi
// (A-98) ve yetki (`settings.manage`, A-68) sunucuda domain'dedir, burada yeniden yazılmaz. İdempotency gerekmez: komutlar stok
// değiştirmez; çift gönderim `CODE_TAKEN` ile sonuçlanır. Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnızca domain'e verilir).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import { createWithSuggestedCode, suggestCode } from "@wms/domain/catalog";
import {
  archiveLocation,
  archiveWarehouse,
  createBulkLocations,
  createLocation,
  createWarehouse,
  getLocationTree,
  getSetupProgress,
  previewBulkLocations,
  searchLocations,
} from "@wms/domain/warehouse";
import type { LocationKindValue } from "@wms/domain/warehouse";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
// Sınırlar yalnızca istemci kötüye kullanımına karşı kaba üst sınırdır; asıl doğrulama/normalleştirme domain'dedir.
const textSchema = z.string().min(1).max(512);
// `LocationKindValue` ile birebir olmalıdır (`satisfies` derleme zamanında zorlar).
const kindSchema = z.enum(["RECEIVING", "STORAGE", "STAGING", "TRANSIT"] as const satisfies readonly LocationKindValue[]);

// `autoCode` (T-250): kod kullanıcı tarafından değiştirilmedi; çakışmada sunucu sıradaki öneriyle yeniden dener.
const createWarehouseSchema = z.object({ slug: slugSchema, code: textSchema, name: textSchema, autoCode: z.boolean().optional() }).strict();
const suggestCodeSchema = z.object({ slug: slugSchema, kind: z.enum(["warehouse", "location"]), warehouseId: idSchema.optional() }).strict();
const bulkSpecShape = {
  slug: slugSchema,
  warehouseId: idSchema,
  parentId: idSchema.nullable(),
  zone: z.string().min(1).max(16),
  rackFrom: z.number().int(),
  rackTo: z.number().int(),
  levelFrom: z.number().int(),
  levelTo: z.number().int(),
};
const previewBulkSchema = z.object(bulkSpecShape).strict();
const createBulkSchema = z.object({ ...bulkSpecShape, idempotencyKey: z.string().min(1).max(64) }).strict();
const searchLocationsSchema = z.object({ slug: slugSchema, warehouseId: idSchema, q: z.string().max(128), limit: z.number().int().min(1).max(20).optional() }).strict();
const setupProgressSchema = z.object({ slug: slugSchema }).strict();
const archiveWarehouseSchema = z.object({ slug: slugSchema, warehouseId: idSchema }).strict();
const createLocationSchema = z
  .object({ slug: slugSchema, warehouseId: idSchema, parentId: idSchema.nullable(), code: textSchema, name: textSchema, kind: kindSchema, autoCode: z.boolean().optional() })
  .strict();
const archiveLocationSchema = z.object({ slug: slugSchema, locationId: idSchema }).strict();
const moreLocationsSchema = z
  .object({ slug: slugSchema, warehouseId: idSchema, after: z.object({ depth: z.number().int().min(0).max(16), code: textSchema, id: idSchema }).strict() })
  .strict();

/** Komut izni `settings.manage`; sayaç doğrulanmış tenant kimliğiyle tüketilir (üye/yetkisiz çağıran sayaç tüketmez). */
async function writeContext(slug: string, ctx: ActionContext) {
  const principal = ctx.principal;
  if (principal === null) throw new Error("unreachable: principal required");
  await limitVerifiedTenant({ db: getAppDb(), principal, tenantSlug: slug, permission: "settings.manage" }, ctx);
  return { db: getAppDb(), principal, tenantSlug: slug };
}

export async function createWarehouseAction(raw: unknown) {
  return guardedAction({ schema: createWarehouseSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const create = (code: string) => createWarehouse(params, { code, name: input.name, requestId: ctx.requestId });
    const r =
      input.autoCode === true
        ? await createWithSuggestedCode({ code: input.code, auto: true, suggest: () => suggestCode(params, { kind: "warehouse" }), create })
        : await create(input.code);
    return { warehouseId: r.warehouseId };
  })(raw);
}

export async function archiveWarehouseAction(raw: unknown) {
  return guardedAction({ schema: archiveWarehouseSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const r = await archiveWarehouse(params, { warehouseId: input.warehouseId, requestId: ctx.requestId });
    return { archived: r.archived };
  })(raw);
}

export async function createLocationAction(raw: unknown) {
  return guardedAction({ schema: createLocationSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const create = (code: string) =>
      createLocation(params, { warehouseId: input.warehouseId, parentId: input.parentId, code, name: input.name, kind: input.kind, requestId: ctx.requestId });
    const r =
      input.autoCode === true
        ? await createWithSuggestedCode({
            code: input.code,
            auto: true,
            suggest: () => suggestCode(params, { kind: "location", warehouseId: input.warehouseId }),
            create,
          })
        : await create(input.code);
    return { locationId: r.locationId, depth: r.depth };
  })(raw);
}

export async function archiveLocationAction(raw: unknown) {
  return guardedAction({ schema: archiveLocationSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const r = await archiveLocation(params, { locationId: input.locationId, requestId: ctx.requestId });
    return { archived: r.archived };
  })(raw);
}

/** "Daha fazla" (keyset, OFFSET yok): okuma `stock.view`; domain izin ve kapsamı denetler. */
export async function loadMoreLocationsAction(raw: unknown) {
  return guardedAction({ schema: moreLocationsSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const page = await getLocationTree({ db: getAppDb(), principal, tenantSlug: input.slug }, { warehouseId: input.warehouseId, includeArchived: true, after: input.after, limit: 200 });
    return { items: page.items, next: page.next };
  })(raw);
}

/** Sıradaki depo/lokasyon kodu (T-250): sunucuda hesaplanır; yazımda benzersizlik yine denetlenir. */
export async function suggestCodeAction(raw: unknown) {
  return guardedAction({ schema: suggestCodeSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    return suggestCode(params, { kind: input.kind, ...(input.warehouseId === undefined ? {} : { warehouseId: input.warehouseId }) });
  })(raw);
}

/** Toplu raf önizleme (T-250): salt okuma; kod üretimi, sınır ve çakışma denetimi domain'de. */
export async function previewBulkLocationsAction(raw: unknown) {
  return guardedAction({ schema: previewBulkSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    return previewBulkLocations(params, {
      warehouseId: input.warehouseId,
      parentId: input.parentId,
      zone: input.zone,
      rackFrom: input.rackFrom,
      rackTo: input.rackTo,
      levelFrom: input.levelFrom,
      levelTo: input.levelTo,
    });
  })(raw);
}

/** Toplu raf oluşturma (T-250): tek transaction + idempotency anahtarı domain'dedir. */
export async function createBulkLocationsAction(raw: unknown) {
  return guardedAction({ schema: createBulkSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    return createBulkLocations(params, {
      warehouseId: input.warehouseId,
      parentId: input.parentId,
      zone: input.zone,
      rackFrom: input.rackFrom,
      rackTo: input.rackTo,
      levelFrom: input.levelFrom,
      levelTo: input.levelTo,
      idempotencyKey: input.idempotencyKey,
      requestId: ctx.requestId,
    });
  })(raw);
}

/** Yazdıkça lokasyon arama (T-250): okuma `stock.view`; sınırlı sonuç. */
export async function searchLocationsAction(raw: unknown) {
  return guardedAction({ schema: searchLocationsSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    return searchLocations({ db: getAppDb(), principal, tenantSlug: input.slug }, { warehouseId: input.warehouseId, q: input.q, ...(input.limit === undefined ? {} : { limit: input.limit }) });
  })(raw);
}

/** Boş ekran rehberi ilerlemesi (T-250): okuma `stock.view`. */
export async function getSetupProgressAction(raw: unknown) {
  return guardedAction({ schema: setupProgressSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    return getSetupProgress({ db: getAppDb(), principal, tenantSlug: input.slug });
  })(raw);
}
