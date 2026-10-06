"use client";
// Depo listesi ekranı (T-207). Yetki ve iş kuralları SUNUCUDADIR: `canManage` yalnızca gösterimdir (kilit + açıklama);
// eylemler sunucuda `settings.manage` ister. Kod normalleştirmesi (A-98) istemcide YOK: sunucunun döndürdüğü kod gösterilir.
// Mobilde kart görünümü (tablo yok → yatay taşma yok). Sunucu reddi neden + sonraki eylemle gösterilir.
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Banner, Button, ConfirmDialog, EmptyState, TextField } from "@wms/ui";
import { archiveWarehouseAction, createWarehouseAction } from "./actions.ts";

/** Sunucu eylem hatası (`ActionResult.error`): yalnızca kod + ayrıntı + istek kimliği kullanılır. */
export interface ServerError {
  readonly code: string;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
}

const KNOWN = ["forbidden", "unauthenticated", "not_found", "validation_failed", "version_conflict", "rate_limited", "tenant_suspended", "tenant_closing", "internal"];
const DETAILED = [
  "forbidden_mfa_required",
  "forbidden_warehouse_out_of_scope",
  "unauthenticated_recent_auth_required",
  "validation_failed_code_taken",
  "validation_failed_in_use",
  "validation_failed_parent_invalid",
];

/**
 * Sunucu hatası → `warehouses.errors.<anahtar>` (+ `<anahtar>Action` sonraki eylem). Kod/ayrıntı sunucudan gelir;
 * yalnızca bilinen eşlemeler kullanılır, aksi halde genel `internal`. `IN_USE` metni kapsama göre (depo/lokasyon) ayrışır.
 */
export function errorKey(error: Pick<ServerError, "code" | "detail">, scope: "warehouse" | "location" = "warehouse"): string {
  const base = error.code.toLowerCase();
  const key = KNOWN.includes(base) ? base : "internal";
  if (error.detail !== undefined) {
    const detailed = `${key}_${error.detail.toLowerCase()}`;
    if (DETAILED.includes(detailed)) return detailed === "validation_failed_in_use" && scope === "location" ? "validation_failed_in_use_location" : detailed;
  }
  return key;
}

const LINK_CLS =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-control px-2 text-base font-semibold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const BADGE = "inline-flex items-center rounded-full px-2 text-xs font-bold";
export const SELECT_CLS =
  "min-h-12 w-full min-w-0 rounded-card border-2 border-border bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function ServerErrorBanner({ error, returnTo, scope = "warehouse" }: { error: ServerError; returnTo: string; scope?: "warehouse" | "location" }) {
  const t = useTranslations("warehouses.errors");
  const key = errorKey(error, scope);
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

