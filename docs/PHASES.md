# Fazlar ve Üretim Kapıları
Her faz başında `architect` fazı kartlara böler; faz sonunda Supervisor kapı raporu verir ve kullanıcı onayı olmadan sonraki faza geçilmez.

| Faz | Kapsam | Çıkış kapısı |
|---|---|---|
**Kapı kuralı:** Bir fazın kapısı, `docs/ACCEPTANCE.md`'de "Faz" sütunu o faz olan **tüm** AC'lerin geçmesidir; aşağıdaki tablo bu listeyi tekrarlar ama tek doğru kaynak ACCEPTANCE'tır. Testler `@AC-xx` etiketiyle yazılır; `pnpm test:ac --phase N` o fazın tüm AC'lerini koşturur ve etiketli testi olmayan AC'yi **hata** sayar (eksik test = kapı kapalı). Koşullu AC'ler (`ACCEPTANCE.md` §Koşullu) koşulları sağlanıyorsa kapıya otomatik eklenir. Bir AC'yi başka faza taşımak veya koşullu yapmak §Onay kaynağı kuralıyla insan onayı ister. Kabul senaryoları sağlayıcıdan bağımsız sonuç tanımlar; belirli bir altyapıya (Redis, broker, ORM) bağlı senaryolar yalnızca koşullu bölümde yer alır.

