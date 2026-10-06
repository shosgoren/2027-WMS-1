"use client";
// Üyeler ekranı (T-119). Yetki ve iş kuralları SUNUCUDADIR: burada yalnızca sunucudan gelen durum gösterilir
// (`users.manage` kararı sayfada `listPendingInvitations` sonucundan; sıfırlama uygunluğu `resetLinkAvailable`).
// Sunucu reddi neden ayrıştırılmadan gösterilir (2. tur m6). Mobilde kart görünümü; tablo yok (yatay taşma yok).
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Banner, Button, ConfirmDialog, EmptyState } from "@wms/ui";
import { changeRoleAction, issuePasswordResetLinkAction, removeMemberAction, revokeInvitationAction, transferOwnershipAction } from "./actions.ts";
import { InviteDialog, LinkBox, ServerErrorBanner } from "./invite-dialog.tsx";
import type { ServerError } from "./invite-dialog.tsx";

export interface MemberView {
  /** Komutların `memberId`/`toMemberId` alanı üyelik kimliğidir (kullanıcı kimliği değil). */
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly roles: readonly string[];
  readonly isOwner: boolean;
  readonly isDemo: boolean;
  readonly resetLinkAvailable: boolean;
}

export interface PendingView {
  readonly invitationId: string;
  readonly email: string;
  readonly role: string;
  readonly expiresAt: string;
  readonly invitedBy: string;
}

type Kind = "role" | "remove" | "transfer" | "reset";
interface Confirm {
  readonly kind: Kind;
  readonly member: MemberView;
  readonly roleKey?: string;
}

const SELECT =
  "min-h-12 w-full min-w-0 rounded-card border-2 border-border bg-surface px-3 text-base text-ink sm:w-auto focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const BADGE = "inline-flex items-center rounded-full px-2 text-xs font-bold";

