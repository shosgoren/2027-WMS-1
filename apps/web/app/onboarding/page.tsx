import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner, Button, TextField } from "@wms/ui";
import { TEMPLATE_KEYS, getTemplate } from "@wms/domain/onboarding/templates";
import { slugCandidates, workspaceCreationAllowed } from "@wms/domain/onboarding/workspace";
import { saveWorkspaceNameAction } from "./actions.ts";
import { NAME_MAX, readWizardDraft } from "./draft.ts";
import { Wizard } from "./wizard.tsx";
import type { TemplatePreview } from "./wizard.tsx";

// Çalışma alanı sihirbazı (T-122). Adım sunucu durumundadır: adım 1 POST eder, ad + `requestId` kısa ömürlü httpOnly çerezde
// (URL'de ad yok); çerez varsa adım 2, yoksa (ya da `?edit=1`) adım 1 çizilir: yenileme/geri kaldığı adımdan devam eder ve
// aynı `requestId`'yi taşır. Slug önizlemesi domain'in `slugCandidates` çıktısından sunucuda hesaplanır (istemcide kural yok).
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("onboarding");
  return { title: t("title") };
}


function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const SHELL = "mx-auto flex w-full max-w-xl min-w-0 flex-col gap-4 px-4 py-6";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { getAuthService } = await import("../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect("/login?next=%2Fonboarding");
  const t = await getTranslations("onboarding");

  // A-50 / m11: kayıt kapalıysa (staging/prod) ya da demo kullanıcısıysa sihirbaz açılmaz; sunucu da aynı kararı verir.
  if (!workspaceCreationAllowed(process.env) || principal.isDemo) {
    return (
      <main className={SHELL}>
        <h1 className="break-words text-3xl font-extrabold text-ink">{t("closed.title")}</h1>
        <Banner kind="info">
          <p>{t("closed.body")}</p>
          <p className="mt-1">{t("closed.action")}</p>
        </Banner>
        <div>
          <Link
            href="/login"
            className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-6 text-base font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t("closed.signIn")}
          </Link>
        </div>
      </main>
    );
  }

  const query = await searchParams;
  const draft = await readWizardDraft();
  const edit = first(query.edit) === "1";
  const invalid = first(query.invalid) === "1";
  const errorCode = ["FORBIDDEN", "UNAUTHENTICATED", "RATE_LIMITED", "INTERNAL"].find((c) => c === first(query.error))?.toLowerCase();
  const ts = await getTranslations("serverErrors");

  if (draft === null || edit) {
    return (
      <main className={SHELL}>
        <h1 className="break-words text-3xl font-extrabold text-ink">{t("title")}</h1>
        <p className="text-lg text-ink-muted">{t("intro")}</p>
        <p className="text-base font-semibold text-accent-ink">{t("stepOf", { current: 1, total: 2 })}</p>
        <form action={saveWorkspaceNameAction} className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card">
          <h2 className="text-xl font-bold text-ink">{t("step1.title")}</h2>
          <TextField
            label={t("step1.label")}
            hint={t("step1.hint")}
            name="name"
            defaultValue={draft?.name ?? ""}
            maxLength={NAME_MAX}
            required
            autoComplete="organization"
            error={invalid ? { reason: ts("validation_failed"), action: ts("validation_failedAction") } : undefined}
          />
          {errorCode === undefined ? null : (
            <Banner kind="error">
              {ts(errorCode)} {ts(`${errorCode}Action`)}
            </Banner>
          )}
          <Button type="submit">{t("step1.next")}</Button>
        </form>
      </main>
    );
  }

  const slug = slugCandidates(draft.name, draft.requestId)[0] ?? "";
  const templates: TemplatePreview[] = [];
  for (const key of TEMPLATE_KEYS) {
    const tpl = getTemplate(key);
    if (tpl !== undefined) templates.push({ key: tpl.key, terminology: Object.entries(tpl.terminology) });
  }

  return (
    <main className={SHELL}>
      <h1 className="break-words text-3xl font-extrabold text-ink">{t("title")}</h1>
      <p className="text-base font-semibold text-accent-ink">{t("stepOf", { current: 2, total: 2 })}</p>
      <Wizard name={draft.name} slug={slug} templates={templates} defaultTemplateKey="PACKAGING_SUPPLIES" backHref="/onboarding?edit=1" />
    </main>
  );
}
