"use client";
// Yazdıkça arama kutusu (T-250): ürün ve lokasyon seçicilerinin ortak parçası. Arama SUNUCUDADIR (`search`); sonuç sınırlıdır.
// - İlk harfte öneri (200 ms bekleme, eski yanıt yok sayılır); klavye: ↑/↓ gezinir, Enter seçer, Escape kapatır.
// - Öneri listesi akış içindedir (mutlak konum yok) ve kendi içinde kayar → ekran dışına taşmaz; her satır ≥48 px.
// - Barkod: `scan` verilirse `ScanField` (T-303) gösterilir; okutulan değer `resolve` ile çözülür, tek eşleşme doğrudan seçilir.
// Rol `searchbox` kalır (liste `aria-controls` + `aria-activedescendant` ile bağlanır).
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Banner, ScanField } from "@wms/ui";

export interface Suggestion {
  readonly key: string;
  readonly primary: string;
  readonly secondary?: string;
}

export interface ScanConfig<T> {
  /** Okutulan/yazılan değeri çözer: `[]` yok, tek elemanlı = doğrudan seç, çok = belirsiz. */
  readonly resolve: (value: string) => Promise<readonly T[]>;
}

const INPUT_CLS =
  "min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function Typeahead<T>({
  label,
  hint,
  placeholder,
  name,
  defaultValue = "",
  search,
  toSuggestion,
  onSelect,
  scan,
  scanLabel,
  listLabel,
  clearOnSelect = false,
  extra,
}: {
  label: string;
  hint?: string;
  /** Alanın örnek metni (isteğe bağlı; verilmezse yok). */
  placeholder?: string;
  name?: string;
  defaultValue?: string;
  search: (q: string) => Promise<readonly T[]>;
  toSuggestion: (item: T) => Suggestion;
  onSelect: (item: T) => void;
  scan?: ScanConfig<T>;
  scanLabel?: string;
  listLabel: string;
  clearOnSelect?: boolean;
  extra?: ReactNode;
}) {
  const t = useTranslations("easySetup.picker");
  const id = useId();
  const listId = `${id}-list`;
  const [q, setQ] = useState(defaultValue);
  const [items, setItems] = useState<readonly T[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const [scanned, setScanned] = useState("");
  const [scanMsg, setScanMsg] = useState<"notFound" | "many" | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function onChange(value: string) {
    setQ(value);
    setScanMsg(null);
    clearTimeout(timer.current);
    if (value.trim() === "") {
      seq.current++;
      setItems([]);
      setOpen(false);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(() => {
      const mine = ++seq.current;
      search(value.trim())
        .then((r) => {
          if (mine !== seq.current) return;
          setItems(r);
          setActive(-1);
          setOpen(true);
        })
        .catch(() => {
          if (mine === seq.current) setItems([]);
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false);
        });
    }, 200);
  }

  function choose(item: T) {
    const s = toSuggestion(item);
    onSelect(item);
    setOpen(false);
    setItems([]);
    setQ(clearOnSelect ? "" : s.primary);
  }

  async function onScan(value: string) {
    setScanned(value);
    setScanMsg(null);
    if (scan === undefined) return;
    try {
      const found = await scan.resolve(value);
      if (found.length === 1) choose(found[0] as T);
      else setScanMsg(found.length === 0 ? "notFound" : "many");
    } catch {
      setScanMsg("notFound");
    }
  }

  const expanded = open && q.trim() !== "";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-base font-semibold text-ink">
          {label}
        </label>
        {hint ? <span className="text-sm text-ink-muted">{hint}</span> : null}
        <input
          id={id}
          name={name}
          type="search"
          placeholder={placeholder}
          autoComplete="off"
          maxLength={128}
          value={q}
          aria-autocomplete="list"
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && items.length > 0) {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === "ArrowUp" && items.length > 0) {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && expanded && active >= 0 && items[active] !== undefined) {
              e.preventDefault();
              choose(items[active] as T);
            } else if (e.key === "Enter" && name === undefined) {
              // Üst formu (ör. toplu oluşturucu) yanlışlıkla göndermesin.
              e.preventDefault();
            } else if (e.key === "Escape" && expanded) {
              e.stopPropagation();
              e.preventDefault();
              setOpen(false);
            }
          }}
          className={INPUT_CLS}
        />
      </div>
      {expanded ? (
        items.length === 0 && !busy ? (
          <p className="break-words rounded-card bg-bg px-4 py-3 text-sm text-ink-muted">{t("none")}</p>
        ) : (
          <ul id={listId} role="listbox" aria-label={listLabel} className="m-0 flex max-h-56 min-w-0 list-none flex-col gap-1 overflow-y-auto overscroll-contain rounded-card border-2 border-border bg-surface p-1">
            {items.map((item, i) => {
              const s = toSuggestion(item);
              return (
                <li
                  key={s.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                  className="flex min-h-12 min-w-0 cursor-pointer flex-col justify-center rounded-control px-3 py-1 text-ink aria-selected:bg-accent-soft aria-selected:text-accent-ink"
                >
                  <span className="min-w-0 break-words text-base font-semibold">{s.primary}</span>
                  {s.secondary ? <span className="min-w-0 [overflow-wrap:anywhere] text-sm text-ink-muted">{s.secondary}</span> : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {extra}
      {scan === undefined ? null : (
        <>
          <ScanField
            label={scanLabel ?? t("scanLabel")}
            value={scanned}
            manualLabel={t("scanManual")}
            confirmLabel={t("scanConfirm")}
            cancelLabel={t("scanCancel")}
            placeholder={t("scanPlaceholder")}
            onManualSubmit={(v) => void onScan(v)}
          />
          {scanMsg === null ? null : (
            <Banner kind="warning">
              {t(scanMsg === "notFound" ? "scanNotFound" : "scanMany")} {t(scanMsg === "notFound" ? "scanNotFoundAction" : "scanManyAction")}
            </Banner>
          )}
        </>
      )}
    </div>
  );
}
