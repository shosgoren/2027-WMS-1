import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getItem, itemInUse, listItemBarcodes, listItemConversions } from "@wms/domain/catalog";
import { listUnits } from "@wms/domain/catalog/units";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { AppError } from "@wms/shared/errors";
import { ItemDetail } from "./item-detail.tsx";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("items");
  return { title: t("detail.title") };
}

async function LockedItem() {
  const t = await getTranslations("items");
  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <h1 className="break-words text-2xl font-extrabold text-ink">{t("detail.title")}</h1>
      <Banner kind="warning">
        <p>{t("locked")}</p>
        <p className="mt-1">{t("lockedAction")}</p>
      </Banner>
    </main>
  );
}

// Ürün ayrıntısı (T-216): sunucu bileşeni. Ürün bulunamaz/başka tenant/geçersiz kimlik → 404 (varlık sızdırılmaz). Her okuma tek ürün
// için sınırlıdır (T-240); yazma yetkisi kararı yalnızca gösterim içindir (eylem sunucuda `settings.manage` ister).
export default async function ItemDetailPage({ params }: { params: Promise<{ slug: string; itemId: string }> }) {
  const { slug, itemId } = await params;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  const returnTo = `/t/${encodeURIComponent(slug)}/items/${encodeURIComponent(itemId)}`;
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  // Geçersiz kimlik: DB çağrısı yapmadan 404 (varlık sızdırmaz).
  if (!UUID_RE.test(itemId)) notFound();
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };

  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    const canManage = hasPermission(current.roles, "settings.manage");
    const item = await getItem(call, { itemId });
    const conversions = await listItemConversions(call, item.id);
    const barcodes = await listItemBarcodes(call, item.id);
    const inUse = await itemInUse(call, item.id);
    const units = await listUnits(call);
    const activeUnits = units.filter((u) => u.status === "ACTIVE").map((u) => ({ id: u.id, code: u.code, name: u.name }));
    const baseUnit = units.find((u) => u.id === item.baseUnitId);
    return (
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
        <ItemDetail
          slug={slug}
          canManage={canManage}
          inUse={inUse}
          units={activeUnits}
          item={{
            id: item.id,
            code: item.code,
            name: item.name,
            status: item.status,
            baseUnitId: item.baseUnitId,
            baseUnitCode: baseUnit?.code ?? "",
            trackingMode: item.trackingMode,
            quantityScale: item.quantityScale,
            pickPolicy: item.pickPolicy,
          }}
          conversions={conversions}
          barcodes={barcodes}
        />
      </main>
    );
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
      // `stock.view` izni olmayan üye: hata sayfası değil, neden + sonraki eylemle kilitli görünüm (audit/members deseni).
      if (e.code === "FORBIDDEN") return <LockedItem />;
    }
    throw e;
  }
}
