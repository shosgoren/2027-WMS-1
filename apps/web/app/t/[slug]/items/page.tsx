import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { searchItems } from "@wms/domain/catalog";
import { listUnits } from "@wms/domain/catalog/units";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { AppError } from "@wms/shared/errors";
import { ItemsView } from "./items-view.tsx";
import type { ItemListView } from "./items-view.tsx";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("items");
  return { title: t("title") };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function LockedItems() {
  const t = await getTranslations("items");
  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <h1 className="break-words text-2xl font-extrabold text-ink">{t("title")}</h1>
      <Banner kind="warning">
        <p>{t("locked")}</p>
        <p className="mt-1">{t("lockedAction")}</p>
      </Banner>
    </main>
  );
}

// Ürün listesi (T-216): sunucu bileşeni; veri T-240 okuyucularından (keyset, OFFSET yok). Sayfa kendi kararını verir: üye değil → 404;
// zorunlu MFA → kurulum; oturum yok → giriş. Yazma yetkisi kararı yalnızca gösterim içindir (eylem sunucuda `settings.manage` ister).
export default async function ItemsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const after = first(sp.after);
  const q = (first(sp.q) ?? "").slice(0, 128);
  const statusRaw = first(sp.status) ?? "";
  const { getAuthService } = await import("../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  const returnTo = `/t/${encodeURIComponent(slug)}/items`;
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  // Bilinmeyen durum değeri kullanıcı hatasıdır: DB'ye gitmeden 404.
  if (statusRaw !== "" && statusRaw !== "ACTIVE" && statusRaw !== "ARCHIVED") notFound();
  const status = statusRaw as "" | "ACTIVE" | "ARCHIVED";
  const db = getAppDb();
  const call = { db, principal, tenantSlug: slug };

  let rows: ItemListView[];
  let units: Awaited<ReturnType<typeof listUnits>>;
  let nextCursor: string | null;
  let canManage: boolean;
  try {
    const summary = await getMembershipSummary({ db, principal });
    const current = summary.memberships.find((m) => m.slug === slug);
    if (current === undefined) notFound();
    canManage = hasPermission(current.roles, "settings.manage");
    const page = await searchItems(call, {
      limit: PAGE_SIZE,
      ...(q.trim() === "" ? {} : { q }),
      ...(status === "" ? {} : { status }),
      ...(after === undefined || after === "" ? {} : { after }),
    });
    units = await listUnits(call);
    const unitCode = new Map(units.map((u) => [u.id, u.code] as const));
    // T-257: arama ESKİ kodla eşleştiyse sonuç kartında "bu kod X olarak değişti" bilgisi (sunucu `renamedFrom` verir; kural istemcide yok).
    const old = new Map((page.renamedFrom ?? []).map((r) => [r.itemId, r.oldCode] as const));
    rows = page.items.map((it) => {
      const oldCode = old.get(it.id);
      return { id: it.id, code: it.code, name: it.name, status: it.status, baseUnitCode: unitCode.get(it.baseUnitId) ?? "", ...(oldCode === undefined ? {} : { oldCode }) };
    });
    nextCursor = page.nextCursor;
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
      // Geçersiz imleç (`after`) kullanıcı hatasıdır: boş liste yerine 404.
      if (e.code === "VALIDATION_FAILED") notFound();
      // `stock.view` izni olmayan üye: hata sayfası değil, neden + sonraki eylemle kilitli görünüm (audit/members deseni).
      if (e.code === "FORBIDDEN") return <LockedItems />;
    }
    throw e;
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6 phone:flex-1 phone:gap-2 phone:pb-0 phone:pt-3">
      <ItemsView
        slug={slug}
        canManage={canManage}
        items={rows}
        units={units.filter((u) => u.status === "ACTIVE").map((u) => ({ id: u.id, code: u.code, name: u.name }))}
        nextCursor={nextCursor}
        firstPage={after === undefined || after === ""}
        query={{ q: q.trim() === "" ? "" : q, status }}
      />
    </main>
  );
}
