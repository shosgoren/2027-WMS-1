"use client";
// Saha sevk (T-315): sipariş seçilmiş → satır ürünleri okutularak doğrulanır → satır başına sevk miktarı (varsayılan = SEVK'teki toplanmış miktar) → "Sevk et".
// Ekranda tek birincil eylem (sabit "Sevk et"); kamera ikincil. Sevke uygunluk, kısmi sevk ve çift sevk kuralları T-308 `shipOrder` komutundadır: bu dosya yalnızca girdi
// toplar (istemci denetimi erken geri bildirimdir), sunucu hatasını kod + sonraki eylemle gösterir. Çift gönderim: düğme gönderimde kilitlenir; anahtar yaşam döngüsü
// T-229 deseni (`useKeyHolder` / `submitWithKey`): ağ/geçici hatada AYNI anahtar, red sonrası içerik değişmedikçe aynı anahtar, başarıda yeni anahtar.
// Bu dosyanın saf yardımcıları (`micro`, `show`, `qtyProblem`, `remainingOf`, `shippingErrorKey`) iade ekranı ve birim testiyle paylaşılır.
import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner, CircleCheck, Truck } from "@wms/ui";
import { scanMismatch, submitWithKey, useKeyHolder, type ErrorInfo } from "../../receipts/receipt-form.tsx";
import { resolveItemScanAction } from "../../receipts/actions.ts";
import { shipOrderAction } from "../../orders/shipping-actions.ts";
import { FlowShell, PrimaryButton, PrimaryLink, ScanPanel, SecondaryButton, useScanPrimary, useScanner, useStateRef, type ScanVerdict } from "../receive/receive-flow.tsx";

