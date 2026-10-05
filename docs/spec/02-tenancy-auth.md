# 02 — Tenant İzolasyonu, Kimlik ve Yetki

## Tenant bağlamı
- Kullanıcı birden çok tenant'a üye olabilir: `users`, `tenant_memberships`, `roles`, `permissions`, depo kapsamı ayrı modellenir.
- Sunucu; kimlik, aktif üyelik ve işlem yetkisini doğrulayarak bağlam kurar (I-01). Tenant tablolarında `tenant_id NOT NULL`; platform/global tablolar ayrı güvenlik kapsamında.
- Tenant tabloları arası FK'ler `(tenant_id, entity_id)` çiftini referans alır.
- Cache anahtarı, dosya yolu, job kimliği tenant kapsamlıdır; yine de her erişimde sahiplik doğrulanır.

## RLS
- RLS ENABLE + FORCE; okuma `USING`, yazma `WITH CHECK`. Uygulama rolü I-03'e uyar.
- Bağlam transaction-local (I-02). Pool üzerinde A→B tenant geçişi ve eşzamanlı kullanım test edilir (AC-05). Pooler modu ve prepared statement davranışı seçilen ORM/sürücüyle ADR-004'te doğrulanır.

## Pooler uyumluluğu (ADR-004 — Faz 0 çıkış kapısı)
Transaction-mode pooler (PgBouncer, Supavisor, Neon pooler) arkasında her transaction farklı fiziksel bağlantıya düşebilir. Bu nedenle:
- Tenant bağlamı yalnızca `SELECT set_config('app.current_tenant_id', $1, true)` ile kurulur. `SET` / `SET SESSION` yasak; `SET LOCAL` parametre alamadığı için kullanılmaz (string birleştirme = SQL injection riski).
- `set_config` ve tenant sorguları **aynı ORM transaction nesnesi** üzerinden çalışır (örn. Drizzle `db.transaction(tx => …)`). Transaction dışındaki `db.` çağrısı tenant tablosuna erişemez; bunu sağlayan tek yardımcı `withTenant(ctx, fn)` `packages/db` içindedir ve lint kuralıyla doğrudan `db` kullanımı tenant modüllerinde engellenir.
- **Prepared statement:** Pooler sürümü protokol düzeyi prepared statement desteklemiyorsa sürücüde kapatılır (örn. postgres.js `prepare: false`, Prisma `pgbouncer=true`); destekliyorsa (PgBouncer ≥1.21 `max_prepared_statements`) ayar ADR-004'e yazılır. Karar test sonucuna göre verilir, varsayıma göre değil.
- Advisory lock, `LISTEN/NOTIFY`, session temp table, `WITH HOLD` cursor gibi session'a bağlı özellikler pooler üzerinden kullanılmaz; gerekiyorsa ayrı doğrudan (session-mode) bağlantı havuzu tanımlanır (worker/migration).
- Migration ve uzun süren worker işleri doğrudan (pooler'sız) bağlantı kullanabilir; bu bağlantı da `wms_app` benzeri RLS'e tabi rol ile çalışır, yalnızca migration rolü ayrıdır.
- **Erken kanıt (T-005 spike):** Seçilen sağlayıcının gerçek pooler'ı arkasında; pool boyutu 1–2'ye düşürülerek bağlantı yeniden kullanımı zorlanır; 2 tenant × 50 eşzamanlı istek; her yanıt yalnızca kendi tenant'ının satırlarını döndürmeli, transaction dışı sorgu 0 satır/ret almalı, prepared statement hatası olmamalı. Bu test geçmeden Faz 1'e geçilmez.
- **İki katmanlı kanıt:** (a) T-005 bir kez **seçilen sağlayıcının gerçek pooler'ı** üzerinde koşar ve sonucu ADR-004'e (sağlayıcı, pooler sürümü, sürücü ve ORM sürümü, prepared statement ayarı) yazılır. (b) Aynı test **her CI çalıştırmasında**, docker compose'daki transaction-mode PgBouncer arkasında, üretimle aynı sürücü ayarlarıyla koşar. Yalnızca doğrudan PostgreSQL'e bağlanan bir test geçerli kanıt sayılmaz.
- **Yeniden spike tetikleyicileri:** Sağlayıcı, pooler türü/sürümü, PostgreSQL ana sürümü, sürücü veya ORM ana sürümü değiştiğinde T-005 gerçek sağlayıcıda tekrar koşturulur; koşturulmadan bu yükseltmeler `main`'e girmez (`check:protected` bu paket sürümlerini izler).
- RLS satır izolasyonudur; eylem, depo, alan ve belge durumu yetkisi ayrıca sunucuda uygulanır.

## Roller ve izinler
- Hazır roller: Tenant Sahibi/Yönetici, Depo Şefi, Toplama Personeli, Sayım Personeli, Salt Okunur.
- İzinler eylem + depo kapsamı: `stok.görüntüle`, `fiş.oluştur`, `fiş.onayla`, `stok.işle`, `ters_kayıt.oluştur`, `sayım_farkı.onayla`, `takeout.talep_et`, `ayarlar.yönet`, `kullanıcı.yönet`.
- Görev ayrımı (aynı kişinin oluşturup onaylayamaması) tenant politikasıyla açılıp kapanır (Q: Faz 0).

## Oturum
- Kısa ömürlü erişim token'ı + yenileme rotasyonu + oturum iptali; her yazmada güncel üyelik/yetki kontrolü. Kullanıcı çıkarılması/tenant askıya alınması eski token ile yazmayı engeller.
- Yönetici/süper yönetici için MFA; export, anahtar değişimi, hesap kapatma için yeniden doğrulama. Son tenant sahibi devir olmadan ayrılamaz.
- Süper yönetici müşteri verisine varsayılan erişemez; destek erişimi gerekçeli, süreli, audit'li, gerektiğinde müşteri onaylı ("adına işlem" kaydı ile).
- Auth sağlayıcıları: Google, Microsoft, e-posta (ilk kapsam); Apple sonraki. Kurumsal SSO (SAML/OIDC) Enterprise paket için sonraki faz.
