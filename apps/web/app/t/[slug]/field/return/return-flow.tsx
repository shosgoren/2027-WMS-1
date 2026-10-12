"use client";
// Saha müşteri iadesi (T-315): satır seç → ürünü okut + miktar → kabul rafı → neden → "İadeyi kaydet". Ekran başına tek soru ve tek sabit birincil düğme.
// İade üst sınırı (`RETURN_EXCEEDS_SHIPPED`), yalnız kabul rafına girme, karantina ve sayım kilidi (`LOCATION_LOCKED`) T-308 `createCustomerReturn` komutundadır; bu dosya
// yalnızca girdi toplar (istemci denetimi erken geri bildirimdir) ve sunucu hatasını kod + sonraki eylemle gösterir. Çift gönderim: düğme gönderimde kilitlenir; anahtar
// yaşam döngüsü T-229 deseni (`useKeyHolder` / `submitWithKey`). Hata eşlemesi ve miktar yardımcıları `ship-flow.tsx` ile ortaktır.
import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner, CircleCheck, Undo2 } from "@wms/ui";
import { scanMismatch, submitWithKey, useKeyHolder, type ErrorInfo } from "../../receipts/receipt-form.tsx";
import { resolveItemScanAction } from "../../receipts/actions.ts";
import { createCustomerReturnAction, returnLocationAction } from "../../orders/shipping-actions.ts";
import { FlowShell, PrimaryButton, PrimaryLink, ScanPanel, SecondaryButton, useScanPrimary, useScanner, useStateRef, type ScanVerdict } from "../receive/receive-flow.tsx";
import { FIELD_CLS, ShippingErrorNotice, micro, qtyProblem, show } from "../ship/ship-flow.tsx";

