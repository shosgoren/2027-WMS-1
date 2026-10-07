-- 0023_posting_request_context (T-222 güvenlik incelemesi MAJOR-1/MINOR-1; G-08 genişlet–taşı–daralt): eşik üstü belge işleme isteğinin
-- bağlamı belge satırında, `posting_job_id` ile AYNI transaction'da sunucu tarafında yazılır:
--   * posting_mfa_verified_at: isteği yapan oturum MFA doğrulanmışsa istek zamanı (DB `now()`), değilse NULL. Worker yalnızca bu damga
--     (sınırlı pencere + sonradan MFA/parola sıfırlanmadı denetimi) varken `mfaVerified: true` verir (ADR-014 §12 zayıflamaz).
--   * posting_idempotency_record_id: işi başlatan `IN_PROGRESS` idempotency kaydı; worker `resume` kaydın bu kayıt olduğunu doğrular.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Yalnızca GENİŞLETME: iki sütun NULL'lanabilir, varsayılan yok; mevcut satır ve kod etkilenmez (taşınacak veri yok: işleme kilidi olan satır
--   yalnızca geçicidir ve yeni sütunlar olmadan da geçerlidir; worker NULL damgayı "MFA yok" sayar — fail-closed).
-- * CHECK `documents_posting_context_chk`: bağlam sütunları yalnızca işleme kilidi (`posting_job_id`) doluyken dolu olabilir; kilit kalkınca
--   (POSTED / FAILED) birlikte temizlenmelidir. NOT VALID + VALIDATE (kısa kilit; 0017/0022 deseni).
-- * Yetki: wms_app'e yalnızca bu iki sütunda UPDATE (0012 `posting_job_id`/`posting_requested_by` ile aynı model). FK yok: idempotency kaydı
--   saklama süresi (A-73) temizliğini belge satırına bağlamamak için (satır kilit kalkınca zaten temizlenir).
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION '0023_posting_request_context: 0012 önkoşulu yok (public.documents)';
  END IF;
END
$pre$;

ALTER TABLE public.documents
  ADD COLUMN posting_mfa_verified_at timestamptz,
  ADD COLUMN posting_idempotency_record_id uuid;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_posting_context_chk
  CHECK (posting_job_id IS NOT NULL OR (posting_mfa_verified_at IS NULL AND posting_idempotency_record_id IS NULL)) NOT VALID;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_posting_context_chk;

GRANT UPDATE (posting_mfa_verified_at, posting_idempotency_record_id) ON public.documents TO wms_app;
