"use client";
// Açılış verisi içe aktarma ekranı (T-289): tek sayfa rehber — 1) şablonu indir 2) dosyayı seç 3) önizleme 4) içe aktar 5) sonuç.
// İş kuralları SUNUCUDADIR: ayrıştırma/doğrulama/yetki/idempotans domain'de (`import-parse`, `import-apply`); burada yalnız dosyayı okuma,
// sunucu yanıtını gösterme ve parçaları sırayla çağırma var. Dosya içeriği yalnız bellekte tutulur (diske/loga yazılmaz, G-09).
// Hata varken "İçe aktar" kapalıdır ve nedeni yanında yazar; uygulama sırasında ilerleme gösterilir ve ilk hatada durulur.
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Banner, Button, CircleAlert, ChevronRight, TriangleAlert } from "@wms/ui";
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

/** Gösterilen en çok hata sayısı (domain en çok 100 döner; rubrik İ-06). */
const SHOW_ISSUES = 50;
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
  const summaryRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Önizleme hazır olunca özet görünür alana gelir (telefonda adım 1-2 uzundur).
  useEffect(() => {
    if (preview !== null) summaryRef.current?.scrollIntoView({ block: "start" });
  }, [preview]);
  useEffect(() => {
    if (stage === "done") resultRef.current?.scrollIntoView({ block: "start" });
  }, [stage]);
  // Uygulama sürerken sekmeyi kapatma uyarısı (yarım kalan içe aktarma aynı dosya yeniden yüklenerek tamamlanır; yine de sor).
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
      const r = await applyImportChunkAction({ slug, text, chunk: c });
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

  const issues = preview?.issues ?? [];
  const blocked = preview !== null && preview.issueTotal > 0;
  const applied = reports.flatMap((r) => r.rows);
  const failedRows = applied.filter((r) => r.status === "FAILED");
  const notAttempted = applied.filter((r) => r.status === "NOT_ATTEMPTED").length + (preview === null ? 0 : Math.max(0, preview.chunkCount - reports.length) * limits.chunkSize);
  const incomplete = fatal !== null || failedRows.length > 0 || reports.length < (preview?.chunkCount ?? 0);
  const count = (s: string): number => applied.filter((r) => r.status === s).length;
  const kindKey = preview?.kind === "STOCK" ? "stock" : "products";

  return (
    <>
      <h1 className="break-words text-2xl font-extrabold text-ink phone:text-xl">{t("title")}</h1>
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
          <label htmlFor="import-file" className="text-base font-semibold text-ink">
            {t("step2.label")}
          </label>
          <input
            ref={inputRef}
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            disabled={stage === "applying" || stage === "previewing"}
            onChange={(e) => void onFile(e.target.files?.[0])}
            aria-describedby="import-file-hint"
            className={`${FOCUS} block w-full min-w-0 cursor-pointer rounded-card border-2 border-border-strong bg-surface text-base text-ink file:mr-3 file:min-h-12 file:cursor-pointer file:border-0 file:bg-accent-soft file:px-5 file:text-base file:font-bold file:text-accent-ink disabled:opacity-60`}
          />
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
              <p className="mt-1 text-sm">{te("code", { code: serverError.code })}</p>
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
              <div ref={summaryRef} role="status" data-testid="import-summary" className="flex scroll-mt-3 min-w-0 flex-col gap-2">
                <p className="break-words text-base font-semibold text-ink">
                  {t(`kind.${kindKey}`)} · <span className="font-normal text-ink-muted">{fileName}</span>
                </p>
                {preview.summary === undefined ? null : (
                  <div className="flex min-w-0 gap-2">
                    <Stat value={preview.summary.items} label={t("summary.items")} />
                    <Stat value={preview.summary.stockLines} label={t("summary.stockLines")} />
                    <Stat value={preview.summary.errorRows} label={t("summary.errorRows")} tone={preview.summary.errorRows > 0 ? "bad" : undefined} />
                  </div>
                )}
                {!blocked && preview.products !== undefined ? (
                  <p className="break-words text-base text-ink">
                    {t("detail.products", { create: preview.products.create, existing: preview.products.existing, packs: preview.products.packs, barcodes: preview.products.barcodes })}
                    {preview.products.willCreatePackUnit ? ` ${t("detail.packUnit")}` : ""}
                  </p>
                ) : null}
                {!blocked && preview.stock !== undefined ? (
                  <>
                    <p className="break-words text-base text-ink">{t("detail.stock", { warehouses: preview.stock.warehouses, total: preview.stock.totalQuantity })}</p>
                    {preview.stock.tenantHasStock ? (
                      <Banner kind="warning">
                        <p>{t("detail.stockExists")}</p>
                      </Banner>
                    ) : null}
                  </>
                ) : null}
                {blocked ? (
                  <Banner kind="error">
                    <p>{t("blocked", { n: preview.issueTotal })}</p>
                  </Banner>
                ) : (
                  <Banner kind="success">
                    <p>{t("clean")}</p>
                  </Banner>
                )}
              </div>
              {blocked ? <IssueList issues={issues} total={preview.issueTotal} /> : null}
            </Step>

            {stage === "done" ? null : (
              <Step n={4} title={t("step4.title")} current={stage === "ready" && !blocked}>
                <div className="flex min-w-0 flex-col gap-2">
                  <Button variant="primary" disabled={blocked || stage !== "ready"} loading={stage === "applying"} onClick={() => void onApply()} aria-describedby="import-apply-note">
                    {t("step4.apply")}
                  </Button>
                  <p id="import-apply-note" className="break-words text-sm text-ink-muted">
                    {blocked ? t("step4.blocked", { n: preview.issueTotal }) : t("step4.note")}
                  </p>
                  {stage === "applying" ? (
                    <div aria-live="polite" role="status" className="flex min-w-0 flex-col gap-1">
                      <progress className="h-3 w-full" max={progress.total} value={progress.done} aria-label={t("step4.progress", progress)} />
                      <p className="text-sm font-semibold text-ink">{t("step4.progress", progress)}</p>
                    </div>
                  ) : null}
                </div>
              </Step>
            )}

            {stage === "done" ? (
              <Step n={5} title={t("step5.title")} current>
                <div ref={resultRef} data-testid="import-result" className="flex scroll-mt-3 min-w-0 flex-col gap-2">
                  {incomplete ? (
                    <Banner kind="error">
                      <p>{t("result.partial", { done: count("CREATED") + count("UPDATED") + count("UNCHANGED") + count("APPLIED") + count("REPLAYED"), failed: failedRows.length + (fatal === null ? 0 : 1), notTried: notAttempted })}</p>
                      <p className="mt-1">{t("result.retry")}</p>
                    </Banner>
                  ) : (
                    <Banner kind="success">
                      <p>{preview.kind === "STOCK" ? t("result.okStock", { applied: count("APPLIED"), replayed: count("REPLAYED") }) : t("result.okProducts", { created: count("CREATED"), updated: count("UPDATED"), unchanged: count("UNCHANGED") })}</p>
                    </Banner>
                  )}
                  {fatal === null ? null : (
                    <p className="flex items-start gap-2 break-words text-base text-danger-ink">
                      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
                      <span className="min-w-0">
                        {te(errorKey(fatal.code))} {te(`${errorKey(fatal.code)}Action`)}
                      </span>
                    </p>
                  )}
                  {failedRows.length === 0 ? null : (
                    <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
                      {failedRows.slice(0, SHOW_ISSUES).map((r) => (
                        <li key={r.row} className="flex min-w-0 items-start gap-2 break-words text-base text-ink">
                          <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
                          <span className="min-w-0">
                            {t("result.failedRow", { row: r.row, code: r.code })} {te(errorKey(r.errorCode ?? "unknown"))} {te(`${errorKey(r.errorCode ?? "unknown")}Action`)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!incomplete && preview.kind === "PRODUCTS" ? <p className="text-base text-ink-muted">{t("result.nextStock")}</p> : null}
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <button type="button" className={SECONDARY} onClick={reset}>
                      {incomplete ? t("result.again") : t("result.another")}
                    </button>
                    <Link href={`/t/${encodeURIComponent(slug)}/items`} className={SECONDARY}>
                      {t("result.toItems")}
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

function IssueList({ issues, total }: { issues: readonly ImportIssue[]; total: number }) {
  const t = useTranslations("import");
  const shown = issues.slice(0, SHOW_ISSUES);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="break-words text-base font-semibold text-ink">{total > shown.length ? t("issues.truncated", { shown: shown.length, total }) : t("issues.all", { total })}</p>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="import-issues">
        {shown.map((i, idx) => (
          <li key={`${i.row}-${i.column}-${i.code}-${idx}`} data-testid="import-issue" className="flex min-w-0 flex-col gap-0.5 rounded-card bg-surface p-3 shadow-card">
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-base font-bold text-ink">
              <span data-testid="issue-row">{i.row === 0 ? t("issues.file") : t("issues.row", { row: i.row })}</span>
              <span aria-hidden="true">·</span>
              <span data-testid="issue-column">{t(`column.${COLUMN_KEY[i.column] ?? "file"}`)}</span>
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
    </div>
  );
}
