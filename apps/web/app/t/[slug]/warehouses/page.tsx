import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { countLocationsByWarehouse, listWarehouses } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { WarehousesView } from "./warehouses-view.tsx";
import type { WarehouseView } from "./warehouses-view.tsx";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("warehouses");
  return { title: t("title") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Depo listesi (T-207): sunucu bileşeni; veri T-205 okuyucularından. Sayfa kendi kararını verir: üye değil → 404;
// zorunlu MFA → kurulum; oturum yok → giriş. Yazma yetkisi kararı yalnızca gösterim içindir (eylem sunucuda `settings.manage` ister).
export default async function WarehousesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const after = first((await searchParams).after);
  const { getAuthService } = await import("../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  const returnTo = `/t/${encodeURIComponent(slug)}/warehouses`;
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };

  let rows: WarehouseView[];
  let nextAfter: string | null;
  let canManage: boolean;
  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    canManage = hasPermission(current.roles, "settings.manage");
    const page = await listWarehouses(call, { includeArchived: true, limit: PAGE_SIZE, ...(after === undefined || after === "" ? {} : { afterCode: after }) });
    nextAfter = page.nextAfterCode;
    // Sayfa en çok PAGE_SIZE (50) depo döndürür → toplu sayım sınırı (100) içinde; boş sayfada sorgu yapılmaz.
    const counts = page.items.length === 0 ? new Map<string, number>() : await countLocationsByWarehouse(call, { warehouseIds: page.items.map((w) => w.id) });
    rows = page.items.map((w) => ({ id: w.id, code: w.code, name: w.name, status: w.status, locationCount: counts.get(w.id) ?? 0, locationCountCapped: false }));
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
      // Geçersiz imleç (`after`) kullanıcı hatasıdır: boş liste yerine 404.
      if (e.code === "VALIDATION_FAILED") notFound();
    }
    throw e;
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <WarehousesView slug={slug} canManage={canManage} warehouses={rows} nextAfter={nextAfter} firstPage={after === undefined || after === ""} />
    </main>
  );
}
