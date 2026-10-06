import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { getLocationTree, listWarehouses } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
import { WarehousesView } from "./warehouses-view.tsx";
import type { WarehouseView } from "./warehouses-view.tsx";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
/** Kart başına lokasyon sayısı için tek okuma sınırı; aşılırsa "N+" gösterilir (sayım okuyucusu yok: Bulgular). */
const COUNT_CAP = 100;

/** Eşzamanlı okuma sınırı (bağlantı havuzunu doldurmasın); toplu sayım okuyucusu gelene kadar (Q-57). */
const COUNT_CONCURRENCY = 4;

/** Girdi sırasını koruyan, en çok `limit` eşzamanlı çalışan basit havuz. İlk hata kalan işleri başlatmaz ve fırlatılır. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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
    rows = await mapLimited(page.items, COUNT_CONCURRENCY, async (w) => {
      const tree = await getLocationTree(call, { warehouseId: w.id, limit: COUNT_CAP });
      return { id: w.id, code: w.code, name: w.name, status: w.status, locationCount: tree.items.length, locationCountCapped: tree.next !== null };
    });
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
