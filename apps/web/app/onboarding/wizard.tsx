"use client";
// Sihirbaz adım 2 (T-122): sektör seçimi, şablon önizlemesi ve "Oluştur". İş kuralı sunucuda (`createWorkspaceAction` →
// `createWorkspace`); burada yalnızca seçim, gizli alanlar ve sunucu hatasının (kod + sonraki eylem) gösterimi vardır.
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Banner, Button } from "@wms/ui";
import { createWorkspaceAction } from "./actions.ts";
import type { OnboardingFormState } from "./actions.ts";

export interface TemplatePreview {
  readonly key: string;
  /** [teknik anahtar, tenant terminolojisi etiketi] (şablon verisi; sunucuda okunur). */
  readonly terminology: readonly (readonly [string, string])[];
}

const KNOWN_ERRORS = ["forbidden", "unauthenticated", "validation_failed", "rate_limited", "not_found", "tenant_suspended", "tenant_closing", "internal"] as const;

export function Wizard({
  name,
  slug,
  requestId,
  templates,
  defaultTemplateKey,
  backHref,
}: {
  name: string;
  slug: string;
  requestId: string;
  templates: readonly TemplatePreview[];
  defaultTemplateKey: string;
  backHref: string;
}) {
  const t = useTranslations("onboarding");
  const te = useTranslations("serverErrors");
  const [state, formAction, pending] = useActionState<OnboardingFormState, FormData>(createWorkspaceAction, {});
  const [selected, setSelected] = useState(templates.some((x) => x.key === defaultTemplateKey) ? defaultTemplateKey : (templates[0]?.key ?? ""));
  const preview = templates.find((x) => x.key === selected);
  const code = state.errorCode;
  const errKey = code === undefined ? undefined : KNOWN_ERRORS.find((k) => k === code.toLowerCase());

  return (
    <form action={formAction} className="flex min-w-0 flex-col gap-4">
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="requestId" value={requestId} />
      <section className="flex min-w-0 flex-col gap-1 rounded-card bg-surface p-4 shadow-card">
        <p className="break-words text-xl font-bold text-ink">{name}</p>
        <p className="break-all text-base text-ink-muted">{t("step1.slugPreview", { slug })}</p>
        <p className="text-sm text-ink-muted">{t("step1.slugNote")}</p>
      </section>

      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-1 text-xl font-bold text-ink">{t("step2.title")}</legend>
        {templates.map((tpl) => (
          <label
            key={tpl.key}
            className="flex min-h-12 min-w-0 cursor-pointer items-start gap-3 rounded-card border-2 border-border bg-surface p-4 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus"
          >
            <input
              type="radio"
              name="templateKey"
              value={tpl.key}
              checked={selected === tpl.key}
              onChange={() => setSelected(tpl.key)}
              className="mt-1 size-6 shrink-0 accent-accent"
            />
            <span className="flex min-w-0 flex-col">
              <span className="break-words text-lg font-bold text-ink">{t(`step2.options.${tpl.key}`)}</span>
              <span className="break-words text-base text-ink-muted">{t(`step2.optionHints.${tpl.key}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {preview === undefined ? null : (
        <section aria-labelledby="preview-title" className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-4 shadow-card">
          <h2 id="preview-title" className="text-lg font-bold text-ink">
            {t("step2.previewTitle")}
          </h2>
          <p className="text-base font-semibold text-ink">{t("step2.previewTerms")}</p>
          <ul className="m-0 list-none p-0">
            {preview.terminology.map(([key, label]) => (
              <li key={key} className="break-words border-b border-border py-2 text-base text-ink last:border-b-0">
                {t("step2.previewTermRow", { key: t(`step2.terms.${key.replace(".", "_")}`), label })}
              </li>
            ))}
          </ul>
          <p className="text-base text-ink-muted">{t("step2.laterNote")}</p>
        </section>
      )}

      {code === undefined ? null : (
        <Banner kind="error">
          <p>
            {errKey === undefined ? te("unknown") : te(errKey)} {errKey === undefined ? te("unknownAction") : te(`${errKey}Action`)}
          </p>
          <p className="mt-1 text-sm">{te("code", { code })}</p>
        </Banner>
      )}

      <div className="flex flex-wrap gap-3">
        <Link
          href={backHref}
          className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border bg-surface px-6 text-base font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t("step2.back")}
        </Link>
        <Button type="submit" loading={pending}>
          {pending ? t("step2.creating") : t("step2.create")}
        </Button>
      </div>
    </form>
  );
}
