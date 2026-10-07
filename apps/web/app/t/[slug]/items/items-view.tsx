"use client";
// Ürün listesi ekranı (T-216). Yetki ve iş kuralları SUNUCUDADIR: `canManage` yalnızca gösterimdir (kilit + açıklama); eylemler sunucuda
// `settings.manage` ister. Kod normalleştirmesi, takip modu ve ölçek kuralları istemcide YOK. Arama sunucudadır (GET formu, keyset imleç,
// OFFSET yok); barkod alanına okutma düz metin girişidir (tarama yolu ADR-010). Mobilde kart görünümü (tablo yok → yatay taşma yok).
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Banner, Button, ChevronDown, EmptyState, TextField } from "@wms/ui";
import { PageBody, Sheet } from "../easy-setup/sheet.tsx";
import { SetupGuide, isSetupComplete, useSetupProgress } from "../easy-setup/setup-guide.tsx";
import { Typeahead } from "../easy-setup/typeahead.tsx";
import { createItemAction, searchItemsAction, suggestItemCodeAction } from "./actions.ts";

/** Sunucu eylem hatası (`ActionResult.error`): yalnızca kod + ayrıntı + istek kimliği kullanılır. */
export interface ServerError {
  readonly code: string;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
}

const KNOWN = ["forbidden", "unauthenticated", "not_found", "validation_failed", "version_conflict", "rate_limited", "tenant_suspended", "tenant_closing", "internal"];
const DETAILED = [
  "forbidden_mfa_required",
  "unauthenticated_recent_auth_required",
  "validation_failed_code_taken",
  "validation_failed_in_use",
  "validation_failed_unit_conversion_invalid",
];

/** Sunucu hatası → `items.errors.<anahtar>` (+ `<anahtar>Action` sonraki eylem). Bilinmeyen kod genel `internal`'a düşer. */
export function errorKey(error: Pick<ServerError, "code" | "detail">): string {
  const base = error.code.toLowerCase();
  const key = KNOWN.includes(base) ? base : "internal";
  if (error.detail !== undefined) {
    const detailed = `${key}_${error.detail.toLowerCase()}`;
    if (DETAILED.includes(detailed)) return detailed;
  }
  return key;
}

export function toServerError(e: ServerError): ServerError {
  return { code: e.code, detail: e.detail, requestId: e.requestId };
}

export const LINK_CLS =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-control px-2 text-base font-semibold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
export const BADGE = "inline-flex items-center rounded-full px-2 text-xs font-bold";
export const SELECT_CLS =
  "min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function ServerErrorBanner({ error, returnTo }: { error: ServerError; returnTo: string }) {
  const t = useTranslations("items.errors");
  const key = errorKey(error);
  return (
    <Banner kind="error">
      <p>
        {t(key)} {t(`${key}Action`)}
      </p>
      {error.detail === "MFA_REQUIRED" ? (
        <a className={LINK_CLS} href={`/mfa?next=${encodeURIComponent(returnTo)}`}>
          {t("mfaLink")}
        </a>
      ) : null}
      {error.detail === "RECENT_AUTH_REQUIRED" ? (
        <a className={LINK_CLS} href={`/login?next=${encodeURIComponent(returnTo)}`}>
          {t("loginLink")}
        </a>
      ) : null}
      <p className="mt-1 break-all text-sm">
        {t("code", { code: error.detail === undefined ? error.code : `${error.code}/${error.detail}` })}
        {error.requestId ? ` · ${error.requestId}` : ""}
      </p>
    </Banner>
  );
}

export interface UnitOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** Arama sonucu (T-257): `oldCode` doluysa arama ESKİ kodla eşleşti ("bu kod {code} olarak değişti"). */
export interface ItemHit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly oldCode?: string;
}

export interface ItemListView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly baseUnitCode: string;
  /** Arama eski kodla eşleştiyse o eski kod (T-257). */
  readonly oldCode?: string;
}

