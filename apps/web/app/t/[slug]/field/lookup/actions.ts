"use server";
// Stok sorgu saha eylemleri (T-332b). İnce giriş: girdi doğrulama (zod) + domain okumaları (`stockByItem`, `stockByLocation`, barkod/ürün/raf çözümü).
// Yetki (`stock.view`), depo kapsamı ve kör sayım maskesi domain'dedir; burada yeniden yazılmaz. Yok / başka tenant / yetkisiz üyelik aynı NOT_FOUND'dur.
// Salt okuma: yazma yok, anahtar yok. Miktarlar ondalık DİZGİdir (I-09).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import { resolveBarcodeQuery, searchItems } from "@wms/domain/catalog";
import { stockByItem, stockByLocation } from "@wms/domain/stock";
import { findLocationByCode, listWarehouses } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { createProductionGuard, type ActionContext } from "../../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
const codeSchema = z.string().min(1).max(256);
const cursorSchema = z.string().min(1).max(1024).optional();
const scanSchema = z.object({ slug: slugSchema, code: codeSchema }).strict();
const itemSchema = z.object({ slug: slugSchema, itemId: idSchema, afterKey: cursorSchema }).strict();
const locationSchema = z.object({ slug: slugSchema, locationId: idSchema, afterKey: cursorSchema }).strict();

/** Aynı kodla birden çok eşleşme olduğunda kullanıcıya sunulan seçenek. */
export interface LookupChoice {
  readonly type: "item" | "location";
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

const CHOICE_LIMIT = 8;

const readContext = (slug: string, ctx: ActionContext) => {
  if (ctx.principal === null) throw new Error("unreachable: principal required");
  return { db: getAppDb(), principal: ctx.principal, tenantSlug: slug };
};

/**
 * Okutulan/yazılan kodu çözer: önce ürün barkodu (GS1 dahil), sonra depolardaki raf kodu, sonra ürün kodu/adı. Tek eşleşme → doğrudan sonuç (ilk sayfa);
 * birden çok eşleşme → seçenekler; hiçbiri → NOT_FOUND. Belirsiz barkod `VALIDATION_FAILED/BARCODE_AMBIGUOUS` olarak yukarı çıkar (sessizce seçilmez).
 */
export async function lookupScanAction(raw: unknown) {
  return guardedAction({ schema: scanSchema }, async (input, ctx) => {
    const params = readContext(input.slug, ctx);
    const code = input.code.trim();
    if (code === "") throw new AppError("VALIDATION_FAILED");

    const barcode = await resolveBarcodeQuery(params, code).then(
      (r) => r,
      (e: unknown) => {
        if (e instanceof AppError && e.code === "NOT_FOUND") return null;
        throw e;
      },
    );
    if (barcode !== null) return { kind: "item" as const, result: await stockByItem(params, { itemId: barcode.itemId }) };

    // Raf kodu depo içinde aranır; her etkin depo denenir (aynı kod iki depoda varsa seçenek sunulur).
    const warehouses = (await listWarehouses(params)).items.filter((w) => w.status === "ACTIVE");
    const choices: LookupChoice[] = [];
    for (const w of warehouses) {
      const loc = await findLocationByCode(params, { warehouseId: w.id, code });
      if (loc !== null) choices.push({ type: "location", id: loc.id, code: loc.code, name: loc.name });
    }
    if (choices.length === 0) {
      const found = await searchItems(params, { q: code, status: "ACTIVE", limit: CHOICE_LIMIT });
      for (const it of found.items) choices.push({ type: "item", id: it.id, code: it.code, name: it.name });
    }
    const only = choices.length === 1 ? choices[0] : undefined;
    if (only !== undefined) {
      return only.type === "location"
        ? { kind: "location" as const, result: await stockByLocation(params, { locationId: only.id }) }
        : { kind: "item" as const, result: await stockByItem(params, { itemId: only.id }) };
    }
    if (choices.length === 0) throw new AppError("NOT_FOUND");
    return { kind: "choices" as const, choices };
  })(raw);
}

/** Bir ürünün raf bazlı stoğu (sayfa sayfa; `afterKey` önceki sayfanın imlecidir). */
export async function lookupItemAction(raw: unknown) {
  return guardedAction({ schema: itemSchema }, async (input, ctx) =>
    stockByItem(readContext(input.slug, ctx), { itemId: input.itemId, ...(input.afterKey === undefined ? {} : { afterKey: input.afterKey }) }),
  )(raw);
}

/** Bir rafın ürün bazlı içeriği (sayfa sayfa). */
export async function lookupLocationAction(raw: unknown) {
  return guardedAction({ schema: locationSchema }, async (input, ctx) =>
    stockByLocation(readContext(input.slug, ctx), { locationId: input.locationId, ...(input.afterKey === undefined ? {} : { afterKey: input.afterKey }) }),
  )(raw);
}
