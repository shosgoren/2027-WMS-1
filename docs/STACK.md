# Teknoloji ve Sürüm Kilidi (Faz 0'da kesinleşir; ajanlar bu sürümlere göre kod yazar)
| Katman | Seçim (varsayılan öneri) | Sürüm | ADR |
|---|---|---|---|
| Çalışma zamanı / paket | Node.js LTS, pnpm workspace | Faz 0 | ADR-001 |
| Web | Next.js App Router, TypeScript strict, Tailwind, Shadcn/Radix, Lucide | Faz 0 | ADR-001 |
| Durum/veri | TanStack Query, TanStack Virtual, Zustand (gerektiğinde) | Faz 0 | |
| ORM | Drizzle (öneri) veya Prisma — gerekçe aşağıda; prepared statement ayarı pooler testine göre | Faz 0 | ADR-003 |
| DB | PostgreSQL + transaction pooler | Faz 0 | ADR-004 |
| Kuyruk | Postgres kuyruğu (pg-boss / graphile-worker — Faz 0–4 önerisi) · BullMQ + kalıcı TCP Redis (`noeviction`) · RabbitMQ | Faz 0 | ADR-005 |
| Dosya | S3 uyumlu özel bucket veya Azure Blob | Faz 0 | ADR-006 |
| Validasyon | Zod | | |
| i18n | next-intl | | |
| Test | Vitest, Testcontainers, Playwright, k6, fast-check | | |
| Gözlem | OpenTelemetry + Sentry (veya eşdeğeri) | | |
Kural: Yeni bağımlılık eklemek kart + gerekçe ister; lisans (GPL/AGPL) ve bakım durumu kontrol edilir. Kütüphane belgesi gerektiğinde Context7 kullanılır.

## ADR-003 için doğru gerekçe (ORM)
- Her iki ORM'de de etkileşimli transaction (`db.transaction(tx => …)` / `prisma.$transaction(async tx => …)`) tek bağlantıda çalışır; `set_config` ile RLS her ikisinde de uygulanabilir. "Prisma bağlantı değiştirir" gerekçesi **yanlıştır**, ADR'ye yazılmaz.
- Ortak gerçek risk: callback içinde `tx` yerine global istemciyi (`db.` / `prisma.`) kullanmak → sorgu bağlamsız başka bağlantıda çalışır. Önlem: `withTenant` dışında tenant tablosuna erişimi engelleyen lint kuralı + RLS'in bağlamsız durumda satır döndürmemesi ve yazmayı reddetmesi (I-02).
- Drizzle lehine gerçek nedenler: `FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT`, sıralı kilit gibi ham SQL'i tipli ve şeffaf yazmak kolay; üretilen SQL öngörülebilir; ek sorgu motoru yok.
- Prisma'nın gerçek dezavantajları: etkileşimli transaction'ın varsayılan zaman aşımı kısadır (uzun stok işlemlerinde ayar gerekir); kilit ve kuyruk sorguları büyük ölçüde `$queryRaw`'a düşer.

## ADR-005 için seçenekler (kuyruk)
| Seçenek | Artı | Eksi |
|---|---|---|
| **Postgres kuyruğu** (pg-boss / graphile-worker) | İş, stok işlemiyle **aynı transaction'da** kuyruğa yazılır → outbox = kuyruk; relay ve çift yazma sorunu yok; Redis bağımlılığı yok; `SKIP LOCKED` tabanlı | Yük arttıkça DB'ye ek iş; çok yüksek hacimde ayrı kuyruğa geçiş gerekir |
| BullMQ + Redis | Yüksek hacim, gecikmeli/tekrarlı iş, hız sınırı, tenant adaleti kolay | Outbox relay hop'u gerekir; Redis işletimi |
| RabbitMQ | Olgun yönlendirme, v1.3 seçimi | Ek altyapı, relay hop'u gerekir |
Önerilen yol: Faz 0–4 Postgres kuyruğu, ölçüm eşiği aşılınca (ADR'de sayısal eşik) BullMQ.

**`JobQueue` soyutlaması ilk günden sıkı tutulur:**
- Arayüz `packages/shared` içindedir (`enqueue(tx, job)`, `work(type, handler)`, `schedule`, `cancel`); sağlayıcı kütüphanesi (pg-boss, graphile-worker, bullmq) yalnızca `packages/queue-adapter` içinde import edilebilir — lint kuralı. Domain kodu sağlayıcıya özgü seçenek (öncelik numarası, Redis anahtarı vb.) kullanmaz.
- `enqueue` transaction parametresi alır; Postgres kuyruğunda iş, stok işlemiyle aynı transaction'da yazılır. Broker'a geçildiğinde aynı çağrı outbox'a yazar ve relay devreye girer; domain kodu değişmez.
- Her iki adapter aynı sözleşme testlerinden geçer (AC-16, 22, 23).

**Postgres kuyruğunda yük — doğru teşhis:** `SKIP LOCKED` kendisi WAL üretmez. WAL ve şişkinlik (bloat), iş satırlarının eklenmesi, durum güncellemeleri ve silinmesinden gelir. Bu yüzden:
- **İş birimi belge/olaydır, satır değildir.** 500 satırlı mal kabul veya sayım farkı tek iş (ya da tek olay) üretir; satır başına iş yasak.
- Stok kesinleştirmesinin kendisi kuyruğa bırakılmaz (yalnızca senkron eşiği aşan belgeler, §05 Senkron işlem sınırları); kuyruk yan etkiler içindir: bildirim, export, entegrasyon, rapor.
- Tamamlanan işler kısa süre sonra arşiv tablosuna taşınır/silinir; kuyruk tablosuna agresif autovacuum ayarı verilir.
- BullMQ'ya geçiş eşiği bu ölçümlerle tanımlanır: kuyruk tablosu dead tuple oranı, kuyruk kaynaklı WAL hacmi, iş gecikmesi p95, saniyedeki iş sayısı.
