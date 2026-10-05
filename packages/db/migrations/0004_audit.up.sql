-- 0004_audit (T-107, ADR-016 §7, §10; ADR-015 §5 şablonu; I-12, I-16): tenant kapsamlı append-only audit_logs ve
-- platform tablosu request_rate_limits.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * audit_logs RLS şablonunu taşır: tenant_id NOT NULL, (tenant_id, id) benzersiz, bileşik/tekil FK tenants'a,
--   ENABLE + FORCE RLS, USING + WITH CHECK. tenant_id'nin DEFAULT'u app.current_tenant_id'dir ve wms_app'e tenant_id
--   sütununda INSERT yetkisi VERİLMEZ: başka tenant'a audit yazmak iki katmanda kapalıdır (yetki + WITH CHECK).
-- * actor_user_id / on_behalf_of_user_id bilerek FK DEĞİLDİR: kullanıcı silinse de audit satırı kalır (FK'nin
--   NO ACTION'ı kullanıcı silmeyi bloke eder, SET NULL/CASCADE satırı değiştirirdi — I-12). entity_id metindir
--   (varlık türüne göre uuid/anahtar olabilir; tür bilgisi entity_type'tadır).
-- * action biçimi CHECK ile sınırlıdır (nokta ayraçlı küçük harf); izinli eylem listesi KODDADIR (appendAudit) ve
--   T-117/T-121/T-126 tarafından migration gerektirmeden genişler.
-- * change_summary boyut sınırı uygulama katmanındadır (8 KB, aşım = VALIDATION_FAILED); DB'de yalnızca arka kapı
--   olarak 16 KB CHECK vardır (jsonb metin gösterimi boşluk ekler; iki sınır aynı sayı olamaz).
-- * Değiştirilemezlik: wms_app'e yalnızca INSERT, SELECT; ayrıca BEFORE UPDATE OR DELETE satır tetikleyicisi ve
--   BEFORE TRUNCATE ifade tetikleyicisi migration rolü dahil herkesi reddeder (ENABLE ALWAYS: session_replication_role
--   ile atlatılamaz). Tablo sahibi ALTER TABLE ... DISABLE TRIGGER yapabilir: bilinen sınır (saklama/silme 4P'de ayrı
--   rol ve süreçle). occurred_at/created_xid sunucu değerine zorlanır (istemci ileri/geri tarih yazamaz).
-- * M9 (ADR-016 §10): tenant is_demo=true ise ip ve user_agent tetikleyicide NULL'a çevrilir (çağıran atlatamaz).
--   Tetikleyici işlevi SECURITY DEFINER değildir: tenants satırını çağıranın RLS bağlamında okur.
-- * request_rate_limits platform tablosudur (RLS yok); anahtar yalnızca SHA-256 özetidir (64 onaltılık karakter,
--   CHECK); wms_auth'un bu tabloda yetkisi yoktur.
-- Koşturucu tek transaction içinde çalıştırır; denetim ihlali = RAISE = hiçbir şey uygulanmaz.

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0004_audit: wms_app rolü yok (0001_baseline önkoşulu)';
  END IF;
  IF pg_catalog.to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION '0004_audit: public.tenants yok (0003_tenancy önkoşulu)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 1. audit_logs
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.audit_logs (
  tenant_id           uuid        NOT NULL DEFAULT NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid,
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  actor_user_id       uuid,
  on_behalf_of_user_id uuid,
  action              text        NOT NULL,
  entity_type         text,
  entity_id           text,
  reason              text,
  ip                  text,
  user_agent          text,
  request_id          text,
  change_summary      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_xid         xid8        NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT audit_logs_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT audit_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT audit_logs_action_chk CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT audit_logs_change_summary_chk CHECK (pg_catalog.jsonb_typeof(change_summary) = 'object'
                                                  AND pg_catalog.length(change_summary::text) <= 16384)
);
-- Görüntüleme/export keyset sırası (I-14): (tenant_id, occurred_at DESC, id).
CREATE INDEX audit_logs_tenant_occurred_idx ON public.audit_logs (tenant_id, occurred_at DESC, id);

CREATE FUNCTION public.audit_logs_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_logs append-only: % reddedildi', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;
REVOKE ALL ON FUNCTION public.audit_logs_reject_change() FROM PUBLIC;

CREATE FUNCTION public.audit_logs_force_server_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.occurred_at := pg_catalog.now();
  NEW.created_xid := pg_catalog.pg_current_xact_id();
  -- M9: demo tenant'ta ağ üstverisi tutulmaz. Satır çağıranın RLS bağlamında okunur (SECURITY DEFINER değil).
  IF EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = NEW.tenant_id AND t.is_demo) THEN
    NEW.ip := NULL;
    NEW.user_agent := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.audit_logs_force_server_fields() FROM PUBLIC;

CREATE TRIGGER audit_logs_server_fields
  BEFORE INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_force_server_fields();
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_reject_change();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON public.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_reject_change();
ALTER TABLE public.audit_logs ENABLE ALWAYS TRIGGER audit_logs_server_fields;
ALTER TABLE public.audit_logs ENABLE ALWAYS TRIGGER audit_logs_no_update_delete;
ALTER TABLE public.audit_logs ENABLE ALWAYS TRIGGER audit_logs_no_truncate;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_logs_isolation ON public.audit_logs
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------------------------
-- 2. request_rate_limits (platform tablosu, RLS yok; T-127 kullanır)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.request_rate_limits (
  scope        text        NOT NULL,
  key_hash     text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  CONSTRAINT request_rate_limits_pkey PRIMARY KEY (scope, key_hash, window_start),
  CONSTRAINT request_rate_limits_scope_chk CHECK (scope <> ''),
  CONSTRAINT request_rate_limits_key_hash_chk CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT request_rate_limits_count_chk CHECK (count >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- 3. Yetkiler (tablo başına açık ve en dar)
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE public.audit_logs, public.request_rate_limits FROM PUBLIC, wms_app;
DO $revoke_auth$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_auth') THEN
    REVOKE ALL ON TABLE public.audit_logs, public.request_rate_limits FROM wms_auth;
  END IF;
END
$revoke_auth$;

GRANT SELECT ON public.audit_logs TO wms_app;
-- tenant_id, id, occurred_at, created_xid sütunlarında INSERT yetkisi yok (varsayılan/tetikleyici değerleri).
GRANT INSERT (actor_user_id, on_behalf_of_user_id, action, entity_type, entity_id, reason, ip, user_agent,
              request_id, change_summary) ON public.audit_logs TO wms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.request_rate_limits TO wms_app;

-- ---------------------------------------------------------------------------------------------
-- 4. Yetki denetimi: ihlal = RAISE.
-- ---------------------------------------------------------------------------------------------
DO $verify$
DECLARE
  rls record;
BEGIN
  SELECT relrowsecurity AS en, relforcerowsecurity AS fo INTO rls FROM pg_catalog.pg_class
   WHERE oid = 'public.audit_logs'::regclass;
  IF NOT rls.en OR NOT rls.fo THEN
    RAISE EXCEPTION '0004_audit: audit_logs ENABLE + FORCE ROW LEVEL SECURITY olmalı';
  END IF;
  IF NOT pg_catalog.has_table_privilege('wms_app', 'public.audit_logs', 'SELECT')
     OR pg_catalog.has_table_privilege('wms_app', 'public.audit_logs', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR pg_catalog.has_table_privilege('wms_app', 'public.audit_logs', 'INSERT')
     OR pg_catalog.has_any_column_privilege('wms_app', 'public.audit_logs', 'UPDATE')
     OR pg_catalog.has_column_privilege('wms_app', 'public.audit_logs', 'tenant_id', 'INSERT')
     OR pg_catalog.has_column_privilege('wms_app', 'public.audit_logs', 'id', 'INSERT')
     OR pg_catalog.has_column_privilege('wms_app', 'public.audit_logs', 'occurred_at', 'INSERT')
     OR pg_catalog.has_column_privilege('wms_app', 'public.audit_logs', 'created_xid', 'INSERT')
     OR NOT pg_catalog.has_column_privilege('wms_app', 'public.audit_logs', 'action', 'INSERT') THEN
    RAISE EXCEPTION '0004_audit: wms_app audit_logs yetkileri beklenenden farklı (yalnızca SELECT + sütun bazlı INSERT)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_auth')
     AND pg_catalog.has_any_column_privilege('wms_auth', 'public.audit_logs', 'SELECT, INSERT, UPDATE, REFERENCES')
  THEN
    RAISE EXCEPTION '0004_audit: wms_auth audit_logs üzerinde yetki taşıyor';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_auth')
     AND pg_catalog.has_any_column_privilege('wms_auth', 'public.request_rate_limits', 'SELECT, INSERT, UPDATE, REFERENCES')
  THEN
    RAISE EXCEPTION '0004_audit: wms_auth request_rate_limits üzerinde yetki taşıyor';
  END IF;
  IF NOT pg_catalog.has_table_privilege('wms_app', 'public.request_rate_limits', 'SELECT, INSERT, UPDATE, DELETE')
     OR pg_catalog.has_table_privilege('wms_app', 'public.request_rate_limits', 'TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION '0004_audit: wms_app request_rate_limits yetkileri beklenenden farklı';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
              WHERE c.oid IN ('public.audit_logs'::regclass, 'public.request_rate_limits'::regclass) AND a.grantee = 0) THEN
    RAISE EXCEPTION '0004_audit: audit tablolarında PUBLIC yetkisi var';
  END IF;
END
$verify$;
