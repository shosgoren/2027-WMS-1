"use server";
// Onboarding sunucu eylemleri (T-121/T-122): ince giriş katmanı. İş kuralı `packages/domain`'dedir; burada form ayrıştırma,
// `createProductionGuard` (Origin + IP/kullanıcı hız sınırı + hata maskeleme) ve yönlendirme vardır.
// Sihirbaz taslağı (ad + `requestId`) kısa ömürlü httpOnly çerezdedir: ad URL'de taşınmaz; `requestId` sihirbaz boyunca
// sabittir (geri/yenile/çift tıklama aynı isteği taşır, ikinci tenant oluşmaz); başarıda çerez silinir.
import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createWorkspace } from "@wms/domain/onboarding/workspace";
import { getAppDb } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { createProductionGuard } from "../../lib/action-guard.ts";
import { DRAFT_COOKIE, DRAFT_COOKIE_PATH, DRAFT_TTL_SECONDS, readWizardDraft, validDraftName } from "./draft.ts";
import type { WizardDraft } from "./draft.ts";

export interface OnboardingFormState {
  /** `AppError.code`; iç ayrıntı/SQL/slug varlığı bilgisi taşımaz. */
  readonly errorCode?: string;
}

const guardedAction = createProductionGuard(() => headers());
const saveSchema = z.object({ name: z.string().max(1000) }).strict();
const createSchema = z.object({ templateKey: z.string().min(1).max(64), name: z.string(), requestId: z.string() }).strict();

/** Adım 1 (POST): adı çerezdeki taslağa yazar; mevcut `requestId` korunur, yoksa üretilir. Guard: Origin + hız sınırı. */
export async function saveWorkspaceNameAction(form: FormData): Promise<void> {
  const raw = form.get("name");
  const result = await guardedAction({ schema: saveSchema }, async (input) => {
    if (!validDraftName(input.name)) throw new AppError("VALIDATION_FAILED");
    const existing = await readWizardDraft();
    const draft: WizardDraft = { name: input.name.trim(), requestId: existing?.requestId ?? randomUUID() };
    (await cookies()).set(DRAFT_COOKIE, JSON.stringify(draft), {
      path: DRAFT_COOKIE_PATH,
      maxAge: DRAFT_TTL_SECONDS,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    return true;
  })({ name: typeof raw === "string" ? raw : "" });
  if (!result.ok) redirect(result.error.code === "VALIDATION_FAILED" ? "/onboarding?invalid=1" : `/onboarding?error=${encodeURIComponent(result.error.code)}`);
  redirect("/onboarding");
}

export async function createWorkspaceAction(_prev: OnboardingFormState, form: FormData): Promise<OnboardingFormState> {
  const templateKey = form.get("templateKey");
  const draft = await readWizardDraft();
  if (typeof templateKey !== "string" || draft === null) return { errorCode: "VALIDATION_FAILED" };
  const result = await guardedAction({ schema: createSchema }, async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new Error("unreachable: principal required");
    const created = await createWorkspace({
      db: getAppDb(),
      env: process.env,
      principal,
      name: input.name,
      templateKey: input.templateKey,
      requestId: input.requestId,
    });
    return { slug: created.slug };
  })({ templateKey, name: draft.name, requestId: draft.requestId });
  if (!result.ok) return { errorCode: result.error.code };
  (await cookies()).delete({ name: DRAFT_COOKIE, path: DRAFT_COOKIE_PATH });
  redirect(`/t/${result.data.slug}`);
}