export interface CreateValues {
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

/**
 * Oluşturma penceresi (depo ve lokasyon ortak). `submit` sunucu eylemini çağırır; hata pencerede kalır ve form
 * YENİDEN oluşturulur (çift gönderim `CODE_TAKEN` ile biter; kullanıcı yeni formla yeniden dener).
 */
export function CreateDialog({
  open,
  title,
  intro,
  kinds,
  returnTo,
  scope,
  onClose,
  onDone,
  submit,
}: {
  open: boolean;
  title: string;
  intro?: ReactNode;
  /** Verilirse tür seçimi gösterilir (değerler domain `LocationKindValue`). */
  kinds?: readonly string[];
  returnTo: string;
  scope: "warehouse" | "location";
  onClose: () => void;
  onDone: () => void;
  submit: (v: CreateValues) => Promise<{ ok: true } | { ok: false; error: ServerError }>;
}) {
  const t = useTranslations("warehouses.form");
  const tk = useTranslations("warehouses.kind");
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    if (open) setError(null);
  }, [open]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await submit({ code: String(form.get("code") ?? ""), name: String(form.get("name") ?? ""), kind: String(form.get("kind") ?? "") });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      setRound((n) => n + 1);
      return;
    }
    onDone();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="create-dialog-title"
      onClose={() => {
        if (open) onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border-0 bg-surface p-6 text-ink shadow-card backdrop:bg-ink/50"
    >
      <h2 id="create-dialog-title" className="mb-2 break-words text-xl font-bold">
        {title}
      </h2>
      {open ? (
        <form key={round} onSubmit={(e) => void onSubmit(e)} className="flex min-w-0 flex-col gap-4">
          {intro ? <div className="break-words text-base text-ink-muted">{intro}</div> : null}
          <TextField label={t("code")} hint={t("codeHint")} name="code" autoComplete="off" autoCapitalize="characters" required maxLength={512} />
          <TextField label={t("name")} name="name" autoComplete="off" required maxLength={512} />
          {kinds === undefined ? null : (
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="create-kind" className="text-base font-semibold">
                {t("kind")}
              </label>
              <select id="create-kind" name="kind" defaultValue="STORAGE" className={SELECT_CLS}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {tk(k)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {error ? <ServerErrorBanner error={error} returnTo={returnTo} scope={scope} /> : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button type="submit" loading={busy}>
              {t("submit")}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}

export interface WarehouseView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  /** Aktif lokasyon sayısı; `capped` ise gerçek sayı en az bu kadardır ("N+"). */
  readonly locationCount: number;
  readonly locationCountCapped: boolean;
}

export function WarehousesView({
  slug,
  canManage,
  warehouses,
  nextAfter,
  firstPage,
}: {
  slug: string;
  canManage: boolean;
  warehouses: readonly WarehouseView[];
  /** Sonraki sayfa imleci (son görülen kod); yoksa `null`. */
  nextAfter: string | null;
  firstPage: boolean;
}) {
  const t = useTranslations("warehouses");
  const router = useRouter();
  const base = `/t/${encodeURIComponent(slug)}/warehouses`;
  const [createOpen, setCreateOpen] = useState(false);
  const [archiving, setArchiving] = useState<WarehouseView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function archive() {
    if (archiving === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await archiveWarehouseAction({ slug, warehouseId: archiving.id });
    setBusy(false);
    setArchiving(null);
    if (!res.ok) {
      setError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
      return;
    }
    setNotice(t("done.archived"));
    router.refresh();
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-extrabold text-ink">{t("title")}</h1>
          <p className="break-words text-base text-ink-muted">{t("intro")}</p>
        </div>
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:*:shrink-0 sm:*:whitespace-nowrap">
          <Button onClick={() => setCreateOpen(true)} disabled={!canManage} aria-describedby={canManage ? undefined : "warehouse-locked"}>
            {t("create")}
          </Button>
          {canManage ? null : (
            <p id="warehouse-locked" className="max-w-xs break-words text-sm text-ink-muted">
              {t("lockedReason")}
            </p>
          )}
        </div>
      </div>

      {notice ? <Banner kind="info">{notice}</Banner> : null}
      {error ? <ServerErrorBanner error={error} returnTo={base} /> : null}

      <section aria-label={t("listLabel")} className="flex min-w-0 flex-col gap-3">
        {warehouses.length === 0 ? (
          <EmptyState title={t("empty")} description={canManage ? t("emptyAction") : t("emptyReadOnly")} />
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
            {warehouses.map((w) => {
              const active = w.status === "ACTIVE";
              const noteId = `archive-lock-${w.id}`;
              return (
                <li key={w.id} data-testid="warehouse-card" className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-border bg-surface p-4 shadow-card">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-lg font-bold text-ink">{w.name}</span>
                    <span className={`${BADGE} ${active ? "bg-accent-soft text-accent-ink" : "bg-locked-bg text-locked-ink"}`}>{active ? t("status.ACTIVE") : t("status.ARCHIVED")}</span>
                  </div>
                  <p className="min-w-0 break-all text-base text-ink-muted">{t("codeLabel", { code: w.code })}</p>
                  <p className="text-sm text-ink-muted">{w.locationCountCapped ? t("locationCountCapped", { count: w.locationCount }) : t("locationCount", { count: w.locationCount })}</p>
                  <div role="group" aria-label={t("actionsFor", { name: w.name })} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:*:shrink-0 sm:*:whitespace-nowrap">
                    <Link href={`${base}/${encodeURIComponent(w.id)}`} className={LINK_CLS}>
                      {t("open")}
                    </Link>
                    {active ? (
                      <Button variant="danger" disabled={!canManage} aria-describedby={canManage ? undefined : noteId} onClick={() => setArchiving(w)}>
                        {t("archive")}
                      </Button>
                    ) : null}
                  </div>
                  {active && !canManage ? (
                    <p id={noteId} className="break-words text-sm text-ink-muted">
                      {t("lockedReason")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <nav aria-label={t("paging")} className="flex flex-wrap gap-2">
          {firstPage ? null : (
            <Link href={base} className={LINK_CLS}>
              {t("firstPage")}
            </Link>
          )}
          {nextAfter === null ? null : (
            <Link href={`${base}?after=${encodeURIComponent(nextAfter)}`} className={LINK_CLS}>
              {t("more")}
            </Link>
          )}
        </nav>
      </section>

      <CreateDialog
        open={createOpen}
        title={t("createTitle")}
        returnTo={base}
        scope="warehouse"
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false);
          setNotice(t("done.created"));
          router.refresh();
        }}
        submit={async (v) => {
          const res = await createWarehouseAction({ slug, code: v.code, name: v.name });
          return res.ok ? { ok: true } : { ok: false, error: { code: res.error.code, detail: res.error.detail, requestId: res.error.requestId } };
        }}
      />
      <ConfirmDialog
        open={archiving !== null}
        title={t("confirmArchive.title", { name: archiving?.name ?? "" })}
        description={t("confirmArchive.description", { name: archiving?.name ?? "", code: archiving?.code ?? "" })}
        confirmLabel={t("confirmArchive.button")}
        cancelLabel={t("form.cancel")}
        loading={busy}
        onConfirm={() => void archive()}
        onCancel={() => setArchiving(null)}
      />
    </>
  );
}
