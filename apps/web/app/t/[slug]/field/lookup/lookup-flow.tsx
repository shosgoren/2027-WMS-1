"use client";
// Saha stok sorgusu (T-332b): tek okutma alanı → ürün okutunca raf başına stok, raf okutunca rafın içeriği. Salt okuma; tek birincil eylem "Barkodu okut".
// İş kuralı (yetki, depo kapsamı, kullanılabilir hesabı, kör sayım maskesi) domain'dedir (`stockByItem`/`stockByLocation`); bu dosya yalnızca gösterir.
// Sunucu hatası kod + sonraki eylemle gösterilir (ErrorNotice). Ortak saha parçaları `receive-flow.tsx`'tedir.
import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { MapPinned } from "@wms/ui";
import { ErrorNotice, intOf, type ErrorInfo } from "../../receipts/receipt-form.tsx";
import { CompoundLine, FlowShell, PrimaryButton, ScanPanel, useScanPrimary, useScanner } from "../receive/receive-flow.tsx";
import { lookupItemAction, lookupLocationAction, lookupScanAction, type LookupChoice } from "./actions.ts";

// Sonuç tipleri sunucu eylemlerinin dönüşünden türetilir (istemci sunucu paketini içe aktaramaz, T-127b); alanlar domain sorgularıyla aynıdır.
type Ok<P extends Promise<{ ok: boolean }>> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never;
type StockByItemResult = Ok<ReturnType<typeof lookupItemAction>>;
type StockByLocationResult = Ok<ReturnType<typeof lookupLocationAction>>;
type StockByItemRow = StockByItemResult["rows"][number];
type StockByLocationRow = StockByLocationResult["rows"][number];
type StockStatus = StockByItemRow["stockStatus"];
type StockRowCommon = Pick<StockByItemRow, "stockStatus" | "lot" | "serial">;

type View =
  | { readonly kind: "item"; readonly data: StockByItemResult }
  | { readonly kind: "location"; readonly data: StockByLocationResult }
  | { readonly kind: "choices"; readonly choices: readonly LookupChoice[] }
  | { readonly kind: "notFound" };

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** `"12.000000"` → `"12"` (yalnız görüntü; değer metin kalır, I-09). */
const qty = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

function Quantities({ physical, reserved, available, countLocked }: { physical: string | null; reserved: string | null; available: string | null; countLocked: boolean }) {
  const t = useTranslations("stockLookup");
  if (physical === null || reserved === null || available === null) {
    return (
      <p className="break-words text-base font-bold text-warning-ink" data-testid="count-locked">
        {t("countLocked")}
      </p>
    );
  }
  const cell = (label: string, value: string, testid: string) => (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs font-semibold text-ink-muted">{label}</dt>
      <dd className="m-0 break-all text-xl font-extrabold text-ink" data-testid={testid}>
        {qty(value)}
      </dd>
    </div>
  );
  return (
    <dl className="m-0 grid min-w-0 grid-cols-3 gap-2" data-count-locked={countLocked ? "true" : "false"}>
      {cell(t("physical"), physical, "q-physical")}
      {cell(t("reserved"), reserved, "q-reserved")}
      {cell(t("available"), available, "q-available")}
    </dl>
  );
}

function Badges({ row }: { row: StockRowCommon & { pickBlocked?: boolean } }) {
  const t = useTranslations("stockLookup");
  const parts: string[] = [];
  if (row.lot !== null) parts.push(t("lot", { code: row.lot.code }));
  if (row.serial !== null) parts.push(t("serial", { no: row.serial.serialNo }));
  return (
    <>
      {row.stockStatus === "AVAILABLE" ? null : (
        <span data-testid="status-badge" data-status={row.stockStatus} className="inline-flex min-h-6 w-fit items-center rounded-control bg-warning-bg px-2 text-sm font-bold text-warning-ink">
          {t(`status.${row.stockStatus}`)}
        </span>
      )}
      {row.pickBlocked === true ? <span className="text-sm text-ink-muted">{t("pickBlocked")}</span> : null}
      {parts.length === 0 ? null : <p className="m-0 break-words text-sm text-ink-muted">{parts.join(" · ")}</p>}
    </>
  );
}

