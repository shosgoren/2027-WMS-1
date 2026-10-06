import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { getMembershipSummary } from "@wms/domain/identity/member-queries";
import { hasPermission } from "@wms/domain/identity/permissions";
import { TaskMenu } from "./task-menu.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home");
  return { title: t("title") };
}

// Tenant ana ekranı (T-122): "Merhaba <ad>, Ne yapmak istiyorsun?" + görev kartları. Üyelik/MFA/askı kararları
// `layout.tsx`'tedir (üye değil → 404, askıda → durum ekranı); burada yalnızca kendi üyeliğimiz özetlenir. Layout karar verdiyse
// çocuk çizilmez, bu yüzden "üyelik yok" durumunda sayfa sessizce boş döner (kendi 404'ünü üretmez).
export default async function TenantHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { getAuthService } = await import("@wms/auth");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(`/t/${slug}`)}`);
  const summary = await getMembershipSummary({ db: getAppDb(), principal });
  const current = summary.memberships.find((m) => m.slug === slug);
  if (current === undefined) return null;
  const t = await getTranslations("home");
  const firstName = summary.userName.trim().split(/\s+/)[0] ?? summary.userName;

  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 px-4 py-6">
      <header className="flex min-w-0 flex-col gap-2">
        <p className="break-words text-xl font-semibold text-ink-muted">{t("greeting", { name: firstName })}</p>
        <h1 className="break-words text-4xl font-extrabold text-ink">{t("title")}</h1>
        <p className="max-w-2xl break-words text-lg text-ink">{t("intro")}</p>
      </header>
      <TaskMenu
        slug={slug}
        allowed={{
          usersManage: hasPermission(current.roles, "users.manage"),
          settingsManage: hasPermission(current.roles, "settings.manage"),
          auditView: hasPermission(current.roles, "audit.view"),
        }}
      />
    </main>
  );
}
