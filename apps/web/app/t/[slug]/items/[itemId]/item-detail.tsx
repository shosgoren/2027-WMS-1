"use client";
// Ürün ayrıntısı (T-216). Kurallar SUNUCUDADIR: değişmez alanlar (A-87), katsayı biçimi/ölçeği (I-09), barkod belirsizliği (A-69) ve
// yetki domain'de uygulanır; burada yalnızca gösterilir. Katsayı ve miktar alanları DİZGİ olarak kalır (`Number`'a çevrilmez).
// Mobilde kart/liste görünümü (tablo yok → yatay taşma yok). Sunucu reddi neden + sonraki eylemle gösterilir.
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Banner, Button, ConfirmDialog, TextField } from "@wms/ui";
import { PageBody } from "../../easy-setup/sheet.tsx";
import { CodeChangedNotice, CodeEditDialog } from "../../code-edit-dialog.tsx";
import { addBarcodeAction, archiveItemAction, removeBarcodeAction, setConversionAction, updateItemAction } from "../actions.ts";
import { BADGE, LINK_CLS, SELECT_CLS, ServerErrorBanner, toServerError } from "../items-view.tsx";
import type { ServerError, UnitOption } from "../items-view.tsx";

export interface ItemDetailItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly baseUnitId: string;
  readonly baseUnitCode: string;
  readonly trackingMode: string;
  readonly quantityScale: number;
  readonly pickPolicy: string;
}
export interface ConversionView {
  readonly unitId: string;
  readonly unitCode: string;
  readonly unitName: string;
  readonly factor: string;
}
export interface BarcodeView {
  readonly id: string;
  readonly barcode: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly quantity: string;
  readonly ambiguous: boolean;
}

