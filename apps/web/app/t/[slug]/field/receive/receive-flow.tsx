"use client";
// Saha kabulü (T-313): tara → doğrula → miktar onayla → bitti. Ekran başına tek soru ve tek sabit birincil düğme (N-01); yanlış tarama tam ekran
// uyarıyla durdurulur (N-13); miktar 48 px adım tuşlarıyla (N-02). Yetki, fazla kabul ve durum kuralları domain'dedir (`receiveGoods`);
// bu dosya yalnızca girdi toplar, sunucu hatasını (kod + sonraki eylem) gösterir. Bu dosyadaki ortak saha parçaları `putaway-flow.tsx` ile paylaşılır.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Banner, ChevronDown, CircleAlert, CircleCheck, PackagePlus, ScanField, ScanLine } from "@wms/ui";
import { ScannerService, type ScanSource, type ScannerSource } from "../../../../../lib/scanner/scanner-core.ts";
import { createKeystrokeSource } from "../../../../../lib/scanner/keystroke-source.ts";
import { cameraFeedback, classifyCameraError, createFrameDecoder, openCamera, platformOf, startScanLoop } from "../../../../../lib/scanner/camera-source.ts";
import type { CameraFailure, CameraSession, FrameDecoder, RejectReason } from "../../../../../lib/scanner/camera-source.ts";
import { ErrorNotice, LineStatus, errorKeyOf, intOf, scanMismatch, submitWithKey, useKeyHolder, type ErrorInfo, type ReceiptDetail, type ReceiptLineView } from "../../receipts/receipt-form.tsx";
import { receiveGoodsAction, resolveItemScanAction } from "../../receipts/actions.ts";

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
/** Saha alt gezinme çubuğunun yüksekliği (field/layout.tsx: min-h-14 + py-2 + border-t-2 = 74 px); sabit birincil çubuk hemen üstünde durur. */
const NAV_H = "bottom-[74px]";

export type FlowHue = "green" | "teal";
const SCAN_ICON: Record<FlowHue, string> = { green: "text-cat-green-ink", teal: "text-cat-teal-ink" };
const SCAN_READY_BORDER: Record<FlowHue, string> = { green: "border-cat-green-ink", teal: "border-cat-teal-ink" };
const SCAN_LINK: Record<FlowHue, string> = { green: "text-cat-green-ink", teal: "text-cat-teal-ink" };
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
const PRESSED: Record<FlowHue, string> = {
  green: "aria-pressed:border-cat-green-ink aria-pressed:bg-cat-green-bg aria-pressed:text-cat-green-ink",
  teal: "aria-pressed:border-cat-teal-ink aria-pressed:bg-cat-teal-bg aria-pressed:text-cat-teal-ink",
};
export function SecondaryButton({ children, onClick, disabled, pressed, tone }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean; tone?: FlowHue }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={`flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink ${tone === undefined ? "aria-pressed:bg-accent-soft" : PRESSED[tone]} ${FOCUS}`}
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
  /** Adım numarası/sayısı; hata, kilit ve boş durum ekranlarında verilmez (yanlış sayı gösterilmez). */
  step?: number;
  total?: number;
  title: string;
  instruction?: string;
  /** Geri: ya bağlantı ya işlev; yoksa gösterilmez. */
  backHref?: string;
  onBack?: () => void;
  footer: React.ReactNode;
  /** Sabit çubukta birincil düğmenin hemen ÜSTÜNDE görünen seçim (örn. seçili kabul rafı); içerik kaydırmasına bağlı değildir. */
  footerExtra?: React.ReactNode;
  /** Tarama adımı: ScanField yalnızca "Elle gir" ile açılır (tek yol); elle girişte birincil düğme gizlenir. */
  scanProxy?: boolean;
  children: React.ReactNode;
}

