"use server";
// Görev eylemleri (T-304). İnce giriş: yalnızca girdi doğrulama (zod) + domain komutu; yetki (A-132) ve durum kuralları domain'dedir.
// Üstlenme izni görev türüne bağlıdır → sarmalayıcı `stock.view`, tür izni domain'de denetlenir. Atama/iptal `document.approve`.
// Sayaç doğrulanmış tenant kimliğiyle tüketilir. Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnızca domain'e verilir).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import type { Permission } from "@wms/domain/identity/permissions";
import { assignTask, beginSave, cancelTask, claimTask, getTaskProgress, nextTaskFor, recordTaskStep, resetTaskProgress, savePutawayTask } from "@wms/domain/operations";
import { createProductionGuard, limitVerifiedTenant, type ActionContext } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const slugSchema = z.string().min(1).max(63);
const idSchema = z.string().uuid();
const versionSchema = z.number().int().min(1).max(2_147_483_647);
// Üst sınır yalnızca istemci kötüye kullanımına karşıdır; asıl doğrulama (1–500, denetim karakteri) domain'dedir.
const reasonSchema = z.string().min(1).max(2000);

const claimSchema = z.object({ slug: slugSchema, taskId: idSchema, expectedVersion: versionSchema }).strict();
const assignSchema = z.object({ slug: slugSchema, taskId: idSchema, membershipId: idSchema, expectedVersion: versionSchema }).strict();
const cancelSchema = z.object({ slug: slugSchema, taskId: idSchema, expectedVersion: versionSchema, reason: reasonSchema }).strict();

// Rehberli akış (T-293, ADR-025): girdi STRICT; `membershipId`/`locationId`/`itemId` alanları şemada YOKTUR (fazla alan → VALIDATION_FAILED).
// Okutma yalnızca kod dizesi taşır (barkod/raf kodu); kimlikler sunucuda çözülür, `membership_id` oturumdan türetilir. Kod/miktar loga yazılmaz.
const scanCodeSchema = z.string().min(1).max(256);
const progressReadSchema = z.object({ slug: slugSchema, taskId: idSchema }).strict();
const recordStepSchema = z.discriminatedUnion("step", [
  z.object({ slug: slugSchema, taskId: idSchema, step: z.literal("SCAN_ITEM"), scannedCode: scanCodeSchema, expectedVersion: versionSchema.optional() }).strict(),
  z.object({ slug: slugSchema, taskId: idSchema, step: z.literal("SCAN_TARGET"), scannedCode: scanCodeSchema, expectedVersion: versionSchema.optional() }).strict(),
  z.object({ slug: slugSchema, taskId: idSchema, step: z.literal("ENTER_QUANTITY"), quantity: z.string().min(1).max(32), expectedVersion: versionSchema.optional() }).strict(),
]);
const saveProgressSchema = z.object({ slug: slugSchema, taskId: idSchema, expectedVersion: versionSchema.optional() }).strict();
const nextTaskSchema = z.object({ slug: slugSchema, afterTaskId: idSchema.optional() }).strict();

async function writeContext(slug: string, permission: Permission, ctx: ActionContext) {
  const principal = ctx.principal;
  if (principal === null) throw new Error("unreachable: principal required");
  await limitVerifiedTenant({ db: getAppDb(), principal, tenantSlug: slug, permission }, ctx);
  return { db: getAppDb(), principal, tenantSlug: slug };
}

export async function claimTaskAction(raw: unknown) {
  return guardedAction({ schema: claimSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.view", ctx);
    const r = await claimTask(params, { taskId: input.taskId, expectedVersion: input.expectedVersion, requestId: ctx.requestId });
    return { version: r.version };
  })(raw);
}

export async function assignTaskAction(raw: unknown) {
  return guardedAction({ schema: assignSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", ctx);
    const r = await assignTask(params, { taskId: input.taskId, membershipId: input.membershipId, expectedVersion: input.expectedVersion, requestId: ctx.requestId });
    return { version: r.version };
  })(raw);
}

