#!/usr/bin/env bash
# Yalnızca YEREL/CI (docker compose, T-101c): PgBouncer userlist'ini SCRAM-SHA-256 verifier'larla üretir.
# `pgbouncer-userlist` tek seferlik servisi postgres imajında çalıştırır (openssl/perl/psql var;
# PgBouncer imajında araç yok). Çıktı: /out/userlist.txt (0600, sahibi pgbouncer imajının postgres
# kullanıcısı uid 70). Açık metin parola dosyaya, argv'ye ve loga hiç girmez.
#
# Neden pg_authid'den okunur (deneyle doğrulandı): PgBouncer istemci SCRAM kanıtından ClientKey'i çıkarıp
# sunucuya SCRAM'ı kendi adına yürütür (pass-through). Sunucunun StoredKey'i yalnızca KENDİ tuzuyla
# türetilmiş ClientKey'i kabul eder; bu yüzden wms_app/wms_auth verifier'ı sunucudakiyle BİREBİR
# aynı (aynı tuz ve yineleme) olmalıdır. Rastgele tuzla parolalardan üretilen verifier istemci
# kimlik doğrulamasını geçirir ama sunucu tarafında "password authentication failed" verir.
# Bu yüzden wms_app/wms_auth satırları bootstrap (süper kullanıcı) bağlantısıyla pg_authid.rolpassword'den
# kopyalanır; bu servis o iki rolün açık metin parolasını hiç görmez. Bağlantı parolası libpq ortamından
# (PGPASSWORD) gelir, argv'ye düşmez.
#
# pgbouncer_admin yalnızca PgBouncer'a özgüdür (sunucuda rolü yok, pass-through yok): verifier perl ile
# parolasından rastgele tuzla üretilir. Biçim (RFC 5802/7677, PostgreSQL ile aynı; üretici pg_authid
# ile bayt düzeyinde karşılaştırılarak doğrulandı):
#   SCRAM-SHA-256$4096:<b64 salt>$<b64 StoredKey>:<b64 ServerKey>
#   SaltedPassword = PBKDF2-HMAC-SHA256(parola, salt, 4096, 32)
#   ClientKey = HMAC(SaltedPassword, "Client Key"); StoredKey = SHA256(ClientKey)
#   ServerKey = HMAC(SaltedPassword, "Server Key")
# perl'e argv ile yalnızca ORTAM DEĞİŞKENİ ADI verilir. Parola ham bayt olarak kullanılır (SASLprep yok).
set -euo pipefail

OUT_DIR="${OUT_DIR:-/out}"
OWNER_UID_GID="${OWNER_UID_GID:-70:70}"

verifier() {
  perl -MDigest::SHA=hmac_sha256,sha256 -MMIME::Base64=encode_base64 -e '
    my $name = shift @ARGV;
    my $pw = $ENV{$name};
    die "$name tanımlı değil veya boş\n" unless defined $pw && length $pw;
    my $salt;
    open(my $fh, "<:raw", "/dev/urandom") or die "urandom açılamadı: $!\n";
    read($fh, $salt, 16) == 16 or die "urandom okunamadı\n";
    close $fh;
    my $iter = 4096;
    my $u = hmac_sha256($salt . pack("N", 1), $pw);
    my $salted = $u;
    for (2 .. $iter) { $u = hmac_sha256($u, $pw); $salted ^= $u; }
    my $client_key = hmac_sha256("Client Key", $salted);
    my $stored_key = sha256($client_key);
    my $server_key = hmac_sha256("Server Key", $salted);
    my $b = sub { my $s = encode_base64($_[0], ""); $s };
    print "SCRAM-SHA-256\$$iter:" . $b->($salt) . "\$" . $b->($stored_key) . ":" . $b->($server_key) . "\n";
  ' "$1"
}

umask 077
tmp="$(mktemp "$OUT_DIR/.userlist.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# wms_app / wms_auth: sunucudaki verifier birebir kopyalanır (psql parolayı PGPASSWORD ortamından alır).
for user in wms_app wms_auth; do
  secret="$(psql -X -A -t -q -v ON_ERROR_STOP=1 -h "${PGHOST:-postgres}" -U "${POSTGRES_USER:?POSTGRES_USER tanımlı değil}" \
    -d "${POSTGRES_DB:?POSTGRES_DB tanımlı değil}" \
    -c "SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = '$user'")"
  case "$secret" in
    SCRAM-SHA-256\$*) ;;
    *) echo "make-verifier: $user için pg_authid'de SCRAM-SHA-256 verifier bulunamadı (rol yok veya parola SCRAM değil)" >&2; exit 1;;
  esac
  case "$secret" in *'"'*|*[[:space:]]*) echo "make-verifier: $user verifier biçimi beklenmeyen" >&2; exit 1;; esac
  printf '"%s" "%s"\n' "$user" "$secret" >> "$tmp"
done

# pgbouncer_admin: parolasından üretilir.
admin="${PGBOUNCER_ADMIN_PASSWORD-}"
[ -n "$admin" ] || { echo "make-verifier: PGBOUNCER_ADMIN_PASSWORD tanımlı değil" >&2; exit 1; }
case "$admin" in *'"'*) echo "make-verifier: PGBOUNCER_ADMIN_PASSWORD çift tırnak içeremez" >&2; exit 1;; esac
printf '"%s" "%s"\n' pgbouncer_admin "$(verifier PGBOUNCER_ADMIN_PASSWORD)" >> "$tmp"

chown "$OWNER_UID_GID" "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$OUT_DIR/userlist.txt"
trap - EXIT
chown "$OWNER_UID_GID" "$OUT_DIR"
chmod 0750 "$OUT_DIR"
echo "make-verifier: userlist.txt yazıldı (3 kullanıcı, SCRAM-SHA-256)"