/** Adım çerçevesi: tek satır üst bilgi (geri + kategori ikonu + adım + başlık), altta tek sabit birincil eylem (alt gezinme çubuğunun hemen üstünde). */
export function FlowShell({ hue, icon, step, total, title, instruction, backHref, onBack, footer, footerExtra, scanProxy, children }: FlowShellProps) {
  const t = useTranslations("receiving");
  const back = "flex size-12 shrink-0 items-center justify-center rounded-control border-2 border-border bg-surface text-ink " + FOCUS;
  return (
    <main
      className={`group flex min-h-[calc(100dvh-8.25rem)] w-full min-w-0 flex-col gap-3 px-4 pt-3 ${footerExtra === undefined ? "pb-24" : "pb-44"} ${scanProxy === true ? "[&_[data-mode=scan]]:hidden" : ""}`}
      data-testid="flow-step"
      data-step={step ?? 0}
    >
      <header className="flex min-w-0 items-center gap-3">
        {backHref !== undefined ? (
          <Link href={backHref} aria-label={t("back")} className={back}>
            <ArrowLeft />
          </Link>
        ) : onBack !== undefined ? (
          <button type="button" aria-label={t("back")} onClick={onBack} className={back}>
            <ArrowLeft />
          </button>
        ) : null}
        <span aria-hidden="true" className={`flex size-10 shrink-0 items-center justify-center rounded-full ${HUE[hue]}`}>
          {icon}
        </span>
        <div className="flex min-w-0 flex-col">
          {step === undefined || total === undefined ? null : (
            <p className="text-xs font-bold text-ink-muted" data-testid="step-label">
              {t("stepOf", { n: step, total })}
            </p>
          )}
          <h1 className="break-words text-xl font-extrabold leading-tight text-ink">{title}</h1>
        </div>
      </header>
      {instruction === undefined ? null : <p className="break-words text-base text-ink [@media(max-height:700px)]:hidden">{instruction}</p>}
      {children}
      <div role="group" aria-label={t("primaryBar")} className={`fixed inset-x-0 ${NAV_H} z-10 border-t border-border bg-surface px-4 py-2 group-has-[[data-mode=manual]]:hidden`}>
        <div className="mx-auto flex w-full max-w-md flex-col gap-2">
          {footerExtra}
          {footer}
        </div>
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
          <details className="group/d text-base">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-center gap-2 font-bold">
              {t("detail")}
              <ChevronDown aria-hidden="true" className="size-5 shrink-0 transition-transform group-open/d:rotate-180" />
            </summary>
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
  const btn = `flex size-12 shrink-0 items-center justify-center rounded-control border-2 border-border-strong bg-surface text-3xl font-bold text-ink disabled:opacity-40 ${FOCUS}`;
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
          className={`min-h-12 w-full min-w-0 flex-1 rounded-card border-2 border-border-strong bg-surface px-2 text-center text-2xl font-extrabold text-ink ${FOCUS}`}
        />
        <button type="button" aria-label={`${label} +`} disabled={max !== null && value >= max} onClick={() => onChange(clamp(value + 1))} className={btn}>
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Tarama kaynakları: klavye kaması (DataWedge) ve kamera servis arkasındadır (ADR-010); etkin ekran tek dinleyicidir. `enabled=false` iken tarama iletilmez.
 * `camera(code)` kamera okumasını aynı servis yoluyla (`source: "camera"`) iletir.
 */
export function useScanner(handler: (value: string, source: ScanSource) => void, enabled: boolean): { service: ScannerService | null; camera: (code: string) => void; dropped: boolean; clearDropped: () => void } {
  const [service, setService] = useState<ScannerService | null>(null);
  const [dropped, setDropped] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const ref = useRef(handler);
  ref.current = handler;
  const cameraEmit = useRef<((v: string) => void) | null>(null);
  useEffect(() => {
    const s = new ScannerService();
    s.registerSource(createKeystrokeSource());
    const cam: ScannerSource = {
      id: "camera",
      start(emit) {
        cameraEmit.current = emit;
        return () => {
          cameraEmit.current = null;
        };
      },
    };
    s.registerSource(cam);
    setService(s);
  }, []);
  const stable = useCallback((v: string, src: ScanSource) => ref.current(v, src), []);
  useEffect(() => (service !== null && enabled ? service.onScan(stable) : undefined), [service, enabled, stable]);
  // Okuma kapalıyken (işlem sürüyor ya da uyarı açık) gelen kamera kodu SESSİZCE düşmez: kullanıcıya bildirilir (T-313 güvenlik MINOR).
  const camera = useCallback((code: string) => {
    if (!enabledRef.current) {
      setDropped(true);
      return;
    }
    cameraEmit.current?.(code);
  }, []);
  const clearDropped = useCallback(() => setDropped(false), []);
  return { service, camera, dropped, clearDropped };
}

type CamPhase = { readonly phase: "starting" } | { readonly phase: "scanning" } | { readonly phase: "rejected"; readonly reason: RejectReason } | { readonly phase: "accepted" } | { readonly phase: "failed"; readonly failure: CameraFailure | "decoder" };

/** Kamera yolu kurulabilir mi: `getUserMedia` var ya da güvenli olmayan bağlam (o durumda katman HTTPS rehberini gösterir). Yoksa donanım tetiği (el terminali). */
const cameraPossible = (): boolean => typeof window !== "undefined" && typeof navigator !== "undefined" && (navigator.mediaDevices?.getUserMedia !== undefined || !window.isSecureContext);

/** Okuma sonrası yeşil onayın görünür kaldığı süre (ms); akış bu sürede zaten durmuştur (çift okuma yok). */
const ACCEPT_HOLD_MS = 350;

/**
 * Kamera katmanı (T-286): arka kamera + çözücü (yerleşik API ya da uygulama içi WASM, `camera-source.ts`). Yanlış okuma SATIR İÇİ gösterilir, katman ve kamera açık kalır;
 * doğru okuma yeşil onay + kısa bip + titreşimle bildirilir. Hata mesajı neden + sonraki eylemi söyler; "Elle gir" her durumda görünür.
 */
export function CameraOverlay({ onCode, onClose, onManual }: { onCode: (code: string) => void; onClose: () => void; onManual: () => void }) {
  const t = useTranslations("receiving");
  const video = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const session = useRef<CameraSession | null>(null);
  const [state, setState] = useState<CamPhase>({ phase: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean; failed: boolean }>({ supported: false, on: false, failed: false });
  const [decoderKind, setDecoderKind] = useState<"native" | "wasm" | "">("");
  useEffect(() => {
    let cancelled = false;
    let stopLoop: (() => void) | null = null;
    let hold: ReturnType<typeof setTimeout> | null = null;
    let cam: CameraSession | null = null;
    setState({ phase: "starting" });
    setTorch({ supported: false, on: false, failed: false });
    void (async () => {
      try {
        cam = await openCamera();
      } catch (e) {
        if (!cancelled) setState({ phase: "failed", failure: classifyCameraError(e) });
        return;
      }
      if (cancelled) {
        cam.stop();
        return;
      }
      session.current = cam;
      const v = video.current;
      if (v === null) return;
      v.srcObject = cam.stream;
      void v.play().catch(() => undefined);
      setTorch({ supported: cam.torchSupported, on: false, failed: false });
      let decoder: FrameDecoder;
      try {
        decoder = await createFrameDecoder(); // WASM yolunda çözücü burada tembel yüklenir (yalnızca tarama ekranında)
      } catch {
        cam.stop();
        if (!cancelled) setState({ phase: "failed", failure: "decoder" });
        return;
      }
      if (cancelled) {
        cam.stop();
        return;
      }
      setDecoderKind(decoder.kind);
      setState({ phase: "scanning" });
      const opened = cam;
      stopLoop = startScanLoop({
        decoder,
        video: v,
        onRejected: (reason) => {
          cameraFeedback("bad");
          setState({ phase: "rejected", reason });
        },
        onAccepted: (value) => {
          // Tek kabul: döngü kendini durdurdu; akış da hemen kapanır (aynı kod ikinci kez gönderilemez).
          opened.stop();
          cameraFeedback("ok");
          setState({ phase: "accepted" });
          hold = setTimeout(() => onCodeRef.current(value), ACCEPT_HOLD_MS);
        },
      });
    })();
    return () => {
      cancelled = true;
      if (stopLoop !== null) stopLoop();
      if (hold !== null) clearTimeout(hold);
      cam?.stop();
      session.current = null;
    };
  }, [attempt]);

  const toggleTorch = (): void => {
    const s = session.current;
    if (s === null) return;
    const next = !torch.on;
    void s.setTorch(next).then((ok) => setTorch((p) => ({ ...p, on: ok ? next : p.on, failed: !ok })));
  };
  const failed = state.phase === "failed";
  const platform = typeof navigator === "undefined" ? "other" : platformOf(navigator.userAgent, navigator.maxTouchPoints);
  const failureKey = state.phase !== "failed" ? "" : state.failure === "denied" ? `denied_${platform}` : state.failure;
  const message = ((): { key: string; role: "status" | "alert"; tone: "plain" | "bad" | "good" } => {
    switch (state.phase) {
      case "starting":
        return { key: "camera.starting", role: "status", tone: "plain" };
      case "scanning":
        return { key: torch.failed ? "camera.torchFailed" : "camera.hint", role: torch.failed ? "alert" : "status", tone: "plain" };
      case "rejected":
        return { key: `camera.rejected.${state.reason}`, role: "alert", tone: "bad" };
      case "accepted":
        return { key: "camera.accepted", role: "status", tone: "good" };
      case "failed":
        return { key: `camera.error.${failureKey}`, role: "alert", tone: "bad" };
    }
  })();
  const TONE = { plain: "text-on-accent", bad: "rounded-card bg-danger-bg px-3 py-2 text-danger-ink", good: "rounded-card bg-success-bg px-3 py-2 text-success-ink" } as const;
  const text = (
    <p role={message.role} data-testid="camera-status" data-tone={message.tone} className={`flex min-w-0 items-start gap-2 break-words text-lg font-bold ${TONE[message.tone]}`}>
      {message.tone === "bad" ? <CircleAlert aria-hidden="true" className="mt-0.5 size-6 shrink-0" strokeWidth={2.25} /> : null}
      {message.tone === "good" ? <CircleCheck aria-hidden="true" className="mt-0.5 size-6 shrink-0" strokeWidth={2.25} /> : null}
      <span className="min-w-0 flex-1">{t(message.key)}</span>
    </p>
  );
  const btn = `flex min-h-12 min-w-12 flex-1 items-center whitespace-nowrap justify-center rounded-control border-2 border-on-accent bg-transparent px-3 text-base font-bold text-on-accent ${FOCUS}`;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("camera.title")}
      data-testid="camera-overlay"
      data-phase={state.phase}
      data-decoder={decoderKind}
      className="fixed inset-0 z-40 grid grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden bg-ink p-3 text-on-accent landscape:grid-cols-[minmax(0,1fr)_20rem] landscape:grid-rows-[minmax(0,1fr)_auto]"
    >
      {failed ? null : <div className="row-start-1 landscape:col-start-2 landscape:self-center">{text}</div>}
      <div data-testid="camera-viewport" className="relative row-start-2 min-h-0 min-w-0 overflow-hidden rounded-card bg-ink landscape:col-start-1 landscape:row-span-2 landscape:row-start-1">
        <video ref={video} muted playsInline data-testid="camera-video" className={`size-full object-cover ${failed ? "invisible" : ""}`} />
        {failed ? <div className="absolute inset-0 flex items-center justify-center p-2">{text}</div> : null}
      </div>
      <div className="row-start-3 flex min-w-0 flex-wrap gap-2 landscape:col-start-2 landscape:row-start-2 landscape:flex-col landscape:flex-nowrap">
        {failed && state.failure !== "none" && state.failure !== "insecure" ? (
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className={`${btn} basis-full landscape:basis-auto`}>
            {t("camera.retry")}
          </button>
        ) : null}
        {torch.supported && !failed && state.phase !== "accepted" ? (
          <button type="button" aria-pressed={torch.on} onClick={toggleTorch} className={btn}>
            {torch.on ? t("camera.torchOff") : t("camera.torchOn")}
          </button>
        ) : null}
        <button type="button" onClick={onManual} className={btn}>
          {t("flow.manual")}
        </button>
        <button type="button" onClick={onClose} className={btn}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

/**
 * Tarama paneli (tek yol): büyük okut ikonu + tek cümle; alt birincil düğme "Barkodu okut". ScanField (T-303) yalnızca "Elle gir" bağlantısıyla açılır
 * (ikincil); okuma hazır olduğunda `ready` vurgusu görünür.
 */
const INSTALL_HINT_KEY = "wms.installHint.dismissed";

/**
 * iPhone'da (tüm tarayıcılar WebKit) uygulama henüz ana ekrana eklenmemişse tek satır rehber: "Paylaş > Ana Ekrana Ekle". Kapatılınca (Tamam) bir daha gösterilmez.
 * Android'de tarayıcı kendi "Ana ekrana ekle" yolunu sunar (manifest, `app/manifest.ts`); rehber yalnızca iPhone içindir.
 */
function useInstallHint(): { show: boolean; dismiss: () => void } {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (platformOf(navigator.userAgent, navigator.maxTouchPoints) !== "ios") return;
    const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(INSTALL_HINT_KEY) === "1";
    } catch {
      dismissed = false; // depolama kapalı (gizli sekme): rehber her açılışta görünür, hata değildir
    }
    setShow(!standalone && !dismissed);
  }, []);
  const dismiss = useCallback(() => {
    setShow(false);
    try {
      window.localStorage.setItem(INSTALL_HINT_KEY, "1");
    } catch {
      // depolama kapalı: bu oturumda gizlenir
    }
  }, []);
  return { show, dismiss };
}

