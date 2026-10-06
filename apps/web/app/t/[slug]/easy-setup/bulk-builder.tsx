"use client";
// Toplu raf oluşturucu (T-250): "Bölge A, raf 1–10, göz 1–5" → önizleme → tek komutla oluşturma. Kod üretimi, sınır (2.000), çakışma
// ve yetki SUNUCUDADIR (domain `previewBulkLocations`/`createBulkLocations`); burada kural yoktur: yalnızca sunucu önizlemesi ve hatası
// gösterilir. İdempotency anahtarı (UUID) girdi değişince yenilenir; aynı girdiyle yeniden gönderim aynı anahtarı taşır.
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Banner, Button, TextField } from "@wms/ui";
import { createBulkLocationsAction, previewBulkLocationsAction, searchLocationsAction } from "../warehouses/actions.ts";
import type { ServerError } from "../warehouses/warehouses-view.tsx";
import { ServerErrorBanner } from "../warehouses/warehouses-view.tsx";
import { Sheet } from "./sheet.tsx";
import { Typeahead } from "./typeahead.tsx";

interface Preview {
  readonly count: number;
  readonly first: string;
  readonly last: string;
  readonly sample: readonly string[];
  readonly conflicts: readonly string[];
  readonly conflictCount: number;
  readonly max: number;
}
interface LocOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

const NUM = { inputMode: "numeric" as const, pattern: "[0-9]*", maxLength: 3, autoComplete: "off" };
const LIST_CLS = "m-0 grid max-h-40 min-w-0 list-none grid-cols-2 gap-1 overflow-y-auto overscroll-contain rounded-card border-2 border-border bg-bg p-2 text-sm font-semibold text-ink";

function toInt(v: string): number {
  return v.trim() === "" ? Number.NaN : Number(v);
}

