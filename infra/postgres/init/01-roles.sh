#!/usr/bin/env bash
# Yalnızca YEREL/CI: postgres konteyneri ilk kez başlatılırken (boş veri dizini)
# docker-entrypoint-initdb.d tarafından POSTGRES_USER (= wms_migrator, bootstrap/migration
# rolü) ile çalıştırılır. Neon'daki karşılığı Q-06 / T-005d.
#
# wms_app: uygulama rolü (I-03). RLS'i aşamaz, süper kullanıcı değildir, rol/veritabanı
# oluşturamaz; hiçbir tablonun sahibi değildir (tablo sahibi migration rolüdür).
# wms_auth: ayrı kimlik rolü (ADR-014 §10); wms_app ile aynı kısıtlı nitelikler, hiçbir role üye değil.
# wms_worker: kuyruk tüketicisi (T-115c); wms_app ile aynı kısıtlı nitelikler, hiçbir role üye değil, hiçbir
# tablonun sahibi değil. pgboss iş tablosundaki yetkileri `installQueueSchema` (migration rolü) verir.
# wms_ops: operasyon rolü (T-105c, Q-32 (c), A-80); aynı kısıtlı nitelikler, hiçbir role üye değil. NOLOGIN ve PAROLASIZ
# yaratılır (staging ile aynı; db-fingerprint LOGIN'i reddeder); destek işinde geçici `ALTER ROLE wms_ops LOGIN PASSWORD ...`
# ve iş bitince `NOLOGIN` + `PASSWORD NULL` (docs/RUNBOOK-ops.md). Yetkileri 0009_ops_role migration'ı verir.
# wms_identity_probe: NOLOGIN işlev sahibi rol (ADR-015 §4, ADR-016 §9); migration rolüne yalnızca
# SET (sahiplik devri/SET ROLE) verilir; ADMIN ve INHERIT verilmez (PG16+ sözdizimi).
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER tanımlı değil}"
: "${POSTGRES_DB:?POSTGRES_DB tanımlı değil}"
: "${WMS_APP_PASSWORD:?WMS_APP_PASSWORD tanımlı değil (.env)}"
: "${WMS_AUTH_PASSWORD:?WMS_AUTH_PASSWORD tanımlı değil (.env)}"
: "${WMS_WORKER_PASSWORD:?WMS_WORKER_PASSWORD tanımlı değil (.env)}"

# Parolalar komut satırına (argv; /proc/<pid>/cmdline herkese okunur) GİRMEZ: psql
# `\getenv` (PostgreSQL 15+) ile süreç ortamından psql değişkenine okunur ve :'...' ile
# SQL literal olarak tırnaklanır. Betikte ve argv'de açık metin yoktur. Ortam değişkenleri
# de yalnızca aynı kullanıcı/root tarafından okunabilir (/proc/<pid>/environ 0400).
# `--set` ile parola geçirmek yasaktır (harness.int.test.ts betiği denetler).
psql -v ON_ERROR_STOP=1 --no-psqlrc \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password WMS_APP_PASSWORD
\getenv auth_password WMS_AUTH_PASSWORD
\getenv worker_password WMS_WORKER_PASSWORD
\getenv migrator POSTGRES_USER

-- Hata yolunda `CREATE ROLE ... PASSWORD '<parola>'` ifadesi sunucu loguna (STATEMENT: satırı)
-- düşmesin: bu oturumda hata ifadesi günlüğü kapatılır (PANIC = fiilen hiçbir hata). Yalnızca
-- bu betiğin oturumudur (sunucu ayarı değişmez); süper kullanıcı (bootstrap rolü) ayarlayabilir.
SET log_min_error_statement = panic;

CREATE ROLE wms_app
  LOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  PASSWORD :'app_password';

CREATE ROLE wms_auth
  LOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  PASSWORD :'auth_password';

CREATE ROLE wms_worker
  LOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  PASSWORD :'worker_password';

CREATE ROLE wms_ops
  NOLOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;

CREATE ROLE wms_identity_probe
  NOLOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;

GRANT wms_identity_probe TO :"migrator" WITH ADMIN FALSE, SET TRUE, INHERIT FALSE;
SQL

echo "01-roles.sh: wms_app, wms_auth, wms_worker (LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION) ile wms_ops ve wms_identity_probe (NOLOGIN) oluşturuldu"
