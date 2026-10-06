-- 0018_code_history geri alma (G-08): up'ın yarattığı her şeyi ters sırayla kaldırır.
-- VERİ KAYBETTİRİR: code_history'de satır varsa yalnızca wms_meta.allow_destructive_down = 'on' (WMS_ENV local|ci) iken çalışır.
-- Bekçi sayımı RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce NO FORCE (koşturucu tek transaction'dır; RAISE
-- hepsini geri alır). Kod değişimi yetkileri kaldırılır; kartlardaki mevcut kodlar olduğu gibi kalır (kod sütunu veri kaybı yok).
DO $guard$
DECLARE
  has_rows boolean;
  allow boolean := coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') = 'on';
BEGIN
  ALTER TABLE public.code_history NO FORCE ROW LEVEL SECURITY;
  SELECT EXISTS (SELECT 1 FROM public.code_history) INTO has_rows;
  IF has_rows AND NOT allow THEN
    RAISE EXCEPTION '0018_code_history down: public.code_history tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
END
$guard$;

REVOKE UPDATE (code) ON public.locations FROM wms_app;
REVOKE UPDATE (code) ON public.warehouses FROM wms_app;
REVOKE UPDATE (code) ON public.items FROM wms_app;
DROP TABLE public.code_history;
