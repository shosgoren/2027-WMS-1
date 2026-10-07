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

Ölçüm alanı: üst çubuğun altı ile alt sekme çubuğunun üstü arası ("içerik alanı"). "Döşeme" = yalnız ETKİN iş döşemesi (kilitli ve Yakında liste satırları, açıklama panelleri ve selam alanı döşeme değildir; T-274). Eşikler değişmedi.

| No | Ölçüt | Ölçüm | Geçer (2) | Kısmen (1) | Geçmez (0) |
|---|---|---|---|---|---|
| D-01 | Izgara eşitliği | Tüm görünür döşemelerin genişlik ve yüksekliği | Her üç genişlikte fark ≤ 2 px; satırda yetim döşeme yok (tek kalan tam genişlik de eşit sayılmaz, bkz. not) | Fark 3–8 px | > 8 px ya da yetim |
| D-02 | Başparmak bölgesi | Izgara alt kenarı ile alt sekme üstü arası boşluk; en öncelikli işin konumu | Boşluk ≤ 16 px ve ilk öncelikli döşeme en alt satırda | Boşluk 17–32 px ya da öncelikli iş en altta değil | > 32 px |
| D-03 | Boş alan oranı | İçerik alanında selam, Yakında satırı ve ızgara kutularının birleşimi dışında kalan dikey piksel / içerik alanı | ≤ %15 | %16–25 | > %25 |
| D-04 | Döşeme yüksekliği | En küçük/en büyük döşeme yüksekliği | 88–140 px | 80–87 ya da 141–180 px | < 80 ya da > 180 px |
| D-05 | İkon anlamı ve kategori rengi | Her döşemede ikon + görünür metin; ikonlar birbirinden farklı; her ETKİN döşeme (yönetim dahil) kendi `cat-*` tonunu taşır, tonlar birbirinden ve seçili sekme mavisinden (`accent-soft`) farklı: giriş green, çıkış orange, taşıma teal, sayım purple, nerede sky, düzelt rose, Ürünlerim amber, Depo cyan, Ekip indigo, Ayarlar slate, Kim ne yaptı lilac | Tüm döşemeler eşlemeye uyar, 0 yinelenen ikon, metinsiz döşeme yok | 1 yinelenen ikon ya da 1 yanlış eşleme | ≥ 2 sorun ya da yalnız renk anlam taşıyor |
| D-06 | Yumuşak ton | TEK döşeme biçemi: beyaz (`surface`) döşeme + `cat-*-bg` ikon dairesi içinde koyu `cat-*-ink` ikon; döşeme zemini boyanmaz; dolu (doygun) anlam rengi zemin yok; marka mavisi yalnız birincil eylem/seçili sekme/logo; daire zemini göreli parlaklığı ≥ 0,80 | Hepsi uyar | 1 sapma | ≥ 2 sapma |
| D-07 | Hiyerarşi ve sıra | Saha işleri yönetim işlerinden önce (DOM sırası); PICKER'da ilk döşeme saha işi; yetkisiz işler PICKER'da üstte TEK kapalı satırda (gerekçe cümlesi açılınca bir kez); selam ≤ 2 satır; Yakında döşeme olarak yer kaplamıyor; açık listeler alttan yukarı dolu, kapatma düğmesi altta | Hepsi doğru | 1 sapma | ≥ 2 sapma |
| D-08 | Dokunma hedefi | Görünür tüm etkileşimli öğelerin boyutu ve komşu aralığı | Hepsi ≥ 48×48 px, aralık ≥ 8 px | 44–47 px | < 44 px |
| D-09 | Taşma ve okunurluk (360/390/430) | Yatay taşma; sayfa dikey kayması; döşeme başlığı kesilmesi (`scrollWidth > clientWidth` ya da `…`) | 0 taşma, 0 kayma, 0 kesilen başlık | 1 başlık 3 satır | taşma/kayma/kesilme var |
| D-10 | Kontrast | `theme-contrast.test.ts`: metin ≥ 4,5:1, ikon ≥ 3:1 (Akış + Kokpit); belirteç dışı hex yok | Test yeşil, yeni çiftlerin tümü listede | — | Test kırmızı ya da çift eksik |
| D-11 | Dil ve hata | Görünür tüm metin i18n anahtarı (TR+EN eşit); sunucu hatası kod + sonraki eylemle gösterilir; alan kuralı UI'da yeniden yazılmamış | 0 sabit metin, hata yolu mevcut | 1 sabit metin | ≥ 2 ya da hata yutuluyor |

Not (D-04): ölçüm boyutları yukarıdaki üç boyuttur. Görünür yüksekliği < 700 px olan telefonlarda (Safari araç çubukları açık, 390×664) T-254 "kaydırmasız sığma" kuralı önceliklidir; alt sınır 72 px'e iner (bu boyutta yalnız D-01, D-03 ve D-08 yeniden ölçülür). D-04'ün 88-140 px aralığı HER rol için geçerlidir (eşik ekran görüntüsünden sonra değiştirilmez; ikinci denetim bulgusu).

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


