"use server";
// Depo ve lokasyon eylemleri (T-207). İnce giriş: yalnızca girdi doğrulama (zod) + T-205 domain komutu; kod/ad normalleştirmesi
// (A-98) ve yetki (`settings.manage`, A-68) sunucuda domain'dedir, burada yeniden yazılmaz. İdempotency gerekmez: komutlar stok
// değiştirmez; çift gönderim `CODE_TAKEN` ile sonuçlanır. Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnızca domain'e verilir).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import { archiveLocation, archiveWarehouse, createLocation, createWarehouse, getLocationTree } from "@wms/domain/warehouse";
import type { LocationKindValue } from "@wms/domain/warehouse";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
// Sınırlar yalnızca istemci kötüye kullanımına karşı kaba üst sınırdır; asıl doğrulama/normalleştirme domain'dedir.
const textSchema = z.string().min(1).max(512);
// `LocationKindValue` ile birebir olmalıdır (`satisfies` derleme zamanında zorlar).
const kindSchema = z.enum(["RECEIVING", "STORAGE", "STAGING", "TRANSIT"] as const satisfies readonly LocationKindValue[]);

const createWarehouseSchema = z.object({ slug: slugSchema, code: textSchema, name: textSchema }).strict();
const archiveWarehouseSchema = z.object({ slug: slugSchema, warehouseId: idSchema }).strict();
const createLocationSchema = z
  .object({ slug: slugSchema, warehouseId: idSchema, parentId: idSchema.nullable(), code: textSchema, name: textSchema, kind: kindSchema })
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
    const r = await createWarehouse(params, { code: input.code, name: input.name, requestId: ctx.requestId });
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
    const r = await createLocation(
      params,
      { warehouseId: input.warehouseId, parentId: input.parentId, code: input.code, name: input.name, kind: input.kind, requestId: ctx.requestId },
    );
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
