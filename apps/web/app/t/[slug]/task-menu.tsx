import type { ComponentType, ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock,
  History,
  Lock,
  MapPinned,
  Package,
  PackagePlus,
  Settings2,
  Truck,
  Undo2,
  Users,
  Warehouse,
} from "@wms/ui";

// "Ne yapmak istiyorsun?" döşeme ızgarası (T-122, T-270). Sunucu bileşeni: izin kararı çağıran sayfadan (`allowed`) gelir ve
// yalnızca GÖSTERİMDİR (kilit/bağlantı); asıl yetki hedef sayfa/eylemde sunucuda denetlenir. Faz 1'de olmayan depo işleri
// tıklanamaz "yakında" öğesidir (sahte işlev yok, G-07).
//
// Sıra TEK KAYNAKTA (`TASKS`): saha işleri önce, yönetim işleri sonra (saha cihazı); aynı grupta liste sırası geçerlidir.
// Telefonda ızgara alttan yukarı dolar (başparmak bölgesi): ilk sıradaki iş en alt satırda, yetim kalan son döşeme en üstte tam
// genişliktedir. Ekran okuyucu/odak sırası DOM sırasıdır (önce saha işleri). "Yakında" öğeleri telefonda ızgarada yer kaplamaz;
// tek satırlık düğmeyle (details) ayrı liste olarak açılır. Masaüstü/tablet yerleşimi `md:`/`lg:` ızgarasıdır.

export interface TaskMenuProps {
  readonly slug: string;
  readonly allowed: { readonly usersManage: boolean; readonly settingsManage: boolean; readonly auditView: boolean; readonly stockView: boolean };
}

export type TaskKey = "members" | "settings" | "audit" | "items" | "warehouses" | "receive" | "issue" | "transfer" | "count" | "lookup" | "undo";
export type TaskGroup = "field" | "admin";
/** İş kategorisi renk ailesi (ADR-020 kural 8). Renk tek taşıyıcı değildir: her döşemede ikon + metin vardır. */
export type TaskTone = "inbound" | "outbound" | "move" | "count" | "catalog" | "undo" | "admin";

export interface TaskDef {
  readonly key: TaskKey;
  readonly group: TaskGroup;
  readonly tone: TaskTone;
}

/** Görev tanımları — sıra kaynağı. Yeni iş eklerken yalnızca bu listeye ve `ICONS`'a eklenir. */
export const TASKS: readonly TaskDef[] = [
  { key: "receive", group: "field", tone: "inbound" },
  { key: "issue", group: "field", tone: "outbound" },
  { key: "transfer", group: "field", tone: "move" },
  { key: "count", group: "field", tone: "count" },
  { key: "lookup", group: "field", tone: "catalog" },
  { key: "warehouses", group: "field", tone: "catalog" },
  { key: "items", group: "field", tone: "catalog" },
  { key: "undo", group: "field", tone: "undo" },
  { key: "audit", group: "admin", tone: "admin" },
  { key: "members", group: "admin", tone: "admin" },
  { key: "settings", group: "admin", tone: "admin" },
];

const RANK: Record<TaskGroup, number> = { field: 0, admin: 1 };

/** Saha işleri yönetim işlerinden önce; grup içinde `TASKS` sırası (kararlı sıralama). */
export function orderTasks(defs: readonly TaskDef[]): TaskDef[] {
  return defs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => RANK[a.d.group] - RANK[b.d.group] || a.i - b.i)
    .map((x) => x.d);
}

interface IconProps {
  readonly className?: string;
  readonly strokeWidth?: number;
  readonly "aria-hidden"?: boolean | "true";
}

const ICONS: Record<TaskKey, ComponentType<IconProps>> = {
  members: Users,
  settings: Settings2,
  audit: History,
  items: Package,
  warehouses: Warehouse,
  receive: PackagePlus,
  issue: Truck,
  transfer: ArrowLeftRight,
  count: ClipboardCheck,
  lookup: MapPinned,
  undo: Undo2,
};

function TaskIcon({ name, className }: { name: TaskKey; className: string }): ReactNode {
  const Icon = ICONS[name];
  return <Icon className={className} strokeWidth={2} aria-hidden="true" />;
}

