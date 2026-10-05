# 14 — Dayanıklılık, Gözlem, Dağıtım

- Ortamlar: local (docker compose: postgres, pgbouncer transaction mode, minio, mailpit; redis yalnızca broker seçilirse), dev, staging, prod; veriler ve sırlar ayrık; prod verisi maskesiz teste taşınmaz.
- DB otomatik yedek + PITR; dosyalarda sürümleme; şifreleme anahtarlarının kurtarılması planlı.
- İlk prod öncesi tam restore tatbikatı, sonra en az üç ayda bir; DB + dosya + metadata + silme işaretleri birlikte; ölçülen RPO/RTO raporlanır.
- Kuyruk outbox'tan yeniden kurulabilir; Redis kaybında kesinleşmiş stok kaybolmaz.
- Yapılandırılmış log, request/trace ID (OpenTelemetry), hata izleme. Alarmlar: gecikme, hata oranı, DB bağlantı/kilit, kuyruk yaşı, retry, offline çatışma, stok tutarsızlığı. Yüksek cardinality etiketlerden kaçınılır.
- CI: lint, typecheck, unit, `check:all` bekçileri, entegrasyon (PgBouncer arkasında), `test:ac`, migration ileri/geri, bağımlılık/sır taraması, Playwright duman testi. CI tanımı korunan dosyadır.
- Deploy: connection drain, worker zarif kapanış, job yeniden teslimatı güvenli; eski/yeni sürüm geçişte şemayla uyumlu.
- Olay müdahalesi: sorumlu, alarm kanalı, stok yazmasını güvenle durdurma anahtarı (kill switch), müşteri iletişim şablonu.
