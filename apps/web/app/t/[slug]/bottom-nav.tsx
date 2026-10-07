"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { House, ListChecks, Menu, ScanLine } from "@wms/ui";
import { openAppMenu } from "./app-bar.tsx";

// Telefon alt sekme çubuğu (T-254): başparmak erişimi, her sekme >= 48 px, güvenli alan boşluğu. Yalnız telefonda görünür
// (`phone-only`). Saha ekranlarında (T-303) kendi alt eylem çubuğu vardır; çakışmasın diye orada çizilmez.
// "Görevlerim" için henüz ekran/yetki modeli yok: tıklanamaz ve "Yakında" etiketiyle gösterilir (sahte işlev yok, G-07).

const ICON = { className: "size-6", strokeWidth: 2, "aria-hidden": true } as const;
const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-focus";
const TAB = "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs font-bold";

export function BottomNav({ slug }: { slug: string }) {
  const t = useTranslations("shell.nav");
  const pathname = usePathname();
  const base = `/t/${encodeURIComponent(slug)}`;
  if (pathname.startsWith(`${base}/field`)) return null;

  const link = (href: string, label: string, icon: ReactNode, current: boolean) => (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`${TAB} ${FOCUS} ${current ? "bg-accent-soft text-accent-ink" : "text-ink"}`}
    >
      {icon}
      <span className="max-w-full truncate">{label}</span>
    </Link>
  );

  return (
    <nav
      aria-label={t("label")}
      data-testid="bottom-nav"
      className="phone-only z-30 shrink-0 items-stretch border-t-2 border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {link(base, t("home"), <House {...ICON} />, pathname === base)}
      {link(`${base}/field`, t("scan"), <ScanLine {...ICON} />, false)}
      <span role="group" aria-disabled="true" aria-label={t("tasks")} tabIndex={0} className={`${TAB} ${FOCUS} text-ink-muted`}>
        <ListChecks {...ICON} />
        <span className="max-w-full truncate">{t("tasks")}</span>
        <span className="text-[0.625rem] font-semibold leading-none">{t("soon")}</span>
      </span>
      <button type="button" aria-haspopup="dialog" onClick={openAppMenu} className={`${TAB} ${FOCUS} cursor-pointer text-ink`}>
        <Menu {...ICON} />
        <span className="max-w-full truncate">{t("menu")}</span>
      </button>
    </nav>
  );
}
