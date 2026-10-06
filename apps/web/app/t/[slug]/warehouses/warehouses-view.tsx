"use client";
// Depo listesi ekranı (T-207). Yetki ve iş kuralları SUNUCUDADIR: `canManage` yalnızca gösterimdir (kilit + açıklama);
// eylemler sunucuda `settings.manage` ister. Kod normalleştirmesi (A-98) istemcide YOK: sunucunun döndürdüğü kod gösterilir.
// Mobilde kart görünümü (tablo yok → yatay taşma yok). Sunucu reddi neden + sonraki eylemle gösterilir.
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Banner, Button, ConfirmDialog, EmptyState, TextField } from "@wms/ui";
import { PageBody, Sheet } from "../easy-setup/sheet.tsx";
import { SetupGuide, isSetupComplete, useSetupProgress } from "../easy-setup/setup-guide.tsx";
import { archiveWarehouseAction, createWarehouseAction, suggestCodeAction } from "./actions.ts";

/** Sunucu eylem hatası (`ActionResult.error`): yalnızca kod + ayrıntı + istek kimliği kullanılır. */
export interface ServerError {
  readonly code: string;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
}

const KNOWN = ["idempotency_mismatch", "forbidden", "unauthenticated", "not_found", "validation_failed", "version_conflict", "rate_limited", "tenant_suspended", "tenant_closing", "internal"];
const DETAILED = [
  "forbidden_mfa_required",
  "forbidden_warehouse_out_of_scope",
  "unauthenticated_recent_auth_required",
  "validation_failed_code_taken",
  "validation_failed_in_use",
  "validation_failed_parent_invalid",
  "validation_failed_document_too_large",
  "validation_failed_idempotency_key_required",
];

/**
 * Sunucu hatası → `warehouses.errors.<anahtar>` (+ `<anahtar>Action` sonraki eylem). Kod/ayrıntı sunucudan gelir;
 * yalnızca bilinen eşlemeler kullanılır, aksi halde genel `internal`. `IN_USE` metni kapsama göre (depo/lokasyon) ayrışır.
 */
export function errorKey(error: Pick<ServerError, "code" | "detail">, scope: "warehouse" | "location" | "bulk" = "warehouse"): string {
  const base = error.code.toLowerCase();
  const key = KNOWN.includes(base) ? base : "internal";
  if (error.detail !== undefined) {
    const detailed = `${key}_${error.detail.toLowerCase()}`;
    if (DETAILED.includes(detailed)) {
      if (detailed === "validation_failed_in_use" && scope === "location") return "validation_failed_in_use_location";
      if (detailed === "validation_failed_code_taken" && scope === "bulk") return "validation_failed_code_taken_bulk";
      return detailed;
    }
  }
  return key;
}

const LINK_CLS =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-control px-2 text-base font-semibold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const BADGE = "inline-flex items-center rounded-full px-2 text-xs font-bold";
export const SELECT_CLS =
  "min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function ServerErrorBanner({ error, returnTo, scope = "warehouse" }: { error: ServerError; returnTo: string; scope?: "warehouse" | "location" | "bulk" }) {
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
  /** Kod kullanıcı tarafından değiştirilmedi (önerilen kod): çakışmada sunucu sıradaki öneriyle yeniden dener (T-250). */
  readonly autoCode: boolean;
}

/**
 * Oluşturma penceresi (depo ve lokasyon ortak, T-250). Açılışta sıradaki kod SUNUCUDAN istenir ve hazır gelir; zorunlu olan yalnızca ad.
 * `submit` sunucu eylemini çağırır; hata pencerede kalır, yazılanlar korunur. Telefonda tam ekran tek sütun, eylem çubuğu altta sabit.
 */
