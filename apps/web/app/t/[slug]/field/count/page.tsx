import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ClipboardCheck } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { getCountSession, listCountSessions } from "@wms/domain/operations";
import { AppError } from "@wms/shared/errors";
import { FlowShell, PrimaryLink } from "../receive/receive-flow.tsx";
import { CountFlow } from "./count-flow.tsx";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("counting");
  return { title: t("flow.title") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Saha kör sayım (T-316): `?session=<id>` ile, yoksa sürmekte olan (COUNTING) oturum; birden çoksa seçim listesi. Sayfa YALNIZ `field` kipini okur (T-316a): referans (sistem)
// miktarı ve fark RSC yüküne hiç girmez. Yazma `document.create`; yetkisizde kilit + gerekçe + yardım yolu (R-14). Sahaya açılma T-334'e bağlıdır (ana ekran bağlantısı T-331).
export default async function FieldCountPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await getTranslations("counting");
  const base = `/t/${encodeURIComponent(slug)}/field/count`;
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(base)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };
  const icon = <ClipboardCheck aria-hidden="true" className="size-6" />;
  const message = (title: string, body: string, href: string, label: string, help = false) => (
    <FlowShell hue="teal" icon={icon} title={title} backHref={href} footer={<PrimaryLink href={href}>{label}</PrimaryLink>}>
      <p className="break-words text-lg text-ink" data-testid="count-message">
        {body}
      </p>
      {help ? (
        <Link
          href="/help"
          data-testid="help-link"
          className="flex min-h-12 w-fit items-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t("helpCall")}
        </Link>
      ) : null}
    </FlowShell>
  );
  const guard = (e: unknown): never => {
    if (e instanceof AppError) {
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(base)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(base)}`);
    }
    throw e;
  };

  const summary = await getMembershipSummary({ db, principal });
  const current = summary.memberships.find((m) => m.slug === slug);
  if (current === undefined) notFound();
  if (!hasPermission(current.roles, "document.create")) return message(t("flow.lockedTitle"), t("flow.lockedReason"), fieldHome, t("flow.toField"), true);

  let sessionId = first(sp.session);
  if (sessionId !== undefined && sessionId !== "" && !UUID_RE.test(sessionId)) sessionId = "";
  if (sessionId === undefined || sessionId === "") {
    let page: Awaited<ReturnType<typeof listCountSessions>>;
    try {
      page = await listCountSessions(call, { status: "COUNTING", limit: 30 });
    } catch (e) {
      return guard(e);
    }
    if (page.items.length === 0) return message(t("flow.noneOpenTitle"), t("flow.noneOpen"), fieldHome, t("flow.toField"));
    const only = page.items.length === 1 ? page.items[0] : undefined;
    if (only === undefined) {
      return (
        <FlowShell hue="teal" icon={icon} title={t("flow.pickTitle")} instruction={t("flow.pickInstruction")} backHref={fieldHome} footer={<PrimaryLink href={fieldHome}>{t("flow.toField")}</PrimaryLink>}>
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label={t("flow.pickTitle")}>
            {page.items.map((s) => (
              <li key={s.id} className="flex min-w-0">
                <Link
                  href={`${base}?session=${encodeURIComponent(s.id)}`}
                  className="flex min-h-16 w-full min-w-0 flex-col justify-center rounded-card border-2 border-border bg-surface p-3 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <span className="break-words text-lg font-bold text-ink">{s.warehouseName}</span>
                  <span className="text-sm text-ink-muted">{t("list.locations", { n: s.locationCount })}</span>
                </Link>
              </li>
            ))}
          </ul>
        </FlowShell>
      );
    }
    sessionId = only.id;
  }

  try {
    const d = await getCountSession(call, { sessionId, view: "field" });
    if (d.session.status !== "COUNTING") return message(t("flow.closedTitle"), t("flow.closed"), fieldHome, t("flow.toField"));
    // Açık beyaz liste: referans/fark alanı tipte de yoktur; istemciye yalnızca ekranın kullandığı alanlar gider.
    return (
      <CountFlow
        slug={slug}
        sessionId={d.session.id}
        warehouseId={d.session.warehouseId}
        initialLocations={d.locations.map((l) => ({ id: l.id, code: l.code, name: l.name, locked: l.locked }))}
        initialLines={d.lines.map((l) => ({ id: l.id, locationId: l.locationId, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, unitName: l.unitName || l.unitCode, quantityScale: l.quantityScale, stockStatus: l.stockStatus, counted: l.counted }))}
      />
    );
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") return message(t("flow.goneTitle"), t("flow.gone"), fieldHome, t("flow.toField"));
    return guard(e);
  }
}
