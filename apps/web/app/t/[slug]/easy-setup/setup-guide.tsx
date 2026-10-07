"use client";
// Boş ekran rehberi (T-250): "1) Depo ekle → 2) Rafları oluştur → 3) Ürün ekle". Tamamlanan adım işaretlidir (ikon + metin, yalnız renk değil);
// sıradaki adım TEK büyük düğmedir ve doğru ekrana götürür (`?new=1` / `?bulk=1` ilgili formu açar). İlerleme sunucudan okunur
// (`getSetupProgressAction`); iş kuralı (neyin "tamam" sayıldığı) domain'dedir.
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleCheck } from "@wms/ui";
import { getSetupProgressAction } from "../warehouses/actions.ts";

export interface SetupProgressView {
  readonly hasWarehouse: boolean;
  readonly hasLocation: boolean;
  readonly hasItem: boolean;
  readonly nextWarehouseId: string | null;
}

/** İlerlemeyi yükler; `version` değişince yeniden okur. Hata durumunda `null` (rehber gösterilmez, sayfa çalışır). */
export function useSetupProgress(slug: string, enabled: boolean, version: number): SetupProgressView | null {
  const [progress, setProgress] = useState<SetupProgressView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void getSetupProgressAction({ slug }).then((r) => {
      if (live && r.ok) setProgress(r.data);
    });
    return () => {
      live = false;
    };
  }, [slug, enabled, version]);
  return progress;
}

export function isSetupComplete(p: SetupProgressView): boolean {
  return p.hasWarehouse && p.hasLocation && p.hasItem;
}

const BTN_BIG =
  "inline-flex min-h-14 w-full items-center justify-center rounded-control bg-accent px-6 text-lg font-bold text-on-accent focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const STEP_LINK =
  "inline-flex min-h-12 min-w-12 items-center rounded-control px-1 text-base font-semibold text-accent-ink underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function SetupGuide({ slug, progress }: { slug: string; progress: SetupProgressView }) {
  const t = useTranslations("easySetup.guide");
  const base = `/t/${encodeURIComponent(slug)}`;
  const steps = [
    { key: "warehouse" as const, done: progress.hasWarehouse, href: `${base}/warehouses?new=1`, locked: false },
    {
      key: "locations" as const,
      done: progress.hasLocation,
      href: progress.nextWarehouseId === null ? null : `${base}/warehouses/${encodeURIComponent(progress.nextWarehouseId)}?bulk=1`,
      locked: progress.nextWarehouseId === null,
    },
    { key: "items" as const, done: progress.hasItem, href: `${base}/items?new=1`, locked: false },
  ];
  const next = steps.find((s) => !s.done && !s.locked);
  return (
    <section aria-labelledby="setup-guide-title" data-testid="setup-guide" className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-border bg-surface p-4 shadow-card">
      <div className="min-w-0">
        <h2 id="setup-guide-title" className="break-words text-xl font-extrabold text-ink">
          {t("title")}
        </h2>
        <p className="break-words text-base text-ink-muted">{t("intro")}</p>
      </div>
      <ol aria-label={t("listLabel")} className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
        {steps.map((s, i) => (
          <li key={s.key} data-step={s.key} data-done={s.done} className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden="true"
              className={`mt-1 flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${s.done ? "bg-success-bg text-success-ink" : "bg-accent-soft text-accent-ink"}`}
            >
              {s.done ? <CircleCheck className="size-5 text-success" /> : i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="break-words text-base font-bold text-ink">
                {t(`${s.key}.title`)} <span className="text-sm font-semibold text-ink-muted">· {s.done ? t("done") : t("todo")}</span>
              </span>
              <span className="break-words text-sm text-ink-muted">{s.locked ? t("locations.locked") : t(`${s.key}.hint`)}</span>
              {s.href !== null && !s.done && s !== next ? (
                <Link href={s.href} className={`${STEP_LINK} self-start`}>
                  {t(`${s.key}.action`)}
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {next === undefined || next.href === null ? null : (
        <Link href={next.href} data-testid="setup-next" className={BTN_BIG}>
          {t(`${next.key}.action`)}
        </Link>
      )}
    </section>
  );
}
