import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { ROLE_KEYS } from "@wms/domain/identity/permissions";
import { workspaceCreationAllowed } from "@wms/domain/onboarding/workspace";
import { demoLoginStatus, demoSignInAction } from "./demo-actions.ts";

// Landing (T-122). Oturumlu kullanıcı çalışma alanına ya da `/onboarding`'e gider. Ortam bayrakları istek anında okunur.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("productName") };
}

const BUTTON =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-control px-6 text-base font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Sunucu hata kodları (yalnızca bu liste sorgu dizgesinden okunur; keyfi metin basılmaz). */
const SHOWN_CODES = ["FORBIDDEN", "UNAUTHENTICATED", "RATE_LIMITED", "VALIDATION_FAILED", "INTERNAL"] as const;
type ShownCode = (typeof SHOWN_CODES)[number];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Form eylemi (JS gerektirmez): rol anahtarı `demoSignInAction`'a gider; başarıda oturum çerezleri kurulmuş olur.
 * Eylemin kendisi (demo-actions.ts) bayrak, rol listesi, Origin ve hız sınırı kararlarını verir; burada yalnızca yönlendirme.
 */
async function demoEnter(formData: FormData): Promise<void> {
  "use server";
  const result = await demoSignInAction({ role: String(formData.get("role") ?? "") });
  if (result.ok) redirect("/");
  redirect(`/?demoError=${encodeURIComponent(result.error.code)}`);
}

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { getAuthService } = await import("@wms/auth");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal !== null) {
    // "Son çalışma alanı" kaydı yok (kart dışı); ada göre ilk aktif üyelik. Üyelik yoksa kurulum sihirbazı.
    const summary = await getMembershipSummary({ db: getAppDb(), principal });
    const target = summary.memberships[0];
    redirect(target === undefined ? "/onboarding" : `/t/${target.slug}`);
  }

  const t = await getTranslations();
  // A-43: demo yalnızca sunucuda karar verilir; bayraklar yokken bant ve düğmeler HİÇ render edilmez (login ile aynı koşul).
  const demoState = await demoLoginStatus();
  const demo = demoState !== "disabled";
  // A-50 / m11: `SIGNUP_ENABLED` yalnızca local|ci'da etkindir; staging/prod'da düğme çıkmaz.
  const signup = workspaceCreationAllowed(process.env);
  const rawError = first((await searchParams).demoError);
  const demoError = SHOWN_CODES.find((c): c is ShownCode => c === rawError);

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 px-4 py-8">
      {demo ? <Banner kind="warning">{t("auth.login.demoBanner")}</Banner> : null}
      <section className="flex min-w-0 flex-col gap-3">
        <h1 className="break-words text-4xl font-extrabold text-ink">{t("shell.productName")}</h1>
        <p className="break-words text-xl text-ink">{t("landing.valueProp")}</p>
      </section>
      <nav aria-label={t("landing.actions")} className="flex flex-wrap gap-3">
        <Link href="/login" className={`${BUTTON} bg-accent text-on-accent`}>
          {t("landing.signIn")}
        </Link>
        {signup ? (
          <Link href="/onboarding" className={`${BUTTON} border-2 border-border bg-surface text-ink`}>
            {t("landing.createWorkspace")}
          </Link>
        ) : null}
      </nav>
      {demo ? (
        <section aria-labelledby="demo-heading" className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
          <h2 id="demo-heading" className="text-xl font-bold text-ink">
            {t("landing.demo.heading")}
          </h2>
          <p className="text-base text-ink-muted">{t("landing.demo.intro")}</p>
          {demoState === "misconfigured" ? (
            <Banner kind="warning">
              <p>{t("landing.demo.unavailable")}</p>
              <p className="mt-1">{t("landing.demo.unavailableAction")}</p>
            </Banner>
          ) : null}
          {demoError === undefined ? null : (
            <Banner kind="error">
              <p>{demoError === "RATE_LIMITED" ? `${t("serverErrors.rate_limited")} ${t("serverErrors.rate_limitedAction")}` : `${t("landing.demo.failed")} ${t("landing.demo.failedAction")}`}</p>
              <p className="mt-1 text-sm">{t("serverErrors.code", { code: demoError })}</p>
            </Banner>
          )}
          <form action={demoEnter} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ROLE_KEYS.map((role) => (
              <button
                key={role}
                type="submit"
                name="role"
                value={role}
                disabled={demoState !== "ready"}
                className={`${BUTTON} cursor-pointer border-2 border-border bg-surface text-ink disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {t("landing.demo.enter", { role: t(`roles.${role}`) })}
              </button>
            ))}
          </form>
        </section>
      ) : null}
    </main>
  );
}
