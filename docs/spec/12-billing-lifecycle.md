# 12 — Abonelik, Takeout, Offboarding

## Abonelik
- Tenant durumları: `TRIAL`, `ACTIVE`, `PAST_DUE` (ödeme gecikmiş), `RESTRICTED` (kısıtlı), `SUSPENDED` (askıda; giriş ve okuma açık, yazma kapalı), `CLOSING_GRACE` (kapatma, 30 gün), `DELETION_PENDING`. Geçişler tek durum makinesinde tanımlanır; operasyon durumu ödeme sağlayıcısı durumundan ayrıdır.
- Ödeme sağlayıcısı ADR-008: TR şirketi için yinelenen ödeme destekleyen yerel sağlayıcı (iyzico/PayTR vb.); global sağlayıcıların TR desteği Faz 0'da doğrulanır.
- Abonelik ücretleri için e-Fatura/e-Arşiv düzenleme (entegratör) ve KDV kuralları Faz 4S'te (pilot ücretsiz olduğundan pilot sonrası).
- Webhook imzalı ve idempotent; sırasız olay eski durumu geri getirmez. Proration, vergi, yenileme, iptal sağlayıcı sözleşmesine göre.
- Her yazmada hak kontrolü; limitler eşzamanlı isteklerle aşılamaz.

## Paket düşürme ve veri hakları
- Paket düşürmede **hiçbir veri silinmez ve gizlenmez.** Limit aşan kayıtlar (fazla depo, kullanıcı, ürün vb.) "salt okunur" işaretlenir; yeni kayıt açma ve bu kayıtlar üzerinde yeni hareket limit dahilinde engellenir.
- Aşağıdakiler **paket, ödeme durumu ve feature flag'den bağımsız** her zaman açıktır (deneme bitmiş, ödeme gecikmiş, kısıtlı ve askıda durumları dahil; kapatma sürecinde yalnızca yetkili yöneticiler için, bkz. §Kapatma): tüm kart, belge, hareket ve stok ekranlarını görüntüleme; liste/rapor ekranlarından CSV/JSON indirme; tam takeout. Bunlar entitlement kontrolüne değil yalnızca kimlik, yetki (`takeout.talep_et`, `stok.görüntüle`) ve rate limit kontrolüne tabidir.
- Salt okunur moddaki ekranlar nedenini ve çözümünü gösterir ("Paket limiti: 3 depo. Bu depo salt okunur. Yükselt / başka depoyu arşivle"). Upsell modalı veriye erişimi engellemez.
- Başlamış operasyonlar (açık transfer, toplama, sayım kilidi) düşürme anında yarım kalmaz: tamamlanmasına veya güvenli iptaline izin verilir; bekleyen offline komutlar yeniden doğrulanır, fiziksel hareket yapılmışsa düzeltme görevi oluşur.
- Düşürme öncesi ekranda etkilenecek kayıtların özeti gösterilir; kullanıcı hangi depoların/kullanıcıların aktif kalacağını seçer.

## Takeout ve büyük veri dışa aktarımı
Yetkili yönetici + yeniden doğrulama. Kartlar, belgeler, hareketler, lot/seri, görevler, metadata sürümü, dosya manifesti; sırlar ve platform logları hariç. JSON+CSV(+Excel), manifest (format sürümü, kesim noktası, satır sayıları, checksum). Şifreli arşiv anahtarı ayrı kanaldan; kısa ömürlü signed URL; geçici dosya TTL.

