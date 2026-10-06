-- 0014_reliability geri alma (ADR-015 §9): up'ın yarattığı her şeyi ters sırayla kaldırır.
-- VERİ KAYBETTİRİR: tablolarda satır varsa yalnızca wms_meta.allow_destructive_down = 'on' (WMS_ENV local|ci) iken çalışır.
-- Bekçi sayımı RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce NO FORCE ROW LEVEL SECURITY (koşturucu tek transaction;
-- bekçi RAISE ederse geri alınır). Append-only tetikleyiciler DROP TRIGGER ile kaldırılır (tablo sahibi).
DO $guard$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_consistency_signals', 'stock_consistency_runs', 'processed_events'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '0014_reliability down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

-- İşlev: sahiplik SET ROLE kalıbıyla (0006 down ile aynı).
SET ROLE wms_identity_probe;
DROP FUNCTION wms_probe.active_tenant_ids(uuid, integer);
RESET ROLE;
REVOKE USAGE ON SCHEMA wms_probe FROM wms_worker;

DROP TRIGGER stock_consistency_signals_no_truncate ON public.stock_consistency_signals;
DROP TRIGGER stock_consistency_signals_append_only ON public.stock_consistency_signals;
DROP TRIGGER stock_consistency_signals_server_fields ON public.stock_consistency_signals;
DROP TRIGGER stock_consistency_runs_server_fields ON public.stock_consistency_runs;

DROP FUNCTION public.stock_consistency_signals_force_server_fields();
DROP FUNCTION public.stock_consistency_runs_force_server_fields();
DROP FUNCTION public.reliability_reject_change();

DROP TABLE public.stock_consistency_signals;
DROP TABLE public.stock_consistency_runs;
DROP TABLE public.processed_events;
