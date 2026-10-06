import type { ReactNode } from "react";
import { Clock, Lock } from "lucide-react";

export type TaskCardTone = "accent" | "warning" | "undo";

export interface TaskCardProps {
  /** Dekoratif ikon (örn. lucide); erişilebilir ad başlıktan gelir. */
  icon: ReactNode;
  title: string;
  description?: string;
  /** Yalnızca uygulama içi yol (`/` ile başlar); geçersizse çalışma anında bağlantısız render edilir. */
  href?: `/${string}`;
  /** Yetki yok: bağlantı değil, `aria-disabled`; gerekçe metni çağırandan (i18n). */
  locked?: { reason: string };
  /** Kapalı özellik bayrağı: kilitten ayrı görsel/metin; işlev yok (G-07). */
  soon?: { label: string };
  tone?: TaskCardTone;
}

const TONE: Record<TaskCardTone, { ring: string; badge: string }> = {
  accent: { ring: "border-accent-soft", badge: "bg-accent-soft text-accent-ink" },
  warning: { ring: "border-warning-bg", badge: "bg-warning-bg text-warning-ink" },
  undo: { ring: "border-undo-bg", badge: "bg-undo-bg text-undo" },
};

const BASE =
  "flex min-h-12 min-w-0 w-full flex-col gap-3 rounded-card border-2 p-4 text-left shadow-card";
const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * Uygulama içi yol: `/` ile başlar, `//` ile başlamaz; `\`, kontrol karakteri ve `.`/`..` yol
 * parçası (kodlanmış `%2e` dahil) içermez — `/..//evil` tarayıcıda `//evil` yoluna çözülür ve
 * ileride yolu `Location`'a yazan bir yönlendirmede açık yönlendirmeye dönüşebilir. Yol kısmında
 * kodlanmış ayraç (`%2f`, `%5c`) ve çift kodlama öncüsü (`%25`) da reddedilir: decode edilince
 * `//host` veya `\host` üretebilirler. Sorgu/parça kısmı bu kuraldan muaftır (örn. `?next=%2Fa`).
 */
export function isSafeInternalHref(href: string | undefined): href is `/${string}` {
  if (typeof href !== "string") return false;
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(href)) return false;
  const path = href.split(/[?#]/, 1)[0] ?? "";
  if (/%(?:2f|5c|25)/i.test(path)) return false;
  return !path.split("/").some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg));
}

/** Görev kartı. Kilitli ve "yakında" durumları `data-state` ve farklı ikon/metinle ayrışır. */
export function TaskCard({ icon, title, description, href, locked, soon, tone = "accent" }: TaskCardProps) {
  const t = TONE[tone];
  const head = (badge: ReactNode, badgeClass: string) => (
    <span className="flex items-start justify-between gap-2">
      <span
        aria-hidden="true"
        className={`flex size-12 shrink-0 items-center justify-center rounded-full ${badgeClass}`}
      >
        {icon}
      </span>
      {badge}
    </span>
  );

  if (locked) {
    return (
      <div
        role="group"
        aria-disabled="true"
        aria-label={title}
        data-state="locked"
        tabIndex={0}
        className={`${BASE} ${FOCUS} border-border bg-locked-bg text-locked-ink`}
      >
        {head(<Lock aria-hidden="true" className="size-6 shrink-0 text-locked-ink" />, "bg-border text-locked-ink")}
        <span className="break-words text-xl font-bold">{title}</span>
        <span className="break-words text-base">{locked.reason}</span>
      </div>
    );
  }

  if (soon) {
    return (
      <div
        role="group"
        aria-disabled="true"
        aria-label={title}
        data-state="soon"
        tabIndex={0}
        className={`${BASE} ${FOCUS} border-dashed border-border bg-surface text-ink-muted`}
      >
        {head(
          <span className="inline-flex min-h-8 items-center gap-1 rounded-control bg-accent-soft px-3 text-sm font-semibold text-accent-ink">
            <Clock aria-hidden="true" className="size-4 text-accent-ink" />
            {soon.label}
          </span>,
          t.badge,
        )}
        <span className="break-words text-xl font-bold">{title}</span>
        {description ? <span className="break-words text-base">{description}</span> : null}
      </div>
    );
  }

  const body = (
    <>
      {head(null, t.badge)}
      <span className="break-words text-xl font-bold text-ink">{title}</span>
      {description ? <span className="break-words text-base text-ink">{description}</span> : null}
    </>
  );
  if (href === undefined) {
    return (
      <div data-state="active" className={`${BASE} ${t.ring} bg-surface`}>
        {body}
      </div>
    );
  }
  if (isSafeInternalHref(href)) {
    return (
      <a href={href} data-state="active" className={`${BASE} ${FOCUS} ${t.ring} bg-surface`}>
        {body}
      </a>
    );
  }
  // Geçersiz bağlantı: etkin görünmez (kesikli çerçeve, soluk metin, odak halkası yok); durum `data-state`te görünür.
  return (
    <div
      role="group"
      aria-disabled="true"
      aria-label={title}
      data-state="invalid-link"
      className={`${BASE} border-dashed border-border bg-locked-bg text-locked-ink`}
    >
      {head(null, "bg-border text-locked-ink")}
      <span className="break-words text-xl font-bold">{title}</span>
      {description ? <span className="break-words text-base">{description}</span> : null}
    </div>
  );
}
