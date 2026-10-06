-- 0013_stock_ledger geri alma (ADR-015 §9): up'ın yarattığı her şeyi ters sırayla kaldırır.
-- VERİ KAYBETTİRİR: tablolarda satır varsa yalnızca wms_meta.allow_destructive_down = 'on' (WMS_ENV local|ci) iken çalışır.
-- Bekçi sayımı RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce NO FORCE ROW LEVEL SECURITY (koşturucu tek transaction;
-- bekçi RAISE ederse geri alınır). Defter append-only tetikleyicileri DROP TRIGGER ile kaldırılır (tablo sahibi; DROP TABLE zaten
-- satır tetikleyicisi çalıştırmaz). Öncesinde var olan güvenlik ayarı gevşetilmez.
DO $guard$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['reservations', 'stock_ledger', 'stock_balances', 'stock_dimensions'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '0013_stock_ledger down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

DROP TRIGGER reservations_assert ON public.reservations;
DROP TRIGGER stock_ledger_assert ON public.stock_ledger;
DROP TRIGGER stock_balances_assert ON public.stock_balances;
DROP TRIGGER reservations_guard_update ON public.reservations;
DROP TRIGGER stock_balances_guard_update ON public.stock_balances;
DROP TRIGGER stock_balances_fill_serial_key ON public.stock_balances;
DROP TRIGGER stock_ledger_server_fields ON public.stock_ledger;
DROP TRIGGER stock_ledger_no_truncate ON public.stock_ledger;
DROP TRIGGER stock_ledger_append_only ON public.stock_ledger;
DROP TRIGGER stock_dimensions_no_truncate ON public.stock_dimensions;
DROP TRIGGER stock_dimensions_immutable ON public.stock_dimensions;

DROP FUNCTION public.stock_assert_trigger();
DROP FUNCTION public.stock_assert_dimension(uuid, uuid);
DROP FUNCTION public.reservations_guard_update();
DROP FUNCTION public.stock_balances_guard_update();
DROP FUNCTION public.stock_balances_fill_serial_key();
DROP FUNCTION public.stock_ledger_force_server_fields();
DROP FUNCTION public.stock_reject_change();

DROP TABLE public.reservations;
DROP TABLE public.stock_ledger;
DROP TABLE public.stock_balances;
DROP TABLE public.stock_dimensions;
