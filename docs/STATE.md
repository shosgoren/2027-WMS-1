# STATE (≤80 satır — her görev sonunda Supervisor günceller)

**Oturum kilidi:** session_01C59FRaUynaDdhNGZoRbKsY · 2026-10-05T16:30Z (zamanlanmış oturum: kilit 3 saatten yeniyse ve başka oturumunsa hiçbir şey yapmadan çık; değilse kendi kimliğinle yenile, her push'ta zamanı güncelle)
**Faz:** 0 — Kararlar & iskelet
**Aktif görev:** `int/faz0-pooler` (T-005a #5, T-005b #6, T-005c #7) paket security-reviewer'da ∥ T-008i (../wt-T-008i → `int/faz0-bekciler-1`). STATE'in güncel kopyası: `int/faz0-bekciler-1`.
**Son tamamlanan:** #4 `int/faz0-ci` → `main` (CI dört iş yeşil). `int/faz0-bekciler-1` (T-007, T-008a/b/c) security-reviewer: BLOCKER 2 · MAJOR 7 · MINOR 9 → T-008h
**Sonraki adım:** T-008h → security-reviewer yeniden → bekciler-1 PR (`APPROVED-BY ... @ <head SHA>`). T-005a → T-005b → T-005c. Sonra T-008d/e/f/g (bekçiler taban daldan koşar) ve T-005d (Neon).

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
- [~] T-005a ✓ (#5) · T-005b ✓ (#6, postgres.js 3.4.9 + drizzle 0.45.3, prepare:false A-öneri) · T-005c ✓ (#7, AC-05 pool1/2 + AC-28 PASS) → paket incelemesi → `main`. Takipler: T-005e CI'da pool 1 koşusu; `@wms/db/internal` `sql` dışa verimi; DrizzleQueryError parametreleri loga (G-09) → gözlem kartı; DB_CLIENT_SETTINGS composition root (Faz 1); tests/**/*.ts typecheck kapsamı + STACK testcontainers/pg kilidi → T-004b; T-005c kartı mutasyonu `WITH CHECK (true)`
- [ ] T-005d Neon gerçek pooler koşusu (GitHub Actions; sırlar: `NEON_API_KEY`, değişken `NEON_PROJECT_ID`) → T-005e CI eşdeğerliği → `int/faz0-neon`
- [x] T-006 PILOT.md — varsayımsal profil (Q-12)
- [~] T-007 ✓ · T-008a ✓ · T-008b ✓ · T-008c ✓ (int/faz0-bekciler-1) → T-008h sertleştirme → paket PR. Bilinen risk m9: int dalında kapsam, birleştirme commit konusu + Supervisor kart düzenlemesiyle genişletilebilir (Supervisor güvenilen taraf)
- [ ] Takip: lockfile bütünlüğü (T-003 MINOR) → T-008i
- [ ] T-008d/e/f/g bekçiler → `int/faz0-bekciler-2`
- [~] T-009a — kimlik/CODEOWNERS kısmı iptal (ADR-012 rev.); kalan: kullanıcı isterse `main` branch protection · T-009b AC-43/44'ün yeni tanımına göre
- [ ] Yeni kart (architect yazacak): T-010 Fly dağıtım hattı (staging otomatik, prod etiketle; `FLY_API_TOKEN`)

## Engeller / kullanıcı eylemi bekleyenler (2026-10-05 tek mesajla istendi)
- U-01 Neon: kullanıcı 2026-10-05 tamamladığını bildirdi (proje etkin-wms, AWS Frankfurt, PG 17; `NEON_API_KEY` sırrı + `NEON_PROJECT_ID` değişkeni). Doğrulama T-005d ilk Actions koşusunda → T-005d
- U-02 Fly.io: hesap + kart + `FLY_API_TOKEN` sırrı → T-010
- U-03 (isteğe bağlı) Resend `RESEND_API_KEY` (+ alan adı) → Faz 1 e-posta; yoksa bağlantı ekranda gösterilir
- U-04 Q-07 hukukçu onayı → yalnızca gerçek kişisel veriyle prod için; demo için engel değil
- E-01 kapandı: bu ortamda npm/Docker Hub açık.

## İnceleme takipleri (security-reviewer faz0-iskelet, MINOR — ilgili kartta ele alınır)
- T-005b/d: uygulama süreçleri yalnızca `DATABASE_URL` alır, `DATABASE_URL_DIRECT` (süper kullanıcı) yalnızca migration (RLS bypass yolu) · AC-05 session-level `set_config` sızıntısını açıkça kapsar · T-005a `test:int` betiği eklenir
- T-003: compose imajları digest ile sabitlenir · compose parola denetimine `\n`/`\r` · worker log maskeleme (DB/kuyruk eklenince) · ADR-006 adaptörü: bucket oluşturma + root olmayan erişim anahtarı

## Supervisor kararı bekleyen tasarım noktaları (T-006…T-009 kart raporu)
- T-007 `test:ac --ci`: PR'da mevcut `@AC` testleri koşar, `NO_TEST` yalnızca kapısı geçilmiş fazlar için hata → Supervisor T-007'de kesinleştirir
- `check:pilot` `check:all`'a girmez; Faz 0 kapısında ayrıca denetlenir
- Karantina: `skip` hiç serbest değil; karantinalı test koşar, kapıyı kırmaz

## Açık sorular (özet; detay OPEN_QUESTIONS.md)
Q-01…Q-06 Neon teknik alanları (T-005) · Q-07 KVKK hukukçu onayı · Q-12 pilot değerleri · Q-13 pilot hacim tanımı · Q-10 Neon sır kanalı (→ GitHub repo sırları, ADR-013) · Q-11 BullMQ eşikleri
