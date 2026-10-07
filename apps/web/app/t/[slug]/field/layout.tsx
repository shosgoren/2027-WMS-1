import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

const TOUCH = "min-h-14 min-w-12";
const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

// Saha kabuğu (T-303): el terminali için tek sütun (375 px), alt sabit eylem çubuğu, tüm dokunma hedefleri >= 48 px.
// Alt çubuktaki iki bağlantı da nötr (ikincil) çizilir: akış sayfalarındaki tek dolu birincil eylem sayfanın kendi sabit düğmesidir (T-313).
// Üyelik/yetki kararı üst `t/[slug]/layout.tsx`'tedir; burada yalnızca yerleşim vardır.
export default async function FieldLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await getTranslations("field");
  const base = `/t/${encodeURIComponent(slug)}`;
  return (
    <div className="mx-auto flex w-full max-w-md min-w-0 flex-col pb-24" data-testid="field-shell">
      {children}
      <nav
        aria-label={t("actionBarLabel")}
        data-testid="field-action-bar"
        className="fixed inset-x-0 bottom-0 z-20 flex min-w-0 gap-2 border-t-2 border-border bg-surface px-4 py-2"
      >
        <Link href={`${base}/field`} className={`${TOUCH} flex flex-1 items-center justify-center rounded-control border-2 border-border bg-surface px-3 text-center text-base font-bold text-ink ${FOCUS}`}>
          {t("fieldHome")}
        </Link>
        <Link href={base} className={`${TOUCH} flex flex-1 items-center justify-center rounded-control border-2 border-border bg-surface px-3 text-center text-base font-bold text-ink ${FOCUS}`}>
          {t("mainMenu")}
        </Link>
      </nav>
    </div>
  );
}