const PICK = ["FIFO", "FEFO"] as const;

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-border bg-surface p-4 shadow-card">
      <h2 id={id} className="break-words text-xl font-bold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function ItemDetail({
  slug,
  canManage,
  inUse,
  units,
  item,
  conversions,
  barcodes,
}: {
  slug: string;
  canManage: boolean;
  inUse: boolean;
  units: readonly UnitOption[];
  item: ItemDetailItem;
  conversions: readonly ConversionView[];
  barcodes: readonly BarcodeView[];
}) {
  const t = useTranslations("items");
  const td = useTranslations("items.detail");
  const tt = useTranslations("items.tracking");
  const tp = useTranslations("items.pick");
  const router = useRouter();
  const base = `/t/${encodeURIComponent(slug)}/items`;
  const returnTo = `${base}/${encodeURIComponent(item.id)}`;
  const active = item.status === "ACTIVE";
  const writable = canManage && active;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ServerError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [removing, setRemoving] = useState<BarcodeView | null>(null);
  const [round, setRound] = useState(0);
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeChanged, setCodeChanged] = useState<{ readonly from: string; readonly to: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const otherUnits = units.filter((u) => u.id !== item.baseUnitId);

  /** Ortak eylem sarmalayıcısı: hata banner'da kalır; başarıda bildirim + sunucu verisini yenile. */
  async function run(name: string, doneKey: string, call: () => Promise<{ ok: true } | { ok: false; error: ServerError }>): Promise<boolean> {
    setBusy(name);
    setError(null);
    setNotice(null);
    const res = await call();
    setBusy(null);
    if (!res.ok) {
      setError(toServerError(res.error));
      return false;
    }
    setNotice(td(doneKey));
    setRound((n) => n + 1);
    router.refresh();
    return true;
  }

  async function changeCode(code: string) {
    const r = await updateItemAction({ slug, itemId: item.id, code });
    return r.ok ? ({ ok: true, changed: r.data.changed } as const) : ({ ok: false, error: toServerError(r.error) } as const);
  }
  /** "Geri al" (N-03): eski koda dönüş aynı sunucu komutudur; eski kod başkasına verildiyse sunucu reddi gösterilir. */
  async function undoCode() {
    if (codeChanged === null) return;
    setUndoing(true);
    setError(null);
    const r = await changeCode(codeChanged.from);
    setUndoing(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setCodeChanged(null);
    setNotice(td("done.codeUndone"));
    router.refresh();
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    await run("save", "done.saved", async () => {
      const r = await updateItemAction({ slug, itemId: item.id, name: String(f.get("name") ?? ""), pickPolicy: String(f.get("pickPolicy") ?? "") });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    });
  }
  async function onConversion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    // Katsayı DİZGİ olarak iletilir (I-09); biçim/ölçek denetimi sunucuda.
    await run("conversion", "done.conversion", async () => {
      const r = await setConversionAction({ slug, itemId: item.id, unitId: String(f.get("unitId") ?? ""), factor: String(f.get("factor") ?? "") });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    });
  }
  async function onBarcode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const unitId = String(f.get("unitId") ?? "");
    const quantity = String(f.get("quantity") ?? "").trim();
    await run("barcode", "done.barcodeAdded", async () => {
      const r = await addBarcodeAction({ slug, itemId: item.id, unitId: unitId === "" ? null : unitId, barcode: String(f.get("barcode") ?? ""), quantity: quantity === "" ? null : quantity });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    });
  }
  async function onRemove() {
    if (removing === null) return;
    const target = removing;
    setRemoving(null);
    await run("remove", "done.barcodeRemoved", async () => {
      const r = await removeBarcodeAction({ slug, barcodeId: target.id });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    });
  }
  async function onArchive() {
    setArchiveOpen(false);
    await run("archive", "done.archived", async () => {
      const r = await archiveItemAction({ slug, itemId: item.id });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    });
  }

  return (
    <>
      <PageBody hide={codeOpen}>
      <div className="flex min-w-0 flex-col gap-2">
        <Link href={base} className={`${LINK_CLS} self-start`}>
          {td("back")}
        </Link>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="min-w-0 break-words text-2xl font-extrabold text-ink">{item.name}</h1>
          <span className={`${BADGE} ${active ? "bg-accent-soft text-accent-ink" : "bg-locked-bg text-locked-ink"}`}>{active ? t("status.ACTIVE") : t("status.ARCHIVED")}</span>
        </div>
        <p className="min-w-0 break-all text-base text-ink-muted">{t("codeLabel", { code: item.code })}</p>
        {writable ? (
          <div>
            <Button variant="secondary" onClick={() => setCodeOpen(true)} aria-label={td("codeEdit.for", { name: item.name })}>
              {td("codeEdit.button")}
            </Button>
          </div>
        ) : null}
        {canManage ? null : <p className="break-words text-sm text-ink-muted">{t("lockedReason")}</p>}
        {active ? null : <Banner kind="info">{td("archivedNote")}</Banner>}
      </div>

      {codeChanged ? <CodeChangedNotice from={codeChanged.from} to={item.code === codeChanged.from ? codeChanged.to : item.code} busy={undoing} onUndo={() => void undoCode()} /> : null}
      {notice ? <Banner kind="info">{notice}</Banner> : null}
      {error ? <ServerErrorBanner error={error} returnTo={returnTo} /> : null}

      <Section id="sec-card" title={td("cardTitle")}>
        <form key={`save-${round}`} onSubmit={(e) => void onSave(e)} className="flex min-w-0 flex-col gap-4">
          <TextField label={t("form.name")} name="name" defaultValue={item.name} autoComplete="off" required maxLength={512} disabled={!writable} />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="detail-pick" className="text-base font-semibold">
              {t("form.pick")}
            </label>
            <select id="detail-pick" name="pickPolicy" defaultValue={item.pickPolicy} disabled={!writable} className={SELECT_CLS}>
              {PICK.map((k) => (
                <option key={k} value={k}>
                  {tp(k)}
                </option>
              ))}
            </select>
          </div>
          {writable ? (
            <div>
              <Button type="submit" loading={busy === "save"}>
                {td("save")}
              </Button>
            </div>
          ) : null}
        </form>
        <dl className="m-0 flex min-w-0 flex-col gap-2">
          <div className="min-w-0">
            <dt className="text-sm font-semibold text-ink-muted">{t("form.baseUnit")}</dt>
            <dd className="m-0 break-words text-base text-ink">{item.baseUnitCode}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-sm font-semibold text-ink-muted">{t("form.scale")}</dt>
            <dd className="m-0 break-words text-base text-ink">{item.quantityScale === 0 ? t("form.scaleInteger") : t("form.scaleDecimals", { count: item.quantityScale })}</dd>
          </div>
          {item.trackingMode === "NONE" ? null : (
            <div className="min-w-0">
              <dt className="text-sm font-semibold text-ink-muted">{t("form.tracking")}</dt>
              <dd className="m-0 break-words text-base text-ink">{tt(item.trackingMode)}</dd>
            </div>
          )}
        </dl>
        <p className="break-words text-sm text-ink-muted">{inUse ? td("lockedInUse") : td("lockedFixed")}</p>
      </Section>

      <Section id="sec-conv" title={td("conversionsTitle")}>
        <p className="break-words text-sm text-ink-muted">{td("conversionsHint", { unit: item.baseUnitCode })}</p>
        {conversions.length === 0 ? (
          <p className="break-words text-base text-ink-muted">{td("conversionsEmpty")}</p>
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {conversions.map((c) => (
              <li key={c.unitId} data-testid="conversion-row" className="min-w-0 break-words rounded-card border-2 border-border p-3 text-base text-ink">
                {td("conversionLine", { unit: c.unitCode, factor: c.factor, base: item.baseUnitCode })}
              </li>
            ))}
          </ul>
        )}
        {writable ? (
          <form key={`conv-${round}`} onSubmit={(e) => void onConversion(e)} className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="conv-unit" className="text-base font-semibold">
                {td("conversionUnit")}
              </label>
              <select id="conv-unit" name="unitId" required defaultValue={otherUnits[0]?.id ?? ""} className={SELECT_CLS}>
                {otherUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code} · {u.name}
                  </option>
                ))}
              </select>
            </div>
            <TextField label={td("conversionFactor", { base: item.baseUnitCode })} hint={td("conversionFactorHint")} name="factor" inputMode="decimal" autoComplete="off" required maxLength={64} />
            <div>
              <Button type="submit" loading={busy === "conversion"}>
                {td("conversionSave")}
              </Button>
            </div>
          </form>
        ) : null}
      </Section>

      <Section id="sec-bc" title={td("barcodesTitle")}>
        <p className="break-words text-sm text-ink-muted">{td("barcodesHint")}</p>
        {barcodes.length === 0 ? (
          <p className="break-words text-base text-ink-muted">{td("barcodesEmpty")}</p>
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {barcodes.map((b) => (
              <li key={b.id} data-testid="barcode-row" className="flex min-w-0 flex-col gap-2 rounded-card border-2 border-border p-3">
                <span className="min-w-0 break-all text-base font-semibold text-ink">{b.barcode}</span>
                <span className="min-w-0 break-words text-sm text-ink-muted">{td("barcodeMeta", { unit: b.unitCode, quantity: b.quantity })}</span>
                {b.ambiguous ? <Banner kind="warning">{td("barcodeAmbiguous")}</Banner> : null}
                {writable ? (
                  <div>
                    <Button variant="secondary" onClick={() => setRemoving(b)} aria-label={td("barcodeRemoveFor", { barcode: b.barcode })}>
                      {td("barcodeRemove")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {writable ? (
          <form key={`bc-${round}`} onSubmit={(e) => void onBarcode(e)} className="flex min-w-0 flex-col gap-3">
            <TextField label={td("barcodeValue")} hint={td("barcodeValueHint")} name="barcode" autoComplete="off" autoCapitalize="off" required maxLength={512} />
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="bc-unit" className="text-base font-semibold">
                {td("barcodeUnit")}
              </label>
              <select id="bc-unit" name="unitId" defaultValue="" className={SELECT_CLS}>
                <option value="">{td("barcodeUnitBase", { unit: item.baseUnitCode })}</option>
                {otherUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code} · {u.name}
                  </option>
                ))}
              </select>
            </div>
            <TextField label={td("barcodeQuantity")} hint={td("barcodeQuantityHint")} name="quantity" inputMode="decimal" autoComplete="off" maxLength={64} />
            <div>
              <Button type="submit" loading={busy === "barcode"}>
                {td("barcodeAdd")}
              </Button>
            </div>
          </form>
        ) : null}
      </Section>

      {writable ? (
        <Section id="sec-archive" title={td("archiveTitle")}>
          <p className="break-words text-sm text-ink-muted">{td("archiveHint")}</p>
          <div>
            <Button variant="danger" onClick={() => setArchiveOpen(true)} loading={busy === "archive"}>
              {td("archive")}
            </Button>
          </div>
        </Section>
      ) : null}

      </PageBody>

      <CodeEditDialog
        open={codeOpen}
        subject={item.name}
        current={item.code}
        titleId="code-edit-item-title"
        onClose={() => setCodeOpen(false)}
        submit={changeCode}
        renderError={(e) => <ServerErrorBanner error={e} returnTo={returnTo} />}
        onDone={(r) => {
          setCodeOpen(false);
          setError(null);
          if (r.changed) {
            setNotice(null);
            setCodeChanged({ from: r.from, to: r.to });
          } else setNotice(td("done.codeSame"));
          router.refresh();
        }}
      />
      <ConfirmDialog
        open={archiveOpen}
        title={td("confirmArchive.title", { name: item.name })}
        description={td("confirmArchive.description", { name: item.name, code: item.code })}
        confirmLabel={td("confirmArchive.button")}
        cancelLabel={t("form.cancel")}
        variant="danger"
        onConfirm={() => void onArchive()}
        onCancel={() => setArchiveOpen(false)}
      />
      <ConfirmDialog
        open={removing !== null}
        title={td("confirmRemove.title")}
        description={td("confirmRemove.description", { barcode: removing?.barcode ?? "" })}
        confirmLabel={td("confirmRemove.button")}
        cancelLabel={t("form.cancel")}
        variant="danger"
        onConfirm={() => void onRemove()}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
