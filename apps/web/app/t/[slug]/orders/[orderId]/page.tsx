import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { getSalesOrder } from "@wms/domain/operations";
import { AppError } from "@wms/shared/errors";
import { OrderDetailView } from "../order-form.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("orders");
  return { title: t("detail.title") };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK = "inline-flex min-h-12 w-fit items-center text-base font-bold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

// Sipariş ayrıntısı (T-314): satır başına istenen / tahsisli / toplanan / sevk / açık / iade / iptal (`getSalesOrder`, stock.view). Okunamayan sipariş (yok, başka depo,
// ya da yeni oluşturulup henüz tahsis edilmemiş ve kullanıcı depo kapsamlı — A-314a-2) 404'e DÜŞÜRÜLMEZ: neden + sonraki eylem gösterilir. Okuma izni yoksa kilit + gerekçe.
export default async function OrderDetailPage({ params, searchParams }: { params: Promise<{ slug: string; orderId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug, orderId } = await params;
  const sp = await searchParams;
  const createdParam = Array.isArray(sp.created) ? sp.created[0] : sp.created;
  const returnTo = `/t/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderId)}`;
  if (!UUID_RE.test(orderId)) notFound();
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const db = getAppDb();
  const t = await getTranslations("orders");

  let roles: readonly string[];
  let order: Awaited<ReturnType<typeof getSalesOrder>> | null = null;
  let problem: "hidden" | "locked" | null = null;
  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    roles = current.roles;
    try {
      order = await getSalesOrder({ db, principal, tenantSlug: slug }, { orderId });
    } catch (e) {
      if (e instanceof AppError && e.code === "NOT_FOUND") problem = "hidden";
      else if (e instanceof AppError && e.code === "FORBIDDEN" && e.detail !== "MFA_REQUIRED") problem = "locked";
      else throw e;
    }
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND" || e.code === "VALIDATION_FAILED") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
    }
    throw e;
  }

  const list = `/t/${encodeURIComponent(slug)}/orders`;
  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-3xl font-extrabold text-ink">{t("detail.title")}</h1>
        <Link href={list} className={LINK}>
          {t("detail.back")}
        </Link>
      </header>
      {order !== null ? (
        <OrderDetailView slug={slug} order={order} canApprove={hasPermission(roles, "document.approve")} justCreated={createdParam === "1"} />
      ) : (
        <section className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4" data-testid={problem === "locked" ? "detail-locked" : "detail-hidden"}>
          <h2 className="text-xl font-bold text-ink">{t(problem === "locked" ? "detail.lockedTitle" : "detail.hiddenTitle")}</h2>
          <p className="text-base text-ink">{t(problem === "locked" ? "detail.lockedReason" : createdParam === "1" ? "detail.hiddenCreated" : "detail.hiddenReason")}</p>
          <p className="text-base font-semibold text-ink">{t(problem === "locked" ? "detail.lockedAction" : "detail.hiddenAction")}</p>
        </section>
      )}
    </main>
  );
}
