import { cookies, headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Banner } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { runTenantQuery } from "@wms/domain/identity/access";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { AppError } from "@wms/shared/errors";
import { AppBar } from "./app-bar.tsx";
import { BottomNav } from "./bottom-nav.tsx";

export const dynamic = "force-dynamic";

const TOUCH = "min-h-12 min-w-12";

// Görünüm çerezi kök düzendeki `setView` ile aynı sözleşmeyi kullanır (`view`: flow | cockpit, 1 yıl); telefon menüsündeki anahtar
// bu eylemi çağırır. Kök düzenin eylemi dışa aktarılamaz (layout dosyası yalnızca varsayılan dışa aktarım taşır).
async function setView(formData: FormData): Promise<void> {
  "use server";
  const raw = String(formData.get("view") ?? "");
  const next = raw === "cockpit" ? "cockpit" : "flow";
  (await cookies()).set("view", next, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
}

// Tenant kabuğu (T-119): üyelik SUNUCUDA doğrulanır (üye değil → 404; varlık sızdırılmaz). Yetki kararı domain'dedir
// (`runTenantQuery`); burada yalnızca kullanıcı adı, aktif rol çipi ve tenant değiştirici gösterilir.
export default async function TenantLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { getAuthService } = await import("../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(`/t/${slug}/members`)}`);
  const db = getAppDb();

  try {
    await runTenantQuery({ db, principal, tenantSlug: slug, permission: "stock.view" }, () => Promise.resolve(true));
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND" || e.code === "FORBIDDEN") {
        // Zorunlu MFA: kurulum ekranına yönlendir (A-38); diğer ret nedenleri 404 (varlık sızdırılmaz).
        if (e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(`/t/${slug}/members`)}`);
        notFound();
      }
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(`/t/${slug}/members`)}`);
      if (e.code === "TENANT_SUSPENDED" || e.code === "TENANT_CLOSING") {
        // Sunucu bileşeni hataları üretimde maskelenir (yalnızca digest); kod `error.tsx`'e taşınamaz. Bu yüzden durum burada
        // kodla yakalanır ve çerçeveli bir durum olarak render edilir (çocuklar render edilmez).
        const te = await getTranslations("members.errors");
        const key = e.code.toLowerCase();
        return (
          <main className="mx-auto flex w-full max-w-md min-w-0 flex-col gap-4 px-4 py-6">
            <h1 className="break-words text-2xl font-extrabold text-ink">{te("tenantStatusTitle")}</h1>
            <Banner kind="warning">
              <p>
                {te(key)} {te(`${key}Action`)}
              </p>
              <p className="mt-1 text-sm">{te("code", { code: e.code })}</p>
            </Banner>
          </main>
        );
      }
    }
    throw e;
  }

  const summary = await getMembershipSummary({ db, principal });
  const current = summary.memberships.find((m) => m.slug === slug);
  if (current === undefined) notFound();
  const t = await getTranslations();
  const roleName = current.roles.map((r) => t(`roles.${r}`)).join(", ");
  const view = (await cookies()).get("view")?.value === "cockpit" ? "cockpit" : "flow";

  return (
    <div className="tenant-shell flex min-w-0 flex-col">
      <AppBar
        slug={slug}
        tenantName={current.tenantName}
        userName={summary.userName}
        view={view}
        setViewAction={setView}
        memberships={summary.memberships.map((m) => ({ slug: m.slug, tenantName: m.tenantName, rolesLabel: m.roles.map((r) => t(`roles.${r}`)).join(", ") }))}
      />
      <div className="desk-only flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2" data-testid="tenant-bar">
        <details className="relative min-w-0">
          <summary
            className={`${TOUCH} flex cursor-pointer list-none items-center gap-2 rounded-full bg-accent-soft px-4 text-sm font-bold text-accent-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus`}
            aria-label={t("tenantBar.switchTitle")}
          >
            <span className="min-w-0 truncate">{current.tenantName}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{t("tenantBar.roleChip", { role: roleName })}</span>
          </summary>
          <ul className="absolute left-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] list-none rounded-card border-2 border-border bg-surface p-2 shadow-card">
            {summary.memberships.map((m) => (
              <li key={m.slug}>
                <Link
                  href={`/t/${m.slug}/members`}
                  aria-current={m.slug === slug ? "page" : undefined}
                  className={`${TOUCH} flex flex-col justify-center rounded-card px-3 py-1 text-base font-semibold text-ink focus-visible:outline-3 focus-visible:outline-focus aria-[current=page]:bg-accent-soft`}
                >
                  <span className="break-words">{m.tenantName}</span>
                  <span className="text-sm font-normal text-ink-muted">
                    {m.roles.map((r) => t(`roles.${r}`)).join(", ")}
                    {m.slug === slug ? ` · ${t("tenantBar.current")}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
        <span className="min-w-0 truncate text-sm font-semibold text-ink-muted">{t("tenantBar.user", { name: summary.userName })}</span>
      </div>
      <div className="tenant-body flex min-w-0 flex-col">{children}</div>
      <BottomNav slug={slug} />
    </div>
  );
}
