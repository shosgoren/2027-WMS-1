"use client";
// Lokasyon ağacı (T-207). Sunucu düz listeyi `(derinlik, kod, id)` sırasıyla verir (keyset); ağaç `parentId` ile BURADA kurulur
// (yalnızca gösterim). Yetki/iş kuralları sunucudadır: `canManage` yalnızca kilit gösterimidir; tür/derinlik/ebeveyn
// kuralları (ör. TRANSIT yalnızca kök) yeniden yazılmaz, sunucu reddi (`PARENT_INVALID` vb.) gösterilir.
// Düzey etiketleri (Bölge/Raf/Göz) şimdilik sabit i18n varsayılanıdır; tenant terminolojisi okuyucusu Bulgular'da.
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Banner, Button, ConfirmDialog, EmptyState } from "@wms/ui";
import { BulkBuilder } from "../../easy-setup/bulk-builder.tsx";
import { PageBody } from "../../easy-setup/sheet.tsx";
import { SetupGuide, isSetupComplete, useSetupProgress } from "../../easy-setup/setup-guide.tsx";
import { archiveLocationAction, createLocationAction, getSetupProgressAction, loadMoreLocationsAction, suggestCodeAction } from "../actions.ts";
import { CreateDialog, ServerErrorBanner } from "../warehouses-view.tsx";
import type { ServerError } from "../warehouses-view.tsx";

export const KINDS = ["RECEIVING", "STORAGE", "STAGING", "TRANSIT"] as const;

export interface LocationItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly depth: number;
  readonly kind: string;
  readonly status: "ACTIVE" | "ARCHIVED";
}

export interface TreeCursor {
  readonly depth: number;
  readonly code: string;
  readonly id: string;
}

const BADGE = "inline-flex items-center rounded-full px-2 text-xs font-bold";
const TOGGLE =
  "inline-flex size-12 shrink-0 items-center justify-center rounded-control border-2 border-border-strong bg-surface text-lg font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const LINK_CLS =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-control px-2 text-base font-semibold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Bir seferde en çok bu kadar kademe girinti (mobilde yatay taşma olmasın); daha derinde düzey rozeti yol gösterir. */
const MAX_INDENT_STEPS = 4;
const INDENT_PX = 14;

function levelKey(depth: number): "zone" | "rack" | "bin" | "deeper" {
  return depth === 0 ? "zone" : depth === 1 ? "rack" : depth === 2 ? "bin" : "deeper";
}

