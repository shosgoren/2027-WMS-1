"use client";
// Saha kör sayım (T-316): raf okut → ürün okut (koli → adet) → sayılan miktar → kaydet; raf bitince "Bu rafta başka ürün yok"; tüm raflar bitince gönder.
// KÖR SAYIM: bu ekran yalnız sunucunun `field` kipini alır (T-316a); sistem (referans) miktarı ve fark istemciye HİÇBİR yoldan gelmez (props, eylem yanıtı, hata metni).
// Kilit, yetki, durum ve ölçek kuralları domain'dedir (`recordCount`/`submitCount`); bu dosya yalnızca girdi toplar ve sunucu hatasını (kod + sonraki eylem) gösterir.
// Miktar: ürünün `quantityScale`'ine göre ondalık kabul edilir (virgül/nokta), sunucuya METİN gider (I-09), yuvarlama yok; ölçeği aşan giriş reddedilir (neden + eylem).
// Anahtar: yanıt alınamayan (ağ) tekrar AYNI anahtar, sunucu yanıtından sonraki yeni deneme YENİ anahtar (count-review.tsx `useAttemptKey`; T-313 ile uyumlu).
// Çerçeve `FlowShell` ortak saha parçasıdır (receive-flow.tsx); yatay (844×390) yerleşim düzeltmesi T-292b'dedir.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner, ChevronDown, CircleAlert, CircleCheck, ClipboardCheck, ScanLine } from "@wms/ui";
import { CountErrorNotice, addCountQty, countErrorKey, parseCountQty, plainQty, runAttempt, useAttemptKey, type CountLocationInfo } from "../../counts/[id]/count-review.tsx";
import type { ErrorInfo } from "../../receipts/receipt-form.tsx";
import { resolveLocationScanAction } from "../../receipts/actions.ts";
import { fieldCountAction, recordCountAction, resolveCountItemAction, submitCountAction } from "../../counts/actions.ts";
import { CompoundLine, DroppedNotice, FlowShell, PrimaryButton, PrimaryLink, ScanPanel, SecondaryButton, useScanPrimary, useScanner, useStateRef } from "../receive/receive-flow.tsx";

/** Saha satırı: referans ve fark alanı YOKTUR (sunucu `field` kipi). */
export interface FieldLineView {
  readonly id: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
  readonly quantityScale: number;
  readonly stockStatus: string;
  /** Sayacın kendi girdisi (henüz sayılmadıysa null); sistem miktarı değildir. */
  readonly counted: string | null;
}
type Stage = "loc" | "item" | "qty" | "none" | "submitted";
interface Loc {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface Item {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unitName: string;
  readonly scale: number;
}
interface AlertView {
  readonly titleKey: string;
  readonly reasonKey: string;
  readonly code?: string;
  readonly back?: Stage;
  /** Düğme: "retry" (tekrar okut) ya da "ok" (tamam). */
  readonly button: "retry" | "ok";
}

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const codeOf = (e: Pick<ErrorInfo, "code" | "detail">): string => (e.detail === undefined ? e.code : `${e.code}/${e.detail}`);
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** Raf: kod + ad (ad koddan farklıysa); sahada iki raf aynı adı taşıyabilir. */
const locLabel = (l: { code: string; name: string }): string => (l.name === "" || l.name === l.code ? l.code : `${l.code} · ${l.name}`);
const TOTAL_STEPS = 4;
/** Bir komutta en çok satır (domain `COUNT_MAX_INPUT_LINES`): daha fazla sayılmamış satır parçalı gönderilir. */
const CHUNK = 200;

/** Tam ekran uyarı (R-04): sebep + sonraki eylem; düğme metni uyarının sonucuyla uyumludur (kilit kapandıysa "Tamam", yanlış okumada "Tekrar okut"). */
function CountAlert({ title, reason, action, code, button, onClose }: { title: string; reason: string; action: string; code?: string; button: string; onClose: () => void }) {
  const t = useTranslations("counting");
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate([200, 80, 200]);
  }, []);
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="count-alert-title" aria-describedby="count-alert-body" data-testid="scan-alert" className="fixed inset-0 z-50 flex flex-col justify-between gap-4 bg-danger-bg px-6 pb-6 pt-10 text-danger-ink">
      <div className="flex min-w-0 flex-col items-center gap-4 text-center">
        <CircleAlert aria-hidden="true" className="size-20 text-danger" strokeWidth={2} />
        <h2 id="count-alert-title" className="break-words text-3xl font-extrabold">
          {title}
        </h2>
        <p id="count-alert-body" className="break-words text-xl font-semibold">
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
        {button}
      </button>
    </div>
  );
}

