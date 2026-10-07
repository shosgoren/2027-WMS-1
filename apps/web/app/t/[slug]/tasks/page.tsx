import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { getMembershipSummary, listMembers } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { TASK_KINDS, TASK_KIND_PERMISSION, TASK_STATUSES, listTasks, type TaskCursor, type TaskKind, type TaskStatus } from "@wms/domain/operations";
import { AppError } from "@wms/shared/errors";
import { TasksView } from "./tasks-view.tsx";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("tasks");
  return { title: t("title") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseCursor(raw: string | undefined): TaskCursor | undefined {
  if (raw === undefined || raw === "") return undefined;
  const i = raw.indexOf("~");
  return i < 0 ? { createdKey: raw, id: "" } : { createdKey: raw.slice(0, i), id: raw.slice(i + 1) };
}

// Yönetici görev listesi (T-304): sunucu bileşeni; veri `listTasks` (stock.view). Atama/iptal kararı yalnızca gösterim içindir
// (`document.approve`; eylem sunucuda yeniden denetler). Üye değil → 404; zorunlu MFA → kurulum; oturum yok → giriş.
export default async function TasksPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const kindRaw = first(sp.kind) ?? "";
  const statusRaw = first(sp.status) ?? "";
  const kind = (TASK_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as TaskKind) : undefined;
  const status = (TASK_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as TaskStatus) : undefined;
  const afterRaw = first(sp.after);
  const after = parseCursor(afterRaw);
  const { getAuthService } = await import("../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  const returnTo = `/t/${encodeURIComponent(slug)}/tasks`;
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };

  let canManage: boolean;
  let result: Awaited<ReturnType<typeof listTasks>>;
  let members: Awaited<ReturnType<typeof listMembers>>;
  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    canManage = hasPermission(current.roles, "document.approve");
    result = await listTasks(call, { ...(kind === undefined ? {} : { kind }), ...(status === undefined ? {} : { status }), ...(after === undefined ? {} : { after }), limit: PAGE_SIZE });
    members = await listMembers(call, { demoEmailDomain: process.env.DEMO_EMAIL_DOMAIN?.trim().toLowerCase() || null });
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
      // Geçersiz imleç kullanıcı hatasıdır: boş liste yerine 404.
      if (e.code === "VALIDATION_FAILED") notFound();
    }
    throw e;
  }

  const names = new Map(members.map((m) => [m.membershipId, m.displayName]));
  const filterQuery = new URLSearchParams({ ...(kind === undefined ? {} : { kind }), ...(status === undefined ? {} : { status }) });
  const nextHref =
    result.next === null
      ? null
      : `${returnTo}?${new URLSearchParams({ ...Object.fromEntries(filterQuery), after: `${result.next.createdKey}~${result.next.id}` }).toString()}`;

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <TasksView
        slug={slug}
        canManage={canManage}
        tasks={result.items.map((x) => ({
          id: x.id,
          kind: x.kind,
          status: x.status,
          version: x.version,
          quantity: x.quantity,
          assignedMembershipId: x.assignedMembershipId,
          assignedName: x.assignedMembershipId === null ? null : (names.get(x.assignedMembershipId) ?? null),
        }))}
        members={members.map((m) => ({
          membershipId: m.membershipId,
          displayName: m.displayName,
          kinds: TASK_KINDS.filter((k) => hasPermission(m.roles, TASK_KIND_PERMISSION[k])),
        }))}
        kindFilter={kind ?? ""}
        statusFilter={status ?? ""}
        nextHref={nextHref}
        firstPage={afterRaw === undefined || afterRaw === ""}
      />
    </main>
  );
}
