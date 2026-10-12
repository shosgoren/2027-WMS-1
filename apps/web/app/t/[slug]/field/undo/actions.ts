"use server";
// "Yanlış bir şey yaptım" eylemi (T-333). İnce giriş: yalnızca girdi doğrulama (zod) + `reverseDocument` (stok yalnız oradan değişir, G-01).
// Yetki (`reversal.create`), kalan miktar, bağımlı işlem ve kaynak bağlantısı kuralları domain'dedir; burada yeniden yazılmaz.
// Miktarlar DİZGİ olarak iletilir (I-09). `clientKey` (UUID) zorunludur: anahtar yaşam döngüsü istemcidedir (`useKeyHolder`, T-229 deseni);
// aynı anahtar aynı içerikle yeniden gönderilirse domain saklı sonucu döner (ADR-018).
import { headers } from "next/headers";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import { reverseDocument } from "@wms/domain/stock";
import { createProductionGuard, limitVerifiedTenant } from "../../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());

const reverseSchema = z
  .object({
    slug: z.string().min(1).max(63),
    clientKey: z.string().uuid(),
    documentId: z.string().uuid(),
    lines: z.union([
      z.literal("ALL"),
      z.array(z.object({ lineId: z.string().uuid(), quantity: z.string().min(1).max(32) }).strict()).min(1).max(200),
    ]),
    reason: z.string().min(1).max(500),
  })
  .strict();

/** Seçilen belgeyi ters kayıtla düzeltir (`reversal.create`): tamamı (`"ALL"`) ya da satır/miktar; gerekçe zorunlu. */
export async function reverseDocumentAction(raw: unknown) {
  return guardedAction({ schema: reverseSchema }, async (input, ctx) => {
    if (ctx.principal === null) throw new Error("unreachable: principal required");
    const principal = ctx.principal;
    await limitVerifiedTenant({ db: getAppDb(), principal, tenantSlug: input.slug, permission: "reversal.create" }, ctx);
    const r = await reverseDocument(
      { db: getAppDb(), principal, tenantSlug: input.slug, clientKey: input.clientKey },
      { documentId: input.documentId, lines: input.lines, reason: input.reason, requestId: ctx.requestId },
    );
    return { replayed: r.replayed, reversalNumber: (r.documentNumber as string | null | undefined) ?? null };
  })(raw);
}
