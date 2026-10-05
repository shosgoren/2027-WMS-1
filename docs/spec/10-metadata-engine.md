# 10 — No-Code Metadata Motoru (Faz 6)

- JSONB özel alanlar: ürün, cari, depo, belge başlığı/satırı. Türler: metin, sayı, tarih, seçim, barkod, görsel URL. Çekirdek alanlar (miktar, rezervasyon, lot/seri, sahiplik, durum, SKT) metadata'ya taşınmaz (I-11).
- Katman 1 (süper yönetici/global) ve Katman 2 (tenant) ayrı tablolar/politikalar; global tanımlar tenant için salt okunur; tenant yalnızca paketi dahilinde etiket ve görünürlük ayarlar.
- Doğrulama sunucuda, sürümlü JSON Schema'dan; form aynı şemadan çizilir (server-driven UI).
- Sürüm durumları: taslak → doğrulanmış → yayımlanmış → emekli. Yeni zorunlu alan için backfill/default planı; tür değişiminde sessiz dönüşüm yok.
- Yeni fiş tipi yalnızca test edilmiş davranışlardan türetilir: giriş, çıkış, lokasyon/durum/sahiplik değişimi, rezervasyon, etkisiz. Keyfî kod/SQL, sınırsız kural zinciri, çekirdek kontrolü kapatma yok. Çok aşamalı semantik (transfer gibi) kod + test gerektirir.
- `feature_key` ile paketlere bağlama; entitlement sunucuda uygulanır, upsell modalı sunumdur. Feature flag (dağıtım) ≠ entitlement (ticari hak).
- JSONB sorguları için hedefli indeks ve boyut sınırı.
