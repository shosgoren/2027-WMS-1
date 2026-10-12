"use client";
// Saha kör sayım (T-316): raf okut → ürün okut (koli → adet) → sayılan miktar → kaydet; raf bitince "Bu rafta başka ürün yok"; tüm raflar bitince gönder.
// KÖR SAYIM: bu ekran yalnız sunucunun `field` kipini alır (T-316a); sistem (referans) miktarı ve fark istemciye HİÇBİR yoldan gelmez (props, eylem yanıtı, hata metni).
// Kilit, yetki, durum ve ölçek kuralları domain'dedir (`recordCount`/`submitCount`); bu dosya yalnızca girdi toplar ve sunucu hatasını (kod + sonraki eylem) gösterir.
// Anahtar: her kullanıcı denemesi yeni anahtar, deneme sürerken aynı (count-review.tsx `useAttemptKey`; T-277a). Miktarlar sunucuya DİZGİ gider (I-09).
// Ortak saha parçaları (adım çerçevesi, tarama, miktar, uyarı) `receive-flow.tsx`'tendir (T-313/T-286).
import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner, CircleCheck, ClipboardCheck } from "@wms/ui";
import { CountErrorNotice, countErrorKey, runAttempt, useAttemptKey, type CountLocationInfo } from "../../counts/[id]/count-review.tsx";
import type { ErrorInfo } from "../../receipts/receipt-form.tsx";
import { resolveItemScanAction, resolveLocationScanAction } from "../../receipts/actions.ts";
import { fieldCountAction, recordCountAction, submitCountAction } from "../../counts/actions.ts";
import { CompoundLine, DroppedNotice, FlowShell, PrimaryButton, PrimaryLink, QtyStepper, ScanAlert, ScanPanel, SecondaryButton, scanStepOf, useScanPrimary, useScanner, useStateRef } from "../receive/receive-flow.tsx";

/** Saha satırı: referans ve fark alanı YOKTUR (sunucu `field` kipi). */
export interface FieldLineView {
  readonly id: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
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
}
interface AlertView {
  readonly titleKey: string;
  readonly reasonKey: string;
  readonly code?: string;
  readonly back?: Stage;
}

const codeOf = (e: Pick<ErrorInfo, "code" | "detail">): string => (e.detail === undefined ? e.code : `${e.code}/${e.detail}`);
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const TOTAL_STEPS = 4;

