# STATE (≤80 satır — her görev sonunda Supervisor günceller)

**Oturum kilidi:** session_01C59FRaUynaDdhNGZoRbKsY · 2026-10-05T16:30Z (zamanlanmış oturum: kilit 3 saatten yeniyse ve başka oturumunsa hiçbir şey yapmadan çık; değilse kendi kimliğinle yenile, her push'ta zamanı güncelle)
**Faz:** 0 — Kararlar & iskelet
**Aktif görev:** T-002b (worktree ../wt-T-002b) ∥ T-002d (../wt-T-002d) → `int/faz0-iskelet` (STATE'in güncel kopyası bu dalda)
**Son tamamlanan:** ADR-012 rev. (kullanıcı PR incelemez; Supervisor birleştirir; ADR-001…012 kabul) · ADR-013 barındırma (Fly.io fra + Tigris, dağıtım GitHub Actions'tan)
**Sonraki adım:** T-002a → T-002b/c/d → `int/faz0-iskelet`'i `main`'e PR + birleştirme kapısı → T-003 CI. Neon/Fly sırları gelince T-005d/e ve dağıtım kartları.

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
- [ ] T-002b Web iskeleti · T-002c Worker iskeleti (seri, lock dosyası) · T-002d docker compose (T-002a sonrası paralel)
- [ ] T-003 CI hattı → `int/faz0-ci` (iskelet birleşince)
- [ ] T-004 STACK sürüm kilidi + MAP → `int/faz0-docs` (iskelet birleşince)
- [ ] T-005a entegrasyon test düzeneği → T-005b `withTenant` (security-reviewer zorunlu) → T-005c AC-05/AC-28 (qa-verifier) → `int/faz0-pooler`
- [ ] T-005d Neon gerçek pooler koşusu (GitHub Actions; sırlar: `NEON_API_KEY`, değişken `NEON_PROJECT_ID`) → T-005e CI eşdeğerliği → `int/faz0-neon`
- [x] T-006 PILOT.md — varsayımsal profil (Q-12)
- [ ] T-007 `pnpm test:ac` → T-008a/b/c bekçiler → `int/faz0-bekciler-1` (T-008c `check:protected` ADR-012 rev. `APPROVED-BY` kuralına göre; kart güncellenecek)
- [ ] T-008d/e/f/g bekçiler → `int/faz0-bekciler-2`
- [~] T-009a — kimlik/CODEOWNERS kısmı iptal (ADR-012 rev.); kalan: kullanıcı isterse `main` branch protection · T-009b AC-43/44'ün yeni tanımına göre
- [ ] Yeni kart (architect yazacak): T-010 Fly dağıtım hattı (staging otomatik, prod etiketle; `FLY_API_TOKEN`)

## Engeller / kullanıcı eylemi bekleyenler (2026-10-05 tek mesajla istendi)
- U-01 Neon: proje (AWS Frankfurt, PG 17) + `NEON_API_KEY` sırrı + `NEON_PROJECT_ID` değişkeni GitHub'da → T-005d
- U-02 Fly.io: hesap + kart + `FLY_API_TOKEN` sırrı → T-010
- U-03 (isteğe bağlı) Resend `RESEND_API_KEY` (+ alan adı) → Faz 1 e-posta; yoksa bağlantı ekranda gösterilir
- U-04 Q-07 hukukçu onayı → yalnızca gerçek kişisel veriyle prod için; demo için engel değil
- E-01 kapandı: bu ortamda npm/Docker Hub açık.

## Supervisor kararı bekleyen tasarım noktaları (T-006…T-009 kart raporu)
- T-007 `test:ac --ci`: PR'da mevcut `@AC` testleri koşar, `NO_TEST` yalnızca kapısı geçilmiş fazlar için hata → Supervisor T-007'de kesinleştirir
- `check:pilot` `check:all`'a girmez; Faz 0 kapısında ayrıca denetlenir
- Karantina: `skip` hiç serbest değil; karantinalı test koşar, kapıyı kırmaz

## Açık sorular (özet; detay OPEN_QUESTIONS.md)
Q-01…Q-06 Neon teknik alanları (T-005) · Q-07 KVKK hukukçu onayı · Q-12 pilot değerleri · Q-13 pilot hacim tanımı · Q-10 Neon sır kanalı (→ GitHub repo sırları, ADR-013) · Q-11 BullMQ eşikleri
