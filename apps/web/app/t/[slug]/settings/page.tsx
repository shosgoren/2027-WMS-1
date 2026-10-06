import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner, Button, TextField } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getTenantSettings } from "@wms/domain/onboarding/settings-queries";
import { AppError } from "@wms/shared/errors";
import { TIME_ZONES } from "../../../../lib/timezones.ts";
import { saveSettingsAction } from "./actions.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("title") };
}

const SHOWN = ["FORBIDDEN", "UNAUTHENTICATED", "RATE_LIMITED", "VALIDATION_FAILED", "NOT_FOUND", "INTERNAL"];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Ayarlar (T-122): okuma `getTenantSettings` (settings.manage), yazma `saveSettingsAction`. Yetki yoksa form kilitli + açıklama.
// Yetki kararı sunucudadır; kilit yalnızca gösterimdir (eylem de aynı izni ister).
export default async function SettingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const query = await searchParams;
  const { getAuthService } = await import("../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(`/t/${slug}/settings`)}`);
  const t = await getTranslations("settings");
  const ts = await getTranslations("serverErrors");
  const home = `/t/${encodeURIComponent(slug)}`;

  let settings: Awaited<ReturnType<typeof getTenantSettings>> | null = null;
  try {
    settings = await getTenantSettings({ db: getAppDb(), principal, tenantSlug: slug });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if (e.code === "NOT_FOUND") notFound();
    if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(`/t/${slug}/settings`)}`);
    if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(`/t/${slug}/settings`)}`);
    if (e.code !== "FORBIDDEN") throw e;
  }

  const errorCode = SHOWN.find((c) => c === first(query.error))?.toLowerCase();
  const locked = settings === null;

  return (
    <main className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-4 px-4 py-6">
      <h1 className="break-words text-3xl font-extrabold text-ink">{t("title")}</h1>
      <p className="text-lg text-ink-muted">{t("intro")}</p>
      {locked ? (
        <Banner kind="info">
          <p>{t("locked")}</p>
          <p className="mt-1">{t("lockedAction")}</p>
        </Banner>
      ) : null}
      {first(query.saved) === "1" ? <Banner kind="info">{t("saved")}</Banner> : null}
      {first(query.unchanged) === "1" ? <Banner kind="info">{t("unchanged")}</Banner> : null}
      {errorCode === undefined ? null : (
        <Banner kind="error">
          <p>
            {ts(errorCode)} {ts(`${errorCode}Action`)}
          </p>
          <p className="mt-1 text-sm">{ts("code", { code: errorCode.toUpperCase() })}</p>
        </Banner>
      )}
      <form action={saveSettingsAction} className="flex min-w-0 flex-col gap-4 rounded-card bg-surface p-4 shadow-card">
        <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <input type="hidden" name="slug" value={slug} />
          <TextField label={t("name")} name="name" defaultValue={settings?.name ?? ""} maxLength={120} required />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="locale" className="text-base font-semibold text-ink">
              {t("locale")}
            </label>
            <select
              id="locale"
              name="locale"
              defaultValue={settings?.locale ?? "tr"}
              className="min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
            >
              <option value="tr">{t("localeTr")}</option>
              <option value="en">{t("localeEn")}</option>
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="timeZone" className="text-base font-semibold text-ink">
              {t("timeZone")}
            </label>
            <select
              id="timeZone"
              name="timeZone"
              defaultValue={settings?.timeZone ?? "Europe/Istanbul"}
              className="min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
            >
              {TIME_ZONES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
          {settings === null ? null : <p className="break-all text-sm text-ink-muted">{t("addressNote", { slug: settings.slug })}</p>}
          <Button type="submit">{t("save")}</Button>
        </fieldset>
      </form>
      <div>
        <Link
          href={home}
          className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-6 text-base font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t("back")}
        </Link>
      </div>
    </main>
  );
}
