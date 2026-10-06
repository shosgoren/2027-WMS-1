-- 0016_field_documents (T-301, ADR-021 §1-§4, ADR-017 §7, ADR-015 §5 şablonu, G-08 genişlet–taşı–daralt, A-06, A-22, A-33, A-144):
-- inbound_receipts + inbound_receipt_lines, sales_orders + sales_order_lines, customer_returns + customer_return_lines (yeni tablolar);
-- documents.source_kind/source_id, document_lines.source_line_id (genişletme, nullable); reservations.order_line_id (+ document_line_id
-- NULL'a açılır, "tam olarak biri dolu" CHECK'i); tenant_settings.receiving_qc_enabled (A-06, varsayılan true).
-- Görev/sayım/min-maks tabloları ve COUNT_ADJUSTMENT 0017'dedir (T-302; kapsam dışı).
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Yeni tenant tabloları 0010-0013 desenindedir: tenant_id NOT NULL, ENABLE + FORCE RLS, tek PERMISSIVE USING + WITH CHECK tenant
--   politikası, UNIQUE (tenant_id, id), FK'lerin hepsi (tenant_id, …) BİLEŞİK ve NO ACTION, açık sütun bazlı GRANT'lar, PUBLIC'e
--   hiçbir şey. wms_app: SELECT + sütun düzeyi INSERT/UPDATE; DELETE YOK (A-86). wms_ops bu tablolarda yetkisizdir (A-94).
-- * Türetilen/sunucu sütunlarına INSERT yetkisi YOKTUR: başlıklarda status (varsayılan) ve version (tetikleyici +1; istemci değeri
--   yok), sipariş satırında shipped/returned/cancelled (0 ile başlar; yalnızca sonraki saha komutları UPDATE eder), kabul satırında
--   received/damaged (0 ile başlar). Kimlik/anahtar sütunları UPDATE yetkisinde de yoktur ve ayrıca tetikleyiciyle (tablo sahibi
--   dahil) değişmez kılınır.
-- * Açık sipariş miktarı sütun DEĞİLDİR (hesaplanır: requested − shipped − cancelled; iade açık miktara girmez, 16 kural 6).
--   CHECK: shipped + cancelled <= requested (23514). returned için üst sınır KOYULMADI (iade sınırı açık iş kuralı; A-150).
-- * Sipariş/iade miktarları ürünün TEMEL BİRİMİNDEDİR (rezervasyon ve defter temel birimdedir; A-151). Kabul satırında ise kabul
--   belgesinin birimi + dönüşüm katsayısı saklanır (ADR-021 §1); katsayı satır oluşurken sabitlenir (anahtar sütun).
-- * customer_return_lines.item_id, (tenant_id, sales_order_line_id, item_id) bileşik FK'siyle sevk satırının ürününe kilitlenir.
-- * documents.source_kind/source_id ve document_lines.source_line_id POLİMORFİK bağlantıdır: tek FK ile kaynağa bağlanamaz (hedef
--   tablo kind'a göre değişir; COUNT_SESSION/TASK tabloları 0017'dedir). DB yalnızca (kind IS NULL) = (id IS NULL) tutarlılığını ve
--   kind beyaz listesini zorlar; kaynağın varlığı/tenant'ı saha komutunun (T-305…T-308) sorumluluğudur (A-152). Dangling/başka-tenant
--   kimliği veri sızdırmaz: her okuma (tenant_id, source_id) ile RLS altındadır. wms_app yalnızca INSERT eder (UPDATE yetkisi yok):
--   kaynak bağlantısı belge oluştuktan sonra değişmez; POSTED satırda source_line_id zaten 0012 jsonb-fark tetikleyicisiyle donuktur.
-- * reservations: document_line_id NULL'a açılır; CHECK reservations_source_xor_chk "tam olarak biri dolu"; mevcut satırlar document_line_id
--   dolu olduğundan geçerli kalır. (tenant_id, order_line_id, item_id) bileşik FK'si item_id türetimini (0013 tetikleyicisi, boyuttan)
--   sipariş satırının ürünüyle eşitler. reservations_guard_update order_line_id'yi de değişmez kılar (document_line_id gibi).
--   documents_guard_update source_kind/source_id'yi değişmez kılar. İki işlev CREATE OR REPLACE'tir; down 0012/0013 gövdesini geri yazar.
-- * tenant_settings.receiving_qc_enabled: NOT NULL DEFAULT true (A-06: kalite kontrol varsayılan açık); wms_app UPDATE yetkisi
--   yalnızca bu sütun için eklenir (INSERT tablo düzeyindedir; varsayılan geçerli). wms_ops'a yeni yetki verilmez.
-- * Miktarlar numeric(20,6); float yok (I-09).
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.warehouses') IS NULL
     OR pg_catalog.to_regclass('public.items') IS NULL
     OR pg_catalog.to_regclass('public.units') IS NULL
     OR pg_catalog.to_regclass('public.documents') IS NULL
     OR pg_catalog.to_regclass('public.document_lines') IS NULL
     OR pg_catalog.to_regclass('public.reservations') IS NULL
     OR pg_catalog.to_regclass('public.tenant_settings') IS NULL THEN
    RAISE EXCEPTION '0016_field_documents: 0003 / 0010 / 0011 / 0012 / 0013 önkoşulu yok';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0016_field_documents: wms_app rolü yok (altyapı adımı)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 1. Yeni tablolar
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.inbound_receipts (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  warehouse_id  uuid        NOT NULL,
  number        text        NOT NULL,
  supplier_ref  text,
  status        text        NOT NULL DEFAULT 'DRAFT',
  version       integer     NOT NULL DEFAULT 1,
  created_by    uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_receipts_pkey PRIMARY KEY (id),
  CONSTRAINT inbound_receipts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT inbound_receipts_tenant_number_key UNIQUE (tenant_id, number),
  CONSTRAINT inbound_receipts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT inbound_receipts_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id) REFERENCES public.warehouses (tenant_id, id),
  CONSTRAINT inbound_receipts_number_chk CHECK (btrim(number) <> ''),
  -- A-144: serbest referans metni (kart yok), kişisel veri girilmez uyarısı UI'dadır; ≤100 karakter.
  CONSTRAINT inbound_receipts_supplier_ref_chk CHECK (supplier_ref IS NULL OR (btrim(supplier_ref) <> '' AND char_length(supplier_ref) <= 100)),
  CONSTRAINT inbound_receipts_status_chk CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED')),
  CONSTRAINT inbound_receipts_version_chk CHECK (version >= 1)
);
CREATE INDEX inbound_receipts_tenant_warehouse_idx ON public.inbound_receipts (tenant_id, warehouse_id);
CREATE INDEX inbound_receipts_tenant_status_idx ON public.inbound_receipts (tenant_id, status);

