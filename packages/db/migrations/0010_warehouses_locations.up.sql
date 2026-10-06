-- 0010_warehouses_locations (T-202, ADR-015 §5 şablonu, ADR-017 §2, 06 §Sayım kilidi yaşam döngüsü, A-77):
-- warehouses, locations (dinamik derinlikli ağaç), location_count_locks, membership_warehouse_scopes.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Tüm tablolar: tenant_id NOT NULL, ENABLE + FORCE RLS, tek USING + WITH CHECK tenant politikası (TO'suz: yetkisi olan
--   her role uygulanır), FK'ler NO ACTION (CASCADE zinciri yok), açık sütun bazlı GRANT'lar, PUBLIC'e hiçbir şey.
-- * Bileşik FK hedefleri UNIQUE (tenant_id, id) (ADR-017 §2); locations ayrıca UNIQUE (tenant_id, warehouse_id, id) taşır
--   (ağaçta ebeveynin aynı depoda olmasını FK zorlar). location_count_locks / membership_warehouse_scopes'te `id` yoktur
--   (PK location_id / bileşik PK; tenant_settings emsali).
-- * DELETE her uygulama rolünde reddedilir: wms_app/wms_auth/wms_ops'a DELETE YETKİSİ VERİLMEZ (42501) ve silme politikası
--   yoktur; lokasyon/depo arşivlenir (05 §Geri alma). Tetikleyici ile "her role" ret KONMADI: tablo sahibi (migration
--   rolü) fikstür/migration temizliği için siler (audit_logs'taki gibi bilinen sınır). Tek istisna membership_warehouse_scopes:
--   kapsam kaldırma gerçek silmedir, wms_app DELETE alır (RLS altında).
-- * wms_ops: bu tablolarda HİÇBİR yetkisi yoktur (0009 deseni: yalnızca yazma yolu olan mevcut tablolar; stok/depo yapısı
--   düzeltmesi domain komutlarıyla, G-01). Yetki gerekirse ayrı kart/migration.
-- * Ağaç: parent_id/warehouse_id/tenant_id/id/depth UPDATE'i tetikleyiciyle reddedilir (ebeveyn önceden var olmak zorunda
--   → döngü oluşamaz; taşıma Faz 2 dışı). depth, INSERT tetikleyicisiyle ebeveyn.depth + 1 (kök 0) olmaya zorlanır.
-- * location_count_locks satırı AFTER INSERT tetikleyicisiyle (SECURITY INVOKER) aynı transaction'da IDLE doğar; wms_app'in
--   INSERT yetkisi yalnızca (tenant_id, location_id) sütunlarındadır (durum alanları IDLE varsayılanı). Mevcut lokasyon yok
--   (tablo bu migration'da yaratılır), geri doldurma gerekmez.
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.tenants') IS NULL OR pg_catalog.to_regclass('public.tenant_memberships') IS NULL THEN
    RAISE EXCEPTION '0010_warehouses_locations: 0003_tenancy önkoşulu yok';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0010_warehouses_locations: wms_app rolü yok (altyapı adımı)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tablolar
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.warehouses (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  code         text        NOT NULL,
  name         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT warehouses_pkey PRIMARY KEY (id),
  CONSTRAINT warehouses_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT warehouses_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT warehouses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT warehouses_status_chk CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT warehouses_code_chk CHECK (btrim(code) <> '' AND btrim(name) <> ''),
  CONSTRAINT warehouses_archived_chk CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);

CREATE TABLE public.locations (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  warehouse_id uuid        NOT NULL,
  parent_id    uuid,
  code         text        NOT NULL,
  name         text        NOT NULL,
  depth        smallint    NOT NULL DEFAULT 0,
  kind         text        NOT NULL,
  pick_blocked boolean     NOT NULL DEFAULT false,
  status       text        NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT locations_pkey PRIMARY KEY (id),
  CONSTRAINT locations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT locations_tenant_warehouse_id_key UNIQUE (tenant_id, warehouse_id, id),
  CONSTRAINT locations_tenant_warehouse_code_key UNIQUE (tenant_id, warehouse_id, code),
  CONSTRAINT locations_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id) REFERENCES public.warehouses (tenant_id, id),
  CONSTRAINT locations_parent_fkey FOREIGN KEY (tenant_id, warehouse_id, parent_id)
    REFERENCES public.locations (tenant_id, warehouse_id, id),
  CONSTRAINT locations_parent_not_self_chk CHECK (parent_id <> id),
  CONSTRAINT locations_kind_chk CHECK (kind IN ('RECEIVING', 'STORAGE', 'STAGING', 'TRANSIT')),
  CONSTRAINT locations_status_chk CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT locations_depth_chk CHECK (depth >= 0 AND ((parent_id IS NULL) = (depth = 0))),
  CONSTRAINT locations_code_chk CHECK (btrim(code) <> '' AND btrim(name) <> ''),
  CONSTRAINT locations_archived_chk CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX locations_tenant_warehouse_parent_idx ON public.locations (tenant_id, warehouse_id, parent_id);

CREATE TABLE public.location_count_locks (
  tenant_id        uuid        NOT NULL,
  location_id      uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'IDLE',
  count_session_id uuid,
  locked_at        timestamptz,
  locked_by        uuid,
  CONSTRAINT location_count_locks_pkey PRIMARY KEY (location_id),
  CONSTRAINT location_count_locks_location_fkey FOREIGN KEY (tenant_id, location_id)
    REFERENCES public.locations (tenant_id, id),
  CONSTRAINT location_count_locks_locked_by_fkey FOREIGN KEY (tenant_id, locked_by)
    REFERENCES public.tenant_memberships (tenant_id, id),
  CONSTRAINT location_count_locks_status_chk CHECK (status IN ('IDLE', 'COUNTING')),
  CONSTRAINT location_count_locks_state_chk CHECK (
    (status = 'IDLE' AND count_session_id IS NULL AND locked_at IS NULL AND locked_by IS NULL)
    OR (status = 'COUNTING' AND count_session_id IS NOT NULL AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
  )
);
CREATE INDEX location_count_locks_tenant_status_idx ON public.location_count_locks (tenant_id, status);

CREATE TABLE public.membership_warehouse_scopes (
  tenant_id     uuid        NOT NULL,
  membership_id uuid        NOT NULL,
  warehouse_id  uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_warehouse_scopes_pkey PRIMARY KEY (tenant_id, membership_id, warehouse_id),
  CONSTRAINT membership_warehouse_scopes_membership_fkey FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.tenant_memberships (tenant_id, id),
  CONSTRAINT membership_warehouse_scopes_warehouse_fkey FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES public.warehouses (tenant_id, id)
);
CREATE INDEX membership_warehouse_scopes_tenant_warehouse_idx
  ON public.membership_warehouse_scopes (tenant_id, warehouse_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Tetikleyiciler (hepsi SECURITY INVOKER, search_path sabit, PUBLIC'ten EXECUTE geri alınır)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.locations_check_depth() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  parent_depth smallint;
BEGIN
  -- BEFORE tetikleyici WITH CHECK'ten ÖNCE çalışır (T-235): bağlam tenant'ı doluyken satırın tenant'ı bağlamdan farklıysa
  -- ebeveyn/depo aramasına GİRİLMEZ ve ret üretilmez; reddi FORCE RLS WITH CHECK (42501, polroles={0}) verir. Böylece
  -- uyuşmazlık ebeveyn hatasına (23503/23514) dönüşemez ve ret kaynağı tek (politika) olur. Erken dönüş yeni yol açmaz:
  -- WITH CHECK her NOBYPASSRLS rol için (wms_app, wms_auth, wms_ops; sahip dahil, FORCE) satırı mutlaka reddeder.
  -- row_security_active('public.locations') (PG: boolean, STABLE; geçerli rol için RLS fiilen uygulanıyor mu — FORCE altında
  -- sahip için true, süper kullanıcı/BYPASSRLS için false): RLS'i aşan rolde politika koruma sağlamayacağından erken dönüş
  -- yapılmaz, derinlik/döngü/ebeveyn denetimleri tam çalışır (T-202 MAJOR-1 yolları açılmaz).
  -- Bağlam yoksa (boş/ayarsız) bu dal atlanır ve aşağıdaki denetimler aynen çalışır.
  IF NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '') IS NOT NULL
     AND NEW.tenant_id IS DISTINCT FROM NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid
     AND pg_catalog.row_security_active('public.locations') THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id IS NULL THEN
    IF NEW.depth <> 0 THEN
      RAISE EXCEPTION 'locations: kök lokasyonun depth değeri 0 olmalı' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'locations: lokasyon kendisinin ebeveyni olamaz' USING ERRCODE = '23514', CONSTRAINT = 'locations_parent_not_self_chk';
  END IF;
  SELECT p.depth INTO parent_depth FROM public.locations p
   WHERE p.tenant_id = NEW.tenant_id AND p.warehouse_id = NEW.warehouse_id AND p.id = NEW.parent_id;
  -- Fail-closed: ebeveyn verilmiş ama bu tenant/depoda görünmüyorsa (yok, başka depo/tenant, ya da AYNI ifadede sonradan
  -- eklenecek satır) reddedilir. NO ACTION FK ifade sonunda denetlendiğinden bu bekçi olmadan çocuk ebeveynden önce
  -- keyfi depth ile yazılabilir ve iki satır birbirine ebeveyn olarak döngü kurabilirdi. Çok satırlı INSERT'te kökler önce.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'locations: ebeveyn lokasyon bulunamadı (ebeveyn önceden var olmalı; çok satırlı INSERT''te kökler önce)'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.depth <> parent_depth + 1 THEN
    RAISE EXCEPTION 'locations: depth, ebeveyn depth + 1 olmalı' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.locations_check_depth() FROM PUBLIC;
CREATE TRIGGER locations_check_depth BEFORE INSERT ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.locations_check_depth();

CREATE FUNCTION public.locations_reject_tree_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.depth IS DISTINCT FROM OLD.depth THEN
    RAISE EXCEPTION 'locations: tenant_id, id, warehouse_id, parent_id ve depth değiştirilemez (ağaçta taşıma desteklenmez)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.locations_reject_tree_change() FROM PUBLIC;
CREATE TRIGGER locations_reject_tree_change BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.locations_reject_tree_change();

CREATE FUNCTION public.locations_create_count_lock() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.location_count_locks (tenant_id, location_id) VALUES (NEW.tenant_id, NEW.id);
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.locations_create_count_lock() FROM PUBLIC;
CREATE TRIGGER locations_create_count_lock AFTER INSERT ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.locations_create_count_lock();

-- ---------------------------------------------------------------------------------------------
-- 3. RLS (ADR-015 §5)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.warehouses                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.locations                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.location_count_locks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_count_locks        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.membership_warehouse_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_warehouse_scopes FORCE  ROW LEVEL SECURITY;

CREATE POLICY warehouses_isolation ON public.warehouses
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY locations_isolation ON public.locations
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY location_count_locks_isolation ON public.location_count_locks
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY membership_warehouse_scopes_isolation ON public.membership_warehouse_scopes
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------------------------
-- 4. GRANT'lar (yalnızca wms_app; wms_ops ve diğer roller için hiçbir şey)
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE public.warehouses, public.locations, public.location_count_locks,
                    public.membership_warehouse_scopes FROM PUBLIC;

GRANT SELECT ON public.warehouses TO wms_app;
GRANT INSERT (tenant_id, id, code, name) ON public.warehouses TO wms_app;
GRANT UPDATE (name, status, archived_at) ON public.warehouses TO wms_app;

GRANT SELECT ON public.locations TO wms_app;
GRANT INSERT (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) ON public.locations TO wms_app;
GRANT UPDATE (name, kind, pick_blocked, status, archived_at) ON public.locations TO wms_app;

GRANT SELECT ON public.location_count_locks TO wms_app;
GRANT INSERT (tenant_id, location_id) ON public.location_count_locks TO wms_app;
GRANT UPDATE (status, count_session_id, locked_at, locked_by) ON public.location_count_locks TO wms_app;

GRANT SELECT, DELETE ON public.membership_warehouse_scopes TO wms_app;
GRANT INSERT (tenant_id, membership_id, warehouse_id) ON public.membership_warehouse_scopes TO wms_app;
