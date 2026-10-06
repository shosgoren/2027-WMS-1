-- 0017_tasks_counts_alerts geri alma (ADR-015 §9, G-08): up'ın yarattığı her şeyi ters sırayla kaldırır.
-- VERİ KAYBETTİRİR: yeni tablolarda satır, COUNT_ADJUSTMENT numara sayacı, count_abandon_hours <> 8 ayarı varsa yalnızca
-- wms_meta.allow_destructive_down = 'on' (WMS_ENV local|ci) iken çalışır.
-- İSTİSNA (bayraktan bağımsız): COUNT_ADJUSTMENT belgesi varsa HER ZAMAN RAISE eder — işlenmiş belge ve defter satırı değişmezdir
-- (I-08), silinemez; belge türünü kaldırmak yetim belge bırakırdı.
-- Bekçi sayımı RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce NO FORCE; mevcut tablolarda sayımdan sonra FORCE geri
-- açılır (koşturucu tek transaction'dır; bekçi RAISE ederse hepsi geri alınır).
DO $guard$
DECLARE
  t text;
  has_rows boolean;
  allow boolean := coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') = 'on';
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_alerts', 'item_stock_policies', 'count_session_lines', 'count_sessions', 'warehouse_tasks'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND NOT allow THEN
        RAISE EXCEPTION '0017_tasks_counts_alerts down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;

  ALTER TABLE public.documents NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM public.documents WHERE kind = 'COUNT_ADJUSTMENT') THEN
    RAISE EXCEPTION '0017_tasks_counts_alerts down: COUNT_ADJUSTMENT belgesi var; işlenmiş belge silinemez (bayraktan bağımsız ret)';
  END IF;
  ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;

  ALTER TABLE public.number_sequences NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM public.number_sequences WHERE document_kind = 'COUNT_ADJUSTMENT') AND NOT allow THEN
    RAISE EXCEPTION '0017_tasks_counts_alerts down: public.number_sequences tablosunda COUNT_ADJUSTMENT sayacı var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  DELETE FROM public.number_sequences WHERE document_kind = 'COUNT_ADJUSTMENT';
  ALTER TABLE public.number_sequences FORCE ROW LEVEL SECURITY;

  ALTER TABLE public.tenant_settings NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM public.tenant_settings WHERE count_abandon_hours <> 8) AND NOT allow THEN
    RAISE EXCEPTION '0017_tasks_counts_alerts down: public.tenant_settings tablosunda count_abandon_hours <> 8 ayarı var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  ALTER TABLE public.tenant_settings FORCE ROW LEVEL SECURITY;

  -- Kilit satırı: sayım oturumuna bağlı satır varsa oturumlar da vardır (yukarıdaki bekçi yakalar); FK düşünce uuid FK'siz kalır (0010 hali).
  ALTER TABLE public.document_type_versions NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM public.document_type_versions WHERE key = 'COUNT_ADJUSTMENT' AND tenant_id IS NOT NULL) AND NOT allow THEN
    RAISE EXCEPTION '0017_tasks_counts_alerts down: public.document_type_versions tablosunda tenant''a özel COUNT_ADJUSTMENT sürümü var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  ALTER TABLE public.document_type_versions FORCE ROW LEVEL SECURITY;
END
$guard$;

-- tenant_settings (sütun yetkisi sütunla birlikte düşer).
ALTER TABLE public.tenant_settings
  DROP CONSTRAINT tenant_settings_count_abandon_hours_chk,
  DROP COLUMN count_abandon_hours;

-- COUNT_ADJUSTMENT: sistem fiş tipi satırı. 0012 değişmezlik tetikleyicisi (ENABLE ALWAYS) DELETE'i reddeder; yalnızca bu adımda
-- kapatılır, aynı transaction'da ENABLE ALWAYS ile geri açılır. Önce FK'li belge kalmadığı bekçiyle doğrulandı.
ALTER TABLE public.document_type_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_type_versions DISABLE TRIGGER document_type_versions_immutable;
DELETE FROM public.document_type_versions WHERE key = 'COUNT_ADJUSTMENT';
ALTER TABLE public.document_type_versions ENABLE ALWAYS TRIGGER document_type_versions_immutable;
ALTER TABLE public.document_type_versions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.number_sequences DROP CONSTRAINT number_sequences_kind_chk;
ALTER TABLE public.number_sequences
  ADD CONSTRAINT number_sequences_kind_chk CHECK (document_kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL')) NOT VALID;
ALTER TABLE public.number_sequences VALIDATE CONSTRAINT number_sequences_kind_chk;
ALTER TABLE public.documents DROP CONSTRAINT documents_kind_chk;
ALTER TABLE public.documents
  ADD CONSTRAINT documents_kind_chk CHECK (kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL')) NOT VALID;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_kind_chk;

-- Kilit satırı FK'si (0010 hali: FK'siz uuid).
DROP INDEX public.location_count_locks_tenant_session_idx;
ALTER TABLE public.location_count_locks DROP CONSTRAINT location_count_locks_session_fkey;

-- Yeni tablolar (bağımlılık sırasıyla; tetikleyiciler tabloyla düşer, işlevler ayrıca).
DROP TABLE public.stock_alerts;
DROP TABLE public.item_stock_policies;
DROP TABLE public.count_session_lines;
DROP TABLE public.count_sessions;
DROP TABLE public.warehouse_tasks;
DROP FUNCTION public.stock_alerts_guard_state();
DROP FUNCTION public.count_session_lines_guard_state();
DROP FUNCTION public.count_session_lines_guard_closed();
DROP FUNCTION public.count_sessions_guard_state();
DROP FUNCTION public.warehouse_tasks_guard_state();
