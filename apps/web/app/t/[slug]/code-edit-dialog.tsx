"use client";
// Kodu değiştir penceresi (T-257): ürün, depo ve lokasyon ekranlarının ortak parçası. Kod normalleştirmesi, benzersizlik ve yetki
// SUNUCUDADIR (T-251 domain komutları); burada yeniden yazılmaz. İstemci yalnızca boş/aynı değeri göndermez (kısa yol, kural değil).
// Tek ekran (T-250 deseni): başlık sabit, eylem çubuğu altta sabit; eski → yeni önizlemesi ve "geçmiş hareketler etkilenmez" açıklaması
// her zaman görünür. Onay ek bir soru değildir (N-03): değişiklik geri alınabilir, bu yüzden sonuç bildiriminde "Geri al" düğmesi vardır.
// Sunucu hatası pencerede kalır, yazılan değer korunur (çağıranın `renderError` bileşeni neden + sonraki eylemi gösterir).
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Banner, Button, TextField } from "@wms/ui";
import { Sheet } from "./easy-setup/sheet.tsx";

/** Sunucu eylem hatası (`ActionResult.error`): yalnızca kod + ayrıntı + istek kimliği. */
export interface CodeEditError {
  readonly code: string;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
}

export type CodeEditResult = { readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly error: CodeEditError };

export function CodeEditDialog({
  open,
  subject,
  current,
  titleId,
  onClose,
  onDone,
  submit,
  renderError,
}: {
  open: boolean;
  /** Kartın adı (başlıkta gösterilir). */
  subject: string;
  /** Şimdiki kod (sunucunun döndürdüğü hâliyle). */
  current: string;
  titleId: string;
  onClose: () => void;
  onDone: (result: { readonly from: string; readonly to: string; readonly changed: boolean }) => void;
  submit: (code: string) => Promise<CodeEditResult>;
  renderError: (error: CodeEditError) => ReactNode;
}) {
  const t = useTranslations("codeEdit");
  const [code, setCode] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CodeEditError | null>(null);

  useEffect(() => {
    if (!open) return;
    setCode(current);
    setError(null);
    setBusy(false);
    // Her açılışta şimdiki kodla başlar; açıkken `current` değişse de yazılan korunur.
  }, [open]);

  const next = code.trim();
  const unchanged = next === "" || next === current;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unchanged || busy) return;
    setBusy(true);
    setError(null);
    const res = await submit(next);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone({ from: current, to: next, changed: res.changed });
  }

  return (
    <Sheet
      open={open}
      title={t("title", { name: subject })}
      titleId={titleId}
      onClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={unchanged}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <p className="min-w-0 break-all text-base text-ink-muted">{t("current", { code: current })}</p>
      <TextField
        label={t("newCode")}
        hint={t("newCodeHint")}
        name="newCode"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        required
        maxLength={512}
      />
      <p data-testid="code-edit-preview" aria-live="polite" className="min-w-0 break-all rounded-card bg-accent-soft p-3 text-base font-bold text-accent-ink">
        {unchanged ? t("previewSame") : t("preview", { from: current, to: next })}
      </p>
      <p className="break-words text-sm text-ink-muted">{t("history")}</p>
      {error ? renderError(error) : null}
    </Sheet>
  );
}

/** Başarı bildirimi + "Geri al" (N-03): eski koda dönüş aynı sunucu komutudur; sonucu yine sunucu doğrular. */
export function CodeChangedNotice({
  from,
  to,
  busy,
  onUndo,
}: {
  from: string;
  to: string;
  busy: boolean;
  onUndo: () => void;
}) {
  const t = useTranslations("codeEdit");
  return (
    <Banner kind="info">
      <p className="break-all">{t("done", { from, to })}</p>
      <div className="mt-2">
        <Button variant="secondary" onClick={onUndo} loading={busy}>
          {t("undo", { code: from })}
        </Button>
      </div>
    </Banner>
  );
}
