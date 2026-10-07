"use client";
// Saha kabulü (T-313): tara → doğrula → miktar onayla → bitti. Ekran başına tek soru ve tek sabit birincil düğme (N-01); yanlış tarama tam ekran
// uyarıyla durdurulur (N-13); miktar 48 px adım tuşlarıyla (N-02). Yetki, fazla kabul ve durum kuralları domain'dedir (`receiveGoods`);
// bu dosya yalnızca girdi toplar, sunucu hatasını (kod + sonraki eylem) gösterir. Bu dosyadaki ortak saha parçaları `putaway-flow.tsx` ile paylaşılır.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Banner, CircleAlert, CircleCheck, PackagePlus, ScanField } from "@wms/ui";
import { ScannerService, type ScanSource } from "../../../../../lib/scanner/scanner-core.ts";
import { createKeystrokeSource } from "../../../../../lib/scanner/keystroke-source.ts";
import { ErrorNotice, LineStatus, errorKeyOf, intOf, scanMismatch, submitWithKey, useKeyHolder, type ErrorInfo, type ReceiptDetail, type ReceiptLineView } from "../../receipts/receipt-form.tsx";
import { receiveGoodsAction, resolveItemScanAction } from "../../receipts/actions.ts";

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
/** Saha alt gezinme çubuğunun yüksekliği (field/layout.tsx: min-h-14 + py-2 + border-t-2 = 74 px); sabit birincil çubuk hemen üstünde durur. */
const NAV_H = "bottom-[74px]";

export type FlowHue = "green" | "teal";
const HUE: Record<FlowHue, string> = { green: "bg-cat-green-bg text-cat-green-ink", teal: "bg-cat-teal-bg text-cat-teal-ink" };

// ---------------------------------------------------------------------------------------------------------------------
// Ortak saha parçaları
// ---------------------------------------------------------------------------------------------------------------------
export function PrimaryButton({ children, onClick, disabled, loading, type = "button" }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; loading?: boolean; type?: "button" | "submit" }) {
  return (
    <button
      type={type}
      data-variant="primary"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
      className={`flex min-h-14 w-full min-w-0 items-center justify-center rounded-control bg-accent px-4 text-lg font-bold text-on-accent disabled:opacity-60 ${FOCUS}`}
    >
      {children}
    </button>
  );
}
export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} data-variant="primary" className={`flex min-h-14 w-full min-w-0 items-center justify-center rounded-control bg-accent px-4 text-center text-lg font-bold text-on-accent ${FOCUS}`}>
      {children}
    </Link>
  );
}
export function SecondaryButton({ children, onClick, disabled, pressed }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={`flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink aria-pressed:bg-accent-soft ${FOCUS}`}
    >
      {children}
    </button>
  );
}

const ArrowLeft = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 12H5m6-6-6 6 6 6" />
  </svg>
);

export interface FlowShellProps {
  hue: FlowHue;
  icon: React.ReactNode;
  step: number;
  total: number;
  title: string;
  instruction?: string;
  /** Geri: ya bağlantı ya işlev; yoksa gösterilmez. */
  backHref?: string;
  onBack?: () => void;
  footer: React.ReactNode;
  /** Tarama adımı: alt birincil düğme "Elle gir" olur ve ScanField'ın kendi düğmesi gizlenir (tek birincil). */
  scanProxy?: boolean;
  children: React.ReactNode;
}

