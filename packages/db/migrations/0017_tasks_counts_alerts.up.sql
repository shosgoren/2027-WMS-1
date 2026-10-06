-- 0017_tasks_counts_alerts (T-302, ADR-021 §3 §5 §6 §7, ADR-015 §5 şablonu, G-08 genişlet–taşı–daralt, A-84, A-85, A-90, A-131, A-136, A-139):
-- warehouse_tasks, count_sessions + count_session_lines, item_stock_policies, stock_alerts (yeni tablolar);
-- location_count_locks.count_session_id → count_sessions bileşik FK'si (A-84 kapanışı; A-85 CHECK'i aynen kalır);
-- documents.kind / number_sequences.document_kind beyaz listesine COUNT_ADJUSTMENT + sistem fiş tipi v1 satırı (A-90 deseni);
-- tenant_settings.count_abandon_hours (A-136, varsayılan 8). Komutlar (T-304, T-309, T-310) ve terk edilmiş sayım alarm işi kapsam dışıdır.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Yeni tenant tabloları 0010-0016 desenindedir: tenant_id NOT NULL, ENABLE + FORCE RLS, tek PERMISSIVE USING + WITH CHECK tenant
--   politikası, UNIQUE (tenant_id, id), FK'lerin hepsi (tenant_id, …) BİLEŞİK ve NO ACTION, açık sütun bazlı GRANT'lar, PUBLIC'e
--   hiçbir şey. wms_app: SELECT + sütun düzeyi INSERT/UPDATE; DELETE YOK (A-86). wms_ops bu tablolarda yetkisizdir (A-94).
-- * Sunucu sütunları (status/version varsayılanı, completed_at, approved_at, resolved_at, counted_at) INSERT/UPDATE listesinde YOKTUR;
--   tetikleyici yazar. Kimlik/anahtar sütunları UPDATE listesinde de yoktur ve ayrıca tetikleyiciyle (tablo sahibi dahil) değişmez.
-- * Durum makineleri tetikleyicidedir (23514): görev DONE/CANCELLED, oturum POSTED/CANCELLED, uyarı RESOLVED terminaldir (değişiklik
--   reddedilir; değişmeyen UPDATE geçer). Oturum durumu sıkı sırayla ilerler (COUNTING→SUBMITTED→APPROVED→POSTED, atlama/geri yok; yalnız APPROVED→POSTED: onay atlatılamaz); CANCELLED POSTED dışındaki her durumdan.
-- * stock_alerts yazımı: DB'de wms_app'in web yolu ile worker yolu ayrımı YAPILMAZ (aynı rol; ADR-019 rol tablosu); ayrım sütun
--   yetkisiyle (yalnızca uyarı alanları) ve kod katmanıyla sağlanır. 0014 deseni (app.system_reason yazma politikası) AC-04 INSERT/UPDATE
--   taramasını (SYSTEM_REASON_WRITE tablosu kartta yok) kıracağından bu tabloda KULLANILMADI; Bulgular'a yazıldı. DELETE yok.
-- * location_count_locks FK'si NOT VALID eklenip VALIDATE edilir: Faz 2'de sayım komutu yoktur, COUNTING satırı beklenmez; varsa
--   ön denetim açık hata ile migration'ı durdurur (yetim uuid sessizce kalmaz).
-- * count_session_lines.warehouse_id denormalizedir: (tenant_id, session_id, warehouse_id) ve (tenant_id, warehouse_id, location_id)
--   bileşik FK'leri satırın oturumla ve lokasyonla AYNI depoda olmasını DB'de zorlar. stock_dimension_id NULL = sistemde olmayan sayılan
--   ürün (reference_quantity 0 olmak zorunda); boyut doluysa (tenant_id, stock_dimension_id, item_id) FK'si ürünü boyuta kilitler.
--   Boyutun lokasyonunun satırdaki lokasyonla eşitliği DB'de zorlanmaz (stock_dimensions'ta bu üçlü için UNIQUE yok) — komut (T-309).
-- * warehouse_tasks.source_kind/source_id/source_line_id POLİMORFİK bağlantıdır (0016 A-152 deseni): DB yalnızca çift tutarlılığını
--   ve kind beyaz listesini zorlar; kaynağın varlığı saha komutunun sorumluluğudur. group_id yalnızca gruplama kimliğidir (tablo yok).
-- * COUNT_ADJUSTMENT: documents.kind CHECK'i NOT VALID + VALIDATE ile yenilenir. Belge numara öneki DB'de değildir (A-139: kod katmanı,
--   T-309). document_type_versions sistem satırı 0012 gibi NO FORCE → INSERT → FORCE (tek transaction).
-- * Miktarlar numeric(20,6); float yok (I-09).
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.warehouses') IS NULL
     OR pg_catalog.to_regclass('public.locations') IS NULL
     OR pg_catalog.to_regclass('public.location_count_locks') IS NULL
     OR pg_catalog.to_regclass('public.items') IS NULL
     OR pg_catalog.to_regclass('public.tenant_memberships') IS NULL
     OR pg_catalog.to_regclass('public.stock_dimensions') IS NULL
     OR pg_catalog.to_regclass('public.documents') IS NULL
     OR pg_catalog.to_regclass('public.number_sequences') IS NULL
     OR pg_catalog.to_regclass('public.document_type_versions') IS NULL
     OR pg_catalog.to_regclass('public.tenant_settings') IS NULL
     OR pg_catalog.to_regprocedure('public.field_docs_bump_version()') IS NULL
     OR pg_catalog.to_regprocedure('public.field_docs_guard_keys()') IS NULL THEN
    RAISE EXCEPTION '0017_tasks_counts_alerts: 0003 / 0010 / 0011 / 0012 / 0013 / 0016 önkoşulu yok';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0017_tasks_counts_alerts: wms_app rolü yok (altyapı adımı)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 1. Yeni tablolar
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.warehouse_tasks (
  tenant_id               uuid           NOT NULL,
  id                      uuid           NOT NULL DEFAULT gen_random_uuid(),
  warehouse_id            uuid           NOT NULL,
  kind                    text           NOT NULL,
  status                  text           NOT NULL DEFAULT 'OPEN',
  assigned_membership_id  uuid,
  group_id                uuid,
  source_kind             text,
  source_id               uuid,
  source_line_id          uuid,
  location_id             uuid,
  item_id                 uuid,
  quantity                numeric(20, 6),
  version                 integer        NOT NULL DEFAULT 1,
  completed_at            timestamptz,
  created_at              timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_tasks_pkey PRIMARY KEY (id),
  CONSTRAINT warehouse_tasks_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT warehouse_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT warehouse_tasks_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id) REFERENCES public.warehouses (tenant_id, id),
  CONSTRAINT warehouse_tasks_assignee_fkey FOREIGN KEY (tenant_id, assigned_membership_id) REFERENCES public.tenant_memberships (tenant_id, id),
  -- Lokasyon görevin deposunda olmak zorundadır (locations UNIQUE (tenant_id, warehouse_id, id)); location_id NULL ise denetlenmez.
  CONSTRAINT warehouse_tasks_location_fkey FOREIGN KEY (tenant_id, warehouse_id, location_id) REFERENCES public.locations (tenant_id, warehouse_id, id),
  CONSTRAINT warehouse_tasks_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT warehouse_tasks_kind_chk CHECK (kind IN ('PUTAWAY', 'PICK', 'REPUTAWAY', 'COUNT')),
  CONSTRAINT warehouse_tasks_status_chk CHECK (status IN ('OPEN', 'ASSIGNED', 'DONE', 'CANCELLED')),
  CONSTRAINT warehouse_tasks_assigned_chk CHECK (status <> 'ASSIGNED' OR assigned_membership_id IS NOT NULL),
  CONSTRAINT warehouse_tasks_completed_chk CHECK ((status = 'DONE') = (completed_at IS NOT NULL)),
  CONSTRAINT warehouse_tasks_source_kind_chk CHECK (source_kind IS NULL OR source_kind IN ('INBOUND_RECEIPT', 'SALES_ORDER', 'CUSTOMER_RETURN', 'COUNT_SESSION')),
  CONSTRAINT warehouse_tasks_source_pair_chk CHECK ((source_kind IS NULL) = (source_id IS NULL)),
  CONSTRAINT warehouse_tasks_source_line_chk CHECK (source_line_id IS NULL OR source_id IS NOT NULL),
  CONSTRAINT warehouse_tasks_quantity_chk CHECK (quantity IS NULL OR (quantity > 0 AND item_id IS NOT NULL)),
  CONSTRAINT warehouse_tasks_version_chk CHECK (version >= 1)
);
CREATE INDEX warehouse_tasks_tenant_warehouse_status_idx ON public.warehouse_tasks (tenant_id, warehouse_id, status);
CREATE INDEX warehouse_tasks_tenant_assignee_idx ON public.warehouse_tasks (tenant_id, assigned_membership_id) WHERE assigned_membership_id IS NOT NULL;
CREATE INDEX warehouse_tasks_tenant_source_idx ON public.warehouse_tasks (tenant_id, source_kind, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX warehouse_tasks_tenant_group_idx ON public.warehouse_tasks (tenant_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX warehouse_tasks_tenant_location_idx ON public.warehouse_tasks (tenant_id, location_id) WHERE location_id IS NOT NULL;
CREATE INDEX warehouse_tasks_tenant_item_idx ON public.warehouse_tasks (tenant_id, item_id) WHERE item_id IS NOT NULL;

CREATE TABLE public.count_sessions (
  tenant_id      uuid        NOT NULL,
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  warehouse_id   uuid        NOT NULL,
  status         text        NOT NULL DEFAULT 'COUNTING',
  blind          boolean     NOT NULL DEFAULT false,
  started_by     uuid        NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid,
  approved_at    timestamptz,
  cancel_reason  text,
  CONSTRAINT count_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT count_sessions_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Satırların oturumla aynı depoda olmasını zorlayan bileşik FK hedefi.
  CONSTRAINT count_sessions_tenant_id_id_warehouse_key UNIQUE (tenant_id, id, warehouse_id),
  CONSTRAINT count_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT count_sessions_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id) REFERENCES public.warehouses (tenant_id, id),
  -- Aktörler üyelik kimliğidir (location_count_locks.locked_by emsali); üyelik silinmez (durum ile pasifleşir).
  CONSTRAINT count_sessions_started_by_fkey FOREIGN KEY (tenant_id, started_by) REFERENCES public.tenant_memberships (tenant_id, id),
  CONSTRAINT count_sessions_approved_by_fkey FOREIGN KEY (tenant_id, approved_by) REFERENCES public.tenant_memberships (tenant_id, id),
  CONSTRAINT count_sessions_status_chk CHECK (status IN ('COUNTING', 'SUBMITTED', 'APPROVED', 'POSTED', 'CANCELLED')),
  CONSTRAINT count_sessions_approval_chk CHECK (
    CASE WHEN status IN ('APPROVED', 'POSTED') THEN approved_by IS NOT NULL AND approved_at IS NOT NULL
         WHEN status IN ('COUNTING', 'SUBMITTED') THEN approved_by IS NULL AND approved_at IS NULL
         ELSE (approved_by IS NULL) = (approved_at IS NULL) END
  ),
  CONSTRAINT count_sessions_cancel_reason_chk CHECK (
    (status = 'CANCELLED') = (cancel_reason IS NOT NULL) AND (cancel_reason IS NULL OR (btrim(cancel_reason) <> '' AND char_length(cancel_reason) <= 500))
  )
);
CREATE INDEX count_sessions_tenant_warehouse_status_idx ON public.count_sessions (tenant_id, warehouse_id, status);

CREATE TABLE public.count_session_lines (
  tenant_id           uuid           NOT NULL,
  id                  uuid           NOT NULL DEFAULT gen_random_uuid(),
  session_id          uuid           NOT NULL,
  warehouse_id        uuid           NOT NULL,
  location_id         uuid           NOT NULL,
  stock_dimension_id  uuid,
  item_id             uuid           NOT NULL,
  reference_quantity  numeric(20, 6) NOT NULL,
  counted_quantity    numeric(20, 6),
  counted_by          uuid,
  counted_at          timestamptz,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT count_session_lines_pkey PRIMARY KEY (id),
  CONSTRAINT count_session_lines_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT count_session_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT count_session_lines_session_fkey FOREIGN KEY (tenant_id, session_id, warehouse_id) REFERENCES public.count_sessions (tenant_id, id, warehouse_id),
  CONSTRAINT count_session_lines_location_fkey FOREIGN KEY (tenant_id, warehouse_id, location_id) REFERENCES public.locations (tenant_id, warehouse_id, id),
  CONSTRAINT count_session_lines_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT count_session_lines_dimension_fkey FOREIGN KEY (tenant_id, stock_dimension_id, item_id) REFERENCES public.stock_dimensions (tenant_id, id, item_id),
  CONSTRAINT count_session_lines_counted_by_fkey FOREIGN KEY (tenant_id, counted_by) REFERENCES public.tenant_memberships (tenant_id, id),
  CONSTRAINT count_session_lines_reference_chk CHECK (reference_quantity >= 0 AND (stock_dimension_id IS NOT NULL OR reference_quantity = 0)),
  CONSTRAINT count_session_lines_counted_chk CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  CONSTRAINT count_session_lines_counted_by_chk CHECK ((counted_quantity IS NULL) = (counted_by IS NULL) AND (counted_by IS NULL) = (counted_at IS NULL))
);
-- Oturumda bir boyut tek satırdır; boyutsuz (sistemde olmayan) satır lokasyon × ürün başına tektir (lot/seri A-155: v1'de kaydedilmez).
CREATE UNIQUE INDEX count_session_lines_session_dimension_key ON public.count_session_lines (tenant_id, session_id, stock_dimension_id) WHERE stock_dimension_id IS NOT NULL;
CREATE UNIQUE INDEX count_session_lines_session_unknown_key ON public.count_session_lines (tenant_id, session_id, location_id, item_id) WHERE stock_dimension_id IS NULL;
CREATE INDEX count_session_lines_tenant_location_idx ON public.count_session_lines (tenant_id, location_id);
CREATE INDEX count_session_lines_tenant_item_idx ON public.count_session_lines (tenant_id, item_id);
CREATE INDEX count_session_lines_tenant_dimension_idx ON public.count_session_lines (tenant_id, stock_dimension_id) WHERE stock_dimension_id IS NOT NULL;

CREATE TABLE public.item_stock_policies (
  tenant_id     uuid           NOT NULL,
  id            uuid           NOT NULL DEFAULT gen_random_uuid(),
  warehouse_id  uuid           NOT NULL,
  item_id       uuid           NOT NULL,
  min_quantity  numeric(20, 6) NOT NULL,
  max_quantity  numeric(20, 6) NOT NULL,
  version       integer        NOT NULL DEFAULT 1,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT item_stock_policies_pkey PRIMARY KEY (id),
  CONSTRAINT item_stock_policies_tenant_id_id_key UNIQUE (tenant_id, id),
  -- A-131: min-maks depo × ürün kapsamlıdır.
  CONSTRAINT item_stock_policies_tenant_warehouse_item_key UNIQUE (tenant_id, warehouse_id, item_id),
  CONSTRAINT item_stock_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT item_stock_policies_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id) REFERENCES public.warehouses (tenant_id, id),
  CONSTRAINT item_stock_policies_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT item_stock_policies_range_chk CHECK (min_quantity >= 0 AND min_quantity <= max_quantity),
  CONSTRAINT item_stock_policies_version_chk CHECK (version >= 1)
);
CREATE INDEX item_stock_policies_tenant_item_idx ON public.item_stock_policies (tenant_id, item_id);

CREATE TABLE public.stock_alerts (
  tenant_id          uuid           NOT NULL,
  id                 uuid           NOT NULL DEFAULT gen_random_uuid(),
  kind               text           NOT NULL,
  warehouse_id       uuid           NOT NULL,
  item_id            uuid           NOT NULL,
  status             text           NOT NULL DEFAULT 'OPEN',
  observed_quantity  numeric(20, 6) NOT NULL,
  threshold          numeric(20, 6) NOT NULL,
  opened_at          timestamptz    NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  CONSTRAINT stock_alerts_pkey PRIMARY KEY (id),
  CONSTRAINT stock_alerts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_alerts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT stock_alerts_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id) REFERENCES public.warehouses (tenant_id, id),
  CONSTRAINT stock_alerts_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT stock_alerts_kind_chk CHECK (kind IN ('MIN_MAX')),
  CONSTRAINT stock_alerts_status_chk CHECK (status IN ('OPEN', 'RESOLVED')),
  CONSTRAINT stock_alerts_resolved_chk CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CONSTRAINT stock_alerts_quantities_chk CHECK (observed_quantity >= 0 AND threshold >= 0)
);
-- Aynı depo × ürün (ve uyarı türü) için tek OPEN uyarı.
CREATE UNIQUE INDEX stock_alerts_open_key ON public.stock_alerts (tenant_id, kind, warehouse_id, item_id) WHERE status = 'OPEN';
CREATE INDEX stock_alerts_tenant_warehouse_idx ON public.stock_alerts (tenant_id, warehouse_id);
CREATE INDEX stock_alerts_tenant_item_idx ON public.stock_alerts (tenant_id, item_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Tetikleyiciler (SECURITY INVOKER, search_path sabit, PUBLIC'ten EXECUTE geri alınır)
-- ---------------------------------------------------------------------------------------------
-- 2a. Görev durum makinesi: DONE/CANCELLED terminal (değişmeyen UPDATE geçer); completed_at sunucu değeri (DONE'a geçişte now()).
CREATE FUNCTION public.warehouse_tasks_guard_state() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.status IN ('DONE', 'CANCELLED') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.assigned_membership_id IS DISTINCT FROM OLD.assigned_membership_id
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.location_id IS DISTINCT FROM OLD.location_id THEN
      RAISE EXCEPTION 'warehouse_tasks: sonlanmış görev (%) değiştirilemez', OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'DONE' THEN
    NEW.completed_at := pg_catalog.now();
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.warehouse_tasks_guard_state() FROM PUBLIC;

-- 2b. Sayım oturumu: durum makinesi sıkıdır (atlama/geri yok); POSTED/CANCELLED terminal; approved_at sunucu değeri (APPROVED'a geçişte now()).
CREATE FUNCTION public.count_sessions_guard_state() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.status IN ('POSTED', 'CANCELLED') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
      RAISE EXCEPTION 'count_sessions: sonlanmış oturum (%) değiştirilemez', OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Atlama yok: COUNTING -> SUBMITTED -> APPROVED -> POSTED; CANCELLED her açık durumdan (POSTED terminaldir, yukarıda).
  IF NEW.status <> OLD.status AND NOT (
       NEW.status = 'CANCELLED'
       OR (OLD.status = 'COUNTING' AND NEW.status = 'SUBMITTED')
       OR (OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED')
       OR (OLD.status = 'APPROVED' AND NEW.status = 'POSTED')) THEN
    RAISE EXCEPTION 'count_sessions: geçersiz durum geçişi (% -> %)', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' THEN
    NEW.approved_at := pg_catalog.now();
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    NEW.approved_at := CASE WHEN NEW.approved_by IS NULL THEN NULL ELSE pg_catalog.now() END;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.count_sessions_guard_state() FROM PUBLIC;

-- 2c. Sayım satırı: counted_at sunucu değeri (sayım değeri/sayan değişince now(); değişmeyen UPDATE dokunmaz).
CREATE FUNCTION public.count_session_lines_guard_state() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.counted_quantity IS DISTINCT FROM OLD.counted_quantity OR NEW.counted_by IS DISTINCT FROM OLD.counted_by THEN
    NEW.counted_at := CASE WHEN NEW.counted_quantity IS NULL THEN NULL ELSE pg_catalog.now() END;
  ELSE
    NEW.counted_at := OLD.counted_at;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.count_session_lines_guard_state() FROM PUBLIC;

-- 2c'. Onaylanmış veya kapanmış (APPROVED/POSTED/CANCELLED) oturumun satırı eklenemez/değişmez (0016 field_docs_lines_guard_closed deseni): üst oturum FOR SHARE
--      ile okunur (oturumu kapatan işlem commit olmadan eşzamanlı satır yazımı bloklanır). Değişmeyen UPDATE geçer (no-op). Görev
--      tablosu başlıksız tek satırdır; kapanmış görev değişmezliği 2a'daki terminal kuralındadır. SUBMITTED satırı onaya kadar
--      yazılabilir; APPROVED'dan sonra satır donar (onaylanan fark, onay sonrası sayımla değiştirilemez).
CREATE FUNCTION public.count_session_lines_guard_closed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  SELECT h.status INTO parent_status FROM public.count_sessions h WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.session_id FOR SHARE;
  IF parent_status IN ('APPROVED', 'POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'SESSION_CLOSED: onaylanmış/kapanmış sayım oturumunun satırı eklenemez/değiştirilemez (oturum %)', parent_status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.count_session_lines_guard_closed() FROM PUBLIC;
-- Alfabetik sıra: guard_closed, guard_keys ve guard_state'ten ÖNCE çalışır; her ret 23514.
CREATE TRIGGER count_session_lines_guard_closed BEFORE INSERT OR UPDATE ON public.count_session_lines
  FOR EACH ROW EXECUTE FUNCTION public.count_session_lines_guard_closed();

-- 2d. Uyarı: RESOLVED terminal; resolved_at sunucu değeri (RESOLVED'a geçişte now()).
CREATE FUNCTION public.stock_alerts_guard_state() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.status = 'RESOLVED' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.observed_quantity IS DISTINCT FROM OLD.observed_quantity
       OR NEW.threshold IS DISTINCT FROM OLD.threshold THEN
      RAISE EXCEPTION 'stock_alerts: kapanmış uyarı değiştirilemez' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'RESOLVED' THEN
    NEW.resolved_at := pg_catalog.now();
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_alerts_guard_state() FROM PUBLIC;

-- 2e. Sürüm artışı (0016 işlevi) + anahtar sütun değişmezliği (0016 işlevi; tablo sahibi dahil).
CREATE TRIGGER warehouse_tasks_bump_version BEFORE UPDATE ON public.warehouse_tasks
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_bump_version();
CREATE TRIGGER item_stock_policies_bump_version BEFORE UPDATE ON public.item_stock_policies
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_bump_version();

CREATE TRIGGER warehouse_tasks_guard_keys BEFORE UPDATE ON public.warehouse_tasks
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'warehouse_id', 'kind', 'source_kind', 'source_id', 'source_line_id', 'item_id', 'quantity', 'created_at');
CREATE TRIGGER count_sessions_guard_keys BEFORE UPDATE ON public.count_sessions
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'warehouse_id', 'blind', 'started_by', 'started_at');
CREATE TRIGGER count_session_lines_guard_keys BEFORE UPDATE ON public.count_session_lines
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'session_id', 'warehouse_id', 'location_id', 'stock_dimension_id', 'item_id', 'reference_quantity', 'created_at');
CREATE TRIGGER item_stock_policies_guard_keys BEFORE UPDATE ON public.item_stock_policies
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'warehouse_id', 'item_id', 'created_at');
CREATE TRIGGER stock_alerts_guard_keys BEFORE UPDATE ON public.stock_alerts
  FOR EACH ROW EXECUTE FUNCTION public.field_docs_guard_keys('tenant_id', 'id', 'kind', 'warehouse_id', 'item_id', 'opened_at');

CREATE TRIGGER warehouse_tasks_guard_state BEFORE UPDATE ON public.warehouse_tasks
  FOR EACH ROW EXECUTE FUNCTION public.warehouse_tasks_guard_state();
CREATE TRIGGER count_sessions_guard_state BEFORE UPDATE ON public.count_sessions
  FOR EACH ROW EXECUTE FUNCTION public.count_sessions_guard_state();
CREATE TRIGGER count_session_lines_guard_state BEFORE UPDATE ON public.count_session_lines
  FOR EACH ROW EXECUTE FUNCTION public.count_session_lines_guard_state();
CREATE TRIGGER stock_alerts_guard_state BEFORE UPDATE ON public.stock_alerts
  FOR EACH ROW EXECUTE FUNCTION public.stock_alerts_guard_state();

-- ---------------------------------------------------------------------------------------------
-- 3. Genişletmeler (mevcut tablolar)
-- ---------------------------------------------------------------------------------------------
-- 3a. Kilit satırı → sayım oturumu (A-84 kapanışı). A-85 location_count_locks_state_chk (COUNTING ⇒ count_session_id dolu) aynen kalır.
-- Sayım RLS'ten bağımsız olmalı (0003 down BLOKER-1): sayımdan önce NO FORCE, sonra FORCE geri açılır (tek transaction).
ALTER TABLE public.location_count_locks NO FORCE ROW LEVEL SECURITY;
DO $orphan$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.location_count_locks WHERE count_session_id IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0017_tasks_counts_alerts: % kilit satırı count_session_id taşıyor ama count_sessions tablosu yeni; yetim uuid FK''ye çevrilemez (Faz 2''de beklenmez)', n;
  END IF;
END
$orphan$;
ALTER TABLE public.location_count_locks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.location_count_locks
  ADD CONSTRAINT location_count_locks_session_fkey FOREIGN KEY (tenant_id, count_session_id) REFERENCES public.count_sessions (tenant_id, id) NOT VALID;
ALTER TABLE public.location_count_locks VALIDATE CONSTRAINT location_count_locks_session_fkey;
CREATE INDEX location_count_locks_tenant_session_idx ON public.location_count_locks (tenant_id, count_session_id) WHERE count_session_id IS NOT NULL;

-- 3b. COUNT_ADJUSTMENT belge türü (ADR-021 §3). CHECK'ler NOT VALID eklenip doğrulanır (uzun kilit yok).
ALTER TABLE public.documents DROP CONSTRAINT documents_kind_chk;
ALTER TABLE public.documents
  ADD CONSTRAINT documents_kind_chk CHECK (kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL', 'COUNT_ADJUSTMENT')) NOT VALID;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_kind_chk;
ALTER TABLE public.number_sequences DROP CONSTRAINT number_sequences_kind_chk;
ALTER TABLE public.number_sequences
  ADD CONSTRAINT number_sequences_kind_chk CHECK (document_kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL', 'COUNT_ADJUSTMENT')) NOT VALID;
ALTER TABLE public.number_sequences VALIDATE CONSTRAINT number_sequences_kind_chk;

ALTER TABLE public.document_type_versions NO FORCE ROW LEVEL SECURITY;
INSERT INTO public.document_type_versions (tenant_id, key, version, definition) VALUES
  (NULL, 'COUNT_ADJUSTMENT', 1, '{"schemaVersion": 1, "kind": "COUNT_ADJUSTMENT"}'::jsonb);
ALTER TABLE public.document_type_versions FORCE ROW LEVEL SECURITY;

-- 3c. Terk edilmiş sayım süresi (A-136: saat; tenant ayarı, varsayılan 8). Üst sınır 168 (bir hafta; A-156).
ALTER TABLE public.tenant_settings
  ADD COLUMN count_abandon_hours smallint NOT NULL DEFAULT 8,
  ADD CONSTRAINT tenant_settings_count_abandon_hours_chk CHECK (count_abandon_hours BETWEEN 1 AND 168);

-- ---------------------------------------------------------------------------------------------
-- 4. RLS (ADR-015 §5)
-- ---------------------------------------------------------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouse_tasks', 'count_sessions', 'count_session_lines', 'item_stock_policies', 'stock_alerts'] LOOP
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
-- status/version/completed_at INSERT listesinde YOK (varsayılan + tetikleyici); atama ve durum geçişi UPDATE.
GRANT SELECT ON public.warehouse_tasks TO wms_app;
GRANT INSERT (tenant_id, id, warehouse_id, kind, group_id, source_kind, source_id, source_line_id, location_id, item_id, quantity) ON public.warehouse_tasks TO wms_app;
GRANT UPDATE (status, assigned_membership_id, group_id, location_id) ON public.warehouse_tasks TO wms_app;

-- status/approved_at/started_at INSERT listesinde YOK (oturum COUNTING doğar; onay zamanı tetikleyici yazar).
GRANT SELECT ON public.count_sessions TO wms_app;
GRANT INSERT (tenant_id, id, warehouse_id, blind, started_by) ON public.count_sessions TO wms_app;
GRANT UPDATE (status, approved_by, cancel_reason) ON public.count_sessions TO wms_app;

-- Sayılan değer boş doğar (INSERT listesinde yok); referans bakiye INSERT'te sabitlenir ve sonra değişmez (UPDATE listesinde yok).
GRANT SELECT ON public.count_session_lines TO wms_app;
GRANT INSERT (tenant_id, id, session_id, warehouse_id, location_id, stock_dimension_id, item_id, reference_quantity) ON public.count_session_lines TO wms_app;
GRANT UPDATE (counted_quantity, counted_by) ON public.count_session_lines TO wms_app;

GRANT SELECT ON public.item_stock_policies TO wms_app;
GRANT INSERT (tenant_id, id, warehouse_id, item_id, min_quantity, max_quantity) ON public.item_stock_policies TO wms_app;
GRANT UPDATE (min_quantity, max_quantity) ON public.item_stock_policies TO wms_app;

-- Uyarı yazımı yalnızca wms_app (worker yolu `withSystemTenant`); status/opened_at/resolved_at INSERT'te yok.
GRANT SELECT ON public.stock_alerts TO wms_app;
GRANT INSERT (tenant_id, id, kind, warehouse_id, item_id, observed_quantity, threshold) ON public.stock_alerts TO wms_app;
GRANT UPDATE (status, observed_quantity, threshold) ON public.stock_alerts TO wms_app;

GRANT UPDATE (count_abandon_hours) ON public.tenant_settings TO wms_app;