## 6. Düzeltme turu (bağımsız inceleme sonrası)

Bağımsız tasarım denetimi (Supervisor): ölçülen 18 ölçüt üzerinden 13/18, karar **geçmez**. Yukarıdaki §5 uygulayıcı özpuanı (22/22) fazla iyimserdi: ölçüt tablosu doğruydu ama renk yönü (kullanıcının "turuncu, yeşil, yumuşak" isteği), PICKER ekranı, açık "Yakında" listesi ve ince biçim bulguları kapsanmamıştı. Bu nedenle özpuan aday seçimi dışında karar kanıtı sayılmaz.

Giderilen maddeler: (P1.1) döşeme biçemi tek ve beyaz, renk yalnız ikon dairesinde, her etkin döşeme (yönetim dahil) kendi `cat-*` tonunda, tonlar durum anlamından ayrı ve seçili sekme mavisinden farklı; (P1.2) PICKER'da yetkisiz işler üstte tek kapalı satır, gerekçe cümlesi bir kez; (P1.3) açık "Yakında" listesi alttan yukarı dolu (boş alan ≤ %15), kapatma düğmesi altta, "Yakında" etiketi küçük ve nötr, başlıklar ≤ 2 satır; (P2.4) üst düğmeler düz açık kenarlıklı, önizleme renkli ikonlar küçük ve dairesiz; (P2.5) tall döşemede dikey büyük ikon + başlık; (P2.6) "Ayarlar" kısa etiketi; (P3.7) Ürünlerim ikonu `Boxes`; (P3.8) Görevlerim sekmesi tek satır + küçük nokta (erişilebilir ad "Görevlerim, Yakında"). Ölçümler `mobile-shell` T-270 testindedir (3 boyut x 2 rol, açık ve kapalı).

İkinci bağımsız inceleme: 14/18, "geçmez"; P1 maddeleri (renk, tek biçem, Yakında) çözülmüş sayıldı. Son hedefli tur (üçüncü inceleme bekleniyor):

