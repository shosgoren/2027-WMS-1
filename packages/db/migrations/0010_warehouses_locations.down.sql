-- 0010_warehouses_locations geri alma (ADR-015 §9): up'ın yarattığı her şeyi kaldırır.
-- VERİ KAYBETTİRİR: herhangi bir tabloda satır varsa yalnızca wms_meta.allow_destructive_down = 'on'
-- (WMS_ENV local|ci) iken çalışır. Bekçi sayımı RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce
-- NO FORCE ROW LEVEL SECURITY (koşturucu tek transaction'dır; bekçi RAISE ederse geri alınır).
-- Öncesinde var olan güvenlik ayarı gevşetilmez: hiçbir role/PUBLIC'e bir şey geri verilmez.
DO $guard$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['membership_warehouse_scopes', 'location_count_locks', 'locations', 'warehouses'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '0010_warehouses_locations down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

DROP TRIGGER locations_create_count_lock ON public.locations;
DROP TRIGGER locations_reject_tree_change ON public.locations;
DROP TRIGGER locations_check_depth ON public.locations;
DROP FUNCTION public.locations_create_count_lock();
DROP FUNCTION public.locations_reject_tree_change();
DROP FUNCTION public.locations_check_depth();

DROP TABLE public.membership_warehouse_scopes;
DROP TABLE public.location_count_locks;
DROP TABLE public.locations;
DROP TABLE public.warehouses;
