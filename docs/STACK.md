# Teknoloji ve Sürüm Kilidi (ajanlar bu sürümlere göre kod yazar; G-04)

## Kilitli sürümler
Kaynak sözdizimi: `<dosya>#<json.yolu>` (package.json alanı) veya `docker-compose.yml#<servis>` (imaj = `<paket/imaj>:<sürüm>`). Sürüm hücresi `—` ile başlayan satır henüz kilitli değildir; işaret neyin beklendiğini söyler, sürüm uydurulmaz. Diğer her satır `node scripts/check-docs.mjs` ile kaynağına **birebir** karşılaştırılır (`^`/`~` aralığı = hata).

| bileşen | paket/imaj | sürüm | kaynak | ADR |
|---|---|---|---|---|
| Node.js (engines) | node | >=24 <25 | package.json#engines.node | ADR-001 |
| pnpm | pnpm | 10.28.0 | package.json#packageManager | ADR-001 |
| TypeScript | typescript | 6.0.3 | package.json#devDependencies.typescript | ADR-001 |
| Node tipleri | @types/node | 24.19.1 | package.json#devDependencies.@types/node | ADR-001 |
| ESLint | eslint | 10.12.0 | package.json#devDependencies.eslint | |
| typescript-eslint | typescript-eslint | 8.71.0 | package.json#devDependencies.typescript-eslint | |
| Vitest | vitest | 5.0.3 | package.json#devDependencies.vitest | |
| Next.js | next | 16.3.8 | apps/web/package.json#dependencies.next | ADR-001 |
| Next.js ESLint eklentisi | @next/eslint-plugin-next | 16.3.8 | apps/web/package.json#devDependencies.@next/eslint-plugin-next | ADR-001 |
| React | react | 19.3.0 | apps/web/package.json#dependencies.react | ADR-001 |
| React DOM | react-dom | 19.3.0 | apps/web/package.json#dependencies.react-dom | ADR-001 |
| React tipleri | @types/react | 19.3.0 | apps/web/package.json#devDependencies.@types/react | ADR-001 |
| React DOM tipleri | @types/react-dom | 19.3.0 | apps/web/package.json#devDependencies.@types/react-dom | ADR-001 |
| React (packages/ui) | react | 19.3.0 | packages/ui/package.json#dependencies.react | ADR-001, T-110 |
| React DOM (packages/ui) | react-dom | 19.3.0 | packages/ui/package.json#dependencies.react-dom | ADR-001, T-110 |
| React tipleri (packages/ui) | @types/react | 19.3.0 | packages/ui/package.json#devDependencies.@types/react | ADR-001, T-110 |
| React DOM tipleri (packages/ui) | @types/react-dom | 19.3.0 | packages/ui/package.json#devDependencies.@types/react-dom | ADR-001, T-110 |
| PostgreSQL (yerel/CI) | postgres | 18.6-trixie | docker-compose.yml#postgres | ADR-004; digest sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722 |
| PgBouncer (yerel/CI, transaction mode) | edoburu/pgbouncer | v1.26.0-p0 | docker-compose.yml#pgbouncer | ADR-004 |
| MinIO (yerel/CI) | alpine/minio | RELEASE.2025-10-15T17-29-55Z | docker-compose.yml#minio | ADR-006 |
| Mailpit (yerel/CI) | axllent/mailpit | v1.31.4 | docker-compose.yml#mailpit | |
| Testcontainers | testcontainers | 12.2.0 | package.json#devDependencies.testcontainers | |
| node-postgres (yalnızca test/harness) | pg | 8.23.1 | package.json#devDependencies.pg | |
| node-postgres tipleri | @types/pg | 8.23.1 | package.json#devDependencies.@types/pg | |
| Drizzle ORM | drizzle-orm | 0.45.3 | packages/db/package.json#dependencies.drizzle-orm | ADR-003; Neon koşu 3 (T-005d) |
| PostgreSQL sürücüsü (postgres.js) | postgres | 3.4.9 | packages/db/package.json#dependencies.postgres | ADR-003; Neon koşu 3 (T-005d) |
| PostgreSQL (Neon) | — | — sağlayıcı yönetir, kilitlenemez; gözlenen 18.6 (proje pg_version 18, Q-05, T-005d koşu 3) | | ADR-004 |
| Neon pooler | — | — PgBouncer transaction (belge); sürüm gözlenemedi (Q-02 açık) | | ADR-004 |
| Prepared statement ayarı | — | — `prepare=false` (üretim, T-005d kapı koşusu; Q-04 kapandı); kod kaynağı `packages/db` `DB_CLIENT_SETTINGS` | | ADR-004 |
| Drizzle ORM (packages/auth, yalnızca `sql` etiketi) | drizzle-orm | 0.45.3 | packages/auth/package.json#dependencies.drizzle-orm | ADR-003 |
| Drizzle ORM (packages/domain, yalnızca `sql` etiketi) | drizzle-orm | 0.45.3 | packages/domain/package.json#dependencies.drizzle-orm | ADR-003 |
| Better Auth (kimlik katmanı) | better-auth | 1.7.7 | packages/auth/package.json#dependencies.better-auth | ADR-014 |
| Better Auth (web istemcisi, `better-auth/react`) | better-auth | 1.7.7 | apps/web/package.json#dependencies.better-auth | ADR-014, T-118 |
| Argon2id parola özeti | @node-rs/argon2 | 2.2.1 | packages/auth/package.json#dependencies.@node-rs/argon2 | ADR-014 |
| Argon2id (worker, demo hesap bağdaştırıcısı; pakete gömülmez, imajda yerel ikili) | @node-rs/argon2 | 2.2.1 | apps/worker/package.json#dependencies.@node-rs/argon2 | T-123a, A-63 |
| Kuyruk kütüphanesi | pg-boss | 12.36.0 | packages/queue-adapter/package.json#dependencies.pg-boss | ADR-005 |
| Worker paketleyici (esbuild; yalnızca derleme) | esbuild | 0.28.2 | apps/worker/package.json#devDependencies.esbuild | ADR-013 |
| TanStack Query / Virtual | @tanstack/* | — ilk kullanan kart | | |
| S3 istemcisi (yalnızca `packages/storage`) | @aws-sdk/client-s3 | 3.1146.0 | packages/storage/package.json#dependencies.@aws-sdk/client-s3 | ADR-006, T-125 |
| S3 imzalı URL | @aws-sdk/s3-request-presigner | 3.1146.0 | packages/storage/package.json#dependencies.@aws-sdk/s3-request-presigner | ADR-006, T-125 |
| MinIO STS (yalnızca test düzeneği: root olmayan geçici anahtar) | @aws-sdk/client-sts | 3.1146.0 | packages/storage/package.json#devDependencies.@aws-sdk/client-sts | T-125 |
| Zod | zod | 4.6.5 | packages/shared/package.json#dependencies.zod | |
| Zod (kuyruk bağdaştırıcısı) | zod | 4.6.5 | packages/queue-adapter/package.json#dependencies.zod | ADR-005 |
| Zod (web Server Action girdi doğrulaması) | zod | 4.6.5 | apps/web/package.json#dependencies.zod | T-109b |
| Drizzle ORM (kuyruk bağdaştırıcısı: `sql`) | drizzle-orm | 0.45.3 | packages/queue-adapter/package.json#dependencies.drizzle-orm | ADR-005 |
| Tailwind CSS | tailwindcss | 4.3.3 | apps/web/package.json#dependencies.tailwindcss | T-109 |
| Tailwind PostCSS eklentisi | @tailwindcss/postcss | 4.3.3 | apps/web/package.json#dependencies.@tailwindcss/postcss | T-109 |
| Shadcn/Radix | — | — ilk kullanan kart | | |
| Lucide | lucide-react | 1.52.0 | packages/ui/package.json#dependencies.lucide-react | T-110 |
| next-intl | next-intl | 4.14.9 | apps/web/package.json#dependencies.next-intl | T-109, ADR-002 |

Sürüm notları (kaynak: kurulu `package.json`/`pnpm-lock.yaml`, 2026-10-05):
- **Kapsam kuralı (T-004b):** Workspace'lerin (`pnpm-lock.yaml#importers`) `package.json` dosyalarındaki her doğrudan bağımlılık (`dependencies`, `devDependencies`, `optionalDependencies`; `workspace:` hariç) bu tabloda kaynağıyla kilitli bir satıra sahip olmalıdır; eksikse `node scripts/check-docs.mjs` FAIL verir.
- **S3 istemcisi seçimi (T-125):** `@aws-sdk/client-s3` (Apache-2.0; npm son kararlı 3.1146.0, 2026-10-06) seçildi; `aws4fetch` (MIT, 1.0.20) küçük ama imzalı URL'yi elle kurmayı ve S3 hata/XML ayrıştırmayı bize bırakır, STS/çok parçalı yükleme yok. SDK'nın boyutu yalnızca sunucu/worker paketini etkiler (istemci bundle'ına girmez). Tüm `@aws-sdk/*` sürümleri aynı tam sürümde kilitli. Yalnızca `packages/storage` import eder (ADR-006).
- **pg-boss rolleri (T-115c):** gönderen (web) `DATABASE_URL` = `wms_app` (yalnızca `pgboss.job` INSERT/SELECT; RLS ile kendi tenant'ı); tüketici (worker) `DATABASE_URL_WORKER` = `wms_worker` (`pgboss.job` SELECT/INSERT/UPDATE/DELETE; fetch/complete/fail/retry). Yetkiler ve RLS `installQueueSchema` ile (migration rolü) verilir; roller 01-roles.sh (Neon: T-105, düz parola, Q-06). Yeni rol için yerel volume'u bir kez `docker compose down -v` ile sıfırlayın.
- **pg 8.23.1:** yalnızca testlerde kullanılır (entegrasyon düzeneği: rol/RLS probu, PgBouncer yönetimi); uygulama sürücüsü postgres.js'tir.
- **TypeScript 6.0.3'te kalınır:** typescript-eslint 8.71.0'ın desteklediği TypeScript aralığı `<6.1.0`; TS yükseltmesi typescript-eslint desteğini bekler.
- **Node.js:** 24 Active LTS (`engines` `>=24 <25`). Node 26 LTS'e 2026-10-28'de geçer; geçiş ayrı kartla yapılır (`engines`, `@types/node`, CI Node sürümü birlikte).
- **PostgreSQL 18.x:** Neon projesi `pg_version=18`, `server_version` 18.6 (pooled ve doğrudan; T-005d koşu 3: https://github.com/shosgoren/2027-WMS-1/actions/runs/37388724069). Yerel/CI compose `postgres:18.6-trixie` bununla hizalıdır (T-005e). Önceki "PG 17" kaydı (kullanıcı beyanı 2026-10-05) ölçümle düzeltildi. Neon küçük sürümü sağlayıcı yönetir; ana sürüm değişikliği yeniden spike tetikleyicisidir (ADR-004).
- **PgBouncer 1.26.0** yalnızca yerel/CI içindir. Neon pooler'ı da transaction-mode PgBouncer'dır (belge: https://neon.com/docs/connect/connection-pooling); Neon PgBouncer sürümü gözlenemedi, bu yüzden sürüm eşdeğerliği doğrulanamadı (Q-02 açık). Compose `max_prepared_statements=1000`, `max_client_conn=10000`, `query_wait_timeout=120` Neon belgesindeki değerlerle aynıdır; sunucu havuz boyutu farklıdır (compose 1–2 AC-05 için; Neon `0.9 × max_connections`, ayarlanamaz — Q-31).
- **Sürücü:** postgres.js 3.4.9 + drizzle-orm 0.45.3, `prepare=false`; Neon pooler'ı arkasında AC-05/AC-28 PASS (T-005d koşu 3). Bu paketlerin ana sürüm değişikliği yeniden spike tetikleyicisidir (ADR-004).

## Karar durumu
| Katman | Seçim | ADR (durum) |
|---|---|---|
| Uygulama mimarisi | Next.js App Router monolit + ayrı kalıcı worker, pnpm monorepo, ortak `packages/domain` | ADR-001 (kabul) |
| ORM | Drizzle 0.45.3 + postgres.js 3.4.9, `prepare=false` (Q-03, Q-04 kapandı; T-005d) | ADR-003 (kabul) |
| DB | Neon PostgreSQL 18 (`aws-eu-central-1`) + transaction-mode PgBouncer pooler; teknik alanlar T-005d ile dolduruldu, pooler sürümü gözlenemedi (Q-02) | ADR-004 (kabul) |
| Kuyruk | Postgres kuyruğu (Faz 0–4); kütüphane pg-boss (ADR-005 eki) | ADR-005 (kabul) |
| Dosya | S3 uyumlu özel bucket; yerelde MinIO; prod sağlayıcısı ADR-007 | ADR-006 (kabul) |
| Web arayüzü | TypeScript strict, Tailwind, Shadcn/Radix, Lucide (lucide-react 1.52.0, T-110) | — (Shadcn/Radix: ilk kullanan kart) |
| Durum/veri | TanStack Query, TanStack Virtual, Zustand (gerektiğinde) | — |
| Validasyon / i18n | Zod / next-intl | — |
| Test | Vitest, Testcontainers, Playwright, k6, fast-check | — |
| Gözlem | OpenTelemetry + Sentry (veya eşdeğeri) | — |
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
