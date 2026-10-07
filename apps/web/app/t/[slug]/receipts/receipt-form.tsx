"use client";
// Mal kabul ortak istemci takımı ve masaüstü teslim formu (T-313).
// - Anahtar yaşam döngüsü (ADR-018 §1-3, Supervisor notu: T-229 gelene kadar yerel): form ilk açılışta `crypto.randomUUID()` üretir; ağ hatasında ve
//   geçici sunucu hatasında AYNI anahtar kullanılır; iş kuralı reddinden sonra içerik değişirse yeni anahtar; başarıdan sonra yenilenir.
// - Hata eşlemesi: sunucu hata kodu (+ayrıntı) → `receiving.errors.<anahtar>` (+ `Action`); kural yeniden yazılmaz, yalnızca ileti seçilir.
// - Masaüstü: beklenen teslim listesi (satır durumu, kalite onayı) + oluşturma formu. Saha ekranları `receive-flow.tsx` / `putaway-flow.tsx`.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Banner, Button, CircleCheck, Clock, ConfirmDialog, EmptyState, Lock, PackagePlus, TextField, TriangleAlert } from "@wms/ui";
import { approveQualityAction, createReceiptAction, itemUnitsAction } from "./actions.ts";
import { searchItemsAction } from "../items/actions.ts";

// İstemci dosyaları sunucu paketlerini (tip olarak bile) içe aktaramaz (AC-28 / T-127b): sunucudan gelen veri biçimleri burada yapısal olarak
// tanımlanır; domain tipleriyle birebir uyumludur (sunucu bileşeni `ReceiptView`'ı bu şekle atar, derleyici uyumsuzluğu yakalar).
export interface ReceiptLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly expected: string;
  readonly received: string;
  readonly damaged: string;
  readonly open: string;
}
export interface ReceiptView {
  readonly id: string;
  readonly warehouseId: string;
  readonly number: string;
  readonly supplierRef: string | null;
  readonly status: "DRAFT" | "OPEN" | "CLOSED" | "CANCELLED";
  readonly version: number;
  readonly createdKey: string;
  readonly lines: readonly ReceiptLineView[];
}
export interface ReceiptDetail extends ReceiptView {
  readonly receivingLocations: readonly { readonly id: string; readonly code: string; readonly name: string }[];
}
/** Sunucu eylemi sonucu (`ActionResult` ile yapısal olarak aynı). */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly detail?: string | undefined; readonly requestId: string } };

// ---------------------------------------------------------------------------------------------------------------------
// Anahtar yaşam döngüsü
// ---------------------------------------------------------------------------------------------------------------------
export interface KeyHolder {
  /** Gönderimde kullanılacak anahtar. */
  current(): string;
  /** Başarı: yeni iş için yeni anahtar. */
  success(): void;
  /** İş kuralı reddi: içerik değişene kadar aynı anahtar (sunucu aynı reddi tekrar oynatır). */
  rejected(): void;
  /** Kullanıcı içeriği değiştirdi: red sonrasıysa yeni anahtar. */
  contentChanged(): void;
}

export function createKeyHolder(generate: () => string = () => crypto.randomUUID()): KeyHolder {
  let key = generate();
  let wasRejected = false;
  return {
    current: () => key,
    success: () => {
      key = generate();
      wasRejected = false;
    },
    rejected: () => {
      wasRejected = true;
    },
    contentChanged: () => {
      if (!wasRejected) return;
      key = generate();
      wasRejected = false;
    },
  };
}

export function useKeyHolder(): KeyHolder {
  const ref = useRef<KeyHolder | null>(null);
  if (ref.current === null) ref.current = createKeyHolder();
  return ref.current;
}

/** Geçici hatalar: aynı anahtarla yeniden denemek güvenlidir ve doğrudur (iş kuralı reddi değildir). */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["INTERNAL", "RATE_LIMITED", "NETWORK", "TENANT_SUSPENDED", "TENANT_CLOSING", "UNAUTHENTICATED"]);

export interface ErrorInfo {
  readonly code: string;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
}
export type Outcome<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ErrorInfo };