// Tam sınıf adları (Tailwind kaynak taraması için sabit dizgi). Döşeme zemini = açık `*-bg`, ikon = aynı ailenin koyu `*-ink`'i.
const TONE: Record<TaskTone, { tile: string; icon: string; chip: string }> = {
  inbound: { tile: "border-transparent bg-success-bg", icon: "bg-surface text-success-ink", chip: "bg-success-bg text-success-ink" },
  outbound: { tile: "border-transparent bg-warning-bg", icon: "bg-surface text-warning-ink", chip: "bg-warning-bg text-warning-ink" },
  move: { tile: "border-transparent bg-info-bg", icon: "bg-surface text-info-ink", chip: "bg-info-bg text-info-ink" },
  count: { tile: "border-transparent bg-count-bg", icon: "bg-surface text-count-ink", chip: "bg-count-bg text-count-ink" },
  catalog: { tile: "border-transparent bg-accent-soft", icon: "bg-surface text-accent-ink", chip: "bg-accent-soft text-accent-ink" },
  undo: { tile: "border-transparent bg-undo-bg", icon: "bg-surface text-undo-ink", chip: "bg-undo-bg text-undo-ink" },
  admin: { tile: "border-border bg-surface", icon: "bg-locked-bg text-ink-muted", chip: "bg-locked-bg text-ink-muted" },
};

// Telefon ızgarası: 1. satır "Yakında" düğmesi (otomatik yükseklik), altında N eşit satır. Sınıflar Tailwind kaynak taraması için
// sabit dizgidir (en çok 6 iş); en az yükseklik = N x 4,5 rem + aralıklar + düğme (3,5 rem).
const GRID_ROWS: Record<number, string> = {
  1: "phone:grid-rows-[auto_repeat(1,minmax(0,1fr))] phone:min-h-[calc(4.5rem+3.5rem)]",
  2: "phone:grid-rows-[auto_repeat(2,minmax(0,1fr))] phone:min-h-[calc(9.5rem+3.5rem)]",
  3: "phone:grid-rows-[auto_repeat(3,minmax(0,1fr))] phone:min-h-[calc(14.5rem+3.5rem)]",
  4: "phone:grid-rows-[auto_repeat(4,minmax(0,1fr))] phone:min-h-[calc(19.5rem+3.5rem)]",
  5: "phone:grid-rows-[auto_repeat(5,minmax(0,1fr))] phone:min-h-[calc(24.5rem+3.5rem)]",
  6: "phone:grid-rows-[auto_repeat(6,minmax(0,1fr))] phone:min-h-[calc(29.5rem+3.5rem)]",
};
// Satır numarası = 1 (düğme) + N - sıra: ilk iş (sıra 0) en alt satırda.
const ROW_START: Record<number, string> = {
  2: "phone:row-start-2",
  3: "phone:row-start-3",
  4: "phone:row-start-4",
  5: "phone:row-start-5",
  6: "phone:row-start-6",
  7: "phone:row-start-7",
};

const TILE_BASE = "task-tile relative flex min-h-12 min-w-0 w-full flex-col gap-3 rounded-card border-2 p-4 text-left shadow-card";
const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

export interface TaskTileProps {
  readonly name: TaskKey;
  readonly tone: TaskTone;
  readonly title: string;
  readonly description?: string;
  /** Yalnızca uygulama içi yol (sabit önekten üretilir). */
  readonly href?: `/${string}`;
  /** Yetki yok: bağlantı değil, `aria-disabled`; gerekçe metni çağırandan (i18n). */
  readonly locked?: { readonly reason: string };
  /** Kapalı özellik: kilitten ayrı görsel/metin; işlev yok (G-07). */
  readonly soon?: { readonly label: string };
}

/** İş döşemesi. Durum `data-state`te (active | locked | soon); kategori rengi `TONE`, ikon + metin her zaman var. */
export function TaskTile({ name, tone: toneKey, title, description, href, locked, soon }: TaskTileProps): ReactNode {
  const tone = TONE[toneKey];
  const head = (extra: ReactNode, badgeClass: string) => (
    <span className="tile-head flex items-start justify-between gap-2">
      <span aria-hidden="true" className={`tile-badge flex size-14 shrink-0 items-center justify-center rounded-full ${badgeClass}`}>
        <TaskIcon name={name} className="size-6" />
      </span>
      {extra}
    </span>
  );
  const body = (text: string | undefined, textClass: string) => (
    <span className="tile-body flex min-w-0 flex-col gap-1">
      <span className="tile-title break-words text-xl font-bold">{title}</span>
      {text ? <span className={`tile-desc break-words text-base ${textClass}`}>{text}</span> : null}
    </span>
  );
  if (soon) {
    return (
      <div role="group" aria-disabled="true" aria-label={title} data-state="soon" tabIndex={0} className={`${TILE_BASE} ${FOCUS} border-dashed border-border bg-surface text-ink`}>
        {head(
          <span className="inline-flex min-h-8 items-center gap-1 rounded-control bg-accent-soft px-3 text-sm font-semibold text-accent-ink">
            <Clock aria-hidden="true" className="size-4" />
            {soon.label}
          </span>,
          tone.chip,
        )}
        {body(description, "")}
      </div>
    );
  }
  if (locked) {
    return (
      <div role="group" aria-disabled="true" aria-label={title} data-state="locked" tabIndex={0} className={`${TILE_BASE} ${FOCUS} border-dashed border-border bg-locked-bg text-locked-ink`}>
        {head(<Lock aria-hidden="true" className="tile-lock size-6 shrink-0 text-locked-ink" />, `${tone.icon} opacity-80`)}
        {body(locked.reason, "")}
      </div>
    );
  }
  return (
    <a href={href} data-state="active" data-tone={toneKey} className={`${TILE_BASE} ${FOCUS} ${tone.tile} text-ink`}>
      {head(null, tone.icon)}
      {body(description, "")}
      <ChevronRight aria-hidden="true" className="tile-chevron size-6 shrink-0" />
    </a>
  );
}

