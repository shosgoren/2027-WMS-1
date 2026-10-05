#!/usr/bin/env bash
# Yalnızca YEREL/CI: postgres konteyneri ilk kez başlatılırken (boş veri dizini)
# docker-entrypoint-initdb.d tarafından POSTGRES_USER (= wms_migrator, bootstrap/migration
# rolü) ile çalıştırılır. Neon'daki karşılığı Q-06 / T-005d.
#
# wms_app: uygulama rolü (I-03). RLS'i aşamaz, süper kullanıcı değildir, rol/veritabanı
# oluşturamaz; hiçbir tablonun sahibi değildir (tablo sahibi migration rolüdür).
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER tanımlı değil}"
: "${POSTGRES_DB:?POSTGRES_DB tanımlı değil}"
: "${WMS_APP_PASSWORD:?WMS_APP_PASSWORD tanımlı değil (.env)}"

# Parola psql değişkeni olarak geçirilir ve :'...' ile SQL literal olarak tırnaklanır;
# betikte veya komut satırı çıktısında açık metin olarak yer almaz.
psql -v ON_ERROR_STOP=1 --no-psqlrc \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_password="$WMS_APP_PASSWORD" <<'SQL'
CREATE ROLE wms_app
  LOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  PASSWORD :'app_password';
SQL

echo "01-roles.sh: wms_app oluşturuldu (LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION)"
