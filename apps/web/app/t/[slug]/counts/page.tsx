import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ClipboardCheck, EmptyState, Lock, TriangleAlert } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { getCountSession, listCountSessions, listTasks, type CountSessionCursor } from "@wms/domain/operations";
import { listWarehouses } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { StatusBadge } from "./[id]/count-review.tsx";
import { StartCountForm } from "./start-count-form.tsx";

export const dynamic = "force-dynamic";

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
// Sunucu bileşeninde "use client" modülünden sabit alınamaz (istemci başvurusu olur): sınıf dizgisi burada yereldir.
const LINK_BTN = `inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink ${FOCUS}`;

// Kapanmış oturumda raf sayısı 0 dönebilir (kilit serbest, satırsız; T-316a `locationCount` tanımı): yanıltıcı "0 raf" gösterilmez.
// Terk edilmiş oturumlar listenin üstündedir (sayfa içi sıralama; keyset sırası değişmez).
// Sayfalı liste (≤30 satır/sayfa, keyset; R-11 deseni: sanallaştırma kütüphanesi kurulu değil, 200+ satırlık tek sayfa gerekince takip kartı).
const PAGE_SIZE = 30;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("counting");
  return { title: t("title") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
function parseCursor(raw: string | undefined): CountSessionCursor | undefined {
  if (raw === undefined || raw === "") return undefined;
  const i = raw.indexOf("~");
  return i < 0 ? { startedAt: raw, id: "" } : { startedAt: raw.slice(0, i), id: raw.slice(i + 1) };
}

// Masaüstü "Sayımlar" (T-316): sunucu bileşeni; veri `listCountSessions` (stock.view, keyset). Başlatma kararı yalnızca gösterimdir (`document.approve`);
// sunucu yeniden denetler. Üye değil → 404; MFA → kurulum; oturum yok → giriş.
export default async function CountsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const after = parseCursor(first(sp.after));
  const returnTo = `/t/${encodeURIComponent(slug)}/counts`;
  const { getAuthService } = await import("../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };
  const t = await getTranslations("counting");
  const format = await getFormatter();

  const codesBySession = new Map<string, string[]>();
  const lockedIds = new Set<string>();
  let roles: readonly string[];
  let page: Awaited<ReturnType<typeof listCountSessions>>;
  let warehouses: Awaited<ReturnType<typeof listWarehouses>>;
  let tasks: Awaited<ReturnType<typeof listTasks>>;
  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    roles = current.roles;
    page = await listCountSessions(call, { limit: PAGE_SIZE, ...(after === undefined ? {} : { afterKey: after }) });
    warehouses = await listWarehouses(call);
    tasks = await listTasks(call, { kind: "COUNT", status: "OPEN", limit: 50 });
    // Sayımda olan raflar (açık oturumların kilitli lokasyonları; `field` kipi, miktar yok): raf seçicide işaretlenir, listede kodlarıyla gösterilir.
    for (const s of page.items.filter((x) => x.status === "COUNTING")) {
      const d = await getCountSession(call, { sessionId: s.id, view: "field" });
      codesBySession.set(s.id, d.locations.filter((l) => l.locked).map((l) => l.code));
      for (const l of d.locations) if (l.locked) lockedIds.add(l.id);
    }
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND" || e.code === "VALIDATION_FAILED") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
    }
    throw e;
  }

  const base = `/t/${encodeURIComponent(slug)}`;
  const nextHref = page.next === null ? null : `${returnTo}?${new URLSearchParams({ after: `${page.next.startedAt}~${page.next.id}` }).toString()}`;
  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-3xl font-extrabold text-ink">{t("title")}</h1>
        <p className="break-words text-lg text-ink">{t("intro")}</p>
        <Link href={base} className="inline-flex min-h-12 w-fit items-center text-base font-bold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus">
          {t("backHome")}
        </Link>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <section aria-labelledby="counts-list" className="flex min-w-0 flex-col gap-3">
          <h2 id="counts-list" className="text-xl font-bold text-ink">
            {t("list.title")}
          </h2>
          {page.items.length === 0 ? (
            <EmptyState icon={<ClipboardCheck aria-hidden="true" className="size-6" />} title={t("list.empty")} description={t("list.emptyAction")} />
          ) : (
            <ul aria-label={t("list.title")} className="m-0 flex list-none flex-col gap-3 p-0" data-testid="count-list">
              {[...page.items].sort((a, b) => Number(b.abandoned) - Number(a.abandoned)).map((s) => (
                <li key={s.id} data-testid="count-row" data-session-id={s.id} className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <h3 className="break-words text-lg font-bold text-ink">{s.warehouseName}</h3>
                    <StatusBadge status={s.status} />
                  </div>
                  <p className="break-words text-base text-ink">
                    {s.locationCount > 0 ? `${t("list.locations", { n: s.locationCount })} · ` : ""}
                    {t("list.started", { when: format.dateTime(new Date(`${s.startedAt.slice(0, 23)}Z`), { dateStyle: "medium", timeStyle: "short" }) })}
                  </p>
                  {s.startedBy.name === null ? null : <p className="break-words text-base text-ink-muted">{t("list.startedBy", { name: s.startedBy.name })}</p>}
                  {(codesBySession.get(s.id) ?? []).length === 0 ? null : (
                    <p className="break-words text-base text-ink" data-testid="count-row-codes">
                      {t("list.codes", { codes: (codesBySession.get(s.id) ?? []).slice(0, 4).join(", ") + ((codesBySession.get(s.id) ?? []).length > 4 ? ` +${(codesBySession.get(s.id) ?? []).length - 4}` : "") })}
                    </p>
                  )}
                  {s.abandoned ? (
                    <p className="flex min-w-0 items-start gap-2 text-base font-bold text-warning-ink" data-testid="abandoned-badge">
                      <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                      <span className="min-w-0 break-words">{t("abandoned")}. {t("abandonedHint")}</span>
                    </p>
                  ) : null}
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Link href={`${base}/counts/${encodeURIComponent(s.id)}`} className={LINK_BTN}>
                      {hasPermission(roles, "count_diff.approve") ? t("list.review") : t("list.view")}
                    </Link>
                    {s.status === "COUNTING" ? (
                      <Link href={`${base}/field/count?session=${encodeURIComponent(s.id)}`} className={LINK_BTN}>
                        {t("list.countInField")}
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {nextHref === null ? null : (
            <Link href={nextHref} className={LINK_BTN}>
              {t("list.more")}
            </Link>
          )}
          {hasPermission(roles, "count_diff.approve") ? null : (
            <p className="flex items-start gap-2 text-sm text-ink-muted" data-testid="review-locked-note">
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{t("review.locked")}</span>
            </p>
          )}
        </section>
        <StartCountForm
          slug={slug}
          warehouses={warehouses.items.filter((w) => w.status === "ACTIVE").map((w) => ({ id: w.id, code: w.code, name: w.name }))}
          tasks={tasks.items.filter((x) => x.locationId !== null).map((x) => ({ id: x.id, warehouseId: x.warehouseId, locationId: x.locationId as string }))}
          lockedLocationIds={[...lockedIds]}
          canStart={hasPermission(roles, "document.approve")}
        />
      </div>
    </main>
  );
}
