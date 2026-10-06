import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { TaskCard } from "@wms/ui";
import type { TaskCardTone } from "@wms/ui";

// "Ne yapmak istiyorsun?" kart ızgarası (T-122). Sunucu bileşeni: izin kararı çağıran sayfadan (`allowed`) gelir ve yalnızca
// GÖSTERİMDİR (kilit/bağlantı); asıl yetki hedef sayfa/eylemde sunucuda denetlenir. Faz 1'de olmayan depo işleri
// tıklanamaz "yakında" kartıdır (sahte işlev yok, G-07).

export interface TaskMenuProps {
  readonly slug: string;
  readonly allowed: { readonly usersManage: boolean; readonly settingsManage: boolean; readonly auditView: boolean };
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const ICONS = {
  members: (
    <Icon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  ),
  settings: (
    <Icon>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />
    </Icon>
  ),
  audit: (
    <Icon>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 13h8M8 17h5" />
    </Icon>
  ),
  receive: (
    <Icon>
      <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" />
    </Icon>
  ),
  issue: (
    <Icon>
      <path d="M12 15V3m0 0L8 7m4-4 4 4M5 21h14" />
    </Icon>
  ),
  transfer: (
    <Icon>
      <path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />
    </Icon>
  ),
  count: (
    <Icon>
      <path d="M9 4h6v3H9zM8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 14l2 2 4-4" />
    </Icon>
  ),
  lookup: (
    <Icon>
      <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3" />
    </Icon>
  ),
  undo: (
    <Icon>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
    </Icon>
  ),
} as const;

type TaskKey = keyof typeof ICONS;

type Entry =
  | { key: TaskKey; kind: "link"; allowed: boolean; href: `/${string}` }
  | { key: TaskKey; kind: "screen-soon"; allowed: boolean }
  | { key: TaskKey; kind: "warehouse-soon"; tone: TaskCardTone };

export async function TaskMenu({ slug, allowed }: TaskMenuProps) {
  const t = await getTranslations("home");
  const entries: Entry[] = [
    { key: "members", kind: "link", allowed: allowed.usersManage, href: `/t/${encodeURIComponent(slug)}/members` },
    { key: "settings", kind: "link", allowed: allowed.settingsManage, href: `/t/${encodeURIComponent(slug)}/settings` },
    // Denetim ekranı T-126'dadır: o gelene kadar "yakında".
    { key: "audit", kind: "screen-soon", allowed: allowed.auditView },
    { key: "receive", kind: "warehouse-soon", tone: "accent" },
    { key: "issue", kind: "warehouse-soon", tone: "accent" },
    { key: "transfer", kind: "warehouse-soon", tone: "accent" },
    { key: "count", kind: "warehouse-soon", tone: "accent" },
    { key: "lookup", kind: "warehouse-soon", tone: "accent" },
    { key: "undo", kind: "warehouse-soon", tone: "undo" },
  ];

  return (
    <ul aria-label={t("tasksLabel")} className="m-0 grid min-w-0 list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3">
      {entries.map((e) => {
        const title = t(`tasks.${e.key}.title`);
        const icon = ICONS[e.key];
        let card: ReactNode;
        if (e.kind === "warehouse-soon") {
          card = <TaskCard icon={icon} title={title} description={t("soonWarehouse")} soon={{ label: t("soonLabel") }} tone={e.tone} />;
        } else if (!e.allowed) {
          card = <TaskCard icon={icon} title={title} locked={{ reason: t("lockedReason") }} />;
        } else if (e.kind === "link") {
          card = <TaskCard icon={icon} title={title} description={t(`tasks.${e.key}.description`)} href={e.href} />;
        } else {
          card = <TaskCard icon={icon} title={title} description={t("soonScreen")} soon={{ label: t("soonLabel") }} />;
        }
        return (
          <li key={e.key} className="flex min-w-0">
            {card}
          </li>
        );
      })}
    </ul>
  );
}