export async function TaskMenu({ slug, allowed }: TaskMenuProps) {
  const t = await getTranslations("home");
  const base = `/t/${encodeURIComponent(slug)}` as const;
  const hrefs: Partial<Record<TaskKey, { allowed: boolean; href: `/${string}` }>> = {
    members: { allowed: allowed.usersManage, href: `${base}/members` },
    settings: { allowed: allowed.settingsManage, href: `${base}/settings` },
    audit: { allowed: allowed.auditView, href: `${base}/audit` },
    // Ürün kartı (T-216): okuma `stock.view`; bayrak yalnızca gösterimdir, sayfa/eylem yetkiyi sunucuda denetler.
    items: { allowed: allowed.stockView, href: `${base}/items` },
    // Okuma `stock.view` (her rol); yazma kilidi hedef sayfada gösterilir, asıl yetki sunucudadır (T-205).
    warehouses: { allowed: true, href: `${base}/warehouses` },
  };
  const ordered = orderTasks(TASKS);
  const tiles = ordered.filter((d) => hrefs[d.key] !== undefined);
  const soon = ordered.filter((d) => hrefs[d.key] === undefined);
  // Telefonda tek sütun, eşit yükseklikli yatay satırlar; en çok 6 iş için alttan yukarı doldurma. Daha çok iş olursa doldurma
  // kapanır ve içerik alanı kayar (takip: 2 sütun).
  const reverse = tiles.length >= 1 && tiles.length <= 6;
  const items: ReactNode[] = [];

  if (soon.length > 0) {
    items.push(
      <li key="soon-toggle" className={`soon-row min-w-0 ${reverse ? "phone:row-start-1" : ""}`}>
        <details className="soon-toggle">
          <summary className={`${FOCUS} flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-2xl border-2 border-dashed border-border bg-surface px-3 text-sm font-bold text-ink`}>
            <Clock aria-hidden="true" className="size-5 shrink-0 text-accent-ink" />
            <span className="soon-when-closed min-w-0 flex-1 truncate">{t("soonList.toggle", { count: soon.length })}</span>
            <span className="soon-when-open min-w-0 flex-1 truncate">{t("soonList.back")}</span>
            <span aria-hidden="true" className="soon-chips flex shrink-0 items-center gap-1">
              {soon.map((d) => (
                <span key={d.key} className={`flex size-7 items-center justify-center rounded-full ${TONE[d.tone].chip}`}>
                  <TaskIcon name={d.key} className="size-4" />
                </span>
              ))}
            </span>
            <ChevronDown aria-hidden="true" className="soon-chevron size-5 shrink-0" />
          </summary>
        </details>
      </li>,
    );
  }
  tiles.forEach((d, i) => {
    const h = hrefs[d.key];
    if (h === undefined) return;
    const title = t(`tasks.${d.key}.title`);
    const pos = reverse ? (ROW_START[1 + tiles.length - i] ?? "") : "";
    items.push(
      <li key={d.key} className={`task-item flex min-w-0 ${pos}`}>
        {h.allowed ? (
          <TaskTile name={d.key} tone={d.tone} title={title} description={t(`tasks.${d.key}.description`)} href={h.href} />
        ) : (
          <TaskTile name={d.key} tone={d.tone} title={title} locked={{ reason: t("lockedReason") }} />
        )}
      </li>,
    );
  });
  for (const d of soon) {
    items.push(
      <li key={d.key} className="soon-item flex min-w-0">
        <TaskTile name={d.key} tone={d.tone} title={t(`tasks.${d.key}.title`)} description={t("soonWarehouse")} soon={{ label: t("soonLabel") }} />
      </li>,
    );
  }

  return (
    <ul
      aria-label={t("tasksLabel")}
      className={`task-grid m-0 grid min-w-0 list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3 phone:grid-cols-1 phone:gap-2 ${reverse ? (GRID_ROWS[tiles.length] ?? "") : ""}`}
    >
      {items}
    </ul>
  );
}
