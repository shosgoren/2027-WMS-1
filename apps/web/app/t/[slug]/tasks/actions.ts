"use server";
// Görev eylemleri (T-304). İnce giriş: yalnızca girdi doğrulama (zod) + domain komutu; yetki (A-132) ve durum kuralları domain'dedir.
// Üstlenme izni görev türüne bağlıdır → sarmalayıcı `stock.view`, tür izni domain'de denetlenir. Atama/iptal `document.approve`.
// Sayaç doğrulanmış tenant kimliğiyle tüketilir. Bu dosyada DB bağlantısı açılmaz (`getAppDb` yalnızca domain'e verilir).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import type { Permission } from "@wms/domain/identity/permissions";
import { assignTask, cancelTask, claimTask } from "@wms/domain/operations";
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
