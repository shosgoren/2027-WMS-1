"use server";
// Ayarlar kaydı (T-122): ince giriş katmanı. Kural `updateTenantSettings`'tedir (T-121; settings.manage, audit);
// burada `createProductionGuard` (Origin + hız sınırı + hata maskeleme), tenant sayacı ve yönlendirme vardır.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppDb } from "@wms/db";
import { updateTenantSettings } from "@wms/domain/onboarding/workspace";
import { TIME_ZONES } from "../../../../lib/timezones.ts";
import { createProductionGuard, limitVerifiedTenant } from "../../../../lib/action-guard.ts";

const guardedAction = createProductionGuard(() => headers());
const schema = z
  .object({ slug: z.string().min(1).max(63), name: z.string().max(500), locale: z.string().max(16), timeZone: z.enum(TIME_ZONES) })
  .strict();

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

export async function saveSettingsAction(form: FormData): Promise<void> {
  const slug = field(form, "slug");
  const result = await guardedAction({ schema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const db = getAppDb();
    await limitVerifiedTenant({ db, principal, tenantSlug: input.slug, permission: "settings.manage" }, ctx);
    return updateTenantSettings(db, input.slug, principal, { name: input.name, locale: input.locale, timeZone: input.timeZone });
  })({ slug, name: field(form, "name"), locale: field(form, "locale"), timeZone: field(form, "timeZone") });
  const base = `/t/${encodeURIComponent(slug)}/settings`;
  if (!result.ok) redirect(`${base}?error=${encodeURIComponent(result.error.code)}`);
  redirect(`${base}?${result.data.changed ? "saved=1" : "unchanged=1"}`);
}
