import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MapPinned } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getItem } from "@wms/domain/catalog";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { TASK_LIST_LIMIT_MAX, getLocationBrief, listMyTasks, type TaskCursor, type TaskRow } from "@wms/domain/operations";
import { listWarehouses } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { FlowShell, PrimaryLink } from "../receive/receive-flow.tsx";
import { PutawayFlow, type PutawayTask } from "./putaway-flow.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("receiving");
  return { title: t("putaway.title") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Saha yerleştirme (T-313): `?task=<id>` ile PUTAWAY görevinden, yoksa serbest. Görev `listMyTasks` (stock.view; bana atanmış + üstlenilebilir) içinde aranır:
// başkasının/olmayan görev bulunamaz (varlık sızmaz). Yazma `stock.post`; kurallar `putaway` komutundadır.
export default async function FieldPutawayPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await getTranslations("receiving");
  const base = `/t/${encodeURIComponent(slug)}/field/putaway`;
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const tasksHref = `${fieldHome}/tasks`;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(base)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };
  const icon = <MapPinned aria-hidden="true" className="size-6" />;
  const message = (title: string, body: string, href: string, label: string) => (
    <FlowShell hue="teal" icon={icon} step={1} total={4} title={title} backHref={href} footer={<PrimaryLink href={href}>{label}</PrimaryLink>}>
      <p className="break-words text-lg text-ink" data-testid="putaway-message">
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
  const roles = current.roles;
  if (!hasPermission(roles, "stock.post")) return message(t("flow.lockedTitle"), t("flow.lockedReason"), fieldHome, t("flow.toField"));

  const taskId = first(sp.task);
  if (taskId !== undefined && taskId !== "") {
    let found: TaskRow | undefined;
    try {
      let after: TaskCursor | undefined;
      for (let i = 0; i < 5 && found === undefined; i++) {
        const page = await listMyTasks(call, { limit: TASK_LIST_LIMIT_MAX, ...(after === undefined ? {} : { after }) });
        found = page.items.find((x) => x.id === taskId);
        if (page.next === null) break;
        after = page.next;
      }
    } catch (e) {
      guard(e);
    }
    const usable = found !== undefined && (found.kind === "PUTAWAY" || found.kind === "REPUTAWAY") && found.itemId !== null && found.locationId !== null && found.quantity !== null;
    if (found === undefined || !usable || found.itemId === null || found.locationId === null || found.quantity === null) {
      return message(t("putaway.taskGoneTitle"), t("putaway.taskGone"), tasksHref, t("putaway.backToTasks"));
    }
    try {
      const [item, loc] = await Promise.all([getItem(call, { itemId: found.itemId }), getLocationBrief(call, { locationId: found.locationId })]);
      const task: PutawayTask = { id: found.id, itemId: item.id, itemName: item.name, itemCode: item.code, quantity: found.quantity, sourceId: loc.id, sourceCode: loc.code };
      return <PutawayFlow slug={slug} warehouseId={found.warehouseId} task={task} />;
    } catch (e) {
      if (e instanceof AppError && e.code === "NOT_FOUND") return message(t("putaway.taskGoneTitle"), t("putaway.taskGone"), tasksHref, t("putaway.backToTasks"));
      return guard(e);
    }
  }

  // Serbest başlat: depo `?wh=` ile ya da tek etkin depo; birden çoksa seçim listesi.
  let warehouses: { id: string; code: string; name: string }[] = [];
  try {
    warehouses = (await listWarehouses(call)).items.filter((w) => w.status === "ACTIVE").map((w) => ({ id: w.id, code: w.code, name: w.name }));
  } catch (e) {
    guard(e);
  }
  const wh = first(sp.wh);
  const chosen = warehouses.length === 1 ? warehouses[0] : warehouses.find((w) => w.id === wh);
  if (chosen !== undefined) return <PutawayFlow slug={slug} warehouseId={chosen.id} task={null} />;
  if (warehouses.length === 0) return message(t("putaway.noWarehouseTitle"), t("putaway.noWarehouse"), fieldHome, t("flow.toField"));
  return (
    <FlowShell hue="teal" icon={icon} step={1} total={5} title={t("putaway.warehouseTitle")} instruction={t("putaway.warehouseInstruction")} backHref={fieldHome} footer={<PrimaryLink href={tasksHref}>{t("putaway.toTasks")}</PrimaryLink>}>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label={t("putaway.warehouseTitle")}>
        {warehouses.map((w) => (
          <li key={w.id} className="flex min-w-0">
            <Link
              href={`${base}?wh=${encodeURIComponent(w.id)}`}
              className="flex min-h-16 w-full min-w-0 flex-col justify-center rounded-card border-2 border-border bg-surface p-3 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <span className="break-words text-lg font-bold text-ink">{w.name}</span>
              <span className="text-sm text-ink-muted">{w.code}</span>
            </Link>
          </li>
        ))}
      </ul>
    </FlowShell>
  );
}