CREATE TABLE public.inbound_receipt_lines (
  tenant_id          uuid           NOT NULL,
  id                 uuid           NOT NULL DEFAULT gen_random_uuid(),
  receipt_id         uuid           NOT NULL,
  line_no            integer        NOT NULL,
  item_id            uuid           NOT NULL,
  unit_id            uuid           NOT NULL,
  conversion_factor  numeric(20, 6) NOT NULL,
  expected_quantity  numeric(20, 6) NOT NULL DEFAULT 0,
  received_quantity  numeric(20, 6) NOT NULL DEFAULT 0,
  damaged_quantity   numeric(20, 6) NOT NULL DEFAULT 0,
  created_at         timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT inbound_receipt_lines_pkey PRIMARY KEY (id),
  CONSTRAINT inbound_receipt_lines_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT inbound_receipt_lines_tenant_receipt_line_no_key UNIQUE (tenant_id, receipt_id, line_no),
  CONSTRAINT inbound_receipt_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT inbound_receipt_lines_receipt_fkey FOREIGN KEY (tenant_id, receipt_id) REFERENCES public.inbound_receipts (tenant_id, id),
  CONSTRAINT inbound_receipt_lines_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT inbound_receipt_lines_unit_fkey FOREIGN KEY (tenant_id, unit_id) REFERENCES public.units (tenant_id, id),
  CONSTRAINT inbound_receipt_lines_line_no_chk CHECK (line_no >= 1),
  CONSTRAINT inbound_receipt_lines_factor_chk CHECK (conversion_factor > 0),
  CONSTRAINT inbound_receipt_lines_quantities_chk CHECK (expected_quantity >= 0 AND received_quantity >= 0 AND damaged_quantity >= 0),
  CONSTRAINT inbound_receipt_lines_damaged_chk CHECK (damaged_quantity <= received_quantity)
);
CREATE INDEX inbound_receipt_lines_tenant_item_idx ON public.inbound_receipt_lines (tenant_id, item_id);
CREATE INDEX inbound_receipt_lines_tenant_unit_idx ON public.inbound_receipt_lines (tenant_id, unit_id);

