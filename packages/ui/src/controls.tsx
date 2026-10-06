"use client";

import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes } from "react";
import { LoaderCircle } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "danger";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  /** Yükleniyor: tıklama engellenir, `aria-busy` işaretlenir. */
  loading?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent",
  secondary: "border-2 border-border bg-surface text-ink",
  danger: "bg-undo-ink text-on-accent",
};

export function Button({ variant = "primary", loading = false, disabled, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      className={`inline-flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-control px-6 text-base font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60 ${VARIANT[variant]}`}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="size-5 animate-spin" /> : null}
      {children}
    </button>
  );
}

export interface FieldError {
  /** Neden hatalı. */
  reason: string;
  /** Sonraki eylem (ne yapmalı). */
  action: string;
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> {
  label: string;
  hint?: string;
  error?: FieldError;
}

export function TextField({ label, hint, error, ...rest }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-base font-semibold text-ink">
        {label}
      </label>
      {hint ? (
        <span id={hintId} className="text-sm text-ink-muted">
          {hint}
        </span>
      ) : null}
      <input
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="min-h-12 w-full min-w-0 rounded-card border-2 border-border bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[invalid=true]:border-undo-ink"
      />
      {error ? (
        <span id={errId} role="alert" className="break-words text-sm font-medium text-undo-ink">
          {error.reason} {error.action}
        </span>
      ) : null}
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Eylemin etkisi (yıkıcı işlem onayı öncesi gösterilir). */
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Onay beklerken (örn. sunucu çağrısı) onay düğmesi yükleniyor olur. */
  loading?: boolean;
  /** Yıkıcı değilse birincil düğme; varsayılan tehlikeli. */
  variant?: "primary" | "danger";
}

/** `cancel` (Esc): yükleniyorken engellenir ve `onCancel` çağrılmaz; değilse tarayıcı kapatması yerine üst bileşen karar verir. */
export function handleDialogCancel(
  event: { preventDefault: () => void },
  loading: boolean,
  onCancel: () => void,
): void {
  event.preventDefault();
  if (loading) return;
  onCancel();
}

/**
 * `close` olayı: HTML close-watcher kuralında history-action activation yokken ardışık ikinci
 * kapatma isteğinde `cancel` iptal edilemez ve dialog kendiliğinden kapanır (WHATWG HTML, "request
 * to close a close watcher": canPreventClose=false). Bileşen hâlâ `open` ise durum eşitlenir:
 * yükleniyorsa `onCancel` çağrılmaz ve dialog yeniden açılır (sunucu çağrısı sürerken modal kaybolmaz);
 * değilse kapanış isteği `onCancel` ile üst bileşene bildirilir (Esc ile aynı sözleşme).
 */
export function handleDialogClose(
  el: { open: boolean; isConnected?: boolean; showModal: () => void },
  loading: boolean,
  onCancel: () => void,
): void {
  if (el.open || el.isConnected === false) return;
  if (loading) {
    el.showModal();
    return;
  }
  onCancel();
}

/** Yerel `<dialog>` (showModal): odak tuzağı ve Esc tarayıcıdan. Kapalıyken içerik render edilmez. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  loading = false,
  variant = "danger",
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => handleDialogCancel(e, loading, onCancel)}
      onClose={(e) => handleDialogClose(e.currentTarget, loading, onCancel)}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border-0 bg-surface p-6 text-ink shadow-card backdrop:bg-ink/50"
    >
      <h2 id={titleId} className="mb-2 break-words text-xl font-bold">
        {title}
      </h2>
      <p id={descId} className="mb-6 break-words text-base text-ink-muted">
        {description}
      </p>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button variant={variant} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
