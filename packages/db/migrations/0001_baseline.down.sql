-- 0001_baseline geri alma (ADR-015 §4, §9): yalnızca up'ın açıkça verdiğini geri alır.
-- - PUBLIC'e CREATE (public) ve TEMP (veritabanı) GERİ VERİLMEZ (güvenliği gevşetmez).
-- - wms_meta şeması ve defter tablosu koşturucunundur; burada silinmez.
DO $down$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    REVOKE USAGE ON SCHEMA public FROM wms_app;
  END IF;
END
$down$;