export function ScanPanel({ service, prompt, last, lastName, ready, hue }: { service: ScannerService | null; prompt: string; last: string; lastName?: string; ready: boolean; hue: FlowHue }) {
  const t = useTranslations("receiving");
  const wrap = useRef<HTMLDivElement>(null);
  const install = useInstallHint();
  return (
    <section
      data-testid="scan-panel"
      data-ready={ready ? "true" : "false"}
      aria-live="polite"
      className={`flex min-w-0 flex-none flex-col items-center gap-2 rounded-card border-2 bg-surface p-4 text-center ${ready ? SCAN_READY_BORDER[hue] : "border-border"}`}
    >
      <ScanLine aria-hidden="true" className={`size-16 ${SCAN_ICON[hue]}`} strokeWidth={1.75} />
      <p className="break-words text-lg font-bold text-ink">{ready ? t("flow.readerReady") : prompt}</p>
      {last === "" ? null : (
        <p className="break-words text-sm text-ink-muted" data-testid="last-scan">
          {lastName === undefined ? null : <span className="font-bold text-ink">{t("flow.lastScan", { name: lastName })} </span>}
          <span className="break-all text-xs" data-testid="last-scan-code">{t("flow.lastCode", { code: last })}</span>
        </p>
      )}
      <div ref={wrap} className="w-full min-w-0">
        <ScanField
          label={t("flow.scanLabel")}
          value={last}
          manualLabel={t("flow.manual")}
          confirmLabel={t("flow.manualConfirm")}
          cancelLabel={t("cancel")}
          placeholder={t("flow.scanPlaceholder")}
          onManualSubmit={(v) => service?.submitManual(v)}
        />
      </div>
      <button
        type="button"
        onClick={() => wrap.current?.querySelector<HTMLButtonElement>('[data-mode="scan"] > button')?.click()}
        className={`flex min-h-12 min-w-12 items-center justify-center rounded-control px-4 text-base font-bold ${SCAN_LINK[hue]} underline group-has-[[data-mode=manual]]:hidden ${FOCUS}`}
      >
        {t("flow.manual")}
      </button>
      {install.show ? (
        <div data-testid="install-hint" className="flex w-full min-w-0 items-center gap-2 border-t-2 border-border pt-2 text-left">
          <p className="min-w-0 flex-1 break-words text-base font-semibold text-ink">{t("camera.installHint")}</p>
          <button type="button" onClick={install.dismiss} className={`flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-control border-2 border-border-strong px-3 text-base font-bold text-ink ${FOCUS}`}>
            {t("camera.ok")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Tarama adımının birincil düğmesi: kamera yolu kurulabiliyorsa kamera katmanını açar; yoksa okuyucuyu (el terminali tetiği) hazırlar ve yönerge gösterir. */
export function useScanPrimary(camera: (code: string) => void): { ready: boolean; press: () => void; overlay: React.ReactNode } {
  const [cam, setCam] = useState(false);
  const [ready, setReady] = useState(false);
  const wantManual = useRef(false);
  const onCode = useCallback(
    (code: string) => {
      setCam(false);
      camera(code);
    },
    [camera],
  );
  const onManual = useCallback(() => {
    wantManual.current = true;
    setCam(false);
  }, []);
  // "Elle gir": katman kapanınca tarama panelindeki ScanField elle giriş kipine geçer (aynı bileşen, ikinci bir giriş yolu yok).
  useEffect(() => {
    if (cam || !wantManual.current) return;
    wantManual.current = false;
    document.querySelector<HTMLButtonElement>('[data-testid="scan-panel"] [data-mode="scan"] > button')?.click();
  }, [cam]);
  const press = (): void => {
    if (cameraPossible()) setCam(true);
    else {
      setReady(true);
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(30);
    }
  };
  return { ready, press, overlay: cam ? <CameraOverlay onCode={onCode} onClose={() => setCam(false)} onManual={onManual} /> : null };
}

/** Okuma kapalıyken gelen kod bildirimi (uyarı açıkken de görünür: üstte, `z-[60]`). */
export function DroppedNotice({ show, onClose }: { show: boolean; onClose: () => void }) {
  const t = useTranslations("receiving");
  if (!show) return null;
  return (
    <div role="alert" data-testid="camera-dropped" className="fixed inset-x-4 top-16 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-card border-2 border-warning bg-warning-bg px-4 py-3 text-warning-ink shadow-card">
      <p className="min-w-0 flex-1 break-words text-base font-bold">{t("camera.dropped")}</p>
      <button type="button" onClick={onClose} className={`flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-control border-2 border-warning-ink px-3 text-base font-bold ${FOCUS}`}>
        {t("camera.ok")}
      </button>
    </div>
  );
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
  const [refreshing, startTransition] = useTransition();
  const holder = useKeyHolder();
  const [stage, setStage] = useState<Stage>("scan");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [showDamaged, setShowDamaged] = useState(false);
  const [last, setLast] = useState("");
  const [lastName, setLastName] = useState<string | undefined>(undefined);
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
      setLastName(undefined);
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
      setLastName(line.itemName);
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
  const { service: scanner, camera, dropped, clearDropped } = useScanner((v) => void onScanned(v), stage !== "done" && alert === null && !busy);
  const scanPrimary = useScanPrimary(camera);

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

  const alertView = (
    <>
      <DroppedNotice show={dropped} onClose={clearDropped} />
      {alert === null ? null : (
      <ScanAlert
        title={t(alert.titleKey)}
        reason={t(`errors.${alert.reasonKey}`, { remaining: "-" })}
        action={t(`errors.${alert.reasonKey}Action`)}
        {...(alert.code === undefined ? {} : { code: alert.code })}
        onClose={() => setAlert(null)}
      />
      )}
    </>
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
          footer={finished ? <PrimaryLink href={base}>{t("flow.otherReceipt")}</PrimaryLink> : <PrimaryButton loading={refreshing} onClick={() => setStage("scan")}>{t("flow.nextItem")}</PrimaryButton>}
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
          footerExtra={
            receipt.receivingLocations.length > 1 ? (
              <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" data-testid="rack-choice">
                <legend className="sr-only">{t("flow.rackLabel")}</legend>
                <p className="text-sm font-bold text-ink-muted">{t("flow.rackLabel")}</p>
                <div className="flex min-w-0 gap-2 overflow-x-auto" data-testid="rack-chips">
                  {receipt.receivingLocations.map((l) => (
                    <SecondaryButton
                      key={l.id}
                      tone="green"
                      pressed={picked.locationId === l.id}
                      onClick={() => {
                        holder.contentChanged();
                        setPicked({ ...picked, locationId: l.id });
                      }}
                    >
                      {l.name}
                    </SecondaryButton>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className="text-sm font-semibold text-ink" data-testid="rack-auto">
                {t("flow.rackAuto", { name: receipt.receivingLocations[0]?.name ?? "" })}
              </p>
            )
          }
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
            <p className="break-words text-sm text-ink-muted [@media(max-height:700px)]:hidden">{picked.line.itemCode}</p>
            <LineStatus expected={picked.line.expected} received={picked.line.received} damaged={picked.line.damaged} open={picked.line.open} />
          </section>
          <QtyStepper
            label={t("flow.received", { unit: picked.line.unitName })}
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
        backHref={base}
        scanProxy
        footer={<PrimaryButton onClick={scanPrimary.press}>{t("flow.scanNow")}</PrimaryButton>}
      >
        <ScanPanel service={scanner} prompt={busy ? t("flow.checking") : t("flow.scanPrompt")} last={last} {...(lastName === undefined ? {} : { lastName })} ready={scanPrimary.ready && last === ""} hue="green" />
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
      {scanPrimary.overlay}
      {alertView}
    </>
  );
}
