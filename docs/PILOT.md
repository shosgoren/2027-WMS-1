# Etkin WMS — Pilot tanımı (VARSAYIMSAL PROFİL)

**Durum:** Varsayımsal profil (2026-10-05). Gerçek pilot müşteri yok (kullanıcı cevabı, 2026-10-05). Sektör kullanıcı tarafından seçildi ("ambalaj, hırdavat benzeri"); diğer değerler Supervisor önerisidir. Her varsayımsal satır `A-xx` ile işaretlidir ve hepsi **Q-12** ile gerçek pilot müşteride doğrulanır, en geç Faz 3A başlamadan (`PHASES.md §Pilot tanımı` tamlık kuralı). Doğrulanmamış `A-xx` varken Faz 3A kapısı kapanmaz.

**Kaynak sözleşme:** `docs/tasks/T-006.md` (anahtar ve enum listesi). Aşağıdaki tablo `check:pilot` (T-008f) tarafından makine olarak okunur: sütunlar sabit, `key` İngilizce snake_case (ADR-002), Varsayım sütunu yalnızca `A-xx`, `DOĞRULANDI` veya `SABİT`. Bu dosyada başka tablo yoktur.

| key | Alan | Değer | Varsayım |
|---|---|---|---|
| sector | Sektör (tek): ambalaj ve sarf toptancısı; tasarım örneği karton kutu, koli bandı | PACKAGING_SUPPLIES | A-11 |
| customer_code | Müşteri kodu (gerçek ad yazılmaz, G-09) | PILOT-A | A-12 |
| warehouse_count | Depo sayısı | 1 | SABİT |
| location_count | Lokasyon sayısı | 120 | A-13 |
| location_depth | Lokasyon derinliği (Bölge, Raf, Göz) | ZONE>RACK>BIN | A-14 |
| active_sku_count | Aktif SKU sayısı | 300 | A-15 |
| tracking_mode.ALL | Takip modu, ürün grubu ALL (tüm ürünler) | NONE | A-16 |
| expiry_tracking | SKT takibi | NO | A-17 |
| expiry_fefo | FEFO kuralı | NOT_APPLICABLE | A-18 |
| min_shelf_life_days | Minimum kalan raf ömrü (gün) | NOT_APPLICABLE | A-19 |
| handling_unit_mode | Koli ve palet kullanımı (PHASES seçenek a: yalnızca birim) | UNIT_ONLY | A-20 |
| partial_case_opening | Kısmi koli açma | YES | A-21 |
| stock_owner | Stok sahibi | SINGLE | A-22 |
| current_system | Mevcut sistem | EXCEL | A-23 |
| opening_stock_source | Açılış stoku kaynağı | EXCEL_IMPORT | A-24 |
| daily_receipt_lines | Günlük ortalama kabul satırı | 30 | A-25 |
| daily_order_lines | Günlük ortalama sipariş satırı | 60 | A-26 |
| daily_shipment_lines | Günlük ortalama sevk satırı | 60 | A-27 |
| users_by_role | Kullanıcı sayısı ve rolleri | 1 yönetici, 1 depo şefi, 3 toplayıcı | A-28 |
| devices | Cihazlar | Saha: personelin kendi Android veya iPhone telefonu, kamera ile okutma (mobil web veya PWA), ek donanım zorunlu değil; yönetici: bilgisayar veya telefon; el terminali veya USB okuyucu isteğe bağlı | A-29 |
| label_printer | Etiket yazıcısı | ZPL, 203 dpi, ağ yazıcısı | A-30 |
| offline_required | Offline gerekli mi | NO | A-31 |
| erp_integration | ERP bağlantısı (pilotta Excel import ve export) | NONE | SABİT |
| base_units | Temel birim | ADET (koli = birim dönüşümü) | A-32 |
| quantity_decimals | Miktar ondalık hanesi | 0 | A-33 |
| success.unexplained_count_diff_max | Pilot sonu sayımında açıklanamayan fark üst sınırı (adet) | 5 | A-34 |
| success.unassisted_tasks_per_week_max | Personelin destek almadan tamamlayamadığı görev üst sınırı (haftada adet; pilot boyunca azalan) | 3 | A-35 |

