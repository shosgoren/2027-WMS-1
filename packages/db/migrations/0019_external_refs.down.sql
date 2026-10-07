-- 0019_external_refs geri alma (G-08): up'ın yarattığı her şeyi ters sırayla kaldırır.
-- VERİ KAYBETTİRİR: tablolarda satır varsa yalnızca wms_meta.allow_destructive_down = 'on' (WMS_ENV local|ci) iken çalışır.
-- Bekçi sayımı RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce NO FORCE (koşturucu tek transaction'dır; RAISE
-- hepsini geri alır).
DO $guard$
DECLARE
  t text;
  has_rows boolean;
  allow boolean := coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') = 'on';
BEGIN
  FOREACH t IN ARRAY ARRAY['external_refs', 'sync_cursors'] LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
    IF has_rows AND NOT allow THEN
      RAISE EXCEPTION '0019_external_refs down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
    END IF;
  END LOOP;
END
$guard$;

DROP TABLE public.sync_cursors;
DROP TABLE public.external_refs;
DROP FUNCTION public.sync_cursors_guard();
DROP FUNCTION public.external_refs_on_update();
