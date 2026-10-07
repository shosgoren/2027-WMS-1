# UX_NOVICE — "Eğitimsiz, rehberli, hata yaptırmayan" tasarım rehberi (taslak)

> Hedef (kullanıcı, birebir): "ilk defa bilgisayar veya telefon, tablet kullanacak birinin kolaylığında herhangi bir eğitim almasına gerek olmadan bu programın tüm yerleri kullanılabilir bir rehber yönlendirme şeklinde kullanıcı hata yaptırmayan bir yapı".
> Kapsam: tüm `apps/web` ekranları; özellikle saha (telefon/el terminali) ve kurulum akışları.
> Dayanak: `docs/spec/08-ux-i18n.md` ("Sıfır eğitim" ilkesi), T-250, T-254, T-257, ADR-020 (palet: `undo`, `danger*`, `success*` belirteçleri; durum = renk + ikon + metin).
> Durum: araştırma taslağı, 2026-10-06. Bağlayıcı değil; supervisor onayıyla `docs/spec/08`'e ve kartlara dönüşür.
> Kaynak notu: NN/g, W3C, GOV.UK, Material sayfaları bu ortamda doğrudan açılamadı (ağ engeli); bağlantılar web aramasıyla doğrulandı, içerik özetleri arama sonuçlarına dayanır.

---

## 1. İlkeler (N-01…N-15)