/** Sayılan miktar: −/+ (48 px), ondalık ürün için `inputmode="decimal"` ve virgül/nokta; ölçeği aşan giriş açık neden + eylemle reddedilir. */
function CountQty({ label, value, scale, onChange, onScan, scanLabel }: { label: string; value: string; scale: number; onChange: (v: string) => void; onScan: () => void; scanLabel: string }) {
  const t = useTranslations("counting");
  const id = useId();
  const parsed = parseCountQty(value, scale);
  const btn = `flex size-12 shrink-0 items-center justify-center rounded-control border-2 border-border-strong bg-surface text-3xl font-bold text-ink disabled:opacity-40 ${FOCUS}`;
  const canon = parsed.ok ? parsed.value : "0";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-base font-semibold text-ink" htmlFor={id}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" aria-label={`${label} −`} disabled={!parsed.ok || canon === "0"} onClick={() => onChange(addCountQty(canon, "-1"))} className={btn}>
          <span aria-hidden="true">−</span>
        </button>
        <input
          id={id}
          inputMode={scale > 0 ? "decimal" : "numeric"}
          autoComplete="off"
          value={value}
          aria-invalid={!parsed.ok || undefined}
          aria-describedby={parsed.ok ? undefined : `${id}-err`}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, "").slice(0, 16))}
          className={`min-h-12 w-full min-w-0 flex-1 rounded-card border-2 bg-surface px-2 text-center text-2xl font-extrabold text-ink ${parsed.ok ? "border-border-strong" : "border-danger"} ${FOCUS}`}
        />
        <button type="button" aria-label={`${label} +`} disabled={!parsed.ok} onClick={() => onChange(addCountQty(canon, "1"))} className={btn}>
          <span aria-hidden="true">+</span>
        </button>
        <button type="button" aria-label={scanLabel} title={scanLabel} data-testid="scan-more" onClick={onScan} className={`flex size-12 shrink-0 items-center justify-center rounded-control border-2 border-border-strong bg-surface text-ink ${FOCUS}`}>
          <ScanLine aria-hidden="true" className="size-6" strokeWidth={2} />
        </button>
      </div>
      {parsed.ok ? null : (
        <p id={`${id}-err`} role="alert" data-testid="qty-error" className="flex items-start gap-1 break-words text-base font-semibold text-danger-ink">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
          <span className="min-w-0">
            {t(`flow.qtyErr.${parsed.reason === "scale" && scale === 0 ? "scaleInt" : parsed.reason}`, { scale })} {t(`flow.qtyErr.${parsed.reason === "scale" && scale === 0 ? "scaleInt" : parsed.reason}Action`)}
          </span>
        </p>
      )}
    </div>
  );
}

