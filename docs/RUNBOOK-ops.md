# RUNBOOK-ops: operasyon rolü `wms_ops` (T-105c, Q-32 (c))

Kapsam: destek, veri düzeltme, backfill. Bu işler **Neon dal sahibi rolüyle yapılmaz** (BYPASSRLS: FORCE RLS'i atlar);
yalnızca NOBYPASSRLS `wms_ops` rolüyle, açık tenant kimliğiyle ve denetim kaydı bırakarak yapılır.

## Rolün sınırları
- Her ortamda varsayılan NOLOGIN (parolasız); NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION; hiçbir role üye değil; hiçbir nesnenin sahibi değil; DDL yok.
- Yetkili tablolar (0009_ops_role): `tenants` (SELECT; UPDATE yalnızca `name`, `status`), `tenant_memberships`, `membership_roles`,
  `invitations` (UPDATE yalnızca `expires_at`, `revoked_at`), `tenant_settings`, `audit_logs` (SELECT + INSERT; UPDATE/DELETE yok).
- **Stok defteri ve bakiye tablolarına yetki yoktur (G-01).** Stok düzeltmesi yalnızca `packages/domain` stok komutlarıyla yapılır; `wms_ops` ile
  defter/bakiye düzeltme girişimi yasaktır ve zaten 42501 ile reddedilir. `users`, `sessions`, `accounts`, `verifications`, `security_events`,
  `request_rate_limits`, `admin_reset_grants` tablolarına yetki yoktur.
- Tenant bağlamı olmadan hiçbir satır görünmez. Bağlam kurulsa bile, **aynı transaction'da** gerekçeli ve operatör adlı `ops.session_opened`
  denetim satırı yoksa tablolar boş görünür ve yazılamaz (RESTRICTIVE politika `ops_session_required`). `audit_logs` da aynıdır: oturumsuz
  okunamaz; yazılan her satır `ops.*` eylemi olmalı ve `actor_user_id`/`on_behalf_of_user_id` boş kalmalıdır (başka kullanıcı adına kayıt yok).

## Bağlantı bilgisinin yeri
- `wms_ops` bağlantı URI'si **Fly sırrı DEĞİLDİR** ve uygulama/worker/auth süreçlerinin ortamına girmez (uygulama süreçleri yalnızca
  `DATABASE_URL`, `AUTH_DATABASE_URL`, `DATABASE_URL_WORKER` alır).
- Yeri: operasyon işini koşan GitHub Actions işinin sırrı (repo/ortam sırrı `STAGING_DATABASE_URL_OPS`; özel repo ücretsiz planında
  `environment:` koruması yoksa düz repo sırrı ve yalnızca o işin adımına verilir — A-54 sınırı; plan yükselince korumalı ortam).
  Doğrudan (pooler'sız) bağlantı kullanılır; oturum `BEGIN … COMMIT` içindedir.
- Yerel/CI: `01-roles.sh` rolü **NOLOGIN ve parolasız** yaratır. Yerelde geçici açın ve işiniz bitince kapatın (migration rolüyle):
  `ALTER ROLE wms_ops LOGIN PASSWORD '<rastgele>'` … `ALTER ROLE wms_ops NOLOGIN PASSWORD NULL`. Parolayı repoya/loga/komut satırı geçmişine yazmayın.
- Staging (A-80): `scripts/provision-staging.mjs` `wms_ops`'u **NOLOGIN ve parolasız** yaratır; Fly'a hiçbir şey yazılmaz. Destek işi için geçici LOGIN + kısa ömürlü parola veren Actions iş akışı **henüz yok (T-105d)**; o zamana kadar staging'de `wms_ops` ile oturum açılamaz.

### Mevcut yerel volume için geçiş (MINOR-5)
`01-roles.sh` yalnızca boş veri dizininde çalışır; 0009'dan önce kurulmuş yerel/CI volume'unda `wms_ops` yoktur ve `pnpm db:migrate`
"wms_ops rolü yok" ile durur. Ya `docker compose down -v` (veri silinir) ya da migration rolüyle bir kez:
`CREATE ROLE wms_ops NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;` (parolasız), sonra `pnpm db:migrate`.

## Kullanım adımları (tek tenant, tek transaction)
1. Gerekçeyi (değişiklik/destek kaydı numarası) ve operatör adını hazırlayın; kişisel veri içeren serbest metin yazmayın.
2. `wms_ops` ile **doğrudan** bağlanın ve:
   ```sql
   BEGIN;
   SELECT public.ops_open_session('<tenant-uuid>', '<operatör>', '<gerekçe/kayıt no>');  -- bağlamı set_config(..., true) ile kurar + denetimi yazar
   -- yalnızca bu tenant için gerekli en dar DML
   COMMIT;
   ```
3. `ops_open_session` yazılamazsa (örn. var olmayan tenant, boş gerekçe) hata verir; işlemi `ROLLBACK` edin, hiçbir değişiklik kalmaz.
4. Sonucu doğrulayın: aynı tenant için `SELECT … FROM audit_logs WHERE action = 'ops.session_opened'` satırı kim/gerekçe/tenant taşır.
5. Bir oturum tek tenant içindir; başka tenant için yeni transaction ve yeni `ops_open_session` çağrısı gerekir.

## Yasaklar
- Dal sahibi/migration rolüyle veri düzeltmek veya `DATABASE_URL_DIRECT`'i operasyon için kullanmak.
- `withSystemTenant` / `app.system_reason` ile operasyon (işlev reddeder); session-level `set_config` (G-02); transaction dışı sorgu.
- Stok defteri/bakiye tablolarına doğrudan yazmak, `wms_ops`'a DDL/ek yetki vermek, rolü başka bir role üye yapmak, BYPASSRLS vermek.
- Bağlantı bilgisini Fly'a, repoya, loga, PR/rapora yazmak; gerçek müşteri kişisel verisini destek notlarına kopyalamak.
- Denetim satırı olmadan çalışmayı denemek (politika engeller; sorun olarak raporlanır, atlatılmaz).

## Doğrulama
`pnpm test:int tests/integration/schema/ops-role.int.test.ts` (rol nitelikleri, bağlamsız 0 satır, çapraz tenant yazma reddi, denetim zorunluluğu,
defter/DDL 42501, 0009 ileri/geri/ileri).
