"use client";
// Sipariş ekranları istemci takımı (T-314): sipariş listesi + oluşturma formu + toplama görevlendirmesi (OrdersView) ve sipariş ayrıntısı (OrderDetailView).
// - Kurallar sunucuda/domain'dedir: yetki (`document.create` / `document.approve`), kapsam, durum, tahsis ve iptal kuralları burada YENİDEN YAZILMAZ. `canCreate` /
//   `canApprove` yalnızca gösterimdir (kilit + gerekçe); eylem sunucuda yeniden denetlenir ve sunucu reddi neden + sonraki eylemle gösterilir (FORBIDDEN ekranı yok).
// - Anahtar yaşam döngüsü (ADR-018 §1-3; receipts/receipt-form.tsx `createKeyHolder` ile aynı): her niyet (işlem + hedef + içerik imzası) kendi anahtarını taşır;
//   ağ/geçici hatada AYNI anahtarla yeniden gönderilir (çift gönderimde tekrar oynatılır), başarıdan sonra yenilenir, içerik değişince (imza değişir) yeni anahtar.
// - Yatay taşma yok: liste ve satırlar kart düzenindedir (tablo yok); sayfa başına ≤30 sipariş (keyset). TanStack Virtual bağımlılığı bu pakette kurulu
//   değildir (bkz. rapor bulgusu); büyük listeye karşı sayfalama kullanılır.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Banner, Button, CircleCheck, Clock, ConfirmDialog, EmptyState, Lock, PackagePlus, TextField, TriangleAlert } from "@wms/ui";
import { itemUnitsAction } from "../receipts/actions.ts";
import { createKeyHolder, submitWithKey, type ErrorInfo, type KeyHolder } from "../receipts/receipt-form.tsx";
import { searchItemsAction } from "../items/actions.ts";
import { cancelOrderAction, cancelOrderLineAction, createOrderAction, createPickAssignmentAction, lineStockAction, reserveOrderAction } from "./actions.ts";

