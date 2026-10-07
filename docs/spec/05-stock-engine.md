# 05 — Stok Motoru

## Belge durumları
| Durum | Stok etkisi | İzin |
|---|---|---|
| DRAFT | Yok | Düzenle, iptal |
| APPROVED | Fiziksel etki yok | İşleme gönder; rezervasyon ayrı işlem |
| POSTED | Kesin | Görüntüle, yetkili ters kayıt |
| CANCELLED | Yok (işlenmemiş) | Salt okunur |
Satır bazında ters çevrilen miktar ve `NONE|PARTIAL|FULL` ters kayıt durumu izlenir. Kısmi operasyonlarda gerçekleşen miktar ayrı hareketle kesinleşir, kalan açık kalır.

## İşlem sözleşmesi (her stok komutu, 7 adım)
1. Kimlik, aktif üyelik, depo/eylem yetkisi, paket hakkı.
2. Şema + idempotency anahtarı (tenant + işlem türü + istek özeti).
3. Transaction aç, tenant bağlamını kur (I-02).
4. Belge sürümü ve stok/rezervasyon satırlarını **§Kilit sözleşmesi**ne göre, yalnızca `acquireStockLocks` ile, tam kilit planını önceden bildirerek kilitle.
5. Yeterlilik, lot/seri, SKT, lokasyon, durum geçişi kontrolleri.
6. Defter + bakiye + rezervasyon tüketimi + belge durumu + audit + outbox + idempotency sonucu **aynı transaction**.
7. Commit → yanıt. Yanıt kaybolursa aynı anahtar önceki sonucu döner.
Serialization/deadlock hatasında tüm transaction sınırlı sayıda gecikmeli yeniden denenir; iş kuralı hatası denenmez. Belge başına satır limiti; uzun kilitler izlenir.

## Rezervasyon ve hareketler
- **Rezervasyon modeli (varsayılan, ADR-009 ile değiştirilebilir):** Rezervasyon, sipariş satırını belirli bir stok boyutuna (lokasyon + lot + durum + sahip) bağlayan **sert tahsistir**. Rezervasyon ve sipariş defter satırı üretmez; fiziksel bakiyeyi değiştirmez. Toplamada rezervasyon, malla birlikte hedef boyuta (sevk alanı) taşınır; sevkte tüketilir; iptalde serbest kalır ve fiziksel stok yerinde kalır (gerekirse geri yerleştirme görevi). Sayısal örnekler: `docs/spec/16-stock-effects.md`.
- Rezervasyon atomik; aynı stok iki siparişe tahsis edilemez; süre aşımı, serbest bırakma, kısmi tüketim, yeniden tahsis. Sevke uygun olmayan stok rezerve edilemez.
- Toplama = depo içi yer değişimi; sevk = müşteriye çıkış; aynı çıkış iki kez yazılmaz.
- FIFO/FEFO politikası; öneriyi değiştirmek yetkili ve gerekçeli; sevk yasağı aşılamaz.
- Fiş numarası tenant + belge türü + dönem kapsamında atomik (sequence tablosu, satır kilidi). Boşluksuz numara gereksinimi ayrıca karar (Q).
- UTC zaman damgası, iş tarihi, tenant saat dilimi ayrı. Kapalı döneme geri tarihli hareket yalnızca düzeltme prosedürüyle.
- Periyodik tutarlılık işi defter ↔ bakiye/rezervasyon karşılaştırır; fark alarmdır, defter sessizce değiştirilmez.

## Kilit sözleşmesi (I-15)
Deadlock'u önlemenin tek yolu tüm stok komutlarının aynı sırayla kilit almasıdır. Bu sıra ajanların takdirine bırakılmaz. Stok komutu kilitlerini **yalnızca tek giriş noktasıyla** alır: `packages/db/src/locking.ts` içindeki `acquireStockLocks(tx, tenantId, plan)`. Alt adımlar (`lockDocument`, `lockBalances` vb.) bu dosyadan dışarı **export edilmez**; komutlar onları tek tek çağıramaz.

**Kilit planı** (komut, kilitlemeden önce ihtiyacının tamamını bildirir; sonradan kilit eklenmez):
```ts
type StockLockPlan = {
  document?: { id: string; expectedVersion: number };   // belge başlığı + sürüm kontrolü
  locationIds: string[];                                // hareketin dokunduğu kaynak + hedef lokasyonlar (sayım kilidi kontrolü için)
  dimensions: StockDimensionKey[];                      // bakiyesi değişecek tüm boyutlar (kaynak + hedef; taşıma birimi dahil)
  reservationIds: string[];                             // tüketilecek / taşınacak / serbest bırakılacak rezervasyonlar
  serialIds: string[];                                  // hareket eden seri numaraları
  countSessionId?: string;                              // YALNIZCA sayım farkı komutu doldurur; istisnanın tek anahtarı
};
```

