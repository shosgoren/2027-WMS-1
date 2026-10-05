# Kod Haritası (≤60 satır; her faz sonunda scout günceller)
```
apps/web        Next.js App Router: (auth) (dashboard) (mobile) (superadmin) api/
apps/worker     BullMQ işçileri: import, export, ocr, notify, outbox-relay, deletion, consistency-check
packages/domain İş kuralları ve komutlar: identity, inventory, receipts, orders, warehouse, counts, metadata, billing, integrations, reporting
packages/db     Şema, migration, tenant-scoped transaction yardımcıları, RLS testleri
packages/shared Zod şemaları, hata kodları, tipler, i18n anahtar tipleri
packages/ui     Shadcn tabanlı ortak bileşenler, dynamic-form, scanner, virtualized
tests/          integration (Testcontainers), e2e (Playwright), load (k6)
docs/           spec/, adr/, tasks/, agents/, STATE, MAP, INVARIANTS, ACCEPTANCE, PHASES
```
