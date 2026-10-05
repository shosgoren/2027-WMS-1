# 15 — Mühendislik Standartları

## Kod
- TypeScript strict; `any` yalnızca gerekçeli. Domain kodu framework'ten bağımsız (`packages/domain`); giriş katmanı ince.
- UI domain servisini atlayarak stok/yetki tablosu yazamaz; web, worker, import aynı komutları kullanır.
- Commit: Conventional Commits; PR açıklaması T-xxx + AC listesi.

## API sözleşmesi
Hata kodları: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `TENANT_SUSPENDED`, `TENANT_CLOSING`, `COUNT_LOCK_ROW_MISSING`, `ENTITLEMENT_REQUIRED`, `NOT_FOUND`, `VERSION_CONFLICT`, `IDEMPOTENCY_MISMATCH`, `INSUFFICIENT_STOCK`, `TRACKING_VIOLATION`, `LOCATION_LOCKED`, `REVERSAL_BLOCKED`, `PERIOD_CLOSED`, `RATE_LIMITED`. Cursor pagination, boyut sınırları, sürümleme politikası dokümante.

## Test stratejisi
| Katman | Araç | Zorunlu olduğu yer |
|---|---|---|
| Unit | Vitest | Domain kuralları |
| Özellik tabanlı | fast-check | Defter = bakiye, dönüşüm, ters kayıt toplamları |
| Entegrasyon | Testcontainers PostgreSQL, `wms_app` rolü | RLS, concurrency, idempotency, migration |
| E2E | Playwright (masaüstü + mobil viewport) | Kritik akışlar |
| Yük | k6 | Faz 4P kapısı (AC-24) |
Lint/unit geçmesi AC testlerinin yerini tutmaz.

## DB sözleşmesi
`(tenant_id, code)` benzersiz; `(tenant_id, id)` benzersiz + bileşik FK; NOT NULL/CHECK; `numeric` miktar; belge `version` sütunu (optimistic concurrency); append-only tablolarda `created_xid xid8` (I-16); kalıcı işlem kimliği; sürümlü metadata; stok boyutu NULL-safe benzersiz. İndeksler tenant önekli ve sorgu şekline göre. Tenant silme kontrolsüz `ON DELETE CASCADE` zincirine bırakılmaz.

Örnek RLS (politika örneği, doğrulanmış migration değil):
```sql
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_tenant_scope ON items FOR ALL TO wms_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```
Akış: `BEGIN` → `SELECT set_config('app.current_tenant_id', $1, true)` → aynı bağlantıda sorgular → `COMMIT/ROLLBACK`. `$1` doğrulanmış üyelikten. ORM havuzu üzerinde entegrasyon testiyle kanıtlanır (AC-05).
