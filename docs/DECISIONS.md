# Karar Dizini (tek satır / ADR)
Format: `ADR-xxx | tarih | karar | durum (önerildi/kabul/yerine geçti)`
ADR-001 | 2026-10-05 | Next.js App Router monolit + ayrı kalıcı worker, pnpm monorepo, ortak `packages/domain` (v1.3 NestJS API reddedildi) | kabul
ADR-002 | 2026-10-05 | İngilizce kod/tip/DB/API, Türkçe UI (next-intl), eşleme `GLOSSARY.md` (v1.3 Türkçe-first reddedildi; katalog çevirisi ayrı kart) | kabul
ADR-003 | 2026-10-05 | ORM: Drizzle (Prisma reddedildi; gerekçe `STACK.md §ADR-003`) | kabul
ADR-004 | 2026-10-05 | PostgreSQL: Neon (yönetilen) + Neon pooler; PG 18 (18.6), `aws-eu-central-1`, PgBouncer transaction (sürüm gözlenemedi, Q-02), postgres.js 3.4.9 + drizzle-orm 0.45.3, `prepare=false` (T-005d koşu 3 https://github.com/shosgoren/2027-WMS-1/actions/runs/37388724069) | kabul (teknik alanlar T-005d ile dolduruldu; Q-01/Q-02/Q-06 kısmi açık, Faz 1'i engellemez — ADR-004 Doğrulama)
ADR-005 | 2026-10-05 | Kuyruk: Postgres kuyruğu (pg-boss, ek 2026-10-05), `JobQueue` arayüzü; BullMQ geçiş eşikleri Q-11 (v1.3 RabbitMQ reddedildi) | kabul
ADR-006 | 2026-10-05 | Dosya: S3 uyumlu özel bucket, `ObjectStorage` arayüzü, yerelde MinIO (v1.3 Azure Blob reddedildi) | kabul
ADR-007 | 2026-10-05 | Bölge: AB + KVKK standart sözleşmeyle aktarım (varsayım A-02); hukukçu onayı (Q-07) gelmeden gerçek kişisel veriyle prod yok — canlı ortam demo verisiyle | kabul (koşullu)
ADR-008 | 2026-10-05 | Ödeme sağlayıcısı ve e-Arşiv entegratörü Faz 4S'e ertelendi | kabul
ADR-009 | 2026-10-05 | Rezervasyon: sert tahsis (`05 §Rezervasyon ve hareketler`) | kabul
ADR-010 | 2026-10-05 | Tarama: DataWedge keystroke + `ScannerService`; Enterprise Browser/yerel kabuk pilot cihazına göre yeniden değerlendirilir | kabul
ADR-011 | 2026-10-05 | Taşıma birimi: `handling_units` + nullable `handling_unit_id` Faz 2'de; akış pilot cevabına göre 3A/3B | kabul
ADR-012 | 2026-10-05 | Onay kaynağı (rev.): kullanıcı PR incelemez; CI + bekçiler + security-reviewer/qa-verifier geçince Supervisor kendi PR'ını birleştirir; ADR'ler bu kararla kabul; ayrı kimlik/CODEOWNERS yok (bilinen risk) | kabul
ADR-013 | 2026-10-05 | Barındırma: Fly.io `fra` (web + worker süreç grupları) + Tigris; dağıtım yalnızca GitHub Actions'tan, sırlar GitHub repo sırlarında; e-posta Resend | kabul
