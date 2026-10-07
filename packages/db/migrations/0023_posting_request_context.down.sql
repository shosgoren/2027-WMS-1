-- 0023_posting_request_context geri alma (G-08): bağlam sütunlarını ve CHECK'i kaldırır.
-- VERİ KAYBETTİRİR: işleme kilidi olan (bağlamı dolu) belge satırı varsa, bu satırlar yalnızca wms_meta.allow_destructive_down = 'on'
-- (WMS_ENV local|ci) iken geri alınır; aksi halde işlem reddedilir (süren eşik üstü işleme bağlamını sessizce kaybetmek MFA kararını bozar).
-- Sayım RLS'ten bağımsız olmalı (0003 down BLOKER-1): NO FORCE → sayım → FORCE.
DO $guard$
DECLARE
  has_rows boolean;
  allow boolean := coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') = 'on';
BEGIN
  ALTER TABLE public.documents NO FORCE ROW LEVEL SECURITY;
  SELECT EXISTS (SELECT 1 FROM public.documents WHERE posting_mfa_verified_at IS NOT NULL OR posting_idempotency_record_id IS NOT NULL) INTO has_rows;
  IF has_rows AND NOT allow THEN
    RAISE EXCEPTION '0023_posting_request_context down: public.documents tablosunda dolu işleme bağlamı var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
END
$guard$;

REVOKE UPDATE (posting_mfa_verified_at, posting_idempotency_record_id) ON public.documents FROM wms_app;
ALTER TABLE public.documents DROP CONSTRAINT documents_posting_context_chk;
ALTER TABLE public.documents DROP COLUMN posting_idempotency_record_id, DROP COLUMN posting_mfa_verified_at;
