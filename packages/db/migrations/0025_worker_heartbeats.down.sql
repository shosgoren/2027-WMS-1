-- 0025_worker_heartbeats geri alma (G-08): tabloyu ve şemayı kaldırır. Veri kaybettirmez: satırlar geçicidir (worker 30 sn'de bir yeniden yazar), kalıcı bilgi taşımaz.
DROP TABLE wms_health.worker_heartbeats;
DROP SCHEMA wms_health;
