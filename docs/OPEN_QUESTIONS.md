# Açık Sorular ve Varsayımlar
Format: `Q-xx | soru | etkilenen T/I | durum` · `A-xx | varsayım | geçerlilik koşulu | doğrulayan Q`

## Sorular
Q-01 | Neon'da hangi bölge kullanılacak; güncel bölge listesinde TR bölgesi gerçekten yok mu? (Bölge ADR-007 KVKK yurt dışı aktarım kararına bağlı) | ADR-004, ADR-007, T-005, T-001b | açık
Q-02 | Neon pooler'ının türü ve sürümü nedir (PgBouncer ise hangi sürüm); sağlayıcı tarafı güncellemeler nasıl izlenecek (yeniden spike tetikleyicisi); CI'daki docker PgBouncer bununla davranış olarak eşdeğer mi? | ADR-004, T-005, I-02 | açık
Q-03 | Hangi PostgreSQL sürücüsü kullanılacak (postgres.js / node-postgres / Neon serverless) ve Drizzle ile hangi sürümler? | ADR-003, ADR-004, T-004, T-005 | açık
Q-04 | Neon pooler'ı protokol düzeyi prepared statement destekliyor mu; sürücüde prepared statement açık mı kapalı mı olacak? (Karar T-005 test sonucuna göre) | ADR-003, ADR-004, T-005 | açık
Q-05 | Neon'da hangi PostgreSQL ana sürümü kullanılacak? | ADR-004, T-004, T-005 | açık
Q-06 | Neon'da migration ve session'a bağlı worker işleri için doğrudan (pooler'sız) bağlantı nasıl sağlanacak; uygulama rolü ile migration rolü ayrımı nasıl kurulacak? | ADR-004, T-005, I-02 | açık
Q-07 | AB bölgesinde barındırma için KVKK yurt dışı aktarım mekanizması (standart sözleşme, bildirim yükümlülükleri) hukukçu tarafından yazılı olarak onaylandı mı? Onaysız gerçek kişisel veriyle prod'a çıkılmaz | ADR-007, ADR-004, ADR-006, prod kapısı | açık
Q-08 | Ürün adı "Rafta" mı "Stoklu" mu? (Repo/dokümanlar "Rafta", tasarım kanvası "Stoklu" diyor) | UI metinleri, i18n katalog, alan adı, T-002 | açık
Q-09 | Tasarım referansı hangisi? | UI kartları (Faz 1+), `packages/ui` | **kapandı 2026-10-05 (kullanıcı):** referans `docs/design/stok-takip-prototipi.pdf` — tek ekran ("Ne yapmak istiyorsun?" ana menüsü), 3 görünüm (Akış/Kokpit masaüstü, mobil). 16 ekranlık kanvas beklenmez; diğer ekranlar bu görsel dili izler
Q-10 | Neon hesabı ve proje oluşturuldu mu; bağlantı bilgileri ajanlara hangi sır kanalıyla verilecek? (Kullanıcı eylemi; bilgiler repoya/rapora girmez — G-09) | T-005, ADR-004 | açık
Q-11 | Postgres kuyruğundan BullMQ'ya geçişin sayısal eşikleri nedir (dead tuple sayısı, kuyruk kaynaklı WAL MB/saat, iş gecikmesi p95, saniyedeki iş sayısı)? İlk yük profili ölçümüyle belirlenecek | ADR-005 | açık

## Varsayımlar
A-01 | Neon pooler'ı transaction-mode PgBouncer'dır (kullanıcı kararı kaydı, 2026-10-05; doğrulanmadı) | T-005 Neon üzerinde pooler türü/sürümü belirlenene kadar | Q-02
A-02 | Barındırma AB bölgesinde; KVKK yurt dışı aktarımı standart sözleşmeyle (ADR-007; varsayılan sunuldu, itiraz gelmedi 2026-10-05) | Hukukçu yazılı onayına kadar; onaysız gerçek kişisel veriyle prod yok | Q-07
A-03 | Onay/görev ayrımı tenant ayarıdır, varsayılan kapalı (karar listesi md. 10; itiraz gelmedi 2026-10-05) | Kullanıcı aksini belirtene veya pilot müşteri farklı ihtiyaç bildirene kadar | — (PILOT.md, T-006)
A-04 | Negatif stok yasaktır; istisna yoktur (karar listesi md. 10; itiraz gelmedi 2026-10-05) | Kullanıcı istisna tanımlayana kadar; istisna stok etkili olduğundan netleşmeden üretime açılmaz | — (PILOT.md, T-006)
A-05 | Boşluksuz (ardışık, atlamasız) fiş numarası gerekmez (karar listesi md. 10; itiraz gelmedi 2026-10-05) | Mevzuat/pilot müşteri gereksinimi aksini gösterene kadar | — (PILOT.md, T-006)
A-06 | Mal kabulde kalite kontrol varsayılan olarak açıktır (karar listesi md. 10; itiraz gelmedi 2026-10-05) | Kullanıcı/pilot aksini belirtene kadar | — (PILOT.md, T-006)
A-07 | Senkron belge satır eşiği 200, belge başına sert sınır 2.000 satır (`05 §Senkron işlem sınırları` önerisi; itiraz gelmedi 2026-10-05) | İlk yük profili ölçümü (AC-36) aksini gösterene kadar | — (karar listesi md. 11)
A-08 | Offline pilot kapsamında yoktur; Faz 5 pilot öncesine alınmaz (karar listesi md. 11; itiraz gelmedi 2026-10-05) | Pilot müşteri offline gerektirene kadar (`PHASES.md`: offline vaat edilen pilotta Faz 5 öne alınır) | — (PILOT.md, T-006)
A-09 | Logo ürün/sürümü, maliyet otoritesi, ilk hedef el terminali ve etiket yazıcısı kararları Faz 6'ya ertelenir (karar listesi md. 14; itiraz gelmedi 2026-10-05). Tarama yolu bu sürede ADR-010 varsayılanıyla ilerler | Pilot cihazı veya ERP gereksinimi daha erken netleşene kadar | — (ADR-010 yeniden değerlendirme tetikleyicisi)
A-10 | Pilot gerçek müşteri belli değilse `PILOT.md` varsayımsal profille doldurulur (T-006); her satırı ayrı `A-xx` ile işaretlenir | En geç Faz 3A başlamadan gerçek müşteriyle doğrulanır (`PHASES.md §Pilot tanımı` tamlık kuralı) | — (T-006)
