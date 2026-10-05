#!/usr/bin/env bash
# Yalnızca YEREL/CI: postgres konteyneri ilk kez başlatılırken (boş veri dizini)
# docker-entrypoint-initdb.d tarafından POSTGRES_USER (= wms_migrator, bootstrap/migration
# rolü) ile çalıştırılır. Neon'daki karşılığı Q-06 / T-005d.
#
# wms_app: uygulama rolü (I-03). RLS'i aşamaz, süper kullanıcı değildir, rol/veritabanı
# oluşturamaz; hiçbir tablonun sahibi değildir (tablo sahibi migration rolüdür).
# wms_auth: ayrı kimlik rolü (ADR-014 §10); wms_app ile aynı kısıtlı nitelikler, hiçbir role üye değil.
# wms_identity_probe: NOLOGIN işlev sahibi rol (ADR-015 §4, ADR-016 §9); migration rolüne yalnızca
# SET (sahiplik devri/SET ROLE) verilir; ADMIN ve INHERIT verilmez (PG16+ sözdizimi).
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER tanımlı değil}"
: "${POSTGRES_DB:?POSTGRES_DB tanımlı değil}"
: "${WMS_APP_PASSWORD:?WMS_APP_PASSWORD tanımlı değil (.env)}"
: "${WMS_AUTH_PASSWORD:?WMS_AUTH_PASSWORD tanımlı değil (.env)}"

# Parola psql değişkeni olarak geçirilir ve :'...' ile SQL literal olarak tırnaklanır;
# betikte veya komut satırı çıktısında açık metin olarak yer almaz.
psql -v ON_ERROR_STOP=1 --no-psqlrc \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_password="$WMS_APP_PASSWORD" \
  --set auth_password="$WMS_AUTH_PASSWORD" \
  --set migrator="$POSTGRES_USER" <<'SQL'
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

CREATE ROLE wms_identity_probe
  NOLOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE;

GRANT wms_identity_probe TO :"migrator" WITH ADMIN FALSE, SET TRUE, INHERIT FALSE;
SQL

echo "01-roles.sh: wms_app, wms_auth (LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION) ve wms_identity_probe (NOLOGIN) oluşturuldu"
