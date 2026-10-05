# 01 — Kapsam, Mimari ve Ölçek

## Kapsam
Çok müşterili depo/stok yönetimi: mal kabul, yerleştirme, rezervasyon, toplama, sevk, transfer, iade, sayım, raporlama. Sektör şablonları: tekstil, gıda, hırdavat, e-ticaret. Cari kartlar müşteri/tedarikçi referansıdır. Tam muhasebe, e-belge düzenleme ve MRP kapsam dışıdır (entegrasyon). WMS sevk belgesi, ayrıca entegre edilmeden resmî e-İrsaliye yerine geçmez.

## Mimari
- **Modüler monolit, pnpm monorepo:** `apps/web` (Next.js), `apps/worker` (uzun ömürlü işçi süreci), `packages/domain` (iş kuralları), `packages/db`, `packages/shared`, `packages/ui`. Web ve worker **aynı domain komutlarını** paylaşır; stok/yetki kuralı ekranlara veya worker'a kopyalanmaz.
- Route Handlers ve Server Actions ince giriş katmanıdır; domain servislerini çağırır.
- Worker'lar istek süreçlerinden ayrı, serverless fonksiyonlarda değil kalıcı süreçte çalışır (import, export, OCR, bildirim, outbox relay, silme, tutarlılık kontrolü).
- PostgreSQL stok doğruluğunun tek kaynağıdır; cache/kuyruk/arama türevdir.
- Önceki v1.3 seçimi (NestJS API + RabbitMQ + Azure Blob) ile bu belgedeki (Next.js + Postgres kuyruğu/BullMQ + S3 uyumlu) arasındaki seçim **ADR-001/005/006**'da yapılır; kuyruk (`JobQueue`) ve dosya erişimi (`ObjectStorage`) arayüz arkasında soyutlanır ki değişim domain'i etkilemesin.

## Ölçek ve hizmet hedefleri
100.000 tenant / 1.000.000 bağlı kullanıcı **uzun vadeli** hedeftir, başlangıç kapasitesi değildir. Bağlı oturum, aktif kullanıcı, eş zamanlı istek ve saniyedeki stok işlemi ayrı ölçülür.

| Ölçüt | Başlangıç hedefi | Koşul |
|---|---|---|
| Aylık kesinti | ≤ 43 dakika | Kritik API'ler (planlı bakım hariç, ayrıca duyurulur) |
| Liste/detay API | p95 ≤ 500 ms | Sunucu tarafı, tanımlı veri hacmi |
| Stok kesinleştirme | p95 ≤ 1 sn | Haricî çağrı olmadan |
| RPO / RTO | ≤ 15 dk / ≤ 4 saat | Felaket senaryosu |

Faz 0'da yük profili sayısallaştırılır (aktif tenant, tenant başına SKU/hareket, sıcak satır yoğunluğu, okuma-yazma oranı, RPS, günlük dosya hacmi). Tenant kotası ve kuyruk adaleti gürültülü komşuyu sınırlar. Bölümleme, read replica, tenant'ı ayrı kümeye taşıma ölçüme göre devreye alınır. Yetki ve güncel stok kontrolü replikadan yapılmaz.
