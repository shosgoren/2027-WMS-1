-- 0013_stock_ledger (T-232, ADR-017 §1-§7, §11, §12; I-04, I-05, I-09, I-15, I-16; G-01 İKİNCİ SAVUNMA):
-- stock_dimensions, stock_balances, stock_ledger, reservations + mutlak defter–bakiye denetimi (ertelenmiş kısıt tetikleyicileri).
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Tenant tabloları: tenant_id NOT NULL, ENABLE + FORCE RLS, tek PERMISSIVE USING + WITH CHECK tenant politikası (0010-0012 emsali),
--   FK'ler NO ACTION ve hepsi (tenant_id, …) BİLEŞİK, açık sütun bazlı GRANT'lar, PUBLIC'e hiçbir şey.
-- * wms_ops bu tablolarda HİÇBİR yetkiye sahip değildir (0010-0012 deseni; kart "SELECT" der, ops oturumu denetim-zorunluluğu
--   (RESTRICTIVE) ayrı kart gerektirir) — rapora sapma olarak yazıldı.
-- * stock_ledger değişmezliği: UPDATE/DELETE/TRUNCATE tetikleyicileri ve sunucu-alanları tetikleyicisi ENABLE ALWAYS
--   (session_replication_role = replica altında da çalışır). Tablo sahibi ALTER TABLE … DISABLE TRIGGER yapabilir: bilinen sınır
--   (0004 emsali); fikstür temizliği yalnızca bunu kullanır (süper kullanıcı/sahip; wms_app yapamaz).
-- * Denetim (ADR-017 §6): stock_assert_dimension() boyutun commit anındaki güncel durumunu MUTLAK karşılaştırır
--   (quantity = Σ defter; reserved_quantity = Σ ACTIVE rezervasyon; bakiye yoksa ikisi 0). Üç tabloda ertelenmiş FOR EACH ROW kısıt
--   tetikleyicisi; tekilleştirme YOK; işlev hiçbir kullanıcı GUC'u okumaz (yalnızca app.current_tenant_id bağlamı, geçen tenant_id
--   ile eşleşmek zorunda). Denetim tetikleyicileri de ENABLE ALWAYS (replica modunda atlanamaz).
-- * Seri tekilliği (I-05, ADR-017 §3): stock_balances.serial_key = boyutun serial_id'si (yoksa sıfır UUID sentineli) — BEFORE INSERT
--   tetikleyicisi doldurur, bileşik FK (tenant_id, stock_dimension_id, serial_key) → stock_dimensions boyutla eşleşmeyi KANITLAR
--   (MATCH SIMPLE NULL deliğine karşı sentinel). CHECK: seri boyutunda quantity ∈ {0,1}; kısmi tekil indeks: aynı seri bir boyutta pozitif.
-- * Sunucu alanları: stock_ledger.created_xid ve occurred_at BEFORE INSERT tetikleyicisiyle sunucu değerine zorlanır; wms_app INSERT
--   yetkisi ikisini kapsamaz (kart yalnızca created_xid der; occurred_at 0012 document_status_history emsaliyle eklendi — sapma).
-- * Rezervasyon: ACTIVE dışı (CONSUMED/RELEASED) satır sonlanmıştır, değiştirilemez (ADR-009; varsayım). INSERT yalnızca ACTIVE açar.
-- * Ürün tutarlılığı (ADR-017 §2, M-3 / MAJOR-1): stock_ledger ve reservations'a item_id eklenir. Değer BEFORE INSERT (reservations'ta
--   ayrıca BEFORE UPDATE) ENABLE ALWAYS tetikleyicisiyle HER ZAMAN boyutun item_id'sinden türetilir (istemci veremez); bileşik FK'ler
--   (tenant_id, stock_dimension_id, item_id) → stock_dimensions ve (tenant_id, document_line_id, item_id) → document_lines (yeni
--   UNIQUE (tenant_id, id, item_id)) belge satırının ürününün boyutun ürünüyle eşit olmasını DB'de zorlar. Reservations.stock_dimension_id
--   UPDATE yetkisi KALIR (ADR-017 §7: toplamada rezervasyon hedef boyuta taşınır); aynı denetim UPDATE'te de çalışır (item_id yeniden
--   türetilir, satır FK'si başka ürüne taşımayı reddeder). FK'nin yan etkisi: defter/rezervasyonun bağlandığı satırın item_id'si değişemez.
-- * Takip modu (MAJOR-2): stock_dimensions BEFORE INSERT ENABLE ALWAYS tetikleyicisi ürünün tracking_mode'una göre lot/seri doluluğunu
--   zorlar (NONE: ikisi NULL; LOT: lot dolu, seri NULL; SERIAL: seri dolu, lot NULL; LOT_AND_SERIAL: ikisi dolu) ve seri doluysa serinin
--   lot_id'sinin boyutun lot_id'sine eşit olmasını ister (MINOR-6). Bileşik FK yerine tetikleyici: tracking_mode'u boyuta kopyalamak
--   istemciye ek sütun yükler; boyut değişmez ve items.tracking_mode değişmez (A-87), bu yüzden INSERT anı denetimi yeterlidir.
-- * MINOR-5 (defter yalnızca APPROVED + posting_job_id dolu belgede): UYGULANMADI — ADR-018 §2 senkron yolda (≤ 200 satır) posting_job_id
--   hiç yazılmaz ve defter/belge durumu aynı transaction'da sıralanır; kural senkron akışı kırardı. Q önerisi raporda.
-- * Miktarlar numeric(20,6); float yok (I-09).
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.document_lines') IS NULL
     OR pg_catalog.to_regclass('public.handling_units') IS NULL
     OR pg_catalog.to_regclass('public.serials') IS NULL THEN
    RAISE EXCEPTION '0013_stock_ledger: 0010/0011/0012 önkoşulu yok';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0013_stock_ledger: wms_app rolü yok (altyapı adımı)';
  END IF;
