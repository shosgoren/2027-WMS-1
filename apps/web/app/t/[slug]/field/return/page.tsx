import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Undo2 } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { getSalesOrder, listSalesOrders, type SalesOrderCursor, type SalesOrderDetail, type SalesOrderLineView } from "@wms/domain/operations";
import { AppError } from "@wms/shared/errors";
import { FlowShell, PrimaryLink } from "../receive/receive-flow.tsx";
import { ReturnFlow } from "./return-flow.tsx";

export const dynamic = "force-dynamic";

// Her sayfada en çok bu kadar sipariş taranır (ayrıntı okuması sipariş başınadır); fazlası "Sonraki siparişler" bağlantısıyla.
const SCAN_SIZE = 20;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("returns");
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
/** "x.yyyyyy" → 1e-6 ölçekli tam sayı (float yok, I-09). Biçim bozuksa 0. */
function microOf(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  return m === null ? 0n : BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}
/** Gösterim için iade edilebilir miktar (sevk − iade); asıl üst sınır `createCustomerReturn` komutundadır. */
function returnableOf(l: SalesOrderLineView): bigint {
  const r = microOf(l.shipped) - microOf(l.returned);
  return r > 0n ? r : 0n;
}
function dec(m: bigint): string {
  return `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
}
const returnableLines = (o: SalesOrderDetail): SalesOrderLineView[] => o.lines.filter((l) => returnableOf(l) > 0n);

// Saha müşteri iadesi (T-315): `?order=<id>` ile seçilen siparişin sevk edilmiş satırı iade edilir; yoksa iade edilebilir (sevk − iade > 0) satırı olan siparişler listelenir
// (kapanmış sipariş dahil; iade siparişi yeniden açmaz, kural 6). Okuma `listSalesOrders`/`getSalesOrder` (stock.view); yazma yalnız `createCustomerReturnAction` (`stock.post`).
export default async function FieldReturnPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await getTranslations("returns");
  const base = `/t/${encodeURIComponent(slug)}/field/return`;
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(base)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };
  const icon = <Undo2 aria-hidden="true" className="size-6" />;
  const message = (title: string, body: string, href: string, label: string) => (
    <FlowShell hue="teal" icon={icon} title={title} backHref={href} footer={<PrimaryLink href={href}>{label}</PrimaryLink>}>
      <p className="break-words text-lg text-ink" data-testid="return-message">
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
    const lines = returnableLines(order);
    if (lines.length === 0) return message(t("nothingTitle"), t("nothingBody"), base, t("toList"));
    return (
      <ReturnFlow
        slug={slug}
        order={{
          id: order.id,
          number: order.number,
          lines: lines.map((l) => ({ id: l.id, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, unitCode: l.unitCode, returnable: dec(returnableOf(l)) })),
        }}
      />
    );
  }

  let candidates: SalesOrderDetail[] = [];
  let next: SalesOrderCursor | null = null;
  try {
    const after = parseCursor(first(sp.after));
    const page = await listSalesOrders(call, { limit: SCAN_SIZE, ...(after === undefined ? {} : { afterKey: after }) });
    next = page.next;
    const details = await Promise.all(page.items.filter((o) => o.status !== "CANCELLED").map((o) => getSalesOrder(call, { orderId: o.id })));
    candidates = details.filter((o) => returnableLines(o).length > 0);
  } catch (e) {
    if (e instanceof AppError && e.code === "VALIDATION_FAILED") return message(t("notFoundTitle"), t("badCursor"), base, t("toList"));
    guard(e);
  }
  const nextHref = next === null ? null : `${base}?${new URLSearchParams({ after: `${next.createdKey}~${next.id}` }).toString()}`;
  const rowCls =
    "flex min-h-16 min-w-0 flex-col justify-center gap-1 rounded-card border-2 border-border bg-surface p-3 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return (
    <FlowShell hue="teal" icon={icon} title={t("title")} instruction={t("pickInstruction")} backHref={fieldHome} footer={<PrimaryLink href={fieldHome}>{t("toField")}</PrimaryLink>}>
      {candidates.length === 0 ? (
        <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-4" data-testid="return-empty">
          <h2 className="break-words text-xl font-bold text-ink">{t("emptyTitle")}</h2>
          <p className="break-words text-base text-ink-muted">{t("emptyBody")}</p>
        </section>
      ) : (
        <ul aria-label={t("title")} className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="return-orders">
          {candidates.map((o) => (
            <li key={o.id} className="flex min-w-0">
              <Link href={`${base}?order=${encodeURIComponent(o.id)}`} className={`${rowCls} w-full`} data-testid="return-pick" data-order-id={o.id}>
                <span className="break-words text-lg font-bold text-ink">{o.number}</span>
                <span className="break-words text-sm text-ink-muted">
                  {o.customerRef === null ? "" : `${o.customerRef} · `}
                  {t("returnableLines", { count: returnableLines(o).length })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {nextHref === null ? null : (
        <Link href={nextHref} className={`${rowCls} items-center text-center text-base font-bold text-ink`} data-testid="return-more">
          {t("moreOrders")}
        </Link>
      )}
    </FlowShell>
  );
}
