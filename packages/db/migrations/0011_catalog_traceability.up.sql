-- 0011_catalog_traceability (T-204, ADR-015 §5 şablonu, ADR-017 §1-§2, 04 §Ürün, lot, seri, birim, ADR-011, A-69, A-72):
-- units, items, unit_conversions, item_barcodes, inventory_owners, lots, serials, handling_units.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Tüm tablolar: tenant_id NOT NULL, ENABLE + FORCE RLS, tek USING + WITH CHECK tenant politikası (TO'suz), FK'ler NO ACTION
--   ve hepsi (tenant_id, …) BİLEŞİK (RI denetimi RLS'i atlar: başka tenant'ın kaydına referans FK ile reddedilir),
--   açık sütun bazlı GRANT'lar, PUBLIC'e hiçbir şey. Her tabloda UNIQUE (tenant_id, id) (bileşik FK hedefi).
-- * Ürüne bağlı hedefler (ADR-017 §2, M-3): lots UNIQUE (tenant_id, item_id, id), serials UNIQUE (tenant_id, item_id, id);
--   seri → lot FK (tenant_id, item_id, lot_id): aynı tenant'ta BAŞKA ürünün lotu reddedilir. lot_id NULL ise FK atlanır (MATCH SIMPLE).
-- * NULL-safe tekillik: item_barcodes UNIQUE NULLS NOT DISTINCT (tenant_id, item_id, unit_id, barcode) (PG 15+; kurulu sürüm
--   ≥ 17). (tenant_id, barcode) üzerinde benzersiz OLMAYAN indeks: aynı barkod farklı ürüne/birime bağlanabilir, belirsizlik komutta çözülür (A-69).
-- * Seri tekilliği ürün içi (A-72): UNIQUE (tenant_id, item_id, serial_no).
-- * DELETE: wms_app/wms_auth/wms_ops'a DELETE YETKİSİ YOKTUR (42501); items/units/lots/serials/inventory_owners/handling_units
--   arşivlenir/durum değiştirir. Tek istisna item_barcodes (yanlış girilmiş takma ad gerçek silinir; durum sütunu yok,
--   başka tabloya FK ile referans edilmez). Tablo sahibi (migration rolü) fikstür temizliği için siler (0010'daki bilinen sınır).
-- * wms_ops: bu tablolarda HİÇBİR yetkisi yoktur (0009/0010 deseni).
-- * items.base_unit_id, tracking_mode, quantity_scale, handling_units.kind/code, lots/serials kimlik alanları wms_app için
--   değiştirilemez (UPDATE yetkisi yok): stok oluştuktan sonra anlam değiştirmek defter tutarlılığını bozar (değişim = ayrı komut/migration).
-- * unit_conversions: temel birim için satır yoktur (katsayı 1 örtük): tetikleyici unit_id = items.base_unit_id satırını reddeder.
--   Dönüşümde hiyerarşi yoktur (her birim doğrudan temel birime), dolayısıyla döngü oluşamaz; döngü reddi handling_units'tedir.
-- * handling_units.parent_id değişebilir (palete koli ekleme): BEFORE INSERT OR UPDATE OF parent_id tetikleyicisi ata zincirini
--   yukarı yürür, her halkayı FOR UPDATE kilitler ve satırın kendisine ulaşırsa 'HANDLING_UNIT_CYCLE' (SQLSTATE 23514) ile reddeder.
--   Eşzamanlı çapraz iç içe koymada kilit sırası çakışırsa PostgreSQL biri 40P01 ile iptal eder; ikisi birden commit edemez.
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.tenants') IS NULL OR pg_catalog.to_regclass('public.locations') IS NULL THEN
    RAISE EXCEPTION '0011_catalog_traceability: 0003_tenancy / 0010_warehouses_locations önkoşulu yok';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0011_catalog_traceability: wms_app rolü yok (altyapı adımı)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tablolar
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.units (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  code         text        NOT NULL,
  name         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT units_pkey PRIMARY KEY (id),
  CONSTRAINT units_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT units_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT units_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT units_status_chk CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT units_code_chk CHECK (btrim(code) <> '' AND btrim(name) <> ''),
  CONSTRAINT units_archived_chk CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);

CREATE TABLE public.items (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  code            text        NOT NULL,
  name            text        NOT NULL,
  base_unit_id    uuid        NOT NULL,
  tracking_mode   text        NOT NULL DEFAULT 'NONE',
  quantity_scale  smallint    NOT NULL DEFAULT 0,
  pick_policy     text        NOT NULL DEFAULT 'FIFO',
  status          text        NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT items_pkey PRIMARY KEY (id),
  CONSTRAINT items_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT items_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT items_base_unit_fkey FOREIGN KEY (tenant_id, base_unit_id) REFERENCES public.units (tenant_id, id),
  CONSTRAINT items_tracking_mode_chk CHECK (tracking_mode IN ('NONE', 'LOT', 'SERIAL', 'LOT_AND_SERIAL')),
  CONSTRAINT items_quantity_scale_chk CHECK (quantity_scale BETWEEN 0 AND 6),
  CONSTRAINT items_pick_policy_chk CHECK (pick_policy IN ('FIFO', 'FEFO')),
  CONSTRAINT items_status_chk CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT items_code_chk CHECK (btrim(code) <> '' AND btrim(name) <> ''),
  CONSTRAINT items_archived_chk CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX items_tenant_base_unit_idx ON public.items (tenant_id, base_unit_id);

CREATE TABLE public.unit_conversions (
  tenant_id      uuid           NOT NULL,
  id             uuid           NOT NULL DEFAULT gen_random_uuid(),
  item_id        uuid           NOT NULL,
  unit_id        uuid           NOT NULL,
  to_base_factor numeric(20, 6) NOT NULL,
  created_at     timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT unit_conversions_pkey PRIMARY KEY (id),
  CONSTRAINT unit_conversions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT unit_conversions_tenant_item_unit_key UNIQUE (tenant_id, item_id, unit_id),
  CONSTRAINT unit_conversions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT unit_conversions_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT unit_conversions_unit_fkey FOREIGN KEY (tenant_id, unit_id) REFERENCES public.units (tenant_id, id),
  CONSTRAINT unit_conversions_factor_chk CHECK (to_base_factor > 0)
);
CREATE INDEX unit_conversions_tenant_unit_idx ON public.unit_conversions (tenant_id, unit_id);

CREATE TABLE public.item_barcodes (
  tenant_id   uuid           NOT NULL,
  id          uuid           NOT NULL DEFAULT gen_random_uuid(),
  item_id     uuid           NOT NULL,
  unit_id     uuid,
  barcode     text           NOT NULL,
  quantity    numeric(20, 6),
  created_at  timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT item_barcodes_pkey PRIMARY KEY (id),
  CONSTRAINT item_barcodes_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT item_barcodes_tenant_item_unit_barcode_key UNIQUE NULLS NOT DISTINCT (tenant_id, item_id, unit_id, barcode),
  CONSTRAINT item_barcodes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT item_barcodes_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT item_barcodes_unit_fkey FOREIGN KEY (tenant_id, unit_id) REFERENCES public.units (tenant_id, id),
  CONSTRAINT item_barcodes_barcode_chk CHECK (btrim(barcode) <> ''),
  CONSTRAINT item_barcodes_quantity_chk CHECK (quantity IS NULL OR quantity > 0)
);
-- A-69: BENZERSİZ DEĞİL (aynı barkod birden çok ürüne/birime bağlanabilir; çözümleme komutta, sessiz atama yok).
CREATE INDEX item_barcodes_tenant_barcode_idx ON public.item_barcodes (tenant_id, barcode);
CREATE INDEX item_barcodes_tenant_unit_idx ON public.item_barcodes (tenant_id, unit_id);

CREATE TABLE public.inventory_owners (
  tenant_id   uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  code        text        NOT NULL,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_owners_pkey PRIMARY KEY (id),
  CONSTRAINT inventory_owners_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT inventory_owners_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT inventory_owners_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT inventory_owners_code_chk CHECK (btrim(code) <> '' AND btrim(name) <> '')
);

CREATE TABLE public.lots (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  item_id          uuid        NOT NULL,
  lot_code         text        NOT NULL,
  production_date  date,
  expiry_date      date,
  supplier_lot     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lots_pkey PRIMARY KEY (id),
  CONSTRAINT lots_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT lots_tenant_item_id_key UNIQUE (tenant_id, item_id, id),
  CONSTRAINT lots_tenant_item_lot_code_key UNIQUE (tenant_id, item_id, lot_code),
  CONSTRAINT lots_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT lots_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT lots_lot_code_chk CHECK (btrim(lot_code) <> ''),
  CONSTRAINT lots_dates_chk CHECK (production_date IS NULL OR expiry_date IS NULL OR expiry_date >= production_date)
);

CREATE TABLE public.serials (
  tenant_id   uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  item_id     uuid        NOT NULL,
  serial_no   text        NOT NULL,
  lot_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT serials_pkey PRIMARY KEY (id),
  CONSTRAINT serials_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT serials_tenant_item_id_key UNIQUE (tenant_id, item_id, id),
  CONSTRAINT serials_tenant_item_serial_no_key UNIQUE (tenant_id, item_id, serial_no),
  CONSTRAINT serials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT serials_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT serials_lot_fkey FOREIGN KEY (tenant_id, item_id, lot_id) REFERENCES public.lots (tenant_id, item_id, id),
  CONSTRAINT serials_serial_no_chk CHECK (btrim(serial_no) <> '')
);
CREATE INDEX serials_tenant_lot_idx ON public.serials (tenant_id, lot_id);

CREATE TABLE public.handling_units (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  kind         text        NOT NULL,
  code         text        NOT NULL,
  parent_id    uuid,
  location_id  uuid,
  status       text        NOT NULL DEFAULT 'OPEN',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handling_units_pkey PRIMARY KEY (id),
  CONSTRAINT handling_units_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT handling_units_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT handling_units_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT handling_units_parent_fkey FOREIGN KEY (tenant_id, parent_id) REFERENCES public.handling_units (tenant_id, id),
  CONSTRAINT handling_units_location_fkey FOREIGN KEY (tenant_id, location_id) REFERENCES public.locations (tenant_id, id),
  CONSTRAINT handling_units_kind_chk CHECK (kind IN ('KOLI', 'PALET')),
  CONSTRAINT handling_units_status_chk CHECK (status IN ('OPEN', 'CLOSED', 'EMPTIED')),
  CONSTRAINT handling_units_code_chk CHECK (btrim(code) <> ''),
  CONSTRAINT handling_units_parent_not_self_chk CHECK (parent_id <> id)
);
CREATE INDEX handling_units_tenant_parent_idx ON public.handling_units (tenant_id, parent_id);
CREATE INDEX handling_units_tenant_location_idx ON public.handling_units (tenant_id, location_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Tetikleyiciler (SECURITY INVOKER, search_path sabit, PUBLIC'ten EXECUTE geri alınır)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.unit_conversions_reject_base_unit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.items i
              WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.item_id AND i.base_unit_id = NEW.unit_id) THEN
    RAISE EXCEPTION 'unit_conversions: temel birim için dönüşüm satırı yoktur (katsayı 1 örtük)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.unit_conversions_reject_base_unit() FROM PUBLIC;
CREATE TRIGGER unit_conversions_reject_base_unit BEFORE INSERT OR UPDATE OF item_id, unit_id ON public.unit_conversions
  FOR EACH ROW EXECUTE FUNCTION public.unit_conversions_reject_base_unit();

CREATE FUNCTION public.handling_units_reject_cycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  cur uuid := NEW.parent_id;
  nxt uuid;
BEGIN
  IF cur IS NULL THEN
    RETURN NEW;
  END IF;
  IF cur = NEW.id THEN
    RAISE EXCEPTION 'HANDLING_UNIT_CYCLE: taşıma birimi kendisinin üstü olamaz' USING ERRCODE = '23514';
  END IF;
  -- Ata zincirini yukarı yürü; her halkayı kilitle (eşzamanlı çapraz iç içe koymada ikinci işlem güncel zinciri görür).
  -- Mevcut veride döngü bulunamaz (bu tetikleyici her değişikliği denetler), dolayısıyla döngü sonlanır.
  LOOP
    SELECT h.parent_id INTO nxt FROM public.handling_units h
     WHERE h.tenant_id = NEW.tenant_id AND h.id = cur
       FOR UPDATE;
    IF NOT FOUND OR nxt IS NULL THEN
      EXIT; -- ebeveyn yoksa/başka tenant ise bileşik FK reddeder
    END IF;
    IF nxt = NEW.id THEN
      RAISE EXCEPTION 'HANDLING_UNIT_CYCLE: taşıma birimi hiyerarşisinde döngü oluşur' USING ERRCODE = '23514';
    END IF;
    cur := nxt;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.handling_units_reject_cycle() FROM PUBLIC;
CREATE TRIGGER handling_units_reject_cycle BEFORE INSERT OR UPDATE OF parent_id ON public.handling_units
  FOR EACH ROW EXECUTE FUNCTION public.handling_units_reject_cycle();

-- ---------------------------------------------------------------------------------------------
-- 3. RLS (ADR-015 §5)
-- ---------------------------------------------------------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['units', 'items', 'unit_conversions', 'item_barcodes', 'inventory_owners', 'lots', 'serials', 'handling_units'] LOOP
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
-- 4. GRANT'lar (yalnızca wms_app; wms_ops ve diğer roller için hiçbir şey)
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON public.units TO wms_app;
GRANT INSERT (tenant_id, id, code, name) ON public.units TO wms_app;
GRANT UPDATE (name, status, archived_at) ON public.units TO wms_app;

GRANT SELECT ON public.items TO wms_app;
GRANT INSERT (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale, pick_policy) ON public.items TO wms_app;
GRANT UPDATE (name, pick_policy, status, archived_at) ON public.items TO wms_app;

GRANT SELECT ON public.unit_conversions TO wms_app;
GRANT INSERT (tenant_id, id, item_id, unit_id, to_base_factor) ON public.unit_conversions TO wms_app;
GRANT UPDATE (to_base_factor) ON public.unit_conversions TO wms_app;

GRANT SELECT, DELETE ON public.item_barcodes TO wms_app;
GRANT INSERT (tenant_id, id, item_id, unit_id, barcode, quantity) ON public.item_barcodes TO wms_app;
GRANT UPDATE (quantity) ON public.item_barcodes TO wms_app;

GRANT SELECT ON public.inventory_owners TO wms_app;
GRANT INSERT (tenant_id, id, code, name) ON public.inventory_owners TO wms_app;
GRANT UPDATE (name) ON public.inventory_owners TO wms_app;

GRANT SELECT ON public.lots TO wms_app;
GRANT INSERT (tenant_id, id, item_id, lot_code, production_date, expiry_date, supplier_lot) ON public.lots TO wms_app;
GRANT UPDATE (production_date, expiry_date, supplier_lot) ON public.lots TO wms_app;

GRANT SELECT ON public.serials TO wms_app;
GRANT INSERT (tenant_id, id, item_id, serial_no, lot_id) ON public.serials TO wms_app;

GRANT SELECT ON public.handling_units TO wms_app;
GRANT INSERT (tenant_id, id, kind, code, parent_id, location_id, status) ON public.handling_units TO wms_app;
GRANT UPDATE (parent_id, location_id, status) ON public.handling_units TO wms_app;