/** Kod önerisi yanıt süresi sınırı; aşılırsa kod alanı açılır (T-259). */
const SUGGEST_TIMEOUT_MS = 5000;
const TRACKING = ["NONE", "LOT", "SERIAL", "LOT_AND_SERIAL"] as const;
const PICK = ["FIFO", "FEFO"] as const;
const SCALES = [0, 1, 2, 3, 4, 5, 6] as const;

/** Akıllı varsayılan (A-250-5): birim ADET (sektör şablonları temel birim olarak ADET önerir). ADET yoksa SESSİZ SEÇİM YOK (T-259): boş kalır, kullanıcı seçer. */
function defaultUnitId(units: readonly UnitOption[]): string {
  return units.find((u) => u.code.toUpperCase() === "ADET")?.id ?? "";
}

/** Sunucunun `renamedFrom` bilgisini sonuç satırlarına işler; birden çok aday varsa hepsi listelenir (sessiz seçim yok, N-14). */
function withRenamed(data: {
  readonly items: readonly { readonly id: string; readonly code: string; readonly name: string }[];
  readonly renamedFrom: readonly { readonly itemId: string; readonly oldCode: string }[];
}): readonly ItemHit[] {
  const old = new Map(data.renamedFrom.map((r) => [r.itemId, r.oldCode] as const));
  return data.items.map((i) => {
    const oldCode = old.get(i.id);
    return oldCode === undefined ? i : { ...i, oldCode };
  });
}

