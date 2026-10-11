-- 0025_worker_heartbeats (T-282; G-08 genişlet–taşı–daralt: yalnızca GENİŞLETME, yeni tablo): worker süreci kendi kaydını periyodik günceller;
-- `/api/health` (wms_app) en taze kaydın yaşına ve kuyruk ilerleme sayılarına bakar. Worker durursa kayıt bayatlar → uptime kırmızı.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * AYRI ŞEMA (`wms_health`), `public` DEĞİL: `wms_worker` için "public şemasında hiçbir tablo yetkisi yok" değişmezi (AC-02, T-211 ADR-019 §1) korunur;
--   worker tenant verisi taşıyan hiçbir tabloya yine dokunamaz. Şemada YALNIZCA bu tablo vardır (testle sabitlenir); `public` drift testi etkilenmez.
-- * TENANT'SIZ İŞLETİM TABLOSU: satırda tenant/iş yükü/kişisel veri YOK (örnek kimliği, sürüm, zaman damgası, 3 sayaç). Bu yüzden RLS yoktur
--   (`admin_reset_grants` emsali: platform tablosu); koruma YETKİ ile sağlanır: PUBLIC'ten tüm yetki alınır, yalnızca iki rol açıkça yetkilendirilir.
-- * Kuyruk sayaçlarını WORKER yazar (wms_worker `pgboss.job`'un tüm satırlarını görür; wms_app tenant RLS'i yüzünden görmez). wms_app yalnızca SELECT:
--   web tarafı kuyruk satırlarına hiç dokunmaz, yeni yetki gerekmez.
-- * wms_worker: SELECT (ON CONFLICT için), INSERT, DELETE (eski örnek satırlarının temizliği) ve UPDATE YALNIZCA değişen sütunlarda
--   (`instance_id`/`started_at` değişmez). wms_app: yalnızca SELECT. Başka rol (wms_auth, wms_ops, probe) yetkisizdir.
-- * Zaman damgası `now()` ile VERİTABANI saatinden yazılır, yaş da veritabanında hesaplanır (worker/web saat farkı etkisiz).
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['wms_app', 'wms_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION '0025_worker_heartbeats: % rolü yok (altyapı adımı)', r;
    END IF;
  END LOOP;
END
$pre$;

CREATE SCHEMA wms_health;
REVOKE ALL ON SCHEMA wms_health FROM PUBLIC;
GRANT USAGE ON SCHEMA wms_health TO wms_app, wms_worker;

CREATE TABLE wms_health.worker_heartbeats (
  instance_id         text        NOT NULL,
  version             text        NOT NULL,
  started_at          timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  oldest_waiting_age_s integer   NOT NULL DEFAULT 0,
  expired_active      integer     NOT NULL DEFAULT 0,
  failed_recent       integer     NOT NULL DEFAULT 0,
  CONSTRAINT worker_heartbeats_pkey PRIMARY KEY (instance_id),
  CONSTRAINT worker_heartbeats_instance_chk CHECK (instance_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  CONSTRAINT worker_heartbeats_version_chk CHECK (version ~ '^[A-Za-z0-9._+-]{1,64}$'),
  CONSTRAINT worker_heartbeats_counts_chk CHECK (oldest_waiting_age_s >= 0 AND expired_active >= 0 AND failed_recent >= 0)
);

REVOKE ALL ON wms_health.worker_heartbeats FROM PUBLIC;
GRANT SELECT ON wms_health.worker_heartbeats TO wms_app;
GRANT SELECT, INSERT, DELETE ON wms_health.worker_heartbeats TO wms_worker;
GRANT UPDATE (version, last_seen_at, oldest_waiting_age_s, expired_active, failed_recent) ON wms_health.worker_heartbeats TO wms_worker;

DO $verify$
DECLARE
  r record;
BEGIN
  IF pg_catalog.has_table_privilege('wms_app', 'wms_health.worker_heartbeats', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION '0025_worker_heartbeats: wms_app yalnızca SELECT taşımalı';
  END IF;
  IF pg_catalog.has_table_privilege('wms_worker', 'wms_health.worker_heartbeats', 'TRUNCATE, REFERENCES, TRIGGER')
     OR pg_catalog.has_column_privilege('wms_worker', 'wms_health.worker_heartbeats', 'instance_id', 'UPDATE')
     OR pg_catalog.has_column_privilege('wms_worker', 'wms_health.worker_heartbeats', 'started_at', 'UPDATE') THEN
    RAISE EXCEPTION '0025_worker_heartbeats: wms_worker yetkisi beklenenden geniş';
  END IF;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('wms_auth', 'wms_ops', 'wms_identity_probe') LOOP
    IF pg_catalog.has_table_privilege(r.rolname, 'wms_health.worker_heartbeats', 'SELECT, INSERT, UPDATE, DELETE')
       OR pg_catalog.has_schema_privilege(r.rolname, 'wms_health', 'USAGE') THEN
      RAISE EXCEPTION '0025_worker_heartbeats: % yetkisiz olmalı', r.rolname;
    END IF;
  END LOOP;
END
$verify$;
