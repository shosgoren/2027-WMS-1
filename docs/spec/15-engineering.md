# 15 — Mühendislik Standartları

## Kod
- TypeScript strict; `any` yalnızca gerekçeli. Domain kodu framework'ten bağımsız (`packages/domain`); giriş katmanı ince.
- UI domain servisini atlayarak stok/yetki tablosu yazamaz; web, worker, import aynı komutları kullanır.
- Commit: Conventional Commits; PR açıklaması T-xxx + AC listesi.

## API sözleşmesi
Hata kodları: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `TENANT_SUSPENDED`, `TENANT_CLOSING`, `COUNT_LOCK_ROW_MISSING`, `ENTITLEMENT_REQUIRED`, `NOT_FOUND`, `VERSION_CONFLICT`, `IDEMPOTENCY_MISMATCH`, `INSUFFICIENT_STOCK`, `TRACKING_VIOLATION`, `LOCATION_LOCKED`, `REVERSAL_BLOCKED`, `PERIOD_CLOSED`, `RATE_LIMITED`, `INTERNAL`. Cursor pagination, boyut sınırları, sürümleme politikası dokümante.

### Hata sözleşmesi kuralı (T-113, T-133)
- Domain/uygulama hatası `AppError` (`packages/shared/src/errors.ts`) ya da ondan türeyen sınıfla fırlatılır; kod yalnızca `ERROR_CODES` listesindendir. Listede olmayan kod, onu ilk kullanan kartta hem `ERROR_CODES`/`HTTP_STATUS`'a hem bu bölüme eklenir.
- Yanıt gövdesi: `{ error: { code, detail?, messageKey, retryable } }`; HTTP durumu koddan (`HTTP_STATUS`). İç mesaj, SQL, SQLSTATE, yığın gövdeye girmez; kök neden yalnızca `cause` ile loga gider (G-07: yutulmaz).
- `mapAccessError` (`packages/domain/src/identity/access.ts`) tenant erişim/komut sarmalayıcısından çıkan her hatayı eşler: `AppError` olduğu gibi geçer; `MembershipError` `FORBIDDEN`/`TENANT_SUSPENDED`/`TENANT_CLOSING` aynı kodla `AppError` olur; SQLSTATE `40P01`/`40001` → `VERSION_CONFLICT` + `retryable: true` (ADR-016 §11); **tanınmayan her şey** (diğer `MembershipError` kodları ve komut içinde düz `Error` dahil) → `INTERNAL` (500), orijinal hata `cause`'da. Bu yüzden komut gövdesindeki iş kuralı reddi `AppError` değilse istemciye `INTERNAL` olarak döner.
- i18n anahtarı: `errors.<kod>`, ayrıntılıysa `errors.<kod>.<ayrıntı>` (küçük harf; `errorMessageKey`).

