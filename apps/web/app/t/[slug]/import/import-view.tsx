"use client";
// Açılış verisi içe aktarma ekranı (T-289): tek sayfa rehber — 1) şablonu indir 2) dosyayı seç 3) önizleme 4) içe aktar 5) sonuç.
// İş kuralları SUNUCUDADIR: ayrıştırma/doğrulama/yetki/idempotans domain'de (`import-parse`, `import-apply`); burada yalnız dosyayı okuma,
// sunucu yanıtını gösterme ve parçaları sırayla çağırma var. Dosya içeriği yalnız bellekte tutulur (diske/loga yazılmaz, G-09).
// Hata varken "İçe aktar" kapalıdır ve nedeni yanında yazar; uygulama sırasında ilerleme gösterilir ve ilk hatada durulur.
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Banner, ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert } from "@wms/ui";
import { applyImportChunkAction, previewImportAction } from "./actions.ts";

export interface ImportViewProps {
  readonly slug: string;
  readonly templates: { readonly products: string; readonly stock: string };
  readonly columns: { readonly products: readonly string[]; readonly stock: readonly string[] };
  readonly limits: { readonly maxBytes: number; readonly maxRows: number; readonly chunkSize: number };
}

// Türler sunucu eyleminin dönüşünden türetilir (istemci paketine domain içe aktarımı girmez, T-127b).
type PreviewResult = Awaited<ReturnType<typeof previewImportAction>>;
type ApplyResult = Awaited<ReturnType<typeof applyImportChunkAction>>;
type ImportPreview = Extract<PreviewResult, { ok: true }>["data"];
type ImportIssue = ImportPreview["issues"][number];
type ChunkReport = Extract<ApplyResult, { ok: true }>["data"];

interface SafeErr {
  readonly code: string;
  readonly requestId?: string | undefined;
}
type Stage = "idle" | "previewing" | "ready" | "applying" | "done";

/** İlk görünümde gösterilen hata kartı (satır) sayısı; "Tümünü göster" ile hepsi (domain en çok 100 hata döner). */
const FIRST_CARDS = 10;
/** Sonuçta listelenen en çok başarısız satır; fazlası "ve N satır daha" ile söylenir (sessiz kesme yok). */
const FAILED_SHOWN = 20;
const FOCUS = "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus";
const SECONDARY = `${FOCUS} inline-flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-control border-2 border-border-strong bg-surface px-5 text-base font-bold text-ink`;
const KNOWN_ERRORS = ["forbidden", "unauthenticated", "validation_failed", "rate_limited", "not_found", "tenant_suspended", "tenant_closing", "internal"];
const COLUMN_KEY: Readonly<Record<string, string>> = {
  kod: "code",
  ad: "name",
  "temel birim": "baseUnit",
  "koli içi adet": "packQty",
  "adet barkodu": "unitBarcode",
  "koli barkodu": "packBarcode",
  "ürün kodu": "itemCode",
  "raf kodu": "shelfCode",
  miktar: "quantity",
  dosya: "file",
};