END
$pre$;

-- Defter/rezervasyon bileşik FK hedefi (MAJOR-1): satırın ürünü.
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_tenant_id_id_item_key UNIQUE (tenant_id, id, item_id);

-- ---------------------------------------------------------------------------------------------
-- 1. Tablolar
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.stock_dimensions (
  tenant_id           uuid        NOT NULL,
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  item_id             uuid        NOT NULL,
  location_id         uuid        NOT NULL,
  lot_id              uuid,
  serial_id           uuid,
  stock_status        text        NOT NULL DEFAULT 'AVAILABLE',
  inventory_owner_id  uuid,
  handling_unit_id    uuid,
  serial_key          uuid        GENERATED ALWAYS AS (COALESCE(serial_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_dimensions_pkey PRIMARY KEY (id),
  CONSTRAINT stock_dimensions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_dimensions_tenant_id_id_serial_key_key UNIQUE (tenant_id, id, serial_key),
  CONSTRAINT stock_dimensions_tenant_id_id_item_key UNIQUE (tenant_id, id, item_id),
  CONSTRAINT stock_dimensions_natural_key UNIQUE NULLS NOT DISTINCT
    (tenant_id, item_id, location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id),
  CONSTRAINT stock_dimensions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT stock_dimensions_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT stock_dimensions_location_fkey FOREIGN KEY (tenant_id, location_id) REFERENCES public.locations (tenant_id, id),
  CONSTRAINT stock_dimensions_lot_fkey FOREIGN KEY (tenant_id, item_id, lot_id) REFERENCES public.lots (tenant_id, item_id, id),
  CONSTRAINT stock_dimensions_serial_fkey FOREIGN KEY (tenant_id, item_id, serial_id) REFERENCES public.serials (tenant_id, item_id, id),
  CONSTRAINT stock_dimensions_owner_fkey FOREIGN KEY (tenant_id, inventory_owner_id) REFERENCES public.inventory_owners (tenant_id, id),
  CONSTRAINT stock_dimensions_handling_unit_fkey FOREIGN KEY (tenant_id, handling_unit_id) REFERENCES public.handling_units (tenant_id, id),
  CONSTRAINT stock_dimensions_stock_status_chk CHECK (stock_status IN ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'BLOCKED'))
);
CREATE INDEX stock_dimensions_tenant_location_idx ON public.stock_dimensions (tenant_id, location_id);
CREATE INDEX stock_dimensions_tenant_lot_idx ON public.stock_dimensions (tenant_id, lot_id);
CREATE INDEX stock_dimensions_tenant_serial_idx ON public.stock_dimensions (tenant_id, serial_id);
CREATE INDEX stock_dimensions_tenant_owner_idx ON public.stock_dimensions (tenant_id, inventory_owner_id);
CREATE INDEX stock_dimensions_tenant_handling_unit_idx ON public.stock_dimensions (tenant_id, handling_unit_id);

CREATE TABLE public.stock_balances (
  tenant_id          uuid           NOT NULL,
  stock_dimension_id uuid           NOT NULL,
  quantity           numeric(20, 6) NOT NULL DEFAULT 0,
  reserved_quantity  numeric(20, 6) NOT NULL DEFAULT 0,
  version            bigint         NOT NULL DEFAULT 0,
  serial_key         uuid           NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  CONSTRAINT stock_balances_pkey PRIMARY KEY (tenant_id, stock_dimension_id),
  CONSTRAINT stock_balances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT stock_balances_dimension_fkey FOREIGN KEY (tenant_id, stock_dimension_id, serial_key)
    REFERENCES public.stock_dimensions (tenant_id, id, serial_key),
  CONSTRAINT stock_balances_quantity_chk CHECK (quantity >= 0),
  CONSTRAINT stock_balances_reserved_chk CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity),
  CONSTRAINT stock_balances_version_chk CHECK (version >= 0),
  CONSTRAINT stock_balances_serial_qty_chk CHECK (serial_key = '00000000-0000-0000-0000-000000000000' OR quantity IN (0, 1))
);
-- AC-09 DB savunması: aynı seri en çok bir boyutta pozitif (kısmi tekil indeks ertelenemez; ADR-017 §3 MINOR-5).
CREATE UNIQUE INDEX stock_balances_serial_positive_key ON public.stock_balances (tenant_id, serial_key)
  WHERE quantity > 0 AND serial_key <> '00000000-0000-0000-0000-000000000000';