CREATE TABLE public.sales_orders (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  number        text        NOT NULL,
  customer_ref  text,
  status        text        NOT NULL DEFAULT 'OPEN',
  version       integer     NOT NULL DEFAULT 1,
  created_by    uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_orders_pkey PRIMARY KEY (id),
  CONSTRAINT sales_orders_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT sales_orders_tenant_number_key UNIQUE (tenant_id, number),
  CONSTRAINT sales_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT sales_orders_number_chk CHECK (btrim(number) <> ''),
  CONSTRAINT sales_orders_customer_ref_chk CHECK (customer_ref IS NULL OR (btrim(customer_ref) <> '' AND char_length(customer_ref) <= 100)),
  CONSTRAINT sales_orders_status_chk CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  CONSTRAINT sales_orders_version_chk CHECK (version >= 1)
);
CREATE INDEX sales_orders_tenant_status_idx ON public.sales_orders (tenant_id, status);

CREATE TABLE public.sales_order_lines (
  tenant_id           uuid           NOT NULL,
  id                  uuid           NOT NULL DEFAULT gen_random_uuid(),
  order_id            uuid           NOT NULL,
  line_no             integer        NOT NULL,
  item_id             uuid           NOT NULL,
  requested_quantity  numeric(20, 6) NOT NULL,
  shipped_quantity    numeric(20, 6) NOT NULL DEFAULT 0,
  returned_quantity   numeric(20, 6) NOT NULL DEFAULT 0,
  cancelled_quantity  numeric(20, 6) NOT NULL DEFAULT 0,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_lines_pkey PRIMARY KEY (id),
  CONSTRAINT sales_order_lines_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Rezervasyon ve iade satırı ürün uyumu bileşik FK'lerinin hedefi (ADR-017 §2 M-3 deseni).
  CONSTRAINT sales_order_lines_tenant_id_id_item_key UNIQUE (tenant_id, id, item_id),
  CONSTRAINT sales_order_lines_tenant_order_line_no_key UNIQUE (tenant_id, order_id, line_no),
  CONSTRAINT sales_order_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT sales_order_lines_order_fkey FOREIGN KEY (tenant_id, order_id) REFERENCES public.sales_orders (tenant_id, id),
  CONSTRAINT sales_order_lines_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT sales_order_lines_line_no_chk CHECK (line_no >= 1),
  CONSTRAINT sales_order_lines_quantities_chk CHECK (requested_quantity >= 0 AND shipped_quantity >= 0 AND returned_quantity >= 0 AND cancelled_quantity >= 0),
  -- Açık miktar = requested − shipped − cancelled (hesaplanır, sütun değil); iade girmez (16 kural 6).
  CONSTRAINT sales_order_lines_open_chk CHECK (shipped_quantity + cancelled_quantity <= requested_quantity)
);
CREATE INDEX sales_order_lines_tenant_item_idx ON public.sales_order_lines (tenant_id, item_id);

