"use client";
// Sipariş ekranları istemci takımı (T-314): sipariş listesi + oluşturma formu + toplama görevlendirmesi (OrdersView) ve sipariş ayrıntısı (OrderDetailView).
// - Kurallar sunucuda/domain'dedir: yetki (`document.create` / `document.approve`), kapsam, durum, rezervasyon ve iptal kuralları burada YENİDEN YAZILMAZ. `canCreate` /
//   `canApprove` yalnızca gösterimdir (kilit + gerekçe + yol); eylem sunucuda yeniden denetlenir ve sunucu reddi neden + sonraki eylemle gösterilir (FORBIDDEN ekranı yok).
// - Anahtar yaşam döngüsü (ADR-018 §1-3; receipts/receipt-form.tsx `createKeyHolder` ile aynı): her niyet (işlem + hedef + içerik imzası) kendi anahtarını taşır;
//   ağ/geçici hatada AYNI anahtarla yeniden gönderilir (çift gönderimde tekrar oynatılır), başarıdan sonra yenilenir, içerik değişince (imza değişir) yeni anahtar.
// - Geri bildirim eylemin YANINDA gösterilir (satır/panel içinde ya da eylem bölümünde), `role=alert|status` taşır ve odak ona taşınır (`Notice`). Doğrulama
//   alanın altında neden + eylemle yazılır (`TextField error`); düğme doğrulama yüzünden kapatılmaz.
// - Terim: rezervasyon ailesi tek terimle yazılır (Rezerve et / Rezerve / Rezerve edilemeyen; docs/GLOSSARY.md "Rezervasyon"); "tahsis/ayırma" kullanılmaz (A-314-8).
// - Yatay taşma yok: liste ve satırlar kart düzenindedir (tablo yok); sayfa başına ≤30 sipariş (keyset). TanStack Virtual bağımlılığı bu pakette kurulu
//   değildir (A-314-5); büyük listeye karşı sayfalama kullanılır.
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Banner, Button, CircleAlert, CircleCheck, Clock, ConfirmDialog, EmptyState, Lock, PackagePlus, TextField, TriangleAlert } from "@wms/ui";
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
// Oluşturulan siparişin numarası (A-314a-2): kapsamlı kullanıcı yeni siparişi okuyamayabilir; numara oluşturma YANITINDAN gelir ve oturumda tutulur.
// Metin yalnızca oluşturma eyleminin döndürdüğü kimlikle eşleşince gösterilir (URL parametresine güvenilmez).
// ---------------------------------------------------------------------------------------------------------------------
const CREATED_KEY = "wms.orders.created";
export function rememberCreated(created: { readonly id: string; readonly number: string }): void {
  try {
    sessionStorage.setItem(CREATED_KEY, JSON.stringify({ id: created.id.toLowerCase(), number: created.number }));
  } catch {
    // depolama kapalı: yalnızca numara ipucu kaybolur, akış sürer
  }
}
/** Kimlik eşleşirse numarayı döndürür; `consume` ise kaydı siler. */
export function createdNumberOf(id: string, consume: boolean): string | null {
  try {
    const raw = sessionStorage.getItem(CREATED_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as { id?: unknown; number?: unknown };
    if (typeof v.id !== "string" || typeof v.number !== "string" || v.id !== id.toLowerCase()) return null;
    if (consume) sessionStorage.removeItem(CREATED_KEY);
    return v.number;
  } catch {
    return null;
  }
}

const RESERVED_KEY = "wms.orders.reserved.";
/** Bu siparişte rezervasyon denendi (oturum): yenilemede "rezerve edilemeyen" durumunu doğru göstermek için; kural değil, yalnız gösterim ipucu. */
export function rememberReserved(orderId: string): void {
  try {
    sessionStorage.setItem(`${RESERVED_KEY}${orderId.toLowerCase()}`, "1");
  } catch {
    // depolama kapalı: yalnız yenileme sonrası ipucu kaybolur
  }
}
export function reserveAttempted(orderId: string): boolean {
  try {
    return sessionStorage.getItem(`${RESERVED_KEY}${orderId.toLowerCase()}`) === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hata eşlemesi (kural yeniden yazılmaz; yalnızca ileti seçilir)
// ---------------------------------------------------------------------------------------------------------------------
export type OrderErrorContext = "create" | "reserve" | "cancel" | "assign" | "lookup";

/**
 * Sunucu hatası → `orders.errors.<anahtar>` (+ `Action`). `INSUFFICIENT_STOCK` elle rezervede "rezerve edilemeyen miktar"dır; otomatik rezervasyonda yetersiz stok RET
 * DEĞİLDİR (T-306): satır rezervesiz kalır ve ekran bunu satırda gösterir. `DOCUMENT_STATE` = sipariş artık açık değil.
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
      if (detail === undefined && context === "create") return "create_invalid";
      return "validation_failed";
    default:
      return "internal";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Geri bildirim bileşenleri: eylemin yanında, rol + odak
// ---------------------------------------------------------------------------------------------------------------------
type Tone = "success" | "warning" | "info" | "error";
/** Geri bildirim kutusu: bağlandığında (ve `seq` değişince) odak ona taşınır; içeride `role=status|alert` taşıyan `Banner` vardır. */
function Notice({ kind, seq = 0, testId, children }: { kind: Tone; seq?: number; testId?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [seq]);
  return (
    <div ref={ref} tabIndex={-1} data-testid={testId} className="min-w-0 rounded-card focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus">
      <Banner kind={kind}>{children}</Banner>
    </div>
  );
}

interface ErrState {
  readonly info: ErrorInfo;
  readonly ctx: OrderErrorContext;
  readonly seq: number;
}
function ErrorNotice({ error }: { error: ErrState }) {
  const t = useTranslations("orders");
  const key = orderErrorKey(error.info, error.ctx);
  return (
    <Notice kind="error" seq={error.seq} testId="error-notice">
      <p className="font-semibold" data-testid="error-reason">
        {t(`errors.${key}`)}
      </p>
      <p data-testid="error-action">{t(`errors.${key}Action`)}</p>
      <details className="mt-1 text-sm">
        <summary className="flex min-h-12 cursor-pointer items-center">{t("moreInfo")}</summary>
        <p data-testid="error-code">{t("errorCode", { code: error.info.detail === undefined ? error.info.code : `${error.info.code}/${error.info.detail}` })}</p>
        {error.info.requestId === undefined ? null : <p className="break-all">{error.info.requestId}</p>}
      </details>
    </Notice>
  );
}

/** Alan altı doğrulama iletisi (neden + eylem; `TextField error` ile aynı görünüm) — alanı olmayan bölüm düzeyi doğrulama için. */
function FieldMsg({ reason, action, testId }: { reason: string; action: string; testId?: string }) {
  return (
    <p role="alert" data-testid={testId} className="m-0 flex items-start gap-1 break-words text-sm font-medium text-danger-ink">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <span className="min-w-0">
        {reason} {action}
      </span>
    </p>
  );
}

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const LINK_BTN = `inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink ${FOCUS}`;
const SELECT = `min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-3 text-base text-ink disabled:opacity-60 ${FOCUS}`;

function LockedNote({ text, testId }: { text: string; testId: string }) {
  const t = useTranslations("orders");
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <p className="m-0 flex min-w-0 items-start gap-2 text-base text-ink">
        <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <span className="min-w-0 break-words">{text}</span>
      </p>
      <Link href="/help" className={`${LINK_BTN} w-fit`} data-testid="help-link">
        {t("helpCall")}
      </Link>
    </div>
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
/** Kalan − rezerve (yalnız gösterim: "rezerve edilemeyen" rozeti). Negatif → 0. */
export function unallocatedOf(open: string, allocated: string): bigint {
  const d = microOf(open) - microOf(allocated);
  return d < 0n ? 0n : d;
}
function fromMicroDisplay(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}
/** Ondalık dizgilerin toplamı (1e-6 ölçeği, BigInt; float yok). */
export function sumQuantities(list: readonly string[]): string {
  return fromMicroDisplay(list.reduce((a, q) => a + microOf(q), 0n));
}
export type ReserveOutcome = "full" | "partial" | "none" | "nothing";
/** Rezervasyon sonucu: bu çağrıda rezerve edilen toplam ve (yenilenmiş veriden) rezerve edilemeyen satır sayısı → ileti türü. Sahte "tamamlandı" yok. */
export function reserveOutcome(total: bigint, shortCount: number): ReserveOutcome {
  if (total > 0n) return shortCount === 0 ? "full" : "partial";
  return shortCount > 0 ? "none" : "nothing";
}

const STATUS_TONE: Record<OrderStatus, string> = {
  OPEN: "bg-info-bg text-info-ink",
  CLOSED: "bg-success-bg text-success-ink",
  CANCELLED: "bg-danger-bg text-danger-ink",
};
/** Miktar: tam sayı (ondalık istemcide reddedilir; ölçek denetimi ayrıca domain'dedir). */
const QTY_RE = /^[1-9]\d{0,8}$/;
export const validQty = (q: string): boolean => QTY_RE.test(q);
/** Yazılan miktar kırpılmaz/sessizce değiştirilmez (ondalık "1.5" → "15" olmaz); geçersizse alan altında neden + eylem gösterilir. */
const digits = (v: string): string => v.slice(0, 12);

/** Sarmalayıcı içindeki ilk alana odak (TextField ref iletmez). */
function focusIn(el: HTMLElement | null): void {
  el?.querySelector<HTMLElement>("input, select, textarea")?.focus();
}
const afterRender = (fn: () => void): void => {
  requestAnimationFrame(() => requestAnimationFrame(fn));
};

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
  /** Bozuk sayfa bağlantısı (`after`) yüzünden ilk sayfa gösteriliyor. */
  readonly badCursor?: boolean;
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
type SearchProblem = { readonly kind: "none" } | { readonly kind: "error"; readonly info: ErrorInfo };
type AssignResult = { readonly groupId: string | null; readonly taskCount: number; readonly assigned: boolean; readonly seq: number };

export function OrdersView({ slug, orders, nextHref, statusFilter, assignees, canCreate, canApprove, badCursor = false }: OrdersViewProps) {
  const t = useTranslations("orders");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const keyFor = useKeyFor();
  const seq = useRef(0);
  const [customerRef, setCustomerRef] = useState("");
  const [lines, setLines] = useState<readonly DraftLine[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<readonly Found[]>([]);
  const [problem, setProblem] = useState<SearchProblem | null>(null);
  const [noLines, setNoLines] = useState(false);
  const [picked, setPicked] = useState<(Found & { units: readonly UnitOption[] }) | null>(null);
  const [unitId, setUnitId] = useState("");
  const [qty, setQty] = useState("");
  const [qtyBad, setQtyBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<ErrState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [assignee, setAssignee] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [assignResult, setAssignResult] = useState<AssignResult | null>(null);
  const [assignError, setAssignError] = useState<ErrState | null>(null);
  const searchToken = useRef(0);
  const itemRef = useRef<HTMLDivElement>(null);
  const qtyRef = useRef<HTMLDivElement>(null);

  const base = `/t/${encodeURIComponent(slug)}/orders`;
  const nextSeq = (): number => ++seq.current;
  // Seçim yalnız ŞU AN görünen açık siparişleri sayar: süzgeç/sayfa değişince görünmeyen seçim sayılmaz ve temizlenir (SR-MINOR-3).
  const visibleOpen = new Set(orders.filter((o) => o.status === "OPEN").map((o) => o.id));
  const sel = new Set([...selected].filter((id) => visibleOpen.has(id)));
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => visibleOpen.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [orders]);

  async function search(q: string) {
    setQuery(q);
    setNoLines(false);
    const token = ++searchToken.current;
    if (q.trim().length < 1) {
      setFound([]);
      setProblem(null);
      return;
    }
    try {
      const r = await searchItemsAction({ slug, q: q.trim(), limit: 5 });
      if (token !== searchToken.current) return;
      if (!r.ok) {
        setFound([]);
        setProblem({ kind: "error", info: { code: r.error.code, detail: r.error.detail, requestId: r.error.requestId } });
        return;
      }
      setFound(r.data.items);
      setProblem(r.data.items.length === 0 ? { kind: "none" } : null);
    } catch {
      if (token !== searchToken.current) return;
      setFound([]);
      setProblem({ kind: "error", info: { code: "NETWORK" } });
    }
  }
  async function pick(f: Found) {
    setFound([]);
    setQuery(f.name);
    try {
      const r = await itemUnitsAction({ slug, itemId: f.id });
      if (!r.ok) {
        setProblem({ kind: "error", info: { code: r.error.code, detail: r.error.detail, requestId: r.error.requestId } });
        return;
      }
      setPicked({ ...f, units: r.data.units });
      setUnitId(r.data.units[0]?.unitId ?? "");
      setProblem(null);
      afterRender(() => focusIn(qtyRef.current));
    } catch {
      setProblem({ kind: "error", info: { code: "NETWORK" } });
    }
  }
  function addLine() {
    const unit = picked?.units.find((u) => u.unitId === unitId);
    if (picked === null || unit === undefined) return;
    if (!validQty(qty)) {
      setQtyBad(true);
      focusIn(qtyRef.current);
      return;
    }
    setCreateError(null);
    setLines((l) => [...l, { itemId: picked.id, itemName: picked.name, unitId: unit.unitId, unitName: unit.unitName || unit.unitCode, quantity: qty }]);
    setPicked(null);
    setQuery("");
    setQty("");
    setQtyBad(false);
    setNoLines(false);
    afterRender(() => focusIn(itemRef.current));
  }
  async function submitCreate() {
    if (busy) return;
    if (lines.length === 0) {
      setNoLines(true);
      focusIn(itemRef.current);
      return;
    }
    setBusy(true);
    setCreateError(null);
    const payload = { customerRef: customerRef.trim(), lines: lines.map((l) => ({ itemId: l.itemId, unitId: l.unitId, quantity: l.quantity })) };
    const holder = keyFor(`create:${JSON.stringify(payload)}`);
    const out = await submitWithKey(holder, (clientKey) =>
      createOrderAction({ slug, clientKey, ...(payload.customerRef === "" ? {} : { customerRef: payload.customerRef }), lines: payload.lines }),
    );
    if (!out.ok) {
      setBusy(false);
      setCreateError({ info: out.error, ctx: "create", seq: nextSeq() });
      return;
    }
    // A-314a-2: kapsamlı kullanıcı yeni siparişi listede/ayrıntıda göremeyebilir → numara oluşturma yanıtından saklanır, doğrudan ayrıntıya gidilir.
    rememberCreated({ id: out.data.orderId, number: out.data.number });
    router.push(`${base}/${encodeURIComponent(out.data.orderId)}`);
  }
  function toggle(id: string) {
    setAssignResult(null);
    setAssignError(null);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  async function submitAssign() {
    if (busy || sel.size === 0) return;
    setBusy(true);
    setAssignError(null);
    const ids = [...sel].sort();
    const holder = keyFor(`assign:${ids.join(",")}:${assignee}`);
    const out = await submitWithKey(holder, (clientKey) =>
      createPickAssignmentAction({ slug, clientKey, orderIds: ids, ...(assignee === "" ? {} : { assigneeMembershipId: assignee }) }),
    );
    setBusy(false);
    setConfirm(false);
    if (!out.ok) {
      setAssignError({ info: out.error, ctx: "assign", seq: nextSeq() });
      return;
    }
    setAssignResult({ groupId: out.data.groupId, taskCount: out.data.taskCount, assigned: assignee !== "", seq: nextSeq() });
    setSelected(new Set());
    startTransition(() => router.refresh());
  }

  const filters: readonly (OrderStatus | "ALL")[] = ["OPEN", "CLOSED", "CANCELLED", "ALL"];
  const assigneeName = assignees.find((a) => a.membershipId === assignee)?.displayName ?? "";
  const itemProblem =
    problem?.kind === "error"
      ? { reason: t(`errors.${orderErrorKey(problem.info, "lookup")}`), action: t(`errors.${orderErrorKey(problem.info, "lookup")}Action`) }
      : problem?.kind === "none"
        ? { reason: t("form.itemNoneReason"), action: t("form.itemNoneAction") }
        : noLines
          ? { reason: t("form.noLinesReason"), action: t("form.noLinesAction") }
          : undefined;
  // Sayfa başına TEK birincil: seçim varken görevlendirme; yoksa siparişi kaydet.
  const assignPrimary = sel.size > 0;
  const chosen = orders.filter((o) => sel.has(o.id)).map((o) => o.number);
  const numbersText = `${chosen.slice(0, 8).join(", ")}${chosen.length > 8 ? ` ${t("assign.more", { n: chosen.length - 8 })}` : ""}`;
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
      <div className="flex min-w-0 flex-wrap gap-2 lg:col-span-2">
        <a href="#orders-list" className={`sr-only focus:not-sr-only ${LINK_BTN}`}>
          {t("skipList")}
        </a>
        {canApprove ? (
          <a href="#assign-bar" className={`sr-only focus:not-sr-only ${LINK_BTN}`}>
            {t("skipAssign")}
          </a>
        ) : null}
        <a href="#order-new" className={`sr-only focus:not-sr-only ${LINK_BTN}`}>
          {t("skipForm")}
        </a>
      </div>
      <section aria-labelledby="orders-list" className="flex min-w-0 flex-col gap-3">
        <h2 id="orders-list" tabIndex={-1} className="text-xl font-bold text-ink outline-none">
          {t("list.title")}
        </h2>
        <nav aria-label={t("list.filter")} className="flex min-w-0 flex-wrap gap-2">
          {filters.map((f) => {
            const on = f === statusFilter;
            return (
              <Link
                key={f}
                href={`${base}?status=${f}`}
                aria-current={on ? "page" : undefined}
                data-selected={on}
                className={`inline-flex min-h-12 min-w-12 items-center justify-center gap-1 rounded-control border-2 px-4 text-base font-bold ${FOCUS} ${
                  on ? "border-accent bg-info-bg text-info-ink" : "border-border-strong bg-surface text-ink"
                }`}
                data-testid={`filter-${f}`}
              >
                {on ? <CircleCheck aria-hidden="true" className="size-4" /> : null}
                {t(`filter.${f}`)}
              </Link>
            );
          })}
        </nav>
        {badCursor ? (
          <Banner kind="warning">
            <p className="font-semibold" data-testid="bad-cursor">
              {t("list.badCursor")}
            </p>
            <p>{t("list.badCursorAction")}</p>
          </Banner>
        ) : null}
        {canApprove ? (
          <div id="assign-bar" tabIndex={-1} className="sticky top-0 z-10 flex min-w-0 flex-col gap-2 rounded-card border-2 border-border-strong bg-surface p-3 outline-none focus-visible:outline-3 focus-visible:outline-focus" data-testid="assign-bar">
            <p className="m-0 text-base font-semibold text-ink" aria-live="polite">
              {sel.size === 0 ? t("assign.idle") : t("assign.selected", { n: sel.size })}
            </p>
            {assignees.length === 0 ? (
              <p className="m-0 text-sm text-ink-muted">{t("assign.noAssignees")}</p>
            ) : (
              <label className="flex min-w-0 flex-col gap-1 text-base font-semibold text-ink">
                {t("assign.picker")}
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={sel.size === 0} className={SELECT} data-testid="assign-picker">
                  <option value="">{t("assign.anyone")}</option>
                  {assignees.map((a) => (
                    <option key={a.membershipId} value={a.membershipId}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
                <span className="text-sm font-normal text-ink-muted">{t("assign.pickerHint")}</span>
              </label>
            )}
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button variant={assignPrimary ? "primary" : "secondary"} disabled={busy || sel.size === 0} onClick={() => setConfirm(true)} data-testid="assign-open">
                {t("assign.create")}
              </Button>
              {sel.size === 0 ? null : (
                <Button variant="secondary" disabled={busy} onClick={() => setSelected(new Set())} data-testid="assign-clear">
                  {t("assign.clear")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <LockedNote text={t("assign.locked")} testId="assign-locked" />
        )}
        {assignResult === null ? null : assignResult.groupId === null ? (
          <Notice kind="warning" seq={assignResult.seq} testId="assign-none">
            <p className="font-semibold">{t("assign.noneTitle")}</p>
            <p>{t("assign.noneAction")}</p>
          </Notice>
        ) : (
          <Notice kind="success" seq={assignResult.seq} testId="assign-done">
            <p>{t(assignResult.assigned ? "assign.doneAssigned" : "assign.doneOpen", { n: assignResult.taskCount })}</p>
          </Notice>
        )}
        {assignError === null ? null : <ErrorNotice error={assignError} />}
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
                      checked={sel.has(o.id)}
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
        <h2 id="order-new" tabIndex={-1} className="text-xl font-bold text-ink outline-none">
          {t("form.title")}
        </h2>
        {!canCreate ? (
          <LockedNote text={t("form.locked")} testId="create-locked" />
        ) : (
          <form
            className="flex min-w-0 flex-col gap-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreate();
            }}
          >
            <p className="m-0 text-sm text-ink-muted">{t("form.scopeHint")}</p>
            {createError === null ? null : <ErrorNotice error={createError} />}
            <TextField
              label={t("form.customerRef")}
              hint={t("form.customerRefHint")}
              value={customerRef}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => {
                setCustomerRef(e.target.value);
                setCreateError(null);
              }}
            />
            {lines.length === 0 ? null : (
              <ul aria-label={t("form.lines")} className="m-0 flex list-none flex-col gap-2 p-0" data-testid="draft-lines">
                {lines.map((l, i) => (
                  <li key={`${l.itemId}-${i}`} className="flex min-w-0 items-center justify-between gap-2 rounded-card bg-bg px-3 py-2">
                    <span className="min-w-0 break-words text-base text-ink">
                      {l.itemName} · {l.quantity} {l.unitName}
                    </span>
                    <Button
                      variant="secondary"
                      aria-label={t("form.removeLine", { name: l.itemName })}
                      onClick={() => {
                        setCreateError(null);
                        setLines((x) => x.filter((_, j) => j !== i));
                        afterRender(() => focusIn(itemRef.current));
                      }}
                    >
                      {t("form.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-dashed border-border p-3">
              <div ref={itemRef} className="min-w-0">
                <TextField label={t("form.item")} hint={t("form.itemHint")} value={query} autoComplete="off" required aria-required="true" error={itemProblem} onChange={(e) => void search(e.target.value)} />
              </div>
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
                  <div ref={qtyRef} className="min-w-0">
                    <TextField
                      label={t("form.quantity")}
                      hint={t("form.quantityHint")}
                      inputMode="numeric"
                      required
                      aria-required="true"
                      value={qty}
                      error={qtyBad || (qty !== "" && !validQty(qty)) ? { reason: t("form.qtyReason"), action: t("form.qtyAction") } : undefined}
                      onChange={(e) => {
                        setQty(digits(e.target.value));
                        setQtyBad(false);
                      }}
                    />
                  </div>
                  <Button variant="secondary" onClick={addLine}>
                    {t("form.addLine")}
                  </Button>
                </>
              )}
            </div>
            <Button type="submit" variant={assignPrimary ? "secondary" : "primary"} loading={busy} data-testid="create-submit">
              {t("form.save")}
            </Button>
          </form>
        )}
      </section>
      <ConfirmDialog
        open={confirm}
        title={t("assign.confirmTitle")}
        description={t(assignee === "" ? "assign.confirmBodyOpen" : "assign.confirmBody", { n: sel.size, numbers: numbersText, name: assigneeName })}
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
interface LineErr extends ErrState {
  readonly lineId: string;
}

const METRICS = ["requested", "allocated", "picked", "shipped", "open", "returned", "cancelled"] as const;

export function OrderDetailView({ slug, order, canApprove }: OrderDetailViewProps) {
  const t = useTranslations("orders");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const keyFor = useKeyFor();
  const seq = useRef(0);
  const nextSeq = (): number => ++seq.current;
  const [busy, setBusy] = useState(false);
  const [createdNumber, setCreatedNumber] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [reserved, setReserved] = useState<{ total: bigint; lineId: string | null; seq: number } | null>(null);
  const [actionError, setActionError] = useState<ErrState | null>(null);
  const [actionDone, setActionDone] = useState<string | null>(null);
  const [lineError, setLineError] = useState<LineErr | null>(null);
  const [lineNote, setLineNote] = useState<{ lineId: string; text: string; seq: number } | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [cancelQty, setCancelQty] = useState("");
  const [qtyTouched, setQtyTouched] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [stock, setStock] = useState<{ rows: readonly StockRow[]; truncated: boolean } | null>(null);
  const [alloc, setAlloc] = useState<Readonly<Record<number, string>>>({});
  const [allocNone, setAllocNone] = useState(false);
  const [confirmOrder, setConfirmOrder] = useState(false);
  const [orderReason, setOrderReason] = useState("");
  const [orderReasonTouched, setOrderReasonTouched] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const orderPanelRef = useRef<HTMLElement>(null);

  // A-314a-2: oluşturma yanıtından gelen numara (yalnızca bu siparişin kimliğiyle eşleşirse) bir kez gösterilir.
  useEffect(() => {
    setCreatedNumber(createdNumberOf(order.id, true));
    // Yenilemede de doğru durum: bu siparişte rezervasyon denendiyse (oturum belleği) rezerve edilemeyen satırlar işaretli kalır.
    setAttempted(reserveAttempted(order.id));
  }, [order.id]);
  // Panel açılınca (ve rafları yüklenince) ilk alana odak.
  useEffect(() => {
    if (panel !== null) focusIn(panelRef.current);
  }, [panel, stock]);
  useEffect(() => {
    if (confirmOrder) focusIn(orderPanelRef.current);
  }, [confirmOrder]);

  const isOpen = order.status === "OPEN";
  const base = `/t/${encodeURIComponent(slug)}/orders`;
  const refresh = (): void => startTransition(() => router.refresh());
  /** Rezerve edilemeyen satır: kalan > rezerve VE (bu ekranda rezervasyon denendi ya da satırda kısmi rezerve var). Yalnız gösterim. */
  const isShort = (l: OrderLine): boolean => isOpen && microOf(l.open) > 0n && unallocatedOf(l.open, l.allocated) > 0n && (attempted || microOf(l.allocated) > 0n);
  const shortLines = order.lines.filter(isShort);
  /** Her eylemin iletisi yalnız o eylemde yazılır/odak alır: yeni eylem başlayınca eski iletiler (kaydedildi, rezervasyon, iptal, hata) temizlenir. */
  const clearFeedback = (): void => {
    setCreatedNumber(null);
    setReserved(null);
    setLineNote(null);
    setActionDone(null);
    setActionError(null);
    setLineError(null);
  };

  async function reserve(overrides?: { lineId: string; allocations: { dimension: StockRow["dimension"]; quantity: string }[] }[], lineId: string | null = null) {
    if (busy) return;
    setBusy(true);
    clearFeedback();
    const holder = keyFor(`reserve:${order.id}:${JSON.stringify(overrides ?? null)}`);
    const out = await submitWithKey(holder, (clientKey) => reserveOrderAction({ slug, clientKey, orderId: order.id, ...(overrides === undefined ? {} : { overrides }) }));
    setBusy(false);
    if (!out.ok) {
      if (lineId === null) setActionError({ info: out.error, ctx: "reserve", seq: nextSeq() });
      else setLineError({ lineId, info: out.error, ctx: "reserve", seq: nextSeq() });
      return;
    }
    setAttempted(true);
    rememberReserved(order.id);
    setReserved({ total: out.data.lines.reduce((a, l) => a + microOf(l.quantity), 0n), lineId, seq: nextSeq() });
    setPanel(null);
    setStock(null);
    setAlloc({});
    refresh();
  }
  /** Rezervasyon sonucu bildirimi (yenilenmiş veriden; yenilenirken gösterilmez). */
  function outcomeNotice() {
    if (reserved === null || pending) return null;
    const kind = reserveOutcome(reserved.total, shortLines.length);
    const total = fromMicroDisplay(reserved.total);
    const tone: Tone = kind === "full" ? "success" : kind === "nothing" ? "info" : "warning";
    return (
      <Notice kind={tone} seq={reserved.seq} testId="reserve-result">
        <p className="font-semibold" data-testid={kind === "full" ? "reserve-done" : `reserve-${kind}`}>
          {t(`reserve.${kind === "nothing" ? "nothingNew" : kind}`, { total, n: shortLines.length })}
        </p>
        {kind === "partial" || kind === "none" ? <p>{t("reserve.shortAction")}</p> : kind === "nothing" ? <p>{t("reserve.nothingNewAction")}</p> : null}
      </Notice>
    );
  }
  async function openManual(line: OrderLine) {
    setPanel({ lineId: line.id, kind: "manual" });
    setStock(null);
    setAlloc({});
    setAllocNone(false);
    clearFeedback();
    try {
      const r = await lineStockAction({ slug, itemId: line.itemId });
      if (!r.ok) {
        setLineError({ lineId: line.id, info: { code: r.error.code, detail: r.error.detail, requestId: r.error.requestId }, ctx: "lookup", seq: nextSeq() });
        return;
      }
      setStock({ rows: r.data.rows, truncated: r.data.truncated });
    } catch {
      setLineError({ lineId: line.id, info: { code: "NETWORK" }, ctx: "lookup", seq: nextSeq() });
    }
  }
  async function submitManual(line: OrderLine) {
    if (stock === null || busy) return;
    const entered = stock.rows.map((_, i) => (alloc[i] ?? "").trim());
    const bad = entered.findIndex((q) => q !== "" && !validQty(q));
    if (bad >= 0) {
      setAllocNone(false);
      panelRef.current?.querySelectorAll<HTMLInputElement>("input")[bad]?.focus();
      return;
    }
    const allocations = stock.rows.flatMap((r, i) => (validQty(entered[i] as string) ? [{ dimension: r.dimension, quantity: entered[i] as string }] : []));
    if (allocations.length === 0) {
      setAllocNone(true);
      focusIn(panelRef.current);
      return;
    }
    setAllocNone(false);
    await reserve([{ lineId: line.id, allocations }], line.id);
  }
  function openCancel(line: OrderLine) {
    setPanel({ lineId: line.id, kind: "cancel" });
    setCancelQty(fmtQty(line.open));
    setQtyTouched(false);
    setReason("");
    setReasonTouched(false);
    clearFeedback();
  }
  async function submitCancelLine(line: OrderLine) {
    if (busy) return;
    if (!validQty(cancelQty)) {
      setQtyTouched(true);
      panelRef.current?.querySelectorAll<HTMLInputElement>("input")[0]?.focus();
      return;
    }
    if (reason.trim() === "") {
      setReasonTouched(true);
      panelRef.current?.querySelectorAll<HTMLInputElement>("input")[1]?.focus();
      return;
    }
    setBusy(true);
    clearFeedback();
    const holder = keyFor(`cancel-line:${line.id}:${cancelQty}:${reason.trim()}`);
    const out = await submitWithKey(holder, (clientKey) => cancelOrderLineAction({ slug, clientKey, lineId: line.id, quantity: cancelQty, reason: reason.trim() }));
    setBusy(false);
    if (!out.ok) {
      setLineError({ lineId: line.id, info: out.error, ctx: "cancel", seq: nextSeq() });
      return;
    }
    setLineNote({ lineId: line.id, text: t("cancel.lineDone", { no: line.lineNo }), seq: nextSeq() });
    setPanel(null);
    refresh();
  }
  async function submitCancelOrder() {
    if (busy) return;
    if (orderReason.trim() === "") {
      setOrderReasonTouched(true);
      focusIn(orderPanelRef.current);
      return;
    }
    setBusy(true);
    clearFeedback();
    const holder = keyFor(`cancel-order:${order.id}:${order.version}:${orderReason.trim()}`);
    const out = await submitWithKey(holder, (clientKey) => cancelOrderAction({ slug, clientKey, orderId: order.id, expectedVersion: order.version, reason: orderReason.trim() }));
    setBusy(false);
    if (!out.ok) {
      setActionError({ info: out.error, ctx: "cancel", seq: nextSeq() });
      return;
    }
    setConfirmOrder(false);
    setActionDone(t("cancel.orderDone", { number: order.number }));
    refresh();
  }

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

      {createdNumber === null ? null : (
        <Notice kind="success" testId="created-note">
          <p data-testid="created-text">{t("detail.created", { number: createdNumber })}</p>
          {isOpen ? <p>{t("detail.createdNext")}</p> : null}
        </Notice>
      )}

      <ul aria-label={t("detail.lines")} className="m-0 flex list-none flex-col gap-3 p-0" data-testid="order-lines">
        {order.lines.map((l) => {
          const short = unallocatedOf(l.open, l.allocated);
          const lineOpen = isOpen && microOf(l.open) > 0n;
          const showShort = isShort(l);
          const here = panel !== null && panel.lineId === l.id ? panel.kind : null;
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
              {showShort ? (
                <p className="m-0 flex min-w-0 items-start gap-2 text-base font-semibold text-warning-ink" data-testid="line-short">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                  <span className="min-w-0 break-words">{t("detail.lineShort", { n: fromMicroDisplay(short) })}</span>
                </p>
              ) : null}
              {lineNote !== null && lineNote.lineId === l.id ? (
                <Notice kind="success" seq={lineNote.seq} testId="cancel-done">
                  <p>{lineNote.text}</p>
                </Notice>
              ) : null}
              {reserved !== null && reserved.lineId === l.id ? outcomeNotice() : null}
              {lineOpen && canApprove ? (
                <div className="flex min-w-0 flex-wrap gap-2">
                  {showShort ? (
                    <Button variant="secondary" disabled={busy} onClick={() => void openManual(l)} data-testid="manual-open">
                      {t("manual.open")}
                    </Button>
                  ) : null}
                  <Button variant="secondary" disabled={busy} onClick={() => openCancel(l)} data-testid="cancel-line-open">
                    {t("cancel.lineOpen")}
                  </Button>
                </div>
              ) : null}
              {here === "cancel" ? (
                <div ref={panelRef} className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border-strong p-3" data-testid="cancel-panel">
                  <h4 className="m-0 text-base font-bold text-ink">{t("cancel.lineTitle", { no: l.lineNo })}</h4>
                  <TextField
                    label={t("cancel.quantity")}
                    hint={t("cancel.quantityHint", { open: fmtQty(l.open) })}
                    inputMode="numeric"
                    value={cancelQty}
                    error={qtyTouched || (cancelQty !== "" && !validQty(cancelQty)) ? { reason: t("form.qtyReason"), action: t("form.qtyAction") } : undefined}
                    onChange={(e) => {
                      setCancelQty(digits(e.target.value));
                      setQtyTouched(false);
                    }}
                  />
                  <TextField
                    label={t("cancel.reason")}
                    hint={t("cancel.reasonHint")}
                    value={reason}
                    maxLength={500}
                    autoComplete="off"
                    required
                    aria-required="true"
                    error={reasonTouched && reason.trim() === "" ? { reason: t("cancel.reasonMissingReason"), action: t("cancel.reasonMissingAction") } : undefined}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Button variant="danger" loading={busy} onClick={() => void submitCancelLine(l)} data-testid="cancel-line-submit">
                      {t("cancel.lineSubmit")}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setPanel(null)}>
                      {t("dismiss")}
                    </Button>
                  </div>
                  {lineError !== null && lineError.lineId === l.id ? <ErrorNotice error={lineError} /> : null}
                </div>
              ) : null}
              {here === "manual" ? (
                <div ref={panelRef} className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border-strong p-3" data-testid="manual-panel">
                  <h4 className="m-0 text-base font-bold text-ink">{t("manual.title", { no: l.lineNo })}</h4>
                  <p className="m-0 text-sm text-ink-muted">{t("manual.hint", { n: fromMicroDisplay(short) })}</p>
                  <p className="m-0 text-sm text-ink-muted">{t("manual.sideEffect")}</p>
                  {stock === null ? (
                    lineError !== null && lineError.lineId === l.id ? null : <p className="m-0 text-base text-ink-muted">{t("manual.loading")}</p>
                  ) : stock.rows.length === 0 ? (
                    <p className="m-0 text-base text-ink" data-testid="manual-empty">
                      {t("manual.empty")}
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {stock.rows.map((r, i) => {
                        const v = (alloc[i] ?? "").trim();
                        return (
                          <li key={`${r.dimension.locationId}-${i}`} className="flex min-w-0 flex-col gap-1 border-t border-border pt-2">
                            <span className="break-words text-base font-semibold text-ink">
                              {r.warehouseCode} · {r.locationCode}
                              {r.lotCode === null ? "" : ` · ${t("manual.lot", { code: r.lotCode })}`}
                              {r.serialNo === null ? "" : ` · ${t("manual.serial", { no: r.serialNo })}`}
                            </span>
                            <span className="text-sm text-ink-muted">{t("manual.available", { n: fmtQty(r.available) })}</span>
                            <TextField
                              label={t("manual.quantity")}
                              inputMode="numeric"
                              value={alloc[i] ?? ""}
                              error={v !== "" && !validQty(v) ? { reason: t("form.qtyReason"), action: t("form.qtyAction") } : undefined}
                              onChange={(e) => {
                                setAllocNone(false);
                                setAlloc((a) => ({ ...a, [i]: digits(e.target.value) }));
                              }}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {stock?.truncated === true ? <p className="m-0 text-sm text-ink-muted">{t("manual.truncated")}</p> : null}
                  {allocNone ? <FieldMsg reason={t("manual.noneReason")} action={t("manual.noneAction")} testId="manual-none" /> : null}
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Button variant="secondary" loading={busy} disabled={stock === null || stock.rows.length === 0} onClick={() => void submitManual(l)} data-testid="manual-submit">
                      {t("manual.submit")}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setPanel(null)}>
                      {t("dismiss")}
                    </Button>
                  </div>
                  {lineError !== null && lineError.lineId === l.id ? <ErrorNotice error={lineError} /> : null}
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
        {actionDone === null ? null : (
          <Notice kind="success" testId="cancel-order-done">
            <p>{actionDone}</p>
          </Notice>
        )}
        {reserved !== null && reserved.lineId === null ? outcomeNotice() : null}
        {actionError === null ? null : <ErrorNotice error={actionError} />}
        {!isOpen ? (
          <p className="m-0 text-base text-ink-muted" data-testid="order-closed">
            {t("actions.closed")}
          </p>
        ) : canApprove ? (
          <>
            <p className="m-0 text-base text-ink">{t("reserve.explain")}</p>
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
        <section ref={orderPanelRef} className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-danger bg-surface p-4" data-testid="cancel-order-panel" aria-labelledby="cancel-order-title">
          <h2 id="cancel-order-title" className="text-xl font-bold text-ink">
            {t("cancel.orderTitle", { number: order.number })}
          </h2>
          <p className="m-0 text-base text-ink">{t("cancel.orderBody")}</p>
          <TextField
            label={t("cancel.reason")}
            hint={t("cancel.reasonHint")}
            value={orderReason}
            maxLength={500}
            autoComplete="off"
            required
            aria-required="true"
            error={orderReasonTouched && orderReason.trim() === "" ? { reason: t("cancel.reasonMissingReason"), action: t("cancel.reasonMissingAction") } : undefined}
            onChange={(e) => setOrderReason(e.target.value)}
          />
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button variant="danger" loading={busy} onClick={() => void submitCancelOrder()} data-testid="cancel-order-submit">
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

/**
 * Okunamayan sipariş paneli (A-314a-2): sipariş yok / başka depo / yeni oluşturulup henüz rezerve edilmediği için kapsamlı kullanıcıya görünmüyor.
 * Oluşturma eyleminin döndürdüğü kimlikle eşleşirse sipariş numarası ve sonraki eylem gösterilir; eşleşmezse genel açıklama.
 */
export function OrderHiddenNotice() {
  const t = useTranslations("orders");
  // Kimlik yoldan okunur (prop değil): sunucu çıktısı var olmayan / başka tenant / kapsam dışı kimlikler için birebir aynıdır.
  const orderId = String(useParams<{ orderId?: string }>().orderId ?? "");
  const [number, setNumber] = useState<string | null>(null);
  useEffect(() => {
    setNumber(createdNumberOf(orderId, false));
  }, [orderId]);
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4" data-testid="detail-hidden" data-created={number !== null}>
      <h2 className="m-0 break-words text-xl font-bold text-ink">{number === null ? t("detail.hiddenTitle") : t("detail.hiddenCreatedTitle", { number })}</h2>
      <p className="m-0 text-base text-ink">{number === null ? t("detail.hiddenReason") : t("detail.hiddenCreatedReason")}</p>
      <p className="m-0 text-base font-semibold text-ink" data-testid="hidden-action">
        {number === null ? t("detail.hiddenAction") : t("detail.hiddenCreatedAction", { number })}
      </p>
    </section>
  );
}
