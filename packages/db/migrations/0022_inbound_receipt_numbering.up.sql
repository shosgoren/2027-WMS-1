-- 0022_inbound_receipt_numbering (T-305, A-305-1, G-08 genişlet–taşı–daralt): `inbound_receipts.number` NOT NULL (0016) ve numara
-- `number_sequences` ile üretilir; sıra tablosunun tür CHECK'ine `INBOUND_RECEIPT` eklenir (önek `KBL`, uygulama tarafı numbering.ts).
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Yalnızca GENİŞLETME: eski CHECK'in kabul ettiği her değer yeni CHECK'te de geçerlidir (taşınacak veri yok). Daraltma adımı down'dadır
--   ve satır varken yalnızca wms_meta.allow_destructive_down = 'on' iken çalışır.
-- * 0017 deseni: eski CHECK düşer, yenisi NOT VALID eklenir, ardından VALIDATE (kısa kilit; tablo küçüktür).
-- * Yetki/RLS/sütun değişmez: GRANT'lar 0012'deki gibi; `documents.kind` CHECK'i DEĞİŞMEZ (kabul belgesi stok belgesi değildir; ayrı tablo).
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.number_sequences') IS NULL OR pg_catalog.to_regclass('public.inbound_receipts') IS NULL THEN
    RAISE EXCEPTION '0022_inbound_receipt_numbering: 0012 / 0016 önkoşulu yok';
  END IF;
END
$pre$;

ALTER TABLE public.number_sequences DROP CONSTRAINT number_sequences_kind_chk;
ALTER TABLE public.number_sequences
  ADD CONSTRAINT number_sequences_kind_chk
  CHECK (document_kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL', 'COUNT_ADJUSTMENT', 'INBOUND_RECEIPT')) NOT VALID;
ALTER TABLE public.number_sequences VALIDATE CONSTRAINT number_sequences_kind_chk;