| Faz | Kapsam | Çıkış kapısı (AC'ler + ek kanıt) |
|---|---|---|
| 0 — Kararlar & iskelet | Karar listesi → ADR'ler; monorepo, docker compose, `pnpm verify`, `pnpm test:ac`, CI, STACK/MAP; gerçek pooler arkasında RLS spike'ı (T-005); pilot tanımı | **AC-05, AC-28, AC-37, AC-43, AC-44**; ADR-001…004, ADR-011 ve ADR-012 kabul; branch protection + CODEOWNERS + ajan kimliği kurulu; `check:pilot` yeşil (PILOT.md tam; varsayımlar `A-xx` ile); bekçiler CI'da zorunlu; PgBouncer arkasında CI yeşil |
| 1 — Güvenli temel | Auth, üyelik/RBAC, RLS, audit, işlemsel e-posta, temel izleme/yedek, landing + onboarding + pilot sektör şablonu | **AC-04, AC-18**; AC-05 CI'da yeşil kalmaya devam; restore kanıtı |
| 2 — Kartlar & stok çekirdeği | Ürün/birim/barkod, depo/lokasyon, pilotun gerektirdiği lot/seri, defter, bakiye, rezervasyon, idempotency, ters kayıt, kuyruk/outbox, kilit sözleşmesi, tutarlılık işi | **AC-01, 02, 03, 06, 09, 16, 21, 22, 23, 27, 36** + koşullu AC-32, 33 (ADR-005 broker seçtiyse) |
| 3A — Pilot akışı | Yalnızca §Pilot tanımındaki akış: kabul → yerleştirme → rezervasyon → toplama görevlendirmesi → sevk → iade → kilitli sayım; pilotun barkod/etiket ihtiyacı; pilot raporları ve min-maks uyarısı | **AC-08, 10, 13, 20, 31, 35, 39, 40** + koşullu AC-34 (lot), AC-41 (SKT/FEFO), AC-42 (seri), AC-38 (izlenen koli/palet) — koşullar `PILOT.md`'den; PILOT.md'de doğrulanmamış `A-xx` yok; pilot depo verisiyle prova |
| 4P — Pilot hazırlığı | Kart/stok açılış import'u, export/takeout, kapatma süreci, yedek/restore, alarm, güvenlik ve yük testi, hukuki metinler (aydınlatma, DPA, kullanım koşulları) | **AC-15, 17, 24, 26, 29, 30**; pilot kontrol listesi; geri dönüş prosedürü |
| ▶ **Pilot** | Seçilen tek müşteri, tek depo, §Pilot başarı ölçütleri | Ölçütler karşılandı; kullanıcı onayı |
| 3B — Kalan depo akışları | Transfer ve transit, üretim giriş/sarf, çoklu depo, ek raporlar | **AC-07** + yeni kartların AC'leri |
| 4S — Ticari SaaS | Abonelik, ödeme sağlayıcısı, e-Arşiv, paket limitleri, self-servis kayıt açılışı | **AC-19, 25** + faturalama AC'leri |
| 5 — Mobil/offline | Cihaz matrisi, IndexedDB kuyruğu, senkron, çatışma | **AC-11, 12**; ağ kesintisi/ortak cihaz testleri |
| 6 — Genişletme | Metadata/no-code, Logo adapter, e-İrsaliye adapter, public API, gelişmiş etiket | **AC-14**; entegrasyon retry ve yetki testleri |
| 7 — AI & ölçek | BYOK/yönetilen AI, tahmin, kapasite artırımı, B2B | AI onay/veri sınırları; ölçülen kapasite/maliyet |

Pilot ücretsiz ve sözleşmeli yürütülür; bu yüzden abonelik/ödeme (4S) pilotun önünde değildir. Offline vaat edilen pilotta Faz 5 pilot öncesine alınır. Pilot sektör lot/seri/FEFO gerektiriyorsa bunlar Faz 2–3A'dan çıkarılmaz. AI ve kapsamlı no-code güvenli stok çekirdeğinin önüne alınmaz.

## Pilot tanımı (Faz 0'da kullanıcıyla doldurulur; `docs/PILOT.md` olarak kaydedilir)
| Alan | Değer |
|---|---|
| Sektör (tek) | … (ör. hırdavat: lot yok; gıda: lot + SKT + FEFO) |
| Müşteri | … |
| Depo sayısı | 1 |
| Lokasyon sayısı / derinlik | … / … (ör. Bölge→Raf→Göz) |
| Aktif SKU sayısı | … |
| Takip modu | NONE / LOT / SERIAL / LOT_AND_SERIAL — ürün grubu bazında |
| SKT kullanımı ve kuralı | Yok / var: FEFO mu, minimum kalan raf ömrü (gün) kaç — SKT yalnızca lotlu ürünlerde tutulur |
| Koli/palet nasıl kullanılıyor | (a) Yalnızca birim: "1 koli = 12 adet" dönüşümü, koli açılıp adetle çalışılıyor · (b) **İzlenen taşıma birimi**: koli/palet kendi barkoduyla (LPN/SSCC) okutuluyor, içeriği birlikte hareket ediyor · (c) Karışık |
| Kısmi koli açma | Var / yok |
| Stok sahibi | Tek sahip / müşteri adına (3PL, konsinye) |
| Mevcut sistem ve geçiş verisi | … (Excel / Logo / el defteri; açılış stoku nasıl alınacak) |
| Günlük ortalama kabul / sipariş / sevk satırı | … / … / … |
| Kullanıcı sayısı ve rolleri | … (ör. 1 yönetici, 1 depo şefi, 3 toplayıcı) |
| Cihazlar | … (ör. 2 Android + kamera; 1 USB okuyucu) |
| Etiket yazıcısı | … |
| Offline gerekli mi | Evet / Hayır |
| ERP bağlantısı | Pilot kapsamında yok (Excel import/export) |

**Tamlık kuralı:** `docs/PILOT.md` içinde `…`, "TBD" veya seçilmemiş seçenek kalamaz; `pnpm check:pilot` bunu denetler ve Faz 0 kapısının parçasıdır. Pilot müşteri henüz belli değilse tablo **varsayımsal profil** olarak doldurulur; her varsayım `A-xx` ile işaretlenir ve en geç Faz 3A başlamadan gerçek müşteriyle doğrulanır. Doğrulanmamış `A-xx` varken Faz 3A kapısı kapanmaz. `check:pilot` tutarlılığı da denetler: SKT "var" ise en az bir ürün grubu `LOT`/`LOT_AND_SERIAL` olmalı (SKT lotta tutulur); koli cevabı (b)/(c) ise ADR-011 kabul edilmiş olmalı. Koşullu AC'lerin (AC-34, 38, 41, 42) koşulları bu dosyadan okunur.

**Modele etkisi (Faz 2 kart setini belirler):**
| Pilot cevabı | Faz 2 (model) | Faz 3A (saha akışı) |
|---|---|---|
| Takip modu NONE | Lot/seri tabloları ve boyut alanları yine kurulur (takip modu kararı) | Lot/seri ekranı yok |
| LOT + SKT | Aynı model | Lot seçimi, FEFO, SKT uyarısı, raf ömrü kuralı (AC-34) |
| SERIAL | Aynı model | Birim başına tarama (AC-34) |
| Koli (a) birim | Birim dönüşümü + paket barkodu (mevcut model) | Koli barkodu okutunca adet otomatik |
| Koli (b) izlenen taşıma birimi | Taşıma birimi boyutu (`handling_unit_id`) — ADR-011 varsayılanıyla zaten kurulu | Koli/palet taşıma, koli açma, içerik sorgulama (AC-38) |
| Müşteri adına stok | `inventory_owner` boyutu zaten var | Sahip bazlı rapor ve sevk kısıtı |

**Pilot senaryosu (AC-31'in temeli):** Tedarikçi teslimatının kabulü (kısmi + 1 hasarlı satır) → karantinadan çıkış → yerleştirme → 3 müşteri siparişinin rezervasyonu → toplama görevlendirmesi ve toplama (1 "ürün bulunamadı" durumu) → sevk (1 kısmi sevk) → 1 müşteri iadesi (karantinaya) → seçili lokasyonlarda kilitli sayım ve fark onayı → stok durumu ve hareket raporu.

**Pilot başarı ölçütleri (sayı bazlı):**
| Ölçüt | Hedef |
|---|---|
| Kesintisiz pilot süresi | ≥ 20 iş günü |
| Sistemde işlenen hareket satırı | ≥ pilot tanımındaki günlük hacim × 20 |
| Defter–bakiye tutarsızlığı (tutarlılık işi) | 0 |
| Tenant izolasyon ihlali | 0 |
| Kaybolan veya çift işlenen stok işlemi | 0 |
| Pilot sonu sayımında açıklanamayan fark | ≤ … adet (müşteriyle birlikte belirlenir) |
| Personelin destek almadan tamamlayamadığı görev | Haftada ≤ … adet, pilot boyunca azalan |
| Kritik (stok/veri) hata | 0 açık; çözülen her biri için regresyon testi |
| Stok kesinleştirme gecikmesi | p95 ≤ 1 sn |

## Faz 0 karar listesi (Supervisor tek mesajda, önerili seçeneklerle sorar)
**Kritik yol — ilk dördü cevaplanmadan T-002 (iskelet) ve T-005 (pooler spike) başlamaz:**
1. ADR-001 Uygulama mimarisi: Next.js monolit + ayrı worker (öneri) / NestJS API + Next.js ön yüz (önceki v1.3)
2. ADR-002 Kod/DB adlandırma dili: İngilizce kod/DB + Türkçe UI + `GLOSSARY.md` eşlemesi (öneri) / Türkçe-first (önceki tercih; v1.3 kataloğu çevrilmez)
3. ADR-004 PostgreSQL barındırma ve pooler (Neon / Supabase / Azure / kendi kurulum) — T-005 bu sağlayıcı üzerinde koşar
4. ADR-003 ORM: Drizzle (öneri; gerekçe `docs/STACK.md`) / Prisma

**Faz 0 içinde, iskelet sürerken:**
5. ADR-005 Kuyruk: Postgres kuyruğu (Faz 0–4 önerisi) / BullMQ+Redis / RabbitMQ
6. ADR-006 Dosya deposu: S3 uyumlu / Azure Blob
7. ADR-007 Barındırma bölgesi ve KVKK aktarım yaklaşımı
8. ADR-008 Ödeme sağlayıcısı ve e-Arşiv entegratörü
9. **Pilot tanımı** (tek sektör, müşteri, depo profili; yukarıdaki tablo) — Faz 2 kart setini bu belirler; paket birimleri ve miktar hassasiyeti
10. Onay/görev ayrımı; negatif stok istisnası; boşluksuz fiş numarası gerekip gerekmediği; kabulde kalite kontrol varsayılanı; senkron belge satır eşiği ve sert sınır; rezervasyon modeli (sert tahsis varsayılanı — ADR-009); tarama yolu (keystroke / Enterprise Browser / yerel kabuk — ADR-010)
11. İlk yük profili sayıları; offline azami süre ve izinli işlemler
12. ADR-012 Ajan GitHub kimliği ve onay kaynağı (ayrı kimlik önerilir; kullanıcının GitHub ayarı gerekir)
13. ADR-011 Taşıma birimi (koli/palet LPN) — model Faz 2'de, akış pilota göre (öneri)
14. Logo ürün/sürümü; maliyet otoritesi; saklama sınıfları; ilk hedef el terminali ve etiket yazıcısı
Cevaplanmayan maddeler `A-xx` varsayımıyla ilerler; stok veya güvenlik etkili olanlar netleşmeden ilgili özellik üretime açılmaz.