export interface ReturnLineView {
  readonly id: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitCode: string;
  /** İade edilebilir miktar = sevk − önceki iadeler (ondalık dizgi; yalnızca gösterim ve erken denetim). */
  readonly returnable: string;
}
export interface ReturnOrderView {
  readonly id: string;
  readonly number: string;
  readonly lines: readonly ReturnLineView[];
}
interface Place {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
type Stage = "line" | "scan" | "place" | "reason" | "done";

/** Okutulan raf eşleşmeleri → kabul rafı adayları (yalnız ETKİN `RECEIVING`). Boş küme için neden: raf yok mu, kabul alanı değil mi (kural domain'dedir, bu yalnız geri bildirim). */
export function placeCandidates(matches: readonly { id: string; code: string; name: string; kind: string; status: string }[]): { candidates: Place[]; reason: "placeNotReceiving" | null } {
  const ok = matches.filter((m) => m.kind === "RECEIVING" && m.status === "ACTIVE").map((m) => ({ id: m.id, code: m.code, name: m.name }));
  return { candidates: ok, reason: ok.length === 0 ? "placeNotReceiving" : null };
}

export function ReturnFlow({ slug, order }: { slug: string; order: ReturnOrderView }) {
  const t = useTranslations("returns");
  const holder = useKeyHolder();
  const listHref = `/t/${encodeURIComponent(slug)}/field/return`;
  const icon = <Undo2 aria-hidden="true" className="size-6" />;
  const [stage, setStage, stageRef] = useStateRef<Stage>("line");
  const [line, setLine, lineRef] = useStateRef<ReturnLineView | null>(null);
  const [verified, setVerified] = useState(false);
  const [qty, setQty] = useState("");
  const [place, setPlace] = useState<Place | null>(null);
  const [choices, setChoices] = useState<readonly Place[]>([]);
  const [reason, setReason] = useState("");
  const [last, setLast] = useState("");
  const [lastName, setLastName] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<"scanMismatch" | "scanFailed" | "badQuantity" | "notVerified" | "placeNotReceiving" | "placeUnknown" | "placeMissing" | "reasonRequired" | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const blocked = useCallback(() => busyRef.current || (stageRef.current !== "scan" && stageRef.current !== "place"), [stageRef]);

  function changed(): void {
    holder.contentChanged();
    setProblem(null);
    setError(null);
  }

  const onScanned = useCallback(
    async (code: string): Promise<ScanVerdict> => {
      if (blocked()) return "refused";
      busyRef.current = true;
      setBusy(true);
      setLast(code);
      setLastName(undefined);
      setProblem(null);
      setError(null);
      try {
        if (stageRef.current === "scan") {
          const res = await resolveItemScanAction({ slug, code });
          if (!res.ok) {
            setError(res.error);
            return "refused";
          }
          const chosen = lineRef.current;
          if (chosen === null || scanMismatch(res.data.itemId, [chosen.itemId])) {
            setProblem("scanMismatch");
            return "refused";
          }
          holder.contentChanged();
          setLastName(res.data.itemName);
          setVerified(true);
          setQty((q) => (q === "" ? "1" : q));
          return "taken";
        }
        const res = await returnLocationAction({ slug, code });
        if (!res.ok) {
          if (res.error.code === "NOT_FOUND") setProblem("placeUnknown");
          else setError(res.error);
          return "refused";
        }
        const { candidates, reason: why } = placeCandidates(res.data.matches);
        if (why !== null) {
          setProblem(why);
          return "refused";
        }
        holder.contentChanged();
        setLastName(candidates[0]?.name);
        if (candidates.length === 1) {
          setPlace(candidates[0] ?? null);
          setChoices([]);
        } else {
          setPlace(null);
          setChoices(candidates);
        }
        return "taken";
      } catch {
        setProblem("scanFailed");
        return "refused";
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [slug, holder, blocked, stageRef, lineRef],
  );
  const scanning = stage === "scan" || stage === "place";
  const { service: scanner, camera } = useScanner((v) => onScanned(v), scanning, blocked);
  const scanPrimary = useScanPrimary(camera, { busy, name: lastName, code: last, alerting: false });

  function go(next: Stage): void {
    setProblem(null);
    setError(null);
    setLast("");
    setLastName(undefined);
    setStage(next);
  }

  async function confirm(): Promise<void> {
    if (busyRef.current || line === null || place === null) return;
    if (reason.trim() === "") return setProblem("reasonRequired");
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const quantity = qty.trim().replace(",", ".");
    const out = await submitWithKey(holder, (clientKey) =>
      createCustomerReturnAction({ slug, clientKey, orderLineId: line.id, quantity, locationId: place.id, reason: reason.trim() }),
    );
    busyRef.current = false;
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setStage("done");
  }

  const problemView = problem === null ? null : (
    <Banner kind="error">
      <p data-testid="return-problem">{t(problem)}</p>
    </Banner>
  );
  const errorView = error === null ? null : <ShippingErrorNotice error={error} />;
  const scanBlock = (promptKey: string) => (
    <>
      <ScanPanel service={scanner} prompt={busy ? t("checking") : t(promptKey)} last={last} {...(lastName === undefined ? {} : { lastName })} ready={scanPrimary.ready && last === ""} hue="teal" />
      <SecondaryButton onClick={scanPrimary.press}>{t("camera")}</SecondaryButton>
    </>
  );

  if (stage === "done") {
    return (
      <FlowShell hue="teal" icon={icon} title={t("doneTitle")} footer={<PrimaryLink href={listHref}>{t("toList")}</PrimaryLink>}>
        <p className="flex items-start gap-2 break-words text-lg text-ink" data-testid="return-done">
          <CircleCheck aria-hidden="true" className="mt-1 size-6 shrink-0 text-success" />
          {t("doneBody")}
        </p>
      </FlowShell>
    );
  }

  if (stage === "line" || line === null) {
    return (
      <FlowShell hue="teal" icon={icon} step={1} total={4} title={t("lineTitle", { number: order.number })} instruction={t("lineInstruction")} backHref={listHref} footer={<PrimaryLink href={listHref}>{t("toList")}</PrimaryLink>}>
        <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="return-lines">
          {order.lines.map((l) => (
            <li key={l.id} className="flex min-w-0">
              <button
                type="button"
                data-testid="return-line"
                onClick={() => {
                  setLine(l);
                  setVerified(false);
                  setQty("");
                  setPlace(null);
                  setChoices([]);
                  holder.contentChanged();
                  go("scan");
                }}
                className="flex min-h-16 w-full min-w-0 flex-col justify-center gap-1 rounded-card border-2 border-border bg-surface p-3 text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <span className="break-words text-lg font-bold text-ink">{l.itemName}</span>
                <span className="break-words text-sm text-ink-muted">
                  {l.itemCode} · {t("returnable", { qty: show(l.returnable), unit: l.unitCode })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </FlowShell>
    );
  }

  if (stage === "scan") {
    return (
      <>
        <FlowShell
          hue="teal"
          icon={icon}
          step={2}
          total={4}
          title={t("scanTitle")}
          instruction={t("scanInstruction", { item: line.itemName })}
          onBack={() => go("line")}
          footer={
            <PrimaryButton
              onClick={() => {
                if (!verified) return setProblem("notVerified");
                const bad = qtyProblem(qty.trim().replace(",", "."), line.returnable);
                if (bad !== null || (micro(qty) ?? 0n) <= 0n) return setProblem("badQuantity");
                go("place");
              }}
            >
              {t("next")}
            </PrimaryButton>
          }
        >
          {scanBlock("scanPrompt")}
          {verified ? (
            <>
              <p className="flex items-center gap-1 break-words text-base font-semibold text-success-ink" data-testid="return-verified">
                <CircleCheck aria-hidden="true" className="size-5 shrink-0" />
                {t("verified", { name: line.itemName })}
              </p>
              <label className="flex min-w-0 flex-col gap-1 text-base font-bold text-ink">
                {t("qtyLabel", { unit: line.unitCode })}
                <input
                  data-testid="return-qty"
                  inputMode="decimal"
                  autoComplete="off"
                  className={FIELD_CLS}
                  value={qty}
                  onChange={(e) => {
                    setQty(e.target.value);
                    changed();
                  }}
                />
                <span className="text-sm font-normal text-ink-muted">{t("returnable", { qty: show(line.returnable), unit: line.unitCode })}</span>
              </label>
            </>
          ) : null}
          {problemView}
          {errorView}
        </FlowShell>
        {scanPrimary.overlay}
      </>
    );
  }

  if (stage === "place") {
    return (
      <>
        <FlowShell
          hue="teal"
          icon={icon}
          step={3}
          total={4}
          title={t("placeTitle")}
          instruction={t("placeInstruction")}
          onBack={() => go("scan")}
          footer={
            <PrimaryButton
              onClick={() => {
                if (place === null) return setProblem("placeMissing");
                go("reason");
              }}
            >
              {t("next")}
            </PrimaryButton>
          }
        >
          {scanBlock("placePrompt")}
          {place === null ? null : (
            <p className="flex items-center gap-1 break-words text-base font-semibold text-success-ink" data-testid="return-place">
              <CircleCheck aria-hidden="true" className="size-5 shrink-0" />
              {t("placeChosen", { name: place.name || place.code })}
            </p>
          )}
          {choices.length === 0 ? null : (
            <div className="flex min-w-0 flex-col gap-2" data-testid="return-place-choices">
              <p className="break-words text-base text-ink">{t("placePick")}</p>
              {choices.map((c) => (
                <SecondaryButton
                  key={c.id}
                  onClick={() => {
                    setPlace(c);
                    setChoices([]);
                    changed();
                  }}
                >
                  {c.name || c.code}
                </SecondaryButton>
              ))}
            </div>
          )}
          {problemView}
          {errorView}
        </FlowShell>
        {scanPrimary.overlay}
      </>
    );
  }

  return (
    <FlowShell
      hue="teal"
      icon={icon}
      step={4}
      total={4}
      title={t("reasonTitle")}
      instruction={t("reasonInstruction")}
      onBack={() => go("place")}
      footer={
        <PrimaryButton loading={busy} onClick={() => void confirm()}>
          {t("confirm")}
        </PrimaryButton>
      }
    >
      <p className="break-words text-base font-semibold text-ink" data-testid="return-summary">
        {t("summary", { qty: show(qty.trim().replace(",", ".")), unit: line.unitCode, item: line.itemName, place: place?.name || place?.code || "" })}
      </p>
      <label className="flex min-w-0 flex-col gap-1 text-base font-bold text-ink">
        {t("reasonLabel")}
        <textarea
          data-testid="return-reason"
          className={`${FIELD_CLS} min-h-24 py-2 font-normal`}
          maxLength={500}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            changed();
          }}
        />
      </label>
      <p className="break-words text-sm text-ink-muted" data-testid="return-privacy">
        {t("privacy")}
      </p>
      {problemView}
      {errorView}
    </FlowShell>
  );
}
