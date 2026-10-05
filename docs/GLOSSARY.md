# Sözlük ve Terminoloji
- **Sipariş toplama görevlendirmesi:** Sektördeki "wave/dalga" yerine kullanılan terim; tablo, ekran ve menüde "wave" kullanılmaz.
- **Fiş:** Stok etkili veya etkisiz belge (mal kabul, transfer, sayım farkı, sevk, iade, üretim giriş/sarf).
- **Ters kayıt:** İşlenmiş fişi geri almak için orijinale referans veren karşıt hareket.
- **Stok boyutu:** tenant + ürün + lokasyon + lot/seri + stok durumu + stok sahibi + taşıma birimi (opsiyonel).
- **Kullanılabilir stok:** Σ fiziksel (durum `AVAILABLE`, lokasyon türü `STORAGE` veya `STAGING`, toplama dışı olmayan lokasyon) − Σ aktif rezervasyon. Kabul alanındaki, karantinadaki, transit ve sayım görevi bekleyen lokasyondaki stok fizikseldir ama kullanılabilir değildir.
- **Transit:** Transfer çıkışı yapılmış, hedefte kabul edilmemiş stok.
- **Tenant terminolojisi:** Kullanıcıya gösterilen etiket (örn. "Göz Kodu"); teknik alan kimliğini değiştirmez.
## Adlandırma kuralı (ADR-002 — önerilen varsayılan)
Kod, tip, DB şeması, API ve ajan istemleri **İngilizce**; arayüz metinleri **Türkçe** (next-intl anahtarları üzerinden); iş terimi ↔ teknik ad eşlemesi yalnızca bu tabloda tutulur. Gerekçe: İngilizce tanımlayıcılar daha az token'a bölünür, kütüphane kalıplarıyla tutarlıdır ve ajan hata oranını düşürür. ADR-002 Türkçe yönünde karar verirse tablo yine geçerlidir, yalnızca sütunlar yer değiştirir. v1.3'teki Türkçe 106 tabloluk katalog bu tabloya göre çevrilir (ayrı görev kartı).

| İş terimi (UI) | Teknik ad (kod/DB) | Not |
|---|---|---|
| Stok kartı / malzeme | `item` | |
| Cari | `account` | Müşteri/tedarikçi rolü alanla |
| Depo | `warehouse` | |
| Lokasyon (Bölge/Koridor/Raf/Kat/Göz) | `location` (`level` alanı) | Derinlik dinamik |
| Fiş / belge | `document`, `document_line`, `document_type` | |
| Mal kabul | `receipt` (document_type) | |
| Yerleştirme | `putaway` | |
| Sevk | `shipment` | |
| Transfer | `transfer` | Transit lokasyonu `location.kind = TRANSIT` |
| Sayım / sayım farkı | `count_session`, `count_adjustment` | |
| İade | `return` | |
| Rezervasyon | `reservation` | |
| Sipariş toplama görevlendirmesi | `pick_assignment` | **`wave` kullanılmaz** (kod dahil) |
| Toplama görevi | `pick_task` | |
| Hareket defteri | `stock_ledger` | |
| Stok boyutu | `stock_dimension` | |
| Ters kayıt | `reversal` | |
| Lot / SKT | `lot`, `lot.expiry_date` | |
| Koli / palet (izlenen kap) | `handling_unit` (`kind` KOLI/PALET, `sscc`) | "1 koli = 12 adet" ise bu değil, `unit_conversion` |
| Seri no | `serial` | |
| Stok sahibi | `inventory_owner` | |
| Paket / hak | `plan`, `entitlement` | |