| No | Kural | Gerekçe (tek satır) | Kaynak |
|---|---|---|---|
| N-01 | **Ekran başına tek iş, tek birincil düğme.** Bir ekran bir soru sorar veya bir karar ister; birincil eylem tek ve en büyük düğmedir. | Bilinmeyen süreçte yolu bulmayı, mobilde kullanımı ve hatadan dönmeyi kolaylaştırır. | [GOV.UK – One thing per page](https://designnotes.blog.gov.uk/2015/07/03/one-thing-per-page/), [Question pages](https://design-system.service.gov.uk/patterns/question-pages) |
| N-02 | **Hatayı imkânsız kıl, sonra uyar.** Serbest metin yerine seçim, tarama, adım düğmesi (+/−); geçersiz değer girilemez (poka-yoke). | Kayma (slip) hataları kullanıcının değil tasarımın kusurudur; kısıt koymak en ucuz önlemdir. | [NN/g – Slips](https://www.nngroup.com/articles/slips/), [SAP – Poka-yoke in UX](https://blogs.sap.com/2021/11/01/poka-yoke-in-ux-design/) |
| N-03 | **Geri alınabilen işte onay penceresi yok, 10 sn "Geri al" var.** Onay yalnız geri alınamaz/ağır sonuçlu işte; düğmeler sonucu söyler ("Fişi iptal et" / "Vazgeç"), varsayılan "Evet" yok. | Sık onay alışkanlıkla "Tamam"a basmayı öğretir; geri al hem hızlı hem güvenli. | [NN/g – Confirmation dialogs](https://www.nngroup.com/articles/confirmation-dialog/) |
| N-04 | **Her alanın akıllı varsayılanı vardır.** Sektör şablonu > son kullanılan > güvenli varsayılan; boş bırakılabilir alan "Bilmiyorum" seçeneği taşır. | Daha az karar = daha az hata; GOV.UK "bilmiyorum" geçerli yanıt olmalı der. | [NN/g – 4 principles to reduce cognitive load in forms](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/), [GOV.UK Question pages](https://design-system.service.gov.uk/patterns/question-pages) |
| N-05 | **Doğrulama alan terk edilince, alanın yanında.** Yazarken kırmızı yok; hata ikon + metin + renk. | Hata, kullanıcı alanı bitirmeden gösterilirse rahatsız eder; yerinde gösterilen hata hemen düzeltilir. | [NN/g – Reporting errors in forms](https://www.nngroup.com/articles/errors-forms-design-guidelines/) |
| N-06 | **Hata mesajı "ne yapmalısın" ile başlar.** Sade dil, suçlamasız, teknik kod yok (kod yalnız "Ayrıntı" altında). | GOV.UK: neyin yanlış gittiğini ve nasıl düzeltileceğini söyle; düzeltme eylemiyle başla. | [GOV.UK – Error message](https://design-system.service.gov.uk/components/error-message), [NN/g – Hostile error messages](https://www.nngroup.com/articles/hostile-error-messages/) |
| N-07 | **Dokunma hedefi ≥48×48 CSS px, aralık ≥8 px.** (WCAG 2.5.8 alt sınırı 24 px; Apple 44 pt; Material 48 dp — en yükseği seçilir.) | Eldivenli el, titreyen parmak, ilk kez dokunmatik kullanan kişi. | [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [Android touch target](https://support.google.com/accessibility/android/answer/7101858) |
| N-08 | **İlkokul düzeyinde dil (6.–8. sınıf), kısa cümle, fiille başlayan düğme.** Teknik/yabancı terim yerinde açıklanır ("FIFO = önce giren önce çıkar"). | Düşük okuryazar kullanıcı metni kelime kelime "sürer", çevresini kaçırır; yaşlılar teknik terimde takılır. | [NN/g – Lower-literacy users](https://www.nngroup.com/articles/writing-for-lower-literacy-users/), [NN/g – Define techy terms](https://www.nngroup.com/articles/define-techy-words-old-users/) |
| N-09 | **Metin + ikon + renk birlikte; yalnız renk/ikon anlam taşımaz.** Kritik iş kartlarında büyük piktogram. | Okuma güçlüğü ve renk körlüğü; ADR-020 zaten durum = renk+ikon+metin der. | [COGA – Making Content Usable](https://www.w3.org/TR/coga-usable/), ADR-020 |
| N-10 | **Çıkmaz ekran yok.** Her ekranda geri/ana sayfa, boş durumda "sıradaki adım" düğmesi, hata ekranında kurtarma eylemi. | Boş durum sistem durumunu bildirmeli, öğretmeli ve doğrudan göreve götürmeli. | [NN/g – Empty states](https://www.nngroup.com/articles/empty-state-interface-design/) |
| N-11 | **Zorunlu tur yerine bağlam içi yardım.** Her ekranda "Ne yapmalıyım?" (?) ipucu; tur yalnız rol başına bir kez, atlanabilir. | Bağlam içi öğrenme, baştaki zorunlu eğitimden daha akılda kalıcı. | [NN/g – Empty states](https://www.nngroup.com/articles/empty-state-interface-design/) (öğrenme ipuçları bölümü) |
| N-12 | **Kademeli açıklama: önce temel, "Gelişmiş" kapalı.** Uzun işler adım adım sihirbazla; ilerleme göstergesi, otomatik kayıt, kaldığı yerden devam. | Sihirbaz acemiye uygundur; çıkışta ilerleme kaybolmamalı. | [NN/g – Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [NN/g – Wizards](https://www.nngroup.com/articles/wizards/) |
| N-13 | **Taramada çok kanallı geri bildirim.** Doğru okutma: kısa bip + kısa titreşim + yeşil; yanlış: farklı ton + uzun titreşim + tam ekran kırmızı + sesli/yazılı sebep. İş durur, kullanıcı onaylamadan devam etmez. | Gürültülü depo zemininde ses tek başına yetmez; eldivenli kullanıcı titreşime güvenir. | [Zebra DataWedge](https://techdocs.zebra.com/datawedge/latest/guide/about/), [Cleverence – Zebra TC58e rehberi](https://www.cleverence.com/articles/technical-manuals/using-the-zebra-tc58e-your-ultimate-guide/) |
| N-14 | **Tekrar giriş isteme, sessiz seçim yapma.** Bilinen veri ön doldurulur (WCAG 3.3.7); belirsizlikte sistem tahmin etmez, kullanıcıya iki seçenekle sorar (T-257 ilkesi). | Tekrar yazmak hata kaynağı; sessiz tahmin görünmez hata üretir. | [WCAG 2.2 – 3.3.7 Redundant Entry](https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html) |
| N-15 | **Zaman baskısı yok; süreli öğe durdurulabilir.** "Geri al" bildirimi odak/dokunuşta durur ve "Son işlemler" listesinden sonra da erişilir. | Yaşlı kullanıcılar ~%43 daha yavaş; WCAG 2.2.1 süre ayarlanabilir olmalı. | [NN/g – Usability for older adults](https://www.nngroup.com/articles/usability-for-senior-citizens/), [WCAG 2.2.1](https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable) |

---

## 2. Ölçülebilir kontrol listesi

Tür: **[OTO]** = Playwright e2e / axe-core ile otomatik; **[YARI]** = otomatik tarama + insan onayı; **[EL]** = manuel sezgisel denetim.
Cihaz profilleri: iPhone 13 (390×844), 360×740, tablet 768×1024, masaüstü 1440×900.

| # | Kontrol | Tür | Ölçüt / nasıl |
|---|---|---|---|
| K-01 | Dokunma hedefi ≥48×48 px | OTO | Tüm `button, a, input, [role=button|tab|checkbox|radio]` için `getBoundingClientRect` (T-254 testi genelleştirilir). |
| K-02 | Hedefler arası boşluk ≥8 px | OTO | Komşu etkileşimli kutuların kesişim/mesafe taraması. |
| K-03 | axe-core: 0 ihlal (wcag2a, wcag2aa, wcag22aa) | OTO | `@axe-core/playwright` her rotada. (2026-10-06: repoda kurulu değil; T-261 STACK.md'ye Context7 ile doğrulanan sürümle ekler — G-04.) |
| K-04 | Ekranda tek birincil eylem | OTO | `[data-variant=primary]` görünür sayısı = 1 (diyaloglar ayrı sayılır). |
| K-05 | Her form alanının etiketi + varsayılanı veya "Bilmiyorum"u var | YARI | Boş zorunlu alan sayısı ilk açılışta 0 olmalı; istisna listesi gerekçeli (`data-no-default="neden"`). |
| K-06 | Her hata mesajı eylem fiiliyle başlar ve alanla `aria-describedby` ile bağlı | YARI | i18n anahtarları `errors.*` için sözlük denetimi (emir kipi fiil listesi) + DOM bağlantı testi; dil kalitesi insan onayı. |
| K-07 | Ham teknik hata kullanıcıya görünmez | OTO | Ekran metninde `/[A-Z_]{6,}|Error:|SQLSTATE|undefined|null/` yok (ayrıntı paneli hariç). |
| K-08 | Geri alınabilen yıkıcı işlem 10 sn "Geri al" sunar; odakta süre durur | OTO | Sil/iptal/taşı → toast görünür → "Geri al" → durum eskiye döner (domain'de ters kayıt, G-01). |
| K-09 | Geri alınamaz işlemde onay penceresi sonucu söyler, varsayılan odak "Vazgeç" | OTO | Diyalog düğme metni ≠ "Evet/Tamam"; `document.activeElement` = iptal. |
| K-10 | Çıkmaz ekran yok | OTO | Rota tarayıcı: her sayfada görünür geri/ana sayfa bağlantısı; boş liste durumunda ≥1 eylem düğmesi. |
| K-11 | Her ekranda "Ne yapmalıyım?" ipucu | OTO | `[data-help]` varlığı + i18n anahtarı boş değil. |
| K-12 | Telefonda ana ekran ve iş ekranları kaydırmasız; yatay taşma yok | OTO | T-254 ölçütü tüm saha rotalarına genişletilir. |
| K-13 | Durum yalnız renkle verilmez | YARI | Durum rozetlerinde ikon + metin zorunlu (bileşen testi); gri tonlamalı ekran görüntüsü insan incelemesi. |
| K-14 | Yanlış tarama tam ekran uyarı + farklı ses + titreşim; onaysız devam yok | OTO | Sahte tarama olayıyla yanlış lokasyon → `role=alertdialog`, hareket yazılmadı (int testi). Ses/titreşim cihazda EL. |
| K-15 | Okunabilirlik: kullanıcı metinleri kısa | YARI | TR cümle uzunluğu ≤15 kelime, düğme ≤3 kelime (i18n lint); Ateşman okunabilirlik puanı raporu. |
| K-16 | Sihirbaz yarıda kalınca ilerleme korunur | OTO | Adım 2'de sayfayı kapat → yeniden aç → adım 2'den devam. |
| K-17 | Klavye ile tüm akış tamamlanabilir, odak görünür | OTO | Tab dizisiyle ana görev akışı; `:focus-visible` kontrastı. |
| K-18 | Metin %200 büyütmede kırpılmaz | OTO | `zoom`/font-size ölçekli ekran görüntüsü + taşma tespiti. |
| K-19 | "İlk kez kullanan" senaryosu yardım almadan tamamlanır | EL | Bölüm 5'teki yazılı yürüyüş; başarı ≥%80, yardım dokunuşu ölçülür. |
| K-20 | Nielsen 10 sezgisi + COGA 8 hedefi denetimi | EL | Faz sonu denetimi, bulgu başına önem 0–4. |

---

## 3. Ekran ekran açıklar (kartlardan/şartnameden çıkarım — kod okunmadı)

1. **Şartname çelişkisi — onay vs. geri al:** `08-ux-i18n.md` "Yıkıcı işlemler onay ister" der; geri alma deseni hiç yok. ADR-020'de `undo` renk belirteci var ama karşılığı bir bileşen/kural tanımlı görünmüyor. → N-03 ile şartname güncellemesi gerekir: Q-82 / A-157; karar taslağı ADR-024 (öneri, T-262 kapsamında yazılır).
2. **Ana ekran (task-menu):** T-254 sığdırmayı çözüyor, fakat kartların piktogram/metin dili, "Yakında" kartlarının acemiyi yanıltma riski (dokunulabilir görünüp çalışmaması) tanımsız. "Yakında" kartları dokunulduğunda ne olacağı belirtilmemiş.
3. **Yardım:** Şartname "Yardım çağır" öğesinden söz ediyor; T-254'te Yardım menüye taşınıyor (bir dokunuş daha uzak). Ekran başına bağlamsal yardım ("?" / ne yapmalıyım) tanımlı değil.
4. **Kurulum (T-250):** Boş ekran rehberi ve akıllı varsayılan iyi; ancak kapsam depo/raf/ürünle sınırlı. Açılış fişi (ilk stok), kullanıcı davet, rol atama gibi sonraki ilk adımlar rehbere bağlı değil. Toplu raf oluşturucu önizleme var, geri alma yok.
5. **Sektör sihirbazı:** "Yarım kalan onboarding devam eder" var; ilerleme göstergesi, adım başına tek soru ve "Bilmiyorum" seçeneği tanımlı değil.
6. **Formlar genel:** "Hata mesajı neden + sonraki eylem" kuralı var ama ortak hata kataloğu, satır içi doğrulama zamanlaması ve dil düzeyi ölçütü yok; her kart kendi mesajını yazıyor (tutarsızlık riski).
7. **Saha/tarama (T-303 ScanField, T-257):** T-257 eski kod okutulunca onay istiyor (iyi); ancak yanlış lokasyon/yanlış ürün/fazla miktar için tutarlı çok kanallı uyarı (ses+titreşim+tam ekran) tanımlı değil. Miktar girişi serbest sayı mı, +/− adım mı belli değil.
8. **Kod değiştirme onayı (T-257):** Yerinde; ama `settings.manage` yetkisi olmayan kullanıcı için kilit + açıklama metni ("Bunu yöneticin yapabilir — Yardım çağır") belirtilmemiş.
9. **Offline/bekleyen işlem:** Şartname görsel ayrımı istiyor; Faz 5'e ertelenmiş. Acemi için "kaydedildi mi?" kaygısı en büyük güven sorunu — en azından çevrimiçi "kaydedildi ✓" geri bildirimi her işten sonra standart olmalı.
10. **Rol başına ilk kullanım turu:** Hiçbir kartta yok.
11. **Erişilebilirlik ölçümü:** Dokunma hedefi testi yalnız T-254 ana ekranında; axe taraması ve tüm rotalarda tarama yok.
12. **Ses/piktogram:** Okuma güçlüğü olan kullanıcı için sesli okuma veya piktogram desteği hiçbir yerde yok.

---

## 4. Önerilen kartlar (öncelik sırasıyla, en çok 8)

Kart eşlemesi (T-260): T-NOV-1 → `docs/tasks/T-261.md` · T-NOV-2 → T-262 (+ ADR-024 öneri) · T-NOV-3 → T-263 · T-NOV-4 → T-264 · T-NOV-5 → T-265 · T-NOV-6 → T-266 (ilk dilim: saha mal kabul) · T-NOV-7 → T-267 · T-NOV-8 → T-268. Açık sorular Q-82…Q-86, varsayımlar A-157…A-162.

**P1 — T-NOV-1: Acemi kullanılabilirlik kapısı (heuristic gate e2e)**
- Kapsam: `tests/e2e/novice-gate.spec.ts` (yeni), rota listesi, K-01…K-04, K-07, K-10, K-11, K-12 kontrolleri; axe-core (kurulu değilse STACK.md + ADR ile eklenir); `check:all`'a rapor bağlantısı.
- Kabul: 4 cihaz profilinde tüm rotalar taranır; ihlal listesi `.artifacts/novice-gate/`; ilk sürümde mevcut ihlaller kayıtlı taban çizgisi (ratchet: sayı yalnız azalabilir, G-11 ile uyumlu).

**P1 — T-NOV-2: Geri al bildirimi + onay politikası**
- Kapsam: `@wms/ui` `UndoToast` (ADR-020 `undo` belirteci), "Son işlemler" listesi, domain'de ters kayıtla geri alma (G-01: bakiyeye doğrudan yazmadan); şartname 08 "Yıkıcı işlemler" maddesinin güncellenmesi (ADR).
- Kabul: K-08, K-09 yeşil; geri alma ters kayıt üretir (int testi, RLS'li); toast odakta/dokunuşta durur; ekran okuyucu `aria-live=polite`.

**P1 — T-NOV-3: Tarama hata önleme (yanlış lokasyon/ürün/miktar)**
- Kapsam: ScanField geri bildirim katmanı: iyi okuma (kısa bip + titreşim `navigator.vibrate` + yeşil şerit), kötü okuma (farklı ton + uzun titreşim + tam ekran kırmızı `alertdialog` + sebep + tek "Anladım, tekrar okut" düğmesi); miktar için +/− adım ve beklenen miktar üst sınırı.
- Kabul: K-14 yeşil; yanlış taramada hareket yazılmaz (int); ses/titreşim kapalı cihazda görsel uyarı yeterli; iOS'ta `vibrate` desteklenmeyebilir (doğrulanmalı, G-04).

**P1 — T-NOV-4: Sade dil hata kataloğu**
- Kapsam: domain hata kodu → TR/EN kullanıcı mesajı eşlemesi (`errors.*`), şablon "Ne oldu + Ne yapmalısın + [Eylem düğmesi]"; teknik kod "Ayrıntı"da; i18n lint (K-06, K-07, K-15).
- Kabul: tüm domain hata kodlarının kataloğu var (eksik kod = test kırmızı); mesajlar ≤15 kelime; düzenleyici dil incelemesi kayıtlı.

**P2 — T-NOV-5: Bağlamsal "?" ve "Ne yapmalıyım?" ipuçları**
- Kapsam: her ekran üst çubuğunda (?) düğmesi → 1–3 adımlı resimli ipucu kartı; "Yardım çağır" (yöneticiye bildirim) aynı panelde; telefonda alt çubuk "Menü" yerine erişim yolu ≤1 dokunuş.
- Kabul: K-11 yeşil; yardım dokunuşu ölçüm olayı (metrik, kişisel veri yok — G-09).

**P2 — T-NOV-6: Sihirbaz modu (rehberli görev)**
- Kapsam: Mal kabul, sevk, sayım, transfer için "adım adım" mod: ekran başına tek soru, ilerleme çubuğu, otomatik ara kayıt, geri dönülebilir özet ekranı; tenant/rol ayarıyla "Uzman modu"na geçiş.
- Kabul: K-04, K-16 yeşil; ilk kez kullanan senaryosunda mal kabul yardım almadan ≤3 dk (EL ölçüm).

**P3 — T-NOV-7: Rol başına ilk kullanım turu + tamamlanan adım rozetleri**
- Kapsam: ilk girişte rol bazlı 3–5 adımlık atlanabilir tur (depo çalışanı / dükkân sahibi / yönetici); T-250 boş ekran rehberinin ilk stok açılış fişi ve kullanıcı davetiyle uzatılması.
- Kabul: tur bir kez gösterilir, Yardım'dan yeniden açılır; atla düğmesi her adımda; e2e 375 px.

**P3 — T-NOV-8: Piktogram ve sesli okuma desteği**
- Kapsam: iş kartları ve kritik uyarılar için tutarlı Lucide piktogram sözlüğü; isteğe bağlı "Sesli oku" (Web Speech API `speechSynthesis`, TR ses varlığı cihaza bağlı — doğrulanmalı); ayarlarda büyük yazı modu.
- Kabul: K-13, K-18 yeşil; sesli okuma kapalıyken hiçbir işlev kaybolmaz; TR sesi olmayan cihazda düğme gizlenir (sahte başarı yok, G-07).

---

## 5. Sürekli gelişim döngüsü

**Ritim**
- **Her kart:** UI dokunan kart, Bölüm 2'den ilgili K-xx maddelerini kabul ölçütüne yazar; T-261 kapısı (`pnpm test:e2e -- novice-gate`) yeşil kalır, taban artmaz.
- **Her sürüm (release):** "İlk kez kullanan" yazılı yürüyüşü (aşağıda) en az 1 kişiyle — tercihen gerçek depo çalışanı veya dijital deneyimi az biri — telefonda yapılır; sonuç `.artifacts/novice-walkthrough/<sürüm>.md`.
- **Her faz kapısı:** aşağıdaki "Faz kapısı kontrol listesi" eksiksiz işaretlenmeden faz kapanmaz; kapı raporuna (JOURNAL) liste ve yürüyüş dosyasının yolu yazılır.
- **Her faz sonu:** sezgisel denetim (Nielsen 10 sezgisi + COGA 8 hedefi + bu belgenin N-01…N-15'i); 2 değerlendirici, bulgu önem 0–4; ≥3 önemdeki bulgular sonraki faza kart olur. Bu belge aynı toplantıda gözden geçirilir: geçersiz ilke çıkarılır, yeni bulgu ilkeye dönüşür, sürüm notu `DECISIONS`'a ADR olarak.
- **Çeyreklik:** 5 kullanıcıyla moderasyonlu test (yaşlı ve düşük okuryazar katılımcı dahil; NN/g yaşlılarla test önerileri).

**Faz kapısı kontrol listesi (her faz kapısında, tümü zorunlu)**
- [ ] T-261 acemi kapısı iki projede yeşil; `novice-baseline.json` ölçülen değerlere sıkılaştırıldı (`tighten.json` boş) ve önceki kapıya göre toplam ihlal sayısı artmadı.
- [ ] Bu fazda eklenen her yeni rota `tests/e2e/novice-routes.ts`'de ve tabanda 0 ihlalle.
- [ ] "İlk kez kullanan" yürüyüşü: ortak çekirdek (aşağıda) + o fazın ek adımları, telefonda (390×844 veya 360×740), en az 1 katılımcı, gözlemci müdahalesiz; sonuç `.artifacts/novice-walkthrough/faz-<n>.md`.
- [ ] Yürüyüşte her adım için yardımsız/yardımlı/başarısız, süre, yardım dokunuşu, hata sayısı ve "kaybolma" notu kayıtlı; yardımsız başarı K-19 eşiğinin (≥%80, A-160 varsayımı) altındaysa nedeni ve kart numarası yazılı.
- [ ] Başarısız veya yardımlı her adım için ≥3 önemde bulgu → kart (Kuyruk'a eklendi) ya da gerekçeli kabul.
- [ ] Faz kapsamındaki geri alınabilir işlemler K-08, geri alınamazlar K-09'u sağlıyor (ADR-024 kabul edildiyse).
- [ ] Bu belge gözden geçirildi; açık Q-xx'ler (Q-82…Q-86) güncel durumda.

**İlk kez kullanan yürüyüşü — ortak çekirdek (betik; her sürümde ve her faz kapısında aynı)**
1. Davet bağlantısıyla gir, şifre oluştur. 2. Ana ekranda "Mal kabul"ü bul. 3. Bir ürünü okut/seç, miktarı 12 gir, kaydet. 4. Yanlış rafı okut, uyarıyı anla, düzelt. 5. Yanlışlıkla bir satırı sil, geri al. 6. "Bugün yaptıkların"da işlemi gör. 7. Yardım iste.
Ekranı henüz olmayan adım "uygulanamaz" diye işaretlenir (atlanmaz, gizlenmez); faz ilerledikçe adımlar uygulanabilir hale gelir.

**Faz bazında ek yürüyüş adımları (ortak çekirdekten sonra)**
| Faz kapısı | Ek adımlar (katılımcı yardımsız dener) |
|---|---|
| 3A — Pilot akışı | Rehberle depo + raf + ürün kur (T-250); beklenen teslimi sihirbazla kabul et (T-266), yerleştir; sipariş için topla; sevk et; bir iadeyi al; bir rafı kör say; (?) ipucundan bir ekranın ne işe yaradığını bul (T-265). |
| 4P — Pilot hazırlığı | Açılış stokunu içe aktar ve önizlemede hatayı düzelt; verini dışa aktar; yedekten dönüş adımlarını yardım metninden bul (yönetici rolüyle). |
| ▶ Pilot | Gerçek pilot depoda, gerçek çalışanla, ortak çekirdek + 3A adımları; vardiya başında ilk kez gören kişi; süre ve yardım dokunuşu taban ölçümü olarak kaydedilir (Q-85). |
| 3B — Kalan depo akışları | Depolar arası transfer başlat ve karşı depoda teslim al; üretim girişi/sarf kaydı; iki depo arasında ürün ara. |
| 4S — Ticari SaaS | Kendi kendine kayıt ol, paket seç, ödeme ekranını tamamla; fatura/e-Arşiv belgesini bul. |
| 5 — Mobil/offline | Ağ kapalıyken kabul yap, "bekliyor" durumunu anla; ağ gelince senkronu ve çatışma uyarısını çöz; ortak cihazda kullanıcı değiştir. |
| 6 — Genişletme | Yeni bir özel alan ekle ve formda kullan; entegrasyon hatasını ekrandan anla ve yeniden dene. |
| 7 — AI & ölçek | AI önerisini gör, gerekçesini oku, onayla veya reddet; önerinin neyi değiştireceğini önceden anla. |

Ölçülen: adım başına başarı (yardımsız/yardımlı/başarısız), süre, yardım dokunuşu, hata sayısı, "kaybolma" anları (sesli düşünme notu). Gözlemci müdahale etmez. Katılımcı adı/kişisel verisi dosyaya yazılmaz (G-09); yalnız "K1, K2…" ve profil (ör. "dijital deneyimi az, 55+").

**Metrikler (ürün içi, anonim, kişisel veri yok — G-09)**
| Metrik | Tanım | Hedef (A-xx varsayım; ölçüm sonrası güncellenir) |
|---|---|---|
| Görev tamamlama süresi | Görev ekranı açılış → başarılı kayıt, medyan | Sürümden sürüme düşmeli |
| Görev başarı oranı | Başlatılan / tamamlanan görev | ≥%90 |
| Hata oranı | Doğrulama hatası + reddedilen işlem / görev | Sürümden sürüme düşmeli |
| Yanlış tarama oranı | Kötü okuma uyarısı / toplam tarama | Lokasyon bazında izlenir |
| Geri al kullanımı | Geri al / yıkıcı işlem | Yüksekse o işlem yeniden tasarlanır |
| Yardım dokunuşu | (?) ve "Yardım çağır" / ekran oturumu | En yüksek 3 ekran her faz incelenir |
| Terk oranı | Sihirbazda yarıda bırakılan adım | Adım bazında; en yüksek adım sadeleştirilir |

Not: Hedef sayılar uydurma değil, varsayımdır (G-03, A-160): ilk sürümde taban çizgisi ölçülür, hedefler Q-85 ile onaya sunulur. Telemetri için olay şeması ve saklama süresi ayrı karar gerektirir (KVKK, Q-85); karar gelene kadar ürün içi ölçüm yok, metrikler yalnız yürüyüşte elle toplanır.

**Doğrulanamayan / açık noktalar**
- Honeywell'in resmi uygulama-UX rehberi bulunamadı; yalnız tarayıcı "good read / bad read" göstergesi belgeleri var. Zebra kaynağı DataWedge belgesi + üçüncü taraf rehber.
- `@axe-core/playwright`, `navigator.vibrate` (iOS Safari), TR `speechSynthesis` sesi kurulu/destekli mi doğrulanmadı.
- Kaynak sayfaları doğrudan açılamadı; alıntı içerikler arama özetlerine dayanır.

---

## 6. Az dokunuş ilkesi ve dokunuş bütçesi (T-321, ADR-023)

> Hedef (kullanıcı, birebir): "Minimum bilgi girişi yada dokunma ve maksimum faydayı sağlayabilir miyiz … program hem az zaman ayırmalı ve ayırdığı zamanda fayda verim sağladığını hissetmelidir."

**N-16 — Az dokunuş, çok fayda.** Her ana iş bir **niyettir** (ADR-023) ve bir dokunuş bütçesi taşır. Sistem soruyu değil öneriyi getirir: önce hazır plan/önizleme gösterilir, kullanıcı yalnız onaylar veya tek öğeyi değiştirir. Bilinen veri yeniden sorulmaz (N-14); seçim serbest metinden önce gelir (N-02).
- **Dokunuş** = işi başlatan ekran açıkken, iş tamamlanana kadar gereken dokunuş/tıklama sayısı (ekran açılışı ve kaydırma sayılmaz; tarama dokunuş değildir).
- **Yazma niyeti** her zaman önizleme + **tek** onay ister (ADR-023 §3); onay önizlemenin birincil düğmesidir, ayrı diyalog açılmaz. Geri alınabilen yazımlar onaydan sonra "Geri al" sunar (N-03, ADR-024).
- **Ses** (üst paket) dokunuşun yerine geçer ama onayı atlamaz: yazma niyetinde önizleme yine açılır, "onayla" sesi veya bir dokunuş gerekir.
- **Uyarı yönlendirir:** "Dikkat" kartı bir cümle + tek eylem düğmesi taşır (T-328); kritik saha hatası ekran engeline ek olarak kısa ve vurgulu sesle söylenir (T-327), iş onaylanana kadar durur (N-13).
- Bütçe aşan akış tasarım hatasıdır: kart kabul ölçütüne e2e dokunuş sayacı yazılır; aşım ancak gerekçeli istisna ile (kartta "Bütçe istisnası: neden").

**Niyet başına dokunuş bütçesi (≤; ses sütunu üst paket)**

| Niyet | İş | Başlangıç | Dokunuş bütçesi | Ses ile | Kart |
|---|---|---|---|---|---|
| `orders.today` | Bugünkü siparişleri tüm bilgiyle göster | Ana ekran | 1 | 1 cümle, 0 dokunuş | T-326 |
| `pick.plan_and_assign` | Siparişleri yürüme sırasıyla planla, personele ata | "Bugün" ekranı (ana ekrandan +1) | 2 (ana ekrandan 3) | 1 cümle + "onayla" veya 1 dokunuş | T-325, T-326 |
| `pick.undo_plan` | Az önce yapılan planı geri al | Plan sonrası bildirim | 1 | — | T-326 |
| `staff.assign_area` | Bir personelin kat/bölge/koridorunu ayarla | Personel alanları ekranı | 3 (kişi → alan → onay) | 1 cümle + "onayla" | T-324, T-326 |
| `location.recompute_walk_order` | Deponun yürüme sırasını güncelle | Personel alanları ekranı | 2 | — | T-323, T-326 |
| `attention.*` eylemi | Dikkat kartındaki işi başlat | "Bugün" ekranı | 1 (yazma niyetinde 2) | — | T-328 |
| `actions.today` | Bugün yaptıklarımı göster | Ana ekran | 1 | 1 cümle | T-322 |
| Tarama hatası onayı | Yanlış okutmayı anla, tekrar okut | Saha akışı | 1 | — (ses yalnız uyarır) | T-263, T-327 |

**Ölçüm:** e2e testleri dokunuşu `pointerdown` sayacıyla ölçer (T-326, T-328); sonuç `.artifacts/<kart>/touch-budget.json`. Bütçeler varsayımdır (G-03) — ilk "ilk kez kullanan" yürüyüşünden (§5) sonra gözden geçirilir.
