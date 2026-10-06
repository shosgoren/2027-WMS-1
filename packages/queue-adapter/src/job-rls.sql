-- pgboss iş tablolarında satır düzeyi güvenlik (T-115c). `installQueueSchema` (migration rolü) pg-boss şeması
-- kurulduktan sonra çalıştırır; idempotent. Neden .sql dosyası: tenant ayarı (`app.current_tenant_id`) yalnızca
-- SQL/packages/db tarafında anılır (I-02/G-02 lint koruması); bu dosya bir migration gibi DDL'dir.
--
-- Kapsam: `pgboss.job` (bölümlü ana tablo) VE bölümleri (`job_common` = kuyrukların GERÇEK tablosu: pg-boss 12.36
-- `queue.table_name` = 'job_common'; send/fetch/complete/fail doğrudan bölüme gider). Yeni bölüm eklenirse her
-- kurulumda kapsanır. Politikalar iki tabloda aynıdır.
--
-- Zarf biçimi: data = {"v":1,"tenantId":<uuid|null>,...}. `tenantId` JSON null = tenant'sız platform işi.
--   wms_app    INSERT: tenantId = oturumun tenant'ı (zarf sahteciliği reddedilir) VEYA platform işi.
--   wms_app    SELECT: tenant bağlamındaki oturum YALNIZCA kendi tenant'ının işlerini görür (tekilleştirme sorgusu için).
--              Platform işleri (tenantId null) yalnızca tenant ayarı BOŞ/ayarsız oturumda görünür (enqueuePlatform'un
--              INSERT ... RETURNING id yolu); tenant bağlamı başka tenant'ın da platform işlerinin de satırını görmez.
--              UPDATE/DELETE politikası YOK + yetki yok. Boş dize tenant sayılmaz (nullif).
--   wms_worker ALL: tüm satırlar (tüketici tüm tenant'ların işlerini işler; tenant verisine ayrı bağlantıyla erişir).
-- ENABLE + FORCE: tablo sahibi de (BYPASSRLS/süper kullanıcı değilse) politikaya tabidir.
DO $rls$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT 'pgboss.job'::regclass
    UNION ALL
    SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = 'pgboss.job'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS job_app_insert ON %s', t);
    EXECUTE format('DROP POLICY IF EXISTS job_app_select ON %s', t);
    EXECUTE format('DROP POLICY IF EXISTS job_worker_all ON %s', t);
    EXECUTE format($p$CREATE POLICY job_app_insert ON %s FOR INSERT TO wms_app
      WITH CHECK (
        data->>'tenantId' = nullif(current_setting('app.current_tenant_id', true), '')
        OR jsonb_typeof(data->'tenantId') = 'null'
      )$p$, t);
    EXECUTE format($p$CREATE POLICY job_app_select ON %s FOR SELECT TO wms_app
      USING (
        data->>'tenantId' = nullif(current_setting('app.current_tenant_id', true), '')
        OR (
          jsonb_typeof(data->'tenantId') = 'null'
          AND nullif(current_setting('app.current_tenant_id', true), '') IS NULL
        )
      )$p$, t);
    EXECUTE format($p$CREATE POLICY job_worker_all ON %s FOR ALL TO wms_worker
      USING (true)
      WITH CHECK (true)$p$, t);
  END LOOP;
END
$rls$;