// İstemci dosyaları sunucu paketlerini içe aktaramaz (AC-28 / T-127b): veri biçimleri yapısal olarak tanımlanır; domain tipleriyle birebir uyumludur
// (sunucu bileşeni `SalesOrderListItem` / `SalesOrderDetail` değerlerini bu şekle verir, derleyici uyumsuzluğu yakalar).
export type OrderStatus = "OPEN" | "CLOSED" | "CANCELLED";
export interface OrderListItem {
  readonly id: string;
  readonly number: string;
  readonly customerRef: string | null;
  readonly status: OrderStatus;
  readonly version: number;
  readonly createdKey: string;
  readonly lineCount: number;
  readonly openLineCount: number;
}
export interface OrderLine {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitCode: string;
  readonly unitName: string;
  readonly requested: string;
  readonly allocated: string;
  readonly picked: string;
  readonly shipped: string;
  readonly open: string;
  readonly returned: string;
  readonly cancelled: string;
}
export interface OrderDetail extends OrderListItem {
  readonly lines: readonly OrderLine[];
}
export interface AssigneeOption {
  readonly membershipId: string;
  readonly displayName: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Anahtar yaşam döngüsü (niyet başına)
// ---------------------------------------------------------------------------------------------------------------------
/** İmza (işlem + hedef + içerik) başına anahtar tutucu. Aynı imza → aynı tutucu; imza değişince yeni anahtar. */
export function createKeyRegistry(generate?: () => string): (signature: string) => KeyHolder {
  const map = new Map<string, KeyHolder>();
  return (signature) => {
    let h = map.get(signature);
    if (h === undefined) {
      h = createKeyHolder(generate);
      map.set(signature, h);
    }
    return h;
  };
}
function useKeyFor(): (signature: string) => KeyHolder {
  const ref = useRef<((signature: string) => KeyHolder) | null>(null);
  if (ref.current === null) ref.current = createKeyRegistry();
  return ref.current;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hata eşlemesi (kural yeniden yazılmaz; yalnızca ileti seçilir)
// ---------------------------------------------------------------------------------------------------------------------
export type OrderErrorContext = "create" | "reserve" | "cancel" | "assign" | "lookup";

/**
 * Sunucu hatası → `orders.errors.<anahtar>` (+ `Action`). `INSUFFICIENT_STOCK` elle tahsiste "tahsis edilemeyen miktar"dır; otomatik rezervasyonda yetersiz stok RET
 * değildir (T-306): satır tahsissiz açık kalır ve ekran bunu satırda gösterir. `DOCUMENT_STATE` = sipariş artık açık değil / işlem görmüş.
 */
export function orderErrorKey(error: Pick<ErrorInfo, "code" | "detail">, context: OrderErrorContext): string {
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
      if (detail === "DOCUMENT_STATE") return "document_state";
      if (detail === "DOCUMENT_TOO_LARGE") return "too_large";
      if (detail === "QUANTITY_SCALE") return "quantity_scale";
      if (detail === "CODE_TAKEN") return "code_taken";
      if (detail === undefined && context === "assign") return "assign_invalid";
      if (detail === undefined && context === "cancel") return "cancel_invalid";
      if (detail === undefined && context === "reserve") return "reserve_invalid";
      return "validation_failed";
    default:
      return "internal";
  }
}

function ErrorNotice({ error, context }: { error: ErrorInfo; context: OrderErrorContext }) {
  const t = useTranslations("orders");
  const key = orderErrorKey(error, context);
  return (
    <Banner kind="error">
      <p className="font-semibold" data-testid="error-reason">
        {t(`errors.${key}`)}
      </p>
      <p data-testid="error-action">{t(`errors.${key}Action`)}</p>
      <details className="mt-1 text-sm">
        <summary className="flex min-h-12 cursor-pointer items-center">{t("moreInfo")}</summary>
        <p data-testid="error-code">{t("errorCode", { code: error.detail === undefined ? error.code : `${error.code}/${error.detail}` })}</p>
        {error.requestId === undefined ? null : <p className="break-all">{error.requestId}</p>}
      </details>
    </Banner>
  );
}

function LockedNote({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="flex min-w-0 items-start gap-2 text-base text-ink-muted" data-testid={testId}>
      <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Gösterim yardımcıları (miktar kuralı değil; yalnız biçim)
// ---------------------------------------------------------------------------------------------------------------------
/** `"4.000000"` → `"4"`, `"2.500000"` → `"2.5"` (yalnız gösterim; değer sunucudan olduğu gibi gelir). */
export function fmtQty(s: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
function microOf(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (m === null) return 0n;
  const v = BigInt(m[2] as string) * 1_000_000n + BigInt(((m[3] ?? "") + "000000").slice(0, 6));
  return m[1] === "-" ? -v : v;
}
/** Açık − tahsisli (yalnız gösterim: "tahsis edilemeyen miktar" rozeti). Negatif → 0. */
export function unallocatedOf(open: string, allocated: string): bigint {
  const d = microOf(open) - microOf(allocated);
  return d < 0n ? 0n : d;
}
function fromMicroDisplay(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const LINK_BTN = `inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink ${FOCUS}`;
const SELECT = `min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-3 text-base text-ink ${FOCUS}`;
const STATUS_TONE: Record<OrderStatus, string> = {
  OPEN: "bg-info-bg text-info-ink",
  CLOSED: "bg-success-bg text-success-ink",
  CANCELLED: "bg-danger-bg text-danger-ink",
};
const QTY_RE = /^\d{1,9}(\.\d{1,6})?$/;
const validQty = (q: string): boolean => QTY_RE.test(q) && /[1-9]/.test(q);

function StatusBadge({ status }: { status: OrderStatus }) {
  const t = useTranslations("orders");
  return (
    <span className={`inline-flex min-h-8 items-center gap-1 rounded-full px-3 text-sm font-bold ${STATUS_TONE[status]}`} data-status={status}>
      {status === "OPEN" ? <Clock aria-hidden="true" className="size-4" /> : status === "CLOSED" ? <CircleCheck aria-hidden="true" className="size-4" /> : <TriangleAlert aria-hidden="true" className="size-4" />}
      {t(`status.${status}`)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Liste + oluşturma + toplama görevlendirmesi
// ---------------------------------------------------------------------------------------------------------------------
export interface OrdersViewProps {
  readonly slug: string;
  readonly orders: readonly OrderListItem[];
  readonly nextHref: string | null;
  readonly statusFilter: OrderStatus | "ALL";
  readonly assignees: readonly AssigneeOption[];
  readonly canCreate: boolean;
  readonly canApprove: boolean;
}
interface DraftLine {
  readonly itemId: string;
  readonly itemName: string;
  readonly unitId: string;
  readonly unitName: string;
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
  readonly unitName: string;
}
type AssignResult = { readonly groupId: string | null; readonly taskCount: number; readonly assigned: boolean };

export function OrdersView({ slug, orders, nextHref, statusFilter, assignees, canCreate, canApprove }: OrdersViewProps) {
  const t = useTranslations("orders");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const keyFor = useKeyFor();
  const [customerRef, setCustomerRef] = useState("");
  const [lines, setLines] = useState<readonly DraftLine[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<readonly Found[]>([]);
  const [picked, setPicked] = useState<(Found & { units: readonly UnitOption[] }) | null>(null);
  const [unitId, setUnitId] = useState("");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ info: ErrorInfo; ctx: OrderErrorContext } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [assignee, setAssignee] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [assignResult, setAssignResult] = useState<AssignResult | null>(null);

  const base = `/t/${encodeURIComponent(slug)}/orders`;

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
        setError({ info: { code: r.error.code, detail: r.error.detail, requestId: r.error.requestId }, ctx: "lookup" });
        return;
      }
      setPicked({ ...f, units: r.data.units });
      setUnitId(r.data.units[0]?.unitId ?? "");
      setError(null);
    } catch {
      setError({ info: { code: "NETWORK" }, ctx: "lookup" });
    }
  }
  function addLine() {
    const unit = picked?.units.find((u) => u.unitId === unitId);
    if (picked === null || unit === undefined || !validQty(qty)) return;
    setLines((l) => [...l, { itemId: picked.id, itemName: picked.name, unitId: unit.unitId, unitName: unit.unitName || unit.unitCode, quantity: qty }]);
    setPicked(null);
    setQuery("");
    setQty("");
  }
  async function submitCreate() {
    if (busy || lines.length === 0) return;
    setBusy(true);
    setError(null);
    const payload = { customerRef: customerRef.trim(), lines: lines.map((l) => ({ itemId: l.itemId, unitId: l.unitId, quantity: l.quantity })) };
    const holder = keyFor(`create:${JSON.stringify(payload)}`);
    const out = await submitWithKey(holder, (clientKey) =>
      createOrderAction({ slug, clientKey, ...(payload.customerRef === "" ? {} : { customerRef: payload.customerRef }), lines: payload.lines }),
    );
    if (!out.ok) {
      setBusy(false);
      setError({ info: out.error, ctx: "create" });
      return;
    }
    // A-314a-2: kapsamlı kullanıcı yeni siparişi listede göremeyebilir → doğrudan ayrıntıya gidilir (orada neden + sonraki eylem gösterilir).
    router.push(`${base}/${encodeURIComponent(out.data.orderId)}?created=1`);
  }
  function toggle(id: string) {
    setAssignResult(null);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  async function submitAssign() {
    if (busy || selected.size === 0) return;
    setBusy(true);
    setError(null);
    const ids = [...selected].sort();
    const holder = keyFor(`assign:${ids.join(",")}:${assignee}`);
    const out = await submitWithKey(holder, (clientKey) =>
      createPickAssignmentAction({ slug, clientKey, orderIds: ids, ...(assignee === "" ? {} : { assigneeMembershipId: assignee }) }),
    );
    setBusy(false);
    setConfirm(false);
    if (!out.ok) {
      setError({ info: out.error, ctx: "assign" });
      return;
    }
    setAssignResult({ groupId: out.data.groupId, taskCount: out.data.taskCount, assigned: assignee !== "" });
    setSelected(new Set());
    startTransition(() => router.refresh());
  }

  const filters: readonly (OrderStatus | "ALL")[] = ["OPEN", "CLOSED", "CANCELLED", "ALL"];
  const assigneeName = assignees.find((a) => a.membershipId === assignee)?.displayName ?? "";
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
      <section aria-labelledby="orders-list" className="flex min-w-0 flex-col gap-3">
        <h2 id="orders-list" className="text-xl font-bold text-ink">
          {t("list.title")}
        </h2>
        <nav aria-label={t("list.filter")} className="flex min-w-0 flex-wrap gap-2">
          {filters.map((f) => (
            <Link
              key={f}
              href={`${base}?status=${f}`}
              aria-current={f === statusFilter ? "page" : undefined}
              className={`${LINK_BTN} ${f === statusFilter ? "bg-info-bg" : ""}`}
              data-testid={`filter-${f}`}
            >
              {t(`filter.${f}`)}
            </Link>
          ))}
        </nav>
        {assignResult === null ? null : assignResult.groupId === null ? (
          <Banner kind="warning">
            <p className="font-semibold" data-testid="assign-none">
              {t("assign.noneTitle")}
            </p>
            <p>{t("assign.noneAction")}</p>
          </Banner>
        ) : (
          <Banner kind="success">
            <p data-testid="assign-done">{t(assignResult.assigned ? "assign.doneAssigned" : "assign.doneOpen", { n: assignResult.taskCount })}</p>
          </Banner>
        )}
        {error !== null && (error.ctx === "assign" || error.ctx === "lookup") ? <ErrorNotice error={error.info} context={error.ctx} /> : null}
        {canApprove ? (
          selected.size === 0 ? (
            <p className="text-sm text-ink-muted">{t("assign.hint")}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border-strong bg-surface p-4" data-testid="assign-panel">
              <h3 className="text-lg font-bold text-ink">{t("assign.title")}</h3>
              <p className="text-base text-ink">{t("assign.selected", { n: selected.size })}</p>
              <label className="flex min-w-0 flex-col gap-1 text-base font-semibold text-ink">
                {t("assign.picker")}
                <select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  className={SELECT}
                  data-testid="assign-picker"
                >
                  <option value="">{t("assign.anyone")}</option>
                  {assignees.map((a) => (
                    <option key={a.membershipId} value={a.membershipId}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
                <span className="text-sm font-normal text-ink-muted">{t("assign.pickerHint")}</span>
              </label>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirm(true)} data-testid="assign-open">
                {t("assign.create")}
              </Button>
            </div>
          )
        ) : (
          <LockedNote text={t("assign.locked")} testId="assign-locked" />
        )}
        {orders.length === 0 ? (
          <EmptyState icon={<PackagePlus aria-hidden="true" className="size-6" />} title={t("list.empty")} description={t("list.emptyAction")} />
        ) : (
          <ul aria-label={t("list.title")} className="m-0 flex list-none flex-col gap-3 p-0" data-testid="order-list">
            {orders.map((o) => (
              <li key={o.id} data-testid="order-row" data-order-id={o.id} className="flex min-w-0 items-start gap-2 rounded-card border-2 border-border bg-surface p-3">
                {canApprove && o.status === "OPEN" ? (
                  <label className="flex min-h-12 min-w-12 shrink-0 items-center justify-center">
                    <input
                      type="checkbox"
                      className="size-6"
                      checked={selected.has(o.id)}
                      onChange={() => toggle(o.id)}
                      aria-label={t("list.select", { number: o.number })}
                      data-testid="order-select"
                    />
                  </label>
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <h3 className="min-w-0 break-words text-lg font-bold text-ink">{o.number}</h3>
                    <StatusBadge status={o.status} />
                  </div>
                  {o.customerRef === null ? null : <p className="break-words text-sm text-ink-muted">{t("list.customer", { ref: o.customerRef })}</p>}
                  <p className="text-sm font-semibold text-ink" data-testid="order-open-lines">
                    {t("list.lines", { open: o.openLineCount, total: o.lineCount })}
                  </p>
                  <Link href={`${base}/${encodeURIComponent(o.id)}`} className={`${LINK_BTN} w-fit`}>
                    {t("list.openDetail")}
                  </Link>
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

      <section aria-labelledby="order-new" className="flex min-w-0 flex-col gap-3 self-start rounded-card border-2 border-border bg-surface p-4">
        <h2 id="order-new" className="text-xl font-bold text-ink">
          {t("form.title")}
        </h2>
        {!canCreate ? (
          <LockedNote text={t("form.locked")} testId="create-locked" />
        ) : (
          <form
            className="flex min-w-0 flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreate();
            }}
          >
            <p className="text-sm text-ink-muted">{t("form.scopeHint")}</p>
            {error !== null && error.ctx === "create" ? <ErrorNotice error={error.info} context="create" /> : null}
            <TextField
              label={t("form.customerRef")}
              hint={t("form.customerRefHint")}
              value={customerRef}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => setCustomerRef(e.target.value)}
            />
            {lines.length === 0 ? null : (
              <ul aria-label={t("form.lines")} className="m-0 flex list-none flex-col gap-2 p-0" data-testid="draft-lines">
                {lines.map((l, i) => (
                  <li key={`${l.itemId}-${i}`} className="flex min-w-0 items-center justify-between gap-2 rounded-card bg-bg px-3 py-2">
                    <span className="min-w-0 break-words text-base text-ink">
                      {l.itemName} · {l.quantity} {l.unitName}
                    </span>
                    <Button variant="secondary" aria-label={t("form.removeLine", { name: l.itemName })} onClick={() => setLines((x) => x.filter((_, j) => j !== i))}>
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
                    <select value={unitId} onChange={(e) => setUnitId(e.target.value)} className={SELECT}>
                      {picked.units.map((u) => (
                        <option key={u.unitId} value={u.unitId}>
                          {u.unitName || u.unitCode}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TextField label={t("form.quantity")} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, "").slice(0, 16))} />
                  <Button variant="secondary" onClick={addLine} disabled={!validQty(qty)}>
                    {t("form.addLine")}
                  </Button>
                </>
              )}
            </div>
            <Button type="submit" variant="primary" loading={busy} disabled={lines.length === 0} data-testid="create-submit">
              {t("form.save")}
            </Button>
          </form>
        )}
      </section>
      <ConfirmDialog
        open={confirm}
        title={t("assign.confirmTitle")}
        description={t(assignee === "" ? "assign.confirmBodyOpen" : "assign.confirmBody", { n: selected.size, name: assigneeName })}
        confirmLabel={t("assign.create")}
        cancelLabel={t("dismiss")}
        variant="primary"
        loading={busy}
        onConfirm={() => void submitAssign()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Ayrıntı: satır dökümü, rezervasyon, satır/sipariş iptali
// ---------------------------------------------------------------------------------------------------------------------
export interface OrderDetailViewProps {
  readonly slug: string;
  readonly order: OrderDetail;
  readonly canApprove: boolean;
  readonly justCreated: boolean;
}
interface StockRow {
  readonly dimension: {
    readonly locationId: string;
    readonly lotId: string | null;
    readonly serialId: string | null;
    readonly stockStatus: string;
    readonly inventoryOwnerId: string | null;
    readonly handlingUnitId: string | null;
  };
  readonly locationCode: string;
  readonly warehouseCode: string;
  readonly lotCode: string | null;
  readonly serialNo: string | null;
  readonly available: string;
}
type Panel = { readonly lineId: string; readonly kind: "cancel" | "manual" } | null;

const METRICS = ["requested", "allocated", "picked", "shipped", "open", "returned", "cancelled"] as const;

export function OrderDetailView({ slug, order, canApprove, justCreated }: OrderDetailViewProps) {
  const t = useTranslations("orders");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const keyFor = useKeyFor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ info: ErrorInfo; ctx: OrderErrorContext } | null>(null);
  const [reserved, setReserved] = useState<{ total: string; manual: boolean } | null>(null);
  const [cancelled, setCancelled] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [cancelQty, setCancelQty] = useState("");
  const [reason, setReason] = useState("");
  const [stock, setStock] = useState<{ rows: readonly StockRow[]; truncated: boolean } | null>(null);
  const [alloc, setAlloc] = useState<Readonly<Record<number, string>>>({});
  const [confirmOrder, setConfirmOrder] = useState(false);
  const [orderReason, setOrderReason] = useState("");

  const isOpen = order.status === "OPEN";
  const base = `/t/${encodeURIComponent(slug)}/orders`;
  const refresh = (): void => startTransition(() => router.refresh());

  async function reserve(overrides?: { lineId: string; allocations: { dimension: StockRow["dimension"]; quantity: string }[] }[]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReserved(null);
    const holder = keyFor(`reserve:${order.id}:${JSON.stringify(overrides ?? null)}`);
    const out = await submitWithKey(holder, (clientKey) =>
      reserveOrderAction({ slug, clientKey, orderId: order.id, ...(overrides === undefined ? {} : { overrides }) }),
    );
    setBusy(false);
    if (!out.ok) {
      setError({ info: out.error, ctx: "reserve" });
      return;
    }
    setReserved({ total: sumQuantities(out.data.lines.map((l) => l.quantity)), manual: overrides !== undefined });
    setPanel(null);
    setStock(null);
    setAlloc({});
    refresh();
  }
  async function openManual(line: OrderLine) {
    setPanel({ lineId: line.id, kind: "manual" });
    setStock(null);
    setAlloc({});
    setError(null);
    try {
      const r = await lineStockAction({ slug, itemId: line.itemId });
      if (!r.ok) {
        setError({ info: { code: r.error.code, detail: r.error.detail, requestId: r.error.requestId }, ctx: "lookup" });
        return;
      }
      setStock({ rows: r.data.rows, truncated: r.data.truncated });
    } catch {
      setError({ info: { code: "NETWORK" }, ctx: "lookup" });
    }
  }
  async function submitManual(line: OrderLine) {
    if (stock === null) return;
    const allocations = stock.rows.flatMap((r, i) => {
      const q = (alloc[i] ?? "").trim();
      return validQty(q) ? [{ dimension: r.dimension, quantity: q }] : [];
    });
    if (allocations.length === 0) return;
    await reserve([{ lineId: line.id, allocations }]);
  }
  function openCancel(line: OrderLine) {
    setPanel({ lineId: line.id, kind: "cancel" });
    setCancelQty(fmtQty(line.open));
    setReason("");
    setError(null);
  }
  async function submitCancelLine(line: OrderLine) {
    if (busy || !validQty(cancelQty) || reason.trim() === "") return;
    setBusy(true);
    setError(null);
    const holder = keyFor(`cancel-line:${line.id}:${cancelQty}:${reason.trim()}`);
    const out = await submitWithKey(holder, (clientKey) => cancelOrderLineAction({ slug, clientKey, lineId: line.id, quantity: cancelQty, reason: reason.trim() }));
    setBusy(false);
    if (!out.ok) {
      setError({ info: out.error, ctx: "cancel" });
      return;
    }
    setCancelled(t("cancel.lineDone", { no: line.lineNo }));
    setPanel(null);
    refresh();
  }
  async function submitCancelOrder() {
    if (busy || orderReason.trim() === "") return;
    setBusy(true);
    setError(null);
    const holder = keyFor(`cancel-order:${order.id}:${order.version}:${orderReason.trim()}`);
    const out = await submitWithKey(holder, (clientKey) => cancelOrderAction({ slug, clientKey, orderId: order.id, expectedVersion: order.version, reason: orderReason.trim() }));
    setBusy(false);
    setConfirmOrder(false);
    if (!out.ok) {
      setError({ info: out.error, ctx: "cancel" });
      return;
    }
    setCancelled(t("cancel.orderDone", { number: order.number }));
    refresh();
  }

  const shortLines = order.lines.filter((l) => unallocatedOf(l.open, l.allocated) > 0n);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4" aria-labelledby="order-head">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h2 id="order-head" className="min-w-0 break-words text-2xl font-extrabold text-ink" data-testid="order-number">
            {order.number}
          </h2>
          <StatusBadge status={order.status} />
        </div>
        {order.customerRef === null ? null : <p className="break-words text-base text-ink-muted">{t("list.customer", { ref: order.customerRef })}</p>}
        <p className="text-sm font-semibold text-ink">{t("list.lines", { open: order.openLineCount, total: order.lineCount })}</p>
      </section>

      {justCreated ? (
        <Banner kind="success">
          <p data-testid="created-note">{t("detail.created", { number: order.number })}</p>
          <p>{t("detail.createdNext")}</p>
        </Banner>
      ) : null}
      {reserved === null ? null : (
        <Banner kind="success">
          <p data-testid="reserve-done">{t(reserved.manual ? "reserve.doneManual" : "reserve.done", { total: reserved.total })}</p>
        </Banner>
      )}
      {cancelled === null ? null : (
        <Banner kind="success">
          <p data-testid="cancel-done">{cancelled}</p>
        </Banner>
      )}
      {error !== null ? <ErrorNotice error={error.info} context={error.ctx} /> : null}
      {isOpen && shortLines.length > 0 ? (
        <Banner kind="warning">
          <p className="font-semibold" data-testid="short-note">
            {t("detail.shortTitle", { n: shortLines.length })}
          </p>
          <p>{t("detail.shortAction")}</p>
        </Banner>
      ) : null}

      <ul aria-label={t("detail.lines")} className="m-0 flex list-none flex-col gap-3 p-0" data-testid="order-lines">
        {order.lines.map((l) => {
          const short = unallocatedOf(l.open, l.allocated);
          const lineOpen = isOpen && microOf(l.open) > 0n;
          return (
            <li key={l.id} data-testid="order-line" data-line-id={l.id} className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-border bg-surface p-4">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                <h3 className="min-w-0 break-words text-lg font-bold text-ink">
                  {t("detail.lineNo", { no: l.lineNo })} · {l.itemName} <span className="font-normal text-ink-muted">({l.itemCode})</span>
                </h3>
                <span className="text-sm text-ink-muted">{t("detail.unit", { unit: l.unitName || l.unitCode })}</span>
              </div>
              <dl className="m-0 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 lg:grid-cols-7">
                {METRICS.map((m) => (
                  <div key={m} className="flex min-w-0 flex-col" data-metric={m}>
                    <dt className="text-sm text-ink-muted">{t(`metric.${m}`)}</dt>
                    <dd className="m-0 break-words text-lg font-bold text-ink">{fmtQty(l[m])}</dd>
                  </div>
                ))}
              </dl>
              {isOpen && short > 0n ? (
                <p className="flex min-w-0 items-start gap-2 text-base font-semibold text-warning-ink" data-testid="line-short">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                  <span className="min-w-0 break-words">{t("detail.lineShort", { n: fromMicroDisplay(short) })}</span>
                </p>
              ) : null}
              {lineOpen && canApprove ? (
                <div className="flex min-w-0 flex-wrap gap-2">
                  {short > 0n ? (
                    <Button variant="secondary" disabled={busy} onClick={() => void openManual(l)} data-testid="manual-open">
                      {t("manual.open")}
                    </Button>
                  ) : null}
                  <Button variant="secondary" disabled={busy} onClick={() => openCancel(l)} data-testid="cancel-line-open">
                    {t("cancel.lineOpen")}
                  </Button>
                </div>
              ) : null}
              {panel !== null && panel.lineId === l.id && panel.kind === "cancel" ? (
                <div className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border-strong p-3" data-testid="cancel-panel">
                  <h4 className="text-base font-bold text-ink">{t("cancel.lineTitle", { no: l.lineNo })}</h4>
                  <TextField label={t("cancel.quantity")} hint={t("cancel.quantityHint", { open: fmtQty(l.open) })} inputMode="decimal" value={cancelQty} onChange={(e) => setCancelQty(e.target.value.replace(/[^0-9.]/g, "").slice(0, 16))} />
                  <TextField label={t("cancel.reason")} hint={t("cancel.reasonHint")} value={reason} maxLength={500} autoComplete="off" onChange={(e) => setReason(e.target.value)} />
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Button variant="danger" loading={busy} disabled={!validQty(cancelQty) || reason.trim() === ""} onClick={() => void submitCancelLine(l)} data-testid="cancel-line-submit">
                      {t("cancel.lineSubmit")}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setPanel(null)}>
                      {t("dismiss")}
                    </Button>
                  </div>
                </div>
              ) : null}
              {panel !== null && panel.lineId === l.id && panel.kind === "manual" ? (
                <div className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border-strong p-3" data-testid="manual-panel">
                  <h4 className="text-base font-bold text-ink">{t("manual.title", { no: l.lineNo })}</h4>
                  <p className="text-sm text-ink-muted">{t("manual.hint", { n: fromMicroDisplay(short) })}</p>
                  <p className="text-sm text-ink-muted">{t("manual.sideEffect")}</p>
                  {stock === null ? (
                    <p className="text-base text-ink-muted">{t("manual.loading")}</p>
                  ) : stock.rows.length === 0 ? (
                    <p className="text-base text-ink" data-testid="manual-empty">
                      {t("manual.empty")}
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {stock.rows.map((r, i) => (
                        <li key={`${r.dimension.locationId}-${i}`} className="flex min-w-0 flex-col gap-1 border-t border-border pt-2">
                          <span className="break-words text-base font-semibold text-ink">
                            {r.warehouseCode} · {r.locationCode}
                            {r.lotCode === null ? "" : ` · ${t("manual.lot", { code: r.lotCode })}`}
                            {r.serialNo === null ? "" : ` · ${t("manual.serial", { no: r.serialNo })}`}
                          </span>
                          <span className="text-sm text-ink-muted">{t("manual.available", { n: fmtQty(r.available) })}</span>
                          <TextField
                            label={t("manual.quantity")}
                            inputMode="decimal"
                            value={alloc[i] ?? ""}
                            onChange={(e) => setAlloc((a) => ({ ...a, [i]: e.target.value.replace(/[^0-9.]/g, "").slice(0, 16) }))}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                  {stock?.truncated === true ? <p className="text-sm text-ink-muted">{t("manual.truncated")}</p> : null}
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      loading={busy}
                      disabled={stock === null || !stock.rows.some((_, i) => validQty((alloc[i] ?? "").trim()))}
                      onClick={() => void submitManual(l)}
                      data-testid="manual-submit"
                    >
                      {t("manual.submit")}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setPanel(null)}>
                      {t("dismiss")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <section className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-border bg-surface p-4" aria-labelledby="order-actions">
        <h2 id="order-actions" className="text-xl font-bold text-ink">
          {t("actions.title")}
        </h2>
        {!isOpen ? (
          <p className="text-base text-ink-muted" data-testid="order-closed">
            {t("actions.closed")}
          </p>
        ) : canApprove ? (
          <>
            <p className="text-base text-ink">{t("reserve.explain")}</p>
            <Button variant="primary" loading={busy} onClick={() => void reserve()} data-testid="reserve-submit">
              {t("reserve.submit")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmOrder(true)} data-testid="cancel-order-open">
              {t("cancel.orderOpen")}
            </Button>
          </>
        ) : (
          <LockedNote text={t("actions.locked")} testId="actions-locked" />
        )}
        <Link href={base} className={`${LINK_BTN} w-fit`}>
          {t("detail.back")}
        </Link>
      </section>

      {confirmOrder ? (
        <section className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-danger bg-surface p-4" data-testid="cancel-order-panel" aria-labelledby="cancel-order-title">
          <h2 id="cancel-order-title" className="text-xl font-bold text-ink">
            {t("cancel.orderTitle", { number: order.number })}
          </h2>
          <p className="text-base text-ink">{t("cancel.orderBody")}</p>
          <TextField label={t("cancel.reason")} hint={t("cancel.reasonHint")} value={orderReason} maxLength={500} autoComplete="off" onChange={(e) => setOrderReason(e.target.value)} />
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button variant="danger" loading={busy} disabled={orderReason.trim() === ""} onClick={() => void submitCancelOrder()} data-testid="cancel-order-submit">
              {t("cancel.orderSubmit")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmOrder(false)}>
              {t("dismiss")}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Ondalık dizgilerin toplamı (1e-6 ölçeği, BigInt; float yok). Yalnız "bu çağrıda tahsis edilen toplam" gösterimi içindir. */
export function sumQuantities(list: readonly string[]): string {
  return fromMicroDisplay(list.reduce((a, q) => a + microOf(q), 0n));
}
