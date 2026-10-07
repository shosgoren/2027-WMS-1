import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { TaskCard } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("field");
  return { title: t("title") };
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

// Her iş ilgili akış kartı (T-313…T-316) gelene kadar KİLİTLİDİR; bağlantı yoktur (sahte bağlantı yok, G-07).
// T-313: Kabul ve Yerleştirme açıktır (`stock.post` olanlara bağlantı; olmayana kilit + gerekçe, FORBIDDEN ekranına götürülmez).
const OPEN_HREF: Readonly<Record<string, `/${string}`>> = { receive: "/field/receive", putaway: "/field/putaway" };
const MENU = [
  { key: "receive", icon: <Icon><path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" /></Icon> },
  { key: "putaway", icon: <Icon><path d="M3 9.5 12 4l9 5.5V20H3ZM9 20v-6h6v6" /></Icon> },
  { key: "pick", icon: <Icon><path d="M12 15V3m0 0L8 7m4-4 4 4M5 21h14" /></Icon> },
  { key: "ship", icon: <Icon><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" /></Icon> },
  { key: "return", icon: <Icon><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></Icon> },
  { key: "count", icon: <Icon><path d="M9 4h6v3H9zM8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 14l2 2 4-4" /></Icon> },
] as const;

// Saha menüsü (06 §Görevlendirme: tara → doğrula → miktar onayla). Kilit gerekçesi açıklamayla birlikte gösterilir.
export default async function FieldHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await getTranslations("field");
  const { getAuthService } = await import("../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(`/t/${slug}/field`)}`);
  const summary = await getMembershipSummary({ db: getAppDb(), principal });
  const canPost = hasPermission(summary.memberships.find((m) => m.slug === slug)?.roles ?? [], "stock.post");
  const base = `/t/${encodeURIComponent(slug)}` as const;
  return (
    <main className="flex w-full min-w-0 flex-col gap-4 px-4 py-4">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-3xl font-extrabold text-ink">{t("title")}</h1>
        <p className="break-words text-lg text-ink">{t("intro")}</p>
      </header>
      <ul aria-label={t("menuLabel")} className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
        {MENU.map((m) => {
          const open = OPEN_HREF[m.key];
          return (
            <li key={m.key} className="flex min-w-0">
              {open !== undefined && canPost ? (
                <TaskCard icon={m.icon} title={t(`tasks.${m.key}.title`)} description={t(`tasks.${m.key}.description`)} href={`${base}${open}`} />
              ) : (
                <TaskCard
                  icon={m.icon}
                  title={t(`tasks.${m.key}.title`)}
                  locked={{ reason: `${t(`tasks.${m.key}.description`)} ${open !== undefined ? t("noPermission") : t("lockedReason")}` }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
