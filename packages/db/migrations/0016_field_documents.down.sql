-- 0016_field_documents geri alma (ADR-015 §9, G-08): up'ın yarattığı her şeyi ters sırayla kaldırır.
-- VERİ KAYBETTİRİR: yeni tablolarda satır, kaynak bağlantısı dolu belge/satır, sipariş satırına bağlı SONLANMIŞ rezervasyon ya da
-- receiving_qc_enabled = false olan ayar varsa yalnızca wms_meta.allow_destructive_down = 'on' (WMS_ENV local|ci) iken çalışır.
-- İSTİSNA (bayraktan bağımsız): sipariş satırına bağlı ACTIVE rezervasyon varsa HER ZAMAN RAISE eder — silmek reserved_quantity
-- ↔ aktif rezervasyon toplamı eşitliğini (I-04, 0013 denetimi) sessizce bozardı; önce rezervasyonlar serbest bırakılmalıdır.
-- Bekçi sayımı RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce NO FORCE; mevcut tablolarda sayımdan sonra FORCE geri
-- açılır (koşturucu tek transaction'dır; bekçi RAISE ederse hepsi geri alınır). Öncesinde var olan güvenlik ayarı gevşetilmez.
DO $guard$
DECLARE
  t text;
  has_rows boolean;
  allow boolean := coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') = 'on';
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_return_lines', 'customer_returns', 'sales_order_lines', 'sales_orders', 'inbound_receipt_lines', 'inbound_receipts'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND NOT allow THEN
        RAISE EXCEPTION '0016_field_documents down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;

  -- Bekçi ile DELETE arasındaki yarış: eşzamanlı ACTIVE rezervasyon eklenemesin (tablo kilidi transaction sonuna kadar tutulur).
  LOCK TABLE public.reservations IN SHARE ROW EXCLUSIVE MODE;
  ALTER TABLE public.reservations NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE order_line_id IS NOT NULL AND status = 'ACTIVE') THEN
    RAISE EXCEPTION '0016_field_documents down: sipariş satırına bağlı ACTIVE rezervasyon var; önce serbest bırakılmalı (bayraktan bağımsız ret)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE order_line_id IS NOT NULL) AND NOT allow THEN
    RAISE EXCEPTION '0016_field_documents down: public.reservations tablosunda sipariş satırına bağlı satır var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  -- reservations'ta NO FORCE bilerek KALIR: aşağıdaki DELETE RLS'ten bağımsız olmalı; FORCE o adımdan sonra geri açılır.

  ALTER TABLE public.documents NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM public.documents WHERE source_kind IS NOT NULL) AND NOT allow THEN
    RAISE EXCEPTION '0016_field_documents down: public.documents tablosunda kaynak bağlantılı satır var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;

  ALTER TABLE public.document_lines NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM public.document_lines WHERE source_line_id IS NOT NULL) AND NOT allow THEN
    RAISE EXCEPTION '0016_field_documents down: public.document_lines tablosunda kaynak satır bağlantılı satır var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  IF EXISTS (SELECT 1 FROM public.document_lines WHERE target_stock_status IS NOT NULL) AND NOT allow THEN
    RAISE EXCEPTION '0016_field_documents down: public.document_lines tablosunda target_stock_status dolu satır var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  ALTER TABLE public.document_lines FORCE ROW LEVEL SECURITY;

  ALTER TABLE public.tenant_settings NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM public.tenant_settings WHERE receiving_qc_enabled = false) AND NOT allow THEN
    RAISE EXCEPTION '0016_field_documents down: public.tenant_settings tablosunda receiving_qc_enabled = false ayarı var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  ALTER TABLE public.tenant_settings FORCE ROW LEVEL SECURITY;
END
$guard$;

-- tenant_settings (sütun yetkisi sütunla birlikte düşer).
ALTER TABLE public.tenant_settings DROP COLUMN receiving_qc_enabled;

