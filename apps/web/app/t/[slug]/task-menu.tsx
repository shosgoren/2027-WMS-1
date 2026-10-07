import type { ComponentType, CSSProperties, ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import {
  ArrowLeftRight,
  Banner,
  Boxes,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock,
  History,
  ListChecks,
  Lock,
  MapPinned,
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
// Telefonda ızgara alttan yukarı dolar (başparmak bölgesi): ilk sıradaki iş en alt satırda. İzinli işler döşemedir; yetkisiz işler
// ve "Yakında" işleri ızgarada yer kaplamaz: üstteki iki tek satırlık düğmeyle (details, birlikte yalnız biri açık) ayrı liste olarak
// açılır; açılan liste alttan yukarı dolar ve kapatma düğmesi başparmağa yakın (altta) durur. Ekran okuyucu/odak sırası DOM
// sırasıdır. Masaüstü/tablet yerleşimi `md:`/`lg:` ızgarasıdır (düğmeler gizli, tüm iş döşemeleri görünür).

/** Saha rolleri için "Görevlerim" özeti (gerçek `listMyTasks` sayımı; sahte veri yok, G-07). Hata: sunucu mesajı + kod (yutulmaz). */
export type MyTasksSummary =
  | { readonly kind: "count"; readonly count: number; readonly more: boolean }
  | { readonly kind: "error"; readonly message: string; readonly code: string };

export interface TaskMenuProps {
  readonly slug: string;
  readonly allowed: { readonly usersManage: boolean; readonly settingsManage: boolean; readonly auditView: boolean; readonly stockView: boolean; readonly stockPost?: boolean };
  /** Verilirse (yalnız saha rolleri) ızgaranın üstünde telefon özet kartı çizilir. */
  readonly myTasks?: MyTasksSummary;
}

export type TaskKey = "members" | "settings" | "audit" | "items" | "warehouses" | "receive" | "issue" | "transfer" | "count" | "lookup" | "undo";
export type TaskGroup = "field" | "admin";
/** İş kategorisi renk tonu (ADR-020 kural 8): durum anlam renklerinden AYRI `cat-*` belirteçleri. Renk tek taşıyıcı değildir: ikon + metin var. */
export type CatHue = "green" | "orange" | "teal" | "purple" | "sky" | "rose" | "amber" | "cyan" | "indigo" | "slate" | "lilac";

export interface TaskDef {
  readonly key: TaskKey;
  readonly group: TaskGroup;
  readonly hue: CatHue;
}

/** Görev tanımları — sıra kaynağı. Yeni iş eklerken yalnızca bu listeye ve `ICONS`'a eklenir. */
export const TASKS: readonly TaskDef[] = [
  { key: "receive", group: "field", hue: "green" },
  { key: "issue", group: "field", hue: "orange" },
  { key: "transfer", group: "field", hue: "teal" },
  { key: "count", group: "field", hue: "purple" },
  { key: "lookup", group: "field", hue: "sky" },
  { key: "warehouses", group: "field", hue: "cyan" },
  { key: "items", group: "field", hue: "amber" },
  { key: "undo", group: "field", hue: "rose" },
  { key: "audit", group: "admin", hue: "lilac" },
  { key: "members", group: "admin", hue: "indigo" },
  { key: "settings", group: "admin", hue: "slate" },
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
  items: Boxes,
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

// Tam sınıf adları (Tailwind kaynak taraması için sabit dizgi). Döşeme beyaz (`surface`); renk yalnız ikon dairesinde:
// açık `cat-*-bg` zemin + aynı tonun koyu `cat-*-ink` ikonu. `icon` = yalnız ikon rengi (önizleme şeridi).
const HUE: Record<CatHue, { circle: string; icon: string }> = {
  green: { circle: "bg-cat-green-bg text-cat-green-ink", icon: "text-cat-green-ink" },
  orange: { circle: "bg-cat-orange-bg text-cat-orange-ink", icon: "text-cat-orange-ink" },
  teal: { circle: "bg-cat-teal-bg text-cat-teal-ink", icon: "text-cat-teal-ink" },
  purple: { circle: "bg-cat-purple-bg text-cat-purple-ink", icon: "text-cat-purple-ink" },
  sky: { circle: "bg-cat-sky-bg text-cat-sky-ink", icon: "text-cat-sky-ink" },
  rose: { circle: "bg-cat-rose-bg text-cat-rose-ink", icon: "text-cat-rose-ink" },
  amber: { circle: "bg-cat-amber-bg text-cat-amber-ink", icon: "text-cat-amber-ink" },
  cyan: { circle: "bg-cat-cyan-bg text-cat-cyan-ink", icon: "text-cat-cyan-ink" },
  indigo: { circle: "bg-cat-indigo-bg text-cat-indigo-ink", icon: "text-cat-indigo-ink" },
  slate: { circle: "bg-cat-slate-bg text-cat-slate-ink", icon: "text-cat-slate-ink" },
  lilac: { circle: "bg-cat-lilac-bg text-cat-lilac-ink", icon: "text-cat-lilac-ink" },
};

const TILE_BASE = "task-tile relative flex min-h-12 min-w-0 w-full flex-col gap-3 rounded-card border-2 border-border bg-surface p-4 text-left text-ink shadow-card";
const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const ROW = `${FOCUS} flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-2xl border border-border bg-surface px-3 text-sm font-bold text-ink`;

export interface TaskTileProps {
  readonly name: TaskKey;
  readonly hue: CatHue;
  readonly title: string;
  readonly description?: string;
  /** Yalnızca uygulama içi yol (sabit önekten üretilir). */
  readonly href?: `/${string}`;
  /** Yetki yok: bağlantı değil, `aria-disabled`; gerekçe metni çağırandan (i18n). */
  readonly locked?: { readonly reason: string };
  /** Kapalı özellik: kilitten ayrı görsel/metin; işlev yok (G-07). */
  readonly soon?: { readonly label: string };
}

/** İş döşemesi. Durum `data-state`te (active | locked | soon); renk yalnız ikon dairesinde, ikon + metin her zaman var. */
export function TaskTile({ name, hue, title, description, href, locked, soon }: TaskTileProps): ReactNode {
  const h = HUE[hue];
  const head = (extra: ReactNode, circle: string) => (
    <span className="tile-head flex items-start justify-between gap-2">
      <span aria-hidden="true" className={`tile-badge flex size-14 shrink-0 items-center justify-center rounded-full ${circle}`}>
        <TaskIcon name={name} className="size-6" />
      </span>
      {extra}
    </span>
  );
  const body = (text: string | undefined) => (
    <span className="tile-body flex min-w-0 flex-col gap-1">
      <span className="tile-title break-words text-xl font-bold">{title}</span>
      {text ? <span className="tile-desc break-words text-base">{text}</span> : null}
    </span>
  );
  if (soon) {
    return (
      <div role="group" aria-disabled="true" aria-label={title} data-state="soon" tabIndex={0} className={`${TILE_BASE} ${FOCUS}`}>
        {head(<span className="tile-soon inline-flex min-h-6 items-center rounded-control bg-locked-bg px-2 text-xs font-semibold text-ink-muted">{soon.label}</span>, h.circle)}
        {body(description)}
      </div>
    );
  }
  if (locked) {
    return (
      <div role="group" aria-disabled="true" aria-label={title} data-state="locked" tabIndex={0} className={`${TILE_BASE} ${FOCUS} bg-locked-bg text-locked-ink`}>
        {head(<Lock aria-hidden="true" className="tile-lock size-6 shrink-0 text-locked-ink" />, "bg-surface text-locked-ink")}
        {body(locked.reason)}
      </div>
    );
  }
  return (
    <a href={href} data-state="active" data-hue={hue} className={`${TILE_BASE} ${FOCUS}`}>
      {head(null, h.circle)}
      {body(description)}
      <ChevronRight aria-hidden="true" className="tile-chevron size-6 shrink-0" />
    </a>
  );
}

export async function TaskMenu({ slug, allowed, myTasks }: TaskMenuProps) {
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
    // Saha kabulü (T-313): yazma `stock.post`; yetkisiz kullanıcıya bağlantı verilmez (kilit + gerekçe), FORBIDDEN ekranına götürmez.
    receive: { allowed: allowed.stockPost === true, href: `${base}/field/receive` },
  };
  const ordered = orderTasks(TASKS);
  const real = ordered.filter((d) => hrefs[d.key] !== undefined);
  const active = real.filter((d) => hrefs[d.key]?.allowed === true);
  const locked = real.filter((d) => hrefs[d.key]?.allowed !== true);
  const soon = ordered.filter((d) => hrefs[d.key] === undefined);
  // Telefonda tek sütun, eşit yükseklikli yatay satırlar; en çok 6 izinli iş için alttan yukarı doldurma (CSS değişkenleri `--rows`,
  // `--row`). Daha çok iş olursa doldurma kapanır ve içerik alanı kayar (takip: 2 sütun).
  const reverse = active.length >= 1 && active.length <= 6;
  const hasCard = reverse && myTasks !== undefined;
  const gridStyle = reverse ? ({ "--rows": active.length } as CSSProperties) : undefined;
  const items: ReactNode[] = [];

  if (locked.length > 0 || soon.length > 0) {
    items.push(
      <li key="more" className="top-rows min-w-0">
        {locked.length > 0 ? (
          <details className="locked-toggle" name="task-more">
            <summary className={ROW}>
              <Lock aria-hidden="true" className="row-lock size-5 shrink-0 text-ink-muted" />
              <span className="when-closed min-w-0 flex-1 truncate">{t("lockedList.toggle", { count: locked.length })}</span>
              <span className="when-open min-w-0 flex-1 truncate">{t("soonList.back")}</span>
              <ChevronDown aria-hidden="true" className="row-chevron size-5 shrink-0" />
            </summary>
          </details>
        ) : null}
        {soon.length > 0 ? (
          <details className="soon-toggle" name="task-more">
            <summary className={ROW}>
              <span className="when-closed min-w-0 flex-1 truncate">{t("soonList.toggle", { count: soon.length })}</span>
              <span className="when-open min-w-0 flex-1 truncate">{t("soonList.back")}</span>
              <span aria-hidden="true" className="soon-preview flex shrink-0 items-center gap-0.5">
                {soon.map((d) => (
                  <TaskIcon key={d.key} name={d.key} className={`size-3.5 ${HUE[d.hue].icon}`} />
                ))}
              </span>
              <ChevronDown aria-hidden="true" className="row-chevron size-5 shrink-0" />
            </summary>
          </details>
        ) : null}
      </li>,
    );
  }
  if (hasCard && myTasks !== undefined) {
    const mt = myTasks;
    items.push(
      <li key="my-tasks" className="my-tasks-row min-w-0">
        {mt.kind === "error" ? (
          <Banner kind="warning">
            <p>{mt.message}</p>
            <p className="mt-1 text-sm">{mt.code}</p>
          </Banner>
        ) : mt.count > 0 ? (
          <a href={`${base}/field/tasks`} data-testid="my-tasks-card" className={`my-tasks ${FOCUS} flex min-h-16 w-full items-center gap-4 rounded-2xl border-2 border-border bg-surface p-4 text-ink shadow-card`}>
            <span aria-hidden="true" className="my-tasks-count text-6xl font-extrabold leading-none">
              {mt.more ? `${mt.count}+` : mt.count}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-semibold text-ink-muted">{t("myTasks.title")}</span>
              <span className="break-words text-lg font-bold">{t("myTasks.assigned", { count: mt.more ? `${mt.count}+` : String(mt.count) })}</span>
            </span>
            <ChevronRight aria-hidden="true" className="size-6 shrink-0" />
          </a>
        ) : (
          <p data-testid="my-tasks-empty" className="my-tasks my-tasks-empty m-0 flex min-h-16 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-surface px-4 text-center text-base font-semibold text-ink-muted">
            <ListChecks aria-hidden="true" className="size-10" />
            {t("myTasks.empty")}
          </p>
        )}
      </li>,
    );
  }
  active.forEach((d, i) => {
    const h = hrefs[d.key];
    if (h === undefined) return;
    const row = reverse ? ({ "--row": active.length + (hasCard ? 2 : 1) - i } as CSSProperties) : undefined;
    items.push(
      <li key={d.key} className="task-item flex min-w-0" style={row}>
        <TaskTile name={d.key} hue={d.hue} title={t(`tasks.${d.key}.title`)} description={t(`tasks.${d.key}.description`)} href={h.href} />
      </li>,
    );
  });
  if (locked.length > 0) {
    items.push(
      <li key="locked-note" className="locked-note min-w-0 text-base font-semibold text-ink">
        <Lock aria-hidden="true" className="size-10 text-ink-muted" />
        <span className="break-words">{t("lockedReason")}</span>
      </li>,
    );
  }
  for (const d of locked) {
    items.push(
      <li key={d.key} className="locked-item flex min-w-0">
        <TaskTile name={d.key} hue={d.hue} title={t(`tasks.${d.key}.title`)} locked={{ reason: t("lockedReason") }} />
      </li>,
    );
  }
  if (soon.length > 0) {
    items.push(
      <li key="soon-note" className="soon-note min-w-0 text-base font-semibold text-ink">
        <Clock aria-hidden="true" className="size-10 text-ink-muted" />
        <span className="break-words">{t("soonWarehouse")}</span>
      </li>,
    );
  }
  for (const d of soon) {
    items.push(
      <li key={d.key} className="soon-item flex min-w-0">
        <TaskTile name={d.key} hue={d.hue} title={t(`tasks.${d.key}.title`)} description={t("soonWarehouse")} soon={{ label: t("soonLabel") }} />
      </li>,
    );
  }

  return (
    <ul
      aria-label={t("tasksLabel")}
      style={gridStyle}
      className={`task-grid m-0 grid min-w-0 list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3 phone:grid-cols-1 phone:gap-2 ${reverse ? "task-grid-fill" : ""} ${hasCard ? "task-grid-card" : ""}`}
    >
      {items}
    </ul>
  );
}
