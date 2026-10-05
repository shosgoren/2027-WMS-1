# 13 — Raporlar, Uyarılar, Bildirim ve Yazdırma (önceki belgelerde eksikti)

## Temel raporlar (pilot raporları Faz 3A, diğerleri 3B)
Anlık stok durumu (depo/lokasyon/lot/durum), hareket ekstresi (ürün/lokasyon/tarih), SKT yaklaşan ve geçmiş lotlar, min-maks altı ürünler, yavaş dönen/hareketsiz stok, açık siparişler ve rezervasyonlar, transit stok, sayım farkları, personel görev performansı (adet bazlı). Raporlar tenant kapsamlı, sayfalı; büyük çıktılar worker ile Excel/CSV.

## Uyarılar
Min-maks / yeniden sipariş noktası, SKT eşiği, tutarlılık farkı, senkronizasyon çatışması, kuyruk/entegrasyon hatası. Uyarı kuralı tenant ayarlıdır, stok değiştirmez.

## Bildirim
Uygulama içi + işlemsel e-posta (Faz 1); push/SMS sonraki. Kullanıcı tercihleri; işlemsel ve pazarlama ayrı (İYS). Tüm gönderimler outbox üzerinden.

## Yazdırma
A4 belge PDF'leri (irsaliye benzeri sevk belgesi, toplama listesi, sayım formu) ve etiketler (ürün, lokasyon, koli; ZPL/PDF). Şablonlar tenant logosu ve terminolojisiyle; şablon sürümü belgeye kaydedilir.

## Arama
Ürün kodu/adı/barkod ile hızlı arama (PostgreSQL trigram/tam metin); ayrı arama motoru ölçüme göre.
