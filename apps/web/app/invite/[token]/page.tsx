import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { isWellFormedInvitationToken } from "@wms/domain/identity/invitations";
import { InviteAcceptForm } from "../../auth-forms.tsx";

export const dynamic = "force-dynamic";

// Belirteç yolda taşınır: Referer ile sızmaz (T-117 MINOR-5; `proxy.ts` aynı başlığı da ekler).
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("auth");
  if (!isWellFormedInvitationToken(token)) {
    return (
      <main className="mx-auto flex w-full max-w-md min-w-0 flex-col gap-4 px-4 py-6">
        <h1 className="break-words text-2xl font-extrabold text-ink">{t("invite.title")}</h1>
        <Banner kind="error">
          {t("invite.errors.not_found")} {t("invite.errors.not_foundAction")}
        </Banner>
      </main>
    );
  }
  const { getAuthService } = await import("../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  return <InviteAcceptForm token={token} signedIn={principal !== null} />;
}