export async function cancelTaskAction(raw: unknown) {
  return guardedAction({ schema: cancelSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "document.approve", ctx);
    const r = await cancelTask(params, { taskId: input.taskId, expectedVersion: input.expectedVersion, reason: input.reason, requestId: ctx.requestId });
    return { version: r.version };
  })(raw);
}

const readContext = (slug: string, ctx: ActionContext) => {
  if (ctx.principal === null) throw new Error("unreachable: principal required");
  return { db: getAppDb(), principal: ctx.principal, tenantSlug: slug };
};

/** Görevin rehberli ilerlemesi (`stock.post`; yalnızca atanan üye). Geçersiz/eski ilerleme ilk adım olarak döner; görev `DONE` ise `taskStatus` söyler. */
export async function getTaskProgressAction(raw: unknown) {
  return guardedAction({ schema: progressReadSchema }, async (input, ctx) => getTaskProgress(readContext(input.slug, ctx), { taskId: input.taskId }))(raw);
}

/**
 * Okutulan kodu/miktarı doğrular ve adımı ilerletir (`stock.post`). Yanlış raf/ürün/miktar hata DEĞİL `accepted: false` sonucudur (beklenen + okunan değerle,
 * ilerleme değişmez); sıra dışı gönderim `VALIDATION_FAILED`/`DOCUMENT_STATE`, başkasının görevi `FORBIDDEN`, başka tenant `NOT_FOUND`.
 */
export async function recordTaskStepAction(raw: unknown) {
  return guardedAction({ schema: recordStepSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", ctx);
    const base = { taskId: input.taskId, step: input.step, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }) };
    const body = input.step === "ENTER_QUANTITY" ? { ...base, quantity: input.quantity } : { ...base, scannedCode: input.scannedCode };
    return recordTaskStep({ db: params.db, principal: params.principal, tenantSlug: params.tenantSlug }, body);
  })(raw);
}

/**
 * Kaydet adımına geçer ve `putaway`'i ilerlemede saklanan istemci anahtarıyla çağırır (ADR-018: yanıt kaybolursa AYNI çağrı tekrarlanır → tek defter etkisi).
 * Dönüş yalnızca stok komutu başarılıysa (görev `DONE`) gelir; hata → "Kaydedilemedi — Tekrar dene". İstemci anahtar/lokasyon/ürün/miktar göndermez.
 */
export async function saveTaskAction(raw: unknown) {
  return guardedAction({ schema: saveProgressSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", ctx);
    const r = await savePutawayTask(
      { db: params.db, principal: params.principal, tenantSlug: params.tenantSlug },
      { taskId: input.taskId, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }), requestId: ctx.requestId },
    );
    return { replayed: r.replayed, taskDone: true as const };
  })(raw);
}

/** Yalnızca Kaydet anahtarını ilerlemeye yazar (SAVING); stok değişmez. Yeniden gönderimde aynı anahtar. */
export async function beginSaveAction(raw: unknown) {
  return guardedAction({ schema: saveProgressSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", ctx);
    const r = await beginSave(params, { taskId: input.taskId, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }) });
    return { progress: r.progress };
  })(raw);
}

/** Baştan başla: ilerleme satırını siler (kaydedilemeyen iş için çıkış yolu). */
export async function resetTaskProgressAction(raw: unknown) {
  return guardedAction({ schema: progressReadSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", ctx);
    return resetTaskProgress(params, { taskId: input.taskId });
  })(raw);
}

/** Sıradaki görev (A-293-2): bana atanmış, aynı depo, önce aynı grup. Yoksa `task: null` ("Görevlerim"e dön). */
export async function nextTaskAction(raw: unknown) {
  return guardedAction({ schema: nextTaskSchema }, async (input, ctx) => {
    const params = await writeContext(input.slug, "stock.post", ctx);
    const task = await nextTaskFor(params, input.afterTaskId === undefined ? {} : { afterTaskId: input.afterTaskId });
    return { task };
  })(raw);
}