#### Kodda tanımlı `AppError` kodları (Faz 1)
| Kod | Anlam (Faz 1 kullanımı) | HTTP | messageKey |
|---|---|---|---|
| `VALIDATION_FAILED` | Girdi doğrulaması başarısız (Faz 1'de fırlatan yok) | 400 | `errors.validation_failed` |
| `UNAUTHENTICATED` | Principal yok | 401 | `errors.unauthenticated` |
| `FORBIDDEN` | Üyelik/izin reddi, tenant ACTIVE değil | 403 | `errors.forbidden` |
| `TENANT_SUSPENDED` | Tenant askıda | 403 | `errors.tenant_suspended` |
| `TENANT_CLOSING` | Tenant kapanışta | 403 | `errors.tenant_closing` |
| `NOT_FOUND` | Tenant slug'ı boş ya da kullanıcı üye değil (varlık sızdırılmaz) | 404 | `errors.not_found` |
| `VERSION_CONFLICT` | Deadlock/serileştirme (`retryable: true`) | 409 | `errors.version_conflict` |
| `RATE_LIMITED` | Hız sınırı (Faz 1'de yalnızca kimlik yüzeyinde fırlatılır, aşağıda) | 429 | `errors.rate_limited` |
| `INTERNAL` | Tanınmayan hata (yukarıdaki kural) | 500 | `errors.internal` |

Ayrıntılar (`detail`; kodu değiştirmez, istemciyi yönlendirir — `ERROR_DETAILS`):

| Kod + ayrıntı | Anlam | HTTP | messageKey |
|---|---|---|---|
| `FORBIDDEN` + `MFA_REQUIRED` | `TENANT_ADMIN` rolü, oturum MFA doğrulanmamış, tenant `is_demo` değil (A-38) | 403 | `errors.forbidden.mfa_required` |
| `UNAUTHENTICATED` + `RECENT_AUTH_REQUIRED` | Yakın zamanda kimlik doğrulama reddi (`AuthError` `reason: "REAUTH_REQUIRED"`) | 401 | `errors.unauthenticated.recent_auth_required` |

#### Kimlik doğrulama yüzeyi (Better Auth uçları, `packages/auth/src/index.ts`; T-112)
Bu uçlar `AppError` gövdesi kullanmaz: Better Auth `APIError` gövdesinde `code` (mesaj = kod) döner; `messageKey` yoktur. Better Auth'un kendi kodları da bu yüzeyden geçer (kütüphane listesi, burada tekrarlanmaz).

| Kod | Anlam | HTTP |
|---|---|---|
| `CLIENT_IP_REQUIRED` | Üretimde güvenilir istemci IP başlığı yok | 400 |
| `TRUST_DEVICE_DISABLED` | 2FA doğrulama gövdesinde `trustDevice` (ADR-014 §12) | 400 |
| `DEMO_FORBIDDEN` | Demo kullanıcısı için kapalı hesap/oturum yönetimi ucu (A-43) | 403 |
| `RATE_LIMITED` | E-posta başına giriş kilidi / parola sıfırlama talep sınırı (A-41) | 429 |
| `MAIL_DELIVERY_DISABLED` | Parola sıfırlama talebi; kullanıcı var/yok ayrımı olmadan her istek aynı yanıt (A-42) | 503 |
| `SESSION_POLICY_FAILED` | Oturum politikası yazımı başarısız; oturum iptal edildi (fail-closed) | 500 |
| `INTERNAL_ERROR` | Handler'da yakalanmayan hata; gövde yalnızca `{ code }` | 500 |

#### İç kodlar (istemci gövdesine girmez)
| Kod | Kaynak | Anlam | İstemciye etkisi |
|---|---|---|---|
| `SLUG_TAKEN` | `MembershipError` (`packages/db/src/with-membership.ts`, `withNewTenant`) | Slug başka tenant'ta kullanımda | Faz 1'de üretim çağıranı yok; `mapAccessError`'dan geçerse `INTERNAL`. HTTP eşlemesi tenant oluşturma kartında |
| `IDEMPOTENCY_MISMATCH` | `MembershipError` (aynı) | Oluşturma isteği farklı parametrelerle tekrar kullanıldı | Listede API kodu, ama `ERROR_CODES`'ta yok; `mapAccessError`'dan geçerse `INTERNAL` |
| `MAIL_DELIVERY_DISABLED` | `MailError` (`packages/shared/src/mailer.ts`, worker; T-116), `MailDeliveryDisabledError` (`packages/auth`) | Kip `disabled`/yapılandırma eksik ya da alıcı bu ortamda teslim edilemez; sahte başarı yok | İş/kanca hatası; HTTP karşılığı yalnızca yukarıdaki kimlik yüzeyi satırı |
| `MAIL_SEND_FAILED` | `MailError` (worker sağlayıcıları; T-116) | Sağlayıcı isteği başarısız ya da başarısız durum kodu | İş hatası |
| `MAIL_RECIPIENT_INVALID` | `MailError` (T-116) | Mühürden çıkan alıcı tek, çıplak adres değil; kalıcı hata (gönderim yok) | İş hatası |

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
