-- 0004_audit geri alma (ADR-015 §9): audit_logs ve request_rate_limits'i kaldırır.
-- VERİ KAYBETTİRİR (audit satırları!): herhangi bir tabloda satır varsa yalnızca
-- wms_meta.allow_destructive_down = 'on' (WMS_ENV local|ci) iken çalışır.
-- Sayım RLS'ten BAĞIMSIZ olmalı (0003 down BLOKER-1): audit_logs FORCE RLS altındadır; süper kullanıcı olmayan sahip
-- bağlamsız satır göremez. Sayımdan önce NO FORCE yapılır; bekçi RAISE ederse koşturucunun transaction'ı bunu geri alır.
-- Tetikleyici DROP TABLE ile birlikte kalkar (DROP, satır tetikleyicilerini çalıştırmaz); işlevler ayrıca düşürülür.
DO $guard$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  IF pg_catalog.to_regclass('public.audit_logs') IS NOT NULL THEN
    ALTER TABLE public.audit_logs NO FORCE ROW LEVEL SECURITY;
  END IF;
  FOREACH t IN ARRAY ARRAY['audit_logs', 'request_rate_limits'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '0004_audit down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

DROP TABLE public.request_rate_limits;
DROP TABLE public.audit_logs;
DROP FUNCTION public.audit_logs_force_server_fields();
DROP FUNCTION public.audit_logs_reject_change();
