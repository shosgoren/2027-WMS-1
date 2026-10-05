# 09 — Import ve Entegrasyonlar

## CSV/Excel import
Yükle → sütun eşleştir (akıllı öneri) → önizle/validate → hataları indir → onayla → worker'da işle. Birim, tarih, barkod, encoding (Windows-1254 dahil), yinelenen satır kuralları tanımlı. Kart import'u ≠ stok açılış import'u; stok import'u defteri atlayamaz. Her satırın dış referansı/idempotency kaydı; tekrar import çift stok yapmaz. Formül/CSV injection, zip bomb, boyut/satır sınırları.

## Logo ERP (Go/Tiger)
Ürün/sürüm, örnek export ve alan eşleme matrisi doğrulanmadan "birebir uyum" iddiası yok. ERP veritabanına doğrudan yazılmaz; belgelenmiş API, kontrollü adapter veya export/import. Ürün, sipariş, stok, cari için otorite ayrı belirlenir; dış referans ve senkron cursor'ları saklanır; hata ve mutabakat ekranı.

## Webhook ve olaylar
Gelen/giden webhook'larda imza, zaman penceresi, tekrar kontrolü, retry/backoff, dead-letter; sırasız olaylar sürüm kontrolüyle.

## e-İrsaliye
WMS sevk belgesi e-İrsaliye değildir. Gerekirse özel entegratör adapter'ı (Faz 6) ile gönderim; belge durumu geri alınır.

## Public API (Faz 6)
Tenant API anahtarları (kapsamlı izin, rotasyon, hash'li saklama), sürümlü REST, rate limit, idempotency başlığı; aynı domain komutları.

## B2B (Faz 7)
İzinli veri paylaşımı, iki tarafta ayrı belgeler; tenantlar arası genel RLS istisnası açılmaz; izin iptali ve paylaşılan alanlar açık.
