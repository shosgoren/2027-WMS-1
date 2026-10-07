"use client";
// Yönetici görev ekranı (T-304). Yetki ve iş kuralları SUNUCUDADIR: `canManage` yalnızca gösterimdir (kilit + açıklama); eylemler
// sunucuda `document.approve` ister (A-132). Atanabilir kişiler sunucuda hesaplanır (`kinds`: kişinin yapabildiği görev türleri).
// Mobilde kart görünümü (tablo yok → yatay taşma yok). Sunucu reddi neden + sonraki eylemle gösterilir.
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { Banner, Button, EmptyState, TextField } from "@wms/ui";
import { PageBody, Sheet } from "../easy-setup/sheet.tsx";
import { assignTaskAction, cancelTaskAction } from "./actions.ts";

export type TaskKindValue = "PUTAWAY" | "PICK" | "REPUTAWAY" | "COUNT";
export type TaskStatusValue = "OPEN" | "ASSIGNED" | "DONE" | "CANCELLED";

export interface TaskView {
  readonly id: string;
  readonly kind: TaskKindValue;
  readonly status: TaskStatusValue;
  readonly version: number;
  readonly quantity: string | null;
  readonly assignedName: string | null;
  readonly assignedMembershipId: string | null;
}
export interface TaskMemberView {
  readonly membershipId: string;
  readonly displayName: string;
  /** Kişinin yapabildiği görev türleri (A-132; sunucuda hesaplandı). */
  readonly kinds: readonly TaskKindValue[];
}
interface ServerError {
  readonly code: string;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
}

const KINDS: readonly TaskKindValue[] = ["PUTAWAY", "PICK", "REPUTAWAY", "COUNT"];
const STATUSES: readonly TaskStatusValue[] = ["OPEN", "ASSIGNED", "DONE", "CANCELLED"];
const KNOWN = ["forbidden", "unauthenticated", "not_found", "validation_failed", "version_conflict", "rate_limited", "tenant_suspended", "tenant_closing", "internal"];

/** Sunucu hatası → `tasks.errors.<anahtar>`; yalnızca bilinen eşlemeler, aksi halde genel `internal`. */
export function taskErrorKey(error: Pick<ServerError, "code" | "detail">): string {
  const base = error.code.toLowerCase();
  const key = KNOWN.includes(base) ? base : "internal";
  return key === "validation_failed" && error.detail === "DOCUMENT_STATE" ? "validation_failed_document_state" : key;
}

const SELECT_CLS =
  "min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-4 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const LINK_CLS =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-control px-2 text-base font-semibold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const BADGE = "inline-flex items-center rounded-full bg-accent-soft px-2 text-xs font-bold text-accent-ink";

export interface TasksViewProps {
  readonly slug: string;
  readonly canManage: boolean;
  readonly tasks: readonly TaskView[];
  readonly members: readonly TaskMemberView[];
  readonly kindFilter: TaskKindValue | "";
  readonly statusFilter: TaskStatusValue | "";
  /** Sonraki sayfa bağlantısı (keyset imleci sorgu dizesinde); yoksa `null`. */
  readonly nextHref: string | null;
  readonly firstPage: boolean;
}

