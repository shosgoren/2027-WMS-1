# 03 — Güvenlik, KVKK ve Türkiye Mevzuatı

## Uygulama güvenliği
- Sunucuda Zod validasyonu, parametrik SQL, bağlama uygun XSS koruması, güvenli cookie, CSP; cookie tabanlı yazmalarda CSRF/origin kontrolü. IDOR'a karşı her kaynak erişiminde sahiplik kontrolü.
- Rate limit: IP, kullanıcı, tenant; import/export/AI için ek kota.
- TLS 1.3 tercih; at-rest şifreleme ve anahtar rotasyonu DB, dosya ve yedekler için doğrulanır.
- Dosya yükleme: boyut/tür, içerik doğrulama, karantina, kötü amaçlı yazılım taraması; haricî URL indirmede SSRF sınırı.
- Bağımlılık ve sır taraması CI'da; bilinen kritik açık = merge yok.
- Audit (I-12): tenant, gerçek aktör, adına işlem yapılan, işlem, kayıt, zaman, gerekçe, IP/cihaz, request ID, değişiklik özeti.

## KVKK / GDPR
- Veri envanteri, işleme amaçları, veri sorumlusu (müşteri) / veri işleyen (platform) rolleri, **veri işleme sözleşmesi (DPA)**, saklama politikası, ilgili kişi başvuruları, ihlal müdahale prosedürü.
- **Barındırma bölgesi:** Yurt dışında barındırma KVKK'daki yurt dışı aktarım kurallarına tabidir; bölge ve aktarım mekanizması ADR-007'de hukuk görüşüyle seçilir.
- VERBİS kayıt yükümlülüğü, aydınlatma metni, çerez politikası, kullanım koşulları, abonelik sözleşmesi hazırlanır (hukukçu doğrular; teknik kontrol hukuki uyum beyanı değildir).
- Ticari e-posta/SMS (pazarlama) İYS kurallarına tabidir; işlemsel bildirimler pazarlamadan ayrı tutulur.
- Operasyonel silme, hukuki saklama ve anonimleştirme ayrı süreçlerdir; süreler kayıt sınıfına göre doğrulanır.
