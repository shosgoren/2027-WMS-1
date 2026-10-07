# DESIGN_REVIEW — Telefon ana ekranı tasarım denetim ölçütleri (T-270)

> Bu belge **uygulamadan önce** yazıldı; ölçütler ve eşikler ekran görüntüsü üretildikten sonra değiştirilmez.
> Dayanak: T-270 kartı, `docs/ux/UX_NOVICE.md` (N-01, N-07, N-09, N-16), ADR-020 (renk tek taşıyıcı değildir).
> Her UI kartı için aynı şablon kullanılır: yeni kart kendi ölçüt tablosunu bu belgeye bölüm olarak ekler.

## 1. Nasıl uygulanır

1. Uygulayıcı her aday için 360×740, 390×844, 430×932 ekran görüntüsü + ölçüm çıktısı üretir (`.artifacts/<kart>/`).
2. Puanlayıcı (uygulayıcıdan ayrı ajan; uygulayıcı kendi puanını yalnızca aday seçimi için kullanır) tabloyu doldurur.
3. Puan: **2** = geçer, **1** = kısmen (düzeltme önerilir), **0** = geçmez. Her ölçüt için geçer eşiği "2"dir.
4. **Birleştirme eşiği:** hiçbir ölçütte 0 yok **ve** toplam ≥ %90 (11 ölçüt × 2 = 22 puan → ≥ 20). Ölçüt başına 1 puan "geçer" sayılmaz; gerekçesiyle kayıtlı kabul riski olmalıdır.
5. Supervisor görüntüyü kullanıcıya göstermeden birleştirmez (kart §5).

## 2. Ölçütler (T-270 ana ekran, telefon)

Ölçüm alanı: üst çubuğun altı ile alt sekme çubuğunun üstü arası ("içerik alanı"). "Döşeme" = etkin + kilitli iş döşemesi (Yakında satırı ve selam alanı döşeme değildir).

| No | Ölçüt | Ölçüm | Geçer (2) | Kısmen (1) | Geçmez (0) |
|---|---|---|---|---|---|
| D-01 | Izgara eşitliği | Tüm görünür döşemelerin genişlik ve yüksekliği | Her üç genişlikte fark ≤ 2 px; satırda yetim döşeme yok (tek kalan tam genişlik de eşit sayılmaz, bkz. not) | Fark 3–8 px | > 8 px ya da yetim |
| D-02 | Başparmak bölgesi | Izgara alt kenarı ile alt sekme üstü arası boşluk; en öncelikli işin konumu | Boşluk ≤ 16 px ve ilk öncelikli döşeme en alt satırda | Boşluk 17–32 px ya da öncelikli iş en altta değil | > 32 px |
| D-03 | Boş alan oranı | İçerik alanında selam, Yakında satırı ve ızgara kutularının birleşimi dışında kalan dikey piksel / içerik alanı | ≤ %15 | %16–25 | > %25 |
| D-04 | Döşeme yüksekliği | En küçük/en büyük döşeme yüksekliği | 88–140 px | 80–87 ya da 141–180 px | < 80 ya da > 180 px |
| D-05 | İkon anlamı ve kategori rengi | Her döşemede ikon + görünür metin; ikonlar birbirinden farklı; kategori → renk eşlemesi: giriş success, çıkış warning, taşıma info, sayım mor, katalog/depo accent, yönetim nötr | Tüm döşemeler eşlemeye uyar, 0 yinelenen ikon, metinsiz döşeme yok | 1 yinelenen ikon ya da 1 yanlış eşleme | ≥ 2 sorun ya da yalnız renk anlam taşıyor |
| D-06 | Yumuşak ton | Döşeme yüzeyi ve ikon zemini yalnız `*-bg`/`accent-soft`/`surface` belirteçleri; dolu (doygun) anlam rengi zemin yok; marka mavisi yalnız birincil eylem/seçili sekme/logo | Hepsi uyar; hesaplanan zemin göreli parlaklığı ≥ 0,80 | 1 sapma | ≥ 2 sapma |
| D-07 | Hiyerarşi ve sıra | Saha işleri yönetim işlerinden önce (DOM sırası); PICKER'da ilk döşeme saha işi; selam ≤ 2 satır; Yakında döşeme olarak yer kaplamıyor | Hepsi doğru | 1 sapma | ≥ 2 sapma |
| D-08 | Dokunma hedefi | Görünür tüm etkileşimli öğelerin boyutu ve komşu aralığı | Hepsi ≥ 48×48 px, aralık ≥ 8 px | 44–47 px | < 44 px |
| D-09 | Taşma ve okunurluk (360/390/430) | Yatay taşma; sayfa dikey kayması; döşeme başlığı kesilmesi (`scrollWidth > clientWidth` ya da `…`) | 0 taşma, 0 kayma, 0 kesilen başlık | 1 başlık 3 satır | taşma/kayma/kesilme var |
| D-10 | Kontrast | `theme-contrast.test.ts`: metin ≥ 4,5:1, ikon ≥ 3:1 (Akış + Kokpit); belirteç dışı hex yok | Test yeşil, yeni çiftlerin tümü listede | — | Test kırmızı ya da çift eksik |
| D-11 | Dil ve hata | Görünür tüm metin i18n anahtarı (TR+EN eşit); sunucu hatası kod + sonraki eylemle gösterilir; alan kuralı UI'da yeniden yazılmamış | 0 sabit metin, hata yolu mevcut | 1 sabit metin | ≥ 2 ya da hata yutuluyor |

