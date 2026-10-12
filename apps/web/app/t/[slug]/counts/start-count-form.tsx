"use client";
// Sayım başlatma formu (T-316): depo seç → lokasyonları işaretle (ya da açık COUNT görevinden seç) → kör sayım anahtarı → başlat.
// Kilit, süren işlem bekleme, "biri doluysa hiçbiri kilitlenmez" ve yetki kuralları `startCount` komutundadır; burada yeniden yazılmaz.
// Sunucu reddi (kod + sonraki eylem) gösterilir; `LOCATION_LOCKED` ayrıca seçilen lokasyon kodlarını sayar (sunucu hangi lokasyonun dolu olduğunu bildirmez, A-316-2).
// Anahtar: her başlatma denemesi yeni anahtar (T-277a). Lokasyon listesi 200'lük keyset sayfalarla yüklenir; liste kendi içinde kayar (sanallaştırma kütüphanesi kurulu değil).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Banner, Button, ConfirmDialog, Lock, TextField } from "@wms/ui";
import { CountErrorNotice, LINK_BTN, runAttempt, useAttemptKey } from "./[id]/count-review.tsx";
import type { ErrorInfo } from "../receipts/receipt-form.tsx";
import { listCountLocationsAction, startCountAction } from "./actions.ts";

export interface StartWarehouse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
export interface StartCountTask {
  readonly id: string;
  readonly warehouseId: string;
  readonly locationId: string;
}
interface Loc {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface Cursor {
  readonly depth: number;
  readonly code: string;
  readonly id: string;
}

const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
/** Onay kutusu: kutunun kendisi 48x48 dokunma hedefidir (eldiven/saha); işaret metinle de çizilir (renk tek taşıyıcı değildir). */
const CHECK = `grid size-12 shrink-0 appearance-none place-content-center rounded-control border-2 border-border-strong bg-surface checked:border-accent checked:bg-accent checked:text-on-accent checked:after:text-2xl checked:after:font-extrabold checked:after:content-['✓'] ${FOCUS}`;
/** Bir komutta en çok lokasyon (domain `COUNT_MAX_LOCATIONS`; yalnız seçim sınırı gösterimi, aşımı sunucu da reddeder). */
const MAX_SELECT = 200;
const SHOW_CODES = 8;

export function StartCountForm({ slug, warehouses, tasks, canStart }: { slug: string; warehouses: readonly StartWarehouse[]; tasks: readonly StartCountTask[]; canStart: boolean }) {
  const t = useTranslations("counting");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const startKey = useAttemptKey();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [locs, setLocs] = useState<readonly Loc[]>([]);
  const [next, setNext] = useState<Cursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ErrorInfo | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [blind, setBlind] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  const load = useCallback(
    async (wh: string, after: Cursor | null, append: boolean) => {
      if (wh === "") return;
      setLoading(true);
      setLoadError(null);
      try {
        const r = await listCountLocationsAction({ slug, warehouseId: wh, ...(after === null ? {} : { after }) });
        if (!r.ok) {
          setLoadError({ code: r.error.code, detail: r.error.detail, requestId: r.error.requestId });
          return;
        }
        setLocs((cur) => (append ? [...cur, ...r.data.items] : r.data.items));
        setNext(r.data.next);
      } catch {
        setLoadError({ code: "NETWORK" });
      } finally {
        setLoading(false);
      }
    },
    [slug],
  );
  useEffect(() => {
    setLocs([]);
    setNext(null);
    setSelected(new Set());
    void load(warehouseId, null, false);
  }, [warehouseId, load]);

  const toggle = (id: string): void => {
    setStarted(null);
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else if (n.size < MAX_SELECT) n.add(id);
      return n;
    });
  };
  const q = query.trim().toLowerCase();
  const visible = q === "" ? locs : locs.filter((l) => l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q));
  const byId = new Map(locs.map((l) => [l.id, l]));
  const warehouseTasks = tasks.filter((x) => x.warehouseId === warehouseId);
  const selectedCodes = [...selected].map((id) => byId.get(id)?.code ?? "").filter((c) => c !== "");

  async function start() {
    if (busyRef.current || selected.size === 0 || warehouseId === "") return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setConfirm(false);
    const out = await runAttempt(startKey, (clientKey) => startCountAction({ slug, clientKey, warehouseId, locationIds: [...selected], blind }));
    busyRef.current = false;
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setStarted(out.data.sessionId);
    setSelected(new Set());
    startTransition(() => router.refresh());
  }

  return (
    <section aria-labelledby="count-start" className="flex min-w-0 flex-col gap-3 self-start rounded-card border-2 border-border bg-surface p-4" data-testid="start-count">
      <h2 id="count-start" className="text-xl font-bold text-ink">
        {t("form.title")}
      </h2>
      {!canStart ? (
        <>
          <p className="flex items-start gap-2 text-base text-ink-muted" data-testid="start-locked">
            <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span className="min-w-0 break-words">{t("form.locked")}</span>
          </p>
          <Link href="/help" data-testid="help-link" className={LINK_BTN}>
            {t("helpCall")}
          </Link>
        </>
      ) : warehouses.length === 0 ? (
        <p className="break-words text-base text-ink-muted" data-testid="start-no-warehouse">
          {t("form.noWarehouse")}
        </p>
      ) : (
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm(true);
          }}
        >
          {started === null ? null : (
            <Banner kind="success">
              <p className="font-semibold" data-testid="start-done">
                {t("form.started")}
              </p>
              <Link href={`/t/${encodeURIComponent(slug)}/counts/${encodeURIComponent(started)}`} className="inline-flex min-h-12 items-center font-bold underline">
                {t("form.openSession")}
              </Link>
            </Banner>
          )}
          {error === null ? null : (
            <>
              <CountErrorNotice error={error} context="start" />
              {error.code === "LOCATION_LOCKED" && selectedCodes.length > 0 ? (
                <p className="break-words text-base text-ink" data-testid="start-locked-codes">
                  {t("form.lockedSelection", { codes: selectedCodes.slice(0, SHOW_CODES).join(", ") + (selectedCodes.length > SHOW_CODES ? ` +${selectedCodes.length - SHOW_CODES}` : "") })}
                </p>
              ) : null}
            </>
          )}
          {warehouses.length > 1 ? (
            <label className="flex min-w-0 flex-col gap-1 text-base font-semibold text-ink">
              {t("form.warehouse")}
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                className={`min-h-12 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-3 text-base text-ink ${FOCUS}`}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {warehouseTasks.length === 0 ? null : (
            <div className="flex min-w-0 flex-col gap-2" data-testid="count-tasks">
              <p className="text-base font-semibold text-ink">{t("form.tasks")}</p>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {warehouseTasks.map((task) => {
                  const loc = byId.get(task.locationId);
                  const on = selected.has(task.locationId);
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={loc === undefined}
                        onClick={() => toggle(task.locationId)}
                        className={`inline-flex min-h-12 min-w-12 items-center justify-center rounded-control border-2 border-border-strong bg-surface px-4 text-base font-bold text-ink aria-pressed:bg-accent-soft disabled:opacity-60 ${FOCUS}`}
                      >
                        {loc === undefined ? t("form.taskLoading") : t("form.taskPick", { code: loc.code })}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <TextField label={t("form.search")} hint={t("form.searchHint")} value={query} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
          {loadError === null ? null : <CountErrorNotice error={loadError} context="read" />}
          <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
            <legend className="mb-1 text-base font-semibold text-ink">{t("form.locations")}</legend>
            <ul className="m-0 flex max-h-72 min-w-0 list-none flex-col gap-1 overflow-y-auto p-0" data-testid="location-picker">
              {visible.map((l) => (
                <li key={l.id} className="min-w-0">
                  <label className="flex min-h-14 min-w-0 cursor-pointer items-center gap-3 rounded-control border-2 border-border bg-surface px-2 text-base text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="checkbox" className={CHECK} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                    <span className="min-w-0 break-words">
                      <span className="font-bold">{l.code}</span> {l.name === "" || l.name === l.code ? "" : <span className="text-ink-muted">· {l.name}</span>}
                    </span>
                  </label>
                </li>
              ))}
              {visible.length === 0 && !loading ? (
                <li className="break-words p-2 text-base text-ink-muted" data-testid="no-locations">
                  {t("form.noLocations")}
                </li>
              ) : null}
            </ul>
            {next === null ? null : (
              <Button variant="secondary" loading={loading} onClick={() => void load(warehouseId, next, true)}>
                {t("form.moreLocations")}
              </Button>
            )}
          </fieldset>

          <label className="flex min-h-12 min-w-0 items-center gap-3 text-base text-ink">
            <input type="checkbox" className={CHECK} checked={blind} onChange={(e) => setBlind(e.target.checked)} data-testid="blind-toggle" />
            <span className="min-w-0">
              <span className="block break-words font-semibold">{t("form.blind")}</span>
              <span className="block break-words text-sm text-ink-muted">{t("form.blindHint")}</span>
            </span>
          </label>

          <p className="break-words text-base font-semibold text-ink" aria-live="polite" data-testid="selected-count">
            {t("form.selected", { n: selected.size })}
            {selected.size >= MAX_SELECT ? ` ${t("form.selectMax", { max: MAX_SELECT })}` : ""}
          </p>
          <Button type="submit" variant="primary" loading={busy} disabled={selected.size === 0 || warehouseId === ""} data-testid="start-submit">
            {t("form.start")}
          </Button>
        </form>
      )}
      <ConfirmDialog
        open={confirm}
        title={t("form.confirmTitle")}
        description={t("form.confirmBody", { n: selected.size })}
        confirmLabel={t("form.confirmStart")}
        cancelLabel={t("cancel.back")}
        variant="primary"
        loading={busy}
        onConfirm={() => void start()}
        onCancel={() => setConfirm(false)}
      />
    </section>
  );
}