function errorKey(code: string): string {
  const k = code.toLowerCase();
  return KNOWN_ERRORS.includes(k) ? k : "unknown";
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Step({ n, title, current, muted, children }: { n: number; title: string; current?: boolean; muted?: boolean; children?: ReactNode }) {
  return (
    <li aria-current={current === true ? "step" : undefined} data-step={n} className={`flex min-w-0 gap-3 ${muted === true ? "opacity-70" : ""}`}>
      <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-full text-base font-extrabold ${current === true ? "bg-accent-soft text-accent-ink" : "bg-locked-bg text-locked-ink"}`}>
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h2 className="break-words text-lg font-bold leading-8 text-ink">{title}</h2>
        {children}
      </div>
    </li>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: "bad" }) {
  return (
    <div className={`flex min-w-0 flex-1 flex-col rounded-card px-2 py-2 text-center ${tone === "bad" ? "bg-danger-bg text-danger-ink" : "bg-accent-soft text-accent-ink"}`}>
      <span className="text-2xl font-extrabold leading-8">{value}</span>
      <span className="break-words text-sm font-semibold">{label}</span>
    </div>
  );
}

export function ImportView({ slug, templates, columns, limits }: ImportViewProps) {
  const t = useTranslations("import");
  const te = useTranslations("serverErrors");
  const [stage, setStage] = useState<Stage>("idle");
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [clientError, setClientError] = useState<"tooBig" | "readFailed" | null>(null);
  const [serverError, setServerError] = useState<SafeErr | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [reports, setReports] = useState<readonly ChunkReport[]>([]);
  const [fatal, setFatal] = useState<SafeErr | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Başlık açılışta görünür olsun: uygulama kabuğunun içerik alanı kendi içinde kayar ve sayfa geçişinde kaydırma konumunu korur (ayarlar sayfasındaki
  // bağlantı sayfanın altındadır); bu yüzden açılışta başlık görünür alana alınır.
  useEffect(() => {
    headingRef.current?.scrollIntoView({ block: "nearest" }); // görünürse kaydırmaz (masaüstünde üst çubuğu kesmez); üstte kalmışsa üste getirir
  }, []);
  // Önizleme hazır olunca özet görünür alana gelir (telefonda adım 1-2 uzundur).
  useEffect(() => {
    if (preview !== null) summaryRef.current?.scrollIntoView({ block: "start" });
  }, [preview]);
  useEffect(() => {
    if (stage === "done") resultRef.current?.scrollIntoView({ block: "start" });
  }, [stage]);
  // Uygulama sürerken sekmeyi kapatma uyarısı.
  useEffect(() => {
    if (stage !== "applying") return;
    const h = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [stage]);

  function reset(): void {
    setStage("idle");
    setText(null);
    setFileName("");
    setPreview(null);
    setClientError(null);
    setServerError(null);
    setReports([]);
    setFatal(null);
    setProgress({ done: 0, total: 0 });
    if (inputRef.current !== null) inputRef.current.value = "";
    headingRef.current?.scrollIntoView({ block: "nearest" });
  }

  async function onFile(file: File | undefined): Promise<void> {
    setPreview(null);
    setServerError(null);
    setClientError(null);
    setReports([]);
    setFatal(null);
    setStage("idle");
    if (file === undefined) {
      setText(null);
      setFileName("");
      return;
    }
    setFileName(file.name);
    if (file.size > limits.maxBytes) {
      setText(null);
      setClientError("tooBig");
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      setText(null);
      setClientError("readFailed");
      return;
    }
    setText(content);
    setStage("previewing");
    const r = await previewImportAction({ slug, text: content });
    if (!r.ok) {
      setServerError({ code: r.error.code, requestId: r.error.requestId });
      setStage("idle");
      return;
    }
    setPreview(r.data);
    setStage("ready");
  }

  async function onApply(): Promise<void> {
    if (text === null || preview === null || preview.issueTotal > 0) return;
    setStage("applying");
    setReports([]);
    setFatal(null);
    const total = preview.rowCount;
    setProgress({ done: 0, total });
    const acc: ChunkReport[] = [];
    for (let c = 0; c < preview.chunkCount; c++) {
      const r = await applyImportChunkAction({ slug, text, chunk: c, digest: preview.digest });
      if (!r.ok) {
        setFatal({ code: r.error.code, requestId: r.error.requestId });
        break;
      }
      acc.push(r.data);
      setReports([...acc]);
      setProgress({ done: Math.min(total, (c + 1) * limits.chunkSize), total });
      if (!r.data.complete) break;
    }
    setStage("done");
  }

  const blocked = preview !== null && preview.issueTotal > 0;
  // Boş şablon: hata değil, yönlendirici uyarı ("şablona en az bir satır ekle").
  const onlyNoRows = blocked && preview.issues.length === 1 && preview.issues[0]?.code === "NO_ROWS";
  const applied = reports.flatMap((r) => r.rows);
  const failedRows = applied.filter((r) => r.status === "FAILED");
  const count = (s: string): number => applied.filter((r) => r.status === s).length;
  const existingCount = count("UNCHANGED") + count("REPLAYED"); // "zaten vardı": yeni yazılmadı
  const addedCount = count("CREATED") + count("UPDATED") + count("APPLIED");
  // Denenmeyen = rapor edilen NOT_ATTEMPTED satırları + hiç rapor edilmeyen satırlar (durdurulan/erişilemeyen parçalar).
  const notTried = preview === null ? 0 : count("NOT_ATTEMPTED") + Math.max(0, preview.rowCount - applied.length);
  const failedCount = failedRows.length + (fatal === null ? 0 : 1);
  const incomplete = fatal !== null || failedRows.length > 0 || notTried > 0;
  const kindKey = preview?.kind === "STOCK" ? "stock" : "products";
  const isStock = preview?.kind === "STOCK";
  const pickFixed = (): void => inputRef.current?.click();
  const busy = stage === "applying" || stage === "previewing";

  return (
    <>
      <h1 ref={headingRef} className="scroll-mt-2 break-words text-2xl font-extrabold text-ink phone:text-xl">
        {t("title")}
      </h1>
      <p className="text-base text-ink-muted">{t("intro")}</p>
      <ol className="m-0 flex min-w-0 list-none flex-col gap-5 p-0">
        <Step n={1} title={t("step1.title")} current={stage === "idle" && text === null}>
          <p className="text-base text-ink-muted">{t("step1.hint")}</p>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <button type="button" className={SECONDARY} onClick={() => download("urunler-sablon.csv", templates.products)}>
              {t("step1.products")}
            </button>
            <button type="button" className={SECONDARY} onClick={() => download("acilis-stoku-sablon.csv", templates.stock)}>
              {t("step1.stock")}
            </button>
          </div>
          <p className="break-words text-sm text-ink-muted">{t("step1.columnsProducts", { cols: columns.products.join(", ") })}</p>
          <p className="break-words text-sm text-ink-muted">{t("step1.columnsStock", { cols: columns.stock.join(", ") })}</p>
        </Step>

        <Step n={2} title={t("step2.title")} current={stage === "idle" && text === null}>
          {/* Yerel dosya girdisi yalnız ekran okuyucu/klavye içindir (sr-only, display:none DEĞİL: odak alabilir); görünen denetim ≥ 48 px etikettir. */}
          <input
            ref={inputRef}
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => void onFile(e.target.files?.[0])}
            aria-describedby="import-file-status import-file-hint"
            className="peer sr-only"
          />
          <label
            htmlFor="import-file"
            className={`${SECONDARY} peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus cursor-pointer self-start peer-disabled:cursor-not-allowed peer-disabled:opacity-60`}
          >
            {t("step2.label")}
          </label>
          <p id="import-file-status" className="break-words text-base font-semibold text-ink">
            {fileName === "" ? t("step2.none") : t("step2.chosen", { name: fileName })}
          </p>
          <p id="import-file-hint" className="text-sm text-ink-muted">
            {t("step2.hint", { kb: Math.round(limits.maxBytes / 1024), rows: limits.maxRows })}
          </p>
          {clientError === null ? null : (
            <Banner kind="error">
              <p>{t(`clientErrors.${clientError}`, { kb: Math.round(limits.maxBytes / 1024) })}</p>
            </Banner>
          )}
          {serverError === null ? null : (
            <Banner kind="error">
              <p>
                {te(errorKey(serverError.code))} {te(`${errorKey(serverError.code)}Action`)}
              </p>
            </Banner>
          )}
        </Step>

        {preview === null ? (
          <>
            <Step n={3} title={t("step3.title")} muted>
              {stage === "previewing" ? (
                <p role="status" className="text-base text-ink-muted">
                  {t("step3.checking")}
                </p>
              ) : null}
            </Step>
            <Step n={4} title={t("step4.title")} muted />
            <Step n={5} title={t("step5.title")} muted />
          </>
        ) : (
          <>
            <Step n={3} title={t("step3.title")} current={stage === "ready"}>
              <div ref={summaryRef} role="status" data-testid="import-summary" className="flex scroll-mt-2 min-w-0 flex-col gap-2">
                <p className="break-words text-base font-semibold text-ink">
                  {t(`kind.${kindKey}`)} · <span className="font-normal text-ink-muted">{fileName}</span>
                </p>
                {preview.summary === undefined ? null : (
                  <>
                    <p className="break-words text-base font-semibold text-ink" data-testid="import-summary-line">
                      {t(isStock ? "summary.lineStock" : "summary.lineProducts", { total: preview.rowCount, ok: preview.rowCount - preview.summary.errorRows, bad: preview.summary.errorRows })}
                    </p>
                    <div className="flex min-w-0 gap-2">
                      <Stat value={preview.summary.items} label={t("summary.items")} />
                      {isStock ? <Stat value={preview.summary.stockLines} label={t("summary.stockLines")} /> : null}
                      <Stat value={preview.summary.errorRows} label={t("summary.errorRows")} tone={preview.summary.errorRows > 0 ? "bad" : undefined} />
                    </div>
                  </>
                )}
                {!blocked && preview.products !== undefined ? (
                  <p className="break-words text-base text-ink">
                    {t("detail.products", { create: preview.products.create, existing: preview.products.existing, packs: preview.products.packs, barcodes: preview.products.barcodes })}
                    {preview.products.willCreatePackUnit ? ` ${t("detail.packUnit")}` : ""}
                  </p>
                ) : null}
                {!blocked && preview.stock !== undefined ? (
                  <>
                    <p className="break-words text-base text-ink">
                      {preview.stock.lines === preview.stock.alreadyApplied ? t("detail.stockNothing") : t("detail.stock", { warehouses: preview.stock.warehouses, total: preview.stock.totalQuantity })}
                      {preview.stock.alreadyApplied > 0 ? ` ${t("detail.stockSkipped", { n: preview.stock.alreadyApplied })}` : ""}
                    </p>
                    {preview.stock.tenantHasStock && stage !== "done" ? (
                      <Banner kind="warning">
                        <p>{t("detail.stockExists")}</p>
                      </Banner>
                    ) : null}
                  </>
                ) : null}
                {onlyNoRows ? (
                  <Banner kind="warning">
                    <p>{t("noRows")}</p>
                    <button type="button" className={`${SECONDARY} mt-2 w-full`} onClick={pickFixed} disabled={busy}>
                      {t("issues.pickFixed")}
                    </button>
                  </Banner>
                ) : blocked ? (
                  <Banner kind="error">
                    <p>{t("blocked", { n: preview.issueTotal })}</p>
                    <button type="button" className={`${SECONDARY} mt-2 w-full`} onClick={pickFixed} disabled={busy}>
                      {t("issues.pickFixed")}
                    </button>
                  </Banner>
                ) : stage === "done" ? null : (
                  <Banner kind="success">
                    <p>{t("clean")}</p>
                  </Banner>
                )}
              </div>
              {blocked && !onlyNoRows ? <IssueList issues={preview.issues} total={preview.issueTotal} /> : null}
            </Step>

            <Step n={4} title={t("step4.title")} current={stage === "ready" && !blocked}>
              {stage === "done" ? (
                <p className={`flex items-start gap-2 break-words text-base font-semibold ${incomplete ? "text-danger-ink" : "text-success-ink"}`} data-testid="import-step4-status">
                  {incomplete ? <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" /> : <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />}
                  <span className="min-w-0">{incomplete ? t("step4.partial") : t("step4.done")}</span>
                </p>
              ) : (
                <div className="flex min-w-0 flex-col gap-2">
                  <button
                    type="button"
                    data-variant="primary"
                    disabled={blocked || stage !== "ready"}
                    aria-busy={stage === "applying" || undefined}
                    onClick={() => void onApply()}
                    aria-describedby="import-apply-note"
                    className={`${FOCUS} inline-flex min-h-12 min-w-12 items-center justify-center rounded-control px-6 text-base font-bold ${blocked || stage !== "ready" ? "cursor-not-allowed border-2 border-border bg-locked-bg text-locked-ink" : "bg-accent text-on-accent"}`}
                  >
                    {t("step4.apply")}
                  </button>
                  <p id="import-apply-note" className="break-words text-sm text-ink-muted">
                    {onlyNoRows ? t("step4.noRows") : blocked ? t("step4.blocked", { n: preview.issueTotal }) : t("step4.note")}
                  </p>
                  {stage === "applying" ? (
                    <div aria-live="polite" role="status" className="flex min-w-0 flex-col gap-1">
                      <progress className="h-3 w-full" max={progress.total} value={progress.done} aria-label={t("step4.progress", progress)} />
                      <p className="text-sm font-semibold text-ink">{t("step4.progress", progress)}</p>
                    </div>
                  ) : null}
                </div>
              )}
            </Step>

            {stage === "done" ? (
              <Step n={5} title={t("step5.title")} current>
                <div ref={resultRef} data-testid="import-result" className="flex scroll-mt-2 min-w-0 flex-col gap-2">
                  <Banner kind={incomplete ? "error" : "success"}>
                    <p>{incomplete ? t("result.partial", { n: addedCount }) : resultSummary(t, preview.kind, count)}</p>
                    {incomplete ? <p className="mt-1">{t(isStock ? "result.retryStock" : "result.retryProducts")}</p> : null}
                  </Banner>
                  <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0" data-testid="import-counts">
                    {existingCount > 0 ? (
                      <li className="flex items-start gap-2 text-base font-semibold text-info-ink">
                        <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-info" />
                        <span className="min-w-0">{t("result.stat.existing", { n: existingCount })}</span>
                      </li>
                    ) : null}
                    {incomplete || failedCount > 0 ? (
                      <li className="flex items-start gap-2 text-base font-semibold text-danger-ink">
                        <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                        <span className="min-w-0">{t("result.stat.failed", { n: failedCount })}</span>
                      </li>
                    ) : null}
                    {incomplete || notTried > 0 ? (
                      <li className="flex items-start gap-2 text-base font-semibold text-warning-ink">
                        <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                        <span className="min-w-0">{t("result.stat.skipped", { n: notTried })}</span>
                      </li>
                    ) : null}
                  </ul>
                  {fatal === null ? null : (
                    <p className="flex items-start gap-2 break-words text-base text-danger-ink">
                      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                      <span className="min-w-0">
                        {te(errorKey(fatal.code))} {te(`${errorKey(fatal.code)}Action`)}
                      </span>
                    </p>
                  )}
                  {failedRows.length === 0 ? null : (
                    <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0" data-testid="import-failed-rows">
                      {failedRows.slice(0, FAILED_SHOWN).map((r) => (
                        <li key={r.row} className="flex min-w-0 items-start gap-2 break-words text-base text-ink">
                          <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                          <span className="min-w-0">
                            {t("result.failedRow", { row: r.row, code: r.code })}{" "}
                            {r.reason !== undefined ? t(`result.reason.${r.reason}`) : rowErrorText(te, t, r.errorCode ?? "unknown")}
                          </span>
                        </li>
                      ))}
                      {failedRows.length > FAILED_SHOWN ? (
                        <li className="text-base font-semibold text-ink-muted" data-testid="import-failed-more">
                          {t("result.moreFailed", { n: failedRows.length - FAILED_SHOWN })}
                        </li>
                      ) : null}
                    </ul>
                  )}
                  {!incomplete && preview.kind === "PRODUCTS" ? <p className="text-base text-ink-muted">{t("result.nextStock")}</p> : null}
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <button type="button" className={SECONDARY} onClick={reset}>
                      {incomplete ? t("result.again") : t("result.another")}
                    </button>
                    <Link href={`/t/${encodeURIComponent(slug)}/items`} className={SECONDARY}>
                      {isStock ? t("result.toStock") : t("result.toItems")}
                      <ChevronRight aria-hidden="true" className="size-5" />
                    </Link>
                  </div>
                </div>
              </Step>
            ) : (
              <Step n={5} title={t("step5.title")} muted />
            )}
          </>
        )}
      </ol>
    </>
  );
}

type Translate = ReturnType<typeof useTranslations>;

/** Satır hatası metni: yetki/oturum/hız gibi kullanıcının bildiği nedenler sunucu hata sözlüğünden, diğerleri tek sade cümle (satır başına uzun metin yok). */
function rowErrorText(te: Translate, t: Translate, code: string): string {
  const k = errorKey(code);
  return ["forbidden", "unauthenticated", "rate_limited", "tenant_suspended", "tenant_closing"].includes(k) ? `${te(k)} ${te(`${k}Action`)}` : t("result.failedGeneric");
}

/** Başarılı sonuç özeti: yalnız sıfırdan büyük sayılar yazılır; "zaten vardı" sayısı ayrı satırda (ikon + renk) gösterilir, burada tekrarlanmaz. */
function resultSummary(t: Translate, kind: "PRODUCTS" | "STOCK", count: (s: string) => number): string {
  const parts = [t("result.okLead")];
  if (kind === "STOCK") {
    if (count("APPLIED") > 0) parts.push(t("result.stockApplied", { n: count("APPLIED") }));
  } else {
    if (count("CREATED") > 0) parts.push(t("result.created", { n: count("CREATED") }));
    if (count("UPDATED") > 0) parts.push(t("result.updated", { n: count("UPDATED") }));
  }
  if (parts.length === 1) parts.push(t("result.none"));
  return parts.join(" ");
}

function IssueList({ issues, total }: { issues: readonly ImportIssue[]; total: number }) {
  const t = useTranslations("import");
  const [all, setAll] = useState(false);
  // Aynı satırın hataları tek kartta (sıra korunur).
  const groups: { row: number; items: ImportIssue[] }[] = [];
  for (const i of issues) {
    const g = groups.find((x) => x.row === i.row);
    if (g === undefined) groups.push({ row: i.row, items: [i] });
    else g.items.push(i);
  }
  const shown = all ? groups : groups.slice(0, FIRST_CARDS);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="break-words text-base font-semibold text-ink">{total > issues.length ? t("issues.truncated", { shown: issues.length, total }) : t("issues.all", { total })}</p>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="import-issues">
        {shown.map((g) => (
          <li key={g.row} data-testid="import-issue" className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-3 shadow-card">
            <p className="text-base font-bold text-ink" data-testid="issue-row">
              {g.row === 0 ? t("issues.file") : t("issues.row", { row: g.row })}
            </p>
            <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
              {g.items.map((i, idx) => (
                <li key={`${i.column}-${i.code}-${idx}`} data-testid="issue-item" className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-base font-bold text-ink" data-testid="issue-column">
                    {t(`column.${COLUMN_KEY[i.column] ?? "file"}`)}
                  </p>
                  <p data-testid="issue-reason" className="flex min-w-0 items-start gap-2 break-words text-base text-danger-ink">
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                    <span className="min-w-0">{t(`issue.${i.code}.reason`, { ...i.params })}</span>
                  </p>
                  <p data-testid="issue-fix" className="break-words text-base text-ink">
                    {t("issues.fixPrefix")} {t(`issue.${i.code}.fix`, { ...i.params })}
                  </p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {groups.length > FIRST_CARDS ? (
        <button type="button" className={`${SECONDARY} self-start`} aria-expanded={all} onClick={() => setAll(!all)} data-testid="issues-toggle">
          {all ? t("issues.less") : t("issues.more", { n: groups.length })}
        </button>
      ) : null}
    </div>
  );
}
