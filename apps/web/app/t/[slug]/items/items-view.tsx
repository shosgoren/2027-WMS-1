"use client";
// Ürün listesi ekranı (T-216). Yetki ve iş kuralları SUNUCUDADIR: `canManage` yalnızca gösterimdir (kilit + açıklama); eylemler sunucuda
// `settings.manage` ister. Kod normalleştirmesi, takip modu ve ölçek kuralları istemcide YOK. Arama sunucudadır (GET formu, keyset imleç,
// OFFSET yok); barkod alanına okutma düz metin girişidir (tarama yolu ADR-010). Mobilde kart görünümü (tablo yok → yatay taşma yok).
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Banner, Button, EmptyState, TextField } from "@wms/ui";
import { createItemAction } from "./actions.ts";

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
  "min-h-12 w-full min-w-0 rounded-card border-2 border-border bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

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

export interface ItemListView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly baseUnitCode: string;
}

const TRACKING = ["NONE", "LOT", "SERIAL", "LOT_AND_SERIAL"] as const;
const PICK = ["FIFO", "FEFO"] as const;
const SCALES = [0, 1, 2, 3, 4, 5, 6] as const;

function CreateItemDialog({ open, slug, units, returnTo, onClose }: { open: boolean; slug: string; units: readonly UnitOption[]; returnTo: string; onClose: () => void }) {
  const t = useTranslations("items.form");
  const tt = useTranslations("items.tracking");
  const tp = useTranslations("items.pick");
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [round, setRound] = useState(0);
  // Reddedilen gönderimde yazılanlar korunur (form yeniden oluşturulurken varsayılan değer olur); pencere kapanınca silinir.
  const [last, setLast] = useState<Record<string, string>>({});

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    if (open) setError(null);
    else setLast({});
  }, [open]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setLast(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
    const res = await createItemAction({
      slug,
      code: String(form.get("code") ?? ""),
      name: String(form.get("name") ?? ""),
      baseUnitId: String(form.get("baseUnitId") ?? ""),
      quantityScale: Number(form.get("quantityScale") ?? "0"),
      trackingMode: String(form.get("trackingMode") ?? "NONE"),
      pickPolicy: String(form.get("pickPolicy") ?? "FIFO"),
    });
    setBusy(false);
    if (!res.ok) {
      setError(toServerError(res.error));
      setRound((n) => n + 1);
      return;
    }
    onClose();
    router.push(`/t/${encodeURIComponent(slug)}/items/${encodeURIComponent((res.data as { itemId: string }).itemId)}`);
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="create-item-title"
      onClose={() => {
        if (open) onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-card border-0 bg-surface p-6 text-ink shadow-card backdrop:bg-ink/50"
    >
      <h2 id="create-item-title" className="mb-2 break-words text-xl font-bold">
        {t("createTitle")}
      </h2>
      {open ? (
        <form key={round} onSubmit={(e) => void onSubmit(e)} className="flex min-w-0 flex-col gap-4">
          <TextField label={t("code")} hint={t("codeHint")} name="code" defaultValue={last.code ?? ""} autoComplete="off" required maxLength={512} />
          <TextField label={t("name")} name="name" defaultValue={last.name ?? ""} autoComplete="off" required maxLength={512} />
          {units.length === 0 ? <Banner kind="warning">{t("noUnits")}</Banner> : null}
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="create-base-unit" className="text-base font-semibold">
              {t("baseUnit")}
            </label>
            <span className="text-sm text-ink-muted">{t("baseUnitHint")}</span>
            <select id="create-base-unit" name="baseUnitId" required defaultValue={last.baseUnitId ?? units[0]?.id ?? ""} className={SELECT_CLS}>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} · {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="create-scale" className="text-base font-semibold">
              {t("scale")}
            </label>
            <span className="text-sm text-ink-muted">{t("scaleHint")}</span>
            <select id="create-scale" name="quantityScale" defaultValue={last.quantityScale ?? "0"} className={SELECT_CLS}>
              {SCALES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t("scaleInteger") : t("scaleDecimals", { count: n })}
                </option>
              ))}
            </select>
          </div>
          <details className="min-w-0 rounded-card border-2 border-border p-3">
            <summary className="flex min-h-12 cursor-pointer items-center text-base font-semibold">{t("advanced")}</summary>
            <div className="mt-2 flex min-w-0 flex-col gap-4">
              <p className="break-words text-sm text-ink-muted">{t("advancedHint")}</p>
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor="create-tracking" className="text-base font-semibold">
                  {t("tracking")}
                </label>
                <select id="create-tracking" name="trackingMode" defaultValue={last.trackingMode ?? "NONE"} className={SELECT_CLS}>
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
                <select id="create-pick" name="pickPolicy" defaultValue={last.pickPolicy ?? "FIFO"} className={SELECT_CLS}>
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
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button type="submit" loading={busy} disabled={units.length === 0}>
              {t("submit")}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
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
  const base = `/t/${encodeURIComponent(slug)}/items`;
  const [createOpen, setCreateOpen] = useState(false);
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

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-extrabold text-ink">{t("title")}</h1>
          <p className="break-words text-base text-ink-muted">{t("intro")}</p>
        </div>
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:*:shrink-0 sm:*:whitespace-nowrap">
          <Button onClick={() => setCreateOpen(true)} disabled={!canManage} aria-describedby={canManage ? undefined : "item-locked"}>
            {t("create")}
          </Button>
          {canManage ? null : (
            <p id="item-locked" className="max-w-xs break-words text-sm text-ink-muted">
              {t("lockedReason")}
            </p>
          )}
        </div>
      </div>

      <form method="get" action={base} role="search" aria-label={t("search.label")} className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-border bg-surface p-4">
        <TextField label={t("search.label")} hint={t("search.hint")} name="q" type="search" defaultValue={query.q} autoComplete="off" maxLength={128} />
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="item-status" className="text-base font-semibold">
            {t("search.status")}
          </label>
          <select id="item-status" name="status" defaultValue={query.status} className={SELECT_CLS}>
            <option value="">{t("search.all")}</option>
            <option value="ACTIVE">{t("status.ACTIVE")}</option>
            <option value="ARCHIVED">{t("status.ARCHIVED")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit">{t("search.submit")}</Button>
          {filtered ? (
            <Link href={base} className={LINK_CLS}>
              {t("search.clear")}
            </Link>
          ) : null}
        </div>
      </form>

      <section aria-label={t("listLabel")} className="flex min-w-0 flex-col gap-3">
        {items.length === 0 ? (
          <EmptyState title={filtered ? t("emptyFiltered") : t("empty")} description={filtered ? t("emptyFilteredAction") : canManage ? t("emptyAction") : t("emptyReadOnly")} />
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

      <CreateItemDialog open={createOpen} slug={slug} units={units} returnTo={base} onClose={() => setCreateOpen(false)} />
    </>
  );
}
