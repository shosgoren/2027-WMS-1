# Kabul Senaryoları (qa-verifier bu ID'lerle test yazar)
| ID | Senaryo | Beklenen | Faz |
|---|---|---|---|
| AC-01 | 10 stoktan eşzamanlı iki 7 çıkış | En fazla biri kesinleşir; negatif yok | 2 |
| AC-02 | Aynı stok isteği / worker olayı tekrar | Tek etki, önceki sonuç | 2 |
| AC-03 | Commit sonrası yanıt kaybı | Yeniden istek çift hareket üretmez | 2 |
| AC-04 | Tenant A, B'nin ID'sini kullanır | API, DB, dosya, cache, export reddeder | 1 |
| AC-05 | Gerçek pooler arkasında, pool 1–2'ye düşürülmüş, 2 tenant × 50 eşzamanlı istek | Her yanıt yalnızca kendi tenant'ı; transaction dışı sorgu veri döndürmez; prepared statement hatası yok | 0 |
| AC-06 | 100 girişin 60'ı sevkliyken tam geri alma | `REVERSAL_BLOCKED` veya kontrollü düzeltme | 2 |
| AC-07 | Transfer: kaynakta 20 çıkış, hedefte 15 kabul, 5 kayıp onayı | `16-stock-effects` Senaryo B'nin her satırı birebir | 3B |
| AC-08 | Karantina, hasarlı veya kabul alanındaki stoku rezerve etme / sevk etme | Ret; kullanılabilir miktara dahil edilmez | 3A |
| AC-09 | Seri takipli ürün iki lokasyona | `TRACKING_VIOLATION` | 2 |
| AC-10 | Aynı siparişin toplama ve sevki | Müşteri çıkışı bir kez | 3A |
| AC-11 | İki offline cihaz aynı son ürün | Bir kesinleşme; diğeri çatışma + düzeltme görevi | 5 |
| AC-12 | Çıkarılmış kullanıcının offline kuyruğu | Güncel yetkiyle ret | 5 |
| AC-13 | Sayımdaki lokasyona hareket | `LOCATION_LOCKED` | 3A |
| AC-39 | Sayım kilidi yaşam döngüsü: yeni lokasyon oluşturulur; süren bir stok işlemi varken sayım başlatılır; kilitliyken (a) normal hareket, (b) başka oturumun fark fişi, (c) onaysız oturumun fark fişi, (d) kilitli + kilitsiz lokasyona birlikte yazan fark fişi, (e) doğru oturumun onaylı fark fişi gönderilir; ayrıca iptal | Yeni lokasyonun kilit satırı vardır; sayım başlangıcı süren işlemin bitmesini bekler; (a)–(d) reddedilir; (e) fark satırlarını işler ve kilitleri aynı transaction'da `IDLE` yapar; iptal fark uygulamadan kilidi açar | 3A |
| AC-14 | Metadata değişti, eski fiş açılır | Eski sürümle doğru görüntü + ters kayıt | 6 |
| AC-15 | Aynı stok import'u tekrar | İkinci açılış yok | 4P |
| AC-16 | Kuyruk işleyicileri (worker) durdurulur veya çöker, bu sırada stok işlemleri sürer; sonra işleyiciler döner | Stok kesinleştirmeleri etkilenmez; bekleyen işlerin her biri tek etkiyle işlenir; kayıp iş yok | 2 |
| AC-17 | Yedekten restore | Defter/bakiye, dosya, silme işaretleri doğru | 4P |
| AC-18 | Çıkarılan kullanıcının eski token'ı ile yazma | Ret | 1 |
| AC-19 | Paket limiti eşzamanlı isteklerle aşılmaya çalışılır | Limit korunur | 4S |
| AC-20 | Min-maks altına düşen ürün | Uyarı üretilir, stok değişmez | 3A |
| AC-21 | Tutarlılık işi defter–bakiye farkı bulur | Alarm; defter değişmez | 2 |
| AC-22 | Aynı iş/olay tüketiciye iki kez teslim edilir (işleyici yan etkiden sonra, onaydan önce çöker) | Etki tek kez; ikinci teslim `processed_events` ile sessizce onaylanır; haricî çağrıda aynı idempotency anahtarı gider | 2 |
| AC-23 | Aynı kuyruğu iki işleyici örneği eşzamanlı tüketir | Hiçbir iş iki örnekte birlikte yürütülmez; toplam işlenen = toplam kuyruğa giren | 2 |
| AC-24 | 1M hareket satırlı tenant için takeout, aynı anda stok işlemleri sürerken | Stok işlemlerinin p95'i hedef içinde; uzun transaction yok; export bakiyeleri kesim noktasındaki defterle birebir | 4P |
| AC-25 | Paket düşürülmüş / ödemesi gecikmiş / askıdaki tenant | Tüm veriyi görüntüler, CSV/JSON indirir ve takeout alır; yeni kayıt limit dahilinde engellenir | 4S |
| AC-26 | Kesilen takeout işi yeniden başlar | Son tamamlanan parçadan devam eder; yinelenen veya eksik satır yok (manifest sayıları tutar) | 4P |
| AC-27 | Aynı 5 ürünü ters sıralı satırlarla içeren 20 sipariş eşzamanlı sevk/rezerve edilir | Deadlock nedeniyle başarısız işlem yok (yeniden deneme sonrası); toplam stok ve defter tutarlı | 2 |
| AC-28 | Tenant modülünde `withTenant` dışında global istemci kullanılır | Lint CI'da hata verir; çalışma anında sorgu satır döndürmez / yazma reddedilir | 0 |
| AC-29 | Seq 100'ü alan işlem bekletilir, 101 commit olur, takeout başlar, ardından 100 commit olur | Export 100'ü içermez, 101'i içerir; export bakiyeleri kesitteki defterle birebir; aynı kesitle yeniden çalıştırma `deterministic: true` dosyalarda aynı checksum'ı verir (değişebilir tablo dosyaları bu garantinin dışındadır) | 4P |
| AC-30 | Kapatılan tenant'ta: normal kullanıcı girişi, yönetici girişi, yazma isteği, import işi, takeout işi, 31. gün | Normal kullanıcı reddedilir; yönetici salt okunur portala girer; yazma `TENANT_CLOSING`; import çalışmaz; takeout tamamlanır; 31. günde silme işi başlar ve takeout dosyaları silinir | 4P |
| AC-31 | Çekirdek akış (`16-stock-effects` Senaryo A, adım 0–11) | Her adımdan sonra tüm sütunlar tablodakiyle birebir; son durumda fiziksel 7, defter toplamı 7, açık rezervasyon 0 | 3A |
| AC-40 | Tam pilot akışı (`16-stock-effects` Senaryo D, adım 1–10): kısmi/hasarlı kabul, 2 ürün, 3 sipariş, "ürün bulunamadı", kısmi sevk, iade, kilitli sayım | Her adımdan sonra X ve Y tablolarındaki tüm sütunlar ve belge/sipariş son durumu birebir; X fiziksel 8, Y fiziksel 2, açık rezervasyon 1 | 3A |
| AC-35 | Pilot cihazında, işletim sistemi klavyesi Türkçe iken HID/DataWedge keystroke ile `i`, `ı`, `-`, `/`, `.` içeren barkodlar ve GS1 (FNC1 ayraçlı) barkod taranır | Okunan değer birebir; GS1 alanları doğru ayrışır; elle klavyeden yazılan değer "tarama" sayılmaz | 3A |
| AC-43 | Onay kaynağı testi: ajan kimliği korunan dosyayı değiştirir ve kartına `protected: true` ekler; ajan kimliği PR'ı onaylamaya çalışır; insan onayından sonra yeni commit eklenir; CODEOWNERS dosyası PR dalında değiştirilir | Hepsinde `check:protected` kırmızı: beyan onay sayılmaz, ajan onayı geçersiz, eski onay düşer, CODEOWNERS `main`'den okunur. Yalnızca son commit'e verilmiş insan onayıyla yeşil | 0 |
| AC-44 | Karantina testi: (a) kayıtsız `@quarantine`, (b) insan onaysız yeni karantina, (c) kapı AC testinin karantinası, (d) bitiş tarihi geçmiş karantina, (e) tüm koşulları sağlayan karantina | (a)–(d) CI kırmızı; (e) yeşil, test yine koşar ve sonucu raporlanır | 0 |
| AC-37 | Bekçi testi: kart dışı dosya değiştirilir; bir test `skip` edilir; bir `@AC` testi silinir; bir assertion `expect(true)` yapılır; lint kuralı gevşetilir | Her biri ayrı ayrı CI'ı kırmızıya çevirir; mesaj nedeni ve dosyayı gösterir | 0 |
| AC-36 | Senkron eşiğin üstünde satırlı belge işlenir; aynı istek iki kez gönderilir; işleme sırasında worker yeniden başlar | Belge worker'da tek transaction'da `POSTED` olur; tek stok etkisi; arayüz "işleniyor" → sonuç gösterir; sert sınırın üstü reddedilir | 2 |