CREATE TABLE public.stock_ledger (
  tenant_id          uuid           NOT NULL,
  id                 uuid           NOT NULL DEFAULT gen_random_uuid(),
  document_id        uuid           NOT NULL,
  document_line_id   uuid           NOT NULL,
  stock_dimension_id uuid           NOT NULL,
  item_id            uuid           NOT NULL,
  quantity           numeric(20, 6) NOT NULL,
  reason             text           NOT NULL,
  business_date      date           NOT NULL,
  occurred_at        timestamptz    NOT NULL DEFAULT now(),
  actor_user_id      uuid,
  created_xid        xid8           NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT stock_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT stock_ledger_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_ledger_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT stock_ledger_dimension_fkey FOREIGN KEY (tenant_id, stock_dimension_id, item_id)
    REFERENCES public.stock_dimensions (tenant_id, id, item_id),
  CONSTRAINT stock_ledger_line_item_fkey FOREIGN KEY (tenant_id, document_line_id, item_id)
    REFERENCES public.document_lines (tenant_id, id, item_id),
  CONSTRAINT stock_ledger_document_line_fkey FOREIGN KEY (tenant_id, document_id, document_line_id)
    REFERENCES public.document_lines (tenant_id, document_id, id),
  CONSTRAINT stock_ledger_quantity_chk CHECK (quantity <> 0),
  CONSTRAINT stock_ledger_reason_chk CHECK (btrim(reason) <> '')
);
-- §6 toplam denetimi: index-only.
CREATE INDEX stock_ledger_dimension_sum_idx ON public.stock_ledger (tenant_id, stock_dimension_id) INCLUDE (quantity);
CREATE INDEX stock_ledger_document_line_idx ON public.stock_ledger (tenant_id, document_id, document_line_id);
CREATE INDEX stock_ledger_tenant_xid_idx ON public.stock_ledger (tenant_id, created_xid);

