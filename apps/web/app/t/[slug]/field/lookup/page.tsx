import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MapPinned } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { AppError } from "@wms/shared/errors";
import { FlowShell, PrimaryLink } from "../receive/receive-flow.tsx";
import { LookupFlow } from "./lookup-flow.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("stockLookup");
  return { title: t("pageTitle") };
}

// Saha stok sorgusu (T-332b). Üyelik özeti sayfada çözülür: üye olmayan / başka tenant / var olmayan slug aynı 404'tür. Okuma izni `stock.view` (domain eylemlerde yeniden denetler);
// burada yalnızca yetkisizlere kilit ekranı gösterilir (kural yeniden yazılmaz).
export default async function FieldLookupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await getTranslations("stockLookup");
  const tr = await getTranslations("receiving");
  const base = `/t/${encodeURIComponent(slug)}/field/lookup`;
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(base)}`);
  let summary;
  try {
    summary = await getMembershipSummary({ db: getAppDb(), principal });
  } catch (e) {
    if (e instanceof AppError && e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(base)}`);
    if (e instanceof AppError && e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(base)}`);
    throw e;
  }
  const current = summary.memberships.find((m) => m.slug === slug);
  if (current === undefined) notFound();
  if (!hasPermission(current.roles, "stock.view")) {
    return (
      <FlowShell hue="teal" icon={<MapPinned aria-hidden="true" className="size-6" />} title={t("lockedTitle")} backHref={fieldHome} footer={<PrimaryLink href={fieldHome}>{tr("flow.toField")}</PrimaryLink>}>
        <p className="break-words text-lg text-ink" data-testid="lookup-locked">
          {t("lockedReason")}
        </p>
        <Link href="/help" className="flex min-h-12 w-fit items-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus">
          {tr("flow.helpCall")}
        </Link>
      </FlowShell>
    );
  }
  return <LookupFlow slug={slug} />;
}
