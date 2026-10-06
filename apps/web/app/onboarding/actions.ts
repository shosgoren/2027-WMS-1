"use server";
// Onboarding sunucu eylemi (T-121): ince giriş katmanı. İş kuralı `packages/domain`'dedir; burada yalnızca form
// ayrıştırma, oturumlu kimlik ve yönlendirme vardır. `requestId` istemci formunda üretilir (gizli alan): çift tıklama
// ve yeniden gönderme aynı isteği taşır, ikinci tenant oluşmaz.
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuthService } from "@wms/auth";
import { createWorkspace, openAppDb } from "@wms/domain/onboarding/workspace";
import { AppError } from "@wms/shared/errors";

export interface OnboardingFormState {
  /** `AppError.code`; iç ayrıntı/SQL/slug varlığı bilgisi taşımaz. */
  readonly errorCode?: string;
}

const db = () => openAppDb(process.env.DATABASE_URL);

function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
}

export async function createWorkspaceAction(_prev: OnboardingFormState, form: FormData): Promise<OnboardingFormState> {
  const name = field(form, "name");
  const templateKey = field(form, "templateKey");
  const requestId = field(form, "requestId");
  const slug = field(form, "slug");
  if (name === undefined || templateKey === undefined || requestId === undefined) {
    return { errorCode: "VALIDATION_FAILED" };
  }
  let target: string;
  try {
    const principal = await getAuthService().getPrincipal(await headers());
    if (principal === null) return { errorCode: "UNAUTHENTICATED" };
    const result = await createWorkspace({
      db: db(),
      env: process.env,
      principal,
      name,
      slug: slug === undefined || slug.trim() === "" ? undefined : slug,
      templateKey,
      requestId,
    });
    target = `/t/${result.slug}`;
  } catch (e) {
    // Beklenen domain hataları kodla döner; diğerleri INTERNAL olarak yutulmadan yeniden fırlatılır (G-07).
    if (e instanceof AppError) return { errorCode: e.code };
    throw e;
  }
  redirect(target);
}
