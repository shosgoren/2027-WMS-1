"use client";
// Sayım gözden geçirme ekranı ve sayım ekranlarının ortak istemci takımı (T-316). Domain kuralı burada YENİDEN YAZILMAZ (G-01): yetki, durum geçişi,
// fark hesabı ve kilit açma sunucudadır; bu dosya yalnızca gösterir, girdi toplar ve sunucu hatasını (kod + sonraki eylem) çevirir.
// - Anahtar yaşam döngüsü (T-277a, kart kararı): her kullanıcı denemesi YENİ anahtar; aynı deneme sürerken (çift gönderim) aynı anahtar.
//   Kalıcı saklanan ret (`VALIDATION_FAILED` vb.) aynı anahtarla tekrar oynatılır, bu yüzden yeniden deneme yeni anahtar ister (MINOR-3).
// - Zincir "Onayla ve fark fişini işle": iki ayrı komut; onay başarılı fiş başarısızsa durum "onaylandı, fiş bekliyor" (APPROVED) ve yalnız fiş yeniden denenir.
// - Referans (sistem) miktarı yalnız bu ekranda ve yalnız `count_diff.approve` olana gelir (sunucu `review` kipi); saha ekranı (`count-flow.tsx`) bunu hiç almaz.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Banner, Button, CircleCheck, Clock, ConfirmDialog, EmptyState, Lock, TriangleAlert, ClipboardCheck } from "@wms/ui";
import type { ActionResult, ErrorInfo, Outcome } from "../../receipts/receipt-form.tsx";
import { approveAndPostCountAction, cancelCountAction, postCountAdjustmentAction } from "../actions.ts";