## Koşullu kabul senaryoları
Koşulu ADR veya `docs/PILOT.md` ile karşılanırsa ilgili fazın kapısına eklenir; karşılanmazsa `pnpm test:ac` bunları atlar ve raporda koşulu yazar. Koşul `docs/ACCEPTANCE.conditions.json` dosyasında makine tarafından okunur biçimde tutulur.
| ID | Koşul | Senaryo | Beklenen | Faz |
|---|---|---|---|---|
| AC-32 | ADR-005 ayrı broker seçtiyse (BullMQ/RabbitMQ) | Relay olayı broker'a ekledikten sonra, `PUBLISHED` commit'inden önce çöker | Olay ikinci kez eklenir ama tüketici etkisi tek kez (AC-22 ile); iş kimliği = olay kimliği | 2 |
| AC-33 | ADR-005 ayrı broker seçtiyse | Broker verisi tamamen kaybolur | Stok etkilenmez; `PUBLISHED` ama işlenmemiş olaylar `processed_events` karşılaştırmasıyla yeniden kuyruğa alınır; çift etki yok | 2 |
| AC-38 | Pilot koli cevabı (b) veya (c) | 12 adetlik koli okutularak R-01'den SEVK'e taşınır; koli açılıp 5 adet çıkarılır; palet içindeki koli sorgulanır | Taşıma birimi hareketinde içerik başına −/+ defter çifti, toplam fiziksel değişmez; açılan kolide 7 kalır; hiçbir stok iki taşıma biriminde birden görünmez | 3A (koşul yoksa 3B) |
| AC-34 | Pilotta en az bir ürün grubu `LOT` veya `LOT_AND_SERIAL` | Lot seçerek kabul, rezervasyon, toplama, sevk; lotsuz satır gönderme; başka lotu okutma | Her hareket doğru lot boyutuna yazılır; lotsuz satır ve yanlış lot reddedilir; lot bazında hareket ekstresi doğrudur | 3A (koşul yoksa 3B) |
| AC-41 | Pilotta SKT kullanımı = var (yalnızca lotlu ürünlerde geçerli) | SKT'si geçmiş lotu rezerve etme; minimum kalan raf ömrünün altındaki lotu sevk etme; FEFO önerisi; öneriyi gerekçesiz değiştirme | Ret / ret / en erken SKT'li uygun lot önerilir / gerekçe ve yetki olmadan değiştirilemez | 3A (koşul yoksa 3B) |
| AC-42 | Pilotta en az bir ürün grubu `SERIAL` veya `LOT_AND_SERIAL` | Birim başına seri tarama; aynı seriyi iki kez okutma; `LOT_AND_SERIAL`'da seriyi yanlış lotla okutma | Her birim taranmadan satır kesinleşmez; tekrar ve lot–seri uyuşmazlığı reddedilir (AC-09'daki tekillik kısıtına ek olarak) | 3A (koşul yoksa 3B) |