**`acquireStockLocks` adımları — sıra sabittir, atlanabilir ama yer değiştiremez:**
| # | Adım | SQL davranışı | Sıra anahtarı |
|---|---|---|---|
| 1 | `lockDocument` | `SELECT … FROM documents WHERE id=$1 FOR UPDATE`; `version ≠ expectedVersion` → `VERSION_CONFLICT` | tek satır |
| 2 | `assertLocationsNotCounting` | `SELECT … FROM location_count_locks WHERE location_id = ANY($1) ORDER BY location_id FOR SHARE` (sayım farkı komutunda `FOR UPDATE`). Kilit satırı yoksa → hata `COUNT_LOCK_ROW_MISSING` (veri bütünlüğü ihlali, alarm). Durum `COUNTING` ise → `LOCATION_LOCKED`; **tek istisna** aşağıdaki sayım farkı kuralıdır. Ayrıntı: `docs/spec/06-operations.md` §Sayım kilidi yaşam döngüsü | `location_id` artan |
| 3 | `ensureDimensions` + `ensureBalanceRows` | Eksik boyut ve bakiye satırları sıralı `INSERT … ON CONFLICT DO NOTHING` | boyut anahtarı / `stock_dimension_id` artan |
| 4 | `lockBalances` | `SELECT … FROM stock_balances WHERE stock_dimension_id = ANY($1) ORDER BY stock_dimension_id FOR UPDATE` | `stock_dimension_id` artan |
| 5 | `lockReservations` | `SELECT … FROM reservations WHERE id = ANY($1) ORDER BY id FOR UPDATE` | `id` artan |
| 6 | `lockSerials` | `SELECT … FROM serials WHERE id = ANY($1) ORDER BY id FOR NO KEY UPDATE` (T-256: **`FOR UPDATE`'e geri ÇEVRİLMEZ**; kök neden aşağıdaki not) | `id` artan |

> **Not (T-256, seri kilit modu):** Adım 3'te yeni boyut satırı eklenirken `stock_dimensions_serial_fkey` `serials` satırında `FOR KEY SHARE` alır. Adım 6 `FOR UPDATE` olsaydı aynı seriyi isteyen iki işlem birbirinin KEY SHARE'ini bekleyip 40P01 (deadlock) üretirdi; `id` sırası tek anahtarda çözmez. `FOR NO KEY UPDATE` KEY SHARE ile çakışmaz, kendisiyle çakışır (seri komutları yine sıralanır). Bu mod `FOR UPDATE`'e ya da daha zayıf bir kipe (`FOR SHARE`) çevrilmemelidir; `locking.int.test.ts` bunu doğrular.


Dönüş değeri: kilitlenmiş satırların anlık görüntüsü (`LockedState`). Komut iş kurallarını (yeterlilik, lot/SKT, durum geçişi) **bu görüntü üzerinde** kontrol eder ve yazma işlemlerini yalnızca bu satırlara yapar.

- **Satırlar arası sıra:** Her adımda tekil ve değişmez anahtar artan. `item_id, location_id` gibi eksik anahtarlar kullanılmaz (lot, durum, sahip de boyutun parçası). Uygulamada da (`Set` + sort) ve SQL'de de (`ORDER BY`) sıralanır.
- **Kilit, güncellemeden önce:** Bakiye, rezervasyon ve seri `UPDATE`'leri yalnızca `LockedState` içindeki satırlara yapılır. Kilitsiz toplu `UPDATE` stok tablolarında yasaktır. Plan dışında kalan bir satıra ihtiyaç doğarsa komut iptal edilir ve planı genişletilerek baştan çalıştırılır.
- `lock_timeout` kısa tutulur; deadlock/serialization hatasında tüm transaction sınırlı sayıda gecikmeli yeniden denenir (en fazla 3, jitter'lı). Uzun kilit süresi metrik ve alarm üretir.
- Doğrulama: AC-27 (ters sıralı satırlarla eşzamanlı siparişler), AC-13 (sayım kilidi koordinasyonu) ve lint kuralı: stok tablolarında `FOR UPDATE` / `FOR SHARE` yalnızca `locking.ts` içinde; `locking.ts`'den yalnızca `acquireStockLocks` ve tipleri export edilebilir.

## Senkron işlem sınırları
Stok kesinleştirmesi kısa olmalıdır; bu barındırma platformunun HTTP zaman aşımından bağımsız bir kuraldır (zaman aşımı yalnızca belirtidir, sorun uzun kilit süresidir).
- **Bir belge = bir transaction.** Atomikliği korumak için bir belgenin işlenmesi birden çok transaction'a bölünmez.
- **Senkron sınır:** Satır sayısı eşiğin (öneri 200, ADR ile kesinleşir) altındaki belgeler istek içinde işlenir. Üstündekiler worker'da, **aynı 7 adımlı sözleşme ve aynı idempotency anahtarıyla** işlenir; belge `APPROVED` kalır ve `posting_job_id` taşır, arayüz "işleniyor" gösterir, sonuç `POSTED` ya da gerekçeli hata olur. Worker'da işlemek kilit süresini kısaltmaz; yalnızca HTTP isteğini serbest bırakır.
- **Sert sınır:** Belge başına azami satır (öneri 2.000). Üstü tek belge olarak kabul edilmez; import akışı birden çok belgeye böler.
- Server Action ve Route Handler ince giriş katmanıdır: yetki + doğrulama + domain komutu çağrısı. Büyük okuma (rapor, export) Server Action'da yapılmaz; worker işine çevrilir.
- Her komut sınıfına `statement_timeout` ve `lock_timeout` verilir. İzlenen ölçüler: transaction süresi p95/p99, kilit bekleme süresi, deadlock sayısı, async belge kuyruğu yaşı. Stok kesinleştirme p95 > 1 sn alarm üretir. Test: AC-36.

## Outbox relay (I-07)
> ADR-005'te **Postgres kuyruğu** seçilirse iş, stok işlemiyle aynı transaction'da kuyruğa yazılır; ayrı relay gerekmez ve bu bölümün yalnızca **tüketici** kuralları (processed_events, haricî idempotency anahtarı, FAILED/alarm) geçerlidir. Aşağıdaki relay kuralları BullMQ/RabbitMQ seçildiğinde uygulanır.

Postgres → kuyruk aktarımı "tam bir kez" olamaz; hedef **en az bir kez teslim + etkide tam bir kez**tir.
- `outbox_events`: `id` (UUID, olay kimliği = idempotency anahtarı), `tenant_id`, `type`, `payload`, `status` (`PENDING|PUBLISHED|FAILED`), `attempts`, `next_attempt_at`, `published_at`, `created_seq` (monoton).
- Relay döngüsü: kısa transaction'da `SELECT … WHERE status='PENDING' AND next_attempt_at<=now() ORDER BY created_seq LIMIT n FOR UPDATE SKIP LOCKED` → kuyruğa ekle → `status='PUBLISHED'`. Birden çok relay örneği aynı satırı alamaz (SKIP LOCKED).
- Kuyruğa eklerken **jobId = outbox event id** verilir; relay commit'ten önce çökerse ikinci ekleme aynı jobId'ye çarpar. BullMQ jobId tekilliği yalnızca iş kuyrukta/saklanırken geçerlidir; bu yüzden asıl güvence tüketici tarafındadır.
- Tüketici: işi yan etkisiyle birlikte aynı DB transaction'ında `processed_events (consumer, event_id)` PRIMARY KEY'ine yazar; çakışma = zaten işlenmiş → sessizce onayla. Haricî sistem çağrılarında (e-posta, ERP, webhook) olay kimliği karşı tarafa idempotency anahtarı olarak gönderilir.
- Başarısızlıkta üstel geri çekilme; `attempts` eşiğinde `FAILED` + alarm + yönetici ekranından yeniden gönderme. Aynı aggregate için sıra gerekiyorsa sıralama anahtarı (`tenant_id + aggregate_id`) ile tek tüketici grubu.
- Redis tamamen kaybolursa `PUBLISHED` ama işlenmemiş olaylar `processed_events` ile karşılaştırılarak yeniden kuyruğa alınır (yeniden kurma komutu).

## Geri alma ve arşiv
- Kullanılmış kart (ürün, lot, lokasyon) silinmez, arşivlenir.
- Taslak iptal edilebilir; işlenmiş belge yalnızca ters kayıtla (I-08). Aynı ters işlem tekrar gönderilirse ikinci etki yok.
- Sonraki sevk/transfer/rezervasyon/seri hareketi ve kapalı dönem kontrol edilir; uygun değilse neden + çözüm önerisiyle ret (örn. 100 giriş, 60 sevk → tam geri alma reddedilir).
- Gerekçe, aktör, onaylayan, kaynak ve ters belge bağlantısı saklanır.
- Varsayılan negatif stok yasaktır (I-05).