export function BulkBuilder({
  open,
  slug,
  warehouseId,
  returnTo,
  onClose,
  onDone,
}: {
  open: boolean;
  slug: string;
  warehouseId: string;
  returnTo: string;
  onClose: () => void;
  onDone: (r: { created: number; first: string; last: string; replayed: boolean }) => void;
}) {
  const t = useTranslations("easySetup.bulk");
  const tp = useTranslations("easySetup.picker");
  const titleId = useId();
  const [zone, setZone] = useState("A");
  const [rackFrom, setRackFrom] = useState("1");
  const [rackTo, setRackTo] = useState("10");
  const [levelFrom, setLevelFrom] = useState("1");
  const [levelTo, setLevelTo] = useState("5");
  const [parent, setParent] = useState<LocOption | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<ServerError | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const keyRef = useRef<{ sig: string; key: string } | null>(null);

  const sig = [zone, rackFrom, rackTo, levelFrom, levelTo, parent?.id ?? ""].join("|");

  // Her kapanışta başlangıç değerleri (açılışta yeni form).
  useEffect(() => {
    if (open) return;
    setZone("A");
    setRackFrom("1");
    setRackTo("10");
    setLevelFrom("1");
    setLevelTo("5");
    setParent(null);
    setPreview(null);
    setPreviewError(null);
    setError(null);
    keyRef.current = null;
  }, [open]);

  // Girdi değiştikçe sunucu önizlemesi (400 ms bekleme; eski yanıt yok sayılır).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      void previewBulkLocationsAction({
        slug,
        warehouseId,
        parentId: parent?.id ?? null,
        zone,
        rackFrom: toInt(rackFrom),
        rackTo: toInt(rackTo),
        levelFrom: toInt(levelFrom),
        levelTo: toInt(levelTo),
      }).then((r) => {
        if (!live) return;
        setLoading(false);
        if (r.ok) {
          setPreview(r.data);
          setPreviewError(null);
        } else {
          setPreview(null);
          setPreviewError({ code: r.error.code, detail: r.error.detail, requestId: r.error.requestId });
        }
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // sig tüm alanları kapsar
  }, [open, slug, warehouseId, sig]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preview === null || preview.conflictCount > 0 || loading) return;
    if (keyRef.current === null || keyRef.current.sig !== sig) keyRef.current = { sig, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    const res = await createBulkLocationsAction({
      slug,
      warehouseId,
      parentId: parent?.id ?? null,
      zone,
      rackFrom: toInt(rackFrom),
      rackTo: toInt(rackTo),
      levelFrom: toInt(levelFrom),
      levelTo: toInt(levelTo),
      idempotencyKey: keyRef.current.key,
    });
    setBusy(false);
    if (!res.ok) {
      setError({ code: res.error.code, detail: res.error.detail, requestId: res.error.requestId });
      return;
    }
    onDone(res.data);
  }

  const canSubmit = preview !== null && preview.conflictCount === 0 && !loading && !busy;
  const errScope = "bulk" as const;
  return (
    <Sheet
      open={open}
      title={t("title")}
      titleId={titleId}
      onClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={!canSubmit}>
            {preview === null ? t("submit") : t("submitCount", { count: preview.count })}
          </Button>
        </>
      }
    >
      <p className="break-words text-base text-ink-muted">{t("intro")}</p>
      <section aria-label={t("previewTitle")} data-testid="bulk-preview" aria-live="polite" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-base font-bold text-ink">{t("previewTitle")}</h3>
        {loading && preview === null ? <p className="text-sm text-ink-muted">{t("previewLoading")}</p> : null}
        {previewError ? (
          previewError.code === "VALIDATION_FAILED" && previewError.detail === undefined ? (
            <Banner kind="warning">
              {t("invalid")} {t("invalidAction")}
            </Banner>
          ) : previewError.detail === "DOCUMENT_TOO_LARGE" ? (
            <Banner kind="warning">
              {t("tooMany", { max: 2000 })} {t("tooManyAction")}
            </Banner>
          ) : (
            <ServerErrorBanner error={previewError} returnTo={returnTo} scope={errScope} />
          )
        ) : null}
        {preview === null ? null : (
          <>
            <p data-testid="bulk-summary" className="break-words text-base font-semibold text-ink">
              {preview.count === 1 ? t("previewOne", { first: preview.first }) : t("previewSummary", { count: preview.count, first: preview.first, last: preview.last })}
            </p>
            <ul aria-label={t("previewListLabel")} data-testid="bulk-preview-list" className={LIST_CLS}>
              {preview.sample.map((c) => (
                <li key={c} className="min-w-0 break-all py-1">
                  {c}
                </li>
              ))}
            </ul>
            {preview.count > preview.sample.length ? <p className="text-sm text-ink-muted">{t("previewMore", { shown: preview.sample.length })}</p> : null}
            {preview.conflictCount > 0 ? (
              <Banner kind="error">
                <p>
                  {t("conflictsTitle", { count: preview.conflictCount })}. {t("conflictsAction")}
                </p>
                <ul aria-label={t("conflictsListLabel")} data-testid="bulk-conflicts" className={`${LIST_CLS} mt-2`}>
                  {preview.conflicts.map((c) => (
                    <li key={c} className="min-w-0 break-all py-1">
                      {c}
                    </li>
                  ))}
                </ul>
                {preview.conflictCount > preview.conflicts.length ? <p className="mt-1 text-sm">{t("conflictsMore", { shown: preview.conflicts.length })}</p> : null}
              </Banner>
            ) : null}
          </>
        )}
      </section>

      <TextField label={t("zone")} hint={t("zoneHint")} name="zone" value={zone} onChange={(e) => setZone(e.target.value)} autoCapitalize="characters" autoComplete="off" maxLength={8} required />
      <TextField label={t("rackFrom")} name="rackFrom" value={rackFrom} onChange={(e) => setRackFrom(e.target.value)} required {...NUM} />
      <TextField label={t("rackTo")} name="rackTo" value={rackTo} onChange={(e) => setRackTo(e.target.value)} required {...NUM} />
      <TextField label={t("levelFrom")} name="levelFrom" value={levelFrom} onChange={(e) => setLevelFrom(e.target.value)} required {...NUM} />
      <TextField label={t("levelTo")} name="levelTo" value={levelTo} onChange={(e) => setLevelTo(e.target.value)} required {...NUM} />

      <details className="min-w-0 rounded-card border-2 border-border p-3">
        <summary className="flex min-h-12 cursor-pointer items-center text-base font-semibold">{t("advanced")}</summary>
        <div className="mt-2 flex min-w-0 flex-col gap-3">
          {parent === null ? null : (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="break-words text-sm font-semibold text-ink">{tp("selected", { name: `${parent.name} (${parent.code})` })}</p>
              <Button variant="secondary" onClick={() => setParent(null)}>
                {t("parentClear")}
              </Button>
            </div>
          )}
          <Typeahead<LocOption>
            label={t("parent")}
            hint={t("parentHint")}
            listLabel={tp("listLabel")}
            scanLabel={t("scanParent")}
            clearOnSelect
            search={async (q) => {
              const r = await searchLocationsAction({ slug, warehouseId, q, limit: 8 });
              return r.ok ? r.data : [];
            }}
            toSuggestion={(l) => ({ key: l.id, primary: l.code, secondary: l.name })}
            onSelect={setParent}
            scan={{
              resolve: async (v) => {
                const r = await searchLocationsAction({ slug, warehouseId, q: v, limit: 5 });
                if (!r.ok) return [];
                const exact = r.data.filter((l) => l.code.toLowerCase() === v.trim().toLowerCase());
                return exact.length > 0 ? exact : r.data;
              },
            }}
          />
        </div>
      </details>
      {error ? <ServerErrorBanner error={error} returnTo={returnTo} scope={errScope} /> : null}
    </Sheet>
  );
}
