"use client";
// Form sayfası (T-250): telefonda tam ekran tek sütun, masaüstünde ortalı pencere. Yapı: başlık (sabit) · gövde (kendi içinde kayar) ·
// eylem çubuğu (altta sabit, başparmak erişimi). Sayfa gövdesi kaymaz: kaydırma yalnızca `body` alanındadır. `<dialog>` modal olduğundan
// odak tuzağı ve Escape tarayıcıdadır. Çağıran, açıkken arkadaki sayfa içeriğini `hidden` ile gizler (`useHideWhile`).
import { useEffect, useRef } from "react";
import type { FormEvent, ReactNode } from "react";

export function Sheet({
  open,
  title,
  titleId,
  onClose,
  onSubmit,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  titleId: string;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Eylem çubuğu içeriği (düğmeler). */
  footer: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (open) onClose();
      }}
      className="m-0 h-dvh max-h-dvh w-screen max-w-none flex-col overflow-hidden rounded-none border-0 bg-surface p-0 text-ink shadow-card backdrop:bg-ink/50 open:flex sm:m-auto sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[min(32rem,calc(100vw-2rem))] sm:rounded-card"
    >
      {open ? (
        <form onSubmit={onSubmit} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <h2 id={titleId} className="shrink-0 break-words border-b-2 border-border px-4 py-3 text-xl font-bold">
            {title}
          </h2>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">{children}</div>
          <div className="flex shrink-0 flex-col-reverse gap-3 border-t-2 border-border bg-surface p-3 sm:flex-row sm:justify-end">{footer}</div>
        </form>
      ) : null}
    </dialog>
  );
}

/** Form açıkken arkadaki sayfa içeriğini akıştan çıkarır (sayfa gövdesi kaymasın; yalnız form kendi içinde kayar). */
export function PageBody({ hide, children }: { hide: boolean; children: ReactNode }) {
  return (
    <div data-hide={hide} className="flex min-w-0 flex-col gap-4 data-[hide=true]:hidden">
      {children}
    </div>
  );
}