/** Adım çerçevesi: üstte adım + geri, ortada tek soru, altta tek sabit birincil eylem (alt gezinme çubuğunun hemen üstünde). */
export function FlowShell({ hue, icon, step, total, title, instruction, backHref, onBack, footer, scanProxy, children }: FlowShellProps) {
  const t = useTranslations("receiving");
  const back = "flex size-12 shrink-0 items-center justify-center rounded-control border-2 border-border bg-surface text-ink " + FOCUS;
  return (
    <main
      className={`group flex w-full min-w-0 flex-col gap-3 px-4 pb-24 pt-3 ${scanProxy === true ? "[&_[data-mode=scan]>button]:hidden" : ""}`}
      data-testid="flow-step"
      data-step={step}
    >
      <div className="flex min-w-0 items-center gap-3">
        {backHref !== undefined ? (
          <Link href={backHref} aria-label={t("back")} className={back}>
            <ArrowLeft />
          </Link>
        ) : onBack !== undefined ? (
          <button type="button" aria-label={t("back")} onClick={onBack} className={back}>
            <ArrowLeft />
          </button>
        ) : null}
        <p className="min-w-0 text-sm font-bold text-ink-muted" data-testid="step-label">
          {t("stepOf", { n: step, total })}
        </p>
      </div>
      <header className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className={`flex size-12 shrink-0 items-center justify-center rounded-full ${HUE[hue]}`}>
          {icon}
        </span>
        <div className="flex min-w-0 flex-col">
          <h1 className="break-words text-2xl font-extrabold leading-tight text-ink">{title}</h1>
          {instruction === undefined ? null : <p className="break-words text-base text-ink">{instruction}</p>}
        </div>
      </header>
      {children}
      <div role="group" aria-label={t("primaryBar")} className={`fixed inset-x-0 ${NAV_H} z-10 border-t border-border bg-surface px-4 py-2 group-has-[[data-mode=manual]]:hidden`}>
        <div className="mx-auto w-full max-w-md">{footer}</div>
      </div>
    </main>
  );
}

/** Yanlış tarama / engelleyici hata: tam ekran, sebep + sonraki eylem, tek "tekrar okut" düğmesi (N-13). */
export function ScanAlert({ title, reason, action, code, onClose }: { title: string; reason: string; action: string; code?: string; onClose: () => void }) {
  const t = useTranslations("receiving");
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
    // Yalnızca titreşim (iOS Safari desteklemeyebilir; yoksa görsel uyarı yeterlidir, N-13).
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate([200, 80, 200]);
  }, []);
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="scan-alert-title" aria-describedby="scan-alert-body" data-testid="scan-alert" className="fixed inset-0 z-50 flex flex-col justify-between gap-4 bg-danger-bg px-6 pb-6 pt-10 text-danger-ink">
      <div className="flex min-w-0 flex-col items-center gap-4 text-center">
        <CircleAlert aria-hidden="true" className="size-20 text-danger" strokeWidth={2} />
        <h2 id="scan-alert-title" className="break-words text-3xl font-extrabold">
          {title}
        </h2>
        <p id="scan-alert-body" className="break-words text-xl font-semibold">
          {reason} {action}
        </p>
        {code === undefined ? null : (
          <details className="text-base">
            <summary className="flex min-h-12 cursor-pointer items-center justify-center">{t("detail")}</summary>
            <p data-testid="error-code">{t("errorCode", { code })}</p>
          </details>
        )}
      </div>
      <button ref={btn} type="button" onClick={onClose} className={`flex min-h-14 w-full items-center justify-center rounded-control bg-danger px-4 text-lg font-bold text-on-accent ${FOCUS}`}>
        {t("scanAgain")}
      </button>
    </div>
  );
}