export function CountFlow({ slug, sessionId, warehouseId, initialLocations, initialLines }: { slug: string; sessionId: string; warehouseId: string; initialLocations: readonly CountLocationInfo[]; initialLines: readonly FieldLineView[] }) {
  const t = useTranslations("counting");
  const recordKey = useAttemptKey();
  const submitKey = useAttemptKey();
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const [locations, setLocations, locationsRef] = useStateRef<readonly CountLocationInfo[]>(initialLocations);
  const [lines, setLines, linesRef] = useStateRef<readonly FieldLineView[]>(initialLines);
  // Satırı olmayan raf (sistemde mal yok görünen) yalnız sayaç "başka ürün yok" dediğinde ya da bulgu kaydettiğinde tamamlanır; satırlı raf tüm satırlar sayılınca.
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  const [skipSend, setSkipSend] = useState(false);
  const [stage, setStage, stageRef] = useStateRef<Stage>("loc");
  const [loc, setLoc, locRef] = useStateRef<Loc | null>(null);
  const [item, setItem, itemRef] = useStateRef<Item | null>(null);
  const [status, setStatus] = useState("AVAILABLE");
  const [qty, setQtyState, qtyRef] = useStateRef("1");
  const [last, setLast] = useState("");
  const [lastStage, setLastStage] = useState<Stage>("loc");
  const [lastName, setLastName] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [alert, setAlert, alertRef] = useStateRef<AlertView | null>(null);
  const [error, setError] = useState<{ info: ErrorInfo; ctx: "record" | "submit" } | null>(null);
  const [saved, setSaved] = useState<{ name: string; qty: string } | null>(null);
  const setQty = (v: string): void => {
    recordKey.changed(); // içerik değişti: aynı anahtar başka içerikle IDEMPOTENCY_MISMATCH verirdi
    setQtyState(v);
  };

  const lockedLocs = locations.filter((l) => l.locked);
  const locComplete = (id: string): boolean => {
    const own = lines.filter((l) => l.locationId === id);
    return own.length === 0 ? visited.has(id) : own.every((l) => l.counted !== null);
  };
  const doneLocs = lockedLocs.filter((l) => locComplete(l.id)).length;
  const allDone = lockedLocs.length > 0 && doneLocs === lockedLocs.length;
  const noneLocked = lockedLocs.length === 0;

  const showAlert = (titleKey: string, reasonKey: string, code?: string, back?: Stage, button: "retry" | "ok" = "retry"): void => {
    setAlert({ titleKey, reasonKey, button, ...(code === undefined ? {} : { code }), ...(back === undefined ? {} : { back }) });
  };

  // Odak: aşama/uyarı değişince odak BODY'ye düşmesin; adım başlığına taşınır (ekran okuyucu yeni adımı okur).
  useEffect(() => {
    if (alert !== null) return;
    const h = document.querySelector<HTMLElement>('[data-testid="flow-step"] h1');
    if (h === null) return;
    h.tabIndex = -1;
    h.style.outline = "none"; // programatik odak: başlık çerçevesi çizilmez (etkileşimli öğe değildir)
    h.focus({ preventScroll: true });
  }, [stage, alert, saved, skipSend]);

  // Akış kapısı (ref'ten, eşzamanlı): tarama servisi ve kamera aynı işlevi kullanır.
  const blocked = useCallback(() => {
    const at = stageRef.current;
    return busyRef.current || alertRef.current !== null || !(at === "loc" || at === "item" || at === "qty");
  }, [alertRef, stageRef]);

  /** Kayıt başarısı sonrası sunucu ilerlemesini tazeler; başarısızsa yerel (az önce kaydedilen) durum doğru kalır, kayıt başarısı etkilenmez. */
  const resync = useCallback(async () => {
    try {
      const r = await fieldCountAction({ slug, sessionId });
      if (r.ok) {
        setLines(r.data.lines.map((l) => ({ id: l.id, locationId: l.locationId, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, unitName: l.unitName || l.unitCode, quantityScale: l.quantityScale, stockStatus: l.stockStatus, counted: l.counted })));
        setLocations(r.data.locations.map((l) => ({ id: l.id, code: l.code, name: l.name, locked: l.locked })));
      }
    } catch {
      /* yerel durum geçerli */
    }
  }, [slug, sessionId, setLines, setLocations]);

  const onScanned = useCallback(
    async (code: string) => {
      if (blocked()) return;
      busyRef.current = true;
      setLast(code);
      setLastStage(stageRef.current);
      setLastName(undefined);
      setBusy(true);
      setError(null);
      setSaved(null);
      try {
        const at = stageRef.current;
        if (at === "loc") {
          const res = await resolveLocationScanAction({ slug, warehouseId, code });
          if (!res.ok) {
            showAlert("alert.scanTitle", countErrorKey(res.error, "scan"), codeOf(res.error));
            return;
          }
          const inSession = locationsRef.current.find((x) => sameId(x.id, res.data.id));
          if (inSession === undefined) {
            showAlert("alert.locTitle", "loc_not_in_session", "LOC_NOT_IN_SESSION");
            return;
          }
          if (!inSession.locked) {
            showAlert("alert.locTitle", "loc_closed", "LOC_NOT_LOCKED");
            return;
          }
          setLastName(locLabel(res.data));
          setLoc({ id: inSession.id, code: res.data.code, name: res.data.name });
          setStage("item");
          return;
        }
        // at === "item" | "qty"
        const res = await resolveCountItemAction({ slug, code });
        if (!res.ok) {
          showAlert("alert.scanTitle", countErrorKey(res.error, "scan"), codeOf(res.error));
          return;
        }
        // Sayım temel birimde yapılır: koli okutunca adım koli içi adettir (`baseQuantity`, K-1; sunucudan AYNEN). Ürün ölçeğine uymayan adım uydurulmaz, açık uyarı.
        const step = parseCountQty(plainQty(res.data.baseQuantity), res.data.quantityScale);
        if (!step.ok || step.value === "0") {
          showAlert("alert.unitTitle", "qty_fractional", "QUANTITY_NOT_REPRESENTABLE");
          return;
        }
        setLastName(res.data.itemName);
        const here = locRef.current;
        if (at === "qty") {
          // Aynı ürün yeniden okutulursa adet eklenir (iki koli = iki katı; üst sınırda kırpılır); başka ürün önce açık ürünü bitirmeyi ister.
          if (itemRef.current === null || !sameId(itemRef.current.id, res.data.itemId)) {
            showAlert("alert.mismatchTitle", "finish_first", "SCAN_MISMATCH");
            return;
          }
          const cur = parseCountQty(qtyRef.current, itemRef.current.scale);
          recordKey.changed();
          setQtyState(addCountQty(cur.ok ? cur.value : "0", step.value));
          return;
        }
        if (here === null) return;
        const own = linesRef.current.filter((l) => l.locationId === here.id && sameId(l.itemId, res.data.itemId));
        const known = own[0];
        setItem({ id: res.data.itemId, code: res.data.itemCode, name: res.data.itemName, unitName: known?.unitName ?? "", scale: res.data.quantityScale });
        setStatus(own.find((l) => l.stockStatus === "AVAILABLE")?.stockStatus ?? known?.stockStatus ?? "AVAILABLE");
        recordKey.changed();
        setQtyState(step.value);
        setStage("qty");
      } catch {
        showAlert("alert.networkTitle", "network", "NETWORK");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [slug, warehouseId, blocked, stageRef, locRef, itemRef, qtyRef, linesRef, locationsRef, recordKey, setLoc, setStage, setItem],
  );
  const scanning = (stage === "loc" || stage === "item" || stage === "qty") && !(allDone && !skipSend);
  const { service: scanner, camera, dropped, clearDropped } = useScanner((v) => void onScanned(v), scanning && alert === null && !busy, blocked);
  const scanPrimary = useScanPrimary(camera, { busy, name: lastName, code: last, alerting: alert !== null });

  /** Yazma hatası: engelleyici durumlar (kilit kapandı, durum değişti, oturum yok) tam ekran uyarıdır; diğerleri satır içi (neden + sonraki eylem). */
  function failed(info: ErrorInfo, ctx: "record" | "submit"): void {
    const key = countErrorKey(info, ctx);
    if (key === "location_locked" || key === "document_state" || key === "not_found") {
      showAlert("alert.lockTitle", "flow_closed", codeOf(info), "loc", "ok");
      void resync();
      return;
    }
    setError({ info, ctx });
  }

  function mark(locationId: string, found: Item | null, st: string, counted: string): void {
    const cur = linesRef.current;
    if (found === null) {
      setLines(cur.map((l) => (l.locationId === locationId && l.counted === null ? { ...l, counted } : l)));
      return;
    }
    const idx = cur.findIndex((l) => l.locationId === locationId && sameId(l.itemId, found.id) && l.stockStatus === st);
    if (idx >= 0) setLines(cur.map((l, i) => (i === idx ? { ...l, counted } : l)));
    else setLines([...cur, { id: `new-${found.id}-${st}`, locationId, itemId: found.id, itemCode: found.code, itemName: found.name, unitName: found.unitName, quantityScale: found.scale, stockStatus: st, counted }]);
  }

  const parsedQty = item === null ? null : parseCountQty(qty, item.scale);

  async function save() {
    const here = loc;
    const cur = item;
    if (busyRef.current || here === null || cur === null) return;
    const q = parseCountQty(qty, cur.scale);
    if (!q.ok) return; // düğme de kapalıdır; ölçek kuralı sunucuda da denetlenir
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const out = await runAttempt(recordKey, (clientKey) => recordCountAction({ slug, clientKey, sessionId, lines: [{ locationId: here.id, itemId: cur.id, countedQuantity: q.value, stockStatus: status }] }));
    busyRef.current = false;
    setBusy(false);
    if (!out.ok) {
      failed(out.error, "record");
      return;
    }
    mark(here.id, cur, status, q.value);
    setVisited((v) => new Set(v).add(here.id));
    setSaved({ name: cur.name, qty: q.value });
    setItem(null);
    setLast("");
    setLastName(undefined);
    setStage("item");
    void resync();
  }

  /** "Bu rafta başka ürün yok": okutulmayan (sayılmamış) satırlar 0 olarak yazılır (200'erli parçalar); satırı olmayan raf yalnız tamamlandı sayılır (yazılacak bir şey yok). */
  async function confirmNone() {
    const here = loc;
    if (busyRef.current || here === null) return;
    const rest = linesRef.current.filter((l) => l.locationId === here.id && l.counted === null);
    if (rest.length > 0) {
      busyRef.current = true;
      setBusy(true);
      setError(null);
      for (let i = 0; i < rest.length; i += CHUNK) {
        const part = rest.slice(i, i + CHUNK);
        const out = await runAttempt(recordKey, (clientKey) =>
          recordCountAction({ slug, clientKey, sessionId, lines: part.map((l) => ({ locationId: here.id, itemId: l.itemId, countedQuantity: "0", stockStatus: l.stockStatus })) }),
        );
        if (!out.ok) {
          busyRef.current = false;
          setBusy(false);
          // Önceki parçalar yazıldı; kalan satırlar sayılmamış kalır, kullanıcı yeniden dener.
          setLines(linesRef.current.map((l) => (rest.slice(0, i).some((r) => r.id === l.id) ? { ...l, counted: "0" } : l)));
          failed(out.error, "record");
          return;
        }
      }
      busyRef.current = false;
      setBusy(false);
      mark(here.id, null, "AVAILABLE", "0");
    }
    setVisited((v) => new Set(v).add(here.id));
    setLoc(null);
    setItem(null);
    setSaved(null);
    setLast("");
    setLastName(undefined);
    setStage("loc");
    void resync();
  }

  async function submit() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const out = await runAttempt(submitKey, (clientKey) => submitCountAction({ slug, clientKey, sessionId }));
    busyRef.current = false;
    setBusy(false);
    if (!out.ok) {
      failed(out.error, "submit");
      return;
    }
    setStage("submitted");
  }

  const icon = <ClipboardCheck aria-hidden="true" className="size-6" />;
  const closeAlert = (): void => {
    if (alert?.back !== undefined) {
      setLoc(null);
      setItem(null);
      setStage(alert.back);
    }
    setAlert(null);
    clearDropped();
  };
  const alertView = (
    <>
      <DroppedNotice show={dropped} alerting={alert !== null} onClose={clearDropped} />
      {alert === null ? null : (
        <CountAlert
          title={t(alert.titleKey)}
          reason={t(`errors.${alert.reasonKey}`)}
          action={t(`errors.${alert.reasonKey}Action`)}
          button={t(alert.button === "ok" ? "flow.alertOk" : "flow.alertRetry")}
          {...(alert.code === undefined ? {} : { code: alert.code })}
          onClose={closeAlert}
        />
      )}
    </>
  );
  const withOverlay = (node: React.ReactNode): React.ReactElement => (
    <>
      {node}
      {scanPrimary.overlay}
    </>
  );
  /** Yönerge: kısa ekranda gizlenmez (ortak çerçevenin yönergesi 700 px altında gizlendiğinden burada çizilir). */
  const instr = (key: string): React.ReactElement => (
    <p className="break-words text-base text-ink" data-testid="count-instruction">
      {t(key)}
    </p>
  );

  if (stage === "submitted") {
    return withOverlay(
      <>
        <FlowShell hue="teal" icon={icon} step={4} total={TOTAL_STEPS} title={t("flow.submittedTitle")} footer={<PrimaryLink href={fieldHome}>{t("flow.toField")}</PrimaryLink>}>
          <Banner kind="success">
            <p className="font-semibold" data-testid="count-submitted">
              {t("flow.submitted")}
            </p>
          </Banner>
          <p className="flex items-center gap-2 text-lg font-bold text-ink">
            <CircleCheck aria-hidden="true" className="size-6 text-success" />
            {t("flow.submittedNext")}
          </p>
        </FlowShell>
        {alertView}
      </>,
    );
  }

  if (noneLocked) {
    return withOverlay(
      <>
        <FlowShell hue="teal" icon={icon} title={t("flow.closedTitle")} backHref={fieldHome} footer={<PrimaryLink href={fieldHome}>{t("flow.toField")}</PrimaryLink>}>
          <p className="break-words text-lg text-ink" data-testid="count-closed">
            {t("flow.closed")}
          </p>
        </FlowShell>
        {alertView}
      </>,
    );
  }

  if (allDone && !skipSend && stage === "loc") {
    const countedLines = lines.filter((l) => l.counted !== null).length;
    return withOverlay(
      <>
        <FlowShell
          hue="teal"
          icon={icon}
          step={4}
          total={TOTAL_STEPS}
          title={t("flow.sendTitle")}
          onBack={() => {
            setError(null);
            setSkipSend(true);
          }}
          footer={
            <PrimaryButton loading={busy} onClick={() => void submit()}>
              {t("flow.send")}
            </PrimaryButton>
          }
        >
          {instr("flow.sendInstruction")}
          <p className="rounded-card border-2 border-border bg-surface p-3 text-lg font-bold text-ink" data-testid="count-progress">
            {t("flow.sendSummary", { locs: lockedLocs.length, items: countedLines })}
          </p>
          {error === null ? null : <CountErrorNotice error={error.info} context={error.ctx} />}
        </FlowShell>
        {alertView}
      </>,
    );
  }

  if (stage === "none" && loc !== null) {
    return withOverlay(
      <>
        <FlowShell
          hue="teal"
          icon={icon}
          step={3}
          total={TOTAL_STEPS}
          title={t("flow.noneTitle")}
          onBack={() => {
            setError(null);
            setStage("item");
          }}
          footer={
            <PrimaryButton loading={busy} onClick={() => void confirmNone()}>
              {t("flow.noneConfirm")}
            </PrimaryButton>
          }
        >
          {instr("flow.noneInstruction")}
          <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3">
            <p className="break-words text-xl font-bold text-ink">{t("flow.atLocation", { name: locLabel(loc) })}</p>
            <p className="break-words text-base text-ink">{t("flow.noneBody")}</p>
          </section>
          {error === null ? null : <CountErrorNotice error={error.info} context={error.ctx} />}
        </FlowShell>
        {alertView}
      </>,
    );
  }

  if (stage === "qty" && loc !== null && item !== null) {
    const candidates = [...new Set(lines.filter((l) => l.locationId === loc.id && sameId(l.itemId, item.id)).map((l) => l.stockStatus))];
    const before = lines.find((l) => l.locationId === loc.id && sameId(l.itemId, item.id) && l.stockStatus === status)?.counted ?? null;
    return withOverlay(
      <>
        <FlowShell
          hue="teal"
          icon={icon}
          step={3}
          total={TOTAL_STEPS}
          title={t("flow.qtyTitle")}
          onBack={() => {
            setError(null);
            setItem(null);
            setStage("item");
          }}
          footer={
            <PrimaryButton loading={busy} disabled={parsedQty === null || !parsedQty.ok} onClick={() => void save()}>
              {t("flow.save")}
            </PrimaryButton>
          }
        >
          {instr("flow.qtyInstruction")}
          <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3" aria-label={t("flow.verify")}>
            <p className="break-words text-2xl font-extrabold text-ink" data-testid="counted-item">
              {item.name}
            </p>
            <p className="break-words text-base text-ink">{t("flow.atLocation", { name: locLabel(loc) })}</p>
            {before === null ? null : (
              <p className="break-words text-sm font-semibold text-ink-muted" data-testid="counted-before">
                {t("flow.countedBefore", { n: plainQty(before) })}
              </p>
            )}
          </section>
          {candidates.length > 1 ? (
            <div role="group" aria-label={t("flow.statusLabel")} className="flex min-w-0 flex-wrap gap-2">
              {candidates.map((s) => (
                <SecondaryButton key={s} pressed={status === s} tone="teal" onClick={() => setStatus(s)}>
                  {t(`stockStatus.${s}`)}
                </SecondaryButton>
              ))}
            </div>
          ) : null}
          <CountQty label={t("flow.qtyLabel")} value={qty} scale={item.scale} onChange={setQty} onScan={scanPrimary.press} scanLabel={t("flow.scanMore")} />
          {item.scale === 0 && parsedQty !== null && parsedQty.ok ? <CompoundLine slug={slug} itemId={item.id} baseQty={Number(parsedQty.value)} /> : null}
          {error === null ? null : <CountErrorNotice error={error.info} context={error.ctx} />}
        </FlowShell>
        {alertView}
      </>,
    );
  }

  const inItem = stage === "item" && loc !== null;
  const panelLast = inItem && lastStage !== "item" ? "" : last; // raf okutması ürün adımında "son okutulan" olarak tekrar gösterilmez (kısa ekranda yer)
  return withOverlay(
    <>
      <FlowShell
        hue="teal"
        icon={icon}
        step={inItem ? 2 : 1}
        total={TOTAL_STEPS}
        title={t(inItem ? "flow.itemTitle" : "flow.locTitle")}
        {...(inItem
          ? {
              onBack: () => {
                setLoc(null);
                setSaved(null);
                setLast("");
                setLastName(undefined);
                setStage("loc");
              },
            }
          : { backHref: fieldHome })}
        scanProxy
        footer={<PrimaryButton onClick={scanPrimary.press}>{t("flow.scanNow")}</PrimaryButton>}
      >
        {inItem ? (
          <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3" data-testid="count-location">
            <p className="break-words text-xl font-bold text-ink">{t("flow.atLocation", { name: locLabel(loc) })}</p>
            {saved === null ? instr("flow.itemInstruction") : (
              <p className="flex items-center gap-2 break-words text-base font-semibold text-success-ink" role="status" data-testid="count-saved">
                <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-success" />
                {t("flow.saved", { name: saved.name, qty: saved.qty })}
              </p>
            )}
          </section>
        ) : (
          <>
            {instr("flow.locInstruction")}
            <p className="rounded-card border-2 border-border bg-surface p-3 text-lg font-bold text-ink" data-testid="count-progress">
              {t("flow.progress", { done: doneLocs, total: lockedLocs.length })}
            </p>
          </>
        )}
        <ScanPanel service={scanner} prompt={busy ? t("flow.checking") : t(inItem ? "flow.itemPrompt" : "flow.locPrompt")} last={panelLast} {...(lastName === undefined || panelLast === "" ? {} : { lastName })} ready={scanPrimary.ready && panelLast === ""} hue="teal" />
        {inItem ? <SecondaryButton onClick={() => setStage("none")}>{t("flow.noneButton")}</SecondaryButton> : null}
        {allDone && skipSend ? (
          <SecondaryButton
            onClick={() => {
              setSkipSend(false);
              setLoc(null);
              setStage("loc");
            }}
          >
            {t("flow.backToSend")}
          </SecondaryButton>
        ) : null}
        {error === null ? null : <CountErrorNotice error={error.info} context={error.ctx} />}
      </FlowShell>
      {alertView}
    </>,
  );
}