CREATE TABLE public.customer_returns (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  warehouse_id  uuid        NOT NULL,
  number        text        NOT NULL,
  status        text        NOT NULL DEFAULT 'DRAFT',
  version       integer     NOT NULL DEFAULT 1,
  created_by    uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_returns_pkey PRIMARY KEY (id),
  CONSTRAINT customer_returns_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customer_returns_tenant_number_key UNIQUE (tenant_id, number),
  CONSTRAINT customer_returns_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT customer_returns_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id) REFERENCES public.warehouses (tenant_id, id),
  CONSTRAINT customer_returns_number_chk CHECK (btrim(number) <> ''),
  -- A-153: durum kümesi kabul belgesiyle aynı (kartta ayrı küme yok).
  CONSTRAINT customer_returns_status_chk CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED')),
  CONSTRAINT customer_returns_version_chk CHECK (version >= 1)
);
CREATE INDEX customer_returns_tenant_warehouse_idx ON public.customer_returns (tenant_id, warehouse_id);

CREATE TABLE public.customer_return_lines (
  tenant_id            uuid           NOT NULL,
  id                   uuid           NOT NULL DEFAULT gen_random_uuid(),
  return_id            uuid           NOT NULL,
  line_no              integer        NOT NULL,
  sales_order_line_id  uuid           NOT NULL,
  item_id              uuid           NOT NULL,
  quantity             numeric(20, 6) NOT NULL,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT customer_return_lines_pkey PRIMARY KEY (id),
  CONSTRAINT customer_return_lines_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customer_return_lines_tenant_return_line_no_key UNIQUE (tenant_id, return_id, line_no),
  CONSTRAINT customer_return_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT customer_return_lines_return_fkey FOREIGN KEY (tenant_id, return_id) REFERENCES public.customer_returns (tenant_id, id),
  CONSTRAINT customer_return_lines_order_line_fkey FOREIGN KEY (tenant_id, sales_order_line_id) REFERENCES public.sales_order_lines (tenant_id, id),
  CONSTRAINT customer_return_lines_order_line_item_fkey FOREIGN KEY (tenant_id, sales_order_line_id, item_id)
    REFERENCES public.sales_order_lines (tenant_id, id, item_id),
  CONSTRAINT customer_return_lines_line_no_chk CHECK (line_no >= 1),
  CONSTRAINT customer_return_lines_quantity_chk CHECK (quantity > 0)
);
CREATE INDEX customer_return_lines_tenant_order_line_idx ON public.customer_return_lines (tenant_id, sales_order_line_id);
CREATE INDEX customer_return_lines_tenant_item_idx ON public.customer_return_lines (tenant_id, item_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Tetikleyiciler (SECURITY INVOKER, search_path sabit, PUBLIC'ten EXECUTE geri alınır)
-- ---------------------------------------------------------------------------------------------
-- 2a. Başlıklar: version her UPDATE'te +1 (istemci değeri yok sayılır; 0012 documents deseni).
CREATE FUNCTION public.field_docs_bump_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.field_docs_bump_version() FROM PUBLIC;

-- 2b. Anahtar sütunlar değişmez (tablo sahibi dahil). Sütun adları tetikleyici argümanıdır (fail-closed: listelenen her sütun).
CREATE FUNCTION public.field_docs_guard_keys() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  i integer;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    IF pg_catalog.to_jsonb(NEW) -> TG_ARGV[i] IS DISTINCT FROM pg_catalog.to_jsonb(OLD) -> TG_ARGV[i] THEN
      RAISE EXCEPTION '%: % değiştirilemez', TG_TABLE_NAME, TG_ARGV[i] USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.field_docs_guard_keys() FROM PUBLIC;

CREATE TRIGGER inbound_receipts_bump_version BEFORE UPDATE ON public.inbound_receipts
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_bump_version();
CREATE TRIGGER sales_orders_bump_version BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_bump_version();
CREATE TRIGGER customer_returns_bump_version BEFORE UPDATE ON public.customer_returns
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_bump_version();

CREATE TRIGGER inbound_receipts_guard_keys BEFORE UPDATE ON public.inbound_receipts
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'warehouse_id', 'number', 'created_by', 'created_at');
CREATE TRIGGER sales_orders_guard_keys BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'number', 'created_by', 'created_at');
CREATE TRIGGER customer_returns_guard_keys BEFORE UPDATE ON public.customer_returns
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'warehouse_id', 'number', 'created_by', 'created_at');
CREATE TRIGGER inbound_receipt_lines_guard_keys BEFORE UPDATE ON public.inbound_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'receipt_id', 'line_no', 'item_id', 'unit_id', 'conversion_factor', 'created_at');
CREATE TRIGGER sales_order_lines_guard_keys BEFORE UPDATE ON public.sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'order_id', 'line_no', 'item_id', 'created_at');
CREATE TRIGGER customer_return_lines_guard_keys BEFORE UPDATE ON public.customer_return_lines
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'return_id', 'line_no', 'sales_order_line_id', 'item_id', 'created_at');

