"use client";
// "Yanlış bir şey yaptım" (T-333): seçilen belge → tamamı ya da satır/miktar → gerekçe → onay. Ekran başına tek soru ve tek birincil düğme.
// Stok yalnız `reverseDocument` komutuyla (sunucu eylemi) değişir; kalan miktar, bağımlı işlem ve yetki kuralları domain'dedir. Bu dosya yalnızca
// girdi toplar (istemci denetimi yalnız kullanıcıya erken geri bildirimdir) ve sunucu hatasını kullanıcı diliyle gösterir.
// Anahtar yaşam döngüsü T-229 deseni: red sonrası içerik değişmedikçe aynı anahtar, başarıda yeni anahtar.
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Banner, Undo2 } from "@wms/ui";
import { submitWithKey, useKeyHolder, type ErrorInfo } from "../../receipts/receipt-form.tsx";
import { FlowShell, PrimaryButton, PrimaryLink, SecondaryButton } from "../receive/receive-flow.tsx";
import { reverseDocumentAction } from "./actions.ts";

export interface UndoLineView {
  readonly lineId: string;
  readonly lineNo: number;
  readonly itemCode: string;
  readonly itemName: string;
  readonly baseUnitCode: string;
  readonly remaining: string;
}
export interface UndoDocView {
  readonly documentId: string;
  readonly number: string;
  readonly lines: readonly UndoLineView[];
}

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const FIELD = `min-h-12 w-full min-w-0 rounded-control border-2 border-border-strong bg-surface px-3 text-lg text-ink ${FOCUS}`;
const QTY_RE = /^\d{1,14}(?:\.\d{1,6})?$/;
const BLOCKED_DETAILS: ReadonlySet<string> = new Set(["STOCK_USED", "STOCK_RESERVED", "SERIAL_IN_USE", "SOURCE_LINKED", "STATUS_CHANGE", "EXCEEDS_REMAINING"]);

/** Ondalık dizgi → 1e-6 ölçekli tam sayı (yalnız istemci denetimi; float yok, I-09). Biçim geçersizse null. */
function micro(s: string): bigint | null {
  const v = s.trim().replace(",", ".");
  if (!QTY_RE.test(v)) return null;
  const [i = "0", f = ""] = v.split(".");
  return BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}
const show = (s: string): string => (/^\d+\.0+$/.test(s) ? (s.split(".")[0] as string) : s.replace(/(\.\d*?)0+$/, "$1"));

function errorKey(e: ErrorInfo): string {
  switch (e.code) {
    case "NETWORK": return "network";
    case "FORBIDDEN": return "forbidden";
    case "NOT_FOUND": return "not_found";
    case "VERSION_CONFLICT": return "version_conflict";
    case "IDEMPOTENCY_MISMATCH": return "idempotency_mismatch";
    case "INSUFFICIENT_STOCK": return "insufficient_stock";
    case "LOCATION_LOCKED": return "location_locked";
    case "REVERSAL_BLOCKED": return e.detail !== undefined && BLOCKED_DETAILS.has(e.detail) ? e.detail : "blocked";
    case "VALIDATION_FAILED":
      if (e.detail === "DOCUMENT_STATE") return "document_state";
      if (e.detail === "QUANTITY_SCALE") return "quantity_scale";
      return "validation_failed";
    case "RATE_LIMITED": return "rate_limited";
    case "UNAUTHENTICATED": return "unauthenticated";
    case "TENANT_SUSPENDED": return "tenant_suspended";
    case "TENANT_CLOSING": return "tenant_closing";
    default: return "internal";
  }
}

type Stage = "how" | "reason" | "done";

