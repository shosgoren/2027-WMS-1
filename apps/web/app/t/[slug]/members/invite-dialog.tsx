"use client";
// Davet penceresi + tek seferlik bağlantı kutusu + sunucu hatası gösterimi (T-119). Düz bağlantı YALNIZCA bileşen
// durumunda tutulur (URL, depolama, log yok); kapatılınca ya da sayfa yenilenince kaybolur (A-42).
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Banner, Button, TextField, TriangleAlert } from "@wms/ui";
import { inviteMemberAction } from "./actions.ts";

/** Sunucu eylem hatası (`ActionResult.error`); yalnızca kod + ayrıntı + istek kimliği kullanılır. */
export interface ServerError {
  readonly code: string;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
}

const LINK_CLS =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-control px-2 text-base font-semibold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Hata: neden + sonraki eylem (`members.errors.*`); kod ve istek kimliği destek içindir. İç neden ayrıştırılmaz. */
export function ServerErrorBanner({ error, returnTo }: { error: ServerError; returnTo: string }) {
  const t = useTranslations("members.errors");
  const known = ["forbidden", "unauthenticated", "not_found", "validation_failed", "version_conflict", "rate_limited", "tenant_suspended", "tenant_closing", "internal"];
  const base = error.code.toLowerCase();
  const key = known.includes(base) ? base : "internal";
  const detailed = error.detail === undefined ? null : `${key}_${error.detail.toLowerCase()}`;
  const hasDetailed = detailed !== null && t.has(detailed);
  const prefix = hasDetailed ? detailed : key;
  return (
    <Banner kind="error">
      <p>
        {t(prefix)} {t(`${prefix}Action`)}
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
        {t("code", { code: error.code })}
        {error.requestId ? ` · ${error.requestId}` : ""}
      </p>
    </Banner>
  );
}

/** Tek seferlik bağlantı: salt okunur alan + "Kopyala" + uyarı. */
export function LinkBox({ title, link, warning, onDismiss }: { title: string; link: string; warning: string; onDismiss: () => void }) {
  const t = useTranslations("members.linkBox");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-warning bg-surface p-4 shadow-card" data-testid="link-box">
      <div className="flex min-w-0 items-center gap-2">
        <TriangleAlert aria-hidden="true" className="size-5 shrink-0 text-warning" />
        <h3 className="min-w-0 break-words text-lg font-bold text-ink">{title}</h3>
      </div>
      <Banner kind="warning">{warning}</Banner>
      <input
        readOnly
        value={link}
        aria-label={title}
        onFocus={(e) => e.currentTarget.select()}
        className="min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Button onClick={() => void copy()}>{t("copy")}</Button>
        <Button variant="secondary" onClick={onDismiss}>
          {t("dismiss")}
        </Button>
      </div>
      <p role="status" className="break-words text-sm text-ink-muted">
        {state === "copied" ? t("copied") : state === "failed" ? `${t("copyFailed")} ${t("copyFailedAction")}` : ""}
      </p>
    </section>
  );
}

interface InviteResult {
  readonly delivery: "EMAIL" | "SCREEN";
  readonly inviteLink?: string;
}

export function InviteDialog({
  open,
  slug,
  roleKeys,
  onClose,
  onInvited,
}: {
  open: boolean;
  slug: string;
  roleKeys: readonly string[];
  onClose: () => void;
  /** Bağlantı üst bileşene verilmez; yalnızca liste yenilenir. */
  onInvited: () => void;
}) {
  const t = useTranslations("members.inviteDialog");
  const tr = useTranslations("roles");
  const tl = useTranslations("members.linkBox");
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    if (open) {
      setError(null);
      setResult(null);
    }
  }, [open]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await inviteMemberAction({ slug, email: String(form.get("email") ?? ""), roleKey: String(form.get("roleKey") ?? "") });
    setBusy(false);
    if (!res.ok) {
      setError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
      return;
    }
    setResult({ delivery: res.data.delivery, ...(res.data.inviteLink === undefined ? {} : { inviteLink: res.data.inviteLink }) });
    onInvited();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="invite-title"
      onClose={() => {
        setResult(null); // bağlantı kapanışta bellekten düşer
        if (open) onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border-0 bg-surface p-6 text-ink shadow-card backdrop:bg-ink/50"
    >
      <h2 id="invite-title" className="mb-4 break-words text-xl font-bold">
        {t("title")}
      </h2>
      {open && result === null ? (
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
          <TextField label={t("email")} hint={t("emailHint")} name="email" type="email" autoComplete="off" required />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="invite-role" className="text-base font-semibold">
              {t("role")}
            </label>
            <select
              id="invite-role"
              name="roleKey"
              defaultValue="READ_ONLY"
              className="min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-4 text-base focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {roleKeys.map((r) => (
                <option key={r} value={r}>
                  {tr(r)}
                </option>
              ))}
            </select>
          </div>
          {error ? <ServerErrorBanner error={error} returnTo={`/t/${slug}/members`} /> : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t("close")}
            </Button>
            <Button type="submit" loading={busy}>
              {t("submit")}
            </Button>
          </div>
        </form>
      ) : null}
      {open && result !== null ? (
        <div className="flex flex-col gap-4">
          {result.delivery === "EMAIL" || result.inviteLink === undefined ? (
            <Banner kind="info">{t("sentEmail")}</Banner>
          ) : (
            <>
              <Banner kind="warning">{t("sentScreen")}</Banner>
              <LinkBox
                title={t("linkLabel")}
                link={result.inviteLink}
                warning={tl("warning")}
                onDismiss={onClose}
              />
            </>
          )}
          <div className="flex flex-col sm:flex-row sm:justify-end">
            <Button onClick={onClose}>{t("close")}</Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
