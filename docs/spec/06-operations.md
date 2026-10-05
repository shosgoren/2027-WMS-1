# 06 — Depo Operasyonları

## Görevlendirme
Mal kabul, yerleştirme, toplama, sevk ve sayım görevleri depo yöneticisince personele atanır veya personel üstlenir (yetkisi olan depoda). Saha ekranı sadeleştirilmiş görev listesidir: barkod tara → ürün/lokasyon doğrula → miktar onayla → rafa koy/raftan al. Birden çok siparişin birlikte toplanması "sipariş toplama görevlendirmesi" adıyla yapılır.

## Mal kabul ve yerleştirme
Beklenen teslim referansı → fiziksel kabul → kalite/karantina → yerleştirme. Kısmi, fazla/eksik, hasarlı kabul kaydedilir. Yerleştirme ikinci stok girişi oluşturmaz.

## Sipariş, toplama, sevk
Sipariş → rezervasyon → toplama görevi → paketleme → sevk. Kısmi miktar, ürün bulunamadı, yeniden atama, iptal, barkod doğrulaması. Toplama/paket/sevk belge bağlantıları izlenebilir; kısmi sevk ve açık bakiye desteklenir.

## Transfer
Kaynak çıkışı → transit → hedef kabul. Hedef kabul edilmeden hedefte kullanılabilir olmaz. Kısmi kabul, hasar/kayıp, red ve kaynağa dönüş ayrı hareket; toplam miktar korunur.

## İade ve üretim
Müşteri iadesi orijinal sevke bağlanabilir; miktar ve lot/seri doğrulanır; varsayılan karantina. Tedarikçiye iade ayrı çıkış. Üretimden giriş ve sarf iş emri referansıyla; tam MRP sonraki kapsam.

## Sayım
İlk sürüm: seçili lokasyonlarda sunucu tarafı hareket kilidi (kaynak ve hedef hareketi kapsar; kilit süresince offline gelen hareketler de işlenmez).

### Sayım kilidi yaşam döngüsü
- **Satır önceden vardır.** Her lokasyon için `location_count_locks` satırı (`location_id` PK, `status IDLE|COUNTING`, `count_session_id`, `locked_at`, `locked_by`) **lokasyonla aynı transaction'da** oluşturulur; mevcut lokasyonlar için migration geri doldurur. Gerekçe: olmayan satıra `FOR SHARE` hiçbir şeyi kilitlemez; satır sayım başlarken oluşturulsaydı süren bir stok işlemiyle yarışırdı. Lokasyon silinmez, arşivlenir; kilit satırı da kalır. Tutarlılık işi her lokasyonun tam bir kilit satırı olduğunu denetler.
- **Sayım başlatma:** Tek transaction'da seçilen lokasyonların kilit satırları `location_id` artan sırayla `FOR UPDATE` alınır (süren stok işlemleri `FOR SHARE` tuttuğu için onların bitmesi beklenir; `lock_timeout` aşılırsa başlatma yeniden denenir veya kullanıcıya "lokasyonda süren işlem var" gösterilir) → hepsi `IDLE` ise `COUNTING` + `count_session_id` yazılır → aynı transaction'da referans bakiyeler sabitlenir. Biri zaten `COUNTING` ise başlatma tümüyle reddedilir (kısmi kilit yok).
- **Sayım süresince:** Normal stok komutları bu lokasyonlara `LOCATION_LOCKED` alır (kaynak veya hedef olarak). Okuma, rapor ve sayım gözlemi kaydı serbesttir. Lokasyon toplama önerilerinden çıkarılır.
- **Kontrollü istisna — sayım farkı komutu:** Kilitli lokasyona yalnızca şu koşulların **hepsi** sağlanırsa stok yazılır: komut türü `COUNT_ADJUSTMENT`; plan `countSessionId` taşır ve kilit satırındaki `count_session_id` ile eşleşir; oturum durumu `APPROVED` (fark onaylanmış); kullanıcı `sayım_farkı.onayla` yetkisine sahip; komutun dokunduğu **her** lokasyon bu oturuma kilitli (başka oturuma kilitli veya kilitsiz lokasyona yazamaz). Komut fark satırlarını işler ve **aynı transaction'da** kilitleri `IDLE`'a çevirir; ayrı "kilidi aç" adımı yoktur.
- **İptal:** Yetkili iptal, fark uygulamadan kilitleri aynı transaction'da `IDLE`'a çevirir; gerekçe audit'e yazılır.
- **Terk edilmiş sayım:** Tanımlı süreyi (öneri 8 saat, tenant ayarı) aşan `COUNTING` kilitleri alarm üretir; otomatik açılmaz, yalnızca yetkili iptal veya onayla kapanır.

Oturum başlayınca referans bakiye sabitlenir. Kör sayım, ikinci sayım, tolerans, fark onayı. Fark fişi işlenmeden kilit açılmaz; iptalde fark uygulanmaz. Hareket sürerken sayım (cutoff/snapshot) ayrı sürüm. Periyodik dönüşümlü sayım (cycle count) planı sonraki sürüm.
