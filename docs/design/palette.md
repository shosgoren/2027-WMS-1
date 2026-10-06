# Renk paleti ve ikon renk kuralları (ADR-020)

**Durum:** kullanıcı kararı 2026-10-06 — güven veren, uluslararası kabul görmüş palet; Q-09 prototip **paletinin** yerini alır (prototipin yerleşim ve görsel dili — kart tabanlı görev menüsü, kilit + açıklama, Akış/Kokpit/mobil görünümleri — referans olarak kalır). Uygulama: T-246a/T-246b/T-246c.
**Kapsam:** açık tema (Akış varsayılan + Kokpit). Koyu tema kapsam dışı (§8).

## 1. Araştırma özeti

### 1.1 Referans tasarım sistemleri (açık tema)
Değerler, sistemlerin yayımlanmış npm paketlerinden okundu (2026-10-06; web sitelerine ajan ortamından erişilemedi, paket içindeki belirteç dosyası birincil kaynak kabul edildi). "Beyaz üstünde" sütunu bu çalışmanın betiğiyle hesaplanan WCAG oranıdır.

| Sistem (paket sürümü) | Birincil / bağlantı | Beyaz üstünde | Metin / ikincil metin | Kenar | Hata | Başarı | Uyarı | Bilgi | Kontrast yaklaşımı |
|---|---|---:|---|---|---|---|---|---|---|
| IBM Carbon (`@carbon/themes` 11.82.0, White) | `interactive` #0f62fe | 5.00 | #161616 / #525252 | subtle #c6c6c6, strong #8d8d8d | #da1e28 | #24a148 | #f1c21b | #0043ce | Rol tabanlı belirteç (`text-error` = `support-error`); uyarı sarısı #f1c21b metin olarak kullanılamaz (1.68:1) |
| Atlassian (`@atlaskit/tokens` 20.3.0, light) | `link`/`brand-bold` #1868db | 5.20 | #292a2e / #505258 | yarı saydam #0b120e24 | metin #ae2e24, ikon #c9372c | metin #4c6b1f, ikon #6a9a23 | metin #9e4c00, ikon #e06c00 | metin #1558bc, ikon #357de8 | Her anlam rengi için ayrı **metin / ikon / zemin / dolu zemin** belirteci |
| Microsoft Fluent 2 (`@fluentui/tokens` 1.0.0-alpha.24) | `brand[80]` #0f6cbd | 5.38 | #242424 / #424242 | #d1d1d1 | cranberry #c50f1f | green #107c10 | orange (shade20 #bc4b09) | — (brand) | Durum renkleri ayrı paletten (`statusColorMapping`: danger=cranberry, success=green, warning=orange) |
| Google Material 3 (`@material/web` 2.5.0, baseline) | `primary40` #6750a4 (mor) | 6.44 | #1d1b20 / #49454f | outline #79747e | `error40` #b3261e | — | — | — | Dinamik renk (ton paleti); temel tema mavi değil, başarı/uyarı rolü yok |
| Salesforce Lightning (`@salesforce-ux/design-system` 2.264.1) | `brand-accessible` #0176d3 | 4.63 | #181818 / #444444 | #c9c9c9 | metin #ea001e, yıkıcı #ba0517 | #2e844a | #fe9339 (zemin) | — | "Accessible" adlı ayrı marka belirteci; uyarı turuncusu metin değil zemin |
| GOV.UK (`govuk-frontend` 6.5.1) | brand #1d70b8, link #1a65a6 | 5.17 | #0b0c0c / #484949 | #cecece | #ca3535 | #0f7a52 | — | — | Odak = sarı #ffdd00 + siyah `focus-text` (marka renginden bağımsız, yüksek görünürlük) |
| Shopify Polaris (`@shopify/polaris-tokens` 9.4.2) | `text-link`/`border-focus` #005bd3 | 6.11 | #303030 / #616161 | #e3e3e3 | metin #8e0b21, dolu #c70a24 | metin #014b40, dolu #047b5d | metin #5e4200 | metin #003a5a | Her anlam için `text-*` (koyu, metin) + `icon-*` + `bg-surface-*` (açık zemin) ayrımı |
| GitHub Primer (`@primer/primitives` 11.10.0) | `fgColor-accent` #0969da | 5.19 | #1f2328 / #59636e | #d1d9e0 | #d1242f | #1a7f37 | `attention` #9a6700 | — | `fg*` (metin) / `bgColor-*-emphasis` (dolu) ayrımı |