// İstemci dosyaları sunucu paketlerini (tip olarak bile) içe aktaramaz (AC-28): veri biçimleri yapısal olarak burada tanımlıdır.
export type CountStatus = "COUNTING" | "SUBMITTED" | "APPROVED" | "POSTED" | "CANCELLED";
export interface CountSessionInfo {
  readonly id: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly status: CountStatus;
  readonly blind: boolean;
  readonly locationCount: number;
  readonly startedBy: { readonly name: string | null };
  readonly abandoned: boolean;
}
export interface CountLocationInfo {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly locked: boolean;
}
export interface ReviewLine {
  readonly id: string;
  readonly locationId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
  readonly stockStatus: string;
  readonly reference: string;
  readonly counted: string | null;
  readonly difference: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Anahtar yaşam döngüsü
// ---------------------------------------------------------------------------------------------------------------------
export interface AttemptKey {
  /** Deneme başı: deneme sürüyorsa aynı anahtar (çift gönderim), değilse yeni anahtar. */
  begin(): string;
  /** Deneme bitti (başarı, ret ya da ağ hatası): sonraki deneme yeni anahtar alır. */
  settle(): void;
}
export function createAttemptKey(generate: () => string = () => crypto.randomUUID()): AttemptKey {
  let key: string | null = null;
  return {
    begin: () => {
      if (key === null) key = generate();
      return key;
    },
    settle: () => {
      key = null;
    },
  };
}
export function useAttemptKey(): AttemptKey {
  const ref = useRef<AttemptKey | null>(null);
  if (ref.current === null) ref.current = createAttemptKey();
  return ref.current;
}

/** Tek kullanıcı denemesi: anahtar alınır, çağrı yapılır, deneme biter. Ağ/yürütme hatası `NETWORK` olur (yutulmaz, kullanıcıya gösterilir). */
export async function runAttempt<T>(holder: AttemptKey, call: (clientKey: string) => Promise<ActionResult<T>>): Promise<Outcome<T>> {
  const key = holder.begin();
  try {
    const res = await call(key);
    if (res.ok) return { ok: true, data: res.data };
    return { ok: false, error: { code: res.error.code, detail: res.error.detail, requestId: res.error.requestId } };
  } catch {
    return { ok: false, error: { code: "NETWORK" } };
  } finally {
    holder.settle();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hata eşlemesi (kod + ayrıntı → ileti anahtarı; kural yeniden yazılmaz, yalnızca ileti seçilir)
// ---------------------------------------------------------------------------------------------------------------------
export type CountErrorContext = "start" | "record" | "submit" | "approve" | "post" | "cancel" | "scan" | "read";

export function countErrorKey(error: Pick<ErrorInfo, "code" | "detail">, context: CountErrorContext): string {
  const { code, detail } = error;
  switch (code) {
    case "NETWORK":
      return "network";
    case "FORBIDDEN":
      return detail === "WAREHOUSE_OUT_OF_SCOPE" ? "forbidden_scope" : "forbidden";
    case "LOCATION_LOCKED":
      return context === "start" ? "start_locked" : "location_locked";
    case "INSUFFICIENT_STOCK":
      return "insufficient_stock";
    case "TRACKING_VIOLATION":
      return "tracking_violation";
    case "VERSION_CONFLICT":
      return "version_conflict";
    case "IDEMPOTENCY_MISMATCH":
      return "idempotency_mismatch";
    case "NOT_FOUND":
      return context === "scan" ? "scan_unknown" : "not_found";
    case "UNAUTHENTICATED":
      return "unauthenticated";
    case "RATE_LIMITED":
      return "rate_limited";
    case "TENANT_SUSPENDED":
      return "tenant_suspended";
    case "TENANT_CLOSING":
      return "tenant_closing";
    case "VALIDATION_FAILED":
      if (detail === "DOCUMENT_STATE") return "document_state";
      if (detail === "QUANTITY_SCALE") return "quantity_scale";
      if (detail === "TOO_MANY_LINES" || detail === "DOCUMENT_TOO_LARGE") return "too_large";
      if (detail === "IN_USE") return "item_inactive";
      if (detail === "BARCODE_AMBIGUOUS") return "barcode_ambiguous";
      if (detail === undefined && context === "start") return "start_invalid";
      if (detail === undefined && (context === "submit" || context === "approve")) return "uncounted";
      return "validation_failed";
    default:
      return "internal";
  }
}

/** Durumu sunucudan yeniden okumayı gerektiren hatalar (iş başka biri/başka sekme tarafından ilerlemiş olabilir). */
export const needsRefresh = (error: Pick<ErrorInfo, "code" | "detail">): boolean => (error.code === "VALIDATION_FAILED" && error.detail === "DOCUMENT_STATE") || error.code === "NOT_FOUND";

export function CountErrorNotice({ error, context }: { error: ErrorInfo; context: CountErrorContext }) {
  const t = useTranslations("counting");
  const key = countErrorKey(error, context);
  return (
    <Banner kind="error">
      <p className="font-semibold" data-testid="count-error-reason">
        {t(`errors.${key}`)}
      </p>
      <p data-testid="count-error-action">{t(`errors.${key}Action`)}</p>
      <details className="mt-1 text-sm">
        <summary className="flex min-h-12 cursor-pointer items-center">{t("detail")}</summary>
        <p data-testid="count-error-code">{t("errorCode", { code: error.detail === undefined ? error.code : `${error.code}/${error.detail}` })}</p>
        {error.requestId === undefined ? null : <p className="break-all">{error.requestId}</p>}
      </details>
    </Banner>
  );
}

/** `"3.000000"` → `"3"`, `"-2.500000"` → `"-2.5"`. Yalnız gösterim (saklama ve hesap sunucuda dizgidir; I-09). */
export function plainQty(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d*?))?0*$/.exec(s.trim());
  if (m === null) return s;
  const frac = m[3] ?? "";
  return `${m[1] ?? ""}${m[2] ?? "0"}${frac === "" ? "" : `.${frac}`}`;
}
/** Fark dizgisinin işareti: -1 eksik, 0 aynı, 1 fazla. Yalnız gösterim sınıflandırması (fark sunucuda hesaplanmıştır). */
export function diffSign(d: string): -1 | 0 | 1 {
  const p = plainQty(d);
  if (p === "0" || p === "-0") return 0;
  return p.startsWith("-") ? -1 : 1;
}

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
export const LINK_BTN = `inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink ${FOCUS}`;
/** Durum rozeti: renk tek taşıyıcı değildir (ikon + metin). */
export const STATUS_TONE: Record<CountStatus, string> = {
  COUNTING: "bg-info-bg text-info-ink",
  SUBMITTED: "bg-warning-bg text-warning-ink",
  APPROVED: "bg-warning-bg text-warning-ink",
  POSTED: "bg-success-bg text-success-ink",
  CANCELLED: "bg-danger-bg text-danger-ink",
};
export function StatusBadge({ status }: { status: CountStatus }) {
  const t = useTranslations("counting");
  const Icon = status === "POSTED" ? CircleCheck : status === "CANCELLED" ? TriangleAlert : Clock;
  return (
    <span className={`inline-flex min-h-8 items-center gap-1 rounded-full px-3 text-sm font-bold ${STATUS_TONE[status]}`} data-status={status} data-testid="count-status">
      <Icon aria-hidden="true" className="size-4" />
      {t(`status.${status}`)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Gözden geçirme
// ---------------------------------------------------------------------------------------------------------------------
export interface CountReviewProps {
  readonly slug: string;
  readonly session: CountSessionInfo;
  readonly locations: readonly CountLocationInfo[];
  /** `count_diff.approve` yoksa boş (sunucu `review` kipini hiç okumaz). */
  readonly lines: readonly ReviewLine[];
  readonly canReview: boolean;
  readonly canCancel: boolean;
}

/** İlk gösterilen satır sayısı ve "daha fazla" adımı (sanallaştırma kütüphanesi kurulu değil; R-11 deseni: sayfalı gösterim). */
const PAGE = 50;
const OPEN_STATES: ReadonlySet<CountStatus> = new Set(["COUNTING", "SUBMITTED", "APPROVED"]);

export function CountReview({ slug, session, locations, lines, canReview, canCancel }: CountReviewProps) {
  const t = useTranslations("counting");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const approveKey = useAttemptKey();
  const postKey = useAttemptKey();
  const cancelKey = useAttemptKey();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<{ info: ErrorInfo; ctx: CountErrorContext } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(PAGE);
  const refresh = (): void => startTransition(() => router.refresh());

  const open = OPEN_STATES.has(session.status);
  const counted = lines.filter((l) => l.counted !== null).length;
  const uncounted = lines.length - counted;
  const differing = lines.filter((l) => l.difference !== null && diffSign(l.difference) !== 0).length;
  const approvedPending = session.status === "APPROVED";

  async function run<T>(ctx: CountErrorContext, call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    if (busyRef.current) return { ok: false, error: { code: "BUSY" } };
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const out = await call();
    busyRef.current = false;
    setBusy(false);
    if (!out.ok) {
      setError({ info: out.error, ctx });
      if (needsRefresh(out.error) || out.error.code === "VERSION_CONFLICT") refresh();
    }
    return out;
  }

  async function approveAndPost() {
    setConfirm(false);
    const out = await run("approve", () => runAttempt(approveKey, (clientKey) => approveAndPostCountAction({ slug, clientKey, sessionId: session.id })));
    if (!out.ok) return;
    // Zincir: onay kalıcıdır. Fiş başarısızsa sunucu durumu APPROVED'dır ("onaylandı, fiş bekliyor"); yenileme bunu gösterir, neden aşağıda kalır.
    if (!out.data.posted) setError({ info: out.data.postError, ctx: "post" });
    refresh();
  }
  async function postOnly() {
    const out = await run("post", () => runAttempt(postKey, (clientKey) => postCountAdjustmentAction({ slug, clientKey, sessionId: session.id })));
    if (out.ok) refresh();
  }
  async function cancel() {
    if (reason.trim() === "") return;
    const out = await run("cancel", () => runAttempt(cancelKey, (clientKey) => cancelCountAction({ slug, clientKey, sessionId: session.id, reason: reason.trim() })));
    if (!out.ok) return;
    setCancelOpen(false);
    setReason("");
    refresh();
  }

  const byLocation = new Map<string, ReviewLine[]>();
  for (const l of lines.slice(0, shown)) byLocation.set(l.locationId, [...(byLocation.get(l.locationId) ?? []), l]);

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]" data-testid="count-review">
      <section aria-labelledby="count-lines" className="flex min-w-0 flex-col gap-3">
        <h2 id="count-lines" className="text-xl font-bold text-ink">
          {t("review.lines")}
        </h2>
        {!canReview ? (
          <p className="flex items-start gap-2 text-base text-ink-muted" data-testid="review-locked">
            <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span className="min-w-0 break-words">{t("review.locked")}</span>
          </p>
        ) : lines.length === 0 ? (
          <EmptyState icon={<ClipboardCheck aria-hidden="true" className="size-6" />} title={t("review.empty")} description={t("review.emptyAction")} />
        ) : (
          <>
            <p className="text-base text-ink" data-testid="review-summary">
              {t("review.summary", { counted, total: lines.length })} {differing === 0 ? "" : t("review.summaryDiff", { n: differing })}
            </p>
            {uncounted === 0 || !open ? null : <Banner kind="warning">{t("review.uncounted", { n: uncounted })}</Banner>}
            <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label={t("review.lines")} data-testid="review-lines">
              {[...byLocation.entries()].map(([locationId, rows]) => {
                const loc = locations.find((x) => x.id === locationId);
                return (
                  <li key={locationId} className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-3" data-testid="review-location">
                    <h3 className="flex min-w-0 flex-wrap items-center gap-2 break-words text-lg font-bold text-ink">
                      <span className="min-w-0 break-words">{loc === undefined ? "" : loc.name === "" || loc.name === loc.code ? loc.code : `${loc.code} · ${loc.name}`}</span>
                      {loc === undefined ? null : (
                        <span className="inline-flex min-h-8 items-center gap-1 text-sm font-semibold text-ink-muted">
                          <Lock aria-hidden="true" className="size-4" />
                          {loc.locked ? t("review.lockOn") : t("review.lockOff")}
                        </span>
                      )}
                    </h3>
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {rows.map((l) => (
                        <ReviewRow key={l.id} line={l} />
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
            {shown >= lines.length ? null : (
              <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)} data-testid="review-more">
                {t("review.more", { n: lines.length - shown })}
              </Button>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="count-actions" className="flex min-w-0 flex-col gap-3 self-start rounded-card border-2 border-border bg-surface p-4">
        <h2 id="count-actions" className="text-xl font-bold text-ink">
          {t("actions.title")}
        </h2>
        <StatusBadge status={session.status} />
        {session.abandoned ? (
          <Banner kind="warning">
            <p className="font-semibold" data-testid="abandoned-badge">
              {t("abandoned")}
            </p>
            <p>{t("abandonedHint")}</p>
          </Banner>
        ) : null}
        {error === null ? null : <CountErrorNotice error={error.info} context={error.ctx} />}
        {session.status === "POSTED" ? <Banner kind="success">{t("done.posted")}</Banner> : null}
        {session.status === "CANCELLED" ? <Banner kind="info">{t("done.cancelled")}</Banner> : null}
        {approvedPending ? (
          <Banner kind="warning">
            <p className="font-semibold" data-testid="approved-pending">
              {t("post.pending")}
            </p>
            <p>{t("post.pendingHint")}</p>
          </Banner>
        ) : null}

        {open && !approvedPending ? (
          canReview ? (
            <Button variant="primary" loading={busy} onClick={() => setConfirm(true)} data-testid="approve-post">
              {t("approve.button")}
            </Button>
          ) : (
            <p className="flex items-start gap-2 text-base text-ink-muted" data-testid="approve-locked">
              <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <span className="min-w-0 break-words">{t("approve.locked")}</span>
            </p>
          )
        ) : null}
        {approvedPending ? (
          canReview ? (
            <Button variant="primary" loading={busy} onClick={() => void postOnly()} data-testid="post-only">
              {t("post.button")}
            </Button>
          ) : (
            <p className="flex items-start gap-2 text-base text-ink-muted" data-testid="post-locked">
              <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <span className="min-w-0 break-words">{t("approve.locked")}</span>
            </p>
          )
        ) : null}

        {open ? (
          canCancel ? (
            cancelOpen ? (
              <form
                className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-danger p-3"
                data-testid="cancel-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void cancel();
                }}
              >
                <p className="break-words text-base font-bold text-danger-ink">{t("cancel.effect")}</p>
                <label className="flex min-w-0 flex-col gap-1 text-base font-semibold text-ink">
                  {t("cancel.reason")}
                  <span className="text-sm font-normal text-ink-muted">{t("cancel.reasonHint")}</span>
                  <textarea
                    value={reason}
                    maxLength={500}
                    rows={3}
                    onChange={(e) => setReason(e.target.value)}
                    className={`min-h-24 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface p-3 text-base text-ink ${FOCUS}`}
                  />
                </label>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Button type="submit" variant="danger" loading={busy} disabled={reason.trim() === ""} data-testid="cancel-confirm">
                    {t("cancel.confirm")}
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setCancelOpen(false)}>
                    {t("cancel.back")}
                  </Button>
                </div>
              </form>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => setCancelOpen(true)} data-testid="cancel-open">
                {t("cancel.button")}
              </Button>
            )
          ) : (
            <p className="flex items-start gap-2 text-base text-ink-muted" data-testid="cancel-locked">
              <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <span className="min-w-0 break-words">{t("cancel.locked")}</span>
            </p>
          )
        ) : null}
        {(!canReview || !canCancel) && open ? (
          <Link href="/help" data-testid="help-link" className={LINK_BTN}>
            {t("helpCall")}
          </Link>
        ) : null}
      </section>

      <ConfirmDialog
        open={confirm}
        title={t("approve.confirmTitle")}
        description={differing === 0 ? t("approve.confirmNone") : t("approve.confirmBody", { n: differing })}
        confirmLabel={t("approve.confirm")}
        cancelLabel={t("cancel.back")}
        variant="primary"
        loading={busy}
        onConfirm={() => void approveAndPost()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

function ReviewRow({ line }: { line: ReviewLine }) {
  const t = useTranslations("counting");
  const sign = line.difference === null ? null : diffSign(line.difference);
  const tone = sign === null ? "text-ink-muted" : sign === 0 ? "text-success-ink" : "text-danger-ink";
  return (
    <li className="flex min-w-0 flex-col gap-1 border-t border-border pt-2" data-testid="review-line">
      <span className="break-words text-base font-semibold text-ink">
        {line.itemName} <span className="font-normal text-ink-muted">· {line.itemCode}</span>
        {line.stockStatus === "AVAILABLE" ? null : <span className="font-normal text-ink-muted"> · {t(`stockStatus.${line.stockStatus}`)}</span>}
      </span>
      <dl className="m-0 grid min-w-0 grid-cols-3 gap-2 text-sm">
        <div className="min-w-0">
          <dt className="text-ink-muted">{t("review.reference")}</dt>
          <dd className="m-0 break-words text-base font-bold text-ink" data-testid="line-reference">
            {plainQty(line.reference)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ink-muted">{t("review.counted")}</dt>
          <dd className="m-0 break-words text-base font-bold text-ink" data-testid="line-counted">
            {line.counted === null ? "–" : plainQty(line.counted)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ink-muted">{t("review.difference")}</dt>
          <dd className={`m-0 flex min-w-0 items-center gap-1 break-words text-base font-bold ${tone}`} data-testid="line-difference" data-sign={sign === null ? "pending" : String(sign)}>
            {sign === null ? <Clock aria-hidden="true" className="size-4 shrink-0" /> : sign === 0 ? <CircleCheck aria-hidden="true" className="size-4 shrink-0" /> : <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />}
            <span className="min-w-0 break-words">
              {line.difference === null || sign === null
                ? t("diff.pending")
                : sign === 0
                  ? t("diff.same")
                  : sign > 0
                    ? t("diff.over", { n: plainQty(line.difference) })
                    : t("diff.under", { n: plainQty(line.difference).replace("-", "") })}
            </span>
          </dd>
        </div>
      </dl>
    </li>
  );
}