export interface ShipLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitCode: string;
  /** SEVK alanında toplanmış (rezerve) miktar, ondalık dizgi. */
  readonly picked: string;
}
export interface ShipOrderView {
  readonly id: string;
  readonly number: string;
  readonly lines: readonly ShipLineView[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Saf yardımcılar (float yok, I-09)
// ---------------------------------------------------------------------------------------------------------------------
const QTY_RE = /^\d{1,14}(?:\.\d{1,6})?$/;

/** Ondalık dizgi → 1e-6 ölçekli tam sayı; biçim geçersizse null. Virgül ondalık ayırıcı kabul edilir. */
export function micro(s: string): bigint | null {
  const v = s.trim().replace(",", ".");
  if (!QTY_RE.test(v)) return null;
  const [i = "0", f = ""] = v.split(".");
  return BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}
/** `1e-6` ölçekli tam sayı → en kısa ondalık dizgi. */
export function fromMicro(m: bigint): string {
  const i = m / 1_000_000n;
  const f = (m % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f === "" ? i.toString() : `${i}.${f}`;
}
/** Gösterim: sondaki sıfırlar atılır (`"6.000000"` → `"6"`). */
export const show = (s: string): string => {
  const m = micro(s);
  return m === null ? s : fromMicro(m);
};
/** Miktar girdisi `0 < q ≤ max` mi? Boş/biçim hatası `bad`, üst sınır aşımı `over`; sıfır geçerlidir (satır sevk edilmez) ve `null` döner. */
export function qtyProblem(raw: string, max: string): "bad" | "over" | null {
  const q = micro(raw);
  const cap = micro(max);
  if (q === null || cap === null) return "bad";
  return q > cap ? "over" : null;
}
/** Sevk sonrası SEVK'te kalan miktar (negatif olmaz); 0 ise `null`. */
export function remainingOf(picked: string, qty: string): string | null {
  const p = micro(picked);
  const q = micro(qty);
  if (p === null || q === null || q >= p) return null;
  return fromMicro(p - q);
}

/**
 * Sunucu hatası → ileti anahtarı (`shipping.errors.<anahtar>` + `Action`). Kural yeniden yazılmaz, yalnızca ileti seçilir.
 * `INSUFFICIENT_STOCK` sevkte "sevk edilecek toplanmış miktar yok"tur (AC-10: ikinci sevk denemesi aynı kodla reddedilir).
 */
export function shippingErrorKey(error: Pick<ErrorInfo, "code" | "detail">): string {
  const { code, detail } = error;
  switch (code) {
    case "NETWORK":
      return "network";
    case "FORBIDDEN":
      return detail === "WAREHOUSE_OUT_OF_SCOPE" ? "forbidden_scope" : "forbidden";
    case "LOCATION_LOCKED":
      return "location_locked";
    case "INSUFFICIENT_STOCK":
      return "insufficient_stock";
    case "TRACKING_VIOLATION":
      return "tracking_violation";
    case "VERSION_CONFLICT":
      return "version_conflict";
    case "IDEMPOTENCY_MISMATCH":
      return "idempotency_mismatch";
    case "NOT_FOUND":
      return "not_found";
    case "UNAUTHENTICATED":
      return "unauthenticated";
    case "RATE_LIMITED":
      return "rate_limited";
    case "TENANT_SUSPENDED":
      return "tenant_suspended";
    case "TENANT_CLOSING":
      return "tenant_closing";
    case "VALIDATION_FAILED":
      if (detail === "RETURN_EXCEEDS_SHIPPED") return "return_exceeds_shipped";
      if (detail === "BARCODE_AMBIGUOUS") return "barcode_ambiguous";
      if (detail === "DOCUMENT_STATE") return "document_state";
      if (detail === "QUANTITY_SCALE") return "quantity_scale";
      return "validation_failed";
    default:
      return "internal";
  }
}

/** Sunucu hatası bildirimi: neden + sonraki eylem; kod ve istek kimliği "Ayrıntı" altında. */
export function ShippingErrorNotice({ error }: { error: ErrorInfo }) {
  const t = useTranslations("shipping");
  const key = shippingErrorKey(error);
  return (
    <Banner kind="error">
      <p className="font-semibold" data-testid="ship-error">
        {t(`errors.${key}`)}
      </p>
      <p>{t(`errors.${key}Action`)}</p>
      <details className="mt-1 text-sm">
        <summary className="flex min-h-12 cursor-pointer items-center">{t("detail")}</summary>
        <p data-testid="error-code">{t("errorCode", { code: error.detail === undefined ? error.code : `${error.code}/${error.detail}` })}</p>
        {error.requestId === undefined ? null : <p className="break-all">{error.requestId}</p>}
      </details>
    </Banner>
  );
}

export const FIELD_CLS =
  "min-h-12 w-full min-w-0 rounded-control border-2 border-border-strong bg-surface px-3 text-lg text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

// ---------------------------------------------------------------------------------------------------------------------
// Akış
// ---------------------------------------------------------------------------------------------------------------------
export function ShipFlow({ slug, order }: { slug: string; order: ShipOrderView }) {
  const t = useTranslations("shipping");
  const holder = useKeyHolder();
  const listHref = `/t/${encodeURIComponent(slug)}/field/ship`;
  const icon = <Truck aria-hidden="true" className="size-6" />;
  const [verified, setVerified, verifiedRef] = useStateRef<readonly string[]>([]);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(order.lines.map((l) => [l.id, show(l.picked)])));
  const [last, setLast] = useState("");
  const [lastName, setLastName] = useState<string | undefined>(undefined);
  const [scanProblem, setScanProblem] = useState<"notInOrder" | "alreadyVerified" | "scanFailed" | null>(null);
  const [problem, setProblem] = useState<"nothingVerified" | "badQuantity" | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ shippedLines: number; leftovers: { id: string; name: string; unit: string; qty: string }[] } | null>(null);
  const busyRef = useRef(false);
  const blocked = useCallback(() => busyRef.current, []);

  const onScanned = useCallback(
    async (code: string): Promise<ScanVerdict> => {
      if (busyRef.current) return "refused";
      busyRef.current = true;
      setBusy(true);
      setLast(code);
      setLastName(undefined);
      setScanProblem(null);
      setError(null);
      try {
        const res = await resolveItemScanAction({ slug, code });
        if (!res.ok) {
          setError(res.error);
          return "refused";
        }
        if (scanMismatch(res.data.itemId, order.lines.map((l) => l.itemId))) {
          setScanProblem("notInOrder");
          return "refused";
        }
        const target = order.lines.find((l) => l.itemId === res.data.itemId && !verifiedRef.current.includes(l.id));
        if (target === undefined) {
          setScanProblem("alreadyVerified");
          return "refused";
        }
        holder.contentChanged();
        setLastName(res.data.itemName);
        setVerified([...verifiedRef.current, target.id]);
        setProblem(null);
        return "taken";
      } catch {
        setScanProblem("scanFailed");
        return "refused";
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [slug, order.lines, holder, setVerified, verifiedRef],
  );
  const { service: scanner, camera } = useScanner((v) => onScanned(v), done === null, blocked);
  const scanPrimary = useScanPrimary(camera, { busy, name: lastName, code: last, alerting: false });

  const chosen = order.lines.filter((l) => verified.includes(l.id));
  async function confirm(): Promise<void> {
    if (busyRef.current) return;
    if (chosen.length === 0) return setProblem("nothingVerified");
    const lines: { orderLineId: string; quantity: string }[] = [];
    for (const l of chosen) {
      const raw = (qty[l.id] ?? "").trim().replace(",", ".");
      if (qtyProblem(raw, l.picked) !== null) return setProblem("badQuantity");
      if ((micro(raw) ?? 0n) > 0n) lines.push({ orderLineId: l.id, quantity: raw });
    }
    if (lines.length === 0) return setProblem("badQuantity");
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    setError(null);
    const out = await submitWithKey(holder, (clientKey) => shipOrderAction({ slug, clientKey, orderId: order.id, lines }));
    busyRef.current = false;
    setBusy(false);
    if (!out.ok) return setError(out.error);
    // Kalan SEVK'te bekleyen miktar: toplanmış − sevk edilen (sevk edilmeyen/okutulmayan satırlar dahil).
    const leftovers = order.lines.flatMap((l) => {
      const sent = lines.find((x) => x.orderLineId === l.id)?.quantity ?? "0";
      const left = remainingOf(l.picked, sent);
      return left === null ? [] : [{ id: l.id, name: l.itemName, unit: l.unitCode, qty: left }];
    });
    setDone({ shippedLines: lines.length, leftovers });
  }

  if (done !== null) {
    return (
      <FlowShell hue="teal" icon={icon} title={t("doneTitle")} footer={<PrimaryLink href={listHref}>{t("toList")}</PrimaryLink>}>
        <p className="break-words text-lg text-ink" data-testid="ship-done">
          {t("doneBody", { number: order.number, count: done.shippedLines })}
        </p>
        <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0" data-testid="ship-leftovers">
          {done.leftovers.map((x) => (
            <li key={x.id} className="break-words text-base font-semibold text-ink">
              {x.name}: {t("remaining", { qty: x.qty, unit: x.unit })}
            </li>
          ))}
        </ul>
      </FlowShell>
    );
  }

  const problemKey = scanProblem ?? problem;
  return (
    <>
      <FlowShell
        hue="teal"
        icon={icon}
        title={t("flowTitle", { number: order.number })}
        instruction={t("flowInstruction")}
        backHref={listHref}
        footer={
          <PrimaryButton loading={busy} onClick={() => void confirm()}>
            {t("confirm")}
          </PrimaryButton>
        }
      >
        {problemKey === null ? null : (
          <Banner kind="error">
            <p data-testid="ship-problem">{t(problemKey)}</p>
          </Banner>
        )}
        {error === null ? null : <ShippingErrorNotice error={error} />}
        <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="ship-lines">
          {order.lines.map((l) => {
            const ok = verified.includes(l.id);
            const raw = qty[l.id] ?? "";
            const left = ok ? remainingOf(l.picked, raw.replace(",", ".")) : null;
            return (
              <li key={l.id} className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3" data-testid="ship-line" data-verified={ok ? "true" : "false"}>
                <span className="break-words text-base font-bold text-ink">{l.itemName}</span>
                <span className="break-words text-sm text-ink-muted">
                  {l.itemCode} · {t("linePicked", { qty: show(l.picked), unit: l.unitCode })}
                </span>
                <span className={`flex items-center gap-1 text-sm font-semibold ${ok ? "text-success-ink" : "text-ink-muted"}`}>
                  {ok ? <CircleCheck aria-hidden="true" className="size-4" /> : null}
                  {ok ? t("lineVerified") : t("lineToScan")}
                </span>
                {ok ? (
                  <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-ink">
                    {t("qtyLabel", { unit: l.unitCode })}
                    <input
                      data-testid="ship-qty"
                      inputMode="decimal"
                      autoComplete="off"
                      className={FIELD_CLS}
                      value={raw}
                      onChange={(e) => {
                        setQty({ ...qty, [l.id]: e.target.value });
                        holder.contentChanged();
                        setProblem(null);
                        setError(null);
                      }}
                    />
                    {left === null ? null : (
                      <span className="break-words text-sm font-semibold text-ink" data-testid="ship-remaining">
                        {t("remaining", { qty: left, unit: l.unitCode })}
                      </span>
                    )}
                  </label>
                ) : null}
              </li>
            );
          })}
        </ul>
        <ScanPanel service={scanner} prompt={busy ? t("checking") : t("scanPrompt")} last={last} {...(lastName === undefined ? {} : { lastName })} ready={scanPrimary.ready && last === ""} hue="teal" />
        <SecondaryButton onClick={scanPrimary.press}>{t("camera")}</SecondaryButton>
        <p className="break-words text-sm text-ink-muted">{t("qtyHelp")}</p>
      </FlowShell>
      {scanPrimary.overlay}
    </>
  );
}
