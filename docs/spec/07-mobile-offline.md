# 07 — Mobil, Donanım ve Offline

## Donanım
### Tarama kaynağı önceliği
1. **Donanım tarayıcı** (Zebra/Honeywell el terminalinin dahili motoru veya USB/Bluetooth HID okuyucu) — saha için birincil yol.
2. **Kamera** — yedek yol (yönetici ekranları, donanımsız küçük depolar).

### Web uygulamasının (PWA) teknik sınırı
- Tarayıcıda çalışan bir PWA, Android **DataWedge intent** çıktısını doğrudan alamaz; intent yalnızca yerel uygulamalara gider. Bu nedenle PWA'da DataWedge **keystroke çıkışı** modunda yapılandırılır. Intent entegrasyonu gerekiyorsa (daha güvenilir, odak bağımsız) üç yol vardır ve ADR-010 ile seçilir: Zebra Enterprise Browser, ince yerel kabuk (TWA/Capacitor) veya keystroke ile kalmak.
- Tüm kaynaklar tek `ScannerService` arkasındadır; ekranlar yalnızca `onScan(value, source)` olayını dinler.

### Keystroke (klavye kaması) yakalama katmanı
- DataWedge/okuyucu profili: sabit **önek** (örn. STX veya nadir bir karakter) ve **sonek** (Enter). Global `keydown` dinleyicisi önek–sonek arasını tampona alır; tuşlar arası süre eşiği (örn. < 30 ms) ve önek birlikte "tarama" kabul edilir. İnsan yazımı tarama sayılmaz.
- Tarama sırasında sanal klavyenin açılmaması için tarama alanlarında `inputmode="none"`; odak kaybında tampon kaybolmaz (global dinleyici).
- **Türkçe klavye düzeni riski:** HID okuyucular tuş kodu gönderir; cihaz klavyesi Türkçe Q iken `i/ı`, `-`, `/`, `.`, `*` gibi karakterler yanlış üretilebilir. Okuyucu ve cihaz düzeni eşleştirilir (veya okuyucu Unicode/Alt-kod moduna alınır); test matrisinde Türkçe düzen zorunludur (AC-35).
- **GS1 ayracı (FNC1 / ASCII 29)** keystroke modunda kaybolabilir; profilde görünür bir yer tutucu karaktere eşlenir ve ayrıştırıcı bunu tanır.

### Kamera yolu
- Desteklenen tarayıcıda yerel `BarcodeDetector`, yoksa WASM tabanlı çözücü; fener (torch) kontrolü, odak kilidi, aynı kodun tekrar okunmasını önleyen kısa bekleme.

### Test ve ölçüm
- Cihaz/tarayıcı matrisi: pilot cihazları × klavye düzeni × tarama kaynağı. Senaryolar: loş ışık, kirli/hasarlı etiket, buruşuk poşet, ardışık hızlı tarama, yanlış ürün okutma.
- Sayı bazlı saha ölçüleri: tarama başına süre (ms), görev başına yeniden tarama sayısı, okunamayan etiket sayısı (günlük).
- Etiket yazıcı: format (ZPL/PDF), DPI ve yazdırma yolu (tarayıcı, yerel köprü, ağ yazıcısı) ADR ile seçilir.

## Offline (Faz 5)
- İlk kapsam: önceden atanmış göreve ait tarama, miktar ve sayım gözlemi. Serbest sevk, stok düzeltme, onaysız tahsis offline kesinleşmez.
- Offline kayıt komuttur (I-10). Fiziksel hareket yapılmış ama sunucu reddetmişse düzeltme/yeniden yerleştirme görevi oluşur; kayıt sessizce atılmaz.
- Komut alanları: `operation_id`, tenant, aktör, cihaz, görev, şema sürümü, beklenen belge sürümü, yerel sıra, payload. Cihaz saati sıra otoritesi değildir.
- Durumlar: yerelde bekliyor → gönderiliyor → kabul / çatışmalı / reddedildi; her komut için sonuç ve gerekçe görünür.
- Aynı belge/görevde bağımlı komutlar sıralı; bağımsızlar kontrollü paralel; batch sonucu komut bazında.
- İki cihaz aynı son ürünü işlerse ilk geçerli kesinleşen kabul; diğeri yönetici onay ekranına "Senkronizasyon Çakışması" olarak düşer.
- Background Sync yalnızca destekleyen tarayıcıda ek kolaylık; açılışta, bağlantı dönüşünde ve manuel senkron da var. Depolama temizliği riski kullanıcıya gösterilir.
- IndexedDB verisi tenant/kullanıcı bazında ayrık; ortak cihazda çıkışta bekleyen işlem uyarısı; azami offline süre ve yerel veri temizleme politikası Faz 0 kararı.
