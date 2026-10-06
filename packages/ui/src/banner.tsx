import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";

export type BannerKind = "info" | "warning" | "error" | "success";

export interface BannerProps {
  kind: BannerKind;
  children: ReactNode;
}

const KIND: Record<BannerKind, { cls: string; iconCls: string; role: "status" | "alert"; Icon: typeof Info }> = {
  info: { cls: "bg-info-bg text-info-ink", iconCls: "text-info", role: "status", Icon: Info },
  warning: { cls: "bg-warning-bg text-warning-ink", iconCls: "text-warning", role: "status", Icon: TriangleAlert },
  error: { cls: "bg-danger-bg text-danger-ink", iconCls: "text-danger", role: "alert", Icon: CircleAlert },
  success: { cls: "bg-success-bg text-success-ink", iconCls: "text-success", role: "status", Icon: CircleCheck },
};

/** Uyarı bandı (örn. "Demo ortamı"). Metin çağırandan gelir. */
export function Banner({ kind, children }: BannerProps) {
  const { cls, iconCls, role, Icon } = KIND[kind];
  return (
    <div role={role} data-kind={kind} className={`flex min-h-12 items-start gap-3 rounded-card px-4 py-3 ${cls}`}>
      <Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${iconCls}`} />
      <div className="min-w-0 break-words text-base font-medium">{children}</div>
    </div>
  );
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Sonraki eylem (örn. Button). */
  action?: ReactNode;
}

/** Boş durum: ne olduğu + sonraki eylem. */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card bg-surface p-6 text-center">
      {icon ? (
        <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          {icon}
        </span>
      ) : null}
      <p className="break-words text-lg font-bold text-ink">{title}</p>
      {description ? <p className="break-words text-base text-ink-muted">{description}</p> : null}
      {action}
    </div>
  );
}

export interface ActivityItem {
  id: string;
  /** Yerelleştirilmiş saat metni (örn. "09:42"); biçimlendirme çağırandadır. */
  time: string;
  /** `<time dateTime>` için makine biçimi (isteğe bağlı). */
  dateTime?: string;
  text: string;
  icon?: ReactNode;
}

export interface ActivityListProps {
  title: string;
  items: readonly ActivityItem[];
  /** Liste boşken gösterilen metin. */
  emptyText: string;
}

/** "Bugün yaptıkların": saat + metin satırları. Büyük liste sanallaştırması ilk kullanan kartta. */
export function ActivityList({ title, items, emptyText }: ActivityListProps) {
  return (
    <section className="rounded-card bg-surface p-4 shadow-card">
      <h2 className="mb-2 text-lg font-bold text-ink">{title}</h2>
      {items.length === 0 ? (
        <p className="py-3 text-base text-ink-muted">{emptyText}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {items.map((it) => (
            <li key={it.id} className="flex min-h-12 items-center gap-3 border-b border-border py-2 last:border-b-0">
              {it.icon ? (
                <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                  {it.icon}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 break-words text-base text-ink">{it.text}</span>
              <time dateTime={it.dateTime} className="shrink-0 text-sm text-ink-muted">
                {it.time}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
