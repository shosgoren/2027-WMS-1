"use client";
// Ana ekran ikincil listeleri: "Yetkin olmayan işler" ve "Yakında gelecekler" (T-274, DESIGN_REVIEW §7.3 B-01).
// Telefonda iki tek satırlık düğme (şevronlu) kararmış ana ekran üzerinde ALT SAYFA (bottom sheet) açar. Satırlar sunucuda üretilir
// (`task-menu.tsx`, yetki gösterimi ve metinler sunucudan); bu dosya yalnız açma/kapama, odak ve hareketleri yönetir.
// - Yerel `<dialog>` modal: odak tuzağı, Esc, kararmış arka plan ve odağın açan düğmeye dönmesi tarayıcıdadır.
// - Arka plana dokunma: `dialog`'un kendisine gelen tıklama (alt sayfa kutusu `dialog` kutusunu doldurur, arka plan ::backdrop'tur).
// - Aşağı kaydırma: tutamaç + başlık satırında işaretçi olayları; ≥ 80 px aşağı çekmek kapatır, daha azı geri döner.
// - Yükseklik içeriğe uyar (en çok görünür yüksekliğin %85'i); kapatma düğmesi en altta (başparmak).
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ChevronDown, Clock, Lock } from "@wms/ui";

const SWIPE_CLOSE_PX = 80;
const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const ROW = `${FOCUS} flex min-h-12 cursor-pointer items-center gap-2 rounded-2xl border border-border bg-surface px-3 text-sm font-bold text-ink`;

export interface MoreList {
  readonly toggle: string;
  readonly note: string;
  readonly rows: ReactNode;
  /** Düğmede küçük renkli ikon önizlemesi (yalnız "Yakında"). */
  readonly preview?: ReactNode;
}

export function MoreToggles({ locked, soon, closeLabel }: { locked: MoreList | null; soon: MoreList | null; closeLabel: string }) {
  const [open, setOpen] = useState<"locked" | "soon" | null>(null);
  const list = open === "locked" ? locked : open === "soon" ? soon : null;
  return (
    <>
      {locked === null ? null : (
        <button type="button" className={`locked-toggle ${ROW} w-full text-left`} aria-haspopup="dialog" aria-expanded={open === "locked"} onClick={() => setOpen("locked")}>
          <Lock aria-hidden="true" className="size-5 shrink-0 text-ink-muted" />
          <span className="when-closed min-w-0 flex-1 truncate">{locked.toggle}</span>
          <ChevronDown aria-hidden="true" className="row-chevron size-5 shrink-0" />
        </button>
      )}
      {soon === null ? null : (
        <button type="button" className={`soon-toggle ${ROW} w-full text-left`} aria-haspopup="dialog" aria-expanded={open === "soon"} onClick={() => setOpen("soon")}>
          <span className="when-closed min-w-0 flex-1 truncate">{soon.toggle}</span>
          <span aria-hidden="true" className="soon-preview flex shrink-0 items-center gap-0.5">
            {soon.preview}
          </span>
          <ChevronDown aria-hidden="true" className="row-chevron size-5 shrink-0" />
        </button>
      )}
      <MoreSheet
        open={list !== null}
        label={list?.toggle ?? ""}
        icon={open === "locked" ? <Lock aria-hidden="true" className="size-5 shrink-0 text-ink-muted" /> : <Clock aria-hidden="true" className="size-5 shrink-0 text-ink-muted" />}
        note={list?.note ?? ""}
        closeLabel={closeLabel}
        onClose={() => setOpen(null)}
      >
        <ul className="task-grid sheet-rows m-0 flex min-w-0 list-none flex-col gap-2 p-0">{list?.rows}</ul>
      </MoreSheet>
    </>
  );
}

function MoreSheet({ open, label, icon, note, closeLabel, onClose, children }: { open: boolean; label: string; icon: ReactNode; note: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const start = useRef<number | null>(null);
  const dy = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // Açılışta odak başlık satırına (ekran okuyucu bağlamı duyar; ilk satırda tuhaf odak halkası olmaz).
      noteRef.current?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);
  // Odak tuzağı: Tab/Shift+Tab alt sayfanın içinde döner (yerel modal odak tuzağı tarayıcı arayüzüne çıkabilir).
  const trap = (e: ReactKeyboardEvent<HTMLDialogElement>): void => {
    if (e.key !== "Tab" || !panel.current) return;
    const f = Array.from(panel.current.querySelectorAll<HTMLElement>('a[href], button, [tabindex="0"]'));
    const first = f[0];
    const last = f[f.length - 1];
    if (first === undefined || last === undefined) return;
    const at = document.activeElement;
    if (e.shiftKey && at === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const move = (y: number): void => {
    if (panel.current) panel.current.style.transform = y === 0 ? "" : `translateY(${y}px)`;
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    start.current = e.clientY;
    dy.current = 0;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const drag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (start.current === null) return;
    dy.current = Math.max(0, e.clientY - start.current);
    move(dy.current);
  };
  const up = (): void => {
    if (start.current === null) return;
    const far = dy.current >= SWIPE_CLOSE_PX;
    start.current = null;
    dy.current = 0;
    move(0);
    if (far) onClose();
  };
  return (
    <dialog
      ref={ref}
      aria-label={label}
      aria-modal="true"
      data-testid="more-sheet"
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={trap}
      className="fixed inset-x-0 bottom-0 top-auto m-0 h-auto max-h-none w-full max-w-none bg-transparent p-0 text-ink backdrop:bg-ink/50"
    >
      {open ? (
        <div ref={panel} className="flex max-h-[85dvh] min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain rounded-t-3xl border-t border-border bg-bg px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div data-testid="sheet-header" className="flex shrink-0 touch-none flex-col gap-1" onPointerDown={down} onPointerMove={drag} onPointerUp={up} onPointerCancel={up}>
            <div aria-hidden="true" className="flex h-6 items-center justify-center">
              <span className="h-1.5 w-12 rounded-full bg-border-strong" />
            </div>
            <p ref={noteRef} tabIndex={-1} className="m-0 flex items-center gap-2 px-1 text-base font-semibold text-ink outline-none">
              {icon}
              <span className="min-w-0 break-words">{note}</span>
            </p>
          </div>
          {children}
          <button type="button" onClick={onClose} className={`${ROW} w-full justify-center`}>
            {closeLabel}
          </button>
        </div>
      ) : null}
    </dialog>
  );
}