**Ana DB'yi kilitlememe kuralları:**
- İş yalnızca worker'da, ayrı ve düşük öncelikli kuyrukta, tenant başına aynı anda tek takeout ile çalışır.
- Okuma kaynağı: read replica varsa replica (yetki kontrolü primary'de yapılır, iş başlamadan önce); yoksa primary üzerinde **keyset (seek) sayfalama ile parçalı okuma**: `WHERE tenant_id=$t AND id > $last ORDER BY id LIMIT 5000`, her parça ayrı kısa transaction, `statement_timeout` ve `lock_timeout` ile. Uzun açık transaction, `OFFSET` sayfalama ve tüm veriyi belleğe alma yasaktır.
**Kesim noktası protokolü (I-16):**
`max(ledger_seq)` kesim noktası olarak **kullanılmaz**: sequence değeri `nextval` anında verilir, commit sırasını garanti etmez. Seq 100'ü alan işlem beklerken 101 commit olabilir; export 101'i görüp 100'ü görmezse, 100 daha sonra commit olduğunda "≤ H" filtresi onu da içeri alır ve kesit bozulur. Bunun yerine transaction görünürlüğüne dayalı kesim kullanılır:
1. Append-only tablolar (`stock_ledger`, `document_status_history`, `audit_logs`, `outbox_events`) her satırda yazan transaction'ın kimliğini tutar: `created_xid xid8 NOT NULL DEFAULT pg_current_xact_id()`.
2. Export başında, primary'de tek kısa sorguyla `S = pg_current_snapshot()` ve `L = pg_current_wal_lsn()` alınır ve `export_jobs` satırına yazılır. Uzun süre açık tutulan transaction yoktur.
3. Kesite dahil olma kuralı: satır yalnızca `pg_visible_in_snapshot(created_xid, S)` ise export edilir. Snapshot alındığı anda commit olmamış her işlem (seq numarası ne olursa olsun) dışarıda kalır; sonradan commit olması sonucu değiştirmez.
4. Sayfalama bu filtreyle birlikte keyset ile yapılır (`ledger_seq > $last`); sayfalar farklı zamanlarda okunsa da sonuç aynı kesittir.
5. Replica kullanılıyorsa okuma başlamadan önce `pg_last_wal_replay_lsn() >= L` beklenir; aksi halde kesite dahil olması gereken satırlar henüz replikada olmayabilir.
6. Export'taki bakiyeler bakiye tablosundan değil, bu kesitteki defter satırlarından yeniden hesaplanır. Belge durumları `document_status_history`'den aynı kesite göre türetilir.
7. Değişebilen tablolar (kartlar, ayarlar, lokasyonlar) export anındaki son hâliyle alınır; manifest bunu `mutable_tables_as_of` alanında açıkça belirtir. Kesitteki hareketlerin referans verdiği her kart export'ta bulunur (arşivlenmiş olsa bile).
8. Manifest: `snapshot`, `wal_lsn`, kesim zamanı, dosya başına satır sayısı, checksum ve `deterministic` bayrağı.
9. **Checksum garantisinin kapsamı:** `deterministic: true` dosyalar (kesite bağlı append-only tablolar ve bunlardan türetilen bakiyeler/belge durumları) aynı kesitle yeniden üretildiğinde **aynı checksum'ı** verir; satırlar sabit anahtar sırasıyla ve sabit serileştirme biçimiyle (alan sırası, sayı ve tarih formatı) yazılır. `deterministic: false` dosyalar (değişebilir tablolar, ekler) yalnızca **bütünlük** checksum'ı taşır: indirilen dosyanın bozulmadığını kanıtlar, yeniden üretildiğinde aynı olacağını garanti etmez. Arşivin tamamı için tekrar üretilebilirlik garantisi verilmez; manifest bunu açıkça yazar.

Aynı kural, sequence'i "buraya kadar işlendi" işareti olarak kullanma eğiliminde olan tüm tüketiciler için geçerlidir: artımlı raporlar, ERP senkron cursor'ları, tutarlılık işi. Bunlar da ya `xid8` görünürlüğü ya da durum alanı (`status = PENDING` gibi) ile çalışır.
- Çıktı akış (stream) olarak doğrudan object storage'a multipart yüklenir; satır sayıları ve checksum parça parça hesaplanır.
- İlerleme yüzdesi, tahmini süre ve iptal edilebilirlik kullanıcıya gösterilir; kesilen iş son tamamlanan parçadan devam eder (`export_jobs.cursor`).
- Aynı mekanizma liste ekranlarındaki büyük CSV/Excel indirmeleri için de kullanılır; belirli satır sayısının üzerindeki indirmeler otomatik olarak arka plan işine çevrilir.

## Kapatma ve silme
Kapatma talebi yeniden doğrulama ister. Tenant `CLOSING_GRACE` durumuna geçer; bu 30 günlük geri açılabilir süredir (hukuki saklama süresi değildir). Ayrılışta tek tık churn anketi.

**`CLOSING_GRACE` süresince ne durur, ne açık kalır:**
| Konu | Davranış |
|---|---|
| Mevcut oturumlar | Tüm kullanıcıların oturumları iptal edilir |
| Yeniden giriş | Yalnızca `takeout.talep_et` yetkisi olan kullanıcılar (sahip/yönetici), MFA ile; diğer kullanıcılar giremez |
| Erişilen arayüz | "Hesap kapatma sürecinde" salt okunur portalı: tüm veriyi görüntüleme, CSV/JSON indirme, takeout talebi, hesabı yeniden açma. Başka ekran yok |
| Yazma | Tümü reddedilir (`TENANT_CLOSING`); açık operasyonlar kapatma öncesinde tamamlanır veya iptal edilir (kapatma ekranı listeler) |
| Entegrasyon/API anahtarları, webhook'lar | İptal edilir |
| Worker işleri | Operasyonel işler (import, senkron, bildirim, AI, tahmin) durur. **Açık kalanlar:** takeout/export, kapatma bildirimleri, silme hazırlığı. Worker her iş başında tenant durumunu kontrol eder ve yalnızca izinli iş türlerini çalıştırır |
| Bekleyen offline komutlar | Reddedilir; cihaz tarafı "hesap kapatıldı" gösterir |
| Faturalama | Yeni dönem tahakkuku durur |

**Yeniden açma:** 30 gün içinde yönetici tek adımda yeniden açar; anahtarlar yeniden üretilir, eski oturumlar geçersiz kalır.

**Süre sonu:** Tenant `DELETION_PENDING` → silme işi. Kayıt sınıfına göre silme/saklama/anonimleştirme (DB, medya, cache, arama, geçici export dosyaları). Silme işi idempotent, parçalı ve izlenebilir. Süre sonunda üretilmiş ama indirilmemiş takeout dosyaları da silinir; kullanıcı son 7 gün ve son gün e-postayla uyarılır. Yedekler kendi döngüsünde sona erer; restore sonrası silme işaretleri yeniden uygulanır.

Ödeme gecikmesi nedeniyle `SUSPENDED` durumu kapatmadan farklıdır: tüm kullanıcılar giriş yapar, veri görüntülenir ve indirilir (I-13), yalnızca yazma kısıtlanır.