/** Miktar: 48 px (burada 56 px) eksi/artı + sayı alanı; `inputmode="numeric"` yalnızca bu alanda; tam sayı; sınır sunucudan gelen kalan miktardır. */
export function QtyStepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number | null; onChange: (n: number) => void }) {
  const inputId = useId();
  const clamp = (n: number): number => Math.min(max ?? 999_999_999, Math.max(min, n));
  const btn = `flex size-14 shrink-0 items-center justify-center rounded-control border-2 border-border-strong bg-surface text-3xl font-bold text-ink disabled:opacity-40 ${FOCUS}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-base font-semibold text-ink" htmlFor={inputId}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" aria-label={`${label} −`} disabled={value <= min} onClick={() => onChange(clamp(value - 1))} className={btn}>
          <span aria-hidden="true">−</span>
        </button>
        <input
          id={inputId}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          value={String(value)}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, "").slice(0, 9);
            onChange(clamp(d === "" ? min : Number(d)));
          }}
          className={`min-h-14 w-full min-w-0 flex-1 rounded-card border-2 border-border-strong bg-surface px-2 text-center text-3xl font-extrabold text-ink ${FOCUS}`}
        />
        <button type="button" aria-label={`${label} +`} disabled={max !== null && value >= max} onClick={() => onChange(clamp(value + 1))} className={btn}>
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </div>
  );
}

/** Tarama kaynağı: klavye kaması (DataWedge) servis arkasındadır (ADR-010); etkin ekran tek dinleyicidir. `enabled=false` iken tarama iletilmez. */
export function useScanner(handler: (value: string, source: ScanSource) => void, enabled: boolean): ScannerService | null {
  const [service, setService] = useState<ScannerService | null>(null);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = new ScannerService();
    s.registerSource(createKeystrokeSource());
    setService(s);
  }, []);
  const stable = useCallback((v: string, src: ScanSource) => ref.current(v, src), []);
  useEffect(() => (service !== null && enabled ? service.onScan(stable) : undefined), [service, enabled, stable]);
  return service;
}

export interface AlertState {
  readonly titleKey: string;
  readonly reasonKey: string;
  readonly params?: Record<string, string>;
  readonly code?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Kabul akışı
// ---------------------------------------------------------------------------------------------------------------------
type Stage = "scan" | "qty" | "done";
interface Picked {
  readonly line: ReceiptLineView;
  readonly received: number;
  readonly damaged: number;
  readonly locationId: string;
}
interface Done {
  readonly itemName: string;
  readonly received: number;
  readonly damaged: number;
  readonly remaining: number | null;
}

export function ReceiveFlow({ slug, receipt }: { slug: string; receipt: ReceiptDetail }) {
  const t = useTranslations("receiving");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const holder = useKeyHolder();
  const wrap = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>("scan");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [showDamaged, setShowDamaged] = useState(false);
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const base = `/t/${encodeURIComponent(slug)}/field/receive`;
  const open = receipt.lines.filter((l) => intOf(l.open) !== 0);
  const itemIds = receipt.lines.map((l) => l.itemId);

  const onScanned = useCallback(
    async (code: string) => {
      if (busy || alert !== null) return;
      setLast(code);
      setBusy(true);
      setError(null);
      let res: Awaited<ReturnType<typeof resolveItemScanAction>>;
      try {
        res = await resolveItemScanAction({ slug, code });
      } catch {
        setBusy(false);
        setAlert({ titleKey: "alert.networkTitle", reasonKey: "network", code: "NETWORK" });
        return;
      }
      setBusy(false);
      if (!res.ok) {
        const key = errorKeyOf(res.error, "scan");
        setAlert({ titleKey: "alert.scanTitle", reasonKey: key, code: res.error.detail === undefined ? res.error.code : `${res.error.code}/${res.error.detail}` });
        return;
      }
      const { itemId, quantity, unitId } = res.data;
      if (scanMismatch(itemId, itemIds)) {
        setAlert({ titleKey: "alert.mismatchTitle", reasonKey: "scan_mismatch", code: "SCAN_MISMATCH" });
        return;
      }
      const line = open.find((l) => l.itemId === itemId);
      if (line === undefined) {
        setAlert({ titleKey: "alert.mismatchTitle", reasonKey: "line_done", code: "LINE_COMPLETE" });
        return;
      }
      const max = intOf(line.open);
      // Koli barkodu adedi (A-20): yalnızca barkod birimi satır birimiyle aynıysa varsayılan olur; değilse 1 (kullanıcı değiştirir).
      const perScan = unitId === line.unitId ? (intOf(quantity) ?? 1) : 1;
      if (stage === "qty" && picked !== null && picked.line.id === line.id) {
        // Aynı ürünün koli barkodu yeniden okutuldu: adet eklenir.
        holder.contentChanged();
        setPicked({ ...picked, received: Math.min(max ?? Infinity, picked.received + perScan) });
        return;
      }
      if (stage === "qty" && picked !== null) {
        setAlert({ titleKey: "alert.mismatchTitle", reasonKey: "finish_first", code: "SCAN_MISMATCH" });
        return;
      }
      holder.contentChanged();
      setShowDamaged(false);
      setPicked({ line, received: Math.max(1, Math.min(max ?? Infinity, perScan)), damaged: 0, locationId: receipt.receivingLocations[0]?.id ?? "" });
      setStage("qty");
    },
    [busy, alert, slug, stage, picked, receipt],
  );
  const scanner = useScanner((v) => void onScanned(v), stage !== "done" && alert === null && !busy);

  async function confirm() {
    if (picked === null || busy) return;
    setBusy(true);
    setError(null);
    const out = await submitWithKey(holder, (clientKey) =>
      receiveGoodsAction({
        slug,
        clientKey,
        receiptId: receipt.id,
        lines: [
          {
            lineId: picked.line.id,
            received: String(picked.received),
            ...(picked.damaged > 0 ? { damaged: String(picked.damaged) } : {}),
            locationId: picked.locationId,
          },
        ],
      }),
    );
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    const open0 = intOf(picked.line.open);
    setDone({
      itemName: picked.line.itemName,
      received: picked.received,
      damaged: picked.damaged,
      remaining: open0 === null ? null : Math.max(open0 - picked.received, 0),
    });
    setStage("done");
    startTransition(() => router.refresh());
  }

  const alertView =
    alert === null ? null : (
      <ScanAlert
        title={t(alert.titleKey)}
        reason={t(`errors.${alert.reasonKey}`, { remaining: "-" })}
        action={t(`errors.${alert.reasonKey}Action`)}
        {...(alert.code === undefined ? {} : { code: alert.code })}
        onClose={() => setAlert(null)}
      />
    );

  const icon = <PackagePlus aria-hidden="true" className="size-6" />;

  if (receipt.receivingLocations.length === 0) {
    return (
      <FlowShell hue="green" icon={icon} step={2} total={4} title={t("flow.noLocationTitle")} backHref={base} footer={<PrimaryLink href={base}>{t("flow.otherReceipt")}</PrimaryLink>}>
        <Banner kind="error">
          {t("flow.noLocation")} {t("flow.noLocationAction")}
        </Banner>
      </FlowShell>
    );
  }

  if (stage === "done" && done !== null) {
    const finished = open.length === 0 || (done.remaining === 0 && open.length <= 1);
    return (
      <>
        <FlowShell
          hue="green"
          icon={icon}
          step={4}
          total={4}
          title={t("flow.savedTitle")}
          footer={finished ? <PrimaryLink href={base}>{t("flow.otherReceipt")}</PrimaryLink> : <PrimaryButton onClick={() => setStage("scan")}>{t("flow.nextItem")}</PrimaryButton>}
        >
          <Banner kind="success">
            <p className="font-semibold" data-testid="saved-summary">
              {t("flow.saved", { name: done.itemName, received: done.received })}
            </p>
            {done.damaged > 0 ? <p>{t("flow.savedDamaged", { n: done.damaged })}</p> : null}
            {done.remaining === null || done.remaining === 0 ? null : <p>{t("flow.savedRemaining", { n: done.remaining })}</p>}
          </Banner>
          {finished ? (
            <p className="flex items-center gap-2 text-lg font-bold text-ink">
              <CircleCheck aria-hidden="true" className="size-6 text-success" />
              {t("flow.receiptDone")}
            </p>
          ) : (
            <p className="text-base text-ink-muted">{t("flow.openStays")}</p>
          )}
        </FlowShell>
        {alertView}
      </>
    );
  }

  if (stage === "qty" && picked !== null) {
    const max = intOf(picked.line.open);
    return (
      <>
        <FlowShell
          hue="green"
          icon={icon}
          step={3}
          total={4}
          title={t("flow.qtyTitle")}
          instruction={t("flow.qtyInstruction")}
          onBack={() => {
            setPicked(null);
            setStage("scan");
            setError(null);
          }}
          footer={
            <PrimaryButton loading={busy} onClick={() => void confirm()}>
              {t("flow.confirm")}
            </PrimaryButton>
          }
        >
          <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3" aria-label={t("flow.verify")}>
            <p className="text-sm font-bold text-ink-muted">{t("flow.verify")}</p>
            <p className="break-words text-2xl font-extrabold text-ink" data-testid="verified-item">
              {picked.line.itemName}
            </p>
            <p className="break-words text-sm text-ink-muted">{picked.line.itemCode}</p>
            <LineStatus expected={picked.line.expected} received={picked.line.received} damaged={picked.line.damaged} open={picked.line.open} />
          </section>
          <QtyStepper
            label={t("flow.received", { unit: picked.line.unitCode })}
            value={picked.received}
            min={1}
            max={max}
            onChange={(n) => {
              holder.contentChanged();
              setPicked({ ...picked, received: n, damaged: Math.min(picked.damaged, n) });
            }}
          />
          {showDamaged ? (
            <QtyStepper
              label={t("flow.damagedLabel")}
              value={picked.damaged}
              min={0}
              max={picked.received}
              onChange={(n) => {
                holder.contentChanged();
                setPicked({ ...picked, damaged: n });
              }}
            />
          ) : (
            <SecondaryButton
              onClick={() => {
                holder.contentChanged();
                setShowDamaged(true);
              }}
            >
              {t("flow.hasDamaged")}
            </SecondaryButton>
          )}
          {receipt.receivingLocations.length > 1 ? (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="text-base font-semibold text-ink">{t("flow.rackLabel")}</legend>
              <div className="flex min-w-0 flex-wrap gap-2">
                {receipt.receivingLocations.map((l) => (
                  <SecondaryButton
                    key={l.id}
                    pressed={picked.locationId === l.id}
                    onClick={() => {
                      holder.contentChanged();
                      setPicked({ ...picked, locationId: l.id });
                    }}
                  >
                    {l.code}
                  </SecondaryButton>
                ))}
              </div>
            </fieldset>
          ) : (
            <p className="text-sm text-ink-muted">{t("flow.rackAuto", { code: receipt.receivingLocations[0]?.code ?? "" })}</p>
          )}
          {error === null ? null : <ErrorNotice error={error} context="receive" remaining={String(max ?? picked.line.open)} />}
        </FlowShell>
        {alertView}
      </>
    );
  }

  // Tarama adımı (ya da tüm satırlar tamamsa bitiş).
  if (open.length === 0) {
    return (
      <FlowShell hue="green" icon={icon} step={4} total={4} title={t("flow.receiptDone")} footer={<PrimaryLink href={base}>{t("flow.otherReceipt")}</PrimaryLink>}>
        <p className="text-base text-ink">{t("flow.allDone")}</p>
      </FlowShell>
    );
  }
  return (
    <>
      <FlowShell
        hue="green"
        icon={icon}
        step={2}
        total={4}
        title={t("flow.scanTitle")}
        instruction={t("flow.scanInstruction")}
        backHref={base}
        scanProxy
        footer={
          <PrimaryButton
            onClick={() => wrap.current?.querySelector<HTMLButtonElement>('[data-mode="scan"] > button')?.click()}
          >
            {t("flow.manual")}
          </PrimaryButton>
        }
      >
        <div ref={wrap} className="min-w-0">
          <ScanInput service={scanner} label={busy ? t("flow.checking") : t("flow.scanLabel")} value={last} />
        </div>
        <section aria-label={t("flow.expectedItems")} className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-bold text-ink-muted">
            {receipt.number}
            {receipt.supplierRef === null ? "" : ` · ${receipt.supplierRef}`}
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="expected-lines">
            {receipt.lines.map((l) => (
              <li key={l.id} className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3">
                <span className="break-words text-base font-bold text-ink">{l.itemName}</span>
                <LineStatus expected={l.expected} received={l.received} damaged={l.damaged} open={l.open} />
              </li>
            ))}
          </ul>
        </section>
      </FlowShell>
      {alertView}
    </>
  );
}

/** ScanField sarmalayıcısı: elle girilen değer de aynı tarama yoluna (`submitManual`, kaynak `manual`) gider; tarama sayılmaz. */
export function ScanInput({ service, label, value }: { service: ScannerService | null; label: string; value: string }) {
  const t = useTranslations("receiving");
  return (
    <ScanField
      label={label}
      value={value}
      manualLabel={t("flow.manual")}
      confirmLabel={t("flow.manualConfirm")}
      cancelLabel={t("cancel")}
      placeholder={t("flow.scanPlaceholder")}
      onManualSubmit={(v) => service?.submitManual(v)}
    />
  );
}
