import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Package } from "@wms/ui";
import { SignOutButton } from "./auth-forms.tsx";
import "./globals.css";

// Uygulama kabuğu (T-109): üst bar, Akış/Kokpit görünüm anahtarı, kullanıcı çipi yer tutucusu,
// "Yardım çağır". Görünür metin yalnızca messages/*.json'dan gelir (ADR-002). Oturum T-118'de bağlanır.
const VIEWS = ["flow", "cockpit"] as const;
type View = (typeof VIEWS)[number];
const VIEW_COOKIE = "view";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function parseView(value: string | undefined): View {
  return VIEWS.find((v) => v === value) ?? "flow";
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("productName") };
}

async function setView(formData: FormData): Promise<void> {
  "use server";
  const next = parseView(String(formData.get("view") ?? ""));
  (await cookies()).set(VIEW_COOKIE, next, { path: "/", maxAge: ONE_YEAR_SECONDS, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
}

const TOUCH = "min-h-12 min-w-12";

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await getLocale();
  const t = await getTranslations("shell");
  const cookieStore = await cookies();
  const view = parseView(cookieStore.get(VIEW_COOKIE)?.value);
  // İyimser: yalnızca oturum çerezinin varlığı (çıkış düğmesi gösterimi); yetki sunucuda (proxy.ts notu).
  const hasSession = cookieStore.getAll().some((c) => /^(?:__Secure-)?better-auth\.session_token$/.test(c.name));

  return (
    <html lang={locale} data-view={view}>
      <body className="min-h-dvh bg-bg text-ink antialiased">
        <NextIntlClientProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-card focus:bg-surface focus:px-4 focus:py-3"
          >
            {t("skipToContent")}
          </a>
          <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-accent text-on-accent"
              >
                <Package className="size-6" strokeWidth={2} aria-hidden="true" />
              </span>
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-xl font-extrabold">{t("productName")}</span>
                <span className="w-fit rounded-full bg-accent-soft px-2 text-xs font-bold text-accent-ink">
                  {t("easyMode")}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <form action={setView} aria-label={t("viewSwitch.label")}>
                <div className="flex rounded-full bg-accent-soft p-1" role="group">
                  {VIEWS.map((v) => (
                    <button
                      key={v}
                      type="submit"
                      name="view"
                      value={v}
                      aria-pressed={view === v}
                      className={`${TOUCH} cursor-pointer rounded-full px-4 text-sm font-bold ${
                        view === v ? "bg-ink text-surface" : "text-ink"
                      }`}
                    >
                      {t(`viewSwitch.${v}`)}
                    </button>
                  ))}
                </div>
              </form>

              <div
                role="group"
                aria-label={t("userChip.label")}
                className={`${TOUCH} flex items-center gap-2 rounded-full border-2 border-border px-1 pr-3`}
              >
                <span
                  aria-hidden="true"
                  className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-ink"
                >
                  {t("userChip.placeholderInitials")}
                </span>
                <span className="hidden text-sm font-semibold sm:inline">{t("userChip.placeholderName")}</span>
              </div>

              {hasSession ? <SignOutButton /> : null}

              <Link
                href="/help"
                className={`${TOUCH} inline-flex items-center justify-center rounded-full bg-accent-soft px-4 text-sm font-bold text-accent-ink`}
              >
                <span className="sm:hidden">{t("help.short")}</span>
                <span className="hidden sm:inline">{t("help.full")}</span>
              </Link>
            </div>
          </header>
          <div id="main" tabIndex={-1}>
            {children}
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
