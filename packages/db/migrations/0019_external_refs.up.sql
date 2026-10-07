-- 0019_external_refs (T-252): ERP hazırlığı — dış referans eşlemesi (UUID <-> dış kimlik) ve dışa aktarım senkron imleçleri.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Eşleme koddan bağımsızdır: iç taraf yalnızca entity_id (UUID); kod değişimi (T-251) eşlemeyi etkilemez.
-- * external_refs POLİMORFİKTİR (entity_type + entity_id): hedef tablo tek olmadığından bileşik FK YOKTUR (0018 code_history ile
--   aynı kasıtlı karar; A-252-1). Tenant sınırı RLS USING + WITH CHECK ile korunur; varlığın aynı tenant'ta var olduğu domain
--   katmanında RLS altında doğrulanır (DB tetikleyicisi AC-04 "B anahtarlı INSERT RLS hatası" sözleşmesini bozardı: BEFORE
--   tetikleyici WITH CHECK'ten önce çalışır). Yalnızca tenant_id -> tenants(id) FK'si vardır.
-- * İki yönlü tekillik: UNIQUE (tenant_id, system, entity_type, entity_id) ve UNIQUE (tenant_id, system, entity_type, external_id).
-- * Yetki (en az yetki): wms_app SELECT + açık sütunlu INSERT; UPDATE yalnızca external_code (tetikleyici version+1 ve synced_at'i
--   yazar, istemci veremez); DELETE yok. wms_ops için hiçbir şey.
-- * sync_cursors: akış başına imleç = (cursor_xid, cursor_id) çifti (defter sırası created_xid, id). UPDATE yalnızca imleç
--   sütunları; tetikleyici geriye gitmeyi 23514 ile reddeder ve updated_at'i yazar. Aynı değerle UPDATE zararsızdır (idempotent).

CREATE TABLE public.external_refs (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  system        text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     uuid        NOT NULL,
  external_id   text        NOT NULL,
  external_code text,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  version       integer     NOT NULL DEFAULT 1,
  CONSTRAINT external_refs_pkey PRIMARY KEY (id),
  CONSTRAINT external_refs_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT external_refs_entity_key UNIQUE (tenant_id, system, entity_type, entity_id),
  CONSTRAINT external_refs_external_key UNIQUE (tenant_id, system, entity_type, external_id),
  CONSTRAINT external_refs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT external_refs_system_chk CHECK (system ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  CONSTRAINT external_refs_entity_type_chk CHECK (entity_type IN ('ITEM', 'UNIT', 'WAREHOUSE', 'LOCATION', 'PARTY', 'DOCUMENT', 'LEDGER_ENTRY')),
  CONSTRAINT external_refs_external_id_chk CHECK (btrim(external_id) <> '' AND char_length(external_id) <= 200),
  CONSTRAINT external_refs_external_code_chk CHECK (external_code IS NULL OR (btrim(external_code) <> '' AND char_length(external_code) <= 200)),
  CONSTRAINT external_refs_version_chk CHECK (version >= 1)
);

CREATE TABLE public.sync_cursors (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  system     text        NOT NULL,
  stream     text        NOT NULL,
  cursor_xid bigint      NOT NULL DEFAULT 0,
  cursor_id  uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_cursors_pkey PRIMARY KEY (id),
  CONSTRAINT sync_cursors_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT sync_cursors_stream_key UNIQUE (tenant_id, system, stream),
  CONSTRAINT sync_cursors_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT sync_cursors_system_chk CHECK (system ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  CONSTRAINT sync_cursors_stream_chk CHECK (stream ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT sync_cursors_xid_chk CHECK (cursor_xid >= 0)
);

CREATE FUNCTION public.external_refs_on_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.synced_at := pg_catalog.now();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.external_refs_on_update() FROM PUBLIC;
CREATE TRIGGER external_refs_on_update BEFORE UPDATE ON public.external_refs
  FOR EACH ROW EXECUTE FUNCTION public.external_refs_on_update();

CREATE FUNCTION public.sync_cursors_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.cursor_xid < OLD.cursor_xid OR (NEW.cursor_xid = OLD.cursor_xid AND NEW.cursor_id < OLD.cursor_id) THEN
    RAISE EXCEPTION 'sync_cursors: imleç geriye alınamaz' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.sync_cursors_guard() FROM PUBLIC;
CREATE TRIGGER sync_cursors_guard BEFORE UPDATE ON public.sync_cursors
  FOR EACH ROW EXECUTE FUNCTION public.sync_cursors_guard();

DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['external_refs', 'sync_cursors'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
         USING      (tenant_id = NULLIF(pg_catalog.current_setting(''app.current_tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting(''app.current_tenant_id'', true), '''')::uuid)',
      t || '_isolation', t);
  END LOOP;
END
$rls$;

GRANT SELECT ON public.external_refs TO wms_app;
GRANT INSERT (tenant_id, id, system, entity_type, entity_id, external_id, external_code) ON public.external_refs TO wms_app;
GRANT UPDATE (external_code) ON public.external_refs TO wms_app;

GRANT SELECT ON public.sync_cursors TO wms_app;
GRANT INSERT (tenant_id, id, system, stream, cursor_xid, cursor_id) ON public.sync_cursors TO wms_app;
GRANT UPDATE (cursor_xid, cursor_id) ON public.sync_cursors TO wms_app;
