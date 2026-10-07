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
import { TASK_LIST_LIMIT_MAX, listMyTasks } from "@wms/domain/operations";
import { TaskMenu, type MyTasksSummary } from "./task-menu.tsx";

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
  // Saha rolleri (yönetim yetkisi olmayanlar) için "Görevlerim" özeti: mevcut domain sorgusu (`listMyTasks`: tenant bağlamı, `stock.view`,
  // depo kapsamı domain'de). Sayım yalnız BANA ATANMIŞ (ASSIGNED) görevlerdir; liste tek sayfaya sığmazsa "n+" gösterilir. Hata bu bölümle
  // sınırlıdır (ana ekran düşmez): sunucu hatası + kod gösterilir.
  let myTasks: MyTasksSummary | undefined;
  if (!hasPermission(current.roles, "users.manage")) {
    try {
      const mine = await listMyTasks({ db: getAppDb(), principal, tenantSlug: slug }, { limit: TASK_LIST_LIMIT_MAX });
      myTasks = { kind: "count", count: mine.items.filter((x) => x.status === "ASSIGNED").length, more: mine.next !== null };
    } catch (e) {
      if (e instanceof AppError) {
        if (e.code === "NOT_FOUND") notFound();
        if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(`/t/${slug}`)}`);
        if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(`/t/${slug}`)}`);
      }
      console.error(JSON.stringify({ level: "error", msg: "home my tasks failed", error: e instanceof Error ? e.name : typeof e, code: e instanceof AppError ? e.code : undefined }));
      const code = e instanceof AppError ? e.code : "INTERNAL";
      const key = ["FORBIDDEN", "RATE_LIMITED", "TENANT_SUSPENDED", "TENANT_CLOSING", "VALIDATION_FAILED"].includes(code) ? code.toLowerCase() : "internal";
      myTasks = { kind: "error", message: `${ts(key)} ${ts(`${key}Action`)}`, code: ts("code", { code }) };
    }
  }
  const firstName = summary.userName.trim().split(/\s+/)[0] ?? summary.userName;

  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 px-4 py-6 phone:min-h-0 phone:flex-1 phone:gap-2 phone:px-3 phone:pb-2 phone:pt-1">
      {/* Telefonda iki kısa satır (selam + soru); açıklama paragrafı yalnız geniş ekranda (T-254, T-270). */}
      <header className="flex min-w-0 flex-col gap-2 phone:gap-0">
        <p className="break-words text-xl font-semibold text-ink-muted phone:text-sm">{t("home.greeting", { name: firstName })}</p>
        <h1 className="break-words text-4xl font-extrabold text-ink phone:text-xl">{t("home.title")}</h1>
        <p className="desk-only max-w-2xl basis-full break-words text-lg text-ink">{t("home.intro")}</p>
      </header>
      <TaskMenu
        slug={slug}
        myTasks={myTasks}
        allowed={{
          usersManage: hasPermission(current.roles, "users.manage"),
          settingsManage: hasPermission(current.roles, "settings.manage"),
          auditView: hasPermission(current.roles, "audit.view"),
          stockView: hasPermission(current.roles, "stock.view"),
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
        <div className="desk-only flex min-w-0 flex-col">
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
        </div>
      )}
    </main>
  );
}
