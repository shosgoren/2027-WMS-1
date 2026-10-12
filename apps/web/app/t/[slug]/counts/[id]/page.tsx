import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { getCountSession } from "@wms/domain/operations";
import { AppError } from "@wms/shared/errors";
import { CountReview, type ReviewLine } from "./count-review.tsx";

export const dynamic = "force-dynamic";

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
// Sunucu bileşeninde "use client" modülünden sabit alınamaz (istemci başvurusu olur): sınıf dizgisi burada yereldir.
const LINK_BTN = `inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink ${FOCUS}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("counting");
  return { title: t("review.title") };
}

// Sayım gözden geçirme (T-316): sunucu bileşeni. Referans/sayılan/fark yalnızca `count_diff.approve` olana `review` kipiyle okunur (T-316a);
// yetkisiz kullanıcı `field` kipiyle yalnızca oturum başlığını görür (referans alanı sunucuda bile gelmez) ve kilit + gerekçe görür. Eylem kararları yalnızca
// gösterimdir (`count_diff.approve` / `document.approve`); sunucu yeniden denetler. Yok / başka tenant / kapsam dışı oturum → 404 (varlık sızmaz).
export default async function CountReviewPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const returnTo = `/t/${encodeURIComponent(slug)}/counts/${encodeURIComponent(id)}`;
  if (!UUID_RE.test(id)) notFound();
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };
  const t = await getTranslations("counting");
  const format = await getFormatter();

  let canReview: boolean;
  let canCancel: boolean;
  let detail: Awaited<ReturnType<typeof getCountSession>>;
  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    canReview = hasPermission(current.roles, "count_diff.approve");
    canCancel = hasPermission(current.roles, "document.approve");
    detail = canReview ? await getCountSession(call, { sessionId: id, view: "review" }) : await getCountSession(call, { sessionId: id, view: "field" });
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND" || e.code === "VALIDATION_FAILED") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
    }
    throw e;
  }

  const s = detail.session;
  const startedLabel = format.dateTime(new Date(`${s.startedAt.slice(0, 23)}Z`), { dateStyle: "medium", timeStyle: "short" });
  // Açık beyaz liste: yalnızca ekranın kullandığı alanlar istemciye gider. Yetkisizde satır listesi hiç gönderilmez.
  const lines: ReviewLine[] =
    detail.view === "review"
      ? detail.lines.map((l) => ({
          id: l.id,
          locationId: l.locationId,
          itemCode: l.itemCode,
          itemName: l.itemName,
          unitName: l.unitName || l.unitCode,
          stockStatus: l.stockStatus,
          reference: l.reference,
          counted: l.counted,
          difference: l.difference,
        }))
      : [];
  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-3xl font-extrabold text-ink">{t("review.title")}</h1>
        <p className="break-words text-lg text-ink" data-testid="review-meta">
          {t("review.meta", { warehouse: s.warehouseName, when: startedLabel, locations: s.locationCount })}
        </p>
        <p className="break-words text-base text-ink-muted">{s.startedBy.name === null ? t("review.startedByUnknown") : t("review.startedBy", { name: s.startedBy.name })}</p>
        <Link href={`/t/${encodeURIComponent(slug)}/counts`} className={`${LINK_BTN} w-fit`}>
          {t("review.back")}
        </Link>
      </header>
      <CountReview
        slug={slug}
        session={{
          id: s.id,
          warehouseId: s.warehouseId,
          warehouseCode: s.warehouseCode,
          warehouseName: s.warehouseName,
          status: s.status,
          blind: s.blind,
          locationCount: s.locationCount,
          startedBy: { name: s.startedBy.name },
          abandoned: s.abandoned,
        }}
        locations={detail.locations.map((l) => ({ id: l.id, code: l.code, name: l.name, locked: l.locked }))}
        lines={lines}
        canReview={canReview}
        canCancel={canCancel}
      />
    </main>
  );
}
