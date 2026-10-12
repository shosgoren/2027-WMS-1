import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { getMembershipSummary, listMembers } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { listSalesOrders, SALES_ORDER_STATUSES, type SalesOrderCursor, type SalesOrderStatus } from "@wms/domain/operations";
import { AppError } from "@wms/shared/errors";
import { OrdersView } from "./order-form.tsx";

export const dynamic = "force-dynamic";

// Sayfalı liste (≤30 satır/sayfa, keyset; OFFSET yok). Sıra eskiden yeniye (A-314a-3): en eski açık sipariş üstte.
const PAGE_SIZE = 30;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("orders");
  return { title: t("title") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
function parseCursor(raw: string | undefined): SalesOrderCursor | undefined {
  if (raw === undefined || raw === "") return undefined;
  const i = raw.indexOf("~");
  return i < 0 ? { createdKey: raw, id: "" } : { createdKey: raw.slice(0, i), id: raw.slice(i + 1) };
}

// Masaüstü "Siparişler" (T-314): sunucu bileşeni; veri `listSalesOrders` (stock.view, keyset, depo kapsamı). Oluşturma (`document.create`) ve görevlendirme
// (`document.approve`) kararı yalnızca gösterimdir; eylem sunucuda yeniden denetler. Okuma izni yoksa kilit + gerekçe gösterilir (FORBIDDEN ekranı yok).
// Üye değil → 404; MFA → kurulum; oturum yok → giriş.
export default async function OrdersPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const rawStatus = first(sp.status);
  const statusFilter: SalesOrderStatus | "ALL" = rawStatus === "ALL" ? "ALL" : (SALES_ORDER_STATUSES as readonly string[]).includes(rawStatus ?? "") ? (rawStatus as SalesOrderStatus) : "OPEN";
  const after = parseCursor(first(sp.after));
  const returnTo = `/t/${encodeURIComponent(slug)}/orders`;
  const { getAuthService } = await import("../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };
  const t = await getTranslations("orders");

  let roles: readonly string[];
  let page: Awaited<ReturnType<typeof listSalesOrders>> | null = null;
  let members: Awaited<ReturnType<typeof listMembers>> = [];
  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    roles = current.roles;
    try {
      page = await listSalesOrders(call, { limit: PAGE_SIZE, ...(statusFilter === "ALL" ? {} : { status: statusFilter }), ...(after === undefined ? {} : { afterKey: after }) });
      members = await listMembers(call, { demoEmailDomain: process.env.DEMO_EMAIL_DOMAIN?.trim().toLowerCase() || null });
    } catch (e) {
      // Okuma izni yok (stock.view): kilit + gerekçe gösterilir; MFA / oturum aşağıda yönlendirilir.
      if (!(e instanceof AppError && e.code === "FORBIDDEN" && e.detail !== "MFA_REQUIRED")) throw e;
    }
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND" || e.code === "VALIDATION_FAILED") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
    }
    throw e;
  }

  const nextHref =
    page === null || page.next === null ? null : `${returnTo}?${new URLSearchParams({ status: statusFilter, after: `${page.next.createdKey}~${page.next.id}` }).toString()}`;
  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-3xl font-extrabold text-ink">{t("title")}</h1>
        <p className="break-words text-lg text-ink">{t("intro")}</p>
        <Link
          href={`/t/${encodeURIComponent(slug)}`}
          className="inline-flex min-h-12 w-fit items-center text-base font-bold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t("backHome")}
        </Link>
      </header>
      {page === null ? (
        <p className="flex min-w-0 items-start gap-2 rounded-card border-2 border-border bg-surface p-4 text-base text-ink" data-testid="view-locked">
          {t("viewLocked")}
        </p>
      ) : (
        <OrdersView
          slug={slug}
          orders={page.items}
          nextHref={nextHref}
          statusFilter={statusFilter}
          // Atanabilir kişi = görev türü izni (`stock.post`) olanlar; depo kapsamı ve izin domain'de yeniden denetlenir (reddedilirse neden + eylem gösterilir).
          assignees={members.filter((m) => hasPermission(m.roles, "stock.post")).map((m) => ({ membershipId: m.membershipId, displayName: m.displayName }))}
          canCreate={hasPermission(roles, "document.create")}
          canApprove={hasPermission(roles, "document.approve")}
        />
      )}
    </main>
  );
}