Not (D-04): ölçüm boyutları yukarıdaki üç boyuttur. Görünür yüksekliği < 700 px olan telefonlarda (Safari araç çubukları açık, 390×664) T-254 "kaydırmasız sığma" kuralı önceliklidir; alt sınır 72 px'e iner (bu boyutta yalnız D-01, D-03 ve D-08 yeniden ölçülür).

Not (D-01): kartın "tek sayıda döşeme" kuralı gereği son döşeme tam genişlik olabilir; bu durumda eşitlik **yükseklik** (±2 px) ve her satırın tam genişliği doldurması ile ölçülür, yetim = satırda boşluk bırakan döşeme. 1 sütunlu aday tüm satırlarda aynı genişlik olduğundan bu ölçütten etkilenmez.

## 3. Kural dışı saptırmalar

Adaylar kartın bir sayısal hedefinden saparsa (ör. 2 sütun, 88–140 px) puan tablosunda ayrıca "Kart sapması" satırı yazılır ve Supervisor'a raporlanır.

## 4. Kayıt şablonu (puanlayıcı doldurur)

| Aday | D-01 | D-02 | D-03 | D-04 | D-05 | D-06 | D-07 | D-08 | D-09 | D-10 | D-11 | Toplam | Karar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (örnek) A | | | | | | | | | | | | /22 | |

Kanıt: `.artifacts/t-270/` (ekran görüntüsü + `metrics-*.json`). Ölçümler Playwright mobil projesinden alınır.

## 5. T-270 puan kaydı

Tarih 2026-10-07. Puanlayan: **uygulayıcı (aday seçimi için)**; ayrı denetçi ajan puanı ve Supervisor'ın kullanıcıya gösterimi AÇIK (kart §5, bu belge §1.5). Kanıt: `.artifacts/t-270/variant-{a,b}-admin-{360,390,430}.png`, `metrics-variant.json` (geçici `?v=a|b` anahtarıyla aynı derlemeden alındı; anahtar nihai kodda yok).

**Adaylar.** A: 2 sütun dikey döşeme (ikon üstte, başlık altta), alttan yukarı doldurma, yetim son döşeme en üstte tam genişlik. B: tek sütun yatay satır (ikon solda, başlık + açıklama, sağ ok), alttan yukarı doldurma. İkisinde de: Yakında = tek satırlık düğme, kategori yumuşak renkleri, aynı sıra (kaynak: `TASKS`).

Ölçümler (yönetici, 5 döşeme): A döşeme yüksekliği 162 / 197 / 226 px (360 / 390 / 430), boş alan %7,0 / 6,0 / 5,4, alt boşluk 8 px. B döşeme yüksekliği 94 / 115 / 132 px, boş alan %9,6 / 8,2 / 7,3, alt boşluk 8 px. İkisinde taşma 0, sayfa kayması 0.

| Aday | D-01 | D-02 | D-03 | D-04 | D-05 | D-06 | D-07 | D-08 | D-09 | D-10 | D-11 | Toplam | Karar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 2 | 2 | 2 | **0** (162-226 px; 390 ve 430'da > 180) | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 20/22 | Geçmez (D-04 = 0); dolgun ama içi boş, 230 px'lik tam genişlik yetim |
| B | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 22/22 | Seçildi |

**Kart sapması (§3):** B telefonda 2 sütun değil 1 sütundur. Gerekçe: kartın "2 sütun + 88-140 px + boş alan ≤ %15" üçlüsü 5 döşemeyle birlikte sağlanamaz (A'da boşluk korunursa döşemeler 160-226 px olur; döşeme sınırı korunursa boş alan %25-30). B üçünü birden sağlar, açıklama metnini görünür tutar (N-08/N-09) ve yetim döşeme sorunu yapısal olarak yoktur. 6'dan fazla iş olduğunda alttan yukarı doldurma kapanır ve içerik alanı kayar; o durumda 2 sütun takip kartıdır.

D-04 kısa ekran notu uygulandı (390×664 kaydırmasız sığma, alt sınır 72 px); mevcut `mobile-shell` döngüsünün 5 etkin döşeme için bu boyutta geçtiği doğrulandı.

