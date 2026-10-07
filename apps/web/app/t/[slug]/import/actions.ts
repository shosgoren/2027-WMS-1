"use server";
// Açılış verisi içe aktarma eylemleri (T-289). İnce giriş: yalnızca girdi doğrulama (zod) + domain komutu. Ayrıştırma, doğrulama, yetki
// (`settings.manage`; stok dosyasında ayrıca `document.create`/`document.approve`/`stock.post`) ve idempotans domain'dedir; burada yeniden
// yazılmaz. Dosya içeriği YALNIZ bellekte taşınır: diske/loga yazılmaz (G-09); loga yalnız sınıf adı/SQLSTATE girer (ortak guard). Her çağrı
// dosyayı sunucuda yeniden ayrıştırır (istemci önizlemesine güvenilmez). Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnız domain'e verilir).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import { IMPORT_MAX_BYTES, applyImportChunk, previewImport } from "@wms/domain/onboarding/import";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
// Karakter üst sınırı baytın üst sınırıdır değil: asıl bayt/satır sınırları domain'dedir (`classify`); bu yalnız kaba kötüye kullanım sınırı.
const textSchema = z.string().min(1).max(IMPORT_MAX_BYTES);
const previewSchema = z.object({ slug: slugSchema, text: textSchema }).strict();
// `digest`: önizlemenin içerik özeti (sha-256 hex); uygulama dosyayı yeniden ayrıştırır ve özet uyuşmazsa reddeder.
const applySchema = z.object({ slug: slugSchema, text: textSchema, chunk: z.number().int().min(0).max(1000), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

async function writeContext(slug: string, ctx: ActionContext) {
  const principal = ctx.principal;
  if (principal === null) throw new Error("unreachable: principal required");
  await limitVerifiedTenant({ db: getAppDb(), principal, tenantSlug: slug, permission: "settings.manage" }, ctx);
  return { db: getAppDb(), principal, tenantSlug: slug };
}

/** Önizleme: hiçbir şey yazılmaz; satır başına sorunlar ve özet döner. */
export async function previewImportAction(raw: unknown) {
  return guardedAction({ schema: previewSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    return previewImport({ ...params, requestId: ctx.requestId }, input.text);
  })(raw);
}

/** Bir parçayı (≤ 200 satır) uygular; rapor hangi satırların uygulandığını açıkça söyler. */
export async function applyImportChunkAction(raw: unknown) {
  return guardedAction({ schema: applySchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, ctx);
    const report = await applyImportChunk({ ...params, requestId: ctx.requestId }, { text: input.text, chunk: input.chunk, digest: input.digest });
    // Ayrıntı kodu (errorDetail) istemciye gönderilmez: ekranda yalnız sade metin gösterilir.
    return { ...report, rows: report.rows.map((r) => ({ row: r.row, code: r.code, status: r.status, ...(r.errorCode === undefined ? {} : { errorCode: r.errorCode }), ...(r.reason === undefined ? {} : { reason: r.reason }) })) };
  })(raw);
}