function Row({ title, code, row }: { title: string; code: string; row: StockByItemRow | StockByLocationRow }) {
  return (
    <li data-testid="stock-row" className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3">
      <p className="m-0 break-words text-lg font-bold text-ink">{title}</p>
      <p className="m-0 break-all text-sm text-ink-muted">{code}</p>
      <Badges row={row} />
      <Quantities physical={row.physical} reserved={row.reserved} available={row.available} countLocked={row.countLocked} />
    </li>
  );
}

const SHOWN_STATUSES: readonly StockStatus[] = ["QUARANTINE", "DAMAGED", "BLOCKED"];

export function LookupFlow({ slug }: { slug: string }) {
  const t = useTranslations("stockLookup");
  const fieldHome = `/t/${encodeURIComponent(slug)}/field`;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState("");
  const [lastName, setLastName] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [moreError, setMoreError] = useState<ErrorInfo | null>(null);

  const blocked = useCallback(() => busyRef.current, []);
  const run = useCallback(async (job: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setMoreError(null);
    try {
      await job();
    } catch {
      setError({ code: "NETWORK" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const showResult = useCallback((v: View): void => {
    setView(v);
    if (v.kind === "item") setLastName(v.data.item.name);
    else if (v.kind === "location") setLastName(v.data.location.name || v.data.location.code);
    else setLastName(undefined);
  }, []);

  const onScanned = useCallback(
    (code: string): void => {
      setLast(code);
      void run(async () => {
        const res = await lookupScanAction({ slug, code });
        if (!res.ok) {
          if (res.error.code === "NOT_FOUND") {
            setLastName(undefined);
            setView({ kind: "notFound" });
          } else setError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
          return;
        }
        showResult(res.data.kind === "choices" ? { kind: "choices", choices: res.data.choices } : res.data.kind === "item" ? { kind: "item", data: res.data.result } : { kind: "location", data: res.data.result });
      });
    },
    [run, showResult, slug],
  );

  const pick = (c: LookupChoice): void => {
    setLast(c.code);
    void run(async () => {
      if (c.type === "item") {
        const res = await lookupItemAction({ slug, itemId: c.id });
        if (!res.ok) return setError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
        showResult({ kind: "item", data: res.data });
      } else {
        const res = await lookupLocationAction({ slug, locationId: c.id });
        if (!res.ok) return setError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
        showResult({ kind: "location", data: res.data });
      }
    });
  };

  const more = (): void => {
    const v = view;
    if (v === null || (v.kind !== "item" && v.kind !== "location") || v.data.nextCursor === null) return;
    const afterKey = v.data.nextCursor;
    void run(async () => {
      if (v.kind === "item") {
        const res = await lookupItemAction({ slug, itemId: v.data.item.id, afterKey });
        if (!res.ok) return setMoreError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
        setView({ kind: "item", data: { ...res.data, rows: [...v.data.rows, ...res.data.rows] } });
      } else {
        const res = await lookupLocationAction({ slug, locationId: v.data.location.id, afterKey });
        if (!res.ok) return setMoreError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
        setView({ kind: "location", data: { ...res.data, rows: [...v.data.rows, ...res.data.rows] } });
      }
    });
  };

  const { service: scanner, camera } = useScanner((v) => onScanned(v), true, blocked);
  const scanPrimary = useScanPrimary(camera, { busy, name: lastName, code: last, alerting: false });
  const icon = <MapPinned aria-hidden="true" className="size-6" />;

  const moreButton = (cursor: string | null) =>
    cursor === null ? null : (
      <>
        {moreError === null ? null : <ErrorNotice error={moreError} context="scan" />}
        <button
          type="button"
          onClick={more}
          disabled={busy}
          data-testid="lookup-more"
          className={`flex min-h-12 w-full min-w-0 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink disabled:opacity-60 ${FOCUS}`}
        >
          {t("more")}
        </button>
      </>
    );

  let body: React.ReactNode = null;
  if (view?.kind === "notFound") {
    body = (
      <section role="status" data-testid="lookup-not-found" className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3">
        <p className="m-0 break-words text-lg font-bold text-ink">{t("notFound")}</p>
        <p className="m-0 break-words text-base text-ink">{t("notFoundAction")}</p>
      </section>
    );
  } else if (view?.kind === "choices") {
    body = (
      <section className="flex min-w-0 flex-col gap-2" data-testid="lookup-choices">
        <p className="m-0 break-words text-base font-bold text-ink">{t("choicesTitle")}</p>
        <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
          {view.choices.map((c) => (
            <li key={`${c.type}-${c.id}`} className="flex min-w-0">
              <button
                type="button"
                onClick={() => pick(c)}
                disabled={busy}
                className={`flex min-h-14 w-full min-w-0 flex-col justify-center rounded-card border-2 border-border bg-surface p-3 text-left disabled:opacity-60 ${FOCUS}`}
              >
                <span className="break-words text-lg font-bold text-ink">{c.name}</span>
                <span className="break-all text-sm text-ink-muted">
                  {t(c.type === "item" ? "kindItem" : "kindLocation")} · {c.code}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  } else if (view?.kind === "item") {
    const d = view.data;
    const whole = intOf(d.totals.physical);
    body = (
      <>
        <section className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-3" aria-label={t("totalTitle")} data-testid="lookup-total">
          <p className="m-0 break-words text-xl font-extrabold text-ink" data-testid="lookup-heading">
            {t("itemResult", { name: d.item.name, code: d.item.code })}
          </p>
          <p className="m-0 text-sm text-ink-muted">{t("unit", { unit: d.item.baseUnit.name || d.item.baseUnit.code })}</p>
          <p className="m-0 text-sm font-bold text-ink-muted">{t("totalTitle")}</p>
          <Quantities physical={d.totals.physical} reserved={d.totals.reserved} available={d.totals.available} countLocked={false} />
          {SHOWN_STATUSES.filter((s) => d.totals.physicalByStatus[s] !== "0.000000" && qty(d.totals.physicalByStatus[s]) !== "0").map((s) => (
            <p key={s} className="m-0 break-words text-base font-semibold text-warning-ink" data-testid={`status-total-${s}`}>
              {t("statusTotal", { status: t(`status.${s}`), qty: qty(d.totals.physicalByStatus[s]) })}
            </p>
          ))}
          {d.totals.countLockedExcluded ? (
            <p className="m-0 break-words text-sm font-semibold text-ink" data-testid="count-locked-excluded">
              {t("countLockedExcluded")}
            </p>
          ) : null}
          {whole === null ? null : <CompoundLine slug={slug} itemId={d.item.id} baseQty={whole} />}
        </section>
        {d.rows.length === 0 ? (
          <p role="status" className="m-0 break-words text-lg text-ink" data-testid="lookup-empty">
            {t("emptyItem", { name: d.item.name })}
          </p>
        ) : (
          <ul aria-label={t("rowsLabel")} className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {d.rows.map((r) => (
              <Row key={r.dimensionId} title={r.locationName || r.locationCode} code={r.locationCode} row={r} />
            ))}
          </ul>
        )}
        {moreButton(d.nextCursor)}
      </>
    );
  } else if (view?.kind === "location") {
    const d = view.data;
    body = (
      <>
        <p className="m-0 break-words text-xl font-extrabold text-ink" data-testid="lookup-heading">
          {t("locationResult", { name: d.location.name || d.location.code, code: d.location.code })}
        </p>
        {d.rows.length === 0 ? (
          <p role="status" className="m-0 break-words text-lg text-ink" data-testid="lookup-empty">
            {t("emptyLocation", { name: d.location.name || d.location.code })}
          </p>
        ) : (
          <ul aria-label={t("rowsLabel")} className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {d.rows.map((r) => (
              <Row key={r.dimensionId} title={r.itemName} code={r.itemCode} row={r} />
            ))}
          </ul>
        )}
        {moreButton(d.nextCursor)}
      </>
    );
  }

  return (
    <>
      <FlowShell hue="teal" icon={icon} title={t("title")} {...(view === null ? { instruction: t("instruction") } : {})} backHref={fieldHome} scanProxy footer={<PrimaryButton onClick={scanPrimary.press}>{t("scanNow")}</PrimaryButton>}>
        <ScanPanel service={scanner} prompt={busy ? t("checking") : t("prompt")} last={last} {...(lastName === undefined ? {} : { lastName })} ready={scanPrimary.ready && last === ""} hue="teal" />
        {error === null ? null : <ErrorNotice error={error} context="scan" />}
        {body}
      </FlowShell>
      {scanPrimary.overlay}
    </>
  );
}