- **Rubrik bütünlüğü:** D-04'teki PICKER istisnası kaldırıldı; e2e'deki `activeCount >= 5` koşulu kaldırıldı, 88-140 px her rolde ölçülüyor.
- **PICKER:** döşemeler en çok 140 px, altta; boşalan alan gerçek içerikle dolu: "Görevlerim" özet kartı (`listMyTasks` = mevcut domain sorgusu, `stock.view`, tenant bağlamı domain'de; sayım yalnız bana atanmış ASSIGNED işler, tek sayfaya sığmazsa "n+") — n>0 ise tek dokunuşla `/t/<slug>/field/tasks`, n=0 ise sakin boş durum satırı, sorgu hatasında sunucu mesajı + kod. Kart yalnız yönetim yetkisi (`users.manage`) olmayan rollerde çizilir. Alt sekme "Görevlerim" gerçek ekrana bağlandı, "Yakında" noktası kalktı.
- **Açık listeler:** yetkisiz ve Yakında listeleri alttan yukarı: tek açıklama paneli (boşluğu doldurur, `emptyRatio` ≤ %15 üç boyutta ölçülür) + kompakt (56-64 px), gölgesiz, nötr renkli, oksuz satırlar; "İşlere dön" düğmesinde kilit ikonu yok.
- **Ton ayrımı (ΔE):** Ekip indigo → violet-indigo (`cat-indigo` bg #ebe5fc / ink #47299c; Sayım purple bg #f0e5fb / ink #6a1fb0). Seçili sekme `accent-soft` #e3ecfa / `accent-ink` #0f4699'a göre: indigo daire zemini önce ΔE2000 5,1 (kontrast oranı 1,037) idi, şimdi ΔE2000 8,5 (1,029); indigo ikon rengi önce ΔE2000 6,8, şimdi 13,1 (kontrast oranı 1,141). Pastel zeminler doğası gereği birbirine yakındır; ayrımı ikon rengi + ikon şekli + metin taşır. `theme-contrast.test.ts` artık tüm tonlar için CIE76 ΔE zemin ≥ 5 ve ikon ≥ 20 (seçili sekme mavisine göre) denetler.


## 7. T-274 ölçütleri (Ürünler ekranı + ana ekran P3) — uygulamadan ÖNCE yazıldı, ekran görüntüsünden sonra değişmez

Ölçüm: telefon (Playwright `mobile` projesi), 360×740, 390×844, 430×932; ölçümler `mobile-shell.spec.ts` içindedir, görüntüler `.artifacts/t-274/final-*.png`. Puan 2/1/0; birleştirme eşiği: hiçbir ölçütte 0 yok ve toplam ≥ %90 (H-01 kaldırıldı: 11 ölçüt × 2 = 22 → ≥ 20). Bağımsız puanlayıcı uygulayıcının puanını geçersiz kılabilir.

| No | Ölçüt | Geçer (2) | Kısmen (1) | Geçmez (0) |
|---|---|---|---|---|
| I-01 | Tek arama alanı: Gelişmiş kapalıyken görünür metin girişi / seçim / "Ara" düğmesi sayısı | 1 giriş, 0 ek denetim | 2 giriş ya da 1 ek denetim | ≥ 3 |
| I-02 | Kaydırmasız ilk görünüm: arama alanı ve "Yeni ürün" üst çubuk–alt sekme arasında tam görünür; yatay taşma | İkisi görünür, taşma 0 | — | biri görünmez ya da taşma |
| I-03 | Başparmak bölgesi: "Yeni ürün" alt kenarı ile alt sekme üstü arası | ≤ 16 px | 17–32 px | > 32 px |
| I-04 | Açıklama paragrafı satır sayısı (telefon) | 1 | 2 | ≥ 3 |
| I-05 | Dokunma hedefi (görünür tüm etkileşimli öğeler) | Hepsi ≥ 48×48 | 44–47 | < 44 |
| I-06 | Tek alanla kod, ad ve barkod yazılarak bulunur (e2e) | Üçü de | İkisi | ≤ 1 |
| I-07 | Eski kodla arama sonucunda (GET sayfası ve öneri) "kod değişti" bilgisi | İkisinde de | Birinde | Hiçbirinde |
| I-08 | Dil ve hata: sabit metin yok, TR/EN eşit, sunucu hatası kod + sonraki eylem | Sağlanır | 1 sabit metin | ≥ 2 ya da hata yutuluyor |
| H-01 | ~~Gerekçe kartı yüksekliği ≤ 160 px~~ **KALDIRILDI (Supervisor kararı, a67bd63 sonrası):** D-03 `emptyRatio ≤ %15` önceliklidir, kart boşluğu doldurur. Boşluk ayrıca açık listelerdeki satırların gerçek tek satırlık açıklamasıyla (`tasks.*.description`) ve ≤ 72 px satırla azaltıldı. | — | — | — |
| H-02 | Boş durum kartı (`my-tasks-empty`) yüksekliği ve "Tara ile başla" gerçek bağlantı (`/t/<slug>/field`) | ≤ 120 px + bağlantı | 121–140 px | > 140 px ya da bağlantı yok |
| H-03 | Saat ikonu boyutu 360/390/430'da tutarlı | Fark ≤ 1 px | 2–4 px | > 4 px |
| H-04 | Gerekçe kartı alttan bitişik: kart alt kenarı ile ilk liste satırı üstü arası; D-03 boş alan eşiği (≤ %15) bozulmaz | ≤ 16 px ve D-03 geçer | 17–32 px | > 32 px ya da D-03 kırılır |

### 7.1 Supervisor kararı (2026-10-07, görsel inceleme sonrası): AÇIK ikincil listelerde `emptyRatio` uygulanmaz

Gerekçe: "metrik doldurma kutusu üretiyordu; kullanıcı görsel kalitesi öncelikli". Önceki "emptyRatio önceliklidir" kararı (a67bd63) bu kararla DEĞİŞTİRİLDİ; ekran görüntüsünde yetkisiz liste açıkken ekranın yaklaşık yarısı yalnız kilit ikonu ve tek cümle taşıyan kutuydu.

- **Kapsam:** D-03 (`emptyRatio ≤ %15`) yalnız KAPALI ana ekran için geçerlidir ve değişmedi. Açık Yakında / yetkisiz listelerinde yerine **H-05** geçer.
- **H-05 (açık liste, doldurma yok):** etkileşimli ya da gerçek içerik taşımayan hiçbir kutu ≤ 160 px (2); 161–200 (1); > 200 (0). Satırlar altta: kapatma düğmesi alt sekmenin ≤ 16 px üstünde (2); 17–32 (1); > 32 (0). Açıklama satırların üstünde TEK kompakt başlık satırıdır ("Bu işler için yetkin yok. Sorumluna sorabilirsin."); üstündeki zemin düz kalır. e2e: `expectExpandedList` (mobile-shell).
- **I-09 (N-01, kurulum rehberi):** kurulum tamamlanmadıysa rehber TEK kompakt satır ("Kurulum 0/3 · Sıradaki: Depo ekle", ok ile açılır); kapalıyken dolu düğme yok, "Yeni ürün" tek birincil eylem (2); aksi 0.
- **I-10:** sabit çubuğun altında içerik kalmaz (liste sonu ≤ çubuk üstü) (2).
- **I-11 (arama alanı örnek metni "Örn. URN-0001, koli ya da barkod"):** alanda görünür örnek metin var (2); yok (0). `Typeahead` opsiyonel `placeholder` prop'u (604663e kapsam eki); diğer kullanıcılar değişmedi. e2e: mobile-shell.