function CreateItemDialog({ open, slug, units, returnTo, onClose, onDone }: { open: boolean; slug: string; units: readonly UnitOption[]; returnTo: string; onClose: () => void; onDone: (itemId: string) => void }) {
  const t = useTranslations("items.form");
  const te = useTranslations("easySetup");
  const tt = useTranslations("items.tracking");
  const tp = useTranslations("items.pick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [touched, setTouched] = useState(false);
  // Gecikmeli öneri yanıtı kapanışın (closure) bayat `touched` değerini görmesin diye ref (T-259 MINOR-2).
  const touchedRef = useRef(false);
  const [codeState, setCodeState] = useState<"loading" | "ready" | "failed">("loading");
  const [unitId, setUnitId] = useState(() => defaultUnitId(units));
  const [scale, setScale] = useState("0");
  const [tracking, setTracking] = useState("NONE");
  const [pick, setPick] = useState("FIFO");

  // Her açılışta akıllı varsayılanlar: ADET, 0 ondalık, takip yok, FIFO; sıradaki kod sunucudan hazır gelir.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setName("");
    setCode("");
    setTouched(false);
    touchedRef.current = false;
    setCodeState("loading");
    setUnitId(defaultUnitId(units));
    setScale("0");
    setTracking("NONE");
    setPick("FIFO");
    // Öneri hiç dönmezse alan sonsuza dek salt okunur kalmasın: süre dolunca "failed" (kullanıcı kodu kendisi yazar).
    let settled = false;
    const timer = setTimeout(() => {
      if (live && !settled) {
        settled = true;
        setCodeState("failed");
      }
    }, SUGGEST_TIMEOUT_MS);
    void suggestItemCodeAction({ slug }).then((r) => {
      if (!live || settled) return;
      settled = true;
      clearTimeout(timer);
      if (r.ok) {
        // Kullanıcı kodu değiştirdiyse (`touched`; silip boş bırakmak dahil) öneri uygulanmaz (N-14: sessiz değişiklik yok).
        if (!touchedRef.current) setCode(r.data.code);
        setCodeState("ready");
      } else setCodeState("failed");
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // units yalnızca açılışta okunur.
  }, [open, slug]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createItemAction({
      slug,
      code,
      name,
      ...(units.length === 0 ? {} : { baseUnitId: unitId }),
      quantityScale: Number(scale),
      trackingMode: tracking,
      pickPolicy: pick,
      autoCode: !touched && codeState === "ready",
    });
    setBusy(false);
    if (!res.ok) {
      setError(toServerError(res.error));
      return;
    }
    onDone((res.data as { itemId: string }).itemId);
  }

  return (
    <Sheet
      open={open}
      title={t("createTitle")}
      titleId="create-item-title"
      onClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={codeState === "loading"}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <TextField label={t("name")} name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required maxLength={512} />
      <TextField
        label={t("code")}
        hint={codeState === "loading" ? te("code.loading") : codeState === "failed" ? te("code.failed") : touched ? `${te("code.custom")} ${t("codeHint")}` : `${te("code.suggested")} ${t("codeHint")}`}
        name="code"
        value={code}
        readOnly={codeState === "loading"}
        aria-busy={codeState === "loading"}
        onChange={(e) => {
          touchedRef.current = true;
          setTouched(true);
          setCode(e.target.value);
        }}
        autoComplete="off"
        required
        maxLength={512}
      />
      {units.length === 0 ? <Banner kind="info">{te("items.unitAuto")}</Banner> : null}
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor="create-base-unit" className="text-base font-semibold">
          {t("baseUnit")}
        </label>
        <span className="text-sm text-ink-muted">{t("baseUnitHint")}</span>
        {units.length > 0 && !units.some((u) => u.code.toUpperCase() === "ADET") ? <span className="text-sm font-semibold text-ink">{t("baseUnitChoose")}</span> : null}
        <select id="create-base-unit" name="baseUnitId" required={units.length > 0} disabled={units.length === 0} value={unitId} onChange={(e) => setUnitId(e.target.value)} className={SELECT_CLS}>
          {units.length === 0 ? <option value="">{te("items.unitDefaultOption")}</option> : null}
          {units.length > 0 && unitId === "" ? <option value="">{t("baseUnitPlaceholder")}</option> : null}
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.code} · {u.name}
            </option>
          ))}
        </select>
      </div>
      <details className="min-w-0 rounded-card border-2 border-border p-3">
        <summary className="flex min-h-12 cursor-pointer items-center text-base font-semibold">{t("advanced")}</summary>
        <div className="mt-2 flex min-w-0 flex-col gap-4">
          <p className="break-words text-sm text-ink-muted">{t("advancedHint")}</p>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="create-scale" className="text-base font-semibold">
              {t("scale")}
            </label>
            <span className="text-sm text-ink-muted">{t("scaleHint")}</span>
            <select id="create-scale" name="quantityScale" value={scale} onChange={(e) => setScale(e.target.value)} className={SELECT_CLS}>
              {SCALES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t("scaleInteger") : t("scaleDecimals", { count: n })}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="create-tracking" className="text-base font-semibold">
              {t("tracking")}
            </label>
            <select id="create-tracking" name="trackingMode" value={tracking} onChange={(e) => setTracking(e.target.value)} className={SELECT_CLS}>
              {TRACKING.map((k) => (
                <option key={k} value={k}>
                  {tt(k)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="create-pick" className="text-base font-semibold">
              {t("pick")}
            </label>
            <select id="create-pick" name="pickPolicy" value={pick} onChange={(e) => setPick(e.target.value)} className={SELECT_CLS}>
              {PICK.map((k) => (
                <option key={k} value={k}>
                  {tp(k)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </details>
      {error ? <ServerErrorBanner error={error} returnTo={returnTo} /> : null}
    </Sheet>
  );
}

export function ItemsView({
  slug,
  canManage,
  items,
  units,
  nextCursor,
  firstPage,
  query,
}: {
  slug: string;
  canManage: boolean;
  items: readonly ItemListView[];
  units: readonly UnitOption[];
  /** Sonraki sayfa imleci (opak); yoksa `null`. */
  nextCursor: string | null;
  firstPage: boolean;
  query: { readonly q: string; readonly status: "" | "ACTIVE" | "ARCHIVED" };
}) {
  const t = useTranslations("items");
  const te = useTranslations("easySetup.items");
  const tg = useTranslations("easySetup.guide");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const base = `/t/${encodeURIComponent(slug)}/items`;
  const [createOpen, setCreateOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const progress = useSetupProgress(slug, canManage, version);
  const guide = canManage && progress !== null && !isSetupComplete(progress);

  // Rehberin büyük düğmesi `?new=1` ile gelir: formu aç, adresi temizle.
  useEffect(() => {
    if (params.get("new") === "1" && canManage) {
      setCreateOpen(true);
      router.replace(pathname);
    }
  }, [params, canManage, pathname, router]);
  const filtered = query.q !== "" || query.status !== "";
  const keep = new URLSearchParams();
  if (query.q !== "") keep.set("q", query.q);
  if (query.status !== "") keep.set("status", query.status);
  const withParams = (extra?: [string, string]): string => {
    const p = new URLSearchParams(keep);
    if (extra) p.set(extra[0], extra[1]);
    const s = p.toString();
    return s === "" ? base : `${base}?${s}`;
  };

  const formRef = useRef<HTMLFormElement>(null);
  const [submitting, setSubmitting] = useState(false);
  // Aramanın sunucudaki karşılığı (GET `?q=&status=`): yalnızca adres üretir; arama kuralı sunucudadır.
  const goSearch = (status: string): void => {
    const form = formRef.current;
    const q = form === null ? "" : String(new FormData(form).get("q") ?? "").trim();
    const p = new URLSearchParams();
    if (q !== "") p.set("q", q);
    if (status !== "") p.set("status", status);
    const s = p.toString();
    router.push(s === "" ? base : `${base}?${s}`);
  };
  // Enter (klavye ya da barkod okuyucunun sonundaki Enter): tek eşleşme varsa doğrudan ürünü aç, yoksa/çoksa sonuç listesine git.
  async function onSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const q = String(new FormData(form).get("q") ?? "").trim();
    const status = String(new FormData(form).get("status") ?? "");
    if (q === "") {
      goSearch(status);
      return;
    }
    setSubmitting(true);
    const r = await searchItemsAction({ slug, q, limit: 2 });
    setSubmitting(false);
    const hits = r.ok ? withRenamed(r.data) : [];
    if (hits.length === 1 && hits[0] !== undefined) router.push(`${base}/${encodeURIComponent(hits[0].id)}`);
    else goSearch(status);
  }

  return (
    <>
      <PageBody hide={createOpen}>
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-extrabold text-ink phone:text-xl">{t("title")}</h1>
        <p className="break-words text-base text-ink-muted phone:truncate phone:text-sm">{t("intro")}</p>
      </div>

      <form ref={formRef} method="get" action={base} role="search" aria-label={t("search.label")} aria-busy={submitting} onSubmit={(e) => void onSearchSubmit(e)} className="flex min-w-0 flex-col gap-2">
        <Typeahead<ItemHit>
          label={t("search.label")}
          hint={t("search.hint")}
          placeholder={t("search.placeholder")}
          name="q"
          defaultValue={query.q}
          listLabel={te("searchSuggestLabel")}
          search={async (q) => {
            const r = await searchItemsAction({ slug, q, limit: 8 });
            return r.ok ? withRenamed(r.data) : [];
          }}
          toSuggestion={(i) => ({
            key: i.id,
            primary: i.name,
            secondary: i.oldCode === undefined ? t("codeLabel", { code: i.code }) : t("renamedNote", { code: i.code, old: i.oldCode }),
          })}
          onSelect={(i) => router.push(`${base}/${encodeURIComponent(i.id)}`)}
        />
        <details className="min-w-0" open={query.status !== "" ? true : undefined}>
          <summary className="flex min-h-12 cursor-pointer items-center text-base font-semibold text-accent-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus">{t("search.advanced")}</summary>
          <div className="flex min-w-0 flex-col gap-1 pb-2">
            <label htmlFor="item-status" className="text-base font-semibold">
              {t("search.status")}
            </label>
            <select id="item-status" name="status" defaultValue={query.status} onChange={(e) => goSearch(e.target.value)} className={SELECT_CLS}>
              <option value="">{t("search.all")}</option>
              <option value="ACTIVE">{t("status.ACTIVE")}</option>
              <option value="ARCHIVED">{t("status.ARCHIVED")}</option>
            </select>
          </div>
        </details>
        {filtered ? (
          <Link href={base} className={`${LINK_CLS} self-start`}>
            {t("search.clear")}
          </Link>
        ) : null}
      </form>

      {/* Kurulum rehberi aramanın altında: ilk görünümde arama + birincil eylem her zaman görünür (T-274). */}
      {guide && progress !== null ? (
        <details data-testid="setup-collapsed" className="group min-w-0 rounded-card border-2 border-border bg-surface px-3">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1 break-words">
              {t("search.setupSummary", {
                done: [progress.hasWarehouse, progress.hasLocation, progress.hasItem].filter(Boolean).length,
                next: tg(!progress.hasWarehouse ? "warehouse.title" : !progress.hasLocation ? "locations.title" : "items.title"),
              })}
            </span>
            <ChevronDown aria-hidden="true" className="size-5 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="pb-3">
            <SetupGuide slug={slug} progress={progress} />
          </div>
        </details>
      ) : null}

      <section aria-label={t("listLabel")} className="flex min-w-0 flex-col gap-3">
        {items.length === 0 ? (
          guide && !filtered ? null : <EmptyState title={filtered ? t("emptyFiltered") : t("empty")} description={filtered ? t("emptyFilteredAction") : canManage ? t("emptyAction") : t("emptyReadOnly")} />
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
            {items.map((it) => {
              const active = it.status === "ACTIVE";
              return (
                <li key={it.id} data-testid="item-card" className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4 shadow-card">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-lg font-bold text-ink">{it.name}</span>
                    <span className={`${BADGE} ${active ? "bg-accent-soft text-accent-ink" : "bg-locked-bg text-locked-ink"}`}>{active ? t("status.ACTIVE") : t("status.ARCHIVED")}</span>
                  </div>
                  <p className="min-w-0 break-all text-base text-ink-muted">{t("codeLabel", { code: it.code })}</p>
                  {it.oldCode === undefined ? null : <p className="min-w-0 break-words text-sm font-semibold text-ink">{t("renamedNote", { code: it.code, old: it.oldCode })}</p>}
                  <p className="min-w-0 break-all text-sm text-ink-muted">{t("baseUnitLabel", { unit: it.baseUnitCode })}</p>
                  <div>
                    <Link href={`${base}/${encodeURIComponent(it.id)}`} className={LINK_CLS} aria-label={t("openFor", { name: it.name })}>
                      {t("open")}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <nav aria-label={t("paging")} className="flex flex-wrap gap-2">
          {firstPage ? null : (
            <Link href={withParams()} className={LINK_CLS}>
              {t("firstPage")}
            </Link>
          )}
          {nextCursor === null ? null : (
            <Link href={withParams(["after", nextCursor])} className={LINK_CLS}>
              {t("more")}
            </Link>
          )}
        </nav>
      </section>
      </PageBody>

      {/* Birincil eylem altta sabit (başparmak bölgesi); form açıkken gizli. */}
      <div data-hide={createOpen} className="sticky bottom-0 z-10 -mx-4 mt-auto flex min-w-0 flex-col gap-1 border-t border-border bg-bg px-4 py-2 data-[hide=true]:hidden">
        <Button onClick={() => setCreateOpen(true)} disabled={!canManage} aria-describedby={canManage ? undefined : "item-locked"}>
          {t("create")}
        </Button>
        {canManage ? null : (
          <p id="item-locked" className="break-words text-sm text-ink-muted">
            {t("lockedReason")}
          </p>
        )}
      </div>

      <CreateItemDialog
        open={createOpen}
        slug={slug}
        units={units}
        returnTo={base}
        onClose={() => setCreateOpen(false)}
        onDone={(itemId) => {
          setCreateOpen(false);
          setVersion((n) => n + 1);
          router.push(`${base}/${encodeURIComponent(itemId)}`);
        }}
      />
    </>
  );
}
