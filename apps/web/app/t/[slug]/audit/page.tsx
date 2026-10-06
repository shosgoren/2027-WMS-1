import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { AUDIT_ACTIONS, getAppDb } from "@wms/db";
import { listAudit, type AuditFilters, type AuditPage } from "@wms/domain/audit/audit-query";
import { AppError } from "@wms/shared/errors";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auditLog");
  return { title: t("title") };
}

const SHOWN = ["forbidden", "recent_auth_required", "rate_limited", "validation_failed", "internal"] as const;
const LINK_CLS =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border bg-surface px-6 text-base font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const FIELD_CLS =
  "min-h-12 w-full min-w-0 rounded-card border-2 border-border bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? undefined : s;
}

// Denetim kaydı (T-126): `audit.view`; yetki kararı sunucudadır (listAudit). Yetkisiz kullanıcı kilit açıklaması görür, veri görmez.
export default async function AuditPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const query = await searchParams;
  const here = `/t/${encodeURIComponent(slug)}/audit`;
  const { getAuthService } = await import("@wms/auth");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(here)}`);
  const t = await getTranslations("auditLog");
  const ts = await getTranslations("serverErrors");

  const filters: { from?: string; to?: string; action?: string } = {};
  for (const k of ["from", "to", "action"] as const) {
    const v = first(query[k]);
    if (v !== undefined) filters[k] = v;
  }
  const cursor = first(query.cursor);

  let page: AuditPage | null = null;
  let errorCode: string | undefined = SHOWN.find((c) => c === first(query.error));
  let locked = false;
  try {
    page = await listAudit({ db: getAppDb(), principal, tenantSlug: slug }, { filters: filters as AuditFilters, ...(cursor === undefined ? {} : { cursor }) });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if (e.code === "NOT_FOUND") notFound();
    if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(here)}`);
    if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(here)}`);
    if (e.code === "FORBIDDEN") locked = true;
    else if (e.code === "VALIDATION_FAILED") errorCode = "validation_failed";
    else throw e;
  }

  const qs = (extra: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v !== undefined) p.set(k, v);
    const s = p.toString();
    return s === "" ? "" : `?${s}`;
  };
  const exportHref = `/api/t/${encodeURIComponent(slug)}/audit/export${qs({})}`;
  const fmt = (d: Date): string =>
    new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "medium", timeZone: page?.timeZone ?? "UTC" }).format(d);
  const actionName = (a: string, known: boolean): string => (known ? t(`actions.${a}`) : t("actions.other"));

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <h1 className="break-words text-3xl font-extrabold text-ink">{t("title")}</h1>
      <p className="text-lg text-ink-muted">{t("intro")}</p>
      {locked ? (
        <Banner kind="info">
          <p>{t("locked")}</p>
          <p className="mt-1">{t("lockedAction")}</p>
        </Banner>
      ) : null}
      {errorCode === undefined ? null : (
        <Banner kind="error">
          <p>
            {errorCode === "recent_auth_required" ? t("recentAuth") : ts(errorCode)} {errorCode === "recent_auth_required" ? t("recentAuthAction") : ts(`${errorCode}Action`)}
          </p>
          {errorCode === "recent_auth_required" ? (
            <a className={`${LINK_CLS} mt-2`} href={`/login?next=${encodeURIComponent(here)}`}>
              {t("loginLink")}
            </a>
          ) : null}
          <p className="mt-1 text-sm">{ts("code", { code: errorCode.toUpperCase() })}</p>
        </Banner>
      )}
      {locked ? null : (
        <>
          <form method="get" className="grid min-w-0 grid-cols-1 gap-3 rounded-card bg-surface p-4 shadow-card sm:grid-cols-4 sm:items-end">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="from" className="text-base font-semibold text-ink">{t("from")}</label>
              <input id="from" name="from" type="date" defaultValue={filters.from ?? ""} className={FIELD_CLS} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="to" className="text-base font-semibold text-ink">{t("to")}</label>
              <input id="to" name="to" type="date" defaultValue={filters.to ?? ""} className={FIELD_CLS} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="action" className="text-base font-semibold text-ink">{t("action")}</label>
              <select id="action" name="action" defaultValue={filters.action ?? ""} className={FIELD_CLS}>
                <option value="">{t("allActions")}</option>
                {AUDIT_ACTIONS.map((a) => (
                  <option key={a} value={a}>{t(`actions.${a}`)}</option>
                ))}
              </select>
            </div>
            <button type="submit" className={LINK_CLS}>{t("filter")}</button>
          </form>
          <div>
            <a href={exportHref} className={LINK_CLS}>{t("export")}</a>
            <p className="mt-1 text-sm text-ink-muted">{t("exportNote")}</p>
          </div>
          {page === null || page.items.length === 0 ? (
            page === null ? null : <p className="text-lg text-ink">{t("empty")}</p>
          ) : (
            <>
              <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0 md:hidden" aria-label={t("title")}>
                {page.items.map((r) => (
                  <li key={r.id} className="flex min-w-0 flex-col gap-1 rounded-card bg-surface p-4 shadow-card">
                    <span className="text-sm text-ink-muted">{fmt(r.occurredAt)}</span>
                    <span className="break-words text-lg font-bold text-ink">{actionName(r.action, r.actionKnown)}</span>
                    <span className="break-words text-base text-ink">{r.actorName ?? t("system")}</span>
                    {r.entityType === null ? null : <span className="break-all text-sm text-ink-muted">{r.entityType}{r.entityId === null ? "" : ` · ${r.entityId}`}</span>}
                    {r.reason === null ? null : <span className="break-words text-sm text-ink">{r.reason}</span>}
                  </li>
                ))}
              </ul>
              <div className="hidden min-w-0 overflow-x-auto rounded-card bg-surface shadow-card md:block">
                <table className="w-full min-w-0 border-collapse text-left text-base text-ink">
                  <thead>
                    <tr className="border-b-2 border-border">
                      <th scope="col" className="p-3">{t("colDate")}</th>
                      <th scope="col" className="p-3">{t("colPerson")}</th>
                      <th scope="col" className="p-3">{t("colAction")}</th>
                      <th scope="col" className="p-3">{t("colRecord")}</th>
                      <th scope="col" className="p-3">{t("colReason")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((r) => (
                      <tr key={r.id} className="border-b border-border align-top">
                        <td className="p-3">{fmt(r.occurredAt)}</td>
                        <td className="break-words p-3">{r.actorName ?? t("system")}</td>
                        <td className="break-words p-3">{actionName(r.action, r.actionKnown)}</td>
                        <td className="break-all p-3 text-sm">{r.entityType === null ? "" : `${r.entityType}${r.entityId === null ? "" : ` · ${r.entityId}`}`}</td>
                        <td className="break-words p-3">{r.reason ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {page.nextCursor === null ? null : (
                <div>
                  <Link href={`${here}${qs({ cursor: page.nextCursor })}`} className={LINK_CLS}>{t("more")}</Link>
                </div>
              )}
            </>
          )}
        </>
      )}
      <div>
        <Link href={`/t/${encodeURIComponent(slug)}`} className={LINK_CLS}>{t("back")}</Link>
      </div>
    </main>
  );
}
