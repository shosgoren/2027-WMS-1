"use client";
// Saha yerleştirme (T-313): [kaynak (KABUL) →] ürün okut → hedef lokasyon okut → onay → bitti. `PUTAWAY` görevinden (miktar ve ürün görevle birebir:
// poka-yoke, A-305-7) ya da serbest başlar. Yetki, sayım kilidi (`LOCATION_LOCKED`), hedef lokasyon türü ve stok kuralları domain'dedir (`putaway`);
// bu dosya yalnızca girdi toplar ve sunucu hatasını (kod + sonraki eylem) gösterir. Ortak saha parçaları `receive-flow.tsx`'tedir.
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner, CircleCheck, MapPinned } from "@wms/ui";
import { ErrorNotice, errorKeyOf, intOf, scanMismatch, submitWithKey, useKeyHolder, type ErrorInfo } from "../../receipts/receipt-form.tsx";
import { availableAtLocationAction, putawayAction, resolveItemScanAction, resolveLocationScanAction } from "../../receipts/actions.ts";
import { DroppedNotice, FlowShell, PrimaryButton, PrimaryLink, QtyStepper, ScanAlert, ScanPanel, useScanPrimary, useScanner, type AlertState } from "../receive/receive-flow.tsx";

export interface PutawayTask {
  readonly id: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly itemCode: string;
  readonly quantity: string;
  readonly sourceId: string;
  readonly sourceCode: string;
  readonly sourceName: string;
}
type Stage = "source" | "item" | "target" | "confirm" | "done";
interface Loc {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface Item {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

export function PutawayFlow({ slug, warehouseId, task }: { slug: string; warehouseId: string; task: PutawayTask | null }) {
  const t = useTranslations("receiving");
  const holder = useKeyHolder();
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const tasksHref = `${fieldHome}/tasks`;
  const total = task === null ? 5 : 4;
  const first: Stage = task === null ? "source" : "item";
  const [stage, setStage] = useState<Stage>(first);
  const [source, setSource] = useState<Loc | null>(task === null ? null : { id: task.sourceId, code: task.sourceCode, name: task.sourceName });
  const [item, setItem] = useState<Item | null>(task === null ? null : { id: task.itemId, name: task.itemName, code: task.itemCode });
  const [target, setTarget] = useState<Loc | null>(null);
  const [qty, setQty] = useState(intOf(task?.quantity) ?? 1);
  const [avail, setAvail] = useState<number | null>(null);
  const [last, setLast] = useState("");
  const [lastName, setLastName] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<(AlertState & { back?: Stage }) | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [donePair, setDonePair] = useState<{ item: string; qty: number; to: string } | null>(null);

  const stepOf = (s: Stage): number => {
    const order: Stage[] = task === null ? ["source", "item", "target", "confirm", "done"] : ["item", "target", "confirm", "done"];
    return order.indexOf(s) + 1;
  };
  const showAlert = (titleKey: string, reasonKey: string, code: string, back?: Stage): void => setAlert({ titleKey, reasonKey, code, ...(back === undefined ? {} : { back }) });

  const onScanned = useCallback(
    async (code: string) => {
      if (busy || alert !== null) return;
      setLast(code);
      setLastName(undefined);
      setBusy(true);
      setError(null);
      try {
        if (stage === "source" || stage === "target") {
          const res = await resolveLocationScanAction({ slug, warehouseId, code });
          if (!res.ok) {
            showAlert("alert.scanTitle", errorKeyOf(res.error, "scan"), res.error.detail === undefined ? res.error.code : `${res.error.code}/${res.error.detail}`);
            return;
          }
          const loc = { id: res.data.id, code: res.data.code, name: res.data.name };
          holder.contentChanged();
          setLastName(loc.name);
          if (stage === "source") {
            setSource(loc);
            setStage("item");
          } else {
            setTarget(loc);
            setStage("confirm");
          }
        } else if (stage === "item") {
          const res = await resolveItemScanAction({ slug, code });
          if (!res.ok) {
            showAlert("alert.scanTitle", errorKeyOf(res.error, "scan"), res.error.detail === undefined ? res.error.code : `${res.error.code}/${res.error.detail}`);
            return;
          }
          if (task !== null) {
            if (scanMismatch(res.data.itemId, [task.itemId])) {
              showAlert("alert.mismatchTitle", "scan_mismatch", "SCAN_MISMATCH");
              return;
            }
          } else if (source !== null) {
            const a = await availableAtLocationAction({ slug, locationId: source.id, itemId: res.data.itemId });
            if (!a.ok) {
              showAlert("alert.scanTitle", errorKeyOf(a.error, "scan"), a.error.code);
              return;
            }
            const have = intOf(a.data.quantity);
            if (have === 0) {
              showAlert("alert.mismatchTitle", "no_stock_here", "NO_STOCK_HERE");
              return;
            }
            setAvail(have);
            setQty(Math.max(1, Math.min(have ?? Infinity, intOf(res.data.quantity) ?? 1)));
          }
          holder.contentChanged();
          setLastName(res.data.itemName);
          setItem({ id: res.data.itemId, name: res.data.itemName, code: res.data.itemCode });
          setStage("target");
        }
      } catch {
        showAlert("alert.networkTitle", "network", "NETWORK");
      } finally {
        setBusy(false);
      }
    },
    [busy, alert, stage, slug, warehouseId, task, source],
  );
  const scanning = stage === "source" || stage === "item" || stage === "target";
  const { service: scanner, camera, dropped, clearDropped } = useScanner((v) => void onScanned(v), scanning && alert === null && !busy);
  const scanPrimary = useScanPrimary(camera);

  async function confirm() {
    if (busy || source === null || item === null || target === null) return;
    setBusy(true);
    setError(null);
    const out = await submitWithKey(holder, (clientKey) =>
      putawayAction({
        slug,
        clientKey,
        ...(task === null ? {} : { taskId: task.id }),
        sourceLocationId: source.id,
        targetLocationId: target.id,
        itemId: item.id,
        quantity: String(qty),
      }),
    );
    setBusy(false);
    if (!out.ok) {
      const key = errorKeyOf(out.error, "putaway");
      // Engelleyici sonuçlar (sayım kilidi, uygun olmayan raf, stok yok) tam ekran uyarıdır; kullanıcı başka raf okutur.
      if (key === "location_locked" || key === "putaway_invalid" || key === "insufficient_stock") {
        showAlert("alert.putawayTitle", key, out.error.detail === undefined ? out.error.code : `${out.error.code}/${out.error.detail}`, "target");
      } else setError(out.error);
      return;
    }
    setDonePair({ item: item.name, qty, to: target.name || target.code });
    setStage("done");
  }

  const icon = <MapPinned aria-hidden="true" className="size-6" />;
  const closeAlert = (): void => {
    if (alert?.back !== undefined) {
      holder.contentChanged();
      setTarget(null);
      setStage(alert.back);
    }
    setAlert(null);
  };
  const alertView = (
    <>
      <DroppedNotice show={dropped} onClose={clearDropped} />
      {alert === null ? null : (
        <ScanAlert
          title={t(alert.titleKey)}
          reason={t(`errors.${alert.reasonKey}`, { remaining: "-" })}
          action={t(`errors.${alert.reasonKey}Action`)}
          {...(alert.code === undefined ? {} : { code: alert.code })}
          onClose={closeAlert}
        />
      )}
    </>
  );

  const prev: Partial<Record<Stage, Stage>> = task === null ? { item: "source", target: "item", confirm: "target" } : { target: "item", confirm: "target" };
  const back = (): void => {
    const p = prev[stage];
    if (p !== undefined) {
      setError(null);
      setStage(p);
    }
  };
  const backProps = prev[stage] === undefined ? { backHref: task === null ? fieldHome : tasksHref } : { onBack: back };

  if (stage === "done" && donePair !== null) {
    return (
      <>
        <FlowShell
          hue="teal"
          icon={icon}
          step={stepOf("done")}
          total={total}
          title={t("putaway.savedTitle")}
          footer={
            task === null ? (
              <PrimaryButton
                onClick={() => {
                  holder.contentChanged();
                  setItem(null);
                  setTarget(null);
                  setStage("item");
                }}
              >
                {t("flow.nextItem")}
              </PrimaryButton>
            ) : (
              <PrimaryLink href={tasksHref}>{t("putaway.backToTasks")}</PrimaryLink>
            )
          }
        >
          <Banner kind="success">
            <p className="font-semibold" data-testid="saved-summary">
              {t("putaway.saved", { name: donePair.item, qty: donePair.qty, to: donePair.to })}
            </p>
          </Banner>
          <p className="flex items-center gap-2 text-lg font-bold text-ink">
            <CircleCheck aria-hidden="true" className="size-6 text-success" />
            {t("putaway.noNewStock")}
          </p>
        </FlowShell>
        {alertView}
      </>
    );
  }

  if (stage === "confirm" && source !== null && item !== null && target !== null) {
    return (
      <>
        <FlowShell
          hue="teal"
          icon={icon}
          step={stepOf("confirm")}
          total={total}
          title={t("putaway.confirmTitle")}
          instruction={t("putaway.confirmInstruction")}
          {...backProps}
          footer={
            <PrimaryButton loading={busy} onClick={() => void confirm()}>
              {t("putaway.confirm")}
            </PrimaryButton>
          }
        >
          <section className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-3" aria-label={t("flow.verify")}>
            <p className="break-words text-2xl font-extrabold text-ink" data-testid="verified-item">
              {item.name}
            </p>
            <p className="break-words text-base text-ink">
              {t("putaway.fromTo", { from: source.name || source.code, to: target.name || target.code })}
            </p>
          </section>
          {task !== null ? (
            <p className="rounded-card bg-bg p-3 text-lg font-bold text-ink" data-testid="fixed-qty">
              {t("putaway.taskQty", { n: qty })}
            </p>
          ) : (
            <QtyStepper
              label={t("putaway.qtyLabel")}
              value={qty}
              min={1}
              max={avail}
              onChange={(n) => {
                holder.contentChanged();
                setQty(n);
              }}
            />
          )}
          {error === null ? null : <ErrorNotice error={error} context="putaway" />}
        </FlowShell>
        {alertView}
      </>
    );
  }

  const titleKey = stage === "source" ? "putaway.sourceTitle" : stage === "item" ? "putaway.itemTitle" : "putaway.targetTitle";
  return (
    <>
      <FlowShell
        hue="teal"
        icon={icon}
        step={stepOf(stage)}
        total={total}
        title={t(titleKey)}
        {...backProps}
        scanProxy
        footer={<PrimaryButton onClick={scanPrimary.press}>{t("flow.scanNow")}</PrimaryButton>}
      >
        {task !== null && stage === "item" ? (
          <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3" data-testid="task-card">
            <p className="break-words text-xl font-bold text-ink">{task.itemName}</p>
            <p className="break-words text-base text-ink">{t("putaway.taskLine", { qty: intOf(task.quantity) ?? task.quantity, from: task.sourceName || task.sourceCode })}</p>
          </section>
        ) : null}
        {stage === "target" && item !== null ? (
          <section className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3">
            <p className="break-words text-xl font-bold text-ink">{item.name}</p>
            {source === null ? null : <p className="break-words text-base text-ink">{t("putaway.takenFrom", { from: source.name || source.code })}</p>}
          </section>
        ) : null}
        <ScanPanel service={scanner} prompt={busy ? t("flow.checking") : t(stage === "item" ? "putaway.itemPrompt" : stage === "source" ? "putaway.sourcePrompt" : "putaway.targetPrompt")} last={last} {...(lastName === undefined ? {} : { lastName })} ready={scanPrimary.ready && last === ""} hue="teal" />
      </FlowShell>
      {scanPrimary.overlay}
      {alertView}
    </>
  );
}
