# STATE (≤80 satır — her görev sonunda Supervisor günceller)

**Oturum kilidi:** session_01C59FRaUynaDdhNGZoRbKsY · 2026-10-06T21:57Z (zamanlanmış oturum: kilit 3 saatten yeniyse ve başka oturumunsa hiçbir şey yapmadan çık; değilse kendi kimliğinle yenile, her push'ta zamanı güncelle)
**Faz:** 2 — stok çekirdeği (T-213, T-217 main'de; T-221 incelemede) + Faz 3A (int/faz3a: T-301/T-303/T-312 içinde; T-302 düzeltmede; T-250/251/252 kullanıcı geri bildirimi kartları). Faz 0/1 kapıları GEÇTİ (JOURNAL). Kullanıcı UTC+3: kullanıcı mesajlarında Türkiye saati.
**Aktif görev:** Palet (ADR-020) tüm mevcut ekranlarda main'de (#74, #76). T-247 kabulü: e2e-staging ardışık 1/3 yeşil, 2/3 koşuyor. Ajanlar: T-220 qa (stok çekirdeği), T-250 kolay kurulum, T-302 düzeltme (onay atlatma DB), T-223 eki (v2 testleri + zengin demo). İncelemede: T-221 (a4d5512). Faz 2 kalan dallar: feat/T-221 → int/faz2-defter; T-223 → main.
**Son tamamlanan:** #76 T-246d · #74 palet T-246a/b/c · #75 T-249 audit TZ testi · #73 T-217 + docs · #72 T-247 hidrasyon · #71 T-213 · önceki: JOURNAL
**Sonraki adım:** e2e-staging 3/3 → T-247 kapanır. T-221 inceleme → int/faz2-defter → PR. T-223 eki → main PR. T-302 düzeltme → yeniden sayım → int/faz3a. T-220 → PR. Sonra: T-251 (kod değiştirme, 0018), T-252 (dış referans, 0019), T-248 (hedef durum), T-224 (ters kayıt), T-222/T-225 (worker; pg-boss supervise ZORUNLU), T-226/T-229 ekranlar, T-304→T-305… (3A komutları; ZORUNLU notlar kartlarda). int/faz3a → main PR (ADR-021/022 kabul; protected → APPROVED-BY head SHA). OQ'ya: A-155+ (T-302), A-221-1…6, A-223-1…5, A-T312-1…6. Kullanıcı işi: pilot profil doğrulaması (Q-12) 3A kapısı için. ≤4 uygulama ajanı; --no-verify yasak (21:45Z ihlal kaydı).

## Çalışma biçimi (kullanıcı kararı 2026-10-05 — ADR-012 rev., PROTOCOL §Onay kaynağı)
- Kullanıcı PR incelemez. Birleştirme kapısı: CI/oturumda `pnpm verify` + `check:all` + `test:int` + ilgili `test:ac` yeşil; risk matrisine göre `security-reviewer` ve `qa-verifier` BLOCKER: 0 → Supervisor PR'ı kendisi birleştirir (`mcp__github__merge_pull_request`). Korunan değişiklikte PR açıklamasında `APPROVED-BY: supervisor (ADR-012 rev.)`.
- Faz kapısı geçince sonraki faza kendiliğinden geçilir; kapı raporu JOURNAL'a.
- Kullanıcıya yalnızca **hesabını gerektiren işler** için tek mesaj; bitince canlı adres + deneme rehberi. "Bitti" = Faz 0…4P kapıları geçti ve prod (Fly, demo veri) ayakta. Sonra 3B/4S/5… aynı döngüyle sürer.
- Zamanlanmış görev: saatlik Routine `trig_01KkPqG8EZQVgdpYeU6eWxaW` (dk :42) bu oturuma (session_01C59FRaUynaDdhNGZoRbKsY) mesaj düşer → bu dosyadan devam. Başka oturum devralırsa kilit kuralına uyar.
- Dallar: kart dalı `feat/T-xxx-…` → `int/<dilim>` → `main`. `main`'e doğrudan push yok.
- Ortam: npm + Docker Hub açık (dockerd elle başlatılır: `dockerd >/tmp/dockerd.log 2>&1 &`). Sağlayıcı API'leri (neon.tech, fly.io) ajan ortamından kapalı → Neon/Fly işleri yalnızca GitHub Actions'ta, sırlar GitHub repo sırlarında.

## Kararlar (özet; detay DECISIONS.md) — hepsi kabul
ADR-001 Next.js + ayrı worker · 002 İngilizce kod/DB, Türkçe UI · 003 Drizzle · 004 Neon · 005 Postgres kuyruğu · 006 S3 uyumlu · 007 AB bölgesi (Q-07 gelene kadar canlıda yalnızca demo veri) · 008 4S'e ertelendi · 009 sert tahsis · 010 keystroke · 011 taşıma birimi Faz 2 · 012 Supervisor birleştirir · 013 Fly.io + GitHub Actions

## Kuyruk (bağımlılık sırası; kartlar docs/tasks/)
- [x] T-001 / T-001b Faz 0 kararları → ADR'ler
- [x] T-002a `pnpm verify` (4245f13, int/faz0-iskelet'te). Bulgular → T-004: TS 6.0.3'te kal (typescript-eslint <6.1); Node 24 LTS, 26 LTS 2026-10-28 → geçiş değerlendir; CI Node 24 sabitle; eslint/vitest config tsc dışında; `@eslint/js` yok
- [x] T-002b web (Next 16.3.8, React 19.3) · T-002c worker yaşam döngüsü · T-002d compose (PG 17.11, PgBouncer 1.26 transaction, alpine/minio yalnızca yerel, mailpit). Bulgular: worker tsconfig.build.json (T-010); ADR-005 pg-boss 12.36 vs graphile-worker 0.18 → architect (pg-boss transaction-mode pooler'a uygun görünüyor); Docker Hub 429 → CI'da mirror.gcr.io; nvm yolu /opt/nvm
- [x] T-003 CI (`ci.yml`: verify, infra, secrets, deps; A-36 audit istisnası bitiş 2026-10-19). Takip: lockfile bütünlüğü (el ile düzenlenmiş lockfile audit'i kandırabilir) → T-008 ek kartı
- [x] T-004 STACK + MAP + `scripts/check-docs.mjs` (#3). Bulgu: T-008g check-docs'u `check:all`'a bağlar; doğrudan bağımlılık STACK'te yoksa hata önerisi
- [x] T-005a ✓ (#5) · T-005b ✓ (#6, postgres.js 3.4.9 + drizzle 0.45.3, prepare:false A-öneri) · T-005c ✓ (#7, AC-05 pool1/2 + AC-28 PASS) → paket incelemesi → `main`. Takipler: T-005e CI'da pool 1 koşusu; `@wms/db/internal` `sql` dışa verimi; DrizzleQueryError parametreleri loga (G-09) → gözlem kartı; DB_CLIENT_SETTINGS composition root (Faz 1); tests/**/*.ts typecheck kapsamı + STACK testcontainers/pg kilidi → T-004b; T-005c kartı mutasyonu `WITH CHECK (true)`
- [x] T-005d Neon gerçek pooler koşusu (koşu 3 PASS, 2026-10-05) · (GitHub Actions; sırlar: `NEON_API_KEY`, değişken `NEON_PROJECT_ID`) → T-005e CI eşdeğerliği → `int/faz0-neon`
- [x] T-006 PILOT.md — varsayımsal profil (Q-12)
- [x] T-007, T-008a/b/c/h/i, T-014 (#8). Bilinen risk: int kapsam sahtelemesi (m9), PR gövdesinde gizli HTML
- [ ] Takip: lockfile bütünlüğü (T-003 MINOR) → T-008i
- [x] T-008d/e/f/g (#20). Açık MINOR'lar → T-008j
- [~] T-009a — kimlik/CODEOWNERS kısmı iptal (ADR-012 rev.); kalan: kullanıcı isterse `main` branch protection · T-009b AC-43/44'ün yeni tanımına göre
- [x] T-010 Fly staging (#11, #12, #13 main'de; ilk dağıtım yeşil). Takipler: `not found` desenini daralt, taban imaj güncelleme süreci, PR CI'da docker build

## Faz 1 plan takipleri (security-reviewer @8335c6b MINOR; ilgili kart başlamadan küçük docs PR'ı)
- m1 dolaylı ADMIN: `pg_has_role(current_user,'wms_identity_probe','MEMBER WITH ADMIN OPTION')=false` (T-103/T-105 öncesi) · m2 T-108 yerel/CI'da beklenmeyen ADMIN satırı FAIL · m3 demo bekçi işlevi `search_path` + `proowner`/`prosecdef` assertion · m4 ADR-016 açık risk (reset-password tx paylaşmaz) için Q kaydı + karar (T-117b öncesi) · m5 T-105:26, T-101b:18, ADR-015:29 artıkları
- T-110 #28 MINOR: href yalnızca uygulama içi yol, Esc yükleniyorken, STACK lucide satırı, odak/48px T-131
- T-102 MINOR-1 risk kaydı: wms_app security_events'te tenant'tan bağımsız tüm kullanıcıların ip/user_agent/detail'ini okur (kart gereği) — T-113'te sütun/işlevle daraltma değerlendirilir
- T-005d düz parola yeniden denemesi (Supervisor kararı 2026-10-05): kabul edilen risk — parola koşuya özel, geçici dal silinir; Neon `log_statement`/`pg_stat_statements` metni ve dal silme başarısızsa rolün yaşaması bilinen risk; T-005f Q-06 kaydına işlenir
- İnceleme takipleri (kart başlamadan ilgili karta işlenir): T-112 ← reauth.* olaylarını yalnızca wms_auth yazabilsin (T-102 @77317fe) · T-121 ← withNewTenant imzası (tenantId içeride, `created`, ad değişiminden sonra tekrar → IDEMPOTENCY_MISMATCH), SLUG_TAKEN hata kodu 15-engineering'e · T-105 ← Neon'da FORCE RLS altında operasyon rolü tenant bağlamı, ALLOWED_DB_LEVEL_SETTINGS, pg_subscription/largeobject okunabilirliği · app-settings bekçisini check:all'a bağlama kartı · T-131 ← ConfirmDialog çift Esc · OPEN_QUESTIONS A-xx ← T-103 varsayımları (tenants yaratıcı alanları nullable, tenant_settings varsayılanları, invitations.created_at yok, wms_app sütun GRANT'ları, süresi dolmuş davet T-117'de iptal)
- Son inceleme takipleri (özet): T-005e imaj @sha256 sabitleme + neon'da sürüm assertion'ı yok · PG18 AFTER tetikleyicileri kuyruğa alan rolle (defter/audit kartlarına) · T-101c 0·0·3 · T-111 0·0·5 (require takma adı → bekçi kartı; tests/integration'da auth importu Q; T-112'de ham istemci yalnızca global auth tablolarında) · T-107 son MAJOR c3f711a'da düzeltildi
- T-101 Faz 0 kapısından önce başlatıldı (Supervisor kararı: zaman kullanımı); birleştirme kapıdan sonra

## Engeller
- E-03 kapandı (2026-10-06 07:55Z): kullanıcı repoyu PUBLIC yaptı; Actions koşuyor (#39–#42 CI yeşil).
- U-06 kapandı (2026-10-05): kullanıcı `FLY_API_TOKEN`'ı uygulama kapsamlı deploy token'la değiştirdi; doğrulama dispatch koşusu yeşil https://github.com/shosgoren/2027-WMS-1/actions/runs/37356910665. Eski org token'ın iptali kullanıcıya hatırlatıldı.
- U-07 kapandı (2026-10-05): kullanıcı `NEON_API_KEY`'i `etkin-wms` proje kapsamlı anahtarla değiştirdi; doğrulama ilk neon-spike koşusunda.
- U-01 Neon: kullanıcı 2026-10-05 tamamladığını bildirdi (proje etkin-wms, AWS Frankfurt, PG 17; `NEON_API_KEY` sırrı + `NEON_PROJECT_ID` değişkeni). Doğrulama T-005d ilk Actions koşusunda → T-005d
- U-02 Fly.io: kullanıcı 2026-10-05 tamamladığını bildirdi (hesap + kart + `FLY_API_TOKEN` repo sırrı). Doğrulama T-010 ilk dağıtım koşusunda
- U-03 Resend: kullanıcı 2026-10-05 `RESEND_API_KEY` repo sırrını ekledi; alan adı bildirilmedi → doğrulanmış alan adı olana kadar Resend yalnızca hesap sahibinin adresine `onboarding@resend.dev`'den gönderebilir; diğer alıcılar için davet/şifre bağlantısı ekranda gösterilir (ADR-013, kapalı bayrak). Faz 1 e-posta kartında
- U-04 Q-07 hukukçu onayı → yalnızca gerçek kişisel veriyle prod için; demo için engel değil
- E-02 (2026-10-05 19:24Z→): GitHub barındırılan runner kapasitesi — işlerin çoğu "not acquired by Runner of type hosted" ile iptal; bazı işler (verify, secrets) koşuyor → kota/ödeme değil, kullanıcı işi değil. Yalnızca runner'a hiç atanmamış işler yeniden koşturulur; CI yeşil olmadan birleştirme yok. Docs-only int/faz1-plan push'larını grupla (kuyruk yükü).
- E-01 kapandı: bu ortamda npm/Docker Hub açık.

## İnceleme takipleri (security-reviewer faz0-iskelet, MINOR — ilgili kartta ele alınır)
- T-005b/d: uygulama süreçleri yalnızca `DATABASE_URL` alır, `DATABASE_URL_DIRECT` (süper kullanıcı) yalnızca migration (RLS bypass yolu) · AC-05 session-level `set_config` sızıntısını açıkça kapsar · T-005a `test:int` betiği eklenir
- T-003: compose imajları digest ile sabitlenir · compose parola denetimine `\n`/`\r` · worker log maskeleme (DB/kuyruk eklenince) · ADR-006 adaptörü: bucket oluşturma + root olmayan erişim anahtarı

## Açık sorular (özet; detay OPEN_QUESTIONS.md)
Q-01…Q-06 Neon teknik alanları (T-005) · Q-07 KVKK hukukçu onayı · Q-12 pilot değerleri · Q-13 pilot hacim tanımı · Q-10 Neon sır kanalı (→ GitHub repo sırları, ADR-013) · Q-11 BullMQ eşikleri
