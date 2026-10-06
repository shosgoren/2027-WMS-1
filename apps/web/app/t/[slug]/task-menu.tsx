import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ClipboardCheck, FileText, Package, Search, SlidersHorizontal, TaskCard, Undo2, Users, Warehouse } from "@wms/ui";
import type { TaskCardTone } from "@wms/ui";

// "Ne yapmak istiyorsun?" kart ızgarası (T-122). Sunucu bileşeni: izin kararı çağıran sayfadan (`allowed`) gelir ve yalnızca
// GÖSTERİMDİR (kilit/bağlantı); asıl yetki hedef sayfa/eylemde sunucuda denetlenir. Faz 1'de olmayan depo işleri
// tıklanamaz "yakında" kartıdır (sahte işlev yok, G-07).

export interface TaskMenuProps {
  readonly slug: string;
  readonly allowed: { readonly usersManage: boolean; readonly settingsManage: boolean; readonly auditView: boolean; readonly stockView: boolean };
}

const ICON_PROPS = { className: "size-6", strokeWidth: 2, "aria-hidden": true } as const;

const ICONS = {
  members: <Users {...ICON_PROPS} />,
  settings: <SlidersHorizontal {...ICON_PROPS} />,
  audit: <FileText {...ICON_PROPS} />,
  items: <Package {...ICON_PROPS} />,
  warehouses: <Warehouse {...ICON_PROPS} />,
  receive: <ArrowDownToLine {...ICON_PROPS} />,
  issue: <ArrowUpFromLine {...ICON_PROPS} />,
  transfer: <ArrowLeftRight {...ICON_PROPS} />,
  count: <ClipboardCheck {...ICON_PROPS} />,
  lookup: <Search {...ICON_PROPS} />,
  undo: <Undo2 {...ICON_PROPS} />,
} as const;

type TaskKey = keyof typeof ICONS;

type Entry =
  | { key: TaskKey; kind: "link"; allowed: boolean; href: `/${string}` }
  | { key: TaskKey; kind: "warehouse-soon"; tone: TaskCardTone };

export async function TaskMenu({ slug, allowed }: TaskMenuProps) {
  const t = await getTranslations("home");
  const entries: Entry[] = [
    { key: "members", kind: "link", allowed: allowed.usersManage, href: `/t/${encodeURIComponent(slug)}/members` },
    { key: "settings", kind: "link", allowed: allowed.settingsManage, href: `/t/${encodeURIComponent(slug)}/settings` },
    { key: "audit", kind: "link", allowed: allowed.auditView, href: `/t/${encodeURIComponent(slug)}/audit` },
    // Ürün kartı (T-216): okuma `stock.view`; bayrak yalnızca gösterimdir, sayfa/eylem yetkiyi sunucuda denetler.
    { key: "items", kind: "link", allowed: allowed.stockView, href: `/t/${encodeURIComponent(slug)}/items` },
    // Okuma `stock.view` (her rol); yazma kilidi hedef sayfada gösterilir, asıl yetki sunucudadır (T-205).
    { key: "warehouses", kind: "link", allowed: true, href: `/t/${encodeURIComponent(slug)}/warehouses` },
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
        } else {
          card = <TaskCard icon={icon} title={title} description={t(`tasks.${e.key}.description`)} href={e.href} />;
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