export function CreateDialog({
  open,
  title,
  intro,
  kinds,
  returnTo,
  scope,
  defaultName = "",
  suggest,
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
  /** Ad alanının önerilen başlangıç değeri (akıllı varsayılan). */
  defaultName?: string;
  /** Sıradaki kodu sunucudan ister; başarısızsa `null` (kullanıcı kodu kendisi yazar). */
  suggest: () => Promise<string | null>;
  onClose: () => void;
  onDone: (result: unknown) => void;
  submit: (v: CreateValues) => Promise<{ ok: true; data?: unknown } | { ok: false; error: ServerError }>;
}) {
  const t = useTranslations("warehouses.form");
  const te = useTranslations("easySetup.code");
  const tk = useTranslations("warehouses.kind");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [name, setName] = useState(defaultName);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState("STORAGE");
  const [touched, setTouched] = useState(false);
  const [codeState, setCodeState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setName(defaultName);
    setKind("STORAGE");
    setTouched(false);
    setCode("");
    setCodeState("loading");
    void suggest().then((c) => {
      if (!live) return;
      if (c === null) setCodeState("failed");
      else {
        setCode(c);
        setCodeState("ready");
      }
    });
    return () => {
      live = false;
    };
    // `suggest`/`defaultName` her açılışta okunur; kimlikleri değişse de form yeniden başlamaz.
  }, [open]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await submit({ code, name, kind, autoCode: !touched && codeState === "ready" });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone(res.data);
  }

  return (
    <Sheet
      open={open}
      title={title}
      titleId="create-dialog-title"
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
      {intro ? <div className="break-words text-base text-ink-muted">{intro}</div> : null}
      <TextField label={t("name")} name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required maxLength={512} />
      <TextField
        label={t("code")}
        hint={codeState === "loading" ? te("loading") : codeState === "failed" ? te("failed") : touched ? `${te("custom")} ${t("codeHint")}` : `${te("suggested")} ${t("codeHint")}`}
        name="code"
        value={code}
        onChange={(e) => {
          setTouched(true);
          setCode(e.target.value);
        }}
        autoComplete="off"
        autoCapitalize="characters"
        required
        maxLength={512}
      />
      {kinds === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="create-kind" className="text-base font-semibold">
            {t("kind")}
          </label>
          <select id="create-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className={SELECT_CLS}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {tk(k)}
              </option>
            ))}
          </select>
        </div>
      )}
      {error ? <ServerErrorBanner error={error} returnTo={returnTo} scope={scope} /> : null}
    </Sheet>
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
  const te = useTranslations("easySetup");
  const router = useRouter();
  const base = `/t/${encodeURIComponent(slug)}/warehouses`;
  const [createOpen, setCreateOpen] = useState(false);
  const [archiving, setArchiving] = useState<WarehouseView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const progress = useSetupProgress(slug, canManage, version);
  const guide = canManage && progress !== null && !isSetupComplete(progress);
  const pathname = usePathname();
  const params = useSearchParams();

  // Rehberin büyük düğmesi `?new=1` ile gelir: formu aç, adresi temizle (yenilemede yeniden açılmasın).
  useEffect(() => {
    if (params.get("new") === "1" && canManage) {
      setCreateOpen(true);
      router.replace(pathname);
    }
  }, [params, canManage, pathname, router]);

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
      <PageBody hide={createOpen}>
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
      {guide && progress !== null ? <SetupGuide slug={slug} progress={progress} /> : null}

      <section aria-label={t("listLabel")} className="flex min-w-0 flex-col gap-3">
        {warehouses.length === 0 ? (
          guide ? null : <EmptyState title={t("empty")} description={canManage ? t("emptyAction") : t("emptyReadOnly")} />
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
      </PageBody>

      <CreateDialog
        open={createOpen}
        title={t("createTitle")}
        returnTo={base}
        scope="warehouse"
        defaultName={progress !== null && !progress.hasWarehouse ? te("form.defaultWarehouseName") : ""}
        suggest={async () => {
          const r = await suggestCodeAction({ slug, kind: "warehouse" });
          return r.ok ? r.data.code : null;
        }}
        onClose={() => setCreateOpen(false)}
        onDone={(data) => {
          setCreateOpen(false);
          setNotice(t("done.created"));
          setVersion((n) => n + 1);
          // İlk depo: doğrudan raf oluşturucuya git (rehberin 2. adımı).
          const id = (data as { warehouseId?: string } | undefined)?.warehouseId;
          if (progress !== null && !progress.hasLocation && id !== undefined) router.push(`${base}/${encodeURIComponent(id)}?bulk=1`);
          else router.refresh();
        }}
        submit={async (v) => {
          const res = await createWarehouseAction({ slug, code: v.code, name: v.name, autoCode: v.autoCode });
          return res.ok ? { ok: true, data: res.data } : { ok: false, error: { code: res.error.code, detail: res.error.detail, requestId: res.error.requestId } };
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