-- reservations: önce sipariş satırına bağlı SONLANMIŞ satırlar (yalnızca bayrak açıksa buraya gelinir; ACTIVE olanlar yukarıda reddedildi).
-- Silme tetikleyicisi yok; ertelenmiş denetim yalnızca INSERT/UPDATE'tedir ve sonlanmış satır toplama girmez.
-- Çift savunma: ACTIVE satır silinmez; kalırsa aşağıdaki SET NOT NULL fail-closed düşer.
DELETE FROM public.reservations WHERE order_line_id IS NOT NULL AND status <> 'ACTIVE';
-- 0013 gövdesi geri yazılır.
CREATE OR REPLACE FUNCTION public.reservations_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.document_line_id IS DISTINCT FROM OLD.document_line_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'reservations: tenant_id/id/document_line_id/created_at değiştirilemez' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'reservations: sonlanmış rezervasyon (%) değiştirilemez', OLD.status USING ERRCODE = '23514';
  END IF;
  -- closed_at sunucu değeridir (istemci veremez): terminale geçişte now(), ACTIVE kalırsa NULL.
  IF NEW.status <> 'ACTIVE' THEN
    NEW.closed_at := pg_catalog.now();
  ELSE
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
DROP INDEX public.reservations_order_line_idx;
ALTER TABLE public.reservations
  DROP CONSTRAINT reservations_source_xor_chk,
  DROP CONSTRAINT reservations_order_line_item_fkey,
  DROP CONSTRAINT reservations_order_line_fkey,
  DROP COLUMN order_line_id,
  ALTER COLUMN document_line_id SET NOT NULL;
ALTER TABLE public.reservations FORCE ROW LEVEL SECURITY;

-- documents / document_lines.
-- 0012 gövdesi geri yazılır.
CREATE OR REPLACE FUNCTION public.documents_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'DOCUMENT_POSTED_IMMUTABLE: işlenmiş belge değiştirilemez (I-08)' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.type_version_id IS DISTINCT FROM OLD.type_version_id
     OR NEW.reversal_of_document_id IS DISTINCT FROM OLD.reversal_of_document_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'documents: tenant_id/id/kind/type_version_id/reversal_of_document_id/created_by/created_at değiştirilemez' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$fn$;
DROP INDEX public.document_lines_tenant_source_line_idx;
ALTER TABLE public.document_lines DROP CONSTRAINT document_lines_target_stock_status_chk, DROP COLUMN target_stock_status, DROP COLUMN source_line_id;
DROP INDEX public.documents_tenant_source_idx;
ALTER TABLE public.documents
  DROP CONSTRAINT documents_source_pair_chk,
  DROP CONSTRAINT documents_source_kind_chk,
  DROP COLUMN source_id,
  DROP COLUMN source_kind;

-- Yeni tablolar (bağımlılık sırasıyla).
DROP TRIGGER customer_return_lines_guard_closed ON public.customer_return_lines;
DROP TRIGGER sales_order_lines_guard_closed ON public.sales_order_lines;
DROP TRIGGER inbound_receipt_lines_guard_closed ON public.inbound_receipt_lines;
DROP FUNCTION public.field_docs_lines_guard_closed();
DROP TRIGGER customer_return_lines_guard_keys ON public.customer_return_lines;
DROP TRIGGER sales_order_lines_guard_keys ON public.sales_order_lines;
DROP TRIGGER inbound_receipt_lines_guard_keys ON public.inbound_receipt_lines;
DROP TRIGGER customer_returns_guard_keys ON public.customer_returns;
DROP TRIGGER sales_orders_guard_keys ON public.sales_orders;
DROP TRIGGER inbound_receipts_guard_keys ON public.inbound_receipts;
DROP TRIGGER customer_returns_bump_version ON public.customer_returns;
DROP TRIGGER sales_orders_bump_version ON public.sales_orders;
DROP TRIGGER inbound_receipts_bump_version ON public.inbound_receipts;
DROP FUNCTION public.field_docs_guard_keys();
DROP FUNCTION public.field_docs_bump_version();

DROP TABLE public.customer_return_lines;
DROP TABLE public.customer_returns;
DROP TABLE public.sales_order_lines;
DROP TABLE public.sales_orders;
DROP TABLE public.inbound_receipt_lines;
DROP TABLE public.inbound_receipts;
