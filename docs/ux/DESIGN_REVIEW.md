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
| H-04 | ~~Gerekçe kartı alttan bitişik~~ **DEĞİŞTİ (bkz. §7.1, §7.2):** açık listelerde D-03 (`emptyRatio`) uygulanmaz, yerine H-05; D-03 yalnız KAPALI ana ekranda geçerlidir. Gerekçe kartı kalktı; açıklama tek başlık satırıdır. §7.3 ile B-01 (alt sayfa) bu ölçütü de yerine alır. | — | — | — |

### 7.1 Supervisor kararı (2026-10-07, görsel inceleme sonrası): AÇIK ikincil listelerde `emptyRatio` uygulanmaz (açık liste ölçütleri §7.3 B-01/B-02 ile yeniden tanımlandı)

Gerekçe: "metrik doldurma kutusu üretiyordu; kullanıcı görsel kalitesi öncelikli". Önceki "emptyRatio önceliklidir" kararı (a67bd63) bu kararla DEĞİŞTİRİLDİ; ekran görüntüsünde yetkisiz liste açıkken ekranın yaklaşık yarısı yalnız kilit ikonu ve tek cümle taşıyan kutuydu.

- **Kapsam:** D-03 (`emptyRatio ≤ %15`) yalnız KAPALI ana ekran için geçerlidir ve değişmedi. Açık Yakında / yetkisiz listelerinde yerine **H-05** geçer.
- **H-05 (açık liste, doldurma yok):** etkileşimli ya da gerçek içerik taşımayan hiçbir kutu ≤ 160 px (2); 161–200 (1); > 200 (0). Satırlar altta: kapatma düğmesi alt sekmenin ≤ 16 px üstünde (2); 17–32 (1); > 32 (0). Açıklama satırların üstünde TEK kompakt başlık satırıdır ("Bu işler için yetkin yok. Sorumluna sorabilirsin."); üstündeki zemin düz kalır. e2e: `expectExpandedList` (mobile-shell).
- **I-09 (N-01, kurulum rehberi):** kurulum tamamlanmadıysa rehber TEK kompakt satır ("Kurulum 0/3 · Sıradaki: Depo ekle", ok ile açılır); kapalıyken dolu düğme yok, "Yeni ürün" tek birincil eylem (2); aksi 0.
- **I-10:** sabit çubuğun altında içerik kalmaz (liste sonu ≤ çubuk üstü) (2).
- **I-11 (arama alanı örnek metni "Örn. URN-0001, koli ya da barkod"):** alanda görünür örnek metin var (2); yok (0). `Typeahead` opsiyonel `placeholder` prop'u (604663e kapsam eki); diğer kullanıcılar değişmedi. e2e: mobile-shell.

### 7.2 Eşik değişiklik geçmişi (ekran görüntüsünden SONRA yapılan her değişiklik; dürüstlük kaydı)