export function LocationTree({
  slug,
  warehouseId,
  warehouseName,
  warehouseCode,
  warehouseActive,
  canManage,
  initialItems,
  initialNext,
}: {
  slug: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  warehouseActive: boolean;
  canManage: boolean;
  initialItems: readonly LocationItem[];
  initialNext: TreeCursor | null;
}) {
  const t = useTranslations("warehouses.tree");
  const tk = useTranslations("warehouses.kind");
  const tw = useTranslations("warehouses");
  const tb = useTranslations("easySetup.bulk");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const base = `/t/${encodeURIComponent(slug)}/warehouses`;
  const returnTo = `${base}/${encodeURIComponent(warehouseId)}`;

  const [items, setItems] = useState<readonly LocationItem[]>(initialItems);
  const [next, setNext] = useState<TreeCursor | null>(initialNext);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialItems.filter((i) => i.parentId === null).map((i) => i.id)));
  const [parent, setParent] = useState<{ readonly id: string | null; readonly label: string } | undefined>(undefined);
  const [archiving, setArchiving] = useState<LocationItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<{ error: ServerError; scope: "warehouse" | "location" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const writable = canManage && warehouseActive;
  const [bulkOpen, setBulkOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const progress = useSetupProgress(slug, canManage, version);
  const guide = canManage && progress !== null && !isSetupComplete(progress);

  // Rehberin büyük düğmesi `?bulk=1` ile gelir: oluşturucuyu aç, adresi temizle.
  useEffect(() => {
    if (params.get("bulk") === "1" && writable) {
      setBulkOpen(true);
      router.replace(pathname);
    }
  }, [params, writable, pathname, router]);

  // `router.refresh()` sonrası sunucu verisi yeni gelir: yerel (daha fazla yüklenmiş) liste sunucuyla eşitlenir.
  useEffect(() => {
    setItems(initialItems);
    setNext(initialNext);
  }, [initialItems, initialNext]);

  const children = useMemo(() => {
    const m = new Map<string | null, LocationItem[]>();
    for (const it of items) {
      const list = m.get(it.parentId) ?? [];
      list.push(it);
      m.set(it.parentId, list);
    }
    return m;
  }, [items]);

  const visible = useMemo(() => {
    const out: LocationItem[] = [];
    const walk = (parentId: string | null) => {
      for (const it of children.get(parentId) ?? []) {
        out.push(it);
        if (expanded.has(it.id)) walk(it.id);
      }
    };
    walk(null);
    return out;
  }, [children, expanded]);

  function toggle(id: string) {
    const n = new Set(expanded);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setExpanded(n);
  }

  async function archive() {
    if (archiving === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await archiveLocationAction({ slug, locationId: archiving.id });
    setBusy(false);
    setArchiving(null);
    if (!res.ok) {
      setError({ error: { code: res.error.code, detail: res.error.detail, requestId: res.error.requestId }, scope: "location" });
      return;
    }
    setNotice(t("done.archived"));
    router.refresh();
  }

  async function loadMore() {
    if (next === null) return;
    setMore(true);
    setError(null);
    const res = await loadMoreLocationsAction({ slug, warehouseId, after: next });
    setMore(false);
    if (!res.ok) {
      setError({ error: { code: res.error.code, detail: res.error.detail, requestId: res.error.requestId }, scope: "location" });
      return;
    }
    setItems((cur) => [...cur, ...res.data.items.map((i) => ({ id: i.id, parentId: i.parentId, code: i.code, name: i.name, depth: i.depth, kind: i.kind, status: i.status }))]);
    setNext(res.data.next);
  }

  const lockText = !canManage ? tw("lockedReason") : !warehouseActive ? t("warehouseArchived") : null;

  return (
    <>
      <PageBody hide={bulkOpen || parent !== undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={base} className={LINK_CLS}>
            {t("back")}
          </Link>
          <h1 className="break-words text-2xl font-extrabold text-ink">{warehouseName}</h1>
          <p className="break-all text-base text-ink-muted">{tw("codeLabel", { code: warehouseCode })}</p>
        </div>
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:*:shrink-0 sm:*:whitespace-nowrap">
          <Button onClick={() => setParent({ id: null, label: warehouseName })} disabled={!writable} aria-describedby={lockText === null ? undefined : "tree-locked"}>
            {t("addRoot")}
          </Button>
          <Button variant="secondary" onClick={() => setBulkOpen(true)} disabled={!writable} aria-describedby={lockText === null ? undefined : "tree-locked"}>
            {tb("open")}
          </Button>
          {lockText === null ? null : (
            <p id="tree-locked" className="max-w-xs break-words text-sm text-ink-muted">
              {lockText}
            </p>
          )}
        </div>
      </div>

      {notice ? <Banner kind="info">{notice}</Banner> : null}
      {error ? <ServerErrorBanner error={error.error} returnTo={returnTo} scope={error.scope} /> : null}
      {guide && progress !== null ? <SetupGuide slug={slug} progress={progress} /> : null}

      <section aria-label={t("label")} className="flex min-w-0 flex-col gap-3">
        {visible.length === 0 ? (
          guide ? null : <EmptyState title={t("empty")} description={writable ? t("emptyAction") : t("emptyReadOnly")} />
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" role="tree" aria-label={t("label")}>
            {visible.map((it) => {
              const hasChildren = (children.get(it.id) ?? []).length > 0;
              const open = expanded.has(it.id);
              const active = it.status === "ACTIVE";
              const noteId = `loc-lock-${it.id}`;
              return (
                <li
                  key={it.id}
                  role="treeitem"
                  aria-level={it.depth + 1}
                  aria-expanded={hasChildren ? open : undefined}
                  data-testid="location-row"
                  style={{ marginLeft: Math.min(it.depth, MAX_INDENT_STEPS) * INDENT_PX }}
                  className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border bg-surface p-3 shadow-card"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    {hasChildren ? (
                      <button type="button" className={TOGGLE} aria-label={t(open ? "collapse" : "expand", { name: it.name })} aria-expanded={open} onClick={() => toggle(it.id)}>
                        {open ? "−" : "+"}
                      </button>
                    ) : null}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="min-w-0 break-words text-base font-bold text-ink">{it.name}</span>
                      <span className="min-w-0 break-all text-sm text-ink-muted">{tw("codeLabel", { code: it.code })}</span>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className={`${BADGE} bg-accent-soft text-accent-ink`}>{tk(it.kind)}</span>
                        <span className={`${BADGE} bg-locked-bg text-locked-ink`}>{t(`level.${levelKey(it.depth)}`)}</span>
                        {active ? null : <span className={`${BADGE} bg-warning-bg text-warning-ink`}>{tw("status.ARCHIVED")}</span>}
                      </div>
                    </div>
                  </div>
                  {active ? (
                    <div role="group" aria-label={tw("actionsFor", { name: it.name })} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:*:shrink-0 sm:*:whitespace-nowrap">
                      <Button variant="secondary" disabled={!writable} aria-describedby={lockText === null ? undefined : noteId} onClick={() => setParent({ id: it.id, label: `${it.name} (${it.code})` })}>
                        {t("addChild")}
                      </Button>
                      <Button variant="danger" disabled={!writable} aria-describedby={lockText === null ? undefined : noteId} onClick={() => setArchiving(it)}>
                        {t("archive")}
                      </Button>
                    </div>
                  ) : null}
                  {active && lockText !== null ? (
                    <p id={noteId} className="break-words text-sm text-ink-muted">
                      {lockText}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {next === null ? null : (
          <div>
            <Button variant="secondary" loading={more} onClick={() => void loadMore()}>
              {t("more")}
            </Button>
          </div>
        )}
      </section>
      </PageBody>

      <BulkBuilder
        open={bulkOpen}
        slug={slug}
        warehouseId={warehouseId}
        returnTo={returnTo}
        onClose={() => setBulkOpen(false)}
        onDone={async (r) => {
          setBulkOpen(false);
          setNotice(r.replayed ? tb("doneReplayed", { count: r.created }) : tb("done", { count: r.created, first: r.first, last: r.last }));
          setVersion((n) => n + 1);
          // Rehberin 3. adımı: ürün yoksa ürün formuna git.
          const p = await getSetupProgressAction({ slug });
          if (p.ok && !p.data.hasItem) router.push(`/t/${encodeURIComponent(slug)}/items?new=1`);
          else router.refresh();
        }}
      />
      <CreateDialog
        open={parent !== undefined}
        title={parent?.id === null || parent === undefined ? t("createRootTitle") : t("createChildTitle")}
        intro={parent === undefined ? undefined : t("parentIs", { parent: parent.label })}
        kinds={KINDS}
        returnTo={returnTo}
        scope="location"
        suggest={async () => {
          const r = await suggestCodeAction({ slug, kind: "location", warehouseId });
          return r.ok ? r.data.code : null;
        }}
        onClose={() => setParent(undefined)}
        onDone={() => {
          setVersion((n) => n + 1);
          // Yeni alt lokasyon görünsün: ebeveyn açılır.
          const pid = parent?.id;
          if (pid !== undefined && pid !== null) setExpanded((cur) => new Set(cur).add(pid));
          setParent(undefined);
          setNotice(t("done.created"));
          router.refresh();
        }}
        submit={async (v) => {
          const res = await createLocationAction({ slug, warehouseId, parentId: parent?.id ?? null, code: v.code, name: v.name, kind: v.kind, autoCode: v.autoCode });
          return res.ok ? { ok: true, data: res.data } : { ok: false, error: { code: res.error.code, detail: res.error.detail, requestId: res.error.requestId } };
        }}
      />
      <ConfirmDialog
        open={archiving !== null}
        title={t("confirmArchive.title", { name: archiving?.name ?? "" })}
        description={t("confirmArchive.description", { name: archiving?.name ?? "", code: archiving?.code ?? "" })}
        confirmLabel={t("confirmArchive.button")}
        cancelLabel={tw("form.cancel")}
        loading={busy}
        onConfirm={() => void archive()}
        onCancel={() => setArchiving(null)}
      />
    </>
  );
}
