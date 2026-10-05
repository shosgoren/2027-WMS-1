# 16 — Operasyonların Sayısal Stok Etkisi (normatif)

Bu dosya **beklenen değerlerin tek kaynağıdır.** Kod bu tablolarla çelişirse kod hatalıdır. Testler (AC-31, AC-07 ve tüm stok birim testleri) beklenen değerleri buradan alır. Tabloyu değiştirmek ADR + kullanıcı onayı ister.

## Temel kurallar
1. Defter satırı = bir boyutta işaretli miktar (`+` giriş, `−` çıkış). Bakiye = o boyuttaki defter satırlarının toplamı.
2. **Sipariş ve rezervasyon defter satırı üretmez**, fiziksel bakiyeyi değiştirmez.
3. **Lokasyon veya durum değişimi** = aynı miktarda bir `−` ve bir `+` satırı; depo toplam fiziksel miktarı değişmez.
4. **Fiziksel miktarı yalnızca** kabul, sevk, iade, sayım farkı, kayıp/fire, üretim giriş/sarf ve ters kayıt değiştirir.
5. **Kullanılabilir** = Σ fiziksel (`AVAILABLE`, lokasyon türü `STORAGE`/`STAGING`, `pick_blocked = false`) − Σ aktif rezervasyon.
6. **İade sipariş açık miktarını yeniden açmaz.** Yeniden gönderim yeni sipariş/satır ister.
7. Rezervasyon iptali fiziksel stoğu hareket ettirmez; mal sevk alanındaysa geri yerleştirme görevi oluşur.
8. Taşıma birimi (koli/palet) hareketi, içindeki her boyut için bir `−`/`+` çiftidir; taşıma biriminin kendisi stok değildir, toplam fiziksel değişmez. Koli açma = ilgili miktar için `handling_unit_id` dolu boyuttan boş boyuta `−`/`+` çifti.
9. **"Ürün bulunamadı"** defteri değiştirmez: toplama bulunan miktarla kesinleşir, eksik kısmın rezervasyonu serbest kalır, lokasyon `pick_blocked` olur ve sayım görevi açılır; fark yalnızca sayım onayıyla defterleşir. Yeniden tahsis `pick_blocked` lokasyonları kullanmaz; uygun stok yoksa sipariş satırı rezervesiz açık kalır.

## Senaryo A — Pilot akışı (AC-31'in beklenen değerleri)
Tek ürün X, depo D1. Lokasyonlar: `KABUL` (RECEIVING), `R-01` (STORAGE), `SEVK` (STAGING). Takip modu `NONE`. Tenant politikası: kabulde kalite kontrol **açık**. Sipariş S1: 4 adet.

Bakiye sütunları `lokasyon·durum` boyutlarıdır (KAR = QUARANTINE, KUL = AVAILABLE).