İlk §7 tablosu ekran görüntüsünden önce yazıldı (8997f48 ile birlikte commit edildi; rubrik ve kod aynı commit'teydi, bu bir süreç eksiğiydi). Sonraki değişiklikler:

| Değişiklik | Karar / commit | Gerekçe |
|---|---|---|
| H-01 (gerekçe kartı ≤ 160 px) KALDIRILDI | Karar a67bd63 (T-274 kartı kapsam eki); uygulama 8997f48 | T-270 `emptyRatio ≤ %15` önceliklidir diye; kart boşluğu dolduran büyük kutuya dönüştü (görsel olarak kötü, bkz. d9ce4d6) |
| §7.1 eklendi: açık listelerde `emptyRatio` uygulanmaz; H-05, I-09, I-10, I-11 | d9ce4d6 (I-11 uygulaması 5c51152) | "Metrik doldurma kutusu üretiyordu; kullanıcı görsel kalitesi öncelikli". Önceki karar (a67bd63) geri alındı |
| Açık liste satır üst sınırı 64 → 72 px (mobile-shell 359-360, 386-387) | Karar a67bd63; uygulama 8997f48 | Her satıra tek satırlık gerçek açıklama sığsın |
| "Döşeme" tanımı daraltıldı (§2): yalnız ETKİN döşeme; kilitli/Yakında satırları dışarıda | 8997f48 | Kart madde 3; D-01/D-04 eşikleri DEĞİŞMEDİ |
| H-04'teki "D-03 bozulmaz" ibaresi netleştirildi (D-03 yalnız kapalı ana ekran) | bu belge güncellemesi (§7.3 öncesi rubrik-yalnız commit) | §7.1 ile çelişkiydi |
| T-274 kartı madde 3 ("emptyRatio önceliklidir, değişmez", `docs/tasks/T-274.md`) ve `mobile-shell.spec.ts` içindeki "H-01 ... emptyRatio önceliklidir; gerekçe kartı boşluğu doldurur" yorumu bayat | Kart dosyası dokunulacak dosyalar dışında: güncelleme Supervisor'da. Test yorumu rubrik-yalnız commit'ten SONRAKİ kod commit'inde düzeltilir | Güncel kural: §7.1 + §7.3 (açık listede `emptyRatio` yok; B-01/B-02) |
| T-313 R-11 (§8.1) "TanStack Virtual" → "sayfalı liste ≤50 satır; sanallaştırma 200+ satırlık tek sayfa gerekince takip kartı" | e762fb4 (rubrik-yalnız commit; T-313 görüntüsünden ÖNCE) | `@tanstack/react-virtual` kurulu değil, yeni bağımlılık eklenmeyecek; teslim listesi keyset ile ≤50 satır/sayfa gelir (T-274 aynı sonuca vardı). Diğer R-ölçütleri değişmedi |
| Ana ekran ölçeklenmesi (§7.4): ≤5 izinli iş tek sütun satır (mevcut), ≥6 eşit 2 sütunlu ızgara; 2 sütunda D-04 88–140 px | Supervisor kararı 2026-10-07 (T-313); rubrik-yalnız commit, T-313 ana ekran görüntüsünden ÖNCE | "6 etkin işte tek sütun D-04'ü ihlal ediyor": 6 döşemeyle 360×740'ta 77 px (<88), 390×664'te son döşeme alt sekmenin 38 px altına taşıyor. Eşikler gevşetilmedi; yerleşim biçimi değişti |
| 2 sütun D-04 tavanı 140 px → "en çok kare (yükseklik ≤ genişlik), en az 88 px" (§7.4.1) | Supervisor kararı 2026-10-07 (T-313); rubrik-yalnız commit, yeni görüntüden ÖNCE | "2 sütunda 140 px tavan büyük telefonda 178–266 px boş bant bırakıyor"; dolgu içeriği reddedildi. B-02 ve `emptyRatio` değişmedi |
| e57c69a GERİ ÇEKİLDİ: "2 sütun döşeme en çok kare" kuralı kaldırıldı; yerine §7.4.1 (140 px'i yalnız gerçek içerik/açıklama aşar, ≤ kare; D-04b içi boşluk ≤ 24 px) | Supervisor kararı 2026-10-07 (bağımsız inceleme T-313, 28/32); rubrik-yalnız commit, görüntülerden ÖNCE | e57c69a geri çekildi: ölçüm sonrası tavan kaldırma = eşik bükme (bağımsız inceleme T-313). Büyüyen döşemenin içi boş kalıyordu (60–75 px) |

### 7.3 Yeni ölçütler (bağımsız inceleme "geçmez" sonrası) — ekran görüntüsü ve kod değişikliğinden ÖNCE sabitlendi

Bu bölüm ayrı, yalnız rubrik içeren bir commit'tir; kod ve ekran görüntüsü sonradan gelir; eşikler sonradan değişmez. Ölçüm: telefon (Playwright `mobile`), 360×740, 390×844, 430×932; ölçümler `mobile-shell.spec.ts` içindedir. Puan 2/1/0. Birleştirme eşiği: hiçbir ölçütte 0 yok ve toplam ≥ %90.

**Yürürlükte kalan ölçütler:** I-01…I-08, I-10, H-02, H-03, D-01…D-11 (kapalı ana ekran). **Yerine geçilenler:** H-04, H-05, I-09, I-11 (aşağıdaki B/S/T ölçütleri); I-04 hint ve açıklama satır sayısı korunur. **Toplam:** I-01…I-08, I-10, H-02, H-03, B-01…B-05, T-01, S-01 = 18 ölçüt × 2 = 36; eşik ≥ 33.

| No | Ölçüt | Geçer (2) | Kısmen (1) | Geçmez (0) |
|---|---|---|---|---|
| B-01 | "Yakında" ve "Yetkin olmayan işler" AÇILINCA kararmış ana ekran üzerinde ALT SAYFA (bottom sheet) olarak açılır. Alt sayfa `role="dialog"` + `aria-modal`; yüksekliği içeriğine uyar ve görünür yüksekliğin ≤ %85'i; kapatma denetimi sayfanın EN ALTINDA (altı ≤ 16 px içeride, 48 px); arka plana dokunma, Esc ve aşağı kaydırma (≥ 80 px) kapatır; odak sayfada tutulur (Tab döngüsü dışarı çıkmaz) ve kapanınca açan düğmeye döner; sayfa içinde düz zemin bandı yok | Hepsi | Yalnız biri eksik: aşağı kaydırma, odağın geri dönmesi ya da arka plana dokunma | Diğer (yükseklik > %85, kapatma altta değil, odak tuzağı yok, Esc yok ya da doğrudan düz bant) |
| B-02 | Ana içerik alanında (üst çubuk altı – alt sekme üstü; alt sayfa açıkken yalnız alt sayfanın kutusu, kararmış zemin sayılmaz) içerik ya da etkileşimli öğe içermeyen EN BÜYÜK dikey bant. İçerik öğesi: etkileşimli öğe (kutusu), metin düğümü taşıyan öğe, simge (svg); kenarlıklı/boyalı kutular tek başına içerik sayılmaz. Durumlar: ana ekran kapalı (yönetici, toplayıcı boş durum), alt sayfa içi (Yakında, yetkisiz), ürünler (ürün yok). Ürün listesi ekrandan kısaysa liste sonu ile sabit "Yeni ürün" çubuğu arası bu ölçütün DIŞINDADIR (liste gerçek içeriktir; boşluk kabul edilmiş risk, inceleyici görsel olarak değerlendirir) | ≤ 120 px (3 boyutta, tüm durumlarda) | 121–160 px | > 160 px |
| B-03 | Ürün yokken ürünler ekranı ÖĞRETEN gerçek boş durum: sıralı (`ol`) kurulum adımları (adım metni + ikincil metin bağlantıları, DOLU düğme yok); sayfadaki tek dolu birincil eylem sabit "Yeni ürün" (dolu `bg-accent` denetim sayısı = 1). B-02 geçerli | Sıralı liste var, dolu denetim = 1 | Liste var ama 2. dolu denetim ya da bağlantı yok | Liste yok ya da ≥ 2 ek dolu denetim |
| B-04 | Genişleyen her denetimde (Gelişmiş, alt sayfa açan "Yakında"/"Yetkin olmayan işler" düğmeleri, kurulum satırı açılırsa) görünür şevron (chevron); hepsi aynı biçimde, sağda, ≥ 48 px yükseklikte ve açılınca aynı dönüşü yapar | Hepsi tutarlı | 1 tutarsız | ≥ 2 tutarsız ya da şevronsuz |
| B-05 | Arama alanı: solda büyüteç simgesi; ipucu (hint) 360'ta TEK satır; örnek metin yalnız gerçek örnekler: "Örn. URN-0001 ya da Koli 40x30"; barkod yalnız ipucunda bir kez ("barkodu okutabilirsin"), örnek metinde yok | Dördü de | 1 eksik | ≥ 2 eksik |
| T-01 | Metin ve hizalama: yalnız filtre ile arayıp sonuç yoksa "Bu filtreye uyan ürün yok"; boş-filtre ipucu tek kutu diline uygun; "Aramayı temizle" sol kenarı arama alanıyla hizalı (± 2 px); "Yakında" açıklaması çoğul ("Bu işler … açılacak") | Dördü de | 1 eksik | ≥ 2 eksik |
| S-01 | Kurulum satırı eylem gibi okunur: depo yoksa "Önce depo ekle · 1. adım / 3"; depo var, raf yoksa "Sıradaki: rafları oluştur · 2. adım / 3"; raf da varsa ve sıra üründe ise "Sıradaki: ilk ürünü ekle". Sağda şevron; dokununca doğrudan o adıma gider; ürün adımında satır "Yeni ürün" ile AYNI eylemi açar (ikinci dolu düğme yok) | Hepsi | 1 eksik | ≥ 2 eksik |

Yazma kuralı: bu tablo ve eşikler ekran görüntüsünden sonra değiştirilirse değişiklik §7.2'ye commit ve gerekçesiyle eklenir.

### 7.4 Ana ekran ölçeklenmesi: izinli iş sayısına göre yerleşim (2026-10-07, T-313; görüntüden ÖNCE sabitlendi)

Gerekçe: "6 etkin işte tek sütun D-04'ü ihlal ediyor" (ölçüm: 6 döşeme, yönetici; 360×740 → 77 px, 390×664 → son döşeme alt sekmenin 38 px altında, 390×844 → 94 px, 430×932 → 109 px).

Kural (telefon ana ekranı, `.task-grid`):
- **≤5 izinli (etkin) iş:** tek sütun yatay satırlar (mevcut §5 B biçimi, D-04 88–140 px; kısa ekranda 72 px).
- **≥6 izinli iş:** eşit 2 sütunlu ızgara, aynı döşeme biçimi (ikon dairesi + başlık; açıklama 2 sütunda gizlenebilir), eşit satırlar. Tek sayıda iş varsa son döşeme tam genişlik kaplar (yetim döşeme yok; eşitlik yükseklik ve satır genişliğiyle ölçülür, bkz. D-01 notu).
- **D-04 (2 sütun):** döşeme yüksekliği 88–140 px (görünür yüksekliği < 700 px olan ekranda 72 px alt sınırı, mevcut D-04 notu); 140 px'i yalnızca döşeme GERÇEK içerik taşıyorsa aşabilir (§7.4.1) ve her durumda ≤ kare (yükseklik ≤ genişlik). **D-04b (§7.4.1):** döşeme içi dikey boşluk ≤ 24 px. **B-02 ve `emptyRatio` aynen geçerlidir.**
- Her iki modda aynı güçte ölçülür: eşit boyut (±2 px), yetim yok, ızgara alt kenarı alt sekmenin ≤ 16 px üstünde (alttan yukarı), dokunma hedefi ≥ 48×48 px ve aralık ≥ 8 px, sayfa kayması yok; 360×740, 390×664, 390×844, 430×932. Başlık ≤ 2 satır (D-09).
- Eşikler değişmedi; yalnızca 6+ iş için yerleşim biçimi eklendi. (DÜZELTME 2026-10-07: e57c69a'daki "en çok kare" tavan kaldırma kuralı geri çekildi; geçerli kural §7.4.1'dedir.)

#### 7.4.1 2 sütun D-04 (2026-10-07, Supervisor kararı; görüntülerden ÖNCE) — e57c69a GERİ ÇEKİLDİ

Geri çekme: e57c69a ("2 sütunda döşeme en çok kare, ≥ 88 px") 140 px tavanını ölçüm BAŞARISIZ OLDUKTAN sonra kaldırdığı için eşik bükme sayıldı (bağımsız inceleme T-313, 28/32). Boş alan, döşemeyi büyütüp içini boş bırakarak kapatılamaz.

Geçerli kural (2 sütun, ≥ 6 izinli iş):
- **D-04:** döşeme yüksekliği 88–140 px (görünür yüksekliği < 700 px olan ekranda 72 px alt sınırı). 140 px'i **yalnızca döşeme GERÇEK içerik taşıyorsa** aşabilir: ikonun altında başlık + tek satırlık sade dilde açıklama (örn. "Depoya mal geldi — gelen ürünü say, kaydet"; acemi kullanıcıya ne işe yaradığını söyler, N-08/N-09). Üst sınır kare (yükseklik ≤ genişlik). Açıklaması olmayan döşeme 140 px'i aşamaz.
- **D-04b (yeni):** döşeme İÇİNDE ikon, başlık ve açıklama blokları arasındaki toplam dikey boşluk ≤ 24 px (içi boş döşeme yok; incelemede 60–75 px bulundu). Ölçü: döşeme iç yüksekliği − (ikon + başlık + açıklama kutu yükseklikleri toplamı); iç yükseklik = kenarlık ve iç dolgu çıkarılmış yükseklik, dolgu 2 × 12 px'e kadar sayılmaz.
- **B-02** (en büyük boş dikey bant ≤ 120 px) ve kapalı ana ekranda **`emptyRatio ≤ %15`** DEĞİŞMEZ. Dolgu/süs içeriği eklenmez.
- Tek sütun kipi (≤ 5 iş) değişmedi: 88–140 px.

## 8. T-313 mal kabul ve yerleştirme ekranları — tasarım ölçütleri (görüntüden ÖNCE yazıldı)

> Bu bölüm T-313 ekran görüntüsü üretilmeden önce ayrı commit olarak yazıldı; eşikler görüntüden sonra değiştirilmez. Şablon §1 ile aynı (2/1/0; 0 yok ve toplam ≥ %90). Dayanak: UX_NOVICE N-01, N-02, N-06, N-07, N-09, N-13, N-16; 08-ux-i18n §Kurallar; ADR-020.
> Not: eşik değişiklik geçmişi §7.2 tablosundadır; T-313'ün R-11 revizyonu oraya ve §8.3'e işlendi.

### 8.1 Kapsam ve ölçüm

Ekranlar: saha kabulü (`/field/receive`: teslim seç → ürün okut → miktar → bitti), saha yerleştirme (`/field/putaway`: ürün okut → hedef lokasyon okut → miktar → bitti), masaüstü `receipts` (liste + oluşturma formu). Telefon boyutları 360×740, 390×844, 430×932; masaüstü 1280×800. "Adım ekranı" = akışın tek bir adımı. "Eylem bölgesi" = alt sabit çubuğun üstü ile saha alt gezinme çubuğu arası. Ölçümler Playwright mobil projesinden alınır (`.artifacts/t-313/`).

| No | Ölçüt | Ölçüm | Geçer (2) | Kısmen (1) | Geçmez (0) |
|---|---|---|---|---|---|
| R-01 | Tek birincil eylem, altta sabit | Her adım ekranında görünür `[data-variant=primary]` sayısı; konumu | Tam 1; alt kenarı gezinme çubuğunun üstünden ≤ 16 px; yüksekliği ≥ 56 px; kaydırmada yerinde | 2 birincil ya da boşluk 17–32 px | 0 ya da > 2 birincil, ya da kaydırınca kayıyor |
| R-02 | Dokunma hedefi | Görünür tüm etkileşimli öğeler (miktar +/− dahil) | Hepsi ≥ 48×48 px, komşu aralık ≥ 8 px | 44–47 px | < 44 px |
| R-03 | Taşma ve kayma | 360/390/430'da `scrollWidth > clientWidth`; adım ekranında sayfa dikey kayması (390×664 dahil) | 0 yatay taşma; adım ekranı kaydırmasız sığar (yalnız liste kendi içinde kayar) | 1 adım ekranı 1–40 px kayar | yatay taşma ya da > 40 px kayma |
| R-04 | Yanlış tarama engeli | Ürün/lokasyon uyuşmazlığında DOM; hareket yazımı | `role=alertdialog`, tam ekran, sebep cümlesi + tek "tekrar okut" düğmesi; onaysız devam yok; sunucuya yazma isteği gitmedi | uyarı tam ekran değil | uyarı yok ya da devam edilebiliyor |
| R-05 | Miktar girişi | Miktar alanı ve adım tuşları | `inputmode="numeric"` yalnız miktar alanında; +/− 48 px; üst sınır kalan miktar; tam sayı; varsayılan ön dolu (koli barkodu adedi ya da kalan) | varsayılan ön dolu değil | serbest metin, sınırsız ya da ondalık |
| R-06 | Adım yönlendirmesi | Her adımda ne yapılacağı | Görünür "Adım n / m" ve tek cümlelik yönerge; geri dönüş yolu; çıkmaz ekran yok (hata ve bitti dahil) | yönerge ya da geri yok | adım belirsiz |
| R-07 | Yumuşak kategori rengi | Kabul ekranları `cat-green`; yerleştirme `cat-teal` (taşıma ailesi); renk yalnız ikon dairesi ve başlık şeridinde | `cat-*-bg` daire + `cat-*-ink` ikon, doygun zemin yok, ana mavi yalnız birincil düğme/odak | 1 sapma | ≥ 2 sapma ya da renk tek anlam taşıyıcı |
| R-08 | Düz Türkçe | Tüm görünür metin (TR) | Cümle ≤ 15 kelime, düğme ≤ 3 kelime ve fiille başlar, teknik terim ("SKU", "FIFO", "RLS") yok | 1–2 sapma | ≥ 3 sapma |
| R-09 | Hata gösterimi | Sunucu reddi (`OVER_RECEIPT`, `SCAN_MISMATCH`, `LOCATION_LOCKED`, `FORBIDDEN`, ağ) | Neden + sonraki eylem cümlesi + "Ayrıntı" altında kod; hata `aria-live` ile okunur; alan kuralı UI'da yeniden yazılmamış | kod ya da eylem eksik | ham hata, kod yok ya da hata yutuluyor |
| R-10 | Dokunuş bütçesi (N-16) | e2e `pointerdown` sayacı; tarama dokunuş değildir; akış başlangıcı = akış ekranı açık | Kabul (teslim seçili, tam miktar) ≤ 3; yerleştirme (görev ya da serbest, tam miktar) ≤ 3; teslim seçme ≤ +1 | +1 aşım | > +1 aşım |
| R-11 | Sayfalı liste | Teslim/satır listesi | Liste sayfalıdır (≤50 satır/sayfa, keyset "daha fazla"), kart görünümü (tablo yok); sanallaştırma 200+ satırlık tek sayfa gerekince (takip kartı) | sayfa 51–100 satır | sayfa > 100 satır ya da OFFSET/tümünü yükleme |
| R-12 | Durum yalnız renk değil | Satır durumu (beklenen/kabul/hasarlı/açık) ve sonuç | Her durum ikon + metin + renk; beklenen ve kabul sayıları görünür | 1 durum yalnız renk | ≥ 2 |
| R-13 | Sonuç ve sıradaki iş | Kayıttan sonra ekran | "Kaydedildi" onayı (kabul/hasarlı/açık sayıları ile) + tek birincil "Sıradaki" düğmesi; çift gönderim engelli (gönderirken düğme kapalı) | onay var, sonraki yok | sessiz başarı ya da çift gönderim mümkün |
| R-14 | Yetki ve kilit | Yetkisiz kullanıcı (kalite onayı `document.approve` yok; saha `stock.view`/`stock.adjust` yok) | Gizlenmez; kilitli + gerekçe cümlesi + "Yardım çağır" yolu; sunucu `FORBIDDEN`'ı da gösterilir | kilit var, gerekçe yok | gizli ya da tıklanınca sessiz hata |
| R-15 | Masaüstü liste + form | 1280 px `receipts` | Liste ve oluşturma formu aynı ekranda; tedarikçi referansı altında "kişisel veri girmeyin" uyarısı; kalite onayı eylemi var; tek birincil | uyarı ya da eylem eksik | form yok ya da > 1 birincil |
| R-16 | Dil ve kontrast | i18n TR+EN eşit anahtar; `theme-contrast` yeni çiftleri; belirteç dışı hex yok | 0 sabit metin, kontrast test yeşil | 1 sabit metin | ≥ 2 sabit metin ya da test kırmızı |

Toplam 16 ölçüt × 2 = 32 puan; birleştirme eşiği ≥ 29 ve hiçbirinde 0 yok (§1.4 gereği ölçüt başına 1 yalnız gerekçeli kabul riskiyle).

### 8.2 Puan kaydı

Ayrı denetçi puanı ve Supervisor'ın kullanıcıya görüntü gösterimi birleştirmeden önce zorunludur (kart §Supervisor notu). Uygulayıcı özpuanı karar kanıtı sayılmaz (§6 dersi). Kayıt şablonu:

| Aday | R-01 | R-02 | R-03 | R-04 | R-05 | R-06 | R-07 | R-08 | R-09 | R-10 | R-11 | R-12 | R-13 | R-14 | R-15 | R-16 | Toplam | Karar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (doldurulacak) | | | | | | | | | | | | | | | | | /32 | |

### 8.3 Geçmiş

Bu bölüm önce ölçütleri yazar; uygulama sonrası ölçüm özeti ve denetçi puanı buraya eklenir (ölçüt metinleri değişmez).

**R-11 revizyonu (ekran görüntüsünden önce, ayrı commit).** İlk metin "TanStack Virtual, liste içi kaydırma" istiyordu. Gerekçe: `@tanstack/react-virtual` kurulu değil ve yeni bağımlılık eklenmeyecek (Supervisor kararı 2026-10-07); teslim listesi keyset ile ≤50 satır/sayfa getirilir, bu boyutta sanallaştırma gerekmez (T-274 aynı sonuca vardı). Sanallaştırma 200+ satırlık tek sayfa gerektiğinde takip kartıdır. Diğer ölçütler değişmedi; görüntü henüz üretilmedi.
