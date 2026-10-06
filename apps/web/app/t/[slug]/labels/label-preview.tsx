"use client";
// Etiket önizleme ve yazdırma (T-312, ADR-022 §3). SVG metinleri `@wms/domain/labels` içinde kaçışlanmış olarak üretilir (XSS testleri
// templates.test.ts); burada yalnızca gösterilir. Yazdırma tarayıcıdan (print.css `@page 100mm 50mm`); "ZPL indir" aynı içeriği
// `.zpl` dosyası verir. Yerel köprü yalnızca `LABEL_LOCAL_BRIDGE_ENABLED` açıkken görünür ve henüz çalışmaz (ADR-022; yeni ADR eki ister).
import { useTranslations } from "next-intl";
import { Button } from "@wms/ui";
import "./print.css";

export interface LabelPreviewProps {
  /** Üretilmiş (kaçışlanmış) SVG sayfaları: etiket başına bir sayfa. */
  readonly pages: readonly string[];
  readonly zpl: string;
  readonly fileName: string;
  readonly templateVersion: string;
  readonly bridgeEnabled: boolean;
}

export function LabelPreview({ pages, zpl, fileName, templateVersion, bridgeEnabled }: LabelPreviewProps) {
  const t = useTranslations("labels");

  function downloadZpl(): void {
    const url = URL.createObjectURL(new Blob([zpl], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="flex flex-col gap-4" aria-label={t("preview")}>
      <div className="label-controls flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => window.print()}>
          {t("print")}
        </Button>
        <Button type="button" variant="secondary" onClick={downloadZpl}>
          {t("downloadZpl")}
        </Button>
        {bridgeEnabled ? (
          <Button type="button" variant="secondary" disabled>
            {t("bridge")}
          </Button>
        ) : null}
        <p className="text-sm text-ink-muted">{t("summary", { count: pages.length, version: templateVersion })}</p>
      </div>
      <div className="label-sheet" data-testid="label-sheet">
        {pages.map((svg, i) => (
          // SVG: sunucuda kaçışlanmış, yalnızca svg/rect/text/g öğeleri (templates.test.ts XSS testi).
          <div key={i} className="label-page" dangerouslySetInnerHTML={{ __html: svg }} />
        ))}
      </div>
    </section>
  );
}
