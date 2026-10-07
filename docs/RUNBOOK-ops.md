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

## 0020 TARGET_STATUS ihlali ile deploy durdu (T-258/T-271)
Belirti: `pnpm db:migrate` / deploy `0020_target_status_guard: kuralı ihlal eden document_lines.target_stock_status satırı var; önce düzeltilmeli` ile durur.
Migration tek transaction'dır; RAISE her şeyi geri alır (kısmi uygulanmış 0020 yoktur, FORCE RLS geri kurulur). Kural: hedef durum yalnız STOCK_MOVE belgesinde ve
(aynı durum | QUARANTINE>AVAILABLE | AVAILABLE>QUARANTINE) çiftinde olabilir. Hiçbir adımda migration dosyasını veya bekçiyi gevşetmeyin; satır düzeltilir.
1. **Ön sorgu (yalnız salt okunur; sayım + kimlik, kişisel veri seçmeyin).** Migration rolüyle; tablo sahibi FORCE RLS altındadır, bu yüzden tek transaction'da RLS'i
   kapatıp okuyun ve bitince geri alın (işlem `ROLLBACK` ile biter, kalıcı değişiklik yok):
   ```sql
   BEGIN;
   ALTER TABLE public.documents NO FORCE ROW LEVEL SECURITY;
   ALTER TABLE public.document_lines NO FORCE ROW LEVEL SECURITY;
   SELECT d.status AS belge_durumu, d.kind AS belge_turu, count(*) AS satir_sayisi
     FROM public.document_lines l JOIN public.documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
    WHERE l.target_stock_status IS NOT NULL
      AND (d.kind <> 'STOCK_MOVE' OR (l.target_stock_status <> l.stock_status
           AND (l.stock_status || '>' || l.target_stock_status) NOT IN ('QUARANTINE>AVAILABLE','AVAILABLE>QUARANTINE')))
    GROUP BY 1, 2;
   -- kimlik listesi (tenant_id, document_id, line_id, belge durumu); ad/serbest metin/not seçmeyin:
   SELECT l.tenant_id, l.document_id, l.id AS line_id, d.status, d.kind, l.stock_status, l.target_stock_status
     FROM public.document_lines l JOIN public.documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
    WHERE l.target_stock_status IS NOT NULL
      AND (d.kind <> 'STOCK_MOVE' OR (l.target_stock_status <> l.stock_status
           AND (l.stock_status || '>' || l.target_stock_status) NOT IN ('QUARANTINE>AVAILABLE','AVAILABLE>QUARANTINE')))
    ORDER BY 1, 2, 3 LIMIT 100;
   ROLLBACK;  -- NO FORCE da geri alınır
   ```
   Çıktıyı yalnız sayım ve kimliklerle (UUID) rapora/destek kaydına yazın.
2. **Belge durumu DRAFT ise:** uygulama yoluyla düzeltin (doğrudan SQL değil): ilgili tenant'ın yetkili kullanıcısı/uygulama komutuyla `updateDraft` ile satırın hedef durumunu
   boşaltın veya izinli çifte getirin ya da taslağı iptal edin. Sonra ön sorguyu yeniden çalıştırın; 0 satır olunca `pnpm db:migrate`.
3. **Belge durumu APPROVED/CANCELLED ise:** uygulama yolu yoktur (satır yalnız DRAFT'ta yazılır, 0012 koruması). POSTED ise I-08 gereği satır değiştirilmez: durun, Q ekleyin, kullanıcıya bildirin. Süper kullanıcı onarımı **veri değiştiren işlemdir; yalnızca kullanıcının
   (veri sahibi/operatör sorumlusu) açık onayıyla** yapılır; onay ve kayıt numarası olmadan çalıştırılmaz. Onay sonrası:
   a. Önce yedek/anlık görüntü alın (Neon dalı veya `pg_dump` yalnız etkilenen satırlar; çıktı repoya/loga girmez).
   b. Tek transaction içinde, yalnız ön sorgudaki kimliklerle ve tenant bazında; `UPDATE ... SET target_stock_status = NULL WHERE (tenant_id, id) IN (...)`
      (değerin önceki hâlini aynı transaction'da geçici tabloya veya destek kaydına kimlik + eski değer olarak yazın; geri dönüş buradandır).
      APPROVED/CANCELLED belgede satır değişmezlik koruması varsa bunu atlatmak için `session_replication_role` DEĞİL, yalnız koruma tetikleyicisinin gerektirdiği
      yolu (kullanıcı onayı + Supervisor kararı) kullanın; yol belirsizse durun ve `docs/OPEN_QUESTIONS.md`'ye Q ekleyin.
   c. Aynı transaction'da ön sorguyu yeniden çalıştırın; sonuç 0 değilse `ROLLBACK`. 0 ise `COMMIT`.
   d. **Geri dönüş:** hata fark edilirse kayıtlı kimlik + eski değerlerle ters `UPDATE` (yine onayla); onaydan önce `ROLLBACK` her şeyi geri alır.
4. Deploy'u yeniden çalıştırın; `0020` uygulanınca `pnpm test:int tests/integration/stock/posting.int.test.ts` (4x4 eşitlik) ve operations-schema testi doğrulama içindir.

## Dağıtım sırası: migration → worker → web (T-222/T-275)
Eşik üstü belge işleme (`stock.document.post`, ADR-018 §6) web ve worker'ın birlikte sürümlenmesine bağlıdır. Sıra: (1) migration (`pnpm db:migrate`; 0023 sütunları + 0024 bekçisi
yalnızca genişletir, eski kodla uyumludur), (2) **worker**, (3) **web**.
Gerekçe: yeni web isteği belgeye `posting_job_id` + MFA damgası + idempotency kaydı yazıp işi kuyruğa bırakır; bu işi çözen (damgayı doğrulayan `mayVouchMfa`, kayıt kimliğini
sürdüren `resume`) kod worker'dadır. Web önce çıkarsa, eski worker yeni işi tanımaz/yanlış yorumlar: iş kuyrukta bekler, belge `PROCESSING`'te (kilitli) takılı kalır ve
istemci `IN_PROGRESS` görür. Worker önce çıkarsa durum zararsızdır: eski web iş üretmez ya da damgasız üretir; yeni worker damgasız işi fail-closed (`mfaVerified: false`) işler.
Geri alma tersidir: önce web, sonra worker. Not: 0024 tetikleyicisi damgayı yalnızca `posting_job_id` NULL → dolu geçişinde yazdırır; eski sürüm web bunu zaten aynı ifadede yazar,
farklı bir yazım yolu 23514 `POSTING_STAMP_GUARD` ile reddedilir (bu hata dağıtım sırası yanlışlığının değil, kodun belirtisidir).
Takılı işleme kilidi gözlenirse (belge APPROVED + `posting_job_id` dolu, işlenmiyor): önce worker'ın ayakta ve yeni sürümde olduğunu doğrulayın; sonlandırma süpürücüsü kiracı
açıksa kilidi temizler (kiracı askıda/kapanıştaysa ertelenir, A-222-3).
