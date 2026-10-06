import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ActivityList, Banner } from "@wms/ui";
import { AppError } from "@wms/shared/errors";
import { listMyActionsToday } from "@wms/domain/audit/today";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { TaskMenu } from "./task-menu.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home");
  return { title: t("title") };
}

// Tenant ana ekranı (T-122): "Merhaba <ad>, Ne yapmak istiyorsun?" + görev kartları. Üyelik/MFA/askı kararları
// `layout.tsx`'tedir (üye değil → 404, askıda → durum ekranı); burada yalnızca kendi üyeliğimiz özetlenir. Layout karar verdiyse
// çocuk çizilmez, bu yüzden "üyelik yok" durumunda sayfa sessizce boş döner (kendi 404'ünü üretmez).
export default async function TenantHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { getAuthService } = await import("../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(`/t/${slug}`)}`);
  const summary = await getMembershipSummary({ db: getAppDb(), principal });
  const current = summary.memberships.find((m) => m.slug === slug);
  if (current === undefined) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  // `now` ASLA verilmez (sunucu saati); yalnızca çağıranın kendi satırları, en çok 5. Bölüm düzeyinde yakalanır: bu liste
  // hata verirse ana ekran (görev kartları) düşmez; yalnızca kod anahtarlı nötr satır gösterilir.
  let today: Awaited<ReturnType<typeof listMyActionsToday>> | null = null;
  let todayError: string | null = null;
  try {
    today = await listMyActionsToday({ db: getAppDb(), principal, tenantSlug: slug }, { limit: 5 });
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND") notFound();
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(`/t/${slug}`)}`);
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(`/t/${slug}`)}`);
    }
    // Maskeli günlük: yalnızca sınıf adı ve kod (mesaj/SQL/parametre yok, G-09).
    console.error(JSON.stringify({ level: "error", msg: "home today list failed", error: e instanceof Error ? e.name : typeof e, code: e instanceof AppError ? e.code : undefined }));
    todayError = e instanceof AppError ? e.code : "INTERNAL";
  }
  const errKey = ["FORBIDDEN", "RATE_LIMITED", "TENANT_SUSPENDED", "TENANT_CLOSING", "VALIDATION_FAILED"].includes(todayError ?? "") ? (todayError as string).toLowerCase() : "internal";
  const ts = await getTranslations("serverErrors");
  const firstName = summary.userName.trim().split(/\s+/)[0] ?? summary.userName;

  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 px-4 py-6">
      <header className="flex min-w-0 flex-col gap-2">
        <p className="break-words text-xl font-semibold text-ink-muted">{t("home.greeting", { name: firstName })}</p>
        <h1 className="break-words text-4xl font-extrabold text-ink">{t("home.title")}</h1>
        <p className="max-w-2xl break-words text-lg text-ink">{t("home.intro")}</p>
      </header>
      <TaskMenu
        slug={slug}
        allowed={{
          usersManage: hasPermission(current.roles, "users.manage"),
          settingsManage: hasPermission(current.roles, "settings.manage"),
          auditView: hasPermission(current.roles, "audit.view"),
        }}
      />
      {today === null ? (
        <section aria-labelledby="today-title" className="flex flex-col gap-2 rounded-card bg-surface p-4 shadow-card">
          <h2 id="today-title" className="text-lg font-bold text-ink">
            {t("home.today.title")}
          </h2>
          <Banner kind="warning">
            <p>
              {ts(errKey)} {ts(`${errKey}Action`)}
            </p>
            <p className="mt-1 text-sm">{ts("code", { code: todayError ?? "INTERNAL" })}</p>
          </Banner>
        </section>
      ) : (
        <ActivityList
          title={t("home.today.title")}
          emptyText={t("home.today.empty")}
          items={today.items.map((it, i) => ({
            id: `${it.occurredAt.toISOString()}-${i}`,
            time: format.dateTime(it.occurredAt, { hour: "2-digit", minute: "2-digit", timeZone: today.timeZone }),
            dateTime: it.occurredAt.toISOString(),
            text: t(it.summaryKey),
          }))}
        />
      )}
    </main>
  );
}