-- ---------------------------------------------------------------------------------------------
-- 3. Genişletmeler (mevcut tablolar; hepsi nullable/varsayılanlı, mevcut satırlar geçerli kalır)
-- ---------------------------------------------------------------------------------------------
-- 3a. Belge kaynak bağlantısı (ADR-021 §2).
ALTER TABLE public.documents
  ADD COLUMN source_kind text,
  ADD COLUMN source_id   uuid,
  ADD CONSTRAINT documents_source_kind_chk CHECK (source_kind IS NULL OR source_kind IN ('INBOUND_RECEIPT', 'SALES_ORDER', 'CUSTOMER_RETURN', 'COUNT_SESSION', 'TASK')),
  ADD CONSTRAINT documents_source_pair_chk CHECK ((source_kind IS NULL) = (source_id IS NULL));
CREATE INDEX documents_tenant_source_idx ON public.documents (tenant_id, source_kind, source_id) WHERE source_id IS NOT NULL;

ALTER TABLE public.document_lines
  ADD COLUMN source_line_id uuid,
  -- STOCK_MOVE durum değişimi (kalite onayı KAR→KUL, AVAILABLE→QUARANTINE; T-217 A-217-1): NULL = kaynak durumla aynı (stock_status ile aynı küme).
  ADD COLUMN target_stock_status text,
  ADD CONSTRAINT document_lines_target_stock_status_chk CHECK (target_stock_status IS NULL OR target_stock_status IN ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'BLOCKED'));
CREATE INDEX document_lines_tenant_source_line_idx ON public.document_lines (tenant_id, source_line_id) WHERE source_line_id IS NOT NULL;

-- documents_guard_update: 0012 gövdesi + source_kind/source_id değişmez (yalnızca eklenen koşul).
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
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'documents: tenant_id/id/kind/type_version_id/reversal_of_document_id/source_kind/source_id/created_by/created_at değiştirilemez' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$fn$;

-- 3b. Rezervasyon: talep kaynağı belge satırı VEYA sipariş satırı (ADR-017 §7, ADR-021 §4).
ALTER TABLE public.reservations
  ALTER COLUMN document_line_id DROP NOT NULL,
  ADD COLUMN order_line_id uuid,
  ADD CONSTRAINT reservations_order_line_fkey FOREIGN KEY (tenant_id, order_line_id) REFERENCES public.sales_order_lines (tenant_id, id),
  ADD CONSTRAINT reservations_order_line_item_fkey FOREIGN KEY (tenant_id, order_line_id, item_id)
    REFERENCES public.sales_order_lines (tenant_id, id, item_id),
  ADD CONSTRAINT reservations_source_xor_chk CHECK ((document_line_id IS NULL) <> (order_line_id IS NULL));
CREATE INDEX reservations_order_line_idx ON public.reservations (tenant_id, order_line_id) WHERE order_line_id IS NOT NULL;

-- reservations_guard_update: 0013 gövdesi + order_line_id değişmez (yalnızca eklenen koşul).
CREATE OR REPLACE FUNCTION public.reservations_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.document_line_id IS DISTINCT FROM OLD.document_line_id
     OR NEW.order_line_id IS DISTINCT FROM OLD.order_line_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'reservations: tenant_id/id/document_line_id/order_line_id/created_at değiştirilemez' USING ERRCODE = '23514';
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