**Ortak desen (palet kararının dayanağı):**
1. Birincil etkileşim/bağlantı rengi 8 sistemin 7'sinde **orta-koyu mavi**dir (#005bd3…#1d70b8 aralığı; beyaz üstünde 4.6–6.1:1). İstisna Material 3 temel teması (mor, dinamik renk); Polaris'te marka dolgusu koyu gri (#303030), bağlantı ve odak mavi. Mavi, kurumsal/finans markalarında "güvenilir, istikrarlı" algısıyla en sık seçilen renktir (DeSantis Breindel finans markaları taraması; Lizbon Üniversitesi deneysel çalışmasında mavi logo kırmızıya göre güveni artırdı — §9).
2. Nötrler hafif soğuk (mavi-gri) ya da saf gri; metin #161616–#303030, ikincil metin #424242–#616161.
3. Anlam renkleri herkeste aynı aileler: kırmızı = hata/tehlike, yeşil = başarı, turuncu/amber = uyarı, mavi = bilgi.
4. Olgun sistemler (Atlassian, Polaris, Primer, Carbon) her anlam rengini **en az üç role** böler: koyu **metin**, orta **ikon/dolu**, açık **zemin**. Sarı/turuncunun metin olarak AA geçmemesi (Carbon #f1c21b 1.68:1, SLDS #fe9339 2.22:1) bu ayrımın nedenidir.
5. Odak göstergesi ya birincil mavi (Carbon, Polaris) ya da yüksek kontrastlı ayrı renk (GOV.UK sarı, Fluent siyah).

### 1.2 Kültürlerarası anlam ve renk körlüğü
- **Kırmızı/yeşil ters anlam:** Çin, Tayvan ve Japonya borsalarında kırmızı = yükseliş, yeşil = düşüş; Kore'de kırmızı = yükseliş, mavi = düşüş (Benzinga; W3C www-international LC_STOCK_COLOR yazışması — §9). Batıda tersi. **Sonuç:** Etkin WMS'te miktar artış/azalışı **renkle kodlanmaz**; işaret (+/−), ok ikonu (`ArrowUp`/`ArrowDown`) ve metinle gösterilir, renk nötr (`ink`). Kırmızı/yeşil yalnızca **işlem durumu** (başarılı/başarısız) için kullanılır; bu kullanım arayüzlerde (form doğrulama, bildirim) uluslararası olarak tutarlıdır.
- **Renk körlüğü:** erkeklerin ~1/12'si, kadınların ~1/200'ü; vakaların büyük çoğunluğu kırmızı-yeşil (UTMB Accessibility — §9). WCAG 1.4.1 (Use of Color, A) rengin tek bilgi taşıyıcı olmasını yasaklar. **Kural:** her durum = **renk + farklı biçimli ikon + metin** (§6). Başarı ve hata ikonları farklı şekillerdedir (`CircleCheck` / `CircleAlert`), yalnız renkte ayrışmaz.

### 1.3 WCAG 2.2 AA eşikleri (uygulanan)
| Ölçüt | Eşik | Bu palette |
|---|---|---|
| 1.4.3 Contrast (Minimum) | Metin 4.5:1; büyük metin (≥24 px ya da ≥18.66 px kalın) 3:1 | **Tüm metin çiftleri 4.5:1** ile denetlendi (büyük metin istisnası kullanılmadı) |
| 1.4.11 Non-text Contrast | UI bileşen sınırı, anlam taşıyan ikon, odak göstergesi 3:1 (bitişik renge karşı) | Girdi kenarı (`border-strong`), odak halkası, durum ikonları 3:1 ile denetlendi |
| 1.4.1 Use of Color | Renk tek başına bilgi taşımaz | §6 kuralları |
| 2.4.7 Focus Visible / 2.4.11 Focus Not Obscured (Minimum) | Odak görünür, yapışkan üst bar altında tamamen gizlenmez | 3 px `outline` + 2 px ofset (mevcut); üst bar için `scroll-padding-top` T-246b'de denetlenir |
| Devre dışı (inactive) bileşen | 1.4.3/1.4.11'den muaf | `disabled:opacity-60` korunur; ayrıca `aria-disabled`/metinle ayrışır |

## 2. Önerilen palet (Akış — varsayılan)

Belirteç adları korunur; değerler değişir. Yeni anlam belirteçleri: `success*`, `danger*`, `info*`, `warning` (dolu/ikon), `undo` (dolu/ikon), `border-strong`. Her anlam rengi üç rol: **`<ad>`** (dolu zemin + ikon; beyaz metin taşır), **`<ad>-ink`** (metin), **`<ad>-bg`** (açık zemin).

| Belirteç | Eski (prototip) | Yeni | Rol |
|---|---|---|---|
| `ink` | #12302b | **#172133** | Ana metin, varsayılan ikon |
| `ink-muted` | #3f544f | **#4a5568** | İkincil metin, nötr ikon |
| `surface` | #ffffff | **#ffffff** | Kart, üst bar, diyalog |
| `bg` | #ecf3f1 | **#f3f5f9** | Sayfa zemini |
| `border` | #c9d6d2 | **#d5dce5** | **Yalnız süsleyici** ayırıcı (kart çerçevesi, tablo çizgisi) |
| `border-strong` (yeni) | — | **#6b778a** | Girdi, seçim kutusu, ikincil düğme kenarı (1.4.11) |
| `accent` | #0f766e (teal) | **#1559c7** | Birincil düğme, seçili durum |
| `accent-ink` | #0b5a54 | **#0f4699** | Bağlantı, `accent-soft` üstünde metin/ikon |
| `accent-soft` | #d3ece6 | **#e3ecfa** | Rozet, ikon kabı, görünüm anahtarı zemini |
| `on-accent` | #ffffff | **#ffffff** | Tüm dolu (`accent`, `danger`, `success`, `warning`, `undo`, `info`) zeminlerde metin |
| `locked-bg` | #e2e9e7 | **#e9edf2** | Kilitli/geçersiz kart |
| `locked-ink` | #46564f | **#4a5568** | Kilitli kart metni ve `Lock` ikonu |
| `focus` | #12302b | **#1559c7** | Odak halkası (Carbon/Polaris deseni: birincil mavi) |
| `warning` (yeni) | — | **#b45309** | Uyarı ikonu, uyarı dolu zemin |
| `warning-ink` | #6b4300 | **#7a3e00** | Uyarı metni |
| `warning-bg` | #fff3c4 | **#fff4d5** | Uyarı bandı, "Sahip" rozeti zemini |
| `undo` (yeni) | — | **#c2410c** | Geri al / ters kayıt ikonu |
| `undo-ink` | #8a3b00 | **#8a3300** | Ters kayıt metni |
| `undo-bg` | #ffe8d1 | **#fdebdd** | Ters kayıt rozeti zemini |
| `danger` (yeni) | — (`undo-ink` kullanılıyordu) | **#c9252c** | Tehlikeli düğme, hata ikonu, geçersiz alan kenarı |
| `danger-ink` (yeni) | — | **#a51c22** | Hata metni (alan hatası, çıkış hatası) |
| `danger-bg` (yeni) | — (`undo-bg` kullanılıyordu) | **#fdeaea** | Hata bandı zemini |
| `success` (yeni) | — | **#18794e** | Başarı ikonu, dolu başarı zemini |
| `success-ink` (yeni) | — | **#11613d** | Başarı metni |
| `success-bg` (yeni) | — | **#e4f4ea** | Başarı bandı zemini |
| `info` (yeni) | — (`accent` kullanılıyordu) | **#1a6fc2** | Bilgi ikonu |
| `info-ink` (yeni) | — | **#0d4f91** | Bilgi metni |
| `info-bg` (yeni) | — (`accent-soft` kullanılıyordu) | **#e5f0fb** | Bilgi bandı zemini |

`--shadow-card` gölge rengi `ink` ile eşlenir: `rgb(23 33 51 / 0.08)`, `rgb(23 33 51 / 0.06)`.

**Anlamsal düzeltmeler (mevcut kodda yanlış eşleme):**
- Hata bandı ve `ConfirmDialog`/`Button` `danger` çeşidi `undo-*` kullanıyor → `danger-*`. `undo` yalnız "geri al / ters kayıt" anlamında kalır (hata değil, dikkat).
- Bilgi bandı `accent-*` kullanıyor → `info-*` (marka rengi ile durum rengi ayrışır; Kokpit'te marka değişince bilgi bandı değişmez).
- Girdi ve ikincil düğme kenarı `border` (#c9d6d2, beyaz üstünde **1.50:1**, 1.4.11'i geçmiyor) → `border-strong`.
- Banner ikonu metin rengini miras alıyor → anlam rengi (`text-<ad>`), metin `-ink`.

### Nötr ve mavi ilkel skala (başvuru; CSS'e eklenmez)
Bileşenler yalnız **anlam belirteçlerini** kullanır. Aşağıdaki ilkeller değerlerin nereden geldiğini gösterir; `neutral-*` Tailwind yardımcısı olarak **eklenmez** (gereksiz yüzey; bileşen kodu `text-neutral-500` gibi sınıflara kaymasın).

| İlkel | Hex | Eşlenen belirteç |
|---|---|---|
| neutral-0 | #ffffff | `surface`, `on-accent` |
| neutral-50 | #f3f5f9 | `bg` |
| neutral-100 | #e9edf2 | `locked-bg` |
| neutral-200 | #d5dce5 | `border` |
| neutral-500 | #6b778a | `border-strong` |
| neutral-700 | #4a5568 | `ink-muted`, `locked-ink` |
| neutral-900 | #172133 | `ink` |
| blue-50 | #e3ecfa | `accent-soft` |
| blue-600 | #1559c7 | `accent`, `focus` |
| blue-800 | #0f4699 | `accent-ink` |
| navy-700 | #243d8f | Kokpit `accent`, `focus` |
| navy-800 | #1c3175 | Kokpit `accent-ink` |

## 3. Kokpit görünümü (`[data-view="cockpit"]`)
Eskiden Akış teal, Kokpit mavi idi; yeni palette ikisi de mavi ailesindedir (güven rengi tutarlı kalır). Kokpit, yoğun masaüstü görünüm olarak **daha koyu lacivert** vurgu ve biraz daha soğuk zemin alır. Görünüm farkı yalnız renkle verilmez: anahtar `aria-pressed` + etiket metniyle seçilidir (1.4.1).

| Belirteç | Eski Kokpit | Yeni Kokpit |
|---|---|---|
| `bg` | #eff2fa | **#eef1f7** |
| `accent` | #2548c4 | **#243d8f** |
| `accent-ink` | #1d3a9e | **#1c3175** |
| `accent-soft` | #dbe3fb | **#e1e6f5** |
| `locked-bg` | #e3e7f1 | **#e5e9f1** |
| `locked-ink` | #464f6b | **#465066** |
| `border` | #c9d0e4 | **#cfd6e3** |
| `focus` | (miras #12302b) | **#243d8f** |

Anlam belirteçleri (`success*`, `danger*`, `warning*`, `info*`, `undo*`, `border-strong`, `ink*`) Kokpit'te **değişmez** — durum renkleri görünümden bağımsızdır.

## 4. Uygulama yüzeyleri
Landing (`apps/web/app/page.tsx`), yönetim ekranları (`/t/<slug>` ana ekran, `settings`, `members`, `audit`), kimlik/onboarding/yardım ekranları ve `packages/ui` aynı belirteçleri kullanır. **Satış / fiyat sayfası repoda yok** (2026-10-06 `git grep -i "pricing|fiyat|satış"` → 0); ileride oluşturulacak satış veya fiyat sayfası aynı belirteçleri ve bu dosyanın kurallarını kullanır.

## 5. Kullanım kuralları (bileşen → belirteç)
| Öğe | Zemin | Metin | Kenar / ikon |
|---|---|---|---|
| Birincil düğme | `accent` | `on-accent` | — |
| İkincil düğme | `surface` | `ink` | `border-strong` (2 px) |
| Tehlikeli düğme | `danger` | `on-accent` | — |
| Girdi / seçim | `surface` | `ink` | `border-strong`; geçersizken `danger` |
| Alan hatası | — | `danger-ink` + `CircleAlert` (`danger`) | — |
| Bant: bilgi / uyarı / hata / başarı | `info-bg` / `warning-bg` / `danger-bg` / `success-bg` | `-ink` | ikon `info` / `warning` / `danger` / `success` |
| Rozet: sahip / demo / ters kayıt | `warning-bg` / `locked-bg` / `undo-bg` | `-ink` | — |
| Kart, üst bar | `surface` | `ink` | `border` (süs) |
| Kilitli kart | `locked-bg` | `locked-ink` | `Lock` ikonu `locked-ink` |
| Bağlantı | — | `accent-ink` + alt çizgi | — |
| Odak | — | — | `outline: 3px solid var(--color-focus)`, ofset 2 px |

## 6. Durum ve ikon renk kuralları
1. **Tek kütüphane:** Lucide (`lucide-react` 1.52.0, STACK kilitli; yeni bağımlılık yok). Uygulamadaki elle çizilmiş satır içi SVG'ler (`apps/web/app/layout.tsx` logo, `apps/web/app/t/[slug]/task-menu.tsx` 9 görev ikonu) Lucide karşılıklarıyla değiştirilir. `apps/web` `lucide-react`'e doğrudan bağımlı değildir; ikonlar `@wms/ui` üzerinden yeniden dışa aktarılır (`packages/ui/src/icons.ts`) — yeni paket bağımlılığı eklenmez.
2. **Renk = `currentColor`.** İkona sabit renk (`color=`/`stroke=` hex) verilmez; renk ebeveynin `text-*` belirtecinden gelir.
3. **Varsayılan nötr:** süsleyici/gezinme ikonları `ink` (birincil) veya `ink-muted` (ikincil). Görev kartı rozet ikonu `accent-ink` / `accent-soft` kabı.
4. **Durum ikonları anlam rengiyle ve sabit biçimle:** bilgi `Info` → `info`; uyarı `TriangleAlert` → `warning`; hata `CircleAlert` → `danger`; başarı `CircleCheck` → `success`; geri al `Undo2` → `undo`; kilit `Lock` → `locked-ink`; yakında `Clock` → `accent-ink`; yükleniyor `LoaderCircle` → `currentColor`. Biçimler farklı olduğundan renk körü kullanıcı ikonu biçimden ayırt eder.
5. **Durum hiçbir zaman yalnız renk değildir:** ikon + metin birlikte (1.4.1). Anlam taşıyan ikonun bitişik zemine kontrastı ≥3:1 (§7'de denetlendi).
6. **Çizgi ve boyut:** `strokeWidth` 2 (Lucide varsayılanı; `absoluteStrokeWidth` kullanılmaz). Boyutlar: 16 px (`size-4`, rozet içi), 20 px (`size-5`, bant ve düğme), 24 px (`size-6`, kart ve gezinme). İkon kabı 40 px (`size-10`, liste) veya 48 px (`size-12`, kart/logo). Dokunma hedefi ikon değil kap/düğmedir (≥48 px).
7. **Erişilebilirlik:** süsleyici ikon `aria-hidden="true"`; yalnız ikonlu düğmede erişilebilir ad `aria-label` ile (i18n).
8. **Miktar yönü** (giriş/çıkış, artış/azalış) renkle kodlanmaz: işaret + ok ikonu + metin, renk `ink` (§1.2).

## 7. WCAG kontrast tablosu
Hesaplama: WCAG 2.2 göreli parlaklık formülü (sRGB doğrusallaştırma, eşik 0.04045), oran (L1+0.05)/(L2+0.05). Betik repoya eklenmedi (Supervisor talimatı); T-246a aynı çiftleri birim testte (`apps/web/app/theme-contrast.test.ts`) `globals.css`'ten okuyarak denetler. Metin eşiği 4.5:1, UI/ikon eşiği 3:1. **Sonuç: Akış 41/41, Kokpit 41/41 çift AA geçer; geçmeyen çift yok.**


### 7.1 Akış (varsayılan)

| Ön plan | Zemin | Oran | Eşik | Sonuç | Kullanım |
|---|---|---:|---:|---|---|
| `ink` #172133 | `surface` #ffffff | 16.13:1 | 4.5:1 | AA ✓ | gövde metni (kart, diyalog, üst bar) |
| `ink` #172133 | `bg` #f3f5f9 | 14.78:1 | 4.5:1 | AA ✓ | sayfa metni |
| `ink-muted` #4a5568 | `surface` #ffffff | 7.53:1 | 4.5:1 | AA ✓ | ipucu, açıklama, saat |
| `ink-muted` #4a5568 | `bg` #f3f5f9 | 6.89:1 | 4.5:1 | AA ✓ | sayfa ikincil metni |
| `ink` #172133 | `locked-bg` #e9edf2 | 13.72:1 | 4.5:1 | AA ✓ | kilitli kart başlığı (miras) |
| `locked-ink` #4a5568 | `locked-bg` #e9edf2 | 6.40:1 | 4.5:1 | AA ✓ | kilitli kart gerekçesi |
| `locked-ink` #4a5568 | `border` #d5dce5 | 5.45:1 | 4.5:1 | AA ✓ | kilitli kart rozet ikonu |
| `on-accent` #ffffff | `accent` #1559c7 | 6.39:1 | 4.5:1 | AA ✓ | birincil düğme |
| `accent-ink` #0f4699 | `accent-soft` #e3ecfa | 7.49:1 | 4.5:1 | AA ✓ | bilgi rozeti, görünüm anahtarı, 'Kolay mod' |
| `accent-ink` #0f4699 | `surface` #ffffff | 8.91:1 | 4.5:1 | AA ✓ | bağlantı |
| `accent-ink` #0f4699 | `bg` #f3f5f9 | 8.17:1 | 4.5:1 | AA ✓ | bağlantı (sayfa zemini) |
| `warning-ink` #7a3e00 | `warning-bg` #fff4d5 | 7.61:1 | 4.5:1 | AA ✓ | uyarı bandı, 'Sahip' rozeti |
| `undo-ink` #8a3300 | `undo-bg` #fdebdd | 7.09:1 | 4.5:1 | AA ✓ | geri al / ters kayıt rozeti |
| `success-ink` #11613d | `success-bg` #e4f4ea | 6.58:1 | 4.5:1 | AA ✓ | başarı bandı/rozeti |
| `danger-ink` #a51c22 | `danger-bg` #fdeaea | 6.50:1 | 4.5:1 | AA ✓ | hata bandı |
| `info-ink` #0d4f91 | `info-bg` #e5f0fb | 7.15:1 | 4.5:1 | AA ✓ | bilgi bandı |
| `danger-ink` #a51c22 | `surface` #ffffff | 7.53:1 | 4.5:1 | AA ✓ | alan hata metni, çıkış hatası |
| `success-ink` #11613d | `surface` #ffffff | 7.50:1 | 4.5:1 | AA ✓ | başarı metni |
| `on-accent` #ffffff | `danger` #c9252c | 5.55:1 | 4.5:1 | AA ✓ | tehlikeli düğme |
| `on-accent` #ffffff | `success` #18794e | 5.41:1 | 4.5:1 | AA ✓ | başarı düğmesi (dolu) |
| `border-strong` #6b778a | `surface` #ffffff | 4.53:1 | 3:1 | AA ✓ | girdi / ikincil düğme kenarı |
| `border-strong` #6b778a | `bg` #f3f5f9 | 4.15:1 | 3:1 | AA ✓ | girdi kenarı (sayfa zemini) |
| `focus` #1559c7 | `surface` #ffffff | 6.39:1 | 3:1 | AA ✓ | odak halkası (kart/üst bar üstünde) |
| `focus` #1559c7 | `bg` #f3f5f9 | 5.86:1 | 3:1 | AA ✓ | odak halkası (sayfa zemini) |
| `accent` #1559c7 | `surface` #ffffff | 6.39:1 | 3:1 | AA ✓ | birincil düğme sınırı / seçili durum |
| `accent` #1559c7 | `bg` #f3f5f9 | 5.86:1 | 3:1 | AA ✓ | birincil düğme sınırı (sayfa) |
| `danger` #c9252c | `surface` #ffffff | 5.55:1 | 3:1 | AA ✓ | hata ikonu / geçersiz alan kenarı |
| `danger` #c9252c | `danger-bg` #fdeaea | 4.79:1 | 3:1 | AA ✓ | hata bandı ikonu |
| `warning` #b45309 | `surface` #ffffff | 5.02:1 | 3:1 | AA ✓ | uyarı ikonu |
| `warning` #b45309 | `warning-bg` #fff4d5 | 4.58:1 | 3:1 | AA ✓ | uyarı bandı ikonu |
| `success` #18794e | `surface` #ffffff | 5.41:1 | 3:1 | AA ✓ | başarı ikonu |
| `success` #18794e | `success-bg` #e4f4ea | 4.74:1 | 3:1 | AA ✓ | başarı bandı ikonu |
| `info` #1a6fc2 | `surface` #ffffff | 5.13:1 | 3:1 | AA ✓ | bilgi ikonu |
| `info` #1a6fc2 | `info-bg` #e5f0fb | 4.44:1 | 3:1 | AA ✓ | bilgi bandı ikonu |
| `undo` #c2410c | `surface` #ffffff | 5.18:1 | 3:1 | AA ✓ | geri al ikonu |
| `undo` #c2410c | `undo-bg` #fdebdd | 4.46:1 | 3:1 | AA ✓ | geri al rozeti ikonu |
| `ink-muted` #4a5568 | `surface` #ffffff | 7.53:1 | 3:1 | AA ✓ | nötr ikon (varsayılan) |
| `accent` #1559c7 | `accent-soft` #e3ecfa | 5.37:1 | 3:1 | AA ✓ | görünüm anahtarı seçili parça |
| `danger` #c9252c | `bg` #f3f5f9 | 5.08:1 | 3:1 | AA ✓ | geçersiz alan kenarı (sayfa zemini) |
| `ink-muted` #4a5568 | `locked-bg` #e9edf2 | 6.40:1 | 3:1 | AA ✓ | kilit ikonu |
| `accent-ink` #0f4699 | `accent-soft` #e3ecfa | 7.49:1 | 3:1 | AA ✓ | kart rozet ikonu |

Akış (varsayılan): 41 çift, kalan 0

### 7.2 Kokpit

| Ön plan | Zemin | Oran | Eşik | Sonuç | Kullanım |
|---|---|---:|---:|---|---|
| `ink` #172133 | `surface` #ffffff | 16.13:1 | 4.5:1 | AA ✓ | gövde metni (kart, diyalog, üst bar) |
| `ink` #172133 | `bg` #eef1f7 | 14.26:1 | 4.5:1 | AA ✓ | sayfa metni |
| `ink-muted` #4a5568 | `surface` #ffffff | 7.53:1 | 4.5:1 | AA ✓ | ipucu, açıklama, saat |
| `ink-muted` #4a5568 | `bg` #eef1f7 | 6.65:1 | 4.5:1 | AA ✓ | sayfa ikincil metni |
| `ink` #172133 | `locked-bg` #e5e9f1 | 13.26:1 | 4.5:1 | AA ✓ | kilitli kart başlığı (miras) |
| `locked-ink` #465066 | `locked-bg` #e5e9f1 | 6.64:1 | 4.5:1 | AA ✓ | kilitli kart gerekçesi |
| `locked-ink` #465066 | `border` #cfd6e3 | 5.53:1 | 4.5:1 | AA ✓ | kilitli kart rozet ikonu |
| `on-accent` #ffffff | `accent` #243d8f | 9.82:1 | 4.5:1 | AA ✓ | birincil düğme |
| `accent-ink` #1c3175 | `accent-soft` #e1e6f5 | 9.65:1 | 4.5:1 | AA ✓ | bilgi rozeti, görünüm anahtarı, 'Kolay mod' |
| `accent-ink` #1c3175 | `surface` #ffffff | 12.03:1 | 4.5:1 | AA ✓ | bağlantı |
| `accent-ink` #1c3175 | `bg` #eef1f7 | 10.63:1 | 4.5:1 | AA ✓ | bağlantı (sayfa zemini) |
| `warning-ink` #7a3e00 | `warning-bg` #fff4d5 | 7.61:1 | 4.5:1 | AA ✓ | uyarı bandı, 'Sahip' rozeti |
| `undo-ink` #8a3300 | `undo-bg` #fdebdd | 7.09:1 | 4.5:1 | AA ✓ | geri al / ters kayıt rozeti |
| `success-ink` #11613d | `success-bg` #e4f4ea | 6.58:1 | 4.5:1 | AA ✓ | başarı bandı/rozeti |
| `danger-ink` #a51c22 | `danger-bg` #fdeaea | 6.50:1 | 4.5:1 | AA ✓ | hata bandı |
| `info-ink` #0d4f91 | `info-bg` #e5f0fb | 7.15:1 | 4.5:1 | AA ✓ | bilgi bandı |
| `danger-ink` #a51c22 | `surface` #ffffff | 7.53:1 | 4.5:1 | AA ✓ | alan hata metni, çıkış hatası |
| `success-ink` #11613d | `surface` #ffffff | 7.50:1 | 4.5:1 | AA ✓ | başarı metni |
| `on-accent` #ffffff | `danger` #c9252c | 5.55:1 | 4.5:1 | AA ✓ | tehlikeli düğme |
| `on-accent` #ffffff | `success` #18794e | 5.41:1 | 4.5:1 | AA ✓ | başarı düğmesi (dolu) |
| `border-strong` #6b778a | `surface` #ffffff | 4.53:1 | 3:1 | AA ✓ | girdi / ikincil düğme kenarı |
| `border-strong` #6b778a | `bg` #eef1f7 | 4.01:1 | 3:1 | AA ✓ | girdi kenarı (sayfa zemini) |
| `focus` #243d8f | `surface` #ffffff | 9.82:1 | 3:1 | AA ✓ | odak halkası (kart/üst bar üstünde) |
| `focus` #243d8f | `bg` #eef1f7 | 8.68:1 | 3:1 | AA ✓ | odak halkası (sayfa zemini) |
| `accent` #243d8f | `surface` #ffffff | 9.82:1 | 3:1 | AA ✓ | birincil düğme sınırı / seçili durum |
| `accent` #243d8f | `bg` #eef1f7 | 8.68:1 | 3:1 | AA ✓ | birincil düğme sınırı (sayfa) |
| `danger` #c9252c | `surface` #ffffff | 5.55:1 | 3:1 | AA ✓ | hata ikonu / geçersiz alan kenarı |
| `danger` #c9252c | `danger-bg` #fdeaea | 4.79:1 | 3:1 | AA ✓ | hata bandı ikonu |
| `warning` #b45309 | `surface` #ffffff | 5.02:1 | 3:1 | AA ✓ | uyarı ikonu |
| `warning` #b45309 | `warning-bg` #fff4d5 | 4.58:1 | 3:1 | AA ✓ | uyarı bandı ikonu |
| `success` #18794e | `surface` #ffffff | 5.41:1 | 3:1 | AA ✓ | başarı ikonu |
| `success` #18794e | `success-bg` #e4f4ea | 4.74:1 | 3:1 | AA ✓ | başarı bandı ikonu |
| `info` #1a6fc2 | `surface` #ffffff | 5.13:1 | 3:1 | AA ✓ | bilgi ikonu |
| `info` #1a6fc2 | `info-bg` #e5f0fb | 4.44:1 | 3:1 | AA ✓ | bilgi bandı ikonu |
| `undo` #c2410c | `surface` #ffffff | 5.18:1 | 3:1 | AA ✓ | geri al ikonu |
| `undo` #c2410c | `undo-bg` #fdebdd | 4.46:1 | 3:1 | AA ✓ | geri al rozeti ikonu |
| `ink-muted` #4a5568 | `surface` #ffffff | 7.53:1 | 3:1 | AA ✓ | nötr ikon (varsayılan) |
| `accent` #243d8f | `accent-soft` #e1e6f5 | 7.87:1 | 3:1 | AA ✓ | görünüm anahtarı seçili parça |
| `danger` #c9252c | `bg` #eef1f7 | 4.90:1 | 3:1 | AA ✓ | geçersiz alan kenarı (sayfa zemini) |
| `ink-muted` #4a5568 | `locked-bg` #e5e9f1 | 6.18:1 | 3:1 | AA ✓ | kilit ikonu |
| `accent-ink` #1c3175 | `accent-soft` #e1e6f5 | 9.65:1 | 3:1 | AA ✓ | kart rozet ikonu |

Kokpit: 41 çift, kalan 0

### 7.3 Karşılaştırma: eski prototip paleti
- Referans: prototip accent #0f766e / beyaz: 5.47:1
- Referans: prototip border #c9d6d2 / surface: 1.50:1
- Referans: prototip undo-ink #8a3b00 / surface: 7.76:1

Not: eski `border` (#c9d6d2) girdi kenarı olarak 1.50:1 ile 1.4.11'i geçmiyordu; yeni palet bunu `border-strong` ile düzeltir.

## 8. Koyu tema (kapsam dışı — gelecek notu)
- Belirteç yapısı koyu temaya hazırdır: bileşenler yalnız anlam belirteçlerini kullandığından koyu tema yeni bir seçici bloğu (`[data-theme="dark"]` ve/veya `@media (prefers-color-scheme: dark)`) ile yalnız değerleri değiştirir; bileşen kodu değişmez.
- Koyu temada dolu anlam renkleri (`danger`, `success`…) açıklaştırılır, `-bg` belirteçleri koyu ve düşük doygunlukta olur; tüm §7 çiftleri yeniden hesaplanır (aynı birim test).
- Kokpit × koyu tema bileşimi ayrıca tanımlanmalıdır (4 kombinasyon). Ayrı kart + ADR-020 eki; tetikleyici kullanıcı/pilot talebi.

## 9. Kaynaklar
- IBM Carbon — renk ve tema belirteçleri: https://carbondesignsystem.com/elements/color/tokens/ · paket `@carbon/themes` 11.82.0 (`src/dtcg/themes.json`, White)
- Atlassian Design System — renk: https://atlassian.design/foundations/color-new · paket `@atlaskit/tokens` 20.3.0 (`atlassian-light`)
- Microsoft Fluent 2 — renk: https://fluent2.microsoft.design/color · paket `@fluentui/tokens` 1.0.0-alpha.24 (`global/colors.js`, `statusColorMapping.js`)
- Google Material 3 — renk rolleri: https://m3.material.io/styles/color/roles · paket `@material/web` 2.5.0 (`tokens/versions/v0_192/_md-ref-palette.scss`)
- Salesforce Lightning Design System — renk: https://www.lightningdesignsystem.com/design-tokens/ · paket `@salesforce-ux/design-system` 2.264.1
- GOV.UK Design System — renk: https://design-system.service.gov.uk/styles/colour/ · paket `govuk-frontend` 6.5.1 (`settings/_colours-functional.scss`, `_colours-palette--internal.scss`)
- Shopify Polaris — renk belirteçleri: https://polaris-react.shopify.com/tokens/color · paket `@shopify/polaris-tokens` 9.4.2 (`dist/css/styles.css`)
- GitHub Primer — renk: https://primer.style/foundations/color · paket `@primer/primitives` 11.10.0 (`dist/css/functional/themes/light.css`)
- WCAG 2.2: https://www.w3.org/TR/WCAG22/ — 1.4.1, 1.4.3, 1.4.11, 2.4.7, 2.4.11; kontrast oranı tanımı https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
- Mavi ve güven: DeSantis Breindel, "The Financial Blues" https://www.desantisbreindel.com/thinking/the-financial-blues/ · Lizbon Üniversitesi deneysel çalışma (renk ve marka güveni) https://repositorio.ulisboa.pt/entities/publication/5c2ad3c1-be35-4ada-97c1-303b67190fb3
- Borsa renk gelenekleri: Benzinga https://www.benzinga.com/general/education/21/10/23258001/did-you-know-you-dont-want-to-be-in-the-green-if-youre-trading-in-china-japan-or-taiwan · W3C www-international (LC_STOCK_COLOR) https://lists.w3.org/Archives/Public/www-international/2005JulSep/0188.html · data.europa.eu renk çağrışımları https://data.europa.eu/apps/data-visualisation-guide/colour-connotations
- Renk körlüğü yaygınlığı: UTMB Accessibility https://www.utmb.edu/accessibility/digital/100-days-of-a11y/100-days-article/days-of-a11y/2024/04/03/3.-color-blindness

Tasarım sistemi web sayfaları ajan ortamından açılamadı (egress engeli): bu sayfaların bağlantıları **erişimle doğrulanmadı**, yalnız başvuru içindir. Hex değerlerinin kaynağı yukarıdaki npm paketlerinin belirteç dosyalarıdır (2026-10-06, `npm pack`). Araştırma bağlantıları (güven, borsa renkleri, renk körlüğü, WCAG) web aramasıyla bulundu.
