# 04 — Çekirdek Veri Modeli
(Tablo adları örnektir; adlandırma dili ADR-002.)

| Grup | Varlıklar | Kural |
|---|---|---|
| Kimlik | users, tenants, memberships, roles, sessions | Kimlik ≠ üyelik |
| Kartlar | items, item_barcodes, units, unit_conversions, accounts | Kod tenant içinde benzersiz |
| Depo | warehouses, locations (Depo→Bölge/Koridor→Raf→Kat→Göz, dinamik derinlik), location_count_locks (lokasyon başına bir satır, lokasyonla birlikte oluşur) | Ağaç döngüsüz, tenant/depo tutarlı; `location.kind` ∈ `RECEIVING` (kabul), `STORAGE` (raf), `STAGING` (sevk alanı), `TRANSIT`; yalnızca `STORAGE` ve `STAGING` sevke uygundur; `location.pick_blocked` (toplama dışı) bayrağı açık sayım görevi olan lokasyonu kullanılabilirden çıkarır |
| İzlenebilirlik | lots, serials, inventory_owners, handling_units | SKT lotta; seri tekil ürün; taşıma birimi iç içe olabilir (palet → koli), döngüsüz |
| Stok | stock_dimensions, stock_ledger, stock_balances, reservations | Defter kaynak (I-04) |
| Planlama | item_stock_policies (min/maks/yeniden sipariş noktası, depo bazlı) | Uyarı üretir, stok değiştirmez |
| Belgeler | documents, document_lines, document_type_versions, document_status_history, number_sequences | İşlenmiş satır + kural sürümü korunur; durum geçmişi append-only |
| Görünürlük | `created_xid xid8 DEFAULT pg_current_xact_id()` — stock_ledger, document_status_history, audit_logs, outbox_events | Kesim noktaları bu sütunla belirlenir (I-16) |
| Operasyon | orders, pick_assignments, tasks, shipments, transfers, counts, returns | Kısmi işlem ve durum geçişleri açık |
| Güvenilirlik | idempotency_records, outbox_events, processed_events | Tekrar teslimat tek etki |
| Platform | metadata_versions, entitlements, plans, subscriptions, feature_flags | Global yazma platform yetkisi |
| Dosya/veri | attachments, export_jobs, import_jobs, deletion_jobs, audit_logs | Sahiplik, saklama, durum |
| Bildirim | notifications, notification_prefs | Tenant/kullanıcı kapsamlı |

## Ürün, lot, seri, birim
- Ürün: temel birim, takip modu (`NONE|LOT|SERIAL|LOT_AND_SERIAL`), miktar hassasiyeti, FIFO/FEFO politikası, min-maks (politika tablosunda).
- Çoklu barkod; barkod birim/paket miktarına bağlanabilir; belirsiz barkod sessizce ilk ürüne atanmaz; GS1 ayrıştırma test edilir.
- Lot ürüne aittir: lot kodu, üretim tarihi, SKT (tarih-only), tedarikçi lotu. SKT özel alan değildir.
- Seri benzersizliği tenant politikasıyla (ürün içi / tenant geneli); seri takipli stok miktarı 1 ve tek konum.
- Birim dönüşümü decimal; katsayı belge satırına kopyalanır (I-09).
- Stok boyutundaki opsiyonel alanların NULL davranışı tek bakiye satırı üretecek şekilde tasarlanır (NULLS NOT DISTINCT veya sentinel).
- Stok durumları: `AVAILABLE` (kullanılabilir), `QUARANTINE` (karantina), `DAMAGED` (hasarlı), `BLOCKED` (bloke). Durum değişimi aynı lokasyonda iki defter satırıdır (eski durum −, yeni durum +). Transit bir durum değil lokasyon türüdür.
- **Taşıma birimi (koli/palet, LPN) kararı — ADR-011:** "1 koli = 12 adet" bir **birim dönüşümüdür** ve mevcut modelde vardır. Koli/paletin kendi kimliğiyle izlenmesi (içeriği tek okutmayla taşınan kap) ise ayrı bir kavramdır: `handling_units` (id, tür KOLI/PALET, barkod/SSCC, üst taşıma birimi, lokasyon, durum AÇIK/KAPALI/BOŞALTILDI) ve stok boyutuna nullable `handling_unit_id`. Sonradan eklemek tüm bakiye ve defter satırlarında migration gerektirdiği için **önerilen varsayılan:** boyut alanı ve tablo Faz 2'de kurulur (NULL = taşıma birimsiz stok, NULL-safe benzersizlik), akışlar yalnızca pilot (b)/(c) cevabı verirse 3A'da, yoksa 3B'de yapılır. Taşıma birimi hareketi = içindeki her boyut için `−`/`+` defter satırı çifti; taşıma biriminin kendisi stok değildir.
- **Takip modu kararı:** Lot, seri ve SKT için veri modeli, kısıtlar ve defter boyutları **her durumda Faz 2'de** kurulur (sonradan eklemek tüm stok tablolarında migration gerektirir); AC-09 bu nedenle koşulsuzdur. Saha akışları (birim başına seri tarama, lot seçimi, FEFO önerisi, SKT uyarıları) pilot `LOT`/`SERIAL` gerektiriyorsa Faz 3A'da, gerektirmiyorsa Faz 3B'de yapılır (AC-34).
- Maliyet/değerleme ayrı ADR; ERP'nin hangi verinin otoritesi olduğu açıkça yazılır.
