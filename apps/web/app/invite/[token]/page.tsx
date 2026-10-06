import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { isWellFormedInvitationToken, previewInvitation } from "@wms/domain/identity/invitations";
import { guardInvitePreview } from "../../../lib/invite-guard.ts";
import { createProductionLimiter } from "../../../lib/rate-limit.ts";
import { InviteAcceptForm } from "../../auth-forms.tsx";

export const dynamic = "force-dynamic";

// Belirteç yolda taşınır: Referer ile sızmaz (T-117 MINOR-5; `proxy.ts` aynı başlığı da ekler).
export const metadata: Metadata = { referrer: "no-referrer" };

const MAIN = "mx-auto flex w-full max-w-md min-w-0 flex-col gap-4 px-4 py-6";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("auth");
  const notFound = (
    <main className={MAIN}>
      <h1 className="break-words text-2xl font-extrabold text-ink">{t("invite.title")}</h1>
      <Banner kind="error">
        {t("invite.errors.not_found")} {t("invite.errors.not_foundAction")}
      </Banner>
    </main>
  );
  if (!isWellFormedInvitationToken(token)) return notFound;
  const requestHeaders = await headers();
  // Belirteç denemesi hız sınırı (T-127 IP sınırı; A-41). IP çözülemezse nötr metin (500 yok, belirteçli URL hata günlüğüne düşmez).
  const guard = await guardInvitePreview(requestHeaders, createProductionLimiter());
  if (guard === "unavailable") return notFound;
  if (guard === "rate_limited") {
    return (
      <main className={MAIN}>
        <h1 className="break-words text-2xl font-extrabold text-ink">{t("invite.title")}</h1>
        <Banner kind="error">{t("invite.rateLimited")}</Banner>
      </main>
    );
  }
  const preview = await previewInvitation({ db: getAppDb(), token });
  // Yok/süresi dolmuş/iptal/kabul/askıda/demo: hepsi aynı nötr metin (varlık sızdırılmaz).
  if (preview === null) return notFound;
  const tRoot = await getTranslations();
  const hoursLeft = Math.ceil((preview.expiresAt.getTime() - Date.now()) / 3_600_000);
  const { getAuthService } = await import("../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(requestHeaders);
  return (
    <>
      <div className="mx-auto w-full max-w-md min-w-0 px-4 pt-6">
        <Banner kind="info">
          {t("invite.preview", { tenant: preview.tenantName, role: tRoot(`roles.${preview.roleKey}`) })}{" "}
          {hoursLeft <= 1 ? t("invite.expiresSoon") : t("invite.expiresInHours", { hours: hoursLeft })}
        </Banner>
      </div>
      <InviteAcceptForm token={token} signedIn={principal !== null} />
    </>
  );
}
