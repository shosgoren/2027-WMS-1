import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { TASK_KINDS, listMyTasks, type TaskCursor, type TaskKind } from "@wms/domain/operations";
import { AppError } from "@wms/shared/errors";
import { claimTaskAction } from "../../tasks/actions.ts";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const ERROR_KEYS = ["forbidden", "unauthenticated", "not_found", "validation_failed", "validation_failed_document_state", "version_conflict", "rate_limited", "tenant_suspended", "tenant_closing", "internal"];
const BTN =
  "flex min-h-12 min-w-12 w-full items-center justify-center rounded-control px-4 text-base font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("tasks.field");
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

// "Görevlerim" (T-304): sunucu bileşeni, 375 px tek sütun. "Üstlen" sunucu eylemidir (`claimTaskAction`: yetki ve sürüm denetimi domain'de);
// hata `?error=` ile geri gösterilir. "Başla": ilgili akış ekranı (T-313…T-316) gelene kadar KİLİTLİ + açıklama (sahte bağlantı yok, G-07).
export default async function FieldTasksPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const afterRaw = first(sp.after);
  const errorRaw = first(sp.error) ?? "";
  const t = await getTranslations("tasks");
  const te = await getTranslations("tasks.errors");
  const base = `/t/${encodeURIComponent(slug)}/field/tasks`;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(base)}`);

  let page: Awaited<ReturnType<typeof listMyTasks>>;
  const after = parseCursor(afterRaw);
  try {
    page = await listMyTasks({ db: getAppDb(), principal, tenantSlug: slug }, { limit: PAGE_SIZE, ...(after === undefined ? {} : { after }) });
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND" || e.code === "VALIDATION_FAILED") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(base)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(base)}`);
    }
    throw e;
  }

  async function claim(formData: FormData) {
    "use server";
    const res = await claimTaskAction({ slug, taskId: String(formData.get("taskId") ?? ""), expectedVersion: Number(formData.get("version")) });
    if (res.ok) redirect(`${base}?claimed=1`);
    const key = res.error.code.toLowerCase() === "validation_failed" && res.error.detail === "DOCUMENT_STATE" ? "validation_failed_document_state" : res.error.code.toLowerCase();
    redirect(`${base}?error=${encodeURIComponent(key)}`);
  }

  const errorKey = errorRaw === "" ? null : ERROR_KEYS.includes(errorRaw) ? errorRaw : "internal";
  const kindOf = (k: TaskKind) => ((TASK_KINDS as readonly string[]).includes(k) ? t(`kind.${k}`) : k);

  return (
    <main className="flex w-full min-w-0 flex-col gap-4 px-4 py-4">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-3xl font-extrabold text-ink">{t("field.title")}</h1>
        <p className="break-words text-lg text-ink">{t("field.intro")}</p>
      </header>
      {first(sp.claimed) === "1" ? (
        <p role="status" className="rounded-card bg-success-bg px-4 py-3 text-base font-semibold text-success-ink">
          {t("field.claimed")}
        </p>
      ) : null}
      {errorKey === null ? null : (
        <p role="alert" className="rounded-card bg-danger-bg px-4 py-3 text-base font-semibold text-danger-ink">
          {te(errorKey)} {te(`${errorKey}Action`)}
        </p>
      )}
      {page.items.length === 0 ? (
        <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-4">
          <h2 className="break-words text-xl font-bold text-ink">{t("field.empty.title")}</h2>
          <p className="break-words text-base text-ink-muted">{t("field.empty.action")}</p>
        </section>
      ) : (
        <ul aria-label={t("field.listLabel")} className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
          {page.items.map((task) => (
            <li key={task.id} data-testid="field-task" data-task-id={task.id} className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="break-words text-xl font-bold text-ink">{kindOf(task.kind)}</h2>
                <span className="inline-flex items-center rounded-full bg-accent-soft px-2 text-xs font-bold text-accent-ink">
                  {task.status === "ASSIGNED" ? t("field.mine") : t("field.available")}
                </span>
              </div>
              {task.quantity === null ? null : <p className="break-words text-base text-ink-muted">{t("quantity", { quantity: task.quantity })}</p>}
              {task.status === "OPEN" ? (
                <form action={claim}>
                  <input type="hidden" name="taskId" value={task.id} />
                  <input type="hidden" name="version" value={task.version} />
                  <button type="submit" className={`${BTN} bg-accent text-on-accent`}>
                    {t("field.claim")}
                  </button>
                </form>
              ) : (
                <>
                  <button type="button" disabled aria-describedby={`start-${task.id}`} className={`${BTN} border-2 border-border-strong bg-surface text-ink opacity-60`}>
                    {t("field.start")}
                  </button>
                  <p id={`start-${task.id}`} className="break-words text-sm text-ink-muted">
                    {t("field.startLocked")}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {page.next === null ? null : (
        <Link
          href={`${base}?after=${encodeURIComponent(`${page.next.createdKey}~${page.next.id}`)}`}
          className={`${BTN} border-2 border-border-strong bg-surface text-ink`}
        >
          {t("field.more")}
        </Link>
      )}
    </main>
  );
}
