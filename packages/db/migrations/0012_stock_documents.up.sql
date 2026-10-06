-- 0012_stock_documents (T-206, ADR-017 §5, §8-§10, ADR-018 §1-§3 §6, ADR-015 §5 şablonu, I-06, I-08, I-11, I-16, A-79):
-- document_type_versions, number_sequences, documents, document_lines, document_status_history, idempotency_records.
-- Defter/bakiye/boyut/rezervasyon ve yazma koruması T-232'dedir (kapsam dışı).
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Tenant tabloları (number_sequences, documents, document_lines, document_status_history, idempotency_records):
--   tenant_id NOT NULL, ENABLE + FORCE RLS, tek USING + WITH CHECK tenant politikası (TO'suz; 0010/0011 emsali), FK'ler NO ACTION
--   ve hepsi (tenant_id, …) BİLEŞİK (RI denetimi RLS'i atlar), açık sütun bazlı GRANT'lar, PUBLIC'e hiçbir şey.
--   Politika PERMISSIVE'dir (RESTRICTIVE-yalnız politika kümesi her şeyi reddederdi; RESTRICTIVE yalnızca 0009'daki wms_ops
--   denetim-zorunluluğu içindir).
-- * document_type_versions KÜRESEL/SİSTEM tablosudur: tenant_id NULL = sistem (A-79). Okuma politikası
--   `tenant_id IS NULL OR tenant_id = current`; yazma politikası YOKTUR (FORCE RLS tablo sahibine de uygulanır), wms_app yalnızca SELECT.
--   Sistem satırlarını migration kendisi yazar (aşağıda NO FORCE → INSERT → FORCE; tek transaction). Satır UPDATE/DELETE'i
--   ENABLE ALWAYS tetikleyiciyle herkese kapalıdır (I-11: sürüm değişmez). documents.type_version_id'nin tenant uyuşmazlığı
--   (başka tenant'ın tenant-özel sürümü) FK ile yakalanamaz (NULL tenantlı hedef + RI RLS'i atlar): BEFORE INSERT tetikleyicisi
--   fail-closed denetler (sürüm bulunamaz/başka tenant'ınsa ret). (type_version_id, kind) → (id, key) bileşik FK'si fiş tipi anahtarının
--   belge türüyle eşleşmesini zorlar.
-- * POSTED değişmezliği (I-08): documents'ta POSTED satırın HER UPDATE/DELETE'i reddedilir (23514); document_lines'ta POSTED belgenin
--   satırı yalnızca reversed_quantity (artış) + reversal_status (ileri geçiş) için güncellenebilir, ekleme/silme/diğer sütun ret.
--   version her başlık UPDATE'inde tetikleyiciyle +1 (istemci değeri yok sayılır; wms_app version'a yazamaz). Tetikleyiciler
--   migration rolü dahil herkesi bağlar (sahibin DISABLE TRIGGER yapabilmesi bilinen sınır, 0004 emsali).
-- * created_xid (I-16, ADR-017 §5): document_status_history BEFORE INSERT tetikleyicisi (ENABLE ALWAYS) created_xid ve occurred_at'i
--   sunucu değerine zorlar. geçmişi yalnızca documents AFTER INSERT /
--   AFTER UPDATE OF status tetikleyicisi yazar; doğrudan INSERT herkes için reddedilir (pg_trigger_depth denetimi, MINOR-3).
-- * document_status_history append-only: wms_app'e yalnızca SELECT/INSERT; BEFORE UPDATE OR DELETE tetikleyicisi 42501 ile reddeder.
--   Bu tetikleyici bilerek ENABLE ALWAYS DEĞİLDİR: fikstür temizliği (tablo sahibi + süper kullanıcı) `SET LOCAL
--   session_replication_role = replica` ile atlayabilsin (0004'ten fark: audit_logs satırı fikstürde yok, burada tohumlanır).
--   wms_app bu ayarı değiştiremez (süper kullanıcı ayarı).
-- * idempotency_records (ADR-017 §10, ADR-018): wms_app SELECT, INSERT (created_at hariç), UPDATE (status, result, error_code,
--   http_status, completed_at); request_hash/actor_user_id/client_key/command_type DEĞİŞTİRİLEMEZ (sütun yetkisi + tetikleyici,
--   tablo sahibi dahil); DELETE yok. Sonlanmış kayıt (IN_PROGRESS dışı) tamamen değişmezdir (I-06: tekrar = önceki sonuç).
--   result üst düzey anahtar beyaz listesi CHECK'tedir; iç içe yapı komut kodunda zod ile doğrulanır (T-213).
-- * actor/created_by/posting_requested_by/actor_user_id bilerek FK DEĞİLDİR (kullanıcı silinse de belge/denetim izi kalır, 0004 emsali).
-- * wms_ops: bu tablolarda HİÇBİR yetkisi yoktur (0010/0011 deseni; ops-role testi ayrıcalık listesini sabitler). Kart "yalnızca
--   SELECT" der; ops oturumu denetim-zorunluluğu (RESTRICTIVE) ayrı kart/migration gerektirir — rapora sapma olarak yazıldı.
-- * Miktarlar numeric(20,6); float yok (I-09).
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.tenants') IS NULL
     OR pg_catalog.to_regclass('public.locations') IS NULL
     OR pg_catalog.to_regclass('public.items') IS NULL
     OR pg_catalog.to_regclass('public.handling_units') IS NULL THEN
    RAISE EXCEPTION '0012_stock_documents: 0003_tenancy / 0010_warehouses_locations / 0011_catalog_traceability önkoşulu yok';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0012_stock_documents: wms_app rolü yok (altyapı adımı)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tablolar
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.document_type_versions (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid,
  key         text        NOT NULL,
  version     integer     NOT NULL,
  definition  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_type_versions_pkey PRIMARY KEY (id),
  CONSTRAINT document_type_versions_id_key_key UNIQUE (id, key),
  CONSTRAINT document_type_versions_tenant_key_version_key UNIQUE NULLS NOT DISTINCT (tenant_id, key, version),
  CONSTRAINT document_type_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT document_type_versions_key_chk CHECK (btrim(key) <> ''),
  CONSTRAINT document_type_versions_version_chk CHECK (version >= 1),
  CONSTRAINT document_type_versions_definition_chk CHECK (jsonb_typeof(definition) = 'object')
);

CREATE TABLE public.number_sequences (
  tenant_id      uuid        NOT NULL,
  document_kind  text        NOT NULL,
  period         text        NOT NULL,
  next_value     bigint      NOT NULL DEFAULT 1,
  CONSTRAINT number_sequences_pkey PRIMARY KEY (tenant_id, document_kind, period),
  CONSTRAINT number_sequences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT number_sequences_kind_chk CHECK (document_kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL')),
  CONSTRAINT number_sequences_period_chk CHECK (btrim(period) <> ''),
  CONSTRAINT number_sequences_next_value_chk CHECK (next_value >= 1)
);

CREATE TABLE public.documents (
  tenant_id                 uuid        NOT NULL,
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  kind                      text        NOT NULL,
  type_version_id           uuid        NOT NULL,
  number                    text,
  status                    text        NOT NULL DEFAULT 'DRAFT',
  version                   integer     NOT NULL DEFAULT 1,
  warehouse_id              uuid        NOT NULL,
  business_date             date        NOT NULL,
  reversal_of_document_id   uuid,
  posting_job_id            uuid,
  posting_requested_by      uuid,
  reason                    text,
  created_by                uuid        NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_pkey PRIMARY KEY (id),
  CONSTRAINT documents_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT documents_tenant_kind_number_key UNIQUE (tenant_id, kind, number),
  CONSTRAINT documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT documents_type_version_fkey FOREIGN KEY (type_version_id, kind) REFERENCES public.document_type_versions (id, key),
  CONSTRAINT documents_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id) REFERENCES public.warehouses (tenant_id, id),
  CONSTRAINT documents_reversal_of_fkey FOREIGN KEY (tenant_id, reversal_of_document_id) REFERENCES public.documents (tenant_id, id),
  CONSTRAINT documents_kind_chk CHECK (kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL')),
  CONSTRAINT documents_status_chk CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED', 'CANCELLED')),
  CONSTRAINT documents_version_chk CHECK (version >= 1),
  CONSTRAINT documents_number_chk CHECK (number IS NULL OR btrim(number) <> ''),
  CONSTRAINT documents_posted_number_chk CHECK (status <> 'POSTED' OR number IS NOT NULL),
  CONSTRAINT documents_reversal_chk CHECK ((kind = 'REVERSAL') = (reversal_of_document_id IS NOT NULL)),
  CONSTRAINT documents_reversal_not_self_chk CHECK (reversal_of_document_id IS NULL OR reversal_of_document_id <> id),
  CONSTRAINT documents_posting_pair_chk CHECK ((posting_job_id IS NULL) = (posting_requested_by IS NULL)),
  CONSTRAINT documents_posting_status_chk CHECK (posting_job_id IS NULL OR status = 'APPROVED')
);
CREATE INDEX documents_tenant_warehouse_idx ON public.documents (tenant_id, warehouse_id);
CREATE INDEX documents_tenant_status_idx ON public.documents (tenant_id, status, business_date);
CREATE INDEX documents_tenant_reversal_of_idx ON public.documents (tenant_id, reversal_of_document_id);
CREATE INDEX documents_type_version_idx ON public.documents (type_version_id);

CREATE TABLE public.document_lines (
  tenant_id            uuid           NOT NULL,
  id                   uuid           NOT NULL DEFAULT gen_random_uuid(),
  document_id          uuid           NOT NULL,
  line_no              integer        NOT NULL,
  item_id              uuid           NOT NULL,
  unit_id              uuid           NOT NULL,
  quantity             numeric(20, 6) NOT NULL,
  conversion_factor    numeric(20, 6) NOT NULL,
  base_quantity        numeric(20, 6) NOT NULL,
  source_location_id   uuid,
  target_location_id   uuid,
  lot_id               uuid,
  serial_id            uuid,
  stock_status         text           NOT NULL DEFAULT 'AVAILABLE',
  inventory_owner_id   uuid,
  handling_unit_id     uuid,
  reversed_quantity    numeric(20, 6) NOT NULL DEFAULT 0,
  reversal_status      text           NOT NULL DEFAULT 'NONE',
  created_at           timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT document_lines_pkey PRIMARY KEY (id),
  CONSTRAINT document_lines_tenant_id_id_key UNIQUE (tenant_id, id),
  -- T-232 defter FK'si (tenant_id, document_id, document_line_id) bu anahtarı hedefler.
  CONSTRAINT document_lines_tenant_document_id_key UNIQUE (tenant_id, document_id, id),
  CONSTRAINT document_lines_tenant_document_line_no_key UNIQUE (tenant_id, document_id, line_no),
  CONSTRAINT document_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT document_lines_document_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents (tenant_id, id),
  CONSTRAINT document_lines_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT document_lines_unit_fkey FOREIGN KEY (tenant_id, unit_id) REFERENCES public.units (tenant_id, id),
  CONSTRAINT document_lines_source_location_fkey FOREIGN KEY (tenant_id, source_location_id) REFERENCES public.locations (tenant_id, id),
  CONSTRAINT document_lines_target_location_fkey FOREIGN KEY (tenant_id, target_location_id) REFERENCES public.locations (tenant_id, id),
  -- M-3: lot/seri ÜRÜNE bağlı (başka ürünün lotu reddedilir); NULL ise FK atlanır (MATCH SIMPLE).
  CONSTRAINT document_lines_lot_fkey FOREIGN KEY (tenant_id, item_id, lot_id) REFERENCES public.lots (tenant_id, item_id, id),
  CONSTRAINT document_lines_serial_fkey FOREIGN KEY (tenant_id, item_id, serial_id) REFERENCES public.serials (tenant_id, item_id, id),
  CONSTRAINT document_lines_owner_fkey FOREIGN KEY (tenant_id, inventory_owner_id) REFERENCES public.inventory_owners (tenant_id, id),
  CONSTRAINT document_lines_handling_unit_fkey FOREIGN KEY (tenant_id, handling_unit_id) REFERENCES public.handling_units (tenant_id, id),
  CONSTRAINT document_lines_line_no_chk CHECK (line_no >= 1),
  CONSTRAINT document_lines_quantity_chk CHECK (quantity > 0 AND conversion_factor > 0 AND base_quantity > 0),
  CONSTRAINT document_lines_location_chk CHECK (source_location_id IS NOT NULL OR target_location_id IS NOT NULL),
  CONSTRAINT document_lines_stock_status_chk CHECK (stock_status IN ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'BLOCKED')),
  CONSTRAINT document_lines_reversed_chk CHECK (reversed_quantity >= 0),
  CONSTRAINT document_lines_reversal_status_chk CHECK (reversal_status IN ('NONE', 'PARTIAL', 'FULL')),
  CONSTRAINT document_lines_reversal_consistent_chk CHECK ((reversal_status = 'NONE') = (reversed_quantity = 0))
);
CREATE INDEX document_lines_tenant_item_idx ON public.document_lines (tenant_id, item_id);
CREATE INDEX document_lines_tenant_unit_idx ON public.document_lines (tenant_id, unit_id);
CREATE INDEX document_lines_tenant_source_idx ON public.document_lines (tenant_id, source_location_id);
CREATE INDEX document_lines_tenant_target_idx ON public.document_lines (tenant_id, target_location_id);
CREATE INDEX document_lines_tenant_lot_idx ON public.document_lines (tenant_id, lot_id);
CREATE INDEX document_lines_tenant_serial_idx ON public.document_lines (tenant_id, serial_id);

CREATE TABLE public.document_status_history (
  tenant_id      uuid        NOT NULL,
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  document_id    uuid        NOT NULL,
  from_status    text,
  to_status      text        NOT NULL,
  actor_user_id  uuid,
  reason         text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_xid    xid8        NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT document_status_history_pkey PRIMARY KEY (id),
  CONSTRAINT document_status_history_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT document_status_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT document_status_history_document_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents (tenant_id, id),
  CONSTRAINT document_status_history_from_chk CHECK (from_status IS NULL OR from_status IN ('DRAFT', 'APPROVED', 'POSTED', 'CANCELLED')),
  CONSTRAINT document_status_history_to_chk CHECK (to_status IN ('DRAFT', 'APPROVED', 'POSTED', 'CANCELLED'))
);
CREATE INDEX document_status_history_tenant_document_idx ON public.document_status_history (tenant_id, document_id, occurred_at);

CREATE TABLE public.idempotency_records (
  tenant_id      uuid        NOT NULL,
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  command_type   text        NOT NULL,
  client_key     uuid        NOT NULL,
  actor_user_id  uuid        NOT NULL,
  request_hash   text        NOT NULL,
  status         text        NOT NULL DEFAULT 'IN_PROGRESS',
  result         jsonb,
  error_code     text,
  http_status    integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  CONSTRAINT idempotency_records_pkey PRIMARY KEY (id),
  CONSTRAINT idempotency_records_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT idempotency_records_tenant_command_key_key UNIQUE (tenant_id, command_type, client_key),
  CONSTRAINT idempotency_records_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT idempotency_records_command_type_chk CHECK (btrim(command_type) <> ''),
  CONSTRAINT idempotency_records_request_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_records_status_chk CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'REJECTED', 'FAILED')),
  CONSTRAINT idempotency_records_error_code_chk CHECK ((status IN ('REJECTED', 'FAILED')) = (error_code IS NOT NULL)),
  CONSTRAINT idempotency_records_completed_chk CHECK ((status = 'IN_PROGRESS') = (completed_at IS NULL)),
  CONSTRAINT idempotency_records_http_status_chk CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  -- ADR-017 §10 üst düzey beyaz liste (CHECK'te küme döndüren işlev kullanılamaz: jsonb_object_keys yok); iç içe doğrulama kodda (T-213).
  CONSTRAINT idempotency_records_result_chk CHECK (
    result IS NULL OR (
      jsonb_typeof(result) = 'object'
      AND (result - ARRAY['documentId', 'documentNumber', 'status', 'reservationIds', 'lines']::text[]) = '{}'::jsonb
    )
  )
);

-- ---------------------------------------------------------------------------------------------
-- 2. Tetikleyiciler (SECURITY INVOKER, search_path sabit, PUBLIC'ten EXECUTE geri alınır)
-- ---------------------------------------------------------------------------------------------

-- 2a. document_type_versions: değişmez (I-11). ENABLE ALWAYS.
CREATE FUNCTION public.document_type_versions_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'document_type_versions değişmezdir (I-11): % reddedildi', TG_OP USING ERRCODE = '42501';
END
$fn$;
REVOKE ALL ON FUNCTION public.document_type_versions_reject_change() FROM PUBLIC;
CREATE TRIGGER document_type_versions_immutable BEFORE UPDATE OR DELETE ON public.document_type_versions
  FOR EACH ROW EXECUTE FUNCTION public.document_type_versions_reject_change();
ALTER TABLE public.document_type_versions ENABLE ALWAYS TRIGGER document_type_versions_immutable;

-- 2b. number_sequences: sayaç geri gitmez; kimlik sütunları değişmez.
CREATE FUNCTION public.number_sequences_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
     OR NEW.period IS DISTINCT FROM OLD.period THEN
    RAISE EXCEPTION 'number_sequences: anahtar sütunları değiştirilemez' USING ERRCODE = '23514';
  END IF;
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'number_sequences: next_value azaltılamaz' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.number_sequences_guard_update() FROM PUBLIC;
CREATE TRIGGER number_sequences_guard_update BEFORE UPDATE ON public.number_sequences
  FOR EACH ROW EXECUTE FUNCTION public.number_sequences_guard_update();

-- 2c. documents
CREATE FUNCTION public.documents_check_type_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Fail-closed: sürüm görünmüyorsa (yok / başka tenant'ın tenant-özel sürümü) ret. Okuma çağıranın RLS bağlamındadır
  -- (politika: sistem satırı veya kendi tenant'ı).
  IF NOT EXISTS (SELECT 1 FROM public.document_type_versions v
                  WHERE v.id = NEW.type_version_id AND (v.tenant_id IS NULL OR v.tenant_id = NEW.tenant_id)) THEN
    RAISE EXCEPTION 'documents: fiş tipi sürümü yok veya bu tenant için geçerli değil' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.documents_check_type_version() FROM PUBLIC;
CREATE TRIGGER documents_check_type_version BEFORE INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_check_type_version();

CREATE FUNCTION public.documents_guard_update() RETURNS trigger
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
REVOKE ALL ON FUNCTION public.documents_guard_update() FROM PUBLIC;
CREATE TRIGGER documents_guard_update BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_guard_update();

CREATE FUNCTION public.documents_guard_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'DOCUMENT_POSTED_IMMUTABLE: işlenmiş belge silinemez (I-08)' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$fn$;
REVOKE ALL ON FUNCTION public.documents_guard_delete() FROM PUBLIC;
CREATE TRIGGER documents_guard_delete BEFORE DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_guard_delete();

-- 2d. document_lines: satır yazımı (INSERT/UPDATE/DELETE) YALNIZCA DRAFT belgede (spec 05 §Belge durumları: yalnız DRAFT "Düzenle";
--     T-213 updateDraft yalnız DRAFT). POSTED belgede tek istisna reversed_quantity artışı + reversal_status ileri geçişi (I-08);
--     APPROVED/CANCELLED satırları salt okunur. Üst belge durumu FOR SHARE ile okunur: posting işlemi başlığı POSTED yapıp commit
--     etmeden eşzamanlı satır yazımı bloklanır ve (READ COMMITTED yeniden denetimi) commit sonrası POSTED'ı görüp reddedilir (MAJOR-1).
--     Satır sahibi belge görünmüyorsa (NULL) bileşik FK reddeder.
CREATE FUNCTION public.document_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  parent_status text;
  old_rank int;
  new_rank int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT d.status INTO parent_status FROM public.documents d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.document_id FOR SHARE;
    IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'DOCUMENT_NOT_DRAFT: yalnızca taslak belgeye satır eklenebilir (belge %)', parent_status USING ERRCODE = '23514';
    END IF;
    IF NEW.reversed_quantity <> 0 OR NEW.reversal_status <> 'NONE' THEN
      RAISE EXCEPTION 'document_lines: yeni satır ters çevrilmiş olamaz' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT d.status INTO parent_status FROM public.documents d WHERE d.tenant_id = OLD.tenant_id AND d.id = OLD.document_id FOR SHARE;

  IF TG_OP = 'DELETE' THEN
    IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'DOCUMENT_NOT_DRAFT: yalnızca taslak belgenin satırı silinebilir (belge %)', parent_status USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'document_lines: tenant_id/id/document_id değiştirilemez' USING ERRCODE = '23514';
  END IF;
  IF parent_status = 'POSTED' THEN
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['reversed_quantity', 'reversal_status']::text[])
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['reversed_quantity', 'reversal_status']::text[]) THEN
      RAISE EXCEPTION 'DOCUMENT_POSTED_IMMUTABLE: işlenmiş belge satırında yalnızca reversed_quantity/reversal_status değişebilir (I-08)' USING ERRCODE = '23514';
    END IF;
    IF NEW.reversed_quantity < OLD.reversed_quantity THEN
      RAISE EXCEPTION 'REVERSAL_DECREASE: reversed_quantity azaltılamaz (I-08)' USING ERRCODE = '23514';
    END IF;
    old_rank := CASE OLD.reversal_status WHEN 'NONE' THEN 0 WHEN 'PARTIAL' THEN 1 ELSE 2 END;
    new_rank := CASE NEW.reversal_status WHEN 'NONE' THEN 0 WHEN 'PARTIAL' THEN 1 ELSE 2 END;
    IF new_rank < old_rank THEN
      RAISE EXCEPTION 'REVERSAL_DECREASE: reversal_status geri alınamaz (I-08)' USING ERRCODE = '23514';
    END IF;
  ELSIF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_DRAFT: yalnızca taslak belgenin satırı değiştirilebilir (belge %)', parent_status USING ERRCODE = '23514';
  ELSIF NEW.reversed_quantity IS DISTINCT FROM OLD.reversed_quantity OR NEW.reversal_status IS DISTINCT FROM OLD.reversal_status THEN
    RAISE EXCEPTION 'document_lines: ters çevirme alanları yalnızca POSTED belge satırında değişir' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.document_lines_guard() FROM PUBLIC;
CREATE TRIGGER document_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON public.document_lines
  FOR EACH ROW EXECUTE FUNCTION public.document_lines_guard();

-- 2e. document_status_history: sunucu alanları (ENABLE ALWAYS) + append-only (bilinçli olarak ENABLE ALWAYS değil, üst not).
CREATE FUNCTION public.document_status_history_force_server_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.occurred_at := pg_catalog.now();
  NEW.created_xid := pg_catalog.pg_current_xact_id();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.document_status_history_force_server_fields() FROM PUBLIC;
CREATE TRIGGER document_status_history_server_fields BEFORE INSERT ON public.document_status_history
  FOR EACH ROW EXECUTE FUNCTION public.document_status_history_force_server_fields();
ALTER TABLE public.document_status_history ENABLE ALWAYS TRIGGER document_status_history_server_fields;

CREATE FUNCTION public.document_status_history_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'document_status_history append-only: % reddedildi', TG_OP USING ERRCODE = '42501';
END
$fn$;
REVOKE ALL ON FUNCTION public.document_status_history_reject_change() FROM PUBLIC;
CREATE TRIGGER document_status_history_append_only BEFORE UPDATE OR DELETE ON public.document_status_history
  FOR EACH ROW EXECUTE FUNCTION public.document_status_history_reject_change();
CREATE TRIGGER document_status_history_no_truncate BEFORE TRUNCATE ON public.document_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.document_status_history_reject_change();
ALTER TABLE public.document_status_history ENABLE ALWAYS TRIGGER document_status_history_no_truncate;

-- 2e'. Durum geçmişini YALNIZCA documents tetikleyicisi yazar (MINOR-3): geçmiş gerçek geçişten sapamaz. SECURITY DEFINER KULLANILMAZ
--      (AC-04 bekçisi: her SECURITY DEFINER işlev wms_probe'ta probe sahipli ve izinli listede olmalı; probe'a yazma yetkisi vermek
--      güvenlik yüzeyini genişletirdi). Bunun yerine SECURITY INVOKER yazıcı + history üzerinde AFTER INSERT denetimi: satır, başka
--      bir tetikleyicinin içinden (pg_trigger_depth() >= 2) eklenmediyse HERKES için (tablo sahibi dahil) 42501 ile reddedilir.
--      wms_app'in sütun düzeyi INSERT yetkisi yalnızca bu tetikleyici yolu içindir; doğrudan INSERT ifadesi (derinlik 1) geri alınır.
--      Denetim AFTER'dır: RLS WITH CHECK ve tekillik hataları önce, kendi hata kodlarıyla görünür. wms_app tetikleyici/işlev
--      yaratamaz, dolayısıyla derinliği yapay yükseltemez (mevcut tek ek tetikleyici bu yazıcıdır).
CREATE FUNCTION public.documents_write_status_history() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.document_status_history (tenant_id, document_id, from_status, to_status, actor_user_id)
  VALUES (NEW.tenant_id, NEW.id,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
          NEW.status,
          NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')::uuid);
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.documents_write_status_history() FROM PUBLIC;
CREATE FUNCTION public.document_status_history_require_trigger_path() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'document_status_history: satır yalnızca documents durum tetikleyicisiyle yazılır (doğrudan INSERT reddedildi)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.document_status_history_require_trigger_path() FROM PUBLIC;
CREATE TRIGGER document_status_history_trigger_path AFTER INSERT ON public.document_status_history
  FOR EACH ROW EXECUTE FUNCTION public.document_status_history_require_trigger_path();
ALTER TABLE public.document_status_history ENABLE ALWAYS TRIGGER document_status_history_trigger_path;
CREATE TRIGGER documents_status_history_ins AFTER INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_write_status_history();
CREATE TRIGGER documents_status_history_upd AFTER UPDATE OF status ON public.documents
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.documents_write_status_history();

-- 2f. idempotency_records: kimlik/özet sütunları ve sonlanmış kayıt değişmez (tablo sahibi dahil).
CREATE FUNCTION public.idempotency_records_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.command_type IS DISTINCT FROM OLD.command_type
     OR NEW.client_key IS DISTINCT FROM OLD.client_key
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'idempotency_records: tenant_id/id/command_type/client_key/actor_user_id/request_hash/created_at değiştirilemez (I-06)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'idempotency_records: sonlanmış kayıt (%) değiştirilemez (I-06: tekrar = önceki sonuç)', OLD.status
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.idempotency_records_guard_update() FROM PUBLIC;
CREATE TRIGGER idempotency_records_guard_update BEFORE UPDATE ON public.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION public.idempotency_records_guard_update();

-- ---------------------------------------------------------------------------------------------
-- 3. Sistem fiş tipi sürümleri (A-79; tenant_id NULL). FORCE RLS tablo sahibine de uygulandığından yalnızca bu migration'da
--    (tek transaction) NO FORCE → INSERT → FORCE. definition şimdilik yer tutucu şemadır (içerik T-213/T-217'de zenginleşir
--    → yeni sürüm satırı; mevcut satır değişmez).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.document_type_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_type_versions NO FORCE ROW LEVEL SECURITY;
INSERT INTO public.document_type_versions (tenant_id, key, version, definition) VALUES
  (NULL, 'STOCK_IN',   1, '{"schemaVersion": 1, "kind": "STOCK_IN"}'::jsonb),
  (NULL, 'STOCK_OUT',  1, '{"schemaVersion": 1, "kind": "STOCK_OUT"}'::jsonb),
  (NULL, 'STOCK_MOVE', 1, '{"schemaVersion": 1, "kind": "STOCK_MOVE"}'::jsonb),
  (NULL, 'REVERSAL',   1, '{"schemaVersion": 1, "kind": "REVERSAL"}'::jsonb);
ALTER TABLE public.document_type_versions FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------
-- 4. RLS (ADR-015 §5)
-- ---------------------------------------------------------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['number_sequences', 'documents', 'document_lines', 'document_status_history', 'idempotency_records'] LOOP
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

CREATE POLICY document_type_versions_read ON public.document_type_versions
  FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
REVOKE ALL ON TABLE public.document_type_versions FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 5. GRANT'lar (yalnızca wms_app; wms_ops ve diğer roller için hiçbir şey)
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON public.document_type_versions TO wms_app;

GRANT SELECT ON public.number_sequences TO wms_app;
GRANT INSERT (tenant_id, document_kind, period, next_value) ON public.number_sequences TO wms_app;
GRANT UPDATE (next_value) ON public.number_sequences TO wms_app;

-- status/version INSERT'te yok: DRAFT/1 varsayılanı; durum geçişi UPDATE (status) ile (tetikleyici version'ı artırır).
GRANT SELECT ON public.documents TO wms_app;
GRANT INSERT (tenant_id, id, kind, type_version_id, number, warehouse_id, business_date, reversal_of_document_id, reason, created_by)
  ON public.documents TO wms_app;
GRANT UPDATE (number, status, warehouse_id, business_date, reason, posting_job_id, posting_requested_by) ON public.documents TO wms_app;

GRANT SELECT, DELETE ON public.document_lines TO wms_app;
GRANT INSERT (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity,
              source_location_id, target_location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id)
  ON public.document_lines TO wms_app;
GRANT UPDATE (line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, source_location_id, target_location_id,
              lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id, reversed_quantity, reversal_status)
  ON public.document_lines TO wms_app;

-- Sütun düzeyi INSERT yalnızca documents tetikleyici yolu içindir (doğrudan INSERT AFTER tetikleyicisiyle 42501, MINOR-3); created_xid/
-- occurred_at listede YOK. UPDATE/DELETE yetkisi yok.
GRANT SELECT ON public.document_status_history TO wms_app;
GRANT INSERT (tenant_id, id, document_id, from_status, to_status, actor_user_id) ON public.document_status_history TO wms_app;

GRANT SELECT ON public.idempotency_records TO wms_app;
GRANT INSERT (tenant_id, id, command_type, client_key, actor_user_id, request_hash, status, result, error_code, http_status, completed_at)
  ON public.idempotency_records TO wms_app;
GRANT UPDATE (status, result, error_code, http_status, completed_at) ON public.idempotency_records TO wms_app;
