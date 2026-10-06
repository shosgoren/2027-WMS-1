import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { getLocationTree, listWarehouses } from "@wms/domain/warehouse";
import type { WarehouseRow } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { LocationTree } from "./location-tree.tsx";

export const dynamic = "force-dynamic";

const TREE_PAGE = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tek depo okuyucusu gelene kadar (Q-57) tarama üst sınırı: en çok 5 sayfa x 200 = 1000 depo. */
const MAX_SCAN_PAGES = 5;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("warehouses");
  return { title: t("tree.title") };
}

// Lokasyon ağacı (T-207): sunucu bileşeni. Depo bulunamaz/kapsam dışı/geçersiz kimlik → 404 (varlık sızdırılmaz).
// Yazma yetkisi kararı yalnızca gösterim içindir (eylem sunucuda `settings.manage` ister).
export default async function LocationTreePage({ params }: { params: Promise<{ slug: string; warehouseId: string }> }) {
  const { slug, warehouseId } = await params;
  const { getAuthService } = await import("../../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  const returnTo = `/t/${encodeURIComponent(slug)}/warehouses/${encodeURIComponent(warehouseId)}`;
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  // Geçersiz kimlik: tarama/DB çağrısı yapmadan 404 (varlık sızdırmaz).
  if (!UUID_RE.test(warehouseId)) notFound();
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };

  let warehouse: WarehouseRow | undefined;
  let tree: Awaited<ReturnType<typeof getLocationTree>>;
  let canManage: boolean;
  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    canManage = hasPermission(current.roles, "settings.manage");
    // `getWarehouse` okuyucusu yok (Bulgular): kapsamlı listeden anahtar kümesiyle aranır.
    let afterCode: string | undefined;
    for (let scanned = 1; ; scanned++) {
      const page = await listWarehouses(call, { includeArchived: true, ...(afterCode === undefined ? {} : { afterCode }) });
      warehouse = page.items.find((w) => w.id === warehouseId.toLowerCase());
      if (warehouse !== undefined || page.nextAfterCode === null) break;
      if (scanned >= MAX_SCAN_PAGES) {
        // Sınır aşıldı: bulunamadı gibi davranılır; maskeli günlük (yalnızca neden, G-09).
        console.error(JSON.stringify({ level: "error", msg: "warehouse lookup scan limit reached", maxPages: MAX_SCAN_PAGES }));
        notFound();
      }
      afterCode = page.nextAfterCode;
    }
    if (warehouse === undefined) notFound();
    tree = await getLocationTree(call, { warehouseId: warehouse.id, includeArchived: true, limit: TREE_PAGE });
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
    }
    throw e;
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <LocationTree
        slug={slug}
        warehouseId={warehouse.id}
        warehouseName={warehouse.name}
        warehouseCode={warehouse.code}
        warehouseActive={warehouse.status === "ACTIVE"}
        canManage={canManage}
        initialItems={tree.items.map((i) => ({ id: i.id, parentId: i.parentId, code: i.code, name: i.name, depth: i.depth, kind: i.kind, status: i.status }))}
        initialNext={tree.next}
      />
    </main>
  );
}