export function UndoFlow({ slug, doc }: { slug: string; doc: UndoDocView }) {
  const t = useTranslations("undo");
  const holder = useKeyHolder();
  const listHref = `/t/${encodeURIComponent(slug)}/field/undo`;
  const [stage, setStage] = useState<Stage>("how");
  const [mode, setMode] = useState<"all" | "some">("all");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<"pickAtLeastOne" | "badQuantity" | "reasonRequired" | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [doneNumber, setDoneNumber] = useState<string | null>(null);
  const icon = <Undo2 aria-hidden="true" className="size-6" />;

  const picked = doc.lines.flatMap((l) => (qty[l.lineId]?.trim() ? [{ line: l, raw: (qty[l.lineId] as string).trim().replace(",", ".") }] : []));
  function validateHow(): boolean {
    if (mode === "all") return true;
    if (picked.length === 0) return setProblem("pickAtLeastOne"), false;
    for (const p of picked) {
      const m = micro(p.raw);
      const rest = micro(p.line.remaining) ?? 0n;
      if (m === null || m <= 0n || m > rest) return setProblem("badQuantity"), false;
    }
    return true;
  }
  function changed(): void {
    holder.contentChanged();
    setProblem(null);
    setError(null);
  }

  async function confirm(): Promise<void> {
    if (busy) return;
    if (reason.trim() === "") return setProblem("reasonRequired");
    setBusy(true);
    setError(null);
    const out = await submitWithKey(holder, (clientKey) =>
      reverseDocumentAction({
        slug,
        clientKey,
        documentId: doc.documentId,
        lines: mode === "all" ? "ALL" : picked.map((p) => ({ lineId: p.line.lineId, quantity: p.raw })),
        reason: reason.trim(),
      }),
    );
    setBusy(false);
    if (!out.ok) return setError(out.error);
    setDoneNumber(out.data.reversalNumber ?? doc.number);
    setStage("done");
  }

  if (stage === "done") {
    return (
      <FlowShell hue="teal" icon={icon} title={t("doneTitle")} footer={<PrimaryLink href={listHref}>{t("toList")}</PrimaryLink>}>
        <p className="break-words text-lg text-ink" data-testid="undo-done">
          {t("doneBody", { number: doneNumber ?? doc.number })}
        </p>
      </FlowShell>
    );
  }

  const errorView =
    error === null ? null : (
      <Banner kind="error">
        <p className="font-semibold" data-testid="undo-error">
          {t(`errors.${errorKey(error)}.msg`)}
        </p>
        <p>{t(`errors.${errorKey(error)}.action`)}</p>
        <details className="mt-1 text-sm">
          <summary className="flex min-h-12 cursor-pointer items-center">{t("detail")}</summary>
          <p>{t("errorCode", { code: error.detail === undefined ? error.code : `${error.code}/${error.detail}` })}</p>
          {error.requestId === undefined ? null : <p className="break-all">{error.requestId}</p>}
        </details>
      </Banner>
    );
  const problemView = problem === null ? null : (
    <Banner kind="error">
      <p data-testid="undo-problem">{t(problem)}</p>
    </Banner>
  );

  if (stage === "reason") {
    const count = mode === "all" ? doc.lines.length : picked.length;
    return (
      <FlowShell
        hue="teal"
        icon={icon}
        step={2}
        total={2}
        title={t("reasonTitle")}
        instruction={t("reasonInstruction")}
        onBack={() => setStage("how")}
        footer={
          <PrimaryButton loading={busy} onClick={() => void confirm()}>
            {t("confirm")}
          </PrimaryButton>
        }
      >
        <p className="break-words text-base font-semibold text-ink" data-testid="undo-summary">
          {mode === "all" ? t("summaryAll", { number: doc.number }) : t("summarySome", { count, number: doc.number })}
        </p>
        <label className="flex min-w-0 flex-col gap-1 text-base font-bold text-ink">
          {t("reasonLabel")}
          <textarea
            data-testid="undo-reason"
            className={`${FIELD} min-h-24 py-2 font-normal`}
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              changed();
            }}
          />
        </label>
        {problemView}
        {errorView}
      </FlowShell>
    );
  }

  return (
    <FlowShell
      hue="teal"
      icon={icon}
      step={1}
      total={2}
      title={t("howTitle")}
      instruction={t("howInstruction")}
      backHref={listHref}
      footer={
        <PrimaryButton
          onClick={() => {
            if (validateHow()) {
              setProblem(null);
              setStage("reason");
            }
          }}
        >
          {t("next")}
        </PrimaryButton>
      }
    >
      <p className="break-words text-xl font-bold text-ink">{doc.number}</p>
      <div className="flex min-w-0 gap-2">
        <SecondaryButton pressed={mode === "all"} tone="teal" onClick={() => { setMode("all"); changed(); }}>
          {t("modeAll")}
        </SecondaryButton>
        <SecondaryButton pressed={mode === "some"} tone="teal" onClick={() => { setMode("some"); changed(); }}>
          {t("modeSome")}
        </SecondaryButton>
      </div>
      {mode === "all" ? (
        <p className="break-words text-base text-ink-muted">{t("allNote")}</p>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="undo-lines">
          {doc.lines.map((l) => {
            const none = (micro(l.remaining) ?? 0n) === 0n;
            return (
              <li key={l.lineId} className="flex min-w-0 flex-col gap-1 rounded-card border-2 border-border bg-surface p-3">
                <span className="break-words text-base font-bold text-ink">{l.itemName}</span>
                <span className="break-words text-sm text-ink-muted">
                  {l.itemCode} · {t("lineRemaining", { remaining: show(l.remaining), unit: l.baseUnitCode })}
                </span>
                {none ? null : (
                  <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-ink">
                    {t("qtyLabel", { unit: l.baseUnitCode })}
                    <input
                      data-testid="undo-qty"
                      inputMode="decimal"
                      autoComplete="off"
                      className={FIELD}
                      value={qty[l.lineId] ?? ""}
                      onChange={(e) => {
                        setQty({ ...qty, [l.lineId]: e.target.value });
                        changed();
                      }}
                    />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {mode === "some" ? <p className="break-words text-sm text-ink-muted">{t("qtyHelp")}</p> : null}
      {problemView}
    </FlowShell>
  );
}
