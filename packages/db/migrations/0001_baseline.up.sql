-- 0001_baseline (T-101, ADR-015 §4, I-03): roller migration'da YARATILMAZ; yalnızca denetlenir.
-- Koşturucu tek transaction içinde çalıştırır; denetim ihlali = RAISE = hiçbir şey uygulanmaz.

DO $baseline$
DECLARE
  app pg_catalog.pg_roles%ROWTYPE;
  n   bigint;
BEGIN
  SELECT * INTO app FROM pg_catalog.pg_roles WHERE rolname = 'wms_app';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0001_baseline: wms_app rolü yok (altyapı adımı: infra/postgres/init/01-roles.sh veya T-105)';
  END IF;
  IF app.rolsuper OR app.rolbypassrls THEN
    RAISE EXCEPTION '0001_baseline: wms_app SUPERUSER veya BYPASSRLS olamaz (I-03)';
  END IF;
  IF app.rolcreaterole OR app.rolcreatedb THEN
    RAISE EXCEPTION '0001_baseline: wms_app CREATEROLE veya CREATEDB olamaz (I-03)';
  END IF;

  SELECT count(*) INTO n FROM pg_catalog.pg_auth_members WHERE member = app.oid;
  IF n > 0 THEN
    RAISE EXCEPTION '0001_baseline: wms_app hiçbir role üye olamaz (% üyelik bulundu)', n;
  END IF;

  SELECT (SELECT count(*) FROM pg_catalog.pg_class     WHERE relowner = app.oid)
       + (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspowner = app.oid)
       + (SELECT count(*) FROM pg_catalog.pg_proc      WHERE proowner = app.oid)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION '0001_baseline: wms_app hiçbir nesnenin sahibi olamaz (% nesne bulundu)', n;
  END IF;
END
$baseline$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $temp$
BEGIN
  EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC', current_database());
END
$temp$;
GRANT USAGE ON SCHEMA public TO wms_app;

-- wms_meta: yalnızca migration defteri; sahibi migration rolü (koşturucu şemayı yaratmış olur).
CREATE SCHEMA IF NOT EXISTS wms_meta;
REVOKE ALL ON SCHEMA wms_meta FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA wms_meta FROM PUBLIC;

-- Yetki denetimi (dolaylı/doğrudan verilmiş olabilir): ihlal = RAISE.
DO $verify$
BEGIN
  IF pg_catalog.has_schema_privilege('wms_app', 'wms_meta', 'USAGE, CREATE') THEN
    RAISE EXCEPTION '0001_baseline: wms_app wms_meta şemasında yetki taşıyor';
  END IF;
  IF pg_catalog.has_table_privilege('wms_app', 'wms_meta.schema_migrations',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION '0001_baseline: wms_app defter tablosunda yetki taşıyor';
  END IF;
  IF pg_catalog.has_schema_privilege('wms_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION '0001_baseline: wms_app public şemasında CREATE yetkisi taşıyor';
  END IF;
  IF pg_catalog.has_database_privilege('wms_app', current_database(), 'TEMP') THEN
    RAISE EXCEPTION '0001_baseline: wms_app veritabanında TEMP yetkisi taşıyor';
  END IF;
END
$verify$;