-- 3c. Kalite kontrol ayarı (A-06: varsayılan açık).
ALTER TABLE public.tenant_settings ADD COLUMN receiving_qc_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------------------------
-- 4. RLS (ADR-015 §5)
-- ---------------------------------------------------------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inbound_receipts', 'inbound_receipt_lines', 'sales_orders', 'sales_order_lines', 'customer_returns', 'customer_return_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
         USING      (tenant_id = NULLIF(pg_catalog.current_setting(''app.current_tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting(''app.current_tenant_id'', true), '''')::uuid)',
      t || '_isolation', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
  END LOOP;
END
$rls$;

-- ---------------------------------------------------------------------------------------------
-- 5. GRANT'lar (yalnızca wms_app; DELETE yok; wms_ops için hiçbir şey)
-- ---------------------------------------------------------------------------------------------
-- status/version INSERT listesinde YOK (varsayılan + tetikleyici); durum geçişi UPDATE (status).
GRANT SELECT ON public.inbound_receipts TO wms_app;
GRANT INSERT (tenant_id, id, warehouse_id, number, supplier_ref, created_by) ON public.inbound_receipts TO wms_app;
GRANT UPDATE (supplier_ref, status) ON public.inbound_receipts TO wms_app;

-- received/damaged INSERT listesinde YOK (0 ile başlar; kabul komutu UPDATE eder).
GRANT SELECT ON public.inbound_receipt_lines TO wms_app;
GRANT INSERT (tenant_id, id, receipt_id, line_no, item_id, unit_id, conversion_factor, expected_quantity) ON public.inbound_receipt_lines TO wms_app;
GRANT UPDATE (expected_quantity, received_quantity, damaged_quantity) ON public.inbound_receipt_lines TO wms_app;

GRANT SELECT ON public.sales_orders TO wms_app;
GRANT INSERT (tenant_id, id, number, customer_ref, created_by) ON public.sales_orders TO wms_app;
GRANT UPDATE (customer_ref, status) ON public.sales_orders TO wms_app;

-- shipped/returned/cancelled INSERT listesinde YOK (0 ile başlar; yalnızca sevk/iade/iptal komutları UPDATE eder).
GRANT SELECT ON public.sales_order_lines TO wms_app;
GRANT INSERT (tenant_id, id, order_id, line_no, item_id, requested_quantity) ON public.sales_order_lines TO wms_app;
GRANT UPDATE (requested_quantity, shipped_quantity, returned_quantity, cancelled_quantity) ON public.sales_order_lines TO wms_app;

GRANT SELECT ON public.customer_returns TO wms_app;
GRANT INSERT (tenant_id, id, warehouse_id, number, created_by) ON public.customer_returns TO wms_app;
GRANT UPDATE (status) ON public.customer_returns TO wms_app;

GRANT SELECT ON public.customer_return_lines TO wms_app;
GRANT INSERT (tenant_id, id, return_id, line_no, sales_order_line_id, item_id, quantity) ON public.customer_return_lines TO wms_app;
GRANT UPDATE (quantity) ON public.customer_return_lines TO wms_app;

-- Genişletmeler: yalnızca INSERT (kaynak bağlantısı ve sipariş bağlantısı oluşturulduktan sonra değişmez).
GRANT INSERT (source_kind, source_id) ON public.documents TO wms_app;
GRANT INSERT (source_line_id) ON public.document_lines TO wms_app;
-- target_stock_status: document_lines'taki diğer yazılabilir sütunlar gibi INSERT + UPDATE (0012 document_lines_guard yalnız DRAFT'ta yazıma izin verir; POSTED'da jsonb farkı reddeder).
GRANT INSERT (target_stock_status) ON public.document_lines TO wms_app;
GRANT UPDATE (target_stock_status) ON public.document_lines TO wms_app;
GRANT INSERT (order_line_id) ON public.reservations TO wms_app;
GRANT UPDATE (receiving_qc_enabled) ON public.tenant_settings TO wms_app;
