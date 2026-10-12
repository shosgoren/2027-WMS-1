import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Undo2 } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { RECENT_DOCUMENTS_MAX_LIMIT, listMyRecentDocuments, type RecentDocumentsResult } from "@wms/domain/stock";
import { AppError } from "@wms/shared/errors";
import { FlowShell, PrimaryLink } from "../receive/receive-flow.tsx";
import { UndoFlow } from "./undo-flow.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("undo");
  return { title: t("title") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// "Yanlış bir şey yaptım" (T-333): kendi son işlemlerin → biri seçilir → (istemci) tamamı/satır-miktar → gerekçe → onay. Okuma `listMyRecentDocuments`
// (`reversal.create`, depo kapsamlı); yazma yalnız `reverseDocument` eylemidir. `reversal.create` olmayan kullanıcı menüde bu işi kilitli görür; adres doğrudan
// açılırsa kilit + gerekçe. Başka tenant, başkasının belgesi ve kapsam dışı belge listede olmadığından hepsi aynı "kayıt bulunamadı" ekranını verir.
export default async function FieldUndoPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await getTranslations("undo");
  const format = await getFormatter();
  const base = `/t/${encodeURIComponent(slug)}/field/undo`;
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(base)}`);
  const db = getAppDb();
  const icon = <Undo2 aria-hidden="true" className="size-6" />;

  const summary = await getMembershipSummary({ db, principal });
  const current = summary.memberships.find((m) => m.slug === slug);
  if (current === undefined) notFound();
  if (!hasPermission(current.roles, "reversal.create")) {
    return (
      <FlowShell hue="teal" icon={icon} title={t("lockedTitle")} backHref={fieldHome} footer={<PrimaryLink href={fieldHome}>{t("toField")}</PrimaryLink>}>
        <p className="break-words text-lg text-ink" data-testid="undo-locked">
          {t("lockedReason")}
        </p>
      </FlowShell>
    );
  }

  let recent: RecentDocumentsResult;
  try {
    recent = await listMyRecentDocuments({ db, principal, tenantSlug: slug }, { limit: RECENT_DOCUMENTS_MAX_LIMIT });
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(base)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(base)}`);
    }
    throw e;
  }

  const docId = first(sp.doc);
  if (docId !== undefined && docId !== "") {
    const doc = recent.documents.find((d) => d.documentId === docId.toLowerCase());
    if (doc === undefined || doc.blocked !== null) {
      return (
        <FlowShell hue="teal" icon={icon} title={t("notFoundTitle")} backHref={base} footer={<PrimaryLink href={base}>{t("toList")}</PrimaryLink>}>
          <p className="break-words text-lg text-ink" data-testid="undo-not-found">
            {t("notFound")}
          </p>
        </FlowShell>
      );
    }
    return (
      <UndoFlow
        slug={slug}
        doc={{
          documentId: doc.documentId,
          number: doc.number ?? doc.documentId,
          lines: doc.lines.map((l) => ({ lineId: l.lineId, lineNo: l.lineNo, itemCode: l.itemCode, itemName: l.itemName, baseUnitCode: l.baseUnitCode, remaining: l.remaining })),
        }}
      />
    );
  }

  const rowCls =
    "flex min-h-16 min-w-0 flex-col justify-center gap-1 rounded-card border-2 border-border bg-surface p-3 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return (
    <FlowShell hue="teal" icon={icon} title={t("title")} instruction={t("pickInstruction")} backHref={fieldHome} footer={<PrimaryLink href={fieldHome}>{t("toField")}</PrimaryLink>}>
      {recent.documents.length === 0 ? (
        <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-4" data-testid="undo-empty">
          <h2 className="break-words text-xl font-bold text-ink">{t("emptyTitle")}</h2>
          <p className="break-words text-base text-ink-muted">{t("emptyBody")}</p>
        </section>
      ) : (
        <ul aria-label={t("title")} className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="undo-list">
          {recent.documents.map((d) => {
            const when = format.dateTime(d.createdAt, { dateStyle: "short", timeStyle: "short", timeZone: recent.timeZone });
            const body = (
              <>
                <span className="break-words text-lg font-bold text-ink">
                  {t(`kind.${d.kind}`)} · {d.number ?? ""}
                </span>
                <span className="text-sm text-ink-muted">
                  {when} · {t("lines", { count: d.lines.length })}
                </span>
                {d.blocked === null ? null : <span className="text-sm font-semibold text-danger-ink">{t(`blocked.${d.blocked}`)}</span>}
              </>
            );
            return (
              <li key={d.documentId} className="flex min-w-0">
                {d.blocked === null ? (
                  <Link href={`${base}?doc=${encodeURIComponent(d.documentId)}`} className={`${rowCls} w-full`} data-testid="undo-pick" data-document-id={d.documentId}>
                    {body}
                  </Link>
                ) : (
                  <div role="group" aria-disabled="true" tabIndex={0} className={`${rowCls} w-full bg-locked-bg`} data-testid="undo-blocked" data-document-id={d.documentId}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </FlowShell>
  );
}
