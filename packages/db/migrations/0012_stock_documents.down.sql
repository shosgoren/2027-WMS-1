-- 0012_stock_documents geri alma (ADR-015 §9): up'ın yarattığı her şeyi ters sırayla kaldırır.
-- VERİ KAYBETTİRİR: kullanıcı verisi taşıyan tablolarda (document_type_versions HARİÇ: yalnızca up'ın tohumladığı 4 sistem satırı
-- vardır) satır varsa yalnızca wms_meta.allow_destructive_down = 'on' (WMS_ENV local|ci) iken çalışır. Bekçi sayımı RLS'ten
-- bağımsız olmalı (0003 down BLOKER-1): sayımdan önce NO FORCE ROW LEVEL SECURITY (koşturucu tek transaction'dır; bekçi RAISE
-- ederse geri alınır). document_type_versions'ta up'ın 4 sistem satırı dışında satır varsa o da veri sayılır.
-- Öncesinde var olan güvenlik ayarı gevşetilmez: hiçbir role/PUBLIC'e bir şey geri verilmez.
DO $guard$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_records', 'document_status_history', 'document_lines', 'documents', 'number_sequences', 'document_type_versions'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      IF t = 'document_type_versions' THEN
        SELECT EXISTS (SELECT 1 FROM public.document_type_versions
                        WHERE NOT (tenant_id IS NULL AND version = 1 AND key IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL')))
          INTO has_rows;
      ELSE
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      END IF;
      IF has_rows AND coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '0012_stock_documents down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

DROP TRIGGER documents_status_history_upd ON public.documents;
DROP TRIGGER documents_status_history_ins ON public.documents;
DROP TRIGGER idempotency_records_guard_update ON public.idempotency_records;
DROP TRIGGER document_status_history_trigger_path ON public.document_status_history;
DROP TRIGGER document_status_history_no_truncate ON public.document_status_history;
DROP TRIGGER document_status_history_append_only ON public.document_status_history;
DROP TRIGGER document_status_history_server_fields ON public.document_status_history;
DROP TRIGGER document_lines_guard ON public.document_lines;
DROP TRIGGER documents_guard_delete ON public.documents;
DROP TRIGGER documents_guard_update ON public.documents;
DROP TRIGGER documents_check_type_version ON public.documents;
DROP TRIGGER number_sequences_guard_update ON public.number_sequences;
DROP TRIGGER document_type_versions_immutable ON public.document_type_versions;

DROP FUNCTION public.documents_write_status_history();
DROP FUNCTION public.document_status_history_require_trigger_path();
DROP FUNCTION public.idempotency_records_guard_update();
DROP FUNCTION public.document_status_history_reject_change();
DROP FUNCTION public.document_status_history_force_server_fields();
DROP FUNCTION public.document_lines_guard();
DROP FUNCTION public.documents_guard_delete();
DROP FUNCTION public.documents_guard_update();
DROP FUNCTION public.documents_check_type_version();
DROP FUNCTION public.number_sequences_guard_update();
DROP FUNCTION public.document_type_versions_reject_change();

DROP TABLE public.idempotency_records;
DROP TABLE public.document_status_history;
DROP TABLE public.document_lines;
DROP TABLE public.documents;
DROP TABLE public.number_sequences;
DROP TABLE public.document_type_versions;
