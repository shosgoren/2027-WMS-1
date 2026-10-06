import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { getAppDb } from "@wms/db";
import { runTenantQuery } from "@wms/domain/identity/access";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { AppError } from "@wms/shared/errors";

export const dynamic = "force-dynamic";

const TOUCH = "min-h-12 min-w-12";

// Tenant kabuğu (T-119): üyelik SUNUCUDA doğrulanır (üye değil → 404; varlık sızdırılmaz). Yetki kararı domain'dedir
// (`runTenantQuery`); burada yalnızca kullanıcı adı, aktif rol çipi ve tenant değiştirici gösterilir.
export default async function TenantLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { getAuthService } = await import("@wms/auth");
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
    }
    throw e;
  }

  const summary = await getMembershipSummary({ db, principal });
  const current = summary.memberships.find((m) => m.slug === slug);
  if (current === undefined) notFound();
  const t = await getTranslations();
  const roleName = current.roles.map((r) => t(`roles.${r}`)).join(", ");

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2" data-testid="tenant-bar">
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
      {children}
    </div>
  );
}