export function MembersView({
  slug,
  selfUserId,
  members,
  pending,
  roleKeys,
}: {
  slug: string;
  selfUserId: string;
  members: readonly MemberView[];
  /** `null`: yönetim yetkisi yok. */
  pending: readonly PendingView[] | null;
  roleKeys: readonly string[];
}) {
  const t = useTranslations("members");
  const tr = useTranslations("roles");
  const format = useFormatter();
  const router = useRouter();
  const canManage = pending !== null;
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [revoking, setRevoking] = useState<PendingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [resetUnavailable, setResetUnavailable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<{ name: string; link: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const returnTo = `/t/${slug}/members`;

  const roleName = (keys: readonly string[]) => keys.map((k) => tr(k)).join(", ");
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  function fail(res: { error: { code: string; detail?: string | undefined; requestId: string } }, kind?: Kind) {
    // Sıfırlama reddi: neden ayrıştırılmaz, nötr metin (2. tur m6); kimlik/oturum/MFA yönlendirmeleri korunur.
    if (kind === "reset" && res.error.code === "FORBIDDEN" && res.error.detail === undefined) {
      setResetUnavailable(true);
      return;
    }
    setError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
  }

  async function run() {
    if (confirm === null) return;
    const { kind, member } = confirm;
    setBusy(true);
    setError(null);
    setResetUnavailable(false);
    setNotice(null);
    setResetLink(null);
    if (kind === "reset") {
      const res = await issuePasswordResetLinkAction({ slug, memberId: member.membershipId });
      setBusy(false);
      setConfirm(null);
      if (!res.ok) return fail(res, kind);
      setResetLink({ name: member.displayName, link: res.data.resetLink });
      return;
    }
    const res =
      kind === "role"
        ? await changeRoleAction({ slug, memberId: member.membershipId, roleKey: confirm.roleKey })
        : kind === "remove"
          ? await removeMemberAction({ slug, memberId: member.membershipId })
          : await transferOwnershipAction({ slug, toMemberId: member.membershipId });
    setBusy(false);
    setConfirm(null);
    if (!res.ok) return fail(res);
    setNotice(t(`done.${kind}`));
    router.refresh();
  }

  async function revoke() {
    if (revoking === null) return;
    setBusy(true);
    setError(null);
    const res = await revokeInvitationAction({ slug, invitationId: revoking.invitationId });
    setBusy(false);
    setRevoking(null);
    if (!res.ok) return fail(res);
    setNotice(t("pending.revoked"));
    router.refresh();
  }

  const confirmText = confirm
    ? {
        title: t(`confirm.${confirm.kind}.title`),
        description: t(`confirm.${confirm.kind}.description`, {
          name: confirm.member.displayName,
          role: confirm.roleKey === undefined ? "" : tr(confirm.roleKey),
        }),
        button: t(`confirm.${confirm.kind}.button`),
      }
    : { title: "", description: "", button: "" };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-extrabold text-ink">{t("title")}</h1>
          <p className="break-words text-base text-ink-muted">{t("intro")}</p>
        </div>
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:*:shrink-0 sm:*:whitespace-nowrap">
          <Button onClick={() => setInviteOpen(true)} disabled={!canManage} aria-describedby={canManage ? undefined : "invite-locked"}>
            {t("invite")}
          </Button>
          {canManage ? null : (
            <p id="invite-locked" className="max-w-xs break-words text-sm text-ink-muted">
              {t("lockedReason")}
            </p>
          )}
        </div>
      </div>

      {notice ? <Banner kind="info">{notice}</Banner> : null}
      {error ? <ServerErrorBanner error={error} returnTo={returnTo} /> : null}
      {resetUnavailable ? <Banner kind="error">{t("unavailableReason")}</Banner> : null}
      {resetLink ? (
        <LinkBox title={`${t("linkBox.resetTitle")} · ${resetLink.name}`} link={resetLink.link} warning={t("linkBox.resetWarning")} onDismiss={() => setResetLink(null)} />
      ) : null}

      <section aria-label={t("membersList")} className="flex min-w-0 flex-col gap-3">
        {members.length === 0 ? (
          <EmptyState title={t("empty")} description={t("emptyAction")} />
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
            {members.map((m) => {
              const self = m.userId === selfUserId;
              // Demo satırı: rol/çıkarma/devir için ayrı nötr metin; sıfırlama kilidi 2. tur m6 metninde kalır.
              const lockText = !canManage ? t("lockedReason") : m.isDemo ? t("demoLocked") : null;
              const resetLocked = !canManage || m.isDemo || !m.resetLinkAvailable;
              const resetText = !canManage ? t("lockedReason") : m.isDemo || !m.resetLinkAvailable ? t("unavailableReason") : null;
              const current = m.roles[0] ?? "";
              const selected = draft[m.userId] ?? current;
              const noteId = `lock-${m.userId}`;
              return (
                <li key={m.userId} data-testid="member-card" className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-border bg-surface p-4 shadow-card">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-lg font-bold text-ink">{m.displayName}</span>
                    {m.isOwner ? <span className={`${BADGE} bg-warning-bg text-warning-ink`}>{t("ownerBadge")}</span> : null}
                    {self ? <span className={`${BADGE} bg-accent-soft text-accent-ink`}>{t("selfBadge")}</span> : null}
                    {m.isDemo ? <span className={`${BADGE} bg-locked-bg text-locked-ink`}>{t("demoBadge")}</span> : null}
                  </div>
                  <p className="min-w-0 truncate text-base text-ink-muted" title={m.email}>
                    {m.email}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {roleName(m.roles)} · {t("statusActive")}
                  </p>
                  {self ? null : (
                    <div role="group" aria-label={t("actionsFor", { name: m.displayName })} className="flex min-w-0 flex-col gap-2">
                      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:*:shrink-0 sm:*:whitespace-nowrap">
                        <select
                          aria-label={`${t("role")} · ${m.displayName}`}
                          className={SELECT}
                          value={selected}
                          disabled={lockText !== null}
                          onChange={(e) => setDraft({ ...draft, [m.userId]: e.target.value })}
                        >
                          {roleKeys.map((r) => (
                            <option key={r} value={r}>
                              {tr(r)}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="secondary"
                          disabled={lockText !== null || selected === current}
                          aria-describedby={lockText === null ? undefined : noteId}
                          onClick={() => setConfirm({ kind: "role", member: m, roleKey: selected })}
                        >
                          {t("applyRole")}
                        </Button>
                      </div>
                      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:*:shrink-0 sm:*:whitespace-nowrap">
                        <Button variant="danger" disabled={lockText !== null} aria-describedby={lockText === null ? undefined : noteId} onClick={() => setConfirm({ kind: "remove", member: m })}>
                          {t("remove")}
                        </Button>
                        {m.isOwner ? null : (
                          <Button variant="secondary" disabled={lockText !== null} aria-describedby={lockText === null ? undefined : noteId} onClick={() => setConfirm({ kind: "transfer", member: m })}>
                            {t("transfer")}
                          </Button>
                        )}
                        <Button variant="secondary" disabled={resetLocked} aria-describedby={resetText === null ? undefined : `${noteId}-reset`} onClick={() => setConfirm({ kind: "reset", member: m })}>
                          {t("resetLink")}
                        </Button>
                      </div>
                      {lockText === null ? null : (
                        <p id={noteId} className="break-words text-sm text-ink-muted">
                          {lockText}
                        </p>
                      )}
                      {resetText === null ? null : (
                        <p id={`${noteId}-reset`} className="break-words text-sm text-ink-muted">
                          {resetText}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label={t("pending.title")} className="flex min-w-0 flex-col gap-3">
        <h2 className="break-words text-xl font-bold text-ink">{t("pending.title")}</h2>
        {pending === null ? (
          <p className="break-words text-base text-ink-muted">{t("pending.locked")}</p>
        ) : pending.length === 0 ? (
          <p className="break-words text-base text-ink-muted">{t("pending.empty")}</p>
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
            {pending.map((p) => (
              <li key={p.invitationId} data-testid="pending-card" className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4 shadow-card">
                <p className="min-w-0 break-all text-base font-bold text-ink">{p.email}</p>
                <p className="text-sm text-ink-muted">
                  {tr(p.role)} · {t("pending.expires", { date: when(p.expiresAt) })}
                </p>
                <p className="break-words text-sm text-ink-muted">{t("pending.invitedBy", { name: p.invitedBy })}</p>
                <div>
                  <Button variant="secondary" onClick={() => setRevoking(p)}>
                    {t("pending.revoke")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <InviteDialog
        open={inviteOpen}
        slug={slug}
        roleKeys={roleKeys}
        onClose={() => setInviteOpen(false)}
        onInvited={() => router.refresh()}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={confirmText.title}
        description={confirmText.description}
        confirmLabel={confirmText.button}
        cancelLabel={t("confirmCancel")}
        variant={confirm?.kind === "remove" ? "danger" : "primary"}
        loading={busy}
        onConfirm={() => void run()}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={revoking !== null}
        title={t("pending.revokeTitle")}
        description={t("pending.revokeDescription", { email: revoking?.email ?? "" })}
        confirmLabel={t("pending.revoke")}
        cancelLabel={t("confirmCancel")}
        loading={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}
