# Karar Dizini (tek satır / ADR)
Format: `ADR-xxx | tarih | karar | durum (önerildi/kabul/yerine geçti)`
ADR-001 | 2026-10-05 | Next.js App Router monolit + ayrı kalıcı worker, pnpm monorepo, ortak `packages/domain` (v1.3 NestJS API reddedildi) | kabul
ADR-002 | 2026-10-05 | İngilizce kod/tip/DB/API, Türkçe UI (next-intl), eşleme `GLOSSARY.md` (v1.3 Türkçe-first reddedildi; katalog çevirisi ayrı kart) | kabul
ADR-003 | 2026-10-05 | ORM: Drizzle (Prisma reddedildi; gerekçe `STACK.md §ADR-003`) | kabul
ADR-004 | 2026-10-05 | PostgreSQL: Neon (yönetilen) + Neon pooler; bölge/pooler sürümü/sürücü/prepared statement T-005 ile doldurulacak (Q-01…Q-06) | kabul (teknik alanlar T-005)
ADR-005 | 2026-10-05 | Kuyruk: Postgres kuyruğu (pg-boss, ek 2026-10-05), `JobQueue` arayüzü; BullMQ geçiş eşikleri Q-11 (v1.3 RabbitMQ reddedildi) | kabul
ADR-006 | 2026-10-05 | Dosya: S3 uyumlu özel bucket, `ObjectStorage` arayüzü, yerelde MinIO (v1.3 Azure Blob reddedildi) | kabul
ADR-007 | 2026-10-05 | Bölge: AB + KVKK standart sözleşmeyle aktarım (varsayım A-02); hukukçu onayı (Q-07) gelmeden gerçek kişisel veriyle prod yok — canlı ortam demo verisiyle | kabul (koşullu)
ADR-008 | 2026-10-05 | Ödeme sağlayıcısı ve e-Arşiv entegratörü Faz 4S'e ertelendi | kabul
ADR-009 | 2026-10-05 | Rezervasyon: sert tahsis (`05 §Rezervasyon ve hareketler`) | kabul
ADR-010 | 2026-10-05 | Tarama: DataWedge keystroke + `ScannerService`; Enterprise Browser/yerel kabuk pilot cihazına göre yeniden değerlendirilir | kabul
ADR-011 | 2026-10-05 | Taşıma birimi: `handling_units` + nullable `handling_unit_id` Faz 2'de; akış pilot cevabına göre 3A/3B | kabul
ADR-012 | 2026-10-05 | Onay kaynağı (rev.): kullanıcı PR incelemez; CI + bekçiler + security-reviewer/qa-verifier geçince Supervisor kendi PR'ını birleştirir; ADR'ler bu kararla kabul; ayrı kimlik/CODEOWNERS yok (bilinen risk) | kabul
ADR-013 | 2026-10-05 | Barındırma: Fly.io `fra` (web + worker süreç grupları) + Tigris; dağıtım yalnızca GitHub Actions'tan, sırlar GitHub repo sırlarında; e-posta Resend | kabul
