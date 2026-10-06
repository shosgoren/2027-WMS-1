-- 0011_catalog_traceability geri alma (ADR-015 §9): up'ın yarattığı her şeyi kaldırır.
-- VERİ KAYBETTİRİR: herhangi bir tabloda satır varsa yalnızca wms_meta.allow_destructive_down = 'on'
-- (WMS_ENV local|ci) iken çalışır. Bekçi sayımı RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce
-- NO FORCE ROW LEVEL SECURITY (koşturucu tek transaction'dır; bekçi RAISE ederse geri alınır).
-- Öncesinde var olan güvenlik ayarı gevşetilmez: hiçbir role/PUBLIC'e bir şey geri verilmez.
DO $guard$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['handling_units', 'serials', 'lots', 'inventory_owners', 'item_barcodes', 'unit_conversions', 'items', 'units'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '0011_catalog_traceability down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

DROP TRIGGER handling_units_reject_cycle ON public.handling_units;
DROP TRIGGER unit_conversions_reject_base_unit ON public.unit_conversions;
DROP FUNCTION public.handling_units_reject_cycle();
DROP FUNCTION public.unit_conversions_reject_base_unit();

DROP TABLE public.handling_units;
DROP TABLE public.serials;
DROP TABLE public.lots;
DROP TABLE public.inventory_owners;
DROP TABLE public.item_barcodes;
DROP TABLE public.unit_conversions;
DROP TABLE public.items;
DROP TABLE public.units;
