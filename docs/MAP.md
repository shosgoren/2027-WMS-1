# Kod Haritası (≤60 satır; her faz sonunda scout günceller)
Durum: `var` = yol repoda mevcut; `planlı: <kart>` = henüz yok, ilgili kart açar. `node scripts/check-docs.mjs` her ikisini doğrular.

| yol | durum | açıklama |
|---|---|---|
| apps/web/ | var | Next.js App Router; şimdilik `app/api/health`. Route grupları (auth) (dashboard) (mobile) (superadmin) ilk kullanan kartta |
| apps/worker/ | var | Kalıcı worker süreci (yaşam döngüsü); kuyruk ADR-005 (Postgres kuyruğu), henüz iş yok |
| packages/db/ | var | Drizzle istemcisi, `withTenant`, şema, migration, RLS testleri |
| packages/domain/ | planlı: ilk kullanan kart | İş kuralları ve stok komutları (G-01): identity, inventory, receipts, orders, warehouse, counts, metadata, billing, integrations, reporting |
| packages/shared/ | planlı: ilk kullanan kart | Zod şemaları, hata kodları, tipler, i18n anahtar tipleri, `JobQueue` arayüzü |
| packages/queue-adapter/ | planlı: ADR-005 eki | Kuyruk sağlayıcı kütüphanesinin tek import noktası |
| packages/ui/ | planlı: ilk kullanan kart | Shadcn tabanlı ortak bileşenler, dynamic-form, scanner, virtualized |
| tests/integration/ | var | Testcontainers PostgreSQL entegrasyon testleri (`pnpm test:int`) |
| tests/e2e/ | planlı: ilk kullanan kart | Playwright uçtan uca testler |
| tests/load/ | planlı: ilk kullanan kart | k6 yük testleri |
| infra/ | var | Yerel/CI altyapı yapılandırması |
| infra/postgres/init/ | var | PostgreSQL ilk açılış betikleri (roller) |
| infra/pgbouncer/ | var | PgBouncer yapılandırması (transaction mode) |
| docker-compose.yml | var | Yerel altyapı: postgres, pgbouncer, minio, mailpit |
| .env.example | var | Ortam değişkeni şablonu (sır içermez) |
| scripts/ | var | Repo betikleri: `verify`, `compose-smoke`, `check-docs` |
| .github/workflows/ | var | CI iş akışları (`ci.yml`: verify, infra, secrets, deps — T-003) |
| docs/ | var | spec/, adr/, tasks/, agents/, STATE, MAP, STACK, INVARIANTS, ACCEPTANCE, PHASES |
