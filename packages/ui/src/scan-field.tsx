"use client";

import { useId, useState } from "react";
import { Keyboard, ScanLine } from "lucide-react";
import type { FieldError } from "./controls.tsx";

export interface ScanFieldProps {
  label: string;
  /** Son taranan değer (tarama kaynağından; alan salt okunurdur, `inputmode="none"`). */
  value: string;
  /** Elle giriş düğmesi metni (i18n). */
  manualLabel: string;
  /** Elle girilen değeri onaylama düğmesi metni (i18n). */
  confirmLabel: string;
  /** Elle girişten vazgeç düğmesi metni (i18n). */
  cancelLabel: string;
  placeholder?: string;
  error?: FieldError;
  /** Elle girilen değer; çağıran bunu `source: "manual"` olarak işaretler (tarama sayılmaz). */
  onManualSubmit: (value: string) => void;
}

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const BTN = `inline-flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-control px-4 text-base font-bold ${FOCUS}`;

/** Tarama alanı: varsayılan salt okunur + `inputmode="none"` (sanal klavye açılmaz); elle yazım ayrı düğmeyle. */
export function ScanField({ label, value, manualLabel, confirmLabel, cancelLabel, placeholder, error, onManualSubmit }: ScanFieldProps) {
  const id = useId();
  const errId = `${id}-err`;
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = (): void => {
    const v = draft.trim();
    if (v === "") return;
    onManualSubmit(v);
    setDraft("");
    setManual(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-mode={manual ? "manual" : "scan"}>
      <label htmlFor={id} className="flex items-center gap-2 text-base font-semibold text-ink">
        <ScanLine aria-hidden="true" className="size-5 shrink-0" />
        {label}
      </label>
      {manual ? (
        <>
          <input
            id={id}
            type="text"
            inputMode="text"
            autoFocus
            autoComplete="off"
            value={draft}
            placeholder={placeholder}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className={`min-h-12 w-full min-w-0 rounded-card border-2 border-border bg-surface px-4 text-lg text-ink ${FOCUS} aria-[invalid=true]:border-undo-ink`}
          />
          <div className="flex min-w-0 flex-wrap gap-2">
            <button type="button" onClick={submit} className={`${BTN} bg-accent text-on-accent`}>
              {confirmLabel}
            </button>
            <button type="button" onClick={() => setManual(false)} className={`${BTN} border-2 border-border bg-surface text-ink`}>
              {cancelLabel}
            </button>
          </div>
        </>
      ) : (
        <>
          <input
            id={id}
            type="text"
            inputMode="none"
            readOnly
            autoComplete="off"
            value={value}
            placeholder={placeholder}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            className={`min-h-12 w-full min-w-0 rounded-card border-2 border-border bg-surface px-4 text-lg text-ink ${FOCUS} aria-[invalid=true]:border-undo-ink`}
          />
          <button type="button" onClick={() => setManual(true)} className={`${BTN} self-start border-2 border-border bg-surface text-ink`}>
            <Keyboard aria-hidden="true" className="size-5" />
            {manualLabel}
          </button>
        </>
      )}
      {error ? (
        <span id={errId} role="alert" className="break-words text-sm font-medium text-undo-ink">
          {error.reason} {error.action}
        </span>
      ) : null}
    </div>
  );
}