export function TasksView({ slug, canManage, tasks, members, kindFilter, statusFilter, nextHref, firstPage }: TasksViewProps) {
  const t = useTranslations("tasks");
  const te = useTranslations("tasks.errors");
  const router = useRouter();
  const base = `/t/${encodeURIComponent(slug)}/tasks`;
  const [assigning, setAssigning] = useState<TaskView | null>(null);
  const [cancelling, setCancelling] = useState<TaskView | null>(null);
  const [memberId, setMemberId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const eligible = assigning === null ? [] : members.filter((m) => m.kinds.includes(assigning.kind));

  function close() {
    if (busy) return;
    setAssigning(null);
    setCancelling(null);
    setMemberId("");
    setReason("");
  }

  async function finish(res: { ok: true } | { ok: false; error: ServerError }, done: string) {
    setBusy(false);
    setAssigning(null);
    setCancelling(null);
    setMemberId("");
    setReason("");
    if (!res.ok) {
      setError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
      return;
    }
    setNotice(done);
    router.refresh();
  }

  async function submitAssign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (assigning === null || memberId === "") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    await finish(await assignTaskAction({ slug, taskId: assigning.id, membershipId: memberId, expectedVersion: assigning.version }), t("done.assigned"));
  }

  async function submitCancel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (cancelling === null || reason.trim() === "") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    await finish(await cancelTaskAction({ slug, taskId: cancelling.id, expectedVersion: cancelling.version, reason }), t("done.cancelled"));
  }

  const key = error === null ? "" : taskErrorKey(error);
  const sheetOpen = assigning !== null || cancelling !== null;

  return (
    <>
      <PageBody hide={sheetOpen}>
        <header className="min-w-0">
          <h1 className="break-words text-2xl font-extrabold text-ink">{t("title")}</h1>
          <p className="break-words text-base text-ink-muted">{t("intro")}</p>
        </header>
        {canManage ? null : (
          <div id="task-locked">
            <Banner kind="info">{t("lockedReason")}</Banner>
          </div>
        )}
        {notice === null ? null : <Banner kind="success">{notice}</Banner>}
        {error === null ? null : (
          <Banner kind="error">
            <p>
              {te(key)} {te(`${key}Action`)}
            </p>
            <p className="mt-1 break-all text-sm">
              {te("code", { code: error.detail === undefined ? error.code : `${error.code}/${error.detail}` })}
              {error.requestId ? ` · ${error.requestId}` : ""}
            </p>
          </Banner>
        )}
        <form method="get" action={base} aria-label={t("filters.label")} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-base font-semibold text-ink">
            {t("filters.kind")}
            <select name="kind" defaultValue={kindFilter} className={SELECT_CLS}>
              <option value="">{t("filters.all")}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-base font-semibold text-ink">
            {t("filters.status")}
            <select name="status" defaultValue={statusFilter} className={SELECT_CLS}>
              <option value="">{t("filters.all")}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            {t("filters.apply")}
          </Button>
        </form>
        {tasks.length === 0 ? (
          <EmptyState title={t("empty.title")} description={t("empty.action")} />
        ) : (
          <ul aria-label={t("listLabel")} className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
            {tasks.map((task) => {
              const open = task.status === "OPEN" || task.status === "ASSIGNED";
              return (
                <li key={task.id} data-testid="task-row" data-task-id={task.id} className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-4">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-words text-lg font-bold text-ink">{t(`kind.${task.kind}`)}</span>
                    <span className={BADGE}>{t(`status.${task.status}`)}</span>
                  </div>
                  <p className="break-words text-base text-ink-muted">
                    {task.assignedMembershipId === null ? t("unassigned") : task.assignedName === null ? t("assigneeUnknown") : t("assignee", { name: task.assignedName })}
                  </p>
                  {task.quantity === null ? null : <p className="break-words text-base text-ink-muted">{t("quantity", { quantity: task.quantity })}</p>}
                  {open ? (
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                      <Button
                        variant="secondary"
                        disabled={!canManage}
                        aria-describedby={canManage ? undefined : "task-locked"}
                        onClick={() => {
                          setError(null);
                          setNotice(null);
                          setAssigning(task);
                        }}
                      >
                        {task.status === "OPEN" ? t("assign") : t("reassign")}
                      </Button>
                      <Button
                        variant="danger"
                        disabled={!canManage}
                        aria-describedby={canManage ? undefined : "task-locked"}
                        onClick={() => {
                          setError(null);
                          setNotice(null);
                          setCancelling(task);
                        }}
                      >
                        {t("cancel")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <nav className="flex min-w-0 flex-wrap gap-3">
          {firstPage ? null : (
            <Link className={LINK_CLS} href={base + (kindFilter === "" && statusFilter === "" ? "" : `?${new URLSearchParams({ ...(kindFilter === "" ? {} : { kind: kindFilter }), ...(statusFilter === "" ? {} : { status: statusFilter }) }).toString()}`)}>
              {t("firstPage")}
            </Link>
          )}
          {nextHref === null ? null : (
            <Link className={LINK_CLS} href={nextHref}>
              {t("nextPage")}
            </Link>
          )}
        </nav>
      </PageBody>

      <Sheet
        open={assigning !== null}
        title={t("assignTitle")}
        titleId="task-assign-title"
        onClose={close}
        onSubmit={(e) => void submitAssign(e)}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              {t("back")}
            </Button>
            <Button type="submit" loading={busy} disabled={memberId === ""}>
              {t("submit")}
            </Button>
          </>
        }
      >
        {assigning === null ? null : <p className="break-words text-base font-bold text-ink">{t(`kind.${assigning.kind}`)}</p>}
        {eligible.length === 0 ? (
          <Banner kind="info">{t("noEligible")}</Banner>
        ) : (
          <label className="flex min-w-0 flex-col gap-1 text-base font-semibold text-ink">
            {t("member")}
            <select name="membershipId" value={memberId} onChange={(e) => setMemberId(e.target.value)} required className={SELECT_CLS}>
              <option value="">{t("memberPlaceholder")}</option>
              {eligible.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
      </Sheet>

      <Sheet
        open={cancelling !== null}
        title={t("cancelTitle")}
        titleId="task-cancel-title"
        onClose={close}
        onSubmit={(e) => void submitCancel(e)}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              {t("back")}
            </Button>
            <Button type="submit" variant="danger" loading={busy} disabled={reason.trim() === ""}>
              {t("confirmCancel")}
            </Button>
          </>
        }
      >
        {cancelling === null ? null : <p className="break-words text-base font-bold text-ink">{t(`kind.${cancelling.kind}`)}</p>}
        <TextField label={t("reasonLabel")} hint={t("reasonHint")} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" required maxLength={500} />
      </Sheet>
    </>
  );
}