/** Anahtarlı gönderim: ağ hatası `NETWORK` olur ve anahtar korunur; reddedilirse anahtar `rejected` işaretlenir; başarıda yenilenir. */
export async function submitWithKey<T>(holder: KeyHolder, call: (clientKey: string) => Promise<ActionResult<T>>): Promise<Outcome<T>> {
  const key = holder.current();
  let res: ActionResult<T>;
  try {
    res = await call(key);
  } catch {
    return { ok: false, error: { code: "NETWORK" } };
  }
  if (res.ok) {
    holder.success();
    return { ok: true, data: res.data };
  }
  if (!TRANSIENT_CODES.has(res.error.code)) holder.rejected();
  return { ok: false, error: { code: res.error.code, detail: res.error.detail, requestId: res.error.requestId } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Hata eşlemesi
// ---------------------------------------------------------------------------------------------------------------------
export type ErrorContext = "receive" | "putaway" | "create" | "approve" | "scan";

/**
 * Sunucu hatası → ileti anahtarı. `OVER_RECEIPT` ayrı bir sunucu kodu DEĞİLDİR (A-305-3): kabulde ayrıntısız `VALIDATION_FAILED` olarak gelir ve
 * sade dille "Beklenenden fazla okuttun. Kalan: n" gösterilir. `SCAN_MISMATCH` istemci tarafı tarama kontrolüdür (`scanMismatch`).
 */
export function errorKeyOf(error: Pick<ErrorInfo, "code" | "detail">, context: ErrorContext): string {
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
      if (detail === "BARCODE_AMBIGUOUS") return "barcode_ambiguous";
      if (detail === "DOCUMENT_STATE") return "document_state";
      if (detail === "QUANTITY_SCALE") return "quantity_scale";
      if (detail === undefined && context === "receive") return "over_receipt";
      if (detail === undefined && context === "putaway") return "putaway_invalid";
      return "validation_failed";
    default:
      return "internal";
  }
}

/** Taranan ürün bu işin ürünlerinden biri değilse true (istemci tarafı yanlış tarama engeli; alan kuralı değildir). */
export function scanMismatch(resolvedItemId: string, allowedItemIds: readonly string[]): boolean {
  return !allowedItemIds.includes(resolvedItemId);
}

/** `"6.000000"` → 6; kesirli ya da sayı olmayan dizgi → null (adım düğmesi sınırsız kalır, değer olduğu gibi gider). Yalnızca gösterim/varsayılan. */
export function intOf(s: string | null | undefined): number | null {
  if (s === undefined || s === null) return null;
  const m = /^(\d{1,9})(?:\.0+)?$/.exec(s.trim());
  return m === null ? null : Number(m[1]);
}

export function ErrorNotice({ error, context, remaining }: { error: ErrorInfo; context: ErrorContext; remaining?: string }) {
  const t = useTranslations("receiving");
  const key = errorKeyOf(error, context);
  return (
    <Banner kind="error">
      <p className="font-semibold" data-testid="error-reason">
        {t(`errors.${key}`, { remaining: remaining ?? "-" })}
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

// ---------------------------------------------------------------------------------------------------------------------
// Satır durumu (ikon + metin + renk)
// ---------------------------------------------------------------------------------------------------------------------
export function LineStatus({ expected, received, damaged, open }: { expected: string; received: string; damaged: string; open: string }) {
  const t = useTranslations("receiving");
  const done = intOf(open) === 0;
  const hasDamage = (intOf(damaged) ?? 0) > 0;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="inline-flex items-center gap-1 font-semibold text-ink">
        {done ? <CircleCheck aria-hidden="true" className="size-4 text-success" /> : <Clock aria-hidden="true" className="size-4 text-warning" />}
        {done ? t("line.complete") : t("line.open", { open: String(intOf(open) ?? open) })}
      </span>
      <span className="text-ink-muted">{t("line.expected", { n: String(intOf(expected) ?? expected) })}</span>
      <span className="text-ink-muted">{t("line.received", { n: String(intOf(received) ?? received) })}</span>
      {hasDamage ? (
        <span className="inline-flex items-center gap-1 font-semibold text-danger-ink">
          <TriangleAlert aria-hidden="true" className="size-4 text-danger" />
          {t("line.damaged", { n: String(intOf(damaged) ?? damaged) })}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Masaüstü: teslim listesi + oluşturma formu
// ---------------------------------------------------------------------------------------------------------------------
const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const LINK_BTN = `inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink ${FOCUS}`;

export interface WarehouseOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
export interface ReceiptsViewProps {
  readonly slug: string;
  readonly receipts: readonly ReceiptView[];
  readonly nextHref: string | null;
  readonly warehouses: readonly WarehouseOption[];
  readonly canCreate: boolean;
  readonly canApprove: boolean;
}

interface DraftLine {
  readonly itemId: string;
  readonly itemName: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly quantity: string;
}
interface Found {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface UnitOption {
  readonly unitId: string;
  readonly unitCode: string;
}

export function ReceiptsView({ slug, receipts, nextHref, warehouses, canCreate, canApprove }: ReceiptsViewProps) {
  const t = useTranslations("receiving");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const createKey = useKeyHolder();
  const approveKey = useKeyHolder();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [supplierRef, setSupplierRef] = useState("");
  const [lines, setLines] = useState<readonly DraftLine[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<readonly Found[]>([]);
  const [picked, setPicked] = useState<(Found & { units: readonly UnitOption[] }) | null>(null);
  const [unitId, setUnitId] = useState("");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ info: ErrorInfo; ctx: ErrorContext } | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ReceiptView | null>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const changed = (): void => {
    createKey.contentChanged();
    setCreated(null);
  };

  async function search(q: string) {
    setQuery(q);
    if (q.trim().length < 1) {
      setFound([]);
      return;
    }
    try {
      const r = await searchItemsAction({ slug, q: q.trim(), limit: 5 });
      if (r.ok) setFound(r.data.items);
    } catch {
      setFound([]);
    }
  }
  async function pick(f: Found) {
    setFound([]);
    setQuery(f.name);
    try {
      const r = await itemUnitsAction({ slug, itemId: f.id });
      if (!r.ok) {
        setError({ info: { code: r.error.code, detail: r.error.detail, requestId: r.error.requestId }, ctx: "scan" });
        return;
      }
      setPicked({ ...f, units: r.data.units });
      setUnitId(r.data.units[0]?.unitId ?? "");
      setError(null);
    } catch {
      setError({ info: { code: "NETWORK" }, ctx: "scan" });
    }
  }
  function addLine() {
    const unit = picked?.units.find((u) => u.unitId === unitId);
    if (picked === null || unit === undefined || !/^[1-9][0-9]{0,8}$/.test(qty)) return;
    changed();
    setLines((l) => [...l, { itemId: picked.id, itemName: picked.name, unitId: unit.unitId, unitCode: unit.unitCode, quantity: qty }]);
    setPicked(null);
    setQuery("");
    setQty("");
  }
  async function submit() {
    if (busy || lines.length === 0 || warehouseId === "") return;
    setBusy(true);
    setError(null);
    const out = await submitWithKey(createKey, (clientKey) =>
      createReceiptAction({
        slug,
        clientKey,
        warehouseId,
        ...(supplierRef.trim() === "" ? {} : { supplierRef: supplierRef.trim() }),
        lines: lines.map((l) => ({ itemId: l.itemId, unitId: l.unitId, expectedQuantity: l.quantity })),
      }),
    );
    setBusy(false);
    if (!out.ok) {
      setError({ info: out.error, ctx: "create" });
      return;
    }
    setCreated(out.data.number);
    setLines([]);
    setSupplierRef("");
    startTransition(() => router.refresh());
  }
  async function approve(r: ReceiptView) {
    setBusy(true);
    const out = await submitWithKey(approveKey, (clientKey) => approveQualityAction({ slug, clientKey, receiptId: r.id }));
    setBusy(false);
    setConfirm(null);
    if (!out.ok) {
      setError({ info: out.error, ctx: "approve" });
      return;
    }
    setError(null);
    setApproved(r.number);
    startTransition(() => router.refresh());
  }

  const field = `/t/${encodeURIComponent(slug)}/field/receive` as const;
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
      <section aria-labelledby="receipts-list" className="flex min-w-0 flex-col gap-3">
        <h2 id="receipts-list" className="text-xl font-bold text-ink">
          {t("list.title")}
        </h2>
        {approved === null ? null : <Banner kind="success">{t("quality.done", { number: approved })}</Banner>}
        {error !== null && (error.ctx === "approve" || error.ctx === "scan") ? <ErrorNotice error={error.info} context={error.ctx} /> : null}
        {receipts.length === 0 ? (
          <EmptyState icon={<PackagePlus aria-hidden="true" className="size-6" />} title={t("list.empty")} description={t("list.emptyAction")} />
        ) : (
          <ul aria-label={t("list.title")} className="m-0 flex list-none flex-col gap-3 p-0" data-testid="receipt-list">
            {receipts.map((r) => (
              <li key={r.id} data-testid="receipt-row" data-receipt-id={r.id} className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <h3 className="break-words text-lg font-bold text-ink">{r.number}</h3>
                  <span className="inline-flex min-h-8 items-center gap-1 rounded-full bg-cat-green-bg px-3 text-sm font-bold text-cat-green-ink">
                    {r.status === "OPEN" ? <Clock aria-hidden="true" className="size-4" /> : <CircleCheck aria-hidden="true" className="size-4" />}
                    {t(`status.${r.status}`)}
                  </span>
                </div>
                {r.supplierRef === null ? null : <p className="break-words text-sm text-ink-muted">{t("list.supplier", { ref: r.supplierRef })}</p>}
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {r.lines.map((l) => (
                    <li key={l.id} className="flex min-w-0 flex-col gap-1 border-t border-border pt-2">
                      <span className="break-words text-base font-semibold text-ink">
                        {l.itemName} <span className="font-normal text-ink-muted">({l.unitCode})</span>
                      </span>
                      <LineStatus expected={l.expected} received={l.received} damaged={l.damaged} open={l.open} />
                    </li>
                  ))}
                </ul>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {r.status === "OPEN" ? (
                    <Link href={`${field}?receipt=${encodeURIComponent(r.id)}`} className={LINK_BTN}>
                      {t("list.receiveInField")}
                    </Link>
                  ) : null}
                  {canApprove ? (
                    <Button variant="secondary" disabled={busy} onClick={() => setConfirm(r)}>
                      {t("quality.approve")}
                    </Button>
                  ) : (
                    <p className="flex min-w-0 items-start gap-2 text-sm text-ink-muted" data-testid="quality-locked">
                      <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 break-words">{t("quality.locked")}</span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextHref === null ? null : (
          <Link href={nextHref} className={LINK_BTN}>
            {t("list.more")}
          </Link>
        )}
      </section>

      <section aria-labelledby="receipt-new" className="flex min-w-0 flex-col gap-3 self-start rounded-card border-2 border-border bg-surface p-4">
        <h2 id="receipt-new" className="text-xl font-bold text-ink">
          {t("form.title")}
        </h2>
        {!canCreate ? (
          <p className="flex items-start gap-2 text-base text-ink-muted" data-testid="create-locked">
            <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span className="min-w-0 break-words">{t("form.locked")}</span>
          </p>
        ) : (
          <form
            className="flex min-w-0 flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {created === null ? null : <Banner kind="success">{t("form.created", { number: created })}</Banner>}
            {error !== null && error.ctx === "create" ? <ErrorNotice error={error.info} context="create" /> : null}
            {warehouses.length > 1 ? (
              <label className="flex min-w-0 flex-col gap-1 text-base font-semibold text-ink">
                {t("form.warehouse")}
                <select
                  value={warehouseId}
                  onChange={(e) => {
                    changed();
                    setWarehouseId(e.target.value);
                  }}
                  className={`min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-3 text-base text-ink ${FOCUS}`}
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} · {w.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <TextField
              label={t("form.supplierRef")}
              hint={t("form.supplierRefHint")}
              value={supplierRef}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => {
                changed();
                setSupplierRef(e.target.value);
              }}
            />
            {lines.length === 0 ? null : (
              <ul aria-label={t("form.lines")} className="m-0 flex list-none flex-col gap-2 p-0" data-testid="draft-lines">
                {lines.map((l, i) => (
                  <li key={`${l.itemId}-${i}`} className="flex min-w-0 items-center justify-between gap-2 rounded-card bg-bg px-3 py-2">
                    <span className="min-w-0 break-words text-base text-ink">
                      {l.itemName} · {l.quantity} {l.unitCode}
                    </span>
                    <Button
                      variant="secondary"
                      aria-label={t("form.removeLine", { name: l.itemName })}
                      onClick={() => {
                        changed();
                        setLines((x) => x.filter((_, j) => j !== i));
                      }}
                    >
                      {t("form.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-dashed border-border p-3">
              <TextField label={t("form.item")} hint={t("form.itemHint")} value={query} autoComplete="off" onChange={(e) => void search(e.target.value)} />
              {found.length === 0 ? null : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={t("form.item")}>
                  {found.map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => void pick(f)} className={`flex min-h-12 w-full items-center rounded-control border-2 border-border bg-surface px-3 text-left text-base text-ink ${FOCUS}`}>
                        <span className="min-w-0 break-words">
                          {f.name} <span className="text-ink-muted">({f.code})</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {picked === null ? null : (
                <>
                  <label className="flex min-w-0 flex-col gap-1 text-base font-semibold text-ink">
                    {t("form.unit")}
                    <select value={unitId} onChange={(e) => setUnitId(e.target.value)} className={`min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-3 text-base text-ink ${FOCUS}`}>
                      {picked.units.map((u) => (
                        <option key={u.unitId} value={u.unitId}>
                          {u.unitCode}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TextField label={t("form.expected")} inputMode="numeric" pattern="[0-9]*" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 9))} />
                  <Button variant="secondary" onClick={addLine} disabled={!/^[1-9][0-9]{0,8}$/.test(qty)}>
                    {t("form.addLine")}
                  </Button>
                </>
              )}
            </div>
            <Button type="submit" variant="primary" loading={busy} disabled={lines.length === 0 || warehouseId === ""}>
              {t("form.save")}
            </Button>
          </form>
        )}
      </section>
      <ConfirmDialog
        open={confirm !== null}
        title={t("quality.confirmTitle")}
        description={t("quality.confirmBody", { number: confirm?.number ?? "" })}
        confirmLabel={t("quality.approve")}
        cancelLabel={t("cancel")}
        variant="primary"
        loading={busy}
        onConfirm={() => confirm !== null && void approve(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