export function CountFlow({ slug, sessionId, warehouseId, initialLocations, initialLines }: { slug: string; sessionId: string; warehouseId: string; initialLocations: readonly CountLocationInfo[]; initialLines: readonly FieldLineView[] }) {
  const t = useTranslations("counting");
  const recordKey = useAttemptKey();
  const submitKey = useAttemptKey();
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const [locations, setLocations, locationsRef] = useStateRef<readonly CountLocationInfo[]>(initialLocations);
  const [lines, setLines, linesRef] = useStateRef<readonly FieldLineView[]>(initialLines);
  // Satırı olmayan raf (sistemde mal yok görünen) yalnız sayaç "başka ürün yok" dediğinde ya da bulgu kaydettiğinde tamamlanır; satırlı raf tüm satırlar sayılınca.
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  const [stage, setStage, stageRef] = useStateRef<Stage>("loc");
  const [loc, setLoc, locRef] = useStateRef<Loc | null>(null);
  const [item, setItem, itemRef] = useStateRef<Item | null>(null);
  const [status, setStatus] = useState("AVAILABLE");
  const [qty, setQty, qtyRef] = useStateRef(1);
  const [last, setLast] = useState("");
  const [lastName, setLastName] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [alert, setAlert, alertRef] = useStateRef<AlertView | null>(null);
  const [error, setError] = useState<{ info: ErrorInfo; ctx: "record" | "submit" } | null>(null);
  const [saved, setSaved] = useState<{ name: string; qty: string } | null>(null);

  const lockedLocs = locations.filter((l) => l.locked);
  const locComplete = (id: string): boolean => {
    const own = lines.filter((l) => l.locationId === id);
    return own.length === 0 ? visited.has(id) : own.every((l) => l.counted !== null);
  };
  const doneLocs = lockedLocs.filter((l) => locComplete(l.id)).length;
  const allDone = lockedLocs.length > 0 && doneLocs === lockedLocs.length;
  const noneLocked = lockedLocs.length === 0;

  const showAlert = (titleKey: string, reasonKey: string, code?: string, back?: Stage): void => {
    setAlert({ titleKey, reasonKey, ...(code === undefined ? {} : { code }), ...(back === undefined ? {} : { back }) });
  };

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
        setLines(r.data.lines.map((l) => ({ id: l.id, locationId: l.locationId, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, unitName: l.unitName || l.unitCode, stockStatus: l.stockStatus, counted: l.counted })));
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
          setLastName(res.data.name || res.data.code);
          setLoc({ id: inSession.id, code: res.data.code, name: res.data.name });
          setStage("item");
          return;
        }
        // at === "item" | "qty"
        const res = await resolveItemScanAction({ slug, code });
        if (!res.ok) {
          showAlert("alert.scanTitle", countErrorKey(res.error, "scan"), codeOf(res.error));
          return;
        }
        // Sayım temel birimde yapılır: koli okutunca adım koli içi adettir (`baseQuantity`, K-1); kesirli/birimsiz ise açık uyarı (adım uydurulmaz).
        const step = scanStepOf(res.data, res.data.baseUnitId);
        if (!step.ok) {
          showAlert("alert.unitTitle", step.reason === "unit" ? "unit_mismatch" : "qty_fractional", step.reason === "unit" ? "UNIT_MISMATCH" : "QUANTITY_NOT_WHOLE");
          return;
        }
        setLastName(res.data.itemName);
        const here = locRef.current;
        if (at === "qty") {
          // Aynı ürün yeniden okutulursa adet eklenir (iki koli = iki katı); başka ürün önce açık ürünü bitirmeyi ister.
          if (itemRef.current === null || !sameId(itemRef.current.id, res.data.itemId)) {
            showAlert("alert.mismatchTitle", "finish_first", "SCAN_MISMATCH");
            return;
          }
          setQty(qtyRef.current + step.step);
          return;
        }
        if (here === null) return;
        const own = linesRef.current.filter((l) => l.locationId === here.id && sameId(l.itemId, res.data.itemId));
        const known = own[0];
        setItem({ id: res.data.itemId, code: res.data.itemCode, name: res.data.itemName, unitName: known?.unitName ?? "" });
        setStatus(own.find((l) => l.stockStatus === "AVAILABLE")?.stockStatus ?? known?.stockStatus ?? "AVAILABLE");
        setQty(step.step);
        setStage("qty");
      } catch {
        showAlert("alert.networkTitle", "network", "NETWORK");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [slug, warehouseId, blocked, stageRef, locRef, itemRef, qtyRef, linesRef, locationsRef, setLoc, setStage, setItem, setQty],
  );
  const scanning = (stage === "loc" || stage === "item" || stage === "qty") && !allDone;
  const { service: scanner, camera, dropped, clearDropped } = useScanner((v) => void onScanned(v), scanning && alert === null && !busy, blocked);
  const scanPrimary = useScanPrimary(camera, { busy, name: lastName, code: last, alerting: alert !== null });

  /** Yazma hatası: engelleyici durumlar (kilit kapandı, durum değişti, oturum yok) tam ekran uyarıdır; diğerleri satır içi (neden + sonraki eylem). */
  function failed(info: ErrorInfo, ctx: "record" | "submit"): void {
    const key = countErrorKey(info, ctx);
    if (key === "location_locked" || key === "document_state" || key === "not_found") {
      showAlert("alert.lockTitle", key, codeOf(info), "loc");
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
    else setLines([...cur, { id: `new-${found.id}-${st}`, locationId, itemId: found.id, itemCode: found.code, itemName: found.name, unitName: found.unitName, stockStatus: st, counted }]);
  }

  async function save() {
    const here = loc;
    const cur = item;
    if (busyRef.current || here === null || cur === null) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const out = await runAttempt(recordKey, (clientKey) =>
      recordCountAction({ slug, clientKey, sessionId, lines: [{ locationId: here.id, itemId: cur.id, countedQuantity: String(qty), stockStatus: status }] }),
    );
    busyRef.current = false;
    setBusy(false);
    if (!out.ok) {
      failed(out.error, "record");
      return;
    }
    mark(here.id, cur, status, String(qty));
    setVisited((v) => new Set(v).add(here.id));
    setSaved({ name: cur.name, qty: String(qty) });
    setItem(null);
    setLast("");
    setLastName(undefined);
    setStage("item");
    void resync();
  }

  /** "Bu rafta başka ürün yok": okutulmayan (sayılmamış) satırlar 0 olarak yazılır; satırı olmayan raf yalnız tamamlandı sayılır (yazılacak bir şey yok). */
  async function confirmNone() {
    const here = loc;
    if (busyRef.current || here === null) return;
    const rest = linesRef.current.filter((l) => l.locationId === here.id && l.counted === null);
    if (rest.length > 0) {
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const out = await runAttempt(recordKey, (clientKey) =>
        recordCountAction({ slug, clientKey, sessionId, lines: rest.map((l) => ({ locationId: here.id, itemId: l.itemId, countedQuantity: "0", stockStatus: l.stockStatus })) }),
      );
      busyRef.current = false;
      setBusy(false);
      if (!out.ok) {
        failed(out.error, "record");
        return;
      }
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
        <ScanAlert title={t(alert.titleKey)} reason={t(`errors.${alert.reasonKey}`)} action={t(`errors.${alert.reasonKey}Action`)} {...(alert.code === undefined ? {} : { code: alert.code })} onClose={closeAlert} />
      )}
    </>
  );
  const withOverlay = (node: React.ReactNode): React.ReactElement => (
    <>
      {node}
      {scanPrimary.overlay}
    </>
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

  if (allDone && (stage === "loc")) {
    return withOverlay(
      <>
        <FlowShell
          hue="teal"
          icon={icon}
          step={4}
          total={TOTAL_STEPS}
          title={t("flow.sendTitle")}
          instruction={t("flow.sendInstruction")}
          footer={
            <PrimaryButton loading={busy} onClick={() => void submit()}>
              {t("flow.send")}
            </PrimaryButton>
          }
        >
          <p className="rounded-card border-2 border-border bg-surface p-3 text-lg font-bold text-ink" data-testid="count-progress">
            {t("flow.progress", { done: doneLocs, total: lockedLocs.length })}
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
          instruction={t("flow.noneInstruction")}
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
          <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3">
            <p className="break-words text-xl font-bold text-ink">{t("flow.atLocation", { name: loc.name || loc.code })}</p>
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
          instruction={t("flow.qtyInstruction")}
          onBack={() => {
            setError(null);
            setItem(null);
            setStage("item");
          }}
          footer={
            <PrimaryButton loading={busy} onClick={() => void save()}>
              {t("flow.save")}
            </PrimaryButton>
          }
        >
          <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3" aria-label={t("flow.verify")}>
            <p className="break-words text-2xl font-extrabold text-ink" data-testid="counted-item">
              {item.name}
            </p>
            <p className="break-words text-base text-ink">{t("flow.atLocation", { name: loc.name || loc.code })}</p>
            {before === null ? null : (
              <p className="break-words text-sm font-semibold text-ink-muted" data-testid="counted-before">
                {t("flow.countedBefore", { n: before })}
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
          <QtyStepper label={t("flow.qtyLabel")} scan={{ label: t("flow.scanMore"), onClick: scanPrimary.press }} value={qty} min={0} max={null} onChange={(n) => setQty(n)} />
          <CompoundLine slug={slug} itemId={item.id} baseQty={qty} />
          {error === null ? null : <CountErrorNotice error={error.info} context={error.ctx} />}
        </FlowShell>
        {alertView}
      </>,
    );
  }

  const inItem = stage === "item" && loc !== null;
  return withOverlay(
    <>
      <FlowShell
        hue="teal"
        icon={icon}
        step={inItem ? 2 : 1}
        total={TOTAL_STEPS}
        title={t(inItem ? "flow.itemTitle" : "flow.locTitle")}
        instruction={t(inItem ? "flow.itemInstruction" : "flow.locInstruction")}
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
            <p className="break-words text-xl font-bold text-ink">{t("flow.atLocation", { name: loc.name || loc.code })}</p>
            {saved === null ? null : (
              <p className="flex items-center gap-2 break-words text-base font-semibold text-success-ink" role="status" data-testid="count-saved">
                <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-success" />
                {t("flow.saved", { name: saved.name, qty: saved.qty })}
              </p>
            )}
          </section>
        ) : (
          <p className="rounded-card border-2 border-border bg-surface p-3 text-lg font-bold text-ink" data-testid="count-progress">
            {t("flow.progress", { done: doneLocs, total: lockedLocs.length })}
          </p>
        )}
        <ScanPanel service={scanner} prompt={busy ? t("flow.checking") : t(inItem ? "flow.itemPrompt" : "flow.locPrompt")} last={last} {...(lastName === undefined ? {} : { lastName })} ready={scanPrimary.ready && last === ""} hue="teal" />
        {inItem ? (
          <SecondaryButton onClick={() => setStage("none")}>{t("flow.noneButton")}</SecondaryButton>
        ) : null}
        {error === null ? null : <CountErrorNotice error={error.info} context={error.ctx} />}
      </FlowShell>
      {alertView}
    </>,
  );
}