CREATE TABLE public.reservations (
  tenant_id          uuid           NOT NULL,
  id                 uuid           NOT NULL DEFAULT gen_random_uuid(),
  stock_dimension_id uuid           NOT NULL,
  document_line_id   uuid           NOT NULL,
  item_id            uuid           NOT NULL,
  quantity           numeric(20, 6) NOT NULL,
  status             text           NOT NULL DEFAULT 'ACTIVE',
  expires_at         timestamptz,
  created_at         timestamptz    NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CONSTRAINT reservations_pkey PRIMARY KEY (id),
  CONSTRAINT reservations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT reservations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT reservations_dimension_fkey FOREIGN KEY (tenant_id, stock_dimension_id, item_id)
    REFERENCES public.stock_dimensions (tenant_id, id, item_id),
  CONSTRAINT reservations_document_line_fkey FOREIGN KEY (tenant_id, document_line_id) REFERENCES public.document_lines (tenant_id, id),
  CONSTRAINT reservations_line_item_fkey FOREIGN KEY (tenant_id, document_line_id, item_id)
    REFERENCES public.document_lines (tenant_id, id, item_id),
  CONSTRAINT reservations_quantity_chk CHECK (quantity > 0),
  CONSTRAINT reservations_status_chk CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  CONSTRAINT reservations_closed_chk CHECK ((status = 'ACTIVE') = (closed_at IS NULL)),
  CONSTRAINT reservations_expires_chk CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX reservations_active_sum_idx ON public.reservations (tenant_id, stock_dimension_id) INCLUDE (quantity) WHERE status = 'ACTIVE';
CREATE INDEX reservations_dimension_idx ON public.reservations (tenant_id, stock_dimension_id);
CREATE INDEX reservations_document_line_idx ON public.reservations (tenant_id, document_line_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Tetikleyiciler (SECURITY INVOKER, search_path sabit, PUBLIC'ten EXECUTE geri alınır)
-- ---------------------------------------------------------------------------------------------

-- 2a. Ortak ret işlevi (boyut + defter).
CREATE FUNCTION public.stock_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION '%: değişmezdir/append-only (I-04): % reddedildi', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_reject_change() FROM PUBLIC;

CREATE TRIGGER stock_dimensions_immutable BEFORE UPDATE OR DELETE ON public.stock_dimensions
  FOR EACH ROW EXECUTE FUNCTION public.stock_reject_change();
CREATE TRIGGER stock_dimensions_no_truncate BEFORE TRUNCATE ON public.stock_dimensions
  FOR EACH STATEMENT EXECUTE FUNCTION public.stock_reject_change();

CREATE TRIGGER stock_ledger_append_only BEFORE UPDATE OR DELETE ON public.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.stock_reject_change();
CREATE TRIGGER stock_ledger_no_truncate BEFORE TRUNCATE ON public.stock_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.stock_reject_change();
ALTER TABLE public.stock_ledger ENABLE ALWAYS TRIGGER stock_ledger_append_only;
ALTER TABLE public.stock_ledger ENABLE ALWAYS TRIGGER stock_ledger_no_truncate;

-- 2b. stock_ledger sunucu alanları (ADR-017 §5).
CREATE FUNCTION public.stock_ledger_force_server_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.created_xid := pg_catalog.pg_current_xact_id();
  NEW.occurred_at := pg_catalog.now();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_ledger_force_server_fields() FROM PUBLIC;
CREATE TRIGGER stock_ledger_server_fields BEFORE INSERT ON public.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.stock_ledger_force_server_fields();
ALTER TABLE public.stock_ledger ENABLE ALWAYS TRIGGER stock_ledger_server_fields;

-- 2b'. item_id boyuttan türetilir (istemci değeri HER ZAMAN ezilir). Boyut görünmüyorsa (yok / başka tenant) sıfır UUID sentineli kalır:
--      bileşik FK 23503 verir (NOT NULL 23502'den önce yanlış sınıf dönmesin).
CREATE FUNCTION public.stock_set_item_id() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  SELECT d.item_id INTO NEW.item_id FROM public.stock_dimensions d
   WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.stock_dimension_id;
  IF NOT FOUND THEN
    NEW.item_id := '00000000-0000-0000-0000-000000000000';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_set_item_id() FROM PUBLIC;
CREATE TRIGGER stock_ledger_set_item_id BEFORE INSERT ON public.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.stock_set_item_id();
CREATE TRIGGER reservations_set_item_id BEFORE INSERT OR UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.stock_set_item_id();
ALTER TABLE public.stock_ledger ENABLE ALWAYS TRIGGER stock_ledger_set_item_id;
ALTER TABLE public.reservations ENABLE ALWAYS TRIGGER reservations_set_item_id;

-- 2b''. Boyut: ürünün takip moduna göre lot/seri doluluğu (MAJOR-2) ve serinin lotu ile boyutun lotu eşitliği (MINOR-6).
CREATE FUNCTION public.stock_dimensions_check_tracking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  mode text;
  s_lot uuid;
  s_found boolean;
BEGIN
  SELECT i.tracking_mode INTO mode FROM public.items i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.item_id;
  IF NOT FOUND THEN
    RETURN NEW; -- ürün yok / görünmüyor: bileşik FK 23503 verir
  END IF;
  IF (mode IN ('LOT', 'LOT_AND_SERIAL')) <> (NEW.lot_id IS NOT NULL)
     OR (mode IN ('SERIAL', 'LOT_AND_SERIAL')) <> (NEW.serial_id IS NOT NULL) THEN
    RAISE EXCEPTION 'TRACKING_VIOLATION: ürün takip modu % ile boyutun lot/seri alanları uyuşmuyor', mode USING ERRCODE = '23514';
  END IF;
  IF NEW.serial_id IS NOT NULL THEN
    SELECT sr.lot_id, true INTO s_lot, s_found FROM public.serials sr
     WHERE sr.tenant_id = NEW.tenant_id AND sr.item_id = NEW.item_id AND sr.id = NEW.serial_id;
    IF s_found AND s_lot IS DISTINCT FROM NEW.lot_id THEN
      RAISE EXCEPTION 'TRACKING_VIOLATION: serinin lotu boyutun lotuyla eşleşmiyor' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_dimensions_check_tracking() FROM PUBLIC;
CREATE TRIGGER stock_dimensions_check_tracking BEFORE INSERT ON public.stock_dimensions
  FOR EACH ROW EXECUTE FUNCTION public.stock_dimensions_check_tracking();
ALTER TABLE public.stock_dimensions ENABLE ALWAYS TRIGGER stock_dimensions_check_tracking;

-- 2b'''. Sahip yolu (MINOR-1): boyutu olan ürünün tracking_mode'u / boyutta kullanılan serinin lot_id'si değiştirilemez (wms_app zaten
--      UPDATE yetkisine sahip değil; bu tetikleyiciler tablo sahibini/migration rolünü bağlar, ENABLE ALWAYS). Okuma RLS altında yapıldığından
--      fail-closed: tenant bağlamı satırın tenant'ıyla eşleşmiyorsa (RLS satırları gizleyip denetimi sessizce geçirmesin) ret.
CREATE FUNCTION public.stock_guard_item_tracking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'STOCK_TENANT_CONTEXT_MISMATCH: tracking_mode değişimi için tenant bağlamı satırın tenant''ı olmalı' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_dimensions d WHERE d.tenant_id = OLD.tenant_id AND d.item_id = OLD.id) THEN
    RAISE EXCEPTION 'TRACKING_VIOLATION: ürünün stok boyutu var; tracking_mode değiştirilemez (A-87)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_guard_item_tracking() FROM PUBLIC;
CREATE TRIGGER items_guard_tracking_mode BEFORE UPDATE OF tracking_mode ON public.items
  FOR EACH ROW WHEN (OLD.tracking_mode IS DISTINCT FROM NEW.tracking_mode) EXECUTE FUNCTION public.stock_guard_item_tracking();
ALTER TABLE public.items ENABLE ALWAYS TRIGGER items_guard_tracking_mode;

CREATE FUNCTION public.stock_guard_serial_lot() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'STOCK_TENANT_CONTEXT_MISMATCH: serinin lot_id değişimi için tenant bağlamı satırın tenant''ı olmalı' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_dimensions d WHERE d.tenant_id = OLD.tenant_id AND d.serial_id = OLD.id) THEN
    RAISE EXCEPTION 'TRACKING_VIOLATION: seri bir stok boyutunda kullanılıyor; lot_id değiştirilemez' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_guard_serial_lot() FROM PUBLIC;
CREATE TRIGGER serials_guard_lot BEFORE UPDATE OF lot_id ON public.serials
  FOR EACH ROW WHEN (OLD.lot_id IS DISTINCT FROM NEW.lot_id) EXECUTE FUNCTION public.stock_guard_serial_lot();
ALTER TABLE public.serials ENABLE ALWAYS TRIGGER serials_guard_lot;

-- 2c. stock_balances: serial_key boyuttan türetilir (istemci değeri yok sayılır); anahtar sütunlar değişmez.
CREATE FUNCTION public.stock_balances_fill_serial_key() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Boyut görünmüyorsa (yok / başka tenant) sentinel kalır: B anahtarlı satırı RLS WITH CHECK (42501), A anahtarlı ama olmayan
  -- boyutu bileşik FK (23503) reddeder; burada ayrıca hata atılmaz (RLS hata sınıfı korunur).
  SELECT d.serial_key INTO NEW.serial_key FROM public.stock_dimensions d
   WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.stock_dimension_id;
  IF NOT FOUND THEN
    NEW.serial_key := '00000000-0000-0000-0000-000000000000';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_balances_fill_serial_key() FROM PUBLIC;
CREATE TRIGGER stock_balances_fill_serial_key BEFORE INSERT ON public.stock_balances
  FOR EACH ROW EXECUTE FUNCTION public.stock_balances_fill_serial_key();
ALTER TABLE public.stock_balances ENABLE ALWAYS TRIGGER stock_balances_fill_serial_key;

CREATE FUNCTION public.stock_balances_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.stock_dimension_id IS DISTINCT FROM OLD.stock_dimension_id
     OR NEW.serial_key IS DISTINCT FROM OLD.serial_key THEN
    RAISE EXCEPTION 'stock_balances: tenant_id/stock_dimension_id/serial_key değiştirilemez' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_balances_guard_update() FROM PUBLIC;
CREATE TRIGGER stock_balances_guard_update BEFORE UPDATE ON public.stock_balances
  FOR EACH ROW EXECUTE FUNCTION public.stock_balances_guard_update();

-- 2d. reservations: kimlik sütunları değişmez; sonlanmış rezervasyon değişmez.
CREATE FUNCTION public.reservations_guard_update() RETURNS trigger
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
REVOKE ALL ON FUNCTION public.reservations_guard_update() FROM PUBLIC;
CREATE TRIGGER reservations_guard_update BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.reservations_guard_update();

-- ---------------------------------------------------------------------------------------------
-- 3. Mutlak defter–bakiye denetimi (ADR-017 §6, G-01 ikinci savunma)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.stock_assert_dimension(p_tenant_id uuid, p_dimension_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  ctx uuid := NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid;
  b_found boolean;
  b_qty numeric;
  b_reserved numeric;
  l_sum numeric;
  r_sum numeric;
BEGIN
  IF ctx IS NULL OR p_tenant_id IS NULL OR ctx <> p_tenant_id THEN
    RAISE EXCEPTION 'STOCK_TENANT_CONTEXT_MISMATCH: tenant bağlamı boş veya yazılan satırın tenant''ından farklı' USING ERRCODE = '23514';
  END IF;

  SELECT b.quantity, b.reserved_quantity INTO b_qty, b_reserved
    FROM public.stock_balances b WHERE b.tenant_id = p_tenant_id AND b.stock_dimension_id = p_dimension_id;
  b_found := FOUND;
  IF NOT b_found THEN
    b_qty := 0;
    b_reserved := 0;
  END IF;

  SELECT COALESCE(pg_catalog.sum(l.quantity), 0) INTO l_sum
    FROM public.stock_ledger l WHERE l.tenant_id = p_tenant_id AND l.stock_dimension_id = p_dimension_id;
  SELECT COALESCE(pg_catalog.sum(r.quantity), 0) INTO r_sum
    FROM public.reservations r WHERE r.tenant_id = p_tenant_id AND r.stock_dimension_id = p_dimension_id AND r.status = 'ACTIVE';

  IF b_qty <> l_sum OR b_reserved <> r_sum THEN
    RAISE EXCEPTION 'STOCK_BALANCE_LEDGER_MISMATCH: boyut % bakiye=%/% (miktar/rezerve) defter=% aktif rezervasyon=%',
      p_dimension_id, b_qty, b_reserved, l_sum, r_sum USING ERRCODE = '23514';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_assert_dimension(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stock_assert_dimension(uuid, uuid) TO wms_app;

CREATE FUNCTION public.stock_assert_trigger() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM public.stock_assert_dimension(NEW.tenant_id, NEW.stock_dimension_id);
  IF TG_OP = 'UPDATE'
     AND (OLD.tenant_id, OLD.stock_dimension_id) IS DISTINCT FROM (NEW.tenant_id, NEW.stock_dimension_id) THEN
    PERFORM public.stock_assert_dimension(OLD.tenant_id, OLD.stock_dimension_id);
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_assert_trigger() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER stock_balances_assert AFTER INSERT OR UPDATE ON public.stock_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.stock_assert_trigger();
CREATE CONSTRAINT TRIGGER stock_ledger_assert AFTER INSERT ON public.stock_ledger
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.stock_assert_trigger();
CREATE CONSTRAINT TRIGGER reservations_assert AFTER INSERT OR UPDATE ON public.reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.stock_assert_trigger();
ALTER TABLE public.stock_balances ENABLE ALWAYS TRIGGER stock_balances_assert;
ALTER TABLE public.stock_ledger ENABLE ALWAYS TRIGGER stock_ledger_assert;
ALTER TABLE public.reservations ENABLE ALWAYS TRIGGER reservations_assert;

-- ---------------------------------------------------------------------------------------------
-- 4. RLS (ADR-015 §5)
-- ---------------------------------------------------------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_dimensions', 'stock_balances', 'stock_ledger', 'reservations'] LOOP
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
-- 5. GRANT'lar (yalnızca wms_app; DELETE hiçbir stok tablosunda yok; wms_ops için hiçbir şey)
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON public.stock_dimensions TO wms_app;
GRANT INSERT (tenant_id, id, item_id, location_id, lot_id, serial_id, stock_status, inventory_owner_id, handling_unit_id)
  ON public.stock_dimensions TO wms_app;

-- serial_key INSERT listesinde YOK (tetikleyici boyuttan yazar).
GRANT SELECT ON public.stock_balances TO wms_app;
GRANT INSERT (tenant_id, stock_dimension_id, quantity, reserved_quantity, version) ON public.stock_balances TO wms_app;
GRANT UPDATE (quantity, reserved_quantity, version) ON public.stock_balances TO wms_app;

-- created_xid ve occurred_at INSERT listesinde YOK.
GRANT SELECT ON public.stock_ledger TO wms_app;
GRANT INSERT (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, actor_user_id)
  ON public.stock_ledger TO wms_app;

-- closed_at ne INSERT'te ne UPDATE'te var (sunucu now() yazar); item_id de yok (tetikleyici boyuttan türetir).
GRANT SELECT ON public.reservations TO wms_app;
GRANT INSERT (tenant_id, id, stock_dimension_id, document_line_id, quantity, status, expires_at) ON public.reservations TO wms_app;
GRANT UPDATE (stock_dimension_id, quantity, status) ON public.reservations TO wms_app;
