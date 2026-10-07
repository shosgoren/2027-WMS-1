-- 0021_easy_setup_indexes (T-259; T-250 inceleme MINOR-5, MINOR-7): kolay kurulum sorguları için indeksler. Yalnızca indeks; veri/yetki değişmez.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * RLS + sızdırmazlık (leakproof) kısıtı: uygulama rolü (wms_app) FORCE RLS altında çalışır; politika koşulu "güvenlik bariyeri"dir ve
--   kullanıcı koşulu indeks koşulu olarak YALNIZCA tüm işlevleri LEAKPROOF ise kullanılabilir. PostgreSQL 17'de `lower()`, `upper()`,
--   `LIKE`, `jsonb ->>` LEAKPROOF DEĞİL; `texteq`, `starts_with`, `text_pattern_*` LEAKPROOF. Bu yüzden kartta yazılı
--   `((change_summary->>'bulk_ref'))` ve `lower(code) text_pattern_ops` ifade indeksleri wms_app planında SEQ SCAN'e düşer (T-259 int testi
--   EXPLAIN ile bunu gösterdi); burada kullanıcı koşulu düz sütun + leakproof işlevle yazılabilen biçimler kurulur.
-- * audit_logs_tenant_bulk_ref_idx: toplu raf oluşturucunun idempotency araması (tenant'ın TÜM audit satırlarını taramasın). Toplu komutun tek
--   audit satırında `entity_type = 'location_batch'` ve `entity_id` = idempotency anahtarıdır (domain, T-259); arama `entity_id = $anahtar`
--   (texteq, leakproof). KISMİ indeks: yalnızca toplu komut satırları indekslenir, diğer audit yazımlarına ek maliyet yok.
-- * locations_search_code_idx: lokasyon seçici typeahead'inin kod kolu (`starts_with(code, '<ÖNEK>')`; kodlar yazımda ASCII büyük harfe
--   normalize edilir, A-98). `text_pattern_ops` C-dışı collation'da bile önek aramasını indeksler; PostgreSQL 17 `starts_with`'i bu indeksin
--   aralık koşuluna çevirir. KISMİ (`status = 'ACTIVE'`): arama yalnızca aktif lokasyonları arar. Ad kolu (`lower(name)`) leakproof olmadığından
--   RLS altında indekslenemez; maliyeti depo başına lokasyon sınırı ile (A-259-1) sınırlıdır.
-- * CONCURRENTLY KULLANILMAZ: migration koşturucusu her migration'ı tek transaction'da çalıştırır (CREATE INDEX CONCURRENTLY
--   transaction içinde çalışmaz). Bedel: indeks kurulurken tabloya yazma kısa süre bekler (SHARE kilidi); koşturucunun lock_timeout'u
--   sonsuz beklemeyi engeller. Pilot ölçeğinde (A-259-3) kabul edilir; büyük tabloda ayrı bakım penceresi gerekir.

CREATE INDEX audit_logs_tenant_bulk_ref_idx
  ON public.audit_logs (tenant_id, entity_id)
  WHERE entity_type = 'location_batch';

CREATE INDEX locations_search_code_idx
  ON public.locations (tenant_id, warehouse_id, code text_pattern_ops)
  WHERE status = 'ACTIVE';
