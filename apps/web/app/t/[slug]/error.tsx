"use client";
// Tenant alanı hata sınırı (T-119 MINOR-1). Sunucu bileşeni hataları istemciye yalnızca genel mesaj + `digest` olarak
// gelir (üretimde ham mesaj/yığın maskelenir); hata KODU buraya taşınmaz. Bu yüzden askıda/kapanan tenant `layout.tsx`'te
// kodla yakalanıp durum olarak gösterilir; burası beklenmeyen hatalar içindir: ham mesaj/yığın gösterilmez, yalnızca
// genel neden + sonraki eylem ve (varsa) destek kodu.
import { useTranslations } from "next-intl";
import { Banner, Button } from "@wms/ui";

export default function TenantError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("members.errors");
  return (
    <main className="mx-auto flex w-full max-w-md min-w-0 flex-col gap-4 px-4 py-6">
      <h1 className="break-words text-2xl font-extrabold text-ink">{t("boundaryTitle")}</h1>
      <Banner kind="error">
        <p>
          {t("internal")} {t("internalAction")}
        </p>
        {error.digest ? <p className="mt-1 break-all text-sm">{t("supportCode", { code: error.digest })}</p> : null}
      </Banner>
      <div>
        <Button onClick={() => retry()}>{t("retry")}</Button>
      </div>
    </main>
  );
}
