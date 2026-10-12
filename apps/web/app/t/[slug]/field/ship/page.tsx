import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Truck } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { getSalesOrder, listSalesOrders, type SalesOrderCursor, type SalesOrderDetail } from "@wms/domain/operations";
import { AppError } from "@wms/shared/errors";
import { FlowShell, PrimaryLink } from "../receive/receive-flow.tsx";
import { ShipFlow } from "./ship-flow.tsx";

export const dynamic = "force-dynamic";

// Her sayfada en çok bu kadar açık sipariş taranır (ayrıntı okuması sipariş başınadır); fazlası "Sonraki siparişler" bağlantısıyla.
const SCAN_SIZE = 20;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shipping");
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
/** Toplanmış (SEVK'te) miktarı sıfırdan büyük satırı var mı: ondalık dizgide sıfır olmayan rakam = pozitif (negatif olamaz). */
const hasPicked = (o: SalesOrderDetail): boolean => o.lines.some((l) => /[1-9]/.test(l.picked));

// Saha sevk (T-315): `?order=<id>` ile seçilen siparişin toplanmış satırları sevk edilir; yoksa SEVK'te toplanmış miktarı olan açık siparişler listelenir.
// Okuma `listSalesOrders`/`getSalesOrder` (stock.view, depo kapsamı domain'de); yazma yalnız `shipOrderAction` (`stock.post`). Başka tenant / kapsam dışı / olmayan
// sipariş aynı "sipariş bulunamadı" ekranını verir. Sıra eskiden yeniye (A-314a-3).
export default async function FieldShipPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await getTranslations("shipping");
  const base = `/t/${encodeURIComponent(slug)}/field/ship`;
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(base)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };
  const icon = <Truck aria-hidden="true" className="size-6" />;
  const message = (title: string, body: string, href: string, label: string) => (
    <FlowShell hue="teal" icon={icon} title={title} backHref={href} footer={<PrimaryLink href={href}>{label}</PrimaryLink>}>
      <p className="break-words text-lg text-ink" data-testid="ship-message">
        {body}
      </p>
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
  if (!hasPermission(current.roles, "stock.post")) return message(t("lockedTitle"), t("lockedReason"), fieldHome, t("toField"));

  const orderId = first(sp.order);
  if (orderId !== undefined && orderId !== "") {
    let order: SalesOrderDetail;
    try {
      order = await getSalesOrder(call, { orderId });
    } catch (e) {
      if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION_FAILED")) return message(t("notFoundTitle"), t("notFound"), base, t("toList"));
      return guard(e);
    }
    const lines = order.lines.filter((l) => /[1-9]/.test(l.picked));
    if (order.status !== "OPEN" || lines.length === 0) return message(t("nothingTitle"), t("nothingBody"), base, t("toList"));
    return (
      <ShipFlow
        slug={slug}
        order={{
          id: order.id,
          number: order.number,
          lines: lines.map((l) => ({ id: l.id, lineNo: l.lineNo, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, unitCode: l.unitCode, picked: l.picked })),
        }}
      />
    );
  }

  let ready: SalesOrderDetail[] = [];
  let next: SalesOrderCursor | null = null;
  try {
    const after = parseCursor(first(sp.after));
    const page = await listSalesOrders(call, { status: "OPEN", limit: SCAN_SIZE, ...(after === undefined ? {} : { afterKey: after }) });
    next = page.next;
    const details = await Promise.all(page.items.filter((o) => o.openLineCount > 0).map((o) => getSalesOrder(call, { orderId: o.id })));
    ready = details.filter(hasPicked);
  } catch (e) {
    if (e instanceof AppError && e.code === "VALIDATION_FAILED") return message(t("notFoundTitle"), t("badCursor"), base, t("toList"));
    guard(e);
  }
  const nextHref = next === null ? null : `${base}?${new URLSearchParams({ after: `${next.createdKey}~${next.id}` }).toString()}`;
  const rowCls =
    "flex min-h-16 min-w-0 flex-col justify-center gap-1 rounded-card border-2 border-border bg-surface p-3 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return (
    <FlowShell hue="teal" icon={icon} title={t("title")} instruction={t("pickInstruction")} backHref={fieldHome} footer={<PrimaryLink href={fieldHome}>{t("toField")}</PrimaryLink>}>
      {ready.length === 0 ? (
        <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-4" data-testid="ship-empty">
          <h2 className="break-words text-xl font-bold text-ink">{t("emptyTitle")}</h2>
          <p className="break-words text-base text-ink-muted">{t("emptyBody")}</p>
        </section>
      ) : (
        <ul aria-label={t("title")} className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="ship-orders">
          {ready.map((o) => (
            <li key={o.id} className="flex min-w-0">
              <Link href={`${base}?order=${encodeURIComponent(o.id)}`} className={`${rowCls} w-full`} data-testid="ship-pick" data-order-id={o.id}>
                <span className="break-words text-lg font-bold text-ink">{o.number}</span>
                <span className="break-words text-sm text-ink-muted">
                  {o.customerRef === null ? "" : `${o.customerRef} · `}
                  {t("readyLines", { count: o.lines.filter((l) => /[1-9]/.test(l.picked)).length })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {nextHref === null ? null : (
        <Link href={nextHref} className={`${rowCls} items-center text-center text-base font-bold text-ink`} data-testid="ship-more">
          {t("moreOrders")}
        </Link>
      )}
    </FlowShell>
  );
}