## Kullanıcı yönü (2026-10-07; T-285)
Gerçek pilot müşteri ve ölçülmüş işlem hacmi YOK; aşağıdakiler ürün yönüdür, kesin değer değildir. Gerçek personel sayısı, raf düzeni, hacim ve takip ihtiyacı müşteri seçildiğinde doğrulanır (Q-12).
- **Sektör:** ambalaj, hırdavat ve benzeri ürünleri yöneten küçük/orta ölçekli depolar.
- **Hacim:** günlük kabul/sipariş/sevk satırı bilinmiyor; A-25, A-26, A-27 ve A-28 yalnız geliştirme ve test varsayımıdır.
- **Cihaz:** saha personeli kendi Android/iPhone telefonu; raf ve ürün barkodu telefon kamerasıyla mobil web/PWA üzerinden okunur; başlangıçta ek donanım zorunlu değil (A-29; T-286). iPhone'da tüm tarayıcılar WebKit kullandığından tarayıcının yerleşik barkod API'sine güvenilmez; çözme uygulama içinde yapılır.
- **Koli/adet:** koli içi adet ürün bazında tanımlanır; gerektiğinde koli açılıp adetle işlem yapılır; gerçek dönüşüm değerleri müşteriyle belirlenir (A-20, A-21; T-287).
- **Lot/seri/SKT:** ilk pilot için zorunlu değil; mimari destekler (A-16, A-17).
- **Bağlantı:** depo Wi-Fi/mobil kapsaması bilinmiyor; pilot öncesi ölçülür; kesinti varsa offline pilot kapsamına girer (A-31, Q-102).
- **Temel hedef:** minimum veri girişi ve dokunuşla doğru işlem; personel sıradaki rafı, ürünü ve miktarı açıkça görür; görev dağıtımı ve az yürüme sağlayan toplama planı somut zaman kazandırır.
- **Ses:** ileride üst paket; aynı işler ses kapalıyken basit ve rehberli arayüzle yapılabilir.

## Tutarlılık (T-006 kabul ölçütü)
- `expiry_tracking = NO` olduğundan `expiry_fefo` ve `min_shelf_life_days` = `NOT_APPLICABLE`; lot şartı doğmaz.
- `handling_unit_mode = UNIT_ONLY` olduğundan ADR-011'in "kabul" olması `check:pilot` tarafından bu profil için şart koşulmaz. ADR-011 Faz 0 kapısında ayrıca kabul gerektirir (`PHASES.md` Faz 0 satırı); bu dosya o şartı değiştirmez.
- `offline_required = NO` geçici varsayımdır (A-31): kapsama bilinmiyor; pilot öncesi ölçümde (Q-102) kesinti çıkarsa YES olur ve Faz 5 pilot öncesine alınır.
- Sabit satırlar yalnızca `PHASES.md`'nin sabitlediği `warehouse_count = 1` ve `erp_integration = NONE`.

## Modele ve faz kapılarına etkisi
- **Faz 2:** Lot ve seri tabloları ile boyut alanları takip modu kararı gereği yine kurulur; `handling_unit_id` boyutu ADR-011 varsayılanıyla kurulur. Koli, birim dönüşümü ve paket barkodu ile modellenir (PHASES seçenek a).
- **Faz 3A:** Lot ve seri ekranı yok; koli barkodu okutulunca adet otomatik gelir. Koşullu **AC-34 (lot), AC-38 (izlenen koli ve palet), AC-41 (SKT ve FEFO), AC-42 (seri)** koşulları bu profilde sağlanmaz; Faz 3A kapısına girmez, 3B'ye kalır. Gerçek pilot doğrulaması (Q-12) takip modunu, SKT'yi veya koli modunu değiştirirse bu AC'ler 3A kapısına geri girer.
- **Faz 5:** Şu an pilot öncesine alınmaz; Q-102 ölçümünde kesinti çıkarsa alınır (yukarıdaki `offline_required` notu).

## Pilot başarı ölçütleri
`PHASES.md §Pilot başarı ölçütleri` geçerlidir; müşteriyle belirlenecek iki boşluk yukarıdaki `success.*` satırlarıdır (A-34, A-35). "Sistemde işlenen hareket satırı" hedefindeki günlük hacmin hangi satır türlerinden oluştuğu açık sorudur (Q-13); bu dosya bir toplam hesaplamaz.
