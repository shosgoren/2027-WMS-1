# Karar Dizini (tek satır / ADR)
Format: `ADR-xxx | tarih | karar | durum (önerildi/kabul/yerine geçti)`
ADR-001 | 2026-10-05 | Next.js App Router monolit + ayrı kalıcı worker, pnpm monorepo, ortak `packages/domain` (v1.3 NestJS API reddedildi) | önerildi
ADR-002 | 2026-10-05 | İngilizce kod/tip/DB/API, Türkçe UI (next-intl), eşleme `GLOSSARY.md` (v1.3 Türkçe-first reddedildi; katalog çevirisi ayrı kart) | önerildi
ADR-003 | 2026-10-05 | ORM: Drizzle (Prisma reddedildi; gerekçe `STACK.md §ADR-003`) | önerildi
ADR-004 | 2026-10-05 | PostgreSQL: Neon (yönetilen) + Neon pooler; bölge/pooler sürümü/sürücü/prepared statement T-005 ile doldurulacak (Q-01…Q-06) | önerildi
ADR-005 | 2026-10-05 | Kuyruk: Postgres kuyruğu (pg-boss/graphile-worker seçimi T-002), `JobQueue` arayüzü; BullMQ geçiş eşikleri Q-11 (v1.3 RabbitMQ reddedildi) | önerildi
ADR-006 | 2026-10-05 | Dosya: S3 uyumlu özel bucket, `ObjectStorage` arayüzü, yerelde MinIO (v1.3 Azure Blob reddedildi) | önerildi
ADR-007 | 2026-10-05 | Bölge: AB + KVKK standart sözleşmeyle aktarım (varsayım A-02); prod öncesi hukukçu onayı şart (Q-07) | önerildi
ADR-008 | 2026-10-05 | Ödeme sağlayıcısı ve e-Arşiv entegratörü Faz 4S'e ertelendi | önerildi
ADR-009 | 2026-10-05 | Rezervasyon: sert tahsis (`05 §Rezervasyon ve hareketler`) | önerildi
ADR-010 | 2026-10-05 | Tarama: DataWedge keystroke + `ScannerService`; Enterprise Browser/yerel kabuk pilot cihazına göre yeniden değerlendirilir | önerildi
ADR-011 | 2026-10-05 | Taşıma birimi: `handling_units` + nullable `handling_unit_id` Faz 2'de; akış pilot cevabına göre 3A/3B | önerildi
ADR-012 | 2026-10-05 | Ajan kimliği: ayrı GitHub kimliği (App önerilir) + branch protection + CODEOWNERS=kullanıcı; şu an ayrı kimlik yok, T-009'a kadar main'e yalnızca kullanıcı birleştirir (bilinen risk) | önerildi
