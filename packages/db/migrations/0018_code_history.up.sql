-- 0018_code_history (T-251): ürün/depo/lokasyon kodları değiştirilebilir; her değişim code_history'ye yazılır.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Tüm referanslar UUID + (tenant_id, id) bileşik FK ile kurulu; kod yalnızca UNIQUE (tenant_id[, warehouse_id], code) etiketidir.
--   Bu yüzden kod değişimi defter/fiş/rezervasyon/barkod bağlantılarını etkilemez.
-- * code_history POLİMORFİKTİR (entity_type + entity_id): hedef tablo tek olmadığından bileşik FK YOKTUR (kasıtlı; tenant
--   sınırı RLS USING + WITH CHECK ile korunur, entity_id'nin aynı tenant'ta olması uygulama katmanında aynı transaction'da
--   kilitli satırdan türetilir). Yalnızca tenant_id -> tenants(id) FK'si vardır.
-- * Ekle-yalnız: wms_app'e yalnızca SELECT ve INSERT (açık sütun listesi) verilir; UPDATE/DELETE yoktur (42501). Sütun
--   yetkisiyle changed_at DEFAULT now()'a bağlıdır (istemci değer veremez).
-- * Yetki (en az yetki): wms_app'e YALNIZCA items.code, warehouses.code, locations.code için sütun düzeyinde UPDATE eklenir.
--   Bu üç sütunda kodu kilitleyen bir bekçi tetikleyici yoktur (denetlendi: items_guard_tracking_mode yalnızca tracking_mode;
--   locations_reject_tree_change tenant_id/id/warehouse_id/parent_id/depth). wms_ops ve diğer roller için hiçbir şey.
-- * Eski kod araması için indeks: (tenant_id, entity_type, old_code, changed_at DESC).

CREATE TABLE public.code_history (
  tenant_id   uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  entity_type text        NOT NULL,
  entity_id   uuid        NOT NULL,
  old_code    text        NOT NULL,
  new_code    text        NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid        NOT NULL,
  CONSTRAINT code_history_pkey PRIMARY KEY (id),
  CONSTRAINT code_history_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT code_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT code_history_entity_type_chk CHECK (entity_type IN ('item', 'warehouse', 'location')),
  CONSTRAINT code_history_codes_chk CHECK (btrim(old_code) <> '' AND btrim(new_code) <> '' AND old_code <> new_code)
);
CREATE INDEX code_history_tenant_old_code_idx ON public.code_history (tenant_id, entity_type, old_code, changed_at DESC);
CREATE INDEX code_history_tenant_entity_idx ON public.code_history (tenant_id, entity_type, entity_id, changed_at DESC);

ALTER TABLE public.code_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_history FORCE ROW LEVEL SECURITY;
CREATE POLICY code_history_isolation ON public.code_history
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
REVOKE ALL ON TABLE public.code_history FROM PUBLIC;

GRANT SELECT ON public.code_history TO wms_app;
GRANT INSERT (tenant_id, id, entity_type, entity_id, old_code, new_code, changed_by) ON public.code_history TO wms_app;

GRANT UPDATE (code) ON public.items TO wms_app;
GRANT UPDATE (code) ON public.warehouses TO wms_app;
GRANT UPDATE (code) ON public.locations TO wms_app;
