import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

// Kısa, statik yardım sayfası (T-122 Supervisor eki): üst bardaki "Yardım çağır" bağlantısının hedefi. Sahte işlev yok
// (sohbet/telefon/form yok); yalnızca takılınca ne yapılacağı. Oturum gerekmez.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help");
  return { title: t("title") };
}

const ITEMS = ["sign", "access", "support"] as const;

export default async function HelpPage() {
  const t = await getTranslations("help");
  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <h1 className="break-words text-3xl font-extrabold text-ink">{t("title")}</h1>
      <p className="text-lg text-ink">{t("intro")}</p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {ITEMS.map((k) => (
          <li key={k} className="break-words rounded-card bg-surface p-4 text-base text-ink shadow-card">
            {t(`items.${k}`)}
          </li>
        ))}
      </ul>
      <div>
        <Link
          href="/"
          className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-6 text-base font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t("back")}
        </Link>
      </div>
    </main>
  );
}