| # | İşlem | Defter satırları | KABUL·KAR | KABUL·KUL | R-01·KUL | SEVK·KUL | Fiziksel | Rezerve | Kullanılabilir | S1 istenen / sevk / açık |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Başlangıç | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| 1 | Mal kabul 10 | +10 KABUL·KAR | 10 | 0 | 0 | 0 | 10 | 0 | 0 | — |
| 2 | Kalite onayı 10 | −10 KABUL·KAR, +10 KABUL·KUL | 0 | 10 | 0 | 0 | 10 | 0 | 0 ¹ | — |
| 3 | Yerleştirme 10 → R-01 | −10 KABUL·KUL, +10 R-01·KUL | 0 | 0 | 10 | 0 | 10 | 0 | 10 | — |
| 4 | Sipariş S1 oluşur (4) | — | 0 | 0 | 10 | 0 | 10 | 0 | 10 | 4 / 0 / 4 |
| 5 | Rezervasyon 4 (R-01·KUL'a) | — ² | 0 | 0 | 10 | 0 | 10 | 4 | 6 | 4 / 0 / 4 |
| 6 | Toplama 4 → SEVK | −4 R-01·KUL, +4 SEVK·KUL; rezervasyon 4 SEVK·KUL'a taşınır | 0 | 0 | 6 | 4 | 10 | 4 | 6 | 4 / 0 / 4 |
| 7 | Kısmi sevk 3 | −3 SEVK·KUL; rezervasyondan 3 tüketilir | 0 | 0 | 6 | 1 | 7 | 1 | 6 | 4 / 3 / 1 |
| 8 | Müşteri iadesi 1 (S1 sevkine bağlı) | +1 KABUL·KAR | 1 | 0 | 6 | 1 | 8 | 1 | 6 | 4 / 3 / 1 ³ |
| 9 | S1 kalan 1 iptal | — ; rezervasyon 1 serbest; geri yerleştirme görevi oluşur | 1 | 0 | 6 | 1 | 8 | 0 | 7 | 4 / 3 / 0 (iptal 1) |
| 10 | Geri yerleştirme SEVK → R-01 | −1 SEVK·KUL, +1 R-01·KUL | 1 | 0 | 7 | 0 | 8 | 0 | 7 | — |
| 11 | Sayım R-01: sistem 7, sayılan 6, fark onayı | −1 R-01·KUL (neden: SAYIM) | 1 | 0 | 6 | 0 | 7 | 0 | 6 | — |

¹ Kabul alanı sevke uygun değildir (`RECEIVING`). ² Rezervasyon tablosuna satır yazılır, defter değişmez. ³ İade açık miktarı değiştirmez; S1 satırında `iade = 1` ayrıca tutulur.

**Kontrol:** Fiziksel son = 10 (kabul) − 3 (sevk) + 1 (iade) − 1 (sayım) = **7**. Tüm defter satırlarının toplamı = 7. Açık rezervasyon = 0.

**Varyantlar:**
- Kalite kontrol **kapalıysa** adım 1 doğrudan `+10 KABUL·KUL` olur, adım 2 yoktur.
- Kabulde 1 adet hasarlıysa: `+9 KABUL·KAR`, `+1 KABUL·DAMAGED`; hasarlı stok hiçbir zaman kullanılabilir sayılmaz.
- Takip modu `LOT` ise her sütun lot ile ayrışır (`R-01·KUL·L1`); rezervasyon belirli lota yapılır; FEFO önerisi en erken SKT'li uygun lottur.
- Toplama sırasında "ürün bulunamadı": kural 9 uygulanır. Tam sayısal örnek Senaryo D adım 7'dedir.

## Senaryo D — Tam pilot akışı (AC-40'ın beklenen değerleri)
Senaryo A çekirdek doğrulamadır (tek ürün, tek sipariş). Senaryo D, pilot tanımındaki akışın tamamını içerir: kısmi ve hasarlı kabul, iki ürün, üç sipariş, "ürün bulunamadı", kısmi sevk, iade, iki lokasyonda sayım. Takip modu `NONE`, kalite kontrol açık. Lokasyonlar: `KABUL`, `R-01` (X), `R-02` (Y), `SEVK`.

Girdiler: Beklenen teslim G1 = X 20, Y 10. Gelen = X 18 (2 eksik), Y 10 (1 hasarlı). Siparişler: S1 = X 5 · S2 = X 6, Y 3 · S3 = Y 4. Saha gerçeği (sistem bilmiyor): R-02'ye yerleştirilen 9 Y'nin 3'ü yanlış yere konmuş, R-02'de fiilen 6 var.

| # | İşlem | Defter satırları |
|---|---|---|
| 1 | Mal kabul G1 | X: +18 KABUL·KAR · Y: +9 KABUL·KAR, +1 KABUL·DMG |
| 2 | Kalite onayı | X: −18 KABUL·KAR, +18 KABUL·KUL · Y: −9 KABUL·KAR, +9 KABUL·KUL |
| 3 | Yerleştirme | X: −18 KABUL·KUL, +18 R-01 · Y: −9 KABUL·KUL, +9 R-02 |
| 4 | S1, S2, S3 oluşur | — |
| 5 | Rezervasyon: S1 X5, S2 X6+Y3, S3 Y4 | — |
| 6 | Toplama S1+S2: X 11, Y 3 → SEVK | X: −11 R-01, +11 SEVK · Y: −3 R-02, +3 SEVK |
| 7 | Toplama S3: Y 4 istenir, 3 bulunur, 1 "bulunamadı" | Y: −3 R-02, +3 SEVK; S3 rezervasyonunun 1'i serbest; R-02 `pick_blocked` + sayım görevi; yeniden tahsis: uygun Y yok |
| 8 | Sevk: S1 X5 tam · S2 X6 tam + Y 2 kısmi · S3 Y3 | X: −11 SEVK · Y: −5 SEVK |
| 9 | Müşteri iadesi: S1'den X 1 | X: +1 KABUL·KAR |
| 10 | Kilitli sayım R-01 ve R-02; fark onayı | X R-01: sistem 7, sayılan 7 → satır yok · Y R-02: sistem 3, sayılan 0 → −3 R-02 (SAYIM); kilitler ve `pick_blocked` kalkar |

**Ürün X — her adım sonrası**
| # | KABUL·KAR | KABUL·KUL | R-01 | SEVK | Fiziksel | Rezerve | Kullanılabilir |
|---|---|---|---|---|---|---|---|
| 1 | 18 | 0 | 0 | 0 | 18 | 0 | 0 |
| 2 | 0 | 18 | 0 | 0 | 18 | 0 | 0 |
| 3 | 0 | 0 | 18 | 0 | 18 | 0 | 18 |
| 4 | 0 | 0 | 18 | 0 | 18 | 0 | 18 |
| 5 | 0 | 0 | 18 | 0 | 18 | 11 | 7 |
| 6–7 | 0 | 0 | 7 | 11 | 18 | 11 | 7 |
| 8 | 0 | 0 | 7 | 0 | 7 | 0 | 7 |
| 9–10 | 1 | 0 | 7 | 0 | 8 | 0 | 7 |

**Ürün Y — her adım sonrası**
| # | KABUL·KAR | KABUL·KUL | KABUL·DMG | R-02 | SEVK | Fiziksel | Rezerve | Kullanılabilir |
|---|---|---|---|---|---|---|---|---|
| 1 | 9 | 0 | 1 | 0 | 0 | 10 | 0 | 0 |
| 2 | 0 | 9 | 1 | 0 | 0 | 10 | 0 | 0 |
| 3–4 | 0 | 0 | 1 | 9 | 0 | 10 | 0 | 9 |
| 5 | 0 | 0 | 1 | 9 | 0 | 10 | 7 | 2 |
| 6 | 0 | 0 | 1 | 6 | 3 | 10 | 7 | 2 |
| 7 | 0 | 0 | 1 | 3 | 6 | 10 | 6 | 0 ¹ |
| 8–9 | 0 | 0 | 1 | 3 | 1 | 5 | 1 | 0 ¹ |
| 10 | 0 | 0 | 1 | 0 | 1 | 2 | 1 | 0 |

¹ R-02 `pick_blocked` olduğu için kullanılabilire dahil değil.

**Belge ve sipariş son durumu**
| Belge | Satır | İstenen | Kabul/Sevk | Açık | Not |
|---|---|---|---|---|---|
| G1 | X | 20 | 18 | 2 | Tedarikçiden beklenen eksik |
| G1 | Y | 10 | 10 | 0 | 1 hasarlı (KABUL·DMG) |
| S1 | X | 5 | 5 | 0 | 1 iade (açık miktarı değiştirmez) |
| S2 | X | 6 | 6 | 0 | |
| S2 | Y | 3 | 2 | 1 | 1 rezerve, SEVK'te bekliyor |
| S3 | Y | 4 | 3 | 1 | Rezervesiz; stok yok (sayım farkı sonrası) |

**Kontrol:** X fiziksel = 18 − 11 + 1 = **8**. Y fiziksel = 10 − 5 − 3 = **2** (1 hasarlı + 1 SEVK'te rezerve). Her iki ürün için defter satırları toplamı fiziksel ile birebir; açık rezervasyon toplamı 1.

## Senaryo B — Transfer (AC-07'nin beklenen değerleri)
D1/R-01'de 20 adet. Transit lokasyonu `TR-D1-D2` (TRANSIT). Hedef D2.

| # | İşlem | Defter satırları | D1 R-01·KUL | TR-D1-D2·KUL | D2 KABUL·KUL | Tenant toplam fiziksel | D1 kullanılabilir | D2 kullanılabilir |
|---|---|---|---|---|---|---|---|---|
| 0 | Başlangıç | — | 20 | 0 | 0 | 20 | 20 | 0 |
| 1 | Transfer çıkışı 20 | −20 D1 R-01·KUL, +20 TR·KUL | 0 | 20 | 0 | 20 | 0 | 0 |
| 2 | Hedef kabul 15 | −15 TR·KUL, +15 D2 KABUL·KUL | 0 | 5 | 15 | 20 | 0 | 0 ¹ |
| 3 | Kalan 5 için kayıp onayı | −5 TR·KUL (neden: TRANSFER_KAYIP) | 0 | 0 | 15 | 15 | 0 | 0 ¹ |

¹ D2'de yerleştirme yapılana kadar kullanılabilir 0'dır. Adım 3 onaylanmadan transit 5 açık kalır ve raporda görünür; kayıp yalnızca yetkili onayla defterleşir.

## Senaryo C — Ters kayıt (AC-06)
Giriş belgesi G1: +100 R-01·KUL. Ardından 60 adet sevk edildi; R-01·KUL = 40.
| İstek | Sonuç |
|---|---|
| G1'in tamamını ters çevir (−100) | Ret `REVERSAL_BLOCKED`: kalan 40 < 100. Hiçbir satır yazılmaz |
| G1'den 40 ters çevir | −40 R-01·KUL; G1 ters kayıt durumu `PARTIAL` (40/100); R-01·KUL = 0 |
| Aynı 40'lık ters kayıt isteği tekrar (aynı idempotency anahtarı) | İlk sonuç döner; ikinci −40 yazılmaz |
