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
import { createProductionGuard } from "../../lib/action-guard.ts";

export interface OnboardingFormState {
  /** `AppError.code`; iç ayrıntı/SQL/slug varlığı bilgisi taşımaz. */
  readonly errorCode?: string;
}

export interface WizardDraft {
  readonly name: string;
  readonly requestId: string;
}

const DRAFT_COOKIE = "wms_onboarding";
const DRAFT_TTL_SECONDS = 60 * 30;
const NAME_MAX = 120; // domain `NAME_MAX` ile aynı; asıl doğrulama domain'dedir.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const guardedAction = createProductionGuard(() => headers());
const createSchema = z.object({ templateKey: z.string().min(1).max(64), name: z.string(), requestId: z.string() }).strict();

function validDraftName(name: string): boolean {
  const n = name.trim();
  return n !== "" && n.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(n);
}

/** Çerezdeki taslak; yok/bozuksa `null`. Yalnızca çağıranın kendi çerezini döndürür. */
export async function readWizardDraft(): Promise<WizardDraft | null> {
  const raw = (await cookies()).get(DRAFT_COOKIE)?.value;
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as { name?: unknown; requestId?: unknown };
    if (typeof v.name !== "string" || typeof v.requestId !== "string" || !validDraftName(v.name) || !UUID_RE.test(v.requestId)) return null;
    return { name: v.name.trim(), requestId: v.requestId };
  } catch {
    return null;
  }
}

/** Adım 1 (POST): adı çerezdeki taslağa yazar; mevcut `requestId` korunur, yoksa üretilir. */
export async function saveWorkspaceNameAction(form: FormData): Promise<void> {
  const raw = form.get("name");
  if (typeof raw !== "string" || !validDraftName(raw)) redirect("/onboarding?invalid=1");
  const existing = await readWizardDraft();
  const draft: WizardDraft = { name: raw.trim(), requestId: existing?.requestId ?? randomUUID() };
  (await cookies()).set(DRAFT_COOKIE, JSON.stringify(draft), {
    path: "/onboarding",
    maxAge: DRAFT_TTL_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
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
  (await cookies()).delete({ name: DRAFT_COOKIE, path: "/onboarding" });
  redirect(`/t/${result.data.slug}`);
}
